//! Plattformübergreifender Golden-Master des regionalen Writers.

use zugfolge_determinism::{assert_golden, golden_path};
use zugfolge_sim::{
    Command, ConservativeDispatcher, MaterializationWindow, OperatingStatus, Simulation,
    TrainCategory, TrainRun, Waypoint,
};

fn run() -> Simulation<ConservativeDispatcher> {
    let mut simulation = Simulation::new(
        7,
        2,
        0,
        MaterializationWindow::new(48).unwrap(),
        ConservativeDispatcher,
    );
    simulation
        .apply(Command::Materialize(TrainRun {
            world_id: 7,
            id: 11,
            region_id: 2,
            operator: "Referenzbahn".into(),
            train_number: "RE 11".into(),
            category: TrainCategory::Regional,
            route: vec![
                Waypoint {
                    operating_point: "Leipzig Hbf".into(),
                    position_mm: 0,
                    arrival: 60,
                    minimum_dwell_seconds: 30,
                    departure: 90,
                },
                Waypoint {
                    operating_point: "Halle Hbf".into(),
                    position_mm: 40_000_000,
                    arrival: 2_400,
                    minimum_dwell_seconds: 30,
                    departure: 2_430,
                },
            ],
            next_waypoint: 0,
            delay_seconds: 0,
            position_mm: 0,
            speed_mm_per_second: 0,
            status: OperatingStatus::Planned,
        }))
        .unwrap();
    simulation
        .apply(Command::AddDelay {
            train_run_id: 11,
            seconds: 120,
        })
        .unwrap();
    simulation.apply(Command::AdvanceTo(3_000)).unwrap();
    simulation
}

#[test]
fn replay_is_platform_stable() {
    let first = run();
    let second = run();
    assert_eq!(first.state_hash(), second.state_hash());
    assert_golden(golden_path!("simulation-24h"), first.state_hash());
}
