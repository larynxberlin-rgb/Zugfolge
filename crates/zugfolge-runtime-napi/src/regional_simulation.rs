//! Enge napi-rs-Uebersetzung fuer die persistierbare regionale M4-Grenze.

use napi_derive::napi;

/// Initialisiert Simulation und Delta-Publisher aus dem versionierten JSON-Vertrag.
#[napi(js_name = "initializeRegionalSimulation")]
pub fn initialize_regional_simulation(input_json: String) -> napi::Result<String> {
    zugfolge_sim_runtime::initialize_regional_simulation(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Rekonstruiert einen persistierten Zustand und liefert einen echten Snapshot.
#[napi(js_name = "restoreRegionalSimulation")]
pub fn restore_regional_simulation(state_json: String) -> napi::Result<String> {
    zugfolge_sim_runtime::restore_regional_simulation(&state_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Wendet ein idempotentes Kommando an und liefert Ereignisse plus Rust-Delta.
#[napi(js_name = "applyRegionalSimulationCommand")]
pub fn apply_regional_simulation_command(
    state_json: String,
    command_json: String,
) -> napi::Result<String> {
    zugfolge_sim_runtime::apply_regional_simulation_command(&state_json, &command_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Wendet eine geordnete, atomar persistierbare Gruppe idempotenter Kommandos an.
#[napi(js_name = "applyRegionalSimulationCommandBatch")]
pub fn apply_regional_simulation_command_batch(
    state_json: String,
    batch_json: String,
) -> napi::Result<String> {
    zugfolge_sim_runtime::apply_regional_simulation_command_batch(&state_json, &batch_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
