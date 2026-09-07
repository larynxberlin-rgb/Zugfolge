//! Reproduzierbarer Mehrtagesnachweis des signierten v2-Betriebsprogramms.

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value, json};
use zugfolge_sim_runtime::operational_runtime::{
    COMMAND_SCHEMA, RESTORE_SCHEMA, apply_operational_simulation_command,
    initialize_operational_simulation, release_operational_infrastructure_cache,
    restore_operational_simulation,
};

const SERVICE_DAYS: usize = 3;

#[derive(Clone)]
struct ProgramTrain {
    base_id: String,
    departure_offset_ms: i64,
    interlocking_route_id: String,
    train: Value,
}

type ProgramSchedule = (i64, BTreeMap<i64, Vec<ProgramTrain>>);

fn object<'a>(value: &'a Value, detail: &str) -> Result<&'a Map<String, Value>, Box<dyn Error>> {
    value.as_object().ok_or_else(|| detail.to_owned().into())
}

fn array<'a>(value: &'a Value, detail: &str) -> Result<&'a Vec<Value>, Box<dyn Error>> {
    value.as_array().ok_or_else(|| detail.to_owned().into())
}

fn string(value: &Value, detail: &str) -> Result<String, Box<dyn Error>> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| detail.to_owned().into())
}

fn nonnegative_i64(value: &Value, detail: &str) -> Result<i64, Box<dyn Error>> {
    value
        .as_i64()
        .filter(|value| *value >= 0)
        .ok_or_else(|| detail.to_owned().into())
}

fn has_recurring_suffix(train_id: &str) -> bool {
    train_id.rsplit_once(":day-").is_some_and(|(_, suffix)| {
        !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
    })
}

fn program(deployment: &Map<String, Value>) -> Result<ProgramSchedule, Box<dyn Error>> {
    let repeat_every_s = nonnegative_i64(
        deployment.get("repeatEveryS").ok_or("repeatEveryS fehlt")?,
        "repeatEveryS ist ungueltig",
    )?;
    let repeat_every_ms = repeat_every_s
        .checked_mul(1_000)
        .filter(|value| *value > 0)
        .ok_or("Wiederholungsperiode ist ungueltig")?;
    let initialization = object(
        deployment
            .get("regionalSimulation")
            .ok_or("regionalSimulation fehlt")?,
        "regionalSimulation ist ungueltig",
    )?;
    if initialization.get("nowMs").and_then(Value::as_i64) != Some(0) {
        return Err("Wiederholbares v2-Betriebsprogramm muss bei 0 ms beginnen".into());
    }
    let trains = array(
        initialization.get("trains").ok_or("Fahrten fehlen")?,
        "Fahrten sind ungueltig",
    )?;
    if trains.is_empty() {
        return Err("Signiertes v2-Betriebsprogramm enthaelt keine Fahrt".into());
    }

    let mut grouped = BTreeMap::<i64, Vec<ProgramTrain>>::new();
    let mut seen = BTreeMap::<String, ()>::new();
    for train in trains {
        let train_object = object(train, "Fahrt ist ungueltig")?;
        let base_id = string(
            train_object.get("id").ok_or("Fahrt-ID fehlt")?,
            "Fahrt-ID ist ungueltig",
        )?;
        let departure_offset_ms = nonnegative_i64(
            train_object
                .get("scheduledDepartureMs")
                .ok_or("Abfahrtsgrenze fehlt")?,
            "Abfahrtsgrenze ist ungueltig",
        )?;
        if departure_offset_ms >= repeat_every_ms
            || has_recurring_suffix(&base_id)
            || seen.insert(base_id.clone(), ()).is_some()
        {
            return Err(format!("Fahrt '{base_id}' ist nicht eindeutig wiederholbar").into());
        }
        let interlocking_route_id = string(
            train_object
                .get("dispatchInterlockingRouteId")
                .ok_or("dispatchInterlockingRouteId fehlt")?,
            "dispatchInterlockingRouteId ist ungueltig",
        )?;
        grouped
            .entry(departure_offset_ms)
            .or_default()
            .push(ProgramTrain {
                base_id,
                departure_offset_ms,
                interlocking_route_id,
                train: train.clone(),
            });
    }
    for trains in grouped.values_mut() {
        trains.sort_by(|left, right| left.base_id.cmp(&right.base_id));
    }
    Ok((repeat_every_ms, grouped))
}

fn infrastructure_path(bound_state: &Value) -> Result<String, Box<dyn Error>> {
    let release_id = string(
        bound_state
            .pointer("/infraRelease/infraReleaseId")
            .ok_or("infraRelease.infraReleaseId fehlt")?,
        "infraRelease.infraReleaseId ist ungueltig",
    )?;
    let configured: Value = serde_json::from_str(&std::env::var(
        "ZUGFOLGE_OPERATIONAL_INFRASTRUCTURE_ROOTS_JSON",
    )?)?;
    let roots = object(
        &configured,
        "ZUGFOLGE_OPERATIONAL_INFRASTRUCTURE_ROOTS_JSON ist kein Objekt",
    )?;
    let root = PathBuf::from(string(
        roots
            .get(&release_id)
            .ok_or("InfraRelease-ID besitzt keine erlaubte Infrastrukturwurzel")?,
        "erlaubte Infrastrukturwurzel ist ungueltig",
    )?);
    if !root.is_absolute() {
        return Err("Erlaubte Operational-v2-Infrastrukturwurzel muss absolut sein".into());
    }
    Ok(root
        .join("operational-infrastructure-v2.json")
        .to_str()
        .ok_or("Operational-v2-Infrastrukturpfad ist nicht UTF-8")?
        .to_owned())
}

fn recurring_train_id(base_id: &str, day: usize) -> String {
    if day == 0 {
        base_id.to_owned()
    } else {
        format!("{base_id}:day-{day}")
    }
}

fn current_ms(state: &Value) -> Result<i64, Box<dyn Error>> {
    nonnegative_i64(
        state
            .pointer("/world/nowMs")
            .ok_or("state.world.nowMs fehlt")?,
        "state.world.nowMs ist ungueltig",
    )
}

fn apply(
    state: &mut Value,
    state_hash: &mut String,
    command_id: &str,
    command: Value,
) -> Result<usize, Box<dyn Error>> {
    let world_id = string(
        state
            .pointer("/world/worldId")
            .ok_or("state.world.worldId fehlt")?,
        "state.world.worldId ist ungueltig",
    )?;
    let region_id = string(
        state
            .pointer("/world/regionId")
            .ok_or("state.world.regionId fehlt")?,
        "state.world.regionId ist ungueltig",
    )?;
    let revision = state
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or("state.revision fehlt")?;
    let publisher_sequence = state
        .get("publisherSequence")
        .and_then(Value::as_u64)
        .ok_or("state.publisherSequence fehlt")?;
    let envelope = json!({
        "schemaVersion": COMMAND_SCHEMA,
        "worldId": world_id,
        "regionId": region_id,
        "commandId": command_id,
        "expectedStateHash": state_hash,
        "expectedRevision": revision,
        "expectedPublisherSequence": publisher_sequence,
        "command": command,
    });
    let result: Value = serde_json::from_str(&apply_operational_simulation_command(
        &serde_json::to_string(state)?,
        &serde_json::to_string(&envelope)?,
        &infrastructure_path(state)?,
    )?)?;
    let event_count = result
        .get("events")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    *state = result
        .get("state")
        .cloned()
        .ok_or("Ergebniszustand fehlt")?;
    *state_hash = string(
        result.get("stateHash").ok_or("Ergebnishash fehlt")?,
        "Ergebnishash ist ungueltig",
    )?;
    Ok(event_count)
}

fn main() -> Result<(), Box<dyn Error>> {
    let result = run();
    release_operational_infrastructure_cache();
    result
}

fn run() -> Result<(), Box<dyn Error>> {
    let deployment_path = std::env::args()
        .nth(1)
        .ok_or("Aufruf: alpha_day_verify DEPLOYMENT.json")?;
    let signed: Value = serde_json::from_str(&fs::read_to_string(deployment_path)?)?;
    let deployment_hash = string(
        signed.get("deploymentHash").ok_or("deploymentHash fehlt")?,
        "deploymentHash ist ungueltig",
    )?;
    let deployment = object(
        signed.get("deployment").ok_or("deployment fehlt")?,
        "deployment ist ungueltig",
    )?;
    let initialization = deployment
        .get("regionalSimulation")
        .ok_or("regionalSimulation fehlt")?;
    let (repeat_every_ms, grouped) = program(deployment)?;
    let infrastructure_path = infrastructure_path(initialization)?;
    let initialized: Value = serde_json::from_str(&initialize_operational_simulation(
        &serde_json::to_string(initialization)?,
        &infrastructure_path,
    )?)?;
    let mut state = initialized
        .get("state")
        .cloned()
        .ok_or("initialer v2-Zustand fehlt")?;
    let mut state_hash = string(
        initialized
            .get("stateHash")
            .ok_or("initialer Zustandshash fehlt")?,
        "initialer Zustandshash ist ungueltig",
    )?;
    let initialization_hash = string(
        initialized
            .get("initializationHash")
            .ok_or("initialer Initialisierungshash fehlt")?,
        "initialer Initialisierungshash ist ungueltig",
    )?;
    let initial_train_count = initialized
        .pointer("/liveMap/trains")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let mut event_count = initialized
        .get("events")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let mut command_count = 0_usize;

    for day in 0..SERVICE_DAYS {
        let day_offset = i64::try_from(day)?
            .checked_mul(repeat_every_ms)
            .ok_or("Tagesgrenze ist erschoepft")?;
        for (departure_offset_ms, trains) in &grouped {
            let at_ms = day_offset
                .checked_add(*departure_offset_ms)
                .ok_or("Abfahrtsgrenze ist erschoepft")?;
            if current_ms(&state)? < at_ms {
                event_count += apply(
                    &mut state,
                    &mut state_hash,
                    &format!("{deployment_hash}:proof:{day}:{departure_offset_ms}:advance"),
                    json!({ "type": "advance-to", "atMs": at_ms }),
                )?;
                command_count += 1;
            }
            if day > 0 {
                for train in trains {
                    event_count += apply(
                        &mut state,
                        &mut state_hash,
                        &format!(
                            "{deployment_hash}:proof:{day}:{departure_offset_ms}:retire:{}",
                            train.base_id
                        ),
                        json!({
                            "type": "retire",
                            "trainId": recurring_train_id(&train.base_id, day - 1),
                        }),
                    )?;
                    command_count += 1;
                }
            }
            for train in trains {
                let mut materialized = train.train.clone();
                let materialized_object = materialized
                    .as_object_mut()
                    .ok_or("Fahrt ist nicht materialisierbar")?;
                materialized_object.insert(
                    "id".to_owned(),
                    Value::String(recurring_train_id(&train.base_id, day)),
                );
                materialized_object.insert("scheduledDepartureMs".to_owned(), Value::from(at_ms));
                event_count += apply(
                    &mut state,
                    &mut state_hash,
                    &format!(
                        "{deployment_hash}:proof:{day}:{departure_offset_ms}:materialize:{}",
                        train.base_id
                    ),
                    json!({ "type": "materialize", "train": materialized }),
                )?;
                command_count += 1;
            }
            let requests = trains
                .iter()
                .map(|train| {
                    json!({
                        "trainId": recurring_train_id(&train.base_id, day),
                        "interlockingRouteId": train.interlocking_route_id,
                        "committedRank": 0,
                        "timetableDeviationMs": 0,
                        "passengerImpact": 0,
                        "contractualImpact": 0,
                        "networkImpact": 0,
                        "resourceConsequence": 0,
                        "recoveryRank": 0,
                        "waitingSinceMs": train.departure_offset_ms + day_offset,
                    })
                })
                .collect::<Vec<_>>();
            event_count += apply(
                &mut state,
                &mut state_hash,
                &format!("{deployment_hash}:proof:{day}:{departure_offset_ms}:dispatch"),
                json!({ "type": "dispatch", "requests": requests }),
            )?;
            command_count += 1;
        }
    }
    let proof_end_ms = i64::try_from(SERVICE_DAYS)?
        .checked_mul(repeat_every_ms)
        .ok_or("Nachweisende ist erschoepft")?;
    if current_ms(&state)? < proof_end_ms {
        event_count += apply(
            &mut state,
            &mut state_hash,
            &format!("{deployment_hash}:proof:end:advance"),
            json!({ "type": "advance-to", "atMs": proof_end_ms }),
        )?;
        command_count += 1;
    }

    let restored: Value = serde_json::from_str(&restore_operational_simulation(
        &json!({
            "schemaVersion": RESTORE_SCHEMA,
            "expectedInitializationHash": initialization_hash,
            "state": state,
        })
        .to_string(),
        &infrastructure_path,
    )?)?;
    let restored_hash = string(
        restored.get("stateHash").ok_or("Restore-Hash fehlt")?,
        "Restore-Hash ist ungueltig",
    )?;
    if restored_hash != state_hash {
        return Err("v2-Restore-Hash weicht vom Mehrtageszustand ab".into());
    }
    let final_train_count = restored
        .pointer("/liveMap/trains")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    println!(
        "{}",
        json!({
            "worldId": state.pointer("/world/worldId"),
            "regionId": state.pointer("/world/regionId"),
            "initialTrainCount": initial_train_count,
            "finalTrainCount": final_train_count,
            "serviceDaysVerified": SERVICE_DAYS,
            "retirementCyclesVerified": SERVICE_DAYS - 1,
            "runtimeCommandCount": command_count,
            "operationalEventCount": event_count,
            "commitSequence": state.pointer("/world/commitSequence"),
            "eventSequence": state.pointer("/world/eventSequence"),
            "stateHash": state_hash,
            "restoreHashEqual": true,
        })
    );
    Ok(())
}
