//! In-process Node adapter for the unsafe-free [`zugfolge_runtime`] core.
//!
//! All validation and state transitions remain in the dependency crate. The functions in
//! this module only translate napi strings and stable error messages.

#[cfg(feature = "node-addon")]
use napi_derive::napi;

#[cfg(feature = "node-addon")]
mod regional_simulation;

#[cfg(feature = "node-addon")]
pub use regional_simulation::{
    apply_regional_simulation_command, initialize_regional_simulation, restore_regional_simulation,
};

/// Initializes the authoritative, revisioned M5 fleet state.
#[cfg(feature = "node-addon")]
#[napi(js_name = "initializeFleetWorld")]
pub fn initialize_fleet_world(input_json: String) -> napi::Result<String> {
    zugfolge_runtime::initialize_fleet_world(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Applies one versioned M5 command and derives the mobilization snapshot.
#[cfg(feature = "node-addon")]
#[napi(js_name = "applyFleetCommand")]
pub fn apply_fleet_command(
    state_json: String,
    command_json: String,
    replay_receipt_json: Option<String>,
) -> napi::Result<String> {
    zugfolge_runtime::apply_fleet_command(
        &state_json,
        &command_json,
        replay_receipt_json.as_deref(),
    )
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Verifies and hashes a canonical M5 mobilization snapshot in Rust.
#[cfg(feature = "node-addon")]
#[napi(js_name = "verifyFleetMobilizationSnapshot")]
pub fn verify_fleet_mobilization_snapshot(input_json: String) -> napi::Result<String> {
    zugfolge_runtime::verify_fleet_mobilization_snapshot(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Initializes a versioned operating-world snapshot.
#[cfg(feature = "node-addon")]
#[napi(js_name = "initializeOperatingWorld")]
pub fn initialize_operating_world(input_json: String) -> napi::Result<String> {
    zugfolge_runtime::initialize_operating_world(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Applies one revisioned timetable-boundary command.
#[cfg(feature = "node-addon")]
#[napi(js_name = "applyOperatingTransition")]
pub fn apply_operating_transition(
    state_json: String,
    command_json: String,
) -> napi::Result<String> {
    zugfolge_runtime::apply_operating_transition(&state_json, &command_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
