use std::collections::{BTreeMap, BTreeSet};

use zugfolge_sim::operational::{Direction, OperationalInfraRelease};

use crate::*;

fn canonical(release: &ConductorSceneReleaseV1) -> ConductorSceneReleaseV1 {
    let mut result = release.clone();
    result.sources.sort_by(|a, b| a.source_id.cmp(&b.source_id));
    result
        .stations
        .sort_by(|a, b| a.operating_point_id.cmp(&b.operating_point_id));
    result
        .routes
        .sort_by(|a, b| a.route_version_id.cmp(&b.route_version_id));
    for station in &mut result.stations {
        station.source_ids.sort();
    }
    for route in &mut result.routes {
        route.source_ids.sort();
        route.stations.sort_by(|a, b| {
            (&a.operating_point_id, &a.platform_id).cmp(&(&b.operating_point_id, &b.platform_id))
        });
        route.signals.sort_by(|a, b| a.signal_id.cmp(&b.signal_id));
    }
    result
}

/// SHA-256 der typisierten, kanonisch geordneten Szenenrelease-Bytes.
pub fn hash_scene_release(
    release: &ConductorSceneReleaseV1,
) -> Result<String, ConductorSceneIssueV1> {
    validate_scene_release(release)?;
    digest(&canonical(release))
}

/// Prüft vollständige Sichtdaten; erteilt keine Quellen-/Rechtefreigabe.
pub fn validate_scene_release(
    release: &ConductorSceneReleaseV1,
) -> Result<(), ConductorSceneIssueV1> {
    if release.schema_version != "conductor-scene-release/v1"
        || release.policy_id != "conductor-scenes/v1"
        || !identifier(&release.release_id)
        || !identifier(&release.infra_release_id)
        || !hash(&release.infra_release_hash)
    {
        return Err(issue("scene_release_invalid"));
    }
    if release.sources.is_empty()
        || release.sources.len() > 10_000
        || release.routes.is_empty()
        || release.routes.len() > 1_000_000
        || release.stations.len() > 1_000_000
    {
        return Err(issue("scene_release_bounds"));
    }
    let mut sources = BTreeMap::new();
    for source in &release.sources {
        if !identifier(&source.source_id)
            || !hash(&source.source_sha256)
            || !hash(&source.rights_evidence_sha256)
            || sources
                .insert(&source.source_id, source.provenance)
                .is_some()
        {
            return Err(issue("scene_source_invalid"));
        }
    }
    let source_ids_valid = |ids: &[String]| {
        !ids.is_empty()
            && ids.len() <= sources.len()
            && ids.iter().collect::<BTreeSet<_>>().len() == ids.len()
            && ids.iter().all(|id| sources.contains_key(id))
    };
    let mut station_ids = BTreeSet::new();
    for station in &release.stations {
        if !identifier(&station.operating_point_id)
            || !identifier(&station.name)
            || station.name.trim().is_empty()
            || station.platform_count == 0
            || station.daily_calls.is_some_and(|calls| calls > 1_000_000)
            || !source_ids_valid(&station.source_ids)
            || !station_ids.insert(&station.operating_point_id)
        {
            return Err(issue("scene_station_invalid"));
        }
        match (&station.category, &station.category_source_id) {
            (Some(1..=7), Some(source))
                if station.source_ids.contains(source)
                    && sources.get(source) == Some(&SceneProvenance::Observed) => {}
            (None, None) if station.daily_calls.is_some() => {}
            _ => return Err(issue("scene_station_category_unverified")),
        }
    }
    let mut routes = BTreeSet::new();
    for route in &release.routes {
        if !identifier(&route.route_version_id)
            || !routes.insert(&route.route_version_id)
            || route.length_mm <= 0
            || route.length_mm > MAX_SAFE_INTEGER
            || !source_ids_valid(&route.source_ids)
            || route.urbanity.len() < 2
            || route.urbanity.len() > 1_000_000
            || route.stations.len() > 100_000
            || route.signals.len() > 100_000
        {
            return Err(issue("scene_route_invalid"));
        }
        if route.urbanity.first().map(|p| p.route_mm) != Some(0)
            || route.urbanity.last().map(|p| p.route_mm) != Some(route.length_mm)
            || route
                .urbanity
                .iter()
                .any(|p| p.urbanity_basis_points > 10_000)
            || route
                .urbanity
                .windows(2)
                .any(|p| p[0].route_mm >= p[1].route_mm)
        {
            return Err(issue("scene_urbanity_coverage_invalid"));
        }
        let mut local_stations = BTreeSet::new();
        for station in &route.stations {
            if !station_ids.contains(&station.operating_point_id)
                || !identifier(&station.platform_id)
                || station
                    .platform_label
                    .as_ref()
                    .is_some_and(|s| !identifier(s))
                || station.from_route_mm < 0
                || station.to_route_mm <= station.from_route_mm
                || station.to_route_mm > route.length_mm
                || !local_stations.insert((&station.operating_point_id, &station.platform_id))
            {
                return Err(issue("scene_route_station_invalid"));
            }
        }
        let mut signals = BTreeSet::new();
        for signal in &route.signals {
            if !identifier(&signal.signal_id)
                || signal.route_mm < 0
                || signal.route_mm > route.length_mm
                || !signals.insert(&signal.signal_id)
            {
                return Err(issue("scene_route_signal_invalid"));
            }
        }
    }
    let calendar = &release.calendar;
    if calendar.epoch_utc_time_of_day_ms >= 86_400_000
        || calendar.offsets.is_empty()
        || calendar.offsets.len() > 10_000
        || calendar.offsets.iter().any(|o| {
            o.from_ms < 0
                || o.until_ms > MAX_SAFE_INTEGER
                || o.from_ms >= o.until_ms
                || !(-840..=840).contains(&o.utc_offset_minutes)
        })
        || calendar
            .offsets
            .windows(2)
            .any(|o| o[0].until_ms != o[1].from_ms)
    {
        return Err(issue("scene_calendar_invalid"));
    }
    Ok(())
}

/// Prüft Szenenreferenzen gegen den tatsächlichen unveränderten InfraRelease.
/// Der Aufrufer prüft dessen unabhängigen Datei-/Deploymenthash und Freigabe.
pub fn validate_scene_release_infrastructure(
    release: &ConductorSceneReleaseV1,
    infrastructure: &OperationalInfraRelease,
) -> Result<(), ConductorSceneIssueV1> {
    validate_scene_release(release)?;
    infrastructure
        .validate()
        .map_err(|_| issue("scene_infrastructure_invalid"))?;
    if release.infra_release_id != infrastructure.id {
        return Err(issue("scene_infrastructure_binding_mismatch"));
    }
    for scene_route in &release.routes {
        let route = infrastructure
            .route_versions
            .get(&scene_route.route_version_id)
            .ok_or_else(|| issue("scene_route_missing_in_infrastructure"))?;
        if route.length_mm() != scene_route.length_mm {
            return Err(issue("scene_route_length_mismatch"));
        }
        for station in &scene_route.stations {
            let platform = infrastructure
                .platform_intervals
                .get(&station.platform_id)
                .ok_or_else(|| issue("scene_platform_missing_in_infrastructure"))?;
            let mut intervals = Vec::new();
            for leg in &route.legs {
                if leg.edge_id != platform.edge_id || leg.direction != platform.direction {
                    continue;
                }
                let low = leg.edge_entry_mm.min(leg.edge_exit_mm);
                let high = leg.edge_entry_mm.max(leg.edge_exit_mm);
                let from = platform.from_mm.max(low);
                let to = platform.to_mm.min(high);
                if from >= to {
                    continue;
                }
                let (start, end) = match leg.direction {
                    Direction::Along => (from - leg.edge_entry_mm, to - leg.edge_entry_mm),
                    Direction::Against => (leg.edge_entry_mm - to, leg.edge_entry_mm - from),
                };
                let interval = (
                    leg.route_start_mm
                        .checked_add(start)
                        .ok_or_else(|| issue("scene_integer_out_of_range"))?,
                    leg.route_start_mm
                        .checked_add(end)
                        .ok_or_else(|| issue("scene_integer_out_of_range"))?,
                );
                if let Some(last) = intervals
                    .last_mut()
                    .filter(|last: &&mut (i64, i64)| last.1 == interval.0)
                {
                    last.1 = interval.1;
                } else {
                    intervals.push(interval);
                }
            }
            let found = intervals.contains(&(station.from_route_mm, station.to_route_mm))
                && station.to_route_mm - station.from_route_mm == platform.to_mm - platform.from_mm;
            if !found {
                return Err(issue("scene_platform_geometry_mismatch"));
            }
        }
        for signal in &scene_route.signals {
            if !infrastructure.signals.contains(&signal.signal_id)
                || !infrastructure.interlocking_routes.values().any(|locking| {
                    locking.route_template_id == route.template_id
                        && locking.signal_id == signal.signal_id
                        && locking.authority_start_route_mm == signal.route_mm
                })
            {
                return Err(issue("scene_signal_geometry_mismatch"));
            }
        }
    }
    Ok(())
}
