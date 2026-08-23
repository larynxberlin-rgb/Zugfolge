//! Abnahmetests fuer die eine autoritative Betriebswirklichkeit.

use std::collections::{BTreeMap, BTreeSet};

use zugfolge_sim::operational::{
    AutomaticShuntingNeed, Direction, DispatchRequest, EdgeGeometryPoint, FormationVersion,
    InterlockingRouteTemplate, MotionState, MovementKind, OPERATIONAL_PROJECTION_VALIDITY_MS,
    OperationalDisruption, OperationalInfraRelease, OperationalWorld, PhysicalVehicle,
    ProjectedMotionState, ProjectionKind, ResourceLifecycle, RouteLeg, RouteVersion,
    ShuntingPurpose, SignalAspect, TrackInterval, VehicleCondition, VehicleRestriction,
    VehicleType,
};

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
                required_protection_systems: set(&["pzb"]),
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
                required_protection_systems: set(&["pzb"]),
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
        signal_id: "signal:train".to_owned(),
        movement_kind: MovementKind::Train,
        path_resources: set(&["route-resource:common"]),
        overlap_resources: set(&["overlap:1"]),
        flank_resources: set(&["flank:1"]),
        switch_positions: BTreeMap::from([("switch:1".to_owned(), "left".to_owned())]),
        authority_end_route_mm: 100_000,
        release_after_tail_route_mm: 90_000,
    };
    let opposing = InterlockingRouteTemplate {
        id: "interlocking:opposing".to_owned(),
        route_template_id: "route-template".to_owned(),
        signal_id: "signal:opposing".to_owned(),
        movement_kind: MovementKind::Train,
        path_resources: set(&["route-resource:common"]),
        overlap_resources: set(&["overlap:2"]),
        flank_resources: set(&["flank:2"]),
        switch_positions: BTreeMap::from([("switch:1".to_owned(), "right".to_owned())]),
        authority_end_route_mm: 100_000,
        release_after_tail_route_mm: 90_000,
    };
    let shunting = InterlockingRouteTemplate {
        id: "interlocking:shunting".to_owned(),
        route_template_id: "route-template".to_owned(),
        signal_id: "signal:shunting".to_owned(),
        movement_kind: MovementKind::Shunting,
        path_resources: set(&["route-resource:yard"]),
        overlap_resources: BTreeSet::new(),
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
            (opposing.id.clone(), opposing),
            (shunting.id.clone(), shunting),
        ]),
        signals: set(&["signal:train", "signal:opposing", "signal:shunting"]),
        switches: set(&["switch:1"]),
        block_resources: set(&[
            "block:a",
            "block:b",
            "route-resource:common",
            "route-resource:yard",
            "overlap:1",
            "overlap:2",
            "flank:1",
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
        length_mm,
        mass_kg: 80_000,
        maximum_speed_mmps: 20_000,
        power_watts: 4_000_000,
        starting_tractive_force_newtons: 240_000,
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
            20_000,
            None,
            false,
        )
        .unwrap();
    let authority = world.lock_route("train:1", "interlocking:train").unwrap();
    let segment = world.plan_motion("train:1").unwrap();
    assert_eq!(segment.segment_end_route_mm, 60_000);
    let moving_projection = world.project(ProjectionKind::LiveMap, &BTreeSet::new());
    assert_eq!(moving_projection.trains[0].motion_geometry.len(), 2);
    assert_eq!(
        moving_projection.trains[0].motion_geometry[1].route_mm,
        60_000
    );
    world.advance_to(segment.valid_until_ms).unwrap();
    let train = &world.trains["train:1"];
    assert_eq!(train.head_route_mm, 60_000);
    assert_eq!(train.direction, Direction::Against);
    assert!(train.head_route_mm <= authority.end_route_mm);
    assert!(train.tail_route_mm <= train.head_route_mm);
    let braking = train
        .motion_segment
        .clone()
        .expect("Bremsgrenze plant Folgesegment");
    assert!(braking.acceleration_mmps2 < 0);
    assert!(braking.start_speed_mmps > 0);
    world.advance_to(braking.valid_until_ms).unwrap();
    let stopped = &world.trains["train:1"];
    assert_eq!(stopped.head_route_mm, authority.end_route_mm);
    assert_eq!(stopped.speed_mmps, 0);
    assert_eq!(stopped.motion_state, MotionState::Standing);
    let map = world.project(ProjectionKind::LiveMap, &BTreeSet::new());
    let rzue = world.project(ProjectionKind::Rzue, &BTreeSet::new());
    assert_eq!(map.commit_sequence, rzue.commit_sequence);
    assert_eq!(map.trains, rzue.trains);
}

#[test]
fn incompatible_routes_never_lock_together_and_protect_overlap_and_flank() {
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
        .materialize_train(
            "train:2",
            "RB 2",
            "operator:2",
            MovementKind::Train,
            "route:v1",
            "formation:2",
            50_000,
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
            20_000,
            None,
            false,
        )
        .unwrap();
    world.lock_route("train:1", "interlocking:train").unwrap();
    let segment = world.plan_motion("train:1").unwrap();
    world.advance_to(segment.valid_until_ms).unwrap();
    assert!(world.trains["train:1"].tail_route_mm < 90_000);
    assert_eq!(world.route_locks.len(), 1);
    assert_ne!(
        world.resource_lifecycle["overlap:1"],
        ResourceLifecycle::Free
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
            10_000,
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
            10_000,
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
            20_000,
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
            20_000,
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
    let mut world = world();
    for (id, head) in [("train:a", 20_000), ("train:b", 50_000)] {
        let formation = if id.ends_with('a') {
            "formation:1"
        } else {
            "formation:2"
        };
        world
            .materialize_train(
                id,
                id,
                "operator",
                MovementKind::Train,
                "route:v1",
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

#[test]
fn projection_carries_exact_release_vehicle_and_standing_geometry() {
    let mut world = world();
    world
        .materialize_train(
            "train:standing",
            "RB 0",
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

    let projection = world.project(ProjectionKind::LiveMap, &BTreeSet::new());
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
fn state_hash_binds_infra_geometry_and_all_serialized_operational_fields() {
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
    world.lock_route("train:1", "interlocking:train").unwrap();
    world.plan_motion("train:1").unwrap();
    let expected = world.state_hash();

    let mut changed_infra = serde_json::to_value(&world).unwrap();
    changed_infra["infra"]["edgeGeometries"]["edge:a"][0]["longitudeE7"] =
        serde_json::json!(120_000_001);
    let changed_infra: OperationalWorld = serde_json::from_value(changed_infra).unwrap();
    assert_ne!(expected, changed_infra.state_hash());

    let mut changed_train = serde_json::to_value(&world).unwrap();
    changed_train["trains"]["train:1"]["waitingReason"] =
        serde_json::json!("tampered-public-state");
    let changed_train: OperationalWorld = serde_json::from_value(changed_train).unwrap();
    assert_ne!(expected, changed_train.state_hash());
}

#[test]
fn infra_and_interlocking_reject_unknown_resources_and_foreign_route_templates() {
    let mut unknown_resource = release();
    unknown_resource
        .interlocking_routes
        .get_mut("interlocking:train")
        .unwrap()
        .flank_resources
        .insert("unknown:flank".to_owned());
    assert!(unknown_resource.validate().is_err());

    let mut bound_release = release();
    let mut foreign_route = bound_release.route_versions["route:v1"].clone();
    foreign_route.id = "route:foreign".to_owned();
    foreign_route.template_id = "route-template:foreign".to_owned();
    let mut foreign_interlocking = bound_release.interlocking_routes["interlocking:train"].clone();
    foreign_interlocking.id = "interlocking:foreign".to_owned();
    foreign_interlocking.route_template_id = "route-template:foreign".to_owned();
    bound_release
        .route_versions
        .insert(foreign_route.id.clone(), foreign_route);
    bound_release
        .interlocking_routes
        .insert(foreign_interlocking.id.clone(), foreign_interlocking);
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
            20_000,
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
                    "L",
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
                "R",
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
