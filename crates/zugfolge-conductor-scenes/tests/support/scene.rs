//! Explicit fictional source data; snapshots are produced by the actual operational engine.
#![allow(dead_code)]
use std::collections::BTreeSet;
use zugfolge_conductor_scenes::*;
use zugfolge_sim::operational::{OperationalWorld, ProjectionKind};

pub fn release() -> ConductorSceneReleaseV1 {
    ConductorSceneReleaseV1 {
        schema_version: "conductor-scene-release/v1".into(),
        release_id: "scene:explicit-test-fixture".into(),
        infra_release_id: "infra:operational:v2".into(),
        infra_release_hash: "a".repeat(64),
        policy_id: "conductor-scenes/v1".into(),
        coverage: SceneCoverage::TestFixture,
        sources: vec![SceneSourceV1 {
            source_id: "fixture:stations".into(),
            source_sha256: "b".repeat(64),
            rights_evidence_sha256: "c".repeat(64),
            provenance: SceneProvenance::Observed,
        }],
        stations: [
            (
                "a",
                "Kleiner Prüfhaltepunkt Ährenfeld",
                Some(7),
                SceneStationKind::Halt,
            ),
            (
                "b",
                "Mittlerer Prüfstadtbahnhof mit sehr langem Namen",
                None,
                SceneStationKind::Station,
            ),
            (
                "c",
                "Großer Prüfstadt-Hauptbahnhof Süd",
                Some(1),
                SceneStationKind::Station,
            ),
        ]
        .into_iter()
        .map(|(id, name, category, kind)| SceneStationV1 {
            operating_point_id: format!("station:{id}"),
            name: name.into(),
            kind,
            category,
            category_source_id: category.map(|_| "fixture:stations".into()),
            platform_count: 2,
            daily_calls: Some(120),
            source_ids: vec!["fixture:stations".into()],
        })
        .collect(),
        routes: vec![SceneRouteV1 {
            route_version_id: "route:v1".into(),
            length_mm: 120_000,
            source_ids: vec!["fixture:stations".into()],
            urbanity: vec![
                SceneUrbanityPointV1 {
                    route_mm: 0,
                    urbanity_basis_points: 0,
                },
                SceneUrbanityPointV1 {
                    route_mm: 120_000,
                    urbanity_basis_points: 10_000,
                },
            ],
            stations: [
                ("a", 0, 20_000),
                ("b", 25_000, 45_000),
                ("c", 100_000, 120_000),
            ]
            .into_iter()
            .map(|(id, from, to)| SceneRouteStationV1 {
                operating_point_id: format!("station:{id}"),
                platform_id: format!("platform:{id}"),
                platform_label: Some("1 Süd".into()),
                from_route_mm: from,
                to_route_mm: to,
            })
            .collect(),
            signals: vec![SceneRouteSignalV1 {
                signal_id: "signal:stop:2".into(),
                route_mm: 30_000,
            }],
        }],
        calendar: SceneCalendarV1 {
            epoch_utc_time_of_day_ms: 18_000_000,
            offsets: vec![SceneCalendarOffsetV1 {
                from_ms: 0,
                until_ms: 86_400_000,
                utc_offset_minutes: 60,
            }],
        },
    }
}

pub fn input(
    world: &OperationalWorld,
    release: &ConductorSceneReleaseV1,
) -> ProjectConductorSceneInputV1 {
    let operational = world
        .project(ProjectionKind::LiveMap, &BTreeSet::new())
        .unwrap();
    ProjectConductorSceneInputV1 {
        schema_version: "conductor-scene-input/v1".into(),
        binding: ConductorSceneBindingV1 {
            world_id: world.world_id.clone(),
            period_id: "period:fixture".into(),
            operator_id: "operator:1".into(),
            train_run_id: "train:stops".into(),
            region_id: world.region_id.clone(),
            infra_release_id: world.infra_release_id.clone(),
            infra_release_hash: release.infra_release_hash.clone(),
            scene_release_hash: hash_scene_release(release).unwrap(),
            art_release_id: "art:fixture".into(),
            art_manifest_hash: "d".repeat(64),
            operational_state_hash: world.state_hash().to_string(),
            commit_sequence: world.commit_sequence,
            valid_from_ms: 0,
            valid_until_ms: 86_400_000,
        },
        scene_release: release.clone(),
        sample_at_ms: world.now_ms,
        operational,
    }
}
