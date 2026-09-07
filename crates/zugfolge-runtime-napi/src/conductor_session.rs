//! Schmale JSON-Grenze zum autoritativen Sitzungskern.
use napi_derive::napi;
/// Delegiert den versionierten Vertrag vollständig an den Rust-Domänenkern.
#[napi(js_name = "initializeConductorSessionState")]
pub fn initialize_conductor_session_state(input_json: String) -> napi::Result<String> {
    zugfolge_conductor_session::initialize_conductor_session_state_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Delegiert den versionierten Vertrag vollständig an den Rust-Domänenkern.
#[napi(js_name = "applyConductorSessionCommand")]
pub fn apply_conductor_session_command(input_json: String) -> napi::Result<String> {
    zugfolge_conductor_session::apply_conductor_session_command_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Delegiert den versionierten Vertrag vollständig an den Rust-Domänenkern.
#[napi(js_name = "synchronizeConductorSession")]
pub fn synchronize_conductor_session(input_json: String) -> napi::Result<String> {
    zugfolge_conductor_session::synchronize_conductor_session_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Delegiert den versionierten Vertrag vollständig an den Rust-Domänenkern.
#[napi(js_name = "restoreConductorSessionState")]
pub fn restore_conductor_session_state(input_json: String) -> napi::Result<String> {
    zugfolge_conductor_session::restore_conductor_session_state_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Delegiert den versionierten Vertrag vollständig an den Rust-Domänenkern.
#[napi(js_name = "projectConductorSessionSnapshot")]
pub fn project_conductor_session_snapshot(input_json: String) -> napi::Result<String> {
    zugfolge_conductor_session::project_conductor_session_snapshot_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Delegiert den versionierten Vertrag vollständig an den Rust-Domänenkern.
#[napi(js_name = "replayConductorSession")]
pub fn replay_conductor_session(input_json: String) -> napi::Result<String> {
    zugfolge_conductor_session::replay_conductor_session_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Delegiert den versionierten Vertrag vollständig an den Rust-Domänenkern.
#[napi(js_name = "hashConductorOperationalWorld")]
pub fn hash_conductor_operational_world(input_json: String) -> napi::Result<String> {
    zugfolge_conductor_session::hash_conductor_operational_world_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Delegiert den versionierten Vertrag vollständig an den Rust-Domänenkern.
#[napi(js_name = "hashConductorSessionPolicy")]
pub fn hash_conductor_session_policy(input_json: String) -> napi::Result<String> {
    zugfolge_conductor_session::hash_conductor_session_policy_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
