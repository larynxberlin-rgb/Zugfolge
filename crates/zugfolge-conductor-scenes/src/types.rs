//! Versionierter Transportvertrag; Feldsemantik in docs/conductor-scenes.md.
#![allow(missing_docs)]

use serde::{Deserialize, Serialize};
use zugfolge_sim::operational::{OperationalProjection, ProjectedMotionState, SignalAspect};

macro_rules! dto {
    ($name:ident {$($field:ident : $kind:ty),* $(,)?}) => {
        #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $(pub $field: $kind),* }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SceneCoverage {
    TestFixture,
    ReleaseSubset,
    ReleaseComplete,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SceneProvenance {
    Observed,
    Derived,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SceneStationKind {
    Station,
    Halt,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StationSceneSize {
    Small,
    Medium,
    Large,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SceneLightPhase {
    Night,
    Dawn,
    Day,
    Dusk,
}

dto!(SceneSourceV1 {
    source_id: String,
    source_sha256: String,
    rights_evidence_sha256: String,
    provenance: SceneProvenance,
});
dto!(SceneStationV1 {
    operating_point_id: String,
    name: String,
    kind: SceneStationKind,
    category: Option<u8>,
    category_source_id: Option<String>,
    platform_count: u16,
    daily_calls: Option<u32>,
    source_ids: Vec<String>,
});
dto!(SceneUrbanityPointV1 {
    route_mm: i64,
    urbanity_basis_points: u16
});
dto!(SceneRouteStationV1 {
    operating_point_id: String,
    platform_id: String,
    platform_label: Option<String>,
    from_route_mm: i64,
    to_route_mm: i64,
});
dto!(SceneRouteSignalV1 {
    signal_id: String,
    route_mm: i64
});
dto!(SceneRouteV1 {
    route_version_id: String,
    length_mm: i64,
    source_ids: Vec<String>,
    urbanity: Vec<SceneUrbanityPointV1>,
    stations: Vec<SceneRouteStationV1>,
    signals: Vec<SceneRouteSignalV1>,
});
dto!(SceneCalendarOffsetV1 {
    from_ms: i64,
    until_ms: i64,
    utc_offset_minutes: i16
});
dto!(SceneCalendarV1 {
    epoch_utc_time_of_day_ms: u32,
    offsets: Vec<SceneCalendarOffsetV1>,
});
dto!(ConductorSceneReleaseV1 {
    schema_version: String,
    release_id: String,
    infra_release_id: String,
    infra_release_hash: String,
    policy_id: String,
    coverage: SceneCoverage,
    sources: Vec<SceneSourceV1>,
    stations: Vec<SceneStationV1>,
    routes: Vec<SceneRouteV1>,
    calendar: SceneCalendarV1,
});
dto!(ConductorSceneBindingV1 {
    world_id: String,
    period_id: String,
    operator_id: String,
    train_run_id: String,
    region_id: String,
    infra_release_id: String,
    infra_release_hash: String,
    scene_release_hash: String,
    art_release_id: String,
    art_manifest_hash: String,
    operational_state_hash: String,
    commit_sequence: u64,
    valid_from_ms: i64,
    valid_until_ms: i64,
});
dto!(ProjectConductorSceneInputV1 {
    schema_version: String,
    binding: ConductorSceneBindingV1,
    scene_release: ConductorSceneReleaseV1,
    operational: OperationalProjection,
    sample_at_ms: i64,
});
dto!(SceneEnvironmentV1 {
    urbanity_basis_points: u16,
    rural_basis_points: u16,
    suburban_basis_points: u16,
    urban_basis_points: u16,
    scroll_mm: i64,
    provenance: SceneProvenance,
    asset_ids: Vec<String>,
});
dto!(SceneLightingV1 {
    policy_id: String,
    local_time_of_day_ms: u32,
    phase: SceneLightPhase,
    daylight_basis_points: u16,
    window_light_basis_points: u16,
});
dto!(StationSceneV1 {
    schema_version: String,
    operating_point_id: String,
    name: String,
    platform_id: String,
    platform_label: Option<String>,
    size: StationSceneSize,
    category: Option<u8>,
    classification_provenance: SceneProvenance,
    classification_policy_id: String,
    variant: u8,
    visibility_basis_points: u16,
    at_platform: bool,
    asset_ids: Vec<String>,
});
dto!(SceneSignalV1 {
    signal_id: String,
    distance_mm: i64,
    aspect: SignalAspect,
    asset_id: Option<String>,
});
dto!(SceneProjectionV1 {
    schema_version: String,
    binding: ConductorSceneBindingV1,
    at_ms: i64,
    route_version_id: String,
    route_mm: i64,
    speed_mmps: u32,
    motion_state: ProjectedMotionState,
    waiting_reason: Option<String>,
    environment: SceneEnvironmentV1,
    lighting: SceneLightingV1,
    station: Option<StationSceneV1>,
    signals: Vec<SceneSignalV1>,
    visual_only: bool,
    state_hash: String,
});

/// Datensparsamer Fehler: keine Konten, Tokens, Quelldateipfade oder Eingabebytes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorSceneIssueV1 {
    pub code: String,
}

impl std::fmt::Display for ConductorSceneIssueV1 {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(&self.code)
    }
}
impl std::error::Error for ConductorSceneIssueV1 {}
