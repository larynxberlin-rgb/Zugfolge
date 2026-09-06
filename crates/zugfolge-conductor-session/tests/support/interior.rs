//! Explizit fiktive Spielkonfigurationen durch den echten M5-Compiler und Runtimekern.
use serde_json::{Value, json};

use zugfolge_conductor::*;
use zugfolge_demand::*;
use zugfolge_fleet::release_catalog::{
    compile_vehicle_catalog, parse_source_catalog, parse_world_seed,
};

pub fn fixture(index: usize) -> BuildInteriorLayoutInputV1 {
    fixture_variant(index, None, None, false)
}
fn fixture_variant(
    index: usize,
    density: Option<zugfolge_fleet::SeatingDensityV1>,
    seat_type: Option<zugfolge_fleet::SeatTypeV1>,
    reversed: bool,
) -> BuildInteriorLayoutInputV1 {
    let source = parse_source_catalog(include_str!(
        "../../../zugfolge-fleet/tests/fixtures/vehicle-catalog-source-v2-interior.json"
    ))
    .unwrap();
    let mut seed = parse_world_seed(include_str!(
        "../../../zugfolge-fleet/tests/fixtures/vehicle-world-seed-v3-interior.json"
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
pub fn demand(layout: &InteriorLayoutV1) -> DemandEvaluationInputV1 {
    let mut input: DemandEvaluationInputV1 = serde_json::from_str(include_str!(
        "../../../zugfolge-demand/examples/evaluation.json"
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
pub fn projection_input(
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
