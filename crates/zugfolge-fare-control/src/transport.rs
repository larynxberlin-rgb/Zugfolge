use crate::*;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
fn parse<T: DeserializeOwned>(input: &str) -> Result<T, FareControlError> {
    serde_json::from_str(input).map_err(|_| FareControlError("fare_transport_invalid"))
}
fn encode<T: Serialize>(value: &T) -> Result<String, FareControlError> {
    serde_json::to_string(value).map_err(|_| FareControlError("fare_transport_invalid"))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Initialize {
    world_id: String,
    operator_id: String,
    now_ms: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Apply {
    state: FareControlWorldStateV1,
    expected_state_hash: String,
    command: FareControlCommandV1,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Restore {
    state: FareControlWorldStateV1,
    expected_state_hash: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Project {
    state: FareControlWorldStateV1,
    expected_state_hash: String,
    world_id: String,
    operator_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Due {
    plan: PoliceResponsePlanV1,
    evidence: PoliceOperationalEvidenceV1,
    now_ms: i64,
}

pub fn initialize_fare_control_json(input: &str) -> Result<String, FareControlError> {
    let value: Initialize = parse(input)?;
    encode(&initialize_fare_control(
        &value.world_id,
        &value.operator_id,
        value.now_ms,
    )?)
}
pub fn apply_fare_control_json(input: &str) -> Result<String, FareControlError> {
    let value: Apply = parse(input)?;
    encode(&apply_fare_control(
        &value.state,
        &value.expected_state_hash,
        &value.command,
    )?)
}
pub fn restore_fare_control_json(input: &str) -> Result<String, FareControlError> {
    let value: Restore = parse(input)?;
    encode(&restore_fare_control(
        &value.state,
        &value.expected_state_hash,
    )?)
}
pub fn next_fare_control_wakeup_json(input: &str) -> Result<String, FareControlError> {
    let value: Restore = parse(input)?;
    encode(&next_fare_control_wakeup(
        &value.state,
        &value.expected_state_hash,
    )?)
}
pub fn project_fare_cases_json(input: &str) -> Result<String, FareControlError> {
    let value: Project = parse(input)?;
    encode(&project_fare_cases(
        &value.state,
        &value.expected_state_hash,
        &value.world_id,
        &value.operator_id,
    )?)
}
pub fn fare_inspection_policy_hash_json(input: &str) -> Result<String, FareControlError> {
    encode(&fare_inspection_policy_hash(&parse(input)?)?)
}
pub fn project_fare_control_report_json(input: &str) -> Result<String, FareControlError> {
    let value: Project = parse(input)?;
    encode(&project_fare_control_report(
        &value.state,
        &value.expected_state_hash,
        &value.world_id,
        &value.operator_id,
    )?)
}
pub fn fare_journey_evidence_hash_json(input: &str) -> Result<String, FareControlError> {
    encode(&fare_journey_evidence_hash(&parse(input)?)?)
}
pub fn police_response_model_hash_json(input: &str) -> Result<String, FareControlError> {
    encode(&police_response_model_hash(&parse(input)?)?)
}
pub fn police_response_due_json(input: &str) -> Result<String, FareControlError> {
    let value: Due = parse(input)?;
    encode(&police_response_due(
        &value.plan,
        &value.evidence,
        value.now_ms,
    )?)
}
