use crate::common::*;
use crate::*;
use std::collections::BTreeMap;
use zugfolge_conductor_dialogue::DocumentStatusV1;

pub fn initialize_fare_control(
    world_id: &str,
    operator_id: &str,
    now_ms: i64,
) -> Result<FareControlWorldStateV1, FareControlError> {
    need(
        id(world_id) && id(operator_id) && now_ms >= 0,
        "fare_initialization_invalid",
    )?;
    let mut state = FareControlWorldStateV1 {
        schema_version: "fare-control-world-state/v1".into(),
        world_id: world_id.into(),
        operator_id: operator_id.into(),
        revision: 0,
        now_ms,
        cases: BTreeMap::new(),
        police_plans: BTreeMap::new(),
        days: BTreeMap::new(),
        ledger_events: BTreeMap::new(),
        receipts: BTreeMap::new(),
        state_hash: String::new(),
    };
    state.state_hash = fare_control_state_hash(&state)?;
    Ok(state)
}
/// Nächste echte Zahlungs-/Nachweis-/Abschreibungsgrenze, ohne Tick-Quittung.
pub fn next_fare_control_wakeup(
    state: &FareControlWorldStateV1,
    expected_hash: &str,
) -> Result<Option<i64>, FareControlError> {
    restore_fare_control(state, expected_hash)?;
    let mut next = None;
    for case in state.cases.values() {
        let Some(opened) = case.claim_opened_at_ms else {
            continue;
        };
        let rules = rules(&case.pin.economy_release)?;
        let mut times = Vec::new();
        if !case.proof_processed {
            times.push(add(case.pin.inspected_at_ms, rules.valid_proof_delay_ms)?);
        }
        if !case.payment_processed {
            times.push(add(opened, rules.payment_delay_ms)?);
        }
        if nonnegative(&case.claim_cents)?
            > add(
                nonnegative(&case.paid_cents)?,
                nonnegative(&case.written_off_cents)?,
            )?
        {
            times.push(add(opened, rules.write_off_delay_ms)?);
        }
        for at in times {
            next = Some(next.map_or(at, |old: i64| old.min(at)));
        }
    }
    Ok(next)
}
pub fn restore_fare_control(
    state: &FareControlWorldStateV1,
    expected_hash: &str,
) -> Result<FareControlWorldStateV1, FareControlError> {
    need(
        state.schema_version == "fare-control-world-state/v1"
            && id(&state.world_id)
            && id(&state.operator_id)
            && state.now_ms >= 0
            && sha(expected_hash)
            && state.state_hash == expected_hash
            && fare_control_state_hash(state)? == expected_hash,
        "fare_state_invalid",
    )?;
    for (case_id, case) in &state.cases {
        validate_pin(&case.pin)?;
        let rules = rules(&case.pin.economy_release)?;
        let expected_deadline = add(
            day(case.pin.inspected_at_ms, rules),
            mul(i64::from(rules.proof_window_days) + 1, rules.day_length_ms)?,
        )?;
        need(
            case.schema_version == "fare-inspection-case/v1"
                && case.case_id == *case_id
                && id(case_id)
                && case.pin_hash == hash(&case.pin)?
                && case.pin.world_id == state.world_id
                && case.pin.operator_id == state.operator_id
                && case.pin.inspected_at_ms <= state.now_ms
                && case.proof_deadline_ms == expected_deadline
                && case.claim_kind.is_some() == case.claim_opened_at_ms.is_some()
                && case
                    .claim_opened_at_ms
                    .is_none_or(|at| at >= case.pin.inspected_at_ms && at <= state.now_ms)
                && case
                    .proof_received_at_ms
                    .is_none_or(|at| at >= case.pin.inspected_at_ms && at <= state.now_ms),
            "fare_case_state_invalid",
        )?;
        let original = nonnegative(&case.original_claim_cents)?;
        let claim = nonnegative(&case.claim_cents)?;
        let paid = nonnegative(&case.paid_cents)?;
        let written_off = nonnegative(&case.written_off_cents)?;
        nonnegative(&case.costs_cents)?;
        need(
            original >= claim
                && add(paid, written_off)? <= claim
                && add(claim, nonnegative(&case.reduced_cents)?)? == original,
            "fare_case_balance_invalid",
        )?;
        if let Some(hold) = &case.police_hold_id {
            need(
                state.police_plans.contains_key(hold),
                "fare_police_plan_missing",
            )?;
        }
    }
    for (key, event) in &state.ledger_events {
        need(
            event.event_id == *key
                && sha(key)
                && event.world_id == state.world_id
                && event.operator_id == state.operator_id
                && event.at_ms <= state.now_ms
                && event.at_ms >= 0
                && event.day_start_ms >= 0
                && sha(&event.economy_release_hash)
                && event
                    .case_id
                    .as_ref()
                    .is_none_or(|id| state.cases.contains_key(id))
                && event.postings.len() >= 2,
            "fare_ledger_state_invalid",
        )?;
        let total = event
            .postings
            .iter()
            .try_fold(0, |sum, posting| add(sum, amount(&posting.amount_cents)?))?;
        need(total == 0, "fare_ledger_unbalanced")?;
    }
    for (key, receipt) in &state.receipts {
        need(
            receipt.command_id == *key
                && id(key)
                && sha(&receipt.command_hash)
                && sha(&receipt.domain_state_hash)
                && receipt.revision <= state.revision
                && receipt
                    .ledger_event_ids
                    .iter()
                    .all(|id| state.ledger_events.contains_key(id)),
            "fare_receipt_invalid",
        )?;
        match &receipt.binding {
            Some(FareControlEffectBindingV1::Claim { case_id }) => need(
                state
                    .cases
                    .get(case_id)
                    .is_some_and(|case| case.claim_kind.is_some()),
                "fare_receipt_invalid",
            )?,
            Some(FareControlEffectBindingV1::Hold { hold_id, case_ids }) => need(
                !case_ids.is_empty()
                    && state.police_plans.get(hold_id).is_some_and(|plan| {
                        case_ids
                            .iter()
                            .all(|id| plan.cases.iter().any(|case| &case.case_id == id))
                    }),
                "fare_receipt_invalid",
            )?,
            None => {}
        }
    }
    for (key, plan) in &state.police_plans {
        need(
            plan.hold_id == *key
                && id(key)
                && plan.world_id == state.world_id
                && plan.operator_id == state.operator_id
                && plan.plan_hash == crate::police::plan_hash(plan)?
                && plan.requested_at_ms <= state.now_ms
                && plan.cases.iter().all(|case| {
                    state
                        .cases
                        .get(&case.case_id)
                        .is_some_and(|stored| stored.police_hold_id.as_deref() == Some(key))
                }),
            "fare_police_state_invalid",
        )?;
    }
    Ok(state.clone())
}
pub fn project_fare_cases(
    state: &FareControlWorldStateV1,
    expected_hash: &str,
    world_id: &str,
    operator_id: &str,
) -> Result<Vec<FareInspectionCaseViewV1>, FareControlError> {
    need(
        state.world_id == world_id && state.operator_id == operator_id,
        "fare_projection_binding_invalid",
    )?;
    restore_fare_control(state, expected_hash)?;
    Ok(state
        .cases
        .values()
        .map(|case| FareInspectionCaseViewV1 {
            case_id: case.case_id.clone(),
            encounter_id: case.pin.encounter_id.clone(),
            train_run_id: case.pin.train_run_id.clone(),
            status: case.status,
            evidence: case.evidence.clone(),
            claim_kind: case.claim_kind,
            claim_cents: case.claim_cents.clone(),
            paid_cents: case.paid_cents.clone(),
            costs_cents: case.costs_cents.clone(),
            written_off_cents: case.written_off_cents.clone(),
            proof_deadline_ms: case.proof_deadline_ms,
        })
        .collect())
}
pub fn project_fare_control_report(
    state: &FareControlWorldStateV1,
    expected_hash: &str,
    world_id: &str,
    operator_id: &str,
) -> Result<FareControlReportV1, FareControlError> {
    let cases = project_fare_cases(state, expected_hash, world_id, operator_id)?;
    let mut days = Vec::with_capacity(state.days.len());
    for (key, day) in &state.days {
        need(
            key == &day.day_start_ms.to_string()
                && day.day_start_ms >= 0
                && day.day_start_ms <= state.now_ms
                && day.settlement_revision > 0
                && sha(&day.economy_release_hash),
            "fare_day_state_invalid",
        )?;
        nonnegative(&day.contract_revenue_cents)?;
        let contribution = i128::from(amount(&day.net_cents)?)
            + i128::from(nonnegative(&day.premium_cents)?)
            - i128::from(nonnegative(&day.cap_adjustment_cents)?);
        let contribution = i64::try_from(contribution)
            .map_err(|_| FareControlError("fare_arithmetic_overflow"))?;
        days.push(FareDayReportV1 {
            day_start_ms: day.day_start_ms,
            contract_revenue_cents: day.contract_revenue_cents.clone(),
            net_cents: day.net_cents.clone(),
            premium_cents: day.premium_cents.clone(),
            cap_adjustment_cents: day.cap_adjustment_cents.clone(),
            contribution_cents: contribution.to_string(),
            settlement_revision: day.settlement_revision,
        });
    }
    days.sort_by_key(|day| day.day_start_ms);
    Ok(FareControlReportV1 { cases, days })
}
pub fn apply_fare_control(
    state: &FareControlWorldStateV1,
    expected_hash: &str,
    command: &FareControlCommandV1,
) -> Result<FareControlTransitionV1, FareControlError> {
    let mut next = restore_fare_control(state, expected_hash)?;
    need(
        command.world_id == state.world_id
            && command.operator_id == state.operator_id
            && id(&command.command_id),
        "fare_command_binding_invalid",
    )?;
    // CAS-Revision ist keine neue fachliche Absicht bei erneutem Zustellversuch.
    let command_hash = hash(&(
        &command.world_id,
        &command.operator_id,
        &command.command_id,
        command.now_ms,
        &command.action,
    ))?;
    if let Some(receipt) = state.receipts.get(&command.command_id) {
        need(
            receipt.command_hash == command_hash,
            "fare_command_conflict",
        )?;
        let ledger_events = receipt
            .ledger_event_ids
            .iter()
            .map(|id| state.ledger_events[id].clone())
            .collect();
        return Ok(FareControlTransitionV1 {
            state: next,
            receipt: receipt.clone(),
            ledger_events,
        });
    }
    need(
        command.expected_revision == state.revision,
        "fare_stale_revision",
    )?;
    need(command.now_ms >= state.now_ms, "fare_time_regression")?;
    next.now_ms = command.now_ms;
    let mut affected_case = None;
    match &command.action {
        FareControlActionV1::OpenCase { case_id, pin } => {
            crate::cases::open_case(&mut next, command, case_id, pin)?;
            affected_case = Some(case_id.clone());
        }
        FareControlActionV1::InspectDocument { case_id }
        | FareControlActionV1::CreateClaim { case_id, .. }
        | FareControlActionV1::CloseCase { case_id }
        | FareControlActionV1::ReceiveProof { case_id, .. } => {
            let mut case = next
                .cases
                .remove(case_id)
                .ok_or(FareControlError("fare_case_missing"))?;
            match &command.action {
                FareControlActionV1::InspectDocument { .. } => crate::cases::inspect(&mut case)?,
                FareControlActionV1::CreateClaim { kind, .. } => {
                    crate::cases::create_claim(&mut next, command, &mut case, *kind)?
                }
                FareControlActionV1::CloseCase { .. } => crate::cases::close(&mut case),
                FareControlActionV1::ReceiveProof { received_at_ms, .. } => {
                    need(
                        *received_at_ms >= case.pin.inspected_at_ms
                            && *received_at_ms <= command.now_ms,
                        "fare_proof_time_invalid",
                    )?;
                    case.proof_received_at_ms = Some(
                        case.proof_received_at_ms
                            .map_or(*received_at_ms, |old| old.min(*received_at_ms)),
                    );
                    case.evidence.document_status =
                        if case.pin.passenger.fare_fact == zugfolge_demand::FareFactV1::Invalid {
                            DocumentStatusV1::VerifiedInvalid
                        } else {
                            DocumentStatusV1::VerifiedValid
                        };
                    crate::economy::advance_case(&mut next, command, &mut case)?;
                }
                _ => unreachable!("Gepaarte Fallaktion"),
            }
            next.cases.insert(case_id.clone(), case);
            affected_case = Some(case_id.clone());
        }
        FareControlActionV1::AdvanceTime => {
            for key in next.cases.keys().cloned().collect::<Vec<_>>() {
                let mut case = next.cases.remove(&key).expect("Vorhandener Fall");
                crate::economy::advance_case(&mut next, command, &mut case)?;
                next.cases.insert(key, case);
            }
        }
        FareControlActionV1::PlanPolice {
            hold_id,
            train_run_id,
            target_stop_id,
            case_ids,
            model,
        } => crate::police::plan(
            &mut next,
            command,
            hold_id,
            train_run_id,
            target_stop_id,
            case_ids,
            model,
        )?,
        FareControlActionV1::ResolvePolice { evidence } => {
            crate::police::resolve(&mut next, command, evidence)?
        }
        FareControlActionV1::SettleDay {
            day_start_ms,
            contract_revenue_evidence,
            economy_release,
        } => crate::economy::settle_day(
            &mut next,
            command,
            *day_start_ms,
            contract_revenue_evidence,
            economy_release,
        )?,
    }
    next.revision = next
        .revision
        .checked_add(1)
        .ok_or(FareControlError("fare_arithmetic_overflow"))?;
    let ledger_events = next
        .ledger_events
        .values()
        .filter(|event| !state.ledger_events.contains_key(&event.event_id))
        .cloned()
        .collect::<Vec<_>>();
    let binding = match &command.action {
        FareControlActionV1::CreateClaim { case_id, .. } => {
            Some(FareControlEffectBindingV1::Claim {
                case_id: case_id.clone(),
            })
        }
        FareControlActionV1::PlanPolice {
            hold_id, case_ids, ..
        } => Some(FareControlEffectBindingV1::Hold {
            hold_id: hold_id.clone(),
            case_ids: case_ids.clone(),
        }),
        _ => None,
    };
    let domain_state_hash = hash(&(
        &next.world_id,
        &next.operator_id,
        next.revision,
        next.now_ms,
        &next.cases,
        &next.police_plans,
        &next.days,
        &next.ledger_events,
    ))?;
    let receipt = FareControlReceiptV1 {
        command_id: command.command_id.clone(),
        command_hash,
        domain_state_hash,
        revision: next.revision,
        case_id: affected_case,
        binding,
        ledger_event_ids: ledger_events
            .iter()
            .map(|event| event.event_id.clone())
            .collect(),
    };
    next.receipts
        .insert(command.command_id.clone(), receipt.clone());
    next.state_hash = fare_control_state_hash(&next)?;
    restore_fare_control(&next, &next.state_hash)?;
    Ok(FareControlTransitionV1 {
        state: next,
        receipt,
        ledger_events,
    })
}
