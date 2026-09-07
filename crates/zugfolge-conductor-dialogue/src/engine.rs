use crate::validation::{digest, identifier, is_hash};
use crate::*;
use sha2::{Digest, Sha256};

fn selection_hash(input: &StartDialogueInputV1) -> Result<String, DialogueErrorV1> {
    let mut hash = Sha256::new();
    for part in [
        "fare_dialogue",
        &input.world_id,
        &input.period_id,
        &input.train_run_id,
        &input.passenger_key,
        &input.seed,
    ] {
        hash.update(
            u64::try_from(part.len())
                .map_err(|_| DialogueErrorV1::InvalidInput)?
                .to_be_bytes(),
        );
        hash.update(part.as_bytes());
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
fn selected_tree<'a>(
    release: &'a DialogueReleaseV1,
    hash: &str,
) -> Result<&'a DialogueTreeV1, DialogueErrorV1> {
    if !is_hash(hash) {
        return Err(DialogueErrorV1::InvalidState);
    }
    let bucket = |text| {
        u64::from_str_radix(text, 16)
            .map(|n| n % 10_000)
            .map_err(|_| DialogueErrorV1::InvalidState)
    };
    let mut families = release.families.iter().collect::<Vec<_>>();
    families.sort_by_key(|f| &f.family_id);
    let mut cursor = bucket(&hash[..16])?;
    for family in families {
        if cursor < u64::from(family.weight_basis_points) {
            let mut trees = family.trees.iter().collect::<Vec<_>>();
            trees.sort_by_key(|t| &t.tree_id);
            let mut tree_cursor = bucket(&hash[16..32])?;
            for tree in trees {
                if tree_cursor < u64::from(tree.weight_basis_points) {
                    return Ok(tree);
                }
                tree_cursor -= u64::from(tree.weight_basis_points);
            }
            break;
        }
        cursor -= u64::from(family.weight_basis_points);
    }
    Err(DialogueErrorV1::InvalidRelease)
}
fn condition_met(condition: DialogueConditionV1, evidence: &DialogueEvidenceV1) -> bool {
    match condition {
        DialogueConditionV1::Always => true,
        DialogueConditionV1::DocumentUnchecked => {
            evidence.document_status == DocumentStatusV1::Unchecked
        }
        DialogueConditionV1::DocumentValid => {
            evidence.document_status == DocumentStatusV1::VerifiedValid
        }
        DialogueConditionV1::RegularClaimAllowed => {
            evidence.document_status == DocumentStatusV1::VerifiedInvalid
                && evidence.acquisition_exception == AcquisitionExceptionV1::Excluded
                && evidence.identity_status == IdentityStatusV1::Confirmed
        }
        DialogueConditionV1::ProvisionalClaimAllowed => {
            evidence.document_status == DocumentStatusV1::NotPresentable
                && evidence.acquisition_exception == AcquisitionExceptionV1::Excluded
                && evidence.identity_status == IdentityStatusV1::Confirmed
        }
        DialogueConditionV1::PoliceAllowed => {
            evidence.identity_status == IdentityStatusV1::Refused || evidence.concrete_danger
        }
    }
}
fn evidence_progress(previous: &DialogueEvidenceV1, next: &DialogueEvidenceV1) -> bool {
    let document = previous.document_status == next.document_status
        || previous.document_status == DocumentStatusV1::Unchecked
        || (previous.document_status == DocumentStatusV1::NotPresentable
            && matches!(
                next.document_status,
                DocumentStatusV1::VerifiedValid | DocumentStatusV1::VerifiedInvalid
            ));
    let acquisition = previous.acquisition_exception == next.acquisition_exception
        || previous.acquisition_exception == AcquisitionExceptionV1::Unknown;
    let identity = previous.identity_status == next.identity_status
        || previous.identity_status == IdentityStatusV1::Unknown
        || (previous.identity_status == IdentityStatusV1::Refused
            && next.identity_status == IdentityStatusV1::Confirmed);
    document && acquisition && identity && (!previous.concrete_danger || next.concrete_danger)
}
pub fn dialogue_state_hash(state: &DialogueStateV1) -> Result<String, DialogueErrorV1> {
    let mut copy = state.clone();
    copy.state_hash.clear();
    digest(&copy)
}
fn seal(mut state: DialogueStateV1) -> Result<DialogueStateV1, DialogueErrorV1> {
    state.state_hash = dialogue_state_hash(&state)?;
    Ok(state)
}
fn restore<'a>(
    release: &'a DialogueReleaseV1,
    state: &DialogueStateV1,
) -> Result<&'a DialogueNodeV1, DialogueErrorV1> {
    let report = validate_dialogue_release(release)?;
    if state.release_id != report.release_id || state.release_hash != report.release_hash {
        return Err(DialogueErrorV1::ReleaseMismatch);
    }
    if state.schema_version != "conductor-dialogue-state/v1"
        || !is_hash(&state.state_hash)
        || dialogue_state_hash(state)? != state.state_hash
        || [
            &state.world_id,
            &state.period_id,
            &state.train_run_id,
            &state.passenger_key,
            &state.encounter_id,
        ]
        .iter()
        .any(|id| !identifier(id))
        || state.updated_at_ms < 0
        || state.available_at_ms < state.updated_at_ms
        || (state.revision == 0) != state.last_receipt.is_none()
        || state
            .last_receipt
            .as_ref()
            .is_some_and(|r| !identifier(&r.command_id) || !is_hash(&r.command_hash))
    {
        return Err(DialogueErrorV1::InvalidState);
    }
    let tree = selected_tree(release, &state.selection_hash)?;
    if tree.tree_id != state.tree_id {
        return Err(DialogueErrorV1::InvalidState);
    }
    let node = tree
        .nodes
        .iter()
        .find(|n| n.node_id == state.node_id)
        .ok_or(DialogueErrorV1::InvalidState)?;
    if state.status == EncounterStatusV1::Active && node.options.is_empty() {
        return Err(DialogueErrorV1::InvalidState);
    }
    Ok(node)
}
pub fn project_encounter(
    release: &DialogueReleaseV1,
    state: &DialogueStateV1,
) -> Result<PassengerEncounterV1, DialogueErrorV1> {
    let node = restore(release, state)?;
    Ok(PassengerEncounterV1 {
        schema_version: "passenger-encounter/v1".into(),
        encounter_id: state.encounter_id.clone(),
        revision: state.revision,
        status: state.status,
        passenger_text: node.passenger_text.clone(),
        options: if state.status == EncounterStatusV1::Closed {
            Vec::new()
        } else {
            node.options
                .iter()
                .filter(|option| condition_met(option.condition, &state.evidence))
                .map(|option| PassengerDialogueOptionV1 {
                    option_id: option.option_id.clone(),
                    text: option.text.clone(),
                    time_cost_ms: option.time_cost_ms,
                })
                .collect()
        },
        hints: state.evidence.clone(),
        available_at_ms: state.available_at_ms,
    })
}
fn transition(
    release: &DialogueReleaseV1,
    state: DialogueStateV1,
    intent: Option<DialogueIntentV1>,
) -> Result<DialogueTransitionV1, DialogueErrorV1> {
    let encounter = project_encounter(release, &state)?;
    Ok(DialogueTransitionV1 {
        state,
        encounter,
        intent,
    })
}
pub fn start_dialogue(
    release: &DialogueReleaseV1,
    input: &StartDialogueInputV1,
) -> Result<DialogueTransitionV1, DialogueErrorV1> {
    let report = validate_dialogue_release(release)?;
    if report.release_hash != input.release_hash {
        return Err(DialogueErrorV1::ReleaseMismatch);
    }
    if [
        &input.world_id,
        &input.period_id,
        &input.train_run_id,
        &input.passenger_key,
        &input.encounter_id,
    ]
    .iter()
    .any(|id| !identifier(id))
        || input.seed.is_empty()
        || input.seed.len() > 256
        || input.now_ms < 0
    {
        return Err(DialogueErrorV1::InvalidInput);
    }
    let selection_hash = selection_hash(input)?;
    let tree = selected_tree(release, &selection_hash)?;
    let state = seal(DialogueStateV1 {
        schema_version: "conductor-dialogue-state/v1".into(),
        world_id: input.world_id.clone(),
        period_id: input.period_id.clone(),
        train_run_id: input.train_run_id.clone(),
        passenger_key: input.passenger_key.clone(),
        encounter_id: input.encounter_id.clone(),
        release_id: report.release_id,
        release_hash: report.release_hash,
        selection_hash,
        fare_fact: input.fare_fact,
        evidence: input.evidence.clone(),
        tree_id: tree.tree_id.clone(),
        node_id: tree.entry_node_id.clone(),
        revision: 0,
        updated_at_ms: input.now_ms,
        available_at_ms: input.now_ms,
        status: EncounterStatusV1::Active,
        last_receipt: None,
        state_hash: String::new(),
    })?;
    transition(release, state, None)
}
fn check_command(
    release: &DialogueReleaseV1,
    state: &DialogueStateV1,
    command_id: &str,
    expected_revision: u64,
    now_ms: i64,
    command_hash: &str,
) -> Result<Option<DialogueTransitionV1>, DialogueErrorV1> {
    restore(release, state)?;
    if !identifier(command_id) {
        return Err(DialogueErrorV1::InvalidInput);
    }
    if let Some(receipt) = &state.last_receipt {
        if receipt.command_id == command_id {
            return if receipt.command_hash == command_hash {
                transition(release, state.clone(), receipt.intent).map(Some)
            } else {
                Err(DialogueErrorV1::ConflictingCommand)
            };
        }
    }
    if state.revision != expected_revision {
        return Err(DialogueErrorV1::StaleRevision);
    }
    if state.status == EncounterStatusV1::Closed {
        return Err(DialogueErrorV1::DialogueClosed);
    }
    if now_ms < state.updated_at_ms {
        return Err(DialogueErrorV1::NotReady);
    }
    Ok(None)
}
fn record(
    mut state: DialogueStateV1,
    command_id: &str,
    command_hash: String,
    now_ms: i64,
    time_cost_ms: i64,
    intent: Option<DialogueIntentV1>,
) -> Result<DialogueStateV1, DialogueErrorV1> {
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or(DialogueErrorV1::TimeOverflow)?;
    state.updated_at_ms = now_ms;
    state.available_at_ms = now_ms
        .checked_add(time_cost_ms)
        .ok_or(DialogueErrorV1::TimeOverflow)?;
    state.last_receipt = Some(DialogueReceiptV1 {
        command_id: command_id.into(),
        command_hash,
        intent,
    });
    seal(state)
}
pub fn advance_dialogue(
    release: &DialogueReleaseV1,
    state: &DialogueStateV1,
    input: &ChooseDialogueInputV1,
) -> Result<DialogueTransitionV1, DialogueErrorV1> {
    let command_hash = digest(&("choose", input))?;
    if let Some(replay) = check_command(
        release,
        state,
        &input.command_id,
        input.expected_revision,
        input.now_ms,
        &command_hash,
    )? {
        return Ok(replay);
    }
    if input.now_ms < state.available_at_ms {
        return Err(DialogueErrorV1::NotReady);
    }
    if !evidence_progress(&state.evidence, &input.evidence) {
        return Err(DialogueErrorV1::EvidenceRegression);
    }
    let node = restore(release, state)?;
    // Nur zuvor tatsächlich sichtbare Optionen sind wählbar. Neue Evidenz wird
    // separat beobachtet, bevor sie weitere Entscheidungen freigibt.
    let option = node
        .options
        .iter()
        .find(|o| {
            o.option_id == input.option_id
                && condition_met(o.condition, &state.evidence)
                && condition_met(o.condition, &input.evidence)
        })
        .ok_or(DialogueErrorV1::OptionNotAllowed)?;
    let mut next = state.clone();
    next.evidence = input.evidence.clone();
    if let Some(node_id) = &option.next_node_id {
        next.node_id = node_id.clone();
    }
    if option
        .intent
        .is_some_and(|intent| intent != DialogueIntentV1::RequestDocumentCheck)
        || option.next_node_id.is_none()
        || selected_tree(release, &next.selection_hash)?
            .nodes
            .iter()
            .any(|n| n.node_id == next.node_id && n.options.is_empty())
    {
        next.status = EncounterStatusV1::Closed;
    }
    let next = record(
        next,
        &input.command_id,
        command_hash,
        input.now_ms,
        option.time_cost_ms,
        option.intent,
    )?;
    transition(release, next, option.intent)
}
pub fn observe_dialogue(
    release: &DialogueReleaseV1,
    state: &DialogueStateV1,
    input: &ObserveDialogueInputV1,
) -> Result<DialogueTransitionV1, DialogueErrorV1> {
    let command_hash = digest(&("observe", input))?;
    if let Some(replay) = check_command(
        release,
        state,
        &input.command_id,
        input.expected_revision,
        input.now_ms,
        &command_hash,
    )? {
        return Ok(replay);
    }
    if !evidence_progress(&state.evidence, &input.evidence) {
        return Err(DialogueErrorV1::EvidenceRegression);
    }
    let mut next = state.clone();
    next.evidence = input.evidence.clone();
    let available = state.available_at_ms.max(input.now_ms);
    let next = record(
        next,
        &input.command_id,
        command_hash,
        input.now_ms,
        available - input.now_ms,
        None,
    )?;
    transition(release, next, None)
}
pub fn close_dialogue(
    release: &DialogueReleaseV1,
    state: &DialogueStateV1,
    input: &CloseDialogueInputV1,
) -> Result<DialogueTransitionV1, DialogueErrorV1> {
    let command_hash = digest(&("close", input))?;
    if let Some(replay) = check_command(
        release,
        state,
        &input.command_id,
        input.expected_revision,
        input.now_ms,
        &command_hash,
    )? {
        return Ok(replay);
    }
    let mut next = state.clone();
    next.status = EncounterStatusV1::Closed;
    let intent = Some(DialogueIntentV1::CloseWithoutAction);
    let next = record(
        next,
        &input.command_id,
        command_hash,
        input.now_ms,
        0,
        intent,
    )?;
    transition(release, next, intent)
}
