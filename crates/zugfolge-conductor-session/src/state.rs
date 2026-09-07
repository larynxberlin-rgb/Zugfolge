use crate::{common::*, source, *};
use zugfolge_conductor_dialogue::{DialogueReleaseV1, project_encounter};

pub(crate) fn validate_state(
    state: &ConductorTrainStateV1,
    expected: &str,
    releases: &[DialogueReleaseV1],
) -> Result<(), ConductorSessionError> {
    require(
        state.schema_version == STATE_SCHEMA
            && id(&state.world_id)
            && id(&state.train_run_id)
            && (0..=MAX_SAFE).contains(&state.now_ms)
            && state.revision <= u64::try_from(MAX_SAFE).expect("positiv")
            && state.sequence <= u64::try_from(MAX_SAFE).expect("positiv")
            && hash(expected)
            && state.state_hash == expected
            && conductor_session_state_hash(state)? == expected,
        "conductor_session_state_hash_mismatch",
    )?;
    require(
        state.command_receipts.len() <= 262_144
            && state.encounters.len() <= 20_000
            && state.control_receipts.len() <= 40_000,
        "conductor_session_state_limit",
    )?;
    if let Some(session) = &state.session {
        validate_policy(&session.policy)?;
        require(
            id(&session.session_id)
                && id(&session.operator_id)
                && id(&session.owner_ref)
                && session.revision > 0
                && session.revision <= state.revision
                && session.now_ms <= state.now_ms
                && session.started_at_ms >= 0
                && session.started_at_ms <= session.now_ms
                && session.lease_until_ms <= MAX_SAFE
                && session.lease_until_ms > session.started_at_ms
                && session.movement_budget_mm <= u64::from(session.policy.max_movement_burst_mm)
                && (0..=state.now_ms).contains(&session.movement_budget_at_ms)
                && (0..=state.now_ms).contains(&session.command_window_start_ms)
                && session.commands_in_window <= session.policy.max_commands_per_window
                && session
                    .last_command_at_ms
                    .is_none_or(|at| (0..=state.now_ms).contains(&at)),
            "invalid_conductor_session_state",
        )?;
        require(
            (session.status == ConductorSessionStatusV1::Ended) == session.end_reason.is_some()
                && (session.status == ConductorSessionStatusV1::Ended)
                    == session.ended_at_ms.is_some()
                && session
                    .ended_at_ms
                    .is_none_or(|at| (session.started_at_ms..=state.now_ms).contains(&at))
                && (session.status != ConductorSessionStatusV1::Ended
                    || session.active_encounter_id.is_none()),
            "invalid_conductor_session_status",
        )?;
        let layout = state
            .layout
            .as_ref()
            .ok_or(ConductorSessionError("conductor_session_layout_missing"))?;
        let passengers = state.passengers.as_ref().ok_or(ConductorSessionError(
            "conductor_session_passengers_missing",
        ))?;
        require(
            layout.binding.world_id == state.world_id
                && layout.binding.operator_id == session.operator_id
                && layout.layout_hash == session.pins.interior_layout_hash
                && zugfolge_conductor::interior_layout_hash(layout)
                    .map_err(|_| ConductorSessionError("conductor_session_layout_invalid"))?
                    == layout.layout_hash
                && passengers.binding.world_id == state.world_id
                && passengers.binding.train_run_id == state.train_run_id
                && passengers.binding.operator_id == session.operator_id
                && passengers.binding.period_id == session.pins.period_id
                && layout.binding.period_id == session.pins.period_id
                && passengers.binding.manifest_revision == session.pins.manifest_revision
                && passengers.binding.demand_state_hash == session.pins.demand_state_hash
                && session.policy.content_hash == session.pins.policy_hash
                && passengers.state_hash == session.pins.projection_hash,
            "conductor_session_projection_pin_mismatch",
        )?;
        let mut canonical = passengers.clone();
        canonical.state_hash.clear();
        require(
            digest(&canonical)? == passengers.state_hash,
            "conductor_session_projection_hash_mismatch",
        )?;
        active_encounter_record(state, session, passengers)?;
    } else {
        require(
            state.layout.is_none()
                && state.passengers.is_none()
                && state.encounters.is_empty()
                && state.command_receipts.is_empty()
                && state.control_receipts.is_empty()
                && state.revision == 0
                && state.sequence == 0,
            "invalid_empty_conductor_session_state",
        )?;
    }
    for (id, encounter) in &state.encounters {
        require(
            id == &encounter.encounter_id
                && encounter.dialogue.world_id == state.world_id
                && encounter.dialogue.train_run_id == state.train_run_id
                && encounter.dialogue.encounter_id == *id
                && encounter.dialogue.passenger_key == encounter.passenger_key,
            "conductor_encounter_scope_mismatch",
        )?;
        let release = source::dialogue_release(releases, &encounter.dialogue.release_hash)?;
        project_encounter(release, &encounter.dialogue)
            .map_err(|_| ConductorSessionError("conductor_dialogue_state_invalid"))?;
    }
    for receipt in state.command_receipts.values() {
        require(
            receipt.world_id == state.world_id
                && receipt.train_run_id == state.train_run_id
                && receipt.sequence <= state.sequence
                && hash(&receipt.command_hash)
                && id(&receipt.session_id)
                && id(&receipt.idempotency_key),
            "invalid_conductor_command_receipt",
        )?;
    }
    for (id, receipt) in &state.control_receipts {
        require(
            id == &receipt.effect_id
                && receipt.world_id == state.world_id
                && receipt.train_run_id == state.train_run_id
                && state.encounters.contains_key(&receipt.encounter_id)
                && hash(&receipt.domain_state_hash)
                && common::id(&receipt.domain_receipt_id),
            "invalid_conductor_control_receipt",
        )?;
    }
    Ok(())
}

pub fn initialize_conductor_session_state(
    input: &InitializeConductorSessionStateInputV1,
) -> Result<ConductorTrainStateV1, ConductorSessionError> {
    require(
        input.schema_version == "conductor-session-initialize-input/v1"
            && id(&input.world_id)
            && id(&input.train_run_id)
            && (0..=MAX_SAFE).contains(&input.now_ms),
        "invalid_conductor_session_initialization",
    )?;
    let mut state = ConductorTrainStateV1 {
        schema_version: STATE_SCHEMA.into(),
        world_id: input.world_id.clone(),
        train_run_id: input.train_run_id.clone(),
        revision: 0,
        sequence: 0,
        now_ms: input.now_ms,
        session: None,
        layout: None,
        passengers: None,
        encounters: Default::default(),
        control_receipts: Default::default(),
        command_receipts: Default::default(),
        state_hash: String::new(),
    };
    state.state_hash = conductor_session_state_hash(&state)?;
    Ok(state)
}
pub fn restore_conductor_session_state(
    input: &RestoreConductorSessionStateInputV1,
) -> Result<ConductorTrainStateV1, ConductorSessionError> {
    require(
        input.schema_version == "conductor-session-restore-input/v1",
        "unsupported_conductor_session_schema",
    )?;
    validate_state(
        &input.state,
        &input.expected_state_hash,
        &input.dialogue_releases,
    )?;
    Ok(input.state.clone())
}

fn active_encounter_record<'a>(
    state: &'a ConductorTrainStateV1,
    session: &ConductorSessionV1,
    passengers: &zugfolge_conductor::PassengerProjectionV2,
) -> Result<Option<&'a ConductorEncounterRecordV1>, ConductorSessionError> {
    session
        .active_encounter_id
        .as_ref()
        .map(|id| {
            let record = state
                .encounters
                .get(id)
                .ok_or(ConductorSessionError("conductor_session_encounter_missing"))?;
            require(
                session.status != ConductorSessionStatusV1::Ended
                    && !record.closed_by_session
                    && record.encounter_id == *id
                    && record.dialogue.encounter_id == *id
                    && record.dialogue.world_id == state.world_id
                    && record.dialogue.train_run_id == state.train_run_id
                    && record.dialogue.status
                        == zugfolge_conductor_dialogue::EncounterStatusV1::Active
                    && record.dialogue.passenger_key == record.passenger_key
                    && passengers
                        .passengers
                        .iter()
                        .any(|passenger| passenger.passenger_key == record.passenger_key),
                "conductor_session_encounter_missing",
            )?;
            Ok(record)
        })
        .transpose()
}

pub(crate) fn snapshot(
    state: &ConductorTrainStateV1,
    releases: &[DialogueReleaseV1],
) -> Result<ConductorSessionSnapshotV1, ConductorSessionError> {
    let session = state
        .session
        .as_ref()
        .ok_or(ConductorSessionError("conductor_session_missing"))?;
    let passengers = state.passengers.as_ref().ok_or(ConductorSessionError(
        "conductor_session_passengers_missing",
    ))?;
    let active_record = active_encounter_record(state, session, passengers)?;
    let active_passenger_key = active_record.map(|record| record.passenger_key.clone());
    let active_encounter = active_record
        .map(|record| {
            require(
                passengers.passengers.iter().any(|passenger| {
                    passenger.passenger_key == record.passenger_key
                        && passenger.activity == zugfolge_conductor::PassengerActivityV1::Onboard
                }),
                "conductor_session_encounter_missing",
            )?;
            project_encounter(
                source::dialogue_release(releases, &record.dialogue.release_hash)?,
                &record.dialogue,
            )
            .map_err(|_| ConductorSessionError("conductor_dialogue_state_invalid"))
        })
        .transpose()?;
    let mut snapshot = ConductorSessionSnapshotV1 {
        schema_version: SNAPSHOT_SCHEMA.into(),
        world_id: state.world_id.clone(),
        train_run_id: state.train_run_id.clone(),
        session_id: session.session_id.clone(),
        operator_id: session.operator_id.clone(),
        status: session.status,
        revision: session.revision,
        sequence: state.sequence,
        now_ms: state.now_ms,
        lease_until_ms: session.lease_until_ms,
        end_reason: session.end_reason,
        position: session.position.clone(),
        pins: session.pins.clone(),
        passengers: passengers.clone(),
        active_encounter,
        active_passenger_key,
        snapshot_hash: String::new(),
    };
    snapshot.snapshot_hash = digest(&snapshot)?;
    Ok(snapshot)
}
pub fn project_conductor_session_snapshot(
    input: &ProjectConductorSessionSnapshotInputV1,
) -> Result<ConductorSessionSnapshotV1, ConductorSessionError> {
    require(
        input.schema_version == "conductor-session-project-input/v1",
        "unsupported_conductor_session_schema",
    )?;
    validate_state(
        &input.state,
        &input.expected_state_hash,
        &input.source.dialogue_releases,
    )?;
    source::access(&input.state, &input.access)?;
    let session = input
        .state
        .session
        .as_ref()
        .ok_or(ConductorSessionError("conductor_session_missing"))?;
    require(
        session.owner_ref == input.access.owner_ref
            && session.operator_id == input.access.operator_id,
        "conductor_access_denied",
    )?;
    source::operational(&input.state, &input.source)?;
    if session.status != ConductorSessionStatusV1::Ended {
        let live = source::live(&input.state, &input.source, &input.access)?;
        require(
            live.pins.projection_hash == session.pins.projection_hash
                && live.pins.interior_layout_hash == session.pins.interior_layout_hash
                && input.source.operational_world.now_ms < session.lease_until_ms,
            "conductor_session_refresh_required",
        )?;
    }
    snapshot(&input.state, &input.source.dialogue_releases)
}

pub(crate) fn event(
    state: &mut ConductorTrainStateV1,
    kind: ConductorSessionEventKindV1,
    at: i64,
    causality: &str,
) -> Result<ConductorSessionEventV1, ConductorSessionError> {
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or(ConductorSessionError("session_revision_overflow"))?;
    state.sequence = state
        .sequence
        .checked_add(1)
        .ok_or(ConductorSessionError("session_revision_overflow"))?;
    require(
        state.revision <= u64::try_from(MAX_SAFE).expect("positiv")
            && state.sequence <= u64::try_from(MAX_SAFE).expect("positiv"),
        "session_revision_overflow",
    )?;
    state.now_ms = at;
    let session = state
        .session
        .as_mut()
        .ok_or(ConductorSessionError("conductor_session_missing"))?;
    session.revision += 1;
    session.now_ms = at;
    Ok(ConductorSessionEventV1 {
        schema_version: "conductor-session-event/v1".into(),
        world_id: state.world_id.clone(),
        train_run_id: state.train_run_id.clone(),
        session_id: session.session_id.clone(),
        sequence: state.sequence,
        revision: session.revision,
        at_ms: at,
        causality_id: causality.into(),
        kind,
    })
}
pub(crate) fn transition(
    mut state: ConductorTrainStateV1,
    receipt: Option<ConductorCommandReceiptV1>,
    events: Vec<ConductorSessionEventV1>,
    effects: Vec<ConductorSessionEffectV1>,
    releases: &[DialogueReleaseV1],
    visible: bool,
) -> Result<ConductorSessionTransitionV1, ConductorSessionError> {
    state.state_hash = conductor_session_state_hash(&state)?;
    let snapshot = if visible && state.session.is_some() {
        Some(snapshot(&state, releases)?)
    } else {
        None
    };
    Ok(ConductorSessionTransitionV1 {
        schema_version: "conductor-session-transition/v1".into(),
        state_hash: state.state_hash.clone(),
        state,
        receipt,
        snapshot,
        events,
        effects,
    })
}
