use sha2::{Digest, Sha256};
use zugfolge_sim::operational::{ProjectedMotionState, SignalAspect};

use crate::*;

fn bounded_u16(value: i128) -> Result<u16, ConductorSceneIssueV1> {
    u16::try_from(value).map_err(|_| issue("scene_integer_out_of_range"))
}

fn environment(
    route: &SceneRouteV1,
    route_mm: i64,
) -> Result<SceneEnvironmentV1, ConductorSceneIssueV1> {
    let pair = route
        .urbanity
        .windows(2)
        .find(|p| route_mm >= p[0].route_mm && route_mm <= p[1].route_mm)
        .ok_or_else(|| issue("scene_position_outside_route"))?;
    let delta =
        i128::from(pair[1].urbanity_basis_points) - i128::from(pair[0].urbanity_basis_points);
    let u = i128::from(pair[0].urbanity_basis_points)
        + delta * i128::from(route_mm - pair[0].route_mm)
            / i128::from(pair[1].route_mm - pair[0].route_mm);
    let rural = (10_000 - 2 * u).max(0);
    let urban = (2 * u - 10_000).max(0);
    Ok(SceneEnvironmentV1 {
        urbanity_basis_points: bounded_u16(u)?,
        rural_basis_points: bounded_u16(rural)?,
        suburban_basis_points: bounded_u16(10_000 - rural - urban)?,
        urban_basis_points: bounded_u16(urban)?,
        scroll_mm: route_mm,
        provenance: SceneProvenance::Derived,
        asset_ids: ["rural", "suburban", "urban"]
            .into_iter()
            .flat_map(|family| {
                ["vegetation", "road", "building"]
                    .into_iter()
                    .map(move |part| format!("environment.{family}.{part}"))
            })
            .collect(),
    })
}

fn lighting(
    calendar: &SceneCalendarV1,
    at_ms: i64,
) -> Result<SceneLightingV1, ConductorSceneIssueV1> {
    let offset = calendar
        .offsets
        .iter()
        .find(|o| at_ms >= o.from_ms && at_ms < o.until_ms)
        .ok_or_else(|| issue("scene_calendar_coverage_missing"))?;
    let local = (i128::from(calendar.epoch_utc_time_of_day_ms)
        + i128::from(at_ms)
        + i128::from(offset.utc_offset_minutes) * 60_000)
        .rem_euclid(86_400_000);
    let (phase, daylight) = match local {
        0..21_600_000 => (SceneLightPhase::Night, 2_500),
        21_600_000..28_800_000 => (
            SceneLightPhase::Dawn,
            2_500 + (local - 21_600_000) * 7_500 / 7_200_000,
        ),
        28_800_000..64_800_000 => (SceneLightPhase::Day, 10_000),
        64_800_000..72_000_000 => (
            SceneLightPhase::Dusk,
            10_000 - (local - 64_800_000) * 7_500 / 7_200_000,
        ),
        _ => (SceneLightPhase::Night, 2_500),
    };
    Ok(SceneLightingV1 {
        policy_id: "conductor-scene-lighting/v1".to_owned(),
        local_time_of_day_ms: u32::try_from(local)
            .map_err(|_| issue("scene_integer_out_of_range"))?,
        phase,
        daylight_basis_points: bounded_u16(daylight)?,
        window_light_basis_points: bounded_u16(10_000 - daylight)?,
    })
}

fn station(
    release: &ConductorSceneReleaseV1,
    route: &SceneRouteV1,
    route_mm: i64,
) -> Result<Option<StationSceneV1>, ConductorSceneIssueV1> {
    let nearby = route
        .stations
        .iter()
        .map(|s| {
            let distance = if route_mm < s.from_route_mm {
                s.from_route_mm - route_mm
            } else {
                (route_mm - s.to_route_mm).max(0)
            };
            (distance, &s.operating_point_id, &s.platform_id, s)
        })
        .filter(|(distance, ..)| *distance < 100_000)
        .min_by(|a, b| (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2)));
    let Some((distance, _, _, reference)) = nearby else {
        return Ok(None);
    };
    let source = release
        .stations
        .iter()
        .find(|s| s.operating_point_id == reference.operating_point_id)
        .ok_or_else(|| issue("scene_station_missing"))?;
    let (size, provenance, policy) = match source.category {
        Some(1..=2) => (
            StationSceneSize::Large,
            SceneProvenance::Observed,
            "station-category/v1",
        ),
        Some(3..=5) => (
            StationSceneSize::Medium,
            SceneProvenance::Observed,
            "station-category/v1",
        ),
        Some(6..=7) => (
            StationSceneSize::Small,
            SceneProvenance::Observed,
            "station-category/v1",
        ),
        None => {
            let calls = source
                .daily_calls
                .ok_or_else(|| issue("scene_station_classification_incomplete"))?;
            let size = if source.platform_count >= 8 || calls >= 300 {
                StationSceneSize::Large
            } else if source.kind == SceneStationKind::Halt
                && source.platform_count <= 2
                && calls <= 96
            {
                StationSceneSize::Small
            } else {
                StationSceneSize::Medium
            };
            (
                size,
                SceneProvenance::Derived,
                "conductor-station-derived/v1",
            )
        }
        _ => return Err(issue("scene_station_category_unverified")),
    };
    let family = match size {
        StationSceneSize::Small => "small",
        StationSceneSize::Medium => "medium",
        StationSceneSize::Large => "large",
    };
    let mut variant = Sha256::new();
    variant.update(b"conductor-station-variant/v1\0");
    variant.update(release.release_id.as_bytes());
    variant.update(b"\0");
    variant.update(source.operating_point_id.as_bytes());
    Ok(Some(StationSceneV1 {
        schema_version: "station-scene/v1".to_owned(),
        operating_point_id: source.operating_point_id.clone(),
        name: source.name.clone(),
        platform_id: reference.platform_id.clone(),
        platform_label: reference.platform_label.clone(),
        size,
        category: source.category,
        classification_provenance: provenance,
        classification_policy_id: policy.to_owned(),
        variant: variant.finalize()[0] % 4,
        visibility_basis_points: bounded_u16(i128::from(100_000 - distance) / 10)?,
        at_platform: distance == 0,
        asset_ids: ["platform", "roof", "hall", "stairs", "underpass"]
            .into_iter()
            .map(|part| format!("station.{family}.{part}"))
            .collect(),
    }))
}

/// Projiziert nur belegte Positionen; rechnet kein eigenes Betriebsmodell.
pub fn project_conductor_scene(
    input: &ProjectConductorSceneInputV1,
) -> Result<SceneProjectionV1, ConductorSceneIssueV1> {
    let binding = &input.binding;
    let operational = &input.operational;
    let release = &input.scene_release;
    if input.schema_version != "conductor-scene-input/v1" {
        return Err(issue("scene_input_schema_invalid"));
    }
    if [
        &binding.world_id,
        &binding.period_id,
        &binding.operator_id,
        &binding.train_run_id,
        &binding.region_id,
        &binding.infra_release_id,
        &binding.art_release_id,
    ]
    .iter()
    .any(|s| !identifier(s))
        || [
            &binding.infra_release_hash,
            &binding.scene_release_hash,
            &binding.art_manifest_hash,
            &binding.operational_state_hash,
        ]
        .iter()
        .any(|s| !hash(s))
        || binding.commit_sequence > u64::try_from(MAX_SAFE_INTEGER).unwrap_or_default()
    {
        return Err(issue("scene_binding_invalid"));
    }
    if binding.world_id != operational.world_id
        || binding.region_id != operational.region_id
        || binding.infra_release_id != operational.infra_release_id
        || binding.commit_sequence != operational.commit_sequence
        || binding.infra_release_id != release.infra_release_id
        || binding.infra_release_hash != release.infra_release_hash
    {
        return Err(issue("scene_binding_mismatch"));
    }
    if binding.scene_release_hash != hash_scene_release(release)? {
        return Err(issue("scene_release_hash_mismatch"));
    }
    if binding.valid_from_ms < 0
        || binding.valid_until_ms > MAX_SAFE_INTEGER
        || binding.valid_from_ms >= binding.valid_until_ms
        || operational.at_ms < binding.valid_from_ms
        || operational.at_ms >= binding.valid_until_ms
        || operational.stale_after_ms < operational.at_ms
        || operational.stale_after_ms > MAX_SAFE_INTEGER
        || input.sample_at_ms < operational.at_ms
        || input.sample_at_ms > operational.stale_after_ms
        || input.sample_at_ms >= binding.valid_until_ms
    {
        return Err(issue("scene_time_outside_evidence"));
    }
    if release
        .calendar
        .offsets
        .first()
        .is_none_or(|o| o.from_ms > binding.valid_from_ms)
        || release
            .calendar
            .offsets
            .last()
            .is_none_or(|o| o.until_ms < binding.valid_until_ms)
    {
        return Err(issue("scene_calendar_coverage_missing"));
    }
    let mut trains = operational
        .trains
        .iter()
        .filter(|t| t.train_id == binding.train_run_id);
    let train = trains.next().ok_or_else(|| issue("scene_train_missing"))?;
    if trains.next().is_some() || train.operator_id != binding.operator_id {
        return Err(issue("scene_train_binding_mismatch"));
    }
    let route = release
        .routes
        .iter()
        .find(|r| r.route_version_id == train.route_version_id)
        .ok_or_else(|| issue("scene_route_coverage_missing"))?;
    let (route_mm, speed_mmps) = if let Some(segment) = &train.motion_segment {
        if train.motion_state != ProjectedMotionState::Moving
            || segment.route_version_id != train.route_version_id
            || segment.start_route_mm != train.head_route_mm
            || segment.start_speed_mmps != train.speed_mmps
            || operational.at_ms < segment.started_at_ms
            || train.authority_end_route_mm != Some(segment.authority_end_route_mm)
            || input.sample_at_ms > segment.valid_until_ms
        {
            return Err(issue("scene_motion_evidence_invalid"));
        }
        (
            segment
                .position_at(input.sample_at_ms)
                .map_err(|_| issue("scene_motion_evidence_invalid"))?,
            segment
                .speed_at(input.sample_at_ms)
                .map_err(|_| issue("scene_motion_evidence_invalid"))?,
        )
    } else {
        if train.speed_mmps != 0 || train.motion_state == ProjectedMotionState::Moving {
            return Err(issue("scene_motion_evidence_missing"));
        }
        (train.head_route_mm, 0)
    };
    if route_mm < 0 || route_mm > route.length_mm {
        return Err(issue("scene_position_outside_route"));
    }
    let mut signals = Vec::new();
    for reference in &route.signals {
        let distance = reference.route_mm - route_mm;
        if !(0..=200_000).contains(&distance) {
            continue;
        }
        // OperationalWorld stores only deviations from the release-known Stop default.
        let aspect = operational
            .signals
            .get(&reference.signal_id)
            .copied()
            .unwrap_or(SignalAspect::Stop);
        let asset_id = match aspect {
            SignalAspect::Stop => Some("signal.stop".to_owned()),
            SignalAspect::Proceed => Some("signal.proceed".to_owned()),
            SignalAspect::Failed | SignalAspect::ShuntingProceed => None,
        };
        signals.push(SceneSignalV1 {
            signal_id: reference.signal_id.clone(),
            distance_mm: distance,
            aspect,
            asset_id,
        });
    }
    signals.sort_by(|a, b| (a.distance_mm, &a.signal_id).cmp(&(b.distance_mm, &b.signal_id)));
    let mut output = SceneProjectionV1 {
        schema_version: "conductor-scene-projection/v1".to_owned(),
        binding: binding.clone(),
        at_ms: input.sample_at_ms,
        route_version_id: route.route_version_id.clone(),
        route_mm,
        speed_mmps,
        motion_state: train.motion_state,
        waiting_reason: train.waiting_reason.clone(),
        environment: environment(route, route_mm)?,
        lighting: lighting(&release.calendar, input.sample_at_ms)?,
        station: station(release, route, route_mm)?,
        signals,
        visual_only: true,
        state_hash: String::new(),
    };
    output.state_hash = digest(&output)?;
    Ok(output)
}

/// Strikter JSON-Eingang; Fehlermeldungen enthalten niemals Originaleingaben.
pub fn project_conductor_scene_json(input: &str) -> Result<String, ConductorSceneIssueV1> {
    if input.len() > 64 * 1024 * 1024 {
        return Err(issue("scene_input_too_large"));
    }
    let input = serde_json::from_str(input).map_err(|_| issue("scene_input_json_invalid"))?;
    let projection = project_conductor_scene(&input)?;
    serde_json::to_string(&projection).map_err(|_| issue("scene_serialization_failed"))
}
