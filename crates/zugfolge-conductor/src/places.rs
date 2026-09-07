use std::collections::{BTreeMap, BTreeSet, VecDeque};

use zugfolge_demand::{ComfortClassV1, ManifestPassengerV1, SpaceNeedsV1};

use crate::{
    ConductorError,
    engine::{appearance, digest},
    ensure,
    types::*,
};

type Category = (ComfortClassV1, InteriorPlaceKindV1, SpaceNeedsV1);
type PlaceGroup = (ComfortClassV1, InteriorPlaceKindV1, u8);

fn bit(needs: SpaceNeedsV1) -> u8 {
    match needs {
        SpaceNeedsV1::Ordinary => 1,
        SpaceNeedsV1::Wheelchair => 2,
        SpaceNeedsV1::Bicycle => 4,
        SpaceNeedsV1::Stroller => 8,
    }
}

fn category(passenger: &ManifestPassengerV1) -> Category {
    (
        passenger.comfort_class,
        if passenger.seat_number.is_some() {
            InteriorPlaceKindV1::Seat
        } else {
            InteriorPlaceKindV1::Standing
        },
        passenger.space_needs,
    )
}

fn visible(
    binding: &ConductorPassengerBindingV1,
    passenger: &ManifestPassengerV1,
    place: &InteriorPassengerPlaceV1,
) -> VisiblePassengerV1 {
    VisiblePassengerV1 {
        passenger_key: passenger.passenger_key.clone(),
        place_id: place.place_id.clone(),
        vehicle_id: place.vehicle_id.clone(),
        x_mm: place.x_mm,
        y_mm: place.y_mm,
        comfort_class: passenger.comfort_class,
        space_needs: passenger.space_needs,
        posture: if passenger.seat_number.is_some() {
            PassengerPostureV1::Seated
        } else {
            PassengerPostureV1::Standing
        },
        appearance_variant: appearance(binding, &passenger.passenger_key),
        activity: PassengerActivityV1::Onboard,
    }
}

fn augment_flow(residual: &mut [Vec<usize>], source: usize, sink: usize, total: usize) -> usize {
    let mut matched = 0;
    loop {
        let mut parents = vec![None; sink + 1];
        parents[source] = Some(source);
        let mut queue = VecDeque::from([source]);
        while let Some(node) = queue.pop_front() {
            for (next, parent) in parents.iter_mut().enumerate() {
                if parent.is_none() && residual[node][next] > 0 {
                    *parent = Some(node);
                    queue.push_back(next);
                }
            }
        }
        if parents[sink].is_none() {
            break;
        }
        let mut amount = total;
        let mut node = sink;
        while node != source {
            let parent = parents[node].expect("erreichbarer Flusspfad");
            amount = amount.min(residual[parent][node]);
            node = parent;
        }
        node = sink;
        while node != source {
            let parent = parents[node].expect("erreichbarer Flusspfad");
            residual[parent][node] -= amount;
            residual[node][parent] += amount;
            node = parent;
        }
        matched += amount;
    }
    matched
}

pub(crate) fn assign_places(
    binding: &ConductorPassengerBindingV1,
    interior: &InteriorPassengerPlacesV1,
    passengers: &[ManifestPassengerV1],
    previous: &[VisiblePassengerV1],
) -> Result<Vec<VisiblePassengerV1>, ConductorError> {
    let old: BTreeMap<_, _> = previous
        .iter()
        .map(|passenger| (passenger.passenger_key.as_str(), passenger))
        .collect();
    let places: BTreeMap<_, _> = interior
        .places
        .iter()
        .map(|place| (place.place_id.as_str(), place))
        .collect();
    let mut output = Vec::with_capacity(passengers.len());
    let mut remaining: BTreeMap<Category, Vec<(&ManifestPassengerV1, String)>> = BTreeMap::new();
    for passenger in passengers {
        let category = category(passenger);
        remaining.entry(category).or_default().push((
            passenger,
            digest(&[
                "conductor_places_v1",
                &binding.world_id,
                &binding.seed_hash,
                &binding.train_run_id,
                &passenger.passenger_key,
            ]),
        ));
    }
    let mut available: BTreeMap<PlaceGroup, Vec<&InteriorPassengerPlaceV1>> = BTreeMap::new();
    for place in places.values() {
        let mask = place
            .space_needs
            .iter()
            .fold(0, |mask, needs| mask | bit(*needs));
        available
            .entry((place.comfort_class, place.kind, mask))
            .or_default()
            .push(place);
    }
    let mut categories: Vec<_> = remaining.into_iter().collect();
    for (_, passengers) in &mut categories {
        passengers.sort_by(|a, b| (&a.1, &a.0.passenger_key).cmp(&(&b.1, &b.0.passenger_key)));
    }
    let mut groups: Vec<_> = available.into_iter().collect();
    // Maximal 16 Bedarfskategorien und 60 Platzgruppen: Die Flussgröße hängt
    // nicht von der Fahrzeuglänge ab. Mehrzweckplätze werden gemeinsam geprüft,
    // sodass eine frühe flexible Zuordnung keinen passenden Spezialplatz blockiert.
    let source = 0;
    let first_group = 1 + categories.len();
    let sink = first_group + groups.len();
    let mut residual = vec![vec![0_usize; sink + 1]; sink + 1];
    let total: usize = categories
        .iter()
        .map(|(_, passengers)| passengers.len())
        .sum();
    for (index, (category, passengers)) in categories.iter().enumerate() {
        residual[source][index + 1] = passengers.len();
        for (group_index, (group, _)) in groups.iter().enumerate() {
            if category.0 == group.0 && category.1 == group.1 && group.2 & bit(category.2) != 0 {
                residual[index + 1][first_group + group_index] = total;
            }
        }
    }
    for (index, (_, places)) in groups.iter().enumerate() {
        residual[first_group + index][sink] = places.len();
    }
    // Bereits belegte passende Plätze bilden den Anfangsfluss. Rückkanten
    // erlauben nur bei zusätzlichem Platzbedarf die notwendige Umplatzierung.
    let mut preserved: BTreeMap<
        (usize, usize),
        Vec<(&ManifestPassengerV1, &InteriorPassengerPlaceV1)>,
    > = BTreeMap::new();
    let mut occupied = BTreeSet::new();
    let mut matched = 0;
    for (index, (category, passengers)) in categories.iter().enumerate() {
        for (passenger, _) in passengers {
            if let Some(place) = old
                .get(passenger.passenger_key.as_str())
                .and_then(|old| places.get(old.place_id.as_str()))
                .filter(|place| {
                    place.comfort_class == category.0
                        && place.kind == category.1
                        && place.space_needs.contains(&category.2)
                })
            {
                ensure(
                    occupied.insert(place.place_id.as_str()),
                    "duplicate_preserved_place",
                )?;
                let mask = place
                    .space_needs
                    .iter()
                    .fold(0, |mask, needs| mask | bit(*needs));
                let group_index = groups
                    .iter()
                    .position(|(group, _)| *group == (place.comfort_class, place.kind, mask))
                    .expect("bekannte Platzgruppe");
                preserved
                    .entry((index, group_index))
                    .or_default()
                    .push((passenger, place));
                for (from, to) in [
                    (source, index + 1),
                    (index + 1, first_group + group_index),
                    (first_group + group_index, sink),
                ] {
                    residual[from][to] -= 1;
                    residual[to][from] += 1;
                }
                matched += 1;
            }
        }
    }
    // Erst alle unveränderten Plätze sperren. Auch eine ungünstige Zuteilung
    // unter neuen Reisenden wird zunächst ausschließlich unter ihnen repariert.
    for ((index, group_index), assignments) in &preserved {
        residual[first_group + *group_index][*index + 1] -= assignments.len();
    }
    matched += augment_flow(&mut residual, source, sink, total);
    for ((index, group_index), assignments) in &preserved {
        residual[first_group + *group_index][*index + 1] += assignments.len();
    }
    if matched < total {
        // Nur wenn keine vollständige Lösung mit allen erhaltenen Plätzen
        // existiert, dürfen Rückkanten auch die bisher Reisenden umplatzieren.
        matched += augment_flow(&mut residual, source, sink, total);
    }
    ensure(matched == total, "insufficient_compatible_interior_places")?;
    let mut retained_passengers = BTreeSet::new();
    let mut retained_places = BTreeSet::new();
    let mut retained_counts = BTreeMap::new();
    for ((index, group_index), assignments) in &preserved {
        let count = assignments
            .len()
            .min(residual[first_group + *group_index][*index + 1]);
        retained_counts.insert((*index, *group_index), count);
        for (passenger, place) in assignments.iter().take(count) {
            output.push(visible(binding, passenger, place));
            retained_passengers.insert(passenger.passenger_key.as_str());
            retained_places.insert(place.place_id.as_str());
        }
    }
    for (_, places) in &mut groups {
        places.retain(|place| !retained_places.contains(place.place_id.as_str()));
    }
    for (index, (_, passengers)) in categories.iter().enumerate() {
        let mut next_passenger = passengers.iter().filter(|(passenger, _)| {
            !retained_passengers.contains(passenger.passenger_key.as_str())
        });
        for (group_index, (_, places)) in groups.iter_mut().enumerate() {
            let retained = retained_counts
                .get(&(index, group_index))
                .copied()
                .unwrap_or(0);
            for _ in retained..residual[first_group + group_index][index + 1] {
                let (passenger, _) = next_passenger.next().expect("vollständige Bedarfsdeckung");
                let place = places.pop().expect("kapazitätsgeprüfte Zuordnung");
                output.push(visible(binding, passenger, place));
            }
        }
    }
    output.sort_by(|a, b| a.passenger_key.cmp(&b.passenger_key));
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zugfolge_demand::{FareFactV1, Provenance};

    fn binding() -> ConductorPassengerBindingV1 {
        ConductorPassengerBindingV1 {
            world_id: "balanced-test".into(),
            period_id: "period".into(),
            demand_release_id: "release".into(),
            release_hash: "a".repeat(64),
            seed_hash: "b".repeat(64),
            train_run_id: "train".into(),
            operator_id: "operator".into(),
            manifest_revision: 1,
            demand_state_hash: "c".repeat(64),
            operational_receipt_id: "receipt".into(),
        }
    }

    fn passenger(index: usize, needs: SpaceNeedsV1) -> ManifestPassengerV1 {
        ManifestPassengerV1 {
            passenger_key: format!("{index:064x}"),
            journey_chain_id: "a".repeat(64),
            boarding_stop_id: "a".into(),
            alighting_stop_id: "b".into(),
            demand_segment: "balanced-test".into(),
            comfort_class: ComfortClassV1::Standard,
            space_needs: needs,
            fare_fact: FareFactV1::Valid,
            fare_policy_provenance: Provenance::Balanced,
            reservation_id: None,
            seat_number: Some(u32::try_from(index + 1).unwrap()),
        }
    }

    fn layout(masks: &[u8]) -> InteriorPassengerPlacesV1 {
        InteriorPassengerPlacesV1 {
            schema_version: INTERIOR_SCHEMA.into(),
            world_id: "balanced-test".into(),
            train_run_id: "train".into(),
            layout_id: "layout".into(),
            layout_hash: "d".repeat(64),
            places: masks
                .iter()
                .enumerate()
                .map(|(index, mask)| InteriorPassengerPlaceV1 {
                    place_id: format!("place-{index}"),
                    vehicle_id: "car".into(),
                    x_mm: i64::try_from(index).unwrap() * 1_000,
                    y_mm: 1_000,
                    comfort_class: ComfortClassV1::Standard,
                    kind: InteriorPlaceKindV1::Seat,
                    space_needs: [
                        SpaceNeedsV1::Ordinary,
                        SpaceNeedsV1::Wheelchair,
                        SpaceNeedsV1::Bicycle,
                        SpaceNeedsV1::Stroller,
                    ]
                    .into_iter()
                    .filter(|need| bit(*need) & mask != 0)
                    .collect(),
                })
                .collect(),
        }
    }

    #[test]
    fn new_wheelchair_passenger_can_repair_an_existing_flexible_place() {
        let layout = layout(&[3, 1]);
        let before = vec![
            passenger(1, SpaceNeedsV1::Ordinary),
            passenger(2, SpaceNeedsV1::Ordinary),
        ];
        let first = assign_places(&binding(), &layout, &before, &[]).unwrap();
        let flexible = first
            .iter()
            .find(|passenger| passenger.place_id == "place-0")
            .unwrap();
        let survivor = before
            .iter()
            .find(|passenger| passenger.passenger_key == flexible.passenger_key)
            .unwrap()
            .clone();
        let wheelchair = passenger(3, SpaceNeedsV1::Wheelchair);
        let after = assign_places(
            &binding(),
            &layout,
            &[survivor.clone(), wheelchair.clone()],
            &first,
        )
        .unwrap();
        assert_eq!(
            after
                .iter()
                .find(|passenger| passenger.passenger_key == survivor.passenger_key)
                .unwrap()
                .place_id,
            "place-1"
        );
        assert_eq!(
            after
                .iter()
                .find(|passenger| passenger.passenger_key == wheelchair.passenger_key)
                .unwrap()
                .place_id,
            "place-0"
        );
        assert_eq!(
            assign_places(&binding(), &layout, &before, &first).unwrap(),
            first
        );
    }

    #[test]
    fn reassign_new_passengers_before_moving_an_existing_passenger() {
        let layout = layout(&[1, 5, 6, 10]);
        let before = vec![
            passenger(1, SpaceNeedsV1::Ordinary),
            passenger(2, SpaceNeedsV1::Ordinary),
        ];
        let first = assign_places(&binding(), &layout, &before, &[]).unwrap();
        let flexible = first
            .iter()
            .find(|passenger| passenger.place_id == "place-1")
            .unwrap();
        let survivor = before
            .iter()
            .find(|passenger| passenger.passenger_key == flexible.passenger_key)
            .unwrap()
            .clone();
        let wheelchair = passenger(3, SpaceNeedsV1::Wheelchair);
        let bicycle = passenger(4, SpaceNeedsV1::Bicycle);
        let after = assign_places(
            &binding(),
            &layout,
            &[survivor.clone(), wheelchair.clone(), bicycle.clone()],
            &first,
        )
        .unwrap();
        assert_eq!(
            after
                .iter()
                .find(|passenger| passenger.passenger_key == survivor.passenger_key)
                .unwrap()
                .place_id,
            "place-1"
        );
        assert_eq!(
            after
                .iter()
                .find(|passenger| passenger.passenger_key == wheelchair.passenger_key)
                .unwrap()
                .place_id,
            "place-3"
        );
        assert_eq!(
            after
                .iter()
                .find(|passenger| passenger.passenger_key == bicycle.passenger_key)
                .unwrap()
                .place_id,
            "place-2"
        );
    }

    fn brute_force(needs: &[SpaceNeedsV1], masks: &[u8], used: &mut BTreeSet<usize>) -> bool {
        let Some((first, rest)) = needs.split_first() else {
            return true;
        };
        for (index, mask) in masks.iter().enumerate() {
            if mask & bit(*first) != 0 && used.insert(index) {
                if brute_force(rest, masks, used) {
                    return true;
                }
                used.remove(&index);
            }
        }
        false
    }

    #[test]
    fn grouped_matching_agrees_with_independent_exhaustive_assignment() {
        let needs = [
            SpaceNeedsV1::Ordinary,
            SpaceNeedsV1::Wheelchair,
            SpaceNeedsV1::Bicycle,
            SpaceNeedsV1::Stroller,
        ];
        for pattern in 0..256_usize {
            let masks: Vec<_> = (0..6)
                .map(|index| u8::try_from((pattern * (index + 3) + index * 7) % 15 + 1).unwrap())
                .collect();
            let request: Vec<_> = (0..5)
                .map(|index| needs[(pattern / (index + 1) + index) % 4])
                .collect();
            let passengers: Vec<_> = request
                .iter()
                .enumerate()
                .map(|(index, needs)| passenger(index, *needs))
                .collect();
            let expected = brute_force(&request, &masks, &mut BTreeSet::new());
            let result = assign_places(&binding(), &layout(&masks), &passengers, &[]);
            assert_eq!(result.is_ok(), expected, "Muster {pattern}");
            if let Ok(projected) = result {
                let after_request: Vec<_> = request
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| index % 2 == 0)
                    .map(|(_, needs)| *needs)
                    .chain([needs[(pattern + 1) % 4]])
                    .collect();
                let mut after_passengers: Vec<_> = passengers
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| index % 2 == 0)
                    .map(|(_, passenger)| passenger.clone())
                    .collect();
                after_passengers.push(passenger(99, needs[(pattern + 1) % 4]));
                let after =
                    assign_places(&binding(), &layout(&masks), &after_passengers, &projected);
                assert_eq!(
                    after.is_ok(),
                    brute_force(&after_request, &masks, &mut BTreeSet::new()),
                    "Fortschreibung {pattern}"
                );
            }
        }
    }
}
