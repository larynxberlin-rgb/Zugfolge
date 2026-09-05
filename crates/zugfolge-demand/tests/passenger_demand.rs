//! Synthetische Pilotregion, Kapazitätsinvarianten und deterministisches Replay.
use std::collections::{BTreeMap, BTreeSet};

use zugfolge_demand::*;

fn fixture() -> DemandEvaluationInputV1 {
    serde_json::from_str(include_str!("../examples/evaluation.json")).unwrap()
}

fn assert_conservation(result: &DemandEvaluationV1) {
    assert_eq!(
        result.totals.generated,
        result.totals.rail + result.totals.alternative + result.totals.unserved
    );
    for cohort in &result.cohorts {
        let served: u32 = result
            .choices
            .iter()
            .filter(|row| row.cohort_id == cohort.cohort_id)
            .map(|row| row.passengers)
            .sum();
        let unserved: u32 = result
            .unserved
            .iter()
            .filter(|row| row.cohort_id == cohort.cohort_id)
            .map(|row| row.passengers)
            .sum();
        assert_eq!(cohort.passengers, served + unserved);
        let mut intervals: Vec<_> = result
            .choices
            .iter()
            .filter(|row| row.cohort_id == cohort.cohort_id)
            .map(|row| (row.ordinal_start, row.passengers))
            .chain(
                result
                    .unserved
                    .iter()
                    .filter(|row| row.cohort_id == cohort.cohort_id)
                    .map(|row| (row.ordinal_start, row.passengers)),
            )
            .collect();
        intervals.sort();
        let mut next = 0;
        for (start, count) in intervals {
            assert_eq!(start, next);
            next += count;
        }
    }
    let mut before = BTreeMap::<&str, u32>::new();
    for flow in &result.stop_flows {
        let previous = *before.get(flow.train_run_id.as_str()).unwrap_or(&0);
        assert_eq!(
            previous + flow.boarding - flow.alighting,
            flow.onboard_after
        );
        before.insert(&flow.train_run_id, flow.onboard_after);
        if let Some(allocation) = result
            .allocations
            .iter()
            .find(|row| row.train_run_id == flow.train_run_id && row.from_stop_id == flow.stop_id)
        {
            assert_eq!(flow.onboard_after, allocation.passengers);
            assert_eq!(
                allocation.passengers,
                allocation.seated + allocation.standing
            );
            assert!(allocation.passengers <= allocation.capacity);
            if allocation.mode == RailModeV1::Spnv {
                let manifest = result
                    .manifests
                    .iter()
                    .find(|row| {
                        row.train_run_id == allocation.train_run_id
                            && row.segment_id == allocation.segment_id
                    })
                    .unwrap();
                assert_eq!(
                    manifest.passengers.len(),
                    usize::try_from(allocation.passengers).unwrap()
                );
                assert_eq!(
                    manifest.passengers.len(),
                    manifest
                        .passengers
                        .iter()
                        .map(|row| &row.passenger_key)
                        .collect::<BTreeSet<_>>()
                        .len()
                );
            }
        }
    }
    assert!(before.values().all(|count| *count == 0));
    assert_eq!(
        result.totals.forecast_revenue_cents,
        result
            .allocations
            .iter()
            .map(|row| row.forecast_revenue_cents)
            .sum::<i64>()
    );
}

#[test]
fn pilot_daily_demand_is_shared_and_conserved() {
    let input = fixture();
    let result = evaluate_demand(&input).unwrap();
    assert_eq!(result.totals.generated, 40);
    assert_eq!(
        result.state_hash, "a1bf6cc8531bc09a1ce2a523f48112e9d78c0bffe1f8c1856e40cb3248e517b1",
        "balanced pilot golden; not a real-world calibration claim"
    );
    assert_eq!(
        result
            .cohorts
            .iter()
            .filter(|row| row.origin_zone_id == "leipzig")
            .map(|row| row.passengers)
            .sum::<u32>(),
        20
    );
    assert!(
        result
            .choices
            .iter()
            .any(|row| row.trains.iter().any(|leg| leg.mode == RailModeV1::Spnv))
    );
    assert!(
        result
            .choices
            .iter()
            .any(|row| row.trains.iter().any(|leg| leg.mode == RailModeV1::Spfv))
    );
    assert!(result.totals.unserved > 0);
    assert!(result.allocations.iter().any(|row| row.standing > 0));
    assert!(result.choices.iter().any(|row| !row.rejected.is_empty()));
    assert_conservation(&result);
    let mut rest = input;
    rest.day_slice_id = "rest".into();
    rest.window_start_ms = 600_000;
    rest.window_end_ms = 86_400_000;
    assert_eq!(evaluate_demand(&rest).unwrap().totals.generated, 120);
}

#[test]
fn permutation_seed_conservation_and_json_restore_properties() {
    for seed in 0..48 {
        let mut input = fixture();
        input.seed = seed.to_string();
        input.services[0].capacity.standard_seats = seed % 8;
        input.services[0].capacity.standard_standing = seed % 4;
        let expected = evaluate_demand(&input).unwrap();
        assert_conservation(&expected);
        input.services.reverse();
        input.alternatives.reverse();
        input.release.zones.reverse();
        input.release.profiles.reverse();
        input.release.day_slices.reverse();
        for zone in &mut input.release.zones {
            zone.stations.reverse();
        }
        for service in &mut input.services {
            service.fares.reverse();
        }
        assert_eq!(evaluate_demand(&input).unwrap(), expected, "seed {seed}");
        let restored: DemandEvaluationInputV1 =
            serde_json::from_str(&serde_json::to_string(&input).unwrap()).unwrap();
        assert_eq!(
            evaluate_demand_json(&serde_json::to_string(&restored).unwrap()).unwrap(),
            serde_json::to_string(&expected).unwrap()
        );
        let restored_result: DemandEvaluationV1 =
            serde_json::from_str(&serde_json::to_string(&expected).unwrap()).unwrap();
        assert_eq!(restored_result, expected);
    }
}

#[test]
fn release_world_period_and_window_validation_fails_closed() {
    let mut input = fixture();
    input.services[0].world_id = "foreign".into();
    assert_eq!(evaluate_demand(&input).unwrap_err().0, "world_mismatch");
    input = fixture();
    input.release.provenance = Provenance::Observed;
    assert_eq!(
        evaluate_demand(&input).unwrap_err().0,
        "observed_release_requires_sources"
    );
    input = fixture();
    input.seed = "042".into();
    assert_eq!(evaluate_demand(&input).unwrap_err().0, "invalid_world_seed");
    input = fixture();
    input.window_start_ms += 1;
    assert_eq!(
        evaluate_demand(&input).unwrap_err().0,
        "day_slice_window_mismatch"
    );
    input = fixture();
    input.release.profiles[0].ranking[0] = ChoiceDimensionV1::Time;
    assert_eq!(
        evaluate_demand(&input).unwrap_err().0,
        "invalid_lexicographic_ranking"
    );
    input = fixture();
    input.release.max_generated_passengers = 1;
    assert_eq!(
        evaluate_demand(&input).unwrap_err().0,
        "generated_passenger_limit"
    );
    let first = evaluate_demand(&fixture()).unwrap();
    input = fixture();
    input.period_id = "period-2".into();
    let second = evaluate_demand(&input).unwrap();
    assert!(first.cohorts.iter().all(|row| {
        second
            .cohorts
            .iter()
            .all(|other| row.cohort_id != other.cohort_id)
    }));
    let mut json = serde_json::to_value(fixture()).unwrap();
    json["appearance"] = "forbidden-at-demand-boundary".into();
    assert_eq!(
        evaluate_demand_json(&json.to_string()).unwrap_err().0,
        "invalid_demand_json"
    );
}

fn identity_map(result: &DemandEvaluationV1) -> BTreeMap<String, (String, FareFactV1)> {
    result
        .manifests
        .iter()
        .flat_map(|row| &row.passengers)
        .map(|row| {
            (
                row.passenger_key.clone(),
                (row.journey_chain_id.clone(), row.fare_fact),
            )
        })
        .collect()
}

#[test]
fn disruption_revisions_preserve_remaining_identity_and_fare_facts() {
    let mut input = fixture();
    input.services[0].capacity.standard_seats = 100;
    input.services[0].capacity.standard_standing = 0;
    let before = evaluate_demand(&input).unwrap();
    let identities = identity_map(&before);
    input.revision += 1;
    input.now_ms = 100;
    input.services[0].stops[1].passenger_stop = false;
    let after = evaluate_demand(&input).unwrap();
    assert_ne!(before.state_hash, after.state_hash);
    assert_eq!(before.cohorts, after.cohorts);
    assert!(!identity_map(&after).is_empty());
    for (key, fact) in identity_map(&after) {
        assert_eq!(identities.get(&key), Some(&fact));
    }
    assert!(after.manifests.iter().all(|row| row.revision == 2));
    assert_conservation(&after);
    input.services[0].cancelled = true;
    input.revision += 1;
    let cancelled = evaluate_demand(&input).unwrap();
    assert!(
        cancelled
            .manifests
            .iter()
            .all(|row| row.passengers.is_empty())
    );
    assert_eq!(before.cohorts, cancelled.cohorts);
    assert_conservation(&cancelled);
}

#[test]
fn fares_comfort_and_sales_change_lexicographic_choice() {
    let mut input = fixture();
    input.services[0].capacity.standard_seats = 100;
    let baseline = evaluate_demand(&input).unwrap();
    let express_count = |result: &DemandEvaluationV1| {
        result
            .choices
            .iter()
            .filter(|row| row.trains.iter().any(|leg| leg.train_run_id == "express-1"))
            .map(|row| row.passengers)
            .sum::<u32>()
    };
    assert_eq!(express_count(&baseline), 0);
    input.services[1].fares[0].cents_per_segment = 100;
    let cheaper = evaluate_demand(&input).unwrap();
    assert!(express_count(&cheaper) > 0);
    input.services[1].fares[0].sales_available = false;
    let outage = evaluate_demand(&input).unwrap();
    assert_eq!(express_count(&outage), 0);
    input.services[1].fares[0].onboard_sales = true;
    assert!(express_count(&evaluate_demand(&input).unwrap()) > 0);
    input = fixture();
    input.services[0].capacity.standard_seats = 100;
    input.release.profiles[0].ranking = vec![
        ChoiceDimensionV1::Comfort,
        ChoiceDimensionV1::Fare,
        ChoiceDimensionV1::Time,
        ChoiceDimensionV1::Transfers,
        ChoiceDimensionV1::Frequency,
        ChoiceDimensionV1::Reliability,
    ];
    assert!(express_count(&evaluate_demand(&input).unwrap()) > 0);
    input.services[1].comfort_basis_points = 0;
    assert_eq!(express_count(&evaluate_demand(&input).unwrap()), 0);
}

#[test]
fn reservation_and_space_contingents_never_overbook_or_change_fare_status() {
    let mut input = fixture();
    input.release.profiles[0].requires_reservation = true;
    input.services[0].capacity.standard_seats = 1;
    input.services[0].capacity.standard_standing = 10;
    let result = evaluate_demand(&input).unwrap();
    assert!(
        result
            .allocations
            .iter()
            .filter(|row| row.mode == RailModeV1::Spnv)
            .all(|row| row.passengers <= 1 && row.standing == 0)
    );
    for manifest in &result.manifests {
        assert!(
            manifest
                .passengers
                .iter()
                .all(|row| row.reservation_id.is_some() && row.seat_number.is_some())
        );
        assert_eq!(
            manifest.passengers.len(),
            manifest
                .passengers
                .iter()
                .map(|row| row.seat_number)
                .collect::<BTreeSet<_>>()
                .len()
        );
    }
    input = fixture();
    input.services[0].capacity.standard_seats = 100;
    input.services[0].capacity.wheelchair_spaces = 100;
    let baseline = evaluate_demand(&input).unwrap();
    input.release.profiles[0].space_needs = SpaceNeedsV1::Wheelchair;
    let wheelchair = evaluate_demand(&input).unwrap();
    assert_eq!(identity_map(&baseline), identity_map(&wheelchair));
    input.services[0].capacity.wheelchair_spaces = 1;
    let bounded = evaluate_demand(&input).unwrap();
    assert!(bounded.allocations.iter().all(|row| row.wheelchair <= 1));
    input
        .release
        .zones
        .iter_mut()
        .find(|zone| zone.id == "leipzig")
        .unwrap()
        .stations[0]
        .step_free = false;
    let inaccessible = evaluate_demand(&input).unwrap();
    assert!(
        inaccessible
            .stop_flows
            .iter()
            .filter(|row| row.stop_id.ends_with("leipzig"))
            .all(|row| row.boarding == 0)
    );
}

fn transfer_fixture() -> DemandEvaluationInputV1 {
    let mut input = fixture();
    input.alternatives.clear();
    input.release.zones[1].population = 0;
    input.release.zones[2].population = 0;
    input.release.zones[1].workplaces = 0;
    input.release.zones[1].population = 0;
    let mut feeder = input.services[0].clone();
    feeder.train_run_id = "feeder".into();
    feeder.stops.truncate(2);
    feeder.capacity.standard_seats = 100;
    let mut onward = input.services[0].clone();
    onward.train_run_id = "onward".into();
    onward.stops.remove(0);
    onward.stops[0].arrival_ms = 1_920_000;
    onward.stops[0].departure_ms = 1_920_000;
    onward.capacity.standard_seats = 100;
    input.services = vec![feeder, onward];
    input
}

#[test]
fn missed_connection_revises_chain_without_partial_capacity_or_identity_duplication() {
    let mut input = transfer_fixture();
    let connected = evaluate_demand(&input).unwrap();
    assert_eq!(connected.totals.rail, connected.totals.generated);
    assert!(connected.choices.iter().all(|row| row.trains.len() == 2));
    let by_train: Vec<_> = connected
        .manifests
        .iter()
        .map(|manifest| {
            manifest
                .passengers
                .iter()
                .map(|row| row.passenger_key.clone())
                .collect::<BTreeSet<_>>()
        })
        .collect();
    assert_eq!(by_train[0], by_train[1]);
    input.services[1].capacity.standard_seats = 0;
    input.services[1].capacity.standard_standing = 0;
    let full = evaluate_demand(&input).unwrap();
    assert_eq!(full.totals.rail, 0);
    assert!(full.allocations.iter().all(|row| row.passengers == 0));
    input = transfer_fixture();
    input.revision = 2;
    input.services[0].stops[1].arrival_ms += 1;
    let missed = evaluate_demand(&input).unwrap();
    assert_eq!(missed.totals.rail, 0);
    assert_eq!(missed.totals.unserved, missed.totals.generated);
    assert_eq!(connected.cohorts, missed.cohorts);
    assert_conservation(&missed);
}

fn receipt(
    train_run_id: &str,
    events: &[(&str, Option<i64>, Option<i64>)],
) -> TrainOperationalProgressV1 {
    TrainOperationalProgressV1 {
        train_run_id: train_run_id.into(),
        stops: events
            .iter()
            .map(|(stop, arrival, departure)| StopOperationalProgressV1 {
                stop_id: (*stop).into(),
                actual_arrival_ms: *arrival,
                actual_departure_ms: *departure,
            })
            .collect(),
    }
}

fn update_with_progress(
    previous_input: &DemandEvaluationInputV1,
    previous: DemandEvaluationV1,
    now_ms: i64,
    trains: Vec<TrainOperationalProgressV1>,
) -> DemandEvaluationInputV1 {
    let mut next = previous_input.clone();
    next.revision += 1;
    next.now_ms = now_ms;
    next.previous_evaluation = Some(Box::new(PreviousDemandEvaluationV1 {
        result: previous,
        services: previous_input.services.clone(),
    }));
    next.operational_progress = Some(DemandOperationalProgressV1 {
        schema_version: "demand-operational-progress/v1".into(),
        world_id: next.world_id.clone(),
        as_of_ms: now_ms,
        receipt_id: format!("receipt-{}", next.revision),
        trains,
    });
    next
}

#[test]
fn confirmed_feeder_missed_connection_reroutes_only_suffix_and_keeps_seats_across_restore() {
    let initial = transfer_fixture();
    let forecast = evaluate_demand(&initial).unwrap();
    assert_eq!(forecast.projection_mode, "forecast");
    let arrivals = vec![
        receipt(
            "feeder",
            &[
                ("regional-leipzig", None, Some(600_000)),
                ("regional-halle", Some(1_810_000), None),
            ],
        ),
        receipt("onward", &[("regional-halle", None, Some(1_920_000))]),
    ];
    let mut revised = update_with_progress(&initial, forecast.clone(), 2_000_000, arrivals.clone());
    revised.services[0].stops[1].arrival_ms = 1_810_000;
    let mut later = revised.services[1].clone();
    later.train_run_id = "later".into();
    later.stops[0].arrival_ms = 3_000_000;
    later.stops[0].departure_ms = 3_000_000;
    later.stops[1].arrival_ms = 6_000_000;
    later.stops[1].departure_ms = 6_000_000;
    revised.services.push(later);
    let diverted = evaluate_demand(&revised).unwrap();
    assert_eq!(diverted.projection_mode, "progress_bound");
    assert_eq!(diverted.totals.rail, forecast.totals.rail);
    assert_eq!(diverted.totals.stranded, 0);
    assert!(diverted.choices.iter().all(|choice| {
        choice.journey_status == "in_progress"
            && choice
                .trains
                .iter()
                .map(|train| train.train_run_id.as_str())
                .collect::<Vec<_>>()
                == ["feeder", "later"]
    }));
    let seats_for = |result: &DemandEvaluationV1, train: &str| {
        result
            .journey_seats
            .iter()
            .filter(|seat| seat.train_run_id == train)
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(
        seats_for(&forecast, "feeder"),
        seats_for(&diverted, "feeder")
    );
    let people_for = |result: &DemandEvaluationV1, train: &str| {
        result
            .manifests
            .iter()
            .filter(|row| row.train_run_id == train)
            .flat_map(|row| &row.passengers)
            .map(|person| {
                (
                    person.passenger_key.clone(),
                    (
                        person.journey_chain_id.clone(),
                        person.fare_fact,
                        person.seat_number,
                    ),
                )
            })
            .collect::<BTreeMap<_, _>>()
    };
    assert_eq!(
        people_for(&forecast, "feeder"),
        people_for(&diverted, "feeder")
    );
    assert!(
        diverted
            .allocations
            .iter()
            .filter(|row| row.train_run_id == "onward")
            .all(|row| row.passengers == 0)
    );
    assert_conservation(&diverted);
    let mut running_receipts = arrivals;
    running_receipts.push(receipt(
        "later",
        &[("regional-halle", Some(3_000_000), Some(3_000_000))],
    ));
    let mut running = update_with_progress(
        &revised,
        diverted.clone(),
        3_100_000,
        running_receipts.clone(),
    );
    running.services[0].fares[0].cents_per_segment = 999_999;
    let restored: DemandEvaluationInputV1 =
        serde_json::from_str(&serde_json::to_string(&running).unwrap()).unwrap();
    let onboard = evaluate_demand(&restored).unwrap();
    assert_eq!(onboard.journey_seats, diverted.journey_seats);
    assert_eq!(
        onboard.totals.forecast_revenue_cents,
        diverted.totals.forecast_revenue_cents
    );
    assert_eq!(
        people_for(&onboard, "later"),
        people_for(&diverted, "later")
    );
    assert_conservation(&onboard);
    running_receipts[2].stops.push(StopOperationalProgressV1 {
        stop_id: "regional-erfurt".into(),
        actual_arrival_ms: Some(6_000_000),
        actual_departure_ms: None,
    });
    let complete = update_with_progress(&running, onboard.clone(), 6_100_000, running_receipts);
    let completed = evaluate_demand(&complete).unwrap();
    assert!(
        completed
            .choices
            .iter()
            .all(|choice| choice.journey_status == "completed")
    );
    assert_eq!(completed.journey_seats, onboard.journey_seats);
    assert_conservation(&completed);
}

#[test]
fn confirmed_progress_cannot_invent_boardings_regress_or_erase_stranded_travellers() {
    let initial = transfer_fixture();
    let before = evaluate_demand(&initial).unwrap();
    let mut progress = update_with_progress(
        &initial,
        before,
        2_000_000,
        vec![
            receipt(
                "feeder",
                &[
                    ("regional-leipzig", None, Some(600_000)),
                    ("regional-halle", Some(1_810_000), None),
                ],
            ),
            receipt("onward", &[("regional-halle", None, Some(1_920_000))]),
        ],
    );
    let stranded = evaluate_demand(&progress).unwrap();
    assert_eq!(stranded.totals.stranded, stranded.totals.generated);
    assert_eq!(stranded.totals.unserved, 0);
    assert!(
        stranded
            .choices
            .iter()
            .all(|row| row.journey_status == "stranded" && row.trains.len() == 1)
    );
    assert_conservation(&stranded);
    progress
        .previous_evaluation
        .as_mut()
        .unwrap()
        .result
        .state_hash = "0".repeat(64);
    assert_eq!(
        evaluate_demand(&progress).unwrap_err().0,
        "previous_evaluation_hash_mismatch"
    );
    let mut regressed = update_with_progress(&progress, stranded, 2_100_000, Vec::new());
    assert_eq!(
        evaluate_demand(&regressed).unwrap_err().0,
        "operational_progress_regressed"
    );
    regressed.previous_evaluation = None;
    regressed
        .operational_progress
        .as_mut()
        .unwrap()
        .trains
        .push(receipt(
            "feeder",
            &[("regional-leipzig", None, Some(600_000))],
        ));
    assert_eq!(
        evaluate_demand(&regressed).unwrap_err().0,
        "progress_requires_previous_evaluation"
    );
    let before = evaluate_demand(&initial).unwrap();
    let mut active = update_with_progress(
        &initial,
        before,
        1_000_000,
        vec![receipt(
            "feeder",
            &[("regional-leipzig", None, Some(600_000))],
        )],
    );
    active.services[0].cancelled = true;
    assert_eq!(
        evaluate_demand(&active).unwrap_err().0,
        "onboard_change_requires_alighting_receipt"
    );
}

#[test]
fn generation_windows_share_one_capacity_pool_and_keep_individual_cohort_identity() {
    let mut input = fixture();
    input.release.day_slices = vec![
        DemandDaySliceV1 {
            id: "early".into(),
            start_offset_ms: 0,
            end_offset_ms: 600_000,
            share_basis_points: 5000,
        },
        DemandDaySliceV1 {
            id: "later".into(),
            start_offset_ms: 600_000,
            end_offset_ms: 1_200_000,
            share_basis_points: 5000,
        },
        DemandDaySliceV1 {
            id: "rest".into(),
            start_offset_ms: 1_200_000,
            end_offset_ms: 86_400_000,
            share_basis_points: 0,
        },
    ];
    for zone in &mut input.release.zones {
        zone.population = if zone.id == "leipzig" { 12 } else { 0 };
        if zone.id == "erfurt" {
            zone.workplaces = 0;
        }
    }
    input.services.truncate(1);
    input.services[0].stops.truncate(2);
    input.services[0].stops[0].arrival_ms = 1_200_000;
    input.services[0].stops[0].departure_ms = 1_200_000;
    input.services[0].stops[1].arrival_ms = 2_400_000;
    input.services[0].stops[1].departure_ms = 2_400_000;
    input.services[0].capacity.standard_seats = 3;
    input.services[0].capacity.standard_standing = 0;
    input.alternatives.clear();
    input.day_slice_id = "early".into();
    let early = evaluate_demand(&input).unwrap();
    let mut later_input = input.clone();
    later_input.day_slice_id = "later".into();
    later_input.window_start_ms = 600_000;
    later_input.window_end_ms = 1_200_000;
    let later = evaluate_demand(&later_input).unwrap();
    assert_eq!(
        early.totals.rail + later.totals.rail,
        6,
        "independent forecasts cannot be summed"
    );
    input.day_slice_id = "pooled".into();
    input.window_end_ms = 1_200_000;
    input.generation_windows = Some(vec![
        DemandGenerationWindowV1 {
            window_start_ms: 0,
            window_end_ms: 600_000,
            day_slice_id: "early".into(),
        },
        DemandGenerationWindowV1 {
            window_start_ms: 600_000,
            window_end_ms: 1_200_000,
            day_slice_id: "later".into(),
        },
    ]);
    let pooled = evaluate_demand(&input).unwrap();
    assert_eq!(pooled.totals.generated, 12);
    assert_eq!(pooled.totals.rail, 3);
    assert_eq!(pooled.totals.unserved, 9);
    let mut individual_cohorts = early.cohorts;
    individual_cohorts.extend(later.cohorts);
    individual_cohorts.sort_by(|a, b| a.cohort_id.cmp(&b.cohort_id));
    assert_eq!(pooled.cohorts, individual_cohorts);
    assert_conservation(&pooled);
    input.generation_windows.as_mut().unwrap().reverse();
    assert_eq!(evaluate_demand(&input).unwrap(), pooled);
    input.generation_windows.as_mut().unwrap().insert(
        0,
        DemandGenerationWindowV1 {
            window_start_ms: 0,
            window_end_ms: 600_000,
            day_slice_id: "early".into(),
        },
    );
    assert_eq!(
        evaluate_demand(&input).unwrap_err().0,
        "overlapping_generation_windows"
    );
}

#[test]
fn continuation_ranking_compares_the_entire_chain_after_a_reliability_tie() {
    let mut initial = transfer_fixture();
    initial.services[0].reliability_basis_points = 1000;
    initial.release.profiles[0].ranking = vec![
        ChoiceDimensionV1::Reliability,
        ChoiceDimensionV1::Fare,
        ChoiceDimensionV1::Time,
        ChoiceDimensionV1::Transfers,
        ChoiceDimensionV1::Frequency,
        ChoiceDimensionV1::Comfort,
    ];
    let previous = evaluate_demand(&initial).unwrap();
    let mut revised = update_with_progress(
        &initial,
        previous,
        2_000_000,
        vec![
            receipt(
                "feeder",
                &[
                    ("regional-leipzig", None, Some(600_000)),
                    ("regional-halle", Some(1_810_000), None),
                ],
            ),
            receipt("onward", &[("regional-halle", None, Some(1_920_000))]),
        ],
    );
    for (id, reliability, cents) in [("reliable-expensive", 9500, 900), ("cheaper", 8000, 100)] {
        let mut alternative = revised.services[1].clone();
        alternative.train_run_id = id.into();
        alternative.reliability_basis_points = reliability;
        alternative.fares[0].cents_per_segment = cents;
        alternative.stops[0].arrival_ms = 3_000_000;
        alternative.stops[0].departure_ms = 3_000_000;
        alternative.stops[1].arrival_ms = 6_000_000;
        alternative.stops[1].departure_ms = 6_000_000;
        revised.services.push(alternative);
    }
    let result = evaluate_demand(&revised).unwrap();
    assert!(
        result
            .choices
            .iter()
            .all(|choice| choice.metrics.reliability_basis_points == 1000
                && choice.trains.last().unwrap().train_run_id == "cheaper")
    );
    assert_conservation(&result);
}

#[test]
fn terminal_leg_pruning_keeps_the_exhaustive_single_train_result() {
    let mut input = fixture();
    input.services.truncate(1);
    input.alternatives.clear();
    input.release.profiles[0].max_fare_cents = 100_000;
    for index in 0..20 {
        let time = 630_000 + i64::from(index) * 30_000;
        input.services[0].stops.insert(
            usize::try_from(index + 1).unwrap(),
            TrainStopV1 {
                stop_id: format!("intermediate-{index}"),
                station_id: format!("intermediate-{index}"),
                arrival_ms: time,
                departure_ms: time,
                passenger_stop: true,
            },
        );
    }
    // With one train, allowing transfers explores every intermediate stop,
    // but cannot discover another valid leg on the same train.
    for seed in 0..12 {
        input.seed = seed.to_string();
        input.release.max_transfers = 2;
        let exhaustive = evaluate_demand(&input).unwrap();
        input.release.max_transfers = 0;
        let pruned = evaluate_demand(&input).unwrap();
        assert_eq!(pruned.choices, exhaustive.choices);
        assert_eq!(pruned.allocations, exhaustive.allocations);
        assert_eq!(pruned.manifests, exhaustive.manifests);
        assert_eq!(pruned.totals, exhaustive.totals);
    }
}
