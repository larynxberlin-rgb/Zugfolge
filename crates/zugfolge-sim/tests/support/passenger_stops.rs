//! Reine Testinfrastruktur aus dem bestehenden Operational-Abnahmevertrag.
use std::collections::{BTreeMap, BTreeSet};
use zugfolge_sim::operational::*;
pub fn passenger_stop_fixture() -> (OperationalInfraRelease, TrainMaterialization) {
    use zugfolge_sim::operational::{OperationalPassengerStop, OperationalPassengerStopPlan};
    let mut infra = release();
    let template = infra.interlocking_routes["interlocking:train"].clone();
    infra
        .interlocking_routes
        .retain(|_, route| route.movement_kind != MovementKind::Train);
    let original = infra.route_versions["route:v1"].legs.clone();
    let mut legs = Vec::new();
    for (index, (start, end, id)) in [
        (0, 10_000, "interlocking:seed"),
        (10_000, 30_000, "interlocking:train"),
        (30_000, 60_000, "interlocking:train:b"),
        (60_000, 120_000, "interlocking:train:c"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut leg = original[usize::from(start >= 60_000)].clone();
        if start < 60_000 {
            leg.edge_entry_mm = start;
            leg.edge_exit_mm = end;
        }
        leg.route_start_mm = start;
        leg.block_ids = BTreeSet::from([format!("block:stop:{index}")]);
        infra.block_resources.extend(leg.block_ids.iter().cloned());
        let mut locking = template.clone();
        locking.id = id.to_owned();
        locking.signal_id = format!("signal:stop:{index}");
        locking.authority_start_route_mm = start;
        locking.authority_end_route_mm = end;
        locking.release_after_tail_route_mm = end;
        locking.path_resources = leg.block_ids.clone();
        infra.signals.insert(locking.signal_id.clone());
        infra
            .interlocking_routes
            .insert(locking.id.clone(), locking);
        legs.push(leg);
    }
    for route in infra.route_versions.values_mut() {
        route.legs = legs.clone();
    }
    for (id, edge, from_mm, to_mm, direction) in [
        ("platform:a", "edge:a", 0, 20_000, Direction::Along),
        ("platform:b", "edge:a", 25_000, 45_000, Direction::Along),
        ("platform:c", "edge:b", 0, 20_000, Direction::Against),
    ] {
        infra.platform_intervals.insert(
            id.to_owned(),
            TrackInterval {
                edge_id: edge.to_owned(),
                from_mm,
                to_mm,
                direction,
            },
        );
    }
    let mut input = program_template("train:stops", MovementKind::Train, 10_000);
    input.public_passenger_stop = true;
    input.scheduled_departure_ms = Some(1_000);
    input.stop_plan = Some(OperationalPassengerStopPlan {
        schema_version: "zugfolge-operational-passenger-stop-plan/v1".to_owned(),
        world_id: "world:1".to_owned(),
        infrastructure_release_id: infra.id.clone(),
        timetable_release_id: "timetable:fixture".to_owned(),
        service_id: input.id.clone(),
        service_run_id: "service:stops:day-0".to_owned(),
        train_run_id: input.id.clone(),
        route_version_id: input.route_version_id.clone(),
        source_binding_hash: "1".repeat(64),
        stops: [
            ("a", 10_000, 0, 1_000, 1_000),
            ("b", 40_000, 10_000, 15_000, 5_000),
            ("c", 120_000, 30_000, 30_000, 0),
        ]
        .into_iter()
        .enumerate()
        .map(
            |(
                stop_sequence,
                (name, route_mm, scheduled_arrival_ms, scheduled_departure_ms, minimum_dwell_ms),
            )| OperationalPassengerStop {
                stop_id: format!("train:stops:{stop_sequence}"),
                station_id: format!("station:{name}"),
                stop_sequence,
                route_mm,
                platform_id: format!("platform:{name}"),
                scheduled_arrival_ms,
                scheduled_departure_ms,
                minimum_dwell_ms,
            },
        )
        .collect(),
    });
    (infra, input)
}

fn set(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn release() -> OperationalInfraRelease {
    let route = RouteVersion {
        id: "route:v1".to_owned(),
        template_id: "route-template".to_owned(),
        predecessor_id: None,
        transition_route_mm: None,
        legs: vec![
            RouteLeg {
                edge_id: "edge:a".to_owned(),
                direction: Direction::Along,
                edge_entry_mm: 0,
                edge_exit_mm: 60_000,
                route_start_mm: 0,
                block_ids: set(&["block:a"]),
                speed_limit_mmps: 20_000,
                gradient_per_mille: 0,
                available_protection_systems: vec!["pzb".to_owned()],
                simultaneously_required_protection_systems: Vec::new(),
            },
            RouteLeg {
                edge_id: "edge:b".to_owned(),
                direction: Direction::Against,
                edge_entry_mm: 60_000,
                edge_exit_mm: 0,
                route_start_mm: 60_000,
                block_ids: set(&["block:b"]),
                speed_limit_mmps: 20_000,
                gradient_per_mille: -4,
                available_protection_systems: vec!["pzb".to_owned()],
                simultaneously_required_protection_systems: Vec::new(),
            },
        ],
    };
    let reroute = RouteVersion {
        id: "route:v2".to_owned(),
        template_id: "route-template".to_owned(),
        predecessor_id: Some("route:v1".to_owned()),
        transition_route_mm: Some(60_000),
        legs: route.legs.clone(),
    };
    let mut routes = BTreeMap::new();
    routes.insert(route.id.clone(), route);
    routes.insert(reroute.id.clone(), reroute);
    let train_route = InterlockingRouteTemplate {
        id: "interlocking:train".to_owned(),
        route_template_id: "route-template".to_owned(),
        authority_start_route_mm: 0,
        signal_id: "signal:train".to_owned(),
        movement_kind: MovementKind::Train,
        path_resources: set(&["block:a"]),
        overlap_resources: set(&["overlap:1"]),
        flank_resources: set(&["flank:1", "route-resource:common"]),
        switch_positions: BTreeMap::from([("switch:1".to_owned(), "left".to_owned())]),
        authority_end_route_mm: 60_000,
        release_after_tail_route_mm: 50_000,
    };
    let train_route_continuation = InterlockingRouteTemplate {
        id: "interlocking:train:b".to_owned(),
        route_template_id: "route-template".to_owned(),
        authority_start_route_mm: 60_000,
        signal_id: "signal:train:b".to_owned(),
        movement_kind: MovementKind::Train,
        path_resources: set(&["block:b"]),
        overlap_resources: set(&["overlap:1"]),
        flank_resources: set(&["flank:train:b"]),
        switch_positions: BTreeMap::from([("switch:1".to_owned(), "left".to_owned())]),
        authority_end_route_mm: 120_000,
        release_after_tail_route_mm: 120_000,
    };
    let shunting = InterlockingRouteTemplate {
        id: "interlocking:shunting".to_owned(),
        route_template_id: "route-template".to_owned(),
        authority_start_route_mm: 10_000,
        signal_id: "signal:shunting".to_owned(),
        movement_kind: MovementKind::Shunting,
        path_resources: set(&["route-resource:yard"]),
        overlap_resources: set(&["overlap:yard"]),
        flank_resources: set(&["flank:yard"]),
        switch_positions: BTreeMap::from([("switch:1".to_owned(), "left".to_owned())]),
        authority_end_route_mm: 50_000,
        release_after_tail_route_mm: 40_000,
    };
    OperationalInfraRelease {
        id: "infra:operational:v2".to_owned(),
        directed_edges: BTreeMap::from([
            ("edge:a".to_owned(), 60_000),
            ("edge:b".to_owned(), 60_000),
        ]),
        edge_geometries: BTreeMap::from([
            (
                "edge:a".to_owned(),
                vec![
                    EdgeGeometryPoint {
                        edge_offset_mm: 0,
                        latitude_e7: 510_000_000,
                        longitude_e7: 120_000_000,
                        bearing_milli_degrees: Some(90_000),
                    },
                    EdgeGeometryPoint {
                        edge_offset_mm: 60_000,
                        latitude_e7: 510_000_000,
                        longitude_e7: 120_060_000,
                        bearing_milli_degrees: None,
                    },
                ],
            ),
            (
                "edge:b".to_owned(),
                vec![
                    EdgeGeometryPoint {
                        edge_offset_mm: 0,
                        latitude_e7: 510_060_000,
                        longitude_e7: 120_060_000,
                        bearing_milli_degrees: Some(0),
                    },
                    EdgeGeometryPoint {
                        edge_offset_mm: 60_000,
                        latitude_e7: 510_000_000,
                        longitude_e7: 120_060_000,
                        bearing_milli_degrees: None,
                    },
                ],
            ),
        ]),
        route_versions: routes,
        interlocking_routes: BTreeMap::from([
            (train_route.id.clone(), train_route),
            (
                train_route_continuation.id.clone(),
                train_route_continuation,
            ),
            (shunting.id.clone(), shunting),
        ]),
        signals: set(&[
            "signal:train",
            "signal:train:b",
            "signal:opposing",
            "signal:shunting",
        ]),
        switches: set(&["switch:1"]),
        block_resources: set(&[
            "block:a",
            "block:b",
            "route-resource:common",
            "route-resource:yard",
            "overlap:1",
            "overlap:2",
            "overlap:yard",
            "flank:1",
            "flank:train:b",
            "flank:2",
            "flank:yard",
        ]),
        platform_intervals: BTreeMap::from([(
            "platform:short".to_owned(),
            TrackInterval {
                edge_id: "edge:a".to_owned(),
                from_mm: 10_000,
                to_mm: 25_000,
                direction: Direction::Along,
            },
        )]),
        region_boundaries: set(&["boundary:west"]),
        rzue_layout_id: "rzue:layout:v1".to_owned(),
    }
}

pub fn vehicle_type(id: &str, length_mm: u32) -> VehicleType {
    VehicleType {
        id: id.to_owned(),
        role: None,
        control_stands: None,
        traction: None,
        electric_systems: None,
        length_mm,
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

pub fn vehicle(id: &str, type_id: &str) -> PhysicalVehicle {
    PhysicalVehicle {
        id: id.to_owned(),
        type_id: type_id.to_owned(),
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
    }
}
fn program_template(
    id: &str,
    movement_kind: MovementKind,
    head_route_mm: i64,
) -> TrainMaterialization {
    TrainMaterialization {
        stop_plan: None,
        service_outcome: None,
        id: id.to_owned(),
        train_number: "RB 1".to_owned(),
        operator_id: "operator:1".to_owned(),
        movement_kind,
        route_version_id: "route:v1".to_owned(),
        formation_version_id: "formation:1".to_owned(),
        head_route_mm,
        scheduled_departure_ms: None,
        public_passenger_stop: false,
    }
}

pub fn world_with_release(infra_release: OperationalInfraRelease) -> OperationalWorld {
    let mut world = OperationalWorld::new("world:1", "region:a", 0, infra_release).unwrap();
    world
        .register_vehicle_type(vehicle_type("type:short", 10_000), true)
        .unwrap();
    world
        .register_vehicle_type(vehicle_type("type:long", 20_000), true)
        .unwrap();
    world
        .register_vehicle(vehicle("vehicle:1", "type:short"))
        .unwrap();
    world
        .register_vehicle(vehicle("vehicle:2", "type:short"))
        .unwrap();
    world
        .register_vehicle(vehicle("vehicle:3", "type:long"))
        .unwrap();
    world
        .create_formation("formation:1", None, vec!["vehicle:1".to_owned()])
        .unwrap();
    world
        .create_formation("formation:2", None, vec!["vehicle:2".to_owned()])
        .unwrap();
    world
        .create_formation("formation:3", None, vec!["vehicle:3".to_owned()])
        .unwrap();
    world
}
pub fn dispatch_request(
    train_id: &str,
    interlocking_route_id: &str,
    waiting_since_ms: i64,
) -> DispatchRequest {
    DispatchRequest {
        train_id: train_id.to_owned(),
        interlocking_route_id: interlocking_route_id.to_owned(),
        committed_rank: 0,
        timetable_deviation_ms: 0,
        passenger_impact: 0,
        contractual_impact: 0,
        network_impact: 0,
        resource_consequence: 0,
        recovery_rank: 0,
        waiting_since_ms,
    }
}
pub fn advance_stop_train_until_standing(world: &mut OperationalWorld) {
    for _ in 0..300 {
        let Some(segment) = world.trains["train:stops"].motion_segment.clone() else {
            return;
        };
        world.advance_to(segment.valid_until_ms).unwrap();
        world.verify_invariants().unwrap();
    }
    panic!("bounded stop fixture did not reach its next stop");
}
