//! Reproduzierbarer Kernbenchmark fuer Stellwerk, FDL, Bewegung und Rangieren.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::time::Instant;

use zugfolge_sim::operational::{
    AutomaticShuntingNeed, Direction, DispatchRequest, EdgeGeometryPoint,
    InterlockingRouteTemplate, MovementKind, OperationalInfraRelease, OperationalWorld,
    PhysicalVehicle, RouteLeg, RouteVersion, ShuntingPurpose, VehicleCondition, VehicleType,
};

fn set(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn release() -> OperationalInfraRelease {
    let route = RouteVersion {
        id: "route:load:v1".to_owned(),
        template_id: "template:load".to_owned(),
        predecessor_id: None,
        transition_route_mm: None,
        legs: vec![RouteLeg {
            edge_id: "edge:load".to_owned(),
            direction: Direction::Along,
            edge_entry_mm: 0,
            edge_exit_mm: 120_000,
            route_start_mm: 0,
            block_ids: set(&["block:load"]),
            speed_limit_mmps: 20_000,
            gradient_per_mille: 0,
            available_protection_systems: vec!["pzb".to_owned()],
            simultaneously_required_protection_systems: Vec::new(),
        }],
    };
    let route_template =
        |id: &str, signal: &str, movement_kind, authority_end_route_mm| InterlockingRouteTemplate {
            id: id.to_owned(),
            route_template_id: "template:load".to_owned(),
            authority_start_route_mm: 0,
            signal_id: signal.to_owned(),
            movement_kind,
            path_resources: set(&[if movement_kind == MovementKind::Train {
                "block:load"
            } else {
                "resource:shunting"
            }]),
            overlap_resources: set(&[if movement_kind == MovementKind::Train {
                "overlap:train"
            } else {
                "overlap:shunting"
            }]),
            flank_resources: set(&[if movement_kind == MovementKind::Train {
                "flank:train"
            } else {
                "flank:shunting"
            }]),
            switch_positions: BTreeMap::from([("switch:load".to_owned(), "straight".to_owned())]),
            authority_end_route_mm,
            release_after_tail_route_mm: authority_end_route_mm - 10_000,
        };
    let train = route_template(
        "interlocking:train",
        "signal:train",
        MovementKind::Train,
        120_000,
    );
    let shunting = route_template(
        "interlocking:shunting",
        "signal:shunting",
        MovementKind::Shunting,
        50_000,
    );
    OperationalInfraRelease {
        id: "infra:operational-load:v2".to_owned(),
        directed_edges: BTreeMap::from([("edge:load".to_owned(), 120_000)]),
        edge_geometries: BTreeMap::from([(
            "edge:load".to_owned(),
            vec![
                EdgeGeometryPoint {
                    edge_offset_mm: 0,
                    latitude_e7: 510_000_000,
                    longitude_e7: 120_000_000,
                    bearing_milli_degrees: Some(90_000),
                },
                EdgeGeometryPoint {
                    edge_offset_mm: 120_000,
                    latitude_e7: 510_000_000,
                    longitude_e7: 120_120_000,
                    bearing_milli_degrees: None,
                },
            ],
        )]),
        route_versions: BTreeMap::from([(route.id.clone(), route)]),
        interlocking_routes: BTreeMap::from([
            (train.id.clone(), train),
            (shunting.id.clone(), shunting),
        ]),
        signals: set(&["signal:train", "signal:shunting"]),
        switches: set(&["switch:load"]),
        block_resources: set(&[
            "block:load",
            "resource:train",
            "resource:shunting",
            "overlap:train",
            "overlap:shunting",
            "flank:train",
            "flank:shunting",
        ]),
        platform_intervals: BTreeMap::new(),
        region_boundaries: set(&["boundary:load"]),
        rzue_layout_id: "rzue:load:v1".to_owned(),
    }
}

fn vehicle_type() -> VehicleType {
    VehicleType {
        id: "type:load".to_owned(),
        role: None,
        control_stands: None,
        traction: None,
        electric_systems: None,
        length_mm: 10_000,
        mass_kg: 80_000,
        maximum_speed_mmps: 20_000,
        power_watts: 4_000_000,
        starting_tractive_force_newtons: 240_000,
        raw_formation_dynamics: None,
        maximum_acceleration_mmps2: 1_000,
        service_brake_mmps2: 1_000,
        emergency_brake_mmps2: 1_500,
        protection_systems: set(&["pzb"]),
    }
}

fn execute_cycle(index: usize, infra: &OperationalInfraRelease) -> usize {
    let movement_kind = if index & 1 == 0 {
        MovementKind::Train
    } else {
        MovementKind::Shunting
    };
    let mut world = OperationalWorld::new(
        format!("world:load:{index}"),
        "region:load",
        0,
        infra.clone(),
    )
    .expect("benchmark release is valid");
    world
        .register_vehicle_type(vehicle_type(), true)
        .expect("benchmark vehicle type is valid");
    world
        .register_vehicle(PhysicalVehicle {
            id: "vehicle:load".to_owned(),
            type_id: "type:load".to_owned(),
            powered: true,
            orientation: Direction::Along,
            condition: VehicleCondition {
                mechanics_basis_points: 9_500,
                drive_basis_points: 9_500,
                brakes_basis_points: 9_500,
                kilometres_since_maintenance: 500,
                operating_hours_since_maintenance: 20,
                open_observations: 0,
            },
            restrictions: BTreeMap::new(),
            history: Vec::new(),
        })
        .expect("benchmark vehicle is valid");
    world
        .create_formation("formation:load", None, vec!["vehicle:load".to_owned()])
        .expect("benchmark formation is valid");
    world
        .materialize_train(
            "movement:load",
            "L 1",
            "operator:load",
            movement_kind,
            "route:load:v1",
            "formation:load",
            0,
            None,
            false,
        )
        .expect("benchmark movement materializes");
    if movement_kind == MovementKind::Train {
        let selected = world
            .dispatch(&[DispatchRequest {
                train_id: "movement:load".to_owned(),
                interlocking_route_id: "interlocking:train".to_owned(),
                committed_rank: 0,
                timetable_deviation_ms: 0,
                passenger_impact: 0,
                contractual_impact: 0,
                network_impact: 0,
                resource_consequence: 0,
                recovery_rank: 0,
                waiting_since_ms: 0,
            }])
            .expect("dispatcher evaluates benchmark request");
        assert_eq!(selected.as_deref(), Some("movement:load"));
        world
            .plan_motion("movement:load")
            .expect("driver plans benchmark motion");
    } else {
        world
            .execute_automatic_shunting(&AutomaticShuntingNeed {
                id: format!("need:{index}"),
                train_id: "movement:load".to_owned(),
                purpose: ShuntingPurpose::Formation,
                minimum_authority_end_route_mm: 40_000,
            })
            .expect("automatic shunting executes benchmark order");
    }
    let end = world.trains["movement:load"]
        .motion_segment
        .as_ref()
        .expect("motion segment exists")
        .valid_until_ms;
    world.advance_to(end).expect("benchmark motion completes");
    world
        .verify_invariants()
        .expect("benchmark state stays safe");
    world.events.len()
}

#[allow(
    clippy::disallowed_methods,
    reason = "Instant misst nur den externen Benchmarkdurchsatz und beeinflusst keinen Simulationszustand"
)]
fn main() {
    let cycles = env::args()
        .skip_while(|argument| argument != "--cycles")
        .nth(1)
        .map(|value| {
            value
                .parse::<usize>()
                .expect("--cycles requires a positive integer")
        })
        .unwrap_or(20_000);
    assert!(cycles > 0, "--cycles must be positive");
    let infra = release();
    // guards:allow no-wallclock — Wandzeit misst nur den externen Benchmarkdurchsatz, nie Simulationszustand.
    let started = Instant::now();
    let event_count: usize = (0..cycles).map(|index| execute_cycle(index, &infra)).sum();
    let elapsed = started.elapsed();
    let elapsed_ns = elapsed.as_nanos().max(1);
    let events_per_second = (event_count as u128).saturating_mul(1_000_000_000) / elapsed_ns;
    println!(
        "{{\"schemaVersion\":\"zugfolge-operational-core-benchmark/v1\",\"cycles\":{cycles},\"events\":{event_count},\"elapsedMilliseconds\":{},\"eventsPerSecond\":{events_per_second},\"includes\":[\"interlocking\",\"dispatcher\",\"driver\",\"exact-occupancy\",\"automatic-shunting\",\"invariant-check\"]}}",
        elapsed.as_millis(),
    );
}
