//! Additive per-issue acceptance proofs using the explicitly balanced pilot.
use std::collections::{BTreeMap, BTreeSet};

use zugfolge_demand::*;

fn fixture() -> DemandEvaluationInputV1 {
    serde_json::from_str(include_str!("../examples/evaluation.json")).unwrap()
}

fn identities(result: &DemandEvaluationV1) -> BTreeMap<String, FareFactV1> {
    result
        .manifests
        .iter()
        .flat_map(|manifest| &manifest.passengers)
        .map(|passenger| (passenger.passenger_key.clone(), passenger.fare_fact))
        .collect()
}

#[test]
fn demand_drivers_change_generation_attraction_and_transit_reachability() {
    let baseline = evaluate_demand(&fixture()).unwrap();
    let mut input = fixture();
    input.release.season_basis_points = 20_000;
    assert_eq!(evaluate_demand(&input).unwrap().totals.generated, 80);
    input = fixture();
    input.release.zones[0].population = 160;
    assert_eq!(evaluate_demand(&input).unwrap().totals.generated, 60);

    let to_erfurt = |result: &DemandEvaluationV1| {
        result
            .cohorts
            .iter()
            .filter(|row| row.origin_zone_id == "leipzig" && row.destination_zone_id == "erfurt")
            .map(|row| row.passengers)
            .sum::<u32>()
    };
    assert_eq!(to_erfurt(&baseline), 10);
    input = fixture();
    input.release.zones[2].workplaces = 120;
    assert_eq!(to_erfurt(&evaluate_demand(&input).unwrap()), 15);
    input = fixture();
    input.release.profiles[0].workplace_weight = 0;
    input.release.profiles[0].poi_weight = 1;
    input.release.zones[1].poi_weight = 1;
    input.release.zones[2].poi_weight = 3;
    assert_eq!(to_erfurt(&evaluate_demand(&input).unwrap()), 15);
    input = fixture();
    input.release.profiles[0].workplace_weight = 0;
    input.release.profiles[0].population_weight = 1;
    input.release.zones[2].population = 120;
    assert_eq!(to_erfurt(&evaluate_demand(&input).unwrap()), 15);
    input = fixture();
    input.release.profiles[0].purpose = "leisure".into();
    input.release.profiles[0].daily_trips_basis_points = 5000;
    let leisure = evaluate_demand(&input).unwrap();
    assert_eq!(leisure.totals.generated, 20);
    assert!(leisure.cohorts.iter().all(|row| row.purpose == "leisure"));

    let leipzig_ids: BTreeSet<_> = baseline
        .cohorts
        .iter()
        .filter(|row| row.origin_zone_id == "leipzig")
        .map(|row| &row.cohort_id)
        .collect();
    assert!(
        baseline
            .choices
            .iter()
            .any(|row| leipzig_ids.contains(&row.cohort_id) && !row.trains.is_empty())
    );
    for long_interval in [false, true] {
        input = fixture();
        let station = &mut input.release.zones[0].stations[0];
        if long_interval {
            station.service_interval_ms = 2_000_000;
        } else {
            station.access_ms = 1_000_000;
        }
        let disconnected = evaluate_demand(&input).unwrap();
        assert_eq!(disconnected.cohorts, baseline.cohorts);
        assert!(
            disconnected
                .choices
                .iter()
                .filter(|row| leipzig_ids.contains(&row.cohort_id))
                .all(|row| row.trains.is_empty())
        );
    }
}

#[test]
fn full_spnv_spfv_and_each_other_mode_share_one_conserved_demand() {
    for mode in [
        AlternativeModeV1::Car,
        AlternativeModeV1::Coach,
        AlternativeModeV1::LocalTransit,
        AlternativeModeV1::Walk,
    ] {
        let mut input = fixture();
        for train in &mut input.services {
            train.capacity.standard_seats = 0;
            train.capacity.standard_standing = 0;
        }
        input.alternatives[0].mode = mode;
        input.alternatives[0].capacity = 3;
        let result = evaluate_demand(&input).unwrap();
        assert_eq!(result.totals.generated, 40);
        assert_eq!(result.totals.rail, 0);
        assert_eq!(result.totals.alternative, 3);
        assert_eq!(result.totals.unserved, 37);
        assert!(
            result
                .choices
                .iter()
                .all(|row| row.alternative_mode == Some(mode))
        );
        assert!(result.choices.iter().any(|row| !row.rejected.is_empty()));
        for choice in &result.choices {
            assert_eq!(choice.ranking, input.release.profiles[0].ranking);
            assert_eq!(
                choice.metrics,
                ChoiceMetricsV1 {
                    fare_cents: 1000,
                    journey_ms: 7_200_000,
                    transfers: 0,
                    service_interval_ms: 7_200_000,
                    reliability_basis_points: 9000,
                    comfort_basis_points: 5000,
                }
            );
            assert!(
                choice
                    .rejected
                    .iter()
                    .all(|rejected| rejected.reason == "capacity_or_reservation_unavailable")
            );
        }
        input.services.reverse();
        assert_eq!(evaluate_demand(&input).unwrap(), result);
        input.alternatives[0].capacity = 20;
        let more_capacity = evaluate_demand(&input).unwrap();
        assert_eq!(more_capacity.totals.alternative, 10);
        assert_eq!(more_capacity.totals.unserved, 30);
        assert_eq!(more_capacity.cohorts, result.cohorts);
    }
}

#[test]
fn paired_fare_status_is_identical_across_all_comfort_and_space_variants_and_seeds() {
    let mut seen = BTreeSet::new();
    for seed in 0..24 {
        let mut input = fixture();
        input.seed = seed.to_string();
        input.release.fare_compliance.valid_basis_points = 5000;
        input.release.fare_compliance.unpresentable_basis_points = 2500;
        for train in &mut input.services {
            train.capacity.standard_seats = 200;
            train.capacity.premium_seats = 200;
            train.capacity.wheelchair_spaces = 200;
            train.capacity.bicycle_spaces = 200;
            train.capacity.stroller_spaces = 200;
            let mut premium = train.fares[0].clone();
            premium.id.push_str("-premium");
            premium.comfort_class = ComfortClassV1::Premium;
            train.fares.push(premium);
        }
        let baseline = identities(&evaluate_demand(&input).unwrap());
        assert!(!baseline.is_empty());
        seen.extend(baseline.values().map(|fact| format!("{fact:?}")));
        for comfort in [ComfortClassV1::Standard, ComfortClassV1::Premium] {
            for needs in [
                SpaceNeedsV1::Ordinary,
                SpaceNeedsV1::Wheelchair,
                SpaceNeedsV1::Bicycle,
                SpaceNeedsV1::Stroller,
            ] {
                input.release.profiles[0].comfort_class = comfort;
                input.release.profiles[0].space_needs = needs;
                // Paired equality of every fare fact is stronger than matching
                // aggregate rates. Choice/capacity are held equal intentionally.
                assert_eq!(identities(&evaluate_demand(&input).unwrap()), baseline);
            }
        }
    }
    assert_eq!(
        seen.len(),
        3,
        "all fare states occur in the balanced sample"
    );
    for field in [
        "appearance",
        "ethnicity",
        "religion",
        "gender",
        "age",
        "disability",
    ] {
        let mut input = serde_json::to_value(fixture()).unwrap();
        input["release"]["profiles"][0][field] = "not-a-domain-input".into();
        assert_eq!(
            evaluate_demand_json(&input.to_string()).unwrap_err().0,
            "invalid_demand_json"
        );
    }
}
