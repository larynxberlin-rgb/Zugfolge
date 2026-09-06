//! Synthetischer M10-Nachweis mit echten Nachfrageauswertungen und Haltquittungen.
use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};
use zugfolge_conductor::*;
use zugfolge_demand::*;

fn fixture() -> DemandEvaluationInputV1 {
    serde_json::from_str(include_str!(
        "../../zugfolge-demand/examples/evaluation.json"
    ))
    .unwrap()
}

fn progress(
    previous: &DemandEvaluationInputV1,
    result: DemandEvaluationV1,
    now_ms: i64,
    events: &[(&str, Option<i64>, Option<i64>)],
) -> DemandEvaluationInputV1 {
    let mut next = previous.clone();
    next.revision += 1;
    next.now_ms = now_ms;
    next.previous_evaluation = Some(Box::new(PreviousDemandEvaluationV1 {
        result,
        services: previous.services.clone(),
    }));
    next.operational_progress = Some(DemandOperationalProgressV1 {
        schema_version: "demand-operational-progress/v1".into(),
        world_id: next.world_id.clone(),
        as_of_ms: now_ms,
        receipt_id: format!("receipt-{}", next.revision),
        trains: vec![TrainOperationalProgressV1 {
            train_run_id: "regional-1".into(),
            stops: events
                .iter()
                .map(|(stop, arrival, departure)| StopOperationalProgressV1 {
                    stop_id: (*stop).into(),
                    actual_arrival_ms: *arrival,
                    actual_departure_ms: *departure,
                })
                .collect(),
        }],
    });
    next
}

fn interior(service: &TrainServiceV1) -> InteriorPassengerPlacesV1 {
    let mut places = Vec::new();
    for (class, kind, count) in [
        (
            ComfortClassV1::Standard,
            InteriorPlaceKindV1::Seat,
            service.capacity.standard_seats,
        ),
        (
            ComfortClassV1::Standard,
            InteriorPlaceKindV1::Standing,
            service.capacity.standard_standing,
        ),
        (
            ComfortClassV1::Premium,
            InteriorPlaceKindV1::Seat,
            service.capacity.premium_seats,
        ),
    ] {
        for _ in 0..count {
            let index = i64::try_from(places.len()).unwrap();
            places.push(InteriorPassengerPlaceV1 {
                place_id: format!("place-{index:06}"),
                vehicle_id: format!("balanced-car-{}", index / 128),
                x_mm: index % 128 * 1_000,
                y_mm: 1_000,
                comfort_class: class,
                kind,
                space_needs: vec![
                    SpaceNeedsV1::Ordinary,
                    SpaceNeedsV1::Wheelchair,
                    SpaceNeedsV1::Bicycle,
                    SpaceNeedsV1::Stroller,
                ],
            });
        }
    }
    let mut interior = InteriorPassengerPlacesV1 {
        schema_version: INTERIOR_SCHEMA.into(),
        world_id: service.world_id.clone(),
        train_run_id: service.train_run_id.clone(),
        layout_id: "balanced-test-layout".into(),
        layout_hash: String::new(),
        places,
    };
    interior.layout_hash = interior_places_hash(&interior).unwrap();
    interior
}

fn project_input(
    input: &DemandEvaluationInputV1,
    result: DemandEvaluationV1,
) -> ProjectConductorPassengersInputV1 {
    let service = input
        .services
        .iter()
        .find(|service| service.train_run_id == "regional-1")
        .unwrap()
        .clone();
    let binding = ConductorPassengerBindingV1 {
        world_id: result.world_id.clone(),
        period_id: result.period_id.clone(),
        demand_release_id: result.demand_release_id.clone(),
        release_hash: result.release_hash.clone(),
        seed_hash: result.seed_hash.clone(),
        train_run_id: service.train_run_id.clone(),
        operator_id: service.operator_id.clone(),
        manifest_revision: result.revision,
        demand_state_hash: result.state_hash.clone(),
        operational_receipt_id: result
            .operational_progress
            .as_ref()
            .map_or("forecast", |progress| progress.receipt_id.as_str())
            .into(),
    };
    ProjectConductorPassengersInputV1 {
        schema_version: zugfolge_conductor::INPUT_SCHEMA.into(),
        binding,
        interior: interior(&service),
        evaluation: result,
        service,
        previous_projection: None,
    }
}

fn running(
    initial: &DemandEvaluationInputV1,
) -> (DemandEvaluationInputV1, ProjectConductorPassengersInputV1) {
    let forecast = evaluate_demand(initial).unwrap();
    let started = progress(
        initial,
        forecast,
        700_000,
        &[("regional-leipzig", None, Some(600_000))],
    );
    let result = evaluate_demand(&started).unwrap();
    let input = project_input(&started, result);
    (started, input)
}

fn rehash(input: &mut ProjectConductorPassengersInputV1) {
    input.evaluation.state_hash.clear();
    input.evaluation.state_hash = Sha256::digest(serde_json::to_vec(&input.evaluation).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    input.binding.demand_state_hash = input.evaluation.state_hash.clone();
}

fn assert_exact(input: &ProjectConductorPassengersInputV1, projection: &PassengerProjectionV1) {
    let manifest = input
        .evaluation
        .manifests
        .iter()
        .find(|manifest| {
            manifest.train_run_id == projection.binding.train_run_id
                && manifest.segment_id == projection.segment_id
        })
        .unwrap();
    assert_eq!(
        projection
            .passengers
            .iter()
            .map(|passenger| &passenger.passenger_key)
            .collect::<BTreeSet<_>>(),
        manifest
            .passengers
            .iter()
            .map(|passenger| &passenger.passenger_key)
            .collect::<BTreeSet<_>>()
    );
    assert_eq!(projection.passengers.len(), manifest.passengers.len());
    assert_eq!(
        projection
            .passengers
            .iter()
            .map(|passenger| &passenger.place_id)
            .collect::<BTreeSet<_>>()
            .len(),
        projection.passengers.len()
    );
    assert_eq!(
        projection
            .passengers
            .iter()
            .filter(|passenger| passenger.posture == PassengerPostureV1::Seated)
            .count(),
        manifest
            .passengers
            .iter()
            .filter(|passenger| passenger.seat_number.is_some())
            .count()
    );
    for passenger in &projection.passengers {
        let place = input
            .interior
            .places
            .iter()
            .find(|place| place.place_id == passenger.place_id)
            .unwrap();
        assert_eq!(place.comfort_class, passenger.comfort_class);
        assert!(place.space_needs.contains(&passenger.space_needs));
    }
}

#[test]
fn actual_departure_arrival_disruption_departure_and_restore_follow_real_m10() {
    let (started, first_input) = running(&fixture());
    let first = project_conductor_passengers(&first_input).unwrap();
    assert!(!first.passengers.is_empty());
    assert_exact(&first_input, &first);
    assert_eq!(first.phase, PassengerProjectionPhaseV1::InTransit);
    let arrived = progress(
        &started,
        first_input.evaluation.clone(),
        1_900_000,
        &[
            ("regional-leipzig", None, Some(600_000)),
            ("regional-halle", Some(1_850_000), None),
        ],
    );
    let arrived_result = evaluate_demand(&arrived).unwrap();
    let mut arrived_input = project_input(&arrived, arrived_result.clone());
    arrived_input.previous_projection = Some(first.clone());
    let at_stop = project_conductor_passengers(&arrived_input).unwrap();
    assert_exact(&arrived_input, &at_stop);
    assert_eq!(at_stop.phase, PassengerProjectionPhaseV1::AtStop);
    assert_eq!(at_stop.current_stop_id.as_deref(), Some("regional-halle"));
    assert!(
        at_stop
            .passengers
            .iter()
            .any(|passenger| passenger.activity == PassengerActivityV1::Alighting)
    );
    assert!(
        at_stop
            .passengers
            .iter()
            .any(|passenger| passenger.activity == PassengerActivityV1::Onboard)
    );
    for (before, after) in first.passengers.iter().zip(&at_stop.passengers) {
        assert_eq!(before.place_id, after.place_id);
    }
    let mut departed = progress(
        &arrived,
        arrived_result,
        2_500_000,
        &[
            ("regional-leipzig", None, Some(600_000)),
            ("regional-halle", Some(1_850_000), Some(2_400_000)),
        ],
    );
    // Tatsächlicher Aufenthalt + angepasster nachfolgender Fahrplan durch eine Störung.
    departed.services[0].stops[1].departure_ms = 2_400_000;
    departed.services[0].stops[2].arrival_ms += 480_000;
    departed.services[0].stops[2].departure_ms += 480_000;
    let departed_result = evaluate_demand(&departed).unwrap();
    let mut departed_input = project_input(&departed, departed_result.clone());
    departed_input.previous_projection = Some(at_stop);
    let second = project_conductor_passengers(&departed_input).unwrap();
    assert_exact(&departed_input, &second);
    assert_ne!(first.segment_id, second.segment_id);
    let before: BTreeMap<_, _> = first
        .passengers
        .iter()
        .map(|passenger| (&passenger.passenger_key, passenger))
        .collect();
    let mut continuing = 0;
    for passenger in &second.passengers {
        if let Some(previous) = before.get(&passenger.passenger_key) {
            continuing += 1;
            if previous.posture == passenger.posture {
                assert_eq!(previous.place_id, passenger.place_id);
            }
            assert_eq!(previous.appearance_variant, passenger.appearance_variant);
        }
    }
    assert!(continuing > 0);
    let expected = serde_json::to_string(&second).unwrap();
    assert_eq!(
        project_conductor_passengers_json(&serde_json::to_string(&departed_input).unwrap())
            .unwrap(),
        expected
    );
    departed_input.previous_projection = None;
    assert_eq!(
        project_conductor_passengers(&departed_input).unwrap(),
        second,
        "später Einstieg rekonstruiert dieselben Plätze"
    );
    let completed = progress(
        &departed,
        departed_result,
        6_000_000,
        &[
            ("regional-leipzig", None, Some(600_000)),
            ("regional-halle", Some(1_850_000), Some(2_400_000)),
            ("regional-erfurt", Some(5_880_000), None),
        ],
    );
    let complete_input = project_input(&completed, evaluate_demand(&completed).unwrap());
    assert_eq!(
        project_conductor_passengers(&complete_input).unwrap_err().0,
        "train_completed"
    );
}

#[test]
fn forecast_and_unconfirmed_future_sections_never_become_active() {
    let initial = fixture();
    let forecast = evaluate_demand(&initial).unwrap();
    assert_eq!(
        project_conductor_passengers(&project_input(&initial, forecast))
            .unwrap_err()
            .0,
        "demand_forecast_not_boarded"
    );
    let (_, mut input) = running(&initial);
    input
        .evaluation
        .operational_progress
        .as_mut()
        .unwrap()
        .trains
        .clear();
    rehash(&mut input);
    assert_eq!(
        project_conductor_passengers(&input).unwrap_err().0,
        "missing_train_progress"
    );
    let (_, mut input) = running(&initial);
    input
        .evaluation
        .operational_progress
        .as_mut()
        .unwrap()
        .trains[0]
        .stops[0]
        .actual_departure_ms = Some(input.evaluation.now_ms + 1);
    rehash(&mut input);
    assert_eq!(
        project_conductor_passengers(&input).unwrap_err().0,
        "invalid_progress_time"
    );
    let (_, mut input) = running(&initial);
    input
        .evaluation
        .operational_progress
        .as_mut()
        .unwrap()
        .trains[0]
        .stops[0]
        .actual_departure_ms = None;
    input
        .evaluation
        .operational_progress
        .as_mut()
        .unwrap()
        .trains[0]
        .stops[0]
        .actual_arrival_ms = Some(600_000);
    rehash(&mut input);
    assert_eq!(
        project_conductor_passengers(&input).unwrap_err().0,
        "train_not_departed"
    );
}

#[test]
fn scope_hash_duplicates_capacity_and_restore_fail_closed() {
    let (_, input) = running(&fixture());
    type InputMutation = Box<dyn Fn(&mut ProjectConductorPassengersInputV1)>;
    let mutations: Vec<InputMutation> = vec![
        Box::new(|input| input.binding.world_id = "foreign".into()),
        Box::new(|input| input.binding.period_id = "foreign".into()),
        Box::new(|input| input.binding.demand_release_id = "foreign".into()),
        Box::new(|input| input.binding.release_hash = "a".repeat(64)),
        Box::new(|input| input.binding.seed_hash = "a".repeat(64)),
        Box::new(|input| input.binding.manifest_revision += 1),
        Box::new(|input| input.binding.operational_receipt_id = "foreign".into()),
        Box::new(|input| input.service.operator_id = "foreign".into()),
        Box::new(|input| input.service.mode = RailModeV1::Spfv),
        Box::new(|input| input.service.cancelled = true),
        Box::new(|input| input.interior.world_id = "foreign".into()),
        Box::new(|input| input.interior.places[0].x_mm = -1),
        Box::new(|input| {
            input.interior.places[0]
                .space_needs
                .push(SpaceNeedsV1::Ordinary)
        }),
        Box::new(|input| {
            input.interior.places.pop();
        }),
        Box::new(|input| input.evaluation.manifests[0].passengers[0].seat_number = Some(999)),
    ];
    for mutation in mutations {
        let mut corrupt = input.clone();
        mutation(&mut corrupt);
        assert!(project_conductor_passengers(&corrupt).is_err());
    }
    let mut duplicate = input.clone();
    duplicate
        .evaluation
        .manifests
        .push(duplicate.evaluation.manifests[0].clone());
    rehash(&mut duplicate);
    assert_eq!(
        project_conductor_passengers(&duplicate).unwrap_err().0,
        "duplicate_demand_row"
    );
    let mut duplicate = input.clone();
    let passenger = duplicate.evaluation.manifests[0].passengers[0].clone();
    duplicate.evaluation.manifests[0].passengers.push(passenger);
    rehash(&mut duplicate);
    assert_eq!(
        project_conductor_passengers(&duplicate).unwrap_err().0,
        "invalid_manifest_passenger"
    );
    let mut invalid = input.clone();
    invalid
        .evaluation
        .allocations
        .iter_mut()
        .find(|row| row.train_run_id == "regional-1")
        .unwrap()
        .seated += 1;
    rehash(&mut invalid);
    assert_eq!(
        project_conductor_passengers(&invalid).unwrap_err().0,
        "manifest_capacity_mismatch"
    );
    let mut invalid = input.clone();
    invalid
        .evaluation
        .stop_flows
        .iter_mut()
        .find(|row| row.train_run_id == "regional-1")
        .unwrap()
        .boarding += 1;
    rehash(&mut invalid);
    assert_eq!(
        project_conductor_passengers(&invalid).unwrap_err().0,
        "stop_flow_mismatch"
    );
    let valid = project_conductor_passengers(&input).unwrap();
    let mut invalid = input.clone();
    invalid.previous_projection = Some(valid.clone());
    invalid.previous_projection.as_mut().unwrap().passengers[0].place_id = "foreign".into();
    assert_eq!(
        project_conductor_passengers(&invalid).unwrap_err().0,
        "previous_projection_hash_mismatch"
    );
    invalid.previous_projection = Some(valid);
    invalid
        .previous_projection
        .as_mut()
        .unwrap()
        .binding
        .period_id = "foreign".into();
    assert_eq!(
        project_conductor_passengers(&invalid).unwrap_err().0,
        "previous_projection_scope_mismatch"
    );
    let mut json = serde_json::to_value(&input).unwrap();
    json["appearance"] = "forbidden-input".into();
    assert_eq!(
        project_conductor_passengers_json(&json.to_string())
            .unwrap_err()
            .0,
        "invalid_conductor_json"
    );
}

#[test]
fn visible_population_does_not_depend_on_hidden_fare_facts() {
    let (_, input) = running(&fixture());
    let expected = project_conductor_passengers(&input).unwrap();
    for fact in [
        FareFactV1::Valid,
        FareFactV1::ValidUnpresentable,
        FareFactV1::Invalid,
    ] {
        let mut changed = input.clone();
        for passenger in changed
            .evaluation
            .manifests
            .iter_mut()
            .flat_map(|manifest| &mut manifest.passengers)
        {
            passenger.fare_fact = fact;
        }
        rehash(&mut changed);
        let output = project_conductor_passengers(&changed).unwrap();
        assert_eq!(output.passengers, expected.passengers);
        let visible = serde_json::to_string(&output).unwrap();
        for hidden in [
            "fareFact",
            "journeyChainId",
            "farePolicyProvenance",
            "demandSegment",
            "boardingStopId",
            "alightingStopId",
            "reservationId",
        ] {
            assert!(!visible.contains(hidden), "verdecktes Feld {hidden}");
        }
    }
}

#[test]
fn seed_capacity_permutation_and_json_roundtrip_properties() {
    for seed in 0..48 {
        let mut initial = fixture();
        initial.seed = seed.to_string();
        initial.services[0].capacity.standard_seats = seed % 8 + 1;
        initial.services[0].capacity.standard_standing = seed % 4;
        let (_, mut input) = running(&initial);
        let expected = project_conductor_passengers(&input).unwrap();
        assert_exact(&input, &expected);
        initial.services.reverse();
        initial.alternatives.reverse();
        initial.release.zones.reverse();
        initial.release.profiles.reverse();
        initial.release.day_slices.reverse();
        let (_, permuted_source) = running(&initial);
        assert_eq!(permuted_source.evaluation, input.evaluation);
        assert_eq!(
            project_conductor_passengers(&permuted_source).unwrap(),
            expected
        );
        input.interior.places.reverse();
        for place in &mut input.interior.places {
            place.space_needs.reverse();
        }
        // Das echte M10-Ergebnis bleibt mit seiner Originalprüfsumme gepinnt.
        assert_eq!(project_conductor_passengers(&input).unwrap(), expected);
        assert_eq!(
            project_conductor_passengers_json(&serde_json::to_string(&input).unwrap()).unwrap(),
            serde_json::to_string(&expected).unwrap()
        );
        input.previous_projection = Some(expected.clone());
        assert_eq!(project_conductor_passengers(&input).unwrap(), expected);
    }
}

#[test]
fn fully_loaded_4096_passenger_train_has_no_logical_culling() {
    let mut initial = fixture();
    initial.release.zones[0].population = 100_000;
    initial.release.max_generated_passengers = 100_000;
    initial.services[0].capacity.standard_seats = 3_072;
    initial.services[0].capacity.standard_standing = 1_024;
    let (_, input) = running(&initial);
    let output = project_conductor_passengers(&input).unwrap();
    assert_exact(&input, &output);
    assert_eq!(output.passengers.len(), 4_096);
    assert_eq!(
        output
            .passengers
            .iter()
            .filter(|passenger| passenger.posture == PassengerPostureV1::Standing)
            .count(),
        1_024
    );
    assert_eq!(
        project_conductor_passengers_json(&serde_json::to_string(&input).unwrap()).unwrap(),
        serde_json::to_string(&output).unwrap()
    );
}

#[test]
fn all_space_needs_and_premium_are_projected_from_actual_m10() {
    for needs in [
        SpaceNeedsV1::Ordinary,
        SpaceNeedsV1::Wheelchair,
        SpaceNeedsV1::Bicycle,
        SpaceNeedsV1::Stroller,
    ] {
        for comfort in [ComfortClassV1::Standard, ComfortClassV1::Premium] {
            let mut initial = fixture();
            initial.release.profiles[0].space_needs = needs;
            initial.release.profiles[0].comfort_class = comfort;
            if comfort == ComfortClassV1::Premium {
                for service in &mut initial.services {
                    service.capacity.premium_seats = 4;
                    service.fares[0].comfort_class = comfort;
                }
            }
            let (_, input) = running(&initial);
            let output = project_conductor_passengers(&input).unwrap();
            assert!(!output.passengers.is_empty());
            assert_exact(&input, &output);
            assert!(
                output
                    .passengers
                    .iter()
                    .all(|passenger| passenger.space_needs == needs
                        && passenger.comfort_class == comfort)
            );
        }
    }
}
