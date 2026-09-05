//! Mehrzugbenchmark in einem gemeinsamen autoritativen Weltzustand.
#![allow(
    clippy::disallowed_methods,
    reason = "Ausschliesslich externer Messharnisch; Wandzeit gelangt nie in die Simulation"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;
use zugfolge_sim::operational::{
    Direction, EdgeGeometryPoint, InterlockingRouteTemplate, MovementKind, OperationalInfraRelease,
    OperationalWorld, PhysicalVehicle, RouteLeg, RouteVersion, VehicleCondition, VehicleType,
};

fn set(value: String) -> BTreeSet<String> {
    BTreeSet::from([value])
}

fn infrastructure(count: usize) -> OperationalInfraRelease {
    let mut infra = OperationalInfraRelease {
        id: "infra:shared-load/v1".into(),
        directed_edges: BTreeMap::new(),
        edge_geometries: BTreeMap::new(),
        route_versions: BTreeMap::new(),
        interlocking_routes: BTreeMap::new(),
        signals: BTreeSet::new(),
        switches: BTreeSet::new(),
        block_resources: BTreeSet::new(),
        platform_intervals: BTreeMap::new(),
        region_boundaries: BTreeSet::new(),
        rzue_layout_id: "layout:load".into(),
    };
    for index in 0..count {
        let edge = format!("edge:{index}");
        let block = format!("block:{index}");
        let signal = format!("signal:{index}");
        let overlap = format!("overlap:{index}");
        let flank = format!("flank:{index}");
        infra.directed_edges.insert(edge.clone(), 1_000_000);
        infra.edge_geometries.insert(
            edge.clone(),
            vec![
                EdgeGeometryPoint {
                    edge_offset_mm: 0,
                    latitude_e7: 510_000_000,
                    longitude_e7: 120_000_000,
                    bearing_milli_degrees: Some(90_000),
                },
                EdgeGeometryPoint {
                    edge_offset_mm: 1_000_000,
                    latitude_e7: 510_000_000,
                    longitude_e7: 121_000_000,
                    bearing_milli_degrees: None,
                },
            ],
        );
        infra.route_versions.insert(
            format!("route:{index}"),
            RouteVersion {
                id: format!("route:{index}"),
                template_id: format!("template:{index}"),
                predecessor_id: None,
                transition_route_mm: None,
                legs: vec![RouteLeg {
                    edge_id: edge,
                    direction: Direction::Along,
                    edge_entry_mm: 0,
                    edge_exit_mm: 1_000_000,
                    route_start_mm: 0,
                    block_ids: set(block.clone()),
                    speed_limit_mmps: 20_000,
                    gradient_per_mille: 0,
                    available_protection_systems: vec!["pzb".into()],
                    simultaneously_required_protection_systems: Vec::new(),
                }],
            },
        );
        infra.interlocking_routes.insert(
            format!("lock:{index}"),
            InterlockingRouteTemplate {
                id: format!("lock:{index}"),
                route_template_id: format!("template:{index}"),
                authority_start_route_mm: 0,
                signal_id: signal.clone(),
                movement_kind: MovementKind::Train,
                path_resources: set(block.clone()),
                overlap_resources: set(overlap.clone()),
                flank_resources: set(flank.clone()),
                switch_positions: BTreeMap::new(),
                authority_end_route_mm: 1_000_000,
                release_after_tail_route_mm: 1_000_000,
            },
        );
        infra.signals.insert(signal);
        infra.block_resources.extend([block, overlap, flank]);
    }
    infra
}

fn vehicle(index: usize) -> PhysicalVehicle {
    PhysicalVehicle {
        id: format!("vehicle:{index}"),
        type_id: "type:load".into(),
        powered: true,
        orientation: Direction::Along,
        condition: VehicleCondition {
            mechanics_basis_points: 9500,
            drive_basis_points: 9500,
            brakes_basis_points: 9500,
            kilometres_since_maintenance: 500,
            operating_hours_since_maintenance: 20,
            open_observations: 0,
        },
        restrictions: BTreeMap::new(),
        history: Vec::new(),
    }
}

fn percentile(samples: &mut [u128], percent: usize) -> u128 {
    samples.sort_unstable();
    samples[(samples.len() * percent).div_ceil(100).saturating_sub(1)]
}

fn main() {
    let count = std::env::args()
        .nth(1)
        .map(|arg| arg.parse::<usize>().expect("train count"))
        .unwrap_or(250);
    assert!((1..=5000).contains(&count));
    // guards:allow no-wallclock — Messung des externen Lastaufbaus.
    let setup_started = Instant::now();
    let mut world = OperationalWorld::new(
        "world:shared-load",
        "region:shared-load",
        0,
        infrastructure(count),
    )
    .unwrap();
    world
        .register_vehicle_type(
            VehicleType {
                id: "type:load".into(),
                role: None,
                control_stands: None,
                traction: None,
                electric_systems: None,
                length_mm: 120_000,
                mass_kg: 240_000,
                maximum_speed_mmps: 20_000,
                power_watts: 4_000_000,
                starting_tractive_force_newtons: 240_000,
                raw_formation_dynamics: None,
                maximum_acceleration_mmps2: 1000,
                service_brake_mmps2: 1000,
                emergency_brake_mmps2: 1500,
                protection_systems: set("pzb".into()),
            },
            true,
        )
        .unwrap();
    for index in 0..count {
        world.register_vehicle(vehicle(index)).unwrap();
        world
            .create_formation(
                format!("formation:{index}"),
                None,
                vec![format!("vehicle:{index}")],
            )
            .unwrap();
        world
            .materialize_train(
                format!("train:{index}"),
                format!("RB {}", index + 1),
                "operator:load",
                MovementKind::Train,
                format!("route:{index}"),
                format!("formation:{index}"),
                0,
                None,
                false,
            )
            .unwrap();
        world
            .lock_route(&format!("train:{index}"), &format!("lock:{index}"))
            .unwrap();
        world.plan_motion(&format!("train:{index}")).unwrap();
        world.events.clear();
    }
    // Jeder zehnte Block erhaelt einen echten konkurrierenden Kandidaten.
    let mut conflicts = 0;
    for index in (0..count).step_by(10) {
        let other = count + index;
        world.register_vehicle(vehicle(other)).unwrap();
        world
            .create_formation(
                format!("formation:{other}"),
                None,
                vec![format!("vehicle:{other}")],
            )
            .unwrap();
        world
            .materialize_train(
                format!("train:{other}"),
                format!("RB {}", other + 1),
                "operator:load",
                MovementKind::Train,
                format!("route:{index}"),
                format!("formation:{other}"),
                0,
                None,
                false,
            )
            .unwrap();
        assert!(
            world
                .lock_route(&format!("train:{other}"), &format!("lock:{index}"))
                .is_err()
        );
        conflicts += 1;
        world.events.clear();
    }
    let setup_ms = setup_started.elapsed().as_millis();
    let mut movement_ns = 0;
    let mut verification_ns = 0;
    let mut checkpoint_ns = 0;
    let mut events = 0_u64;
    let mut samples = Vec::new();
    for second in 1..=75 {
        let sequence = world.event_sequence;
        // guards:allow no-wallclock — Ereignisverarbeitung getrennt von Referenzpruefung/Commit messen.
        let started = Instant::now();
        world.advance_to(second * 1_000).unwrap();
        let elapsed = started.elapsed().as_nanos();
        movement_ns += elapsed;
        let delta = world.event_sequence - sequence;
        events += delta;
        if delta > 0 {
            samples.push(elapsed);
        }
        world.events.clear();
        // guards:allow no-wallclock — Vollstaendige Sicherheitsreferenz nach jeder Zeitrevision.
        let started = Instant::now();
        world.verify_invariants().unwrap();
        verification_ns += started.elapsed().as_nanos();
        // guards:allow no-wallclock — Zustandscommit separat messen.
        let started = Instant::now();
        world.state_hash();
        checkpoint_ns += started.elapsed().as_nanos();
    }
    assert_eq!(
        world
            .trains
            .values()
            .filter(|train| train.head_route_mm == 1_000_000)
            .count(),
        count
    );
    let p95 = percentile(&mut samples, 95);
    let p99 = percentile(&mut samples, 99);
    println!(
        "{}",
        serde_json::json!({"schemaVersion":"operational-shared-world-benchmark/v1","activeTrains":count,"waitingCompetitors":conflicts,"setupMs":setup_ms,"simulatedMs":75000,"events":events,"movementNs":movement_ns,"fullInvariantNs":verification_ns,"stateCommitNs":checkpoint_ns,"eventfulRevisionP95Ns":p95,"eventfulRevisionP99Ns":p99,"eventsPerSecond":u128::from(events)*1_000_000_000/movement_ns.max(1),"catchUpRatioMilli":75_000_000_000_000_u128/(movement_ns+verification_ns+checkpoint_ns).max(1),"serializedDynamicBytes":serde_json::to_vec(&world).unwrap().len(),"stateHash":world.state_hash().to_hex()})
    );
}
