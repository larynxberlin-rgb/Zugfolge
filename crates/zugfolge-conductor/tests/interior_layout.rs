//! Explizit fiktive Spielkonfigurationen durch den echten M5-Compiler und Runtimekern.
use serde_json::{Value, json};
use std::collections::BTreeSet;
use zugfolge_conductor::*;
use zugfolge_demand::*;
use zugfolge_fleet::release_catalog::{
    compile_vehicle_catalog, parse_source_catalog, parse_world_seed,
};

fn fixture(index: usize) -> BuildInteriorLayoutInputV1 {
    fixture_variant(index, None, None, false)
}
fn fixture_variant(
    index: usize,
    density: Option<zugfolge_fleet::SeatingDensityV1>,
    seat_type: Option<zugfolge_fleet::SeatTypeV1>,
    reversed: bool,
) -> BuildInteriorLayoutInputV1 {
    let source = parse_source_catalog(include_str!(
        "../../zugfolge-fleet/tests/fixtures/vehicle-catalog-source-v2-interior.json"
    ))
    .unwrap();
    let mut seed = parse_world_seed(include_str!(
        "../../zugfolge-fleet/tests/fixtures/vehicle-world-seed-v3-interior.json"
    ))
    .unwrap();
    for asset in &mut seed.assets {
        let config = asset.vehicle_configuration.as_mut().unwrap();
        if let Some(density) = density {
            config.interior.density = density;
        }
        if let Some(seat_type) = seat_type {
            config.interior.seat_type = seat_type;
        }
        if reversed {
            asset.orientation = zugfolge_sim::operational::Direction::Against;
        }
    }
    let compiled = compile_vehicle_catalog(&source, &seed).unwrap();
    let init:Value=serde_json::from_str(&zugfolge_runtime::initialize_fleet_world(&json!({"schemaVersion":"zugfolge-fleet-world-initialize/v2","worldId":seed.world_id,"producedAt":seed.produced_at,"authorityRelease":compiled.fleet_authority}).to_string()).unwrap()).unwrap();
    let result:Value=serde_json::from_str(&zugfolge_runtime::apply_fleet_command(&init["state"].to_string(),&json!({"schemaVersion":"zugfolge-fleet-form-vehicles-command/v2","worldId":seed.world_id,"commandId":"interior-proof","expectedStateHash":init["stateHash"],"expectedRevision":0,"atS":101,"formationId":format!("fixture-interior-formation-{index}"),"vehicleIds":[format!("fixture-interior-vehicle-{index}")],"pathReceiptId":"fixture-path-1"}).to_string(),None).unwrap()).unwrap();
    let mut policy = InteriorGeometryPolicyV1 {
        schema_version: GEOMETRY_POLICY_SCHEMA.into(),
        policy_id: "fixture-generic-mm-v1".into(),
        vehicle_types: vec![],
    };
    for asset in &compiled.fleet_authority.assets {
        let double = asset.vehicle_type_id == 102;
        let count = asset
            .vehicle_configuration
            .as_ref()
            .unwrap()
            .structural
            .door_count_per_side;
        let mut bodies = vec![];
        for b in 0..3 {
            let doors = match (count, b) {
                (4, 0) => vec![7000, 17000],
                (4, 1) => vec![12000],
                (4, _) => vec![11000],
                (6, _) => vec![7000, 17000],
                (8, 0 | 1) => vec![5000, 12000, 19000],
                _ => vec![5000, 17000],
            };
            bodies.push(InteriorBodyGeometryV1 {
                body_id: format!("body-{b}"),
                length_mm: if b == 2 { 22000 } else { 24000 },
                width_mm: 3000,
                deck_ids: if double {
                    vec![InteriorDeckIdV1::Lower, InteriorDeckIdV1::Upper]
                } else {
                    vec![InteriorDeckIdV1::Main]
                },
                entrance_deck_id: if double {
                    InteriorDeckIdV1::Lower
                } else {
                    InteriorDeckIdV1::Main
                },
                door_positions_mm: doors,
                stairs: if double {
                    vec![InteriorStairGeometryV1 {
                        stair_id: format!("stair-{b}"),
                        from_deck_id: InteriorDeckIdV1::Lower,
                        to_deck_id: InteriorDeckIdV1::Upper,
                        at_mm: 3500,
                    }]
                } else {
                    vec![]
                },
                gap_after_mm: 0,
                front_gangway: b > 0,
                rear_gangway: b < 2,
            });
        }
        policy.vehicle_types.push(InteriorVehicleGeometryV1 {
            vehicle_type_id: asset.vehicle_type_id,
            configuration_hash: Some(
                vehicle_configuration_hash(asset.vehicle_configuration.as_ref().unwrap()).unwrap(),
            ),
            art_family: if double {
                "regional-double"
            } else {
                "regional-single"
            }
            .into(),
            bodies,
        });
    }
    BuildInteriorLayoutInputV1 {
        schema_version: LAYOUT_INPUT_SCHEMA.into(),
        binding: InteriorLayoutBindingV1 {
            world_id: seed.world_id,
            period_id: "period-1".into(),
            operator_id: "fixture-operator".into(),
            formation_id: format!("fixture-interior-formation-{index}"),
            formation_revision: result["snapshot"]["revision"].as_u64().unwrap(),
            fleet_state_hash: result["stateHash"].as_str().unwrap().into(),
            fleet_authority_release_id: compiled.fleet_authority.release_id.clone(),
            fleet_authority_release_hash: interior_authority_hash(&compiled.fleet_authority)
                .unwrap(),
            mobilization_snapshot_hash: result["snapshotHash"].as_str().unwrap().into(),
            geometry_policy_hash: interior_geometry_policy_hash(&policy).unwrap(),
            art_release_id: "test-only-art-v2".into(),
            art_manifest_hash: "a".repeat(64),
        },
        authority_release: compiled.fleet_authority,
        mobilization: serde_json::from_value(result["snapshot"].clone()).unwrap(),
        geometry_policy: policy,
    }
}
fn rehash(input: &mut BuildInteriorLayoutInputV1) {
    input.binding.geometry_policy_hash =
        interior_geometry_policy_hash(&input.geometry_policy).unwrap();
    input.binding.fleet_authority_release_hash =
        interior_authority_hash(&input.authority_release).unwrap();
    input.binding.mobilization_snapshot_hash = input.mobilization.sha256().unwrap();
}
fn assert_error(input: &BuildInteriorLayoutInputV1, code: &str) {
    assert!(
        build_interior_layout(input).unwrap_err().0.contains(code),
        "{code}"
    );
}

#[test]
fn alle_freigegebenen_konfigurationen_haben_exakte_kapazitaet_und_erreichbare_interaktionen() {
    for index in 1..=3 {
        let input = fixture(index);
        let layout = build_interior_layout(&input).unwrap();
        let config = layout.vehicles[0].configuration.as_ref().unwrap();
        assert_eq!(
            layout.passenger_places.len(),
            usize::from(config.interior.first_class_seats)
                + usize::from(config.interior.second_class_seats)
                + usize::from(config.interior.multipurpose.standing)
        );
        assert_eq!(
            layout.seats.len(),
            usize::from(config.interior.first_class_seats)
                + usize::from(config.interior.second_class_seats)
        );
        assert_eq!(
            layout.doors.len(),
            2 * usize::from(config.structural.door_count_per_side)
        );
        assert_eq!(
            layout.special_bays.len(),
            usize::from(
                config.interior.multipurpose.bicycles
                    + config.interior.multipurpose.pushchairs
                    + config.interior.multipurpose.wheelchairs
            )
        );
        for interaction in &layout.interactions {
            let path = find_interior_path(&FindInteriorPathInputV1 {
                schema_version: "conductor-interior-path-input/v1".into(),
                layout: layout.clone(),
                expected_layout_hash: layout.layout_hash.clone(),
                from_node_id: layout.entrance_node_id.clone(),
                to_node_id: interaction.node_id.clone(),
                wheelchair: matches!(
                    interaction.kind,
                    InteriorInteractionKindV1::Wheelchair
                        | InteriorInteractionKindV1::AccessibleToilet
                ),
            })
            .unwrap();
            assert_eq!(path.node_ids.last(), Some(&interaction.node_id));
        }
        let restored: InteriorLayoutV1 =
            serde_json::from_str(&serde_json::to_string(&layout).unwrap()).unwrap();
        assert_eq!(interior_layout_hash(&restored).unwrap(), layout.layout_hash);
        if index == 2 {
            assert!(
                layout
                    .passenger_places
                    .iter()
                    .any(|p| p.deck_id == InteriorDeckIdV1::Upper)
            );
            assert!(
                layout
                    .seats
                    .iter()
                    .any(|s| s.facing == InteriorSeatFacingV1::Backward)
            );
        } else {
            assert!(
                layout
                    .passenger_places
                    .iter()
                    .all(|p| p.deck_id == InteriorDeckIdV1::Main)
            );
        }
    }
}

#[test]
fn policy_permutation_und_wiederholung_bleiben_bytegleich() {
    for index in 1..=3 {
        let mut input = fixture(index);
        let expected = build_interior_layout(&input).unwrap();
        input.geometry_policy.vehicle_types.reverse();
        for p in &mut input.geometry_policy.vehicle_types {
            for b in &mut p.bodies {
                b.door_positions_mm.reverse();
                b.stairs.reverse();
            }
        }
        input.authority_release.assets.reverse();
        rehash(&mut input);
        let actual = build_interior_layout(&input).unwrap();
        assert_eq!(actual.passenger_places, expected.passenger_places);
        assert_eq!(actual.nodes, expected.nodes);
        assert_eq!(actual.entrance_node_id, expected.entrance_node_id);
    }
}

#[test]
fn fehlende_konfiguration_decks_tueren_und_uebergaenge_scheitern_konkret() {
    let input = fixture(2);
    let mut missing = input.clone();
    missing.authority_release.assets[1].vehicle_configuration = None;
    rehash(&mut missing);
    assert_error(&missing, "vehicle_configuration_missing");
    let mut missing = input.clone();
    missing.geometry_policy.vehicle_types[1].bodies[0]
        .stairs
        .clear();
    rehash(&mut missing);
    assert_error(&missing, "interior_stair_missing");
    let mut missing = input.clone();
    missing.geometry_policy.vehicle_types[1].bodies[0]
        .door_positions_mm
        .pop();
    rehash(&mut missing);
    assert_error(&missing, "interior_door_count_mismatch");
    let mut missing = input.clone();
    missing.geometry_policy.vehicle_types[1].bodies[0].rear_gangway = false;
    rehash(&mut missing);
    assert_error(&missing, "formation_passenger_area_disconnected");
    let mut missing = input.clone();
    missing.binding.period_id.clear();
    assert_error(&missing, "invalid_interior_binding");
    let mut missing = input.clone();
    missing.binding.world_id = "wrong-world".into();
    assert_error(&missing, "interior_formation_scope_mismatch");
    let mut missing = input.clone();
    missing.binding.geometry_policy_hash = "f".repeat(64);
    assert_error(&missing, "interior_policy_hash_mismatch");
}

#[test]
fn bewegung_prueft_sitzkollision_teleport_treppen_und_exakte_uebergangslaenge() {
    let layout = build_interior_layout(&fixture(2)).unwrap();
    let check = |from, to, transition, wheelchair| {
        check_interior_movement(&CheckInteriorMovementInputV1 {
            schema_version: "conductor-interior-movement-input/v1".into(),
            layout: layout.clone(),
            expected_layout_hash: layout.layout_hash.clone(),
            from,
            to,
            transition_edge_id: transition,
            wheelchair,
        })
        .unwrap()
        .allowed
    };
    for edge in &layout.edges {
        let a = &layout
            .nodes
            .iter()
            .find(|n| n.node_id == edge.from_node_id)
            .unwrap()
            .point;
        let b = &layout
            .nodes
            .iter()
            .find(|n| n.node_id == edge.to_node_id)
            .unwrap()
            .point;
        if edge.kind == InteriorEdgeKindV1::Walk {
            assert!(check(a.clone(), b.clone(), None, false));
        } else {
            assert!(!check(a.clone(), b.clone(), None, false));
            assert!(check(
                a.clone(),
                b.clone(),
                Some(edge.edge_id.clone()),
                false
            ));
            if edge.kind == InteriorEdgeKindV1::Stair {
                assert!(!check(
                    a.clone(),
                    b.clone(),
                    Some(edge.edge_id.clone()),
                    true
                ));
            } else {
                assert_eq!(edge.length_mm, 1200);
            }
        }
    }
    let seat = &layout
        .passenger_places
        .iter()
        .find(|p| p.kind == InteriorPlaceKindV1::Seat)
        .unwrap();
    let collision = InteriorPointV1 {
        vehicle_id: seat.vehicle_id.clone(),
        body_id: seat.body_id.clone(),
        deck_id: seat.deck_id,
        x_mm: seat.x_mm,
        y_mm: seat.y_mm,
    };
    assert!(!check(collision.clone(), collision, None, false));
}

fn demand(layout: &InteriorLayoutV1) -> DemandEvaluationInputV1 {
    let mut input: DemandEvaluationInputV1 = serde_json::from_str(include_str!(
        "../../zugfolge-demand/examples/evaluation.json"
    ))
    .unwrap();
    input.world_id = layout.binding.world_id.clone();
    input.services.truncate(1);
    input.alternatives.clear();
    input.services[0].world_id = input.world_id.clone();
    input.services[0].operator_id = layout.binding.operator_id.clone();
    input.services[0].capacity = layout.capacity.clone();
    input.release.zones[0].population = 10_000;
    input.release.max_generated_passengers = 100_000;
    let prototype = input.release.profiles[0].clone();
    input.release.profiles.clear();
    for (index, need) in [
        SpaceNeedsV1::Ordinary,
        SpaceNeedsV1::Wheelchair,
        SpaceNeedsV1::Bicycle,
        SpaceNeedsV1::Stroller,
    ]
    .into_iter()
    .enumerate()
    {
        let mut profile = prototype.clone();
        profile.id = format!("profile-{index}");
        profile.space_needs = need;
        input.release.profiles.push(profile);
    }
    let mut premium = prototype;
    premium.id = "profile-premium".into();
    premium.comfort_class = ComfortClassV1::Premium;
    input.release.profiles.push(premium);
    let mut fare = input.services[0].fares[0].clone();
    fare.id = "premium-test".into();
    fare.comfort_class = ComfortClassV1::Premium;
    input.services[0].fares.push(fare);
    input
}
fn advance(
    input: &DemandEvaluationInputV1,
    previous: DemandEvaluationV1,
    next_stop: bool,
) -> DemandEvaluationInputV1 {
    let mut next = input.clone();
    next.revision += 1;
    next.now_ms = if next_stop { 2_000_000 } else { 700_000 };
    next.previous_evaluation = Some(Box::new(PreviousDemandEvaluationV1 {
        result: previous,
        services: input.services.clone(),
    }));
    let mut stops = vec![StopOperationalProgressV1 {
        stop_id: "regional-leipzig".into(),
        actual_arrival_ms: None,
        actual_departure_ms: Some(600_000),
    }];
    if next_stop {
        stops.push(StopOperationalProgressV1 {
            stop_id: "regional-halle".into(),
            actual_arrival_ms: Some(1_850_000),
            actual_departure_ms: Some(1_950_000),
        });
    }
    next.operational_progress = Some(DemandOperationalProgressV1 {
        schema_version: "demand-operational-progress/v1".into(),
        world_id: next.world_id.clone(),
        as_of_ms: next.now_ms,
        receipt_id: format!("actual-test-receipt-{}", next.revision),
        trains: vec![TrainOperationalProgressV1 {
            train_run_id: "regional-1".into(),
            stops,
        }],
    });
    next
}
fn projection_input(
    layout: &InteriorLayoutV1,
    input: &DemandEvaluationInputV1,
    result: DemandEvaluationV1,
) -> ProjectConductorPassengersInputV2 {
    let interior = bind_interior_passenger_places(&BindInteriorPassengerPlacesInputV1 {
        schema_version: "conductor-interior-bind-input/v1".into(),
        layout: layout.clone(),
        train_run_id: "regional-1".into(),
        service: input.services[0].clone(),
    })
    .unwrap();
    let binding = ConductorPassengerBindingV1 {
        world_id: result.world_id.clone(),
        period_id: result.period_id.clone(),
        demand_release_id: result.demand_release_id.clone(),
        release_hash: result.release_hash.clone(),
        seed_hash: result.seed_hash.clone(),
        train_run_id: "regional-1".into(),
        operator_id: layout.binding.operator_id.clone(),
        manifest_revision: result.revision,
        demand_state_hash: result.state_hash.clone(),
        operational_receipt_id: result
            .operational_progress
            .as_ref()
            .map_or("forecast", |p| p.receipt_id.as_str())
            .into(),
    };
    ProjectConductorPassengersInputV2 {
        schema_version: PROJECTION_INPUT_V2_SCHEMA.into(),
        binding,
        evaluation: result,
        service: input.services[0].clone(),
        interior,
        previous_projection: None,
    }
}

#[test]
fn echte_m10_vollbelegung_bewahrt_alle_plaetze_sonderflaechen_und_restore_ueber_halte() {
    for index in 1..=3 {
        let layout = build_interior_layout(&fixture(index)).unwrap();
        let mut initial = demand(&layout);
        initial.seed = "0".into();
        let forecast = evaluate_demand(&initial).unwrap();
        assert!(
            project_conductor_passengers_v2(&projection_input(&layout, &initial, forecast.clone()))
                .unwrap_err()
                .0
                .contains("demand_forecast_not_boarded")
        );
        let started = advance(&initial, forecast, false);
        let evaluated = evaluate_demand(&started).unwrap();
        let mut input = projection_input(&layout, &started, evaluated.clone());
        let output = project_conductor_passengers_v2(&input).unwrap();
        assert_eq!(output.passengers.len(), layout.passenger_places.len());
        assert_eq!(
            output
                .passengers
                .iter()
                .filter(|p| p.space_needs == SpaceNeedsV1::Wheelchair)
                .count(),
            usize::try_from(layout.capacity.wheelchair_spaces).unwrap()
        );
        assert_eq!(
            output
                .passengers
                .iter()
                .filter_map(|p| p.space_id.as_ref())
                .collect::<BTreeSet<_>>()
                .len(),
            layout.special_bays.len()
        );
        assert!(
            output
                .passengers
                .iter()
                .any(|p| p.space_needs == SpaceNeedsV1::Wheelchair
                    && p.posture == PassengerPostureV1::Seated)
        );
        for p in &output.passengers {
            if let Some(space) = &p.space_id {
                let bay = input
                    .interior
                    .special_bays
                    .iter()
                    .find(|b| &b.space_id == space)
                    .unwrap();
                assert_eq!(p.vehicle_id, bay.vehicle_id);
                if p.space_needs == SpaceNeedsV1::Wheelchair {
                    assert_eq!(
                        (p.x_mm, p.y_mm, p.deck_id),
                        (bay.x_mm, bay.y_mm, bay.deck_id)
                    );
                }
            }
        }
        input.previous_projection =
            Some(serde_json::from_str(&serde_json::to_string(&output).unwrap()).unwrap());
        assert_eq!(project_conductor_passengers_v2(&input).unwrap(), output);
        let next = advance(&started, evaluated, true);
        let next_result = evaluate_demand(&next).unwrap();
        let mut next_input = projection_input(&layout, &next, next_result);
        let cold = project_conductor_passengers_v2(&next_input).unwrap();
        next_input.previous_projection = Some(output);
        assert_eq!(project_conductor_passengers_v2(&next_input).unwrap(), cold);
        let serialized = serde_json::to_string(&cold).unwrap();
        for private in [
            "fareFact",
            "journeyChainId",
            "boardingStopId",
            "reservationId",
        ] {
            assert!(!serialized.contains(private));
        }
    }
}

#[test]
fn eigenschaftsmatrix_dichte_sitztyp_aussichtung_und_alle_sechs_artfamilien() {
    use zugfolge_fleet::{SeatTypeV1::*, SeatingDensityV1::*};
    for density in [Dense, Standard, Spacious] {
        for seat_type in [Row, FaceToFace, Folding] {
            for reversed in [false, true] {
                let baseline = fixture_variant(2, Some(density), Some(seat_type), reversed);
                for family in ["regional-double", "intercity-double"] {
                    let mut input = baseline.clone();
                    input.geometry_policy.vehicle_types[1].art_family = family.into();
                    rehash(&mut input);
                    let layout = build_interior_layout(&input).unwrap();
                    assert_eq!(layout.passenger_places.len(), 220);
                    assert_eq!(layout.special_bays.len(), 16);
                    assert_eq!(layout.doors.len(), 12);
                    assert_eq!(
                        layout
                            .passenger_places
                            .iter()
                            .map(|p| (&p.vehicle_id, &p.body_id, p.deck_id, p.x_mm, p.y_mm))
                            .collect::<BTreeSet<_>>()
                            .len(),
                        220
                    );
                    assert_eq!(
                        layout
                            .seats
                            .iter()
                            .any(|s| s.facing == InteriorSeatFacingV1::Backward),
                        seat_type == FaceToFace
                    );
                    assert!(
                        layout.vehicles[0]
                            .bodies
                            .iter()
                            .all(|b| b.reversed == reversed)
                    );
                    for edge in layout
                        .edges
                        .iter()
                        .filter(|e| e.kind == InteriorEdgeKindV1::Gangway)
                    {
                        assert_eq!(edge.length_mm, 1200);
                    }
                }
            }
        }
    }
    for index in [1, 3] {
        for reversed in [false, true] {
            for family in ["regional-single", "intercity-single", "dining", "sleeper"] {
                let mut input = fixture_variant(index, None, None, reversed);
                input.geometry_policy.vehicle_types[index - 1].art_family = family.into();
                rehash(&mut input);
                let layout = build_interior_layout(&input).unwrap();
                assert_eq!(
                    layout.passenger_places.len(),
                    if index == 1 { 160 } else { 144 }
                );
                assert!(
                    layout
                        .passenger_places
                        .iter()
                        .all(|p| p.deck_id == InteriorDeckIdV1::Main)
                );
            }
        }
    }
}

#[test]
fn ueberfuellte_und_extreme_geometrie_bleibt_fail_closed() {
    let mut input = fixture(1);
    let asset = &mut input.authority_release.assets[0];
    asset.passenger.seats = 200;
    asset
        .vehicle_configuration
        .as_mut()
        .unwrap()
        .interior
        .second_class_seats = 184;
    input.geometry_policy.vehicle_types[0].configuration_hash =
        Some(vehicle_configuration_hash(asset.vehicle_configuration.as_ref().unwrap()).unwrap());
    let formation = input
        .mobilization
        .formations
        .iter_mut()
        .find(|f| f.id == input.binding.formation_id)
        .unwrap();
    formation.characteristics.seats = 200;
    formation.characteristics.first_class_basis_points = 800;
    rehash(&mut input);
    assert_error(&input, "interior_seat_capacity_gap");
    let mut input = fixture(2);
    input.geometry_policy.vehicle_types[1].bodies[0].stairs[0].at_mm = u32::MAX;
    rehash(&mut input);
    assert_error(&input, "invalid_interior_stair");
    let mut input = fixture(2);
    input.geometry_policy.vehicle_types[1].bodies[0].door_positions_mm[0] = u32::MAX;
    rehash(&mut input);
    assert_error(&input, "invalid_interior_door");
    let mut layout = build_interior_layout(&fixture(1)).unwrap();
    layout.obstacles[0].rect.x_mm = i64::MAX;
    layout.layout_hash = interior_layout_hash(&layout).unwrap();
    let node = layout.nodes[0].point.clone();
    assert!(
        check_interior_movement(&CheckInteriorMovementInputV1 {
            schema_version: "conductor-interior-movement-input/v1".into(),
            expected_layout_hash: layout.layout_hash.clone(),
            layout,
            from: node.clone(),
            to: node,
            transition_edge_id: None,
            wheelchair: false
        })
        .unwrap_err()
        .0
        .contains("invalid_interior_obstacle")
    );
}

#[test]
fn v2_weist_doppelte_bays_fremde_decks_restore_und_scope_ab() {
    let layout = build_interior_layout(&fixture(2)).unwrap();
    let mut initial = demand(&layout);
    initial.seed = "0".into();
    let started = advance(&initial, evaluate_demand(&initial).unwrap(), false);
    let input = projection_input(&layout, &started, evaluate_demand(&started).unwrap());
    let expected = project_conductor_passengers_v2(&input).unwrap();
    let mut wrong = input.clone();
    wrong.interior.special_bays[0].space_need = SpaceNeedsV1::Ordinary;
    wrong.interior.layout_hash = interior_places_v2_hash(&wrong.interior).unwrap();
    assert!(
        project_conductor_passengers_v2(&wrong)
            .unwrap_err()
            .0
            .contains("invalid_interior_special_bay")
    );
    let mut wrong = input.clone();
    wrong
        .interior
        .special_bays
        .push(wrong.interior.special_bays[0].clone());
    wrong.interior.layout_hash = interior_places_v2_hash(&wrong.interior).unwrap();
    assert!(project_conductor_passengers_v2(&wrong).is_err());
    let mut wrong = input.clone();
    wrong.binding.period_id = "wrong-period".into();
    assert!(
        project_conductor_passengers_v2(&wrong)
            .unwrap_err()
            .0
            .contains("demand_scope_mismatch")
    );
    let mut wrong = input.clone();
    let mut old = expected.clone();
    old.passengers[0].deck_id = InteriorDeckIdV1::Main;
    old.state_hash.clear();
    old.state_hash = sha256(&old);
    wrong.previous_projection = Some(old);
    assert!(
        project_conductor_passengers_v2(&wrong)
            .unwrap_err()
            .0
            .contains("invalid_previous_deck_position")
    );
    let mut wrong = input.clone();
    let mut old = expected.clone();
    let indexes: Vec<_> = old
        .passengers
        .iter()
        .enumerate()
        .filter(|(_, p)| p.space_needs == SpaceNeedsV1::Bicycle)
        .map(|(i, _)| i)
        .collect();
    old.passengers[indexes[1]].space_id = old.passengers[indexes[0]].space_id.clone();
    old.state_hash.clear();
    old.state_hash = sha256(&old);
    wrong.previous_projection = Some(old);
    assert!(
        project_conductor_passengers_v2(&wrong)
            .unwrap_err()
            .0
            .contains("invalid_previous_special_bay")
    );
    let mut reordered = input.clone();
    reordered.interior.places.reverse();
    reordered.interior.special_bays.reverse();
    assert_eq!(
        project_conductor_passengers_v2(&reordered).unwrap(),
        expected
    );
}

fn sha256(value: &impl serde::Serialize) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(serde_json::to_vec(value).unwrap())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn sichtbare_v2_variation_ist_vom_fahrausweisfakt_unabhaengig() {
    let layout = build_interior_layout(&fixture(1)).unwrap();
    let mut initial = demand(&layout);
    initial.seed = "0".into();
    let started = advance(&initial, evaluate_demand(&initial).unwrap(), false);
    let mut input = projection_input(&layout, &started, evaluate_demand(&started).unwrap());
    let expected = project_conductor_passengers_v2(&input).unwrap();
    for manifest in &mut input.evaluation.manifests {
        for passenger in &mut manifest.passengers {
            passenger.fare_fact = FareFactV1::Invalid;
        }
    }
    input.evaluation.state_hash.clear();
    input.evaluation.state_hash = sha256(&input.evaluation);
    input.binding.demand_state_hash = input.evaluation.state_hash.clone();
    let actual = project_conductor_passengers_v2(&input).unwrap();
    assert_eq!(actual.passengers, expected.passengers);
}

#[test]
fn m10_rollstuhl_ohne_sitznummer_behaelt_stehstatus_und_eine_exklusive_bay() {
    let layout = build_interior_layout(&fixture(1)).unwrap();
    let mut initial = demand(&layout);
    initial.release.zones.retain(|zone| zone.id != "halle");
    for zone in &mut initial.release.zones {
        zone.population = if zone.id == "leipzig" {
            layout.capacity.standard_seats
        } else {
            0
        };
        zone.workplaces = 1;
    }
    initial.release.day_slices[0].share_basis_points = 10_000;
    initial.release.day_slices[1].share_basis_points = 0;
    initial.release.profiles.truncate(2);
    let (_, forecast) = (0..32)
        .find_map(|seed| {
            initial.seed = seed.to_string();
            let result = evaluate_demand(&initial).unwrap();
            result
                .manifests
                .iter()
                .any(|m| {
                    m.passengers.iter().any(|p| {
                        p.space_needs == SpaceNeedsV1::Wheelchair && p.seat_number.is_none()
                    })
                })
                .then_some((seed, result))
        })
        .expect("M10-Stehfall");
    let started = advance(&initial, forecast, false);
    let input = projection_input(&layout, &started, evaluate_demand(&started).unwrap());
    let output = project_conductor_passengers_v2(&input).unwrap();
    let wheels: Vec<_> = output
        .passengers
        .iter()
        .filter(|p| p.space_needs == SpaceNeedsV1::Wheelchair)
        .collect();
    assert_eq!(wheels.len(), 2);
    assert!(
        wheels
            .iter()
            .all(|p| p.posture == PassengerPostureV1::Standing && p.space_id.is_some())
    );
    assert_eq!(
        wheels
            .iter()
            .filter_map(|p| p.space_id.as_ref())
            .collect::<BTreeSet<_>>()
            .len(),
        2
    );
}
