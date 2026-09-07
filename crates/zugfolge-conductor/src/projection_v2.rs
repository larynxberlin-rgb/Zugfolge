use crate::{
    engine,
    interior::{hash, id, json_hash, require},
    *,
};
use std::collections::{BTreeMap, BTreeSet};
use zugfolge_demand::{ComfortClassV1, ManifestPassengerV1, SpaceNeedsV1};
pub fn interior_places_v2_hash(
    interior: &InteriorPassengerPlacesV2,
) -> Result<String, ConductorError> {
    let mut canonical = interior.clone();
    canonical.layout_hash.clear();
    canonical.places.sort_by(|a, b| a.place_id.cmp(&b.place_id));
    for place in &mut canonical.places {
        place.space_needs.sort();
    }
    canonical
        .special_bays
        .sort_by(|a, b| a.space_id.cmp(&b.space_id));
    json_hash(&canonical)
}

fn flat_place(p: &InteriorPassengerPlaceV2) -> InteriorPassengerPlaceV1 {
    InteriorPassengerPlaceV1 {
        place_id: p.place_id.clone(),
        vehicle_id: p.vehicle_id.clone(),
        x_mm: p.x_mm,
        y_mm: p.y_mm,
        comfort_class: p.comfort_class,
        kind: p.kind,
        space_needs: p.space_needs.clone(),
    }
}
fn flat_visible(p: &VisiblePassengerV2, place: &InteriorPassengerPlaceV2) -> VisiblePassengerV1 {
    VisiblePassengerV1 {
        passenger_key: p.passenger_key.clone(),
        place_id: p.place_id.clone(),
        vehicle_id: p.vehicle_id.clone(),
        x_mm: place.x_mm,
        y_mm: place.y_mm,
        comfort_class: p.comfort_class,
        space_needs: p.space_needs,
        posture: p.posture,
        appearance_variant: p.appearance_variant,
        activity: p.activity,
    }
}
fn category(comfort: ComfortClassV1, kind: InteriorPlaceKindV1) -> usize {
    match (comfort, kind) {
        (ComfortClassV1::Standard, InteriorPlaceKindV1::Seat) => 0,
        (ComfortClassV1::Standard, InteriorPlaceKindV1::Standing) => 1,
        (ComfortClassV1::Premium, InteriorPlaceKindV1::Seat) => 2,
        _ => 3,
    }
}
fn passenger_category(p: &ManifestPassengerV1) -> usize {
    category(
        p.comfort_class,
        if p.seat_number.is_some() {
            InteriorPlaceKindV1::Seat
        } else {
            InteriorPlaceKindV1::Standing
        },
    )
}
fn need_index(need: SpaceNeedsV1) -> usize {
    match need {
        SpaceNeedsV1::Ordinary => 0,
        SpaceNeedsV1::Wheelchair => 1,
        SpaceNeedsV1::Bicycle => 2,
        SpaceNeedsV1::Stroller => 3,
    }
}

fn validate(
    input: &ProjectConductorPassengersInputV2,
) -> Result<InteriorPassengerPlacesV1, ConductorError> {
    let interior = &input.interior;
    require(
        input.schema_version == PROJECTION_INPUT_V2_SCHEMA
            && interior.schema_version == INTERIOR_V2_SCHEMA,
        "unsupported_conductor_v2_schema",
    )?;
    require(
        interior.world_id == input.binding.world_id
            && interior.train_run_id == input.binding.train_run_id
            && id(&interior.layout_id)
            && hash(&interior.source_layout_hash)
            && interior_places_v2_hash(interior)? == interior.layout_hash,
        "interior_v2_scope_mismatch",
    )?;
    require(
        interior.places.len() <= interior::MAX_LAYOUT_PLACES
            && interior.special_bays.len() <= interior::MAX_LAYOUT_PLACES,
        "interior_v2_size_limit",
    )?;
    let mut ids = BTreeSet::new();
    let mut positions = BTreeSet::new();
    let mut counts = [0_u32; 3];
    let mut quotas = [0_u32; 4];
    let mut abilities: BTreeMap<&str, BTreeSet<SpaceNeedsV1>> = BTreeMap::new();
    for bay in &interior.special_bays {
        require(
            id(&bay.space_id)
                && id(&bay.vehicle_id)
                && id(&bay.body_id)
                && ids.insert(bay.space_id.as_str())
                && bay.space_need != SpaceNeedsV1::Ordinary
                && positions.insert((
                    &bay.vehicle_id,
                    &bay.body_id,
                    bay.deck_id,
                    bay.x_mm,
                    bay.y_mm,
                ))
                && (0..=32_000).contains(&bay.x_mm)
                && (0..=3200).contains(&bay.y_mm),
            "invalid_interior_special_bay",
        )?;
        quotas[need_index(bay.space_need)] += 1;
        abilities
            .entry(&bay.vehicle_id)
            .or_default()
            .insert(bay.space_need);
    }
    let mut flat = InteriorPassengerPlacesV1 {
        schema_version: INTERIOR_SCHEMA.into(),
        world_id: interior.world_id.clone(),
        train_run_id: interior.train_run_id.clone(),
        layout_id: interior.layout_id.clone(),
        layout_hash: String::new(),
        places: vec![],
    };
    for place in &interior.places {
        let category = category(place.comfort_class, place.kind);
        let mut expected = abilities
            .get(place.vehicle_id.as_str())
            .cloned()
            .unwrap_or_default();
        expected.insert(SpaceNeedsV1::Ordinary);
        require(
            id(&place.place_id)
                && id(&place.vehicle_id)
                && id(&place.body_id)
                && ids.insert(place.place_id.as_str())
                && positions.insert((
                    &place.vehicle_id,
                    &place.body_id,
                    place.deck_id,
                    place.x_mm,
                    place.y_mm,
                ))
                && (0..=32_000).contains(&place.x_mm)
                && (0..=3200).contains(&place.y_mm)
                && category < 3
                && place.space_needs.len() == expected.len()
                && place.space_needs.iter().copied().collect::<BTreeSet<_>>() == expected,
            "invalid_interior_v2_place",
        )?;
        counts[category] += 1;
        flat.places.push(flat_place(place));
    }
    require(
        interior.special_bays.iter().all(|bay| {
            interior
                .places
                .iter()
                .any(|p| p.vehicle_id == bay.vehicle_id)
        }),
        "interior_bay_without_capacity",
    )?;
    let c = &input.service.capacity;
    require(
        counts == [c.standard_seats, c.standard_standing, c.premium_seats]
            && quotas[1..] == [c.wheelchair_spaces, c.bicycle_spaces, c.stroller_spaces],
        "interior_v2_capacity_mismatch",
    )?;
    flat.layout_hash = interior_places_hash(&flat)?;
    Ok(flat)
}

fn validate_old(
    input: &ProjectConductorPassengersInputV2,
    flat: &InteriorPassengerPlacesV1,
) -> Result<Option<PassengerProjectionV1>, ConductorError> {
    let Some(previous) = &input.previous_projection else {
        return Ok(None);
    };
    let mut unhashed = previous.clone();
    unhashed.state_hash.clear();
    require(
        previous.schema_version == PROJECTION_V2_SCHEMA
            && previous.layout_hash == input.interior.layout_hash
            && previous.source_layout_hash == input.interior.source_layout_hash
            && json_hash(&unhashed)? == previous.state_hash,
        "previous_projection_v2_hash_mismatch",
    )?;
    let places: BTreeMap<_, _> = input
        .interior
        .places
        .iter()
        .map(|p| (p.place_id.as_str(), p))
        .collect();
    let bays: BTreeMap<_, _> = input
        .interior
        .special_bays
        .iter()
        .map(|b| (b.space_id.as_str(), b))
        .collect();
    let mut used = BTreeSet::new();
    let mut passengers = vec![];
    for passenger in &previous.passengers {
        let place = places
            .get(passenger.place_id.as_str())
            .ok_or_else(|| ConductorError("unknown_previous_place".into()))?;
        let (body, deck, x, y) = if passenger.space_needs == SpaceNeedsV1::Ordinary {
            require(passenger.space_id.is_none(), "invalid_previous_special_bay")?;
            (&place.body_id, place.deck_id, place.x_mm, place.y_mm)
        } else {
            let bay = passenger
                .space_id
                .as_ref()
                .and_then(|id| bays.get(id.as_str()))
                .ok_or_else(|| ConductorError("invalid_previous_special_bay".into()))?;
            require(
                used.insert(&bay.space_id)
                    && bay.vehicle_id == place.vehicle_id
                    && bay.space_need == passenger.space_needs,
                "invalid_previous_special_bay",
            )?;
            if passenger.space_needs == SpaceNeedsV1::Wheelchair {
                (&bay.body_id, bay.deck_id, bay.x_mm, bay.y_mm)
            } else {
                (&place.body_id, place.deck_id, place.x_mm, place.y_mm)
            }
        };
        require(
            passenger.body_id == *body
                && passenger.deck_id == deck
                && passenger.x_mm == x
                && passenger.y_mm == y,
            "invalid_previous_deck_position",
        )?;
        passengers.push(flat_visible(passenger, place));
    }
    let mut output = PassengerProjectionV1 {
        schema_version: PROJECTION_SCHEMA.into(),
        binding: previous.binding.clone(),
        segment_id: previous.segment_id.clone(),
        from_stop_id: previous.from_stop_id.clone(),
        to_stop_id: previous.to_stop_id.clone(),
        phase: previous.phase,
        current_stop_id: previous.current_stop_id.clone(),
        layout_id: previous.layout_id.clone(),
        layout_hash: flat.layout_hash.clone(),
        as_of_ms: previous.as_of_ms,
        passengers,
        state_hash: String::new(),
    };
    output.state_hash = json_hash(&output)?;
    Ok(Some(output))
}

// Kapazitätsplatz und Sonderfläche werden gemeinsam demselben realen M5-Asset zugeteilt.
fn assign(
    input: &ProjectConductorPassengersInputV2,
    manifest: &[ManifestPassengerV1],
    previous: &[VisiblePassengerV2],
    keep: bool,
) -> Result<Option<Vec<VisiblePassengerV2>>, ConductorError> {
    let interior = &input.interior;
    let mut vehicles: Vec<_> = interior
        .places
        .iter()
        .map(|p| p.vehicle_id.as_str())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    vehicles.sort();
    let indexes: BTreeMap<_, _> = vehicles.iter().enumerate().map(|(i, v)| (*v, i)).collect();
    let places: BTreeMap<_, _> = interior
        .places
        .iter()
        .map(|p| (p.place_id.as_str(), p))
        .collect();
    let old: BTreeMap<_, _> = previous
        .iter()
        .map(|p| (p.passenger_key.as_str(), p))
        .collect();
    let mut available = vec![[0_usize; 3]; vehicles.len()];
    let mut quotas = vec![[0_usize; 4]; vehicles.len()];
    for p in &interior.places {
        available[indexes[p.vehicle_id.as_str()]][category(p.comfort_class, p.kind)] += 1;
    }
    for bay in &interior.special_bays {
        quotas[indexes[bay.vehicle_id.as_str()]][need_index(bay.space_need)] += 1;
    }
    let mut occupied = BTreeSet::new();
    let mut occupied_bays = BTreeSet::new();
    let mut assignments: BTreeMap<&str, &InteriorPassengerPlaceV2> = BTreeMap::new();
    let mut reserved_bays: BTreeMap<&str, &InteriorSpecialBayV1> = BTreeMap::new();
    if keep {
        for p in manifest {
            let Some(previous) = old.get(p.passenger_key.as_str()) else {
                continue;
            };
            let Some(place) = places.get(previous.place_id.as_str()) else {
                continue;
            };
            if category(place.comfort_class, place.kind) != passenger_category(p)
                || !place.space_needs.contains(&p.space_needs)
            {
                continue;
            }
            let bay = if p.space_needs == SpaceNeedsV1::Ordinary {
                None
            } else {
                previous.space_id.as_ref().and_then(|id| {
                    interior.special_bays.iter().find(|b| {
                        b.space_id == *id
                            && b.vehicle_id == place.vehicle_id
                            && b.space_need == p.space_needs
                            && !occupied_bays.contains(b.space_id.as_str())
                    })
                })
            };
            if p.space_needs != SpaceNeedsV1::Ordinary && bay.is_none() {
                continue;
            }
            if !occupied.insert(place.place_id.as_str()) {
                continue;
            }
            let v = indexes[place.vehicle_id.as_str()];
            available[v][passenger_category(p)] -= 1;
            assignments.insert(p.passenger_key.as_str(), place);
            if let Some(bay) = bay {
                quotas[v][need_index(p.space_needs)] -= 1;
                occupied_bays.insert(bay.space_id.as_str());
                reserved_bays.insert(p.passenger_key.as_str(), bay);
            }
        }
    }
    let mut specials: Vec<_> = manifest
        .iter()
        .filter(|p| {
            p.space_needs != SpaceNeedsV1::Ordinary
                && !assignments.contains_key(p.passenger_key.as_str())
        })
        .collect();
    specials.sort_by_key(|p| {
        (
            vehicles
                .iter()
                .enumerate()
                .filter(|(v, _)| {
                    available[*v][passenger_category(p)] > 0
                        && quotas[*v][need_index(p.space_needs)] > 0
                })
                .count(),
            p.space_needs,
            passenger_category(p),
            p.passenger_key.as_str(),
        )
    });
    let candidates: Vec<Vec<usize>> = specials
        .iter()
        .map(|p| {
            let mut values: Vec<_> = (0..vehicles.len())
                .filter(|v| {
                    available[*v][passenger_category(p)] > 0
                        && quotas[*v][need_index(p.space_needs)] > 0
                })
                .collect();
            let prior = old
                .get(p.passenger_key.as_str())
                .map(|p| p.vehicle_id.as_str());
            values.sort_by_key(|v| (Some(vehicles[*v]) != prior, vehicles[*v]));
            values
        })
        .collect();
    let mut next = vec![0_usize; specials.len()];
    let mut chosen = vec![0_usize; specials.len()];
    let mut depth = 0;
    let mut attempts = 0;
    while depth < specials.len() {
        let p = specials[depth];
        let c = passenger_category(p);
        let n = need_index(p.space_needs);
        let mut found = None;
        while next[depth] < candidates[depth].len() {
            let v = candidates[depth][next[depth]];
            next[depth] += 1;
            attempts += 1;
            require(attempts <= 1_000_000, "interior_assignment_search_limit")?;
            if available[v][c] > 0 && quotas[v][n] > 0 {
                found = Some(v);
                break;
            }
        }
        if let Some(v) = found {
            available[v][c] -= 1;
            quotas[v][n] -= 1;
            chosen[depth] = v;
            depth += 1;
            if depth < specials.len() {
                next[depth] = 0;
            }
        } else {
            if depth == 0 {
                return Ok(None);
            }
            depth -= 1;
            let back = specials[depth];
            available[chosen[depth]][passenger_category(back)] += 1;
            quotas[chosen[depth]][need_index(back.space_needs)] += 1;
        }
    }
    for (p, v) in specials.iter().zip(chosen) {
        let prior = old.get(p.passenger_key.as_str());
        let mut candidates: Vec<_> = interior
            .places
            .iter()
            .filter(|place| {
                place.vehicle_id == vehicles[v]
                    && category(place.comfort_class, place.kind) == passenger_category(p)
                    && !occupied.contains(place.place_id.as_str())
            })
            .collect();
        candidates.sort_by_key(|place| {
            (
                prior.is_none_or(|old| old.place_id != place.place_id),
                place.place_id.as_str(),
            )
        });
        let place = candidates
            .first()
            .ok_or_else(|| ConductorError("interior_assignment_inconsistent".into()))?;
        occupied.insert(place.place_id.as_str());
        assignments.insert(p.passenger_key.as_str(), place);
        let mut bays: Vec<_> = interior
            .special_bays
            .iter()
            .filter(|bay| {
                bay.vehicle_id == vehicles[v]
                    && bay.space_need == p.space_needs
                    && !occupied_bays.contains(bay.space_id.as_str())
            })
            .collect();
        bays.sort_by_key(|bay| {
            (
                prior.is_none_or(|old| old.space_id.as_deref() != Some(bay.space_id.as_str())),
                bay.space_id.as_str(),
            )
        });
        let bay = bays
            .first()
            .ok_or_else(|| ConductorError("interior_assignment_inconsistent".into()))?;
        occupied_bays.insert(bay.space_id.as_str());
        reserved_bays.insert(p.passenger_key.as_str(), bay);
    }
    let ordinary: Vec<_> = manifest
        .iter()
        .filter(|p| !assignments.contains_key(p.passenger_key.as_str()))
        .cloned()
        .collect();
    let flat = InteriorPassengerPlacesV1 {
        schema_version: INTERIOR_SCHEMA.into(),
        world_id: interior.world_id.clone(),
        train_run_id: interior.train_run_id.clone(),
        layout_id: interior.layout_id.clone(),
        layout_hash: String::new(),
        places: interior
            .places
            .iter()
            .filter(|p| !occupied.contains(p.place_id.as_str()))
            .map(flat_place)
            .collect(),
    };
    let old_flat: Vec<_> = previous
        .iter()
        .filter_map(|p| {
            places
                .get(p.place_id.as_str())
                .map(|place| flat_visible(p, place))
        })
        .collect();
    for passenger in crate::places::assign_places(&input.binding, &flat, &ordinary, &old_flat)? {
        assignments.insert(
            manifest
                .iter()
                .find(|p| p.passenger_key == passenger.passenger_key)
                .expect("bekannt")
                .passenger_key
                .as_str(),
            places[passenger.place_id.as_str()],
        );
    }
    let mut output = vec![];
    for p in manifest {
        let place = assignments[p.passenger_key.as_str()];
        let bay = reserved_bays.get(p.passenger_key.as_str());
        let (body, deck, x, y) = if p.space_needs == SpaceNeedsV1::Wheelchair {
            let bay = bay.expect("reserviert");
            (&bay.body_id, bay.deck_id, bay.x_mm, bay.y_mm)
        } else {
            (&place.body_id, place.deck_id, place.x_mm, place.y_mm)
        };
        output.push(VisiblePassengerV2 {
            passenger_key: p.passenger_key.clone(),
            place_id: place.place_id.clone(),
            space_id: bay.map(|b| b.space_id.clone()),
            vehicle_id: place.vehicle_id.clone(),
            body_id: body.clone(),
            deck_id: deck,
            x_mm: x,
            y_mm: y,
            comfort_class: p.comfort_class,
            space_needs: p.space_needs,
            posture: if p.seat_number.is_some() {
                PassengerPostureV1::Seated
            } else {
                PassengerPostureV1::Standing
            },
            appearance_variant: engine::appearance(&input.binding, &p.passenger_key),
            activity: PassengerActivityV1::Onboard,
        });
    }
    output.sort_by(|a, b| a.passenger_key.cmp(&b.passenger_key));
    Ok(Some(output))
}

pub fn project_conductor_passengers_v2(
    input: &ProjectConductorPassengersInputV2,
) -> Result<PassengerProjectionV2, ConductorError> {
    let interior = validate(input)?;
    let previous_projection = validate_old(input, &interior)?;
    let legacy = ProjectConductorPassengersInputV1 {
        schema_version: INPUT_SCHEMA.into(),
        binding: input.binding.clone(),
        evaluation: input.evaluation.clone(),
        service: input.service.clone(),
        interior,
        previous_projection,
    };
    engine::validate_source(&legacy)?;
    let (active, at_stop) = engine::active_section(&legacy)?;
    let manifests = engine::train_manifests(&legacy)?;
    let previous_index = engine::validate_previous(&legacy, active, &manifests)?;
    let mut passengers = input
        .previous_projection
        .as_ref()
        .map_or_else(Vec::new, |p| p.passengers.clone());
    for manifest in manifests
        .iter()
        .take(active + 1)
        .skip(previous_index.unwrap_or(0))
    {
        passengers = if let Some(assigned) = assign(input, &manifest.passengers, &passengers, true)?
        {
            assigned
        } else {
            assign(input, &manifest.passengers, &passengers, false)?.ok_or_else(|| {
                ConductorError("interior_capacity_and_special_bays_incompatible".into())
            })?
        };
    }
    let to_stop = &input.service.stops[active + 1].stop_id;
    let alighting: BTreeSet<_> = manifests[active]
        .passengers
        .iter()
        .filter(|p| p.alighting_stop_id == *to_stop)
        .map(|p| p.passenger_key.as_str())
        .collect();
    for p in &mut passengers {
        p.activity = if at_stop && alighting.contains(p.passenger_key.as_str()) {
            PassengerActivityV1::Alighting
        } else {
            PassengerActivityV1::Onboard
        };
    }
    let mut output = PassengerProjectionV2 {
        schema_version: PROJECTION_V2_SCHEMA.into(),
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
        source_layout_hash: input.interior.source_layout_hash.clone(),
        layout_hash: input.interior.layout_hash.clone(),
        as_of_ms: input.evaluation.now_ms,
        passengers,
        state_hash: String::new(),
    };
    output.state_hash = json_hash(&output)?;
    Ok(output)
}
pub fn project_conductor_passengers_v2_json(json: &str) -> Result<String, ConductorError> {
    require(
        json.len() <= 128 * 1024 * 1024,
        "conductor_input_size_limit",
    )?;
    Ok(serde_json::to_string(&project_conductor_passengers_v2(
        &serde_json::from_str(json)?,
    )?)?)
}
