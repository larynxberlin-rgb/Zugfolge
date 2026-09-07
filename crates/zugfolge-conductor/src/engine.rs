use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use sha2::{Digest, Sha256};
use zugfolge_demand::*;

use crate::{ConductorError, ensure, places::assign_places, types::*};

const SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_PLACES: usize = 300_000;

pub(crate) fn digest(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(
            u64::try_from(part.len())
                .expect("bounded string")
                .to_be_bytes(),
        );
        hash.update(part.as_bytes());
    }
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn json_hash(value: &impl Serialize) -> Result<String, ConductorError> {
    Ok(Sha256::digest(serde_json::to_vec(value)?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn unique<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut found = BTreeSet::new();
    values
        .into_iter()
        .all(|value| id(value) && found.insert(value))
}

/// Kanonische Prüfsumme; der Server pinnt das freigegebene Layout unabhängig.
pub fn interior_places_hash(
    interior: &InteriorPassengerPlacesV1,
) -> Result<String, ConductorError> {
    let mut canonical = interior.clone();
    canonical.layout_hash.clear();
    canonical.places.sort_by(|a, b| a.place_id.cmp(&b.place_id));
    for place in &mut canonical.places {
        place.space_needs.sort();
    }
    json_hash(&canonical)
}

fn validate_interior(input: &ProjectConductorPassengersInputV1) -> Result<(), ConductorError> {
    let interior = &input.interior;
    ensure(
        interior.schema_version == INTERIOR_SCHEMA
            && interior.world_id == input.binding.world_id
            && interior.train_run_id == input.binding.train_run_id
            && id(&interior.layout_id),
        "interior_scope_mismatch",
    )?;
    ensure(
        interior.places.len() <= MAX_PLACES
            && unique(interior.places.iter().map(|place| place.place_id.as_str())),
        "invalid_interior_places",
    )?;
    ensure(
        hash(&interior.layout_hash) && interior_places_hash(interior)? == interior.layout_hash,
        "interior_hash_mismatch",
    )?;
    let mut positions = BTreeSet::new();
    let mut counts = [0_u32; 6];
    for place in &interior.places {
        ensure(
            id(&place.vehicle_id)
                && (0..=SAFE_INTEGER).contains(&place.x_mm)
                && (0..=SAFE_INTEGER).contains(&place.y_mm)
                && positions.insert((&place.vehicle_id, place.x_mm, place.y_mm))
                && !place.space_needs.is_empty()
                && place.space_needs.len() <= 4
                && place.space_needs.iter().collect::<BTreeSet<_>>().len()
                    == place.space_needs.len(),
            "invalid_interior_place",
        )?;
        let slot = match (place.comfort_class, place.kind) {
            (ComfortClassV1::Standard, InteriorPlaceKindV1::Seat) => 0,
            (ComfortClassV1::Standard, InteriorPlaceKindV1::Standing) => 1,
            (ComfortClassV1::Premium, InteriorPlaceKindV1::Seat) => 2,
            (ComfortClassV1::Premium, InteriorPlaceKindV1::Standing) => {
                return Err(ConductorError("premium_standing_place".into()));
            }
        };
        counts[slot] += 1;
        for (index, needs) in [
            SpaceNeedsV1::Wheelchair,
            SpaceNeedsV1::Bicycle,
            SpaceNeedsV1::Stroller,
        ]
        .iter()
        .enumerate()
        {
            if place.space_needs.contains(needs) {
                counts[index + 3] += 1;
            }
        }
    }
    let capacity = &input.service.capacity;
    ensure(
        counts[..3]
            == [
                capacity.standard_seats,
                capacity.standard_standing,
                capacity.premium_seats,
            ]
            && counts[3] >= capacity.wheelchair_spaces
            && counts[4] >= capacity.bicycle_spaces
            && counts[5] >= capacity.stroller_spaces,
        "interior_capacity_mismatch",
    )
}

pub(crate) fn validate_source(
    input: &ProjectConductorPassengersInputV1,
) -> Result<(), ConductorError> {
    let result = &input.evaluation;
    let binding = &input.binding;
    ensure(
        input.schema_version == crate::INPUT_SCHEMA && result.schema_version == RESULT_SCHEMA,
        "unsupported_conductor_schema",
    )?;
    ensure(
        [
            &binding.world_id,
            &binding.period_id,
            &binding.demand_release_id,
            &binding.train_run_id,
            &binding.operator_id,
            &binding.operational_receipt_id,
        ]
        .into_iter()
        .all(|value| id(value))
            && [
                &binding.release_hash,
                &binding.seed_hash,
                &binding.demand_state_hash,
            ]
            .into_iter()
            .all(|value| hash(value))
            && binding.manifest_revision > 0
            && binding.manifest_revision <= u64::try_from(SAFE_INTEGER).expect("positive"),
        "invalid_conductor_binding",
    )?;
    ensure(
        result.world_id == binding.world_id
            && result.period_id == binding.period_id
            && result.demand_release_id == binding.demand_release_id
            && result.release_hash == binding.release_hash
            && result.seed_hash == binding.seed_hash
            && result.revision == binding.manifest_revision
            && result.state_hash == binding.demand_state_hash,
        "demand_scope_mismatch",
    )?;
    ensure(
        (0..=SAFE_INTEGER).contains(&result.now_ms)
            && (0..=SAFE_INTEGER).contains(&result.window_start_ms)
            && result.window_end_ms > result.window_start_ms
            && result.window_end_ms <= SAFE_INTEGER,
        "invalid_demand_time",
    )?;
    ensure(
        result.projection_mode == "progress_bound",
        "demand_forecast_not_boarded",
    )?;
    let mut unhashed = result.clone();
    unhashed.state_hash.clear();
    ensure(
        json_hash(&unhashed)? == result.state_hash,
        "demand_hash_mismatch",
    )?;
    ensure(
        result
            .manifests
            .iter()
            .map(|row| row.passengers.len())
            .sum::<usize>()
            <= 1_000_000,
        "manifest_size_limit",
    )?;
    ensure(
        result
            .cohorts
            .iter()
            .all(|row| row.world_id == binding.world_id)
            && result
                .choices
                .iter()
                .all(|row| row.world_id == binding.world_id)
            && result
                .unserved
                .iter()
                .all(|row| row.world_id == binding.world_id)
            && result
                .allocations
                .iter()
                .all(|row| row.world_id == binding.world_id)
            && result
                .stop_flows
                .iter()
                .all(|row| row.world_id == binding.world_id)
            && result.manifests.iter().all(|row| {
                row.world_id == binding.world_id
                    && row.schema_version == "passenger-manifest/v1"
                    && row.demand_release_id == binding.demand_release_id
                    && row.revision == binding.manifest_revision
            }),
        "manifest_scope_mismatch",
    )?;
    ensure(
        result
            .manifests
            .iter()
            .map(|row| (&row.train_run_id, &row.segment_id))
            .collect::<BTreeSet<_>>()
            .len()
            == result.manifests.len()
            && result
                .allocations
                .iter()
                .map(|row| (&row.train_run_id, &row.segment_id))
                .collect::<BTreeSet<_>>()
                .len()
                == result.allocations.len()
            && result
                .stop_flows
                .iter()
                .map(|row| (&row.train_run_id, &row.stop_id))
                .collect::<BTreeSet<_>>()
                .len()
                == result.stop_flows.len(),
        "duplicate_demand_row",
    )?;
    let service = &input.service;
    ensure(
        service.world_id == binding.world_id
            && service.train_run_id == binding.train_run_id
            && service.operator_id == binding.operator_id
            && service.mode == RailModeV1::Spnv,
        "train_scope_mismatch",
    )?;
    ensure(!service.cancelled, "train_cancelled")?;
    ensure(
        (2..=100).contains(&service.stops.len())
            && unique(service.stops.iter().map(|stop| stop.stop_id.as_str())),
        "invalid_train_stops",
    )?;
    let capacity = &service.capacity;
    ensure(
        [
            capacity.standard_seats,
            capacity.standard_standing,
            capacity.premium_seats,
            capacity.wheelchair_spaces,
            capacity.bicycle_spaces,
            capacity.stroller_spaces,
        ]
        .into_iter()
        .all(|count| count <= 100_000),
        "invalid_train_capacity",
    )?;
    Ok(())
}

pub(crate) fn active_section(
    input: &ProjectConductorPassengersInputV1,
) -> Result<(usize, bool), ConductorError> {
    let progress = input
        .evaluation
        .operational_progress
        .as_ref()
        .ok_or_else(|| ConductorError("missing_operational_progress".into()))?;
    ensure(
        progress.schema_version == "demand-operational-progress/v1"
            && progress.world_id == input.binding.world_id
            && progress.as_of_ms == input.evaluation.now_ms
            && progress.receipt_id == input.binding.operational_receipt_id
            && unique(
                progress
                    .trains
                    .iter()
                    .map(|train| train.train_run_id.as_str()),
            ),
        "operational_scope_mismatch",
    )?;
    let train = progress
        .trains
        .iter()
        .find(|train| train.train_run_id == input.binding.train_run_id)
        .ok_or_else(|| ConductorError("missing_train_progress".into()))?;
    ensure(
        unique(train.stops.iter().map(|stop| stop.stop_id.as_str()))
            && train.stops.iter().all(|stop| {
                input
                    .service
                    .stops
                    .iter()
                    .any(|known| known.stop_id == stop.stop_id)
            }),
        "invalid_progress_stops",
    )?;
    let receipts: BTreeMap<_, _> = train
        .stops
        .iter()
        .map(|stop| (stop.stop_id.as_str(), stop))
        .collect();
    let mut last_time = None;
    let mut departure = None;
    let mut arrival = None;
    for (index, stop) in input.service.stops.iter().enumerate() {
        if let Some(receipt) = receipts.get(stop.stop_id.as_str()) {
            ensure(
                receipt.actual_arrival_ms.is_some() || receipt.actual_departure_ms.is_some(),
                "empty_stop_receipt",
            )?;
            for time in [receipt.actual_arrival_ms, receipt.actual_departure_ms]
                .into_iter()
                .flatten()
            {
                ensure(
                    (0..=progress.as_of_ms).contains(&time)
                        && last_time.is_none_or(|previous| time >= previous),
                    "invalid_progress_time",
                )?;
                last_time = Some(time);
            }
            if receipt.actual_arrival_ms.is_some() {
                arrival = Some(index);
            }
            if receipt.actual_departure_ms.is_some() {
                departure = Some(index);
            }
        }
    }
    let section = departure.ok_or_else(|| ConductorError("train_not_departed".into()))?;
    ensure(section + 1 < input.service.stops.len(), "train_completed")?;
    ensure(
        arrival != Some(input.service.stops.len() - 1),
        "train_completed",
    )?;
    ensure(
        arrival.is_none_or(|index| index <= section + 1),
        "unconfirmed_train_section",
    )?;
    Ok((section, arrival == Some(section + 1)))
}

pub(crate) fn train_manifests(
    input: &ProjectConductorPassengersInputV1,
) -> Result<Vec<&PassengerManifestV1>, ConductorError> {
    let result = &input.evaluation;
    let service = &input.service;
    let manifests: BTreeMap<_, _> = result
        .manifests
        .iter()
        .filter(|row| row.train_run_id == service.train_run_id)
        .map(|row| (row.segment_id.as_str(), row))
        .collect();
    let allocations: BTreeMap<_, _> = result
        .allocations
        .iter()
        .filter(|row| row.train_run_id == service.train_run_id)
        .map(|row| (row.segment_id.as_str(), row))
        .collect();
    let flows: BTreeMap<_, _> = result
        .stop_flows
        .iter()
        .filter(|row| row.train_run_id == service.train_run_id)
        .map(|row| (row.stop_id.as_str(), row))
        .collect();
    ensure(
        manifests.len() == service.stops.len() - 1
            && allocations.len() == manifests.len()
            && flows.len() == service.stops.len(),
        "incomplete_train_manifest",
    )?;
    let stops: BTreeMap<_, _> = service
        .stops
        .iter()
        .enumerate()
        .map(|(index, stop)| (stop.stop_id.as_str(), index))
        .collect();
    let mut output = Vec::new();
    let mut previous: BTreeMap<&str, &ManifestPassengerV1> = BTreeMap::new();
    let mut identities: BTreeMap<&str, &ManifestPassengerV1> = BTreeMap::new();
    for (index, stop) in service.stops.iter().enumerate() {
        let flow = flows
            .get(stop.stop_id.as_str())
            .ok_or_else(|| ConductorError("missing_stop_flow".into()))?;
        let manifest = if index + 1 < service.stops.len() {
            let segment = digest(&[
                "train_segment",
                &service.world_id,
                &service.train_run_id,
                &stop.stop_id,
                &service.stops[index + 1].stop_id,
            ]);
            Some(
                *manifests
                    .get(segment.as_str())
                    .ok_or_else(|| ConductorError("unknown_manifest_segment".into()))?,
            )
        } else {
            None
        };
        let mut current = BTreeMap::new();
        if let Some(manifest) = manifest {
            let mut seats = BTreeSet::new();
            let mut seated = 0_u32;
            let mut standard_seated = 0_u32;
            let mut premium_seated = 0_u32;
            let mut reserved = 0_u32;
            let mut needs = [0_u32; 3];
            for passenger in &manifest.passengers {
                ensure(
                    hash(&passenger.passenger_key)
                        && hash(&passenger.journey_chain_id)
                        && current
                            .insert(passenger.passenger_key.as_str(), passenger)
                            .is_none(),
                    "invalid_manifest_passenger",
                )?;
                let board = stops.get(passenger.boarding_stop_id.as_str()).copied();
                let alight = stops.get(passenger.alighting_stop_id.as_str()).copied();
                ensure(
                    board.is_some_and(|position| {
                        position <= index && service.stops[position].passenger_stop
                    }) && alight.is_some_and(|position| {
                        position > index && service.stops[position].passenger_stop
                    }),
                    "invalid_passenger_stops",
                )?;
                if let Some(first) = identities.get(passenger.passenger_key.as_str()) {
                    ensure(
                        first.journey_chain_id == passenger.journey_chain_id
                            && first.boarding_stop_id == passenger.boarding_stop_id
                            && first.alighting_stop_id == passenger.alighting_stop_id
                            && first.demand_segment == passenger.demand_segment
                            && first.comfort_class == passenger.comfort_class
                            && first.space_needs == passenger.space_needs
                            && first.fare_fact == passenger.fare_fact
                            && first.fare_policy_provenance == passenger.fare_policy_provenance
                            && first.reservation_id == passenger.reservation_id,
                        "inconsistent_passenger_identity",
                    )?;
                } else {
                    ensure(board == Some(index), "missing_boarding_passenger")?;
                    identities.insert(passenger.passenger_key.as_str(), passenger);
                }
                if let Some(seat) = passenger.seat_number {
                    let limit = match passenger.comfort_class {
                        ComfortClassV1::Standard => {
                            standard_seated += 1;
                            service.capacity.standard_seats
                        }
                        ComfortClassV1::Premium => {
                            premium_seated += 1;
                            service.capacity.premium_seats
                        }
                    };
                    ensure(
                        seat > 0 && seat <= limit && seats.insert((passenger.comfort_class, seat)),
                        "invalid_manifest_seat",
                    )?;
                    seated += 1;
                } else {
                    ensure(
                        passenger.comfort_class == ComfortClassV1::Standard
                            && passenger.reservation_id.is_none(),
                        "invalid_standing_passenger",
                    )?;
                }
                if passenger.reservation_id.is_some() {
                    reserved += 1;
                }
                match passenger.space_needs {
                    SpaceNeedsV1::Ordinary => {}
                    SpaceNeedsV1::Wheelchair => needs[0] += 1,
                    SpaceNeedsV1::Bicycle => needs[1] += 1,
                    SpaceNeedsV1::Stroller => needs[2] += 1,
                }
            }
            let allocation = allocations[manifest.segment_id.as_str()];
            let count = u32::try_from(current.len())
                .map_err(|_| ConductorError("manifest_size_limit".into()))?;
            let standing = count - seated;
            ensure(
                allocation.operator_id == service.operator_id
                    && allocation.mode == RailModeV1::Spnv
                    && allocation.from_stop_id == stop.stop_id
                    && allocation.to_stop_id == service.stops[index + 1].stop_id
                    && allocation.passengers == count
                    && allocation.seated == seated
                    && allocation.standing == standing
                    && allocation.reserved == reserved
                    && allocation.wheelchair == needs[0]
                    && allocation.bicycle == needs[1]
                    && allocation.stroller == needs[2]
                    && allocation.capacity
                        == service.capacity.standard_seats
                            + service.capacity.standard_standing
                            + service.capacity.premium_seats
                    && standard_seated <= service.capacity.standard_seats
                    && premium_seated <= service.capacity.premium_seats
                    && standing <= service.capacity.standard_standing
                    && needs[0] <= service.capacity.wheelchair_spaces
                    && needs[1] <= service.capacity.bicycle_spaces
                    && needs[2] <= service.capacity.stroller_spaces,
                "manifest_capacity_mismatch",
            )?;
            output.push(manifest);
        }
        let boarding = current
            .keys()
            .filter(|key| !previous.contains_key(**key))
            .count();
        let alighting = previous
            .keys()
            .filter(|key| !current.contains_key(**key))
            .count();
        ensure(
            previous
                .values()
                .filter(|passenger| !current.contains_key(passenger.passenger_key.as_str()))
                .all(|passenger| passenger.alighting_stop_id == stop.stop_id)
                && current
                    .values()
                    .filter(|passenger| !previous.contains_key(passenger.passenger_key.as_str()))
                    .all(|passenger| passenger.boarding_stop_id == stop.stop_id)
                && usize::try_from(flow.boarding).expect("u32") == boarding
                && usize::try_from(flow.alighting).expect("u32") == alighting
                && usize::try_from(flow.onboard_after).expect("u32") == current.len(),
            "stop_flow_mismatch",
        )?;
        previous = current;
    }
    Ok(output)
}

pub(crate) fn appearance(binding: &ConductorPassengerBindingV1, passenger: &str) -> u32 {
    // Getrennter visueller Teilstrom ohne Fahrausweisfakt, Klasse oder Platzbedarf.
    u32::from_str_radix(
        &digest(&[
            "conductor_appearance_v1",
            &binding.world_id,
            &binding.seed_hash,
            passenger,
        ])[..8],
        16,
    )
    .expect("SHA-256 hexadecimal")
        % 256
}

pub(crate) fn validate_previous(
    input: &ProjectConductorPassengersInputV1,
    active: usize,
    manifests: &[&PassengerManifestV1],
) -> Result<Option<usize>, ConductorError> {
    let Some(previous) = &input.previous_projection else {
        return Ok(None);
    };
    let old = &previous.binding;
    let new = &input.binding;
    let index = manifests
        .iter()
        .position(|manifest| manifest.segment_id == previous.segment_id);
    ensure(
        previous.schema_version == PROJECTION_SCHEMA
            && old.world_id == new.world_id
            && old.period_id == new.period_id
            && old.demand_release_id == new.demand_release_id
            && old.release_hash == new.release_hash
            && old.seed_hash == new.seed_hash
            && old.train_run_id == new.train_run_id
            && old.operator_id == new.operator_id
            && old.manifest_revision > 0
            && old.manifest_revision <= new.manifest_revision
            && (old.manifest_revision != new.manifest_revision || old == new)
            && previous.layout_id == input.interior.layout_id
            && previous.layout_hash == input.interior.layout_hash
            && (0..=input.evaluation.now_ms).contains(&previous.as_of_ms)
            && index.is_some_and(|index| index <= active),
        "previous_projection_scope_mismatch",
    )?;
    let mut unhashed = previous.clone();
    unhashed.state_hash.clear();
    ensure(
        json_hash(&unhashed)? == previous.state_hash,
        "previous_projection_hash_mismatch",
    )?;
    let index = index.expect("validated");
    ensure(
        previous.from_stop_id == input.service.stops[index].stop_id
            && previous.to_stop_id == input.service.stops[index + 1].stop_id
            && match previous.phase {
                PassengerProjectionPhaseV1::InTransit => previous.current_stop_id.is_none(),
                PassengerProjectionPhaseV1::AtStop => {
                    previous.current_stop_id.as_deref() == Some(previous.to_stop_id.as_str())
                }
            },
        "invalid_previous_section",
    )?;
    let places: BTreeMap<_, _> = input
        .interior
        .places
        .iter()
        .map(|place| (place.place_id.as_str(), place))
        .collect();
    let mut occupied = BTreeSet::new();
    ensure(
        unique(
            previous
                .passengers
                .iter()
                .map(|passenger| passenger.passenger_key.as_str()),
        ),
        "duplicate_previous_passenger",
    )?;
    for passenger in &previous.passengers {
        let place = places
            .get(passenger.place_id.as_str())
            .ok_or_else(|| ConductorError("unknown_previous_place".into()))?;
        ensure(
            occupied.insert(&passenger.place_id)
                && passenger.vehicle_id == place.vehicle_id
                && passenger.x_mm == place.x_mm
                && passenger.y_mm == place.y_mm
                && passenger.comfort_class == place.comfort_class
                && place.space_needs.contains(&passenger.space_needs)
                && passenger.posture
                    == match place.kind {
                        InteriorPlaceKindV1::Seat => PassengerPostureV1::Seated,
                        InteriorPlaceKindV1::Standing => PassengerPostureV1::Standing,
                    }
                && passenger.appearance_variant == appearance(new, &passenger.passenger_key),
            "invalid_previous_place",
        )?;
    }
    Ok(Some(index))
}

/// Projiziert einen tatsächlichen Zugabschnitt aus serververtrauten Zustandspins.
pub fn project_conductor_passengers(
    input: &ProjectConductorPassengersInputV1,
) -> Result<PassengerProjectionV1, ConductorError> {
    validate_source(input)?;
    validate_interior(input)?;
    let (active, at_stop) = active_section(input)?;
    let manifests = train_manifests(input)?;
    let previous_index = validate_previous(input, active, &manifests)?;
    let mut passengers = input
        .previous_projection
        .as_ref()
        .map_or_else(Vec::new, |previous| previous.passengers.clone());
    // Ohne Vorprojektion werden die Plätze ab dem ersten Abschnitt rekonstruiert;
    // späterer Einstieg und fortlaufende Projektion stimmen dadurch überein.
    for manifest in manifests
        .iter()
        .take(active + 1)
        .skip(previous_index.unwrap_or(0))
    {
        passengers = assign_places(
            &input.binding,
            &input.interior,
            &manifest.passengers,
            &passengers,
        )?;
    }
    let to_stop = &input.service.stops[active + 1].stop_id;
    let alighting: BTreeSet<_> = manifests[active]
        .passengers
        .iter()
        .filter(|passenger| passenger.alighting_stop_id == *to_stop)
        .map(|passenger| passenger.passenger_key.as_str())
        .collect();
    for passenger in &mut passengers {
        passenger.activity = if at_stop && alighting.contains(passenger.passenger_key.as_str()) {
            PassengerActivityV1::Alighting
        } else {
            PassengerActivityV1::Onboard
        };
    }
    let mut output = PassengerProjectionV1 {
        schema_version: PROJECTION_SCHEMA.into(),
        binding: input.binding.clone(),
        segment_id: manifests[active].segment_id.clone(),
        from_stop_id: input.service.stops[active].stop_id.clone(),
        to_stop_id: to_stop.clone(),
        phase: if at_stop {
            PassengerProjectionPhaseV1::AtStop
        } else {
            PassengerProjectionPhaseV1::InTransit
        },
        current_stop_id: at_stop.then(|| to_stop.clone()),
        layout_id: input.interior.layout_id.clone(),
        layout_hash: input.interior.layout_hash.clone(),
        as_of_ms: input.evaluation.now_ms,
        passengers,
        state_hash: String::new(),
    };
    output.state_hash = json_hash(&output)?;
    Ok(output)
}

/// Strikter begrenzter JSON-Einstieg für nativen Adapter und Prüfbinary.
pub fn project_conductor_passengers_json(json: &str) -> Result<String, ConductorError> {
    ensure(
        json.len() <= 128 * 1024 * 1024,
        "conductor_input_size_limit",
    )?;
    let input: ProjectConductorPassengersInputV1 = serde_json::from_str(json)?;
    Ok(serde_json::to_string(&project_conductor_passengers(
        &input,
    )?)?)
}
