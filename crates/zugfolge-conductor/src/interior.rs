use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use zugfolge_demand::TrainCapacityV1;
use zugfolge_fleet::{
    MobilizationAvailability, MobilizationProcurement, VehicleConfigurationFacts,
    VehicleConfigurationV1,
    release_catalog::{AuthorityVehicleAsset, FleetAuthorityRelease, VehicleRole},
};

use crate::{ConductorError, interior_geometry, interior_movement, interior_types::*};

pub(crate) const MAX_LAYOUT_PLACES: usize = 20_000;
pub(crate) const MAX_SAFE: u64 = 9_007_199_254_740_991;

pub(crate) fn fail(code: &str, vehicle: Option<&str>, body: Option<&str>) -> ConductorError {
    ConductorError(
        serde_json::to_string(&InteriorLayoutIssueV1 {
            code: code.into(),
            vehicle_id: vehicle.map(str::to_owned),
            body_id: body.map(str::to_owned),
        })
        .expect("feste Diagnose"),
    )
}
pub(crate) fn require(ok: bool, code: &str) -> Result<(), ConductorError> {
    if ok {
        Ok(())
    } else {
        Err(fail(code, None, None))
    }
}
pub(crate) fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}
pub(crate) fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(crate) fn json_hash(value: &impl Serialize) -> Result<String, ConductorError> {
    Ok(Sha256::digest(serde_json::to_vec(value)?)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
pub(crate) fn key(kind: &str, parts: &[&str]) -> String {
    format!("{kind}-{}", &crate::engine::digest(parts)[..32])
}

pub fn vehicle_configuration_hash(
    configuration: &VehicleConfigurationV1,
) -> Result<String, ConductorError> {
    configuration
        .validate()
        .map_err(|_| fail("invalid_vehicle_configuration", None, None))?;
    let mut canonical = configuration.clone();
    canonical.normalize();
    json_hash(&canonical)
}
pub fn interior_authority_hash(
    authority: &FleetAuthorityRelease,
) -> Result<String, ConductorError> {
    json_hash(authority)
}
pub fn interior_geometry_policy_hash(
    policy: &InteriorGeometryPolicyV1,
) -> Result<String, ConductorError> {
    let mut canonical = policy.clone();
    canonical.vehicle_types.sort_by(|a, b| {
        (&a.vehicle_type_id, &a.configuration_hash)
            .cmp(&(&b.vehicle_type_id, &b.configuration_hash))
    });
    for profile in &mut canonical.vehicle_types {
        for body in &mut profile.bodies {
            body.door_positions_mm.sort_unstable();
            body.stairs.sort_by(|a, b| a.stair_id.cmp(&b.stair_id));
        }
    }
    json_hash(&canonical)
}
pub fn interior_layout_hash(layout: &InteriorLayoutV1) -> Result<String, ConductorError> {
    let mut canonical = layout.clone();
    canonical.layout_hash.clear();
    canonical
        .passenger_places
        .sort_by(|a, b| a.place_id.cmp(&b.place_id));
    for place in &mut canonical.passenger_places {
        place.space_needs.sort();
    }
    canonical
        .special_bays
        .sort_by(|a, b| a.space_id.cmp(&b.space_id));
    canonical
        .obstacles
        .sort_by(|a, b| a.obstacle_id.cmp(&b.obstacle_id));
    canonical.nodes.sort_by(|a, b| a.node_id.cmp(&b.node_id));
    canonical.edges.sort_by(|a, b| a.edge_id.cmp(&b.edge_id));
    canonical
        .interactions
        .sort_by(|a, b| a.interaction_id.cmp(&b.interaction_id));
    canonical.doors.sort_by(|a, b| a.door_id.cmp(&b.door_id));
    canonical.seats.sort_by(|a, b| a.place_id.cmp(&b.place_id));
    json_hash(&canonical)
}
pub(crate) fn zero_capacity() -> TrainCapacityV1 {
    TrainCapacityV1 {
        standard_seats: 0,
        standard_standing: 0,
        premium_seats: 0,
        wheelchair_spaces: 0,
        bicycle_spaces: 0,
        stroller_spaces: 0,
    }
}
pub(crate) fn add_capacity(total: &mut TrainCapacityV1, other: &TrainCapacityV1) {
    total.standard_seats += other.standard_seats;
    total.standard_standing += other.standard_standing;
    total.premium_seats += other.premium_seats;
    total.wheelchair_spaces += other.wheelchair_spaces;
    total.bicycle_spaces += other.bicycle_spaces;
    total.stroller_spaces += other.stroller_spaces;
}
pub(crate) fn capacity(configuration: &VehicleConfigurationV1) -> TrainCapacityV1 {
    let interior = &configuration.interior;
    TrainCapacityV1 {
        standard_seats: u32::from(interior.second_class_seats),
        standard_standing: u32::from(interior.multipurpose.standing),
        premium_seats: u32::from(interior.first_class_seats),
        wheelchair_spaces: u32::from(interior.multipurpose.wheelchairs),
        bicycle_spaces: u32::from(interior.multipurpose.bicycles),
        stroller_spaces: u32::from(interior.multipurpose.pushchairs),
    }
}

fn validate_asset(asset: &AuthorityVehicleAsset) -> Result<Option<String>, ConductorError> {
    require(
        id(&asset.id) && asset.technical.length_mm > 0 && asset.technical.length_mm <= 500_000,
        "invalid_interior_vehicle",
    )?;
    if asset.technical.role == VehicleRole::Locomotive
        && asset.passenger.seats == 0
        && asset.vehicle_configuration.is_none()
    {
        return Ok(None);
    }
    let config = asset
        .vehicle_configuration
        .as_ref()
        .ok_or_else(|| fail("vehicle_configuration_missing", Some(&asset.id), None))?;
    config
        .validate_against(VehicleConfigurationFacts {
            length_mm: asset.technical.length_mm,
            seats: asset.passenger.seats,
            first_class_seats: asset.passenger.first_class_seats,
            bicycle_places: asset.passenger.bicycle_places,
            wheelchair_places: asset.passenger.wheelchair_places,
            accessible: asset.passenger.accessible,
        })
        .map_err(|_| {
            fail(
                "vehicle_configuration_authority_mismatch",
                Some(&asset.id),
                None,
            )
        })?;
    config
        .validate_equipment(&asset.passenger.equipment)
        .map_err(|_| {
            fail(
                "vehicle_configuration_equipment_mismatch",
                Some(&asset.id),
                None,
            )
        })?;
    Ok(Some(vehicle_configuration_hash(config)?))
}

fn validate_profile(
    profile: &InteriorVehicleGeometryV1,
    asset: &AuthorityVehicleAsset,
) -> Result<(), ConductorError> {
    let vehicle = Some(asset.id.as_str());
    let check = |ok, code| {
        if ok {
            Ok(())
        } else {
            Err(fail(code, vehicle, None))
        }
    };
    check(
        !profile.bodies.is_empty()
            && profile.bodies.len() <= 32
            && [
                "regional-single",
                "regional-double",
                "intercity-single",
                "intercity-double",
                "dining",
                "sleeper",
            ]
            .contains(&profile.art_family.as_str()),
        "invalid_interior_geometry_profile",
    )?;
    let mut bodies = BTreeSet::new();
    let mut length = 0_u64;
    let mut doors = 0_usize;
    let config = asset.vehicle_configuration.as_ref();
    for (index, body) in profile.bodies.iter().enumerate() {
        let body_check = |ok, code| {
            if ok {
                Ok(())
            } else {
                Err(fail(code, vehicle, Some(&body.body_id)))
            }
        };
        body_check(
            id(&body.body_id)
                && bodies.insert(&body.body_id)
                && (5_000..=32_000).contains(&body.length_mm)
                && (2_400..=3_200).contains(&body.width_mm)
                && body.gap_after_mm <= 3_000,
            "invalid_interior_body",
        )?;
        body_check(
            index + 1 < profile.bodies.len() || body.gap_after_mm == 0,
            "interior_trailing_gap",
        )?;
        let single = body.deck_ids == [InteriorDeckIdV1::Main]
            && body.entrance_deck_id == InteriorDeckIdV1::Main;
        let double = body.deck_ids == [InteriorDeckIdV1::Lower, InteriorDeckIdV1::Upper]
            && body.entrance_deck_id == InteriorDeckIdV1::Lower;
        body_check(single || double, "invalid_interior_decks")?;
        body_check(
            (profile.art_family.ends_with("-double") && double)
                || (!profile.art_family.ends_with("-double") && single),
            "interior_art_deck_mismatch",
        )?;
        body_check(
            (single && body.stairs.is_empty())
                || (double && !body.stairs.is_empty() && body.stairs.len() <= 4),
            "interior_stair_missing",
        )?;
        let mut stairs = BTreeSet::new();
        for stair in &body.stairs {
            body_check(
                id(&stair.stair_id)
                    && stairs.insert(&stair.stair_id)
                    && stair.from_deck_id == InteriorDeckIdV1::Lower
                    && stair.to_deck_id == InteriorDeckIdV1::Upper
                    && stair.at_mm >= 1_500
                    && stair.at_mm <= body.length_mm.saturating_sub(1_500),
                "invalid_interior_stair",
            )?;
        }
        let mut centers = body.door_positions_mm.clone();
        centers.sort_unstable();
        let width = config.map_or(0, |c| u32::from(c.structural.door_width_mm));
        body_check(
            centers.len() <= 32 && (centers.is_empty() || width >= 900),
            "invalid_interior_door",
        )?;
        for center in &centers {
            body_check(
                *center >= 1_000 + width / 2
                    && *center <= body.length_mm.saturating_sub(width / 2 + 1_000),
                "invalid_interior_door",
            )?;
        }
        body_check(
            centers
                .windows(2)
                .all(|pair| pair[1] - pair[0] >= width + 600),
            "interior_door_overlap",
        )?;
        doors += centers.len();
        length += u64::from(body.length_mm) + u64::from(body.gap_after_mm);
    }
    check(
        length == u64::try_from(asset.technical.length_mm).expect("positive"),
        "interior_body_length_mismatch",
    )?;
    check(
        config.is_none_or(|c| doors == usize::from(c.structural.door_count_per_side)),
        "interior_door_count_mismatch",
    )
}

pub fn build_interior_layout(
    input: &BuildInteriorLayoutInputV1,
) -> Result<InteriorLayoutV1, ConductorError> {
    let binding = &input.binding;
    require(
        input.schema_version == LAYOUT_INPUT_SCHEMA
            && input.geometry_policy.schema_version == GEOMETRY_POLICY_SCHEMA
            && input.authority_release.schema_version == "zugfolge-fleet-authority-release/v2",
        "unsupported_interior_schema",
    )?;
    require(
        [
            &binding.world_id,
            &binding.period_id,
            &binding.operator_id,
            &binding.formation_id,
            &binding.fleet_authority_release_id,
            &binding.art_release_id,
            &input.geometry_policy.policy_id,
        ]
        .into_iter()
        .all(|s| id(s))
            && [
                &binding.fleet_state_hash,
                &binding.fleet_authority_release_hash,
                &binding.mobilization_snapshot_hash,
                &binding.geometry_policy_hash,
                &binding.art_manifest_hash,
            ]
            .into_iter()
            .all(|s| hash(s))
            && binding.formation_revision > 0
            && binding.formation_revision <= MAX_SAFE,
        "invalid_interior_binding",
    )?;
    require(
        input.mobilization.world_id == binding.world_id
            && input.mobilization.revision == binding.formation_revision,
        "interior_formation_scope_mismatch",
    )?;
    require(
        input.authority_release.release_id == binding.fleet_authority_release_id
            && interior_authority_hash(&input.authority_release)?
                == binding.fleet_authority_release_hash,
        "interior_authority_hash_mismatch",
    )?;
    require(
        input
            .mobilization
            .sha256()
            .map_err(|_| fail("invalid_interior_mobilization", None, None))?
            == binding.mobilization_snapshot_hash,
        "interior_mobilization_hash_mismatch",
    )?;
    require(
        interior_geometry_policy_hash(&input.geometry_policy)? == binding.geometry_policy_hash
            && input.geometry_policy.vehicle_types.len() <= 1024,
        "interior_policy_hash_mismatch",
    )?;
    let mut policy = input.geometry_policy.clone();
    for profile in &mut policy.vehicle_types {
        for body in &mut profile.bodies {
            body.door_positions_mm.sort_unstable();
            body.stairs.sort_by(|a, b| a.stair_id.cmp(&b.stair_id));
        }
    }
    let profiles: BTreeMap<_, _> = policy
        .vehicle_types
        .iter()
        .map(|profile| {
            (
                (profile.vehicle_type_id, profile.configuration_hash.clone()),
                profile,
            )
        })
        .collect();
    require(
        profiles.len() == input.geometry_policy.vehicle_types.len(),
        "duplicate_interior_geometry_profile",
    )?;
    let formation = input
        .mobilization
        .formations
        .iter()
        .find(|f| f.id == binding.formation_id)
        .ok_or_else(|| fail("interior_formation_missing", None, None))?;
    require(
        formation.operator_id == binding.operator_id
            && formation.procurement == MobilizationProcurement::Delivered
            && matches!(
                formation.availability,
                MobilizationAvailability::Available | MobilizationAvailability::Committed
            )
            && formation.available_from <= input.mobilization.produced_at
            && formation.available_until > input.mobilization.produced_at
            && !formation.vehicle_ids.is_empty()
            && formation.vehicle_ids.len() <= 32,
        "interior_formation_unavailable",
    )?;
    let assets: BTreeMap<_, _> = input
        .authority_release
        .assets
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect();
    require(
        assets.len() == input.authority_release.assets.len()
            && formation.vehicle_ids.iter().collect::<BTreeSet<_>>().len()
                == formation.vehicle_ids.len(),
        "duplicate_interior_vehicle",
    )?;
    let mut selected = Vec::new();
    let mut total = zero_capacity();
    for vehicle_id in &formation.vehicle_ids {
        let asset = assets
            .get(vehicle_id.as_str())
            .ok_or_else(|| fail("interior_vehicle_missing", Some(vehicle_id), None))?;
        // Heutiger Halter folgt dem verifizierten Mobilisierungsbeleg, nicht dem ursprünglichen Authority-Eigentümer.
        require(
            asset.delivered_at <= input.mobilization.produced_at
                && asset.retired_at > input.mobilization.produced_at,
            "interior_vehicle_unavailable",
        )?;
        let config_hash = validate_asset(asset)?;
        let profile = profiles
            .get(&(asset.vehicle_type_id, config_hash.clone()))
            .ok_or_else(|| fail("interior_geometry_profile_missing", Some(vehicle_id), None))?;
        validate_profile(profile, asset)?;
        if let Some(configuration) = &asset.vehicle_configuration {
            add_capacity(&mut total, &capacity(configuration));
        }
        selected.push((*asset, *profile, config_hash));
    }
    require(
        u64::from(total.standard_seats)
            + u64::from(total.standard_standing)
            + u64::from(total.premium_seats)
            <= u64::try_from(MAX_LAYOUT_PLACES).expect("bounded"),
        "interior_capacity_limit",
    )?;
    let seats = total.standard_seats + total.premium_seats;
    require(
        seats > 0
            && seats == formation.characteristics.seats
            && u64::from(total.premium_seats) * 10_000 / u64::from(seats)
                == u64::from(formation.characteristics.first_class_basis_points)
            && total.bicycle_spaces == u32::from(formation.characteristics.bicycle_places)
            && total.wheelchair_spaces == u32::from(formation.characteristics.wheelchair_places),
        "interior_mobilization_capacity_mismatch",
    )?;
    let mut layout = interior_geometry::generate(binding, selected, total)?;
    interior_movement::validate_connectivity(&layout)?;
    layout.layout_hash = interior_layout_hash(&layout)?;
    Ok(layout)
}

pub fn build_interior_layout_json(json: &str) -> Result<String, ConductorError> {
    require(json.len() <= 128 * 1024 * 1024, "interior_input_size_limit")?;
    Ok(serde_json::to_string(&build_interior_layout(
        &serde_json::from_str(json)?,
    )?)?)
}

pub(crate) fn verify_layout(
    layout: &InteriorLayoutV1,
    expected_hash: &str,
) -> Result<(), ConductorError> {
    require(
        layout.schema_version == LAYOUT_SCHEMA
            && hash(expected_hash)
            && layout.layout_hash == expected_hash
            && interior_layout_hash(layout)? == expected_hash,
        "interior_layout_hash_mismatch",
    )?;
    require(
        layout.passenger_places.len() <= MAX_LAYOUT_PLACES
            && layout.nodes.len() <= 100_000
            && layout.edges.len() <= 200_000
            && layout.obstacles.len() <= 100_000,
        "interior_layout_size_limit",
    )?;
    let bodies: BTreeMap<_, _> = layout
        .vehicles
        .iter()
        .flat_map(|vehicle| &vehicle.bodies)
        .map(|body| ((body.vehicle_id.as_str(), body.body_id.as_str()), body))
        .collect();
    require(
        !bodies.is_empty()
            && bodies.len() <= 1024
            && bodies.values().all(|body| {
                (5_000..=32_000).contains(&body.length_mm)
                    && (2_400..=3_200).contains(&body.width_mm)
            }),
        "invalid_interior_body",
    )?;
    for obstacle in &layout.obstacles {
        let body = bodies
            .get(&(obstacle.vehicle_id.as_str(), obstacle.body_id.as_str()))
            .ok_or_else(|| fail("interior_obstacle_body_missing", None, None))?;
        let rect = &obstacle.rect;
        require(
            body.deck_ids.contains(&obstacle.deck_id)
                && (0..=32_000).contains(&rect.x_mm)
                && (0..=3_200).contains(&rect.y_mm)
                && (1..=32_000).contains(&rect.length_mm)
                && (1..=3_200).contains(&rect.width_mm)
                && rect.x_mm + rect.length_mm <= i64::from(body.length_mm)
                && rect.y_mm + rect.width_mm <= i64::from(body.width_mm),
            "invalid_interior_obstacle",
        )?;
    }
    for node in &layout.nodes {
        let point = &node.point;
        let body = bodies
            .get(&(point.vehicle_id.as_str(), point.body_id.as_str()))
            .ok_or_else(|| fail("interior_node_body_missing", None, None))?;
        require(
            body.deck_ids.contains(&point.deck_id)
                && (0..=i64::from(body.length_mm)).contains(&point.x_mm)
                && (0..=i64::from(body.width_mm)).contains(&point.y_mm),
            "invalid_interior_node",
        )?;
    }
    Ok(())
}

pub fn bind_interior_passenger_places(
    input: &BindInteriorPassengerPlacesInputV1,
) -> Result<InteriorPassengerPlacesV2, ConductorError> {
    require(
        input.schema_version == "conductor-interior-bind-input/v1" && id(&input.train_run_id),
        "unsupported_interior_bind_schema",
    )?;
    verify_layout(&input.layout, &input.layout.layout_hash)?;
    require(
        input.service.world_id == input.layout.binding.world_id
            && input.service.operator_id == input.layout.binding.operator_id
            && input.service.train_run_id == input.train_run_id
            && input.service.capacity == input.layout.capacity,
        "interior_train_binding_mismatch",
    )?;
    let mut places = InteriorPassengerPlacesV2 {
        schema_version: INTERIOR_V2_SCHEMA.into(),
        world_id: input.layout.binding.world_id.clone(),
        train_run_id: input.train_run_id.clone(),
        layout_id: input.layout.layout_id.clone(),
        source_layout_hash: input.layout.layout_hash.clone(),
        layout_hash: String::new(),
        places: input.layout.passenger_places.clone(),
        special_bays: input.layout.special_bays.clone(),
    };
    places.layout_hash = crate::projection_v2::interior_places_v2_hash(&places)?;
    Ok(places)
}
pub fn bind_interior_passenger_places_json(json: &str) -> Result<String, ConductorError> {
    require(json.len() <= 128 * 1024 * 1024, "interior_input_size_limit")?;
    Ok(serde_json::to_string(&bind_interior_passenger_places(
        &serde_json::from_str(json)?,
    )?)?)
}
