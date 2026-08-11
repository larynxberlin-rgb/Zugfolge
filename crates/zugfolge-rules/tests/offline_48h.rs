//! Deterministischer 48-Stunden-Abnahmelauf mit einer echten Regelentscheidung.

use zugfolge_rules::{RuleDispatcher, conservative_punctual};
use zugfolge_sim::{
    Command, DispatchFacts, DispatchImpact, DispatchTrigger, MaterializationWindow,
    OperatingStatus, Simulation, TrainCategory, TrainRun, Waypoint,
};

fn train(id: u64, first: i64, second: i64) -> TrainRun {
    TrainRun {
        world_id: 7,
        id,
        region_id: 2,
        operator: "Testbahn".into(),
        train_number: format!("RB {id}"),
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

fn run() -> (String, String, usize) {
    let dispatcher = RuleDispatcher::new(conservative_punctual(7, 9, 1)).unwrap();
    let mut simulation =
        Simulation::new(7, 2, 0, MaterializationWindow::new(48).unwrap(), dispatcher);
    simulation
        .apply(Command::Materialize(train(31, 21_600, 30_000)))
        .unwrap();
    simulation
        .apply(Command::Materialize(train(32, 3_600, 7_200)))
        .unwrap();

    let mut facts = DispatchFacts::neutral(700, 21_600);
    facts.route_closed = true;
    facts.impact = DispatchImpact {
        affected_train_runs: 1,
        affected_connections: 2,
        affected_rotations: 1,
        affected_personnel_pools: 1,
        affected_vehicles: 1,
        cost_cents: 85_000,
        contract_penalty_cents: 20_000,
        cancelled_stops: 1,
        cause: "Streckensperrung".into(),
        affected_resource: "Leipzig–Halle".into(),
        contract_effect: "Ausfallwertung".into(),
    };
    simulation
        .apply(Command::Dispatch {
            train_run_id: 31,
            at: 21_600,
            trigger: DispatchTrigger::RouteClosure,
            facts,
        })
        .unwrap();
    simulation.apply(Command::AdvanceTo(172_800)).unwrap();
    let explanation = &simulation.dispatcher().decisions()[0];
    assert_eq!(explanation.impact.affected_train_runs, 1);
    assert!(!explanation.limits.is_empty());
    (
        simulation.state_hash().to_hex(),
        simulation.dispatcher().decision_hash().to_hex(),
        simulation.dispatcher().decisions().len(),
    )
}

#[test]
fn forty_eight_hour_offline_replay_is_identical() {
    let first = run();
    let second = run();
    assert_eq!(first, second);
    assert_eq!(first.2, 1);
}
