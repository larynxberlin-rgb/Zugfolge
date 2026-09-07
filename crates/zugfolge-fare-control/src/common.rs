use crate::*;
use sha2::{Digest, Sha256};
use zugfolge_fleet::{
    FareInspectionEconomyV1,
    release_catalog::{EconomyReleaseDocument, validate_economy_release_document},
};
pub(crate) fn need(value: bool, code: &'static str) -> Result<(), FareControlError> {
    if value {
        Ok(())
    } else {
        Err(FareControlError(code))
    }
}
pub(crate) fn hash<T: serde::Serialize>(value: &T) -> Result<String, FareControlError> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| FareControlError("fare_serialization_invalid"))?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
pub(crate) fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_:-./".contains(&b))
}
pub(crate) fn sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn amount(value: &str) -> Result<i64, FareControlError> {
    let n = value
        .parse::<i64>()
        .map_err(|_| FareControlError("fare_amount_invalid"))?;
    need(n.to_string() == value, "fare_amount_invalid")?;
    Ok(n)
}
pub(crate) fn nonnegative(value: &str) -> Result<i64, FareControlError> {
    let n = amount(value)?;
    need(n >= 0, "fare_amount_invalid")?;
    Ok(n)
}
pub(crate) fn add(a: i64, b: i64) -> Result<i64, FareControlError> {
    a.checked_add(b)
        .ok_or(FareControlError("fare_arithmetic_overflow"))
}
pub(crate) fn mul(a: i64, b: i64) -> Result<i64, FareControlError> {
    a.checked_mul(b)
        .ok_or(FareControlError("fare_arithmetic_overflow"))
}
pub(crate) fn fraction(a: i64, b: u32) -> Result<i64, FareControlError> {
    i64::try_from(i128::from(a) * i128::from(b) / 10_000)
        .map_err(|_| FareControlError("fare_arithmetic_overflow"))
}
pub(crate) fn sample(parts: &[&str]) -> Result<u32, FareControlError> {
    let mut state = Sha256::new();
    for part in parts {
        state.update(
            u64::try_from(part.len())
                .map_err(|_| FareControlError("fare_input_invalid"))?
                .to_be_bytes(),
        );
        state.update(part.as_bytes());
    }
    let bytes = state.finalize();
    let mut head = [0; 8];
    head.copy_from_slice(&bytes[..8]);
    u32::try_from(u64::from_be_bytes(head) % 10_000)
        .map_err(|_| FareControlError("fare_input_invalid"))
}
pub fn fare_inspection_policy_hash(
    policy: &FareInspectionPolicyV1,
) -> Result<String, FareControlError> {
    let mut value = policy.clone();
    value.content_hash.clear();
    hash(&value)
}
pub fn fare_journey_evidence_hash(
    evidence: &FareJourneyEvidenceV1,
) -> Result<String, FareControlError> {
    let mut value = evidence.clone();
    value.content_hash.clear();
    hash(&value)
}
pub fn police_response_model_hash(
    model: &PoliceResponseModelV1,
) -> Result<String, FareControlError> {
    let mut value = model.clone();
    value.content_hash.clear();
    hash(&value)
}
pub fn fare_control_state_hash(
    state: &FareControlWorldStateV1,
) -> Result<String, FareControlError> {
    let mut value = state.clone();
    value.state_hash.clear();
    hash(&value)
}
pub fn fare_contract_revenue_evidence_hash(
    evidence: &FareContractRevenueEvidenceV1,
) -> Result<String, FareControlError> {
    let mut value = evidence.clone();
    value.content_hash.clear();
    hash(&value)
}
pub(crate) fn rules(
    release: &EconomyReleaseDocument,
) -> Result<&FareInspectionEconomyV1, FareControlError> {
    validate_economy_release_document(release)
        .map_err(|_| FareControlError("fare_economy_release_invalid"))?;
    release
        .fare_inspection
        .as_ref()
        .ok_or(FareControlError("fare_economy_rules_missing"))
}
pub(crate) fn validate_pin(pin: &FareInspectionPinV1) -> Result<(), FareControlError> {
    need(
        [
            &pin.world_id,
            &pin.operator_id,
            &pin.period_id,
            &pin.train_run_id,
            &pin.encounter_id,
            &pin.segment_id,
            &pin.passenger.passenger_key,
            &pin.passenger.boarding_stop_id,
            &pin.passenger.alighting_stop_id,
        ]
        .iter()
        .all(|s| id(s))
            && [
                &pin.demand_state_hash,
                &pin.dialogue_release_hash,
                &pin.seed_hash,
            ]
            .iter()
            .all(|s| sha(s))
            && pin.inspected_at_ms >= 0,
        "fare_pin_invalid",
    )?;
    let policy = &pin.inspection_policy;
    need(
        policy.schema_version == "fare-inspection-policy/v1"
            && id(&policy.policy_id)
            && policy.world_id == pin.world_id
            && policy.period_id == pin.period_id
            && policy.content_hash == fare_inspection_policy_hash(policy)?
            && [
                policy.invalid_document_presented_basis_points,
                policy.identity_refusal_basis_points,
                policy.concrete_danger_basis_points,
            ]
            .iter()
            .all(|n| *n <= 10_000),
        "fare_inspection_policy_invalid",
    )?;
    rules(&pin.economy_release)?;
    need(
        pin.expected_economy_release_hash == pin.economy_release.checksum,
        "fare_economy_pin_mismatch",
    )?;
    if let Some(evidence) = &pin.journey_evidence {
        need(
            evidence.schema_version == "fare-journey-evidence/v1"
                && id(&evidence.evidence_id)
                && id(&evidence.source_id)
                && evidence.world_id == pin.world_id
                && evidence.period_id == pin.period_id
                && evidence.train_run_id == pin.train_run_id
                && evidence.boarding_stop_id == pin.passenger.boarding_stop_id
                && evidence.alighting_stop_id == pin.passenger.alighting_stop_id
                && evidence.content_hash == fare_journey_evidence_hash(evidence)?,
            "fare_journey_evidence_invalid",
        )?;
        if let Some(fare) = &evidence.ordinary_fare_cents {
            nonnegative(fare)?;
        }
    }
    Ok(())
}
pub(crate) fn day(at: i64, rules: &FareInspectionEconomyV1) -> i64 {
    at / rules.day_length_ms * rules.day_length_ms
}
pub(crate) fn case_sample(
    case: &FareInspectionCaseV1,
    purpose: &str,
) -> Result<u32, FareControlError> {
    sample(&[
        purpose,
        &case.pin.world_id,
        &case.pin.train_run_id,
        &case.pin.passenger.passenger_key,
        &case.pin.seed_hash,
    ])
}
