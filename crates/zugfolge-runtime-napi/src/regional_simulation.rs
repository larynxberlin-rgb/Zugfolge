//! Enge napi-rs-Uebersetzung fuer die persistierbare operative v2-Grenze.

use napi::{Env, Task, bindgen_prelude::AsyncTask};
use napi_derive::napi;

/// Rechenlast eines operativen v2-Kommandos ausserhalb des Node-Eventloops.
pub struct ApplyOperationalSimulationCommandTask {
    state_json: String,
    command_json: String,
}

impl Task for ApplyOperationalSimulationCommandTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        zugfolge_sim_runtime::operational_runtime::apply_operational_simulation_command(
            &self.state_json,
            &self.command_json,
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Initialisiert den exakten operativen v2-Single-Writer.
#[napi(js_name = "initializeOperationalSimulation")]
pub fn initialize_operational_simulation(input_json: String) -> napi::Result<String> {
    zugfolge_sim_runtime::operational_runtime::initialize_operational_simulation(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Prueft und rekonstruiert einen persistierten operativen v2-Zustand.
#[napi(js_name = "restoreOperationalSimulation")]
pub fn restore_operational_simulation(state_json: String) -> napi::Result<String> {
    zugfolge_sim_runtime::operational_runtime::restore_operational_simulation(&state_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Wendet genau ein typisiertes operatives v2-Kommando an.
#[napi(js_name = "applyOperationalSimulationCommand")]
pub fn apply_operational_simulation_command(
    state_json: String,
    command_json: String,
) -> napi::Result<String> {
    zugfolge_sim_runtime::operational_runtime::apply_operational_simulation_command(
        &state_json,
        &command_json,
    )
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Fuehrt ein operatives v2-Kommando im libuv-Workerpool aus.
#[napi(js_name = "applyOperationalSimulationCommandAsync")]
pub fn apply_operational_simulation_command_async(
    state_json: String,
    command_json: String,
) -> AsyncTask<ApplyOperationalSimulationCommandTask> {
    AsyncTask::new(ApplyOperationalSimulationCommandTask {
        state_json,
        command_json,
    })
}
