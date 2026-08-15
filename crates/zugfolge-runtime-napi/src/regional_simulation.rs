//! Enge napi-rs-Uebersetzung fuer die persistierbare regionale M4-Grenze.

use napi::{Env, Task, bindgen_prelude::AsyncTask};
use napi_derive::napi;

/// Rechenlast eines einzelnen regionalen Kommandos ausserhalb des Node-Eventloops.
pub struct ApplyRegionalSimulationCommandTask {
    state_json: String,
    command_json: String,
}

impl Task for ApplyRegionalSimulationCommandTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        zugfolge_sim_runtime::apply_regional_simulation_command(
            &self.state_json,
            &self.command_json,
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Rechenlast einer regionalen Kommandogruppe ausserhalb des Node-Eventloops.
pub struct ApplyRegionalSimulationCommandBatchTask {
    state_json: String,
    batch_json: String,
}

impl Task for ApplyRegionalSimulationCommandBatchTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        zugfolge_sim_runtime::apply_regional_simulation_command_batch(
            &self.state_json,
            &self.batch_json,
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

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

/// Wendet ein Kommando in libuvs Workerpool an, ohne den Node-Eventloop zu blockieren.
#[napi(js_name = "applyRegionalSimulationCommandAsync")]
pub fn apply_regional_simulation_command_async(
    state_json: String,
    command_json: String,
) -> AsyncTask<ApplyRegionalSimulationCommandTask> {
    AsyncTask::new(ApplyRegionalSimulationCommandTask {
        state_json,
        command_json,
    })
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

/// Wendet eine Kommandogruppe in libuvs Workerpool an, ohne den Node-Eventloop zu blockieren.
#[napi(js_name = "applyRegionalSimulationCommandBatchAsync")]
pub fn apply_regional_simulation_command_batch_async(
    state_json: String,
    batch_json: String,
) -> AsyncTask<ApplyRegionalSimulationCommandBatchTask> {
    AsyncTask::new(ApplyRegionalSimulationCommandBatchTask {
        state_json,
        batch_json,
    })
}
