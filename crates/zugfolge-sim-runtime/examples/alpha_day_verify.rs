//! Reproduzierbarer Mehrtagesnachweis des signierten v2-Betriebsprogramms.

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;

use serde_json::{Map, Value, json};
use zugfolge_sim_runtime::operational_runtime::{
    COMMAND_SCHEMA, RESTORE_SCHEMA, apply_operational_simulation_command,
    initialize_operational_simulation, restore_operational_simulation,
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

fn route_length_mm(route: &Map<String, Value>) -> Result<i64, Box<dyn Error>> {
    let legs = array(
        route
            .get("legs")
            .ok_or("Laufweg besitzt keine Abschnitte")?,
        "Laufwegabschnitte sind ungueltig",
    )?;
    let last = object(
        legs.last()
            .ok_or("Laufweg besitzt keinen letzten Abschnitt")?,
        "Letzter Laufwegabschnitt ist ungueltig",
    )?;
    let start = nonnegative_i64(
        last.get("routeStartMm").ok_or("routeStartMm fehlt")?,
        "routeStartMm ist ungueltig",
    )?;
    let entry = nonnegative_i64(
        last.get("edgeEntryMm").ok_or("edgeEntryMm fehlt")?,
        "edgeEntryMm ist ungueltig",
    )?;
    let exit = nonnegative_i64(
        last.get("edgeExitMm").ok_or("edgeExitMm fehlt")?,
        "edgeExitMm ist ungueltig",
    )?;
    let span = i64::try_from(exit.abs_diff(entry)).map_err(|_| "Laufwegspanne ist zu gross")?;
    start
        .checked_add(span)
        .filter(|value| *value > 0)
        .ok_or_else(|| "Laufweglaenge ist ungueltig".into())
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
    let infra = object(
        initialization
            .get("infraRelease")
            .ok_or("operatives InfraRelease fehlt")?,
        "operatives InfraRelease ist ungueltig",
    )?;
    let routes = object(
        infra
            .get("routeVersions")
            .ok_or("Laufwegversionen fehlen")?,
        "Laufwegversionen sind ungueltig",
    )?;
    let interlocking_routes = object(
        infra
            .get("interlockingRoutes")
            .ok_or("Fahrstrassenvorlagen fehlen")?,
        "Fahrstrassenvorlagen sind ungueltig",
    )?;
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
        let route_id = string(
            train_object
                .get("routeVersionId")
                .ok_or("routeVersionId fehlt")?,
            "routeVersionId ist ungueltig",
        )?;
        let route = object(
            routes
                .get(&route_id)
                .ok_or_else(|| format!("Laufweg '{route_id}' fehlt"))?,
            "Laufwegversion ist ungueltig",
        )?;
        let route_template_id = string(
            route.get("templateId").ok_or("templateId fehlt")?,
            "templateId ist ungueltig",
        )?;
        let movement_kind = string(
            train_object
                .get("movementKind")
                .ok_or("movementKind fehlt")?,
            "movementKind ist ungueltig",
        )?;
        let route_length = route_length_mm(route)?;
        let mut candidates = Vec::new();
        for candidate in interlocking_routes.values() {
            let candidate = object(candidate, "Fahrstrassenvorlage ist ungueltig")?;
            if candidate.get("routeTemplateId").and_then(Value::as_str)
                == Some(route_template_id.as_str())
                && candidate.get("movementKind").and_then(Value::as_str)
                    == Some(movement_kind.as_str())
                && candidate.get("authorityEndRouteMm").and_then(Value::as_i64)
                    == Some(route_length)
            {
                candidates.push(string(
                    candidate.get("id").ok_or("Fahrstrassen-ID fehlt")?,
                    "Fahrstrassen-ID ist ungueltig",
                )?);
            }
        }
        candidates.sort();
        let interlocking_route_id = candidates.into_iter().next().ok_or_else(|| {
            format!("Fahrt '{base_id}' besitzt keine Fahrstrasse bis zum Laufwegende")
        })?;
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
    let initialized: Value = serde_json::from_str(&initialize_operational_simulation(
        &serde_json::to_string(initialization)?,
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
                for train in trains {
                    let mut materialized = train.train.clone();
                    let materialized_object = materialized
                        .as_object_mut()
                        .ok_or("Fahrt ist nicht materialisierbar")?;
                    materialized_object.insert(
                        "id".to_owned(),
                        Value::String(recurring_train_id(&train.base_id, day)),
                    );
                    materialized_object
                        .insert("scheduledDepartureMs".to_owned(), Value::from(at_ms));
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
