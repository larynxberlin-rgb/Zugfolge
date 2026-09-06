//! Automatische Datenrevisionen erhalten vergangene Wünsche und quittierte Reisen.
use std::collections::BTreeSet;

use zugfolge_demand::*;

fn fixture(pooled: bool) -> DemandEvaluationInputV1 {
    let mut input: DemandEvaluationInputV1 =
        serde_json::from_str(include_str!("../examples/population-evaluation.json")).unwrap();
    if pooled {
        input.day_slice_id = "pooled".into();
        input.window_end_ms = 86_400_000;
        input.generation_windows = Some(
            input
                .release
                .day_slices
                .iter()
                .map(|slice| DemandGenerationWindowV1 {
                    window_start_ms: slice.start_offset_ms,
                    window_end_ms: slice.end_offset_ms,
                    day_slice_id: slice.id.clone(),
                })
                .collect(),
        );
    }
    input
}

fn snapshot(
    input: &DemandEvaluationInputV1,
    revision: u64,
    effective_at_ms: i64,
    factor: u32,
) -> DemandPopulationRevisionV1 {
    let mut model = input.release.population_model.clone().unwrap();
    for settlement in &mut model.settlements {
        settlement.population *= factor;
    }
    let zone_populations = input
        .release
        .zones
        .iter()
        .map(|zone| StationPopulationRevisionV1 {
            zone_id: zone.id.clone(),
            population: zone.population * factor,
        })
        .collect::<Vec<_>>();
    for area in &mut model.station_areas {
        for allocation in &mut area.population_allocations {
            allocation.population *= factor;
        }
        let population = zone_populations
            .iter()
            .find(|zone| zone.zone_id == area.zone_id)
            .unwrap()
            .population;
        area.demand_class = station_demand_class(population);
    }
    model.destination_preferences[0].destination_zone_id = "halle".into();
    DemandPopulationRevisionV1 {
        schema_version: POPULATION_REVISION_SCHEMA.into(),
        world_id: input.world_id.clone(),
        revision,
        effective_at_ms,
        population_model: model,
        zone_populations,
    }
}

fn advance(
    input: &DemandEvaluationInputV1,
    result: DemandEvaluationV1,
    now_ms: i64,
) -> DemandEvaluationInputV1 {
    let mut next = input.clone();
    next.now_ms = now_ms;
    next.revision += 1;
    next.previous_evaluation = Some(Box::new(PreviousDemandEvaluationV1 {
        result,
        services: input.services.clone(),
    }));
    if let Some(progress) = &mut next.operational_progress {
        progress.as_of_ms = now_ms;
        progress.receipt_id = format!("receipt-{now_ms}");
    } else {
        next.operational_progress = Some(DemandOperationalProgressV1 {
            schema_version: "demand-operational-progress/v1".into(),
            world_id: input.world_id.clone(),
            as_of_ms: now_ms,
            receipt_id: format!("receipt-{now_ms}"),
            trains: vec![],
        });
    }
    next
}

fn departure(input: &mut DemandEvaluationInputV1) {
    input
        .operational_progress
        .as_mut()
        .unwrap()
        .trains
        .push(TrainOperationalProgressV1 {
            train_run_id: "regional-1".into(),
            stops: vec![StopOperationalProgressV1 {
                stop_id: "regional-leipzig".into(),
                actual_arrival_ms: Some(600_000),
                actual_departure_ms: Some(600_000),
            }],
        });
}

fn standalone(input: &DemandEvaluationInputV1) -> DemandEvaluationV1 {
    let mut forecast = input.clone();
    forecast.previous_evaluation = None;
    forecast.operational_progress = None;
    evaluate_demand(&forecast).unwrap()
}

fn expected_blend(
    before: &DemandEvaluationV1,
    fresh: &DemandEvaluationV1,
    effective: i64,
) -> Vec<JourneyDemandV1> {
    let mut expected: Vec<_> = before
        .cohorts
        .iter()
        .filter(|cohort| cohort.desired_departure_ms <= effective)
        .cloned()
        .chain(
            fresh
                .cohorts
                .iter()
                .filter(|cohort| cohort.desired_departure_ms > effective)
                .cloned(),
        )
        .collect();
    expected.sort_by(|a, b| a.cohort_id.cmp(&b.cohort_id));
    expected
}

fn conserved(result: &DemandEvaluationV1) {
    assert_eq!(
        result.totals.generated,
        result.totals.rail + result.totals.alternative + result.totals.unserved
    );
    assert_eq!(
        result.totals.generated,
        result
            .cohorts
            .iter()
            .map(|cohort| cohort.passengers)
            .sum::<u32>()
    );
    let mut before = std::collections::BTreeMap::new();
    for flow in &result.stop_flows {
        let count = before.entry(&flow.train_run_id).or_insert(0_u32);
        assert_eq!(*count + flow.boarding - flow.alighting, flow.onboard_after);
        *count = flow.onboard_after;
    }
    assert!(
        result
            .allocations
            .iter()
            .all(|allocation| allocation.passengers <= allocation.capacity)
    );
}

#[test]
fn direct_data_snapshot_changes_forecast_without_a_new_base_release() {
    let base = fixture(true);
    let baseline = evaluate_demand(&base).unwrap();
    let mut input = base.clone();
    input.now_ms = 300_000;
    input.population_revision = Some(snapshot(&base, 7, input.now_ms, 2));
    let result = evaluate_demand(&input).unwrap();
    assert_eq!(result.totals.generated, baseline.totals.generated * 2);
    assert_eq!(result.release_hash, baseline.release_hash);
    assert_eq!(result.demand_release_id, baseline.demand_release_id);
    assert_eq!(result.projection_mode, "forecast");
    assert!(result.population_revision.is_some());
    assert_ne!(result.state_hash, baseline.state_hash);
    let moments = |result: &DemandEvaluationV1| {
        result
            .cohorts
            .iter()
            .map(|cohort| {
                (
                    cohort.origin_zone_id.clone(),
                    cohort.destination_zone_id.clone(),
                    cohort.desired_departure_ms,
                )
            })
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(
        moments(&result),
        moments(&baseline),
        "saving data must not reroll departure times"
    );
    let old_ids = baseline
        .cohorts
        .iter()
        .map(|cohort| &cohort.cohort_id)
        .collect::<BTreeSet<_>>();
    assert!(
        result
            .cohorts
            .iter()
            .all(|cohort| !old_ids.contains(&cohort.cohort_id))
    );
    let revision = input.population_revision.as_mut().unwrap();
    revision.zone_populations.reverse();
    revision.population_model.station_areas.reverse();
    revision.population_model.settlements.reverse();
    revision
        .population_model
        .reference_timetable
        .service_dates
        .reverse();
    assert_eq!(evaluate_demand(&input).unwrap(), result);
    conserved(&result);
}

#[test]
fn already_requested_cohorts_including_the_exact_boundary_are_preserved() {
    let base = fixture(false);
    let before = evaluate_demand(&base).unwrap();
    let mut moments = before
        .cohorts
        .iter()
        .map(|cohort| cohort.desired_departure_ms)
        .collect::<Vec<_>>();
    moments.sort_unstable();
    let effective = moments[moments.len() / 2];
    let mut input = advance(&base, before.clone(), effective);
    input.population_revision = Some(snapshot(&base, 1, effective, 2));
    let result = evaluate_demand(&input).unwrap();
    assert_eq!(
        result.cohorts,
        expected_blend(&before, &standalone(&input), effective)
    );
    assert!(
        before
            .cohorts
            .iter()
            .filter(|cohort| cohort.desired_departure_ms == effective)
            .all(|cohort| result.cohorts.contains(cohort))
    );
    assert!(
        result
            .cohorts
            .iter()
            .any(|cohort| !before.cohorts.contains(cohort))
    );
    assert!(
        before
            .cohorts
            .iter()
            .any(|cohort| !result.cohorts.contains(cohort)),
        "unstarted future cohorts are replaced"
    );
    conserved(&result);
}

#[test]
fn repeated_saves_preserve_mixed_history_and_restore_deterministically() {
    let base = fixture(false);
    let before = evaluate_demand(&base).unwrap();
    let mut first = advance(&base, before, 200_000);
    first.population_revision = Some(snapshot(&base, 3, 200_000, 2));
    let once = evaluate_demand(&first).unwrap();
    let mut second = advance(&first, once.clone(), 400_000);
    second.population_revision = Some(snapshot(&base, 4, 400_000, 3));
    let twice = evaluate_demand(&second).unwrap();
    assert_eq!(
        twice.cohorts,
        expected_blend(&once, &standalone(&second), 400_000)
    );
    let unchanged = advance(&second, twice.clone(), 500_000);
    let same_revision = evaluate_demand(&unchanged).unwrap();
    assert_eq!(same_revision.cohorts, twice.cohorts);
    let restored: DemandEvaluationInputV1 =
        serde_json::from_str(&serde_json::to_string(&unchanged).unwrap()).unwrap();
    assert_eq!(evaluate_demand(&restored).unwrap(), same_revision);
    conserved(&twice);
    conserved(&same_revision);
}

#[test]
fn deleting_future_population_keeps_departed_manifest_fares_and_original_ordinals() {
    let base = fixture(true);
    let before = evaluate_demand(&base).unwrap();
    let manifest = before
        .manifests
        .iter()
        .find(|manifest| manifest.train_run_id == "regional-1")
        .unwrap()
        .clone();
    assert!(!manifest.passengers.is_empty());
    let mut input = advance(&base, before.clone(), 700_000);
    departure(&mut input);
    input.population_revision = Some(snapshot(&base, 1, 700_000, 0));
    input.services[0].fares[0].cents_per_segment = 2_000;
    let result = evaluate_demand(&input).unwrap();
    assert_eq!(
        result.cohorts,
        expected_blend(&before, &standalone(&input), 700_000)
    );
    assert!(
        result.totals.generated > 0,
        "a correction cannot revoke past requests"
    );
    let current = result
        .manifests
        .iter()
        .find(|current| {
            current.train_run_id == manifest.train_run_id
                && current.segment_id == manifest.segment_id
        })
        .unwrap();
    assert_eq!(current.passengers, manifest.passengers);
    let restored = advance(&input, result.clone(), 800_000);
    assert_eq!(evaluate_demand(&restored).unwrap().cohorts, result.cohorts);
    conserved(&result);
}

#[test]
fn data_changes_must_be_evaluated_before_later_departure_receipts() {
    let base = fixture(false);
    let before = evaluate_demand(&base).unwrap();
    let mut late = advance(&base, before.clone(), 700_000);
    late.population_revision = Some(snapshot(&base, 1, 1, 2));
    departure(&mut late);
    assert_eq!(
        evaluate_demand(&late).unwrap_err().0,
        "population_revision_changed_started_journey"
    );
    let mut in_order = advance(&base, before, 1);
    in_order.population_revision = Some(snapshot(&base, 1, 1, 2));
    let corrected_forecast = evaluate_demand(&in_order).unwrap();
    let mut after = advance(&in_order, corrected_forecast, 700_000);
    departure(&mut after);
    assert!(evaluate_demand(&after).is_ok());
}

#[test]
fn applied_revision_cannot_be_removed_regressed_retimed_or_silently_changed() {
    let base = fixture(false);
    let before = evaluate_demand(&base).unwrap();
    let mut input = advance(&base, before, 200_000);
    input.population_revision = Some(snapshot(&base, 3, 200_000, 2));
    let result = evaluate_demand(&input).unwrap();
    let next = advance(&input, result, 300_000);
    let mut removed = next.clone();
    removed.population_revision = None;
    assert_eq!(
        evaluate_demand(&removed).unwrap_err().0,
        "population_revision_removed"
    );
    let mut regressed = next.clone();
    regressed.population_revision.as_mut().unwrap().revision = 2;
    assert_eq!(
        evaluate_demand(&regressed).unwrap_err().0,
        "population_revision_regressed"
    );
    let mut changed = next.clone();
    changed
        .population_revision
        .as_mut()
        .unwrap()
        .effective_at_ms += 1;
    assert_eq!(
        evaluate_demand(&changed).unwrap_err().0,
        "population_revision_content_changed"
    );
    let mut content = next.clone();
    content
        .population_revision
        .as_mut()
        .unwrap()
        .population_model
        .destination_preferences[0]
        .reference_connections += 1;
    assert_eq!(
        evaluate_demand(&content).unwrap_err().0,
        "population_revision_content_changed"
    );
    let mut old_effect = next;
    old_effect.population_revision = Some(snapshot(&base, 4, 199_999, 2));
    assert_eq!(
        evaluate_demand(&old_effect).unwrap_err().0,
        "population_revision_effective_time_regressed"
    );
}

#[test]
fn snapshots_cannot_change_sources_stations_zones_or_world_and_time_binding() {
    type Mutation = Box<dyn Fn(&mut DemandPopulationRevisionV1)>;
    let invalid: Vec<Mutation> = vec![
        Box::new(|revision| revision.world_id = "foreign-world".into()),
        Box::new(|revision| revision.revision = 0),
        Box::new(|revision| revision.effective_at_ms = -1),
        Box::new(|revision| revision.effective_at_ms = 300_001),
        Box::new(|revision| {
            revision
                .population_model
                .reference_timetable
                .artifact_sha256 = "d".repeat(64)
        }),
        Box::new(|revision| {
            revision.population_model.settlements[0].source_id = "other-source".into()
        }),
        Box::new(|revision| {
            revision.population_model.settlements[0].name = "Different place".into()
        }),
        Box::new(|revision| {
            revision.population_model.station_areas[0].station_id = "other-station".into()
        }),
        Box::new(|revision| {
            revision.population_model.station_areas[0].population_allocations[0].population += 1
        }),
        Box::new(|revision| revision.zone_populations[0].zone_id = "unknown-zone".into()),
        Box::new(|revision| revision.zone_populations.pop().map(|_| ()).unwrap()),
    ];
    for mutate in invalid {
        let mut input = fixture(false);
        input.now_ms = 300_000;
        input.population_revision = Some(snapshot(&input, 1, input.now_ms, 2));
        mutate(input.population_revision.as_mut().unwrap());
        assert!(evaluate_demand(&input).is_err());
    }
    let mut no_base = fixture(false);
    no_base.population_revision = Some(snapshot(&no_base, 1, 0, 2));
    no_base.release.population_model = None;
    assert_eq!(
        evaluate_demand(&no_base).unwrap_err().0,
        "population_revision_requires_base_model"
    );
}
