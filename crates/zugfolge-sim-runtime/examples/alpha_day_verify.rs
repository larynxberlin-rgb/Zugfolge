//! Spielt den signierten M14.1-Tagesfahrplan durch die echte Rust-Runtime.
use std::fs;

use serde_json::{Value, json};

fn apply(
    state: &Value,
    state_hash: &str,
    command_id: &str,
    command: Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let world_id = state
        .get("worldId")
        .and_then(Value::as_str)
        .ok_or("worldId fehlt")?;
    let region_id = state
        .get("regionId")
        .and_then(Value::as_str)
        .ok_or("regionId fehlt")?;
    let revision = state
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or("revision fehlt")?;
    let publisher_sequence = state
        .get("publisherSequence")
        .and_then(Value::as_u64)
        .ok_or("publisherSequence fehlt")?;
    let envelope = json!({
        "schemaVersion": zugfolge_sim_runtime::COMMAND_SCHEMA,
        "worldId": world_id,
        "regionId": region_id,
        "commandId": command_id,
        "expectedStateHash": state_hash,
        "expectedRevision": revision,
        "expectedPublisherSequence": publisher_sequence,
        "command": command,
    });
    let result = zugfolge_sim_runtime::apply_regional_simulation_command(
        &serde_json::to_string(state)?,
        &serde_json::to_string(&envelope)?,
    )?;
    Ok(serde_json::from_str(&result)?)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let deployment_path = std::env::args()
        .nth(1)
        .ok_or("Aufruf: alpha_day_verify DEPLOYMENT.json")?;
    let signed: Value = serde_json::from_str(&fs::read_to_string(deployment_path)?)?;
    let deployment = signed.get("deployment").ok_or("deployment fehlt")?;
    let initialization = deployment
        .get("regionalSimulation")
        .ok_or("regionalSimulation fehlt")?;
    let initialized_json = zugfolge_sim_runtime::initialize_regional_simulation(
        &serde_json::to_string(initialization)?,
    )?;
    let initialized: Value = serde_json::from_str(&initialized_json)?;
    let mut state = initialized
        .get("state")
        .cloned()
        .ok_or("initial state fehlt")?;
    let mut state_hash = initialized
        .get("stateHash")
        .and_then(Value::as_str)
        .ok_or("initial hash fehlt")?
        .to_owned();
    let initial_train_count = initialized
        .pointer("/snapshot/trains")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let mut transitions = deployment
        .get("boundaryTransitions")
        .and_then(Value::as_array)
        .ok_or("boundaryTransitions fehlen")?
        .clone();
    transitions.sort_by(|left, right| {
        left.get("atS")
            .and_then(Value::as_i64)
            .cmp(&right.get("atS").and_then(Value::as_i64))
            .then_with(|| {
                left.get("transitionId")
                    .and_then(Value::as_str)
                    .cmp(&right.get("transitionId").and_then(Value::as_str))
            })
    });
    let mut now = 0_i64;
    let mut applied = 0_usize;
    for transition in transitions {
        let at_s = transition
            .get("atS")
            .and_then(Value::as_i64)
            .ok_or("atS fehlt")?;
        if at_s > now {
            let result = apply(
                &state,
                &state_hash,
                &format!("alpha-advance-{at_s}"),
                json!({ "type": "advance-to", "atS": at_s }),
            )?;
            state = result.get("state").cloned().ok_or("advance state fehlt")?;
            state_hash = result
                .get("stateHash")
                .and_then(Value::as_str)
                .ok_or("advance hash fehlt")?
                .to_owned();
            now = at_s;
        }
        let id = transition
            .get("transitionId")
            .and_then(Value::as_str)
            .ok_or("transitionId fehlt")?;
        let command = transition.get("command").cloned().ok_or("command fehlt")?;
        let result = apply(&state, &state_hash, id, command)
            .map_err(|error| format!("Grenzkommando '{id}' bei {at_s}s scheiterte: {error}"))?;
        state = result
            .get("state")
            .cloned()
            .ok_or("transition state fehlt")?;
        state_hash = result
            .get("stateHash")
            .and_then(Value::as_str)
            .ok_or("transition hash fehlt")?
            .to_owned();
        applied += 1;
    }
    if now < 86_400 {
        let result = apply(
            &state,
            &state_hash,
            "alpha-advance-day-end",
            json!({ "type": "advance-to", "atS": 86_400 }),
        )?;
        state = result.get("state").cloned().ok_or("day-end state fehlt")?;
        state_hash = result
            .get("stateHash")
            .and_then(Value::as_str)
            .ok_or("day-end hash fehlt")?
            .to_owned();
    }
    let restored_json =
        zugfolge_sim_runtime::restore_regional_simulation(&serde_json::to_string(&state)?)?;
    let restored: Value = serde_json::from_str(&restored_json)?;
    let trains = restored
        .pointer("/snapshot/trains")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let external = restored
        .pointer("/snapshot/externalTrains")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let restored_hash = restored
        .get("stateHash")
        .and_then(Value::as_str)
        .ok_or("restored hash fehlt")?;
    if restored_hash != state_hash {
        return Err("Restore-Hash weicht vom Tagesendzustand ab".into());
    }
    println!(
        "{}",
        json!({
            "worldId": state.get("worldId"),
            "initialTrainCount": initial_train_count,
            "boundaryTransitionCount": applied,
            "dayEndInternalTrainCount": trains,
            "dayEndExternalTrainCount": external,
            "stateHash": state_hash,
            "restoreHashEqual": true,
        })
    );
    Ok(())
}
