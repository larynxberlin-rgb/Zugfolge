use std::collections::{BTreeMap, BTreeSet};

use crate::{
    DemandError, DemandEvaluationInputV1, DemandPopulationRevisionV1, DemandReleaseV1,
    POPULATION_MODEL_SCHEMA, POPULATION_REVISION_SCHEMA, Provenance, StationDemandClass,
    StationPopulationDemandV1, ensure,
};

const CLASS_THRESHOLDS: [u32; 10] = [
    1, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000,
];
const MAX_SETTLEMENTS: usize = 20_000;
const MAX_ALLOCATIONS: usize = 40_000;
const MAX_PREFERENCES: usize = 200 * 199;

/// Veröffentlichte Größenklasse des Einwohnerbudgets, ohne zusätzlichen Nachfragefaktor.
pub fn station_demand_class(population: u32) -> StationDemandClass {
    u8::try_from(CLASS_THRESHOLDS.partition_point(|threshold| *threshold <= population))
        .expect("ten classes")
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn date_ordinal(value: &str) -> Option<u32> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return None;
    }
    let year: u32 = value[..4].parse().ok()?;
    let month: usize = value[5..7].parse().ok()?;
    let day: u32 = value[8..].parse().ok()?;
    if year == 0 || !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day == 0 || day > month_days[month - 1] {
        return None;
    }
    let previous_year = year - 1;
    Some(
        previous_year * 365 + previous_year / 4 - previous_year / 100
            + previous_year / 400
            + month_days[..month - 1].iter().sum::<u32>()
            + day,
    )
}

pub(crate) fn validate_population_model(release: &DemandReleaseV1) -> Result<(), DemandError> {
    let Some(model) = &release.population_model else {
        return Ok(());
    };
    ensure(
        model.schema_version == POPULATION_MODEL_SCHEMA
            && release.provenance == Provenance::Balanced,
        "invalid_population_model",
    )?;
    ensure(
        (1..=MAX_SETTLEMENTS).contains(&model.settlements.len())
            && model.station_areas.len() == release.zones.len()
            && model.destination_preferences.len() <= MAX_PREFERENCES,
        "population_model_size_limit",
    )?;
    let source_ids: BTreeSet<_> = release
        .sources
        .iter()
        .map(|source| source.id.as_str())
        .collect();
    let reference = &model.reference_timetable;
    ensure(
        identifier(&reference.id)
            && reference.artifact_sha256.len() == 64
            && reference
                .artifact_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            && !reference.source_ids.is_empty()
            && reference.source_ids.len() <= release.sources.len()
            && reference
                .source_ids
                .iter()
                .all(|source| source_ids.contains(source.as_str()))
            && reference.source_ids.iter().collect::<BTreeSet<_>>().len()
                == reference.source_ids.len(),
        "invalid_population_reference_timetable",
    )?;
    ensure(
        reference.service_dates.len() == 7,
        "invalid_population_service_dates",
    )?;
    let mut dates = reference
        .service_dates
        .iter()
        .map(|date| date_ordinal(date))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| DemandError("invalid_population_service_dates".into()))?;
    dates.sort_unstable();
    ensure(
        dates.windows(2).all(|pair| pair[1] == pair[0] + 1),
        "invalid_population_service_dates",
    )?;

    let mut settlements = BTreeMap::new();
    for settlement in &model.settlements {
        ensure(
            identifier(&settlement.id)
                && !settlement.name.trim().is_empty()
                && settlement.name.len() <= 256
                && !settlement.name.chars().any(char::is_control)
                && source_ids.contains(settlement.source_id.as_str())
                && settlements
                    .insert(settlement.id.as_str(), settlement.population)
                    .is_none(),
            "invalid_population_settlement",
        )?;
    }
    let zones: BTreeMap<_, _> = release
        .zones
        .iter()
        .map(|zone| (zone.id.as_str(), zone))
        .collect();
    let mut seen_zones = BTreeSet::new();
    let mut seen_stations = BTreeSet::new();
    let mut allocated = BTreeMap::<&str, u64>::new();
    let mut allocation_count = 0_usize;
    for area in &model.station_areas {
        let zone = zones
            .get(area.zone_id.as_str())
            .ok_or_else(|| DemandError("unknown_population_zone".into()))?;
        ensure(
            seen_zones.insert(area.zone_id.as_str())
                && seen_stations.insert(area.station_id.as_str())
                && zone.stations.len() == 1
                && zone.stations[0].station_id == area.station_id,
            "invalid_population_station_area",
        )?;
        allocation_count = allocation_count
            .checked_add(area.population_allocations.len())
            .ok_or_else(|| DemandError("population_model_size_limit".into()))?;
        ensure(
            allocation_count <= MAX_ALLOCATIONS,
            "population_model_size_limit",
        )?;
        let mut seen_settlements = BTreeSet::new();
        let mut area_population = 0_u64;
        for allocation in &area.population_allocations {
            ensure(
                settlements.contains_key(allocation.settlement_id.as_str())
                    && seen_settlements.insert(allocation.settlement_id.as_str()),
                "invalid_station_population_allocation",
            )?;
            area_population += u64::from(allocation.population);
            *allocated
                .entry(allocation.settlement_id.as_str())
                .or_default() += u64::from(allocation.population);
        }
        ensure(
            area_population == u64::from(zone.population),
            "station_population_mismatch",
        )?;
        ensure(
            area.demand_class == station_demand_class(zone.population),
            "station_demand_class_mismatch",
        )?;
    }
    ensure(
        settlements.iter().all(|(id, population)| {
            allocated.get(id).copied().unwrap_or(0) == u64::from(*population)
        }),
        "settlement_population_not_conserved",
    )?;
    let mut relations = BTreeSet::new();
    for preference in &model.destination_preferences {
        ensure(
            preference.origin_zone_id != preference.destination_zone_id
                && zones.contains_key(preference.origin_zone_id.as_str())
                && zones.contains_key(preference.destination_zone_id.as_str())
                && preference.reference_connections > 0
                && relations.insert((
                    preference.origin_zone_id.as_str(),
                    preference.destination_zone_id.as_str(),
                )),
            "invalid_population_destination_preference",
        )?;
    }
    Ok(())
}

pub(crate) fn canonicalize_population_model(release: &mut DemandReleaseV1) {
    let Some(model) = &mut release.population_model else {
        return;
    };
    canonicalize_model(model);
}

fn canonicalize_model(model: &mut StationPopulationDemandV1) {
    model.settlements.sort_by(|a, b| a.id.cmp(&b.id));
    model
        .station_areas
        .sort_by(|a, b| a.zone_id.cmp(&b.zone_id));
    for area in &mut model.station_areas {
        area.population_allocations
            .sort_by(|a, b| a.settlement_id.cmp(&b.settlement_id));
    }
    model.reference_timetable.source_ids.sort();
    model.reference_timetable.service_dates.sort();
    model.destination_preferences.sort_by(|a, b| {
        (&a.origin_zone_id, &a.destination_zone_id)
            .cmp(&(&b.origin_zone_id, &b.destination_zone_id))
    });
}

pub(crate) fn canonicalize_population_revision(revision: &mut DemandPopulationRevisionV1) {
    canonicalize_model(&mut revision.population_model);
    revision
        .zone_populations
        .sort_by(|a, b| a.zone_id.cmp(&b.zone_id));
}

pub(crate) fn release_with_population_revision(
    input: &DemandEvaluationInputV1,
) -> Result<DemandReleaseV1, DemandError> {
    let mut release = input.release.clone();
    let Some(revision) = &input.population_revision else {
        return Ok(release);
    };
    ensure(
        revision.schema_version == POPULATION_REVISION_SCHEMA
            && revision.world_id == input.world_id
            && (1..=9_007_199_254_740_991).contains(&revision.revision)
            && (0..=input.now_ms).contains(&revision.effective_at_ms),
        "invalid_population_revision",
    )?;
    let mut before = release
        .population_model
        .clone()
        .ok_or_else(|| DemandError("population_revision_requires_base_model".into()))?;
    ensure(
        revision.population_model.settlements.len() == before.settlements.len()
            && revision.population_model.station_areas.len() == before.station_areas.len()
            && revision.population_model.destination_preferences.len() <= MAX_PREFERENCES
            && revision
                .population_model
                .station_areas
                .iter()
                .map(|area| area.population_allocations.len())
                .sum::<usize>()
                <= MAX_ALLOCATIONS,
        "population_model_size_limit",
    )?;
    let mut next = revision.population_model.clone();
    canonicalize_model(&mut before);
    canonicalize_model(&mut next);
    ensure(
        before.schema_version == next.schema_version
            && before.reference_timetable == next.reference_timetable
            && before.settlements.len() == next.settlements.len()
            && before
                .settlements
                .iter()
                .zip(&next.settlements)
                .all(|(left, right)| {
                    left.id == right.id
                        && left.name == right.name
                        && left.source_id == right.source_id
                })
            && before.station_areas.len() == next.station_areas.len()
            && before
                .station_areas
                .iter()
                .zip(&next.station_areas)
                .all(|(left, right)| {
                    left.zone_id == right.zone_id && left.station_id == right.station_id
                }),
        "population_revision_changed_base_identity",
    )?;
    ensure(
        revision.zone_populations.len() == release.zones.len(),
        "population_revision_zone_binding_mismatch",
    )?;
    let mut seen = BTreeSet::new();
    for population in &revision.zone_populations {
        ensure(
            seen.insert(population.zone_id.as_str()),
            "population_revision_zone_binding_mismatch",
        )?;
        let zone = release
            .zones
            .iter_mut()
            .find(|zone| zone.id == population.zone_id)
            .ok_or_else(|| DemandError("population_revision_zone_binding_mismatch".into()))?;
        zone.population = population.population;
    }
    release.population_model = Some(next);
    validate_population_model(&release)?;
    Ok(release)
}
