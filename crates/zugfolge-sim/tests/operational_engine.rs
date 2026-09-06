//! Abnahmetests fuer die eine autoritative Betriebswirklichkeit.

use std::collections::{BTreeMap, BTreeSet};

use zugfolge_sim::operational::{
    AutomaticShuntingNeed, Direction, DispatchRequest, EdgeGeometryPoint,
    FormationDynamicsDerivationError, FormationDynamicsDerivationInput, FormationVersion,
    InterlockingRouteTemplate, MotionState, MovementContinuation, MovementContinuity, MovementKind,
    OPERATIONAL_PROJECTION_VALIDITY_MS, OperationalControlStands, OperationalDisruption,
    OperationalError, OperationalInfraRelease, OperationalPowerSystem, OperationalVehicleRole,
    OperationalVehicleTraction, OperationalWorld, PROTECTION_MODE_SELECTION_POLICY_V1,
    PhysicalVehicle, ProjectedMotionState, ProjectionKind, ProtectionModeSelectionRun,
    ResourceLifecycle, RouteLeg, RouteVersion, ShuntingPurpose, SignalAspect, TrackInterval,
    TrainMaterialization, VehicleCondition, VehicleRestriction, VehicleType,
    VehicleTypeRawFormationDynamics, derive_formation_dynamics,
    operational_train_number_numeric_part,
};

fn passenger_stop_fixture() -> (OperationalInfraRelease, TrainMaterialization) {
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

fn stop_receipts(
    world: &OperationalWorld,
) -> Vec<zugfolge_sim::operational::OperationalPassengerStopReceipt> {
    world
        .events
        .iter()
        .filter(|event| event.kind.starts_with("passenger-stop-"))
        .map(|event| {
            let receipt: zugfolge_sim::operational::OperationalPassengerStopReceipt =
                serde_json::from_str(&event.detail).unwrap();
            assert_eq!(receipt.actual_time_ms, event.at_ms);
            assert_eq!(receipt.train_run_id, event.subject_id);
            receipt
        })
        .collect()
}

fn advance_stop_train_until_standing(world: &mut OperationalWorld) {
    for _ in 0..300 {
        let Some(segment) = world.trains["train:stops"].motion_segment.clone() else {
            return;
        };
        world.advance_to(segment.valid_until_ms).unwrap();
        world.verify_invariants().unwrap();
    }
    panic!("bounded stop fixture did not reach its next stop");
}

#[test]
fn native_passenger_stops_three_halts_signal_dwell_and_restore() {
    let (infra, input) = passenger_stop_fixture();
    let mut world = world_with_release(infra);
    world.materialize(input).unwrap();
    assert_eq!(stop_receipts(&world).len(), 1);
    assert_eq!(stop_receipts(&world)[0].actual_time_ms, 0);
    world
        .lock_route("train:stops", "interlocking:train")
        .unwrap();
    let before = world.state_hash();
    assert_eq!(
        world.plan_motion("train:stops"),
        Err(OperationalError::PassengerDepartureTooEarly)
    );
    assert_eq!(world.state_hash(), before);
    world.advance_to(999).unwrap();
    assert_eq!(stop_receipts(&world).len(), 1);
    world.advance_to(1_000).unwrap();
    assert_eq!(stop_receipts(&world)[1].kind, "departure");
    assert_eq!(stop_receipts(&world)[1].actual_time_ms, 1_000);
    let mut mid_motion = OperationalWorld::restore(&world.checkpoint()).unwrap();
    advance_stop_train_until_standing(&mut world);
    advance_stop_train_until_standing(&mut mid_motion);
    assert_eq!(world.state_hash(), mid_motion.state_hash());
    assert_eq!(world.trains["train:stops"].head_route_mm, 30_000);
    // A genuine signal stop between A and B produces no passenger arrival.
    assert_eq!(stop_receipts(&world).len(), 2);
    world.advance_to(world.now_ms + 17_000).unwrap();
    assert_eq!(stop_receipts(&world).len(), 2);
    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:stops",
            "interlocking:train:b",
            world.now_ms,
        )])
        .unwrap();
    advance_stop_train_until_standing(&mut world);
    assert_eq!(world.trains["train:stops"].head_route_mm, 40_000);
    let arrival_b = world.now_ms;
    assert!(arrival_b > 15_000);
    assert_eq!(stop_receipts(&world).len(), 3);
    assert!(world.trains["train:stops"].authority.is_some());
    let mut restored = OperationalWorld::restore(&world.checkpoint()).unwrap();
    let tail_from = world.event_sequence;
    world.advance_to(arrival_b + 4_999).unwrap();
    assert_eq!(world.trains["train:stops"].speed_mmps, 0);
    assert_eq!(stop_receipts(&world).len(), 3);
    world.advance_to(arrival_b + 5_000).unwrap();
    assert_eq!(stop_receipts(&world)[3].actual_time_ms, arrival_b + 5_000);
    advance_stop_train_until_standing(&mut world);
    restored.advance_to(world.now_ms).unwrap();
    assert_eq!(world.state_hash(), restored.state_hash());
    assert_eq!(
        world
            .events
            .iter()
            .filter(|event| event.event_sequence > tail_from)
            .cloned()
            .collect::<Vec<_>>(),
        restored.events
    );
    let receipts = stop_receipts(&world);
    assert_eq!(
        receipts
            .iter()
            .map(|r| (r.stop_sequence, r.kind.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (0, "arrival"),
            (0, "departure"),
            (1, "arrival"),
            (1, "departure"),
            (2, "arrival")
        ]
    );
    assert_eq!(
        receipts
            .iter()
            .map(|r| &r.receipt_id)
            .collect::<BTreeSet<_>>()
            .len(),
        5
    );
    assert_eq!(world.trains["train:stops"].head_route_mm, 120_000);
    world.advance_to(world.now_ms + 60_000).unwrap();
    assert_eq!(stop_receipts(&world), receipts);
    world.verify_invariants().unwrap();
}

#[test]
fn native_passenger_stop_plan_rejects_false_geometry_world_and_tampered_progress() {
    let (infra, input) = passenger_stop_fixture();
    for variant in 0..11 {
        let mut broken = input.clone();
        let plan = broken.stop_plan.as_mut().unwrap();
        match variant {
            0 => plan.world_id = "world:other".to_owned(),
            1 => plan.stops[1].platform_id = "unknown".to_owned(),
            2 => plan.stops[1].route_mm = 49_000,
            3 => plan.stops[1].stop_id = plan.stops[0].stop_id.clone(),
            4 => plan.stops[1].stop_sequence = 0,
            5 => plan.route_version_id = "route:v2".to_owned(),
            6 => plan.stops[1].minimum_dwell_ms = 6_000,
            7 => plan.stops[2].scheduled_departure_ms = 9_007_199_254_740_992,
            8 => plan.stops[2].route_mm = 9_007_199_254_740_992,
            9 => plan.stops[2].scheduled_arrival_ms = 9_007_199_254_740_992,
            _ => plan.stops[2].minimum_dwell_ms = 9_007_199_254_740_992,
        }
        let mut world = world_with_release(infra.clone());
        let before = world.state_hash();
        assert_eq!(
            world.materialize(broken),
            Err(OperationalError::InvalidPassengerStopPlan)
        );
        assert_eq!(world.state_hash(), before);
    }
    let mut world = world_with_release(infra);
    world.materialize(input).unwrap();
    let mut serialized = serde_json::to_value(&world).unwrap();
    serialized["trains"]["train:stops"]["passengerStops"]["receipts"][0]["actualDepartureMs"] =
        0.into();
    let changed: OperationalWorld = serde_json::from_value(serialized).unwrap();
    assert_eq!(
        changed.verify_invariants(),
        Err(OperationalError::InvalidPassengerStopPlan)
    );
    let before = world.state_hash();
    assert_eq!(
        world.change_formation(
            "train:stops",
            "formation:too-long",
            vec!["vehicle:3".to_owned()]
        ),
        Err(OperationalError::InvalidPassengerStopPlan)
    );
    assert_eq!(world.state_hash(), before);
    assert_eq!(
        world.advance_to(9_007_199_254_740_992),
        Err(OperationalError::InvalidPassengerStopPlan)
    );
    assert_eq!(world.state_hash(), before);
    assert_eq!(
        world.reroute_train("train:stops", "route:v2"),
        Err(OperationalError::InvalidPassengerStopPlan)
    );
    assert_eq!(world.state_hash(), before);
}

#[test]
fn native_passenger_stop_handover_transfers_dwell_and_exactly_once_receipts() {
    let (infra, input) = passenger_stop_fixture();
    let mut source = world_with_release(infra.clone());
    let mut target = OperationalWorld::new("world:1", "region:b", 0, infra).unwrap();
    source.materialize(input).unwrap();
    source
        .lock_route("train:stops", "interlocking:train")
        .unwrap();
    let first_receipt = stop_receipts(&source)[0].clone();
    let mut handover = source
        .begin_handover(
            "halt:handover",
            "train:stops",
            "region:b",
            set(&["boundary:west"]),
        )
        .unwrap();
    target.accept_handover(&mut handover).unwrap();
    source.finish_handover(&handover).unwrap();
    target.accept_handover(&mut handover).unwrap();
    source.advance_to(1_000).unwrap();
    target.advance_to(1_000).unwrap();
    let target_receipts = stop_receipts(&target);
    assert_eq!(target_receipts.len(), 1);
    assert_eq!(target_receipts[0].kind, "departure");
    assert_eq!(target_receipts[0].actual_time_ms, 1_000);
    assert_eq!(
        target_receipts[0].stop_plan_hash,
        first_receipt.stop_plan_hash
    );
    assert_eq!(stop_receipts(&source), vec![first_receipt]);
    target.verify_invariants().unwrap();
    source.verify_invariants().unwrap();
}

#[test]
fn native_passenger_formation_change_checks_current_and_future_platforms_only() {
    let (mut infra, input) = passenger_stop_fixture();
    infra
        .platform_intervals
        .get_mut("platform:b")
        .unwrap()
        .from_mm = 15_000;
    let mut world = world_with_release(infra);
    world.materialize(input).unwrap();
    world
        .lock_route("train:stops", "interlocking:train")
        .unwrap();
    world.advance_to(1_000).unwrap();
    advance_stop_train_until_standing(&mut world);
    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:stops",
            "interlocking:train:b",
            world.now_ms,
        )])
        .unwrap();
    advance_stop_train_until_standing(&mut world);
    assert_eq!(world.trains["train:stops"].head_route_mm, 40_000);
    let existing = stop_receipts(&world);
    // The longer formation fits B and C; it never occupied the shorter origin A.
    world
        .change_formation(
            "train:stops",
            "formation:long-at-b",
            vec!["vehicle:3".to_owned()],
        )
        .unwrap();
    assert_eq!(stop_receipts(&world), existing);
    world.verify_invariants().unwrap();
    let mut restored = OperationalWorld::restore(&world.checkpoint()).unwrap();
    world.advance_to(100_000).unwrap();
    restored.advance_to(100_000).unwrap();
    assert_eq!(world.state_hash(), restored.state_hash());
    assert_eq!(
        stop_receipts(&world).last().unwrap().formation_version_id,
        "formation:long-at-b"
    );
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

fn vehicle_type(id: &str, length_mm: u32) -> VehicleType {
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

fn vehicle(id: &str, type_id: &str) -> PhysicalVehicle {
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

fn explicit_vehicle_type(
    id: &str,
    role: OperationalVehicleRole,
    control_stands: OperationalControlStands,
) -> VehicleType {
    let mut kind = vehicle_type(id, 10_000);
    kind.role = Some(role);
    kind.control_stands = Some(control_stands);
    let powered = matches!(
        role,
        OperationalVehicleRole::PoweredUnit | OperationalVehicleRole::Locomotive
    );
    kind.traction = Some(if powered {
        OperationalVehicleTraction::Electric
    } else {
        OperationalVehicleTraction::Unpowered
    });
    kind.electric_systems = Some(if powered {
        vec![OperationalPowerSystem::Ac15kv]
    } else {
        Vec::new()
    });
    kind.raw_formation_dynamics = Some(VehicleTypeRawFormationDynamics {
        brake_weight_kg: kind.mass_kg,
        maximum_acceleration_cap_mmps2: if powered { 1_000 } else { 0 },
        service_brake_cap_mmps2: 1_000,
        emergency_brake_multiplier_basis_points: 15_000,
    });
    if matches!(
        role,
        OperationalVehicleRole::Coach | OperationalVehicleRole::ControlCar
    ) {
        kind.power_watts = 0;
        kind.starting_tractive_force_newtons = 0;
        kind.maximum_acceleration_mmps2 = 0;
    }
    kind
}

fn bind_raw_reference(
    kind: &mut VehicleType,
    brake_weight_kg: u64,
    maximum_acceleration_cap_mmps2: u32,
    service_brake_cap_mmps2: u32,
    emergency_brake_multiplier_basis_points: u16,
) {
    let derived = derive_formation_dynamics(FormationDynamicsDerivationInput {
        total_mass_kg: kind.mass_kg,
        effective_starting_tractive_force_newtons: u64::from(kind.starting_tractive_force_newtons),
        total_brake_weight_kg: brake_weight_kg,
        maximum_acceleration_cap_mmps2,
        service_brake_cap_mmps2,
        emergency_brake_multiplier_basis_points,
    })
    .expect("Test-Rohwerte sind ableitbar");
    kind.raw_formation_dynamics = Some(VehicleTypeRawFormationDynamics {
        brake_weight_kg,
        maximum_acceleration_cap_mmps2,
        service_brake_cap_mmps2,
        emergency_brake_multiplier_basis_points,
    });
    kind.maximum_acceleration_mmps2 = derived.acceleration_mmps2;
    kind.service_brake_mmps2 = derived.service_brake_mmps2;
    kind.emergency_brake_mmps2 = derived.emergency_brake_mmps2;
}

fn explicit_vehicle(
    id: &str,
    type_id: &str,
    powered: bool,
    orientation: Direction,
) -> PhysicalVehicle {
    let mut asset = vehicle(id, type_id);
    asset.powered = powered;
    asset.orientation = orientation;
    asset
}

fn world_with_release(infra_release: OperationalInfraRelease) -> OperationalWorld {
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

fn world() -> OperationalWorld {
    world_with_release(release())
}

fn speed_profile_release(first_limit: u32, second_limit: u32) -> OperationalInfraRelease {
    let mut infra = release();
    for route in infra.route_versions.values_mut() {
        route.legs[0].speed_limit_mmps = first_limit;
        route.legs[1].speed_limit_mmps = second_limit;
        route.legs[1].edge_entry_mm = 600_000;
        for leg in &mut route.legs {
            leg.gradient_per_mille = 0;
        }
    }
    infra.directed_edges.insert("edge:b".into(), 600_000);
    infra.edge_geometries.get_mut("edge:b").unwrap()[1].edge_offset_mm = 600_000;
    let lock = infra
        .interlocking_routes
        .get_mut("interlocking:train:b")
        .unwrap();
    lock.authority_end_route_mm = 660_000;
    lock.release_after_tail_route_mm = 660_000;
    infra
}

fn dispatched_profile_world(infra: OperationalInfraRelease) -> OperationalWorld {
    let mut world = world_with_release(infra);
    world
        .materialize_train(
            "t",
            "RB 1",
            "o",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    world
        .submit_dispatch_requests(&[DispatchRequest {
            train_id: "t".into(),
            interlocking_route_id: "interlocking:train".into(),
            committed_rank: 0,
            timetable_deviation_ms: 0,
            passenger_impact: 0,
            contractual_impact: 0,
            network_impact: 0,
            resource_consequence: 0,
            recovery_rank: 0,
            waiting_since_ms: 0,
        }])
        .unwrap();
    world
}

#[test]
fn newly_activated_lower_limit_on_an_upcoming_authorized_edge_stops_existing_motion() {
    let mut world = dispatched_profile_world(speed_profile_release(20_000, 20_000));
    world.advance_to(1_000).unwrap();
    assert!(world.trains["t"].motion_segment.is_some());
    assert!(
        world.trains["t"]
            .occupied_intervals
            .iter()
            .all(|interval| interval.edge_id != "edge:b")
    );
    let locks = world.route_locks.clone();
    world
        .activate_disruption(
            "new-la",
            OperationalDisruption::SpeedRestriction {
                edge_id: "edge:b".into(),
                maximum_speed_mmps: 1_000,
            },
        )
        .unwrap();
    assert!(world.trains["t"].motion_segment.is_none());
    assert!(matches!(
        world.trains["t"].motion_state,
        MotionState::SafeStop { .. }
    ));
    assert_eq!(world.route_locks, locks);
    world.verify_invariants().unwrap();
}

#[test]
fn lower_vmax_is_reached_before_the_edge_in_both_directions() {
    for reverse in [false, true] {
        let mut infra = speed_profile_release(20_000, 1_000);
        if reverse {
            for route in infra.route_versions.values_mut() {
                for leg in &mut route.legs {
                    std::mem::swap(&mut leg.edge_entry_mm, &mut leg.edge_exit_mm);
                    leg.direction = match leg.direction {
                        Direction::Along => Direction::Against,
                        Direction::Against => Direction::Along,
                    };
                }
            }
        }
        let mut world = dispatched_profile_world(infra);
        let mut replay = OperationalWorld::restore(&world.checkpoint()).unwrap();
        let mut crossed = false;
        for at in (0..=120_000).step_by(10) {
            world.advance_to(at).unwrap();
            let train = &world.trains["t"];
            if let Some(segment) = &train.motion_segment {
                let head = segment.position_at(at).unwrap();
                if head >= 60_000 {
                    crossed = true;
                    assert!(
                        segment.speed_at(at).unwrap() <= 1_000,
                        "head={head}; segment={segment:?}"
                    );
                }
            }
        }
        assert!(crossed);
        replay.advance_to(120_000).unwrap();
        assert_eq!(world.state_hash(), replay.state_hash());
        world.verify_invariants().unwrap();
    }
}

#[test]
fn higher_vmax_waits_for_the_tail_and_existing_overspeed_brakes() {
    let mut world = dispatched_profile_world(speed_profile_release(1_000, 20_000));
    let mut accelerated = false;
    for at in (0..=120_000).step_by(10) {
        world.advance_to(at).unwrap();
        if let Some(segment) = &world.trains["t"].motion_segment {
            let head = segment.position_at(at).unwrap();
            let speed = segment.speed_at(at).unwrap();
            if head < 70_000 {
                assert!(speed <= 1_000, "higher limit before tail: {segment:?}");
            }
            if head > 70_000 && speed > 1_000 {
                accelerated = true;
            }
        }
    }
    assert!(accelerated);
    let mut overspeed = dispatched_profile_world(speed_profile_release(1_000, 20_000));
    overspeed.trains.get_mut("t").unwrap().speed_mmps = 5_000;
    assert!(overspeed.plan_motion("t").unwrap().acceleration_mmps2 < 0);
}

#[test]
fn gradient_changes_dynamics_with_direction_and_rejects_impossible_profiles() {
    fn segment(gradient: i16, reverse: bool) -> zugfolge_sim::operational::MotionSegment {
        let mut infra = release();
        for route in infra.route_versions.values_mut() {
            for leg in &mut route.legs {
                leg.gradient_per_mille = gradient;
            }
            if reverse {
                let leg = &mut route.legs[0];
                std::mem::swap(&mut leg.edge_entry_mm, &mut leg.edge_exit_mm);
                leg.direction = Direction::Against;
            }
        }
        let mut world = world_with_release(infra);
        world
            .materialize_train(
                "t",
                "RB 1",
                "o",
                MovementKind::Train,
                "route:v1",
                "formation:1",
                0,
                None,
                false,
            )
            .unwrap();
        world.lock_route("t", "interlocking:train").unwrap();
        world.plan_motion("t").unwrap()
    }
    let uphill = segment(40, false);
    let level = segment(0, false);
    let downhill = segment(-40, false);
    assert!(uphill.acceleration_mmps2 < level.acceleration_mmps2);
    assert!(level.acceleration_mmps2 < downhill.acceleration_mmps2);
    assert_eq!(
        uphill.acceleration_mmps2,
        segment(-40, true).acceleration_mmps2
    );
    assert_ne!(uphill.valid_until_ms, downhill.valid_until_ms);
    let mut invalid = release();
    invalid.route_versions.get_mut("route:v1").unwrap().legs[0].gradient_per_mille = 101;
    assert!(OperationalWorld::new("w", "r", 0, invalid).is_err());
}

#[test]
fn shunting_has_its_own_limit_in_the_actual_motion_projection() {
    for gradient in [0, 40, -40] {
        let mut infra = speed_profile_release(20_000, 20_000);
        for route in infra.route_versions.values_mut() {
            for leg in &mut route.legs {
                leg.gradient_per_mille = if leg.direction == Direction::Along {
                    gradient
                } else {
                    -gradient
                };
            }
        }
        infra
            .interlocking_routes
            .get_mut("interlocking:shunting")
            .unwrap()
            .authority_end_route_mm = 660_000;
        infra
            .interlocking_routes
            .get_mut("interlocking:shunting")
            .unwrap()
            .release_after_tail_route_mm = 660_000;
        let mut world = world_with_release(infra);
        world
            .materialize_train(
                "t",
                "RB 1",
                "o",
                MovementKind::Shunting,
                "route:v1",
                "formation:1",
                10_000,
                None,
                false,
            )
            .unwrap();
        world.lock_route("t", "interlocking:shunting").unwrap();
        world.plan_motion("t").unwrap();
        let mut reached_limit = false;
        for at in (0..=50_000).step_by(10) {
            world.advance_to(at).unwrap();
            if let Some(segment) = &world.trains["t"].motion_segment {
                let speed = segment.speed_at(at).unwrap();
                assert!(
                    speed <= zugfolge_sim::operational::SHUNTING_MAXIMUM_SPEED_MMPS,
                    "{segment:?}"
                );
                reached_limit |= speed == zugfolge_sim::operational::SHUNTING_MAXIMUM_SPEED_MMPS;
            }
        }
        assert!(reached_limit);
        world.verify_invariants().unwrap();
    }
}

#[test]
fn moving_handover_transfers_events_locks_vehicles_and_survives_retries_and_restore() {
    let mut source = dispatched_profile_world(speed_profile_release(20_000, 20_000));
    let mut target = OperationalWorld::new(
        "world:1",
        "region:b",
        0,
        speed_profile_release(20_000, 20_000),
    )
    .unwrap();
    let mut handover = source
        .begin_handover("h", "t", "region:b", set(&["boundary:west"]))
        .unwrap();
    source = OperationalWorld::restore(&source.checkpoint()).unwrap();
    let before = source.state_hash();
    assert!(source.advance_to(1).is_err());
    assert!(source.safe_stop("t", "during-handover").is_err());
    assert!(
        source
            .activate_disruption(
                "during-handover",
                OperationalDisruption::SpeedRestriction {
                    edge_id: "edge:a".into(),
                    maximum_speed_mmps: 1_000
                }
            )
            .is_err()
    );
    assert_eq!(before, source.state_hash());
    target.accept_handover(&mut handover).unwrap();
    let accepted = target.state_hash();
    target.accept_handover(&mut handover).unwrap();
    assert_eq!(accepted, target.state_hash());
    target = OperationalWorld::restore(&target.checkpoint()).unwrap();
    source.finish_handover(&handover).unwrap();
    let finished = source.state_hash();
    source.finish_handover(&handover).unwrap();
    assert_eq!(finished, source.state_hash());
    assert!(!source.vehicles.contains_key("vehicle:1"));
    assert!(source.route_locks.is_empty());
    assert!(target.vehicles.contains_key("vehicle:1"));
    target.advance_to(60_000).unwrap();
    assert!(target.trains["t"].head_route_mm > 0);
    assert!(target.trains["t"].occupied_blocks.contains("boundary:west"));
    source.verify_invariants().unwrap();
    target.verify_invariants().unwrap();
    OperationalWorld::restore(&source.checkpoint()).unwrap();
    OperationalWorld::restore(&target.checkpoint()).unwrap();
}

#[test]
fn handover_rejects_foreign_world_release_time_route_and_inventory_atomically() {
    let mut source = dispatched_profile_world(speed_profile_release(20_000, 20_000));
    let original = source
        .begin_handover("h", "t", "region:b", set(&["boundary:west"]))
        .unwrap();
    for case in 0..6 {
        let mut infra = speed_profile_release(20_000, 20_000);
        if case == 1 {
            infra.id = "foreign-release".into();
        }
        if case == 3 {
            infra.route_versions.get_mut("route:v1").unwrap().legs[0].speed_limit_mmps = 10_000;
        }
        let mut target = OperationalWorld::new(
            if case == 0 {
                "foreign-world"
            } else {
                "world:1"
            },
            "region:b",
            if case == 2 { 1 } else { 0 },
            infra,
        )
        .unwrap();
        if case == 4 {
            target
                .register_vehicle_type(vehicle_type("type:short", 10_000), true)
                .unwrap();
            target
                .register_vehicle(vehicle("vehicle:1", "type:short"))
                .unwrap();
        }
        let mut handover = original.clone();
        if case == 5 {
            handover.source_event_sequence += 1;
        }
        let before = target.state_hash();
        assert!(
            target.accept_handover(&mut handover).is_err(),
            "case={case}"
        );
        assert_eq!(before, target.state_hash());
        assert!(!handover.acknowledged);
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

fn dispatch_request(
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

fn release_with_route_protection(systems: &[&str]) -> OperationalInfraRelease {
    let mut infra_release = release();
    for leg in &mut infra_release
        .route_versions
        .get_mut("route:v1")
        .expect("Test-Route")
        .legs
    {
        leg.available_protection_systems =
            systems.iter().map(|system| (*system).to_owned()).collect();
        leg.available_protection_systems.sort();
        leg.simultaneously_required_protection_systems.clear();
    }
    infra_release
}

fn release_with_independent_opposing_route() -> OperationalInfraRelease {
    let mut infra_release = release();
    infra_release
        .directed_edges
        .insert("edge:c".to_owned(), 120_000);
    infra_release.edge_geometries.insert(
        "edge:c".to_owned(),
        vec![
            EdgeGeometryPoint {
                edge_offset_mm: 0,
                latitude_e7: 511_000_000,
                longitude_e7: 121_000_000,
                bearing_milli_degrees: Some(90_000),
            },
            EdgeGeometryPoint {
                edge_offset_mm: 120_000,
                latitude_e7: 511_000_000,
                longitude_e7: 121_120_000,
                bearing_milli_degrees: None,
            },
        ],
    );
    infra_release.block_resources.insert("block:c".to_owned());
    infra_release.route_versions.insert(
        "route:opposing".to_owned(),
        RouteVersion {
            id: "route:opposing".to_owned(),
            template_id: "route-template:opposing".to_owned(),
            predecessor_id: None,
            transition_route_mm: None,
            legs: vec![RouteLeg {
                edge_id: "edge:c".to_owned(),
                direction: Direction::Along,
                edge_entry_mm: 0,
                edge_exit_mm: 120_000,
                route_start_mm: 0,
                block_ids: set(&["block:c"]),
                speed_limit_mmps: 20_000,
                gradient_per_mille: 0,
                available_protection_systems: vec!["pzb".to_owned()],
                simultaneously_required_protection_systems: Vec::new(),
            }],
        },
    );
    let opposing = InterlockingRouteTemplate {
        id: "interlocking:opposing".to_owned(),
        route_template_id: "route-template:opposing".to_owned(),
        authority_start_route_mm: 0,
        signal_id: "signal:opposing".to_owned(),
        movement_kind: MovementKind::Train,
        path_resources: set(&["block:c"]),
        overlap_resources: set(&["overlap:2"]),
        flank_resources: set(&["flank:2", "route-resource:common"]),
        switch_positions: BTreeMap::from([("switch:1".to_owned(), "right".to_owned())]),
        authority_end_route_mm: 120_000,
        release_after_tail_route_mm: 90_000,
    };
    infra_release
        .interlocking_routes
        .insert(opposing.id.clone(), opposing);
    infra_release
}

fn release_with_three_train_segments() -> OperationalInfraRelease {
    let mut infra_release = release();
    infra_release
        .directed_edges
        .insert("edge:c".to_owned(), 30_000);
    infra_release.edge_geometries.insert(
        "edge:c".to_owned(),
        vec![
            EdgeGeometryPoint {
                edge_offset_mm: 0,
                latitude_e7: 510_060_000,
                longitude_e7: 120_060_000,
                bearing_milli_degrees: Some(90_000),
            },
            EdgeGeometryPoint {
                edge_offset_mm: 30_000,
                latitude_e7: 510_060_000,
                longitude_e7: 120_090_000,
                bearing_milli_degrees: None,
            },
        ],
    );
    infra_release
        .block_resources
        .extend(set(&["block:c", "overlap:train:c", "flank:train:c"]));
    infra_release.signals.insert("signal:train:c".to_owned());

    let route = infra_release
        .route_versions
        .get_mut("route:v1")
        .expect("Test-Laufweg");
    route.legs[1].edge_exit_mm = 30_000;
    route.legs.push(RouteLeg {
        edge_id: "edge:c".to_owned(),
        direction: Direction::Along,
        edge_entry_mm: 0,
        edge_exit_mm: 30_000,
        route_start_mm: 90_000,
        block_ids: set(&["block:c"]),
        speed_limit_mmps: 20_000,
        gradient_per_mille: 0,
        available_protection_systems: vec!["pzb".to_owned()],
        simultaneously_required_protection_systems: Vec::new(),
    });
    let legs = route.legs.clone();
    infra_release
        .route_versions
        .get_mut("route:v2")
        .expect("Test-Umleitung")
        .legs = legs;

    let middle = infra_release
        .interlocking_routes
        .get_mut("interlocking:train:b")
        .expect("mittlere Test-Fahrstrasse");
    middle.authority_end_route_mm = 90_000;
    middle.release_after_tail_route_mm = 80_000;
    let final_segment = InterlockingRouteTemplate {
        id: "interlocking:train:c".to_owned(),
        route_template_id: "route-template".to_owned(),
        authority_start_route_mm: 90_000,
        signal_id: "signal:train:c".to_owned(),
        movement_kind: MovementKind::Train,
        path_resources: set(&["block:c"]),
        overlap_resources: set(&["overlap:train:c"]),
        flank_resources: set(&["flank:train:c"]),
        switch_positions: BTreeMap::from([("switch:1".to_owned(), "left".to_owned())]),
        authority_end_route_mm: 120_000,
        release_after_tail_route_mm: 120_000,
    };
    infra_release
        .interlocking_routes
        .insert(final_segment.id.clone(), final_segment);
    infra_release
}

fn continuation_release(reverse_successor: bool) -> OperationalInfraRelease {
    let leg = |edge_id: &str,
               direction: Direction,
               edge_entry_mm: i64,
               edge_exit_mm: i64,
               route_start_mm: i64,
               block_id: &str| RouteLeg {
        edge_id: edge_id.to_owned(),
        direction,
        edge_entry_mm,
        edge_exit_mm,
        route_start_mm,
        block_ids: set(&[block_id]),
        speed_limit_mmps: 20_000,
        gradient_per_mille: 0,
        available_protection_systems: vec!["pzb".to_owned()],
        simultaneously_required_protection_systems: Vec::new(),
    };
    let successor_direction = if reverse_successor {
        Direction::Against
    } else {
        Direction::Along
    };
    let (successor_seed_entry, successor_seed_exit) = if reverse_successor {
        (20_000, 10_000)
    } else {
        (10_000, 20_000)
    };
    let successor_exit_entry = if reverse_successor { 30_000 } else { 0 };
    let successor_exit_exit = if reverse_successor { 0 } else { 30_000 };
    let (third_seed_entry, third_seed_exit) = if reverse_successor {
        (10_000, 0)
    } else {
        (20_000, 30_000)
    };
    let third_exit_entry = if reverse_successor { 20_000 } else { 0 };
    let third_exit_exit = if reverse_successor { 0 } else { 20_000 };

    let routes = BTreeMap::from([
        (
            "route:continuation:source".to_owned(),
            RouteVersion {
                id: "route:continuation:source".to_owned(),
                template_id: "template:continuation:source".to_owned(),
                predecessor_id: None,
                transition_route_mm: None,
                legs: vec![leg(
                    "edge:continuation:anchor",
                    Direction::Along,
                    0,
                    20_000,
                    0,
                    "block:continuation:source",
                )],
            },
        ),
        (
            "route:continuation:successor".to_owned(),
            RouteVersion {
                id: "route:continuation:successor".to_owned(),
                template_id: "template:continuation:successor".to_owned(),
                predecessor_id: Some("route:continuation:source".to_owned()),
                transition_route_mm: Some(10_000),
                legs: vec![
                    leg(
                        "edge:continuation:anchor",
                        successor_direction,
                        successor_seed_entry,
                        successor_seed_exit,
                        0,
                        "block:continuation:target",
                    ),
                    leg(
                        "edge:continuation:exit",
                        successor_direction,
                        successor_exit_entry,
                        successor_exit_exit,
                        10_000,
                        "block:continuation:exit",
                    ),
                ],
            },
        ),
        (
            "route:continuation:third".to_owned(),
            RouteVersion {
                id: "route:continuation:third".to_owned(),
                template_id: "template:continuation:third".to_owned(),
                predecessor_id: Some("route:continuation:successor".to_owned()),
                transition_route_mm: Some(10_000),
                legs: vec![
                    leg(
                        "edge:continuation:exit",
                        successor_direction,
                        third_seed_entry,
                        third_seed_exit,
                        0,
                        "block:continuation:third-seed",
                    ),
                    leg(
                        "edge:continuation:third",
                        successor_direction,
                        third_exit_entry,
                        third_exit_exit,
                        10_000,
                        "block:continuation:third-exit",
                    ),
                ],
            },
        ),
        (
            "route:continuation:blocker".to_owned(),
            RouteVersion {
                id: "route:continuation:blocker".to_owned(),
                template_id: "template:continuation:blocker".to_owned(),
                predecessor_id: None,
                transition_route_mm: None,
                legs: vec![
                    leg(
                        "edge:continuation:blocker",
                        Direction::Along,
                        0,
                        300_000,
                        0,
                        "block:continuation:target",
                    ),
                    leg(
                        "edge:continuation:blocker",
                        Direction::Along,
                        300_000,
                        400_000,
                        300_000,
                        "block:continuation:blocker-exit",
                    ),
                ],
            },
        ),
    ]);
    let interlocking = |id: &str,
                        route_template_id: &str,
                        authority_start_route_mm: i64,
                        authority_end_route_mm: i64,
                        path_resource: &str| InterlockingRouteTemplate {
        id: id.to_owned(),
        route_template_id: route_template_id.to_owned(),
        authority_start_route_mm,
        signal_id: format!("signal:{id}"),
        movement_kind: MovementKind::Train,
        path_resources: set(&[path_resource]),
        overlap_resources: set(&[&format!("overlap:{id}")]),
        flank_resources: set(&[&format!("flank:{id}")]),
        switch_positions: BTreeMap::new(),
        authority_end_route_mm,
        release_after_tail_route_mm: authority_end_route_mm,
    };
    let templates = [
        interlocking(
            "continuation:source",
            "template:continuation:source",
            0,
            20_000,
            "block:continuation:source",
        ),
        interlocking(
            "continuation:successor:seed",
            "template:continuation:successor",
            0,
            10_000,
            "block:continuation:target",
        ),
        interlocking(
            "continuation:successor:exit",
            "template:continuation:successor",
            10_000,
            40_000,
            "block:continuation:exit",
        ),
        interlocking(
            "continuation:third:seed",
            "template:continuation:third",
            0,
            10_000,
            "block:continuation:third-seed",
        ),
        interlocking(
            "continuation:third:exit",
            "template:continuation:third",
            10_000,
            30_000,
            "block:continuation:third-exit",
        ),
        interlocking(
            "continuation:blocker:entry",
            "template:continuation:blocker",
            0,
            300_000,
            "block:continuation:target",
        ),
        interlocking(
            "continuation:blocker:exit",
            "template:continuation:blocker",
            300_000,
            400_000,
            "block:continuation:blocker-exit",
        ),
    ];
    let mut signals = BTreeSet::new();
    let mut block_resources = BTreeSet::new();
    let mut interlocking_routes = BTreeMap::new();
    for template in templates {
        signals.insert(template.signal_id.clone());
        block_resources.extend(template.path_resources.iter().cloned());
        block_resources.extend(template.overlap_resources.iter().cloned());
        block_resources.extend(template.flank_resources.iter().cloned());
        interlocking_routes.insert(template.id.clone(), template);
    }
    OperationalInfraRelease {
        id: "infra:movement-continuation:v2".to_owned(),
        directed_edges: BTreeMap::from([
            ("edge:continuation:anchor".to_owned(), 20_000),
            ("edge:continuation:exit".to_owned(), 30_000),
            ("edge:continuation:third".to_owned(), 20_000),
            ("edge:continuation:blocker".to_owned(), 400_000),
        ]),
        edge_geometries: BTreeMap::from([
            (
                "edge:continuation:anchor".to_owned(),
                vec![
                    EdgeGeometryPoint {
                        edge_offset_mm: 0,
                        latitude_e7: 510_000_000,
                        longitude_e7: 120_000_000,
                        bearing_milli_degrees: Some(90_000),
                    },
                    EdgeGeometryPoint {
                        edge_offset_mm: 20_000,
                        latitude_e7: 510_000_000,
                        longitude_e7: 120_020_000,
                        bearing_milli_degrees: None,
                    },
                ],
            ),
            (
                "edge:continuation:exit".to_owned(),
                vec![
                    EdgeGeometryPoint {
                        edge_offset_mm: 0,
                        latitude_e7: 510_000_000,
                        longitude_e7: 120_020_000,
                        bearing_milli_degrees: Some(90_000),
                    },
                    EdgeGeometryPoint {
                        edge_offset_mm: 30_000,
                        latitude_e7: 510_000_000,
                        longitude_e7: 120_050_000,
                        bearing_milli_degrees: None,
                    },
                ],
            ),
            (
                "edge:continuation:third".to_owned(),
                vec![
                    EdgeGeometryPoint {
                        edge_offset_mm: 0,
                        latitude_e7: 510_000_000,
                        longitude_e7: 120_050_000,
                        bearing_milli_degrees: Some(90_000),
                    },
                    EdgeGeometryPoint {
                        edge_offset_mm: 20_000,
                        latitude_e7: 510_000_000,
                        longitude_e7: 120_070_000,
                        bearing_milli_degrees: None,
                    },
                ],
            ),
            (
                "edge:continuation:blocker".to_owned(),
                vec![
                    EdgeGeometryPoint {
                        edge_offset_mm: 0,
                        latitude_e7: 511_000_000,
                        longitude_e7: 121_000_000,
                        bearing_milli_degrees: Some(90_000),
                    },
                    EdgeGeometryPoint {
                        edge_offset_mm: 400_000,
                        latitude_e7: 511_000_000,
                        longitude_e7: 121_400_000,
                        bearing_milli_degrees: None,
                    },
                ],
            ),
        ]),
        route_versions: routes,
        interlocking_routes,
        signals,
        switches: BTreeSet::new(),
        block_resources,
        platform_intervals: BTreeMap::new(),
        region_boundaries: set(&["boundary:continuation"]),
        rzue_layout_id: "rzue:continuation:v1".to_owned(),
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "Testhelfer bildet den vollstaendigen signierten Fortsetzungsvertrag explizit ab"
)]
fn continuation(
    id: &str,
    predecessor_train_id: &str,
    successor_id: &str,
    successor_number: &str,
    route_version_id: &str,
    formation_version_id: &str,
    head_route_mm: i64,
    dispatch_interlocking_route_id: &str,
    not_before_ms: i64,
    minimum_dwell_ms: i64,
    continuity: MovementContinuity,
) -> MovementContinuation {
    let predecessor_base_route_version_id = match route_version_id {
        "route:continuation:third" => "route:continuation:successor",
        _ => "route:continuation:source",
    };
    MovementContinuation {
        id: id.to_owned(),
        predecessor_train_id: predecessor_train_id.to_owned(),
        predecessor_base_route_version_id: predecessor_base_route_version_id.to_owned(),
        successor: TrainMaterialization {
            stop_plan: None,
            service_outcome: None,
            id: successor_id.to_owned(),
            train_number: successor_number.to_owned(),
            operator_id: "operator:1".to_owned(),
            movement_kind: MovementKind::Train,
            route_version_id: route_version_id.to_owned(),
            formation_version_id: formation_version_id.to_owned(),
            head_route_mm,
            scheduled_departure_ms: None,
            public_passenger_stop: false,
        },
        successor_dispatch: dispatch_request(
            successor_id,
            dispatch_interlocking_route_id,
            not_before_ms,
        ),
        not_before_ms,
        minimum_dwell_ms,
        continuity,
    }
}

fn advance_until(world: &mut OperationalWorld, train_id: &str, present: bool) {
    for _ in 0..128 {
        if world.trains.contains_key(train_id) == present {
            return;
        }
        let next = world
            .trains
            .values()
            .filter_map(|train| train.motion_segment.as_ref())
            .map(|segment| segment.valid_until_ms)
            .min()
            .expect("mindestens eine Bewegung fuehrt zum erwarteten Zustand");
        world.advance_to(next).unwrap();
    }
    panic!("erwarteter Zugzustand wurde nicht erreicht");
}

#[test]
fn handover_boundary_protection_survives_another_region_and_movement_continuation_until_retirement()
{
    let mut release = continuation_release(false);
    release.region_boundaries.insert("boundary:second".into());
    let mut source = world_with_release(release.clone());
    source
        .materialize_train(
            "source",
            "RB 101",
            "operator:1",
            MovementKind::Train,
            "route:continuation:source",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    let mut target = OperationalWorld::new("world:1", "region:b", 0, release.clone()).unwrap();
    let mut first = source
        .begin_handover(
            "first",
            "source",
            "region:b",
            set(&["boundary:continuation"]),
        )
        .unwrap();
    target.accept_handover(&mut first).unwrap();
    source.finish_handover(&first).unwrap();
    let mut final_region = OperationalWorld::new("world:1", "region:c", 0, release).unwrap();
    let mut second = target
        .begin_handover("second", "source", "region:c", set(&["boundary:second"]))
        .unwrap();
    assert_eq!(
        second.protected_resources,
        set(&["boundary:continuation", "boundary:second"])
    );
    assert_eq!(
        target
            .begin_handover("second", "source", "region:c", set(&["boundary:second"]))
            .unwrap(),
        second
    );
    final_region.accept_handover(&mut second).unwrap();
    target.finish_handover(&second).unwrap();
    final_region
        .queue_movement_continuation(continuation(
            "continue",
            "source",
            "successor",
            "RB 102",
            "route:continuation:successor",
            "formation:1",
            10_000,
            "continuation:successor:exit",
            0,
            0,
            MovementContinuity::SameDirection,
        ))
        .unwrap();
    final_region
        .submit_dispatch_requests(&[dispatch_request("source", "continuation:source", 0)])
        .unwrap();
    advance_until(&mut final_region, "successor", true);
    assert!(
        second
            .protected_resources
            .is_subset(&final_region.trains["successor"].occupied_blocks)
    );
    let mut restored = OperationalWorld::restore(&final_region.checkpoint()).unwrap();
    let mut invalid = restored.clone();
    invalid
        .trains
        .get_mut("successor")
        .unwrap()
        .occupied_blocks
        .remove("boundary:continuation");
    assert_eq!(
        invalid.verify_invariants(),
        Err(OperationalError::InvalidHandover)
    );
    restored.advance_to(120_000).unwrap();
    assert!(
        second
            .protected_resources
            .is_subset(&restored.trains["successor"].occupied_blocks)
    );
    restored.retire_train("successor").unwrap();
    restored.verify_invariants().unwrap();
    assert!(
        second
            .protected_resources
            .iter()
            .all(|resource| !restored.resource_lifecycle.contains_key(resource))
    );
    OperationalWorld::restore(&restored.checkpoint()).unwrap();
}

#[test]
fn queued_chain_reuses_only_a_proven_ancestor_number_then_activates_atomically() {
    let mut world = world_with_release(continuation_release(false));
    world
        .materialize_train(
            "source",
            "RB 101",
            "operator:1",
            MovementKind::Train,
            "route:continuation:source",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    let first = continuation(
        "first",
        "source",
        "successor",
        "RB 102",
        "route:continuation:successor",
        "formation:1",
        10_000,
        "continuation:successor:exit",
        0,
        0,
        MovementContinuity::SameDirection,
    );
    let second = continuation(
        "second",
        "successor",
        "third",
        "RB 101",
        "route:continuation:third",
        "formation:1",
        10_000,
        "continuation:third:exit",
        0,
        0,
        MovementContinuity::SameDirection,
    );
    let before = world.state_hash();
    assert_eq!(
        world.queue_movement_continuation(second.clone()),
        Err(OperationalError::MovementContinuationTargetOccupied(
            "third".into()
        ))
    );
    assert_eq!(world.state_hash(), before);
    world.queue_movement_continuation(first).unwrap();
    world.queue_movement_continuation(second.clone()).unwrap();
    world.queue_movement_continuation(second).unwrap();
    let mut replay = OperationalWorld::restore(&world.checkpoint()).unwrap();
    for candidate in [&mut world, &mut replay] {
        candidate
            .submit_dispatch_requests(&[dispatch_request("source", "continuation:source", 0)])
            .unwrap();
        advance_until(candidate, "third", true);
        assert!(!candidate.trains.contains_key("source"));
        assert!(!candidate.trains.contains_key("successor"));
        assert_eq!(candidate.trains["third"].train_number, "RB 101");
        candidate.verify_invariants().unwrap();
    }
    assert_eq!(world.state_hash(), replay.state_hash());
}

#[test]
fn movement_continuation_is_atomic_physical_and_replay_deterministic() {
    let infra_release = continuation_release(false);
    let mut world = world_with_release(infra_release.clone());
    world
        .materialize_train(
            "train:continuation:source",
            "RB 101",
            "operator:1",
            MovementKind::Train,
            "route:continuation:source",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    let link = continuation(
        "continuation:source-successor",
        "train:continuation:source",
        "train:continuation:successor",
        "RB 102",
        "route:continuation:successor",
        "formation:1",
        10_000,
        "continuation:successor:exit",
        0,
        0,
        MovementContinuity::SameDirection,
    );
    world.queue_movement_continuation(link.clone()).unwrap();
    world.queue_movement_continuation(link).unwrap();

    let serialized = serde_json::to_value(&world).unwrap();
    let serialized_restore: OperationalWorld = serde_json::from_value(serialized).unwrap();
    assert_eq!(world.state_hash(), serialized_restore.state_hash());
    serialized_restore.verify_invariants().unwrap();
    let mut replay = OperationalWorld::restore(&world.checkpoint()).unwrap();

    for candidate in [&mut world, &mut replay] {
        candidate
            .submit_dispatch_requests(&[dispatch_request(
                "train:continuation:source",
                "continuation:source",
                0,
            )])
            .unwrap();
        advance_until(candidate, "train:continuation:successor", true);

        assert!(!candidate.trains.contains_key("train:continuation:source"));
        let successor = &candidate.trains["train:continuation:successor"];
        assert_eq!(successor.formation_version_id, "formation:1");
        assert_eq!(successor.route_version_id, "route:continuation:successor");
        assert_eq!(successor.head_route_mm, 10_000);
        assert_eq!(successor.tail_route_mm, 0);
        assert!(successor.motion_segment.is_some());
        assert!(candidate.events.iter().any(|event| {
            event.kind == "movement-continued" && event.subject_id == "train:continuation:successor"
        }));
        let persisted = serde_json::to_value(&*candidate).unwrap();
        assert_eq!(
            persisted["pendingMovementContinuations"],
            serde_json::json!({})
        );
        assert!(
            persisted["completedMovementContinuations"]
                .get("continuation:source-successor")
                .is_some()
        );
        candidate.verify_invariants().unwrap();
    }
    assert_eq!(world.state_hash(), replay.state_hash());
}

#[test]
fn movement_continuation_waits_for_real_completion_and_minimum_dwell() {
    let mut world = world_with_release(continuation_release(false));
    world
        .materialize_train(
            "train:continuation:source",
            "RB 111",
            "operator:1",
            MovementKind::Train,
            "route:continuation:source",
            "formation:1",
            0,
            Some(0),
            true,
        )
        .unwrap();
    let mut dwell_continuation = continuation(
        "continuation:dwell",
        "train:continuation:source",
        "train:continuation:successor",
        "RB 112",
        "route:continuation:successor",
        "formation:1",
        10_000,
        "continuation:successor:exit",
        0,
        300_000,
        MovementContinuity::SameDirection,
    );
    dwell_continuation.successor.scheduled_departure_ms = Some(0);
    dwell_continuation.successor.public_passenger_stop = false;
    let mut missing_passenger_dwell = dwell_continuation.clone();
    missing_passenger_dwell.minimum_dwell_ms = 0;
    assert_eq!(
        world.queue_movement_continuation(missing_passenger_dwell),
        Err(OperationalError::InvalidMovementContinuationTimes(
            "continuation:dwell".to_owned()
        ))
    );
    world
        .queue_movement_continuation(dwell_continuation)
        .unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:continuation:source",
            "continuation:source",
            0,
        )])
        .unwrap();
    while let Some(next_ms) = world.trains["train:continuation:source"]
        .motion_segment
        .as_ref()
        .map(|segment| segment.valid_until_ms)
    {
        world.advance_to(next_ms).unwrap();
    }
    let completed_at_ms = world.now_ms;
    let source = &world.trains["train:continuation:source"];
    assert_eq!(source.head_route_mm, 20_000);
    assert_eq!(source.speed_mmps, 0);
    assert!(source.authority.is_none());
    assert_eq!(source.motion_state, MotionState::Standing);

    world.advance_to(completed_at_ms + 299_999).unwrap();
    assert!(world.trains.contains_key("train:continuation:source"));
    assert!(!world.trains.contains_key("train:continuation:successor"));
    world.advance_to(completed_at_ms + 300_000).unwrap();
    assert!(!world.trains.contains_key("train:continuation:source"));
    assert!(world.trains.contains_key("train:continuation:successor"));
    world.verify_invariants().unwrap();
}

#[test]
fn reverse_movement_continuation_requires_both_control_stands() {
    let mut allowed = world_with_release(continuation_release(true));
    allowed
        .materialize_train(
            "train:continuation:source",
            "RB 121",
            "operator:1",
            MovementKind::Train,
            "route:continuation:source",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    allowed
        .queue_movement_continuation(continuation(
            "continuation:reverse",
            "train:continuation:source",
            "train:continuation:successor",
            "RB 122",
            "route:continuation:successor",
            "formation:1",
            10_000,
            "continuation:successor:exit",
            0,
            0,
            MovementContinuity::ReverseDirection,
        ))
        .unwrap();
    allowed
        .submit_dispatch_requests(&[dispatch_request(
            "train:continuation:source",
            "continuation:source",
            0,
        )])
        .unwrap();
    advance_until(&mut allowed, "train:continuation:successor", true);
    assert_eq!(
        allowed.trains["train:continuation:successor"].direction,
        Direction::Against
    );

    let mut denied = world_with_release(continuation_release(true));
    denied
        .formations
        .get_mut("formation:1")
        .unwrap()
        .performance
        .rear_control_stand_available = false;
    denied
        .materialize_train(
            "train:continuation:source",
            "RB 123",
            "operator:1",
            MovementKind::Train,
            "route:continuation:source",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    assert_eq!(
        denied.queue_movement_continuation(continuation(
            "continuation:reverse-denied",
            "train:continuation:source",
            "train:continuation:successor",
            "RB 124",
            "route:continuation:successor",
            "formation:1",
            10_000,
            "continuation:successor:exit",
            0,
            0,
            MovementContinuity::ReverseDirection,
        )),
        Err(OperationalError::ReversalWithoutControlStands(
            "continuation:reverse-denied".to_owned()
        ))
    );
}

#[test]
fn movement_continuation_graph_and_static_bindings_fail_closed() {
    let mut world = world_with_release(continuation_release(false));
    world
        .materialize_train(
            "train:continuation:source",
            "RB 131",
            "operator:1",
            MovementKind::Train,
            "route:continuation:source",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    let valid = continuation(
        "continuation:valid",
        "train:continuation:source",
        "train:continuation:successor",
        "RB 132",
        "route:continuation:successor",
        "formation:1",
        10_000,
        "continuation:successor:exit",
        0,
        0,
        MovementContinuity::SameDirection,
    );
    world.queue_movement_continuation(valid.clone()).unwrap();
    let mut conflicting = valid.clone();
    conflicting.minimum_dwell_ms = 1;
    assert_eq!(
        world.queue_movement_continuation(conflicting),
        Err(OperationalError::ConflictingMovementContinuationId(
            "continuation:valid".to_owned()
        ))
    );
    let mut duplicate_link = valid.clone();
    duplicate_link.id = "continuation:duplicate-link".to_owned();
    assert_eq!(
        world.queue_movement_continuation(duplicate_link),
        Err(OperationalError::DuplicateMovementContinuationLink(
            "continuation:duplicate-link".to_owned()
        ))
    );

    let mut mismatch_world = world_with_release(continuation_release(false));
    mismatch_world
        .materialize_train(
            "train:continuation:source",
            "RB 141",
            "operator:1",
            MovementKind::Train,
            "route:continuation:source",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    assert_eq!(
        mismatch_world.queue_movement_continuation(continuation(
            "continuation:formation-mismatch",
            "train:continuation:source",
            "train:continuation:successor",
            "RB 142",
            "route:continuation:successor",
            "formation:2",
            10_000,
            "continuation:successor:exit",
            0,
            0,
            MovementContinuity::SameDirection,
        )),
        Err(OperationalError::MovementContinuationFormationMismatch(
            "continuation:formation-mismatch".to_owned()
        ))
    );
    assert_eq!(
        mismatch_world.queue_movement_continuation(continuation(
            "continuation:discontinuous",
            "train:continuation:source",
            "train:continuation:third",
            "RB 143",
            "route:continuation:third",
            "formation:1",
            10_000,
            "continuation:third:exit",
            0,
            0,
            MovementContinuity::SameDirection,
        )),
        Err(OperationalError::DiscontinuousMovementContinuation(
            "continuation:discontinuous".to_owned()
        ))
    );
    assert_eq!(
        mismatch_world.queue_movement_continuation(continuation(
            "continuation:unknown-route",
            "train:continuation:source",
            "train:continuation:unknown",
            "RB 144",
            "route:continuation:unknown",
            "formation:1",
            10_000,
            "continuation:successor:exit",
            0,
            0,
            MovementContinuity::SameDirection,
        )),
        Err(OperationalError::UnknownRoute(
            "route:continuation:unknown".to_owned()
        ))
    );

    let mut occupied = world_with_release(continuation_release(false));
    occupied
        .materialize_train(
            "train:continuation:source",
            "RB 145",
            "operator:1",
            MovementKind::Train,
            "route:continuation:source",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    occupied
        .materialize_train(
            "train:continuation:successor",
            "G 146",
            "operator:2",
            MovementKind::Train,
            "route:continuation:blocker",
            "formation:2",
            0,
            None,
            false,
        )
        .unwrap();
    assert_eq!(
        occupied.queue_movement_continuation(continuation(
            "continuation:occupied-id",
            "train:continuation:source",
            "train:continuation:successor",
            "RB 147",
            "route:continuation:successor",
            "formation:1",
            10_000,
            "continuation:successor:exit",
            0,
            0,
            MovementContinuity::SameDirection,
        )),
        Err(OperationalError::MovementContinuationTargetOccupied(
            "train:continuation:successor".to_owned()
        ))
    );

    let mut chained = world_with_release(continuation_release(false));
    chained
        .queue_movement_continuation(continuation(
            "continuation:b-c",
            "train:continuation:successor",
            "train:continuation:third",
            "RB 152",
            "route:continuation:third",
            "formation:2",
            10_000,
            "continuation:third:exit",
            0,
            0,
            MovementContinuity::SameDirection,
        ))
        .unwrap();
    assert_eq!(
        chained.queue_movement_continuation(continuation(
            "continuation:a-b",
            "train:continuation:source",
            "train:continuation:successor",
            "RB 151",
            "route:continuation:successor",
            "formation:1",
            10_000,
            "continuation:successor:exit",
            0,
            0,
            MovementContinuity::SameDirection,
        )),
        Err(OperationalError::MovementContinuationFormationMismatch(
            "continuation:b-c".to_owned()
        ))
    );

    let mut cyclic = world_with_release(continuation_release(false));
    cyclic
        .queue_movement_continuation(continuation(
            "continuation:x-y",
            "train:x",
            "train:y",
            "RB 161",
            "route:continuation:successor",
            "formation:1",
            10_000,
            "continuation:successor:exit",
            0,
            0,
            MovementContinuity::SameDirection,
        ))
        .unwrap();
    assert_eq!(
        cyclic.queue_movement_continuation(continuation(
            "continuation:y-x",
            "train:y",
            "train:x",
            "RB 162",
            "route:continuation:source",
            "formation:1",
            0,
            "continuation:source",
            0,
            0,
            MovementContinuity::SameDirection,
        )),
        Err(OperationalError::CyclicMovementContinuation(
            "continuation:y-x".to_owned()
        ))
    );
}

#[test]
fn movement_continuation_accepts_only_a_physically_equivalent_qualified_predecessor() {
    let mut release = continuation_release(false);
    let mut qualified = release.route_versions["route:continuation:source"].clone();
    qualified.id = "route:continuation:source-qualified".to_owned();
    qualified.template_id = "template:continuation:source-qualified".to_owned();
    let mut first = qualified.legs[0].clone();
    first.edge_exit_mm = 10_000;
    let mut second = qualified.legs[0].clone();
    second.edge_entry_mm = 10_000;
    second.route_start_mm = 10_000;
    qualified.legs = vec![first, second];
    let mut qualified_first_interlocking =
        release.interlocking_routes["continuation:source"].clone();
    qualified_first_interlocking.id = "continuation:source-qualified:first".to_owned();
    qualified_first_interlocking.route_template_id = qualified.template_id.clone();
    qualified_first_interlocking.authority_end_route_mm = 10_000;
    qualified_first_interlocking.release_after_tail_route_mm = 10_000;
    let mut qualified_second_interlocking = qualified_first_interlocking.clone();
    qualified_second_interlocking.id = "continuation:source-qualified:second".to_owned();
    qualified_second_interlocking.authority_start_route_mm = 10_000;
    qualified_second_interlocking.authority_end_route_mm = 20_000;
    qualified_second_interlocking.release_after_tail_route_mm = 20_000;
    release.interlocking_routes.insert(
        qualified_first_interlocking.id.clone(),
        qualified_first_interlocking,
    );
    release.interlocking_routes.insert(
        qualified_second_interlocking.id.clone(),
        qualified_second_interlocking,
    );
    release
        .route_versions
        .insert(qualified.id.clone(), qualified.clone());
    let mut world = world_with_release(release);
    world
        .materialize_train(
            "train:continuation:qualified-source",
            "RB 149",
            "operator:1",
            MovementKind::Train,
            &qualified.id,
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    let link = continuation(
        "continuation:qualified-source-successor",
        "train:continuation:qualified-source",
        "train:continuation:qualified-successor",
        "RB 150",
        "route:continuation:successor",
        "formation:1",
        10_000,
        "continuation:successor:exit",
        0,
        0,
        MovementContinuity::SameDirection,
    );
    assert_eq!(
        link.predecessor_base_route_version_id,
        "route:continuation:source"
    );
    world.queue_movement_continuation(link).unwrap();
}

#[test]
fn movement_continuation_waits_resource_indexed_without_advance_loop() {
    let mut world = world_with_release(continuation_release(false));
    world
        .materialize_train(
            "train:continuation:blocker",
            "G 171",
            "operator:2",
            MovementKind::Train,
            "route:continuation:blocker",
            "formation:2",
            0,
            None,
            false,
        )
        .unwrap();
    world
        .materialize_train(
            "train:continuation:source",
            "RB 172",
            "operator:1",
            MovementKind::Train,
            "route:continuation:source",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    world
        .queue_movement_continuation(continuation(
            "continuation:blocked",
            "train:continuation:source",
            "train:continuation:successor",
            "RB 173",
            "route:continuation:successor",
            "formation:1",
            10_000,
            "continuation:successor:exit",
            0,
            0,
            MovementContinuity::SameDirection,
        ))
        .unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:continuation:blocker",
            "continuation:blocker:entry",
            0,
        )])
        .unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:continuation:source",
            "continuation:source",
            0,
        )])
        .unwrap();

    for _ in 0..64 {
        let source = &world.trains["train:continuation:source"];
        if source.head_route_mm == 20_000 && source.motion_segment.is_none() {
            break;
        }
        let next = world
            .trains
            .values()
            .filter_map(|train| train.motion_segment.as_ref())
            .map(|segment| segment.valid_until_ms)
            .min()
            .unwrap();
        world.advance_to(next).unwrap();
    }
    let source = &world.trains["train:continuation:source"];
    assert_eq!(source.head_route_mm, 20_000);
    assert_eq!(
        source.waiting_reason.as_deref(),
        Some("waiting-for-movement-continuation"),
        "{}",
        serde_json::to_string_pretty(&world).unwrap()
    );
    let persisted = serde_json::to_value(&world).unwrap();
    assert!(
        persisted["continuationsWaitingByResource"]
            .get("block:continuation:target")
            .is_some()
    );
    let blocked_at_ms = world.now_ms;
    world.advance_to(blocked_at_ms).unwrap();
    assert!(world.trains.contains_key("train:continuation:source"));

    advance_until(&mut world, "train:continuation:successor", true);
    assert!(!world.trains.contains_key("train:continuation:source"));
    assert!(
        world.trains["train:continuation:successor"]
            .motion_segment
            .is_some()
    );
    assert_eq!(
        serde_json::to_value(&world).unwrap()["continuationsWaitingByResource"],
        serde_json::json!({})
    );
    world.verify_invariants().unwrap();
}

#[test]
fn continuation_activates_atomically_while_outgoing_dispatch_waits_for_its_route() {
    let mut infra_release = continuation_release(false);
    infra_release
        .route_versions
        .get_mut("route:continuation:blocker")
        .unwrap()
        .legs[0]
        .block_ids = set(&["block:continuation:exit"]);
    infra_release
        .interlocking_routes
        .get_mut("continuation:blocker:entry")
        .unwrap()
        .path_resources = set(&["block:continuation:exit"]);
    let mut world = world_with_release(infra_release);
    world
        .materialize_train(
            "train:continuation:blocker",
            "G 181",
            "operator:2",
            MovementKind::Train,
            "route:continuation:blocker",
            "formation:2",
            0,
            None,
            false,
        )
        .unwrap();
    world
        .materialize_train(
            "train:continuation:source",
            "RB 182",
            "operator:1",
            MovementKind::Train,
            "route:continuation:source",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    world
        .queue_movement_continuation(continuation(
            "continuation:outgoing-blocked",
            "train:continuation:source",
            "train:continuation:successor",
            "RB 183",
            "route:continuation:successor",
            "formation:1",
            10_000,
            "continuation:successor:exit",
            0,
            0,
            MovementContinuity::SameDirection,
        ))
        .unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:continuation:blocker",
            "continuation:blocker:entry",
            0,
        )])
        .unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:continuation:source",
            "continuation:source",
            0,
        )])
        .unwrap();
    advance_until(&mut world, "train:continuation:successor", true);

    let successor = &world.trains["train:continuation:successor"];
    assert_eq!(successor.head_route_mm, 10_000);
    assert_eq!(successor.motion_state, MotionState::Standing);
    assert!(successor.authority.is_none());
    assert!(successor.motion_segment.is_none());
    assert_eq!(
        successor.waiting_reason.as_deref(),
        Some("waiting-for-route-lock")
    );
    assert!(
        serde_json::to_value(&world).unwrap()["pendingDispatchRequests"]
            .get("train:continuation:successor")
            .is_some()
    );

    for _ in 0..128 {
        if world.trains["train:continuation:successor"]
            .motion_segment
            .is_some()
        {
            break;
        }
        let next = world
            .trains
            .values()
            .filter_map(|train| train.motion_segment.as_ref())
            .map(|segment| segment.valid_until_ms)
            .min()
            .unwrap();
        world.advance_to(next).unwrap();
    }
    assert!(
        world.trains["train:continuation:successor"]
            .motion_segment
            .is_some()
    );
    world.verify_invariants().unwrap();
}

#[test]
fn zugsicherungsmenge_ist_one_of_in_template_materialize_authority_und_fahrt() {
    let mut world = world_with_release(release_with_route_protection(&["lzb", "pzb"]));
    let template = program_template("train:overlaid-protection", MovementKind::Train, 0);
    let selections = [ProtectionModeSelectionRun {
        through_route_leg_index: 1,
        selected_protection_system: "pzb".to_owned(),
    }];
    let predicates = world
        .inspect_train_program_template_with_protection_modes(
            &template,
            "interlocking:train",
            PROTECTION_MODE_SELECTION_POLICY_V1,
            &selections,
        )
        .expect("alle Bindungen sind aufloesbar");
    assert!(predicates.is_valid());
    assert!(predicates.failed_predicates().is_empty());
    assert_eq!(
        predicates.protection_mode_selection_runs.as_slice(),
        &selections
    );
    assert_eq!(predicates.protection_mode_selection_count, 2);

    let wrong_mode = [ProtectionModeSelectionRun {
        through_route_leg_index: 1,
        selected_protection_system: "lzb".to_owned(),
    }];
    let wrong_mode_predicates = world
        .inspect_train_program_template_with_protection_modes(
            &template,
            "interlocking:train",
            PROTECTION_MODE_SELECTION_POLICY_V1,
            &wrong_mode,
        )
        .expect("alle Bindungen sind aufloesbar");
    assert_eq!(
        wrong_mode_predicates.failed_predicates(),
        ["protection-mode-selections"]
    );
    let wrong_policy_predicates = world
        .inspect_train_program_template_with_protection_modes(
            &template,
            "interlocking:train",
            "zugfolge-protection-mode-selection/foreign-v1",
            &selections,
        )
        .expect("alle Bindungen sind aufloesbar");
    assert_eq!(
        wrong_policy_predicates.failed_predicates(),
        ["protection-mode-selection-policy"]
    );
    world
        .validate_train_program_template(&template, "interlocking:train")
        .expect("PZB teilt ein System mit der PZB/LZB-Ueberlagerung");
    world
        .materialize(template)
        .expect("Materialisierung nutzt dieselbe Schnittmengenregel");
    world
        .lock_route("train:overlaid-protection", "interlocking:train")
        .expect("Fahrberechtigung nutzt dieselbe Schnittmengenregel");
    let segment = world
        .plan_motion("train:overlaid-protection")
        .expect("Bewegungsplanung nutzt dieselbe Schnittmengenregel");
    world
        .advance_to(segment.valid_until_ms)
        .expect("der autoritative Fahrtpfad bleibt mit PZB fahrbar");
}

#[test]
fn full_route_authority_path_resources_decken_jedes_route_leg_ab() {
    let complete_world = world_with_release(release_with_route_protection(&["lzb", "pzb"]));
    let template = program_template("train:full-route-resources", MovementKind::Train, 0);
    let complete = complete_world
        .inspect_train_program_template(&template, "interlocking:train")
        .expect("vollstaendige Full-Route-Bindung ist aufloesbar");
    assert!(complete.authority_path_resources_cover_route);
    assert!(complete.is_valid());
    assert!(complete.failed_predicates().is_empty());
    assert_eq!(complete.resource_binding_count, 6);

    let mut overreaching_release = release_with_route_protection(&["lzb", "pzb"]);
    let overreaching = overreaching_release
        .interlocking_routes
        .get_mut("interlocking:train")
        .expect("Test-Fahrstrasse");
    overreaching.path_resources = set(&["block:a", "block:b"]);
    overreaching.authority_end_route_mm = 120_000;
    overreaching.release_after_tail_route_mm = 120_000;
    assert_eq!(
        overreaching_release.validate(),
        Err(OperationalError::InvalidInterlockingRoute(
            "interlocking:train".to_owned()
        ))
    );
}

#[test]
fn disjunkte_und_reine_lzb_etcs_mengen_bleiben_fail_closed() {
    for exclusive_system in ["lzb", "etcs-level2"] {
        let mut world = world_with_release(release_with_route_protection(&[exclusive_system]));
        let template = program_template(
            &format!("train:pure-{exclusive_system}"),
            MovementKind::Train,
            0,
        );
        let predicates = world
            .inspect_train_program_template(&template, "interlocking:train")
            .expect("alle Bindungen ausser der Kompatibilitaet sind aufloesbar");
        assert!(!predicates.protection_compatible);
        assert_eq!(
            predicates.failed_predicates(),
            ["protection-intersection", "protection-mode-selections"]
        );
        assert_eq!(
            world.validate_train_program_template(&template, "interlocking:train"),
            Err(OperationalError::InvalidProgramTemplate(
                template.id.clone()
            ))
        );
        assert_eq!(
            world.materialize(template.clone()),
            Err(OperationalError::IncompatibleProtectionSystem(
                template.id.clone()
            ))
        );
    }

    let mut authority_world = world();
    authority_world
        .materialize_train(
            "train:authority-disjoint",
            "RB 2",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .expect("vor der Einschraenkung kompatibel");
    authority_world
        .formations
        .get_mut("formation:1")
        .expect("Test-Formation")
        .performance
        .protection_systems = set(&["etcs-level2"]);
    assert_eq!(
        authority_world.lock_route("train:authority-disjoint", "interlocking:train"),
        Err(OperationalError::UnsafeRoute(
            "interlocking:train".to_owned()
        ))
    );

    let mut motion_world = world();
    motion_world
        .materialize_train(
            "train:motion-disjoint",
            "RB 3",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .expect("vor der Einschraenkung kompatibel");
    motion_world
        .lock_route("train:motion-disjoint", "interlocking:train")
        .expect("vor der Einschraenkung autorisiert");
    motion_world
        .formations
        .get_mut("formation:1")
        .expect("Test-Formation")
        .performance
        .protection_systems = set(&["etcs-level2"]);
    assert_eq!(
        motion_world.plan_motion("train:motion-disjoint"),
        Err(OperationalError::IncompatibleProtectionSystem(
            "train:motion-disjoint".to_owned()
        ))
    );
}

#[test]
fn gleichzeitig_erforderliche_zugsicherung_muss_zusaetzlich_installiert_sein() {
    let mut infra = release_with_route_protection(&["lzb", "pzb"]);
    for leg in &mut infra
        .route_versions
        .get_mut("route:v1")
        .expect("Test-Route")
        .legs
    {
        leg.simultaneously_required_protection_systems = vec!["lzb".to_owned()];
    }
    let world = world_with_release(infra);
    let template = program_template("train:simultaneous-protection", MovementKind::Train, 0);
    let predicates = world
        .inspect_train_program_template_with_protection_modes(
            &template,
            "interlocking:train",
            PROTECTION_MODE_SELECTION_POLICY_V1,
            &[],
        )
        .expect("alle Referenzen bleiben aufloesbar");
    assert_eq!(
        predicates.failed_predicates(),
        ["protection-intersection", "protection-mode-selections"]
    );
}

#[test]
fn programmvorlagen_inspektion_meldet_alle_booleschen_predikate_gemeinsam() {
    let mut world = world();
    let formation = world
        .formations
        .get_mut("formation:1")
        .expect("Test-Formation");
    formation.performance.mobile = false;
    formation.performance.protection_systems = set(&["etcs-level2"]);
    let template = program_template("train:all-predicates", MovementKind::Shunting, 130_000);
    let predicates = world
        .inspect_train_program_template(&template, "interlocking:train")
        .expect("Referenzen bleiben aufloesbar");
    assert_eq!(
        predicates.failed_predicates(),
        [
            "formation-mobile",
            "head-within-route",
            "protection-intersection",
            "protection-mode-selections",
            "movement-kind",
            "route-template",
            "authority-end",
            "release-after-tail",
        ]
    );
    assert!(!predicates.route_template_matches);
    assert!(!predicates.authority_end_matches_route);
    assert!(!predicates.release_after_tail_within_authority);
}

#[test]
fn authority_is_a_hard_motion_limit_and_livemap_rzue_share_commit() {
    let mut world = world();
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    let authority = world.lock_route("train:1", "interlocking:train").unwrap();
    let segment = world.plan_motion("train:1").unwrap();
    assert!(segment.segment_end_route_mm > 0);
    assert!(segment.segment_end_route_mm <= authority.end_route_mm);
    let moving_projection = world
        .project(ProjectionKind::LiveMap, &BTreeSet::new())
        .unwrap();
    assert_eq!(moving_projection.trains[0].motion_geometry.len(), 2);
    assert_eq!(
        moving_projection.trains[0].motion_geometry[1].route_mm,
        segment.segment_end_route_mm
    );
    let mut saw_braking = segment.acceleration_mmps2 < 0;
    for _ in 0..16 {
        let Some(active) = world.trains["train:1"].motion_segment.clone() else {
            break;
        };
        saw_braking |= active.acceleration_mmps2 < 0 && active.start_speed_mmps > 0;
        world.advance_to(active.valid_until_ms).unwrap();
        assert!(world.trains["train:1"].head_route_mm <= authority.end_route_mm);
    }
    let stopped = &world.trains["train:1"];
    assert!(saw_braking);
    assert_eq!(stopped.head_route_mm, authority.end_route_mm);
    assert_eq!(stopped.direction, Direction::Against);
    assert!(stopped.tail_route_mm <= stopped.head_route_mm);
    assert_eq!(stopped.speed_mmps, 0);
    assert_eq!(stopped.motion_state, MotionState::Standing);
    let map = world
        .project(ProjectionKind::LiveMap, &BTreeSet::new())
        .unwrap();
    let rzue = world
        .project(ProjectionKind::Rzue, &BTreeSet::new())
        .unwrap();
    assert_eq!(map.commit_sequence, rzue.commit_sequence);
    assert_eq!(map.trains, rzue.trains);
}

#[test]
fn train_numbers_accept_1_and_99999_and_reject_zero_overlong_or_duplicate_numeric_parts() {
    assert_eq!(operational_train_number_numeric_part("1"), Some(1));
    assert_eq!(
        operational_train_number_numeric_part("ICE 99999"),
        Some(99_999)
    );
    assert_eq!(operational_train_number_numeric_part("0"), None);
    assert_eq!(operational_train_number_numeric_part("RB 00000"), None);
    let mut world = world();
    world
        .materialize_train(
            "train:boundary",
            "ICE 99999",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            10_000,
            None,
            false,
        )
        .unwrap();
    assert_eq!(
        world.materialize_train(
            "train:overlong",
            "S4-1667972",
            "operator:2",
            MovementKind::Train,
            "route:v1",
            "formation:2",
            50_000,
            None,
            false,
        ),
        Err(OperationalError::InvalidTrainNumber(
            "S4-1667972".to_owned()
        ))
    );
    assert_eq!(
        world.materialize_train(
            "train:duplicate",
            "RE-99999",
            "operator:2",
            MovementKind::Train,
            "route:v1",
            "formation:2",
            50_000,
            None,
            false,
        ),
        Err(OperationalError::DuplicateTrainNumber(99_999))
    );
}

#[test]
fn incompatible_routes_never_lock_together_and_protect_overlap_and_flank() {
    let mut world = world_with_release(release_with_independent_opposing_route());
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    world
        .materialize_train(
            "train:2",
            "RB 2",
            "operator:2",
            MovementKind::Train,
            "route:opposing",
            "formation:2",
            0,
            None,
            false,
        )
        .unwrap();
    world.lock_route("train:1", "interlocking:train").unwrap();
    assert!(
        world
            .lock_route("train:2", "interlocking:opposing")
            .is_err()
    );
    let lock = world.route_locks.values().next().unwrap();
    assert!(lock.resources.contains("overlap:1"));
    assert!(lock.resources.contains("flank:1"));
    assert_eq!(world.signal_aspects["signal:train"], SignalAspect::Proceed);
    world.verify_invariants().unwrap();
}

#[test]
fn block_and_route_release_wait_for_tail() {
    let mut world = world();
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:3",
            0,
            None,
            false,
        )
        .unwrap();
    world.lock_route("train:1", "interlocking:train").unwrap();
    let segment = world.plan_motion("train:1").unwrap();
    world.advance_to(segment.valid_until_ms).unwrap();
    assert!(world.trains["train:1"].tail_route_mm < 50_000);
    assert_eq!(world.route_locks.len(), 1);
    assert_ne!(
        world.resource_lifecycle["overlap:1"],
        ResourceLifecycle::Free
    );
}

#[test]
fn full_route_lock_releases_at_terminal_but_keeps_endpoint_protected_until_retirement() {
    let mut world = world_with_release(release_with_route_protection(&["lzb", "pzb"]));
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    assert_eq!(
        world
            .submit_dispatch_requests(&[dispatch_request("train:1", "interlocking:train", 0,)])
            .unwrap(),
        ["train:1"]
    );
    let first_segment = world.trains["train:1"]
        .motion_segment
        .clone()
        .expect("look-ahead starts motion");
    world.advance_to(first_segment.valid_until_ms).unwrap();
    assert!(world.trains["train:1"].head_route_mm < 120_000);
    assert_eq!(world.route_locks.len(), 1);
    assert_eq!(
        world.resource_lifecycle["overlap:1"],
        ResourceLifecycle::RouteLocked
    );

    for _ in 0..16 {
        let Some(valid_until_ms) = world.trains["train:1"]
            .motion_segment
            .as_ref()
            .map(|segment| segment.valid_until_ms)
        else {
            break;
        };
        world.advance_to(valid_until_ms).unwrap();
    }

    let completed = &world.trains["train:1"];
    assert_eq!(completed.head_route_mm, 120_000);
    assert_eq!(completed.tail_route_mm, 110_000);
    assert!(completed.authority.is_none());
    assert_eq!(completed.speed_mmps, 0);
    assert!(world.route_locks.is_empty());
    assert!(!world.signal_aspects.contains_key("signal:train"));
    assert!(completed.occupied_blocks.contains("overlap:1"));
    assert_eq!(
        world.resource_lifecycle["overlap:1"],
        ResourceLifecycle::OccupiedByFormation
    );
    for resource in ["block:a", "route-resource:common", "flank:1"] {
        assert!(!world.resource_lifecycle.contains_key(resource));
    }
    assert_eq!(
        world.resource_lifecycle["block:b"],
        ResourceLifecycle::OccupiedByFormation
    );
    world
        .change_formation(
            "train:1",
            "formation:terminal-changed",
            vec!["vehicle:1".to_owned()],
        )
        .unwrap();
    assert!(
        world.trains["train:1"]
            .occupied_blocks
            .contains("overlap:1")
    );
    assert_eq!(
        world.resource_lifecycle["overlap:1"],
        ResourceLifecycle::OccupiedByFormation
    );

    world
        .materialize_train(
            "train:2",
            "RB 2",
            "operator:2",
            MovementKind::Train,
            "route:v1",
            "formation:2",
            0,
            None,
            false,
        )
        .unwrap();
    assert_eq!(
        world
            .submit_dispatch_requests(&[DispatchRequest {
                train_id: "train:2".to_owned(),
                interlocking_route_id: "interlocking:train".to_owned(),
                committed_rank: 0,
                timetable_deviation_ms: 0,
                passenger_impact: 0,
                contractual_impact: 0,
                network_impact: 0,
                resource_consequence: 0,
                recovery_rank: 0,
                waiting_since_ms: world.now_ms,
            }])
            .unwrap(),
        Vec::<String>::new()
    );
    assert!(world.trains["train:2"].authority.is_none());

    world.retire_train("train:1").unwrap();

    assert!(!world.trains.contains_key("train:1"));
    assert_eq!(world.route_locks.len(), 2);
    assert_eq!(world.signal_aspects["signal:train"], SignalAspect::Proceed);
    assert!(world.trains["train:2"].authority.is_some());
    assert!(world.trains["train:2"].motion_segment.is_some());
    let checkpoint = serde_json::to_value(&world).unwrap();
    assert_eq!(checkpoint["waitingByResource"], serde_json::json!({}));
    world.verify_invariants().unwrap();
}

#[test]
fn checkpoint_invariant_rejects_a_foreign_lock_against_occupied_endpoint_protection() {
    let mut world = world_with_release(release_with_independent_opposing_route());
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    world
        .materialize_train(
            "train:2",
            "RB 2",
            "operator:2",
            MovementKind::Train,
            "route:opposing",
            "formation:2",
            0,
            None,
            false,
        )
        .unwrap();
    world.lock_route("train:1", "interlocking:train").unwrap();
    world
        .trains
        .get_mut("train:2")
        .expect("zweiter Zug")
        .occupied_blocks
        .insert("overlap:1".to_owned());

    assert_eq!(
        world.verify_invariants(),
        Err(OperationalError::UnsafeState)
    );
}

#[test]
fn terminal_release_dispatches_a_disjoint_waiter_and_clears_its_wait_index() {
    let mut world = world_with_release(release_with_independent_opposing_route());
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    world
        .materialize_train(
            "train:2",
            "RB 2",
            "operator:2",
            MovementKind::Train,
            "route:opposing",
            "formation:2",
            0,
            None,
            false,
        )
        .unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request("train:1", "interlocking:train", 0)])
        .unwrap();
    assert_eq!(
        world
            .submit_dispatch_requests(&[DispatchRequest {
                train_id: "train:2".to_owned(),
                interlocking_route_id: "interlocking:opposing".to_owned(),
                committed_rank: 0,
                timetable_deviation_ms: 0,
                passenger_impact: 0,
                contractual_impact: 0,
                network_impact: 0,
                resource_consequence: 0,
                recovery_rank: 0,
                waiting_since_ms: 0,
            }])
            .unwrap(),
        Vec::<String>::new()
    );

    for _ in 0..16 {
        let Some(valid_until_ms) = world.trains["train:1"]
            .motion_segment
            .as_ref()
            .map(|segment| segment.valid_until_ms)
        else {
            break;
        };
        world.advance_to(valid_until_ms).unwrap();
    }

    assert!(
        world.trains["train:1"]
            .occupied_blocks
            .contains("overlap:1")
    );
    assert!(world.trains["train:2"].authority.is_some());
    assert!(world.trains["train:2"].motion_segment.is_some());
    let checkpoint = serde_json::to_value(&world).unwrap();
    assert_eq!(checkpoint["waitingByResource"], serde_json::json!({}));
    world.verify_invariants().unwrap();
}

#[test]
fn three_free_train_segments_are_locked_separately_and_crossed_without_intermediate_stop() {
    let mut world = world_with_release(release_with_three_train_segments());
    world
        .materialize_train(
            "train:progressive",
            "RB 10",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();

    assert_eq!(
        world
            .submit_dispatch_requests(&[dispatch_request(
                "train:progressive",
                "interlocking:train",
                0,
            )])
            .unwrap(),
        ["train:progressive"]
    );
    assert_eq!(world.route_locks.len(), 3);
    assert_eq!(
        world.trains["train:progressive"]
            .authority
            .as_ref()
            .map(|authority| authority.end_route_mm),
        Some(120_000)
    );

    let checkpoint = world.checkpoint();
    let mut replay = OperationalWorld::restore(&checkpoint).unwrap();
    for candidate in [&mut world, &mut replay] {
        let mut crossed = BTreeMap::new();
        for _ in 0..32 {
            let Some(valid_until_ms) = candidate.trains["train:progressive"]
                .motion_segment
                .as_ref()
                .map(|segment| segment.valid_until_ms)
            else {
                break;
            };
            candidate.advance_to(valid_until_ms).unwrap();
            let train = &candidate.trains["train:progressive"];
            if matches!(train.head_route_mm, 60_000 | 90_000) {
                crossed.insert(train.head_route_mm, train.speed_mmps);
            }
        }
        assert!(crossed.get(&60_000).is_some_and(|speed| *speed > 0));
        assert!(crossed.get(&90_000).is_some_and(|speed| *speed > 0));
        let completed = &candidate.trains["train:progressive"];
        assert_eq!(completed.head_route_mm, 120_000);
        assert_eq!(completed.speed_mmps, 0);
        assert!(completed.authority.is_none());
        assert!(completed.motion_segment.is_none());
        let persisted = serde_json::to_value(&*candidate).unwrap();
        assert_eq!(persisted["pendingDispatchRequests"], serde_json::json!({}));
        candidate.verify_invariants().unwrap();
    }
    assert_eq!(world.state_hash(), replay.state_hash());
}

#[test]
fn blocker_in_last_segment_limits_authority_then_waits_and_resumes_at_exact_start() {
    let mut world = world_with_release(release_with_three_train_segments());
    world
        .materialize_train(
            "blocker",
            "G 20",
            "operator:2",
            MovementKind::Train,
            "route:v1",
            "formation:2",
            120_000,
            None,
            false,
        )
        .unwrap();
    world
        .materialize_train(
            "train:progressive",
            "RB 10",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();

    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:progressive",
            "interlocking:train",
            0,
        )])
        .unwrap();
    assert_eq!(world.route_locks.len(), 2);
    assert_eq!(
        world.trains["train:progressive"]
            .authority
            .as_ref()
            .map(|authority| authority.end_route_mm),
        Some(90_000)
    );

    let mut speed_at_first_boundary = None;
    for _ in 0..32 {
        let Some(valid_until_ms) = world.trains["train:progressive"]
            .motion_segment
            .as_ref()
            .map(|segment| segment.valid_until_ms)
        else {
            break;
        };
        world.advance_to(valid_until_ms).unwrap();
        let train = &world.trains["train:progressive"];
        if train.head_route_mm == 60_000 {
            speed_at_first_boundary = Some(train.speed_mmps);
        }
    }
    assert!(speed_at_first_boundary.is_some_and(|speed| speed > 0));
    let waiting = &world.trains["train:progressive"];
    assert_eq!(waiting.head_route_mm, 90_000);
    assert_eq!(waiting.speed_mmps, 0);
    assert_eq!(waiting.motion_state, MotionState::Standing);
    assert!(waiting.authority.is_none());
    assert!(waiting.motion_segment.is_none());
    assert_eq!(
        waiting.waiting_reason.as_deref(),
        Some("waiting-for-route-lock")
    );
    let persisted = serde_json::to_value(&world).unwrap();
    assert_eq!(
        persisted["waitingByResource"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>(),
        set(&["block:c", "overlap:train:c", "flank:train:c"])
    );
    assert!(
        persisted["pendingDispatchRequests"]
            .get("train:progressive")
            .is_some()
    );
    world.verify_invariants().unwrap();

    world.retire_train("blocker").unwrap();
    let resumed = &world.trains["train:progressive"];
    assert_eq!(
        resumed
            .authority
            .as_ref()
            .map(|authority| authority.end_route_mm),
        Some(120_000)
    );
    assert!(resumed.motion_segment.is_some());
    assert!(resumed.waiting_reason.is_none());
    assert_eq!(
        serde_json::to_value(&world).unwrap()["waitingByResource"],
        serde_json::json!({})
    );

    for _ in 0..16 {
        let Some(valid_until_ms) = world.trains["train:progressive"]
            .motion_segment
            .as_ref()
            .map(|segment| segment.valid_until_ms)
        else {
            break;
        };
        world.advance_to(valid_until_ms).unwrap();
    }
    assert_eq!(world.trains["train:progressive"].head_route_mm, 120_000);
    assert_eq!(
        serde_json::to_value(&world).unwrap()["pendingDispatchRequests"],
        serde_json::json!({})
    );
    world.verify_invariants().unwrap();
}

#[test]
fn progressive_authority_schema_and_exact_start_fail_closed() {
    let release = release_with_three_train_segments();
    let serialized =
        serde_json::to_value(&release.interlocking_routes["interlocking:train"]).unwrap();
    assert_eq!(serialized["authorityStartRouteMm"], serde_json::json!(0));
    let mut missing_start = serialized;
    missing_start
        .as_object_mut()
        .unwrap()
        .remove("authorityStartRouteMm");
    assert!(serde_json::from_value::<InterlockingRouteTemplate>(missing_start).is_err());

    let mut duplicate = release.clone();
    let mut duplicate_template = duplicate.interlocking_routes["interlocking:train"].clone();
    duplicate_template.id = "interlocking:duplicate-start".to_owned();
    duplicate
        .interlocking_routes
        .insert(duplicate_template.id.clone(), duplicate_template);
    assert!(matches!(
        duplicate.validate(),
        Err(OperationalError::InvalidInterlockingRoute(_))
    ));

    let mut missing_segment = release.clone();
    missing_segment
        .interlocking_routes
        .remove("interlocking:train:b");
    assert_eq!(
        missing_segment.validate(),
        Err(OperationalError::IncompleteRoute("route:v1".to_owned()))
    );

    let mut world = world_with_release(release);
    world
        .materialize_train(
            "train:mismatched-start",
            "RB 30",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            30_000,
            None,
            false,
        )
        .unwrap();
    assert_eq!(
        world.lock_route("train:mismatched-start", "interlocking:train"),
        Err(OperationalError::UnsafeRoute(
            "interlocking:train".to_owned()
        ))
    );
    assert!(world.route_locks.is_empty());
    assert!(world.signal_aspects.is_empty());
}

#[test]
fn progressive_authority_invariants_reject_missing_lock_and_unbacked_signal() {
    let mut world = world_with_release(release_with_three_train_segments());
    world
        .materialize_train(
            "train:invariants",
            "RB 40",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    world
        .lock_route("train:invariants", "interlocking:train")
        .unwrap();
    world.verify_invariants().unwrap();

    let mut missing_source_lock = world.clone();
    missing_source_lock
        .trains
        .get_mut("train:invariants")
        .unwrap()
        .authority
        .as_mut()
        .unwrap()
        .source_route_lock_id = "lock:missing".to_owned();
    assert_eq!(
        missing_source_lock.verify_invariants(),
        Err(OperationalError::UnsafeState)
    );

    let mut missing_signal = world.clone();
    missing_signal.signal_aspects.remove("signal:train");
    assert_eq!(
        missing_signal.verify_invariants(),
        Err(OperationalError::UnsafeState)
    );

    let mut unbacked_signal = world_with_release(release_with_three_train_segments());
    unbacked_signal
        .signal_aspects
        .insert("signal:train".to_owned(), SignalAspect::Proceed);
    assert_eq!(
        unbacked_signal.verify_invariants(),
        Err(OperationalError::UnsafeState)
    );
}

#[test]
fn exact_intervals_span_switch_like_edge_boundary_without_position_jump() {
    let mut world = world();
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:3",
            65_000,
            None,
            false,
        )
        .unwrap();
    let train = &world.trains["train:1"];
    assert_eq!(train.occupied_intervals.len(), 2);
    assert_eq!(train.occupied_intervals[0].edge_id, "edge:a");
    assert_eq!(train.occupied_intervals[1].edge_id, "edge:b");
    assert_eq!(train.head_route_mm - train.tail_route_mm, 20_000);
}

#[test]
fn separated_vehicle_groups_can_share_a_long_track_and_coupling_is_atomic() {
    let mut world = world();
    world
        .materialize_train(
            "shunt:1",
            "R 1",
            "operator:1",
            MovementKind::Shunting,
            "route:v1",
            "formation:1",
            15_000,
            None,
            false,
        )
        .unwrap();
    world
        .materialize_train(
            "shunt:2",
            "R 2",
            "operator:1",
            MovementKind::Shunting,
            "route:v1",
            "formation:2",
            45_000,
            None,
            false,
        )
        .unwrap();
    world
        .change_formation(
            "shunt:2",
            "formation:coupled",
            vec!["vehicle:2".to_owned(), "vehicle:3".to_owned()],
        )
        .unwrap();
    let train = &world.trains["shunt:2"];
    let formation: &FormationVersion = &world.formations["formation:coupled"];
    assert_eq!(formation.performance.length_mm, 30_000);
    assert_eq!(train.head_route_mm - train.tail_route_mm, 30_000);
    world.verify_invariants().unwrap();
}

#[test]
fn explicit_traction_metadata_is_complete_and_type_consistent() {
    let mut world =
        OperationalWorld::new("world:traction-types", "region:a", 0, release()).unwrap();
    let mut missing_system = explicit_vehicle_type(
        "type:electric-without-system",
        OperationalVehicleRole::PoweredUnit,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    );
    missing_system.electric_systems = Some(Vec::new());
    assert!(matches!(
        world.register_vehicle_type(missing_system, true),
        Err(OperationalError::IncompleteVehicleType(_))
    ));

    let mut partial_metadata = explicit_vehicle_type(
        "type:partial-metadata",
        OperationalVehicleRole::PoweredUnit,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    );
    partial_metadata.traction = None;
    partial_metadata.electric_systems = None;
    assert!(matches!(
        world.register_vehicle_type(partial_metadata, true),
        Err(OperationalError::IncompleteVehicleType(_))
    ));

    let mut duplicate_system = explicit_vehicle_type(
        "type:duplicate-system",
        OperationalVehicleRole::PoweredUnit,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    );
    duplicate_system.electric_systems = Some(vec![
        OperationalPowerSystem::Ac15kv,
        OperationalPowerSystem::Ac15kv,
    ]);
    assert!(matches!(
        world.register_vehicle_type(duplicate_system, true),
        Err(OperationalError::IncompleteVehicleType(_))
    ));
}

#[test]
fn explizite_formationsdynamik_entsteht_aus_rohsummen_statt_typprofilen() {
    let mut world = OperationalWorld::new("world:raw-dynamics", "region:a", 0, release()).unwrap();
    let mut locomotive = explicit_vehicle_type(
        "type:raw-locomotive",
        OperationalVehicleRole::Locomotive,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    );
    bind_raw_reference(&mut locomotive, 40_000, 4_000, 8_000, 15_000);
    let mut coach = explicit_vehicle_type(
        "type:raw-coach",
        OperationalVehicleRole::Coach,
        OperationalControlStands {
            front: false,
            rear: false,
        },
    );
    coach.protection_systems.clear();
    bind_raw_reference(&mut coach, 80_000, 0, 8_000, 15_000);
    world.register_vehicle_type(locomotive, true).unwrap();
    world.register_vehicle_type(coach, false).unwrap();
    for id in ["single", "loaded", "double-a", "double-b"] {
        world
            .register_vehicle(explicit_vehicle(
                &format!("vehicle:{id}"),
                "type:raw-locomotive",
                true,
                Direction::Along,
            ))
            .unwrap();
    }
    world
        .register_vehicle(explicit_vehicle(
            "vehicle:raw-coach",
            "type:raw-coach",
            false,
            Direction::Along,
        ))
        .unwrap();

    let single = world
        .create_formation(
            "formation:raw-single",
            None,
            vec!["vehicle:single".to_owned()],
        )
        .unwrap();
    let loaded = world
        .create_formation(
            "formation:raw-loaded",
            None,
            vec!["vehicle:loaded".to_owned(), "vehicle:raw-coach".to_owned()],
        )
        .unwrap();
    let double = world
        .create_formation(
            "formation:raw-double",
            None,
            vec!["vehicle:double-a".to_owned(), "vehicle:double-b".to_owned()],
        )
        .unwrap();

    assert_eq!(single.performance.acceleration_mmps2, 3_000);
    assert_eq!(loaded.performance.acceleration_mmps2, 1_500);
    assert_eq!(double.performance.acceleration_mmps2, 3_000);
    assert_eq!(single.performance.service_brake_mmps2, 4_903);
    assert_eq!(loaded.performance.service_brake_mmps2, 7_354);
    assert_eq!(double.performance.service_brake_mmps2, 4_903);
    assert_eq!(loaded.performance.emergency_brake_mmps2, 11_031);
}

#[test]
fn raw_dynamics_block_referenz_und_overflow_sind_fail_closed() {
    let mut missing = explicit_vehicle_type(
        "type:raw-missing",
        OperationalVehicleRole::Locomotive,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    );
    missing.raw_formation_dynamics = None;
    assert!(matches!(
        missing.validate(true),
        Err(OperationalError::IncompleteVehicleType(_))
    ));

    let mut manipulated = explicit_vehicle_type(
        "type:raw-manipulated",
        OperationalVehicleRole::Locomotive,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    );
    manipulated.maximum_acceleration_mmps2 += 1;
    assert!(matches!(
        manipulated.validate(true),
        Err(OperationalError::IncompleteVehicleType(_))
    ));

    let mut partial_json = serde_json::to_value(explicit_vehicle_type(
        "type:raw-partial-json",
        OperationalVehicleRole::Locomotive,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    ))
    .unwrap();
    partial_json["rawFormationDynamics"]
        .as_object_mut()
        .unwrap()
        .remove("serviceBrakeCapMmps2");
    assert!(serde_json::from_value::<VehicleType>(partial_json).is_err());

    assert_eq!(
        derive_formation_dynamics(FormationDynamicsDerivationInput {
            total_mass_kg: 1,
            effective_starting_tractive_force_newtons: u64::MAX,
            total_brake_weight_kg: 1,
            maximum_acceleration_cap_mmps2: 1,
            service_brake_cap_mmps2: 1,
            emergency_brake_multiplier_basis_points: 20_000,
        }),
        Err(FormationDynamicsDerivationError::ArithmeticOverflow)
    );

    let mut world = OperationalWorld::new("world:raw-overflow", "region:a", 0, release()).unwrap();
    let mut huge_power = explicit_vehicle_type(
        "type:raw-overflow",
        OperationalVehicleRole::PoweredUnit,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    );
    huge_power.power_watts = u64::MAX;
    world.register_vehicle_type(huge_power, true).unwrap();
    let mut vehicle = explicit_vehicle(
        "vehicle:raw-overflow",
        "type:raw-overflow",
        true,
        Direction::Along,
    );
    vehicle.restrictions.insert(
        "power-a".to_owned(),
        VehicleRestriction::PowerBasisPoints(10_000),
    );
    vehicle.restrictions.insert(
        "power-b".to_owned(),
        VehicleRestriction::PowerBasisPoints(9_999),
    );
    world.register_vehicle(vehicle).unwrap();
    assert_eq!(
        world.create_formation(
            "formation:raw-overflow",
            None,
            vec!["vehicle:raw-overflow".to_owned()],
        ),
        Err(OperationalError::ArithmeticOverflow)
    );
}

#[test]
fn initiale_und_geaenderte_formationen_sind_traktionskompatibel() {
    let mut world = world();
    let powered_type = |id: &str,
                        traction: OperationalVehicleTraction,
                        electric_systems: Vec<OperationalPowerSystem>| {
        let mut kind = explicit_vehicle_type(
            id,
            OperationalVehicleRole::PoweredUnit,
            OperationalControlStands {
                front: true,
                rear: true,
            },
        );
        kind.traction = Some(traction);
        kind.electric_systems = Some(electric_systems);
        kind
    };
    world
        .register_vehicle_type(
            powered_type(
                "type:electric-ac15",
                OperationalVehicleTraction::Electric,
                vec![OperationalPowerSystem::Ac15kv],
            ),
            true,
        )
        .unwrap();
    world
        .register_vehicle_type(
            powered_type(
                "type:diesel",
                OperationalVehicleTraction::Diesel,
                Vec::new(),
            ),
            true,
        )
        .unwrap();
    world
        .register_vehicle_type(
            powered_type(
                "type:electric-multi",
                OperationalVehicleTraction::Electric,
                vec![
                    OperationalPowerSystem::Ac15kv,
                    OperationalPowerSystem::Ac25kv,
                ],
            ),
            true,
        )
        .unwrap();
    world
        .register_vehicle_type(
            powered_type(
                "type:bemu-ac15",
                OperationalVehicleTraction::Battery,
                vec![OperationalPowerSystem::Ac15kv],
            ),
            true,
        )
        .unwrap();
    for (id, type_id) in [
        ("vehicle:electric-1", "type:electric-ac15"),
        ("vehicle:diesel-1", "type:diesel"),
        ("vehicle:multi-1", "type:electric-multi"),
        ("vehicle:bemu-1", "type:bemu-ac15"),
        ("vehicle:bemu-2", "type:bemu-ac15"),
        ("vehicle:bemu-3", "type:bemu-ac15"),
        ("vehicle:bemu-4", "type:bemu-ac15"),
    ] {
        world
            .register_vehicle(explicit_vehicle(id, type_id, true, Direction::Along))
            .unwrap();
    }

    assert!(matches!(
        world.create_formation(
            "formation:mixed-traction",
            None,
            vec![
                "vehicle:electric-1".to_owned(),
                "vehicle:diesel-1".to_owned(),
            ],
        ),
        Err(OperationalError::InvalidFormation(_))
    ));
    assert!(matches!(
        world.create_formation(
            "formation:mixed-systems",
            None,
            vec![
                "vehicle:electric-1".to_owned(),
                "vehicle:multi-1".to_owned(),
            ],
        ),
        Err(OperationalError::InvalidFormation(_))
    ));
    let initial_bemu = world
        .create_formation(
            "formation:bemu-compatible",
            None,
            vec!["vehicle:bemu-1".to_owned(), "vehicle:bemu-2".to_owned()],
        )
        .expect("gleichartige BEMU-Doppeltraktion ist kompatibel");
    assert!(initial_bemu.performance.mobile);

    world
        .materialize_train(
            "shunt:traction-change",
            "R 90",
            "operator:1",
            MovementKind::Shunting,
            "route:v1",
            "formation:1",
            20_000,
            None,
            false,
        )
        .unwrap();
    assert!(matches!(
        world.change_formation(
            "shunt:traction-change",
            "formation:changed-mixed-traction",
            vec![
                "vehicle:electric-1".to_owned(),
                "vehicle:diesel-1".to_owned(),
            ],
        ),
        Err(OperationalError::InvalidFormation(_))
    ));
    assert!(matches!(
        world.change_formation(
            "shunt:traction-change",
            "formation:changed-mixed-systems",
            vec![
                "vehicle:electric-1".to_owned(),
                "vehicle:multi-1".to_owned(),
            ],
        ),
        Err(OperationalError::InvalidFormation(_))
    ));
    world
        .change_formation(
            "shunt:traction-change",
            "formation:changed-bemu-compatible",
            vec!["vehicle:bemu-3".to_owned(), "vehicle:bemu-4".to_owned()],
        )
        .expect("changeFormation akzeptiert gleichartige BEMU-Doppeltraktion");
    assert_eq!(
        world.trains["shunt:traction-change"].formation_version_id,
        "formation:changed-bemu-compatible"
    );
}

#[test]
fn power_restriction_is_applied_per_asset_before_order_independent_summation() {
    let mut world = world();
    let mut restricted = vehicle("vehicle:power-restricted", "type:short");
    restricted.restrictions.insert(
        "restriction:third-power".to_owned(),
        VehicleRestriction::PowerBasisPoints(3_333),
    );
    world.register_vehicle(restricted).unwrap();
    world
        .register_vehicle(vehicle("vehicle:power-healthy", "type:short"))
        .unwrap();

    let restricted_first = world
        .create_formation(
            "formation:power-restricted-first",
            None,
            vec![
                "vehicle:power-restricted".to_owned(),
                "vehicle:power-healthy".to_owned(),
            ],
        )
        .unwrap();
    let restricted_last = world
        .create_formation(
            "formation:power-restricted-last",
            None,
            vec![
                "vehicle:power-healthy".to_owned(),
                "vehicle:power-restricted".to_owned(),
            ],
        )
        .unwrap();

    assert_eq!(restricted_first.performance, restricted_last.performance);
    assert_eq!(restricted_first.performance.power_watts, 5_333_000);
    assert_eq!(restricted_first.performance.acceleration_mmps2, 2_000);
}

#[test]
fn power_restriction_rounded_to_zero_removes_drive_and_acceleration() {
    let mut world = world();
    let mut tiny_type = vehicle_type("type:tiny-power", 10_000);
    tiny_type.power_watts = 1_000;
    world.register_vehicle_type(tiny_type, true).unwrap();
    let mut tiny = vehicle("vehicle:tiny-power", "type:tiny-power");
    tiny.restrictions.insert(
        "restriction:near-total-power-loss".to_owned(),
        VehicleRestriction::PowerBasisPoints(1),
    );
    world.register_vehicle(tiny).unwrap();

    let formation = world
        .create_formation(
            "formation:tiny-power",
            None,
            vec!["vehicle:tiny-power".to_owned()],
        )
        .unwrap();

    assert_eq!(formation.performance.power_watts, 0);
    assert_eq!(formation.performance.acceleration_mmps2, 0);
    assert!(!formation.performance.mobile);
}

#[test]
fn immobilized_powered_asset_contributes_no_drive_or_protection() {
    let mut world = world();
    let mut healthy_type = vehicle_type("type:healthy-protected", 10_000);
    healthy_type.protection_systems = set(&["lzb", "pzb"]);
    world.register_vehicle_type(healthy_type, true).unwrap();
    world
        .register_vehicle(vehicle(
            "vehicle:healthy-protected",
            "type:healthy-protected",
        ))
        .unwrap();
    let mut immobilized = vehicle("vehicle:immobilized", "type:short");
    immobilized.restrictions.insert(
        "restriction:immobilized".to_owned(),
        VehicleRestriction::Immobilized,
    );
    world.register_vehicle(immobilized).unwrap();

    let immobilized_first = world
        .create_formation(
            "formation:immobilized-first",
            None,
            vec![
                "vehicle:immobilized".to_owned(),
                "vehicle:healthy-protected".to_owned(),
            ],
        )
        .unwrap();
    let immobilized_last = world
        .create_formation(
            "formation:immobilized-last",
            None,
            vec![
                "vehicle:healthy-protected".to_owned(),
                "vehicle:immobilized".to_owned(),
            ],
        )
        .unwrap();

    assert_eq!(immobilized_first.performance, immobilized_last.performance);
    assert!(immobilized_first.performance.mobile);
    assert_eq!(immobilized_first.performance.power_watts, 4_000_000);
    assert_eq!(immobilized_first.performance.acceleration_mmps2, 1_000);
    assert_eq!(
        immobilized_first.performance.protection_systems,
        set(&["lzb", "pzb"])
    );

    let immobilized_only = world
        .create_formation(
            "formation:immobilized-only",
            None,
            vec!["vehicle:immobilized".to_owned()],
        )
        .unwrap();
    assert!(!immobilized_only.performance.mobile);
    assert_eq!(immobilized_only.performance.power_watts, 0);
    assert_eq!(immobilized_only.performance.acceleration_mmps2, 0);
    assert!(immobilized_only.performance.protection_systems.is_empty());
}

#[test]
fn unpowered_restrictions_cannot_remove_powered_asset_protection() {
    let mut world = world();
    let mut powered_type = vehicle_type("type:protected-power", 10_000);
    powered_type.protection_systems = set(&["lzb", "pzb"]);
    world.register_vehicle_type(powered_type, true).unwrap();
    world
        .register_vehicle(vehicle("vehicle:protected-power", "type:protected-power"))
        .unwrap();

    let mut trailer_type = vehicle_type("type:restricted-trailer", 20_000);
    trailer_type.power_watts = 0;
    trailer_type.starting_tractive_force_newtons = 0;
    trailer_type.maximum_acceleration_mmps2 = 0;
    trailer_type.protection_systems.clear();
    world.register_vehicle_type(trailer_type, false).unwrap();
    let mut trailer = vehicle("vehicle:restricted-trailer", "type:restricted-trailer");
    trailer.powered = false;
    trailer.restrictions.insert(
        "restriction:trailer-pzb-unavailable".to_owned(),
        VehicleRestriction::ProtectionUnavailable("pzb".to_owned()),
    );
    world.register_vehicle(trailer).unwrap();

    let powered_first = world
        .create_formation(
            "formation:powered-first",
            None,
            vec![
                "vehicle:protected-power".to_owned(),
                "vehicle:restricted-trailer".to_owned(),
            ],
        )
        .unwrap();
    let powered_last = world
        .create_formation(
            "formation:powered-last",
            None,
            vec![
                "vehicle:restricted-trailer".to_owned(),
                "vehicle:protected-power".to_owned(),
            ],
        )
        .unwrap();

    assert_eq!(powered_first.performance, powered_last.performance);
    assert_eq!(
        powered_first.performance.protection_systems,
        set(&["lzb", "pzb"])
    );
}

#[test]
fn locomotive_coach_control_car_formation_exposes_control_stands_at_both_ends() {
    let mut world = world();
    let locomotive = explicit_vehicle_type(
        "type:locomotive",
        OperationalVehicleRole::Locomotive,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    );
    let mut coach = explicit_vehicle_type(
        "type:coach",
        OperationalVehicleRole::Coach,
        OperationalControlStands {
            front: false,
            rear: false,
        },
    );
    coach.protection_systems.clear();
    let mut control_car = explicit_vehicle_type(
        "type:control-car",
        OperationalVehicleRole::ControlCar,
        OperationalControlStands {
            front: true,
            rear: false,
        },
    );
    control_car.protection_systems = set(&["etcs-level2", "pzb"]);
    world.register_vehicle_type(locomotive, true).unwrap();
    world.register_vehicle_type(coach, false).unwrap();
    world.register_vehicle_type(control_car, false).unwrap();
    world
        .register_vehicle(explicit_vehicle(
            "vehicle:locomotive",
            "type:locomotive",
            true,
            Direction::Along,
        ))
        .unwrap();
    world
        .register_vehicle(explicit_vehicle(
            "vehicle:coach",
            "type:coach",
            false,
            Direction::Along,
        ))
        .unwrap();
    world
        .register_vehicle(explicit_vehicle(
            "vehicle:control-car",
            "type:control-car",
            false,
            // Die physische Front des Steuerwagens liegt am Zugschluss.
            Direction::Against,
        ))
        .unwrap();

    let formation = world
        .create_formation(
            "formation:reversible-push-pull",
            None,
            vec![
                "vehicle:locomotive".to_owned(),
                "vehicle:coach".to_owned(),
                "vehicle:control-car".to_owned(),
            ],
        )
        .unwrap();

    assert!(formation.performance.mobile);
    assert!(formation.performance.front_control_stand_available);
    assert!(formation.performance.rear_control_stand_available);
    assert_eq!(formation.performance.protection_systems, set(&["pzb"]));
    assert_eq!(
        formation.vehicle_ids,
        vec![
            "vehicle:locomotive".to_owned(),
            "vehicle:coach".to_owned(),
            "vehicle:control-car".to_owned(),
        ]
    );
}

#[test]
fn unpowered_control_car_at_train_head_is_authoritative_for_protection() {
    let mut world = world();
    let mut control_car = explicit_vehicle_type(
        "type:protected-control-car",
        OperationalVehicleRole::ControlCar,
        OperationalControlStands {
            front: true,
            rear: false,
        },
    );
    control_car.protection_systems = set(&["etcs-level2", "pzb"]);
    let mut coach = explicit_vehicle_type(
        "type:middle-coach",
        OperationalVehicleRole::Coach,
        OperationalControlStands {
            front: false,
            rear: false,
        },
    );
    coach.protection_systems.clear();
    let mut locomotive = explicit_vehicle_type(
        "type:rear-locomotive",
        OperationalVehicleRole::Locomotive,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    );
    locomotive.protection_systems = set(&["lzb", "pzb"]);
    world.register_vehicle_type(control_car, false).unwrap();
    world.register_vehicle_type(coach, false).unwrap();
    world.register_vehicle_type(locomotive, true).unwrap();
    let mut control_asset = explicit_vehicle(
        "vehicle:protected-control-car",
        "type:protected-control-car",
        false,
        Direction::Along,
    );
    control_asset.restrictions.insert(
        "restriction:control-car-pzb-unavailable".to_owned(),
        VehicleRestriction::ProtectionUnavailable("pzb".to_owned()),
    );
    world.register_vehicle(control_asset).unwrap();
    world
        .register_vehicle(explicit_vehicle(
            "vehicle:middle-coach",
            "type:middle-coach",
            false,
            Direction::Along,
        ))
        .unwrap();
    world
        .register_vehicle(explicit_vehicle(
            "vehicle:rear-locomotive",
            "type:rear-locomotive",
            true,
            Direction::Along,
        ))
        .unwrap();

    let formation = world
        .create_formation(
            "formation:control-car-leading",
            None,
            vec![
                "vehicle:protected-control-car".to_owned(),
                "vehicle:middle-coach".to_owned(),
                "vehicle:rear-locomotive".to_owned(),
            ],
        )
        .unwrap();

    assert!(formation.performance.mobile);
    assert!(formation.performance.front_control_stand_available);
    assert!(formation.performance.rear_control_stand_available);
    assert_eq!(
        formation.performance.protection_systems,
        set(&["etcs-level2"])
    );
}

#[test]
fn powered_formation_rejects_vehicle_without_control_stand_at_train_head() {
    let mut world = world();
    let mut coach = explicit_vehicle_type(
        "type:leading-coach",
        OperationalVehicleRole::Coach,
        OperationalControlStands {
            front: false,
            rear: false,
        },
    );
    coach.protection_systems.clear();
    let locomotive = explicit_vehicle_type(
        "type:trailing-locomotive",
        OperationalVehicleRole::Locomotive,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    );
    world.register_vehicle_type(coach, false).unwrap();
    world.register_vehicle_type(locomotive, true).unwrap();
    world
        .register_vehicle(explicit_vehicle(
            "vehicle:leading-coach",
            "type:leading-coach",
            false,
            Direction::Along,
        ))
        .unwrap();
    world
        .register_vehicle(explicit_vehicle(
            "vehicle:trailing-locomotive",
            "type:trailing-locomotive",
            true,
            Direction::Along,
        ))
        .unwrap();

    let error = world
        .create_formation(
            "formation:invalid-leading-coach",
            None,
            vec![
                "vehicle:leading-coach".to_owned(),
                "vehicle:trailing-locomotive".to_owned(),
            ],
        )
        .unwrap_err();
    assert_eq!(
        error,
        OperationalError::InvalidFormation("formation:invalid-leading-coach".to_owned())
    );
}

#[test]
fn unpowered_coach_stock_remains_valid_but_immobile() {
    let mut world = world();
    let mut coach = explicit_vehicle_type(
        "type:unpowered-coach",
        OperationalVehicleRole::Coach,
        OperationalControlStands {
            front: false,
            rear: false,
        },
    );
    coach.protection_systems.clear();
    let control_car = explicit_vehicle_type(
        "type:unpowered-control-car",
        OperationalVehicleRole::ControlCar,
        OperationalControlStands {
            front: true,
            rear: false,
        },
    );
    world.register_vehicle_type(coach, false).unwrap();
    world.register_vehicle_type(control_car, false).unwrap();
    world
        .register_vehicle(explicit_vehicle(
            "vehicle:unpowered-coach",
            "type:unpowered-coach",
            false,
            Direction::Along,
        ))
        .unwrap();
    world
        .register_vehicle(explicit_vehicle(
            "vehicle:unpowered-control-car",
            "type:unpowered-control-car",
            false,
            Direction::Against,
        ))
        .unwrap();

    let formation = world
        .create_formation(
            "formation:unpowered-stock",
            None,
            vec![
                "vehicle:unpowered-coach".to_owned(),
                "vehicle:unpowered-control-car".to_owned(),
            ],
        )
        .unwrap();

    assert!(!formation.performance.mobile);
    assert!(!formation.performance.front_control_stand_available);
    assert!(formation.performance.rear_control_stand_available);
    assert_eq!(formation.performance.power_watts, 0);
    assert_eq!(formation.performance.acceleration_mmps2, 0);
}

#[test]
fn explicit_vehicle_metadata_is_strict_and_cannot_mix_with_legacy_formation() {
    let legacy = vehicle_type("type:legacy-validation", 10_000);
    legacy.validate(true).unwrap();

    let mut partial = legacy.clone();
    partial.id = "type:partial-metadata".to_owned();
    partial.role = Some(OperationalVehicleRole::Locomotive);
    assert_eq!(
        partial.validate(true),
        Err(OperationalError::IncompleteVehicleType(
            "type:partial-metadata".to_owned()
        ))
    );

    let invalid_control_car = explicit_vehicle_type(
        "type:control-car-without-stand",
        OperationalVehicleRole::ControlCar,
        OperationalControlStands {
            front: false,
            rear: false,
        },
    );
    assert!(matches!(
        invalid_control_car.validate(false),
        Err(OperationalError::IncompleteVehicleType(_))
    ));

    let mut powered_control_car = legacy.clone();
    powered_control_car.id = "type:control-car-with-drive-values".to_owned();
    powered_control_car.role = Some(OperationalVehicleRole::ControlCar);
    powered_control_car.control_stands = Some(OperationalControlStands {
        front: true,
        rear: false,
    });
    assert!(matches!(
        powered_control_car.validate(false),
        Err(OperationalError::IncompleteVehicleType(_))
    ));

    let locomotive = explicit_vehicle_type(
        "type:explicit-mixed-locomotive",
        OperationalVehicleRole::Locomotive,
        OperationalControlStands {
            front: true,
            rear: true,
        },
    );
    assert!(matches!(
        locomotive.validate(false),
        Err(OperationalError::IncompleteVehicleType(_))
    ));

    let mut world = world();
    world.register_vehicle_type(locomotive, true).unwrap();
    world
        .register_vehicle(explicit_vehicle(
            "vehicle:explicit-mixed-locomotive",
            "type:explicit-mixed-locomotive",
            true,
            Direction::Along,
        ))
        .unwrap();
    let error = world
        .create_formation(
            "formation:mixed-explicit-legacy",
            None,
            vec![
                "vehicle:explicit-mixed-locomotive".to_owned(),
                "vehicle:1".to_owned(),
            ],
        )
        .unwrap_err();
    assert_eq!(
        error,
        OperationalError::InvalidFormation("formation:mixed-explicit-legacy".to_owned())
    );
}

#[test]
fn automatic_shunting_uses_same_interlocking_driver_and_exact_motion() {
    let mut world = world();
    world
        .materialize_train(
            "shunt:1",
            "R 1",
            "operator:1",
            MovementKind::Shunting,
            "route:v1",
            "formation:1",
            10_000,
            None,
            false,
        )
        .unwrap();
    let selected = world
        .execute_automatic_shunting(&AutomaticShuntingNeed {
            id: "need:formation".to_owned(),
            train_id: "shunt:1".to_owned(),
            purpose: ShuntingPurpose::Formation,
            minimum_authority_end_route_mm: 40_000,
        })
        .unwrap();
    assert_eq!(selected, "interlocking:shunting");
    assert!(matches!(
        world.trains["shunt:1"].motion_state,
        MotionState::Moving
    ));
    assert!(
        world
            .events
            .iter()
            .any(|event| event.kind == "shunting-plan-derived")
    );
    assert_eq!(
        world.signal_aspects["signal:shunting"],
        SignalAspect::ShuntingProceed
    );
}

#[test]
fn passenger_departure_is_hard_but_non_passenger_can_leave_early() {
    let mut passenger_world = world();
    passenger_world
        .materialize_train(
            "passenger",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            Some(60_000),
            true,
        )
        .unwrap();
    passenger_world
        .lock_route("passenger", "interlocking:train")
        .unwrap();
    assert!(passenger_world.plan_motion("passenger").is_err());

    let mut freight = world();
    freight
        .materialize_train(
            "freight",
            "G 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            Some(60_000),
            false,
        )
        .unwrap();
    freight.lock_route("freight", "interlocking:train").unwrap();
    assert!(freight.plan_motion("freight").is_ok());
}

#[test]
fn overlong_platform_has_real_overhang_dwell_and_quality_effect() {
    let mut world = world();
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:3",
            25_000,
            None,
            false,
        )
        .unwrap();
    let (extra_dwell, quality) = world
        .short_platform_effect("train:1", "platform:short", 200)
        .unwrap();
    assert_eq!(extra_dwell, 45);
    assert!(quality > 0);
    assert_eq!(
        world.trains["train:1"].head_route_mm - world.trains["train:1"].tail_route_mm,
        20_000
    );
}

#[test]
fn disruptions_change_real_resources_and_physical_vehicle_until_release() {
    let mut world = world();
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            20_000,
            None,
            false,
        )
        .unwrap();
    world
        .activate_disruption(
            "disruption:signal",
            OperationalDisruption::SignalFailed {
                signal_id: "signal:train".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(world.signal_aspects["signal:train"], SignalAspect::Failed);
    assert!(world.lock_route("train:1", "interlocking:train").is_err());
    world
        .activate_disruption(
            "disruption:vehicle",
            OperationalDisruption::VehicleRestricted {
                vehicle_id: "vehicle:1".to_owned(),
                restriction: VehicleRestriction::MaximumSpeed(5_000),
            },
        )
        .unwrap();
    let current = &world.formations[&world.trains["train:1"].formation_version_id];
    assert_eq!(current.performance.maximum_speed_mmps, 5_000);
    assert!(
        world
            .clear_disruption("disruption:vehicle", "workshop-release:42")
            .is_ok()
    );
    let released = &world.formations[&world.trains["train:1"].formation_version_id];
    assert_eq!(released.performance.maximum_speed_mmps, 20_000);
    assert!(matches!(
        world.trains["train:1"].motion_state,
        MotionState::SafeStop { .. }
    ));
    assert!(
        world.vehicles["vehicle:1"]
            .history
            .iter()
            .any(|entry| entry.contains("released"))
    );
    world
        .activate_disruption(
            "disruption:protection",
            OperationalDisruption::VehicleRestricted {
                vehicle_id: "vehicle:1".to_owned(),
                restriction: VehicleRestriction::ProtectionUnavailable("pzb".to_owned()),
            },
        )
        .unwrap();
    assert!(world.lock_route("train:1", "interlocking:train").is_err());
}

#[test]
fn unknown_disruption_targets_are_rejected_without_partial_effects() {
    for effect in [
        OperationalDisruption::ResourceClosed {
            resource_id: "foreign-resource".into(),
        },
        OperationalDisruption::TrackDetectionFailed {
            resource_id: "foreign-resource".into(),
        },
        OperationalDisruption::SpeedRestriction {
            edge_id: "foreign-edge".into(),
            maximum_speed_mmps: 5_555,
        },
        OperationalDisruption::SignalFailed {
            signal_id: "foreign-signal".into(),
        },
        OperationalDisruption::SwitchFailed {
            switch_id: "foreign-switch".into(),
        },
        OperationalDisruption::VehicleRestricted {
            vehicle_id: "foreign-vehicle".into(),
            restriction: VehicleRestriction::MaximumSpeed(5_555),
        },
    ] {
        let mut world = world();
        let before = world.clone();
        assert!(world.activate_disruption("unknown-target", effect).is_err());
        assert_eq!(world, before);
    }
}

#[test]
fn unsafe_state_stops_without_releasing_occupation() {
    let mut world = world();
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            20_000,
            None,
            false,
        )
        .unwrap();
    let before = world.trains["train:1"].occupied_intervals.clone();
    world.safe_stop("train:1", "unknown-track-state").unwrap();
    assert!(matches!(
        world.trains["train:1"].motion_state,
        MotionState::SafeStop { .. }
    ));
    assert_eq!(world.trains["train:1"].occupied_intervals, before);
}

#[test]
fn infrastructure_failure_stops_an_authorized_movement_without_freeing_track() {
    let mut world = world();
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    world.lock_route("train:1", "interlocking:train").unwrap();
    world.plan_motion("train:1").unwrap();
    let occupied = world.trains["train:1"].occupied_intervals.clone();
    world
        .activate_disruption(
            "disruption:signal:active",
            OperationalDisruption::SignalFailed {
                signal_id: "signal:train".to_owned(),
            },
        )
        .unwrap();
    assert!(matches!(
        world.trains["train:1"].motion_state,
        MotionState::SafeStop { .. }
    ));
    assert_eq!(world.trains["train:1"].occupied_intervals, occupied);
    assert_eq!(world.signal_aspects["signal:train"], SignalAspect::Failed);
    assert_eq!(world.route_locks.len(), 1);
    assert!(world.verify_invariants().is_ok());
}

#[test]
fn checkpoint_restart_and_idempotent_state_hash_are_identical() {
    let mut world = world();
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            20_000,
            None,
            false,
        )
        .unwrap();
    world.processed_command_ids.insert("command:1".to_owned());
    let checkpoint = world.checkpoint();
    assert!(checkpoint.world.events.is_empty());
    let restored = OperationalWorld::restore(&checkpoint).unwrap();
    assert_eq!(world.state_hash(), restored.state_hash());
    assert_eq!(restored.processed_command_ids.len(), 1);

    let mut corrupted = checkpoint;
    corrupted
        .world
        .trains
        .get_mut("train:1")
        .unwrap()
        .head_route_mm += 1;
    assert!(OperationalWorld::restore(&corrupted).is_err());
}

#[test]
fn reroute_preserves_exact_occupied_geometry_and_rejects_change_while_moving() {
    let mut world = world();
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    let occupied = world.trains["train:1"].occupied_intervals.clone();
    world.reroute_train("train:1", "route:v2").unwrap();
    assert_eq!(world.trains["train:1"].occupied_intervals, occupied);
    assert_eq!(world.trains["train:1"].route_version_id, "route:v2");

    world.lock_route("train:1", "interlocking:train").unwrap();
    world.plan_motion("train:1").unwrap();
    assert!(world.reroute_train("train:1", "route:v1").is_err());
}

#[test]
fn region_handover_has_no_duplicate_or_unprotected_gap() {
    let mut source = world();
    source
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            20_000,
            None,
            false,
        )
        .unwrap();
    let mut target = OperationalWorld::new("world:1", "region:b", 0, release()).unwrap();
    let mut handover = source
        .begin_handover("handover:1", "train:1", "region:b", set(&["boundary:west"]))
        .unwrap();
    target.accept_handover(&mut handover).unwrap();
    assert!(source.trains.contains_key("train:1"));
    assert!(target.trains.contains_key("train:1"));
    assert_eq!(
        source.resource_lifecycle["boundary:west"],
        ResourceLifecycle::RouteLocked
    );
    source.finish_handover(&handover).unwrap();
    assert!(!source.trains.contains_key("train:1"));
    assert!(target.trains.contains_key("train:1"));
}

#[test]
fn dispatcher_is_stable_and_does_not_accept_caller_safety_booleans() {
    let mut world = world_with_release(release_with_independent_opposing_route());
    for (index, (id, head)) in [("train:a", 0), ("train:b", 0)].into_iter().enumerate() {
        let formation = if id.ends_with('a') {
            "formation:1"
        } else {
            "formation:2"
        };
        world
            .materialize_train(
                id,
                format!("RB {}", index + 1),
                "operator",
                MovementKind::Train,
                if id.ends_with('a') {
                    "route:v1"
                } else {
                    "route:opposing"
                },
                formation,
                head,
                None,
                false,
            )
            .unwrap();
    }
    let request = |train_id: &str, route: &str, waiting_since_ms| DispatchRequest {
        train_id: train_id.to_owned(),
        interlocking_route_id: route.to_owned(),
        committed_rank: 0,
        timetable_deviation_ms: 0,
        passenger_impact: 0,
        contractual_impact: 0,
        network_impact: 0,
        resource_consequence: 0,
        recovery_rank: 0,
        waiting_since_ms,
    };
    let selected = world
        .dispatch(&[
            request("train:b", "interlocking:opposing", 0),
            request("train:a", "interlocking:train", -10_000),
        ])
        .unwrap();
    assert_eq!(selected.as_deref(), Some("train:a"));
    assert_eq!(world.route_locks.len(), 1);
}

fn dispatch_pair_world(infra: OperationalInfraRelease) -> OperationalWorld {
    let mut world = world_with_release(infra);
    for (id, number, route, formation) in [
        ("train:a", "RB 1", "route:v1", "formation:1"),
        ("train:b", "RB 2", "route:opposing", "formation:2"),
    ] {
        world
            .materialize_train(
                id,
                number,
                "operator",
                MovementKind::Train,
                route,
                formation,
                0,
                None,
                false,
            )
            .unwrap();
    }
    world
}

#[test]
fn dispatcher_wakes_waiters_at_tail_release_while_the_leader_keeps_moving() {
    for shared_continuation_lock in [false, true] {
        let mut infra = release_with_independent_opposing_route();
        if shared_continuation_lock {
            infra
                .interlocking_routes
                .get_mut("interlocking:train:b")
                .unwrap()
                .flank_resources
                .insert("route-resource:common".to_owned());
        }
        let mut world = dispatch_pair_world(infra);
        world
            .submit_dispatch_requests(&[dispatch_request("train:a", "interlocking:train", 0)])
            .unwrap();
        assert!(
            world
                .submit_dispatch_requests(&[dispatch_request(
                    "train:b",
                    "interlocking:opposing",
                    0
                )])
                .unwrap()
                .is_empty()
        );
        let mut replay = world.clone();

        for _ in 0..32 {
            if !world
                .route_locks
                .values()
                .any(|lock| lock.template_id == "interlocking:train")
            {
                break;
            }
            let end_ms = world.trains["train:a"]
                .motion_segment
                .as_ref()
                .unwrap()
                .valid_until_ms;
            world.advance_to(end_ms).unwrap();
        }

        assert!(
            !world
                .route_locks
                .values()
                .any(|lock| lock.template_id == "interlocking:train")
        );
        let leader = &world.trains["train:a"];
        assert!(leader.head_route_mm < 120_000);
        assert_eq!(leader.motion_state, MotionState::Moving);
        let waiter = &world.trains["train:b"];
        if shared_continuation_lock {
            assert!(waiter.authority.is_none());
            assert_eq!(
                waiter.waiting_reason.as_deref(),
                Some("waiting-for-route-lock")
            );
        } else {
            assert_eq!(waiter.motion_state, MotionState::Moving);
            assert_eq!(
                waiter.authority.as_ref().unwrap().issued_at_ms,
                world.now_ms
            );
            assert!(waiter.waiting_reason.is_none());
            assert_eq!(
                serde_json::to_value(&world).unwrap()["waitingByResource"],
                serde_json::json!({})
            );
        }
        world.verify_invariants().unwrap();
        replay.advance_to(world.now_ms).unwrap();
        assert_eq!(world.state_hash(), replay.state_hash());
    }
}

#[test]
fn dispatcher_rejects_conflicting_duplicates_before_mutating_the_batch() {
    let mut world = dispatch_pair_world(release_with_independent_opposing_route());
    let request = dispatch_request("train:a", "interlocking:train", 0);
    let conflicting = DispatchRequest {
        passenger_impact: 1,
        ..request.clone()
    };
    let before = world.clone();
    for requests in [
        [request.clone(), conflicting.clone()],
        [conflicting, request.clone()],
    ] {
        assert_eq!(
            world.submit_dispatch_requests(&requests),
            Err(OperationalError::InvalidDispatchRequest(
                "train:a".to_owned()
            ))
        );
        assert_eq!(world, before);
    }
    assert_eq!(
        world
            .submit_dispatch_requests(&[request.clone(), request])
            .unwrap(),
        vec!["train:a"]
    );
    assert_eq!(
        world
            .events
            .iter()
            .filter(|event| event.kind == "dispatcher-decision")
            .count(),
        1
    );
    world.verify_invariants().unwrap();
}

#[test]
fn dispatcher_batch_preserves_priorities_and_replay_across_input_permutations() {
    for blocked_high_priority in [false, true] {
        let mut infra = release_with_independent_opposing_route();
        let opposing = infra
            .interlocking_routes
            .get_mut("interlocking:opposing")
            .unwrap();
        opposing.flank_resources.remove("route-resource:common");
        opposing.switch_positions.clear();
        let mut world = dispatch_pair_world(infra);
        if blocked_high_priority {
            world
                .activate_disruption(
                    "closed",
                    OperationalDisruption::ResourceClosed {
                        resource_id: "block:a".to_owned(),
                    },
                )
                .unwrap();
        }
        let mut replay = world.clone();
        let high = DispatchRequest {
            passenger_impact: 10,
            ..dispatch_request("train:a", "interlocking:train", 0)
        };
        let low = dispatch_request("train:b", "interlocking:opposing", 0);
        let selected = world
            .submit_dispatch_requests(&[low.clone(), high.clone()])
            .unwrap();
        let reversed = replay.submit_dispatch_requests(&[high, low]).unwrap();
        assert_eq!(
            selected,
            if blocked_high_priority {
                vec!["train:b"]
            } else {
                vec!["train:a", "train:b"]
            }
        );
        assert_eq!(selected, reversed);
        assert_eq!(world.state_hash(), replay.state_hash());
        world.verify_invariants().unwrap();
        if blocked_high_priority {
            assert_eq!(
                world.trains["train:a"].waiting_reason.as_deref(),
                Some("waiting-for-route-lock")
            );
            world
                .clear_disruption("closed", "technical-release")
                .unwrap();
            assert_eq!(world.trains["train:a"].motion_state, MotionState::Moving);
            world.verify_invariants().unwrap();
        }
    }
}

#[test]
fn motion_geometry_keeps_both_track_offsets_at_the_next_edge_boundary() {
    let mut world = dispatched_profile_world(release());
    for _ in 0..32 {
        let segment = world.trains["t"].motion_segment.as_ref().unwrap();
        if segment.segment_end_route_mm == 60_000 {
            break;
        }
        world.advance_to(segment.valid_until_ms).unwrap();
    }
    let projection = world
        .project(ProjectionKind::LiveMap, &BTreeSet::new())
        .unwrap();
    let train = &projection.trains[0];
    assert_eq!(
        train.motion_segment.as_ref().unwrap().segment_end_route_mm,
        60_000
    );
    let boundary = train
        .motion_geometry
        .iter()
        .filter(|point| point.route_mm == 60_000)
        .collect::<Vec<_>>();
    assert_eq!(boundary.len(), 2);
    assert_eq!(boundary[0].edge_id, "edge:a");
    assert_eq!(boundary[0].edge_offset_mm, 60_000);
    assert_eq!(boundary[1].edge_id, "edge:b");
    assert_eq!(boundary[1].edge_offset_mm, 60_000);
    assert_eq!(boundary[0].latitude_e7, boundary[1].latitude_e7);
    assert_eq!(boundary[0].longitude_e7, boundary[1].longitude_e7);
    let expected_head = boundary[1].clone();
    world
        .advance_to(train.motion_segment.as_ref().unwrap().valid_until_ms)
        .unwrap();
    assert_eq!(
        world
            .project(ProjectionKind::LiveMap, &BTreeSet::new())
            .unwrap()
            .trains[0]
            .head_geometry,
        expected_head
    );
}

#[test]
fn projection_carries_exact_release_vehicle_and_standing_geometry() {
    let mut world = world();
    world
        .materialize_train(
            "train:standing",
            "RB 2",
            "operator:standing",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    world
        .materialize_train(
            "train:occupied",
            "RB 1",
            "operator:occupied",
            MovementKind::Train,
            "route:v1",
            "formation:2",
            20_000,
            None,
            false,
        )
        .unwrap();

    let projection = world
        .project(ProjectionKind::LiveMap, &BTreeSet::new())
        .unwrap();
    assert_eq!(projection.infra_release_id, "infra:operational:v2");
    assert_eq!(projection.trains.len(), 2);
    assert_eq!(
        projection.stale_after_ms,
        projection.at_ms + OPERATIONAL_PROJECTION_VALIDITY_MS
    );
    let standing = projection
        .trains
        .iter()
        .find(|train| train.train_id == "train:standing")
        .unwrap();
    assert_eq!(standing.operator_id, "operator:standing");
    assert_eq!(standing.movement_kind, MovementKind::Train);
    assert_eq!(standing.direction, Direction::Along);
    assert_eq!(standing.motion_state, ProjectedMotionState::Standing);
    assert!(standing.occupied_blocks.is_empty());
    assert_eq!(standing.head_geometry.route_mm, 0);
    assert_eq!(standing.head_geometry.edge_id, "edge:a");
    assert_eq!(standing.head_geometry.edge_offset_mm, 0);
    assert!(standing.tail_geometry.is_none());
}

#[test]
fn state_hash_excludes_static_infrastructure_and_binds_all_dynamic_fields() {
    let mut world = world();
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    world.lock_route("train:1", "interlocking:train").unwrap();
    world.plan_motion("train:1").unwrap();
    let expected = world.state_hash();

    let serialized = serde_json::to_value(&world).unwrap();
    assert!(serialized.get("infra").is_none());
    assert!(serialized.get("routeVersions").is_none());
    assert!(serialized.get("edgeGeometries").is_none());

    let mut changed_train = serialized;
    changed_train["trains"]["train:1"]["waitingReason"] =
        serde_json::json!("tampered-public-state");
    let changed_train: OperationalWorld = serde_json::from_value(changed_train).unwrap();
    assert_ne!(expected, changed_train.state_hash());
}

#[test]
fn interlocking_rejects_empty_overlap_resources() {
    let mut empty_overlap = release();
    empty_overlap
        .interlocking_routes
        .get_mut("interlocking:train")
        .unwrap()
        .overlap_resources
        .clear();
    assert_eq!(
        empty_overlap.validate(),
        Err(OperationalError::InvalidInterlockingRoute(
            "interlocking:train".to_owned()
        ))
    );
}

#[test]
fn interlocking_rejects_empty_flank_resources() {
    let mut empty_flank = release();
    empty_flank
        .interlocking_routes
        .get_mut("interlocking:train")
        .unwrap()
        .flank_resources
        .clear();
    assert_eq!(
        empty_flank.validate(),
        Err(OperationalError::InvalidInterlockingRoute(
            "interlocking:train".to_owned()
        ))
    );
}

#[test]
fn infra_and_interlocking_reject_unknown_resources_and_foreign_route_templates() {
    let mut unknown_path_resource = release();
    unknown_path_resource
        .interlocking_routes
        .get_mut("interlocking:train")
        .unwrap()
        .path_resources
        .insert("unknown:path".to_owned());
    assert!(unknown_path_resource.validate().is_err());

    let mut unknown_overlap_resource = release();
    unknown_overlap_resource
        .interlocking_routes
        .get_mut("interlocking:train")
        .unwrap()
        .overlap_resources
        .insert("unknown:overlap".to_owned());
    assert!(unknown_overlap_resource.validate().is_err());

    let mut unknown_flank_resource = release();
    unknown_flank_resource
        .interlocking_routes
        .get_mut("interlocking:train")
        .unwrap()
        .flank_resources
        .insert("unknown:flank".to_owned());
    assert!(unknown_flank_resource.validate().is_err());

    let mut bound_release = release();
    let mut foreign_route = bound_release.route_versions["route:v1"].clone();
    foreign_route.id = "route:foreign".to_owned();
    foreign_route.template_id = "route-template:foreign".to_owned();
    bound_release
        .route_versions
        .insert(foreign_route.id.clone(), foreign_route);
    for (source_id, foreign_id) in [
        ("interlocking:train", "interlocking:foreign"),
        ("interlocking:train:b", "interlocking:foreign:b"),
    ] {
        let mut foreign_interlocking = bound_release.interlocking_routes[source_id].clone();
        foreign_interlocking.id = foreign_id.to_owned();
        foreign_interlocking.route_template_id = "route-template:foreign".to_owned();
        bound_release
            .interlocking_routes
            .insert(foreign_interlocking.id.clone(), foreign_interlocking);
    }
    bound_release.validate().unwrap();

    let mut world = world_with_release(bound_release);
    world
        .materialize_train(
            "train:1",
            "RB 1",
            "operator:1",
            MovementKind::Train,
            "route:v1",
            "formation:1",
            0,
            None,
            false,
        )
        .unwrap();
    assert!(world.lock_route("train:1", "interlocking:foreign").is_err());
    assert!(world.route_locks.is_empty());
}

#[test]
fn exhaustive_interval_property_never_accepts_overlap() {
    for left_head in (10_000..50_000).step_by(5_000) {
        for right_head in (10_000..50_000).step_by(5_000) {
            let mut world = world();
            world
                .materialize_train(
                    "left",
                    "L 1",
                    "operator",
                    MovementKind::Shunting,
                    "route:v1",
                    "formation:1",
                    left_head,
                    None,
                    false,
                )
                .unwrap();
            let result = world.materialize_train(
                "right",
                "R 2",
                "operator",
                MovementKind::Shunting,
                "route:v1",
                "formation:2",
                right_head,
                None,
                false,
            );
            let overlaps = left_head.saturating_sub(10_000) < right_head
                && right_head.saturating_sub(10_000) < left_head;
            assert_eq!(
                result.is_err(),
                overlaps,
                "left={left_head} right={right_head}"
            );
        }
    }
}

fn service_outcome_world(complete_contract: bool) -> (OperationalWorld, TrainMaterialization) {
    use zugfolge_sim::operational::{
        ServiceConnectionAssessment, ServiceOutcomeBinding, ServiceOutcomePolicy,
        ServiceVehicleCapacity,
    };
    let mut world = world();
    world
        .configure_service_outcomes(ServiceOutcomePolicy {
            schema_version: "zugfolge-operational-service-outcome-policy/v1".into(),
            service_ids: vec!["service".into()],
            vehicle_capacities: vec![
                ServiceVehicleCapacity {
                    vehicle_id: "vehicle:1".into(),
                    seats: 120,
                    source_reference: "fleet:verified:vehicle:1".into(),
                },
                ServiceVehicleCapacity {
                    vehicle_id: "vehicle:2".into(),
                    seats: 80,
                    source_reference: "fleet:verified:vehicle:2".into(),
                },
            ],
        })
        .unwrap();
    let train = TrainMaterialization {
        stop_plan: None,
        id: "service:day-0".into(),
        train_number: "RE 42".into(),
        operator_id: "operator:1".into(),
        movement_kind: MovementKind::Train,
        route_version_id: "route:v1".into(),
        formation_version_id: "formation:1".into(),
        head_route_mm: 0,
        scheduled_departure_ms: Some(0),
        public_passenger_stop: true,
        service_outcome: Some(ServiceOutcomeBinding {
            schema_version: "zugfolge-operational-service-outcome-binding/v1".into(),
            service_id: "service".into(),
            service_run_id: "service:service-day:2026-09-05".into(),
            lot_id: "lot:1".into(),
            service_day: "2026-09-05".into(),
            scheduled_arrival_ms: 1_000,
            required_seats: complete_contract.then_some(100),
            connection_assessment: if complete_contract {
                ServiceConnectionAssessment::NoneContracted
            } else {
                ServiceConnectionAssessment::Unavailable
            },
        }),
    };
    (world, train)
}

fn service_outcomes(world: &OperationalWorld) -> Vec<serde_json::Value> {
    world
        .events
        .iter()
        .filter(|event| event.kind == "train-outcome")
        .map(|event| serde_json::from_str(&event.detail).unwrap())
        .collect()
}

#[test]
fn service_outcome_uses_actual_motion_capacity_and_survives_checkpoint_exactly_once() {
    let (mut world, input) = service_outcome_world(true);
    world.materialize(input).unwrap();
    assert!(service_outcomes(&world).is_empty());
    world
        .change_formation(
            "service:day-0",
            "formation:changed",
            vec!["vehicle:2".into()],
        )
        .unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request("service:day-0", "interlocking:train", 0)])
        .unwrap();
    world.advance_to(1_000).unwrap();
    let mut restored = OperationalWorld::restore(&world.checkpoint()).unwrap();
    world.events.clear();
    for candidate in [&mut world, &mut restored] {
        candidate.advance_to(1_000_000).unwrap();
        candidate.verify_invariants().unwrap();
        let outcomes = service_outcomes(candidate);
        assert_eq!(outcomes.len(), 1);
        let outcome = &outcomes[0];
        assert_eq!(outcome["distanceMm"], "120000");
        assert_eq!(outcome["minimumSeatsProvided"], 80);
        assert_eq!(outcome["missingSeats"], 20);
        assert_eq!(outcome["missedConnections"], 0);
        assert_eq!(outcome["evidenceComplete"], true);
        assert!(outcome["actualArrivalMs"].as_i64().unwrap() < candidate.now_ms);
        candidate.advance_to(2_000_000).unwrap();
        assert_eq!(service_outcomes(candidate).len(), 1);
    }
    assert_eq!(world.events, restored.events);
    assert_eq!(world.state_hash(), restored.state_hash());
}

#[test]
fn service_outcome_does_not_invent_missing_contract_obligations_or_a_cancellation() {
    let (mut world, input) = service_outcome_world(false);
    world.materialize(input).unwrap();
    world
        .safe_stop("service:day-0", "authority-missing")
        .unwrap();
    world.advance_to(2_000).unwrap();
    assert!(service_outcomes(&world).is_empty());
    assert_eq!(
        world
            .events
            .iter()
            .filter(|event| event.kind == "train-service-planned")
            .count(),
        1
    );
    let (mut world, input) = service_outcome_world(false);
    world.materialize(input).unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request("service:day-0", "interlocking:train", 0)])
        .unwrap();
    world.advance_to(1_000_000).unwrap();
    let outcome = service_outcomes(&world).remove(0);
    assert_eq!(outcome["minimumSeatsProvided"], 120);
    assert_eq!(outcome["missingSeats"], serde_json::Value::Null);
    assert_eq!(outcome["missedConnections"], serde_json::Value::Null);
    assert_eq!(outcome["evidenceComplete"], false);
}

#[test]
fn service_outcome_binding_requires_signed_policy_and_rejects_duplicate_materialization() {
    let (mut world, input) = service_outcome_world(true);
    let mut without_policy = world_with_release(release());
    assert_eq!(
        without_policy.materialize(input.clone()),
        Err(OperationalError::InvalidServiceOutcome)
    );
    world.materialize(input.clone()).unwrap();
    let before = world.state_hash();
    assert_eq!(
        world.materialize(input),
        Err(OperationalError::DuplicateId("service:day-0".into()))
    );
    assert_eq!(world.state_hash(), before);
}

#[test]
fn service_outcome_receipt_rejects_same_day_after_retirement_and_allows_next_day() {
    let (mut world, input) = service_outcome_world(true);
    world.materialize(input.clone()).unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request("service:day-0", "interlocking:train", 0)])
        .unwrap();
    world.advance_to(1_000_000).unwrap();
    world.retire_train("service:day-0").unwrap();
    let before = world.state_hash();
    assert_eq!(
        world.materialize(input.clone()),
        Err(OperationalError::InvalidServiceOutcome)
    );
    assert_eq!(world.state_hash(), before);
    let mut next = input;
    next.id = "service:day-1".into();
    let binding = next.service_outcome.as_mut().unwrap();
    binding.service_day = "2026-09-06".into();
    binding.service_run_id = "service:service-day:2026-09-06".into();
    binding.scheduled_arrival_ms += 86_400_000;
    world.materialize(next).unwrap();
    world.verify_invariants().unwrap();
    let value = serde_json::to_value(&world).unwrap();
    assert_eq!(
        value["serviceOutcomeState"]["latestStartedDay"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn service_outcome_rejects_invalid_dates_unknown_services_and_restored_capacity_tampering() {
    let (mut world, input) = service_outcome_world(true);
    for day in ["2026-99-99", "2026-02-29", "2026-04-31"] {
        let mut invalid = input.clone();
        let binding = invalid.service_outcome.as_mut().unwrap();
        binding.service_day = day.into();
        binding.service_run_id = format!("service:service-day:{day}");
        assert_eq!(
            world.materialize(invalid),
            Err(OperationalError::InvalidServiceOutcome)
        );
    }
    world.materialize(input).unwrap();
    for field in ["startHeadRouteMm", "minimumSeatsProvided"] {
        let mut encoded = serde_json::to_value(&world).unwrap();
        encoded["trains"]["service:day-0"]["serviceOutcome"][field] = serde_json::json!(999999);
        let corrupted: OperationalWorld = serde_json::from_value(encoded).unwrap();
        assert_eq!(
            corrupted.verify_invariants(),
            Err(OperationalError::InvalidServiceOutcome)
        );
    }
}

#[test]
fn service_outcome_handover_transfers_measurements_and_keeps_semantic_replay_fence() {
    let (mut source, input) = service_outcome_world(true);
    let (mut target, _) = service_outcome_world(true);
    target.region_id = "region:b".into();
    target.vehicles.clear();
    target.formations.clear();
    source.materialize(input.clone()).unwrap();
    source
        .submit_dispatch_requests(&[dispatch_request("service:day-0", "interlocking:train", 0)])
        .unwrap();
    let mut handover = source
        .begin_handover(
            "outcome:handover",
            "service:day-0",
            "region:b",
            set(&["boundary:west"]),
        )
        .unwrap();
    target.accept_handover(&mut handover).unwrap();
    source.finish_handover(&handover).unwrap();
    source.verify_invariants().unwrap();
    target.advance_to(1_000_000).unwrap();
    assert_eq!(service_outcomes(&target).len(), 1);
    assert_eq!(service_outcomes(&target)[0]["distanceMm"], "120000");
    target.retire_train("service:day-0").unwrap();
    assert_eq!(
        target.materialize(input),
        Err(OperationalError::InvalidServiceOutcome)
    );
}
