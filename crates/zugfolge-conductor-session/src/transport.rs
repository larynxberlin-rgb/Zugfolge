use crate::*;
use serde::{Serialize, de::DeserializeOwned};

fn parse<T: DeserializeOwned>(json: &str) -> Result<T, ConductorSessionError> {
    common::require(
        json.len() <= 128 * 1024 * 1024,
        "conductor_session_input_size_limit",
    )?;
    Ok(serde_json::from_str(json)?)
}
fn encode(value: &impl Serialize) -> Result<String, ConductorSessionError> {
    Ok(serde_json::to_string(value)?)
}

pub fn initialize_conductor_session_state_json(
    json: &str,
) -> Result<String, ConductorSessionError> {
    encode(&initialize_conductor_session_state(&parse(json)?)?)
}
pub fn apply_conductor_session_command_json(json: &str) -> Result<String, ConductorSessionError> {
    encode(&apply_conductor_session_command(&parse(json)?)?)
}
pub fn synchronize_conductor_session_json(json: &str) -> Result<String, ConductorSessionError> {
    encode(&synchronize_conductor_session(&parse(json)?)?)
}
pub fn restore_conductor_session_state_json(json: &str) -> Result<String, ConductorSessionError> {
    encode(&restore_conductor_session_state(&parse(json)?)?)
}
pub fn project_conductor_session_snapshot_json(
    json: &str,
) -> Result<String, ConductorSessionError> {
    encode(&project_conductor_session_snapshot(&parse(json)?)?)
}
pub fn replay_conductor_session_json(json: &str) -> Result<String, ConductorSessionError> {
    encode(&replay_conductor_session(&parse(json)?)?)
}
pub fn hash_conductor_operational_world_json(json: &str) -> Result<String, ConductorSessionError> {
    Ok(operational_world_hash(&parse(json)?))
}
pub fn hash_conductor_session_policy_json(json: &str) -> Result<String, ConductorSessionError> {
    conductor_session_policy_hash(&parse(json)?)
}

pub fn replay_conductor_session(
    input: &ReplayConductorSessionInputV1,
) -> Result<ConductorTrainStateV1, ConductorSessionError> {
    common::require(
        input.schema_version == "conductor-session-replay-input/v1" && input.steps.len() <= 262_144,
        "invalid_conductor_session_replay",
    )?;
    state::validate_state(
        &input.initial_state,
        &input.expected_initial_state_hash,
        &input.dialogue_releases,
    )?;
    let mut state = input.initial_state.clone();
    for step in &input.steps {
        let (next, expected) = match step {
            ConductorSessionReplayStepV1::Command {
                command,
                access,
                source,
                expected_result_hash,
            } => (
                apply_conductor_session_command(&ApplyConductorSessionCommandInputV1 {
                    schema_version: "conductor-session-apply-input/v1".into(),
                    expected_state_hash: state.state_hash.clone(),
                    state,
                    command: (**command).clone(),
                    access: access.clone(),
                    source: (**source).clone(),
                })?
                .state,
                expected_result_hash,
            ),
            ConductorSessionReplayStepV1::Synchronize {
                access,
                source,
                causality_id,
                expected_result_hash,
            } => (
                synchronize_conductor_session(&SynchronizeConductorSessionInputV1 {
                    schema_version: "conductor-session-synchronize-input/v1".into(),
                    expected_state_hash: state.state_hash.clone(),
                    state,
                    access: access.clone(),
                    source: (**source).clone(),
                    causality_id: causality_id.clone(),
                })?
                .state,
                expected_result_hash,
            ),
        };
        common::require(
            &next.state_hash == expected,
            "conductor_session_replay_hash_mismatch",
        )?;
        state = next;
    }
    Ok(state)
}
