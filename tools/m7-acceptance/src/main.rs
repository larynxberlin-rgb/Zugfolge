//! Erzeugt echte M7-Kernereignisse aus einem deterministischen 48-Stunden-Lauf.

use std::env;
use std::error::Error;

use serde_json::{Value, json};
use zugfolge_rules::{OperatingProgram, RuleDispatcher, conservative_punctual};
use zugfolge_sim::{
    Command, DispatchFacts, DispatchImpact, DispatchTrigger, DomainEvent, EventKind,
    MaterializationWindow, OperatingStatus, Simulation, TrainCategory, TrainRun, Waypoint,
};

fn train(id: u64, first: i64, second: i64) -> TrainRun {
    TrainRun {
        world_id: 7,
        id,
        region_id: 2,
        operator: "M7-Bahn".into(),
        train_number: format!("RE {id}"),
        category: TrainCategory::Regional,
        route: vec![
            Waypoint {
                operating_point: "Leipzig Hbf".into(),
                position_mm: 0,
                arrival: first,
                minimum_dwell_seconds: 30,
                departure: first + 30,
            },
            Waypoint {
                operating_point: "Halle Hbf".into(),
                position_mm: 40_000_000,
                arrival: second,
                minimum_dwell_seconds: 30,
                departure: second + 30,
            },
        ],
        next_waypoint: 0,
        delay_seconds: 0,
        position_mm: 0,
        speed_mm_per_second: 0,
        status: OperatingStatus::Planned,
    }
}

fn timestamp(second: i64) -> String {
    let day_offset = second.div_euclid(86_400);
    let within_day = second.rem_euclid(86_400);
    let hour = within_day / 3_600;
    let minute = (within_day % 3_600) / 60;
    let second = within_day % 60;
    format!(
        "2026-08-{:02}T{hour:02}:{minute:02}:{second:02}.000Z",
        11 + day_offset
    )
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args().skip(1);
    let world_id = arguments.next().ok_or("Weltkennung fehlt")?;
    let operator_id = arguments.next().ok_or("EVU-Kennung fehlt")?;
    let program_json = arguments.next();
    if arguments.next().is_some() {
        return Err("Unerwartete zusätzliche Argumente".into());
    }

    let program = match program_json {
        Some(value) => serde_json::from_str::<OperatingProgram>(&value)?,
        None => conservative_punctual(world_id.clone(), operator_id.clone(), 1),
    };
    if program.world_id != world_id || program.operator_id != operator_id {
        return Err("Betriebsprogramm gehört nicht zur angeforderten Welt und zum EVU".into());
    }
    let dispatcher = RuleDispatcher::new(program)?;
    let mut simulation = Simulation::new(7, 2, 0, MaterializationWindow::new(48)?, dispatcher);
    let mut core_events = Vec::<DomainEvent>::new();
    core_events.extend(simulation.apply(Command::Materialize(train(31, 21_600, 30_000)))?);
    core_events.extend(simulation.apply(Command::Materialize(train(32, 3_600, 7_200)))?);

    let mut facts = DispatchFacts::neutral(700, 21_600);
    facts.route_closed = true;
    facts.impact = DispatchImpact {
        affected_train_runs: 4,
        affected_connections: 3,
        affected_rotations: 1,
        affected_personnel_pools: 1,
        affected_vehicles: 1,
        cost_cents: 85_000,
        contract_penalty_cents: 20_000,
        cancelled_stops: 1,
        cause: "Streckensperrung".into(),
        affected_resource: "Abzweig Gröbers".into(),
        contract_effect: "Ausfallwertung".into(),
    };
    core_events.extend(simulation.apply(Command::Dispatch {
        train_run_id: 31,
        at: 21_600,
        trigger: DispatchTrigger::RouteClosure,
        facts,
    })?);
    core_events.extend(simulation.apply(Command::AdvanceTo(172_800))?);

    let explanation = simulation
        .dispatcher()
        .decisions()
        .first()
        .ok_or("Regelentscheidung fehlt")?;
    let explanation_value = serde_json::to_value(explanation)?;
    let mut events = Vec::<Value>::new();
    let mut sequence = 1_u64;
    for event in &core_events {
        match &event.kind {
            EventKind::Completed { train_run_id } => {
                events.push(json!({
                    "sequence": sequence,
                    "eventType": "operations.train-outcome",
                    "occurredAt": timestamp(event.at),
                    "payload": {
                        "operatorId": operator_id,
                        "trainRunId": train_run_id.to_string(),
                        "status": "completed",
                        "delaySeconds": 0
                    }
                }));
                sequence += 1;
            }
            EventKind::DispatchApplied {
                train_run_id,
                decision_id,
                ..
            } => {
                events.push(json!({
                    "sequence": sequence,
                    "eventType": "dispatch.major-event",
                    "occurredAt": timestamp(event.at),
                    "payload": {
                        "operatorId": operator_id,
                        "trainRunId": train_run_id.to_string(),
                        "decisionId": decision_id.to_string(),
                        "action": explanation.selected_action,
                        "cause": explanation.impact.cause,
                        "affectedResource": explanation.impact.affected_resource,
                        "outcomeReason": explanation.outcome_reason,
                        "impact": explanation.impact,
                        "manualOverride": explanation.manual_override,
                        "major": true,
                        "explanation": explanation_value
                    }
                }));
                sequence += 1;
            }
            _ => {}
        }
    }
    let output = json!({
        "schema": "zugfolge-m7-acceptance/v1",
        "worldId": world_id,
        "operatorId": operator_id,
        "simulatedThroughSeconds": 172_800,
        "stateHash": simulation.state_hash().to_hex(),
        "decisionHash": simulation.dispatcher().decision_hash().to_hex(),
        "events": events
    });
    println!("{output}");
    Ok(())
}
