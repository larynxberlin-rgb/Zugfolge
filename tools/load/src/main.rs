//! Reproduzierbare M4.11-Lastmessung; nur dieser äußere Harnisch liest die Uhr.
use std::time::Instant;
use zugfolge_sim::{
    Command, ConservativeDispatcher, MaterializationWindow, OperatingStatus, Simulation,
    TrainCategory, TrainRun, Waypoint, load_report,
};

#[allow(
    clippy::disallowed_methods,
    reason = "M4.11 misst im äußeren Last-Harnisch reale Laufzeit; die Simulationszeit des Kerns bleibt explizit"
)]
fn main() {
    let train_count = std::env::args()
        .nth(1)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(180_000);
    let mut simulation = Simulation::new(
        1,
        1,
        0,
        MaterializationWindow::new(72).expect("Fenster"),
        ConservativeDispatcher,
    );
    let started = Instant::now();
    let mut events = 0_u64;
    for id in 1..=train_count {
        let route = (0..10)
            .map(|step| {
                let second = 60 + i64::from(step) * 600;
                Waypoint {
                    operating_point: format!("B{step}"),
                    position_mm: i64::from(step) * 10_000_000,
                    arrival: second,
                    minimum_dwell_seconds: 30,
                    departure: second + 30,
                }
            })
            .collect();
        events = events.saturating_add(
            u64::try_from(
                simulation
                    .apply(Command::Materialize(TrainRun {
                        world_id: 1,
                        id,
                        region_id: 1,
                        operator: "Last-EVU".into(),
                        train_number: format!("L{id}"),
                        category: TrainCategory::Regional,
                        route,
                        next_waypoint: 0,
                        delay_seconds: 0,
                        position_mm: 0,
                        speed_mm_per_second: 0,
                        status: OperatingStatus::Planned,
                    }))
                    .expect("Materialisierung")
                    .len(),
            )
            .expect("Ereigniszahl"),
        );
    }
    events = events.saturating_add(
        u64::try_from(
            simulation
                .apply(Command::AdvanceTo(86_400))
                .expect("Simulation")
                .len(),
        )
        .expect("Ereigniszahl"),
    );
    let micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
    let report = load_report(events, micros);
    println!(
        "train_runs={train_count} events={} elapsed_us={} events_per_second={} target_met={}",
        report.events, report.elapsed_micros, report.events_per_second, report.target_met
    );
    if train_count < 120_000 || events < 2_000_000 || !report.target_met {
        std::process::exit(1);
    }
}
