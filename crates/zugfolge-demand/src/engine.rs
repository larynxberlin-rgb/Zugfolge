use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};

use crate::{DemandError, ensure, types::*};

const DAY_MS: i64 = 86_400_000;
const SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_TIME: i64 = SAFE_INTEGER - 14 * DAY_MS;
const MAX_MANIFEST_ENTRIES: usize = 1_000_000;
const MAX_SEARCH_STEPS: usize = 1_000_000;

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

fn draw(parts: &[&str], upper: u64) -> u64 {
    u64::from_str_radix(&digest(parts)[..16], 16).expect("SHA-256 hexadecimal") % upper
}

fn id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn unique<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut ids = BTreeSet::new();
    values
        .into_iter()
        .all(|value| id(value) && ids.insert(value))
}

fn duration(value: i64) -> bool {
    (0..=7 * DAY_MS).contains(&value)
}
fn money(value: i64) -> bool {
    (0..=1_000_000_000).contains(&value)
}

pub(crate) fn validate_sources(sources: &[SourceEvidenceV1]) -> Result<(), DemandError> {
    ensure(
        unique(sources.iter().map(|source| source.id.as_str())),
        "duplicate_source",
    )?;
    for source in sources {
        ensure(source.rights_approved, "source_rights_not_approved")?;
        ensure(
            source.url.starts_with("https://")
                && source.url.len() <= 2048
                && !source.license.trim().is_empty()
                && source.license.len() <= 256
                && source.artifact_sha256.len() == 64
                && source
                    .artifact_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
            "invalid_source_evidence",
        )?;
    }
    Ok(())
}

fn validate_release(release: &DemandReleaseV1) -> Result<(), DemandError> {
    ensure(
        release.schema_version == RELEASE_SCHEMA && id(&release.id),
        "invalid_demand_release",
    )?;
    ensure(
        (2..=200).contains(&release.zones.len())
            && (1..=32).contains(&release.profiles.len())
            && (1..=96).contains(&release.day_slices.len())
            && release.sources.len() <= 128,
        "release_size_limit",
    )?;
    validate_sources(&release.sources)?;
    ensure(
        release.provenance != Provenance::Observed || !release.sources.is_empty(),
        "observed_release_requires_sources",
    )?;
    ensure(
        unique(release.zones.iter().map(|zone| zone.id.as_str())),
        "duplicate_zone",
    )?;
    ensure(
        unique(release.profiles.iter().map(|profile| profile.id.as_str())),
        "duplicate_profile",
    )?;
    ensure(
        unique(release.day_slices.iter().map(|slice| slice.id.as_str())),
        "duplicate_day_slice",
    )?;
    ensure(
        release.season_basis_points <= 100_000
            && duration(release.minimum_transfer_ms)
            && release.max_transfers <= 2
            && (1..=100_000).contains(&release.max_generated_passengers)
            && (1..=256).contains(&release.max_connections_per_cohort),
        "invalid_demand_limits",
    )?;
    let mut slices: Vec<_> = release.day_slices.iter().collect();
    slices.sort_by_key(|slice| slice.start_offset_ms);
    let mut end = 0;
    let mut shares = 0_u32;
    for slice in slices {
        ensure(
            slice.start_offset_ms == end
                && slice.end_offset_ms > end
                && slice.end_offset_ms <= DAY_MS
                && slice.share_basis_points <= 10_000,
            "invalid_day_slice",
        )?;
        end = slice.end_offset_ms;
        shares += slice.share_basis_points;
    }
    ensure(end == DAY_MS && shares == 10_000, "invalid_daily_profile")?;
    for zone in &release.zones {
        ensure(
            zone.stations.len() <= 16
                && unique(
                    zone.stations
                        .iter()
                        .map(|station| station.station_id.as_str()),
                ),
            "invalid_zone_stations",
        )?;
        for station in &zone.stations {
            ensure(
                duration(station.access_ms) && duration(station.service_interval_ms),
                "invalid_transit_access",
            )?;
        }
    }
    for profile in &release.profiles {
        ensure(
            id(&profile.purpose)
                && profile.daily_trips_basis_points <= 100_000
                && profile.workplace_weight <= 10_000
                && profile.poi_weight <= 10_000
                && profile.population_weight <= 10_000
                && money(profile.max_fare_cents)
                && duration(profile.max_journey_ms)
                && profile.max_journey_ms > 0,
            "invalid_demand_profile",
        )?;
        ensure(
            profile.ranking.len() == 6
                && profile.ranking.iter().collect::<BTreeSet<_>>().len() == 6,
            "invalid_lexicographic_ranking",
        )?;
        for origin in &release.zones {
            ensure(
                release
                    .zones
                    .iter()
                    .any(|zone| zone.id != origin.id && attraction(zone, profile) > 0),
                "no_attractive_destination",
            )?;
        }
    }
    let policy = &release.fare_compliance;
    ensure(
        policy.schema_version == "fare-compliance-policy/v1"
            && policy.valid_basis_points <= 10_000
            && policy.unpresentable_basis_points <= 10_000
            && policy.valid_basis_points + policy.unpresentable_basis_points <= 10_000,
        "invalid_fare_compliance_policy",
    )?;
    ensure(
        unique(policy.source_ids.iter().map(String::as_str))
            && policy
                .source_ids
                .iter()
                .all(|source_id| release.sources.iter().any(|source| &source.id == source_id))
            && (policy.provenance != Provenance::Observed || !policy.source_ids.is_empty()),
        "invalid_fare_policy_sources",
    )?;
    Ok(())
}

fn canonical_release(release: &DemandReleaseV1) -> DemandReleaseV1 {
    let mut release = release.clone();
    release.sources.sort_by(|a, b| a.id.cmp(&b.id));
    release.zones.sort_by(|a, b| a.id.cmp(&b.id));
    for zone in &mut release.zones {
        zone.stations
            .sort_by(|a, b| a.station_id.cmp(&b.station_id));
    }
    release.profiles.sort_by(|a, b| a.id.cmp(&b.id));
    release
        .day_slices
        .sort_by_key(|slice| slice.start_offset_ms);
    release.fare_compliance.source_ids.sort();
    release
}

/// SHA-256 des kanonischen, validierten Releases. Reihenfolgen von Mengen sind irrelevant.
pub fn release_hash(release: &DemandReleaseV1) -> Result<String, DemandError> {
    validate_release(release)?;
    let bytes = serde_json::to_vec(&canonical_release(release))?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn generation_windows(input: &DemandEvaluationInputV1) -> Vec<DemandGenerationWindowV1> {
    let mut windows = input.generation_windows.clone().unwrap_or_else(|| {
        vec![DemandGenerationWindowV1 {
            window_start_ms: input.window_start_ms,
            window_end_ms: input.window_end_ms,
            day_slice_id: input.day_slice_id.clone(),
        }]
    });
    windows.sort_by_key(|window| window.window_start_ms);
    windows
}

fn validate_input(input: &DemandEvaluationInputV1) -> Result<(), DemandError> {
    ensure(
        input.schema_version == INPUT_SCHEMA && id(&input.world_id) && id(&input.period_id),
        "invalid_demand_identity",
    )?;
    ensure(
        input
            .seed
            .parse::<u64>()
            .is_ok_and(|seed| seed.to_string() == input.seed),
        "invalid_world_seed",
    )?;
    ensure(
        input.revision > 0
            && input.revision <= u64::try_from(SAFE_INTEGER).expect("positive")
            && (0..=MAX_TIME).contains(&input.now_ms)
            && (0..=MAX_TIME).contains(&input.window_start_ms)
            && input.window_end_ms > input.window_start_ms
            && input.window_end_ms <= MAX_TIME,
        "invalid_demand_time_or_revision",
    )?;
    validate_release(&input.release)?;
    let windows = generation_windows(input);
    ensure(
        (1..=256).contains(&windows.len())
            && (input.generation_windows.is_none() || input.day_slice_id == "pooled"),
        "invalid_generation_window_pool",
    )?;
    ensure(
        windows
            .first()
            .is_some_and(|window| window.window_start_ms == input.window_start_ms)
            && windows
                .last()
                .is_some_and(|window| window.window_end_ms == input.window_end_ms),
        "generation_window_envelope_mismatch",
    )?;
    for (index, window) in windows.iter().enumerate() {
        ensure(
            (0..=MAX_TIME).contains(&window.window_start_ms)
                && window.window_end_ms > window.window_start_ms
                && window.window_end_ms <= MAX_TIME
                && (index == 0 || windows[index - 1].window_end_ms <= window.window_start_ms),
            "overlapping_generation_windows",
        )?;
        let slice = input
            .release
            .day_slices
            .iter()
            .find(|slice| slice.id == window.day_slice_id)
            .ok_or_else(|| DemandError("unknown_day_slice".into()))?;
        ensure(
            window.window_end_ms - window.window_start_ms
                == slice.end_offset_ms - slice.start_offset_ms
                && window.window_start_ms % DAY_MS == slice.start_offset_ms,
            "day_slice_window_mismatch",
        )?;
    }
    ensure(
        input.services.len() <= 2000 && input.alternatives.len() <= 2000,
        "service_size_limit",
    )?;
    ensure(
        unique(
            input
                .services
                .iter()
                .map(|service| service.train_run_id.as_str()),
        ),
        "duplicate_train_run",
    )?;
    ensure(
        unique(input.alternatives.iter().map(|service| service.id.as_str())),
        "duplicate_alternative",
    )?;
    let mut segments = 0;
    for service in &input.services {
        ensure(service.world_id == input.world_id, "world_mismatch")?;
        ensure(
            id(&service.operator_id)
                && (2..=100).contains(&service.stops.len())
                && (1..=8).contains(&service.fares.len())
                && unique(service.stops.iter().map(|stop| stop.stop_id.as_str()))
                && unique(service.fares.iter().map(|fare| fare.id.as_str())),
            "invalid_train_service",
        )?;
        segments += service.stops.len() - 1;
        for (index, stop) in service.stops.iter().enumerate() {
            ensure(
                id(&stop.station_id)
                    && (0..=MAX_TIME).contains(&stop.arrival_ms)
                    && stop.departure_ms >= stop.arrival_ms
                    && stop.departure_ms <= MAX_TIME
                    && (index == 0 || stop.arrival_ms > service.stops[index - 1].departure_ms),
                "invalid_stop_times",
            )?;
        }
        ensure(
            duration(service.service_interval_ms)
                && service.reliability_basis_points <= 10_000
                && service.comfort_basis_points <= 10_000,
            "invalid_train_quality",
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
            .all(|n| n <= 100_000),
            "invalid_train_capacity",
        )?;
        for fare in &service.fares {
            ensure(money(fare.cents_per_segment), "invalid_fare_product")?;
        }
    }
    ensure(segments <= 20_000, "segment_size_limit")?;
    for alternative in &input.alternatives {
        ensure(alternative.world_id == input.world_id, "world_mismatch")?;
        ensure(
            input
                .release
                .zones
                .iter()
                .any(|zone| zone.id == alternative.origin_zone_id)
                && input
                    .release
                    .zones
                    .iter()
                    .any(|zone| zone.id == alternative.destination_zone_id)
                && alternative.origin_zone_id != alternative.destination_zone_id,
            "invalid_alternative_zones",
        )?;
        ensure(
            money(alternative.fare_cents)
                && duration(alternative.journey_ms)
                && alternative.journey_ms > 0
                && duration(alternative.service_interval_ms)
                && alternative.reliability_basis_points <= 10_000
                && alternative.comfort_basis_points <= 10_000
                && alternative.capacity <= 100_000,
            "invalid_alternative",
        )?;
    }
    Ok(())
}

fn attraction(zone: &DemandZoneV1, profile: &DemandProfileV1) -> u64 {
    u64::from(zone.workplaces) * u64::from(profile.workplace_weight)
        + u64::from(zone.poi_weight) * u64::from(profile.poi_weight)
        + u64::from(zone.population) * u64::from(profile.population_weight)
}

fn cohorts_for_window(
    input: &DemandEvaluationInputV1,
    generation: &DemandGenerationWindowV1,
) -> Result<Vec<JourneyDemandV1>, DemandError> {
    let slice = input
        .release
        .day_slices
        .iter()
        .find(|slice| slice.id == generation.day_slice_id)
        .expect("validated slice");
    let mut result = Vec::new();
    let mut generated = 0_u32;
    let window = generation.window_start_ms.to_string();
    for origin in &input.release.zones {
        for profile in &input.release.profiles {
            let total = u128::from(origin.population)
                * u128::from(profile.daily_trips_basis_points)
                * u128::from(input.release.season_basis_points)
                * u128::from(slice.share_basis_points)
                / 1_000_000_000_000;
            let total = u32::try_from(total)
                .map_err(|_| DemandError("generated_passenger_limit".into()))?;
            generated = generated
                .checked_add(total)
                .ok_or_else(|| DemandError("generated_passenger_limit".into()))?;
            ensure(
                generated <= input.release.max_generated_passengers,
                "generated_passenger_limit",
            )?;
            if total == 0 {
                continue;
            }
            let targets: Vec<_> = input
                .release
                .zones
                .iter()
                .filter(|zone| zone.id != origin.id && attraction(zone, profile) > 0)
                .collect();
            let weight_sum: u64 = targets.iter().map(|zone| attraction(zone, profile)).sum();
            let mut apportioned: Vec<_> = targets
                .into_iter()
                .map(|zone| {
                    let numerator = u128::from(total) * u128::from(attraction(zone, profile));
                    let count = u32::try_from(numerator / u128::from(weight_sum))
                        .expect("bounded by total");
                    let remainder = numerator % u128::from(weight_sum);
                    let tie = digest(&[
                        "demand_apportionment",
                        &input.world_id,
                        &input.period_id,
                        &input.seed,
                        &window,
                        &origin.id,
                        &profile.id,
                        &zone.id,
                    ]);
                    (zone, count, remainder, tie)
                })
                .collect();
            let remaining = total - apportioned.iter().map(|row| row.1).sum::<u32>();
            apportioned.sort_by(|a, b| {
                b.2.cmp(&a.2)
                    .then_with(|| a.3.cmp(&b.3))
                    .then_with(|| a.0.id.cmp(&b.0.id))
            });
            for row in apportioned
                .iter_mut()
                .take(usize::try_from(remaining).expect("bounded count"))
            {
                row.1 += 1;
            }
            for (destination, passengers, _, _) in apportioned {
                if passengers == 0 {
                    continue;
                }
                let cohort_id = digest(&[
                    "demand_cohort",
                    &input.world_id,
                    &input.period_id,
                    &input.release.id,
                    &window,
                    &origin.id,
                    &destination.id,
                    &profile.id,
                ]);
                let offset = draw(
                    &["departure_time", &input.seed, &cohort_id],
                    u64::try_from(generation.window_end_ms - generation.window_start_ms)
                        .expect("positive duration"),
                );
                result.push(JourneyDemandV1 {
                    world_id: input.world_id.clone(),
                    cohort_id,
                    origin_zone_id: origin.id.clone(),
                    destination_zone_id: destination.id.clone(),
                    profile_id: profile.id.clone(),
                    purpose: profile.purpose.clone(),
                    passengers,
                    desired_departure_ms: generation.window_start_ms
                        + i64::try_from(offset).expect("bounded duration"),
                });
            }
        }
    }
    result.sort_by(|a, b| a.cohort_id.cmp(&b.cohort_id));
    Ok(result)
}

fn cohorts(input: &DemandEvaluationInputV1) -> Result<Vec<JourneyDemandV1>, DemandError> {
    let mut cohorts = Vec::new();
    let mut count = 0_u32;
    for window in generation_windows(input) {
        let generated = cohorts_for_window(input, &window)?;
        for cohort in &generated {
            count = count
                .checked_add(cohort.passengers)
                .ok_or_else(|| DemandError("generated_passenger_limit".into()))?;
        }
        ensure(
            count <= input.release.max_generated_passengers,
            "generated_passenger_limit",
        )?;
        cohorts.extend(generated);
    }
    cohorts.sort_by(|a, b| a.cohort_id.cmp(&b.cohort_id));
    Ok(cohorts)
}

#[derive(Clone)]
struct Leg {
    service: usize,
    board: usize,
    alight: usize,
    fare_product_id: String,
    cents_per_segment: i64,
    reservation_required: bool,
}

#[derive(Clone)]
struct Candidate {
    id: String,
    legs: Vec<Leg>,
    alternative: Option<usize>,
    metrics: ChoiceMetricsV1,
}

struct Search<'a> {
    input: &'a DemandEvaluationInputV1,
    profile: &'a DemandProfileV1,
    cohort: &'a JourneyDemandV1,
    departures: &'a BTreeMap<String, Vec<(usize, usize)>>,
    destinations: BTreeMap<String, i64>,
    candidates: BTreeMap<String, Candidate>,
    steps: &'a mut usize,
}

impl Search<'_> {
    fn visit(
        &mut self,
        station: &str,
        ready: i64,
        legs: &mut Vec<Leg>,
        visited: &mut BTreeSet<String>,
    ) -> Result<(), DemandError> {
        let Some(departures) = self.departures.get(station) else {
            return Ok(());
        };
        for &(service_index, board) in departures {
            let service = &self.input.services[service_index];
            if service.cancelled
                || service.stops[board].departure_ms < ready
                || service.stops[board].departure_ms - self.cohort.desired_departure_ms
                    >= self.profile.max_journey_ms
                || legs.iter().any(|leg| leg.service == service_index)
            {
                continue;
            }
            for fare in &service.fares {
                if fare.comfort_class != self.profile.comfort_class
                    || !(fare.sales_available || fare.onboard_sales)
                {
                    continue;
                }
                for alight in (board + 1)..service.stops.len() {
                    let stop = &service.stops[alight];
                    if !stop.passenger_stop || visited.contains(&stop.station_id) {
                        continue;
                    }
                    if stop.arrival_ms - self.cohort.desired_departure_ms
                        > self.profile.max_journey_ms
                    {
                        break;
                    }
                    // Once the last permitted leg is reached, a non-destination
                    // cannot produce a route or a continuation state.
                    if legs.len()
                        == usize::try_from(self.input.release.max_transfers)
                            .expect("bounded transfers")
                        && !self.destinations.contains_key(&stop.station_id)
                    {
                        continue;
                    }
                    *self.steps += 1;
                    ensure(*self.steps <= MAX_SEARCH_STEPS, "connection_search_limit")?;
                    legs.push(Leg {
                        service: service_index,
                        board,
                        alight,
                        fare_product_id: fare.id.clone(),
                        cents_per_segment: fare.cents_per_segment,
                        reservation_required: fare.reservation_required,
                    });
                    if let Some(access) = self.destinations.get(&stop.station_id) {
                        let journey_ms =
                            stop.arrival_ms + access - self.cohort.desired_departure_ms;
                        let metrics = self.metrics(legs, journey_ms);
                        if metrics.fare_cents <= self.profile.max_fare_cents
                            && journey_ms <= self.profile.max_journey_ms
                        {
                            let route = legs
                                .iter()
                                .map(|leg| {
                                    let train = &self.input.services[leg.service];
                                    digest(&[
                                        &train.train_run_id,
                                        &leg.board.to_string(),
                                        &leg.alight.to_string(),
                                        &leg.fare_product_id,
                                    ])
                                })
                                .collect::<Vec<_>>();
                            let route: Vec<_> = route.iter().map(String::as_str).collect();
                            let candidate_id = digest(&route);
                            self.candidates.insert(
                                candidate_id.clone(),
                                Candidate {
                                    id: candidate_id,
                                    legs: legs.clone(),
                                    alternative: None,
                                    metrics,
                                },
                            );
                            ensure(
                                self.candidates.len()
                                    <= usize::try_from(
                                        self.input.release.max_connections_per_cohort,
                                    )
                                    .expect("bounded limit"),
                                "connection_count_limit",
                            )?;
                        }
                    } else if legs.len()
                        <= usize::try_from(self.input.release.max_transfers)
                            .expect("bounded transfers")
                    {
                        visited.insert(stop.station_id.clone());
                        self.visit(
                            &stop.station_id,
                            stop.arrival_ms + self.input.release.minimum_transfer_ms,
                            legs,
                            visited,
                        )?;
                        visited.remove(&stop.station_id);
                    }
                    legs.pop();
                }
            }
        }
        Ok(())
    }

    fn metrics(&self, legs: &[Leg], journey_ms: i64) -> ChoiceMetricsV1 {
        let mut metrics = ChoiceMetricsV1 {
            fare_cents: 0,
            journey_ms,
            transfers: u32::try_from(legs.len() - 1).expect("bounded legs"),
            service_interval_ms: 0,
            reliability_basis_points: 10_000,
            comfort_basis_points: 10_000,
        };
        for leg in legs {
            let service = &self.input.services[leg.service];
            metrics.fare_cents += leg.cents_per_segment
                * i64::try_from(leg.alight - leg.board).expect("bounded stops");
            metrics.service_interval_ms =
                metrics.service_interval_ms.max(service.service_interval_ms);
            metrics.reliability_basis_points = metrics
                .reliability_basis_points
                .min(service.reliability_basis_points);
            metrics.comfort_basis_points = metrics
                .comfort_basis_points
                .min(service.comfort_basis_points);
        }
        metrics
    }
}

fn compare_metrics(
    a: &ChoiceMetricsV1,
    b: &ChoiceMetricsV1,
    ranking: &[ChoiceDimensionV1],
) -> Ordering {
    for dimension in ranking {
        let order = match dimension {
            ChoiceDimensionV1::Fare => a.fare_cents.cmp(&b.fare_cents),
            ChoiceDimensionV1::Time => a.journey_ms.cmp(&b.journey_ms),
            ChoiceDimensionV1::Transfers => a.transfers.cmp(&b.transfers),
            ChoiceDimensionV1::Frequency => a.service_interval_ms.cmp(&b.service_interval_ms),
            ChoiceDimensionV1::Reliability => {
                b.reliability_basis_points.cmp(&a.reliability_basis_points)
            }
            ChoiceDimensionV1::Comfort => b.comfort_basis_points.cmp(&a.comfort_basis_points),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

fn candidates(
    input: &DemandEvaluationInputV1,
    cohort: &JourneyDemandV1,
    profile: &DemandProfileV1,
    departures: &BTreeMap<String, Vec<(usize, usize)>>,
    steps: &mut usize,
) -> Result<Vec<Candidate>, DemandError> {
    let origin = input
        .release
        .zones
        .iter()
        .find(|zone| zone.id == cohort.origin_zone_id)
        .expect("generated zone");
    let destination = input
        .release
        .zones
        .iter()
        .find(|zone| zone.id == cohort.destination_zone_id)
        .expect("generated zone");
    let permitted = |access: &&StationTransitAccessV1| {
        profile.space_needs != SpaceNeedsV1::Wheelchair || access.step_free
    };
    let mut search = Search {
        input,
        cohort,
        profile,
        departures,
        steps,
        destinations: destination
            .stations
            .iter()
            .filter(permitted)
            .map(|access| {
                (
                    access.station_id.clone(),
                    access.access_ms + access.service_interval_ms / 2,
                )
            })
            .collect(),
        candidates: BTreeMap::new(),
    };
    for access in origin.stations.iter().filter(permitted) {
        let ready = (cohort.desired_departure_ms
            + access.access_ms
            + access.service_interval_ms / 2)
            .max(if input.operational_progress.is_some() {
                input.now_ms
            } else {
                0
            });
        search.visit(
            &access.station_id,
            ready,
            &mut Vec::new(),
            &mut BTreeSet::from([access.station_id.clone()]),
        )?;
    }
    let mut result: Vec<_> = search.candidates.into_values().collect();
    for (index, alternative) in input.alternatives.iter().enumerate() {
        if alternative.origin_zone_id != origin.id
            || alternative.destination_zone_id != destination.id
            || alternative.fare_cents > profile.max_fare_cents
            || alternative.journey_ms > profile.max_journey_ms
            || (profile.space_needs == SpaceNeedsV1::Wheelchair && !alternative.accessible)
        {
            continue;
        }
        result.push(Candidate {
            id: digest(&["alternative", &alternative.id]),
            legs: Vec::new(),
            alternative: Some(index),
            metrics: ChoiceMetricsV1 {
                fare_cents: alternative.fare_cents,
                journey_ms: alternative.journey_ms,
                transfers: 0,
                service_interval_ms: alternative.service_interval_ms,
                reliability_basis_points: alternative.reliability_basis_points,
                comfort_basis_points: alternative.comfort_basis_points,
            },
        });
    }
    ensure(
        result.len()
            <= usize::try_from(input.release.max_connections_per_cohort).expect("bounded count"),
        "connection_count_limit",
    )?;
    result.sort_by(|a, b| {
        compare_metrics(&a.metrics, &b.metrics, &profile.ranking)
            .then_with(|| {
                digest(&["choice_tie", &input.seed, &cohort.cohort_id, &a.id]).cmp(&digest(&[
                    "choice_tie",
                    &input.seed,
                    &cohort.cohort_id,
                    &b.id,
                ]))
            })
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(result)
}

struct SegmentUsage {
    standard: BTreeSet<u32>,
    premium: BTreeSet<u32>,
    standing: u32,
    next_standard_seat: u32,
    next_premium_seat: u32,
    reserved: u32,
    wheelchair: u32,
    bicycle: u32,
    stroller: u32,
    revenue: i64,
    passengers: Vec<ManifestPassengerV1>,
}

impl Default for SegmentUsage {
    fn default() -> Self {
        Self {
            standard: BTreeSet::new(),
            premium: BTreeSet::new(),
            standing: 0,
            next_standard_seat: 1,
            next_premium_seat: 1,
            reserved: 0,
            wheelchair: 0,
            bicycle: 0,
            stroller: 0,
            revenue: 0,
            passengers: Vec::new(),
        }
    }
}

impl SegmentUsage {
    fn next_seat(&self, class: ComfortClassV1) -> u32 {
        if class == ComfortClassV1::Premium {
            self.next_premium_seat
        } else {
            self.next_standard_seat
        }
    }

    fn occupy_seat(&mut self, class: ComfortClassV1, seat: u32) {
        let (occupied, next) = if class == ComfortClassV1::Premium {
            (&mut self.premium, &mut self.next_premium_seat)
        } else {
            (&mut self.standard, &mut self.next_standard_seat)
        };
        occupied.insert(seat);
        while occupied.contains(next) {
            *next += 1;
        }
    }
}

struct SeatAssignment {
    service: usize,
    segment: usize,
    seat: Option<u32>,
    reserved: bool,
}

fn seat_plan(
    input: &DemandEvaluationInputV1,
    candidate: &Candidate,
    profile: &DemandProfileV1,
    usage: &[Vec<SegmentUsage>],
) -> Option<Vec<SeatAssignment>> {
    let mut assignments = Vec::new();
    for leg in &candidate.legs {
        let train = &input.services[leg.service];
        let capacity = &train.capacity;
        let reserved = profile.requires_reservation || leg.reservation_required;
        let seats = if profile.comfort_class == ComfortClassV1::Premium {
            capacity.premium_seats
        } else {
            capacity.standard_seats
        };
        let available = |segment: usize, seat: u32| {
            let state = &usage[leg.service][segment];
            if profile.comfort_class == ComfortClassV1::Premium {
                !state.premium.contains(&seat)
            } else {
                !state.standard.contains(&seat)
            }
        };
        let reserved_seat =
            if reserved {
                let start = (leg.board..leg.alight)
                    .map(|segment| usage[leg.service][segment].next_seat(profile.comfort_class))
                    .max()?;
                Some((start..=seats).find(|seat| {
                    (leg.board..leg.alight).all(|segment| available(segment, *seat))
                })?)
            } else {
                None
            };
        for (segment, state) in usage[leg.service]
            .iter()
            .enumerate()
            .take(leg.alight)
            .skip(leg.board)
        {
            let spaces_available = match profile.space_needs {
                SpaceNeedsV1::Ordinary => true,
                SpaceNeedsV1::Wheelchair => state.wheelchair < capacity.wheelchair_spaces,
                SpaceNeedsV1::Bicycle => state.bicycle < capacity.bicycle_spaces,
                SpaceNeedsV1::Stroller => state.stroller < capacity.stroller_spaces,
            };
            if !spaces_available {
                return None;
            }
            let first_free = state.next_seat(profile.comfort_class);
            let seat = reserved_seat.or_else(|| (first_free <= seats).then_some(first_free));
            if seat.is_none()
                && (profile.comfort_class == ComfortClassV1::Premium
                    || reserved
                    || state.standing >= capacity.standard_standing)
            {
                return None;
            }
            assignments.push(SeatAssignment {
                service: leg.service,
                segment,
                seat,
                reserved,
            });
        }
    }
    Some(assignments)
}

fn segment_id(train: &TrainServiceV1, segment: usize) -> String {
    digest(&[
        "train_segment",
        &train.world_id,
        &train.train_run_id,
        &train.stops[segment].stop_id,
        &train.stops[segment + 1].stop_id,
    ])
}

fn train_choices(input: &DemandEvaluationInputV1, candidate: &Candidate) -> Vec<TrainChoiceV1> {
    candidate
        .legs
        .iter()
        .map(|leg| {
            let train = &input.services[leg.service];
            TrainChoiceV1 {
                train_run_id: train.train_run_id.clone(),
                mode: train.mode,
                boarding_stop_id: train.stops[leg.board].stop_id.clone(),
                alighting_stop_id: train.stops[leg.alight].stop_id.clone(),
                fare_product_id: leg.fare_product_id.clone(),
                fare_cents_per_segment: leg.cents_per_segment,
                reservation_required: leg.reservation_required,
                segment_ids: (leg.board..leg.alight)
                    .map(|segment| segment_id(train, segment))
                    .collect(),
            }
        })
        .collect()
}

fn materialize(
    input: &DemandEvaluationInputV1,
    cohort: &JourneyDemandV1,
    ordinal: u32,
    profile: &DemandProfileV1,
    leg: &Leg,
    seat: &SeatAssignment,
) -> ManifestPassengerV1 {
    let train = &input.services[leg.service];
    let ordinal = ordinal.to_string();
    let passenger_key = digest(&[
        "passenger_identity",
        &input.seed,
        &cohort.cohort_id,
        &ordinal,
    ]);
    let journey_chain_id = digest(&["journey_chain", &input.seed, &cohort.cohort_id, &ordinal]);
    let fare_draw = draw(
        &["fare_compliance", &input.seed, &journey_chain_id, &ordinal],
        10_000,
    );
    let policy = &input.release.fare_compliance;
    let fare_fact = if fare_draw < u64::from(policy.valid_basis_points) {
        FareFactV1::Valid
    } else if fare_draw < u64::from(policy.valid_basis_points + policy.unpresentable_basis_points) {
        FareFactV1::ValidUnpresentable
    } else {
        FareFactV1::Invalid
    };
    ManifestPassengerV1 {
        passenger_key: passenger_key.clone(),
        journey_chain_id,
        boarding_stop_id: train.stops[leg.board].stop_id.clone(),
        alighting_stop_id: train.stops[leg.alight].stop_id.clone(),
        demand_segment: profile.id.clone(),
        comfort_class: profile.comfort_class,
        space_needs: profile.space_needs,
        fare_fact,
        fare_policy_provenance: policy.provenance,
        reservation_id: seat.reserved.then(|| {
            digest(&[
                "reservation",
                &input.world_id,
                &passenger_key,
                &train.train_run_id,
                &train.stops[leg.board].stop_id,
                &train.stops[leg.alight].stop_id,
            ])
        }),
        seat_number: seat.seat,
    }
}

fn progress_stop<'a>(
    input: &'a DemandEvaluationInputV1,
    train: &str,
    stop: &str,
) -> Option<&'a StopOperationalProgressV1> {
    input
        .operational_progress
        .as_ref()?
        .trains
        .iter()
        .find(|row| row.train_run_id == train)?
        .stops
        .iter()
        .find(|row| row.stop_id == stop)
}

fn validate_progress(
    input: &DemandEvaluationInputV1,
    cohorts: &[JourneyDemandV1],
) -> Result<(), DemandError> {
    let Some(progress) = &input.operational_progress else {
        return ensure(
            input.previous_evaluation.is_none(),
            "previous_evaluation_requires_progress",
        );
    };
    ensure(
        progress.schema_version == "demand-operational-progress/v1"
            && progress.world_id == input.world_id
            && progress.as_of_ms == input.now_ms
            && id(&progress.receipt_id)
            && unique(progress.trains.iter().map(|row| row.train_run_id.as_str())),
        "invalid_operational_progress",
    )?;
    for row in &progress.trains {
        let train = input
            .services
            .iter()
            .find(|train| train.train_run_id == row.train_run_id)
            .ok_or_else(|| DemandError("unknown_progress_train".into()))?;
        ensure(
            row.stops.len() <= train.stops.len()
                && unique(row.stops.iter().map(|stop| stop.stop_id.as_str())),
            "invalid_progress_stops",
        )?;
        for stop in &row.stops {
            ensure(
                train
                    .stops
                    .iter()
                    .any(|train_stop| train_stop.stop_id == stop.stop_id)
                    && (stop.actual_arrival_ms.is_some() || stop.actual_departure_ms.is_some()),
                "invalid_progress_stop",
            )?;
            for time in [stop.actual_arrival_ms, stop.actual_departure_ms]
                .into_iter()
                .flatten()
            {
                ensure(
                    (0..=input.now_ms).contains(&time),
                    "unconfirmed_future_progress",
                )?;
            }
        }
        let mut last = None;
        for stop in &train.stops {
            if let Some(actual) = row.stops.iter().find(|row| row.stop_id == stop.stop_id) {
                for time in [actual.actual_arrival_ms, actual.actual_departure_ms]
                    .into_iter()
                    .flatten()
                {
                    ensure(
                        last.is_none_or(|previous| time >= previous),
                        "nonmonotonic_operational_progress",
                    )?;
                    last = Some(time);
                }
            }
        }
    }
    let Some(previous) = &input.previous_evaluation else {
        return ensure(
            progress.trains.iter().all(|row| row.stops.is_empty()),
            "progress_requires_previous_evaluation",
        );
    };
    let before = &previous.result;
    ensure(
        before.schema_version == RESULT_SCHEMA
            && before.world_id == input.world_id
            && before.period_id == input.period_id
            && before.demand_release_id == input.release.id
            && before.release_hash == release_hash(&input.release)?
            && before.seed_hash
                == digest(&["world_seed", &input.world_id, &input.period_id, &input.seed])
            && before.window_start_ms == input.window_start_ms
            && before.window_end_ms == input.window_end_ms
            && before.generation_windows == generation_windows(input)
            && before.revision < input.revision
            && before.now_ms <= input.now_ms
            && before.cohorts == cohorts,
        "previous_evaluation_scope_mismatch",
    )?;
    let mut unhashed = before.clone();
    unhashed.state_hash.clear();
    let hash: String = Sha256::digest(serde_json::to_vec(&unhashed)?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    ensure(
        hash == before.state_hash,
        "previous_evaluation_hash_mismatch",
    )?;
    let mut previous_input = input.clone();
    previous_input.services = previous.services.clone();
    previous_input.previous_evaluation = None;
    previous_input.operational_progress = None;
    validate_input(&previous_input)?;
    if let Some(old_progress) = &before.operational_progress {
        for train in &old_progress.trains {
            for old_stop in &train.stops {
                let current = progress_stop(input, &train.train_run_id, &old_stop.stop_id)
                    .ok_or_else(|| DemandError("operational_progress_regressed".into()))?;
                ensure(
                    old_stop
                        .actual_arrival_ms
                        .is_none_or(|time| current.actual_arrival_ms == Some(time))
                        && old_stop
                            .actual_departure_ms
                            .is_none_or(|time| current.actual_departure_ms == Some(time)),
                    "operational_progress_regressed",
                )?;
            }
        }
    }
    ensure(
        before.journey_seats.len() <= MAX_MANIFEST_ENTRIES,
        "previous_seat_limit",
    )?;
    let seats: BTreeSet<_> = before
        .journey_seats
        .iter()
        .map(|seat| {
            (
                &seat.cohort_id,
                seat.ordinal,
                &seat.train_run_id,
                &seat.segment_id,
            )
        })
        .collect();
    ensure(
        seats.len() == before.journey_seats.len(),
        "duplicate_previous_seat",
    )?;
    Ok(())
}

#[derive(Clone)]
struct FrozenJourney {
    prefix: Candidate,
    must_continue: bool,
    completed: bool,
    ready: i64,
    station: String,
}

fn frozen_journeys(
    input: &DemandEvaluationInputV1,
    cohorts: &[JourneyDemandV1],
) -> Result<BTreeMap<(String, u32), FrozenJourney>, DemandError> {
    let mut frozen = BTreeMap::new();
    let Some(previous) = &input.previous_evaluation else {
        return Ok(frozen);
    };
    for choice in &previous.result.choices {
        if choice.trains.is_empty() {
            continue;
        }
        let cohort = cohorts
            .iter()
            .find(|cohort| cohort.cohort_id == choice.cohort_id)
            .ok_or_else(|| DemandError("previous_choice_unknown_cohort".into()))?;
        ensure(
            choice.passengers > 0
                && choice
                    .ordinal_start
                    .checked_add(choice.passengers)
                    .is_some_and(|end| end <= cohort.passengers),
            "invalid_previous_choice_range",
        )?;
        let origin = input
            .release
            .zones
            .iter()
            .find(|zone| zone.id == cohort.origin_zone_id)
            .expect("generated origin");
        let destination = input
            .release
            .zones
            .iter()
            .find(|zone| zone.id == cohort.destination_zone_id)
            .expect("generated destination");
        let mut legs = Vec::new();
        let mut ready = cohort.desired_departure_ms;
        let mut completed = false;
        let mut station = String::new();
        let mut quality = (10_000_u32, 10_000_u32, 0_i64);
        for recorded in &choice.trains {
            let old_train = previous
                .services
                .iter()
                .find(|train| train.train_run_id == recorded.train_run_id)
                .ok_or_else(|| DemandError("previous_service_missing".into()))?;
            let Some(actual_departure) =
                progress_stop(input, &recorded.train_run_id, &recorded.boarding_stop_id)
                    .and_then(|stop| stop.actual_departure_ms)
            else {
                break;
            };
            if legs.is_empty() {
                let board = old_train
                    .stops
                    .iter()
                    .find(|stop| stop.stop_id == recorded.boarding_stop_id)
                    .ok_or_else(|| DemandError("previous_boarding_stop_missing".into()))?;
                let Some(access) = origin
                    .stations
                    .iter()
                    .find(|access| access.station_id == board.station_id)
                else {
                    break;
                };
                ready += access.access_ms + access.service_interval_ms / 2;
            }
            if actual_departure < ready {
                break;
            }
            let service = input
                .services
                .iter()
                .position(|train| train.train_run_id == recorded.train_run_id)
                .ok_or_else(|| DemandError("confirmed_train_removed".into()))?;
            let train = &input.services[service];
            let board = train
                .stops
                .iter()
                .position(|stop| stop.stop_id == recorded.boarding_stop_id)
                .ok_or_else(|| DemandError("confirmed_route_changed".into()))?;
            let alight = train
                .stops
                .iter()
                .position(|stop| stop.stop_id == recorded.alighting_stop_id)
                .ok_or_else(|| DemandError("confirmed_route_changed".into()))?;
            ensure(
                board < alight
                    && recorded.segment_ids
                        == (board..alight)
                            .map(|segment| segment_id(train, segment))
                            .collect::<Vec<_>>(),
                "confirmed_route_changed",
            )?;
            let arrival = progress_stop(input, &recorded.train_run_id, &recorded.alighting_stop_id)
                .and_then(|stop| stop.actual_arrival_ms);
            ensure(
                arrival.is_some() || (!train.cancelled && train.stops[alight].passenger_stop),
                "onboard_change_requires_alighting_receipt",
            )?;
            ensure(
                money(recorded.fare_cents_per_segment),
                "invalid_booked_fare",
            )?;
            legs.push(Leg {
                service,
                board,
                alight,
                fare_product_id: recorded.fare_product_id.clone(),
                cents_per_segment: recorded.fare_cents_per_segment,
                reservation_required: recorded.reservation_required,
            });
            quality.0 = quality.0.min(old_train.reliability_basis_points);
            quality.1 = quality.1.min(old_train.comfort_basis_points);
            quality.2 = quality.2.max(old_train.service_interval_ms);
            station = train.stops[alight].station_id.clone();
            completed = arrival.is_some();
            ready = arrival.unwrap_or_else(|| train.stops[alight].arrival_ms.max(input.now_ms))
                + input.release.minimum_transfer_ms;
            if !completed {
                break;
            }
        }
        if legs.is_empty() {
            continue;
        }
        let must_continue = !destination
            .stations
            .iter()
            .any(|access| access.station_id == station);
        let metrics = ChoiceMetricsV1 {
            fare_cents: legs
                .iter()
                .map(|leg| {
                    leg.cents_per_segment
                        * i64::try_from(leg.alight - leg.board).expect("bounded leg")
                })
                .sum(),
            journey_ms: (ready - input.release.minimum_transfer_ms - cohort.desired_departure_ms)
                .max(0),
            transfers: u32::try_from(legs.len() - 1).expect("bounded transfers"),
            service_interval_ms: quality.2,
            reliability_basis_points: quality.0,
            comfort_basis_points: quality.1,
        };
        let route: Vec<_> = legs
            .iter()
            .map(|leg| {
                digest(&[
                    &input.services[leg.service].train_run_id,
                    &leg.board.to_string(),
                    &leg.alight.to_string(),
                    &leg.fare_product_id,
                ])
            })
            .collect();
        let prefix = Candidate {
            id: digest(&route.iter().map(String::as_str).collect::<Vec<_>>()),
            legs,
            alternative: None,
            metrics,
        };
        for ordinal in choice.ordinal_start..(choice.ordinal_start + choice.passengers) {
            ensure(
                frozen
                    .insert(
                        (cohort.cohort_id.clone(), ordinal),
                        FrozenJourney {
                            prefix: prefix.clone(),
                            must_continue,
                            completed,
                            ready: ready.max(input.now_ms),
                            station: station.clone(),
                        },
                    )
                    .is_none(),
                "duplicate_confirmed_journey",
            )?;
        }
    }
    Ok(frozen)
}

fn continuation_candidates(
    input: &DemandEvaluationInputV1,
    cohort: &JourneyDemandV1,
    profile: &DemandProfileV1,
    frozen: &FrozenJourney,
    departures: &BTreeMap<String, Vec<(usize, usize)>>,
    steps: &mut usize,
) -> Result<Vec<Candidate>, DemandError> {
    let mut remaining = profile.clone();
    remaining.max_fare_cents = (profile.max_fare_cents - frozen.prefix.metrics.fare_cents).max(0);
    let destination = input
        .release
        .zones
        .iter()
        .find(|zone| zone.id == cohort.destination_zone_id)
        .expect("generated destination");
    let mut search = Search {
        input,
        cohort,
        profile: &remaining,
        departures,
        steps,
        destinations: destination
            .stations
            .iter()
            .filter(|access| profile.space_needs != SpaceNeedsV1::Wheelchair || access.step_free)
            .map(|access| {
                (
                    access.station_id.clone(),
                    access.access_ms + access.service_interval_ms / 2,
                )
            })
            .collect(),
        candidates: BTreeMap::new(),
    };
    search.visit(
        &frozen.station,
        frozen.ready,
        &mut Vec::new(),
        &mut BTreeSet::from([frozen.station.clone()]),
    )?;
    let mut result: Vec<_> = search
        .candidates
        .into_values()
        .filter(|candidate| {
            candidate.legs.iter().all(|leg| {
                frozen
                    .prefix
                    .legs
                    .iter()
                    .all(|prior| prior.service != leg.service)
            }) && candidate.legs.len() + frozen.prefix.legs.len()
                <= usize::try_from(input.release.max_transfers + 1).expect("bounded legs")
        })
        .collect();
    let combined = |candidate: &Candidate| {
        let mut metrics = candidate.metrics.clone();
        metrics.reliability_basis_points = metrics
            .reliability_basis_points
            .min(frozen.prefix.metrics.reliability_basis_points);
        metrics.comfort_basis_points = metrics
            .comfort_basis_points
            .min(frozen.prefix.metrics.comfort_basis_points);
        metrics.service_interval_ms = metrics
            .service_interval_ms
            .max(frozen.prefix.metrics.service_interval_ms);
        metrics
    };
    result.sort_by(|a, b| {
        compare_metrics(&combined(a), &combined(b), &profile.ranking).then_with(|| {
            digest(&["choice_tie", &input.seed, &cohort.cohort_id, &a.id]).cmp(&digest(&[
                "choice_tie",
                &input.seed,
                &cohort.cohort_id,
                &b.id,
            ]))
        })
    });
    Ok(result)
}

#[derive(Clone, Copy)]
struct Traveller<'a> {
    input: &'a DemandEvaluationInputV1,
    cohort: &'a JourneyDemandV1,
    ordinal: u32,
    profile: &'a DemandProfileV1,
}

fn commit_plan(
    traveller: Traveller<'_>,
    candidate: &Candidate,
    plan: &[SeatAssignment],
    usage: &mut [Vec<SegmentUsage>],
    flows: &mut [Vec<(u32, u32)>],
    result: &mut DemandEvaluationV1,
) -> Result<(), DemandError> {
    let Traveller {
        input,
        cohort,
        ordinal,
        profile,
    } = traveller;
    for leg in &candidate.legs {
        let train = &input.services[leg.service];
        flows[leg.service][leg.board].0 += 1;
        flows[leg.service][leg.alight].1 += 1;
        for seat in plan.iter().filter(|seat| seat.service == leg.service) {
            let state = &mut usage[seat.service][seat.segment];
            let capacity = &train.capacity;
            if let Some(number) = seat.seat {
                let (occupied, maximum) = if profile.comfort_class == ComfortClassV1::Premium {
                    (&state.premium, capacity.premium_seats)
                } else {
                    (&state.standard, capacity.standard_seats)
                };
                ensure(
                    number > 0 && number <= maximum && !occupied.contains(&number),
                    "confirmed_seat_capacity_conflict",
                )?;
                state.occupy_seat(profile.comfort_class, number);
            } else {
                ensure(
                    !seat.reserved
                        && profile.comfort_class == ComfortClassV1::Standard
                        && state.standing < capacity.standard_standing,
                    "confirmed_standing_capacity_conflict",
                )?;
                state.standing += 1;
            }
            state.reserved += u32::from(seat.reserved);
            match profile.space_needs {
                SpaceNeedsV1::Ordinary => {}
                SpaceNeedsV1::Wheelchair => state.wheelchair += 1,
                SpaceNeedsV1::Bicycle => state.bicycle += 1,
                SpaceNeedsV1::Stroller => state.stroller += 1,
            }
            ensure(
                state.wheelchair <= capacity.wheelchair_spaces
                    && state.bicycle <= capacity.bicycle_spaces
                    && state.stroller <= capacity.stroller_spaces,
                "confirmed_space_capacity_conflict",
            )?;
            state.revenue += leg.cents_per_segment;
            ensure(
                result.journey_seats.len() < MAX_MANIFEST_ENTRIES,
                "manifest_size_limit",
            )?;
            result.journey_seats.push(PassengerSeatAssignmentV1 {
                cohort_id: cohort.cohort_id.clone(),
                ordinal,
                train_run_id: train.train_run_id.clone(),
                segment_id: segment_id(train, seat.segment),
                seat_number: seat.seat,
                reserved: seat.reserved,
            });
            if train.mode == RailModeV1::Spnv {
                state
                    .passengers
                    .push(materialize(input, cohort, ordinal, profile, leg, seat));
            }
        }
    }
    result.totals.forecast_revenue_cents += candidate.metrics.fare_cents;
    ensure(
        result.totals.forecast_revenue_cents <= SAFE_INTEGER,
        "revenue_size_limit",
    )?;
    Ok(())
}

fn choice_record(
    traveller: Traveller<'_>,
    candidate: &Candidate,
    prefix: Option<&FrozenJourney>,
    status: &str,
    rejected: Vec<RejectedConnectionV1>,
) -> ConnectionChoiceV1 {
    let Traveller {
        input,
        cohort,
        ordinal,
        profile,
    } = traveller;
    let mut trains = prefix
        .map(|frozen| train_choices(input, &frozen.prefix))
        .unwrap_or_default();
    trains.extend(train_choices(input, candidate));
    let mut metrics = candidate.metrics.clone();
    if let Some(prefix) = prefix {
        metrics.fare_cents += prefix.prefix.metrics.fare_cents;
        metrics.journey_ms = metrics.journey_ms.max(prefix.prefix.metrics.journey_ms);
        metrics.transfers = u32::try_from(trains.len().saturating_sub(1)).expect("bounded legs");
        metrics.reliability_basis_points = metrics
            .reliability_basis_points
            .min(prefix.prefix.metrics.reliability_basis_points);
        metrics.comfort_basis_points = metrics
            .comfort_basis_points
            .min(prefix.prefix.metrics.comfort_basis_points);
        metrics.service_interval_ms = metrics
            .service_interval_ms
            .max(prefix.prefix.metrics.service_interval_ms);
    }
    ConnectionChoiceV1 {
        world_id: input.world_id.clone(),
        cohort_id: cohort.cohort_id.clone(),
        connection_id: prefix
            .map(|prefix| digest(&["continued_connection", &prefix.prefix.id, &candidate.id]))
            .unwrap_or_else(|| candidate.id.clone()),
        alternative_mode: candidate
            .alternative
            .map(|index| input.alternatives[index].mode),
        trains,
        metrics,
        ranking: profile.ranking.clone(),
        ordinal_start: ordinal,
        passengers: 1,
        journey_status: status.into(),
        rejected,
    }
}

fn append_choice(choices: &mut Vec<ConnectionChoiceV1>, choice: ConnectionChoiceV1) {
    if let Some(last) = choices.last_mut() {
        if last.cohort_id == choice.cohort_id
            && last.connection_id == choice.connection_id
            && last.journey_status == choice.journey_status
            && last.ordinal_start + last.passengers == choice.ordinal_start
            && last.rejected == choice.rejected
        {
            last.passengers += 1;
            return;
        }
    }
    choices.push(choice);
}

/// Wertet einen vollständigen, welt- und fenstergebundenen Faktenstand atomar aus.
pub fn evaluate_demand(input: &DemandEvaluationInputV1) -> Result<DemandEvaluationV1, DemandError> {
    validate_input(input)?;
    let mut input = input.clone();
    input.release = canonical_release(&input.release);
    input
        .services
        .sort_by(|a, b| a.train_run_id.cmp(&b.train_run_id));
    for service in &mut input.services {
        service.fares.sort_by(|a, b| a.id.cmp(&b.id));
    }
    input.alternatives.sort_by(|a, b| a.id.cmp(&b.id));
    if let Some(progress) = &mut input.operational_progress {
        progress
            .trains
            .sort_by(|a, b| a.train_run_id.cmp(&b.train_run_id));
        for train in &mut progress.trains {
            train.stops.sort_by(|a, b| a.stop_id.cmp(&b.stop_id));
        }
    }
    let input = &input;
    let cohorts = cohorts(input)?;
    validate_progress(input, &cohorts)?;
    let mut result = DemandEvaluationV1 {
        schema_version: RESULT_SCHEMA.into(),
        world_id: input.world_id.clone(),
        period_id: input.period_id.clone(),
        demand_release_id: input.release.id.clone(),
        release_hash: release_hash(&input.release)?,
        seed_hash: digest(&["world_seed", &input.world_id, &input.period_id, &input.seed]),
        now_ms: input.now_ms,
        revision: input.revision,
        window_start_ms: input.window_start_ms,
        window_end_ms: input.window_end_ms,
        generation_windows: generation_windows(input),
        projection_mode: if input.operational_progress.is_some() {
            "progress_bound"
        } else {
            "forecast"
        }
        .into(),
        operational_progress: input.operational_progress.clone(),
        cohorts: cohorts.clone(),
        choices: Vec::new(),
        unserved: Vec::new(),
        allocations: Vec::new(),
        manifests: Vec::new(),
        journey_seats: Vec::new(),
        stop_flows: Vec::new(),
        totals: DemandTotalsV1 {
            generated: cohorts.iter().map(|cohort| cohort.passengers).sum(),
            rail: 0,
            alternative: 0,
            unserved: 0,
            stranded: 0,
            forecast_revenue_cents: 0,
        },
        state_hash: String::new(),
    };
    let mut usage: Vec<Vec<SegmentUsage>> = input
        .services
        .iter()
        .map(|train| {
            (1..train.stops.len())
                .map(|_| SegmentUsage::default())
                .collect()
        })
        .collect();
    let mut flows: Vec<Vec<(u32, u32)>> = input
        .services
        .iter()
        .map(|train| vec![(0, 0); train.stops.len()])
        .collect();
    let mut alternative_usage = vec![0_u32; input.alternatives.len()];
    let mut departures: BTreeMap<String, Vec<(usize, usize)>> = BTreeMap::new();
    for (service_index, train) in input.services.iter().enumerate() {
        for (stop_index, stop) in train.stops.iter().enumerate().take(train.stops.len() - 1) {
            if stop.passenger_stop
                && progress_stop(input, &train.train_run_id, &stop.stop_id)
                    .is_none_or(|stop| stop.actual_departure_ms.is_none())
            {
                departures
                    .entry(stop.station_id.clone())
                    .or_default()
                    .push((service_index, stop_index));
            }
        }
    }
    let mut allocation_order: Vec<_> = cohorts.iter().collect();
    allocation_order
        .sort_by_key(|cohort| digest(&["capacity_order", &input.seed, &cohort.cohort_id]));
    let mut search_steps = 0_usize;
    let frozen = frozen_journeys(input, &cohorts)?;
    let previous_seats: BTreeMap<_, _> = input
        .previous_evaluation
        .iter()
        .flat_map(|previous| &previous.result.journey_seats)
        .map(|seat| {
            (
                (
                    seat.cohort_id.clone(),
                    seat.ordinal,
                    seat.train_run_id.clone(),
                    seat.segment_id.clone(),
                ),
                seat,
            )
        })
        .collect();
    for ((cohort_id, ordinal), journey) in &frozen {
        let cohort = cohorts
            .iter()
            .find(|cohort| &cohort.cohort_id == cohort_id)
            .expect("validated frozen cohort");
        let profile = input
            .release
            .profiles
            .iter()
            .find(|profile| profile.id == cohort.profile_id)
            .expect("generated profile");
        let mut plan = Vec::new();
        for leg in &journey.prefix.legs {
            let train = &input.services[leg.service];
            for segment in leg.board..leg.alight {
                let seat = previous_seats
                    .get(&(
                        cohort_id.clone(),
                        *ordinal,
                        train.train_run_id.clone(),
                        segment_id(train, segment),
                    ))
                    .ok_or_else(|| DemandError("confirmed_seat_missing".into()))?;
                plan.push(SeatAssignment {
                    service: leg.service,
                    segment,
                    seat: seat.seat_number,
                    reserved: seat.reserved,
                });
            }
        }
        commit_plan(
            Traveller {
                input,
                cohort,
                ordinal: *ordinal,
                profile,
            },
            &journey.prefix,
            &plan,
            &mut usage,
            &mut flows,
            &mut result,
        )?;
    }
    for cohort in allocation_order {
        let profile = input
            .release
            .profiles
            .iter()
            .find(|profile| profile.id == cohort.profile_id)
            .expect("generated profile");
        let candidates = candidates(input, cohort, profile, &departures, &mut search_steps)?;
        let mut continuations = BTreeMap::<String, Vec<Candidate>>::new();
        for ordinal in 0..cohort.passengers {
            let traveller = Traveller {
                input,
                cohort,
                ordinal,
                profile,
            };
            let prefix = frozen.get(&(cohort.cohort_id.clone(), ordinal));
            if let Some(prefix) = prefix {
                if !prefix.must_continue {
                    let empty = Candidate {
                        id: "destination_reached".into(),
                        legs: Vec::new(),
                        alternative: None,
                        metrics: ChoiceMetricsV1 {
                            fare_cents: 0,
                            journey_ms: 0,
                            transfers: 0,
                            service_interval_ms: 0,
                            reliability_basis_points: 10_000,
                            comfort_basis_points: 10_000,
                        },
                    };
                    append_choice(
                        &mut result.choices,
                        choice_record(
                            traveller,
                            &empty,
                            Some(prefix),
                            if prefix.completed {
                                "completed"
                            } else {
                                "in_progress"
                            },
                            Vec::new(),
                        ),
                    );
                    result.totals.rail += 1;
                    continue;
                }
                if !continuations.contains_key(&prefix.prefix.id) {
                    continuations.insert(
                        prefix.prefix.id.clone(),
                        continuation_candidates(
                            input,
                            cohort,
                            profile,
                            prefix,
                            &departures,
                            &mut search_steps,
                        )?,
                    );
                }
            }
            let available = prefix
                .map(|prefix| &continuations[&prefix.prefix.id])
                .unwrap_or(&candidates);
            let mut rejected = Vec::new();
            let mut selected = None;
            for candidate in available {
                if let Some(alternative) = candidate.alternative {
                    if alternative_usage[alternative] < input.alternatives[alternative].capacity {
                        alternative_usage[alternative] += 1;
                        result.totals.alternative += 1;
                        selected = Some(candidate);
                        break;
                    }
                } else if let Some(plan) = seat_plan(input, candidate, profile, &usage) {
                    commit_plan(
                        traveller,
                        candidate,
                        &plan,
                        &mut usage,
                        &mut flows,
                        &mut result,
                    )?;
                    result.totals.rail += 1;
                    selected = Some(candidate);
                    break;
                }
                rejected.push(RejectedConnectionV1 {
                    connection_id: candidate.id.clone(),
                    reason: "capacity_or_reservation_unavailable".into(),
                });
            }
            if let Some(candidate) = selected {
                append_choice(
                    &mut result.choices,
                    choice_record(
                        traveller,
                        candidate,
                        prefix,
                        if prefix.is_some() {
                            "in_progress"
                        } else {
                            "planned"
                        },
                        rejected,
                    ),
                );
            } else if let Some(prefix) = prefix {
                let empty = Candidate {
                    id: "onward_unavailable".into(),
                    legs: Vec::new(),
                    alternative: None,
                    metrics: ChoiceMetricsV1 {
                        fare_cents: 0,
                        journey_ms: 0,
                        transfers: 0,
                        service_interval_ms: 0,
                        reliability_basis_points: 10_000,
                        comfort_basis_points: 10_000,
                    },
                };
                append_choice(
                    &mut result.choices,
                    choice_record(traveller, &empty, Some(prefix), "stranded", rejected),
                );
                result.totals.rail += 1;
                result.totals.stranded += 1;
            } else {
                result.totals.unserved += 1;
                let reason = if available.is_empty() {
                    "no_feasible_connection"
                } else {
                    "all_connections_full"
                };
                if let Some(last) = result.unserved.last_mut().filter(|last| {
                    last.cohort_id == cohort.cohort_id
                        && last.reason == reason
                        && last.ordinal_start + last.passengers == ordinal
                }) {
                    last.passengers += 1;
                } else {
                    result.unserved.push(UnservedDemandV1 {
                        world_id: input.world_id.clone(),
                        cohort_id: cohort.cohort_id.clone(),
                        ordinal_start: ordinal,
                        passengers: 1,
                        reason: reason.into(),
                    });
                }
            }
        }
    }
    for (service_index, train) in input.services.iter().enumerate() {
        let mut onboard = 0_u32;
        for (stop_index, stop) in train.stops.iter().enumerate() {
            let (boarding, alighting) = flows[service_index][stop_index];
            onboard = onboard
                .checked_add(boarding)
                .and_then(|count| count.checked_sub(alighting))
                .ok_or_else(|| DemandError("flow_conservation_failed".into()))?;
            result.stop_flows.push(StopPassengerFlowV1 {
                world_id: input.world_id.clone(),
                train_run_id: train.train_run_id.clone(),
                stop_id: stop.stop_id.clone(),
                boarding,
                alighting,
                onboard_after: onboard,
            });
            if stop_index + 1 == train.stops.len() {
                ensure(onboard == 0, "terminal_not_empty")?;
                continue;
            }
            let state = &mut usage[service_index][stop_index];
            let seated =
                u32::try_from(state.standard.len() + state.premium.len()).expect("bounded seats");
            ensure(
                seated + state.standing == onboard,
                "allocation_conservation_failed",
            )?;
            let segment_id = segment_id(train, stop_index);
            result.allocations.push(CapacityAllocationV1 {
                world_id: input.world_id.clone(),
                train_run_id: train.train_run_id.clone(),
                segment_id: segment_id.clone(),
                from_stop_id: stop.stop_id.clone(),
                to_stop_id: train.stops[stop_index + 1].stop_id.clone(),
                operator_id: train.operator_id.clone(),
                mode: train.mode,
                passengers: onboard,
                seated,
                standing: state.standing,
                reserved: state.reserved,
                wheelchair: state.wheelchair,
                bicycle: state.bicycle,
                stroller: state.stroller,
                capacity: train.capacity.standard_seats
                    + train.capacity.standard_standing
                    + train.capacity.premium_seats,
                forecast_revenue_cents: state.revenue,
            });
            if train.mode == RailModeV1::Spnv {
                state
                    .passengers
                    .sort_by(|a, b| a.passenger_key.cmp(&b.passenger_key));
                ensure(
                    state.passengers.len()
                        == usize::try_from(onboard).expect("bounded passenger count"),
                    "manifest_conservation_failed",
                )?;
                result.manifests.push(PassengerManifestV1 {
                    schema_version: "passenger-manifest/v1".into(),
                    world_id: input.world_id.clone(),
                    demand_release_id: input.release.id.clone(),
                    train_run_id: train.train_run_id.clone(),
                    segment_id,
                    revision: input.revision,
                    passengers: std::mem::take(&mut state.passengers),
                });
            }
        }
    }
    result.choices.sort_by(|a, b| {
        a.cohort_id
            .cmp(&b.cohort_id)
            .then_with(|| a.ordinal_start.cmp(&b.ordinal_start))
    });
    result
        .unserved
        .sort_by(|a, b| a.cohort_id.cmp(&b.cohort_id));
    result.journey_seats.sort_by(|a, b| {
        (&a.cohort_id, a.ordinal, &a.train_run_id, &a.segment_id).cmp(&(
            &b.cohort_id,
            b.ordinal,
            &b.train_run_id,
            &b.segment_id,
        ))
    });
    ensure(
        result.totals.generated
            == result.totals.rail + result.totals.alternative + result.totals.unserved,
        "demand_conservation_failed",
    )?;
    result.state_hash = Sha256::digest(serde_json::to_vec(&result)?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(result)
}

/// Schmale JSON-Grenze für den napi-rs-Adapter; keine Laufzeitabhängigkeiten.
pub fn evaluate_demand_json(json: &str) -> Result<String, DemandError> {
    ensure(json.len() <= 16 * 1024 * 1024, "demand_input_size_limit")?;
    let input: DemandEvaluationInputV1 = serde_json::from_str(json)?;
    Ok(serde_json::to_string(&evaluate_demand(&input)?)?)
}
