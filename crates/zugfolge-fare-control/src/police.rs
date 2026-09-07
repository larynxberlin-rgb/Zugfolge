use crate::common::*;
use crate::*;
use zugfolge_conductor_dialogue::{DocumentStatusV1, IdentityStatusV1};

pub(crate) fn plan_hash(plan: &PoliceResponsePlanV1) -> Result<String, FareControlError> {
    let mut value = plan.clone();
    value.plan_hash.clear();
    hash(&value)
}
fn validate_model(model: &PoliceResponseModelV1, world: &str) -> Result<(), FareControlError> {
    need(
        model.schema_version == "police-response-model/v1"
            && id(&model.model_id)
            && model.world_id == world
            && model.content_hash == police_response_model_hash(model)?
            && [
                model.available_basis_points,
                model.delayed_basis_points,
                model.identity_success_basis_points,
            ]
            .iter()
            .all(|n| *n <= 10_000)
            && model.response_ms >= 0
            && model.delayed_response_ms >= model.response_ms,
        "fare_police_model_invalid",
    )
}
#[allow(
    clippy::too_many_arguments,
    reason = "Vollständige betriebliche Bindung der gebündelten Anfrage"
)]
pub(crate) fn plan(
    state: &mut FareControlWorldStateV1,
    command: &FareControlCommandV1,
    hold_id: &str,
    train: &str,
    target: &str,
    case_ids: &[String],
    model: &PoliceResponseModelV1,
) -> Result<(), FareControlError> {
    validate_model(model, &state.world_id)?;
    need(
        id(hold_id) && id(train) && id(target) && !case_ids.is_empty(),
        "fare_police_input_invalid",
    )?;
    let mut ids = case_ids.to_vec();
    ids.sort();
    ids.dedup();
    need(ids.len() == case_ids.len(), "fare_police_input_invalid")?;
    let existing = state.police_plans.get(hold_id).cloned();
    need(
        !state
            .police_plans
            .values()
            .any(|plan| plan.train_run_id == train && plan.hold_id != hold_id),
        "fare_police_budget_exhausted",
    )?;
    let mut selected = if let Some(plan) = existing {
        need(
            plan.train_run_id == train
                && plan.target_stop_id == target
                && plan.model == *model
                && plan.resolution == PoliceResolutionV1::Pending,
            "fare_police_plan_conflict",
        )?;
        plan
    } else {
        let request = command.now_ms.to_string();
        let available = sample(&[
            "police_response:availability",
            &state.world_id,
            train,
            target,
            &model.content_hash,
            &request,
        ])? < model.available_basis_points;
        let delayed = sample(&[
            "police_response:delay",
            &state.world_id,
            train,
            target,
            &model.content_hash,
            &request,
        ])? < model.delayed_basis_points;
        PoliceResponsePlanV1 {
            world_id: state.world_id.clone(),
            operator_id: state.operator_id.clone(),
            hold_id: hold_id.into(),
            train_run_id: train.into(),
            target_stop_id: target.into(),
            requested_at_ms: command.now_ms,
            model: model.clone(),
            available,
            response_after_activation_ms: if delayed {
                model.delayed_response_ms
            } else {
                model.response_ms
            },
            cases: Vec::new(),
            resolution: PoliceResolutionV1::Pending,
            plan_hash: String::new(),
        }
    };
    for case_id in ids {
        let case = state
            .cases
            .get(&case_id)
            .ok_or(FareControlError("fare_case_missing"))?;
        need(
            case.pin.train_run_id == train
                && matches!(
                    case.status,
                    FareInspectionCaseStatusV1::Open | FareInspectionCaseStatusV1::ClaimOpen
                )
                && (case.evidence.identity_status == IdentityStatusV1::Refused
                    || case.evidence.concrete_danger)
                && case
                    .police_hold_id
                    .as_deref()
                    .is_none_or(|id| id == hold_id),
            "fare_police_case_ineligible",
        )?;
        if !selected
            .cases
            .iter()
            .any(|outcome| outcome.case_id == case_id)
        {
            let success = case.evidence.identity_status == IdentityStatusV1::Confirmed
                || sample(&[
                    "police_response:identity",
                    &case.pin.world_id,
                    train,
                    &case.pin.passenger.passenger_key,
                    &case.pin.seed_hash,
                    &model.content_hash,
                ])? < model.identity_success_basis_points;
            selected.cases.push(PoliceCaseOutcomeV1 {
                case_id: case_id.clone(),
                identity_confirmed: success,
            });
        }
        state
            .cases
            .get_mut(&case_id)
            .expect("Fall wurde geprüft")
            .police_hold_id = Some(hold_id.into());
    }
    selected.cases.sort_by(|a, b| a.case_id.cmp(&b.case_id));
    selected.plan_hash = plan_hash(&selected)?;
    state.police_plans.insert(hold_id.into(), selected);
    Ok(())
}
fn binding(
    plan: &PoliceResponsePlanV1,
    evidence: &PoliceOperationalEvidenceV1,
) -> Result<(), FareControlError> {
    need(
        plan.world_id == evidence.world_id
            && plan.train_run_id == evidence.train_run_id
            && plan.hold_id == evidence.hold_id
            && plan.target_stop_id == evidence.target_stop_id
            && plan.model.content_hash == evidence.model_hash
            && sha(&evidence.operational_state_hash)
            && plan.plan_hash == plan_hash(plan)?,
        "fare_police_operational_binding_invalid",
    )
}
/// Liefert nur die fällige Absicht für den echten Operational-Resolve-Befehl.
pub fn police_response_due(
    plan: &PoliceResponsePlanV1,
    evidence: &PoliceOperationalEvidenceV1,
    now_ms: i64,
) -> Result<Option<PoliceResolutionV1>, FareControlError> {
    binding(plan, evidence)?;
    if plan.resolution != PoliceResolutionV1::Pending || evidence.released_at_ms.is_some() {
        return Ok(None);
    }
    let (Some(active), Some(deadline)) = (evidence.activated_at_ms, evidence.deadline_ms) else {
        return Ok(None);
    };
    need(
        active >= plan.requested_at_ms && deadline >= active && now_ms >= active,
        "fare_police_time_invalid",
    )?;
    if now_ms >= deadline {
        return Ok(None);
    } // Den Timeout entscheidet der Betrieb selbst.
    if !plan.available {
        return Ok(Some(PoliceResolutionV1::Unavailable));
    }
    if now_ms < add(active, plan.response_after_activation_ms)? {
        return Ok(None);
    }
    Ok(Some(
        if plan.cases.iter().any(|case| case.identity_confirmed) {
            PoliceResolutionV1::IdentityConfirmed
        } else {
            PoliceResolutionV1::IdentityNotConfirmed
        },
    ))
}
pub(crate) fn resolve(
    state: &mut FareControlWorldStateV1,
    command: &FareControlCommandV1,
    evidence: &PoliceOperationalEvidenceV1,
) -> Result<(), FareControlError> {
    let mut plan = state
        .police_plans
        .get(&evidence.hold_id)
        .cloned()
        .ok_or(FareControlError("fare_police_plan_missing"))?;
    binding(&plan, evidence)?;
    let released = evidence
        .released_at_ms
        .ok_or(FareControlError("fare_police_not_released"))?;
    need(
        released <= command.now_ms && released >= plan.requested_at_ms,
        "fare_police_time_invalid",
    )?;
    if plan.resolution != PoliceResolutionV1::Pending {
        return need(
            plan.resolution == evidence.outcome,
            "fare_police_resolution_conflict",
        );
    }
    if evidence.target_unavailable {
        need(
            evidence.outcome == PoliceResolutionV1::TargetUnavailable
                && evidence.activated_at_ms.is_none(),
            "fare_police_outcome_invalid",
        )?;
    } else {
        let active = evidence
            .activated_at_ms
            .ok_or(FareControlError("fare_police_not_activated"))?;
        let deadline = evidence
            .deadline_ms
            .ok_or(FareControlError("fare_police_not_activated"))?;
        need(
            active >= plan.requested_at_ms && deadline >= active && released >= active,
            "fare_police_time_invalid",
        )?;
        match evidence.outcome {
            PoliceResolutionV1::TimedOut => {
                need(released >= deadline, "fare_police_outcome_invalid")?
            }
            PoliceResolutionV1::Unavailable => need(
                !plan.available && released < deadline,
                "fare_police_outcome_invalid",
            )?,
            PoliceResolutionV1::IdentityConfirmed | PoliceResolutionV1::IdentityNotConfirmed => {
                need(
                    plan.available
                        && released >= add(active, plan.response_after_activation_ms)?
                        && released < deadline
                        && (evidence.outcome == PoliceResolutionV1::IdentityConfirmed)
                            == plan.cases.iter().any(|case| case.identity_confirmed),
                    "fare_police_outcome_invalid",
                )?;
            }
            _ => return Err(FareControlError("fare_police_outcome_invalid")),
        }
    }
    for outcome in &plan.cases {
        let mut case = state
            .cases
            .remove(&outcome.case_id)
            .ok_or(FareControlError("fare_case_missing"))?;
        let success = matches!(
            evidence.outcome,
            PoliceResolutionV1::IdentityConfirmed | PoliceResolutionV1::IdentityNotConfirmed
        ) && outcome.identity_confirmed;
        if success {
            case.evidence.identity_status = IdentityStatusV1::Confirmed;
        }
        let cost = nonnegative(&rules(&case.pin.economy_release)?.police_handling_cost_cents)?;
        crate::economy::cost(state, command, &mut case, cost, "police-handling")?;
        if case.status == FareInspectionCaseStatusV1::Open {
            let kind = if case.evidence.document_status == DocumentStatusV1::VerifiedInvalid {
                FareClaimKindV1::Regular
            } else {
                FareClaimKindV1::Provisional
            };
            if success && crate::cases::claim_allowed(&case, kind) {
                crate::cases::create_claim(state, command, &mut case, kind)?;
            } else {
                case.status = FareInspectionCaseStatusV1::ClosedWithoutClaim;
            }
        }
        state.cases.insert(outcome.case_id.clone(), case);
    }
    plan.resolution = evidence.outcome;
    plan.plan_hash = plan_hash(&plan)?;
    state.police_plans.insert(evidence.hold_id.clone(), plan);
    Ok(())
}
