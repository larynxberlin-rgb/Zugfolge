//! Einwohnerbudgets und Referenzpräferenzen sind Modellannahmen, keine Messkalibrierung.
use std::collections::BTreeMap;

use zugfolge_demand::*;

type InputMutation = Box<dyn Fn(&mut DemandEvaluationInputV1)>;

fn legacy() -> DemandEvaluationInputV1 {
    serde_json::from_str(include_str!("../examples/evaluation.json")).unwrap()
}

fn fixture() -> DemandEvaluationInputV1 {
    let mut input = legacy();
    input.release.sources = vec![SourceEvidenceV1 {
        id: "population-and-timetable-test".into(),
        url: "https://example.org/synthetic-population-fixture".into(),
        license: "CC0-1.0".into(),
        artifact_sha256: "a".repeat(64),
        rights_approved: true,
    }];
    input.release.population_model = Some(StationPopulationDemandV1 {
        schema_version: POPULATION_MODEL_SCHEMA.into(),
        settlements: vec![
            DemandSettlementV1 {
                id: "shared-city".into(),
                name: "Mehrstationsort".into(),
                population: 120,
                source_id: input.release.sources[0].id.clone(),
            },
            DemandSettlementV1 {
                id: "other-city".into(),
                name: "Zielort".into(),
                population: 40,
                source_id: input.release.sources[0].id.clone(),
            },
        ],
        station_areas: input
            .release
            .zones
            .iter()
            .map(|zone| StationDemandAreaV1 {
                zone_id: zone.id.clone(),
                station_id: zone.stations[0].station_id.clone(),
                population_allocations: vec![StationPopulationAllocationV1 {
                    settlement_id: if zone.id == "erfurt" {
                        "other-city"
                    } else {
                        "shared-city"
                    }
                    .into(),
                    population: zone.population,
                }],
                demand_class: station_demand_class(zone.population),
            })
            .collect(),
        reference_timetable: DemandReferenceTimetableV1 {
            id: "frozen-reference-week".into(),
            artifact_sha256: "b".repeat(64),
            source_ids: vec![input.release.sources[0].id.clone()],
            service_dates: (1..=7).map(|day| format!("2025-01-{day:02}")).collect(),
        },
        destination_preferences: vec![DemandDestinationPreferenceV1 {
            origin_zone_id: "leipzig".into(),
            destination_zone_id: "erfurt".into(),
            reference_connections: 120,
        }],
    });
    input
}

fn model(input: &mut DemandEvaluationInputV1) -> &mut StationPopulationDemandV1 {
    input.release.population_model.as_mut().unwrap()
}

fn amount(result: &DemandEvaluationV1, origin: &str, destination: &str) -> u32 {
    result
        .cohorts
        .iter()
        .filter(|row| row.origin_zone_id == origin && row.destination_zone_id == destination)
        .map(|row| row.passengers)
        .sum()
}

fn conservation(result: &DemandEvaluationV1) {
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
    for allocation in &result.allocations {
        assert!(allocation.passengers <= allocation.capacity);
    }
    for manifest in &result.manifests {
        let allocation = result
            .allocations
            .iter()
            .find(|allocation| {
                allocation.train_run_id == manifest.train_run_id
                    && allocation.segment_id == manifest.segment_id
            })
            .unwrap();
        assert_eq!(
            manifest.passengers.len(),
            usize::try_from(allocation.passengers).unwrap()
        );
    }
}

#[test]
fn legacy_without_population_model_retains_bytes_and_golden_hash() {
    let input = legacy();
    assert!(
        !serde_json::to_string(&input.release)
            .unwrap()
            .contains("populationModel")
    );
    assert_eq!(
        evaluate_demand(&input).unwrap().state_hash,
        "a1bf6cc8531bc09a1ce2a523f48112e9d78c0bffe1f8c1856e40cb3248e517b1"
    );
}

#[test]
fn published_synthetic_population_example_uses_the_same_native_contract() {
    let input: DemandEvaluationInputV1 =
        serde_json::from_str(include_str!("../examples/population-evaluation.json")).unwrap();
    let result = evaluate_demand(&input).unwrap();
    assert_eq!(result.totals.generated, 40);
    assert_eq!(
        (
            amount(&result, "leipzig", "erfurt"),
            amount(&result, "leipzig", "halle")
        ),
        (16, 4)
    );
    assert_eq!(result.projection_mode, "forecast");
    conservation(&result);
}

#[test]
fn one_city_is_shared_between_stations_without_multiplying_residents() {
    let input = fixture();
    let result = evaluate_demand(&input).unwrap();
    assert_eq!(result.totals.generated, 40);
    conservation(&result);
    let mut doubled = input.clone();
    model(&mut doubled).settlements[0].population = 240;
    for index in 0..2 {
        doubled.release.zones[index].population *= 2;
        model(&mut doubled).station_areas[index].population_allocations[0].population *= 2;
    }
    assert_eq!(evaluate_demand(&doubled).unwrap().totals.generated, 70);
    let mut duplicated = input;
    duplicated.release.zones[0].population = 120;
    model(&mut duplicated).station_areas[0].population_allocations[0].population = 120;
    assert_eq!(
        evaluate_demand(&duplicated).unwrap_err().0,
        "settlement_population_not_conserved"
    );
}

#[test]
fn all_station_class_boundaries_are_derived_without_a_demand_multiplier() {
    assert_eq!(station_demand_class(0), 0);
    let thresholds = [
        1, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000,
    ];
    for (index, threshold) in thresholds.into_iter().enumerate() {
        assert_eq!(
            station_demand_class(threshold - 1),
            u8::try_from(index).unwrap()
        );
        assert_eq!(
            station_demand_class(threshold),
            u8::try_from(index + 1).unwrap()
        );
    }
    assert_eq!(station_demand_class(u32::MAX), 10);
    let mut input = fixture();
    model(&mut input).station_areas[0].demand_class = 10;
    assert_eq!(
        evaluate_demand(&input).unwrap_err().0,
        "station_demand_class_mismatch"
    );
}

#[test]
fn directed_reference_bonus_redistributes_an_unchanged_budget_and_is_capped() {
    let input = fixture();
    let preferred = evaluate_demand(&input).unwrap();
    let mut unbiased = input.clone();
    model(&mut unbiased).destination_preferences.clear();
    let baseline = evaluate_demand(&unbiased).unwrap();
    assert_eq!(preferred.totals.generated, baseline.totals.generated);
    assert_eq!(
        (
            amount(&baseline, "leipzig", "erfurt"),
            amount(&baseline, "leipzig", "halle")
        ),
        (10, 10)
    );
    assert_eq!(
        (
            amount(&preferred, "leipzig", "erfurt"),
            amount(&preferred, "leipzig", "halle")
        ),
        (16, 4)
    );
    assert_eq!(
        amount(&preferred, "erfurt", "leipzig"),
        amount(&baseline, "erfurt", "leipzig")
    );
    let mut uncapped_count = input;
    model(&mut uncapped_count).destination_preferences[0].reference_connections = u32::MAX;
    assert_eq!(
        evaluate_demand(&uncapped_count).unwrap().cohorts,
        preferred.cohorts
    );
    conservation(&preferred);
}

#[test]
fn latent_destinations_keep_positive_weight_even_without_attraction_or_a_train() {
    let mut input = fixture();
    input.release.profiles[0].workplace_weight = 0;
    input.services.clear();
    input.alternatives.clear();
    let result = evaluate_demand(&input).unwrap();
    assert_eq!(
        (
            amount(&result, "leipzig", "erfurt"),
            amount(&result, "leipzig", "halle")
        ),
        (16, 4)
    );
    assert_eq!(result.totals.generated, result.totals.unserved);
    assert_eq!(result.cohorts.len(), 6);
}

#[test]
fn player_supply_changes_do_not_create_people_or_rewrite_wishes() {
    let input = fixture();
    let baseline = evaluate_demand(&input).unwrap();
    let mut expanded = input.clone();
    let mut new_train = expanded.services[0].clone();
    new_train.train_run_id = "player-addition".into();
    new_train.operator_id = "new-player".into();
    new_train.capacity.standard_seats = 100_000;
    expanded.services.push(new_train);
    let added = evaluate_demand(&expanded).unwrap();
    assert_eq!(added.cohorts, baseline.cohorts);
    let mut disrupted = input;
    for service in &mut disrupted.services {
        service.cancelled = true;
        service.operator_id = "changed-owner".into();
    }
    disrupted.alternatives.clear();
    let cancelled = evaluate_demand(&disrupted).unwrap();
    assert_eq!(cancelled.cohorts, baseline.cohorts);
    assert!(cancelled.totals.unserved > baseline.totals.unserved);
}

#[test]
fn population_lists_have_canonical_hashes_and_survive_json_restore() {
    let mut input = fixture();
    let mut second_source = input.release.sources[0].clone();
    second_source.id = "another-free-synthetic-source".into();
    input.release.sources.push(second_source.clone());
    let population = model(&mut input);
    population
        .reference_timetable
        .source_ids
        .push(second_source.id);
    population.station_areas[0].population_allocations[0].population = 60;
    population.station_areas[0]
        .population_allocations
        .push(StationPopulationAllocationV1 {
            settlement_id: "other-city".into(),
            population: 20,
        });
    population.station_areas[2].population_allocations[0].population = 20;
    population.station_areas[2]
        .population_allocations
        .push(StationPopulationAllocationV1 {
            settlement_id: "shared-city".into(),
            population: 20,
        });
    population
        .destination_preferences
        .push(DemandDestinationPreferenceV1 {
            origin_zone_id: "halle".into(),
            destination_zone_id: "leipzig".into(),
            reference_connections: 14,
        });
    let expected = evaluate_demand(&input).unwrap();
    let hash = release_hash(&input.release).unwrap();
    let mut permuted = input.clone();
    permuted.release.zones.reverse();
    let population = model(&mut permuted);
    population.settlements.reverse();
    population.station_areas.reverse();
    population.reference_timetable.source_ids.reverse();
    population.reference_timetable.service_dates.reverse();
    population.destination_preferences.reverse();
    for area in &mut population.station_areas {
        area.population_allocations.reverse();
    }
    assert_eq!(release_hash(&permuted.release).unwrap(), hash);
    assert_eq!(evaluate_demand(&permuted).unwrap(), expected);
    let restored: DemandEvaluationInputV1 =
        serde_json::from_str(&serde_json::to_string(&permuted).unwrap()).unwrap();
    assert_eq!(evaluate_demand(&restored).unwrap(), expected);
    model(&mut permuted).reference_timetable.artifact_sha256 = "c".repeat(64);
    assert_ne!(release_hash(&permuted.release).unwrap(), hash);
}

#[test]
fn invalid_population_evidence_and_references_fail_closed() {
    let cases: Vec<(&str, InputMutation)> = vec![
        (
            "invalid_population_model",
            Box::new(|input| input.release.provenance = Provenance::Observed),
        ),
        (
            "invalid_population_model",
            Box::new(|input| model(input).schema_version = "unversioned".into()),
        ),
        (
            "source_rights_not_approved",
            Box::new(|input| input.release.sources[0].rights_approved = false),
        ),
        (
            "invalid_population_settlement",
            Box::new(|input| model(input).settlements[0].source_id = "missing".into()),
        ),
        (
            "invalid_population_settlement",
            Box::new(|input| {
                let duplicate = model(input).settlements[0].clone();
                model(input).settlements.push(duplicate);
            }),
        ),
        (
            "invalid_population_reference_timetable",
            Box::new(|input| model(input).reference_timetable.source_ids = vec!["missing".into()]),
        ),
        (
            "invalid_population_reference_timetable",
            Box::new(|input| model(input).reference_timetable.artifact_sha256 = "B".repeat(64)),
        ),
        (
            "invalid_population_reference_timetable",
            Box::new(|input| {
                let duplicate = model(input).reference_timetable.source_ids[0].clone();
                model(input).reference_timetable.source_ids.push(duplicate);
            }),
        ),
        (
            "invalid_population_station_area",
            Box::new(|input| model(input).station_areas[0].station_id = "unknown-station".into()),
        ),
        (
            "invalid_population_station_area",
            Box::new(|input| {
                let duplicate = input.release.zones[0].stations[0].clone();
                input.release.zones[1].stations = vec![duplicate.clone()];
                model(input).station_areas[1].station_id = duplicate.station_id;
            }),
        ),
        (
            "invalid_station_population_allocation",
            Box::new(|input| {
                model(input).station_areas[0].population_allocations[0].settlement_id =
                    "unknown-place".into()
            }),
        ),
        (
            "station_population_mismatch",
            Box::new(|input| {
                model(input).station_areas[0].population_allocations[0].population += 1
            }),
        ),
        (
            "invalid_population_destination_preference",
            Box::new(|input| {
                model(input).destination_preferences[0].origin_zone_id = "unknown-zone".into()
            }),
        ),
        (
            "invalid_population_destination_preference",
            Box::new(|input| {
                model(input).destination_preferences[0].origin_zone_id = "erfurt".into()
            }),
        ),
        (
            "invalid_population_destination_preference",
            Box::new(|input| model(input).destination_preferences[0].reference_connections = 0),
        ),
        (
            "invalid_population_destination_preference",
            Box::new(|input| {
                let duplicate = model(input).destination_preferences[0].clone();
                model(input).destination_preferences.push(duplicate);
            }),
        ),
    ];
    for (reason, mutate) in cases {
        let mut input = fixture();
        mutate(&mut input);
        assert_eq!(evaluate_demand(&input).unwrap_err().0, reason);
    }
    let mut unknown_field = serde_json::to_value(fixture()).unwrap();
    unknown_field["release"]["populationModel"]["unverifiedDemandMultiplier"] =
        serde_json::json!(2);
    assert!(serde_json::from_value::<DemandEvaluationInputV1>(unknown_field).is_err());
}

#[test]
fn exactly_seven_real_consecutive_calendar_dates_are_required() {
    for dates in [
        vec!["2025-01-01"; 7],
        vec![
            "2025-02-29",
            "2025-03-01",
            "2025-03-02",
            "2025-03-03",
            "2025-03-04",
            "2025-03-05",
            "2025-03-06",
        ],
        vec![
            "2025-01-01",
            "2025-01-02",
            "2025-01-03",
            "2025-01-04",
            "2025-01-05",
            "2025-01-06",
            "2025-01-08",
        ],
        vec!["2025-01-01"],
        vec!["2025-1-01"; 7],
        vec!["0000-01-01"; 7],
        vec!["2025-13-01"; 7],
        vec!["2025-01-00"; 7],
    ] {
        let mut input = fixture();
        model(&mut input).reference_timetable.service_dates =
            dates.into_iter().map(String::from).collect();
        assert_eq!(
            evaluate_demand(&input).unwrap_err().0,
            "invalid_population_service_dates"
        );
    }
    for dates in [
        [
            "2024-02-26",
            "2024-02-27",
            "2024-02-28",
            "2024-02-29",
            "2024-03-01",
            "2024-03-02",
            "2024-03-03",
        ],
        [
            "2024-12-29",
            "2024-12-30",
            "2024-12-31",
            "2025-01-01",
            "2025-01-02",
            "2025-01-03",
            "2025-01-04",
        ],
        [
            "1900-02-26",
            "1900-02-27",
            "1900-02-28",
            "1900-03-01",
            "1900-03-02",
            "1900-03-03",
            "1900-03-04",
        ],
    ] {
        let mut input = fixture();
        model(&mut input).reference_timetable.service_dates =
            dates.into_iter().map(String::from).collect();
        assert!(evaluate_demand(&input).is_ok());
    }
}

#[test]
fn population_model_budgets_are_enforced_before_expensive_work() {
    let mut input = fixture();
    let settlement = model(&mut input).settlements[0].clone();
    model(&mut input).settlements = vec![settlement; 20_001];
    assert_eq!(
        evaluate_demand(&input).unwrap_err().0,
        "population_model_size_limit"
    );
    let mut input = fixture();
    let allocation = model(&mut input).station_areas[0].population_allocations[0].clone();
    model(&mut input).station_areas[0].population_allocations = vec![allocation; 40_001];
    assert_eq!(
        evaluate_demand(&input).unwrap_err().0,
        "population_model_size_limit"
    );
    let mut input = fixture();
    let preference = model(&mut input).destination_preferences[0].clone();
    model(&mut input).destination_preferences = vec![preference; 39_801];
    assert_eq!(
        evaluate_demand(&input).unwrap_err().0,
        "population_model_size_limit"
    );
}

#[test]
fn maximum_u32_populations_and_preferences_use_wide_integer_apportionment() {
    let mut input = fixture();
    input.services.clear();
    input.alternatives.clear();
    input.release.max_generated_passengers = 100_000;
    input.release.season_basis_points = 1;
    let profile = &mut input.release.profiles[0];
    profile.daily_trips_basis_points = 1;
    profile.workplace_weight = 10_000;
    profile.poi_weight = 10_000;
    profile.population_weight = 10_000;
    let source_id = input.release.sources[0].id.clone();
    input.release.zones = (0..200)
        .map(|index| DemandZoneV1 {
            id: format!("zone-{index}"),
            population: u32::MAX,
            workplaces: u32::MAX,
            poi_weight: u32::MAX,
            stations: vec![StationTransitAccessV1 {
                station_id: format!("station-{index}"),
                access_ms: 0,
                service_interval_ms: 0,
                step_free: true,
            }],
        })
        .collect();
    model(&mut input).settlements = (0..200)
        .map(|index| DemandSettlementV1 {
            id: format!("place-{index}"),
            name: format!("Ort {index}"),
            population: u32::MAX,
            source_id: source_id.clone(),
        })
        .collect();
    model(&mut input).station_areas = (0..200)
        .map(|index| StationDemandAreaV1 {
            zone_id: format!("zone-{index}"),
            station_id: format!("station-{index}"),
            demand_class: 10,
            population_allocations: vec![StationPopulationAllocationV1 {
                settlement_id: format!("place-{index}"),
                population: u32::MAX,
            }],
        })
        .collect();
    model(&mut input).destination_preferences = (0..200)
        .flat_map(|origin| {
            (0..200)
                .filter(move |destination| *destination != origin)
                .map(move |destination| DemandDestinationPreferenceV1 {
                    origin_zone_id: format!("zone-{origin}"),
                    destination_zone_id: format!("zone-{destination}"),
                    reference_connections: u32::MAX,
                })
        })
        .collect();
    let result = evaluate_demand(&input).unwrap();
    assert_eq!(result.totals.generated, 2_000);
    conservation(&result);
    let mut origins = BTreeMap::new();
    for cohort in &result.cohorts {
        *origins.entry(&cohort.origin_zone_id).or_insert(0_u32) += cohort.passengers;
    }
    assert_eq!(origins.len(), 200);
    assert!(origins.values().all(|passengers| *passengers == 10));
}

#[test]
fn actual_departure_keeps_population_manifest_and_fare_facts_during_repricing() {
    let initial = fixture();
    let before = evaluate_demand(&initial).unwrap();
    let original = before
        .manifests
        .iter()
        .find(|manifest| manifest.train_run_id == "regional-1")
        .unwrap()
        .clone();
    assert!(!original.passengers.is_empty());
    let mut revised = initial.clone();
    revised.revision += 1;
    revised.now_ms = 700_000;
    revised.previous_evaluation = Some(Box::new(PreviousDemandEvaluationV1 {
        result: before,
        services: initial.services.clone(),
    }));
    revised.operational_progress = Some(DemandOperationalProgressV1 {
        schema_version: "demand-operational-progress/v1".into(),
        world_id: initial.world_id.clone(),
        as_of_ms: revised.now_ms,
        receipt_id: "native-departure-1".into(),
        trains: vec![TrainOperationalProgressV1 {
            train_run_id: "regional-1".into(),
            stops: vec![StopOperationalProgressV1 {
                stop_id: "regional-leipzig".into(),
                actual_arrival_ms: Some(600_000),
                actual_departure_ms: Some(600_000),
            }],
        }],
    });
    revised.services[0].fares[0].cents_per_segment = 1_000;
    let result = evaluate_demand(&revised).unwrap();
    let continued = result
        .manifests
        .iter()
        .find(|manifest| {
            manifest.train_run_id == original.train_run_id
                && manifest.segment_id == original.segment_id
        })
        .unwrap();
    assert_eq!(continued.passengers, original.passengers);
    conservation(&result);
    let restored: DemandEvaluationInputV1 =
        serde_json::from_str(&serde_json::to_string(&revised).unwrap()).unwrap();
    assert_eq!(evaluate_demand(&restored).unwrap(), result);
    model(&mut revised).reference_timetable.artifact_sha256 = "c".repeat(64);
    assert!(
        evaluate_demand(&revised).is_err(),
        "active journeys cannot switch the population release pin"
    );
}
