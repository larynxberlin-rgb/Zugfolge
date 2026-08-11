//! In-process Node adapter for the M3 PlanningRun runtime.
//!
//! Validation, coordination and state transitions stay in the unsafe-free
//! domain crate. This module translates only napi strings and stable errors.

#[cfg(feature = "node-addon")]
use napi::bindgen_prelude::Result as NapiResult;
#[cfg(feature = "node-addon")]
use napi_derive::napi;

/// Runs a versioned set of competing path requests through the real Rust planner.
#[cfg(feature = "node-addon")]
#[napi(js_name = "coordinatePlanningRun")]
pub fn coordinate_planning_run(input_json: String) -> NapiResult<String> {
    zugfolge_planning_runtime::coordinate_planning_run(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

/// Applies exactly one alternative retained in the revisioned Rust state.
#[cfg(feature = "node-addon")]
#[napi(js_name = "applyPlanningAlternative")]
pub fn apply_planning_alternative(
    state_json: String,
    command_id: String,
    command_json: String,
) -> NapiResult<String> {
    zugfolge_planning_runtime::apply_planning_alternative(&state_json, &command_id, &command_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
