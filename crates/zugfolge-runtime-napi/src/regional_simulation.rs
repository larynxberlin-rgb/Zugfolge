//! Enge napi-rs-Uebersetzung fuer die persistierbare operative v2-Grenze.

use napi::{Env, Task, bindgen_prelude::AsyncTask};
use napi_derive::napi;

/// Prüft beide regionalen Köpfe und erzeugt die native Übergabe ohne DB-Zugriff.
#[napi(js_name = "handoverOperationalSimulation")]
pub fn handover_operational_simulation(
    input_json: String,
    infrastructure_path: String,
) -> napi::Result<String> {
    zugfolge_sim_runtime::operational_runtime::handover_operational_simulation(
        &input_json,
        &infrastructure_path,
    )
    .map_err(|_| napi::Error::from_reason("operational_handover_invalid"))
}

/// Releasegebundener deterministischer Tagesmodell-Adapter.
#[napi(js_name = "generateOperationalDailyRestrictions")]
pub fn generate_operational_daily_restrictions(
    input_json: String,
    infrastructure_path: String,
) -> napi::Result<String> {
    zugfolge_sim_runtime::daily_restrictions::generate_operational_daily_restrictions(
        &input_json,
        &infrastructure_path,
    )
    .map_err(napi::Error::from_reason)
}

/// Hasht einen typisierten operativen Payload in exakt derselben Kanonform
/// wie das native Idempotenzreceipt.
#[napi(js_name = "hashOperationalSimulationCommand")]
pub fn hash_operational_simulation_command(command_json: String) -> napi::Result<String> {
    zugfolge_sim_runtime::operational_runtime::hash_operational_simulation_command(&command_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Rechenlast eines operativen v2-Kommandos ausserhalb des Node-Eventloops.
pub struct ApplyOperationalSimulationCommandTask {
    state_json: String,
    command_json: String,
    resolved_infrastructure_path: String,
}

/// Rechenlast einer atomaren operativen v2-Kommandogruppe ausserhalb des
/// Node-Eventloops.
pub struct ApplyOperationalSimulationCommandBatchTask {
    state_json: String,
    batch_json: String,
    resolved_infrastructure_path: String,
}

impl Task for ApplyOperationalSimulationCommandTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        zugfolge_sim_runtime::operational_runtime::apply_operational_simulation_command(
            &self.state_json,
            &self.command_json,
            &self.resolved_infrastructure_path,
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

impl Task for ApplyOperationalSimulationCommandBatchTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        zugfolge_sim_runtime::operational_runtime::apply_operational_simulation_command_batch(
            &self.state_json,
            &self.batch_json,
            &self.resolved_infrastructure_path,
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Initialisiert den exakten operativen v2-Single-Writer.
#[napi(js_name = "initializeOperationalSimulation")]
pub fn initialize_operational_simulation(
    input_json: String,
    resolved_infrastructure_path: String,
) -> napi::Result<String> {
    zugfolge_sim_runtime::operational_runtime::initialize_operational_simulation(
        &input_json,
        &resolved_infrastructure_path,
    )
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Prueft und rekonstruiert einen persistierten operativen v2-Zustand.
#[napi(js_name = "restoreOperationalSimulation")]
pub fn restore_operational_simulation(
    state_json: String,
    resolved_infrastructure_path: String,
) -> napi::Result<String> {
    zugfolge_sim_runtime::operational_runtime::restore_operational_simulation(
        &state_json,
        &resolved_infrastructure_path,
    )
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Wendet genau ein typisiertes operatives v2-Kommando an.
#[napi(js_name = "applyOperationalSimulationCommand")]
pub fn apply_operational_simulation_command(
    state_json: String,
    command_json: String,
    resolved_infrastructure_path: String,
) -> napi::Result<String> {
    zugfolge_sim_runtime::operational_runtime::apply_operational_simulation_command(
        &state_json,
        &command_json,
        &resolved_infrastructure_path,
    )
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Wendet eine begrenzte, atomare Folge typisierter operativer v2-Kommandos
/// mit genau einer Zustandsdekodierung und Infrastrukturbindung an.
#[napi(js_name = "applyOperationalSimulationCommandBatch")]
pub fn apply_operational_simulation_command_batch(
    state_json: String,
    batch_json: String,
    resolved_infrastructure_path: String,
) -> napi::Result<String> {
    zugfolge_sim_runtime::operational_runtime::apply_operational_simulation_command_batch(
        &state_json,
        &batch_json,
        &resolved_infrastructure_path,
    )
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Fuehrt ein operatives v2-Kommando im libuv-Workerpool aus.
#[napi(js_name = "applyOperationalSimulationCommandAsync")]
pub fn apply_operational_simulation_command_async(
    state_json: String,
    command_json: String,
    resolved_infrastructure_path: String,
) -> AsyncTask<ApplyOperationalSimulationCommandTask> {
    AsyncTask::new(ApplyOperationalSimulationCommandTask {
        state_json,
        command_json,
        resolved_infrastructure_path,
    })
}

/// Fuehrt eine atomare operative v2-Kommandogruppe im libuv-Workerpool aus.
#[napi(js_name = "applyOperationalSimulationCommandBatchAsync")]
pub fn apply_operational_simulation_command_batch_async(
    state_json: String,
    batch_json: String,
    resolved_infrastructure_path: String,
) -> AsyncTask<ApplyOperationalSimulationCommandBatchTask> {
    AsyncTask::new(ApplyOperationalSimulationCommandBatchTask {
        state_json,
        batch_json,
        resolved_infrastructure_path,
    })
}
