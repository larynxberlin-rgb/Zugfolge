//! Abnahmetests fuer die eine autoritative Betriebswirklichkeit.

use std::collections::{BTreeMap, BTreeSet};

use zugfolge_sim::operational::{
    AutomaticShuntingNeed, Direction, DispatchRequest, EdgeGeometryPoint,
    FormationDynamicsDerivationError, FormationDynamicsDerivationInput, FormationVersion,
    InterlockingRouteTemplate, MotionState, MovementKind, OPERATIONAL_PROJECTION_VALIDITY_MS,
    OperationalControlStands, OperationalDisruption, OperationalError, OperationalInfraRelease,
    OperationalPowerSystem, OperationalVehicleRole, OperationalVehicleTraction, OperationalWorld,
    PROTECTION_MODE_SELECTION_POLICY_V1, PhysicalVehicle, ProjectedMotionState, ProjectionKind,
    ProtectionModeSelectionRun, ResourceLifecycle, RouteLeg, RouteVersion, ShuntingPurpose,
    SignalAspect, TrackInterval, TrainMaterialization, VehicleCondition, VehicleRestriction,
    VehicleType, VehicleTypeRawFormationDynamics, derive_formation_dynamics,
    operational_train_number_numeric_part,
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
        signal_id: "signal:train".to_owned(),
        movement_kind: MovementKind::Train,
        path_resources: set(&["block:a", "block:b", "route-resource:common"]),
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
        path_resources: set(&["block:a", "block:b", "route-resource:common"]),
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
            "overlap:yard",
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

fn program_template(
    id: &str,
    movement_kind: MovementKind,
    head_route_mm: i64,
) -> TrainMaterialization {
    TrainMaterialization {
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
    let interlocking = infra_release
        .interlocking_routes
        .get_mut("interlocking:train")
        .expect("Test-Fahrstrasse");
    interlocking.authority_end_route_mm = 120_000;
    interlocking.release_after_tail_route_mm = 120_000;
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
    let opposing = infra_release
        .interlocking_routes
        .get_mut("interlocking:opposing")
        .expect("Test-Gegenfahrstrasse");
    opposing.route_template_id = "route-template:opposing".to_owned();
    opposing.path_resources = set(&["block:c", "route-resource:common"]);
    opposing.authority_end_route_mm = 120_000;
    opposing.release_after_tail_route_mm = 90_000;
    infra_release
}

#[test]
fn zugsicherungsmenge_ist_one_of_in_template_materialize_authority_und_fahrt() {
    let mut world = world_with_release(release_with_route_protection(&["lzb", "pzb"]));
    let template = program_template("train:overlaid-protection", MovementKind::Train, 20_000);
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
    let template = program_template("train:full-route-resources", MovementKind::Train, 20_000);
    let complete = complete_world
        .inspect_train_program_template(&template, "interlocking:train")
        .expect("vollstaendige Full-Route-Bindung ist aufloesbar");
    assert!(complete.authority_path_resources_cover_route);
    assert!(complete.is_valid());
    assert!(complete.failed_predicates().is_empty());
    assert_eq!(complete.resource_binding_count, 5);

    let mut last_leg_only_release = release_with_route_protection(&["lzb", "pzb"]);
    last_leg_only_release
        .interlocking_routes
        .get_mut("interlocking:train")
        .expect("Test-Fahrstrasse")
        .path_resources = set(&["block:b", "route-resource:common"]);
    let last_leg_only_world = world_with_release(last_leg_only_release);
    let last_leg_only = last_leg_only_world
        .inspect_train_program_template(&template, "interlocking:train")
        .expect("alle Referenzen bleiben trotz unvollstaendiger Ressourcenbindung aufloesbar");
    assert!(!last_leg_only.authority_path_resources_cover_route);
    assert!(!last_leg_only.is_valid());
    assert_eq!(
        last_leg_only.failed_predicates(),
        ["authority-path-resources-cover-route"]
    );
    assert_eq!(last_leg_only.resource_binding_count, 4);
    assert_eq!(
        last_leg_only_world.validate_train_program_template(&template, "interlocking:train"),
        Err(OperationalError::InvalidProgramTemplate(template.id))
    );
}

#[test]
fn disjunkte_und_reine_lzb_etcs_mengen_bleiben_fail_closed() {
    for exclusive_system in ["lzb", "etcs-level2"] {
        let mut world = world_with_release(release_with_route_protection(&[exclusive_system]));
        let template = program_template(
            &format!("train:pure-{exclusive_system}"),
            MovementKind::Train,
            20_000,
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
            20_000,
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
            20_000,
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
    let template = program_template("train:simultaneous-protection", MovementKind::Train, 20_000);
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
            "authority-end",
        ]
    );
    assert!(predicates.route_template_matches);
    assert!(!predicates.authority_end_matches_route);
    assert!(predicates.release_after_tail_within_authority);
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
    let moving_projection = world
        .project(ProjectionKind::LiveMap, &BTreeSet::new())
        .unwrap();
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
            "route:opposing",
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
fn full_route_lock_is_released_atomically_when_positive_length_train_retires() {
    let mut world = world_with_release(release_with_route_protection(&["lzb", "pzb"]));
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
    assert_eq!(world.route_locks.len(), 1);
    assert_eq!(world.signal_aspects["signal:train"], SignalAspect::Proceed);

    world.retire_train("train:1").unwrap();

    assert!(!world.trains.contains_key("train:1"));
    assert!(world.route_locks.is_empty());
    assert!(!world.signal_aspects.contains_key("signal:train"));
    for resource in [
        "block:a",
        "block:b",
        "route-resource:common",
        "overlap:1",
        "flank:1",
    ] {
        assert!(!world.resource_lifecycle.contains_key(resource));
    }

    world
        .materialize_train(
            "train:2",
            "RB 2",
            "operator:2",
            MovementKind::Train,
            "route:v1",
            "formation:2",
            20_000,
            None,
            false,
        )
        .unwrap();
    world.lock_route("train:2", "interlocking:train").unwrap();
    world.verify_invariants().unwrap();
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
    let mut world = world_with_release(release_with_independent_opposing_route());
    for (index, (id, head)) in [("train:a", 20_000), ("train:b", 50_000)]
        .into_iter()
        .enumerate()
    {
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
            20_000,
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
