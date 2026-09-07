//! Lokale Testdemo: ausschließlich Transport zum unveränderten Rust-Fachkern.
use serde::Deserialize;
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeSet, sync::Arc};
use zugfolge_sim::operational::{OperationalInfraRelease, OperationalWorld, ProjectionKind};
mod offline;
mod infrastructure;

thread_local! { static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) }; }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { command: String, input: Value }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Advance { world: OperationalWorld, infrastructure: OperationalInfraRelease, at_ms: i64 }

fn execute(request: Request) -> Result<Value, String> {
    let input = serde_json::to_string(&request.input).map_err(|_| "offline_input_invalid")?;
    macro_rules! json_call {
        ($call:path) => {{
            let output = $call(&input).map_err(|error| error.to_string())?;
            serde_json::from_str(&output).map_err(|_| "offline_output_invalid".into())
        }};
    }
    macro_rules! hash_call {
        ($call:path) => { $call(&input).map(Value::String).map_err(|error| error.to_string()) };
    }
    match request.command.as_str() {
        command if command.starts_with("offline.") => offline::execute(command, request.input),
        "session.initialize" => json_call!(zugfolge_conductor_session::initialize_conductor_session_state_json),
        "session.apply" => json_call!(zugfolge_conductor_session::apply_conductor_session_command_json),
        "session.synchronize" => json_call!(zugfolge_conductor_session::synchronize_conductor_session_json),
        "session.restore" => json_call!(zugfolge_conductor_session::restore_conductor_session_state_json),
        "session.project" => json_call!(zugfolge_conductor_session::project_conductor_session_snapshot_json),
        "session.replay" => json_call!(zugfolge_conductor_session::replay_conductor_session_json),
        "session.policyHash" => hash_call!(zugfolge_conductor_session::hash_conductor_session_policy_json),
        "operation.hash" => hash_call!(zugfolge_conductor_session::hash_conductor_operational_world_json),
        "interior.build" => json_call!(zugfolge_conductor::build_interior_layout_json),
        "interior.bind" => json_call!(zugfolge_conductor::bind_interior_passenger_places_json),
        "interior.path" => json_call!(zugfolge_conductor::find_interior_path_json),
        "interior.movement" => json_call!(zugfolge_conductor::check_interior_movement_json),
        "passengers.project" => json_call!(zugfolge_conductor::project_conductor_passengers_v2_json),
        "scene.project" => json_call!(zugfolge_conductor_scenes::project_conductor_scene_json),
        "demand.evaluate" => json_call!(zugfolge_demand::evaluate_demand_json),
        "fare.initialize" => json_call!(zugfolge_fare_control::initialize_fare_control_json),
        "fare.apply" => json_call!(zugfolge_fare_control::apply_fare_control_json),
        "fare.restore" => json_call!(zugfolge_fare_control::restore_fare_control_json),
        "fare.report" => json_call!(zugfolge_fare_control::project_fare_control_report_json),
        "fare.nextWakeup" => json_call!(zugfolge_fare_control::next_fare_control_wakeup_json),
        "fare.policyHash" => json_call!(zugfolge_fare_control::fare_inspection_policy_hash_json),
        "fare.journeyHash" => json_call!(zugfolge_fare_control::fare_journey_evidence_hash_json),
        "fare.modelHash" => json_call!(zugfolge_fare_control::police_response_model_hash_json),
        "fare.policeDue" => json_call!(zugfolge_fare_control::police_response_due_json),
        "operation.advance" => {
            let mut advance: Advance = serde_json::from_value(request.input).map_err(|_| "offline_operation_input_invalid")?;
            advance.world.attach_infrastructure(Arc::new(infrastructure::MemoryInfrastructure::new(advance.infrastructure)?)).map_err(|_| "offline_infrastructure_invalid")?;
            advance.world.advance_to(advance.at_ms).map_err(|_| "offline_operation_advance_failed")?;
            advance.world.verify_invariants().map_err(|_| "offline_operation_invalid")?;
            let live_map = advance.world.project(ProjectionKind::LiveMap, &BTreeSet::new()).map_err(|_| "offline_projection_invalid")?;
            Ok(json!({"worldHash": zugfolge_conductor_session::operational_world_hash(&advance.world), "world": advance.world, "liveMap": live_map}))
        }
        _ => Err("offline_command_unknown".into()),
    }
}

/// Der Browser besitzt den Eingabepuffer bis zum zugehörigen dealloc.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(length: usize) -> *mut u8 {
    if length > 32 * 1024 * 1024 { return std::ptr::null_mut(); }
    Box::into_raw(vec![0u8; length].into_boxed_slice()) as *mut u8
}

/// Ausschließlich den unveränderten Zeiger und die Länge von alloc zurückgeben.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(pointer: *mut u8, length: usize) {
    if !pointer.is_null() {
        unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length))); }
    }
}

/// Gibt den Ergebnispuffer zurück; result_len liefert seine Länge bis zum nächsten Aufruf.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn invoke(pointer: *const u8, length: usize) -> *const u8 {
    let result = if pointer.is_null() || length > 32 * 1024 * 1024 {
        Err("offline_input_invalid".to_owned())
    } else {
        let bytes = unsafe { std::slice::from_raw_parts(pointer, length) };
        serde_json::from_slice(bytes).map_err(|_| "offline_input_invalid".to_owned()).and_then(execute)
    };
    let output = match result { Ok(value) => json!({"ok":true,"value":value}), Err(code) => json!({"ok":false,"error":code}) };
    OUTPUT.with(|cell| { let mut buffer = cell.borrow_mut(); *buffer = serde_json::to_vec(&output).expect("JSON-Ergebnis"); buffer.as_ptr() })
}

#[unsafe(no_mangle)]
pub extern "C" fn result_len() -> usize { OUTPUT.with(|cell| cell.borrow().len()) }
