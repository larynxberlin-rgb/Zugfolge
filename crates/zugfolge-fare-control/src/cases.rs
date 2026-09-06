use crate::common::*;
use crate::economy::{cost, post};
use crate::*;
use zugfolge_conductor_dialogue::{AcquisitionExceptionV1, DocumentStatusV1, IdentityStatusV1};
use zugfolge_demand::FareFactV1;

pub(crate) fn open_case(
    state: &mut FareControlWorldStateV1,
    command: &FareControlCommandV1,
    case_id: &str,
    pin: &FareInspectionPinV1,
) -> Result<(), FareControlError> {
    validate_pin(pin)?;
    need(
        id(case_id)
            && pin.world_id == state.world_id
            && pin.operator_id == state.operator_id
            && pin.inspected_at_ms <= command.now_ms,
        "fare_case_binding_invalid",
    )?;
    let pin_hash = hash(pin)?;
    if let Some(existing) = state.cases.get(case_id) {
        return need(existing.pin_hash == pin_hash, "fare_case_pin_conflict");
    }
    need(
        !state.cases.values().any(|case| {
            case.pin.train_run_id == pin.train_run_id
                && case.pin.passenger.passenger_key == pin.passenger.passenger_key
        }),
        "fare_case_already_exists",
    )?;
    let rules = rules(&pin.economy_release)?;
    // Ereignistag zählt nicht; die Woche endet mit Ablauf des entsprechenden
    // siebten Folgetags. Der Grenzwert ist exklusiv, vgl. §§187/188 BGB.
    let deadline = add(
        day(pin.inspected_at_ms, rules),
        mul(i64::from(rules.proof_window_days) + 1, rules.day_length_ms)?,
    )?;
    state.cases.insert(
        case_id.into(),
        FareInspectionCaseV1 {
            schema_version: "fare-inspection-case/v1".into(),
            case_id: case_id.into(),
            pin: pin.clone(),
            pin_hash,
            status: FareInspectionCaseStatusV1::Open,
            evidence: Default::default(),
            claim_kind: None,
            claim_opened_at_ms: None,
            original_claim_cents: "0".into(),
            claim_cents: "0".into(),
            paid_cents: "0".into(),
            costs_cents: "0".into(),
            written_off_cents: "0".into(),
            reduced_cents: "0".into(),
            proof_deadline_ms: deadline,
            proof_received_at_ms: None,
            payment_processed: false,
            proof_processed: false,
            police_hold_id: None,
        },
    );
    Ok(())
}
pub(crate) fn inspect(case: &mut FareInspectionCaseV1) -> Result<(), FareControlError> {
    need(
        case.status == FareInspectionCaseStatusV1::Open,
        "fare_case_not_open",
    )?;
    if case.evidence.document_status != DocumentStatusV1::Unchecked {
        return Ok(());
    }
    let policy = &case.pin.inspection_policy;
    case.evidence.document_status = match case.pin.passenger.fare_fact {
        FareFactV1::Valid => DocumentStatusV1::VerifiedValid,
        FareFactV1::ValidUnpresentable => DocumentStatusV1::NotPresentable,
        FareFactV1::Invalid => {
            if case_sample(case, "fare_inspection:presented_document")?
                < policy.invalid_document_presented_basis_points
            {
                DocumentStatusV1::VerifiedInvalid
            } else {
                DocumentStatusV1::NotPresentable
            }
        }
    };
    case.evidence.acquisition_exception = match &case.pin.journey_evidence {
        Some(evidence)
            if evidence.ticket_office == FarePurchaseAvailabilityV1::Unavailable
                && evidence.ticket_machine == FarePurchaseAvailabilityV1::Unavailable =>
        {
            AcquisitionExceptionV1::Proven
        }
        Some(evidence)
            if evidence.ticket_office == FarePurchaseAvailabilityV1::Available
                || evidence.ticket_machine == FarePurchaseAvailabilityV1::Available =>
        {
            AcquisitionExceptionV1::Excluded
        }
        _ => AcquisitionExceptionV1::Unknown,
    };
    if case.evidence.document_status != DocumentStatusV1::VerifiedValid {
        case.evidence.identity_status = if case_sample(case, "fare_inspection:identity_request")?
            < policy.identity_refusal_basis_points
        {
            IdentityStatusV1::Refused
        } else {
            IdentityStatusV1::Confirmed
        };
    }
    case.evidence.concrete_danger =
        case_sample(case, "fare_inspection:concrete_danger")? < policy.concrete_danger_basis_points;
    Ok(())
}
pub(crate) fn claim_allowed(case: &FareInspectionCaseV1, kind: FareClaimKindV1) -> bool {
    case.status == FareInspectionCaseStatusV1::Open
        && case.evidence.identity_status == IdentityStatusV1::Confirmed
        && case.evidence.acquisition_exception == AcquisitionExceptionV1::Excluded
        && case
            .pin
            .journey_evidence
            .as_ref()
            .is_some_and(|evidence| evidence.ordinary_fare_cents.is_some())
        && match kind {
            FareClaimKindV1::Regular => {
                case.evidence.document_status == DocumentStatusV1::VerifiedInvalid
                    && case.pin.passenger.fare_fact == FareFactV1::Invalid
            }
            FareClaimKindV1::Provisional => {
                case.evidence.document_status == DocumentStatusV1::NotPresentable
            }
        }
}
pub(crate) fn create_claim(
    state: &mut FareControlWorldStateV1,
    command: &FareControlCommandV1,
    case: &mut FareInspectionCaseV1,
    kind: FareClaimKindV1,
) -> Result<(), FareControlError> {
    need(claim_allowed(case, kind), "fare_claim_not_allowed")?;
    let rules = rules(&case.pin.economy_release)?.clone();
    let fare = case
        .pin
        .journey_evidence
        .as_ref()
        .and_then(|evidence| evidence.ordinary_fare_cents.as_deref())
        .ok_or(FareControlError("fare_tariff_missing"))?;
    let claim = mul(
        nonnegative(fare)?,
        i64::from(rules.ordinary_fare_multiplier),
    )?
    .max(nonnegative(&rules.minimum_claim_cents)?);
    post(
        state,
        command,
        Some(&case.case_id),
        command.now_ms,
        FareLedgerEventKindV1::ClaimOpened,
        &case.pin.economy_release,
        &[
            (FareLedgerRoleV1::Receivable, claim),
            (FareLedgerRoleV1::ClaimAccrual, -claim),
        ],
        "claim-opened",
    )?;
    case.status = FareInspectionCaseStatusV1::ClaimOpen;
    case.claim_kind = Some(kind);
    case.claim_opened_at_ms = Some(command.now_ms);
    case.original_claim_cents = claim.to_string();
    case.claim_cents = claim.to_string();
    cost(
        state,
        command,
        case,
        nonnegative(&rules.handling_cost_cents)?,
        "claim-handling",
    )?;
    Ok(())
}
pub(crate) fn close(case: &mut FareInspectionCaseV1) {
    if case.status == FareInspectionCaseStatusV1::Open && case.police_hold_id.is_none() {
        case.status = FareInspectionCaseStatusV1::ClosedWithoutClaim;
    }
}
