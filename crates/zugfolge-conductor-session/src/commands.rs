use crate::{common::*, source, state, *};
use zugfolge_conductor::{
    CheckInteriorMovementInputV1, InteriorPointV1, PassengerActivityV1, check_interior_movement,
};
use zugfolge_conductor_dialogue::*;

fn effect(
    state: &ConductorTrainStateV1,
    encounter: &ConductorEncounterRecordV1,
    intent: DialogueIntentV1,
    at: i64,
    cause: &str,
) -> ConductorSessionEffectV1 {
    let kind = match intent {
        DialogueIntentV1::CloseWithoutAction => ConductorSessionEffectKindV1::CloseWithoutAction,
        DialogueIntentV1::RequestDocumentCheck => {
            ConductorSessionEffectKindV1::RequestDocumentCheck
        }
        DialogueIntentV1::RequestRegularClaim => ConductorSessionEffectKindV1::RequestRegularClaim,
        DialogueIntentV1::RequestProvisionalClaim => {
            ConductorSessionEffectKindV1::RequestProvisionalClaim
        }
        DialogueIntentV1::RequestPolice => ConductorSessionEffectKindV1::RequestPolice,
    };
    ConductorSessionEffectV1 {
        world_id: state.world_id.clone(),
        train_run_id: state.train_run_id.clone(),
        effect_id: key(&[
            "session-effect",
            &state.world_id,
            &state.train_run_id,
            cause,
            &encounter.encounter_id,
        ]),
        encounter_id: encounter.encounter_id.clone(),
        passenger_key: encounter.passenger_key.clone(),
        kind,
        at_ms: at,
    }
}
fn active_id(state: &ConductorTrainStateV1) -> Option<String> {
    state
        .session
        .as_ref()
        .and_then(|s| s.active_encounter_id.clone())
}
fn close_encounter(
    state: &mut ConductorTrainStateV1,
    source: &ConductorSessionSourceV1,
    cause: &str,
    effects: &mut Vec<ConductorSessionEffectV1>,
) -> Result<(), ConductorSessionError> {
    let Some(id) = active_id(state) else {
        return Ok(());
    };
    let mut record = state.encounters[&id].clone();
    if record.dialogue.status == EncounterStatusV1::Active {
        let result = close_dialogue(
            source::dialogue_release(&source.dialogue_releases, &record.dialogue.release_hash)?,
            &record.dialogue,
            &CloseDialogueInputV1 {
                command_id: key(&[cause, &id, "close"]),
                expected_revision: record.dialogue.revision,
                now_ms: source.operational_world.now_ms,
            },
        )
        .map_err(|_| ConductorSessionError("conductor_dialogue_close_failed"))?;
        record.dialogue = result.state;
        record.closed_by_session = true;
        effects.push(effect(
            state,
            &record,
            DialogueIntentV1::CloseWithoutAction,
            source.operational_world.now_ms,
            cause,
        ));
    }
    state.encounters.insert(id, record);
    state.session.as_mut().expect("Sitzung").active_encounter_id = None;
    Ok(())
}
fn end(
    state: &mut ConductorTrainStateV1,
    source: &ConductorSessionSourceV1,
    reason: ConductorSessionEndReasonV1,
    cause: &str,
    effects: &mut Vec<ConductorSessionEffectV1>,
) -> Result<(), ConductorSessionError> {
    close_encounter(state, source, cause, effects)?;
    let session = state
        .session
        .as_mut()
        .ok_or(ConductorSessionError("conductor_session_missing"))?;
    session.status = ConductorSessionStatusV1::Ended;
    session.end_reason = Some(reason);
    session.ended_at_ms = Some(source.operational_world.now_ms);
    Ok(())
}
fn merge_control(
    state: &mut ConductorTrainStateV1,
    source: &ConductorSessionSourceV1,
) -> Result<bool, ConductorSessionError> {
    let mut changed = false;
    for receipt in &source.control_receipts {
        require(
            receipt.world_id == state.world_id
                && receipt.train_run_id == state.train_run_id
                && state.encounters.contains_key(&receipt.encounter_id)
                && id(&receipt.effect_id)
                && id(&receipt.domain_receipt_id)
                && hash(&receipt.domain_state_hash),
            "invalid_conductor_control_receipt",
        )?;
        if let Some(old) = state.control_receipts.get(&receipt.effect_id) {
            require(old == receipt, "conflicting_conductor_control_receipt")?;
        } else {
            state
                .control_receipts
                .insert(receipt.effect_id.clone(), receipt.clone());
            changed = true;
        }
    }
    require(
        state.control_receipts.len() <= 40_000,
        "conductor_session_state_limit",
    )?;
    Ok(changed)
}
fn refresh(
    state: &mut ConductorTrainStateV1,
    source: &ConductorSessionSourceV1,
    live: source::LiveSource,
    cause: &str,
    effects: &mut Vec<ConductorSessionEffectV1>,
) -> Result<(), ConductorSessionError> {
    if let Some(id) = active_id(state) {
        let record = &state.encounters[&id];
        if !live
            .passengers
            .passengers
            .iter()
            .any(|p| p.passenger_key == record.passenger_key)
        {
            close_encounter(state, source, cause, effects)?;
        }
    }
    if let Some(id) = active_id(state) {
        if let Some(evidence) = source
            .encounter_evidence
            .iter()
            .find(|e| e.encounter_id == id)
        {
            let record = state.encounters.get_mut(&id).expect("Begegnung");
            if evidence.evidence != record.dialogue.evidence {
                let observed = observe_dialogue(
                    source::dialogue_release(
                        &source.dialogue_releases,
                        &record.dialogue.release_hash,
                    )?,
                    &record.dialogue,
                    &ObserveDialogueInputV1 {
                        command_id: key(&[cause, &id, "observe"]),
                        expected_revision: record.dialogue.revision,
                        now_ms: source.operational_world.now_ms,
                        evidence: evidence.evidence.clone(),
                    },
                )
                .map_err(|_| ConductorSessionError("conductor_dialogue_evidence_invalid"))?;
                record.dialogue = observed.state;
            }
        }
    }
    let session = state
        .session
        .as_mut()
        .ok_or(ConductorSessionError("conductor_session_missing"))?;
    session.pins = live.pins;
    state.layout = Some(live.layout);
    state.passengers = Some(live.passengers);
    merge_control(state, source)?;
    Ok(())
}
fn termination(
    state: &ConductorTrainStateV1,
    source: &ConductorSessionSourceV1,
    access: &ConductorSessionAccessV1,
) -> Result<Option<ConductorSessionEndReasonV1>, ConductorSessionError> {
    let Some(session) = &state.session else {
        return Ok(None);
    };
    if session.status == ConductorSessionStatusV1::Ended {
        return Ok(None);
    }
    let train = source::operational(state, source)?;
    if !(access.world_access_active && access.operator_active && access.train_use_authorized) {
        return Ok(Some(ConductorSessionEndReasonV1::AccessRevoked));
    }
    if source.operational_world.now_ms >= session.lease_until_ms {
        return Ok(Some(ConductorSessionEndReasonV1::LeaseExpired));
    }
    let Some(train) = train else {
        return Ok(Some(ConductorSessionEndReasonV1::TrainUnavailable));
    };
    if train.operator_id != session.operator_id
        || train.movement_kind != zugfolge_sim::operational::MovementKind::Train
        || !train.public_passenger_stop
    {
        return Ok(Some(ConductorSessionEndReasonV1::AccessRevoked));
    }
    if train
        .passenger_stops
        .as_ref()
        .is_some_and(|p| p.cancellation.is_some())
    {
        return Ok(Some(ConductorSessionEndReasonV1::TrainUnavailable));
    }
    if source::terminal(train) {
        return Ok(Some(ConductorSessionEndReasonV1::TrainCompleted));
    }
    let Some(formation) = source
        .operational_world
        .formations
        .get(&train.formation_version_id)
    else {
        return Err(ConductorSessionError(
            "conductor_operational_formation_missing",
        ));
    };
    if formation.vehicle_ids != session.pins.vehicle_ids {
        return Ok(Some(ConductorSessionEndReasonV1::FormationChanged));
    }
    Ok(None)
}

fn distance(a: &InteriorPointV1, b: &InteriorPointV1) -> Option<u64> {
    if a.vehicle_id != b.vehicle_id || a.body_id != b.body_id || a.deck_id != b.deck_id {
        return None;
    }
    a.x_mm.abs_diff(b.x_mm).checked_add(a.y_mm.abs_diff(b.y_mm))
}
fn check_inspection_range(
    state: &ConductorTrainStateV1,
    passenger_key: &str,
) -> Result<(), ConductorSessionError> {
    let session = state.session.as_ref().expect("Sitzung");
    let projection = state.passengers.as_ref().expect("Projektion");
    let layout = state.layout.as_ref().expect("Layout");
    let passenger = projection
        .passengers
        .iter()
        .find(|p| p.passenger_key == passenger_key)
        .ok_or(ConductorSessionError("conductor_passenger_missing"))?;
    require(
        passenger.activity == PassengerActivityV1::Onboard,
        "conductor_passenger_alighting",
    )?;
    let target = if passenger.space_needs == zugfolge_demand::SpaceNeedsV1::Wheelchair {
        passenger
            .space_id
            .as_deref()
            .ok_or(ConductorSessionError("conductor_passenger_bay_missing"))?
    } else {
        passenger.place_id.as_str()
    };
    let interaction = layout
        .interactions
        .iter()
        .find(|i| i.target_id == target)
        .ok_or(ConductorSessionError(
            "conductor_passenger_interaction_missing",
        ))?;
    let point = &layout
        .nodes
        .iter()
        .find(|n| n.node_id == interaction.node_id)
        .ok_or(ConductorSessionError(
            "conductor_passenger_interaction_missing",
        ))?
        .point;
    require(
        distance(&session.position, point)
            .is_some_and(|d| d <= u64::from(session.policy.inspection_range_mm)),
        "conductor_passenger_out_of_reach",
    )?;
    let approach = check_interior_movement(&CheckInteriorMovementInputV1 {
        schema_version: "conductor-interior-movement-input/v1".into(),
        layout: layout.clone(),
        expected_layout_hash: layout.layout_hash.clone(),
        from: session.position.clone(),
        to: point.clone(),
        transition_edge_id: None,
        wheelchair: false,
    })
    .map_err(|_| ConductorSessionError("conductor_passenger_out_of_reach"))?;
    require(approach.allowed, "conductor_passenger_out_of_reach")
}
fn rate(session: &mut ConductorSessionV1, now: i64) -> Result<(), ConductorSessionError> {
    require(
        session
            .last_command_at_ms
            .is_none_or(|at| now - at >= session.policy.min_command_interval_ms),
        "conductor_command_rate_limited",
    )?;
    if now - session.command_window_start_ms >= session.policy.command_window_ms {
        session.command_window_start_ms = now;
        session.commands_in_window = 0;
    }
    require(
        session.commands_in_window < session.policy.max_commands_per_window,
        "conductor_command_rate_limited",
    )?;
    session.commands_in_window += 1;
    session.last_command_at_ms = Some(now);
    Ok(())
}

pub fn apply_conductor_session_command(
    input: &ApplyConductorSessionCommandInputV1,
) -> Result<ConductorSessionTransitionV1, ConductorSessionError> {
    require(
        input.schema_version == "conductor-session-apply-input/v1",
        "unsupported_conductor_session_schema",
    )?;
    state::validate_state(
        &input.state,
        &input.expected_state_hash,
        &input.source.dialogue_releases,
    )?;
    source::access(&input.state, &input.access)?;
    source::operational(&input.state, &input.source)?;
    let command = &input.command;
    require(
        command.schema_version == COMMAND_SCHEMA
            && command.world_id == input.state.world_id
            && command.train_run_id == input.state.train_run_id
            && id(&command.session_id)
            && id(&command.idempotency_key)
            && command.expected_revision <= u64::try_from(MAX_SAFE).expect("positiv"),
        "invalid_conductor_command",
    )?;
    let command_hash = digest(command)?;
    let receipt_key = key(&[
        &input.access.owner_ref,
        &command.session_id,
        &command.idempotency_key,
    ]);
    if let Some(receipt) = input.state.command_receipts.get(&receipt_key) {
        require(
            receipt.command_hash == command_hash,
            "conductor_idempotency_conflict",
        )?;
        return state::transition(
            input.state.clone(),
            Some(receipt.clone()),
            vec![],
            vec![],
            &input.source.dialogue_releases,
            input.state.session.as_ref().is_some_and(|s| {
                s.owner_ref == input.access.owner_ref && s.session_id == command.session_id
            }),
        );
    }
    let mut state = input.state.clone();
    let mut effects = vec![];
    let now = input.source.operational_world.now_ms;
    let kind = if command.action == ConductorCommandActionV1::StartSession {
        require(
            command.expected_revision == 0 && command.expected_manifest_revision.is_none(),
            "conductor_stale_revision",
        )?;
        require(
            state
                .session
                .as_ref()
                .is_none_or(|s| s.status == ConductorSessionStatusV1::Ended),
            "conductor_train_reserved",
        )?;
        require(
            state
                .command_receipts
                .values()
                .all(|r| r.session_id != command.session_id),
            "conductor_session_id_reused",
        )?;
        require(
            input
                .access
                .other_active_session_id
                .as_ref()
                .is_none_or(|id| id == &command.session_id),
            "conductor_account_reserved",
        )?;
        let live = source::live(&state, &input.source, &input.access)?;
        let position = live
            .layout
            .nodes
            .iter()
            .find(|n| n.node_id == live.layout.entrance_node_id)
            .ok_or(ConductorSessionError("conductor_entrance_missing"))?
            .point
            .clone();
        state.session = Some(ConductorSessionV1 {
            session_id: command.session_id.clone(),
            operator_id: input.access.operator_id.clone(),
            owner_ref: input.access.owner_ref.clone(),
            status: ConductorSessionStatusV1::Active,
            revision: 0,
            now_ms: now,
            started_at_ms: now,
            lease_until_ms: add_time(now, input.source.session_policy.lease_duration_ms)?,
            ended_at_ms: None,
            end_reason: None,
            position,
            active_encounter_id: None,
            pins: live.pins.clone(),
            policy: input.source.session_policy.clone(),
            movement_budget_mm: u64::from(input.source.session_policy.max_movement_burst_mm),
            movement_budget_at_ms: now,
            command_window_start_ms: now,
            commands_in_window: 0,
            last_command_at_ms: None,
        });
        state.layout = Some(live.layout);
        state.passengers = Some(live.passengers);
        ConductorSessionEventKindV1::Started
    } else {
        let session = state
            .session
            .as_ref()
            .ok_or(ConductorSessionError("conductor_session_missing"))?;
        require(
            session.session_id == command.session_id
                && session.owner_ref == input.access.owner_ref
                && session.operator_id == input.access.operator_id,
            "conductor_access_denied",
        )?;
        require(
            session.revision == command.expected_revision,
            "conductor_stale_revision",
        )?;
        require(
            session.status != ConductorSessionStatusV1::Ended,
            "conductor_session_ended",
        )?;
        if let Some(reason) = termination(&state, &input.source, &input.access)? {
            end(
                &mut state,
                &input.source,
                reason,
                &command.idempotency_key,
                &mut effects,
            )?;
            ConductorSessionEventKindV1::Ended
        } else if command.action == ConductorCommandActionV1::EndSession {
            end(
                &mut state,
                &input.source,
                ConductorSessionEndReasonV1::Requested,
                &command.idempotency_key,
                &mut effects,
            )?;
            ConductorSessionEventKindV1::Ended
        } else {
            let live = source::live(&state, &input.source, &input.access)?;
            if matches!(
                command.action,
                ConductorCommandActionV1::StartInspection { .. }
                    | ConductorCommandActionV1::ChooseDialogueOption { .. }
                    | ConductorCommandActionV1::RequestPolice { .. }
            ) {
                require(
                    command.expected_manifest_revision
                        == Some(live.passengers.binding.manifest_revision),
                    "conductor_stale_manifest",
                )?;
            }
            if let ConductorCommandActionV1::ChooseDialogueOption { option_id }
            | ConductorCommandActionV1::RequestPolice { option_id } = &command.action
            {
                let encounter_id = active_id(&state)
                    .ok_or(ConductorSessionError("conductor_encounter_missing"))?;
                let record = &state.encounters[&encounter_id];
                let visible = project_encounter(
                    source::dialogue_release(
                        &input.source.dialogue_releases,
                        &record.dialogue.release_hash,
                    )?,
                    &record.dialogue,
                )
                .map_err(|_| ConductorSessionError("conductor_dialogue_state_invalid"))?;
                require(
                    visible
                        .options
                        .iter()
                        .any(|option| &option.option_id == option_id),
                    "conductor_dialogue_option_not_offered",
                )?;
            }
            refresh(
                &mut state,
                &input.source,
                live,
                &command.idempotency_key,
                &mut effects,
            )?;
            if !matches!(
                command.action,
                ConductorCommandActionV1::DetachSession | ConductorCommandActionV1::ResumeSession
            ) {
                require(
                    state.session.as_ref().expect("Sitzung").status
                        == ConductorSessionStatusV1::Active,
                    "conductor_session_detached",
                )?;
                rate(state.session.as_mut().expect("Sitzung"), now)?;
            }
            match &command.action {
                ConductorCommandActionV1::Move {
                    to,
                    transition_edge_id,
                } => {
                    require(active_id(&state).is_none(), "conductor_encounter_active")?;
                    let session = state.session.as_mut().expect("Sitzung");
                    let layout = state.layout.as_ref().expect("Layout");
                    let movement = check_interior_movement(&CheckInteriorMovementInputV1 {
                        schema_version: "conductor-interior-movement-input/v1".into(),
                        layout: layout.clone(),
                        expected_layout_hash: layout.layout_hash.clone(),
                        from: session.position.clone(),
                        to: to.clone(),
                        transition_edge_id: transition_edge_id.clone(),
                        wheelchair: false,
                    })
                    .map_err(|_| ConductorSessionError("conductor_movement_invalid"))?;
                    require(movement.allowed, "conductor_movement_blocked")?;
                    let length = if let Some(id) = transition_edge_id {
                        layout
                            .edges
                            .iter()
                            .find(|e| &e.edge_id == id)
                            .ok_or(ConductorSessionError("conductor_transition_missing"))?
                            .length_mm
                    } else {
                        distance(&session.position, to)
                            .ok_or(ConductorSessionError("conductor_movement_invalid"))?
                    };
                    let elapsed = u64::try_from(now - session.movement_budget_at_ms)
                        .map_err(|_| ConductorSessionError("conductor_time_regression"))?;
                    let credit = u128::from(elapsed)
                        * u128::from(session.policy.walk_speed_mm_per_second)
                        / 1000;
                    let budget = (u128::from(session.movement_budget_mm) + credit)
                        .min(u128::from(session.policy.max_movement_burst_mm));
                    require(
                        u128::from(length) <= budget,
                        "conductor_movement_rate_limited",
                    )?;
                    session.movement_budget_mm =
                        u64::try_from(budget - u128::from(length)).expect("begrenzt");
                    session.movement_budget_at_ms = now;
                    session.position = to.clone();
                    ConductorSessionEventKindV1::PositionChanged
                }
                ConductorCommandActionV1::StartInspection { passenger_key } => {
                    require(active_id(&state).is_none(), "conductor_encounter_active")?;
                    check_inspection_range(&state, passenger_key)?;
                    let encounter_id = key(&[
                        "conductor-encounter-v1",
                        &state.world_id,
                        &state.train_run_id,
                        passenger_key,
                    ]);
                    require(
                        !state.encounters.contains_key(&encounter_id),
                        "conductor_passenger_already_inspected",
                    )?;
                    let projection = input.source.projection.as_ref().expect("validierte Quelle");
                    let segment = &state.passengers.as_ref().expect("Projektion").segment_id;
                    let passenger = projection
                        .evaluation
                        .manifests
                        .iter()
                        .find(|m| m.train_run_id == state.train_run_id && m.segment_id == *segment)
                        .and_then(|m| {
                            m.passengers
                                .iter()
                                .find(|p| p.passenger_key == *passenger_key)
                        })
                        .ok_or(ConductorSessionError(
                            "conductor_manifest_passenger_missing",
                        ))?;
                    let session = state.session.as_ref().expect("Sitzung");
                    let release = source::dialogue_release(
                        &input.source.dialogue_releases,
                        &session.pins.dialogue_release_hash,
                    )?;
                    let evidence = input
                        .source
                        .encounter_evidence
                        .iter()
                        .find(|e| e.encounter_id == encounter_id)
                        .map_or_else(DialogueEvidenceV1::default, |e| e.evidence.clone());
                    let result = start_dialogue(
                        release,
                        &StartDialogueInputV1 {
                            world_id: state.world_id.clone(),
                            period_id: session.pins.period_id.clone(),
                            train_run_id: state.train_run_id.clone(),
                            passenger_key: passenger_key.clone(),
                            encounter_id: encounter_id.clone(),
                            now_ms: now,
                            release_hash: session.pins.dialogue_release_hash.clone(),
                            seed: projection.binding.seed_hash.clone(),
                            fare_fact: passenger.fare_fact,
                            evidence,
                        },
                    )
                    .map_err(|_| ConductorSessionError("conductor_dialogue_start_failed"))?;
                    state.encounters.insert(
                        encounter_id.clone(),
                        ConductorEncounterRecordV1 {
                            encounter_id: encounter_id.clone(),
                            passenger_key: passenger_key.clone(),
                            dialogue: result.state,
                            closed_by_session: false,
                        },
                    );
                    state.session.as_mut().expect("Sitzung").active_encounter_id =
                        Some(encounter_id);
                    ConductorSessionEventKindV1::InspectionStarted
                }
                ConductorCommandActionV1::ChooseDialogueOption { option_id }
                | ConductorCommandActionV1::RequestPolice { option_id } => {
                    let id = active_id(&state)
                        .ok_or(ConductorSessionError("conductor_encounter_missing"))?;
                    let mut record = state.encounters[&id].clone();
                    let result = advance_dialogue(
                        source::dialogue_release(
                            &input.source.dialogue_releases,
                            &record.dialogue.release_hash,
                        )?,
                        &record.dialogue,
                        &ChooseDialogueInputV1 {
                            command_id: key(&[&command.session_id, &command.idempotency_key]),
                            expected_revision: record.dialogue.revision,
                            now_ms: now,
                            option_id: option_id.clone(),
                            evidence: record.dialogue.evidence.clone(),
                        },
                    )
                    .map_err(|_| ConductorSessionError("conductor_dialogue_option_rejected"))?;
                    let police = matches!(
                        command.action,
                        ConductorCommandActionV1::RequestPolice { .. }
                    );
                    require(
                        police == (result.intent == Some(DialogueIntentV1::RequestPolice)),
                        "conductor_police_command_mismatch",
                    )?;
                    record.dialogue = result.state;
                    if let Some(intent) = result.intent {
                        effects.push(effect(
                            &state,
                            &record,
                            intent,
                            now,
                            &command.idempotency_key,
                        ));
                    }
                    if record.dialogue.status == EncounterStatusV1::Closed {
                        state.session.as_mut().expect("Sitzung").active_encounter_id = None;
                    }
                    state.encounters.insert(id, record);
                    ConductorSessionEventKindV1::EncounterAdvanced
                }
                ConductorCommandActionV1::DetachSession => {
                    state.session.as_mut().expect("Sitzung").status =
                        ConductorSessionStatusV1::Detached;
                    ConductorSessionEventKindV1::Detached
                }
                ConductorCommandActionV1::ResumeSession => {
                    require(
                        input
                            .access
                            .other_active_session_id
                            .as_ref()
                            .is_none_or(|id| id == &command.session_id),
                        "conductor_account_reserved",
                    )?;
                    state.session.as_mut().expect("Sitzung").status =
                        ConductorSessionStatusV1::Active;
                    ConductorSessionEventKindV1::Resumed
                }
                _ => return Err(ConductorSessionError("invalid_conductor_action")),
            }
        }
    };
    let session = state.session.as_mut().expect("Sitzung");
    if session.status == ConductorSessionStatusV1::Active {
        session.lease_until_ms = add_time(now, session.policy.lease_duration_ms)?;
    }
    require(
        state.command_receipts.len() < usize::try_from(session.policy.max_receipts).expect("u32"),
        "conductor_receipt_limit",
    )?;
    let event = state::event(&mut state, kind, now, &command.idempotency_key)?;
    let receipt = ConductorCommandReceiptV1 {
        schema_version: "conductor-command-receipt/v1".into(),
        world_id: state.world_id.clone(),
        train_run_id: state.train_run_id.clone(),
        session_id: command.session_id.clone(),
        idempotency_key: command.idempotency_key.clone(),
        command_hash,
        revision: event.revision,
        sequence: event.sequence,
        event_kind: kind,
    };
    state.command_receipts.insert(receipt_key, receipt.clone());
    state::transition(
        state,
        Some(receipt),
        vec![event],
        effects,
        &input.source.dialogue_releases,
        true,
    )
}

pub fn synchronize_conductor_session(
    input: &SynchronizeConductorSessionInputV1,
) -> Result<ConductorSessionTransitionV1, ConductorSessionError> {
    require(
        input.schema_version == "conductor-session-synchronize-input/v1" && id(&input.causality_id),
        "unsupported_conductor_session_schema",
    )?;
    state::validate_state(
        &input.state,
        &input.expected_state_hash,
        &input.source.dialogue_releases,
    )?;
    source::operational(&input.state, &input.source)?;
    let Some(session) = &input.state.session else {
        return state::transition(
            input.state.clone(),
            None,
            vec![],
            vec![],
            &input.source.dialogue_releases,
            false,
        );
    };
    require(
        input.access.world_id == input.state.world_id
            && input.access.owner_ref == session.owner_ref
            && input.access.operator_id == session.operator_id,
        "conductor_access_denied",
    )?;
    let visible = input.access.world_access_active
        && input.access.operator_active
        && input.access.train_use_authorized;
    let mut state = input.state.clone();
    let mut effects = vec![];
    let mut changed = merge_control(&mut state, &input.source)?;
    let kind = if let Some(reason) = termination(&state, &input.source, &input.access)? {
        end(
            &mut state,
            &input.source,
            reason,
            &input.causality_id,
            &mut effects,
        )?;
        changed = true;
        ConductorSessionEventKindV1::Ended
    } else {
        if session.status != ConductorSessionStatusV1::Ended {
            let before = state.clone();
            let live = source::live(&state, &input.source, &input.access)?;
            refresh(
                &mut state,
                &input.source,
                live,
                &input.causality_id,
                &mut effects,
            )?;
            changed |= state != before;
        }
        ConductorSessionEventKindV1::SourceSynchronized
    };
    let events = if changed {
        vec![state::event(
            &mut state,
            kind,
            input.source.operational_world.now_ms,
            &input.causality_id,
        )?]
    } else {
        vec![]
    };
    state::transition(
        state,
        None,
        events,
        effects,
        &input.source.dialogue_releases,
        visible,
    )
}
