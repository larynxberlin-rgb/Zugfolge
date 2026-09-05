//! In-process Node adapter for the unsafe-free [`zugfolge_runtime`] core.
//!
//! All validation and state transitions remain in the dependency crate. The functions in
//! this module only translate napi strings and stable error messages.

/// Wertet den gepinnten Personenverkehrsvertrag ohne Plattform-Fachlogik aus.
#[cfg(feature = "node-addon")]
#[napi(js_name = "evaluatePassengerDemand")]
pub fn evaluate_passenger_demand(input_json: String) -> napi::Result<String> {
    zugfolge_demand::evaluate_demand_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Projiziert ausschließlich belegte M10-Fahrgäste in freigegebene Innenraumplätze.
#[cfg(feature = "node-addon")]
#[napi(js_name = "projectConductorPassengers")]
pub fn project_conductor_passengers(input_json: String) -> napi::Result<String> {
    zugfolge_conductor::project_conductor_passengers_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[cfg(feature = "node-addon")]
use napi_derive::napi;

#[cfg(feature = "node-addon")]
mod regional_simulation;

#[cfg(feature = "node-addon")]
pub use regional_simulation::{
    apply_operational_simulation_command, apply_operational_simulation_command_async,
    apply_operational_simulation_command_batch, apply_operational_simulation_command_batch_async,
    initialize_operational_simulation, restore_operational_simulation,
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

/// Revalidates a persisted M5 state and its expected canonical hash in Rust.
#[cfg(feature = "node-addon")]
#[napi(js_name = "verifyFleetWorldState")]
pub fn verify_fleet_world_state(
    state_json: String,
    expected_state_hash: String,
) -> napi::Result<String> {
    zugfolge_runtime::verify_fleet_world_state(&state_json, &expected_state_hash)
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

/// Wertet einen einzelnen M7-Dispositionsfall durch den echten RuleDispatcher aus.
#[cfg(feature = "node-addon")]
#[napi(js_name = "evaluateOperatingDecision")]
pub fn evaluate_operating_decision(
    program_json: String,
    case_json: String,
) -> napi::Result<String> {
    let program = serde_json::from_str(&program_json).map_err(|error| {
        napi::Error::from_reason(format!("Betriebsprogramm ist ungueltig: {error}"))
    })?;
    let case = serde_json::from_str(&case_json).map_err(|error| {
        napi::Error::from_reason(format!("Dispositionsfall ist ungueltig: {error}"))
    })?;
    let result = zugfolge_rules::evaluate_dispatch_case(program, case)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    serde_json::to_string(&result).map_err(|error| {
        napi::Error::from_reason(format!(
            "Dispositionsentscheidung ist nicht serialisierbar: {error}"
        ))
    })
}
