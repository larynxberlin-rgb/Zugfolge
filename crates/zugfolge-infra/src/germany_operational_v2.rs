//! Deterministischer Class-B-Ableiter fuer den Deutschland-Operational-v2-Korpus.
//!
//! Beobachtete OSM-Geometrie bleibt erhalten. Fehlende Stellwerksdetails werden
//! durch eine explizite, kapazitaetsmindernde Stellzonenregel geschlossen. Ohne
//! gepinnte, bereits auf Gleiskanten gematchte Zuglaeufe bleibt das Ergebnis
//! absichtlich nicht aktivierbar: lokale Kantenfahrwege sind nur ein belastbarer
//! Strukturkorpus und kein Ersatz fuer vollstaendige Zuglaeufe.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use redb::{
    Database, Durability, MultimapTableDefinition, ReadableMultimapTable, ReadableTable,
    ReadableTableMetadata, TableDefinition,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::validate_operational_infrastructure_v2_file;

const SPEC_SCHEMA: &str = "zugfolge-germany-operational-infrastructure-derivation/v2";
const MODE: &str = "deterministic-conservative-v1";
const POLICY_ID: &str = "synthetic-operational-b/v2";
const REPORT_SCHEMA: &str = "germany-operational-v2-derivation-report-v1";
const RECEIPT_SCHEMA: &str = "germany-operational-v2-derivation-receipt-v1";
const TURNAROUND_PREFLIGHT_SCHEMA: &str = "germany-operational-v2-turnaround-preflight-v1";
const MOVEMENT_ROUTE_SIDECAR_SCHEMA: &str = "movement-route-templates-v2";
const TRANSFER_DEMAND_SCHEMA: &str = "zugfolge-timetable-transfer-demands/v2";
const DAILY_CIRCULATION_PLAN_SCHEMA: &str = "zugfolge-daily-circulation-plan/v2";
const DAILY_CIRCULATION_PLAN_RULE: &str =
    "lot-local-playable-path-cover-with-explicit-physical-transition-partition/v2";
const MINIMUM_TURNAROUND_S: i64 = 300;
const SIMULATED_OPERATIONAL_BERTH_FALLBACK: &str =
    "real-osm-service-yard-then-spur-then-unclassified-rail/v1";
const MAX_TRANSFER_DEMAND_BYTES: u64 = 128 * 1024 * 1024;
const MAX_STABLING_PATH_EDGES_POLICY: u32 = 64;
const MAX_STABLING_PATH_LENGTH_MM_POLICY: i64 = 10_000_000;
const STANDARD_GAUGE_MM: i64 = 1_435;
const DATABASE_CACHE_BYTES: usize = 16 * 1024 * 1024;
const GENERATED_BATCH_BYTES: usize = 64 * 1024 * 1024;
const MAX_GENERATED_UNIT_BYTES: usize = 64 * 1024 * 1024;
const MAX_GENERATED_RECORD_BYTES: usize = 8 * 1024 * 1024;
const GENERATED_ENTRY_OVERHEAD_BYTES: usize = 128;
const MAX_STABLING_SEARCH_LABELS: usize = 250_000;
const MAX_STABLING_CANDIDATES_PER_CASE: usize = 4_096;
const MAX_STABLING_SEARCH_RESIDENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_GEOJSON_SEQUENCE_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_PLATFORM_SEARCH_CELLS: u128 = 1_000_000;
const MAX_TURNAROUND_PREFLIGHT_DEMANDS: usize = 100_000;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
static NEXT_SCRATCH_ID: AtomicU64 = AtomicU64::new(0);

const TRACKS: TableDefinition<&str, &str> = TableDefinition::new("tracks");
const NODES: TableDefinition<&str, ()> = TableDefinition::new("nodes");
const TRACKS_BY_NODE: MultimapTableDefinition<&str, &str> =
    MultimapTableDefinition::new("tracks_by_node");
const SPATIAL_TRACKS: MultimapTableDefinition<&str, &str> =
    MultimapTableDefinition::new("spatial_tracks");
const SWITCH_BY_NODE: TableDefinition<&str, &str> = TableDefinition::new("switch_by_node");
const SWITCHES: TableDefinition<&str, ()> = TableDefinition::new("switches");
const SIGNALS: TableDefinition<&str, ()> = TableDefinition::new("signals");
const BLOCKS_EVIDENCE: TableDefinition<&str, ()> = TableDefinition::new("blocks_evidence");
const BLOCK_RESOURCES: TableDefinition<&str, ()> = TableDefinition::new("block_resources");
const TRACK_BLOCKS: MultimapTableDefinition<&str, &str> =
    MultimapTableDefinition::new("track_blocks");
const PLATFORMS: TableDefinition<&str, &str> = TableDefinition::new("platforms");
const TIMETABLE_ROUTES: TableDefinition<&str, &str> = TableDefinition::new("timetable_routes");
const TIMETABLE_ROUTES_BY_START: MultimapTableDefinition<&str, &str> =
    MultimapTableDefinition::new("timetable_routes_by_start");
const TURNAROUND_ROUTES: TableDefinition<&str, &str> = TableDefinition::new("turnaround_routes");
const TURNAROUND_INTERLOCKING: TableDefinition<&str, &str> =
    TableDefinition::new("turnaround_interlocking");
const TURNAROUND_TEMPLATES: TableDefinition<&str, &str> =
    TableDefinition::new("turnaround_templates");
const DIRECT_TEMPLATES: TableDefinition<&str, &str> = TableDefinition::new("direct_templates");
const TRANSFER_ROUTES: TableDefinition<&str, &str> = TableDefinition::new("transfer_routes");
const TRANSFER_INTERLOCKING: TableDefinition<&str, &str> =
    TableDefinition::new("transfer_interlocking");
const TRANSFER_TEMPLATES: TableDefinition<&str, &str> = TableDefinition::new("transfer_templates");

/// Stabiler Fehler des Deutschland-Class-B-Ableiters.
#[derive(Debug)]
pub struct GermanyOperationalV2Error(String);

impl GermanyOperationalV2Error {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for GermanyOperationalV2Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for GermanyOperationalV2Error {}

type Result<T> = std::result::Result<T, GermanyOperationalV2Error>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DerivationSpec {
    schema: String,
    mode: String,
    infra_release_id: String,
    layers: LayerSpec,
    policy: PolicySpec,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LayerSpec {
    tracks: String,
    platforms: String,
    switches: String,
    signals: String,
    blocks: String,
    conflict_resources: String,
    timetable_routes: Option<String>,
    transfer_demands: Option<PinnedInputSpec>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PinnedInputSpec {
    path: String,
    expected_bytes: u64,
    expected_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicySpec {
    id: String,
    quality_class: String,
    source_id: String,
    derivation_rule: String,
    unknown_mainline_speed_kmh: u32,
    unknown_service_speed_kmh: u32,
    unknown_gradient_abs_permille: i16,
    minimum_platform_length_mm: i64,
    maximum_platform_snap_distance_mm: i64,
    minimum_overlap_mm: i64,
    minimum_berth_end_clearance_mm: i64,
    maximum_stabling_path_edges: u32,
    maximum_stabling_path_length_mm: i64,
    simulated_operational_berth_fallback: String,
    maximum_direct_dwell_ms: i64,
    terminal_formation_lengths_mm: Vec<i64>,
    default_protection_system: String,
    region_boundary_id: String,
    rzue_layout_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrackRecord {
    id: String,
    from_node_id: i64,
    to_node_id: i64,
    length_mm: i64,
    geometry: Vec<GeometryPoint>,
    speed_along_mmps: u32,
    speed_against_mmps: u32,
    protection_systems: BTreeSet<String>,
    railway: String,
    service: Option<String>,
    orderable: bool,
    gauge_mm: i64,
    gauge_lineage: String,
    electrified: Option<String>,
    voltage: Option<String>,
    frequency: Option<String>,
    bidirectional: bool,
    osm_way_id: i64,
    track_ref: Option<String>,
    quality_class: String,
    source_id: String,
    geometry_lineage: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeometryPoint {
    edge_offset_mm: i64,
    latitude_e7: i32,
    longitude_e7: i32,
    bearing_milli_degrees: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredPlatform {
    edge_id: String,
    from_mm: i64,
    to_mm: i64,
    direction: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimetableRouteInput {
    route_version_id: String,
    template_id: String,
    predecessor_id: Option<String>,
    transition_route_mm: Option<i64>,
    legs: Vec<TimetableLegInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimetableLegInput {
    edge_id: String,
    direction: String,
    edge_entry_mm: i64,
    edge_exit_mm: i64,
    available_protection_systems: Vec<String>,
    simultaneously_required_protection_systems: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnaroundTerminalInterval {
    edge_id: String,
    from_mm: i64,
    to_mm: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnaroundBerth {
    edge_id: String,
    edge_length_mm: i64,
    from_mm: i64,
    to_mm: i64,
    left_clearance_mm: i64,
    right_clearance_mm: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnaroundRouteDispatch {
    route_version_id: String,
    predecessor_base_route_version_id: String,
    continuity: MovementContinuity,
    dispatch_interlocking_route_id: String,
    head_route_mm: i64,
    minimum_runtime_ms: i64,
    resource_ids: BTreeSet<String>,
    route_leg_count: u32,
    protection_contract_runs: Vec<ProtectionContractRun>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum MovementContinuity {
    SameDirection,
    ReverseDirection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProtectionContractRun {
    through_route_leg_index: u32,
    available_protection_systems: Vec<String>,
    simultaneously_required_protection_systems: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnaroundTemplateRecord {
    id: String,
    demand_id: String,
    inbound_route_version_id: String,
    outbound_route_version_id: String,
    location_id: String,
    physical_stop_id: String,
    earliest_departure_s: i64,
    latest_arrival_s: i64,
    available_window_s: i64,
    daily_boundary: bool,
    terminal_edge_id: String,
    terminal_node_id: i64,
    inbound_direction: String,
    outbound_direction: String,
    formation_length_mm: i64,
    candidate_rank: u32,
    stabling_path_length_mm: i64,
    terminal_intervals: Vec<TurnaroundTerminalInterval>,
    stabling_kind: StablingKind,
    arrival_berth_assignment: TurnaroundBerthAssignment,
    departure_berth_assignment: TurnaroundBerthAssignment,
    shunt_in: TurnaroundRouteDispatch,
    arrival_berth: TurnaroundBerth,
    berth_transfer: Option<TurnaroundRouteDispatch>,
    berth_transfer_provenance: Option<BerthTransferProvenance>,
    departure_berth: TurnaroundBerth,
    shunt_out: TurnaroundRouteDispatch,
    outbound: TurnaroundRouteDispatch,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferRouteInput {
    id: String,
    lot_id: String,
    asset_compatibility_key: String,
    source_circulation_id: String,
    target_circulation_id: String,
    source_passenger_leg_id: String,
    target_passenger_leg_id: String,
    source_location_id: String,
    target_location_id: String,
    source_physical_stop_id: String,
    target_physical_stop_id: String,
    earliest_departure_s: i64,
    latest_arrival_s: i64,
    available_window_s: i64,
    movement_kind: String,
    source_passenger_route_version_id: String,
    target_passenger_route_version_id: String,
    formation_lengths_mm: Vec<i64>,
    route_version_id: String,
    template_id: String,
    legs: Vec<TimetableLegInput>,
    total_length_mm: i64,
    weighted_cost_mm: i64,
    minimum_runtime_ms: i64,
    daily_boundary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferTemplateRecord {
    id: String,
    demand_id: String,
    formation_length_mm: i64,
    source_passenger_route_version_id: String,
    target_passenger_route_version_id: String,
    source_location_id: String,
    target_location_id: String,
    earliest_departure_s: i64,
    latest_arrival_s: i64,
    available_window_s: i64,
    daily_boundary: bool,
    movement_kind: String,
    transfer: TurnaroundRouteDispatch,
    target_outbound: TurnaroundRouteDispatch,
    resource_ids: BTreeSet<String>,
    resource_set_sha256: String,
}

#[derive(Clone, Debug)]
struct TransferEvidence {
    file: FileEvidence,
    daily_plan_sha256: String,
    transfer_set_sha256: String,
    circulation_count: u64,
    planned_transition_count: u64,
    transfer_demand_count: u64,
    transfer_lot_count: u64,
    turnaround_demand_count: u64,
    turnaround_pair_count: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnaroundPairDemand {
    id: String,
    lot_id: String,
    asset_compatibility_key: String,
    source_circulation_id: String,
    target_circulation_id: String,
    source_passenger_leg_id: String,
    target_passenger_leg_id: String,
    #[serde(rename = "sourcePassengerRouteVersionId")]
    inbound_route_version_id: String,
    #[serde(rename = "targetPassengerRouteVersionId")]
    outbound_route_version_id: String,
    source_location_id: String,
    target_location_id: String,
    source_physical_stop_id: String,
    target_physical_stop_id: String,
    earliest_departure_s: i64,
    latest_arrival_s: i64,
    available_window_s: i64,
    daily_boundary: bool,
}

#[derive(Clone, Debug)]
struct PlannedContinuation {
    source_circulation_id: String,
    target_circulation_id: String,
    source_passenger_leg_id: String,
    target_passenger_leg_id: String,
    daily_boundary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnaroundPreflightEndpoint {
    edge_id: String,
    offset_mm: i64,
    osm_node_id: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnaroundPreflightPathLeg {
    edge_id: String,
    direction: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnaroundPreflightCandidatePath {
    path_length_mm: i64,
    berth_edge_id: String,
    berth_assignment: TurnaroundBerthAssignment,
    legs: Vec<TurnaroundPreflightPathLeg>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnaroundPreflightFinding {
    inbound_route_version_id: String,
    outbound_route_version_id: String,
    formation_length_mm: i64,
    direct_reason: String,
    stabling_reason: String,
    inbound_endpoint: TurnaroundPreflightEndpoint,
    outbound_endpoint: TurnaroundPreflightEndpoint,
    inbound_candidate_count: u64,
    outbound_candidate_count: u64,
    minimum_inbound_candidate_path_edges: Option<u64>,
    minimum_outbound_candidate_path_edges: Option<u64>,
    minimum_inbound_candidate_path_length_mm: Option<i64>,
    minimum_outbound_candidate_path_length_mm: Option<i64>,
    inbound_candidate_berth_edge_ids: Vec<String>,
    outbound_candidate_berth_edge_ids: Vec<String>,
    shortest_inbound_candidate_path: Option<TurnaroundPreflightCandidatePath>,
    shortest_outbound_candidate_path: Option<TurnaroundPreflightCandidatePath>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectTemplateRecord {
    id: String,
    demand_id: String,
    inbound_route_version_id: String,
    outbound_route_version_id: String,
    location_id: String,
    physical_stop_id: String,
    earliest_departure_s: i64,
    latest_arrival_s: i64,
    available_window_s: i64,
    daily_boundary: bool,
    formation_length_mm: i64,
    terminal_intervals: Vec<TurnaroundTerminalInterval>,
    movement_kind: String,
    continuity: MovementContinuity,
    maximum_dwell_ms: i64,
    resource_ids: BTreeSet<String>,
    resource_set_sha256: String,
    through: Option<TurnaroundRouteDispatch>,
    outbound: TurnaroundRouteDispatch,
}

#[derive(Clone, Debug)]
struct DirectedTrack {
    // Suchlabels teilen die vollstaendige OSM-Geometrie; nur der Arc und die
    // zweiwertige Richtung werden je Pfadkante kopiert.
    track: Arc<TrackRecord>,
    direction: &'static str,
}

#[derive(Clone, Debug)]
struct StablingCandidate {
    total_length_mm: i64,
    path: Vec<DirectedTrack>,
    berth_assignment: TurnaroundBerthAssignment,
}

#[derive(Clone, Debug)]
struct StablingSearchLabel {
    total_length_mm: i64,
    path: Vec<DirectedTrack>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct StablingSearchStats {
    raw_candidate_count: usize,
    duplicate_candidate_count: usize,
    replacement_candidate_count: usize,
    maximum_candidate_path_edges: usize,
    maximum_candidate_path_length_mm: i64,
    maximum_candidate_path_resident_bytes: usize,
    label_count: usize,
    cached_track_count: usize,
    peak_resident_bytes: usize,
}

impl StablingSearchStats {
    fn diagnostic(self, unique_candidate_count: usize) -> String {
        format!(
            "Suchlabels={}, geladene Gleise={}, rohe Kandidaten={}, eindeutige Berths={}, Duplikate={}, Ersetzungen={}, groesster Einzelpfad={} Kanten/{} mm/{} Bytes, Peak={} Bytes",
            self.label_count,
            self.cached_track_count,
            self.raw_candidate_count,
            unique_candidate_count,
            self.duplicate_candidate_count,
            self.replacement_candidate_count,
            self.maximum_candidate_path_edges,
            self.maximum_candidate_path_length_mm,
            self.maximum_candidate_path_resident_bytes,
            self.peak_resident_bytes,
        )
    }
}

#[derive(Clone, Debug)]
struct StablingSearchResult {
    candidates: Vec<StablingCandidate>,
    stats: StablingSearchStats,
}

#[derive(Default)]
struct DirectedTrackCache {
    tracks: BTreeMap<String, Arc<TrackRecord>>,
    resident_bytes: usize,
}

#[derive(Clone, Debug)]
struct CrossBerthConnectorPath {
    total_length_mm: i64,
    path: Vec<DirectedTrack>,
}

#[derive(Clone, Debug)]
struct TerminalNodeAccess {
    terminal_track: TrackRecord,
    node_id: i64,
    connecting_leg: Option<TimetableLegInput>,
}

#[derive(Clone, Debug)]
struct PairedStablingCandidate {
    total_length_mm: i64,
    inbound_path: Vec<DirectedTrack>,
    outbound_path: Vec<DirectedTrack>,
    stabling_kind: StablingKind,
    arrival_berth_assignment: TurnaroundBerthAssignment,
    departure_berth_assignment: TurnaroundBerthAssignment,
    berth_transfer_path: Option<Vec<DirectedTrack>>,
    berth_transfer_provenance: Option<BerthTransferProvenance>,
}

#[derive(Clone, Debug)]
struct PairedStablingSearch {
    candidates: Vec<PairedStablingCandidate>,
    inbound_candidate_count: usize,
    outbound_candidate_count: usize,
    minimum_inbound_candidate_path_edges: Option<usize>,
    minimum_outbound_candidate_path_edges: Option<usize>,
    minimum_inbound_candidate_path_length_mm: Option<i64>,
    minimum_outbound_candidate_path_length_mm: Option<i64>,
    inbound_candidate_berth_edge_ids: Vec<String>,
    outbound_candidate_berth_edge_ids: Vec<String>,
    shortest_inbound_candidate_path: Option<StablingCandidate>,
    shortest_outbound_candidate_path: Option<StablingCandidate>,
    inbound_candidates: Vec<StablingCandidate>,
    outbound_candidates: Vec<StablingCandidate>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum BerthSearchMode {
    ObservedSiding,
    SimulatedOperationalFallback,
}

#[derive(Clone, Copy, Debug)]
struct StablingSearchPolicy {
    formation_length_mm: i64,
    minimum_clearance_mm: i64,
    maximum_path_edges: u32,
    maximum_path_length_mm: i64,
    search_mode: BerthSearchMode,
}

fn string_heap_bytes(value: &String) -> usize {
    value.capacity()
}

fn optional_string_heap_bytes(value: &Option<String>) -> usize {
    value.as_ref().map_or(0, string_heap_bytes)
}

fn track_heap_bytes(track: &TrackRecord) -> usize {
    track
        .geometry
        .capacity()
        .saturating_mul(std::mem::size_of::<GeometryPoint>())
        .saturating_add(string_heap_bytes(&track.id))
        .saturating_add(string_heap_bytes(&track.railway))
        .saturating_add(optional_string_heap_bytes(&track.service))
        .saturating_add(string_heap_bytes(&track.gauge_lineage))
        .saturating_add(optional_string_heap_bytes(&track.electrified))
        .saturating_add(optional_string_heap_bytes(&track.voltage))
        .saturating_add(optional_string_heap_bytes(&track.frequency))
        .saturating_add(optional_string_heap_bytes(&track.track_ref))
        .saturating_add(string_heap_bytes(&track.quality_class))
        .saturating_add(string_heap_bytes(&track.source_id))
        .saturating_add(string_heap_bytes(&track.geometry_lineage))
        .saturating_add(
            track
                .protection_systems
                .iter()
                .fold(0_usize, |total, protection| {
                    total
                        .saturating_add(string_heap_bytes(protection))
                        .saturating_add(GENERATED_ENTRY_OVERHEAD_BYTES)
                }),
        )
}

fn directed_path_resident_bytes(path: &[DirectedTrack]) -> usize {
    // Die internen Pfade entstehen ausschliesslich durch clone+push. Zwei
    // Slots je belegtem Element sind daher eine enge, konservative
    // Kapazitaetsobergrenze fuer die Vec-Allokation.
    let estimated_capacity = if path.is_empty() {
        0
    } else {
        path.len().saturating_mul(2).max(4)
    };
    estimated_capacity.saturating_mul(std::mem::size_of::<DirectedTrack>())
}

fn directed_path_standalone_resident_bytes(path: &[DirectedTrack]) -> usize {
    let mut track_ids = BTreeSet::new();
    path.iter().fold(
        directed_path_resident_bytes(path),
        |resident_bytes, edge| {
            if track_ids.insert(edge.track.id.as_str()) {
                resident_bytes
                    .saturating_add(std::mem::size_of::<TrackRecord>())
                    .saturating_add(track_heap_bytes(&edge.track))
                    .saturating_add(GENERATED_ENTRY_OVERHEAD_BYTES)
            } else {
                resident_bytes
            }
        },
    )
}

fn stabling_candidate_resident_bytes(candidate: &StablingCandidate) -> usize {
    std::mem::size_of::<StablingCandidate>()
        .saturating_add(directed_path_resident_bytes(&candidate.path))
        .saturating_add(GENERATED_ENTRY_OVERHEAD_BYTES)
}

fn stabling_label_resident_bytes(label: &StablingSearchLabel) -> usize {
    std::mem::size_of::<StablingSearchLabel>()
        .saturating_add(directed_path_resident_bytes(&label.path))
        .saturating_add(GENERATED_ENTRY_OVERHEAD_BYTES)
}

fn stabling_search_resident_bytes(
    track_cache: &DirectedTrackCache,
    label_resident_bytes: usize,
    candidate_resident_bytes: usize,
) -> Result<usize> {
    track_cache
        .resident_bytes
        .checked_add(label_resident_bytes)
        .and_then(|value| value.checked_add(candidate_resident_bytes))
        .ok_or_else(|| {
            GermanyOperationalV2Error::new("Abstellkandidaten-Suchspeicher laeuft ueber.")
        })
}

fn require_stabling_search_budget(
    inbound_route_id: &str,
    track_cache: &DirectedTrackCache,
    label_resident_bytes: usize,
    candidate_resident_bytes: usize,
    stats: &mut StablingSearchStats,
    unique_candidate_count: usize,
) -> Result<()> {
    require_stabling_search_budget_with_limit(
        inbound_route_id,
        track_cache,
        label_resident_bytes,
        candidate_resident_bytes,
        stats,
        unique_candidate_count,
        MAX_STABLING_SEARCH_RESIDENT_BYTES,
    )
}

#[allow(clippy::too_many_arguments)]
fn require_stabling_search_budget_with_limit(
    inbound_route_id: &str,
    track_cache: &DirectedTrackCache,
    label_resident_bytes: usize,
    candidate_resident_bytes: usize,
    stats: &mut StablingSearchStats,
    unique_candidate_count: usize,
    maximum_resident_bytes: usize,
) -> Result<()> {
    let resident_bytes = stabling_search_resident_bytes(
        track_cache,
        label_resident_bytes,
        candidate_resident_bytes,
    )?;
    stats.cached_track_count = track_cache.tracks.len();
    stats.peak_resident_bytes = stats.peak_resident_bytes.max(resident_bytes);
    require(
        resident_bytes <= maximum_resident_bytes,
        format!(
            "Abstellkandidatensuche fuer `{inbound_route_id}` ueberschreitet das feste gemeinsame Suchspeicherbudget von {maximum_resident_bytes} Bytes ({}).",
            stats.diagnostic(unique_candidate_count)
        ),
    )
}

fn paired_stabling_candidate_resident_bytes(candidate: &PairedStablingCandidate) -> usize {
    std::mem::size_of::<PairedStablingCandidate>()
        .saturating_add(directed_path_resident_bytes(&candidate.inbound_path))
        .saturating_add(directed_path_resident_bytes(&candidate.outbound_path))
        .saturating_add(
            candidate
                .berth_transfer_path
                .as_deref()
                .map_or(0, directed_path_resident_bytes),
        )
        .saturating_add(GENERATED_ENTRY_OVERHEAD_BYTES)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum StablingKind {
    SharedBerth,
    CrossBerthTransfer,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum BerthTransferRoutingRule {
    RealOsmRailBidirectionalBoundedV1,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BerthTransferProvenance {
    geometry_provenance: BerthGeometryProvenance,
    routing_rule: BerthTransferRoutingRule,
    location_id: String,
    physical_stop_id: String,
    maximum_path_edges_per_side: u32,
    maximum_path_length_mm_per_side: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum BerthAssignmentKind {
    Observed,
    SimulatedOperational,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
enum BerthAssignmentSubtype {
    #[serde(rename = "osm-service-siding")]
    ServiceSiding,
    #[serde(rename = "osm-service-yard")]
    ServiceYard,
    #[serde(rename = "osm-service-spur")]
    ServiceSpur,
    #[serde(rename = "osm-unclassified-rail")]
    UnclassifiedRail,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum BerthGeometryProvenance {
    RealOsmRail,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum BerthOperationalAssignmentProvenance {
    ObservedOsmService,
    SyntheticOperationalBPolicy,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnaroundBerthAssignment {
    kind: BerthAssignmentKind,
    subtype: BerthAssignmentSubtype,
    geometry_provenance: BerthGeometryProvenance,
    operational_assignment_provenance: BerthOperationalAssignmentProvenance,
}

impl TurnaroundBerthAssignment {
    fn stable_key(self) -> &'static str {
        match self.subtype {
            BerthAssignmentSubtype::ServiceSiding => "observed:osm-service-siding",
            BerthAssignmentSubtype::ServiceYard => "simulated-operational:osm-service-yard",
            BerthAssignmentSubtype::ServiceSpur => "simulated-operational:osm-service-spur",
            BerthAssignmentSubtype::UnclassifiedRail => {
                "simulated-operational:osm-unclassified-rail"
            }
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BerthAssignmentCounts {
    observed_osm_service_siding: u64,
    simulated_operational_osm_service_yard: u64,
    simulated_operational_osm_service_spur: u64,
    simulated_operational_osm_unclassified_rail: u64,
}

impl BerthAssignmentCounts {
    fn increment(&mut self, assignment: TurnaroundBerthAssignment) {
        let count = match assignment.subtype {
            BerthAssignmentSubtype::ServiceSiding => &mut self.observed_osm_service_siding,
            BerthAssignmentSubtype::ServiceYard => &mut self.simulated_operational_osm_service_yard,
            BerthAssignmentSubtype::ServiceSpur => &mut self.simulated_operational_osm_service_spur,
            BerthAssignmentSubtype::UnclassifiedRail => {
                &mut self.simulated_operational_osm_unclassified_rail
            }
        };
        *count = count.saturating_add(1);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEvidence {
    path: String,
    bytes: u64,
    sha256: String,
    records: u64,
}

#[derive(Default)]
struct Counts {
    tracks_seen: u64,
    orderable_tracks: u64,
    platforms_seen: u64,
    platform_intervals: u64,
    excluded_platform_evidence: u64,
    switches: u64,
    observed_signals: u64,
    blocks: u64,
    conflict_resources: u64,
    timetable_routes: u64,
    timetable_legs: u64,
    observed_forward_speeds: u64,
    observed_backward_speeds: u64,
    simulated_speeds: u64,
    observed_protection: u64,
    simulated_protection: u64,
}

struct ScratchDirectory(PathBuf);

impl ScratchDirectory {
    fn create(parent: &Path) -> Result<Self> {
        let process_id = std::process::id();
        for _ in 0..1_024 {
            let id = NEXT_SCRATCH_ID.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!(".zugfolge-germany-operational-{process_id}-{id}"));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(io_error("temporaeres Ableitungsverzeichnis", &path, error));
                }
            }
        }
        Err(GermanyOperationalV2Error::new(
            "Kein eindeutiges temporaeres Deutschland-Operational-Verzeichnis verfuegbar.",
        ))
    }

    fn join(&self, file: &str) -> PathBuf {
        self.0.join(file)
    }
}

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct OutputClaims {
    files: Vec<File>,
    acquired_paths: Vec<PathBuf>,
}

impl OutputClaims {
    fn acquire(targets: &[&Path]) -> Result<Self> {
        let mut paths = targets
            .iter()
            .map(|target| {
                let parent = target.parent().unwrap_or_else(|| Path::new("."));
                let file = target.file_name().ok_or_else(|| {
                    GermanyOperationalV2Error::new("Ausgabeziel besitzt keinen Dateinamen.")
                })?;
                Ok(parent.join(format!(".{}.zugfolge-publish.lock", file.to_string_lossy())))
            })
            .collect::<Result<Vec<_>>>()?;
        paths.sort_by_key(|path| output_identity_key(path));
        paths.dedup_by(|left, right| output_identity_key(left) == output_identity_key(right));
        require(
            paths.len() == targets.len(),
            "Kandidat und Bericht besitzen keinen eindeutigen Publish-Claim.",
        )?;
        for path in &paths {
            require(
                targets
                    .iter()
                    .all(|target| output_identity_key(target) != output_identity_key(path)),
                "Ein Ausgabeziel kollidiert mit einem Publish-Claim.",
            )?;
        }
        let mut claims = Self {
            files: Vec::new(),
            acquired_paths: Vec::new(),
        };
        for path in paths {
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| {
                    io_error("exklusiver Operational-v2-Publish-Claim", &path, error)
                })?;
            let claim_path = path.clone();
            claims.files.push(file);
            claims.acquired_paths.push(path);
            let claim = claims
                .files
                .last_mut()
                .expect("Publish-Claim wurde angelegt");
            writeln!(claim, "pid={}", std::process::id())
                .and_then(|()| claim.flush())
                .map_err(|error| io_error("Operational-v2-Publish-Claim", &claim_path, error))?;
        }
        Ok(claims)
    }
}

impl Drop for OutputClaims {
    fn drop(&mut self) {
        self.files.clear();
        for path in &self.acquired_paths {
            let _ = fs::remove_file(path);
        }
    }
}

fn io_error(context: &str, path: &Path, error: io::Error) -> GermanyOperationalV2Error {
    GermanyOperationalV2Error::new(format!("{context} `{}`: {error}", path.display()))
}

fn db_error(error: impl fmt::Display) -> GermanyOperationalV2Error {
    GermanyOperationalV2Error::new(format!("Deutschland-Operational-Index: {error}"))
}

fn require(condition: bool, message: impl fmt::Display) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(GermanyOperationalV2Error::new(message.to_string()))
    }
}

fn digest_hex(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha256(bytes: &[u8]) -> String {
    digest_hex(Sha256::digest(bytes))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_json(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => output
            .push_str(&serde_json::to_string(value).expect("eine Zeichenkette ist serialisierbar")),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical_json(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort_unstable_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical_json(&Value::String(key.clone()), output);
                output.push(':');
                canonical_json(&values[key], output);
            }
            output.push('}');
        }
    }
}

fn stable_id(prefix: &str, parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(u64::try_from(part.len()).unwrap_or(u64::MAX).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    format!("{prefix}{}", digest_hex(hasher.finalize()))
}

fn is_symlink_or_reparse_point(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    false
}

fn require_symlink_free_existing_path(path: &Path, context: &str) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| {
                GermanyOperationalV2Error::new(format!(
                    "Arbeitsverzeichnis fuer {context} kann nicht gelesen werden: {error}"
                ))
            })?
            .join(path)
    };
    for ancestor in absolute.ancestors() {
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|error| io_error(context, ancestor, error))?;
        require(
            !is_symlink_or_reparse_point(&metadata),
            format!(
                "{context} `{}` enthaelt einen Symlink oder Reparse-Point bei `{}`.",
                path.display(),
                ancestor.display()
            ),
        )?;
    }
    fs::canonicalize(&absolute).map_err(|error| io_error(context, &absolute, error))
}

fn canonical_output_path(path: &Path, context: &str) -> Result<PathBuf> {
    require(
        matches!(path.components().next_back(), Some(Component::Normal(_))),
        format!("{context} muss mit genau einem normalen Dateinamen enden."),
    )?;
    let file_name = path.file_name().ok_or_else(|| {
        GermanyOperationalV2Error::new(format!("{context} besitzt keinen Dateinamen."))
    })?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    require(parent.is_dir(), format!("{context} fehlt."))?;
    let canonical_parent = require_symlink_free_existing_path(parent, context)?;
    Ok(canonical_parent.join(file_name))
}

fn movement_route_sidecar_path(candidate: &Path) -> Result<PathBuf> {
    let file_name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            GermanyOperationalV2Error::new("Kandidat besitzt keinen UTF-8-Dateinamen.")
        })?;
    let stem = file_name.strip_suffix(".json").unwrap_or(file_name);
    Ok(candidate.with_file_name(format!("{stem}.movement-route-templates-v2.json")))
}

fn output_identity_key(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value.into_owned()
    }
}

fn publish_create_new(staged: &Path, target: &Path, context: &str) -> Result<()> {
    fs::hard_link(staged, target).map_err(|error| io_error(context, target, error))?;
    Ok(())
}

fn remove_owned_published_link(target: &Path, context: &str) -> Result<()> {
    // Der exklusive sibling-Claim bleibt ueber den gesamten Paar-Publish
    // gehalten. `target` kann an dieser Stelle deshalb nur der unmittelbar
    // zuvor von diesem Lauf create-new angelegte Hardlink sein.
    fs::remove_file(target).map_err(|error| io_error(context, target, error))
}

#[cfg(test)]
fn publish_pair_create_new(
    staged_candidate: &Path,
    candidate: &Path,
    staged_report: &Path,
    report: &Path,
) -> Result<()> {
    publish_create_new(
        staged_candidate,
        candidate,
        "Operational-v2-Kandidat create-new veroeffentlichen",
    )?;
    if let Err(publish_error) = publish_create_new(
        staged_report,
        report,
        "Operational-v2-Bericht create-new veroeffentlichen",
    ) {
        remove_owned_published_link(
            candidate,
            "Partiellen Operational-v2-Kandidaten zuruecknehmen",
        )
        .map_err(|rollback_error| {
            GermanyOperationalV2Error::new(format!(
                "{publish_error} Der partielle Paar-Publish konnte nicht sicher zurueckgenommen werden: {rollback_error}"
            ))
        })?;
        return Err(GermanyOperationalV2Error::new(format!(
            "{publish_error} Der partielle Kandidaten-Publish wurde vollstaendig zurueckgenommen."
        )));
    }
    Ok(())
}

fn publish_triplet_create_new(
    staged_candidate: &Path,
    candidate: &Path,
    staged_sidecar: &Path,
    sidecar: &Path,
    staged_report: &Path,
    report: &Path,
) -> Result<()> {
    publish_create_new(
        staged_candidate,
        candidate,
        "Operational-v2-Kandidat create-new veroeffentlichen",
    )?;
    if let Err(error) = publish_create_new(
        staged_sidecar,
        sidecar,
        "Turnaround-Sidecar create-new veroeffentlichen",
    ) {
        remove_owned_published_link(
            candidate,
            "Partiellen Operational-v2-Kandidaten zuruecknehmen",
        )?;
        return Err(error);
    }
    if let Err(error) = publish_create_new(
        staged_report,
        report,
        "Operational-v2-Bericht create-new veroeffentlichen",
    ) {
        let sidecar_rollback =
            remove_owned_published_link(sidecar, "Partiellen Turnaround-Sidecar zuruecknehmen");
        let candidate_rollback = remove_owned_published_link(
            candidate,
            "Partiellen Operational-v2-Kandidaten zuruecknehmen",
        );
        if let Err(rollback) = sidecar_rollback.and(candidate_rollback) {
            return Err(GermanyOperationalV2Error::new(format!(
                "{error} Der partielle Triplet-Publish konnte nicht sicher zurueckgenommen werden: {rollback}"
            )));
        }
        return Err(error);
    }
    Ok(())
}

fn regular_file(path: &Path, context: &str) -> Result<u64> {
    require_symlink_free_existing_path(path, context)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(context, path, error))?;
    require(
        metadata.file_type().is_file() && !is_symlink_or_reparse_point(&metadata),
        format!(
            "{context} `{}` ist keine regulaere, symlinkfreie Datei.",
            path.display()
        ),
    )?;
    require(
        metadata.len() > 0,
        format!("{context} `{}` ist leer.", path.display()),
    )?;
    Ok(metadata.len())
}

fn layer_path(source_root: &Path, relative: &str, name: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    require(
        !relative.trim().is_empty(),
        format!("Layerpfad `{name}` fehlt."),
    )?;
    require(
        !path.is_absolute()
            && path
                .components()
                .all(|component| matches!(component, Component::Normal(_))),
        format!("Layerpfad `{name}` muss relativ und traversal-frei sein."),
    )?;
    let resolved = source_root.join(path);
    regular_file(&resolved, &format!("Layer `{name}`"))?;
    let canonical_root = fs::canonicalize(source_root)
        .map_err(|error| io_error("Operational-v2-Quellwurzel", source_root, error))?;
    let canonical_layer = fs::canonicalize(&resolved)
        .map_err(|error| io_error(&format!("Layer `{name}`"), &resolved, error))?;
    require(
        canonical_layer.starts_with(&canonical_root),
        format!(
            "Layer `{name}` liegt nach der Pfadauflosung ausserhalb der Operational-v2-Quellwurzel."
        ),
    )?;
    Ok(resolved)
}

fn read_spec(path: &Path) -> Result<(DerivationSpec, FileEvidence)> {
    let expected = regular_file(path, "Ableitungsspezifikation")?;
    let bytes = fs::read(path).map_err(|error| io_error("Ableitungsspezifikation", path, error))?;
    require(
        u64::try_from(bytes.len())
            .map_err(|_| GermanyOperationalV2Error::new("Spezifikation ist zu gross."))?
            == expected,
        "Ableitungsspezifikation aenderte waehrend des Lesens ihre Groesse.",
    )?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        GermanyOperationalV2Error::new(format!("Ableitungsspezifikation ist ungueltig: {error}"))
    })?;
    exact_keys(
        &value,
        &["schema", "mode", "infraReleaseId", "layers", "policy"],
        "Ableitungsspezifikation",
    )?;
    exact_keys(
        value
            .get("layers")
            .ok_or_else(|| GermanyOperationalV2Error::new("layers fehlt."))?,
        &[
            "tracks",
            "platforms",
            "switches",
            "signals",
            "blocks",
            "conflictResources",
            "timetableRoutes",
            "transferDemands",
        ],
        "Ableitungsspezifikation.layers",
    )?;
    exact_keys(
        value
            .get("policy")
            .ok_or_else(|| GermanyOperationalV2Error::new("policy fehlt."))?,
        &[
            "id",
            "qualityClass",
            "sourceId",
            "derivationRule",
            "unknownMainlineSpeedKmh",
            "unknownServiceSpeedKmh",
            "unknownGradientAbsPermille",
            "minimumPlatformLengthMm",
            "maximumPlatformSnapDistanceMm",
            "minimumOverlapMm",
            "minimumBerthEndClearanceMm",
            "maximumStablingPathEdges",
            "maximumStablingPathLengthMm",
            "simulatedOperationalBerthFallback",
            "maximumDirectDwellMs",
            "terminalFormationLengthsMm",
            "defaultProtectionSystem",
            "regionBoundaryId",
            "rzueLayoutId",
        ],
        "Ableitungsspezifikation.policy",
    )?;
    let spec: DerivationSpec = serde_json::from_value(value).map_err(|error| {
        GermanyOperationalV2Error::new(format!("Ableitungsspezifikation ist ungueltig: {error}"))
    })?;
    Ok((
        spec,
        FileEvidence {
            path: path.file_name().map_or_else(
                || "derivation-spec.json".to_owned(),
                |name| name.to_string_lossy().into_owned(),
            ),
            bytes: expected,
            sha256: sha256(&bytes),
            records: 1,
        },
    ))
}

fn exact_keys(value: &Value, expected: &[&str], context: &str) -> Result<()> {
    let values = object(value, context)?;
    let actual: BTreeSet<_> = values.keys().map(String::as_str).collect();
    let expected: BTreeSet<_> = expected.iter().copied().collect();
    require(
        actual == expected,
        format!("{context} besitzt nicht exakt die Pflichtfelder {expected:?}."),
    )
}

fn validate_spec(spec: &DerivationSpec) -> Result<()> {
    require(
        spec.schema == SPEC_SCHEMA,
        format!("Schema muss `{SPEC_SCHEMA}` sein."),
    )?;
    require(spec.mode == MODE, format!("Mode muss `{MODE}` sein."))?;
    require(
        !spec.infra_release_id.trim().is_empty(),
        "infraReleaseId fehlt.",
    )?;
    require(
        spec.policy.id == POLICY_ID,
        format!("Policy-ID muss `{POLICY_ID}` sein."),
    )?;
    require(
        spec.policy.derivation_rule == POLICY_ID,
        format!("derivationRule muss `{POLICY_ID}` sein."),
    )?;
    require(
        spec.policy.quality_class == "B",
        "qualityClass muss `B` sein.",
    )?;
    require(
        !spec.policy.source_id.trim().is_empty()
            && !spec.policy.default_protection_system.trim().is_empty()
            && !spec.policy.region_boundary_id.trim().is_empty()
            && !spec.policy.rzue_layout_id.trim().is_empty(),
        "Policy-IDs und Standardsystem muessen nichtleer sein.",
    )?;
    require(
        spec.policy.unknown_mainline_speed_kmh > 0
            && spec.policy.unknown_service_speed_kmh > 0
            && (0..=200).contains(&spec.policy.unknown_gradient_abs_permille)
            && spec.policy.minimum_platform_length_mm > 0
            && spec.policy.maximum_platform_snap_distance_mm > 0
            && spec.policy.minimum_overlap_mm > 0
            && spec.policy.minimum_berth_end_clearance_mm > 0
            && (1..=MAX_STABLING_PATH_EDGES_POLICY)
                .contains(&spec.policy.maximum_stabling_path_edges)
            && (1..=MAX_STABLING_PATH_LENGTH_MM_POLICY)
                .contains(&spec.policy.maximum_stabling_path_length_mm)
            && spec.policy.maximum_direct_dwell_ms > 0
            && spec
                .policy
                .terminal_formation_lengths_mm
                .iter()
                .all(|length| *length > 0 && *length <= MAX_SAFE_INTEGER)
            && spec
                .policy
                .terminal_formation_lengths_mm
                .windows(2)
                .all(|pair| pair[0] < pair[1]),
        "Numerische Policy-Grenzen sind ungueltig.",
    )?;
    require(
        spec.policy.simulated_operational_berth_fallback == SIMULATED_OPERATIONAL_BERTH_FALLBACK,
        format!(
            "simulatedOperationalBerthFallback muss `{SIMULATED_OPERATIONAL_BERTH_FALLBACK}` sein."
        ),
    )?;
    if let Some(transfer) = &spec.layers.transfer_demands {
        require(
            spec.layers.timetable_routes.is_some()
                && !transfer.path.trim().is_empty()
                && transfer.expected_bytes > 0
                && transfer.expected_bytes <= MAX_TRANSFER_DEMAND_BYTES
                && is_sha256(&transfer.expected_sha256),
            "transferDemands verlangt timetableRoutes sowie einen nichtleeren, bytes-/SHA-256-gepinnten Eingabevertrag.",
        )?;
    }
    Ok(())
}

fn read_bounded_sequence_record<R: BufRead>(
    reader: &mut R,
    record: &mut Vec<u8>,
) -> io::Result<usize> {
    let mut read = 0_usize;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(read);
        }
        let length = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if record.len().saturating_add(length) > MAX_GEOJSON_SEQUENCE_RECORD_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "GeoJSONSeq-Einzeldatensatz ueberschreitet die native 8-MiB-Grenze",
            ));
        }
        record.extend_from_slice(&available[..length]);
        reader.consume(length);
        read = read.checked_add(length).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "Datensatzgroesse laeuft ueber")
        })?;
        if record.last() == Some(&b'\n') {
            return Ok(read);
        }
    }
}

fn scan_sequence<F>(path: &Path, relative: &str, mut consume: F) -> Result<FileEvidence>
where
    F: FnMut(Value, u64) -> Result<()>,
{
    let expected = regular_file(path, "GeoJSONSeq-Layer")?;
    let file = File::open(path).map_err(|error| io_error("GeoJSONSeq-Layer", path, error))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut records = 0_u64;
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = read_bounded_sequence_record(&mut reader, &mut line)
            .map_err(|error| io_error("GeoJSONSeq-Layer", path, error))?;
        if read == 0 {
            break;
        }
        hasher.update(&line);
        bytes = bytes
            .checked_add(
                u64::try_from(read)
                    .map_err(|_| GermanyOperationalV2Error::new("Layergroesse laeuft ueber."))?,
            )
            .ok_or_else(|| GermanyOperationalV2Error::new("Layergroesse laeuft ueber."))?;
        while line
            .last()
            .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
        {
            line.pop();
        }
        if line.first() == Some(&0x1e) {
            line.remove(0);
        }
        require(
            !line.is_empty(),
            format!("Leerer GeoJSONSeq-Datensatz in `{relative}`."),
        )?;
        records = records
            .checked_add(1)
            .ok_or_else(|| GermanyOperationalV2Error::new("Datensatzzahl laeuft ueber."))?;
        let value = serde_json::from_slice(&line).map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "`{relative}` Datensatz {records} ist ungueltig: {error}"
            ))
        })?;
        consume(value, records)?;
    }
    require(
        bytes == expected,
        format!("Layer `{relative}` aenderte beim Lesen seine Groesse."),
    )?;
    Ok(FileEvidence {
        path: relative.to_owned(),
        bytes,
        sha256: digest_hex(hasher.finalize()),
        records,
    })
}

fn object<'a>(value: &'a Value, context: &str) -> Result<&'a serde_json::Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context} ist kein Objekt.")))
}

fn properties<'a>(feature: &'a Value, context: &str) -> Result<&'a serde_json::Map<String, Value>> {
    let root = object(feature, context)?;
    require(
        root.get("type").and_then(Value::as_str) == Some("Feature"),
        format!("{context}.type ist nicht `Feature`."),
    )?;
    object(
        root.get("properties").ok_or_else(|| {
            GermanyOperationalV2Error::new(format!("{context}.properties fehlt."))
        })?,
        &format!("{context}.properties"),
    )
}

fn string_field<'a>(
    values: &'a serde_json::Map<String, Value>,
    key: &str,
    context: &str,
) -> Result<&'a str> {
    values
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context}.{key} fehlt.")))
}

fn i64_field(values: &serde_json::Map<String, Value>, key: &str, context: &str) -> Result<i64> {
    let value = values
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context}.{key} fehlt.")))?;
    require(
        (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value),
        format!("{context}.{key} ist keine sichere Ganzzahl."),
    )?;
    Ok(value)
}

fn optional_tag(tags: &BTreeMap<String, String>, key: &str) -> Option<String> {
    tags.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn standard_gauge(tags: &BTreeMap<String, String>, context: &str) -> Result<(i64, String)> {
    let Some(raw) = optional_tag(tags, "gauge") else {
        return Ok((
            STANDARD_GAUGE_MM,
            "ebo-network-filter-default-standard-gauge".to_owned(),
        ));
    };
    let parsed = raw
        .split(';')
        .next()
        .map(str::trim)
        .and_then(|value| value.parse::<i64>().ok());
    require(
        parsed == Some(STANDARD_GAUGE_MM),
        format!("{context} besitzt keine freigegebene Regelspurklassifikation."),
    )?;
    Ok((STANDARD_GAUGE_MM, "observed-osm-gauge".to_owned()))
}

fn coordinate_e7(value: &Value, context: &str) -> Result<(i32, i32)> {
    let coordinates = value
        .as_array()
        .filter(|coordinates| coordinates.len() >= 2)
        .ok_or_else(|| {
            GermanyOperationalV2Error::new(format!("{context} ist keine Koordinate."))
        })?;
    let longitude = coordinates[0]
        .as_f64()
        .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context}[0] ist ungueltig.")))?;
    let latitude = coordinates[1]
        .as_f64()
        .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context}[1] ist ungueltig.")))?;
    require(
        longitude.is_finite() && latitude.is_finite(),
        format!("{context} ist nicht endlich."),
    )?;
    let longitude_text = coordinates[0].to_string();
    let latitude_text = coordinates[1].to_string();
    Ok((
        decimal_degrees_to_e7(&longitude_text, context)?,
        decimal_degrees_to_e7(&latitude_text, context)?,
    ))
}

fn decimal_degrees_to_e7(value: &str, context: &str) -> Result<i32> {
    let negative = value.starts_with('-');
    let unsigned = value.trim_start_matches('-');
    let mut parts = unsigned.split('.');
    let whole = parts.next().unwrap_or("0").parse::<i64>().map_err(|_| {
        GermanyOperationalV2Error::new(format!("{context} besitzt ungueltige Gradwerte."))
    })?;
    let fraction = parts.next().unwrap_or("");
    require(
        parts.next().is_none(),
        format!("{context} besitzt ungueltige Gradwerte."),
    )?;
    let mut digits = fraction
        .as_bytes()
        .iter()
        .take(7)
        .copied()
        .collect::<Vec<_>>();
    while digits.len() < 7 {
        digits.push(b'0');
    }
    let fraction_value = std::str::from_utf8(&digits)
        .map_err(|_| {
            GermanyOperationalV2Error::new(format!("{context} besitzt ungueltige Gradwerte."))
        })?
        .parse::<i64>()
        .map_err(|_| {
            GermanyOperationalV2Error::new(format!("{context} besitzt ungueltige Gradwerte."))
        })?;
    let absolute = whole
        .checked_mul(10_000_000)
        .and_then(|whole| whole.checked_add(fraction_value))
        .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context} laeuft ueber.")))?;
    let signed = if negative { -absolute } else { absolute };
    i32::try_from(signed)
        .map_err(|_| GermanyOperationalV2Error::new(format!("{context} liegt ausserhalb E7.")))
}

fn integer_sqrt(value: u128) -> u128 {
    if value < 2 {
        return value;
    }
    let mut left = 1_u128;
    let mut right = value.min(u128::from(u64::MAX));
    while left <= right {
        let middle = left + (right - left) / 2;
        if middle <= value / middle {
            left = middle.saturating_add(1);
        } else {
            right = middle.saturating_sub(1);
        }
    }
    right
}

fn planar_length(left: (i32, i32), right: (i32, i32)) -> u64 {
    let dx = i128::from(right.0) - i128::from(left.0);
    let dy = i128::from(right.1) - i128::from(left.1);
    let squared = dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy));
    u64::try_from(integer_sqrt(u128::try_from(squared).unwrap_or(u128::MAX))).unwrap_or(u64::MAX)
}

fn bearing_milli_degrees(left: (i32, i32), right: (i32, i32)) -> u32 {
    let dx = i64::from(right.0) - i64::from(left.0);
    let dy = i64::from(right.1) - i64::from(left.1);
    let absolute_x = dx.unsigned_abs();
    let absolute_y = dy.unsigned_abs();
    if absolute_x == 0 && absolute_y == 0 {
        return 0;
    }
    let quadrant_angle = if absolute_y >= absolute_x {
        u32::try_from(45_000_u64.saturating_mul(absolute_x) / absolute_y.max(1)).unwrap_or(45_000)
    } else {
        90_000_u32.saturating_sub(
            u32::try_from(45_000_u64.saturating_mul(absolute_y) / absolute_x.max(1))
                .unwrap_or(45_000),
        )
    };
    match (dx >= 0, dy >= 0) {
        (true, true) => quadrant_angle,
        (true, false) => 180_000_u32.saturating_sub(quadrant_angle),
        (false, false) => 180_000_u32.saturating_add(quadrant_angle),
        (false, true) => 360_000_u32.saturating_sub(quadrant_angle) % 360_000,
    }
}

fn geometry_points(feature: &Value, length_mm: i64, context: &str) -> Result<Vec<GeometryPoint>> {
    require(
        length_mm > 0,
        format!("{context}.length_mm muss positiv sein."),
    )?;
    let geometry = object(
        object(feature, context)?
            .get("geometry")
            .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context}.geometry fehlt.")))?,
        &format!("{context}.geometry"),
    )?;
    require(
        geometry.get("type").and_then(Value::as_str) == Some("LineString"),
        format!("{context}.geometry ist keine LineString."),
    )?;
    let raw = geometry
        .get("coordinates")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            GermanyOperationalV2Error::new(format!("{context}.geometry.coordinates fehlt."))
        })?;
    let mut coordinates = Vec::new();
    for (index, coordinate) in raw.iter().enumerate() {
        let point = coordinate_e7(
            coordinate,
            &format!("{context}.geometry.coordinates[{index}]"),
        )?;
        if coordinates.last() != Some(&point) {
            coordinates.push(point);
        }
    }
    require(
        coordinates.len() >= 2,
        format!("{context} besitzt weniger als zwei verschiedene Geometriepunkte."),
    )?;
    if i64::try_from(coordinates.len().saturating_sub(1)).unwrap_or(i64::MAX) > length_mm {
        let last = coordinates
            .last()
            .copied()
            .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context}.geometry fehlt.")))?;
        coordinates = vec![coordinates[0], last];
    }
    let mut cumulative = vec![0_u64];
    for pair in coordinates.windows(2) {
        let next = cumulative
            .last()
            .copied()
            .unwrap_or(0)
            .saturating_add(planar_length(pair[0], pair[1]).max(1));
        cumulative.push(next);
    }
    let total = cumulative.last().copied().unwrap_or(1).max(1);
    let last_index = coordinates.len().saturating_sub(1);
    let mut points = Vec::with_capacity(coordinates.len());
    let mut previous = -1_i64;
    for (index, coordinate) in coordinates.iter().enumerate() {
        let offset = if index == 0 {
            0
        } else if index == last_index {
            length_mm
        } else {
            let raw_offset = i128::from(length_mm).saturating_mul(i128::from(cumulative[index]))
                / i128::from(total);
            let remaining = i64::try_from(last_index.saturating_sub(index)).unwrap_or(i64::MAX);
            i64::try_from(raw_offset).unwrap_or(length_mm).clamp(
                previous.saturating_add(1),
                length_mm.saturating_sub(remaining),
            )
        };
        let bearing = coordinates
            .get(index + 1)
            .map(|next| bearing_milli_degrees(*coordinate, *next));
        points.push(GeometryPoint {
            edge_offset_mm: offset,
            latitude_e7: coordinate.1,
            longitude_e7: coordinate.0,
            bearing_milli_degrees: bearing,
        });
        previous = offset;
    }
    Ok(points)
}

fn kmh_to_mmps(speed_kmh: u32) -> u32 {
    speed_kmh.saturating_mul(1_000_000) / 3_600
}

fn parse_tags(
    properties: &serde_json::Map<String, Value>,
    context: &str,
) -> Result<BTreeMap<String, String>> {
    let Some(raw) = properties.get("osm_tags_json").and_then(Value::as_str) else {
        return Ok(BTreeMap::new());
    };
    serde_json::from_str(raw).map_err(|error| {
        GermanyOperationalV2Error::new(format!("{context}.osm_tags_json ist ungueltig: {error}"))
    })
}

fn canonical_protection_systems(tags: &BTreeMap<String, String>) -> BTreeSet<String> {
    let mut systems = BTreeSet::new();
    for (key, value) in tags {
        match (key.as_str(), value.as_str()) {
            ("railway:pzb", "yes" | "forward" | "backward") => {
                systems.insert("pzb".to_owned());
            }
            ("railway:lzb", "yes") => {
                systems.insert("lzb".to_owned());
            }
            ("railway:etcs" | "railway:etcs:forward" | "railway:etcs:backward", "1") => {
                systems.insert("etcs-level1".to_owned());
            }
            ("railway:etcs" | "railway:etcs:forward" | "railway:etcs:backward", "2") => {
                systems.insert("etcs-level2".to_owned());
            }
            ("railway:etcs" | "railway:etcs:forward" | "railway:etcs:backward", "1;2") => {
                systems.insert("etcs-level1".to_owned());
                systems.insert("etcs-level2".to_owned());
            }
            _ => {}
        }
    }
    systems
}

fn track_record(
    feature: &Value,
    policy: &PolicySpec,
    counts: &mut Counts,
    record: u64,
) -> Result<Option<TrackRecord>> {
    let context = format!("tracks Datensatz {record}");
    let values = properties(feature, &context)?;
    counts.tracks_seen = counts.tracks_seen.saturating_add(1);
    if values.get("orderable").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    let id = string_field(values, "feature_id", &context)?.to_owned();
    let length_mm = i64_field(values, "length_mm", &context)?;
    let tags = parse_tags(values, &context)?;
    let railway = optional_tag(&tags, "railway").ok_or_else(|| {
        GermanyOperationalV2Error::new(format!(
            "{context} besitzt keine freigegebene OSM-Betriebsklassifikation."
        ))
    })?;
    require(
        railway == "rail",
        format!("{context} ist keine EBO-Gleiskante railway=rail."),
    )?;
    let (gauge_mm, gauge_lineage) = standard_gauge(&tags, &context)?;
    let oneway = optional_tag(&tags, "oneway");
    let bidirectional = oneway
        .as_deref()
        .is_none_or(|value| matches!(value, "no" | "0" | "false"));
    let mainline = tags
        .get("usage")
        .is_some_and(|usage| matches!(usage.as_str(), "main" | "highspeed"));
    let fallback = if mainline {
        policy.unknown_mainline_speed_kmh
    } else {
        policy.unknown_service_speed_kmh
    };
    let along_kmh = values
        .get("speed_forward_kmh")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0);
    let against_kmh = values
        .get("speed_backward_kmh")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0);
    if along_kmh.is_some() {
        counts.observed_forward_speeds = counts.observed_forward_speeds.saturating_add(1);
    } else {
        counts.simulated_speeds = counts.simulated_speeds.saturating_add(1);
    }
    if against_kmh.is_some() {
        counts.observed_backward_speeds = counts.observed_backward_speeds.saturating_add(1);
    } else {
        counts.simulated_speeds = counts.simulated_speeds.saturating_add(1);
    }
    let mut protection_systems = canonical_protection_systems(&tags);
    if protection_systems.is_empty() {
        protection_systems.insert(policy.default_protection_system.clone());
        counts.simulated_protection = counts.simulated_protection.saturating_add(1);
    } else {
        counts.observed_protection = counts.observed_protection.saturating_add(1);
    }
    counts.orderable_tracks = counts.orderable_tracks.saturating_add(1);
    Ok(Some(TrackRecord {
        id,
        from_node_id: i64_field(values, "from_osm_node_id", &context)?,
        to_node_id: i64_field(values, "to_osm_node_id", &context)?,
        length_mm,
        geometry: geometry_points(feature, length_mm, &context)?,
        speed_along_mmps: kmh_to_mmps(along_kmh.unwrap_or(fallback)).max(1),
        speed_against_mmps: kmh_to_mmps(against_kmh.unwrap_or(fallback)).max(1),
        protection_systems,
        railway,
        service: optional_tag(&tags, "service"),
        orderable: true,
        gauge_mm,
        gauge_lineage,
        electrified: optional_tag(&tags, "electrified"),
        voltage: optional_tag(&tags, "voltage"),
        frequency: optional_tag(&tags, "frequency"),
        bidirectional,
        osm_way_id: i64_field(values, "osm_way_id", &context)?,
        track_ref: optional_tag(&tags, "railway:track_ref"),
        quality_class: string_field(values, "quality_class", &context)?.to_owned(),
        source_id: string_field(values, "source_id", &context)?.to_owned(),
        geometry_lineage: string_field(values, "model_state", &context)?.to_owned(),
    }))
}

fn grid_cell(value: i32, size: i32) -> i32 {
    value.div_euclid(size.max(1))
}

fn grid_key(x: i32, y: i32) -> String {
    format!("{x:+011}:{y:+011}")
}

fn snap_e7(distance_mm: i64) -> i32 {
    let units = distance_mm.saturating_add(10) / 11;
    i32::try_from(units.clamp(1, i64::from(i32::MAX))).unwrap_or(i32::MAX)
}

fn initialize_database(database: &Database) -> Result<()> {
    let transaction = database.begin_write().map_err(db_error)?;
    for definition in [
        TRACKS,
        SWITCH_BY_NODE,
        PLATFORMS,
        TIMETABLE_ROUTES,
        TURNAROUND_ROUTES,
        TURNAROUND_INTERLOCKING,
        TURNAROUND_TEMPLATES,
        DIRECT_TEMPLATES,
        TRANSFER_ROUTES,
        TRANSFER_INTERLOCKING,
        TRANSFER_TEMPLATES,
    ] {
        drop(transaction.open_table(definition).map_err(db_error)?);
    }
    for definition in [NODES, SWITCHES, SIGNALS, BLOCKS_EVIDENCE, BLOCK_RESOURCES] {
        drop(transaction.open_table(definition).map_err(db_error)?);
    }
    drop(
        transaction
            .open_multimap_table(SPATIAL_TRACKS)
            .map_err(db_error)?,
    );
    drop(
        transaction
            .open_multimap_table(TRACK_BLOCKS)
            .map_err(db_error)?,
    );
    drop(
        transaction
            .open_multimap_table(TRACKS_BY_NODE)
            .map_err(db_error)?,
    );
    drop(
        transaction
            .open_multimap_table(TIMETABLE_ROUTES_BY_START)
            .map_err(db_error)?,
    );
    transaction.commit().map_err(db_error)
}

fn track_from_json(value: &str, context: &str) -> Result<TrackRecord> {
    serde_json::from_str(value)
        .map_err(|error| GermanyOperationalV2Error::new(format!("{context}: {error}")))
}

fn node_resource(node: i64) -> String {
    format!("resource:synthetic-stellzone-node:{node}")
}

fn edge_resource(edge_id: &str) -> String {
    stable_id("resource:synthetic-path-edge:", &[edge_id])
}

fn self_loop_flank_resource(edge_id: &str) -> String {
    stable_id("resource:synthetic-self-loop-flank:", &[edge_id])
}

fn local_route_id(track_id: &str, direction: &str) -> String {
    stable_id("route:synthetic-local:", &[track_id, direction])
}

fn local_template_id(track_id: &str, direction: &str) -> String {
    stable_id("template:synthetic-local:", &[track_id, direction])
}

fn synthetic_signal_id(route_id: &str, leg_index: usize) -> String {
    stable_id(
        "signal:synthetic-boundary:",
        &[route_id, &leg_index.to_string()],
    )
}

fn turnaround_shunting_signal_id(route_id: &str) -> String {
    stable_id("signal:synthetic-turnaround-shunting:", &[route_id])
}

fn turnaround_shunting_interlocking_id(route_id: &str) -> String {
    stable_id("interlocking:synthetic-turnaround-shunting:", &[route_id])
}

fn ensure_output_absent(path: &Path, context: &str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(GermanyOperationalV2Error::new(format!(
            "{context} `{}` existiert bereits.",
            path.display()
        ))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(context, path, error)),
    }
}

fn ingest_tracks(
    database: &Database,
    path: &Path,
    relative: &str,
    policy: &PolicySpec,
    local_routes: bool,
    counts: &mut Counts,
) -> Result<FileEvidence> {
    let mut transaction = database.begin_write().map_err(db_error)?;
    transaction.set_durability(Durability::None);
    let mut tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    let mut nodes = transaction.open_table(NODES).map_err(db_error)?;
    let mut spatial = transaction
        .open_multimap_table(SPATIAL_TRACKS)
        .map_err(db_error)?;
    let mut tracks_by_node = transaction
        .open_multimap_table(TRACKS_BY_NODE)
        .map_err(db_error)?;
    let mut resources = transaction.open_table(BLOCK_RESOURCES).map_err(db_error)?;
    let mut signals = transaction.open_table(SIGNALS).map_err(db_error)?;
    let cell_size = snap_e7(policy.maximum_platform_snap_distance_mm);
    let evidence = scan_sequence(path, relative, |feature, record| {
        let Some(track) = track_record(&feature, policy, counts, record)? else {
            return Ok(());
        };
        let serialized = serde_json::to_string(&track).map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "Gleiskante kann nicht serialisiert werden: {error}"
            ))
        })?;
        require(
            tracks
                .insert(track.id.as_str(), serialized.as_str())
                .map_err(db_error)?
                .is_none(),
            format!("Doppelte Gleiskante `{}`.", track.id),
        )?;
        for node in [track.from_node_id, track.to_node_id] {
            let key = node.to_string();
            let _ = nodes.insert(key.as_str(), &()).map_err(db_error)?;
            tracks_by_node
                .insert(key.as_str(), track.id.as_str())
                .map_err(db_error)?;
            let node_mutex = node_resource(node);
            let _ = resources
                .insert(node_mutex.as_str(), &())
                .map_err(db_error)?;
        }
        let edge_mutex = edge_resource(&track.id);
        let _ = resources
            .insert(edge_mutex.as_str(), &())
            .map_err(db_error)?;
        if track.from_node_id == track.to_node_id {
            let self_flank = self_loop_flank_resource(&track.id);
            let _ = resources
                .insert(self_flank.as_str(), &())
                .map_err(db_error)?;
        }
        if local_routes {
            for direction in ["along", "against"] {
                let route_id = local_route_id(&track.id, direction);
                let signal_id = synthetic_signal_id(&route_id, 0);
                require(
                    signals
                        .insert(signal_id.as_str(), &())
                        .map_err(db_error)?
                        .is_none(),
                    format!("Kollidierende synthetische Signal-ID `{signal_id}`."),
                )?;
            }
        }
        for pair in track.geometry.windows(2) {
            let left = (pair[0].longitude_e7, pair[0].latitude_e7);
            let right = (pair[1].longitude_e7, pair[1].latitude_e7);
            let dx = i64::from(right.0) - i64::from(left.0);
            let dy = i64::from(right.1) - i64::from(left.1);
            let span = dx.unsigned_abs().max(dy.unsigned_abs());
            let steps = (span / u64::try_from(cell_size).unwrap_or(1)).saturating_add(1);
            for step in 0..=steps {
                let denominator = i128::from(steps.max(1));
                let longitude = i128::from(left.0)
                    .saturating_add(i128::from(dx).saturating_mul(i128::from(step)) / denominator);
                let latitude = i128::from(left.1)
                    .saturating_add(i128::from(dy).saturating_mul(i128::from(step)) / denominator);
                let x = grid_cell(i32::try_from(longitude).unwrap_or(left.0), cell_size);
                let y = grid_cell(i32::try_from(latitude).unwrap_or(left.1), cell_size);
                let key = grid_key(x, y);
                spatial
                    .insert(key.as_str(), track.id.as_str())
                    .map_err(db_error)?;
            }
        }
        Ok(())
    })?;
    drop(signals);
    drop(resources);
    drop(spatial);
    drop(tracks_by_node);
    drop(nodes);
    drop(tracks);
    transaction.commit().map_err(db_error)?;
    require(
        counts.orderable_tracks > 0,
        "Tracks-Layer besitzt keine orderable Gleiskante.",
    )?;
    Ok(evidence)
}

fn ingest_preflight_tracks(
    database: &Database,
    path: &Path,
    relative: &str,
    policy: &PolicySpec,
    counts: &mut Counts,
) -> Result<FileEvidence> {
    let mut transaction = database.begin_write().map_err(db_error)?;
    transaction.set_durability(Durability::None);
    let mut tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    let mut tracks_by_node = transaction
        .open_multimap_table(TRACKS_BY_NODE)
        .map_err(db_error)?;
    let evidence = scan_sequence(path, relative, |feature, record| {
        let Some(track) = track_record(&feature, policy, counts, record)? else {
            return Ok(());
        };
        let serialized = serde_json::to_string(&track).map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "Preflight-Gleiskante kann nicht serialisiert werden: {error}"
            ))
        })?;
        require(
            tracks
                .insert(track.id.as_str(), serialized.as_str())
                .map_err(db_error)?
                .is_none(),
            format!("Doppelte Preflight-Gleiskante `{}`.", track.id),
        )?;
        for node in [track.from_node_id, track.to_node_id] {
            let key = node.to_string();
            tracks_by_node
                .insert(key.as_str(), track.id.as_str())
                .map_err(db_error)?;
        }
        Ok(())
    })?;
    drop(tracks_by_node);
    drop(tracks);
    transaction.commit().map_err(db_error)?;
    Ok(evidence)
}

fn ingest_switches(
    database: &Database,
    path: &Path,
    relative: &str,
    counts: &mut Counts,
) -> Result<FileEvidence> {
    let mut transaction = database.begin_write().map_err(db_error)?;
    transaction.set_durability(Durability::None);
    let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    let mut switches = transaction.open_table(SWITCHES).map_err(db_error)?;
    let mut by_node = transaction.open_table(SWITCH_BY_NODE).map_err(db_error)?;
    let evidence = scan_sequence(path, relative, |feature, record| {
        let context = format!("switches Datensatz {record}");
        let values = properties(&feature, &context)?;
        let id = string_field(values, "feature_id", &context)?;
        let node = i64_field(values, "osm_node_id", &context)?.to_string();
        let incident_track_ids = parse_string_array_json(
            string_field(values, "incident_track_ids_json", &context)?,
            &format!("{context}.incident_track_ids_json"),
            true,
        )?;
        for track_id in incident_track_ids {
            require(
                tracks.get(track_id.as_str()).map_err(db_error)?.is_some(),
                format!(
                    "{context}.incident_track_ids_json referenziert unbekanntes orderable Gleis `{track_id}`."
                ),
            )?;
        }
        require(
            switches.insert(id, &()).map_err(db_error)?.is_none(),
            format!("Doppelte Weiche `{id}`."),
        )?;
        require(
            by_node
                .insert(node.as_str(), id)
                .map_err(db_error)?
                .is_none(),
            format!("Mehrere Weichen am OSM-Knoten `{node}`."),
        )?;
        counts.switches = counts.switches.saturating_add(1);
        Ok(())
    })?;
    drop(by_node);
    drop(switches);
    drop(tracks);
    transaction.commit().map_err(db_error)?;
    Ok(evidence)
}

fn ingest_signals(
    database: &Database,
    path: &Path,
    relative: &str,
    counts: &mut Counts,
) -> Result<FileEvidence> {
    let mut transaction = database.begin_write().map_err(db_error)?;
    transaction.set_durability(Durability::None);
    let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    let mut signals = transaction.open_table(SIGNALS).map_err(db_error)?;
    let evidence = scan_sequence(path, relative, |feature, record| {
        let context = format!("signals Datensatz {record}");
        let values = properties(&feature, &context)?;
        let id = string_field(values, "feature_id", &context)?;
        let incident_track_ids = parse_string_array_json(
            string_field(values, "incident_track_ids_json", &context)?,
            &format!("{context}.incident_track_ids_json"),
            true,
        )?;
        for track_id in incident_track_ids {
            require(
                tracks.get(track_id.as_str()).map_err(db_error)?.is_some(),
                format!(
                    "{context}.incident_track_ids_json referenziert unbekanntes orderable Gleis `{track_id}`."
                ),
            )?;
        }
        require(
            signals.insert(id, &()).map_err(db_error)?.is_none(),
            format!("Doppeltes Signal `{id}`."),
        )?;
        counts.observed_signals = counts.observed_signals.saturating_add(1);
        Ok(())
    })?;
    drop(signals);
    drop(tracks);
    transaction.commit().map_err(db_error)?;
    Ok(evidence)
}

fn ingest_blocks(
    database: &Database,
    path: &Path,
    relative: &str,
    counts: &mut Counts,
) -> Result<FileEvidence> {
    let mut transaction = database.begin_write().map_err(db_error)?;
    transaction.set_durability(Durability::None);
    let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    let signals = transaction.open_table(SIGNALS).map_err(db_error)?;
    let mut blocks = transaction.open_table(BLOCKS_EVIDENCE).map_err(db_error)?;
    let evidence = scan_sequence(path, relative, |feature, record| {
        let context = format!("blocks Datensatz {record}");
        let values = properties(&feature, &context)?;
        let id = string_field(values, "feature_id", &context)?.to_owned();
        let track_ids = parse_string_array_json(
            string_field(values, "track_ids_json", &context)?,
            &format!("{context}.track_ids_json"),
            false,
        )?;
        for track_id in track_ids {
            require(
                tracks.get(track_id.as_str()).map_err(db_error)?.is_some(),
                format!(
                    "{context}.track_ids_json referenziert unbekanntes orderable Gleis `{track_id}`."
                ),
            )?;
        }
        let boundary_signal_ids = parse_string_array_json(
            string_field(values, "boundary_signal_ids_json", &context)?,
            &format!("{context}.boundary_signal_ids_json"),
            true,
        )?;
        for signal_id in boundary_signal_ids {
            require(
                signals.get(signal_id.as_str()).map_err(db_error)?.is_some(),
                format!(
                    "{context}.boundary_signal_ids_json referenziert unbekanntes Signal `{signal_id}`."
                ),
            )?;
        }
        require(
            blocks.insert(id.as_str(), &()).map_err(db_error)?.is_none(),
            format!("Doppelter Block `{id}`."),
        )?;
        counts.blocks = counts.blocks.saturating_add(1);
        Ok(())
    })?;
    drop(blocks);
    drop(signals);
    drop(tracks);
    transaction.commit().map_err(db_error)?;
    Ok(evidence)
}

fn parse_string_array_json(raw: &str, context: &str, allow_empty: bool) -> Result<Vec<String>> {
    let values: Vec<String> = serde_json::from_str(raw).map_err(|error| {
        GermanyOperationalV2Error::new(format!("{context} ist ungueltig: {error}"))
    })?;
    require(
        (allow_empty || !values.is_empty()) && values.iter().all(|value| !value.is_empty()),
        format!("{context} ist leer oder enthaelt leere IDs."),
    )?;
    Ok(values)
}

fn ingest_conflict_resources(
    database: &Database,
    path: &Path,
    relative: &str,
    counts: &mut Counts,
) -> Result<FileEvidence> {
    let mut transaction = database.begin_write().map_err(db_error)?;
    transaction.set_durability(Durability::None);
    let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    let blocks = transaction.open_table(BLOCKS_EVIDENCE).map_err(db_error)?;
    let switches = transaction.open_table(SWITCHES).map_err(db_error)?;
    let mut resources = transaction.open_table(BLOCK_RESOURCES).map_err(db_error)?;
    let mut track_blocks = transaction
        .open_multimap_table(TRACK_BLOCKS)
        .map_err(db_error)?;
    let evidence = scan_sequence(path, relative, |feature, record| {
        let context = format!("conflictResources Datensatz {record}");
        let values = properties(&feature, &context)?;
        let id = string_field(values, "feature_id", &context)?;
        let resource_kind = string_field(values, "resource_kind", &context)?;
        require(
            matches!(resource_kind, "block" | "switch" | "track_section"),
            format!("{context}.resource_kind `{resource_kind}` ist unbekannt."),
        )?;
        match resource_kind {
            "block" => {
                let block_id = string_field(values, "block_id", &context)?;
                require(
                    blocks.get(block_id).map_err(db_error)?.is_some(),
                    format!("{context}.block_id referenziert unbekannten Block `{block_id}`."),
                )?;
            }
            "switch" => {
                let switch_id = string_field(values, "switch_id", &context)?;
                require(
                    switches.get(switch_id).map_err(db_error)?.is_some(),
                    format!("{context}.switch_id referenziert unbekannte Weiche `{switch_id}`."),
                )?;
            }
            "track_section" => {}
            _ => unreachable!("resource_kind wurde oben vollstaendig validiert"),
        }
        require(
            resources.insert(id, &()).map_err(db_error)?.is_none(),
            format!("Doppelte Konfliktressource `{id}`."),
        )?;
        let track_ids_field = if resource_kind == "switch" {
            "incident_track_ids_json"
        } else {
            "track_ids_json"
        };
        let track_ids = parse_string_array_json(
            string_field(values, track_ids_field, &context)?,
            &format!("{context}.{track_ids_field}"),
            false,
        )?;
        for track_id in track_ids {
            require(
                tracks.get(track_id.as_str()).map_err(db_error)?.is_some(),
                format!(
                    "{context}.{track_ids_field} referenziert unbekanntes orderable Gleis `{track_id}`."
                ),
            )?;
            track_blocks
                .insert(track_id.as_str(), id)
                .map_err(db_error)?;
        }
        counts.conflict_resources = counts.conflict_resources.saturating_add(1);
        Ok(())
    })?;
    drop(track_blocks);
    drop(resources);
    drop(switches);
    drop(blocks);
    drop(tracks);
    transaction.commit().map_err(db_error)?;
    Ok(evidence)
}

#[derive(Clone, Debug)]
enum PlatformGeometry {
    Point((i32, i32)),
    LineString(Vec<(i32, i32)>),
    Polygon(Vec<Vec<(i32, i32)>>),
}

impl PlatformGeometry {
    fn for_each_point(&self, mut visitor: impl FnMut((i32, i32))) {
        match self {
            Self::Point(point) => visitor(*point),
            Self::LineString(points) => points.iter().copied().for_each(visitor),
            Self::Polygon(rings) => rings
                .iter()
                .flat_map(|ring| ring.iter().copied())
                .for_each(visitor),
        }
    }

    fn for_each_segment(&self, mut visitor: impl FnMut((i32, i32), (i32, i32))) {
        match self {
            Self::Point(_) => {}
            Self::LineString(points) => {
                for pair in points.windows(2) {
                    visitor(pair[0], pair[1]);
                }
            }
            Self::Polygon(rings) => {
                for ring in rings {
                    for pair in ring.windows(2) {
                        visitor(pair[0], pair[1]);
                    }
                }
            }
        }
    }
}

fn coordinate_sequence(value: &Value, context: &str) -> Result<Vec<(i32, i32)>> {
    let raw = value
        .as_array()
        .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context} ist kein Array.")))?;
    raw.iter()
        .enumerate()
        .map(|(index, coordinate)| coordinate_e7(coordinate, &format!("{context}[{index}]")))
        .collect()
}

fn platform_geometry(feature: &Value, context: &str) -> Result<PlatformGeometry> {
    let geometry = object(
        object(feature, context)?
            .get("geometry")
            .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context}.geometry fehlt.")))?,
        &format!("{context}.geometry"),
    )?;
    let geometry_type = geometry
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context}.geometry.type fehlt.")))?;
    let coordinates = geometry.get("coordinates").ok_or_else(|| {
        GermanyOperationalV2Error::new(format!("{context}.geometry.coordinates fehlt."))
    })?;
    match geometry_type {
        "Point" => Ok(PlatformGeometry::Point(coordinate_e7(
            coordinates,
            &format!("{context}.geometry.coordinates"),
        )?)),
        "LineString" => {
            let points =
                coordinate_sequence(coordinates, &format!("{context}.geometry.coordinates"))?;
            require(
                points.len() >= 2 && points.windows(2).all(|pair| pair[0] != pair[1]),
                format!(
                    "{context}.geometry LineString benoetigt mindestens zwei aufeinanderfolgend verschiedene Punkte."
                ),
            )?;
            Ok(PlatformGeometry::LineString(points))
        }
        "Polygon" => {
            let raw_rings = coordinates
                .as_array()
                .filter(|rings| !rings.is_empty())
                .ok_or_else(|| {
                    GermanyOperationalV2Error::new(format!(
                        "{context}.geometry Polygon besitzt keine Ringe."
                    ))
                })?;
            let mut rings = Vec::with_capacity(raw_rings.len());
            for (ring_index, raw_ring) in raw_rings.iter().enumerate() {
                let ring_context = format!("{context}.geometry.coordinates[{ring_index}]");
                let ring = coordinate_sequence(raw_ring, &ring_context)?;
                require(
                    ring.len() >= 4,
                    format!("{ring_context} besitzt weniger als vier Positionen."),
                )?;
                require(
                    ring.first() == ring.last(),
                    format!("{ring_context} ist nicht geschlossen."),
                )?;
                require(
                    ring.windows(2).all(|pair| pair[0] != pair[1]),
                    format!("{ring_context} besitzt aufeinanderfolgende Doppelpositionen."),
                )?;
                let distinct: BTreeSet<_> = ring[..ring.len() - 1].iter().copied().collect();
                require(
                    distinct.len() >= 3,
                    format!("{ring_context} besitzt weniger als drei verschiedene Eckpunkte."),
                )?;
                rings.push(ring);
            }
            Ok(PlatformGeometry::Polygon(rings))
        }
        unsupported => Err(GermanyOperationalV2Error::new(format!(
            "{context}.geometry Typ `{unsupported}` ist nicht unterstuetzt; erwartet Point, LineString oder Polygon."
        ))),
    }
}

fn point_segment_projection(
    point: (i32, i32),
    left: (i32, i32),
    right: (i32, i32),
) -> (u128, i128, i128) {
    let left = (i128::from(left.0), i128::from(left.1));
    let right = (i128::from(right.0), i128::from(right.1));
    let vector = (right.0 - left.0, right.1 - left.1);
    let denominator = vector
        .0
        .saturating_mul(vector.0)
        .saturating_add(vector.1.saturating_mul(vector.1));
    if denominator == 0 {
        let dx = i128::from(point.0) - left.0;
        let dy = i128::from(point.1) - left.1;
        return (
            u128::try_from(dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy)))
                .unwrap_or(u128::MAX),
            0,
            1,
        );
    }
    let relative = (i128::from(point.0) - left.0, i128::from(point.1) - left.1);
    let numerator = relative
        .0
        .saturating_mul(vector.0)
        .saturating_add(relative.1.saturating_mul(vector.1))
        .clamp(0, denominator);
    let projected = (
        left.0 + vector.0.saturating_mul(numerator) / denominator,
        left.1 + vector.1.saturating_mul(numerator) / denominator,
    );
    let dx = i128::from(point.0) - projected.0;
    let dy = i128::from(point.1) - projected.1;
    (
        u128::try_from(dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy)))
            .unwrap_or(u128::MAX),
        numerator,
        denominator,
    )
}

fn track_offset_at_fraction(
    left: &GeometryPoint,
    right: &GeometryPoint,
    numerator: i128,
    denominator: i128,
) -> i64 {
    let segment_mm = right.edge_offset_mm.saturating_sub(left.edge_offset_mm);
    left.edge_offset_mm.saturating_add(
        i64::try_from(i128::from(segment_mm).saturating_mul(numerator) / denominator.max(1))
            .unwrap_or(0),
    )
}

fn nearest_on_track(track: &TrackRecord, point: (i32, i32)) -> (u128, i64) {
    let mut best = (u128::MAX, 0_i64);
    for pair in track.geometry.windows(2) {
        let left = (pair[0].longitude_e7, pair[0].latitude_e7);
        let right = (pair[1].longitude_e7, pair[1].latitude_e7);
        let (squared, numerator, denominator) = point_segment_projection(point, left, right);
        let projected_mm = track_offset_at_fraction(&pair[0], &pair[1], numerator, denominator);
        best = best.min((squared, projected_mm));
    }
    best
}

fn cross(left: (i128, i128), right: (i128, i128)) -> i128 {
    left.0
        .saturating_mul(right.1)
        .saturating_sub(left.1.saturating_mul(right.0))
}

fn segment_intersection_track_fraction(
    track_left: (i32, i32),
    track_right: (i32, i32),
    geometry_left: (i32, i32),
    geometry_right: (i32, i32),
) -> Option<(i128, i128)> {
    let track_left = (i128::from(track_left.0), i128::from(track_left.1));
    let track_vector = (
        i128::from(track_right.0) - track_left.0,
        i128::from(track_right.1) - track_left.1,
    );
    let geometry_left = (i128::from(geometry_left.0), i128::from(geometry_left.1));
    let geometry_vector = (
        i128::from(geometry_right.0) - geometry_left.0,
        i128::from(geometry_right.1) - geometry_left.1,
    );
    let delta = (
        geometry_left.0 - track_left.0,
        geometry_left.1 - track_left.1,
    );
    let mut denominator = cross(track_vector, geometry_vector);
    if denominator != 0 {
        let mut track_numerator = cross(delta, geometry_vector);
        let mut geometry_numerator = cross(delta, track_vector);
        if denominator < 0 {
            denominator = -denominator;
            track_numerator = -track_numerator;
            geometry_numerator = -geometry_numerator;
        }
        return ((0..=denominator).contains(&track_numerator)
            && (0..=denominator).contains(&geometry_numerator))
        .then_some((track_numerator, denominator));
    }
    if cross(delta, track_vector) != 0 {
        return None;
    }
    let norm = track_vector
        .0
        .saturating_mul(track_vector.0)
        .saturating_add(track_vector.1.saturating_mul(track_vector.1));
    if norm == 0 {
        return None;
    }
    let geometry_end = (
        geometry_left.0 + geometry_vector.0,
        geometry_left.1 + geometry_vector.1,
    );
    let projection = |point: (i128, i128)| {
        (point.0 - track_left.0)
            .saturating_mul(track_vector.0)
            .saturating_add((point.1 - track_left.1).saturating_mul(track_vector.1))
    };
    let first = projection(geometry_left);
    let second = projection(geometry_end);
    let overlap_start = first.min(second).max(0);
    let overlap_end = first.max(second).min(norm);
    (overlap_start <= overlap_end).then_some((overlap_start, norm))
}

fn point_on_segment(point: (i32, i32), left: (i32, i32), right: (i32, i32)) -> bool {
    let relative = (
        i128::from(point.0) - i128::from(left.0),
        i128::from(point.1) - i128::from(left.1),
    );
    let vector = (
        i128::from(right.0) - i128::from(left.0),
        i128::from(right.1) - i128::from(left.1),
    );
    cross(relative, vector) == 0
        && point.0 >= left.0.min(right.0)
        && point.0 <= left.0.max(right.0)
        && point.1 >= left.1.min(right.1)
        && point.1 <= left.1.max(right.1)
}

fn point_in_polygon(point: (i32, i32), rings: &[Vec<(i32, i32)>]) -> bool {
    let mut inside = false;
    for ring in rings {
        for pair in ring.windows(2) {
            let left = pair[0];
            let right = pair[1];
            if point_on_segment(point, left, right) {
                return true;
            }
            if (left.1 > point.1) == (right.1 > point.1) {
                continue;
            }
            let dy = i128::from(right.1) - i128::from(left.1);
            let left_side = (i128::from(point.0) - i128::from(left.0)).saturating_mul(dy);
            let right_side = (i128::from(right.0) - i128::from(left.0))
                .saturating_mul(i128::from(point.1) - i128::from(left.1));
            if (dy > 0 && left_side < right_side) || (dy < 0 && left_side > right_side) {
                inside = !inside;
            }
        }
    }
    inside
}

fn nearest_on_track_to_geometry(track: &TrackRecord, geometry: &PlatformGeometry) -> (u128, i64) {
    let mut best = (u128::MAX, 0_i64);
    geometry.for_each_point(|point| {
        best = best.min(nearest_on_track(track, point));
    });
    geometry.for_each_segment(|geometry_left, geometry_right| {
        for pair in track.geometry.windows(2) {
            let track_left = (pair[0].longitude_e7, pair[0].latitude_e7);
            let track_right = (pair[1].longitude_e7, pair[1].latitude_e7);
            if let Some((numerator, denominator)) = segment_intersection_track_fraction(
                track_left,
                track_right,
                geometry_left,
                geometry_right,
            ) {
                best = best.min((
                    0,
                    track_offset_at_fraction(&pair[0], &pair[1], numerator, denominator),
                ));
            }
            for (track_point, track_offset) in [
                (track_left, pair[0].edge_offset_mm),
                (track_right, pair[1].edge_offset_mm),
            ] {
                let (distance, _, _) =
                    point_segment_projection(track_point, geometry_left, geometry_right);
                best = best.min((distance, track_offset));
            }
        }
    });
    if let PlatformGeometry::Polygon(rings) = geometry {
        for point in &track.geometry {
            if point_in_polygon((point.longitude_e7, point.latitude_e7), rings) {
                best = best.min((0, point.edge_offset_mm));
            }
        }
    }
    best
}

fn insert_segment_search_cells(
    cells: &mut BTreeSet<(i32, i32)>,
    left: (i32, i32),
    right: (i32, i32),
    cell_size: i32,
    context: &str,
) -> Result<()> {
    let dx = i64::from(right.0) - i64::from(left.0);
    let dy = i64::from(right.1) - i64::from(left.1);
    let span = dx.unsigned_abs().max(dy.unsigned_abs());
    let steps = (span / u64::try_from(cell_size).unwrap_or(1)).saturating_add(1);
    require(
        u128::from(steps) <= MAX_PLATFORM_SEARCH_CELLS,
        format!("{context} ueberschreitet den Plattform-Suchraum."),
    )?;
    for step in 0..=steps {
        let denominator = i128::from(steps.max(1));
        let longitude = i128::from(left.0)
            .saturating_add(i128::from(dx).saturating_mul(i128::from(step)) / denominator);
        let latitude = i128::from(left.1)
            .saturating_add(i128::from(dy).saturating_mul(i128::from(step)) / denominator);
        cells.insert((
            grid_cell(i32::try_from(longitude).unwrap_or(left.0), cell_size),
            grid_cell(i32::try_from(latitude).unwrap_or(left.1), cell_size),
        ));
    }
    Ok(())
}

fn platform_search_cells(
    geometry: &PlatformGeometry,
    cell_size: i32,
    context: &str,
) -> Result<BTreeSet<(i32, i32)>> {
    let mut cells = BTreeSet::new();
    geometry.for_each_point(|point| {
        cells.insert((grid_cell(point.0, cell_size), grid_cell(point.1, cell_size)));
    });
    let mut segment_error = None;
    geometry.for_each_segment(|left, right| {
        if segment_error.is_none()
            && let Err(error) =
                insert_segment_search_cells(&mut cells, left, right, cell_size, context)
        {
            segment_error = Some(error);
        }
    });
    if let Some(error) = segment_error {
        return Err(error);
    }
    if let PlatformGeometry::Polygon(rings) = geometry {
        let mut minimum = (i32::MAX, i32::MAX);
        let mut maximum = (i32::MIN, i32::MIN);
        for point in rings.iter().flat_map(|ring| ring.iter().copied()) {
            minimum.0 = minimum.0.min(grid_cell(point.0, cell_size));
            minimum.1 = minimum.1.min(grid_cell(point.1, cell_size));
            maximum.0 = maximum.0.max(grid_cell(point.0, cell_size));
            maximum.1 = maximum.1.max(grid_cell(point.1, cell_size));
        }
        let width = i128::from(maximum.0) - i128::from(minimum.0) + 1;
        let height = i128::from(maximum.1) - i128::from(minimum.1) + 1;
        let cell_count = u128::try_from(width.saturating_mul(height)).unwrap_or(u128::MAX);
        require(
            cell_count <= MAX_PLATFORM_SEARCH_CELLS,
            format!("{context}.geometry Polygon ueberschreitet den Plattform-Suchraum."),
        )?;
        for x in minimum.0..=maximum.0 {
            for y in minimum.1..=maximum.1 {
                cells.insert((x, y));
            }
        }
    }
    Ok(cells)
}

fn ingest_platforms(
    database: &Database,
    path: &Path,
    relative: &str,
    policy: &PolicySpec,
    counts: &mut Counts,
) -> Result<FileEvidence> {
    let mut transaction = database.begin_write().map_err(db_error)?;
    transaction.set_durability(Durability::None);
    let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    let spatial = transaction
        .open_multimap_table(SPATIAL_TRACKS)
        .map_err(db_error)?;
    let mut platforms = transaction.open_table(PLATFORMS).map_err(db_error)?;
    let cell_size = snap_e7(policy.maximum_platform_snap_distance_mm);
    let maximum_squared =
        u128::from(u32::try_from(cell_size).unwrap_or(u32::MAX)).saturating_pow(2);
    let evidence = scan_sequence(path, relative, |feature, record| {
        counts.platforms_seen = counts.platforms_seen.saturating_add(1);
        let context = format!("platforms Datensatz {record}");
        let values = properties(&feature, &context)?;
        let platform_id = string_field(values, "feature_id", &context)?;
        let geometry = platform_geometry(&feature, &context)?;
        let mut candidates = BTreeSet::new();
        for (base_x, base_y) in platform_search_cells(&geometry, cell_size, &context)? {
            for x in base_x.saturating_sub(1)..=base_x.saturating_add(1) {
                for y in base_y.saturating_sub(1)..=base_y.saturating_add(1) {
                    let key = grid_key(x, y);
                    let mut values = spatial.get(key.as_str()).map_err(db_error)?;
                    while let Some(value) = values.next().transpose().map_err(db_error)? {
                        candidates.insert(value.value().to_owned());
                    }
                }
            }
        }
        let mut best: Option<(u128, String, i64, i64)> = None;
        for track_id in candidates {
            let serialized = tracks
                .get(track_id.as_str())
                .map_err(db_error)?
                .ok_or_else(|| {
                    GermanyOperationalV2Error::new(format!(
                        "Raumindex verweist auf unbekannte Kante `{track_id}`."
                    ))
                })?;
            let track = track_from_json(serialized.value(), "Gleiskante im Plattformabgleich")?;
            let (distance, offset) = nearest_on_track_to_geometry(&track, &geometry);
            if distance <= maximum_squared
                && best.as_ref().is_none_or(|current| {
                    (distance, track_id.as_str(), offset)
                        < (current.0, current.1.as_str(), current.2)
                })
            {
                best = Some((distance, track_id, offset, track.length_mm));
            }
        }
        let Some((_, edge_id, center_mm, edge_length)) = best else {
            counts.excluded_platform_evidence = counts.excluded_platform_evidence.saturating_add(1);
            return Ok(());
        };
        let interval_length = policy.minimum_platform_length_mm.min(edge_length).max(1);
        let mut from_mm = center_mm
            .saturating_sub(interval_length / 2)
            .clamp(0, edge_length.saturating_sub(interval_length));
        let to_mm = from_mm.saturating_add(interval_length).min(edge_length);
        if from_mm >= to_mm {
            from_mm = 0;
        }
        let interval = StoredPlatform {
            edge_id,
            from_mm,
            to_mm,
            direction: "along".to_owned(),
        };
        let serialized = serde_json::to_string(&interval).map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "Bahnsteigintervall kann nicht serialisiert werden: {error}"
            ))
        })?;
        require(
            platforms
                .insert(platform_id, serialized.as_str())
                .map_err(db_error)?
                .is_none(),
            format!("Doppelter Bahnsteig `{platform_id}`."),
        )?;
        counts.platform_intervals = counts.platform_intervals.saturating_add(1);
        Ok(())
    })?;
    drop(platforms);
    drop(spatial);
    drop(tracks);
    transaction.commit().map_err(db_error)?;
    Ok(evidence)
}

fn boundary_resource(track: &TrackRecord, offset_mm: i64) -> Result<String> {
    if offset_mm == 0 {
        Ok(node_resource(track.from_node_id))
    } else if offset_mm == track.length_mm {
        Ok(node_resource(track.to_node_id))
    } else if (0..track.length_mm).contains(&offset_mm) {
        Ok(stable_id(
            "resource:synthetic-section-boundary:",
            &[track.id.as_str(), offset_mm.to_string().as_str()],
        ))
    } else {
        Err(GermanyOperationalV2Error::new(format!(
            "Kantengrenze {offset_mm} liegt ausserhalb `{}`.",
            track.id
        )))
    }
}

fn node_at_offset(track: &TrackRecord, offset_mm: i64) -> Option<i64> {
    if offset_mm == 0 {
        Some(track.from_node_id)
    } else if offset_mm == track.length_mm {
        Some(track.to_node_id)
    } else {
        None
    }
}

fn reverse_direction(direction: &str) -> Result<&'static str> {
    match direction {
        "along" => Ok("against"),
        "against" => Ok("along"),
        _ => Err(GermanyOperationalV2Error::new(format!(
            "Unbekannte Gleisrichtung `{direction}`."
        ))),
    }
}

fn timetable_route_start_key(leg: &TimetableLegInput) -> String {
    timetable_route_start_key_parts(&leg.edge_id, &leg.direction, leg.edge_entry_mm)
}

fn timetable_route_start_key_parts(edge_id: &str, direction: &str, edge_entry_mm: i64) -> String {
    format!(
        "{}:{}:{}:{}",
        edge_id.len(),
        edge_id,
        direction,
        edge_entry_mm
    )
}

fn validate_timetable_leg(
    track: &TrackRecord,
    leg: &TimetableLegInput,
    context: &str,
) -> Result<i64> {
    require(!leg.edge_id.is_empty(), format!("{context}.edgeId fehlt."))?;
    require(
        (0..=track.length_mm).contains(&leg.edge_entry_mm)
            && (0..=track.length_mm).contains(&leg.edge_exit_mm),
        format!("{context} liegt ausserhalb der Kante `{}`.", track.id),
    )?;
    let direction_valid = match leg.direction.as_str() {
        "along" => leg.edge_exit_mm > leg.edge_entry_mm,
        "against" => leg.edge_exit_mm < leg.edge_entry_mm,
        _ => false,
    };
    require(
        direction_valid,
        format!("{context} besitzt ungueltige Richtung oder Offsets."),
    )?;
    let track_protection_systems = track.protection_systems.iter().cloned().collect::<Vec<_>>();
    require(
        !leg.available_protection_systems.is_empty()
            && leg
                .available_protection_systems
                .windows(2)
                .all(|pair| pair[0] < pair[1])
            && leg.available_protection_systems == track_protection_systems,
        format!(
            "{context}.availableProtectionSystems ist nicht die kanonische streckenseitige Alternativenmenge."
        ),
    )?;
    require(
        leg.simultaneously_required_protection_systems
            .windows(2)
            .all(|pair| pair[0] < pair[1])
            && leg
                .simultaneously_required_protection_systems
                .iter()
                .all(|system| leg.available_protection_systems.contains(system)),
        format!(
            "{context}.simultaneouslyRequiredProtectionSystems ist nicht kanonisch oder semantisch unmoeglich."
        ),
    )?;
    Ok(i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm)).unwrap_or(i64::MAX))
}

fn ingest_timetable_routes(
    database: &Database,
    path: &Path,
    relative: &str,
    counts: &mut Counts,
) -> Result<FileEvidence> {
    let mut transaction = database.begin_write().map_err(db_error)?;
    transaction.set_durability(Durability::None);
    let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    let mut routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    let mut routes_by_start = transaction
        .open_multimap_table(TIMETABLE_ROUTES_BY_START)
        .map_err(db_error)?;
    let mut signals = transaction.open_table(SIGNALS).map_err(db_error)?;
    let mut resources = transaction.open_table(BLOCK_RESOURCES).map_err(db_error)?;
    let evidence = scan_sequence(path, relative, |value, record| {
        let context = format!("timetableRoutes Datensatz {record}");
        exact_keys(
            &value,
            &[
                "routeVersionId",
                "templateId",
                "predecessorId",
                "transitionRouteMm",
                "legs",
            ],
            &context,
        )?;
        if let Some(legs) = value.get("legs").and_then(Value::as_array) {
            for (index, leg) in legs.iter().enumerate() {
                exact_keys(
                    leg,
                    &[
                        "edgeId",
                        "direction",
                        "edgeEntryMm",
                        "edgeExitMm",
                        "availableProtectionSystems",
                        "simultaneouslyRequiredProtectionSystems",
                    ],
                    &format!("{context}.legs[{index}]"),
                )?;
            }
        }
        let route: TimetableRouteInput = serde_json::from_value(value).map_err(|error| {
            GermanyOperationalV2Error::new(format!("{context} ist ungueltig: {error}"))
        })?;
        require(
            !route.route_version_id.is_empty()
                && !route.template_id.is_empty()
                && !route.legs.is_empty(),
            format!("{context} ist unvollstaendig."),
        )?;
        require(
            route.predecessor_id.is_some() == route.transition_route_mm.is_some(),
            format!("{context} muss predecessorId und transitionRouteMm gemeinsam setzen."),
        )?;
        let mut previous: Option<(TimetableLegInput, TrackRecord)> = None;
        let mut route_length = 0_i64;
        for (leg_index, leg) in route.legs.iter().enumerate() {
            let serialized = tracks
                .get(leg.edge_id.as_str())
                .map_err(db_error)?
                .ok_or_else(|| {
                    GermanyOperationalV2Error::new(format!(
                        "{context}.legs[{leg_index}] verweist auf unbekannte Kante `{}`.",
                        leg.edge_id
                    ))
                })?;
            let track = track_from_json(serialized.value(), "Timetable-Kantenreferenz")?;
            let length =
                validate_timetable_leg(&track, leg, &format!("{context}.legs[{leg_index}]"))?;
            route_length = route_length.checked_add(length).ok_or_else(|| {
                GermanyOperationalV2Error::new(format!("{context} laeuft in der Laenge ueber."))
            })?;
            require(
                route_length <= MAX_SAFE_INTEGER,
                format!("{context} ueberschreitet sichere Ganzzahlen."),
            )?;
            if let Some((previous_leg, previous_track)) = &previous {
                if previous_leg.edge_id == leg.edge_id {
                    require(
                        previous_leg.edge_exit_mm == leg.edge_entry_mm,
                        format!(
                            "{context}.legs[{leg_index}] schliesst auf derselben Kante nicht lueckenlos an."
                        ),
                    )?;
                } else {
                    let previous_node = node_at_offset(previous_track, previous_leg.edge_exit_mm);
                    let next_node = node_at_offset(&track, leg.edge_entry_mm);
                    require(
                        previous_node.is_some() && previous_node == next_node,
                        format!(
                            "{context}.legs[{leg_index}] besitzt keine lueckenlose gemeinsame Knotengrenze."
                        ),
                    )?;
                }
            }
            for offset in [leg.edge_entry_mm, leg.edge_exit_mm] {
                let resource = boundary_resource(&track, offset)?;
                let _ = resources.insert(resource.as_str(), &()).map_err(db_error)?;
            }
            let signal_id = synthetic_signal_id(&route.route_version_id, leg_index);
            require(
                signals
                    .insert(signal_id.as_str(), &())
                    .map_err(db_error)?
                    .is_none(),
                format!("Kollidierende synthetische Signal-ID `{signal_id}`."),
            )?;
            previous = Some((leg.clone(), track));
            counts.timetable_legs = counts.timetable_legs.saturating_add(1);
        }
        if let Some(transition) = route.transition_route_mm {
            require(
                (0..=route_length).contains(&transition),
                format!("{context}.transitionRouteMm liegt ausserhalb des Laufwegs."),
            )?;
        }
        let serialized = serde_json::to_string(&route).map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "{context} kann nicht serialisiert werden: {error}"
            ))
        })?;
        require(
            routes
                .insert(route.route_version_id.as_str(), serialized.as_str())
                .map_err(db_error)?
                .is_none(),
            format!("Doppelte routeVersionId `{}`.", route.route_version_id),
        )?;
        let start_key = timetable_route_start_key(
            route
                .legs
                .first()
                .expect("vollstaendiger Timetable-Laufweg besitzt ein erstes Leg"),
        );
        routes_by_start
            .insert(start_key.as_str(), route.route_version_id.as_str())
            .map_err(db_error)?;
        counts.timetable_routes = counts.timetable_routes.saturating_add(1);
        Ok(())
    })?;
    drop(resources);
    drop(signals);
    drop(routes_by_start);
    drop(routes);
    drop(tracks);
    transaction.commit().map_err(db_error)?;
    require(
        counts.timetable_routes > 0,
        "timetableRoutes-Layer ist leer.",
    )?;

    let read = database.begin_read().map_err(db_error)?;
    let routes = read.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    for entry in routes.iter().map_err(db_error)? {
        let (_, serialized) = entry.map_err(db_error)?;
        let route: TimetableRouteInput =
            serde_json::from_str(serialized.value()).map_err(|error| {
                GermanyOperationalV2Error::new(format!("Timetable-Index ist ungueltig: {error}"))
            })?;
        if let Some(predecessor) = route.predecessor_id {
            require(
                predecessor != route.route_version_id
                    && routes
                        .get(predecessor.as_str())
                        .map_err(db_error)?
                        .is_some(),
                format!(
                    "Laufweg `{}` verweist auf unbekannten oder eigenen Vorgaenger `{predecessor}`.",
                    route.route_version_id
                ),
            )?;
        }
    }
    Ok(evidence)
}

fn ingest_preflight_timetable_routes(
    database: &Database,
    path: &Path,
    relative: &str,
    counts: &mut Counts,
) -> Result<FileEvidence> {
    let mut transaction = database.begin_write().map_err(db_error)?;
    transaction.set_durability(Durability::None);
    let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    let mut routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    let evidence = scan_sequence(path, relative, |value, record| {
        let context = format!("timetableRoutes Preflight-Datensatz {record}");
        exact_keys(
            &value,
            &[
                "routeVersionId",
                "templateId",
                "predecessorId",
                "transitionRouteMm",
                "legs",
            ],
            &context,
        )?;
        if let Some(legs) = value.get("legs").and_then(Value::as_array) {
            for (index, leg) in legs.iter().enumerate() {
                exact_keys(
                    leg,
                    &[
                        "edgeId",
                        "direction",
                        "edgeEntryMm",
                        "edgeExitMm",
                        "availableProtectionSystems",
                        "simultaneouslyRequiredProtectionSystems",
                    ],
                    &format!("{context}.legs[{index}]"),
                )?;
            }
        }
        let route: TimetableRouteInput = serde_json::from_value(value).map_err(|error| {
            GermanyOperationalV2Error::new(format!("{context} ist ungueltig: {error}"))
        })?;
        require(
            !route.route_version_id.is_empty()
                && !route.template_id.is_empty()
                && !route.legs.is_empty(),
            format!("{context} ist unvollstaendig."),
        )?;
        require(
            route.predecessor_id.is_some() == route.transition_route_mm.is_some(),
            format!("{context} muss predecessorId und transitionRouteMm gemeinsam setzen."),
        )?;
        let mut previous: Option<(TimetableLegInput, TrackRecord)> = None;
        let mut route_length = 0_i64;
        for (leg_index, leg) in route.legs.iter().enumerate() {
            let serialized = tracks
                .get(leg.edge_id.as_str())
                .map_err(db_error)?
                .ok_or_else(|| {
                    GermanyOperationalV2Error::new(format!(
                        "{context}.legs[{leg_index}] verweist auf unbekannte Kante `{}`.",
                        leg.edge_id
                    ))
                })?;
            let track = track_from_json(serialized.value(), "Preflight-Timetable-Kantenreferenz")?;
            let length =
                validate_timetable_leg(&track, leg, &format!("{context}.legs[{leg_index}]"))?;
            route_length = route_length.checked_add(length).ok_or_else(|| {
                GermanyOperationalV2Error::new(format!("{context} laeuft in der Laenge ueber."))
            })?;
            require(
                route_length <= MAX_SAFE_INTEGER,
                format!("{context} ueberschreitet sichere Ganzzahlen."),
            )?;
            if let Some((previous_leg, previous_track)) = &previous {
                if previous_leg.edge_id == leg.edge_id {
                    require(
                        previous_leg.edge_exit_mm == leg.edge_entry_mm,
                        format!(
                            "{context}.legs[{leg_index}] schliesst auf derselben Kante nicht lueckenlos an."
                        ),
                    )?;
                } else {
                    let previous_node = node_at_offset(previous_track, previous_leg.edge_exit_mm);
                    let next_node = node_at_offset(&track, leg.edge_entry_mm);
                    require(
                        previous_node.is_some() && previous_node == next_node,
                        format!(
                            "{context}.legs[{leg_index}] besitzt keine lueckenlose gemeinsame Knotengrenze."
                        ),
                    )?;
                }
            }
            previous = Some((leg.clone(), track));
            counts.timetable_legs = counts.timetable_legs.saturating_add(1);
        }
        if let Some(transition) = route.transition_route_mm {
            require(
                (0..=route_length).contains(&transition),
                format!("{context}.transitionRouteMm liegt ausserhalb des Laufwegs."),
            )?;
        }
        let serialized = serde_json::to_string(&route).map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "{context} kann nicht serialisiert werden: {error}"
            ))
        })?;
        require(
            routes
                .insert(route.route_version_id.as_str(), serialized.as_str())
                .map_err(db_error)?
                .is_none(),
            format!("Doppelte routeVersionId `{}`.", route.route_version_id),
        )?;
        counts.timetable_routes = counts.timetable_routes.saturating_add(1);
        Ok(())
    })?;
    drop(routes);
    drop(tracks);
    transaction.commit().map_err(db_error)?;
    require(
        counts.timetable_routes > 0,
        "timetableRoutes-Layer ist leer.",
    )?;
    let read = database.begin_read().map_err(db_error)?;
    let routes = read.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    for entry in routes.iter().map_err(db_error)? {
        let (_, serialized) = entry.map_err(db_error)?;
        let route: TimetableRouteInput =
            serde_json::from_str(serialized.value()).map_err(|error| {
                GermanyOperationalV2Error::new(format!(
                    "Preflight-Timetable-Index ist ungueltig: {error}"
                ))
            })?;
        if let Some(predecessor) = route.predecessor_id {
            require(
                predecessor != route.route_version_id
                    && routes
                        .get(predecessor.as_str())
                        .map_err(db_error)?
                        .is_some(),
                format!(
                    "Laufweg `{}` verweist auf unbekannten oder eigenen Vorgaenger `{predecessor}`.",
                    route.route_version_id
                ),
            )?;
        }
    }
    Ok(evidence)
}

fn required_u64(value: &Value, field: &str, context: &str) -> Result<u64> {
    value.get(field).and_then(Value::as_u64).ok_or_else(|| {
        GermanyOperationalV2Error::new(format!(
            "{context}.{field} ist keine nichtnegative Ganzzahl."
        ))
    })
}

fn read_transfer_demands(
    path: &Path,
    relative: &str,
    expected: &PinnedInputSpec,
    infra_release_id: &str,
    policy: &PolicySpec,
) -> Result<(
    Vec<TransferRouteInput>,
    Vec<TurnaroundPairDemand>,
    TransferEvidence,
)> {
    let measured_bytes = regular_file(path, "transferDemands")?;
    require(
        measured_bytes == expected.expected_bytes && measured_bytes <= MAX_TRANSFER_DEMAND_BYTES,
        format!(
            "transferDemands besitzt {measured_bytes} statt der gepinnten {} Bytes oder ueberschreitet die native Grenze.",
            expected.expected_bytes
        ),
    )?;
    let bytes = fs::read(path).map_err(|error| io_error("transferDemands", path, error))?;
    require(
        u64::try_from(bytes.len()).ok() == Some(measured_bytes),
        "transferDemands aenderte waehrend des Lesens seine Groesse.",
    )?;
    let file_sha256 = sha256(&bytes);
    require(
        file_sha256 == expected.expected_sha256,
        format!(
            "transferDemands besitzt SHA-256 `{file_sha256}` statt `{}`.",
            expected.expected_sha256
        ),
    )?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        GermanyOperationalV2Error::new(format!("transferDemands ist ungueltig: {error}"))
    })?;
    exact_keys(
        &value,
        &[
            "schema",
            "infraReleaseId",
            "gtfsSnapshotHash",
            "dailyPlan",
            "formationLengthsMm",
            "transferRoutes",
            "transferSetSha256",
        ],
        "transferDemands",
    )?;
    require(
        value["schema"] == TRANSFER_DEMAND_SCHEMA
            && value["infraReleaseId"] == infra_release_id
            && value["gtfsSnapshotHash"].as_str().is_some_and(is_sha256),
        "transferDemands besitzt keine gueltige Schema-/Release-/GTFS-Bindung.",
    )?;
    let formation_lengths: Vec<i64> = serde_json::from_value(value["formationLengthsMm"].clone())
        .map_err(|error| {
        GermanyOperationalV2Error::new(format!(
            "transferDemands.formationLengthsMm ist ungueltig: {error}"
        ))
    })?;
    require(
        !formation_lengths.is_empty()
            && formation_lengths == policy.terminal_formation_lengths_mm
            && formation_lengths.windows(2).all(|pair| pair[0] < pair[1]),
        "transferDemands.formationLengthsMm weicht von der kanonischen Terminal-Policy ab.",
    )?;

    let daily_plan = value
        .get("dailyPlan")
        .ok_or_else(|| GermanyOperationalV2Error::new("transferDemands.dailyPlan fehlt."))?;
    exact_keys(
        daily_plan,
        &[
            "schema",
            "rule",
            "gtfsReleaseId",
            "repeatEveryS",
            "minimumTurnaroundS",
            "metrics",
            "circulations",
            "rolloverAssignments",
            "turnaroundDemands",
            "transferDemands",
            "planSha256",
        ],
        "transferDemands.dailyPlan",
    )?;
    require(
        daily_plan["schema"] == DAILY_CIRCULATION_PLAN_SCHEMA
            && daily_plan["planSha256"].as_str().is_some_and(is_sha256),
        "transferDemands.dailyPlan besitzt keine gueltige Schema-/Hashbindung.",
    )?;
    let repeat_every_s = daily_plan["repeatEveryS"].as_i64().ok_or_else(|| {
        GermanyOperationalV2Error::new("transferDemands.dailyPlan.repeatEveryS fehlt.")
    })?;
    let minimum_turnaround_s = daily_plan["minimumTurnaroundS"].as_i64().ok_or_else(|| {
        GermanyOperationalV2Error::new("transferDemands.dailyPlan.minimumTurnaroundS fehlt.")
    })?;
    let gtfs_release_id = daily_plan["gtfsReleaseId"].as_str().ok_or_else(|| {
        GermanyOperationalV2Error::new("transferDemands.dailyPlan.gtfsReleaseId fehlt.")
    })?;
    require(
        daily_plan["rule"] == DAILY_CIRCULATION_PLAN_RULE
            && !gtfs_release_id.is_empty()
            && gtfs_release_id.trim() == gtfs_release_id
            && repeat_every_s == 86_400
            && minimum_turnaround_s == MINIMUM_TURNAROUND_S,
        "transferDemands.dailyPlan besitzt keine gueltige Regel-/GTFS-/Tages-/Mindestwendezeitbindung.",
    )?;
    let mut plan_body = daily_plan.clone();
    plan_body
        .as_object_mut()
        .expect("dailyPlan wurde als Objekt validiert")
        .remove("planSha256");
    let plan_envelope = json!({
        "schema": DAILY_CIRCULATION_PLAN_SCHEMA,
        "value": plan_body,
    });
    let mut canonical_plan = String::new();
    canonical_json(&plan_envelope, &mut canonical_plan);
    let daily_plan_sha256 = sha256(canonical_plan.as_bytes());
    require(
        daily_plan["planSha256"] == daily_plan_sha256,
        format!(
            "transferDemands.dailyPlan besitzt Zustandshash `{}` statt nativ `{daily_plan_sha256}`.",
            daily_plan["planSha256"]
        ),
    )?;
    let metrics = daily_plan.get("metrics").ok_or_else(|| {
        GermanyOperationalV2Error::new("transferDemands.dailyPlan.metrics fehlt.")
    })?;
    exact_keys(
        metrics,
        &[
            "lotCount",
            "journeyChainCount",
            "circulationCount",
            "rolloverAssignmentCount",
            "plannedTransitionCount",
            "turnaroundDemandCount",
            "transferDemandCount",
            "transferLotCount",
        ],
        "transferDemands.dailyPlan.metrics",
    )?;
    let circulation_count = required_u64(metrics, "circulationCount", "dailyPlan.metrics")?;
    let planned_transition_count =
        required_u64(metrics, "plannedTransitionCount", "dailyPlan.metrics")?;
    let declared_turnaround_demand_count =
        required_u64(metrics, "turnaroundDemandCount", "dailyPlan.metrics")?;
    let transfer_demand_count = required_u64(metrics, "transferDemandCount", "dailyPlan.metrics")?;
    let transfer_lot_count = required_u64(metrics, "transferLotCount", "dailyPlan.metrics")?;
    let daily_turnaround_demands = daily_plan["turnaroundDemands"].as_array().ok_or_else(|| {
        GermanyOperationalV2Error::new("dailyPlan.turnaroundDemands ist kein Array.")
    })?;
    let daily_demands = daily_plan["transferDemands"].as_array().ok_or_else(|| {
        GermanyOperationalV2Error::new("dailyPlan.transferDemands ist kein Array.")
    })?;
    require(
        u64::try_from(daily_plan["circulations"].as_array().map_or(0, Vec::len)).ok()
            == Some(circulation_count)
            && u64::try_from(daily_turnaround_demands.len()).ok()
                == Some(declared_turnaround_demand_count)
            && u64::try_from(daily_demands.len()).ok() == Some(transfer_demand_count),
        "dailyPlan-Metriken stimmen nicht mit den gebundenen Mengen ueberein.",
    )?;
    let circulations = daily_plan["circulations"]
        .as_array()
        .expect("Circulation-Metrik validierte ein Array");
    let mut circulation_by_id = BTreeMap::<String, &Value>::new();
    let mut planned_continuations = BTreeMap::<(String, String), PlannedContinuation>::new();
    let mut circulation_lots = BTreeSet::<String>::new();
    let mut journey_chains = BTreeSet::<String>::new();
    for (index, circulation) in circulations.iter().enumerate() {
        exact_keys(
            circulation,
            &[
                "id",
                "lotId",
                "serviceLineId",
                "assetCompatibilityKey",
                "journeyChainIds",
                "passengerLegIds",
                "passengerTrainRunIds",
                "start",
                "end",
            ],
            &format!("dailyPlan.circulations[{index}]"),
        )?;
        let id = circulation["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| GermanyOperationalV2Error::new("Circulation-ID fehlt."))?;
        let lot_id = circulation["lotId"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| GermanyOperationalV2Error::new("Circulation-Lot-ID fehlt."))?;
        require(
            circulation["assetCompatibilityKey"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
                && circulation["serviceLineId"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty()),
            format!("Circulation `{id}` besitzt keine Lot-/Asset-Bindung."),
        )?;
        circulation_lots.insert(lot_id.to_owned());
        for journey_chain in circulation["journeyChainIds"]
            .as_array()
            .ok_or_else(|| GermanyOperationalV2Error::new("journeyChainIds ist kein Array."))?
        {
            journey_chains.insert(
                journey_chain
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| GermanyOperationalV2Error::new("JourneyChain-ID fehlt."))?
                    .to_owned(),
            );
        }
        let passenger_leg_ids = circulation["passengerLegIds"]
            .as_array()
            .filter(|ids| !ids.is_empty())
            .ok_or_else(|| {
                GermanyOperationalV2Error::new(format!(
                    "Circulation `{id}` besitzt keine Passenger-Legs."
                ))
            })?;
        let leg_ids = passenger_leg_ids
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        GermanyOperationalV2Error::new(format!(
                            "Circulation `{id}` besitzt eine ungueltige Passenger-Leg-ID."
                        ))
                    })
            })
            .collect::<Result<Vec<_>>>()?;
        require(
            circulation["start"]["legId"] == leg_ids[0]
                && circulation["end"]["legId"] == *leg_ids.last().expect("nichtleere Legliste"),
            format!("Circulation `{id}` driftet zwischen Endpunkten und Passenger-Legs."),
        )?;
        for pair in leg_ids.windows(2) {
            let key = (pair[0].clone(), pair[1].clone());
            require(
                planned_continuations
                    .insert(
                        key,
                        PlannedContinuation {
                            source_circulation_id: id.to_owned(),
                            target_circulation_id: id.to_owned(),
                            source_passenger_leg_id: pair[0].clone(),
                            target_passenger_leg_id: pair[1].clone(),
                            daily_boundary: false,
                        },
                    )
                    .is_none(),
                "DailyPlan bindet ein internes Passenger-Leg-Paar mehrfach.",
            )?;
        }
        require(
            circulation_by_id
                .insert(id.to_owned(), circulation)
                .is_none(),
            format!("Doppelte Circulation-ID `{id}`."),
        )?;
    }
    require(
        u64::try_from(circulation_lots.len()).ok()
            == Some(required_u64(metrics, "lotCount", "dailyPlan.metrics")?)
            && u64::try_from(journey_chains.len()).ok()
                == Some(required_u64(
                    metrics,
                    "journeyChainCount",
                    "dailyPlan.metrics",
                )?),
        "DailyPlan-Lot-/JourneyChain-Metriken sind nicht nativ reproduzierbar.",
    )?;
    let rollovers = daily_plan["rolloverAssignments"]
        .as_array()
        .ok_or_else(|| GermanyOperationalV2Error::new("rolloverAssignments ist kein Array."))?;
    require(
        u64::try_from(rollovers.len()).ok()
            == Some(required_u64(
                metrics,
                "rolloverAssignmentCount",
                "dailyPlan.metrics",
            )?),
        "rolloverAssignmentCount stimmt nicht mit der gebundenen Menge ueberein.",
    )?;
    let mut rollover_sources = BTreeSet::new();
    let mut rollover_targets = BTreeSet::new();
    for (index, rollover) in rollovers.iter().enumerate() {
        exact_keys(
            rollover,
            &["kind", "sourceCirculationId", "targetCirculationId"],
            &format!("dailyPlan.rolloverAssignments[{index}]"),
        )?;
        let kind = rollover["kind"]
            .as_str()
            .ok_or_else(|| GermanyOperationalV2Error::new("Rollover-Art fehlt."))?;
        let source_id = rollover["sourceCirculationId"]
            .as_str()
            .ok_or_else(|| GermanyOperationalV2Error::new("Rollover-Quelle fehlt."))?;
        let target_id = rollover["targetCirculationId"]
            .as_str()
            .ok_or_else(|| GermanyOperationalV2Error::new("Rollover-Ziel fehlt."))?;
        let source = circulation_by_id.get(source_id).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!("Unbekannte Rollover-Quelle `{source_id}`."))
        })?;
        let target = circulation_by_id.get(target_id).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!("Unbekanntes Rollover-Ziel `{target_id}`."))
        })?;
        require(
            rollover_sources.insert(source_id.to_owned())
                && rollover_targets.insert(target_id.to_owned()),
            "Rollover-Permutation bindet eine Quelle oder ein Ziel mehrfach.",
        )?;
        require(
            source["lotId"] == target["lotId"]
                && source["assetCompatibilityKey"] == target["assetCompatibilityKey"],
            format!("Rollover `{source_id}` -> `{target_id}` ist nicht Lot-/Asset-kompatibel."),
        )?;
        match kind {
            "same-location" => require(
                source["end"]["locationId"] == target["start"]["locationId"]
                    && source["end"]["physicalStopId"] == target["start"]["physicalStopId"],
                "Same-location-Rollover ist nicht am identischen physischen Halt gebunden.",
            )?,
            "transfer" => require(
                source["end"]["locationId"] != target["start"]["locationId"]
                    || source["end"]["physicalStopId"] != target["start"]["physicalStopId"],
                "Transfer-Rollover ist bereits am identischen physischen Halt gebunden.",
            )?,
            _ => {
                return Err(GermanyOperationalV2Error::new(format!(
                    "Unbekannte Rollover-Art `{kind}`."
                )));
            }
        }
        let inbound = source["passengerLegIds"]
            .as_array()
            .and_then(|ids| ids.last())
            .and_then(Value::as_str)
            .expect("Circulation-Legs wurden validiert");
        let outbound = target["passengerLegIds"]
            .as_array()
            .and_then(|ids| ids.first())
            .and_then(Value::as_str)
            .expect("Circulation-Legs wurden validiert");
        require(
            planned_continuations
                .insert(
                    (inbound.to_owned(), outbound.to_owned()),
                    PlannedContinuation {
                        source_circulation_id: source_id.to_owned(),
                        target_circulation_id: target_id.to_owned(),
                        source_passenger_leg_id: inbound.to_owned(),
                        target_passenger_leg_id: outbound.to_owned(),
                        daily_boundary: true,
                    },
                )
                .is_none(),
            "DailyPlan bindet ein Rollover-Passenger-Leg-Paar mehrfach.",
        )?;
    }
    require(
        rollover_sources.len() == circulation_by_id.len()
            && rollover_targets.len() == circulation_by_id.len(),
        "Rollover-Zuordnung ist keine vollstaendige Circulation-Permutation.",
    )?;
    let turnaround_demand_fields = [
        "id",
        "lotId",
        "assetCompatibilityKey",
        "sourceCirculationId",
        "targetCirculationId",
        "sourcePassengerLegId",
        "targetPassengerLegId",
        "sourcePassengerRouteVersionId",
        "targetPassengerRouteVersionId",
        "sourceLocationId",
        "targetLocationId",
        "sourcePhysicalStopId",
        "targetPhysicalStopId",
        "earliestDepartureS",
        "latestArrivalS",
        "availableWindowS",
        "dailyBoundary",
    ];
    let mut turnaround_demands = Vec::<TurnaroundPairDemand>::new();
    let mut classified_pairs = BTreeSet::<(String, String)>::new();
    let mut previous_turnaround_id: Option<String> = None;
    for (index, demand_value) in daily_turnaround_demands.iter().enumerate() {
        exact_keys(
            demand_value,
            &turnaround_demand_fields,
            &format!("dailyPlan.turnaroundDemands[{index}]"),
        )?;
        let demand: TurnaroundPairDemand =
            serde_json::from_value(demand_value.clone()).map_err(|error| {
                GermanyOperationalV2Error::new(format!(
                    "dailyPlan.turnaroundDemands[{index}] ist ungueltig: {error}"
                ))
            })?;
        require(
            !demand.id.is_empty()
                && previous_turnaround_id
                    .as_ref()
                    .is_none_or(|previous| previous.as_bytes() < demand.id.as_bytes()),
            "turnaroundDemands ist nicht streng nach UTF-8-ID sortiert oder enthaelt Duplikate.",
        )?;
        previous_turnaround_id = Some(demand.id.clone());
        let pair_key = (
            demand.source_passenger_leg_id.clone(),
            demand.target_passenger_leg_id.clone(),
        );
        let planned = planned_continuations.get(&pair_key).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Turnaround-Demand `{}` bindet kein geplantes Passenger-Leg-Paar.",
                demand.id
            ))
        })?;
        let source = circulation_by_id
            .get(&demand.source_circulation_id)
            .ok_or_else(|| {
                GermanyOperationalV2Error::new(format!(
                    "Turnaround-Demand `{}` bindet unbekannte Quelle.",
                    demand.id
                ))
            })?;
        let target = circulation_by_id
            .get(&demand.target_circulation_id)
            .ok_or_else(|| {
                GermanyOperationalV2Error::new(format!(
                    "Turnaround-Demand `{}` bindet unbekanntes Ziel.",
                    demand.id
                ))
            })?;
        let rollover_endpoints_match = !planned.daily_boundary
            || (demand.source_location_id == source["end"]["locationId"]
                && demand.target_location_id == target["start"]["locationId"]
                && demand.source_physical_stop_id == source["end"]["physicalStopId"]
                && demand.target_physical_stop_id == target["start"]["physicalStopId"]);
        require(
            classified_pairs.insert(pair_key)
                && demand.source_circulation_id == planned.source_circulation_id
                && demand.target_circulation_id == planned.target_circulation_id
                && demand.source_passenger_leg_id == planned.source_passenger_leg_id
                && demand.target_passenger_leg_id == planned.target_passenger_leg_id
                && demand.inbound_route_version_id
                    == format!("route:gtfs:{}:v1", demand.source_passenger_leg_id)
                && demand.outbound_route_version_id
                    == format!("route:gtfs:{}:v1", demand.target_passenger_leg_id)
                && demand.lot_id == source["lotId"]
                && demand.lot_id == target["lotId"]
                && demand.asset_compatibility_key == source["assetCompatibilityKey"]
                && demand.asset_compatibility_key == target["assetCompatibilityKey"]
                && !demand.source_location_id.is_empty()
                && demand.source_location_id == demand.target_location_id
                && !demand.source_physical_stop_id.is_empty()
                && demand.source_physical_stop_id == demand.target_physical_stop_id
                && demand.daily_boundary == planned.daily_boundary
                && demand.available_window_s >= minimum_turnaround_s
                && demand
                    .latest_arrival_s
                    .checked_sub(demand.earliest_departure_s)
                    == Some(demand.available_window_s)
                && rollover_endpoints_match,
            format!(
                "Turnaround-Demand `{}` driftet von Plan, Route, Ort, physischem Halt, Lot, Asset, Tagesgrenze oder Zeitfenster ab.",
                demand.id
            ),
        )?;
        turnaround_demands.push(demand);
    }

    let demand_fields = [
        "id",
        "lotId",
        "assetCompatibilityKey",
        "sourceCirculationId",
        "targetCirculationId",
        "sourcePassengerLegId",
        "targetPassengerLegId",
        "sourcePassengerRouteVersionId",
        "targetPassengerRouteVersionId",
        "sourceLocationId",
        "targetLocationId",
        "sourcePhysicalStopId",
        "targetPhysicalStopId",
        "earliestDepartureS",
        "latestArrivalS",
        "availableWindowS",
        "dailyBoundary",
        "movementKind",
    ];
    let mut daily_demand_by_id = BTreeMap::<String, &Value>::new();
    let mut transfer_lots = BTreeSet::<String>::new();
    let mut previous_transfer_id: Option<&str> = None;
    for (index, demand) in daily_demands.iter().enumerate() {
        exact_keys(
            demand,
            &demand_fields,
            &format!("dailyPlan.transferDemands[{index}]"),
        )?;
        let id = demand["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| GermanyOperationalV2Error::new("Daily-Demand-ID fehlt."))?;
        require(
            previous_transfer_id.is_none_or(|previous| previous.as_bytes() < id.as_bytes())
                && daily_demand_by_id.insert(id.to_owned(), demand).is_none(),
            "transferDemands ist nicht streng nach UTF-8-ID sortiert oder enthaelt Duplikate.",
        )?;
        previous_transfer_id = Some(id);
        let source_id = demand["sourceCirculationId"]
            .as_str()
            .ok_or_else(|| GermanyOperationalV2Error::new("Demand-Quellumlauf fehlt."))?;
        let target_id = demand["targetCirculationId"]
            .as_str()
            .ok_or_else(|| GermanyOperationalV2Error::new("Demand-Zielumlauf fehlt."))?;
        let source = circulation_by_id.get(source_id).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!("Demand `{id}` bindet unbekannte Quelle."))
        })?;
        let target = circulation_by_id.get(target_id).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!("Demand `{id}` bindet unbekanntes Ziel."))
        })?;
        let source_leg_id = demand["sourcePassengerLegId"]
            .as_str()
            .ok_or_else(|| GermanyOperationalV2Error::new("Demand-Quellleg fehlt."))?;
        let target_leg_id = demand["targetPassengerLegId"]
            .as_str()
            .ok_or_else(|| GermanyOperationalV2Error::new("Demand-Zielleg fehlt."))?;
        let pair_key = (source_leg_id.to_owned(), target_leg_id.to_owned());
        let planned = planned_continuations.get(&pair_key).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Transfer-Demand `{id}` bindet kein geplantes Passenger-Leg-Paar."
            ))
        })?;
        let rollover_endpoints_match = !planned.daily_boundary
            || (demand["sourceLocationId"] == source["end"]["locationId"]
                && demand["targetLocationId"] == target["start"]["locationId"]
                && demand["sourcePhysicalStopId"] == source["end"]["physicalStopId"]
                && demand["targetPhysicalStopId"] == target["start"]["physicalStopId"]);
        require(
            classified_pairs.insert(pair_key)
                && source_id == planned.source_circulation_id
                && target_id == planned.target_circulation_id
                && demand["lotId"] == source["lotId"]
                && demand["lotId"] == target["lotId"]
                && demand["assetCompatibilityKey"] == source["assetCompatibilityKey"]
                && demand["assetCompatibilityKey"] == target["assetCompatibilityKey"]
                && source_leg_id == planned.source_passenger_leg_id
                && target_leg_id == planned.target_passenger_leg_id
                && demand["sourcePassengerRouteVersionId"]
                    == format!("route:gtfs:{source_leg_id}:v1")
                && demand["targetPassengerRouteVersionId"]
                    == format!("route:gtfs:{target_leg_id}:v1")
                && demand["sourceLocationId"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
                && demand["targetLocationId"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
                && demand["sourcePhysicalStopId"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
                && demand["targetPhysicalStopId"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
                && (demand["sourceLocationId"] != demand["targetLocationId"]
                    || demand["sourcePhysicalStopId"] != demand["targetPhysicalStopId"])
                && demand["dailyBoundary"].as_bool() == Some(planned.daily_boundary)
                && demand["movementKind"] == "train"
                && demand["availableWindowS"]
                    .as_i64()
                    .is_some_and(|value| value > 0)
                && demand["latestArrivalS"]
                    .as_i64()
                    .zip(demand["earliestDepartureS"].as_i64())
                    .and_then(|(latest, earliest)| latest.checked_sub(earliest))
                    == demand["availableWindowS"].as_i64()
                && rollover_endpoints_match,
            format!(
                "Transfer-Demand `{id}` driftet von Plan, Route, Ort, physischem Halt, Lot, Asset, Tagesgrenze, Bewegungsart oder Zeitfenster ab."
            ),
        )?;
        transfer_lots.insert(
            demand["lotId"]
                .as_str()
                .expect("Lot wurde gegen Circulation validiert")
                .to_owned(),
        );
    }
    require(
        classified_pairs.len() == planned_continuations.len()
            && planned_continuations
                .keys()
                .all(|pair| classified_pairs.contains(pair))
            && declared_turnaround_demand_count.saturating_add(transfer_demand_count)
                == planned_transition_count
            && planned_transition_count
                == u64::try_from(planned_continuations.len()).unwrap_or(u64::MAX)
            && planned_transition_count
                == required_u64(metrics, "journeyChainCount", "dailyPlan.metrics")?
            && u64::try_from(transfer_lots.len()).ok() == Some(transfer_lot_count),
        "Turnaround- und Transferanforderungen bilden keine disjunkte vollstaendige Partition aller geplanten Fortsetzungen.",
    )?;

    let route_values = value["transferRoutes"]
        .as_array()
        .ok_or_else(|| GermanyOperationalV2Error::new("transferRoutes ist kein Array."))?;
    require(
        !route_values.is_empty()
            && u64::try_from(route_values.len()).ok() == Some(transfer_demand_count),
        "transferRoutes deckt die Daily-Transferanforderungen nicht vollstaendig ab.",
    )?;
    let mut transfer_hasher = Sha256::new();
    let mut previous_id: Option<&str> = None;
    let mut routes = Vec::with_capacity(route_values.len());
    for (index, route_value) in route_values.iter().enumerate() {
        let id = route_value["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| GermanyOperationalV2Error::new("Transferroute-ID fehlt."))?;
        require(
            previous_id.is_none_or(|previous| previous.as_bytes() < id.as_bytes()),
            "transferRoutes ist nicht streng nach UTF-8-ID sortiert oder enthaelt Duplikate.",
        )?;
        previous_id = Some(id);
        let daily_demand = daily_demand_by_id.get(id).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Transferroute `{id}` besitzt keine Daily-Plan-Anforderung."
            ))
        })?;
        for field in demand_fields {
            require(
                route_value.get(field) == daily_demand.get(field),
                format!("Transferroute `{id}` driftet in `{field}` vom DailyPlan ab."),
            )?;
        }
        let mut canonical = String::new();
        canonical_json(route_value, &mut canonical);
        transfer_hasher.update(canonical.as_bytes());
        transfer_hasher.update(b"\n");
        let route: TransferRouteInput =
            serde_json::from_value(route_value.clone()).map_err(|error| {
                GermanyOperationalV2Error::new(format!(
                    "transferRoutes[{index}] ist ungueltig: {error}"
                ))
            })?;
        require(
            route.formation_lengths_mm == formation_lengths,
            format!("Transferroute `{id}` driftet in formationLengthsMm."),
        )?;
        routes.push(route);
    }
    let transfer_set_sha256 = digest_hex(transfer_hasher.finalize());
    require(
        value["transferSetSha256"] == transfer_set_sha256,
        format!(
            "transferSetSha256 ist nicht nativ reproduzierbar: erwartet {}, nativ {transfer_set_sha256}.",
            value["transferSetSha256"]
        ),
    )?;
    require(
        daily_demand_by_id.len() == routes.len(),
        "Nicht jede Daily-Transferanforderung besitzt genau eine reale Transferroute.",
    )?;
    let turnaround_demand_count = u64::try_from(turnaround_demands.len()).unwrap_or(u64::MAX);
    turnaround_demands.sort();
    turnaround_demands.dedup();
    let turnaround_pair_count = u64::try_from(turnaround_demands.len()).unwrap_or(u64::MAX);
    Ok((
        routes,
        turnaround_demands,
        TransferEvidence {
            file: FileEvidence {
                path: relative.to_owned(),
                bytes: measured_bytes,
                sha256: file_sha256,
                records: u64::try_from(route_values.len()).unwrap_or(u64::MAX),
            },
            daily_plan_sha256,
            transfer_set_sha256,
            circulation_count,
            planned_transition_count,
            transfer_demand_count,
            transfer_lot_count,
            turnaround_demand_count,
            turnaround_pair_count,
        },
    ))
}

fn get_track(transaction: &redb::ReadTransaction, edge_id: &str) -> Result<TrackRecord> {
    let table = transaction.open_table(TRACKS).map_err(db_error)?;
    let value = table.get(edge_id).map_err(db_error)?.ok_or_else(|| {
        GermanyOperationalV2Error::new(format!(
            "Unbekannte Gleiskante `{edge_id}` im Ableitungsindex."
        ))
    })?;
    track_from_json(value.value(), "Gleiskante im Ableitungsindex")
}

fn track_block_resources(
    transaction: &redb::ReadTransaction,
    edge_id: &str,
) -> Result<BTreeSet<String>> {
    let table = transaction
        .open_multimap_table(TRACK_BLOCKS)
        .map_err(db_error)?;
    let mut result = BTreeSet::from([edge_resource(edge_id)]);
    let mut values = table.get(edge_id).map_err(db_error)?;
    while let Some(value) = values.next().transpose().map_err(db_error)? {
        result.insert(value.value().to_owned());
    }
    Ok(result)
}

fn route_from_json(value: &str, context: &str) -> Result<TimetableRouteInput> {
    serde_json::from_str(value)
        .map_err(|error| GermanyOperationalV2Error::new(format!("{context}: {error}")))
}

fn timetable_route(
    transaction: &redb::ReadTransaction,
    route_version_id: &str,
    context: &str,
) -> Result<TimetableRouteInput> {
    let routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    let serialized = routes
        .get(route_version_id)
        .map_err(db_error)?
        .ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "{context} verweist auf unbekannten Laufweg `{route_version_id}`."
            ))
        })?;
    route_from_json(serialized.value(), context)
}

fn directed_track_from_node(track: Arc<TrackRecord>, node_id: i64) -> Option<(DirectedTrack, i64)> {
    if track.from_node_id == node_id && track.to_node_id != node_id {
        let next = track.to_node_id;
        Some((
            DirectedTrack {
                track,
                direction: "along",
            },
            next,
        ))
    } else if track.to_node_id == node_id && track.from_node_id != node_id {
        let next = track.from_node_id;
        Some((
            DirectedTrack {
                track,
                direction: "against",
            },
            next,
        ))
    } else {
        None
    }
}

fn stabling_track_compatible(track: &TrackRecord, terminal: &TrackRecord) -> bool {
    track.id != terminal.id
        && track.orderable
        && track.railway == "rail"
        && track.gauge_mm == STANDARD_GAUGE_MM
        && track.bidirectional
        && matches!(track.quality_class.as_str(), "A" | "B")
        && track.osm_way_id > 0
        && !track.geometry_lineage.is_empty()
        && track.source_id == terminal.source_id
        && track.electrified == terminal.electrified
        && track.voltage == terminal.voltage
        && track.frequency == terminal.frequency
        && track.protection_systems == terminal.protection_systems
}

fn berth_assignment(
    track: &TrackRecord,
    terminal: &TrackRecord,
    search_mode: BerthSearchMode,
) -> Option<TurnaroundBerthAssignment> {
    if !stabling_track_compatible(track, terminal) {
        return None;
    }
    let (kind, subtype, operational_assignment_provenance) =
        match (search_mode, track.service.as_deref()) {
            (BerthSearchMode::ObservedSiding, Some("siding")) => (
                BerthAssignmentKind::Observed,
                BerthAssignmentSubtype::ServiceSiding,
                BerthOperationalAssignmentProvenance::ObservedOsmService,
            ),
            (BerthSearchMode::SimulatedOperationalFallback, Some("yard")) => (
                BerthAssignmentKind::SimulatedOperational,
                BerthAssignmentSubtype::ServiceYard,
                BerthOperationalAssignmentProvenance::SyntheticOperationalBPolicy,
            ),
            (BerthSearchMode::SimulatedOperationalFallback, Some("spur")) => (
                BerthAssignmentKind::SimulatedOperational,
                BerthAssignmentSubtype::ServiceSpur,
                BerthOperationalAssignmentProvenance::SyntheticOperationalBPolicy,
            ),
            (BerthSearchMode::SimulatedOperationalFallback, None) => (
                BerthAssignmentKind::SimulatedOperational,
                BerthAssignmentSubtype::UnclassifiedRail,
                BerthOperationalAssignmentProvenance::SyntheticOperationalBPolicy,
            ),
            _ => return None,
        };
    Some(TurnaroundBerthAssignment {
        kind,
        subtype,
        geometry_provenance: BerthGeometryProvenance::RealOsmRail,
        operational_assignment_provenance,
    })
}

fn adjacent_directed_tracks(
    transaction: &redb::ReadTransaction,
    node_id: i64,
    cache: &mut DirectedTrackCache,
) -> Result<Vec<(DirectedTrack, i64)>> {
    let by_node = transaction
        .open_multimap_table(TRACKS_BY_NODE)
        .map_err(db_error)?;
    let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    let node_key = node_id.to_string();
    let mut edge_ids = Vec::new();
    let mut values = by_node.get(node_key.as_str()).map_err(db_error)?;
    while let Some(value) = values.next().transpose().map_err(db_error)? {
        edge_ids.push(value.value().to_owned());
    }
    edge_ids.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    let mut result = Vec::new();
    for edge_id in edge_ids {
        let track = if let Some(track) = cache.tracks.get(edge_id.as_str()) {
            Arc::clone(track)
        } else {
            let serialized = tracks
                .get(edge_id.as_str())
                .map_err(db_error)?
                .ok_or_else(|| {
                    GermanyOperationalV2Error::new(format!(
                        "Knotenindex verweist auf unbekannte Gleiskante `{edge_id}`."
                    ))
                })?;
            let track = Arc::new(track_from_json(
                serialized.value(),
                "Knotenindex-Gleiskante",
            )?);
            let additional_bytes = std::mem::size_of::<TrackRecord>()
                .saturating_add(track_heap_bytes(&track))
                .saturating_add(string_heap_bytes(&edge_id))
                .saturating_add(std::mem::size_of::<Arc<TrackRecord>>())
                .saturating_add(GENERATED_ENTRY_OVERHEAD_BYTES);
            cache.resident_bytes = cache
                .resident_bytes
                .checked_add(additional_bytes)
                .ok_or_else(|| {
                    GermanyOperationalV2Error::new("Gleis-Cache-Speicher laeuft ueber.")
                })?;
            cache.tracks.insert(edge_id, Arc::clone(&track));
            track
        };
        if let Some(directed) = directed_track_from_node(track, node_id) {
            result.push(directed);
        }
    }
    Ok(result)
}

fn stabling_path_key(candidate: &StablingCandidate) -> (TurnaroundBerthAssignment, i64, Vec<&str>) {
    (
        candidate.berth_assignment,
        candidate.total_length_mm,
        candidate
            .path
            .iter()
            .map(|edge| edge.track.id.as_str())
            .collect(),
    )
}

fn stabling_search_label_key(label: &StablingSearchLabel) -> (i64, Vec<&str>) {
    (
        label.total_length_mm,
        label
            .path
            .iter()
            .map(|edge| edge.track.id.as_str())
            .collect(),
    )
}

fn stabling_candidates(
    transaction: &redb::ReadTransaction,
    terminal: &TrackRecord,
    terminal_node_id: i64,
    policy: StablingSearchPolicy,
    inbound_route_id: &str,
) -> Result<StablingSearchResult> {
    let StablingSearchPolicy {
        formation_length_mm,
        minimum_clearance_mm,
        maximum_path_edges,
        maximum_path_length_mm,
        search_mode,
    } = policy;
    require(
        terminal.orderable
            && terminal.railway == "rail"
            && terminal.gauge_mm == STANDARD_GAUGE_MM
            && terminal.osm_way_id > 0
            && matches!(terminal.quality_class.as_str(), "A" | "B")
            && !terminal.geometry_lineage.is_empty(),
        format!(
            "Terminalkante `{}` von `{inbound_route_id}` besitzt keine freigegebene reale OSM-Klassifikation.",
            terminal.id
        ),
    )?;
    let maximum_path_edges = usize::try_from(maximum_path_edges).map_err(|_| {
        GermanyOperationalV2Error::new("Abstellpfad-Hopgrenze ist nicht darstellbar.")
    })?;
    let berth_required = formation_length_mm
        .checked_add(minimum_clearance_mm.saturating_mul(2))
        .ok_or_else(|| GermanyOperationalV2Error::new("Berth-Laenge laeuft ueber."))?;
    let mut track_cache = DirectedTrackCache::default();
    let mut stats = StablingSearchStats::default();
    let mut by_berth_edge = BTreeMap::<String, StablingCandidate>::new();
    let mut candidate_resident_bytes = 0_usize;
    let initial_label = StablingSearchLabel {
        total_length_mm: 0,
        path: Vec::new(),
    };
    let mut label_resident_bytes = stabling_label_resident_bytes(&initial_label);
    let mut labels = BTreeMap::<(i64, usize), StablingSearchLabel>::from([(
        (terminal_node_id, 0),
        initial_label,
    )]);
    stats.label_count = labels.len();
    for hop in 0..maximum_path_edges {
        let current_nodes: Vec<_> = labels
            .keys()
            .filter(|key| key.1 == hop)
            .map(|(node_id, _)| *node_id)
            .collect();
        for node_id in current_nodes {
            let label = labels
                .get(&(node_id, hop))
                .expect("Hop-Knoten stammt aus dem Labelindex")
                .clone();
            let adjacent = adjacent_directed_tracks(transaction, node_id, &mut track_cache)?;
            require_stabling_search_budget(
                inbound_route_id,
                &track_cache,
                label_resident_bytes,
                candidate_resident_bytes,
                &mut stats,
                by_berth_edge.len(),
            )?;
            for (directed, next_node) in adjacent {
                if !stabling_track_compatible(&directed.track, terminal)
                    || label
                        .path
                        .iter()
                        .any(|edge| edge.track.id == directed.track.id)
                {
                    continue;
                }
                let next_total = label
                    .total_length_mm
                    .checked_add(directed.track.length_mm)
                    .ok_or_else(|| {
                        GermanyOperationalV2Error::new("Abstellpfadlaenge laeuft ueber.")
                    })?;
                if next_total > maximum_path_length_mm {
                    continue;
                }
                let mut next_path = label.path.clone();
                next_path.push(directed);
                let berth_assignment = next_path.last().and_then(|edge| {
                    (edge.track.length_mm >= berth_required)
                        .then(|| berth_assignment(&edge.track, terminal, search_mode))
                        .flatten()
                });
                if let Some(berth_assignment) = berth_assignment {
                    let candidate = StablingCandidate {
                        total_length_mm: next_total,
                        path: next_path.clone(),
                        berth_assignment,
                    };
                    stats.raw_candidate_count = stats.raw_candidate_count.saturating_add(1);
                    stats.maximum_candidate_path_edges =
                        stats.maximum_candidate_path_edges.max(candidate.path.len());
                    stats.maximum_candidate_path_length_mm = stats
                        .maximum_candidate_path_length_mm
                        .max(candidate.total_length_mm);
                    stats.maximum_candidate_path_resident_bytes = stats
                        .maximum_candidate_path_resident_bytes
                        .max(directed_path_standalone_resident_bytes(&candidate.path));
                    let berth_edge_id = candidate
                        .path
                        .last()
                        .expect("Abstellkandidat ist nicht leer")
                        .track
                        .id
                        .clone();
                    let candidate_capacity_available =
                        by_berth_edge.len() < MAX_STABLING_CANDIDATES_PER_CASE;
                    let current_unique_count = by_berth_edge.len();
                    let next_candidate_bytes = stabling_candidate_resident_bytes(&candidate)
                        .saturating_add(string_heap_bytes(&berth_edge_id));
                    match by_berth_edge.entry(berth_edge_id) {
                        std::collections::btree_map::Entry::Vacant(entry) => {
                            let projected_unique_count = current_unique_count.saturating_add(1);
                            stats.duplicate_candidate_count = stats
                                .raw_candidate_count
                                .saturating_sub(projected_unique_count);
                            require(
                                candidate_capacity_available,
                                format!(
                                    "Abstellkandidatensuche fuer `{inbound_route_id}` ueberschreitet die feste Grenze von {MAX_STABLING_CANDIDATES_PER_CASE} Berths."
                                ),
                            )?;
                            candidate_resident_bytes = candidate_resident_bytes
                                .checked_add(next_candidate_bytes)
                                .ok_or_else(|| {
                                    GermanyOperationalV2Error::new(
                                        "Abstellkandidatenspeicher laeuft ueber.",
                                    )
                                })?;
                            require_stabling_search_budget(
                                inbound_route_id,
                                &track_cache,
                                label_resident_bytes,
                                candidate_resident_bytes,
                                &mut stats,
                                projected_unique_count,
                            )?;
                            entry.insert(candidate);
                        }
                        std::collections::btree_map::Entry::Occupied(mut entry) => {
                            stats.duplicate_candidate_count = stats
                                .raw_candidate_count
                                .saturating_sub(current_unique_count);
                            if stabling_path_key(&candidate) < stabling_path_key(entry.get()) {
                                stats.replacement_candidate_count =
                                    stats.replacement_candidate_count.saturating_add(1);
                                candidate_resident_bytes = candidate_resident_bytes
                                    .saturating_sub(
                                        stabling_candidate_resident_bytes(entry.get())
                                            .saturating_add(string_heap_bytes(entry.key())),
                                    )
                                    .checked_add(next_candidate_bytes)
                                    .ok_or_else(|| {
                                        GermanyOperationalV2Error::new(
                                            "Abstellkandidatenspeicher laeuft ueber.",
                                        )
                                    })?;
                                require_stabling_search_budget(
                                    inbound_route_id,
                                    &track_cache,
                                    label_resident_bytes,
                                    candidate_resident_bytes,
                                    &mut stats,
                                    current_unique_count,
                                )?;
                                entry.insert(candidate);
                            }
                        }
                    }
                }
                let next_hop = hop + 1;
                let next_label = StablingSearchLabel {
                    total_length_mm: next_total,
                    path: next_path,
                };
                let next_key = stabling_search_label_key(&next_label);
                let dominated = (0..=next_hop).any(|prior_hop| {
                    labels
                        .get(&(next_node, prior_hop))
                        .is_some_and(|prior| stabling_search_label_key(prior) <= next_key)
                });
                if !dominated {
                    let previous_label_bytes = labels
                        .get(&(next_node, next_hop))
                        .map_or(0, stabling_label_resident_bytes);
                    let next_label_bytes = stabling_label_resident_bytes(&next_label);
                    let next_resident_bytes = label_resident_bytes
                        .saturating_sub(previous_label_bytes)
                        .checked_add(next_label_bytes)
                        .ok_or_else(|| {
                            GermanyOperationalV2Error::new(
                                "Abstellkandidaten-Suchspeicher laeuft ueber.",
                            )
                        })?;
                    require(
                        labels.contains_key(&(next_node, next_hop))
                            || labels.len() < MAX_STABLING_SEARCH_LABELS,
                        format!(
                            "Abstellkandidatensuche fuer `{inbound_route_id}` ueberschreitet die feste Grenze von {MAX_STABLING_SEARCH_LABELS} Suchlabels."
                        ),
                    )?;
                    require_stabling_search_budget(
                        inbound_route_id,
                        &track_cache,
                        next_resident_bytes,
                        candidate_resident_bytes,
                        &mut stats,
                        by_berth_edge.len(),
                    )?;
                    label_resident_bytes = next_resident_bytes;
                    labels.insert((next_node, next_hop), next_label);
                    stats.label_count = labels.len();
                }
            }
        }
    }
    let mut result: Vec<_> = by_berth_edge.into_values().collect();
    result.sort_by(|left, right| stabling_path_key(left).cmp(&stabling_path_key(right)));
    stats.duplicate_candidate_count = stats.raw_candidate_count.saturating_sub(result.len());
    stats.cached_track_count = track_cache.tracks.len();
    debug_assert_eq!(
        stats.raw_candidate_count,
        stats.duplicate_candidate_count + result.len()
    );
    Ok(StablingSearchResult {
        candidates: result,
        stats,
    })
}

fn directed_track_start_node(edge: &DirectedTrack) -> Result<i64> {
    match edge.direction {
        "along" => Ok(edge.track.from_node_id),
        "against" => Ok(edge.track.to_node_id),
        other => Err(GermanyOperationalV2Error::new(format!(
            "Gleiskante `{}` besitzt ungueltige Richtung `{other}`.",
            edge.track.id
        ))),
    }
}

fn directed_track_end_node(edge: &DirectedTrack) -> Result<i64> {
    match edge.direction {
        "along" => Ok(edge.track.to_node_id),
        "against" => Ok(edge.track.from_node_id),
        other => Err(GermanyOperationalV2Error::new(format!(
            "Gleiskante `{}` besitzt ungueltige Richtung `{other}`.",
            edge.track.id
        ))),
    }
}

fn directed_path_is_simple_from(start_node: i64, path: &[DirectedTrack]) -> Result<bool> {
    let mut current_node = start_node;
    let mut visited_nodes = BTreeSet::from([start_node]);
    let mut visited_edges = BTreeSet::new();
    for edge in path {
        if directed_track_start_node(edge)? != current_node
            || !visited_edges.insert(edge.track.id.as_str())
        {
            return Ok(false);
        }
        current_node = directed_track_end_node(edge)?;
        if !visited_nodes.insert(current_node) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn reverse_directed_path(path: &[DirectedTrack]) -> Result<Vec<DirectedTrack>> {
    path.iter()
        .rev()
        .map(|edge| {
            Ok(DirectedTrack {
                track: edge.track.clone(),
                direction: reverse_direction(edge.direction)?,
            })
        })
        .collect()
}

fn cross_berth_terminal_compatible(
    inbound_terminal: &TrackRecord,
    outbound_terminal: &TrackRecord,
) -> bool {
    inbound_terminal.orderable
        && outbound_terminal.orderable
        && inbound_terminal.railway == "rail"
        && outbound_terminal.railway == "rail"
        && inbound_terminal.gauge_mm == STANDARD_GAUGE_MM
        && outbound_terminal.gauge_mm == STANDARD_GAUGE_MM
        && inbound_terminal.source_id == outbound_terminal.source_id
        && inbound_terminal.electrified == outbound_terminal.electrified
        && inbound_terminal.voltage == outbound_terminal.voltage
        && inbound_terminal.frequency == outbound_terminal.frequency
        && !inbound_terminal
            .protection_systems
            .is_disjoint(&outbound_terminal.protection_systems)
        && inbound_terminal.osm_way_id > 0
        && outbound_terminal.osm_way_id > 0
        && !inbound_terminal.geometry_lineage.is_empty()
        && !outbound_terminal.geometry_lineage.is_empty()
}

fn cross_berth_track_compatible(
    track: &TrackRecord,
    inbound_terminal: &TrackRecord,
    outbound_terminal: &TrackRecord,
) -> bool {
    cross_berth_terminal_compatible(inbound_terminal, outbound_terminal)
        && track.orderable
        && track.railway == "rail"
        && track.gauge_mm == STANDARD_GAUGE_MM
        && track.bidirectional
        && matches!(track.quality_class.as_str(), "A" | "B")
        && track.osm_way_id > 0
        && !track.geometry_lineage.is_empty()
        && track.source_id == inbound_terminal.source_id
        && track.electrified == inbound_terminal.electrified
        && track.voltage == inbound_terminal.voltage
        && track.frequency == inbound_terminal.frequency
        && !track
            .protection_systems
            .is_disjoint(&inbound_terminal.protection_systems)
        && !track
            .protection_systems
            .is_disjoint(&outbound_terminal.protection_systems)
}

fn bounded_cross_berth_labels(
    transaction: &redb::ReadTransaction,
    start_node: i64,
    inbound_terminal: &TrackRecord,
    outbound_terminal: &TrackRecord,
    maximum_path_edges: u32,
    maximum_path_length_mm: i64,
) -> Result<BTreeMap<i64, Vec<StablingSearchLabel>>> {
    let maximum_path_edges = usize::try_from(maximum_path_edges).map_err(|_| {
        GermanyOperationalV2Error::new("Cross-Berth-Hopgrenze ist nicht darstellbar.")
    })?;
    let initial_label = StablingSearchLabel {
        total_length_mm: 0,
        path: Vec::new(),
    };
    let search_context = format!("cross-berth:{start_node}");
    let mut track_cache = DirectedTrackCache::default();
    let mut stats = StablingSearchStats::default();
    let mut label_resident_bytes = stabling_label_resident_bytes(&initial_label);
    let mut labels =
        BTreeMap::<(i64, usize), StablingSearchLabel>::from([((start_node, 0), initial_label)]);
    stats.label_count = labels.len();
    for hop in 0..maximum_path_edges {
        let current_nodes: Vec<_> = labels
            .keys()
            .filter(|key| key.1 == hop)
            .map(|(node_id, _)| *node_id)
            .collect();
        for node_id in current_nodes {
            let label = labels
                .get(&(node_id, hop))
                .expect("Hop-Knoten stammt aus dem Cross-Berth-Labelindex")
                .clone();
            let adjacent = adjacent_directed_tracks(transaction, node_id, &mut track_cache)?;
            require_stabling_search_budget(
                &search_context,
                &track_cache,
                label_resident_bytes,
                0,
                &mut stats,
                0,
            )?;
            for (directed, next_node) in adjacent {
                if !cross_berth_track_compatible(
                    &directed.track,
                    inbound_terminal,
                    outbound_terminal,
                ) || label
                    .path
                    .iter()
                    .any(|edge| edge.track.id == directed.track.id)
                {
                    continue;
                }
                let next_total = label
                    .total_length_mm
                    .checked_add(directed.track.length_mm)
                    .ok_or_else(|| {
                        GermanyOperationalV2Error::new("Cross-Berth-Pfadlaenge laeuft ueber.")
                    })?;
                if next_total > maximum_path_length_mm {
                    continue;
                }
                let mut next_path = label.path.clone();
                next_path.push(directed);
                if !directed_path_is_simple_from(start_node, &next_path)? {
                    continue;
                }
                let next_hop = hop + 1;
                let next_label = StablingSearchLabel {
                    total_length_mm: next_total,
                    path: next_path,
                };
                let next_key = stabling_search_label_key(&next_label);
                let dominated = (0..=next_hop).any(|prior_hop| {
                    labels
                        .get(&(next_node, prior_hop))
                        .is_some_and(|prior| stabling_search_label_key(prior) <= next_key)
                });
                if !dominated {
                    let previous_label_bytes = labels
                        .get(&(next_node, next_hop))
                        .map_or(0, stabling_label_resident_bytes);
                    let next_label_bytes = stabling_label_resident_bytes(&next_label);
                    let next_resident_bytes = label_resident_bytes
                        .saturating_sub(previous_label_bytes)
                        .checked_add(next_label_bytes)
                        .ok_or_else(|| {
                            GermanyOperationalV2Error::new("Cross-Berth-Suchspeicher laeuft ueber.")
                        })?;
                    require(
                        labels.contains_key(&(next_node, next_hop))
                            || labels.len() < MAX_STABLING_SEARCH_LABELS,
                        format!(
                            "Cross-Berth-Suche ab Knoten {start_node} ueberschreitet die feste Grenze von {MAX_STABLING_SEARCH_LABELS} Suchlabels."
                        ),
                    )?;
                    require_stabling_search_budget(
                        &search_context,
                        &track_cache,
                        next_resident_bytes,
                        0,
                        &mut stats,
                        0,
                    )?;
                    label_resident_bytes = next_resident_bytes;
                    labels.insert((next_node, next_hop), next_label);
                    stats.label_count = labels.len();
                }
            }
        }
    }
    let mut by_node = BTreeMap::<i64, Vec<StablingSearchLabel>>::new();
    for ((node_id, _), label) in labels {
        by_node.entry(node_id).or_default().push(label);
    }
    for values in by_node.values_mut() {
        values.sort_by(|left, right| {
            stabling_search_label_key(left).cmp(&stabling_search_label_key(right))
        });
    }
    Ok(by_node)
}

fn cross_berth_connector_path_key(path: &CrossBerthConnectorPath) -> (i64, Vec<(&str, &str)>) {
    (
        path.total_length_mm,
        path.path
            .iter()
            .map(|edge| (edge.track.id.as_str(), edge.direction))
            .collect(),
    )
}

fn cross_berth_connector_paths(
    transaction: &redb::ReadTransaction,
    inbound_access: &TerminalNodeAccess,
    outbound_access: &TerminalNodeAccess,
    maximum_path_edges: u32,
    maximum_path_length_mm: i64,
) -> Result<Vec<CrossBerthConnectorPath>> {
    require(
        cross_berth_terminal_compatible(
            &inbound_access.terminal_track,
            &outbound_access.terminal_track,
        ),
        "Cross-Berth-Terminalkanten besitzen keinen gemeinsamen realen Betriebsvertrag.",
    )?;
    if inbound_access.node_id == outbound_access.node_id {
        return Ok(vec![CrossBerthConnectorPath {
            total_length_mm: 0,
            path: Vec::new(),
        }]);
    }
    let inbound_labels = bounded_cross_berth_labels(
        transaction,
        inbound_access.node_id,
        &inbound_access.terminal_track,
        &outbound_access.terminal_track,
        maximum_path_edges,
        maximum_path_length_mm,
    )?;
    let outbound_labels = bounded_cross_berth_labels(
        transaction,
        outbound_access.node_id,
        &inbound_access.terminal_track,
        &outbound_access.terminal_track,
        maximum_path_edges,
        maximum_path_length_mm,
    )?;
    let mut result = Vec::new();
    let mut result_resident_bytes = 0_usize;
    for (meeting_node, inbound_values) in &inbound_labels {
        let Some(outbound_values) = outbound_labels.get(meeting_node) else {
            continue;
        };
        let Some(inbound) = inbound_values.first() else {
            continue;
        };
        let Some(outbound) = outbound_values.first() else {
            continue;
        };
        let mut path = inbound.path.clone();
        path.extend(reverse_directed_path(&outbound.path)?);
        if path.is_empty()
            || !directed_path_is_simple_from(inbound_access.node_id, &path)?
            || directed_track_end_node(path.last().expect("nichtleerer Cross-Berth-Pfad"))?
                != outbound_access.node_id
        {
            continue;
        }
        let total_length_mm = inbound
            .total_length_mm
            .checked_add(outbound.total_length_mm)
            .ok_or_else(|| {
                GermanyOperationalV2Error::new("Cross-Berth-Verbindung laeuft in der Laenge ueber.")
            })?;
        require(
            result.len() < MAX_STABLING_CANDIDATES_PER_CASE,
            format!(
                "Cross-Berth-Verbindungssuche ueberschreitet die feste Grenze von {MAX_STABLING_CANDIDATES_PER_CASE} Pfaden."
            ),
        )?;
        let connector = CrossBerthConnectorPath {
            total_length_mm,
            path,
        };
        result_resident_bytes = result_resident_bytes
            .checked_add(
                std::mem::size_of::<CrossBerthConnectorPath>()
                    .saturating_add(directed_path_resident_bytes(&connector.path)),
            )
            .ok_or_else(|| {
                GermanyOperationalV2Error::new("Cross-Berth-Verbindungsspeicher laeuft ueber.")
            })?;
        require(
            result_resident_bytes <= MAX_STABLING_SEARCH_RESIDENT_BYTES,
            format!(
                "Cross-Berth-Verbindungssuche ueberschreitet das feste Speicherbudget von {MAX_STABLING_SEARCH_RESIDENT_BYTES} Bytes."
            ),
        )?;
        result.push(connector);
    }
    result.sort_by(|left, right| {
        cross_berth_connector_path_key(left).cmp(&cross_berth_connector_path_key(right))
    });
    result.dedup_by(|left, right| {
        left.path
            .iter()
            .map(|edge| (&edge.track.id, edge.direction))
            .eq(right
                .path
                .iter()
                .map(|edge| (&edge.track.id, edge.direction)))
    });
    Ok(result)
}

fn cross_berth_transfer_full_path(
    arrival: &StablingCandidate,
    connector: &CrossBerthConnectorPath,
    departure: &StablingCandidate,
) -> Result<Option<Vec<DirectedTrack>>> {
    let arrival_berth = arrival
        .path
        .last()
        .ok_or_else(|| GermanyOperationalV2Error::new("Cross-Berth-Ankunftspfad ist leer."))?;
    let departure_berth = departure
        .path
        .last()
        .ok_or_else(|| GermanyOperationalV2Error::new("Cross-Berth-Abfahrtspfad ist leer."))?;
    if arrival_berth.track.id == departure_berth.track.id {
        return Ok(None);
    }
    let mut path = reverse_directed_path(&arrival.path)?;
    path.extend(connector.path.iter().cloned());
    path.extend(departure.path.iter().cloned());
    let start_node = directed_track_start_node(
        path.first()
            .ok_or_else(|| GermanyOperationalV2Error::new("Cross-Berth-Pfad ist leer."))?,
    )?;
    Ok(directed_path_is_simple_from(start_node, &path)?.then_some(path))
}

fn directed_path_nodes(path: &[DirectedTrack]) -> Result<Vec<i64>> {
    let Some(first) = path.first() else {
        return Ok(Vec::new());
    };
    let mut nodes = Vec::with_capacity(path.len() + 1);
    nodes.push(directed_track_start_node(first)?);
    for edge in path {
        require(
            nodes.last().copied() == Some(directed_track_start_node(edge)?),
            "Gerichteter Abstellzugang besitzt eine physische Topologieluecke.",
        )?;
        nodes.push(directed_track_end_node(edge)?);
    }
    Ok(nodes)
}

fn directed_track_path_length_mm(path: &[DirectedTrack]) -> Result<i64> {
    path.iter().try_fold(0_i64, |total, edge| {
        total.checked_add(edge.track.length_mm).ok_or_else(|| {
            GermanyOperationalV2Error::new("Gerichtete Gleispfadlaenge laeuft ueber.")
        })
    })
}

fn cross_berth_transfer_path_key(path: &[DirectedTrack]) -> Result<(i64, Vec<(&str, &str)>)> {
    Ok((
        directed_track_path_length_mm(path)?,
        path.iter()
            .map(|edge| (edge.track.id.as_str(), edge.direction))
            .collect(),
    ))
}

fn shortest_cross_berth_transfer_full_path(
    arrival: &StablingCandidate,
    terminal_connectors: &[CrossBerthConnectorPath],
    departure: &StablingCandidate,
) -> Result<Option<Vec<DirectedTrack>>> {
    let arrival_berth = arrival
        .path
        .last()
        .ok_or_else(|| GermanyOperationalV2Error::new("Cross-Berth-Ankunftspfad ist leer."))?;
    let departure_berth = departure
        .path
        .last()
        .ok_or_else(|| GermanyOperationalV2Error::new("Cross-Berth-Abfahrtspfad ist leer."))?;
    if arrival_berth.track.id == departure_berth.track.id {
        return Ok(None);
    }

    let arrival_nodes = directed_path_nodes(&arrival.path)?;
    let departure_nodes = directed_path_nodes(&departure.path)?;
    let mut shortest: Option<Vec<DirectedTrack>> = None;
    let mut retain_shortest = |path: Vec<DirectedTrack>| -> Result<()> {
        let replace = shortest.as_ref().is_none_or(|current| {
            cross_berth_transfer_path_key(&path).expect("validierte Cross-Berth-Pfadlaenge")
                < cross_berth_transfer_path_key(current).expect("validierte Cross-Berth-Pfadlaenge")
        });
        if replace {
            shortest = Some(path);
        }
        Ok(())
    };

    // Zwei getrennte Berths koennen einen realen gemeinsamen Zugangsknoten besitzen,
    // obwohl ihre Passenger-Terminalknoten verschieden sind. In diesem Fall wird nur
    // der physisch notwendige Suffix des Ankunftszugangs rueckwaerts und der Suffix
    // des Abfahrtszugangs vorwaerts befahren. Das vermeidet sowohl Teleportation als
    // auch eine doppelte Befahrung des bereits gemeinsam genutzten Zugangsstamms.
    for (arrival_index, arrival_node) in arrival_nodes.iter().take(arrival.path.len()).enumerate() {
        for (departure_index, departure_node) in departure_nodes
            .iter()
            .take(departure.path.len())
            .enumerate()
        {
            if arrival_node != departure_node {
                continue;
            }
            let mut path = reverse_directed_path(&arrival.path[arrival_index..])?;
            path.extend(departure.path[departure_index..].iter().cloned());
            let start_node =
                directed_track_start_node(path.first().ok_or_else(|| {
                    GermanyOperationalV2Error::new("Cross-Berth-Pfad ist leer.")
                })?)?;
            if directed_path_is_simple_from(start_node, &path)? {
                retain_shortest(path)?;
            }
        }
    }

    for connector in terminal_connectors {
        if let Some(path) = cross_berth_transfer_full_path(arrival, connector, departure)? {
            retain_shortest(path)?;
        }
    }
    Ok(shortest)
}

fn terminal_node_access(
    track: TrackRecord,
    direction: &str,
    offset_mm: i64,
    toward_route_direction: bool,
) -> Result<TerminalNodeAccess> {
    let (node_id, boundary_mm, leg_entry_mm, leg_exit_mm) =
        match (direction, toward_route_direction) {
            ("along", true) => (
                track.to_node_id,
                track.length_mm,
                offset_mm,
                track.length_mm,
            ),
            ("against", true) => (track.from_node_id, 0, offset_mm, 0),
            ("along", false) => (track.from_node_id, 0, 0, offset_mm),
            ("against", false) => (
                track.to_node_id,
                track.length_mm,
                track.length_mm,
                offset_mm,
            ),
            _ => {
                return Err(GermanyOperationalV2Error::new(format!(
                    "Terminalkante `{}` besitzt ungueltige Richtung `{direction}`.",
                    track.id
                )));
            }
        };
    require(
        (0..=track.length_mm).contains(&offset_mm),
        format!(
            "Terminalzugang {offset_mm} liegt ausserhalb der Kante `{}`.",
            track.id
        ),
    )?;
    let connecting_leg = (leg_entry_mm != leg_exit_mm)
        .then(|| derived_leg(&track, direction, leg_entry_mm, leg_exit_mm));
    debug_assert_eq!(node_at_offset(&track, boundary_mm), Some(node_id));
    Ok(TerminalNodeAccess {
        terminal_track: track,
        node_id,
        connecting_leg,
    })
}

fn inbound_terminal_access(
    transaction: &redb::ReadTransaction,
    route: &TimetableRouteInput,
) -> Result<TerminalNodeAccess> {
    let leg = route.legs.last().expect("validierter Ankunftslaufweg");
    terminal_node_access(
        get_track(transaction, &leg.edge_id)?,
        &leg.direction,
        leg.edge_exit_mm,
        true,
    )
}

fn outbound_terminal_access(
    transaction: &redb::ReadTransaction,
    route: &TimetableRouteInput,
) -> Result<TerminalNodeAccess> {
    let leg = route.legs.first().expect("validierter Ausgangslaufweg");
    terminal_node_access(
        get_track(transaction, &leg.edge_id)?,
        &leg.direction,
        leg.edge_entry_mm,
        false,
    )
}

#[derive(Eq, Ord, PartialEq, PartialOrd)]
struct PairedStablingPathKey<'a> {
    stabling_kind: StablingKind,
    arrival_berth_assignment: TurnaroundBerthAssignment,
    departure_berth_assignment: TurnaroundBerthAssignment,
    total_length_mm: i64,
    inbound_path: Vec<(&'a str, &'a str)>,
    berth_transfer_path: Vec<(&'a str, &'a str)>,
    outbound_path: Vec<(&'a str, &'a str)>,
}

fn paired_stabling_path_key(candidate: &PairedStablingCandidate) -> PairedStablingPathKey<'_> {
    PairedStablingPathKey {
        stabling_kind: candidate.stabling_kind,
        arrival_berth_assignment: candidate.arrival_berth_assignment,
        departure_berth_assignment: candidate.departure_berth_assignment,
        total_length_mm: candidate.total_length_mm,
        inbound_path: candidate
            .inbound_path
            .iter()
            .map(|edge| (edge.track.id.as_str(), edge.direction))
            .collect(),
        berth_transfer_path: candidate
            .berth_transfer_path
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|edge| (edge.track.id.as_str(), edge.direction))
            .collect(),
        outbound_path: candidate
            .outbound_path
            .iter()
            .map(|edge| (edge.track.id.as_str(), edge.direction))
            .collect(),
    }
}

fn stabling_candidate_shortest_cmp(
    left: &StablingCandidate,
    right: &StablingCandidate,
) -> std::cmp::Ordering {
    left.total_length_mm
        .cmp(&right.total_length_mm)
        .then_with(|| {
            left.path
                .iter()
                .map(|edge| (edge.track.id.as_bytes(), edge.direction.as_bytes()))
                .cmp(
                    right
                        .path
                        .iter()
                        .map(|edge| (edge.track.id.as_bytes(), edge.direction.as_bytes())),
                )
        })
}

fn candidate_berth_edge_ids(candidates: &[StablingCandidate]) -> Vec<String> {
    let mut result: Vec<_> = candidates
        .iter()
        .map(|candidate| {
            candidate
                .path
                .last()
                .expect("Abstellkandidat besitzt eine Zielkante")
                .track
                .id
                .clone()
        })
        .collect();
    result.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    result.dedup();
    result
}

fn paired_stabling_candidates(
    transaction: &redb::ReadTransaction,
    inbound_access: &TerminalNodeAccess,
    outbound_access: &TerminalNodeAccess,
    policy: StablingSearchPolicy,
    inbound_route_id: &str,
    outbound_route_id: &str,
) -> Result<PairedStablingSearch> {
    let inbound_search = stabling_candidates(
        transaction,
        &inbound_access.terminal_track,
        inbound_access.node_id,
        policy,
        inbound_route_id,
    )?;
    debug_assert_eq!(
        inbound_search.candidates.len() + inbound_search.stats.duplicate_candidate_count,
        inbound_search.stats.raw_candidate_count
    );
    let inbound_candidates = inbound_search.candidates;
    let outbound_search = stabling_candidates(
        transaction,
        &outbound_access.terminal_track,
        outbound_access.node_id,
        policy,
        outbound_route_id,
    )?;
    debug_assert_eq!(
        outbound_search.candidates.len() + outbound_search.stats.duplicate_candidate_count,
        outbound_search.stats.raw_candidate_count
    );
    let outbound_candidates = outbound_search.candidates;
    let mut outbound_by_berth = BTreeMap::<&str, &StablingCandidate>::new();
    for candidate in &outbound_candidates {
        let berth = candidate
            .path
            .last()
            .expect("Abstellpfad besitzt Zielkante");
        outbound_by_berth.insert(berth.track.id.as_str(), candidate);
    }
    let inbound_access_length = inbound_access.connecting_leg.as_ref().map_or(0_i64, |leg| {
        i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm)).unwrap_or(i64::MAX)
    });
    let outbound_access_length = outbound_access
        .connecting_leg
        .as_ref()
        .map_or(0_i64, |leg| {
            i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm)).unwrap_or(i64::MAX)
        });
    let inbound_candidate_count = inbound_candidates.len();
    let outbound_candidate_count = outbound_candidates.len();
    let minimum_inbound_candidate_path_edges = inbound_candidates
        .iter()
        .map(|candidate| candidate.path.len())
        .min();
    let minimum_outbound_candidate_path_edges = outbound_candidates
        .iter()
        .map(|candidate| candidate.path.len())
        .min();
    let minimum_inbound_candidate_path_length_mm = inbound_candidates
        .iter()
        .map(|candidate| candidate.total_length_mm)
        .min();
    let minimum_outbound_candidate_path_length_mm = outbound_candidates
        .iter()
        .map(|candidate| candidate.total_length_mm)
        .min();
    let inbound_candidate_berth_edge_ids = candidate_berth_edge_ids(&inbound_candidates);
    let outbound_candidate_berth_edge_ids = candidate_berth_edge_ids(&outbound_candidates);
    let shortest_inbound_candidate_path = inbound_candidates
        .iter()
        .min_by(|left, right| stabling_candidate_shortest_cmp(left, right))
        .cloned();
    let shortest_outbound_candidate_path = outbound_candidates
        .iter()
        .min_by(|left, right| stabling_candidate_shortest_cmp(left, right))
        .cloned();
    let mut result = Vec::new();
    let mut result_resident_bytes = 0_usize;
    for inbound in &inbound_candidates {
        let inbound_berth = inbound.path.last().expect("Abstellpfad besitzt Zielkante");
        let Some(outbound) = outbound_by_berth.get(inbound_berth.track.id.as_str()) else {
            continue;
        };
        let total_length_mm = inbound
            .total_length_mm
            .checked_add(outbound.total_length_mm)
            .and_then(|value| value.checked_add(inbound_access_length))
            .and_then(|value| value.checked_add(outbound_access_length))
            .ok_or_else(|| {
                GermanyOperationalV2Error::new("Asymmetrische Abstellpfadlaenge laeuft ueber.")
            })?;
        require(
            result.len() < MAX_STABLING_CANDIDATES_PER_CASE,
            format!(
                "Gemeinsame Abstellkandidatensuche fuer `{inbound_route_id}` -> `{outbound_route_id}` ueberschreitet die feste Grenze von {MAX_STABLING_CANDIDATES_PER_CASE} Kandidaten."
            ),
        )?;
        let candidate = PairedStablingCandidate {
            total_length_mm,
            inbound_path: inbound.path.clone(),
            outbound_path: outbound.path.clone(),
            stabling_kind: StablingKind::SharedBerth,
            arrival_berth_assignment: inbound.berth_assignment,
            departure_berth_assignment: outbound.berth_assignment,
            berth_transfer_path: None,
            berth_transfer_provenance: None,
        };
        result_resident_bytes = result_resident_bytes
            .checked_add(paired_stabling_candidate_resident_bytes(&candidate))
            .ok_or_else(|| {
                GermanyOperationalV2Error::new(
                    "Gekoppelter Abstellkandidatenspeicher laeuft ueber.",
                )
            })?;
        require(
            result_resident_bytes <= MAX_STABLING_SEARCH_RESIDENT_BYTES,
            format!(
                "Gemeinsame Abstellkandidatensuche fuer `{inbound_route_id}` -> `{outbound_route_id}` ueberschreitet das feste Speicherbudget von {MAX_STABLING_SEARCH_RESIDENT_BYTES} Bytes."
            ),
        )?;
        result.push(candidate);
    }
    result.sort_by(|left, right| {
        paired_stabling_path_key(left).cmp(&paired_stabling_path_key(right))
    });
    Ok(PairedStablingSearch {
        candidates: result,
        inbound_candidate_count,
        outbound_candidate_count,
        minimum_inbound_candidate_path_edges,
        minimum_outbound_candidate_path_edges,
        minimum_inbound_candidate_path_length_mm,
        minimum_outbound_candidate_path_length_mm,
        inbound_candidate_berth_edge_ids,
        outbound_candidate_berth_edge_ids,
        shortest_inbound_candidate_path,
        shortest_outbound_candidate_path,
        inbound_candidates,
        outbound_candidates,
    })
}

fn minimum_option<T: Ord>(left: Option<T>, right: Option<T>) -> Option<T> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (left @ Some(_), None) => left,
        (None, right) => right,
    }
}

fn merge_candidate_edge_ids(target: &mut Vec<String>, source: Vec<String>) {
    target.extend(source);
    target.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    target.dedup();
}

fn merge_shortest_candidate(
    target: &mut Option<StablingCandidate>,
    source: Option<StablingCandidate>,
) {
    let Some(source) = source else {
        return;
    };
    if target
        .as_ref()
        .is_none_or(|current| stabling_candidate_shortest_cmp(&source, current).is_lt())
    {
        *target = Some(source);
    }
}

fn merge_stabling_search_diagnostics(
    target: &mut PairedStablingSearch,
    source: PairedStablingSearch,
) {
    target.inbound_candidate_count = target
        .inbound_candidate_count
        .saturating_add(source.inbound_candidate_count);
    target.outbound_candidate_count = target
        .outbound_candidate_count
        .saturating_add(source.outbound_candidate_count);
    target.minimum_inbound_candidate_path_edges = minimum_option(
        target.minimum_inbound_candidate_path_edges,
        source.minimum_inbound_candidate_path_edges,
    );
    target.minimum_outbound_candidate_path_edges = minimum_option(
        target.minimum_outbound_candidate_path_edges,
        source.minimum_outbound_candidate_path_edges,
    );
    target.minimum_inbound_candidate_path_length_mm = minimum_option(
        target.minimum_inbound_candidate_path_length_mm,
        source.minimum_inbound_candidate_path_length_mm,
    );
    target.minimum_outbound_candidate_path_length_mm = minimum_option(
        target.minimum_outbound_candidate_path_length_mm,
        source.minimum_outbound_candidate_path_length_mm,
    );
    merge_candidate_edge_ids(
        &mut target.inbound_candidate_berth_edge_ids,
        source.inbound_candidate_berth_edge_ids,
    );
    merge_candidate_edge_ids(
        &mut target.outbound_candidate_berth_edge_ids,
        source.outbound_candidate_berth_edge_ids,
    );
    merge_shortest_candidate(
        &mut target.shortest_inbound_candidate_path,
        source.shortest_inbound_candidate_path,
    );
    merge_shortest_candidate(
        &mut target.shortest_outbound_candidate_path,
        source.shortest_outbound_candidate_path,
    );
    target.inbound_candidates.extend(source.inbound_candidates);
    target
        .inbound_candidates
        .sort_by(|left, right| stabling_path_key(left).cmp(&stabling_path_key(right)));
    target.inbound_candidates.dedup_by(|left, right| {
        left.path
            .last()
            .expect("Inbound-Abstellkandidat besitzt eine Zielkante")
            .track
            .id
            == right
                .path
                .last()
                .expect("Inbound-Abstellkandidat besitzt eine Zielkante")
                .track
                .id
    });
    target
        .outbound_candidates
        .extend(source.outbound_candidates);
    target
        .outbound_candidates
        .sort_by(|left, right| stabling_path_key(left).cmp(&stabling_path_key(right)));
    target.outbound_candidates.dedup_by(|left, right| {
        left.path
            .last()
            .expect("Outbound-Abstellkandidat besitzt eine Zielkante")
            .track
            .id
            == right
                .path
                .last()
                .expect("Outbound-Abstellkandidat besitzt eine Zielkante")
                .track
                .id
    });
}

fn cross_berth_stabling_candidates(
    transaction: &redb::ReadTransaction,
    inbound_access: &TerminalNodeAccess,
    outbound_access: &TerminalNodeAccess,
    policy: StablingSearchPolicy,
    inbound_candidates: &[StablingCandidate],
    outbound_candidates: &[StablingCandidate],
    demand: &TurnaroundPairDemand,
) -> Result<Vec<PairedStablingCandidate>> {
    if inbound_candidates.is_empty() || outbound_candidates.is_empty() {
        return Ok(Vec::new());
    }
    if !cross_berth_terminal_compatible(
        &inbound_access.terminal_track,
        &outbound_access.terminal_track,
    ) {
        return Ok(Vec::new());
    }
    require(
        !demand.source_location_id.is_empty()
            && demand.source_location_id == demand.target_location_id
            && !demand.source_physical_stop_id.is_empty()
            && demand.source_physical_stop_id == demand.target_physical_stop_id,
        format!(
            "Cross-Berth-Demand `{}` ist nicht am identischen autoritativen Ort und physischen Halt gebunden.",
            demand.id
        ),
    )?;
    let connectors = cross_berth_connector_paths(
        transaction,
        inbound_access,
        outbound_access,
        policy.maximum_path_edges,
        policy.maximum_path_length_mm,
    )?;
    let inbound_access_length = inbound_access.connecting_leg.as_ref().map_or(0_i64, |leg| {
        i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm)).unwrap_or(i64::MAX)
    });
    let outbound_access_length = outbound_access
        .connecting_leg
        .as_ref()
        .map_or(0_i64, |leg| {
            i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm)).unwrap_or(i64::MAX)
        });
    let provenance = BerthTransferProvenance {
        geometry_provenance: BerthGeometryProvenance::RealOsmRail,
        routing_rule: BerthTransferRoutingRule::RealOsmRailBidirectionalBoundedV1,
        location_id: demand.source_location_id.clone(),
        physical_stop_id: demand.source_physical_stop_id.clone(),
        maximum_path_edges_per_side: policy.maximum_path_edges,
        maximum_path_length_mm_per_side: policy.maximum_path_length_mm,
    };
    let mut used_berth_pairs = BTreeSet::new();
    let mut result = Vec::new();
    let mut result_resident_bytes = 0_usize;
    for arrival in inbound_candidates {
        for departure in outbound_candidates {
            if let Some(berth_transfer_path) =
                shortest_cross_berth_transfer_full_path(arrival, &connectors, departure)?
            {
                let berth_transfer_path_length_mm =
                    directed_track_path_length_mm(&berth_transfer_path)?;
                let total_length_mm = arrival
                    .total_length_mm
                    .checked_add(berth_transfer_path_length_mm)
                    .and_then(|value| value.checked_add(departure.total_length_mm))
                    .and_then(|value| value.checked_add(inbound_access_length))
                    .and_then(|value| value.checked_add(outbound_access_length))
                    .ok_or_else(|| {
                        GermanyOperationalV2Error::new(
                            "Cross-Berth-Abstellpfadlaenge laeuft ueber.",
                        )
                    })?;
                let arrival_berth_id = arrival
                    .path
                    .last()
                    .expect("Cross-Berth-Ankunftspfad besitzt eine Zielkante")
                    .track
                    .id
                    .clone();
                let departure_berth_id = departure
                    .path
                    .last()
                    .expect("Cross-Berth-Abfahrtspfad besitzt eine Zielkante")
                    .track
                    .id
                    .clone();
                if !used_berth_pairs.insert((arrival_berth_id, departure_berth_id)) {
                    continue;
                }
                require(
                    result.len() < MAX_STABLING_CANDIDATES_PER_CASE,
                    format!(
                        "Cross-Berth-Demand `{}` ueberschreitet die feste Grenze von {MAX_STABLING_CANDIDATES_PER_CASE} Kandidaten.",
                        demand.id
                    ),
                )?;
                let candidate = PairedStablingCandidate {
                    total_length_mm,
                    inbound_path: arrival.path.clone(),
                    outbound_path: departure.path.clone(),
                    stabling_kind: StablingKind::CrossBerthTransfer,
                    arrival_berth_assignment: arrival.berth_assignment,
                    departure_berth_assignment: departure.berth_assignment,
                    berth_transfer_path: Some(berth_transfer_path),
                    berth_transfer_provenance: Some(provenance.clone()),
                };
                result_resident_bytes = result_resident_bytes
                    .checked_add(paired_stabling_candidate_resident_bytes(&candidate))
                    .ok_or_else(|| {
                        GermanyOperationalV2Error::new(
                            "Cross-Berth-Kandidatenspeicher laeuft ueber.",
                        )
                    })?;
                require(
                    result_resident_bytes <= MAX_STABLING_SEARCH_RESIDENT_BYTES,
                    format!(
                        "Cross-Berth-Demand `{}` ueberschreitet das feste Speicherbudget von {MAX_STABLING_SEARCH_RESIDENT_BYTES} Bytes.",
                        demand.id
                    ),
                )?;
                result.push(candidate);
            }
        }
    }
    result.sort_by(|left, right| {
        paired_stabling_path_key(left).cmp(&paired_stabling_path_key(right))
    });
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn paired_stabling_candidates_with_fallback(
    transaction: &redb::ReadTransaction,
    inbound_access: &TerminalNodeAccess,
    outbound_access: &TerminalNodeAccess,
    formation_length_mm: i64,
    minimum_clearance_mm: i64,
    maximum_path_edges: u32,
    maximum_path_length_mm: i64,
    inbound_route_id: &str,
    outbound_route_id: &str,
    demand: &TurnaroundPairDemand,
) -> Result<PairedStablingSearch> {
    let observed_policy = StablingSearchPolicy {
        formation_length_mm,
        minimum_clearance_mm,
        maximum_path_edges,
        maximum_path_length_mm,
        search_mode: BerthSearchMode::ObservedSiding,
    };
    let observed = paired_stabling_candidates(
        transaction,
        inbound_access,
        outbound_access,
        observed_policy,
        inbound_route_id,
        outbound_route_id,
    )?;
    if !observed.candidates.is_empty() {
        return Ok(observed);
    }
    let fallback_policy = StablingSearchPolicy {
        search_mode: BerthSearchMode::SimulatedOperationalFallback,
        ..observed_policy
    };
    let mut fallback = paired_stabling_candidates(
        transaction,
        inbound_access,
        outbound_access,
        fallback_policy,
        inbound_route_id,
        outbound_route_id,
    )?;
    if fallback.candidates.is_empty() {
        merge_stabling_search_diagnostics(&mut fallback, observed);
        fallback.candidates = cross_berth_stabling_candidates(
            transaction,
            inbound_access,
            outbound_access,
            fallback_policy,
            &fallback.inbound_candidates,
            &fallback.outbound_candidates,
            demand,
        )?;
    }
    Ok(fallback)
}

fn directed_offsets(track: &TrackRecord, direction: &str) -> Result<(i64, i64)> {
    match direction {
        "along" => Ok((0, track.length_mm)),
        "against" => Ok((track.length_mm, 0)),
        _ => Err(GermanyOperationalV2Error::new(format!(
            "Gleiskante `{}` besitzt ungueltige Richtung `{direction}`.",
            track.id
        ))),
    }
}

fn derived_leg(
    track: &TrackRecord,
    direction: &str,
    edge_entry_mm: i64,
    edge_exit_mm: i64,
) -> TimetableLegInput {
    TimetableLegInput {
        edge_id: track.id.clone(),
        direction: direction.to_owned(),
        edge_entry_mm,
        edge_exit_mm,
        available_protection_systems: track.protection_systems.iter().cloned().collect(),
        simultaneously_required_protection_systems: Vec::new(),
    }
}

fn route_length(route: &TimetableRouteInput) -> Result<i64> {
    route.legs.iter().try_fold(0_i64, |total, leg| {
        total
            .checked_add(
                i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm)).unwrap_or(i64::MAX),
            )
            .ok_or_else(|| {
                GermanyOperationalV2Error::new(format!(
                    "Laufweg `{}` laeuft in der Laenge ueber.",
                    route.route_version_id
                ))
            })
    })
}

fn minimum_route_runtime_ms(
    transaction: &redb::ReadTransaction,
    route: &TimetableRouteInput,
    authority_start_route_mm: i64,
) -> Result<i64> {
    let route_length_mm = route_length(route)?;
    require(
        (0..route_length_mm).contains(&authority_start_route_mm),
        format!(
            "Laufweg `{}` besitzt keinen Bewegungsabschnitt hinter {authority_start_route_mm} mm.",
            route.route_version_id
        ),
    )?;
    let mut cursor_mm = 0_i64;
    let mut runtime_ms = 0_i64;
    for leg in &route.legs {
        let leg_length_mm =
            i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm)).unwrap_or(i64::MAX);
        let leg_end_mm = cursor_mm.checked_add(leg_length_mm).ok_or_else(|| {
            GermanyOperationalV2Error::new("Laufzeit-Laufweglaenge laeuft ueber.")
        })?;
        if leg_end_mm > authority_start_route_mm {
            let movement_start_mm = cursor_mm.max(authority_start_route_mm);
            let movement_length_mm =
                leg_end_mm.checked_sub(movement_start_mm).ok_or_else(|| {
                    GermanyOperationalV2Error::new("Laufzeitintervall ist ungueltig.")
                })?;
            let track = get_track(transaction, &leg.edge_id)?;
            let speed_mmps = match leg.direction.as_str() {
                "along" => track.speed_along_mmps,
                "against" => track.speed_against_mmps,
                direction => {
                    return Err(GermanyOperationalV2Error::new(format!(
                        "Laufweg `{}` besitzt ungueltige Richtung `{direction}`.",
                        route.route_version_id
                    )));
                }
            };
            require(
                speed_mmps > 0,
                format!(
                    "Laufweg `{}` besitzt keine positive native Laufzeitgeschwindigkeit.",
                    route.route_version_id
                ),
            )?;
            let numerator = movement_length_mm
                .checked_mul(1_000)
                .and_then(|value| value.checked_add(i64::from(speed_mmps) - 1))
                .ok_or_else(|| GermanyOperationalV2Error::new("Laufzeit laeuft ueber."))?;
            runtime_ms = runtime_ms
                .checked_add(numerator / i64::from(speed_mmps))
                .ok_or_else(|| GermanyOperationalV2Error::new("Laufzeit laeuft ueber."))?;
        }
        cursor_mm = leg_end_mm;
    }
    require(
        runtime_ms > 0,
        format!(
            "Laufweg `{}` besitzt keine positive native Mindestlaufzeit.",
            route.route_version_id
        ),
    )?;
    Ok(runtime_ms)
}

fn resource_set_sha256(resources: &BTreeSet<String>) -> String {
    let mut hasher = Sha256::new();
    for resource in resources {
        hasher.update(resource.as_bytes());
        hasher.update(b"\n");
    }
    digest_hex(hasher.finalize())
}

fn protection_contract_runs(legs: &[TimetableLegInput]) -> Result<Vec<ProtectionContractRun>> {
    let mut runs = Vec::<ProtectionContractRun>::new();
    for (index, leg) in legs.iter().enumerate() {
        let through_route_leg_index = u32::try_from(index)
            .map_err(|_| GermanyOperationalV2Error::new("Zu viele Laufweg-Legs."))?;
        if let Some(previous) = runs.last_mut().filter(|previous| {
            previous.available_protection_systems == leg.available_protection_systems
                && previous.simultaneously_required_protection_systems
                    == leg.simultaneously_required_protection_systems
        }) {
            previous.through_route_leg_index = through_route_leg_index;
        } else {
            runs.push(ProtectionContractRun {
                through_route_leg_index,
                available_protection_systems: leg.available_protection_systems.clone(),
                simultaneously_required_protection_systems: leg
                    .simultaneously_required_protection_systems
                    .clone(),
            });
        }
    }
    require(!runs.is_empty(), "Schutzvertrag besitzt keine Laeufe.")?;
    Ok(runs)
}

fn formation_tail_legs(
    route: &TimetableRouteInput,
    formation_length_mm: i64,
    context: &str,
) -> Result<Vec<TimetableLegInput>> {
    require(
        formation_length_mm > 0,
        format!("{context} besitzt keine positive Formationslaenge."),
    )?;
    let mut remaining_mm = formation_length_mm;
    let mut reversed = Vec::new();
    for leg in route.legs.iter().rev() {
        if remaining_mm == 0 {
            break;
        }
        let leg_length_mm =
            i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm)).unwrap_or(i64::MAX);
        if remaining_mm >= leg_length_mm {
            reversed.push(leg.clone());
            remaining_mm = remaining_mm.checked_sub(leg_length_mm).ok_or_else(|| {
                GermanyOperationalV2Error::new(format!("{context} laeuft in der Laenge ueber."))
            })?;
        } else {
            let seed_entry = match leg.direction.as_str() {
                "along" => leg.edge_exit_mm.checked_sub(remaining_mm),
                "against" => leg.edge_exit_mm.checked_add(remaining_mm),
                _ => None,
            }
            .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context} laeuft ueber.")))?;
            reversed.push(passenger_leg_slice(leg, seed_entry, leg.edge_exit_mm));
            remaining_mm = 0;
        }
    }
    require(
        remaining_mm == 0,
        format!("{context} deckt die Formation nicht physisch ab."),
    )?;
    reversed.reverse();
    Ok(reversed)
}

fn formation_prefix_and_remainder(
    route: &TimetableRouteInput,
    formation_length_mm: i64,
    context: &str,
) -> Result<(Vec<TimetableLegInput>, Vec<TimetableLegInput>)> {
    require(
        formation_length_mm > 0,
        format!("{context} besitzt keine positive Formationslaenge."),
    )?;
    let mut remaining_mm = formation_length_mm;
    let mut prefix = Vec::new();
    let mut remainder = Vec::new();
    for leg in &route.legs {
        if remaining_mm == 0 {
            remainder.push(leg.clone());
            continue;
        }
        let leg_length_mm =
            i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm)).unwrap_or(i64::MAX);
        if remaining_mm >= leg_length_mm {
            prefix.push(leg.clone());
            remaining_mm = remaining_mm.checked_sub(leg_length_mm).ok_or_else(|| {
                GermanyOperationalV2Error::new(format!("{context} laeuft in der Laenge ueber."))
            })?;
        } else {
            let seed_exit = match leg.direction.as_str() {
                "along" => leg.edge_entry_mm.checked_add(remaining_mm),
                "against" => leg.edge_entry_mm.checked_sub(remaining_mm),
                _ => None,
            }
            .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context} laeuft ueber.")))?;
            prefix.push(passenger_leg_slice(leg, leg.edge_entry_mm, seed_exit));
            remainder.push(passenger_leg_slice(leg, seed_exit, leg.edge_exit_mm));
            remaining_mm = 0;
        }
    }
    require(
        remaining_mm == 0 && !remainder.is_empty(),
        format!("{context} deckt die Formation oder die folgende Bewegung nicht physisch ab."),
    )?;
    Ok((prefix, remainder))
}

fn terminal_intervals(seed: &[TimetableLegInput]) -> Vec<TurnaroundTerminalInterval> {
    seed.iter()
        .map(|leg| TurnaroundTerminalInterval {
            edge_id: leg.edge_id.clone(),
            from_mm: leg.edge_entry_mm.min(leg.edge_exit_mm),
            to_mm: leg.edge_entry_mm.max(leg.edge_exit_mm),
        })
        .collect()
}

fn canonical_terminal_occupancy(
    seed: &[TimetableLegInput],
    flip_direction: bool,
) -> BTreeSet<(String, i64, i64, String)> {
    seed.iter()
        .map(|leg| {
            let direction = if flip_direction {
                reverse_direction(&leg.direction).unwrap_or("invalid")
            } else {
                leg.direction.as_str()
            };
            (
                leg.edge_id.clone(),
                leg.edge_entry_mm.min(leg.edge_exit_mm),
                leg.edge_entry_mm.max(leg.edge_exit_mm),
                direction.to_owned(),
            )
        })
        .collect()
}

fn normalized_directed_intervals(
    legs: &[TimetableLegInput],
    reverse: bool,
) -> Result<Vec<(String, String, i64, i64)>> {
    let directed = if reverse {
        legs.iter()
            .rev()
            .map(|leg| {
                Ok((
                    leg.edge_id.clone(),
                    reverse_direction(&leg.direction)?.to_owned(),
                    leg.edge_exit_mm,
                    leg.edge_entry_mm,
                ))
            })
            .collect::<Result<Vec<_>>>()?
    } else {
        legs.iter()
            .map(|leg| {
                (
                    leg.edge_id.clone(),
                    leg.direction.clone(),
                    leg.edge_entry_mm,
                    leg.edge_exit_mm,
                )
            })
            .collect()
    };
    let mut normalized: Vec<(String, String, i64, i64)> = Vec::new();
    for interval in directed {
        if let Some(previous) = normalized.last_mut()
            && previous.0 == interval.0
            && previous.1 == interval.1
            && previous.3 == interval.2
        {
            previous.3 = interval.3;
        } else {
            normalized.push(interval);
        }
    }
    Ok(normalized)
}

fn movement_continuity(
    predecessor: &TimetableRouteInput,
    successor: &TimetableRouteInput,
    head_route_mm: i64,
) -> Result<MovementContinuity> {
    require(
        successor.predecessor_id.as_deref() == Some(predecessor.route_version_id.as_str())
            && successor.transition_route_mm == Some(head_route_mm),
        format!(
            "Laufweg `{}` bindet nicht exakt den geometrisch geprueften Vorgaenger `{}` bei {head_route_mm} mm.",
            successor.route_version_id, predecessor.route_version_id
        ),
    )?;
    let predecessor_seed = formation_tail_legs(
        predecessor,
        head_route_mm,
        &format!("Fortsetzungsvorgaenger `{}`", predecessor.route_version_id),
    )?;
    let (successor_seed, _) = formation_prefix_and_remainder(
        successor,
        head_route_mm,
        &format!("Fortsetzungsziel `{}`", successor.route_version_id),
    )?;
    let successor_intervals = normalized_directed_intervals(&successor_seed, false)?;
    let same_direction =
        normalized_directed_intervals(&predecessor_seed, false)? == successor_intervals;
    let reverse_direction =
        normalized_directed_intervals(&predecessor_seed, true)? == successor_intervals;
    require(
        same_direction != reverse_direction,
        format!(
            "Laufweg `{}` besitzt zum Vorgaenger `{}` keine eindeutige physische Fortsetzungsrichtung.",
            successor.route_version_id, predecessor.route_version_id
        ),
    )?;
    Ok(if same_direction {
        MovementContinuity::SameDirection
    } else {
        MovementContinuity::ReverseDirection
    })
}

fn require_movement_continuity(
    predecessor: &TimetableRouteInput,
    successor: &TimetableRouteInput,
    head_route_mm: i64,
    expected: MovementContinuity,
) -> Result<MovementContinuity> {
    let actual = movement_continuity(predecessor, successor, head_route_mm)?;
    require(
        actual == expected,
        format!(
            "Laufweg `{}` widerspricht mit Fortsetzung {:?} der signierten physischen Richtung {:?}.",
            successor.route_version_id, expected, actual
        ),
    )?;
    Ok(actual)
}

fn preflight_endpoint(track: &TrackRecord, offset_mm: i64) -> TurnaroundPreflightEndpoint {
    TurnaroundPreflightEndpoint {
        edge_id: track.id.clone(),
        offset_mm,
        osm_node_id: node_at_offset(track, offset_mm),
    }
}

fn preflight_candidate_path(candidate: &StablingCandidate) -> TurnaroundPreflightCandidatePath {
    TurnaroundPreflightCandidatePath {
        path_length_mm: candidate.total_length_mm,
        berth_edge_id: candidate
            .path
            .last()
            .expect("Abstellkandidat besitzt eine Zielkante")
            .track
            .id
            .clone(),
        berth_assignment: candidate.berth_assignment,
        legs: candidate
            .path
            .iter()
            .map(|edge| TurnaroundPreflightPathLeg {
                edge_id: edge.track.id.clone(),
                direction: edge.direction.to_owned(),
            })
            .collect(),
    }
}

fn direct_preflight_reason(
    transaction: &redb::ReadTransaction,
    inbound: &TimetableRouteInput,
    outbound: &TimetableRouteInput,
    formation_length_mm: i64,
) -> Result<Option<&'static str>> {
    let inbound_leg = inbound.legs.last().expect("validierte Ankunftsroute");
    let outbound_leg = outbound.legs.first().expect("validierte Ausgangsroute");
    let inbound_track = get_track(transaction, &inbound_leg.edge_id)?;
    let outbound_track = get_track(transaction, &outbound_leg.edge_id)?;
    if !same_physical_point(
        &inbound_track,
        inbound_leg.edge_exit_mm,
        &outbound_track,
        outbound_leg.edge_entry_mm,
    ) {
        return Ok(Some("different-physical-terminal"));
    }
    let Ok(inbound_seed) =
        formation_tail_legs(inbound, formation_length_mm, "Turnaround-Preflight-Ankunft")
    else {
        return Ok(Some("inbound-formation-does-not-fit"));
    };
    let Ok((outbound_seed, outbound_remainder)) = formation_prefix_and_remainder(
        outbound,
        formation_length_mm,
        "Turnaround-Preflight-Ausgang",
    ) else {
        return Ok(Some("outbound-formation-or-movement-does-not-fit"));
    };
    let outbound_intervals = normalized_directed_intervals(&outbound_seed, false)?;
    if normalized_directed_intervals(&inbound_seed, true)? == outbound_intervals {
        return Ok(None);
    }
    if terminal_occupancies_overlap(&inbound_seed, &outbound_seed) {
        return Ok(Some(
            "overlapping-terminal-intervals-without-reverse-continuity",
        ));
    }

    let through_route_version_id = format!(
        "preflight:through:{}:{}:{formation_length_mm}",
        inbound.route_version_id, outbound.route_version_id
    );
    let mut through_legs = inbound_seed;
    through_legs.extend(outbound_seed.iter().cloned());
    let through = TimetableRouteInput {
        route_version_id: through_route_version_id.clone(),
        template_id: format!("template:{through_route_version_id}"),
        predecessor_id: Some(inbound.route_version_id.clone()),
        transition_route_mm: Some(formation_length_mm),
        legs: through_legs,
    };
    if validate_derived_route(transaction, &through).is_err()
        || require_movement_continuity(
            inbound,
            &through,
            formation_length_mm,
            MovementContinuity::SameDirection,
        )
        .is_err()
    {
        return Ok(Some("same-direction-through-is-not-physically-contiguous"));
    }
    let qualified_route_version_id = format!(
        "preflight:outbound:{}:{}:{formation_length_mm}",
        inbound.route_version_id, outbound.route_version_id
    );
    let mut qualified_legs = outbound_seed;
    qualified_legs.extend(outbound_remainder);
    let qualified = TimetableRouteInput {
        route_version_id: qualified_route_version_id.clone(),
        template_id: format!("template:{qualified_route_version_id}"),
        predecessor_id: Some(through_route_version_id),
        transition_route_mm: Some(formation_length_mm),
        legs: qualified_legs,
    };
    if validate_derived_route(transaction, &qualified).is_err()
        || require_movement_continuity(
            &through,
            &qualified,
            formation_length_mm,
            MovementContinuity::SameDirection,
        )
        .is_err()
    {
        return Ok(Some("qualified-outbound-is-not-physically-contiguous"));
    }
    Ok(None)
}

fn stabling_preflight(
    transaction: &redb::ReadTransaction,
    policy: &PolicySpec,
    demand: &TurnaroundPairDemand,
    inbound: &TimetableRouteInput,
    outbound: &TimetableRouteInput,
    formation_length_mm: i64,
) -> Result<(
    Option<&'static str>,
    Option<PairedStablingCandidate>,
    Option<PairedStablingSearch>,
)> {
    if formation_tail_legs(
        inbound,
        formation_length_mm,
        "Turnaround-Preflight-Abstellankunft",
    )
    .is_err()
    {
        return Ok((Some("inbound-formation-does-not-fit"), None, None));
    }
    if formation_prefix_and_remainder(
        outbound,
        formation_length_mm,
        "Turnaround-Preflight-Abstellausgang",
    )
    .is_err()
    {
        return Ok((
            Some("outbound-formation-or-movement-does-not-fit"),
            None,
            None,
        ));
    }
    let inbound_access = inbound_terminal_access(transaction, inbound)?;
    let outbound_access = outbound_terminal_access(transaction, outbound)?;
    let search = paired_stabling_candidates_with_fallback(
        transaction,
        &inbound_access,
        &outbound_access,
        formation_length_mm,
        policy.minimum_berth_end_clearance_mm,
        policy.maximum_stabling_path_edges,
        policy.maximum_stabling_path_length_mm,
        &inbound.route_version_id,
        &outbound.route_version_id,
        demand,
    )?;
    let available_window_ms = demand
        .available_window_s
        .checked_mul(1_000)
        .ok_or_else(|| {
            GermanyOperationalV2Error::new("Turnaround-Preflight-Zeitfenster laeuft ueber.")
        })?;
    for candidate in &search.candidates {
        let routes = build_stabling_routes(
            transaction,
            policy,
            inbound,
            outbound,
            formation_length_mm,
            candidate,
        )?;
        if stabling_minimum_runtime_ms(transaction, &routes, formation_length_mm)?
            <= available_window_ms
        {
            return Ok((None, Some(candidate.clone()), Some(search)));
        }
    }
    let reason = if !search.candidates.is_empty() {
        "no-executable-stabling-route-within-window"
    } else if search.inbound_candidate_count == 0 {
        "no-inbound-qualified-stabling-berth"
    } else if search.outbound_candidate_count == 0 {
        "no-outbound-qualified-stabling-berth"
    } else {
        "no-shared-qualified-stabling-berth"
    };
    Ok((Some(reason), None, Some(search)))
}

fn turnaround_preflight_report(
    database: &Database,
    infra_release_id: &str,
    policy: &PolicySpec,
    required_pairs: &[TurnaroundPairDemand],
    transfer_pair_count: usize,
    transfer_formation_demand_count: usize,
) -> Result<Value> {
    let demand_count = required_pairs
        .len()
        .checked_mul(policy.terminal_formation_lengths_mm.len())
        .ok_or_else(|| {
            GermanyOperationalV2Error::new("Turnaround-Preflight-Menge laeuft ueber.")
        })?;
    let total_pair_count = required_pairs
        .len()
        .checked_add(transfer_pair_count)
        .ok_or_else(|| GermanyOperationalV2Error::new("Preflight-Paarmenge laeuft ueber."))?;
    let total_demand_count = demand_count
        .checked_add(transfer_formation_demand_count)
        .ok_or_else(|| GermanyOperationalV2Error::new("Preflight-Gesamtmenge laeuft ueber."))?;
    require(
        total_demand_count <= MAX_TURNAROUND_PREFLIGHT_DEMANDS,
        format!(
            "Movement-Preflight besitzt {total_demand_count} Anforderungen und ueberschreitet die feste Grenze {MAX_TURNAROUND_PREFLIGHT_DEMANDS}."
        ),
    )?;
    let transaction = database.begin_read().map_err(db_error)?;
    let routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    let mut findings = Vec::new();
    let mut reason_counts = BTreeMap::<String, u64>::new();
    let mut direct_covered = 0_u64;
    let mut observed_stabling_only_covered = 0_u64;
    let mut simulated_stabling_only_covered = 0_u64;
    let mut berth_assignment_counts = BerthAssignmentCounts::default();
    let mut minimum_path_edges_histogram = BTreeMap::<String, u64>::new();
    let mut minimum_path_length_mm_histogram = BTreeMap::<String, u64>::new();
    let mut minimum_path_edges_min = None::<u64>;
    let mut minimum_path_edges_max = None::<u64>;
    let mut minimum_path_length_mm_min = None::<i64>;
    let mut minimum_path_length_mm_max = None::<i64>;
    let mut any_covered = 0_u64;
    for pair in required_pairs {
        let inbound_serialized = routes
            .get(pair.inbound_route_version_id.as_str())
            .map_err(db_error)?
            .ok_or_else(|| {
                GermanyOperationalV2Error::new(format!(
                    "Turnaround-Preflight verweist auf unbekannte Ankunftsroute `{}`.",
                    pair.inbound_route_version_id
                ))
            })?;
        let outbound_serialized = routes
            .get(pair.outbound_route_version_id.as_str())
            .map_err(db_error)?
            .ok_or_else(|| {
                GermanyOperationalV2Error::new(format!(
                    "Turnaround-Preflight verweist auf unbekannte Ausgangsroute `{}`.",
                    pair.outbound_route_version_id
                ))
            })?;
        let inbound = route_from_json(inbound_serialized.value(), "Preflight-Ankunftsroute")?;
        let outbound = route_from_json(outbound_serialized.value(), "Preflight-Ausgangsroute")?;
        let inbound_leg = inbound.legs.last().expect("validierte Ankunftsroute");
        let outbound_leg = outbound.legs.first().expect("validierte Ausgangsroute");
        let inbound_track = get_track(&transaction, &inbound_leg.edge_id)?;
        let outbound_track = get_track(&transaction, &outbound_leg.edge_id)?;
        for &formation_length_mm in &policy.terminal_formation_lengths_mm {
            let direct_reason =
                direct_preflight_reason(&transaction, &inbound, &outbound, formation_length_mm)?;
            if direct_reason.is_none() {
                direct_covered = direct_covered.saturating_add(1);
                any_covered = any_covered.saturating_add(1);
                continue;
            }
            let (stabling_reason, stabling_candidate, stabling_search) = stabling_preflight(
                &transaction,
                policy,
                pair,
                &inbound,
                &outbound,
                formation_length_mm,
            )?;
            if let Some(candidate) = stabling_candidate {
                match (
                    candidate.arrival_berth_assignment.kind,
                    candidate.departure_berth_assignment.kind,
                ) {
                    (BerthAssignmentKind::Observed, BerthAssignmentKind::Observed) => {
                        observed_stabling_only_covered =
                            observed_stabling_only_covered.saturating_add(1);
                    }
                    _ => {
                        simulated_stabling_only_covered =
                            simulated_stabling_only_covered.saturating_add(1);
                    }
                }
                berth_assignment_counts.increment(candidate.arrival_berth_assignment);
                if candidate.stabling_kind == StablingKind::CrossBerthTransfer {
                    berth_assignment_counts.increment(candidate.departure_berth_assignment);
                }
                let path_edges = u64::try_from(
                    candidate
                        .inbound_path
                        .len()
                        .saturating_add(candidate.outbound_path.len()),
                )
                .unwrap_or(u64::MAX);
                *minimum_path_edges_histogram
                    .entry(path_edges.to_string())
                    .or_default() += 1;
                *minimum_path_length_mm_histogram
                    .entry(candidate.total_length_mm.to_string())
                    .or_default() += 1;
                minimum_path_edges_min =
                    Some(minimum_path_edges_min.map_or(path_edges, |value| value.min(path_edges)));
                minimum_path_edges_max =
                    Some(minimum_path_edges_max.map_or(path_edges, |value| value.max(path_edges)));
                minimum_path_length_mm_min = Some(
                    minimum_path_length_mm_min.map_or(candidate.total_length_mm, |value| {
                        value.min(candidate.total_length_mm)
                    }),
                );
                minimum_path_length_mm_max = Some(
                    minimum_path_length_mm_max.map_or(candidate.total_length_mm, |value| {
                        value.max(candidate.total_length_mm)
                    }),
                );
                any_covered = any_covered.saturating_add(1);
                continue;
            }
            let direct_reason = direct_reason.expect("nicht abgedeckter Direct-Grund");
            let stabling_reason = stabling_reason.expect("nicht abgedeckter Abstellgrund");
            for reason in [
                format!("direct:{direct_reason}"),
                format!("stabling:{stabling_reason}"),
            ] {
                let count = reason_counts.entry(reason).or_default();
                *count = count.saturating_add(1);
            }
            findings.push(TurnaroundPreflightFinding {
                inbound_route_version_id: inbound.route_version_id.clone(),
                outbound_route_version_id: outbound.route_version_id.clone(),
                formation_length_mm,
                direct_reason: direct_reason.to_owned(),
                stabling_reason: stabling_reason.to_owned(),
                inbound_endpoint: preflight_endpoint(&inbound_track, inbound_leg.edge_exit_mm),
                outbound_endpoint: preflight_endpoint(&outbound_track, outbound_leg.edge_entry_mm),
                inbound_candidate_count: stabling_search.as_ref().map_or(0, |search| {
                    u64::try_from(search.inbound_candidate_count).unwrap_or(u64::MAX)
                }),
                outbound_candidate_count: stabling_search.as_ref().map_or(0, |search| {
                    u64::try_from(search.outbound_candidate_count).unwrap_or(u64::MAX)
                }),
                minimum_inbound_candidate_path_edges: stabling_search
                    .as_ref()
                    .and_then(|search| search.minimum_inbound_candidate_path_edges)
                    .map(|value| u64::try_from(value).unwrap_or(u64::MAX)),
                minimum_outbound_candidate_path_edges: stabling_search
                    .as_ref()
                    .and_then(|search| search.minimum_outbound_candidate_path_edges)
                    .map(|value| u64::try_from(value).unwrap_or(u64::MAX)),
                minimum_inbound_candidate_path_length_mm: stabling_search
                    .as_ref()
                    .and_then(|search| search.minimum_inbound_candidate_path_length_mm),
                minimum_outbound_candidate_path_length_mm: stabling_search
                    .as_ref()
                    .and_then(|search| search.minimum_outbound_candidate_path_length_mm),
                inbound_candidate_berth_edge_ids: stabling_search
                    .as_ref()
                    .map_or_else(Vec::new, |search| {
                        search.inbound_candidate_berth_edge_ids.clone()
                    }),
                outbound_candidate_berth_edge_ids: stabling_search
                    .as_ref()
                    .map_or_else(Vec::new, |search| {
                        search.outbound_candidate_berth_edge_ids.clone()
                    }),
                shortest_inbound_candidate_path: stabling_search.as_ref().and_then(|search| {
                    search
                        .shortest_inbound_candidate_path
                        .as_ref()
                        .map(preflight_candidate_path)
                }),
                shortest_outbound_candidate_path: stabling_search.as_ref().and_then(|search| {
                    search
                        .shortest_outbound_candidate_path
                        .as_ref()
                        .map(preflight_candidate_path)
                }),
            });
        }
    }
    drop(transaction);
    let mut finding_hasher = Sha256::new();
    for finding in &findings {
        let value = serde_json::to_value(finding).map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "Turnaround-Preflight-Finding kann nicht serialisiert werden: {error}"
            ))
        })?;
        let mut canonical = String::new();
        canonical_json(&value, &mut canonical);
        finding_hasher.update(canonical.as_bytes());
        finding_hasher.update(b"\n");
    }
    let body = json!({
        "infraReleaseId": infra_release_id,
        "formationLengthsMm": policy.terminal_formation_lengths_mm,
        "metrics": {
            "pairCount": required_pairs.len(),
            "demandCount": demand_count,
            "turnaroundPairCount": required_pairs.len(),
            "turnaroundFormationDemandCount": demand_count,
            "transferPairCount": transfer_pair_count,
            "transferFormationDemandCount": transfer_formation_demand_count,
            "totalContinuationPairCount": total_pair_count,
            "totalFormationDemandCount": total_demand_count,
            "transferCoveredCount": transfer_formation_demand_count,
            "directCoveredCount": direct_covered,
            "observedStablingOnlyCoveredCount": observed_stabling_only_covered,
            "simulatedOperationalStablingOnlyCoveredCount": simulated_stabling_only_covered,
            "stablingOnlyCoveredCount": observed_stabling_only_covered.saturating_add(simulated_stabling_only_covered),
            "anyCoveredCount": any_covered.saturating_add(
                u64::try_from(transfer_formation_demand_count).unwrap_or(u64::MAX)
            ),
            "uncoveredCount": findings.len(),
            "minimumCombinedAccessEdgeCountMin": minimum_path_edges_min,
            "minimumCombinedAccessEdgeCountMax": minimum_path_edges_max,
            "minimumCombinedMovementPathLengthMmMin": minimum_path_length_mm_min,
            "minimumCombinedMovementPathLengthMmMax": minimum_path_length_mm_max,
        },
        "berthAssignmentCounts": berth_assignment_counts,
        "minimumCombinedAccessEdgeCountHistogram": minimum_path_edges_histogram,
        "minimumCombinedMovementPathLengthMmHistogram": minimum_path_length_mm_histogram,
        "reasonCounts": reason_counts,
        "findingSetSha256": digest_hex(finding_hasher.finalize()),
        "findings": findings,
        "eligible": any_covered.saturating_add(
            u64::try_from(transfer_formation_demand_count).unwrap_or(u64::MAX)
        ) == u64::try_from(total_demand_count).unwrap_or(u64::MAX),
    });
    let envelope = json!({
        "schema": TURNAROUND_PREFLIGHT_SCHEMA,
        "value": body.clone(),
    });
    let mut canonical_envelope = String::new();
    canonical_json(&envelope, &mut canonical_envelope);
    let mut report = body;
    report["schema"] = json!(TURNAROUND_PREFLIGHT_SCHEMA);
    report["stateHash"] = json!(sha256(canonical_envelope.as_bytes()));
    Ok(report)
}

fn terminal_occupancies_overlap(left: &[TimetableLegInput], right: &[TimetableLegInput]) -> bool {
    left.iter().any(|left_leg| {
        right.iter().any(|right_leg| {
            if left_leg.edge_id != right_leg.edge_id {
                return false;
            }
            let left_from = left_leg.edge_entry_mm.min(left_leg.edge_exit_mm);
            let left_to = left_leg.edge_entry_mm.max(left_leg.edge_exit_mm);
            let right_from = right_leg.edge_entry_mm.min(right_leg.edge_exit_mm);
            let right_to = right_leg.edge_entry_mm.max(right_leg.edge_exit_mm);
            left_from < right_to && right_from < left_to
        })
    })
}

fn occupancy_resources_for_legs(
    transaction: &redb::ReadTransaction,
    legs: &[TimetableLegInput],
) -> Result<BTreeSet<String>> {
    let mut resources = BTreeSet::new();
    for leg in legs {
        let track = get_track(transaction, &leg.edge_id)?;
        resources.extend(track_block_resources(transaction, &track.id)?);
        resources.insert(boundary_resource(&track, leg.edge_entry_mm)?);
        resources.insert(boundary_resource(&track, leg.edge_exit_mm)?);
    }
    Ok(resources)
}

fn resources_from_template_value(value: &Value) -> Result<BTreeSet<String>> {
    let mut result = BTreeSet::new();
    for field in ["pathResources", "overlapResources", "flankResources"] {
        let values = value.get(field).and_then(Value::as_array).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Abgeleitete Fahrstrasse besitzt kein kanonisches `{field}`."
            ))
        })?;
        for value in values {
            let id = value.as_str().filter(|id| !id.is_empty()).ok_or_else(|| {
                GermanyOperationalV2Error::new("Abgeleitete Fahrstrassenressource ist ungueltig.")
            })?;
            result.insert(id.to_owned());
        }
    }
    Ok(result)
}

fn switch_positions_for_leg(
    transaction: &redb::ReadTransaction,
    track: &TrackRecord,
    entry_mm: i64,
    exit_mm: i64,
    route_id: &str,
) -> Result<BTreeMap<String, String>> {
    let table = transaction.open_table(SWITCH_BY_NODE).map_err(db_error)?;
    let mut result = BTreeMap::new();
    for node in [
        node_at_offset(track, entry_mm),
        node_at_offset(track, exit_mm),
    ]
    .into_iter()
    .flatten()
    {
        let key = node.to_string();
        if let Some(switch) = table.get(key.as_str()).map_err(db_error)? {
            let switch_id = switch.value().to_owned();
            let position = stable_id("position:synthetic-route:", &[route_id, switch_id.as_str()]);
            if let Some(previous) = result.insert(switch_id.clone(), position.clone()) {
                require(
                    previous == position,
                    format!(
                        "Laufweg `{route_id}` verlangt fuer synthetische Weiche `{switch_id}` widerspruechliche Lagen."
                    ),
                )?;
            }
        }
    }
    Ok(result)
}

fn shunting_template_value(
    transaction: &redb::ReadTransaction,
    route: &TimetableRouteInput,
    authority_start: i64,
) -> Result<(String, Value)> {
    let authority_end = route_length(route)?;
    require(
        authority_start > 0 && authority_end > authority_start,
        format!(
            "Rangierfahrstrasse fuer `{}` besitzt keinen Fahrweg hinter dem Formation-Seed.",
            route.route_version_id
        ),
    )?;
    let mut route_cursor = 0_i64;
    let mut path_resources = BTreeSet::new();
    let mut switch_positions = BTreeMap::new();
    let mut entry = None;
    let mut overlap = None;
    for leg in &route.legs {
        let length =
            i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm)).unwrap_or(i64::MAX);
        let leg_end = route_cursor.checked_add(length).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Rangierlaufweg `{}` laeuft ueber.",
                route.route_version_id
            ))
        })?;
        if route_cursor >= authority_start {
            let track = get_track(transaction, &leg.edge_id)?;
            if entry.is_none() {
                require(
                    route_cursor == authority_start,
                    format!(
                        "Rangierlaufweg `{}` besitzt bei {authority_start} mm keine exakte Leggrenze.",
                        route.route_version_id
                    ),
                )?;
                entry = Some(boundary_resource(&track, leg.edge_entry_mm)?);
            }
            path_resources.extend(track_block_resources(transaction, &track.id)?);
            overlap = Some(boundary_resource(&track, leg.edge_exit_mm)?);
            for (switch_id, position) in switch_positions_for_leg(
                transaction,
                &track,
                leg.edge_entry_mm,
                leg.edge_exit_mm,
                &route.route_version_id,
            )? {
                if let Some(previous) = switch_positions.insert(switch_id.clone(), position.clone())
                {
                    require(
                        previous == position,
                        format!(
                            "Rangierlaufweg `{}` verlangt fuer Weiche `{switch_id}` widerspruechliche Lagen.",
                            route.route_version_id
                        ),
                    )?;
                }
            }
        }
        route_cursor = leg_end;
    }
    let entry = entry.ok_or_else(|| {
        GermanyOperationalV2Error::new(format!(
            "Rangierlaufweg `{}` besitzt kein erstes Bewegungsleg.",
            route.route_version_id
        ))
    })?;
    let overlap = overlap.ok_or_else(|| {
        GermanyOperationalV2Error::new(format!(
            "Rangierlaufweg `{}` besitzt kein letztes Bewegungsleg.",
            route.route_version_id
        ))
    })?;
    let mut flank_resources = BTreeSet::from([entry]);
    if flank_resources.contains(&overlap) {
        flank_resources.insert(stable_id(
            "resource:synthetic-turnaround-loop-flank:",
            &[&route.route_version_id],
        ));
    }
    flank_resources.remove(&overlap);
    require(
        !path_resources.is_empty() && !flank_resources.is_empty(),
        format!(
            "Rangierfahrstrasse fuer `{}` besitzt keine vollstaendige Ressourcenbindung.",
            route.route_version_id
        ),
    )?;
    let id = turnaround_shunting_interlocking_id(&route.route_version_id);
    Ok((
        id.clone(),
        json!({
            "id": id,
            "routeTemplateId": route.template_id,
            "signalId": turnaround_shunting_signal_id(&route.route_version_id),
            "movementKind": "shunting",
            "pathResources": path_resources,
            "overlapResources": BTreeSet::from([overlap]),
            "flankResources": flank_resources,
            "switchPositions": switch_positions,
            "authorityStartRouteMm": authority_start,
            "authorityEndRouteMm": authority_end,
            "releaseAfterTailRouteMm": authority_end,
        }),
    ))
}

fn passenger_leg_slice(
    source: &TimetableLegInput,
    edge_entry_mm: i64,
    edge_exit_mm: i64,
) -> TimetableLegInput {
    let mut result = source.clone();
    result.edge_entry_mm = edge_entry_mm;
    result.edge_exit_mm = edge_exit_mm;
    result
}

fn validate_derived_route(
    transaction: &redb::ReadTransaction,
    route: &TimetableRouteInput,
) -> Result<()> {
    require(
        !route.route_version_id.is_empty()
            && !route.template_id.is_empty()
            && !route.legs.is_empty()
            && route.predecessor_id.is_some() == route.transition_route_mm.is_some(),
        format!(
            "Abgeleiteter Laufweg `{}` ist unvollstaendig.",
            route.route_version_id
        ),
    )?;
    let mut previous: Option<(TimetableLegInput, TrackRecord)> = None;
    let mut total = 0_i64;
    for (index, leg) in route.legs.iter().enumerate() {
        let track = get_track(transaction, &leg.edge_id)?;
        let length = validate_timetable_leg(
            &track,
            leg,
            &format!(
                "Abgeleiteter Laufweg `{}` Leg {index}",
                route.route_version_id
            ),
        )?;
        total = total.checked_add(length).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Abgeleiteter Laufweg `{}` laeuft ueber.",
                route.route_version_id
            ))
        })?;
        require(
            total <= MAX_SAFE_INTEGER,
            format!(
                "Abgeleiteter Laufweg `{}` ueberschreitet sichere Ganzzahlen.",
                route.route_version_id
            ),
        )?;
        if let Some((previous_leg, previous_track)) = &previous {
            if previous_leg.edge_id == leg.edge_id {
                require(
                    previous_leg.edge_exit_mm == leg.edge_entry_mm,
                    format!(
                        "Abgeleiteter Laufweg `{}` ist auf derselben Kante nicht lueckenlos.",
                        route.route_version_id
                    ),
                )?;
            } else {
                let previous_node = node_at_offset(previous_track, previous_leg.edge_exit_mm);
                let next_node = node_at_offset(&track, leg.edge_entry_mm);
                require(
                    previous_node.is_some() && previous_node == next_node,
                    format!(
                        "Abgeleiteter Laufweg `{}` besitzt eine physische Topologieluecke.",
                        route.route_version_id
                    ),
                )?;
            }
        }
        previous = Some((leg.clone(), track));
    }
    if let Some(transition) = route.transition_route_mm {
        require(
            (0..=total).contains(&transition),
            format!(
                "Abgeleiteter Laufweg `{}` besitzt einen ungueltigen Continuity-Anker.",
                route.route_version_id
            ),
        )?;
    }
    Ok(())
}

struct GeneratedTurnaroundRouteIds {
    shunt_in_route_id: String,
    shunt_in_template_id: String,
    berth_transfer_route_id: String,
    berth_transfer_template_id: String,
    shunt_out_route_id: String,
    shunt_out_template_id: String,
    outbound_route_id: String,
    outbound_template_id: String,
    turnaround_id: String,
}

fn generated_route_ids(
    inbound_route_id: &str,
    outbound_route_id: &str,
    formation_length_mm: i64,
    candidate: &PairedStablingCandidate,
) -> GeneratedTurnaroundRouteIds {
    let length = formation_length_mm.to_string();
    let inbound_path = candidate
        .inbound_path
        .iter()
        .map(|edge| format!("{}:{}", edge.track.id, edge.direction))
        .collect::<Vec<_>>()
        .join("\n");
    let outbound_path = candidate
        .outbound_path
        .iter()
        .map(|edge| format!("{}:{}", edge.track.id, edge.direction))
        .collect::<Vec<_>>()
        .join("\n");
    let berth_transfer_path = candidate
        .berth_transfer_path
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|edge| format!("{}:{}", edge.track.id, edge.direction))
        .collect::<Vec<_>>()
        .join("\n");
    let stabling_kind = match candidate.stabling_kind {
        StablingKind::SharedBerth => "shared-berth",
        StablingKind::CrossBerthTransfer => "cross-berth-transfer",
    };
    let shared_parts = [
        inbound_route_id,
        outbound_route_id,
        length.as_str(),
        inbound_path.as_str(),
        outbound_path.as_str(),
        candidate.arrival_berth_assignment.stable_key(),
    ];
    let cross_parts = [
        inbound_route_id,
        outbound_route_id,
        length.as_str(),
        inbound_path.as_str(),
        berth_transfer_path.as_str(),
        outbound_path.as_str(),
        stabling_kind,
        candidate.arrival_berth_assignment.stable_key(),
        candidate.departure_berth_assignment.stable_key(),
    ];
    let parts: &[&str] = if candidate.stabling_kind == StablingKind::SharedBerth {
        &shared_parts
    } else {
        &cross_parts
    };
    GeneratedTurnaroundRouteIds {
        shunt_in_route_id: stable_id("route:synthetic-turnaround-shunt-in:", parts),
        shunt_in_template_id: stable_id("template:synthetic-turnaround-shunt-in:", parts),
        berth_transfer_route_id: stable_id("route:synthetic-turnaround-berth-transfer:", parts),
        berth_transfer_template_id: stable_id(
            "template:synthetic-turnaround-berth-transfer:",
            parts,
        ),
        shunt_out_route_id: stable_id("route:synthetic-turnaround-shunt-out:", parts),
        shunt_out_template_id: stable_id("template:synthetic-turnaround-shunt-out:", parts),
        outbound_route_id: stable_id("route:synthetic-turnaround-outbound:", parts),
        outbound_template_id: stable_id("template:synthetic-turnaround-outbound:", parts),
        turnaround_id: stable_id("turnaround:synthetic-physical:", parts),
    }
}

fn centered_turnaround_berth(
    track: &TrackRecord,
    formation_length_mm: i64,
    minimum_clearance_mm: i64,
    context: &str,
) -> Result<TurnaroundBerth> {
    let from_mm = track
        .length_mm
        .checked_sub(formation_length_mm)
        .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context}-Laenge laeuft ueber.")))?
        / 2;
    let to_mm = from_mm
        .checked_add(formation_length_mm)
        .ok_or_else(|| GermanyOperationalV2Error::new(format!("{context}-Ende laeuft ueber.")))?;
    let berth = TurnaroundBerth {
        edge_id: track.id.clone(),
        edge_length_mm: track.length_mm,
        from_mm,
        to_mm,
        left_clearance_mm: from_mm,
        right_clearance_mm: track.length_mm.checked_sub(to_mm).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!("{context}-Freiraum laeuft ueber."))
        })?,
    };
    require(
        berth.left_clearance_mm >= minimum_clearance_mm
            && berth.right_clearance_mm >= minimum_clearance_mm
            && berth.to_mm.checked_sub(berth.from_mm) == Some(formation_length_mm),
        format!("{context}-Kante `{}` ist zu kurz.", track.id),
    )?;
    Ok(berth)
}

fn berth_seed_offsets(berth: &TurnaroundBerth, direction: &str) -> Result<(i64, i64)> {
    match direction {
        "along" => Ok((berth.from_mm, berth.to_mm)),
        "against" => Ok((berth.to_mm, berth.from_mm)),
        _ => Err(GermanyOperationalV2Error::new(format!(
            "Berth `{}` besitzt ungueltige Richtung `{direction}`.",
            berth.edge_id
        ))),
    }
}

fn append_path_to_berth(
    legs: &mut Vec<TimetableLegInput>,
    path: &[DirectedTrack],
    berth: &TurnaroundBerth,
) -> Result<()> {
    require(
        !path.is_empty(),
        "Abstellzugang besitzt keinen realen Gleispfad.",
    )?;
    for (index, directed) in path.iter().enumerate() {
        let (entry_mm, full_exit_mm) = directed_offsets(&directed.track, directed.direction)?;
        let exit_mm = if index + 1 == path.len() {
            require(
                directed.track.id == berth.edge_id,
                "Abstellzugang endet nicht auf seiner gebundenen Berth-Kante.",
            )?;
            berth_seed_offsets(berth, directed.direction)?.1
        } else {
            full_exit_mm
        };
        legs.push(derived_leg(
            &directed.track,
            directed.direction,
            entry_mm,
            exit_mm,
        ));
    }
    Ok(())
}

fn berth_transfer_route(
    candidate: &PairedStablingCandidate,
    arrival_berth: &TurnaroundBerth,
    departure_berth: &TurnaroundBerth,
    formation_length_mm: i64,
    route_version_id: String,
    template_id: String,
    predecessor_id: String,
) -> Result<TimetableRouteInput> {
    require(
        candidate.stabling_kind == StablingKind::CrossBerthTransfer,
        "Berth-Transfer darf nur fuer Cross-Berth-Kandidaten entstehen.",
    )?;
    let full_path = candidate.berth_transfer_path.as_deref().ok_or_else(|| {
        GermanyOperationalV2Error::new("Cross-Berth-Kandidat besitzt keinen realen Transferpfad.")
    })?;
    require(
        full_path.len() >= 2 && arrival_berth.edge_id != departure_berth.edge_id,
        "Cross-Berth-Transfer verlangt zwei verschiedene reale Berth-Kanten.",
    )?;
    let first = full_path.first().expect("gepruefter Cross-Berth-Pfad");
    let last = full_path.last().expect("gepruefter Cross-Berth-Pfad");
    let arrival_direction = candidate
        .inbound_path
        .last()
        .expect("Cross-Berth-Ankunftspfad besitzt eine Zielkante")
        .direction;
    let departure_direction = candidate
        .outbound_path
        .last()
        .expect("Cross-Berth-Abfahrtspfad besitzt eine Zielkante")
        .direction;
    require(
        first.track.id == arrival_berth.edge_id
            && first.direction == reverse_direction(arrival_direction)?
            && last.track.id == departure_berth.edge_id
            && last.direction == departure_direction,
        "Cross-Berth-Transferpfad widerspricht seinen gerichteten Berth-Zugaengen.",
    )?;
    let reverse_arrival_direction = reverse_direction(arrival_direction)?;
    let (seed_entry_mm, seed_exit_mm) =
        berth_seed_offsets(arrival_berth, reverse_arrival_direction)?;
    let mut legs = vec![derived_leg(
        &first.track,
        reverse_arrival_direction,
        seed_entry_mm,
        seed_exit_mm,
    )];
    for (index, directed) in full_path.iter().enumerate() {
        let (full_entry_mm, full_exit_mm) = directed_offsets(&directed.track, directed.direction)?;
        let entry_mm = if index == 0 {
            seed_exit_mm
        } else {
            full_entry_mm
        };
        let exit_mm = if index + 1 == full_path.len() {
            berth_seed_offsets(departure_berth, directed.direction)?.1
        } else {
            full_exit_mm
        };
        require(
            entry_mm != exit_mm,
            "Cross-Berth-Transfer besitzt ein leeres Bewegungsintervall.",
        )?;
        legs.push(derived_leg(
            &directed.track,
            directed.direction,
            entry_mm,
            exit_mm,
        ));
    }
    let route = TimetableRouteInput {
        route_version_id,
        template_id,
        predecessor_id: Some(predecessor_id),
        transition_route_mm: Some(formation_length_mm),
        legs,
    };
    require(
        route_length(&route)? > formation_length_mm,
        "Cross-Berth-Transfer besitzt keinen realen Bewegungsweg hinter dem Formation-Seed.",
    )?;
    Ok(route)
}

struct BuiltStablingRoutes {
    ids: GeneratedTurnaroundRouteIds,
    arrival_berth: TurnaroundBerth,
    departure_berth: TurnaroundBerth,
    shunt_in: TimetableRouteInput,
    berth_transfer: Option<TimetableRouteInput>,
    shunt_out: TimetableRouteInput,
    shunt_out_continuity: MovementContinuity,
    outbound: TimetableRouteInput,
}

fn build_stabling_routes(
    transaction: &redb::ReadTransaction,
    policy: &PolicySpec,
    inbound: &TimetableRouteInput,
    outbound_base: &TimetableRouteInput,
    formation_length_mm: i64,
    candidate: &PairedStablingCandidate,
) -> Result<BuiltStablingRoutes> {
    let ids = generated_route_ids(
        &inbound.route_version_id,
        &outbound_base.route_version_id,
        formation_length_mm,
        candidate,
    );
    let inbound_seed = formation_tail_legs(
        inbound,
        formation_length_mm,
        &format!("Ankunftslaufweg `{}`", inbound.route_version_id),
    )?;
    let (outbound_seed, outbound_remainder) = formation_prefix_and_remainder(
        outbound_base,
        formation_length_mm,
        &format!("Ausgangslaufweg `{}`", outbound_base.route_version_id),
    )?;
    let inbound_access = inbound_terminal_access(transaction, inbound)?;
    let outbound_access = outbound_terminal_access(transaction, outbound_base)?;
    let arrival_berth_edge = &candidate
        .inbound_path
        .last()
        .ok_or_else(|| GermanyOperationalV2Error::new("Ankunfts-Abstellpfad ist leer."))?
        .track;
    let departure_berth_edge = &candidate
        .outbound_path
        .last()
        .ok_or_else(|| GermanyOperationalV2Error::new("Abfahrts-Abstellpfad ist leer."))?
        .track;
    let arrival_berth = centered_turnaround_berth(
        arrival_berth_edge,
        formation_length_mm,
        policy.minimum_berth_end_clearance_mm,
        "Ankunfts-Berth",
    )?;
    let departure_berth = centered_turnaround_berth(
        departure_berth_edge,
        formation_length_mm,
        policy.minimum_berth_end_clearance_mm,
        "Abfahrts-Berth",
    )?;
    match candidate.stabling_kind {
        StablingKind::SharedBerth => require(
            arrival_berth == departure_berth
                && candidate.arrival_berth_assignment == candidate.departure_berth_assignment
                && candidate.berth_transfer_path.is_none()
                && candidate.berth_transfer_provenance.is_none(),
            "Shared-Berth-Kandidat besitzt widerspruechliche Berths oder Transferdaten.",
        )?,
        StablingKind::CrossBerthTransfer => require(
            arrival_berth.edge_id != departure_berth.edge_id
                && candidate.berth_transfer_path.is_some()
                && candidate.berth_transfer_provenance.is_some(),
            "Cross-Berth-Kandidat besitzt keine zwei verschiedenen realen Berths mit Transferprovenienz.",
        )?,
    }

    let mut shunt_in_legs = inbound_seed;
    if let Some(connecting_leg) = &inbound_access.connecting_leg {
        shunt_in_legs.push(connecting_leg.clone());
    }
    append_path_to_berth(&mut shunt_in_legs, &candidate.inbound_path, &arrival_berth)?;
    let shunt_in = TimetableRouteInput {
        route_version_id: ids.shunt_in_route_id.clone(),
        template_id: ids.shunt_in_template_id.clone(),
        predecessor_id: Some(inbound.route_version_id.clone()),
        transition_route_mm: Some(formation_length_mm),
        legs: shunt_in_legs,
    };
    validate_derived_route(transaction, &shunt_in)?;

    let berth_transfer = if candidate.stabling_kind == StablingKind::CrossBerthTransfer {
        let route = berth_transfer_route(
            candidate,
            &arrival_berth,
            &departure_berth,
            formation_length_mm,
            ids.berth_transfer_route_id.clone(),
            ids.berth_transfer_template_id.clone(),
            shunt_in.route_version_id.clone(),
        )?;
        validate_derived_route(transaction, &route)?;
        require_movement_continuity(
            &shunt_in,
            &route,
            formation_length_mm,
            MovementContinuity::ReverseDirection,
        )?;
        Some(route)
    } else {
        None
    };
    let shunt_out_predecessor = berth_transfer.as_ref().unwrap_or(&shunt_in);
    let departure_berth_direction = candidate
        .outbound_path
        .last()
        .expect("gepruefter Abfahrts-Abstellpfad")
        .direction;
    let reverse_berth_direction = reverse_direction(departure_berth_direction)?;
    let (shunt_out_seed_entry, shunt_out_seed_exit) =
        berth_seed_offsets(&departure_berth, reverse_berth_direction)?;
    let mut shunt_out_legs = vec![derived_leg(
        departure_berth_edge,
        reverse_berth_direction,
        shunt_out_seed_entry,
        shunt_out_seed_exit,
    )];
    let berth_terminal_exit = directed_offsets(departure_berth_edge, reverse_berth_direction)?.1;
    shunt_out_legs.push(derived_leg(
        departure_berth_edge,
        reverse_berth_direction,
        shunt_out_seed_exit,
        berth_terminal_exit,
    ));
    for directed in candidate.outbound_path.iter().rev().skip(1) {
        let direction = reverse_direction(directed.direction)?;
        let (entry_mm, exit_mm) = directed_offsets(&directed.track, direction)?;
        shunt_out_legs.push(derived_leg(&directed.track, direction, entry_mm, exit_mm));
    }
    if let Some(connecting_leg) = &outbound_access.connecting_leg {
        shunt_out_legs.push(connecting_leg.clone());
    }
    shunt_out_legs.extend(outbound_seed.iter().cloned());
    let shunt_out = TimetableRouteInput {
        route_version_id: ids.shunt_out_route_id.clone(),
        template_id: ids.shunt_out_template_id.clone(),
        predecessor_id: Some(shunt_out_predecessor.route_version_id.clone()),
        transition_route_mm: Some(formation_length_mm),
        legs: shunt_out_legs,
    };
    validate_derived_route(transaction, &shunt_out)?;
    let shunt_out_continuity = match candidate.stabling_kind {
        StablingKind::CrossBerthTransfer => MovementContinuity::ReverseDirection,
        StablingKind::SharedBerth
            if candidate
                .inbound_path
                .last()
                .expect("gepruefter Inbound-Abstellpfad")
                .direction
                == candidate
                    .outbound_path
                    .last()
                    .expect("gepruefter Outbound-Abstellpfad")
                    .direction =>
        {
            MovementContinuity::ReverseDirection
        }
        StablingKind::SharedBerth => MovementContinuity::SameDirection,
    };
    require_movement_continuity(
        shunt_out_predecessor,
        &shunt_out,
        formation_length_mm,
        shunt_out_continuity,
    )?;

    let mut outbound_legs = outbound_seed;
    outbound_legs.extend(outbound_remainder);
    require(
        outbound_legs.len() >= 2 && route_length(outbound_base)? > formation_length_mm,
        format!(
            "Ausgangslaufweg `{}` endet bereits am Formation-Seed.",
            outbound_base.route_version_id
        ),
    )?;
    let outbound = TimetableRouteInput {
        route_version_id: ids.outbound_route_id.clone(),
        template_id: ids.outbound_template_id.clone(),
        predecessor_id: Some(shunt_out.route_version_id.clone()),
        transition_route_mm: Some(formation_length_mm),
        legs: outbound_legs,
    };
    validate_derived_route(transaction, &outbound)?;
    require_movement_continuity(
        &shunt_out,
        &outbound,
        formation_length_mm,
        MovementContinuity::SameDirection,
    )?;
    Ok(BuiltStablingRoutes {
        ids,
        arrival_berth,
        departure_berth,
        shunt_in,
        berth_transfer,
        shunt_out,
        shunt_out_continuity,
        outbound,
    })
}

fn stabling_minimum_runtime_ms(
    transaction: &redb::ReadTransaction,
    routes: &BuiltStablingRoutes,
    formation_length_mm: i64,
) -> Result<i64> {
    let shunt_in_runtime_ms =
        minimum_route_runtime_ms(transaction, &routes.shunt_in, formation_length_mm)?;
    let berth_transfer_runtime_ms = routes.berth_transfer.as_ref().map_or(Ok(0), |route| {
        minimum_route_runtime_ms(transaction, route, formation_length_mm)
    })?;
    let shunt_out_runtime_ms =
        minimum_route_runtime_ms(transaction, &routes.shunt_out, formation_length_mm)?;
    shunt_in_runtime_ms
        .checked_add(berth_transfer_runtime_ms)
        .and_then(|value| value.checked_add(shunt_out_runtime_ms))
        .ok_or_else(|| GermanyOperationalV2Error::new("Turnaround-Rangierlaufzeit laeuft ueber."))
}

fn insert_generated<T: Serialize>(
    values: &mut BTreeMap<String, String>,
    id: String,
    value: &T,
    context: &str,
) -> Result<()> {
    let serialized = serde_json::to_string(value).map_err(|error| {
        GermanyOperationalV2Error::new(format!("{context} kann nicht serialisiert werden: {error}"))
    })?;
    require(
        serialized.len() <= MAX_GENERATED_RECORD_BYTES,
        format!(
            "{context} `{id}` ueberschreitet die feste Einzelrecord-Grenze von {MAX_GENERATED_RECORD_BYTES} Bytes."
        ),
    )?;
    match values.entry(id) {
        std::collections::btree_map::Entry::Vacant(entry) => {
            entry.insert(serialized);
        }
        std::collections::btree_map::Entry::Occupied(entry) => {
            require(
                entry.get() == &serialized,
                format!(
                    "Kollidierende abgeleitete ID `{}` fuer {context}.",
                    entry.key()
                ),
            )?;
        }
    }
    Ok(())
}

#[derive(Default)]
struct GeneratedBatch {
    routes: BTreeMap<String, String>,
    interlocking: BTreeMap<String, String>,
    templates: BTreeMap<String, String>,
    signals: BTreeSet<String>,
    resources: BTreeSet<String>,
}

impl GeneratedBatch {
    fn is_empty(&self) -> bool {
        self.routes.is_empty()
            && self.interlocking.is_empty()
            && self.templates.is_empty()
            && self.signals.is_empty()
            && self.resources.is_empty()
    }

    fn estimated_resident_bytes(&self) -> usize {
        let string_map_bytes = |values: &BTreeMap<String, String>| {
            values.iter().fold(0_usize, |total, (id, serialized)| {
                total
                    .saturating_add(id.len())
                    .saturating_add(serialized.len())
                    .saturating_add(GENERATED_ENTRY_OVERHEAD_BYTES)
            })
        };
        let string_set_bytes = |values: &BTreeSet<String>| {
            values.iter().fold(0_usize, |total, id| {
                total
                    .saturating_add(id.len())
                    .saturating_add(GENERATED_ENTRY_OVERHEAD_BYTES)
            })
        };
        string_map_bytes(&self.routes)
            .saturating_add(string_map_bytes(&self.interlocking))
            .saturating_add(string_map_bytes(&self.templates))
            .saturating_add(string_set_bytes(&self.signals))
            .saturating_add(string_set_bytes(&self.resources))
    }
}

fn require_generated_unit_bound(
    resident_bytes_before: usize,
    batch: &GeneratedBatch,
    maximum_unit_bytes: usize,
    context: &str,
) -> Result<()> {
    let unit_bytes = batch
        .estimated_resident_bytes()
        .saturating_sub(resident_bytes_before);
    require(
        unit_bytes <= maximum_unit_bytes,
        format!(
            "{context} ueberschreitet das feste Einzelableitungsbudget von {maximum_unit_bytes} Bytes."
        ),
    )
}

#[derive(Clone, Copy)]
struct GeneratedBatchTables {
    routes: TableDefinition<'static, &'static str, &'static str>,
    interlocking: TableDefinition<'static, &'static str, &'static str>,
    templates: TableDefinition<'static, &'static str, &'static str>,
    route_context: &'static str,
    interlocking_context: &'static str,
    template_context: &'static str,
}

fn insert_generated_table(
    write: &redb::WriteTransaction,
    definition: TableDefinition<&str, &str>,
    values: &BTreeMap<String, String>,
    context: &str,
) -> Result<()> {
    let mut table = write.open_table(definition).map_err(db_error)?;
    for (id, serialized) in values {
        if let Some(previous) = table
            .insert(id.as_str(), serialized.as_str())
            .map_err(db_error)?
        {
            require(
                previous.value() == serialized,
                format!("Kollidierende {context}-ID `{id}`."),
            )?;
        }
    }
    Ok(())
}

fn flush_generated_batch(
    database: &Database,
    batch: &mut GeneratedBatch,
    tables: GeneratedBatchTables,
    force: bool,
    maximum_batch_bytes: usize,
) -> Result<bool> {
    if batch.is_empty() || (!force && batch.estimated_resident_bytes() < maximum_batch_bytes) {
        return Ok(false);
    }
    let mut write = database.begin_write().map_err(db_error)?;
    write.set_durability(Durability::None);
    insert_generated_table(&write, tables.routes, &batch.routes, tables.route_context)?;
    insert_generated_table(
        &write,
        tables.interlocking,
        &batch.interlocking,
        tables.interlocking_context,
    )?;
    insert_generated_table(
        &write,
        tables.templates,
        &batch.templates,
        tables.template_context,
    )?;
    {
        let mut signals = write.open_table(SIGNALS).map_err(db_error)?;
        for id in &batch.signals {
            let _ = signals.insert(id.as_str(), &()).map_err(db_error)?;
        }
    }
    {
        let mut resources = write.open_table(BLOCK_RESOURCES).map_err(db_error)?;
        for id in &batch.resources {
            let _ = resources.insert(id.as_str(), &()).map_err(db_error)?;
        }
    }
    write.commit().map_err(db_error)?;
    *batch = GeneratedBatch::default();
    Ok(true)
}

struct GeneratedMovementArtifacts<'a> {
    interlocking: &'a mut BTreeMap<String, String>,
    signals: &'a mut BTreeSet<String>,
    resources: &'a mut BTreeSet<String>,
}

fn generate_train_route_artifacts(
    transaction: &redb::ReadTransaction,
    predecessor: &TimetableRouteInput,
    route: &TimetableRouteInput,
    head_route_mm: i64,
    expected_continuity: MovementContinuity,
    generated: GeneratedMovementArtifacts<'_>,
    context: &str,
) -> Result<(TurnaroundRouteDispatch, BTreeSet<String>)> {
    let mut authority_start = 0_i64;
    let mut dispatch = None;
    let mut movement_resources = BTreeSet::new();
    for leg_index in 0..route.legs.len() {
        let (id, value, authority_end) =
            template_value(transaction, route, leg_index, authority_start)?;
        let resources = resources_from_template_value(&value)?;
        if authority_start >= head_route_mm {
            movement_resources.extend(resources.iter().cloned());
        }
        if authority_start == head_route_mm {
            dispatch = Some((id.clone(), resources.clone()));
        }
        generated.signals.insert(
            value["signalId"]
                .as_str()
                .expect("abgeleitete Signal-ID")
                .to_owned(),
        );
        generated.resources.extend(resources);
        insert_generated(&mut *generated.interlocking, id, &value, context)?;
        authority_start = authority_end;
    }
    let (dispatch_interlocking_route_id, resource_ids) = dispatch.ok_or_else(|| {
        GermanyOperationalV2Error::new(format!(
            "Laufweg `{}` besitzt bei {head_route_mm} mm keine exakte erste Fahrstrasse.",
            route.route_version_id
        ))
    })?;
    let route_leg_count = u32::try_from(route.legs.len())
        .map_err(|_| GermanyOperationalV2Error::new("Zu viele Laufweg-Legs."))?;
    Ok((
        TurnaroundRouteDispatch {
            route_version_id: route.route_version_id.clone(),
            predecessor_base_route_version_id: route.predecessor_id.clone().ok_or_else(|| {
                GermanyOperationalV2Error::new(format!(
                    "Abgeleiteter Dispatch-Laufweg `{}` besitzt keine statische Vorgaengerbindung.",
                    route.route_version_id
                ))
            })?,
            continuity: require_movement_continuity(
                predecessor,
                route,
                head_route_mm,
                expected_continuity,
            )?,
            dispatch_interlocking_route_id,
            head_route_mm,
            minimum_runtime_ms: minimum_route_runtime_ms(transaction, route, head_route_mm)?,
            resource_ids,
            route_leg_count,
            protection_contract_runs: protection_contract_runs(&route.legs)?,
        },
        movement_resources,
    ))
}

fn add_generated_route_resources(
    transaction: &redb::ReadTransaction,
    route: &TimetableRouteInput,
    generated_resources: &mut BTreeSet<String>,
) -> Result<()> {
    for leg in &route.legs {
        let track = get_track(transaction, &leg.edge_id)?;
        generated_resources.insert(boundary_resource(&track, leg.edge_entry_mm)?);
        generated_resources.insert(boundary_resource(&track, leg.edge_exit_mm)?);
    }
    Ok(())
}

fn same_physical_point(
    left_track: &TrackRecord,
    left_offset_mm: i64,
    right_track: &TrackRecord,
    right_offset_mm: i64,
) -> bool {
    (left_track.id == right_track.id && left_offset_mm == right_offset_mm)
        || node_at_offset(left_track, left_offset_mm).is_some_and(|left_node| {
            node_at_offset(right_track, right_offset_mm) == Some(left_node)
        })
}

fn direct_route_ids(
    inbound_route_id: &str,
    outbound_route_id: &str,
    formation_length_mm: i64,
) -> (String, String, String, String, String) {
    let length = formation_length_mm.to_string();
    let parts = [inbound_route_id, outbound_route_id, length.as_str()];
    (
        stable_id("route:synthetic-direct-through:", &parts),
        stable_id("template:synthetic-direct-through:", &parts),
        stable_id("route:synthetic-direct-outbound:", &parts),
        stable_id("template:synthetic-direct-outbound:", &parts),
        stable_id("direct:synthetic-physical:", &parts),
    )
}

fn derive_direct_templates(
    database: &Database,
    policy: &PolicySpec,
    required_pairs: Option<&[TurnaroundPairDemand]>,
) -> Result<BTreeSet<(String, String, i64)>> {
    if policy.terminal_formation_lengths_mm.is_empty() {
        return Ok(BTreeSet::new());
    }
    let pairs = required_pairs.ok_or_else(|| {
        GermanyOperationalV2Error::new(
            "Direct-Turnaround-Ableitung verlangt die explizite DailyPlan-v2-Partition.",
        )
    })?;
    let tables = GeneratedBatchTables {
        routes: TURNAROUND_ROUTES,
        interlocking: TURNAROUND_INTERLOCKING,
        templates: DIRECT_TEMPLATES,
        route_context: "Direct-Laufweg",
        interlocking_context: "Direct-Fahrstrasse",
        template_context: "Direct-Template",
    };
    let mut batch = GeneratedBatch::default();
    let mut covered = BTreeSet::new();

    for pair in pairs {
        for &formation_length_mm in &policy.terminal_formation_lengths_mm {
            let unit_resident_bytes = batch.estimated_resident_bytes();
            let transaction = database.begin_read().map_err(db_error)?;
            let inbound = timetable_route(
                &transaction,
                &pair.inbound_route_version_id,
                "Direct-Ankunftsroute",
            )?;
            let outbound_base = timetable_route(
                &transaction,
                &pair.outbound_route_version_id,
                "Direct-Ausgangsroute",
            )?;
            let inbound_leg = inbound.legs.last().expect("validierte Ankunftsroute");
            let outbound_leg = outbound_base
                .legs
                .first()
                .expect("validierte Ausgangsroute");
            let inbound_track = get_track(&transaction, &inbound_leg.edge_id)?;
            let outbound_track = get_track(&transaction, &outbound_leg.edge_id)?;
            if !same_physical_point(
                &inbound_track,
                inbound_leg.edge_exit_mm,
                &outbound_track,
                outbound_leg.edge_entry_mm,
            ) {
                continue;
            }
            let inbound_seed = formation_tail_legs(
                &inbound,
                formation_length_mm,
                &format!("Direct-Ankunft `{}`", inbound.route_version_id),
            )?;
            let (outbound_seed, outbound_remainder) = formation_prefix_and_remainder(
                &outbound_base,
                formation_length_mm,
                &format!("Direct-Ausgang `{}`", outbound_base.route_version_id),
            )?;
            let source_intervals = terminal_intervals(&inbound_seed);
            let target_occupancy = canonical_terminal_occupancy(&outbound_seed, false);
            let reverse_continuity =
                canonical_terminal_occupancy(&inbound_seed, true) == target_occupancy;
            if !reverse_continuity && terminal_occupancies_overlap(&inbound_seed, &outbound_seed) {
                continue;
            }
            let (through_route_id, through_template_id, route_id, template_id, direct_id) =
                direct_route_ids(
                    &inbound.route_version_id,
                    &outbound_base.route_version_id,
                    formation_length_mm,
                );
            let mut occupancy_resources =
                occupancy_resources_for_legs(&transaction, &inbound_seed)?;
            let (through_route, through) = if reverse_continuity {
                (None, None)
            } else {
                let mut legs = inbound_seed.clone();
                legs.extend(outbound_seed.iter().cloned());
                let route = TimetableRouteInput {
                    route_version_id: through_route_id.clone(),
                    template_id: through_template_id,
                    predecessor_id: Some(inbound.route_version_id.clone()),
                    transition_route_mm: Some(formation_length_mm),
                    legs,
                };
                validate_derived_route(&transaction, &route)?;
                let (dispatch, movement_resources) = generate_train_route_artifacts(
                    &transaction,
                    &inbound,
                    &route,
                    formation_length_mm,
                    MovementContinuity::SameDirection,
                    GeneratedMovementArtifacts {
                        interlocking: &mut batch.interlocking,
                        signals: &mut batch.signals,
                        resources: &mut batch.resources,
                    },
                    "Direct-Through-Fahrstrasse",
                )?;
                occupancy_resources
                    .extend(occupancy_resources_for_legs(&transaction, &outbound_seed)?);
                occupancy_resources.extend(movement_resources);
                add_generated_route_resources(&transaction, &route, &mut batch.resources)?;
                insert_generated(
                    &mut batch.routes,
                    through_route_id.clone(),
                    &route,
                    "Direct-Through-Laufweg",
                )?;
                (Some(route), Some(dispatch))
            };
            let predecessor = through_route.as_ref().unwrap_or(&inbound);
            let predecessor_id = predecessor.route_version_id.clone();
            let mut legs = outbound_seed;
            legs.extend(outbound_remainder);
            require(
                legs.len() >= 2,
                format!(
                    "Direct-Ausgang `{}` besitzt keine Bewegung hinter dem Formation-Seed.",
                    outbound_base.route_version_id
                ),
            )?;
            let qualified = TimetableRouteInput {
                route_version_id: route_id.clone(),
                template_id,
                predecessor_id: Some(predecessor_id),
                transition_route_mm: Some(formation_length_mm),
                legs,
            };
            validate_derived_route(&transaction, &qualified)?;
            let (dispatch, _) = generate_train_route_artifacts(
                &transaction,
                predecessor,
                &qualified,
                formation_length_mm,
                if reverse_continuity {
                    MovementContinuity::ReverseDirection
                } else {
                    MovementContinuity::SameDirection
                },
                GeneratedMovementArtifacts {
                    interlocking: &mut batch.interlocking,
                    signals: &mut batch.signals,
                    resources: &mut batch.resources,
                },
                "Direct-Ausgangsfahrstrasse",
            )?;
            add_generated_route_resources(&transaction, &qualified, &mut batch.resources)?;
            insert_generated(
                &mut batch.routes,
                route_id,
                &qualified,
                "Direct-Ausgangslaufweg",
            )?;
            batch.resources.extend(occupancy_resources.iter().cloned());
            let direct = DirectTemplateRecord {
                id: direct_id.clone(),
                demand_id: pair.id.clone(),
                inbound_route_version_id: inbound.route_version_id.clone(),
                outbound_route_version_id: outbound_base.route_version_id.clone(),
                location_id: pair.source_location_id.clone(),
                physical_stop_id: pair.source_physical_stop_id.clone(),
                earliest_departure_s: pair.earliest_departure_s,
                latest_arrival_s: pair.latest_arrival_s,
                available_window_s: pair.available_window_s,
                daily_boundary: pair.daily_boundary,
                formation_length_mm,
                terminal_intervals: source_intervals,
                movement_kind: "train".to_owned(),
                continuity: if reverse_continuity {
                    MovementContinuity::ReverseDirection
                } else {
                    MovementContinuity::SameDirection
                },
                maximum_dwell_ms: policy.maximum_direct_dwell_ms,
                resource_set_sha256: resource_set_sha256(&occupancy_resources),
                resource_ids: occupancy_resources,
                through,
                outbound: dispatch,
            };
            insert_generated(&mut batch.templates, direct_id, &direct, "Direct-Template")?;
            require_generated_unit_bound(
                unit_resident_bytes,
                &batch,
                MAX_GENERATED_UNIT_BYTES,
                "Direct-Turnaround-Fall",
            )?;
            drop(transaction);
            flush_generated_batch(database, &mut batch, tables, false, GENERATED_BATCH_BYTES)?;
            covered.insert((
                inbound.route_version_id.clone(),
                outbound_base.route_version_id.clone(),
                formation_length_mm,
            ));
        }
    }
    flush_generated_batch(database, &mut batch, tables, true, GENERATED_BATCH_BYTES)?;
    Ok(covered)
}

fn transfer_route_ids(
    demand_id: &str,
    source_route_id: &str,
    target_route_id: &str,
    formation_length_mm: i64,
) -> (String, String, String, String, String) {
    let length = formation_length_mm.to_string();
    let parts = [demand_id, source_route_id, target_route_id, length.as_str()];
    (
        stable_id("route:synthetic-transfer-qualified:", &parts),
        stable_id("template:synthetic-transfer-qualified:", &parts),
        stable_id("route:synthetic-transfer-target-outbound:", &parts),
        stable_id("template:synthetic-transfer-target-outbound:", &parts),
        stable_id("transfer-template:synthetic-physical:", &parts),
    )
}

fn generate_movement_route_artifacts(
    transaction: &redb::ReadTransaction,
    predecessor: &TimetableRouteInput,
    route: &TimetableRouteInput,
    movement_kind: &str,
    head_route_mm: i64,
    expected_continuity: MovementContinuity,
    generated: GeneratedMovementArtifacts<'_>,
) -> Result<(TurnaroundRouteDispatch, BTreeSet<String>)> {
    match movement_kind {
        "train" => generate_train_route_artifacts(
            transaction,
            predecessor,
            route,
            head_route_mm,
            expected_continuity,
            generated,
            "Transfer-Fahrstrasse",
        ),
        "shunting" => {
            let (id, value) = shunting_template_value(transaction, route, head_route_mm)?;
            let resources = resources_from_template_value(&value)?;
            generated.signals.insert(
                value["signalId"]
                    .as_str()
                    .expect("abgeleitete Rangiersignal-ID")
                    .to_owned(),
            );
            generated.resources.extend(resources.iter().cloned());
            insert_generated(
                &mut *generated.interlocking,
                id.clone(),
                &value,
                "Transfer-Fahrstrasse",
            )?;
            Ok((
                TurnaroundRouteDispatch {
                    route_version_id: route.route_version_id.clone(),
                    predecessor_base_route_version_id: route.predecessor_id.clone().ok_or_else(
                        || {
                            GermanyOperationalV2Error::new(format!(
                                "Abgeleiteter Rangierlaufweg `{}` besitzt keine statische Vorgaengerbindung.",
                                route.route_version_id
                            ))
                        },
                    )?,
                    continuity: require_movement_continuity(
                        predecessor,
                        route,
                        head_route_mm,
                        expected_continuity,
                    )?,
                    dispatch_interlocking_route_id: id,
                    head_route_mm,
                    minimum_runtime_ms: minimum_route_runtime_ms(
                        transaction,
                        route,
                        head_route_mm,
                    )?,
                    resource_ids: resources.clone(),
                    route_leg_count: u32::try_from(route.legs.len())
                        .map_err(|_| GermanyOperationalV2Error::new("Zu viele Laufweg-Legs."))?,
                    protection_contract_runs: protection_contract_runs(&route.legs)?,
                },
                resources,
            ))
        }
        other => Err(GermanyOperationalV2Error::new(format!(
            "Transferlaufweg `{}` besitzt ungueltige Bewegungsart `{other}`.",
            route.route_version_id
        ))),
    }
}

struct ValidatedTransferInput {
    source: TimetableRouteInput,
    target: TimetableRouteInput,
    raw: TimetableRouteInput,
}

fn validate_transfer_input_base(
    transaction: &redb::ReadTransaction,
    policy: &PolicySpec,
    input: &TransferRouteInput,
) -> Result<ValidatedTransferInput> {
    require(
        !input.id.is_empty()
            && !input.lot_id.is_empty()
            && !input.asset_compatibility_key.is_empty()
            && !input.source_circulation_id.is_empty()
            && !input.target_circulation_id.is_empty()
            && !input.source_passenger_leg_id.is_empty()
            && !input.target_passenger_leg_id.is_empty()
            && !input.source_location_id.is_empty()
            && !input.target_location_id.is_empty()
            && !input.source_physical_stop_id.is_empty()
            && !input.target_physical_stop_id.is_empty()
            && (input.source_location_id != input.target_location_id
                || input.source_physical_stop_id != input.target_physical_stop_id)
            && input.available_window_s > 0
            && input
                .latest_arrival_s
                .checked_sub(input.earliest_departure_s)
                == Some(input.available_window_s)
            && input.movement_kind == "train"
            && input.total_length_mm > 0
            && input.weighted_cost_mm >= input.total_length_mm
            && input.minimum_runtime_ms > 0
            && input.formation_lengths_mm == policy.terminal_formation_lengths_mm,
        format!(
            "Transferanforderung `{}` besitzt keinen vollstaendigen fail-closed Vertrag.",
            input.id
        ),
    )?;
    let routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    let source_serialized = routes
        .get(input.source_passenger_route_version_id.as_str())
        .map_err(db_error)?
        .ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Transferanforderung `{}` verweist auf unbekannte Quell-Personenroute `{}`.",
                input.id, input.source_passenger_route_version_id
            ))
        })?;
    let target_serialized = routes
        .get(input.target_passenger_route_version_id.as_str())
        .map_err(db_error)?
        .ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Transferanforderung `{}` verweist auf unbekannte Ziel-Personenroute `{}`.",
                input.id, input.target_passenger_route_version_id
            ))
        })?;
    let source = route_from_json(source_serialized.value(), "Transfer-Quellroute")?;
    let target = route_from_json(target_serialized.value(), "Transfer-Zielroute")?;
    drop(source_serialized);
    drop(target_serialized);
    drop(routes);
    let raw = TimetableRouteInput {
        route_version_id: input.route_version_id.clone(),
        template_id: input.template_id.clone(),
        predecessor_id: None,
        transition_route_mm: None,
        legs: input.legs.clone(),
    };
    validate_derived_route(transaction, &raw)?;
    let raw_length_mm = route_length(&raw)?;
    let raw_runtime_ms = minimum_route_runtime_ms(transaction, &raw, 0)?;
    require(
        raw_length_mm == input.total_length_mm && raw_runtime_ms == input.minimum_runtime_ms,
        format!(
            "Transferanforderung `{}` driftet in nativer Laenge/Laufzeit: {} mm/{raw_runtime_ms} ms statt {} mm/{} ms.",
            input.id, raw_length_mm, input.total_length_mm, input.minimum_runtime_ms
        ),
    )?;
    let source_last = source.legs.last().expect("validierte Quellroute");
    let target_first = target.legs.first().expect("validierte Zielroute");
    let source_track = get_track(transaction, &source_last.edge_id)?;
    let target_track = get_track(transaction, &target_first.edge_id)?;
    let raw_first = raw.legs.first().expect("validierte Transferroute");
    let raw_last = raw.legs.last().expect("validierte Transferroute");
    let raw_first_track = get_track(transaction, &raw_first.edge_id)?;
    let raw_last_track = get_track(transaction, &raw_last.edge_id)?;
    require(
        same_physical_point(
            &source_track,
            source_last.edge_exit_mm,
            &raw_first_track,
            raw_first.edge_entry_mm,
        ) && same_physical_point(
            &raw_last_track,
            raw_last.edge_exit_mm,
            &target_track,
            target_first.edge_entry_mm,
        ),
        format!(
            "Transferanforderung `{}` schliesst nicht physisch an beide Personenrouten an.",
            input.id
        ),
    )?;
    Ok(ValidatedTransferInput {
        source,
        target,
        raw,
    })
}

struct BuiltTransferRoutes {
    record_id: String,
    transfer: TimetableRouteInput,
    target_outbound: TimetableRouteInput,
}

fn build_transfer_routes(
    transaction: &redb::ReadTransaction,
    input: &TransferRouteInput,
    validated: &ValidatedTransferInput,
    formation_length_mm: i64,
) -> Result<BuiltTransferRoutes> {
    require(
        input.formation_lengths_mm.contains(&formation_length_mm),
        "Transfer-Formation ist nicht vom signierten Input gefordert.",
    )?;
    let source_seed = formation_tail_legs(
        &validated.source,
        formation_length_mm,
        &format!("Transferquelle `{}`", input.id),
    )?;
    let (target_seed, target_remainder) = formation_prefix_and_remainder(
        &validated.target,
        formation_length_mm,
        &format!("Transferziel `{}`", input.id),
    )?;
    let (
        transfer_route_id,
        transfer_template_id,
        target_outbound_route_id,
        target_outbound_template_id,
        record_id,
    ) = transfer_route_ids(
        &input.id,
        &validated.source.route_version_id,
        &validated.target.route_version_id,
        formation_length_mm,
    );
    let mut transfer_legs = Vec::with_capacity(
        validated
            .raw
            .legs
            .len()
            .saturating_add(source_seed.len())
            .saturating_add(target_seed.len()),
    );
    transfer_legs.extend(source_seed);
    transfer_legs.extend(validated.raw.legs.iter().cloned());
    transfer_legs.extend(target_seed.iter().cloned());
    let transfer = TimetableRouteInput {
        route_version_id: transfer_route_id,
        template_id: transfer_template_id,
        predecessor_id: Some(validated.source.route_version_id.clone()),
        transition_route_mm: Some(formation_length_mm),
        legs: transfer_legs,
    };
    validate_derived_route(transaction, &transfer)?;
    require_movement_continuity(
        &validated.source,
        &transfer,
        formation_length_mm,
        MovementContinuity::SameDirection,
    )?;

    let mut target_outbound_legs = target_seed;
    target_outbound_legs.extend(target_remainder);
    require(
        target_outbound_legs.len() >= 2,
        format!(
            "Transferzielroute `{}` besitzt keine Bewegung hinter dem Formation-Seed.",
            validated.target.route_version_id
        ),
    )?;
    let target_outbound = TimetableRouteInput {
        route_version_id: target_outbound_route_id,
        template_id: target_outbound_template_id,
        predecessor_id: Some(transfer.route_version_id.clone()),
        transition_route_mm: Some(formation_length_mm),
        legs: target_outbound_legs,
    };
    validate_derived_route(transaction, &target_outbound)?;
    require_movement_continuity(
        &transfer,
        &target_outbound,
        formation_length_mm,
        MovementContinuity::SameDirection,
    )?;
    let window_ms = input
        .available_window_s
        .checked_mul(1_000)
        .ok_or_else(|| GermanyOperationalV2Error::new("Transfer-Zeitfenster laeuft ueber."))?;
    let minimum_runtime_ms = minimum_route_runtime_ms(transaction, &transfer, formation_length_mm)?;
    require(
        minimum_runtime_ms <= window_ms,
        format!(
            "Transferanforderung `{}` braucht {minimum_runtime_ms} ms, besitzt aber nur {window_ms} ms.",
            input.id
        ),
    )?;
    Ok(BuiltTransferRoutes {
        record_id,
        transfer,
        target_outbound,
    })
}

fn validate_transfer_inputs_preflight(
    database: &Database,
    policy: &PolicySpec,
    inputs: &[TransferRouteInput],
) -> Result<usize> {
    let transaction = database.begin_read().map_err(db_error)?;
    let mut covered = 0_usize;
    for input in inputs {
        let validated = validate_transfer_input_base(&transaction, policy, input)?;
        for &formation_length_mm in &input.formation_lengths_mm {
            let _ = build_transfer_routes(&transaction, input, &validated, formation_length_mm)?;
            covered = covered.checked_add(1).ok_or_else(|| {
                GermanyOperationalV2Error::new("Transfer-Preflight-Menge laeuft ueber.")
            })?;
        }
    }
    drop(transaction);
    Ok(covered)
}

fn derive_transfer_templates(
    database: &Database,
    policy: &PolicySpec,
    inputs: &[TransferRouteInput],
) -> Result<()> {
    if inputs.is_empty() {
        return Ok(());
    }
    let tables = GeneratedBatchTables {
        routes: TRANSFER_ROUTES,
        interlocking: TRANSFER_INTERLOCKING,
        templates: TRANSFER_TEMPLATES,
        route_context: "Transfer-Laufweg",
        interlocking_context: "Transfer-Fahrstrasse",
        template_context: "Transfer-Template",
    };
    let mut batch = GeneratedBatch::default();

    for input in inputs {
        for &formation_length_mm in &input.formation_lengths_mm {
            let unit_resident_bytes = batch.estimated_resident_bytes();
            let transaction = database.begin_read().map_err(db_error)?;
            let validated = validate_transfer_input_base(&transaction, policy, input)?;
            let BuiltTransferRoutes {
                record_id,
                transfer,
                target_outbound,
            } = build_transfer_routes(&transaction, input, &validated, formation_length_mm)?;

            let (transfer_dispatch, movement_resources) = generate_movement_route_artifacts(
                &transaction,
                &validated.source,
                &transfer,
                &input.movement_kind,
                formation_length_mm,
                MovementContinuity::SameDirection,
                GeneratedMovementArtifacts {
                    interlocking: &mut batch.interlocking,
                    signals: &mut batch.signals,
                    resources: &mut batch.resources,
                },
            )?;
            let (target_outbound_dispatch, _) = generate_train_route_artifacts(
                &transaction,
                &transfer,
                &target_outbound,
                formation_length_mm,
                MovementContinuity::SameDirection,
                GeneratedMovementArtifacts {
                    interlocking: &mut batch.interlocking,
                    signals: &mut batch.signals,
                    resources: &mut batch.resources,
                },
                "Transfer-Zielausgangsfahrstrasse",
            )?;
            for route in [&transfer, &target_outbound] {
                add_generated_route_resources(&transaction, route, &mut batch.resources)?;
                insert_generated(
                    &mut batch.routes,
                    route.route_version_id.clone(),
                    route,
                    "Transfer-Laufweg",
                )?;
            }
            let record = TransferTemplateRecord {
                id: record_id.clone(),
                demand_id: input.id.clone(),
                formation_length_mm,
                source_passenger_route_version_id: validated.source.route_version_id.clone(),
                target_passenger_route_version_id: validated.target.route_version_id.clone(),
                source_location_id: input.source_location_id.clone(),
                target_location_id: input.target_location_id.clone(),
                earliest_departure_s: input.earliest_departure_s,
                latest_arrival_s: input.latest_arrival_s,
                available_window_s: input.available_window_s,
                daily_boundary: input.daily_boundary,
                movement_kind: input.movement_kind.clone(),
                transfer: transfer_dispatch,
                target_outbound: target_outbound_dispatch,
                resource_set_sha256: resource_set_sha256(&movement_resources),
                resource_ids: movement_resources,
            };
            insert_generated(
                &mut batch.templates,
                record_id,
                &record,
                "Transfer-Template",
            )?;
            require_generated_unit_bound(
                unit_resident_bytes,
                &batch,
                MAX_GENERATED_UNIT_BYTES,
                "Transfer-Fall",
            )?;
            drop(transaction);
            flush_generated_batch(database, &mut batch, tables, false, GENERATED_BATCH_BYTES)?;
        }
    }
    flush_generated_batch(database, &mut batch, tables, true, GENERATED_BATCH_BYTES)?;
    Ok(())
}

fn derive_turnaround_case(
    database: &Database,
    policy: &PolicySpec,
    demand: &TurnaroundPairDemand,
    formation_length_mm: i64,
    batch: &mut GeneratedBatch,
    tables: GeneratedBatchTables,
) -> Result<bool> {
    let transaction = database.begin_read().map_err(db_error)?;
    let inbound = timetable_route(
        &transaction,
        &demand.inbound_route_version_id,
        "Ankunfts-Personenlaufweg aus DailyPlan",
    )?;
    let outbound_base = timetable_route(
        &transaction,
        &demand.outbound_route_version_id,
        "Ausgangs-Personenlaufweg aus DailyPlan",
    )?;
    let inbound_terminal_leg = inbound
        .legs
        .last()
        .ok_or_else(|| GermanyOperationalV2Error::new("Ankunftslaufweg ist leer."))?;
    let inbound_direction = inbound_terminal_leg.direction.clone();
    let inbound_access = inbound_terminal_access(&transaction, &inbound)?;
    let terminal_edge_id = inbound_access.terminal_track.id.clone();
    let terminal_node_id = inbound_access.node_id;
    let outbound_first = outbound_base
        .legs
        .first()
        .ok_or_else(|| GermanyOperationalV2Error::new("Ausgangslaufweg ist leer."))?;
    let outbound_direction = outbound_first.direction.clone();
    let outbound_access = outbound_terminal_access(&transaction, &outbound_base)?;
    let inbound_seed = formation_tail_legs(
        &inbound,
        formation_length_mm,
        &format!(
            "Ankunftslaufweg `{}` fuer Formation {formation_length_mm}",
            inbound.route_version_id
        ),
    )?;
    let terminal_intervals = terminal_intervals(&inbound_seed);
    let candidates = paired_stabling_candidates_with_fallback(
        &transaction,
        &inbound_access,
        &outbound_access,
        formation_length_mm,
        policy.minimum_berth_end_clearance_mm,
        policy.maximum_stabling_path_edges,
        policy.maximum_stabling_path_length_mm,
        &inbound.route_version_id,
        &outbound_base.route_version_id,
        demand,
    )?
    .candidates;
    drop(transaction);

    let mut emitted = false;
    for (candidate_rank, candidate) in candidates.iter().enumerate() {
        let unit_resident_bytes = batch.estimated_resident_bytes();
        let transaction = database.begin_read().map_err(db_error)?;
        let built = build_stabling_routes(
            &transaction,
            policy,
            &inbound,
            &outbound_base,
            formation_length_mm,
            candidate,
        )?;
        let stabling_runtime_ms =
            stabling_minimum_runtime_ms(&transaction, &built, formation_length_mm)?;
        let available_window_ms =
            demand
                .available_window_s
                .checked_mul(1_000)
                .ok_or_else(|| {
                    GermanyOperationalV2Error::new("Turnaround-Zeitfenster laeuft ueber.")
                })?;
        if stabling_runtime_ms > available_window_ms {
            continue;
        }
        let BuiltStablingRoutes {
            ids,
            arrival_berth,
            departure_berth,
            shunt_in,
            berth_transfer,
            shunt_out,
            shunt_out_continuity,
            outbound,
        } = built;
        let shunt_out_predecessor = berth_transfer.as_ref().unwrap_or(&shunt_in);
        let (shunt_in_dispatch, _) = generate_movement_route_artifacts(
            &transaction,
            &inbound,
            &shunt_in,
            "shunting",
            formation_length_mm,
            MovementContinuity::SameDirection,
            GeneratedMovementArtifacts {
                interlocking: &mut batch.interlocking,
                signals: &mut batch.signals,
                resources: &mut batch.resources,
            },
        )?;
        let berth_transfer_dispatch = if let Some(route) = &berth_transfer {
            Some(
                generate_movement_route_artifacts(
                    &transaction,
                    &shunt_in,
                    route,
                    "shunting",
                    formation_length_mm,
                    MovementContinuity::ReverseDirection,
                    GeneratedMovementArtifacts {
                        interlocking: &mut batch.interlocking,
                        signals: &mut batch.signals,
                        resources: &mut batch.resources,
                    },
                )?
                .0,
            )
        } else {
            None
        };
        let (shunt_out_dispatch, _) = generate_movement_route_artifacts(
            &transaction,
            shunt_out_predecessor,
            &shunt_out,
            "shunting",
            formation_length_mm,
            shunt_out_continuity,
            GeneratedMovementArtifacts {
                interlocking: &mut batch.interlocking,
                signals: &mut batch.signals,
                resources: &mut batch.resources,
            },
        )?;
        let (outbound_dispatch, _) = generate_movement_route_artifacts(
            &transaction,
            &shunt_out,
            &outbound,
            "train",
            formation_length_mm,
            MovementContinuity::SameDirection,
            GeneratedMovementArtifacts {
                interlocking: &mut batch.interlocking,
                signals: &mut batch.signals,
                resources: &mut batch.resources,
            },
        )?;
        for route in berth_transfer
            .iter()
            .chain([&shunt_in, &shunt_out, &outbound])
        {
            add_generated_route_resources(&transaction, route, &mut batch.resources)?;
            insert_generated(
                &mut batch.routes,
                route.route_version_id.clone(),
                route,
                "Turnaround-Laufweg",
            )?;
        }
        let candidate_rank = u32::try_from(candidate_rank)
            .map_err(|_| GermanyOperationalV2Error::new("Zu viele Abstellkandidaten."))?;
        let record = TurnaroundTemplateRecord {
            id: ids.turnaround_id.clone(),
            demand_id: demand.id.clone(),
            inbound_route_version_id: inbound.route_version_id.clone(),
            outbound_route_version_id: outbound_base.route_version_id.clone(),
            location_id: demand.source_location_id.clone(),
            physical_stop_id: demand.source_physical_stop_id.clone(),
            earliest_departure_s: demand.earliest_departure_s,
            latest_arrival_s: demand.latest_arrival_s,
            available_window_s: demand.available_window_s,
            daily_boundary: demand.daily_boundary,
            terminal_edge_id: terminal_edge_id.clone(),
            terminal_node_id,
            inbound_direction: inbound_direction.clone(),
            outbound_direction: outbound_direction.clone(),
            formation_length_mm,
            candidate_rank,
            stabling_path_length_mm: candidate.total_length_mm,
            terminal_intervals: terminal_intervals.clone(),
            stabling_kind: candidate.stabling_kind,
            arrival_berth_assignment: candidate.arrival_berth_assignment,
            departure_berth_assignment: candidate.departure_berth_assignment,
            shunt_in: shunt_in_dispatch,
            arrival_berth,
            berth_transfer: berth_transfer_dispatch,
            berth_transfer_provenance: candidate.berth_transfer_provenance.clone(),
            departure_berth,
            shunt_out: shunt_out_dispatch,
            outbound: outbound_dispatch,
        };
        insert_generated(
            &mut batch.templates,
            ids.turnaround_id,
            &record,
            "Turnaround-Template",
        )?;
        require_generated_unit_bound(
            unit_resident_bytes,
            batch,
            MAX_GENERATED_UNIT_BYTES,
            "Stabling-Turnaround-Kandidat",
        )?;
        emitted = true;
        drop(transaction);
        flush_generated_batch(database, batch, tables, false, GENERATED_BATCH_BYTES)?;
    }
    Ok(emitted)
}

fn derive_turnaround_templates(
    database: &Database,
    policy: &PolicySpec,
    required_pairs: Option<&[TurnaroundPairDemand]>,
) -> Result<BTreeSet<(String, String, i64)>> {
    if policy.terminal_formation_lengths_mm.is_empty() {
        return Ok(BTreeSet::new());
    }
    {
        let transaction = database.begin_read().map_err(db_error)?;
        let routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
        require(
            !routes.is_empty().map_err(db_error)?,
            "terminalFormationLengthsMm verlangt einen gepinnten timetableRoutes-Layer.",
        )?;
    }
    let required_pairs = required_pairs.ok_or_else(|| {
        GermanyOperationalV2Error::new(
            "Stabling-Turnaround-Ableitung verlangt die explizite DailyPlan-v2-Partition.",
        )
    })?;
    let tables = GeneratedBatchTables {
        routes: TURNAROUND_ROUTES,
        interlocking: TURNAROUND_INTERLOCKING,
        templates: TURNAROUND_TEMPLATES,
        route_context: "Turnaround-Laufweg",
        interlocking_context: "Turnaround-Fahrstrasse",
        template_context: "Turnaround-Template",
    };
    let mut unique_pairs = BTreeSet::new();
    for pair in required_pairs {
        require(
            unique_pairs.insert((
                pair.inbound_route_version_id.clone(),
                pair.outbound_route_version_id.clone(),
            )),
            "DailyPlan-v2 bindet ein Turnaround-Routenpaar mehrfach.",
        )?;
    }
    let mut batch = GeneratedBatch::default();
    let mut covered = BTreeSet::new();
    for pair in required_pairs {
        for &formation_length_mm in &policy.terminal_formation_lengths_mm {
            if derive_turnaround_case(
                database,
                policy,
                pair,
                formation_length_mm,
                &mut batch,
                tables,
            )? {
                covered.insert((
                    pair.inbound_route_version_id.clone(),
                    pair.outbound_route_version_id.clone(),
                    formation_length_mm,
                ));
            }
        }
    }
    flush_generated_batch(database, &mut batch, tables, true, GENERATED_BATCH_BYTES)?;
    Ok(covered)
}

fn write_bytes(
    writer: &mut BufWriter<File>,
    bytes: &[u8],
    context: &str,
    path: &Path,
) -> Result<()> {
    writer
        .write_all(bytes)
        .map_err(|error| io_error(context, path, error))
}

fn write_json<T: Serialize + ?Sized>(
    writer: &mut BufWriter<File>,
    value: &T,
    context: &str,
    path: &Path,
) -> Result<()> {
    serde_json::to_writer(writer, value).map_err(|error| {
        GermanyOperationalV2Error::new(format!("{context} `{}`: {error}", path.display()))
    })
}

fn write_map_entry_prefix(
    writer: &mut BufWriter<File>,
    first: &mut bool,
    key: &str,
    path: &Path,
) -> Result<()> {
    if !*first {
        write_bytes(writer, b",", "Operational-v2-Rohkandidat", path)?;
    }
    *first = false;
    write_json(writer, key, "Operational-v2-Schluessel", path)?;
    write_bytes(writer, b":", "Operational-v2-Rohkandidat", path)
}

fn write_set_table(
    transaction: &redb::ReadTransaction,
    writer: &mut BufWriter<File>,
    definition: TableDefinition<&str, ()>,
    path: &Path,
) -> Result<()> {
    let table = transaction.open_table(definition).map_err(db_error)?;
    write_bytes(writer, b"[", "Operational-v2-Rohkandidat", path)?;
    let mut first = true;
    for entry in table.iter().map_err(db_error)? {
        let (key, _) = entry.map_err(db_error)?;
        if !first {
            write_bytes(writer, b",", "Operational-v2-Rohkandidat", path)?;
        }
        first = false;
        write_json(writer, key.value(), "Operational-v2-Set", path)?;
    }
    write_bytes(writer, b"]", "Operational-v2-Rohkandidat", path)
}

fn write_directed_edges(
    transaction: &redb::ReadTransaction,
    writer: &mut BufWriter<File>,
    path: &Path,
) -> Result<()> {
    let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    write_bytes(writer, b"{", "Operational-v2-Rohkandidat", path)?;
    let mut first = true;
    for entry in tracks.iter().map_err(db_error)? {
        let (edge_id, serialized) = entry.map_err(db_error)?;
        let track = track_from_json(serialized.value(), "Gleiskante fuer directedEdges")?;
        write_map_entry_prefix(writer, &mut first, edge_id.value(), path)?;
        write_json(writer, &track.length_mm, "Kantenlaenge", path)?;
    }
    write_bytes(writer, b"}", "Operational-v2-Rohkandidat", path)
}

fn write_edge_geometries(
    transaction: &redb::ReadTransaction,
    writer: &mut BufWriter<File>,
    path: &Path,
) -> Result<()> {
    let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    write_bytes(writer, b"{", "Operational-v2-Rohkandidat", path)?;
    let mut first = true;
    for entry in tracks.iter().map_err(db_error)? {
        let (edge_id, serialized) = entry.map_err(db_error)?;
        let track = track_from_json(serialized.value(), "Gleiskante fuer edgeGeometries")?;
        write_map_entry_prefix(writer, &mut first, edge_id.value(), path)?;
        write_json(writer, &track.geometry, "Kantengeometrie", path)?;
    }
    write_bytes(writer, b"}", "Operational-v2-Rohkandidat", path)
}

fn route_leg_value(
    transaction: &redb::ReadTransaction,
    track: &TrackRecord,
    leg: &TimetableLegInput,
    route_start_mm: i64,
    policy: &PolicySpec,
) -> Result<Value> {
    let block_ids = track_block_resources(transaction, &track.id)?;
    let speed_limit_mmps = if leg.direction == "along" {
        track.speed_along_mmps
    } else {
        track.speed_against_mmps
    };
    Ok(json!({
        "edgeId": track.id,
        "direction": leg.direction,
        "edgeEntryMm": leg.edge_entry_mm,
        "edgeExitMm": leg.edge_exit_mm,
        "routeStartMm": route_start_mm,
        "blockIds": block_ids,
        "speedLimitMmps": speed_limit_mmps,
        "gradientPerMille": policy.unknown_gradient_abs_permille,
        "availableProtectionSystems": &leg.available_protection_systems,
        "simultaneouslyRequiredProtectionSystems": &leg.simultaneously_required_protection_systems,
    }))
}

fn route_value(
    transaction: &redb::ReadTransaction,
    route: &TimetableRouteInput,
    policy: &PolicySpec,
) -> Result<Value> {
    let mut route_start_mm = 0_i64;
    let mut legs = Vec::with_capacity(route.legs.len());
    for (index, leg) in route.legs.iter().enumerate() {
        let track = get_track(transaction, &leg.edge_id)?;
        let length = validate_timetable_leg(
            &track,
            leg,
            &format!("Laufweg `{}` Leg {index}", route.route_version_id),
        )?;
        legs.push(route_leg_value(
            transaction,
            &track,
            leg,
            route_start_mm,
            policy,
        )?);
        route_start_mm = route_start_mm.checked_add(length).ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Laufweg `{}` laeuft ueber.",
                route.route_version_id
            ))
        })?;
    }
    Ok(json!({
        "id": route.route_version_id,
        "templateId": route.template_id,
        "predecessorId": route.predecessor_id,
        "transitionRouteMm": route.transition_route_mm,
        "legs": legs,
    }))
}

fn local_route(track: &TrackRecord, direction: &str) -> TimetableRouteInput {
    let (entry, exit) = if direction == "along" {
        (0, track.length_mm)
    } else {
        (track.length_mm, 0)
    };
    TimetableRouteInput {
        route_version_id: local_route_id(&track.id, direction),
        template_id: local_template_id(&track.id, direction),
        predecessor_id: None,
        transition_route_mm: None,
        legs: vec![TimetableLegInput {
            edge_id: track.id.clone(),
            direction: direction.to_owned(),
            edge_entry_mm: entry,
            edge_exit_mm: exit,
            available_protection_systems: track.protection_systems.iter().cloned().collect(),
            simultaneously_required_protection_systems: Vec::new(),
        }],
    }
}

fn write_route_versions(
    transaction: &redb::ReadTransaction,
    writer: &mut BufWriter<File>,
    path: &Path,
    policy: &PolicySpec,
    timetable: bool,
) -> Result<()> {
    write_bytes(writer, b"{", "Operational-v2-Rohkandidat", path)?;
    let mut first = true;
    if timetable {
        let routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
        for entry in routes.iter().map_err(db_error)? {
            let (route_id, serialized) = entry.map_err(db_error)?;
            let route: TimetableRouteInput =
                serde_json::from_str(serialized.value()).map_err(|error| {
                    GermanyOperationalV2Error::new(format!(
                        "Timetable-Index ist ungueltig: {error}"
                    ))
                })?;
            write_map_entry_prefix(writer, &mut first, route_id.value(), path)?;
            write_json(
                writer,
                &route_value(transaction, &route, policy)?,
                "Laufwegversion",
                path,
            )?;
        }
        let routes = transaction.open_table(TRANSFER_ROUTES).map_err(db_error)?;
        for entry in routes.iter().map_err(db_error)? {
            let (route_id, serialized) = entry.map_err(db_error)?;
            let route = route_from_json(serialized.value(), "Transfer-Laufwegindex")?;
            write_map_entry_prefix(writer, &mut first, route_id.value(), path)?;
            write_json(
                writer,
                &route_value(transaction, &route, policy)?,
                "Transfer-Laufwegversion",
                path,
            )?;
        }
        let routes = transaction
            .open_table(TURNAROUND_ROUTES)
            .map_err(db_error)?;
        for entry in routes.iter().map_err(db_error)? {
            let (route_id, serialized) = entry.map_err(db_error)?;
            let route = route_from_json(serialized.value(), "Turnaround-Laufwegindex")?;
            write_map_entry_prefix(writer, &mut first, route_id.value(), path)?;
            write_json(
                writer,
                &route_value(transaction, &route, policy)?,
                "Turnaround-Laufwegversion",
                path,
            )?;
        }
    } else {
        let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
        for entry in tracks.iter().map_err(db_error)? {
            let (_, serialized) = entry.map_err(db_error)?;
            let track = track_from_json(serialized.value(), "Gleiskante fuer lokale Laufwege")?;
            for direction in ["along", "against"] {
                let route = local_route(&track, direction);
                write_map_entry_prefix(writer, &mut first, &route.route_version_id, path)?;
                write_json(
                    writer,
                    &route_value(transaction, &route, policy)?,
                    "lokale Laufwegversion",
                    path,
                )?;
            }
        }
    }
    write_bytes(writer, b"}", "Operational-v2-Rohkandidat", path)
}

fn template_value(
    transaction: &redb::ReadTransaction,
    route: &TimetableRouteInput,
    leg_index: usize,
    authority_start: i64,
) -> Result<(String, Value, i64)> {
    let leg = route
        .legs
        .get(leg_index)
        .ok_or_else(|| GermanyOperationalV2Error::new("Interlocking-Leg fehlt."))?;
    let authority_end = authority_start
        .checked_add(
            i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm)).unwrap_or(i64::MAX),
        )
        .ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Fahrstrasse fuer `{}` laeuft in Leg {leg_index} ueber.",
                route.route_version_id
            ))
        })?;
    let track = get_track(transaction, &leg.edge_id)?;
    let path_resources = track_block_resources(transaction, &track.id)?;
    let entry = boundary_resource(&track, leg.edge_entry_mm)?;
    let overlap = boundary_resource(&track, leg.edge_exit_mm)?;
    let mut flank_resources = BTreeSet::from([entry]);
    if flank_resources.contains(&overlap) {
        flank_resources.insert(self_loop_flank_resource(&track.id));
    }
    flank_resources.remove(&overlap);
    require(
        !flank_resources.is_empty(),
        format!(
            "Fahrstrasse fuer `{}` Leg {leg_index} besitzt keinen eigenstaendigen Flankenschutz.",
            route.route_version_id,
        ),
    )?;
    let switch_positions = switch_positions_for_leg(
        transaction,
        &track,
        leg.edge_entry_mm,
        leg.edge_exit_mm,
        &route.route_version_id,
    )?;
    let template_id = stable_id(
        "interlocking:synthetic-segment:",
        &[route.route_version_id.as_str(), &leg_index.to_string()],
    );
    Ok((
        template_id.clone(),
        json!({
            "id": template_id,
            "routeTemplateId": route.template_id,
            "signalId": synthetic_signal_id(&route.route_version_id, leg_index),
            "movementKind": "train",
            "pathResources": path_resources,
            "overlapResources": BTreeSet::from([overlap]),
            "flankResources": flank_resources,
            "switchPositions": switch_positions,
            "authorityStartRouteMm": authority_start,
            "authorityEndRouteMm": authority_end,
            "releaseAfterTailRouteMm": authority_end,
        }),
        authority_end,
    ))
}

fn write_interlocking_routes(
    transaction: &redb::ReadTransaction,
    writer: &mut BufWriter<File>,
    path: &Path,
    timetable: bool,
) -> Result<()> {
    write_bytes(writer, b"{", "Operational-v2-Rohkandidat", path)?;
    let mut first = true;
    if timetable {
        let routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
        for entry in routes.iter().map_err(db_error)? {
            let (_, serialized) = entry.map_err(db_error)?;
            let route: TimetableRouteInput =
                serde_json::from_str(serialized.value()).map_err(|error| {
                    GermanyOperationalV2Error::new(format!(
                        "Timetable-Index ist ungueltig: {error}"
                    ))
                })?;
            let mut authority_start = 0_i64;
            for leg_index in 0..route.legs.len() {
                let (template_id, value, authority_end) =
                    template_value(transaction, &route, leg_index, authority_start)?;
                write_map_entry_prefix(writer, &mut first, &template_id, path)?;
                write_json(writer, &value, "synthetische Segmentfahrstrasse", path)?;
                authority_start = authority_end;
            }
        }
        let generated = transaction
            .open_table(TURNAROUND_INTERLOCKING)
            .map_err(db_error)?;
        for entry in generated.iter().map_err(db_error)? {
            let (template_id, serialized) = entry.map_err(db_error)?;
            write_map_entry_prefix(writer, &mut first, template_id.value(), path)?;
            write_bytes(
                writer,
                serialized.value().as_bytes(),
                "Turnaround-Fahrstrasse",
                path,
            )?;
        }
        let generated = transaction
            .open_table(TRANSFER_INTERLOCKING)
            .map_err(db_error)?;
        for entry in generated.iter().map_err(db_error)? {
            let (template_id, serialized) = entry.map_err(db_error)?;
            write_map_entry_prefix(writer, &mut first, template_id.value(), path)?;
            write_bytes(
                writer,
                serialized.value().as_bytes(),
                "Transfer-Fahrstrasse",
                path,
            )?;
        }
    } else {
        let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
        for entry in tracks.iter().map_err(db_error)? {
            let (_, serialized) = entry.map_err(db_error)?;
            let track = track_from_json(serialized.value(), "Gleiskante fuer lokale Fahrstrassen")?;
            for direction in ["along", "against"] {
                let route = local_route(&track, direction);
                let (template_id, value, _) = template_value(transaction, &route, 0, 0)?;
                write_map_entry_prefix(writer, &mut first, &template_id, path)?;
                write_json(writer, &value, "lokale synthetische Fahrstrasse", path)?;
            }
        }
    }
    write_bytes(writer, b"}", "Operational-v2-Rohkandidat", path)
}

fn write_platforms(
    transaction: &redb::ReadTransaction,
    writer: &mut BufWriter<File>,
    path: &Path,
) -> Result<()> {
    let platforms = transaction.open_table(PLATFORMS).map_err(db_error)?;
    write_bytes(writer, b"{", "Operational-v2-Rohkandidat", path)?;
    let mut first = true;
    for entry in platforms.iter().map_err(db_error)? {
        let (platform_id, serialized) = entry.map_err(db_error)?;
        write_map_entry_prefix(writer, &mut first, platform_id.value(), path)?;
        write_bytes(
            writer,
            serialized.value().as_bytes(),
            "Bahnsteigintervall",
            path,
        )?;
    }
    write_bytes(writer, b"}", "Operational-v2-Rohkandidat", path)
}

fn write_raw_candidate(
    database: &Database,
    path: &Path,
    spec: &DerivationSpec,
    timetable: bool,
) -> Result<()> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| io_error("Operational-v2-Rohkandidat", path, error))?;
    let mut writer = BufWriter::new(file);
    let transaction = database.begin_read().map_err(db_error)?;
    write_bytes(
        &mut writer,
        b"{\"blockResources\":",
        "Operational-v2-Rohkandidat",
        path,
    )?;
    write_set_table(&transaction, &mut writer, BLOCK_RESOURCES, path)?;
    write_bytes(
        &mut writer,
        b",\"directedEdges\":",
        "Operational-v2-Rohkandidat",
        path,
    )?;
    write_directed_edges(&transaction, &mut writer, path)?;
    write_bytes(
        &mut writer,
        b",\"edgeGeometries\":",
        "Operational-v2-Rohkandidat",
        path,
    )?;
    write_edge_geometries(&transaction, &mut writer, path)?;
    write_bytes(&mut writer, b",\"id\":", "Operational-v2-Rohkandidat", path)?;
    write_json(&mut writer, &spec.infra_release_id, "InfraRelease-ID", path)?;
    write_bytes(
        &mut writer,
        b",\"interlockingRoutes\":",
        "Operational-v2-Rohkandidat",
        path,
    )?;
    write_interlocking_routes(&transaction, &mut writer, path, timetable)?;
    write_bytes(
        &mut writer,
        b",\"platformIntervals\":",
        "Operational-v2-Rohkandidat",
        path,
    )?;
    write_platforms(&transaction, &mut writer, path)?;
    write_bytes(
        &mut writer,
        b",\"regionBoundaries\":[",
        "Operational-v2-Rohkandidat",
        path,
    )?;
    write_json(
        &mut writer,
        &spec.policy.region_boundary_id,
        "Regionsgrenze",
        path,
    )?;
    write_bytes(
        &mut writer,
        b"],\"routeVersions\":",
        "Operational-v2-Rohkandidat",
        path,
    )?;
    write_route_versions(&transaction, &mut writer, path, &spec.policy, timetable)?;
    write_bytes(
        &mut writer,
        b",\"rzueLayoutId\":",
        "Operational-v2-Rohkandidat",
        path,
    )?;
    write_json(
        &mut writer,
        &spec.policy.rzue_layout_id,
        "RZUE-Layout",
        path,
    )?;
    write_bytes(
        &mut writer,
        b",\"signals\":",
        "Operational-v2-Rohkandidat",
        path,
    )?;
    write_set_table(&transaction, &mut writer, SIGNALS, path)?;
    write_bytes(
        &mut writer,
        b",\"switches\":",
        "Operational-v2-Rohkandidat",
        path,
    )?;
    write_set_table(&transaction, &mut writer, SWITCHES, path)?;
    write_bytes(&mut writer, b"}\n", "Operational-v2-Rohkandidat", path)?;
    writer
        .flush()
        .map_err(|error| io_error("Operational-v2-Rohkandidat", path, error))
}

fn table_len(
    transaction: &redb::ReadTransaction,
    definition: TableDefinition<&str, ()>,
) -> Result<u64> {
    transaction
        .open_table(definition)
        .map_err(db_error)?
        .len()
        .map_err(db_error)
}

fn string_table_len(
    transaction: &redb::ReadTransaction,
    definition: TableDefinition<&str, &str>,
) -> Result<u64> {
    transaction
        .open_table(definition)
        .map_err(db_error)?
        .len()
        .map_err(db_error)
}

fn write_report(path: &Path, report: &Value) -> Result<(u64, String)> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| io_error("Deutschland-Operational-Bericht", path, error))?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer(&mut writer, report).map_err(|error| {
        GermanyOperationalV2Error::new(format!(
            "Deutschland-Operational-Bericht `{}` kann nicht serialisiert werden: {error}",
            path.display()
        ))
    })?;
    writer
        .write_all(b"\n")
        .and_then(|()| writer.flush())
        .map_err(|error| io_error("Deutschland-Operational-Bericht", path, error))?;
    drop(writer);
    let bytes =
        fs::read(path).map_err(|error| io_error("Deutschland-Operational-Bericht", path, error))?;
    Ok((
        u64::try_from(bytes.len())
            .map_err(|_| GermanyOperationalV2Error::new("Berichtsgroesse laeuft ueber."))?,
        sha256(&bytes),
    ))
}

fn stabling_template_provenance_counts(
    templates: &[Value],
) -> Result<(BerthAssignmentCounts, u64, u64, u64)> {
    let mut counts = BerthAssignmentCounts::default();
    let mut observed_template_count = 0_u64;
    let mut simulated_operational_template_count = 0_u64;
    let mut cross_berth_template_count = 0_u64;
    for (index, template) in templates.iter().enumerate() {
        let arrival: TurnaroundBerthAssignment = serde_json::from_value(
            template
                .get("arrivalBerthAssignment")
                .cloned()
                .ok_or_else(|| {
                    GermanyOperationalV2Error::new(format!(
                        "Stabling-Template {index} besitzt keine Ankunfts-Berth-Provenienz."
                    ))
                })?,
        )
        .map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "Stabling-Template {index} besitzt ungueltige Ankunfts-Berth-Provenienz: {error}"
            ))
        })?;
        let departure: TurnaroundBerthAssignment = serde_json::from_value(
            template
                .get("departureBerthAssignment")
                .cloned()
                .ok_or_else(|| {
                    GermanyOperationalV2Error::new(format!(
                        "Stabling-Template {index} besitzt keine Abfahrts-Berth-Provenienz."
                    ))
                })?,
        )
        .map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "Stabling-Template {index} besitzt ungueltige Abfahrts-Berth-Provenienz: {error}"
            ))
        })?;
        for assignment in [arrival, departure] {
            require(
                matches!(
                    (assignment.kind, assignment.subtype),
                    (
                        BerthAssignmentKind::Observed,
                        BerthAssignmentSubtype::ServiceSiding
                    ) | (
                        BerthAssignmentKind::SimulatedOperational,
                        BerthAssignmentSubtype::ServiceYard
                            | BerthAssignmentSubtype::ServiceSpur
                            | BerthAssignmentSubtype::UnclassifiedRail
                    )
                ) && assignment.geometry_provenance == BerthGeometryProvenance::RealOsmRail
                    && matches!(
                        (
                            assignment.kind,
                            assignment.operational_assignment_provenance
                        ),
                        (
                            BerthAssignmentKind::Observed,
                            BerthOperationalAssignmentProvenance::ObservedOsmService
                        ) | (
                            BerthAssignmentKind::SimulatedOperational,
                            BerthOperationalAssignmentProvenance::SyntheticOperationalBPolicy
                        )
                    ),
                format!("Stabling-Template {index} widerspricht seiner Berth-Provenienz."),
            )?;
        }
        counts.increment(arrival);
        let stabling_kind: StablingKind =
            serde_json::from_value(template.get("stablingKind").cloned().ok_or_else(|| {
                GermanyOperationalV2Error::new(format!(
                    "Stabling-Template {index} besitzt keine Stabling-Art."
                ))
            })?)
            .map_err(|error| {
                GermanyOperationalV2Error::new(format!(
                    "Stabling-Template {index} besitzt eine ungueltige Stabling-Art: {error}"
                ))
            })?;
        if stabling_kind == StablingKind::CrossBerthTransfer {
            counts.increment(departure);
            cross_berth_template_count = cross_berth_template_count.saturating_add(1);
        } else {
            require(
                arrival == departure,
                format!(
                    "Shared-Berth-Template {index} besitzt verschiedene Ankunfts-/Abfahrtsprovenienz."
                ),
            )?;
        }
        if arrival.kind == BerthAssignmentKind::Observed
            && departure.kind == BerthAssignmentKind::Observed
        {
            observed_template_count = observed_template_count.saturating_add(1);
        } else {
            simulated_operational_template_count =
                simulated_operational_template_count.saturating_add(1);
        }
    }
    Ok((
        counts,
        observed_template_count,
        simulated_operational_template_count,
        cross_berth_template_count,
    ))
}

struct CountingHashWriter<W> {
    inner: W,
    hasher: Sha256,
    bytes: u64,
}

impl<W> CountingHashWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
        }
    }
}

impl<W: Write> CountingHashWriter<W> {
    fn finish(mut self) -> io::Result<(u64, String)> {
        self.flush()?;
        Ok((self.bytes, digest_hex(self.hasher.finalize())))
    }
}

impl<W: Write> Write for CountingHashWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.hasher.update(&buffer[..written]);
        self.bytes = self
            .bytes
            .checked_add(u64::try_from(written).unwrap_or(u64::MAX))
            .ok_or_else(|| io::Error::other("Sidecargroesse laeuft ueber."))?;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn write_sidecar_bytes<W: Write>(writer: &mut W, bytes: &[u8], path: &Path) -> Result<()> {
    writer
        .write_all(bytes)
        .map_err(|error| io_error("Movement-Route-Sidecar", path, error))
}

fn write_canonical_sidecar_value<W: Write>(
    writer: &mut W,
    value: &Value,
    path: &Path,
) -> Result<()> {
    let mut canonical = String::new();
    canonical_json(value, &mut canonical);
    write_sidecar_bytes(writer, canonical.as_bytes(), path)
}

fn write_canonical_sidecar_string<W: Write>(
    writer: &mut W,
    value: &str,
    path: &Path,
) -> Result<()> {
    let serialized = serde_json::to_string(value).map_err(|error| {
        GermanyOperationalV2Error::new(format!(
            "Movement-Route-Sidecar-Zeichenkette kann nicht serialisiert werden: {error}"
        ))
    })?;
    write_sidecar_bytes(writer, serialized.as_bytes(), path)
}

fn write_string_table_array<W: Write>(
    transaction: &redb::ReadTransaction,
    definition: TableDefinition<&str, &str>,
    context: &str,
    writer: &mut W,
    path: &Path,
) -> Result<()> {
    let table = transaction.open_table(definition).map_err(db_error)?;
    write_sidecar_bytes(writer, b"[", path)?;
    let mut first = true;
    for entry in table.iter().map_err(db_error)? {
        let (_, serialized) = entry.map_err(db_error)?;
        let value: Value = serde_json::from_str(serialized.value()).map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "{context} im Ableitungsindex ist ungueltig: {error}"
            ))
        })?;
        if !first {
            write_sidecar_bytes(writer, b",", path)?;
        }
        first = false;
        write_canonical_sidecar_value(writer, &value, path)?;
    }
    write_sidecar_bytes(writer, b"]", path)
}

fn stabling_template_provenance_counts_from_table(
    transaction: &redb::ReadTransaction,
) -> Result<(BerthAssignmentCounts, u64, u64, u64)> {
    let table = transaction
        .open_table(TURNAROUND_TEMPLATES)
        .map_err(db_error)?;
    let mut counts = BerthAssignmentCounts::default();
    let mut observed = 0_u64;
    let mut simulated = 0_u64;
    let mut cross_berth = 0_u64;
    for (index, entry) in table.iter().map_err(db_error)?.enumerate() {
        let (_, serialized) = entry.map_err(db_error)?;
        let value: Value = serde_json::from_str(serialized.value()).map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "Stabling-Template {index} im Ableitungsindex ist ungueltig: {error}"
            ))
        })?;
        let (item, item_observed, item_simulated, item_cross_berth) =
            stabling_template_provenance_counts(std::slice::from_ref(&value)).map_err(|error| {
                GermanyOperationalV2Error::new(format!("Stabling-Template {index}: {error}"))
            })?;
        counts.observed_osm_service_siding = counts
            .observed_osm_service_siding
            .saturating_add(item.observed_osm_service_siding);
        counts.simulated_operational_osm_service_yard = counts
            .simulated_operational_osm_service_yard
            .saturating_add(item.simulated_operational_osm_service_yard);
        counts.simulated_operational_osm_service_spur = counts
            .simulated_operational_osm_service_spur
            .saturating_add(item.simulated_operational_osm_service_spur);
        counts.simulated_operational_osm_unclassified_rail = counts
            .simulated_operational_osm_unclassified_rail
            .saturating_add(item.simulated_operational_osm_unclassified_rail);
        observed = observed.saturating_add(item_observed);
        simulated = simulated.saturating_add(item_simulated);
        cross_berth = cross_berth.saturating_add(item_cross_berth);
    }
    Ok((counts, observed, simulated, cross_berth))
}

fn direct_turnaround_pair_count(transaction: &redb::ReadTransaction) -> Result<u64> {
    let table = transaction.open_table(DIRECT_TEMPLATES).map_err(db_error)?;
    let mut pairs = BTreeSet::new();
    for entry in table.iter().map_err(db_error)? {
        let (_, serialized) = entry.map_err(db_error)?;
        let value: Value = serde_json::from_str(serialized.value()).map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "Direct-Template im Ableitungsindex ist ungueltig: {error}"
            ))
        })?;
        let inbound = value["inboundRouteVersionId"].as_str().ok_or_else(|| {
            GermanyOperationalV2Error::new("Direct-Template besitzt keine inboundRouteVersionId.")
        })?;
        let outbound = value["outboundRouteVersionId"].as_str().ok_or_else(|| {
            GermanyOperationalV2Error::new("Direct-Template besitzt keine outboundRouteVersionId.")
        })?;
        pairs.insert((inbound.to_owned(), outbound.to_owned()));
    }
    u64::try_from(pairs.len())
        .map_err(|_| GermanyOperationalV2Error::new("Direct-Paarmenge laeuft ueber."))
}

#[allow(clippy::too_many_arguments)]
fn write_movement_route_sidecar_body<W: Write>(
    transaction: &redb::ReadTransaction,
    writer: &mut W,
    path: &Path,
    infra_release_id: &str,
    operational_state_hash: &str,
    transfer_set_sha256: &Value,
    metrics: &Value,
    state_hash: Option<&str>,
) -> Result<()> {
    write_sidecar_bytes(writer, b"{\"directTemplates\":", path)?;
    write_string_table_array(
        transaction,
        DIRECT_TEMPLATES,
        "Direct-Template",
        writer,
        path,
    )?;
    write_sidecar_bytes(writer, b",\"infraReleaseId\":", path)?;
    write_canonical_sidecar_string(writer, infra_release_id, path)?;
    write_sidecar_bytes(writer, b",\"metrics\":", path)?;
    write_canonical_sidecar_value(writer, metrics, path)?;
    write_sidecar_bytes(writer, b",\"operationalStateHash\":", path)?;
    write_canonical_sidecar_string(writer, operational_state_hash, path)?;
    write_sidecar_bytes(writer, b",\"schema\":", path)?;
    write_canonical_sidecar_string(writer, MOVEMENT_ROUTE_SIDECAR_SCHEMA, path)?;
    if let Some(state_hash) = state_hash {
        write_sidecar_bytes(writer, b",\"stateHash\":", path)?;
        write_canonical_sidecar_string(writer, state_hash, path)?;
    }
    write_sidecar_bytes(writer, b",\"templates\":", path)?;
    write_string_table_array(
        transaction,
        TURNAROUND_TEMPLATES,
        "Stabling-Template",
        writer,
        path,
    )?;
    write_sidecar_bytes(writer, b",\"timetableTransferSetSha256\":", path)?;
    write_canonical_sidecar_value(writer, transfer_set_sha256, path)?;
    write_sidecar_bytes(writer, b",\"transferTemplates\":", path)?;
    write_string_table_array(
        transaction,
        TRANSFER_TEMPLATES,
        "Transfer-Template",
        writer,
        path,
    )?;
    write_sidecar_bytes(writer, b"}", path)
}

fn write_movement_route_sidecar(
    transaction: &redb::ReadTransaction,
    path: &Path,
    infra_release_id: &str,
    operational_state_hash: &str,
    transfer_evidence: Option<&TransferEvidence>,
) -> Result<(u64, String, String, BerthAssignmentCounts, u64, u64, u64)> {
    let (
        berth_assignment_counts,
        observed_stabling_template_count,
        simulated_operational_stabling_template_count,
        cross_berth_template_count,
    ) = stabling_template_provenance_counts_from_table(transaction)?;
    let direct_template_count = string_table_len(transaction, DIRECT_TEMPLATES)?;
    let stabling_template_count = string_table_len(transaction, TURNAROUND_TEMPLATES)?;
    let transfer_template_count = string_table_len(transaction, TRANSFER_TEMPLATES)?;
    let direct_pair_count = direct_turnaround_pair_count(transaction)?;
    let transfer_set_sha256 = transfer_evidence
        .map(|evidence| Value::String(evidence.transfer_set_sha256.clone()))
        .unwrap_or(Value::Null);
    let metrics = json!({
        "directTemplateCount": direct_template_count,
        "stablingTemplateCount": stabling_template_count,
        "transferTemplateCount": transfer_template_count,
        "transferDemandCount": transfer_evidence.map_or(0, |evidence| evidence.transfer_demand_count),
        "turnaroundDemandCount": transfer_evidence.map_or(0, |evidence| evidence.turnaround_demand_count),
        "plannedTransitionCount": transfer_evidence.map_or(0, |evidence| evidence.planned_transition_count),
        "turnaroundPairCount": direct_pair_count,
        "observedStablingTemplateCount": observed_stabling_template_count,
        "simulatedOperationalStablingTemplateCount": simulated_operational_stabling_template_count,
        "berthAssignmentCounts": berth_assignment_counts.clone(),
        "crossBerthTemplateCount": cross_berth_template_count,
    });

    let mut state_writer = CountingHashWriter::new(io::sink());
    write_sidecar_bytes(&mut state_writer, b"{\"schema\":", path)?;
    write_canonical_sidecar_string(&mut state_writer, MOVEMENT_ROUTE_SIDECAR_SCHEMA, path)?;
    write_sidecar_bytes(&mut state_writer, b",\"value\":", path)?;
    write_movement_route_sidecar_body(
        transaction,
        &mut state_writer,
        path,
        infra_release_id,
        operational_state_hash,
        &transfer_set_sha256,
        &metrics,
        None,
    )?;
    write_sidecar_bytes(&mut state_writer, b"}", path)?;
    let (_, state_hash) = state_writer
        .finish()
        .map_err(|error| io_error("Movement-Route-Sidecar-Zustand", path, error))?;

    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| io_error("Movement-Route-Sidecar", path, error))?;
    let mut writer = CountingHashWriter::new(BufWriter::new(file));
    write_movement_route_sidecar_body(
        transaction,
        &mut writer,
        path,
        infra_release_id,
        operational_state_hash,
        &transfer_set_sha256,
        &metrics,
        Some(&state_hash),
    )?;
    write_sidecar_bytes(&mut writer, b"\n", path)?;
    let (bytes, sidecar_sha256) = writer
        .finish()
        .map_err(|error| io_error("Movement-Route-Sidecar", path, error))?;
    Ok((
        bytes,
        sidecar_sha256,
        state_hash,
        berth_assignment_counts,
        observed_stabling_template_count,
        simulated_operational_stabling_template_count,
        cross_berth_template_count,
    ))
}

/// Prueft alle vom gepinnten DailyPlan verlangten ortsgleichen Fortsetzungen,
/// ohne den grossen Operational-v2-Kandidaten oder Fahrstrassen zu erzeugen.
/// Der Bericht enthaelt jeden Restbefund bis zur festen, fail-closed Grenze.
pub fn preflight_germany_turnarounds_v2(spec_path: &Path, source_root: &Path) -> Result<Value> {
    let source_metadata = fs::symlink_metadata(source_root)
        .map_err(|error| io_error("Turnaround-Preflight-Quellwurzel", source_root, error))?;
    require(
        source_metadata.file_type().is_dir() && !is_symlink_or_reparse_point(&source_metadata),
        "Turnaround-Preflight-Quellwurzel muss ein symlinkfreies Verzeichnis sein.",
    )?;
    require_symlink_free_existing_path(source_root, "Turnaround-Preflight-Quellwurzel")?;
    let (spec, spec_evidence) = read_spec(spec_path)?;
    validate_spec(&spec)?;
    let timetable_relative = spec.layers.timetable_routes.as_deref().ok_or_else(|| {
        GermanyOperationalV2Error::new(
            "Turnaround-Preflight verlangt einen gepinnten timetableRoutes-Layer.",
        )
    })?;
    let transfer_spec = spec.layers.transfer_demands.as_ref().ok_or_else(|| {
        GermanyOperationalV2Error::new(
            "Turnaround-Preflight verlangt gepinnte transferDemands mit DailyPlan.",
        )
    })?;
    let track_path = layer_path(source_root, &spec.layers.tracks, "tracks")?;
    let timetable_path = layer_path(source_root, timetable_relative, "timetableRoutes")?;
    let transfer_path = layer_path(source_root, &transfer_spec.path, "transferDemands")?;
    let (transfer_inputs, turnaround_pairs, transfer_evidence) = read_transfer_demands(
        &transfer_path,
        &transfer_spec.path,
        transfer_spec,
        &spec.infra_release_id,
        &spec.policy,
    )?;
    let temporary_root = std::env::temp_dir();
    require_symlink_free_existing_path(&temporary_root, "Turnaround-Preflight-Temporaerwurzel")?;
    let scratch = ScratchDirectory::create(&temporary_root)?;
    let database_path = scratch.join("turnaround-preflight.redb");
    let mut builder = Database::builder();
    builder.set_cache_size(DATABASE_CACHE_BYTES);
    let database = builder.create(&database_path).map_err(db_error)?;
    initialize_database(&database)?;
    let mut counts = Counts::default();
    let tracks_evidence = ingest_preflight_tracks(
        &database,
        &track_path,
        &spec.layers.tracks,
        &spec.policy,
        &mut counts,
    )?;
    let timetable_evidence = ingest_preflight_timetable_routes(
        &database,
        &timetable_path,
        timetable_relative,
        &mut counts,
    )?;
    let transfer_formation_demand_count =
        validate_transfer_inputs_preflight(&database, &spec.policy, &transfer_inputs)?;
    let mut report = turnaround_preflight_report(
        &database,
        &spec.infra_release_id,
        &spec.policy,
        &turnaround_pairs,
        transfer_inputs.len(),
        transfer_formation_demand_count,
    )?;
    report["inputs"] = json!({
        "spec": spec_evidence,
        "tracks": tracks_evidence,
        "timetableRoutes": timetable_evidence,
        "transferDemands": transfer_evidence.file,
        "dailyPlanSha256": transfer_evidence.daily_plan_sha256,
        "transferSetSha256": transfer_evidence.transfer_set_sha256,
    });
    let mut state_body = report.clone();
    state_body
        .as_object_mut()
        .expect("Preflight-Bericht ist ein Objekt")
        .remove("stateHash");
    let envelope = json!({
        "schema": TURNAROUND_PREFLIGHT_SCHEMA,
        "value": state_body,
    });
    let mut canonical = String::new();
    canonical_json(&envelope, &mut canonical);
    report["stateHash"] = json!(sha256(canonical.as_bytes()));
    Ok(report)
}

/// Leitet aus sechs normalisierten Deutschland-Layern sowie optionalen,
/// bereits auf Kanten gematchten Zuglaeufen einen statischen Operational-v2-
/// Kandidaten ab. Kandidat und Bericht werden niemals ueberschrieben.
pub fn derive_germany_operational_v2(
    spec_path: &Path,
    source_root: &Path,
    candidate_path: &Path,
    report_path: &Path,
) -> Result<Value> {
    let candidate_path = canonical_output_path(candidate_path, "Zielverzeichnis des Kandidaten")?;
    let report_path = canonical_output_path(report_path, "Zielverzeichnis des Berichts")?;
    let sidecar_path = movement_route_sidecar_path(&candidate_path)?;
    require(
        [
            output_identity_key(&candidate_path),
            output_identity_key(&report_path),
            output_identity_key(&sidecar_path),
        ]
        .into_iter()
        .collect::<BTreeSet<_>>()
        .len()
            == 3,
        "Kandidat, Movement-Route-Sidecar und Bericht muessen verschiedene Ziele besitzen.",
    )?;
    let _output_claims = OutputClaims::acquire(&[&candidate_path, &sidecar_path, &report_path])?;
    ensure_output_absent(&candidate_path, "Operational-v2-Kandidat")?;
    ensure_output_absent(&sidecar_path, "Movement-Route-Sidecar")?;
    ensure_output_absent(&report_path, "Operational-v2-Bericht")?;
    let source_metadata = fs::symlink_metadata(source_root)
        .map_err(|error| io_error("Operational-v2-Quellwurzel", source_root, error))?;
    require(
        source_metadata.file_type().is_dir() && !is_symlink_or_reparse_point(&source_metadata),
        "Operational-v2-Quellwurzel muss ein symlinkfreies Verzeichnis sein.",
    )?;
    let candidate_parent = candidate_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let report_parent = report_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    require_symlink_free_existing_path(source_root, "Operational-v2-Quellwurzel")?;
    require_symlink_free_existing_path(candidate_parent, "Zielverzeichnis des Kandidaten")?;
    require_symlink_free_existing_path(report_parent, "Zielverzeichnis des Berichts")?;
    require(
        candidate_parent.is_dir(),
        "Zielverzeichnis des Kandidaten fehlt.",
    )?;
    require(
        report_parent.is_dir(),
        "Zielverzeichnis des Berichts fehlt.",
    )?;

    let (spec, spec_evidence) = read_spec(spec_path)?;
    validate_spec(&spec)?;
    let track_path = layer_path(source_root, &spec.layers.tracks, "tracks")?;
    let platform_path = layer_path(source_root, &spec.layers.platforms, "platforms")?;
    let switch_path = layer_path(source_root, &spec.layers.switches, "switches")?;
    let signal_path = layer_path(source_root, &spec.layers.signals, "signals")?;
    let block_path = layer_path(source_root, &spec.layers.blocks, "blocks")?;
    let conflict_path = layer_path(
        source_root,
        &spec.layers.conflict_resources,
        "conflictResources",
    )?;
    let timetable_path = spec
        .layers
        .timetable_routes
        .as_deref()
        .map(|relative| layer_path(source_root, relative, "timetableRoutes"))
        .transpose()?;
    let transfer_path = spec
        .layers
        .transfer_demands
        .as_ref()
        .map(|pinned| layer_path(source_root, &pinned.path, "transferDemands"))
        .transpose()?;
    let timetable = timetable_path.is_some();

    let scratch = ScratchDirectory::create(candidate_parent)?;
    let report_scratch = ScratchDirectory::create(report_parent)?;
    let database_path = scratch.join("derivation.redb");
    let mut builder = Database::builder();
    builder.set_cache_size(DATABASE_CACHE_BYTES);
    let database = builder.create(&database_path).map_err(db_error)?;
    initialize_database(&database)?;

    let mut counts = Counts::default();
    let tracks_evidence = ingest_tracks(
        &database,
        &track_path,
        &spec.layers.tracks,
        &spec.policy,
        !timetable,
        &mut counts,
    )?;
    let switches_evidence =
        ingest_switches(&database, &switch_path, &spec.layers.switches, &mut counts)?;
    let signals_evidence =
        ingest_signals(&database, &signal_path, &spec.layers.signals, &mut counts)?;
    let blocks_evidence = ingest_blocks(&database, &block_path, &spec.layers.blocks, &mut counts)?;
    let conflicts_evidence = ingest_conflict_resources(
        &database,
        &conflict_path,
        &spec.layers.conflict_resources,
        &mut counts,
    )?;
    let platforms_evidence = ingest_platforms(
        &database,
        &platform_path,
        &spec.layers.platforms,
        &spec.policy,
        &mut counts,
    )?;
    let timetable_evidence = if let (Some(path), Some(relative)) = (
        timetable_path.as_deref(),
        spec.layers.timetable_routes.as_deref(),
    ) {
        Some(ingest_timetable_routes(
            &database,
            path,
            relative,
            &mut counts,
        )?)
    } else {
        None
    };
    let (transfer_inputs, turnaround_pairs, transfer_evidence) = if let (Some(path), Some(pinned)) = (
        transfer_path.as_deref(),
        spec.layers.transfer_demands.as_ref(),
    ) {
        let (inputs, pairs, evidence) = read_transfer_demands(
            path,
            &pinned.path,
            pinned,
            &spec.infra_release_id,
            &spec.policy,
        )?;
        (inputs, pairs, Some(evidence))
    } else {
        (Vec::new(), Vec::new(), None)
    };
    let required_pairs = transfer_evidence
        .as_ref()
        .map(|_| turnaround_pairs.as_slice());
    if let Some(required_pairs) = required_pairs {
        let transfer_formation_demand_count =
            validate_transfer_inputs_preflight(&database, &spec.policy, &transfer_inputs)?;
        let preflight = turnaround_preflight_report(
            &database,
            &spec.infra_release_id,
            &spec.policy,
            required_pairs,
            transfer_inputs.len(),
            transfer_formation_demand_count,
        )?;
        if preflight["eligible"] != Value::Bool(true) {
            let first_findings = preflight["findings"]
                .as_array()
                .expect("Preflight-Findings sind ein Array")
                .iter()
                .take(16)
                .cloned()
                .collect::<Vec<_>>();
            return Err(GermanyOperationalV2Error::new(format!(
                "Turnaround-Preflight verweigert die teure Ableitung: {} von {} Anforderungen sind ohne physische Direct-/Stabling-Kontinuitaet; Finding-Set {}, erste Befunde {}. Vollstaendiger Bericht: `preflight-germany-turnarounds-v2 SPEC SOURCE_ROOT`.",
                preflight["metrics"]["uncoveredCount"],
                preflight["metrics"]["demandCount"],
                preflight["findingSetSha256"],
                serde_json::to_string(&first_findings).unwrap_or_else(|_| "[]".to_owned()),
            )));
        }
    }
    let mut covered_turnarounds = derive_direct_templates(&database, &spec.policy, required_pairs)?;
    covered_turnarounds.extend(derive_turnaround_templates(
        &database,
        &spec.policy,
        required_pairs,
    )?);
    if let Some(required_pairs) = required_pairs {
        for pair in required_pairs {
            for &formation_length_mm in &spec.policy.terminal_formation_lengths_mm {
                require(
                    covered_turnarounds.contains(&(
                        pair.inbound_route_version_id.clone(),
                        pair.outbound_route_version_id.clone(),
                        formation_length_mm,
                    )),
                    format!(
                        "Fahrplan-Turnaround `{}` -> `{}` fuer Formation {formation_length_mm} mm besitzt weder Direct- noch Stabling-Kontinuitaet.",
                        pair.inbound_route_version_id, pair.outbound_route_version_id
                    ),
                )?;
            }
        }
    }
    derive_transfer_templates(&database, &spec.policy, &transfer_inputs)?;

    let raw_candidate = scratch.join("candidate.raw.json");
    let staged_candidate = scratch.join("candidate.validated.json");
    write_raw_candidate(&database, &raw_candidate, &spec, timetable)?;
    let validation = validate_operational_infrastructure_v2_file(
        &raw_candidate,
        &spec.infra_release_id,
        Some(&staged_candidate),
    )
    .map_err(|error| {
        GermanyOperationalV2Error::new(format!(
            "Abgeleiteter Operational-v2-Kandidat verletzt den nativen Vertrag: {error}"
        ))
    })?;

    let read = database.begin_read().map_err(db_error)?;
    let total_signals = table_len(&read, SIGNALS)?;
    let total_switches = table_len(&read, SWITCHES)?;
    let total_resources = table_len(&read, BLOCK_RESOURCES)?;
    let turnaround_route_versions = string_table_len(&read, TURNAROUND_ROUTES)?;
    let turnaround_interlocking_routes = string_table_len(&read, TURNAROUND_INTERLOCKING)?;
    let turnaround_templates = string_table_len(&read, TURNAROUND_TEMPLATES)?;
    let direct_templates = string_table_len(&read, DIRECT_TEMPLATES)?;
    let transfer_route_versions = string_table_len(&read, TRANSFER_ROUTES)?;
    let transfer_interlocking_routes = string_table_len(&read, TRANSFER_INTERLOCKING)?;
    let transfer_templates = string_table_len(&read, TRANSFER_TEMPLATES)?;
    let route_versions = if timetable {
        counts
            .timetable_routes
            .saturating_add(turnaround_route_versions)
            .saturating_add(transfer_route_versions)
    } else {
        counts.orderable_tracks.saturating_mul(2)
    };
    let interlocking_routes = if timetable {
        counts
            .timetable_legs
            .saturating_add(turnaround_interlocking_routes)
            .saturating_add(transfer_interlocking_routes)
    } else {
        counts.orderable_tracks.saturating_mul(2)
    };
    let synthetic_boundary_signals = if timetable {
        counts.timetable_legs
    } else {
        interlocking_routes
    };
    let staged_sidecar =
        scratch.join("operational-infrastructure-v2.movement-route-templates-v2.json");
    let operational_state_hash = validation["stateHash"].as_str().ok_or_else(|| {
        GermanyOperationalV2Error::new("Native Validierung lieferte keinen Zustandshash.")
    })?;
    let (
        sidecar_bytes,
        sidecar_sha256,
        sidecar_state_hash,
        berth_assignment_counts,
        observed_stabling_template_count,
        simulated_operational_stabling_template_count,
        cross_berth_template_count,
    ) = write_movement_route_sidecar(
        &read,
        &staged_sidecar,
        &spec.infra_release_id,
        operational_state_hash,
        transfer_evidence.as_ref(),
    )?;
    drop(read);
    let sidecar_file = sidecar_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| GermanyOperationalV2Error::new("Sidecar besitzt keinen UTF-8-Dateinamen."))?
        .to_owned();

    let policy_value = serde_json::to_value(&spec.policy).map_err(|error| {
        GermanyOperationalV2Error::new(format!("Policy kann nicht kanonisiert werden: {error}"))
    })?;
    let mut policy_canonical = String::new();
    canonical_json(&policy_value, &mut policy_canonical);
    let mut inputs = serde_json::Map::new();
    for (name, evidence) in [
        ("spec", Some(&spec_evidence)),
        ("tracks", Some(&tracks_evidence)),
        ("platforms", Some(&platforms_evidence)),
        ("switches", Some(&switches_evidence)),
        ("signals", Some(&signals_evidence)),
        ("blocks", Some(&blocks_evidence)),
        ("conflictResources", Some(&conflicts_evidence)),
        ("timetableRoutes", timetable_evidence.as_ref()),
        (
            "transferDemands",
            transfer_evidence.as_ref().map(|evidence| &evidence.file),
        ),
    ] {
        inputs.insert(
            name.to_owned(),
            evidence.map_or(Value::Null, |evidence| {
                serde_json::to_value(evidence).unwrap_or(Value::Null)
            }),
        );
    }
    let unresolved_dimensions = if timetable {
        Vec::<String>::new()
    } else {
        vec!["complete-timetable-route-versions".to_owned()]
    };
    let unresolved_required = u64::try_from(unresolved_dimensions.len()).unwrap_or(u64::MAX);
    let route_coverage = if timetable {
        "complete-pinned-timetable-routes"
    } else {
        "local-directed-track-templates"
    };
    let timetable_transfer_set_sha256 = transfer_evidence
        .as_ref()
        .map(|evidence| Value::String(evidence.transfer_set_sha256.clone()))
        .unwrap_or(Value::Null);
    let movement_route_evidence = json!({
        "file": sidecar_file.clone(),
        "bytes": sidecar_bytes,
        "sha256": sidecar_sha256.clone(),
        "stateHash": sidecar_state_hash.clone(),
        "operationalStateHash": validation["stateHash"],
        "timetableTransferSetSha256": timetable_transfer_set_sha256,
        "berthAssignmentCounts": berth_assignment_counts,
        "crossBerthTemplateCount": cross_berth_template_count,
    });
    let timetable_route_evidence = transfer_evidence.as_ref().map(|evidence| {
        json!({
            "timetableRoutes": timetable_evidence,
            "transferDemands": evidence.file,
            "dailyPlanSha256": evidence.daily_plan_sha256,
            "transferSetSha256": evidence.transfer_set_sha256,
            "circulationCount": evidence.circulation_count,
            "plannedTransitionCount": evidence.planned_transition_count,
            "transferDemandCount": evidence.transfer_demand_count,
            "transferLotCount": evidence.transfer_lot_count,
            "turnaroundDemandCount": evidence.turnaround_demand_count,
            "turnaroundPairCount": evidence.turnaround_pair_count,
            "movementRouteTemplates": movement_route_evidence,
        })
    });
    let report = json!({
        "schema": REPORT_SCHEMA,
        "mode": spec.mode,
        "infraReleaseId": spec.infra_release_id,
        "policy": {
            "id": spec.policy.id,
            "sha256": sha256(policy_canonical.as_bytes()),
            "spec": spec.policy,
        },
        "inputs": inputs,
        "candidate": {
            "bytes": validation["bytes"],
            "sha256": validation["sha256"],
            "stateHash": validation["stateHash"],
            "validationMode": validation["validationMode"],
            "movementRouteTemplates": movement_route_evidence,
        },
        "timetableRouteEvidence": timetable_route_evidence,
        "counts": {
            "source": {
                "tracks": counts.tracks_seen,
                "orderableTracks": counts.orderable_tracks,
                "platforms": counts.platforms_seen,
                "switches": counts.switches,
                "signals": counts.observed_signals,
                "blocks": counts.blocks,
                "conflictResources": counts.conflict_resources,
                "timetableRoutes": counts.timetable_routes,
                "timetableLegs": counts.timetable_legs,
                "transferDemands": transfer_evidence.as_ref().map_or(0, |evidence| evidence.transfer_demand_count),
                "transferLots": transfer_evidence.as_ref().map_or(0, |evidence| evidence.transfer_lot_count),
                "turnaroundDemands": transfer_evidence.as_ref().map_or(0, |evidence| evidence.turnaround_demand_count),
                "turnaroundPairs": transfer_evidence.as_ref().map_or(0, |evidence| evidence.turnaround_pair_count),
            },
            "candidate": {
                "directedEdges": counts.orderable_tracks,
                "edgeGeometries": counts.orderable_tracks,
                "routeVersions": route_versions,
                "interlockingRoutes": interlocking_routes,
                "signals": total_signals,
                "switches": total_switches,
                "blockResources": total_resources,
                "platformIntervals": counts.platform_intervals,
                "regionBoundaries": 1,
                "directTemplates": direct_templates,
                "stablingTemplates": turnaround_templates,
                "transferTemplates": transfer_templates,
            },
            "provenance": {
                "observedForwardSpeeds": counts.observed_forward_speeds,
                "observedBackwardSpeeds": counts.observed_backward_speeds,
                "simulatedSpeeds": counts.simulated_speeds,
                "observedProtectionAssignments": counts.observed_protection,
                "simulatedProtectionAssignments": counts.simulated_protection,
                "matchedPlatformIntervals": counts.platform_intervals,
                "excludedPlatformEvidence": counts.excluded_platform_evidence,
                "syntheticBoundarySignals": synthetic_boundary_signals,
                "turnaroundRouteVersions": turnaround_route_versions,
                "turnaroundInterlockingRoutes": turnaround_interlocking_routes,
                "transferRouteVersions": transfer_route_versions,
                "transferInterlockingRoutes": transfer_interlocking_routes,
                "observedStablingTemplates": observed_stabling_template_count,
                "simulatedOperationalStablingTemplates": simulated_operational_stabling_template_count,
                "berthAssignmentCounts": berth_assignment_counts,
                "crossBerthTemplates": cross_berth_template_count,
            },
        },
        "scope": {
            "routeModel": route_coverage,
            "interlockingModel": "deterministic-linear-segment-node-stellzone-mutex-and-progressive-authority/v3",
            "platformModel": "deterministic-nearest-observed-track-within-policy-radius/v1",
            "capacityBias": "conservative-under-capacity",
            "minimumOverlapMmPolicy": spec.policy.minimum_overlap_mm,
            "turnaroundModel": "real-osm-bounded-bidirectional-access-with-observed-siding-or-explicit-synthetic-operational-berth/v3",
            "minimumBerthEndClearanceMmPolicy": spec.policy.minimum_berth_end_clearance_mm,
            "maximumStablingPathEdgesPolicy": spec.policy.maximum_stabling_path_edges,
            "maximumStablingPathLengthMmPolicy": spec.policy.maximum_stabling_path_length_mm,
            "simulatedOperationalBerthFallbackPolicy": spec.policy.simulated_operational_berth_fallback,
            "maximumDirectDwellMsPolicy": spec.policy.maximum_direct_dwell_ms,
            "terminalFormationLengthsMm": spec.policy.terminal_formation_lengths_mm,
            "movementRouteTemplateModel": "daily-plan-scoped-direct-stabling-transfer-continuity/v2",
        },
        "routeCoverage": route_coverage,
        "activationEligible": timetable,
        "unresolvedRequired": unresolved_required,
        "unresolvedRequiredDimensions": unresolved_dimensions,
        "realInterlockingFactsClaimed": false,
        "realGeometry": true,
        "simulatedOperationalAssignment": true,
        "candidateProduced": true,
    });

    let staged_report = report_scratch.join("derivation.report.json");
    let (report_bytes, report_sha256) = write_report(&staged_report, &report)?;
    publish_triplet_create_new(
        &staged_candidate,
        &candidate_path,
        &staged_sidecar,
        &sidecar_path,
        &staged_report,
        &report_path,
    )?;
    Ok(json!({
        "schema": RECEIPT_SCHEMA,
        "infraReleaseId": spec.infra_release_id,
        "candidate": {
            "bytes": validation["bytes"],
            "sha256": validation["sha256"],
            "stateHash": validation["stateHash"],
        },
        "movementRouteTemplates": movement_route_evidence,
        "report": {
            "bytes": report_bytes,
            "sha256": report_sha256,
        },
        "candidateProduced": true,
        "activationEligible": timetable,
        "unresolvedRequired": unresolved_required,
    }))
}

#[cfg(test)]
mod publish_tests {
    use super::{
        BLOCK_RESOURCES, BerthAssignmentKind, BerthAssignmentSubtype, BerthSearchMode,
        DirectedTrackCache, GeneratedBatch, GeneratedBatchTables, GeneratedMovementArtifacts,
        GeometryPoint, MAX_GENERATED_RECORD_BYTES, MAX_STABLING_SEARCH_RESIDENT_BYTES,
        MovementContinuity, PinnedInputSpec, PolicySpec, ScratchDirectory, StablingKind,
        StablingSearchPolicy, StablingSearchStats, TRACK_BLOCKS, TRACKS, TRACKS_BY_NODE,
        TURNAROUND_INTERLOCKING, TURNAROUND_ROUTES, TURNAROUND_TEMPLATES, TerminalNodeAccess,
        TimetableLegInput, TimetableRouteInput, TrackRecord, TurnaroundPairDemand,
        TurnaroundRouteDispatch, berth_assignment, build_stabling_routes, canonical_json,
        ensure_output_absent, flush_generated_batch, generate_movement_route_artifacts,
        initialize_database, insert_generated, paired_stabling_candidates,
        paired_stabling_candidates_with_fallback, publish_create_new, publish_pair_create_new,
        read_transfer_demands, require_generated_unit_bound, require_movement_continuity,
        require_stabling_search_budget_with_limit, sha256, stabling_candidates,
        stabling_minimum_runtime_ms, stabling_template_provenance_counts,
    };
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;

    use redb::{Database, ReadableTable};
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    fn continuity_route(
        route_version_id: &str,
        predecessor_id: Option<&str>,
        transition_route_mm: Option<i64>,
        direction: &str,
        edge_entry_mm: i64,
        edge_exit_mm: i64,
    ) -> TimetableRouteInput {
        TimetableRouteInput {
            route_version_id: route_version_id.to_owned(),
            template_id: format!("template:{route_version_id}"),
            predecessor_id: predecessor_id.map(str::to_owned),
            transition_route_mm,
            legs: vec![
                TimetableLegInput {
                    edge_id: "edge:continuity".to_owned(),
                    direction: direction.to_owned(),
                    edge_entry_mm,
                    edge_exit_mm,
                    available_protection_systems: vec!["pzb".to_owned()],
                    simultaneously_required_protection_systems: Vec::new(),
                },
                TimetableLegInput {
                    edge_id: "edge:movement".to_owned(),
                    direction: "along".to_owned(),
                    edge_entry_mm: 0,
                    edge_exit_mm: 50,
                    available_protection_systems: vec!["pzb".to_owned()],
                    simultaneously_required_protection_systems: Vec::new(),
                },
            ],
        }
    }

    fn transfer_partition_policy() -> PolicySpec {
        serde_json::from_value(json!({
            "id": "policy:test",
            "qualityClass": "B",
            "sourceId": "osm-pbf-deutschland",
            "derivationRule": "test",
            "unknownMainlineSpeedKmh": 80,
            "unknownServiceSpeedKmh": 40,
            "unknownGradientAbsPermille": 12,
            "minimumPlatformLengthMm": 80_000,
            "maximumPlatformSnapDistanceMm": 100_000,
            "minimumOverlapMm": 200_000,
            "minimumBerthEndClearanceMm": 10_000,
            "maximumStablingPathEdges": 64,
            "maximumStablingPathLengthMm": 10_000_000,
            "simulatedOperationalBerthFallback": "real-osm-rail-compatible-non-crossover/v1",
            "maximumDirectDwellMs": 1_200_000,
            "terminalFormationLengthsMm": [46_560, 69_860],
            "defaultProtectionSystem": "pzb",
            "regionBoundaryId": "region:test",
            "rzueLayoutId": "rzue:test"
        }))
        .expect("Testpolicy")
    }

    fn rehash_transfer_partition(contract: &mut Value) {
        let plan = &mut contract["dailyPlan"];
        for key in ["turnaroundDemands", "transferDemands"] {
            plan[key]
                .as_array_mut()
                .expect("Demandliste")
                .sort_by(|left, right| {
                    left["id"]
                        .as_str()
                        .expect("Demand-ID")
                        .as_bytes()
                        .cmp(right["id"].as_str().expect("Demand-ID").as_bytes())
                });
        }
        plan.as_object_mut()
            .expect("DailyPlan")
            .remove("planSha256");
        let plan_schema = plan["schema"].as_str().expect("DailyPlan-Schema");
        let mut canonical_plan = String::new();
        canonical_json(
            &json!({"schema": plan_schema, "value": plan.clone()}),
            &mut canonical_plan,
        );
        plan["planSha256"] = json!(sha256(canonical_plan.as_bytes()));

        contract["transferRoutes"]
            .as_array_mut()
            .expect("Transferroute-Liste")
            .sort_by(|left, right| {
                left["id"]
                    .as_str()
                    .expect("Transferroute-ID")
                    .as_bytes()
                    .cmp(right["id"].as_str().expect("Transferroute-ID").as_bytes())
            });
        let mut transfer_hasher = Sha256::new();
        for route in contract["transferRoutes"]
            .as_array()
            .expect("Transferroute-Liste")
        {
            let mut canonical = String::new();
            canonical_json(route, &mut canonical);
            transfer_hasher.update(canonical.as_bytes());
            transfer_hasher.update(b"\n");
        }
        contract["transferSetSha256"] = json!(
            transfer_hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
    }

    fn valid_transfer_partition() -> Value {
        let turnaround = json!({
            "id": "turnaround:a-b",
            "lotId": "lot:test",
            "assetCompatibilityKey": "asset:test",
            "sourceCirculationId": "circulation:test",
            "targetCirculationId": "circulation:test",
            "sourcePassengerLegId": "leg-a",
            "targetPassengerLegId": "leg-b",
            "sourcePassengerRouteVersionId": "route:gtfs:leg-a:v1",
            "targetPassengerRouteVersionId": "route:gtfs:leg-b:v1",
            "sourceLocationId": "location:shared",
            "targetLocationId": "location:shared",
            "sourcePhysicalStopId": "stop:shared",
            "targetPhysicalStopId": "stop:shared",
            "earliestDepartureS": 1_000,
            "latestArrivalS": 1_300,
            "availableWindowS": 300,
            "dailyBoundary": false
        });
        let transfer = json!({
            "id": "transfer:b-a",
            "lotId": "lot:test",
            "assetCompatibilityKey": "asset:test",
            "sourceCirculationId": "circulation:test",
            "targetCirculationId": "circulation:test",
            "sourcePassengerLegId": "leg-b",
            "targetPassengerLegId": "leg-a",
            "sourcePassengerRouteVersionId": "route:gtfs:leg-b:v1",
            "targetPassengerRouteVersionId": "route:gtfs:leg-a:v1",
            "sourceLocationId": "location:end",
            "targetLocationId": "location:start",
            "sourcePhysicalStopId": "stop:end",
            "targetPhysicalStopId": "stop:start",
            "earliestDepartureS": 2_300,
            "latestArrivalS": 87_100,
            "availableWindowS": 84_800,
            "dailyBoundary": true,
            "movementKind": "train"
        });
        let mut transfer_route = transfer.clone();
        let route = transfer_route.as_object_mut().expect("Transferroute");
        route.insert("formationLengthsMm".to_owned(), json!([46_560, 69_860]));
        route.insert("routeVersionId".to_owned(), json!("route:transfer:b-a"));
        route.insert("templateId".to_owned(), json!("template:transfer:b-a"));
        route.insert(
            "legs".to_owned(),
            json!([{
                "edgeId": "track:real",
                "direction": "along",
                "edgeEntryMm": 0,
                "edgeExitMm": 100_000,
                "availableProtectionSystems": ["pzb"],
                "simultaneouslyRequiredProtectionSystems": []
            }]),
        );
        route.insert("totalLengthMm".to_owned(), json!(100_000));
        route.insert("weightedCostMm".to_owned(), json!(100_000));
        route.insert("minimumRuntimeMs".to_owned(), json!(10_000));
        let mut contract = json!({
            "schema": "zugfolge-timetable-transfer-demands/v2",
            "infraReleaseId": "infra:test",
            "gtfsSnapshotHash": "a".repeat(64),
            "dailyPlan": {
                "schema": "zugfolge-daily-circulation-plan/v2",
                "rule": "lot-local-playable-path-cover-with-explicit-physical-transition-partition/v2",
                "gtfsReleaseId": "gtfs:test",
                "repeatEveryS": 86_400,
                "minimumTurnaroundS": 300,
                "metrics": {
                    "lotCount": 1,
                    "journeyChainCount": 2,
                    "circulationCount": 1,
                    "rolloverAssignmentCount": 1,
                    "plannedTransitionCount": 2,
                    "turnaroundDemandCount": 1,
                    "transferDemandCount": 1,
                    "transferLotCount": 1
                },
                "circulations": [{
                    "id": "circulation:test",
                    "lotId": "lot:test",
                    "serviceLineId": "line:test",
                    "assetCompatibilityKey": "asset:test",
                    "journeyChainIds": ["journey:internal", "journey:rollover"],
                    "passengerLegIds": ["leg-a", "leg-b"],
                    "passengerTrainRunIds": ["run-a", "run-b"],
                    "start": {"legId": "leg-a", "locationId": "location:start", "physicalStopId": "stop:start", "timeS": 1_000},
                    "end": {"legId": "leg-b", "locationId": "location:end", "physicalStopId": "stop:end", "timeS": 2_000}
                }],
                "rolloverAssignments": [{
                    "kind": "transfer",
                    "sourceCirculationId": "circulation:test",
                    "targetCirculationId": "circulation:test"
                }],
                "turnaroundDemands": [turnaround],
                "transferDemands": [transfer]
            },
            "formationLengthsMm": [46_560, 69_860],
            "transferRoutes": [transfer_route],
            "transferSetSha256": ""
        });
        rehash_transfer_partition(&mut contract);
        contract
    }

    fn parse_transfer_partition(contract: &Value) -> super::Result<()> {
        let root = ScratchDirectory::create(&std::env::temp_dir()).expect("Testverzeichnis");
        let path = root.join("transfer-demands-v2.json");
        let bytes = serde_json::to_vec(contract).expect("Transfervertrag serialisieren");
        fs::write(&path, &bytes).expect("Transfervertrag schreiben");
        let pinned = PinnedInputSpec {
            path: "transfer-demands-v2.json".to_owned(),
            expected_bytes: u64::try_from(bytes.len()).expect("Testdateigroesse"),
            expected_sha256: sha256(&bytes),
        };
        read_transfer_demands(
            &path,
            "transfer-demands-v2.json",
            &pinned,
            "infra:test",
            &transfer_partition_policy(),
        )
        .map(|_| ())
    }

    #[test]
    fn daily_plan_v2_partition_ist_exakt_vollstaendig_disjunkt_und_overflowfest() {
        parse_transfer_partition(&valid_transfer_partition()).expect("gueltige V2-Partition");

        let mut cases = Vec::<(&str, Value, &str)>::new();

        let mut unknown_key = valid_transfer_partition();
        unknown_key["legacyFallback"] = json!(true);
        cases.push(("unknown-key", unknown_key, "nicht exakt die Pflichtfelder"));

        let mut duplicate_pair = valid_transfer_partition();
        let mut duplicate = duplicate_pair["dailyPlan"]["turnaroundDemands"][0].clone();
        duplicate["id"] = json!("turnaround:a-b:duplicate");
        duplicate_pair["dailyPlan"]["turnaroundDemands"]
            .as_array_mut()
            .expect("Turnaround-Liste")
            .push(duplicate);
        duplicate_pair["dailyPlan"]["metrics"]["turnaroundDemandCount"] = json!(2);
        rehash_transfer_partition(&mut duplicate_pair);
        cases.push(("duplicate-pair", duplicate_pair, "Turnaround-Demand"));

        let mut missing_pair = valid_transfer_partition();
        missing_pair["dailyPlan"]["turnaroundDemands"] = json!([]);
        missing_pair["dailyPlan"]["metrics"]["turnaroundDemandCount"] = json!(0);
        rehash_transfer_partition(&mut missing_pair);
        cases.push((
            "missing-pair",
            missing_pair,
            "keine disjunkte vollstaendige Partition",
        ));

        let mut wrong_planned_count = valid_transfer_partition();
        wrong_planned_count["dailyPlan"]["metrics"]["plannedTransitionCount"] = json!(3);
        rehash_transfer_partition(&mut wrong_planned_count);
        cases.push((
            "wrong-planned-transition-count",
            wrong_planned_count,
            "keine disjunkte vollstaendige Partition",
        ));

        let mut overlap = valid_transfer_partition();
        let mut overlap_demand = overlap["dailyPlan"]["turnaroundDemands"][0].clone();
        overlap_demand["id"] = json!("transfer:a-b");
        overlap_demand["targetLocationId"] = json!("location:other");
        overlap_demand["targetPhysicalStopId"] = json!("stop:other");
        overlap_demand["movementKind"] = json!("train");
        overlap["dailyPlan"]["transferDemands"]
            .as_array_mut()
            .expect("Transfer-Liste")
            .push(overlap_demand.clone());
        let mut overlap_route = overlap["transferRoutes"][0].clone();
        for (key, value) in overlap_demand.as_object().expect("Overlap-Demand") {
            overlap_route[key] = value.clone();
        }
        overlap_route["routeVersionId"] = json!("route:transfer:a-b");
        overlap_route["templateId"] = json!("template:transfer:a-b");
        overlap["transferRoutes"]
            .as_array_mut()
            .expect("Transferroute-Liste")
            .push(overlap_route);
        overlap["dailyPlan"]["metrics"]["transferDemandCount"] = json!(2);
        rehash_transfer_partition(&mut overlap);
        cases.push(("overlap", overlap, "Transfer-Demand"));

        let mut cross_location_turnaround = valid_transfer_partition();
        cross_location_turnaround["dailyPlan"]["turnaroundDemands"][0]["targetLocationId"] =
            json!("location:other");
        rehash_transfer_partition(&mut cross_location_turnaround);
        cases.push((
            "cross-location-turnaround",
            cross_location_turnaround,
            "Ort, physischem Halt",
        ));

        let mut same_location_transfer = valid_transfer_partition();
        let source_location =
            same_location_transfer["dailyPlan"]["transferDemands"][0]["sourceLocationId"].clone();
        let source_stop =
            same_location_transfer["dailyPlan"]["transferDemands"][0]["sourcePhysicalStopId"]
                .clone();
        {
            let target = &mut same_location_transfer["dailyPlan"]["transferDemands"][0];
            target["targetLocationId"] = source_location.clone();
            target["targetPhysicalStopId"] = source_stop.clone();
        }
        {
            let target = &mut same_location_transfer["transferRoutes"][0];
            target["targetLocationId"] = source_location.clone();
            target["targetPhysicalStopId"] = source_stop.clone();
        }
        rehash_transfer_partition(&mut same_location_transfer);
        cases.push((
            "same-location-transfer",
            same_location_transfer,
            "Ort, physischem Halt",
        ));

        let mut window_overflow = valid_transfer_partition();
        window_overflow["dailyPlan"]["turnaroundDemands"][0]["earliestDepartureS"] =
            json!(i64::MIN);
        window_overflow["dailyPlan"]["turnaroundDemands"][0]["latestArrivalS"] = json!(i64::MAX);
        window_overflow["dailyPlan"]["turnaroundDemands"][0]["availableWindowS"] = json!(i64::MAX);
        rehash_transfer_partition(&mut window_overflow);
        cases.push(("window-overflow", window_overflow, "Zeitfenster"));

        let mut v1 = valid_transfer_partition();
        v1["schema"] = json!("zugfolge-timetable-transfer-demands/v1");
        v1["dailyPlan"]["schema"] = json!("zugfolge-daily-circulation-plan/v1");
        rehash_transfer_partition(&mut v1);
        cases.push(("v1-rejection", v1, "Schema-/Release-/GTFS-Bindung"));

        let mut wrong_rule = valid_transfer_partition();
        wrong_rule["dailyPlan"]["rule"] = json!("legacy-partition/v1");
        rehash_transfer_partition(&mut wrong_rule);
        cases.push(("wrong-rule", wrong_rule, "Regel-/GTFS-/Tages"));

        let mut padded_gtfs = valid_transfer_partition();
        padded_gtfs["dailyPlan"]["gtfsReleaseId"] = json!(" gtfs:test ");
        rehash_transfer_partition(&mut padded_gtfs);
        cases.push(("padded-gtfs-id", padded_gtfs, "Regel-/GTFS-/Tages"));

        for minimum in [299, 301] {
            let mut wrong_minimum = valid_transfer_partition();
            wrong_minimum["dailyPlan"]["minimumTurnaroundS"] = json!(minimum);
            rehash_transfer_partition(&mut wrong_minimum);
            cases.push((
                if minimum < 300 {
                    "too-small-minimum-turnaround"
                } else {
                    "too-large-minimum-turnaround"
                },
                wrong_minimum,
                "Regel-/GTFS-/Tages",
            ));
        }

        for (name, contract, expected) in cases {
            let error = parse_transfer_partition(&contract)
                .expect_err("manipulierter Partitionsvertrag muss fail-closed scheitern");
            assert!(
                error.to_string().contains(expected),
                "{name}: erwartete `{expected}`, erhielt `{error}`"
            );
        }
    }

    fn stabling_test_track(
        id: &str,
        from_node_id: i64,
        to_node_id: i64,
        length_mm: i64,
        service: Option<&str>,
    ) -> TrackRecord {
        TrackRecord {
            id: id.to_owned(),
            from_node_id,
            to_node_id,
            length_mm,
            geometry: vec![
                GeometryPoint {
                    edge_offset_mm: 0,
                    latitude_e7: i32::try_from(from_node_id).unwrap_or(0),
                    longitude_e7: 0,
                    bearing_milli_degrees: None,
                },
                GeometryPoint {
                    edge_offset_mm: length_mm,
                    latitude_e7: i32::try_from(to_node_id).unwrap_or(0),
                    longitude_e7: 0,
                    bearing_milli_degrees: None,
                },
            ],
            speed_along_mmps: 10_000,
            speed_against_mmps: 10_000,
            protection_systems: BTreeSet::from(["pzb".to_owned()]),
            railway: "rail".to_owned(),
            service: service.map(str::to_owned),
            orderable: true,
            gauge_mm: 1_435,
            gauge_lineage: "observed-osm-gauge".to_owned(),
            electrified: Some("contact_line".to_owned()),
            voltage: Some("15000".to_owned()),
            frequency: Some("16.7".to_owned()),
            bidirectional: true,
            osm_way_id: from_node_id.saturating_mul(100).saturating_add(to_node_id),
            track_ref: None,
            quality_class: "B".to_owned(),
            source_id: "osm-pbf-deutschland".to_owned(),
            geometry_lineage: "observed-osm-linestring".to_owned(),
        }
    }

    #[test]
    fn abstellfront_dedupliziert_berth_vor_aggregation_und_bleibt_deterministisch_begrenzt() {
        let root = ScratchDirectory::create(&std::env::temp_dir()).expect("Testverzeichnis");
        let database =
            Database::create(root.join("stabling-dedup.redb")).expect("Abstell-Testdatenbank");
        initialize_database(&database).expect("Abstell-Tabellen");
        let terminal = stabling_test_track("terminal", 1, 2, 100_000, None);
        let tracks = vec![
            terminal.clone(),
            stabling_test_track("access:a", 2, 3, 10_000, None),
            stabling_test_track("access:b", 3, 5, 10_000, None),
            stabling_test_track("access:c", 2, 4, 10_000, None),
            stabling_test_track("access:d", 4, 6, 10_000, None),
            stabling_test_track("berth:shared", 5, 6, 100_000, Some("siding")),
        ];
        let write = database.begin_write().expect("Abstell-Schreibtransaktion");
        {
            let mut table = write.open_table(TRACKS).expect("Track-Tabelle");
            let mut by_node = write
                .open_multimap_table(TRACKS_BY_NODE)
                .expect("Knotenindex");
            for track in &tracks {
                let serialized = serde_json::to_string(track).expect("Track serialisieren");
                table
                    .insert(track.id.as_str(), serialized.as_str())
                    .expect("Track einfuegen");
                for node_id in [track.from_node_id, track.to_node_id] {
                    let node_id = node_id.to_string();
                    by_node
                        .insert(node_id.as_str(), track.id.as_str())
                        .expect("Track indexieren");
                }
            }
        }
        write.commit().expect("Abstell-Testdaten committen");

        let search = || {
            let read = database.begin_read().expect("Abstell-Testleser");
            stabling_candidates(
                &read,
                &terminal,
                2,
                StablingSearchPolicy {
                    formation_length_mm: 46_560,
                    minimum_clearance_mm: 10_000,
                    maximum_path_edges: 3,
                    maximum_path_length_mm: 1_000_000,
                    search_mode: BerthSearchMode::ObservedSiding,
                },
                "route:real-regression",
            )
            .expect("deduplizierte Abstellfront")
        };
        let first = search();
        let second = search();
        assert_eq!(first.stats, second.stats);
        assert_eq!(first.stats.raw_candidate_count, 2);
        assert_eq!(first.candidates.len(), 1);
        assert_eq!(first.stats.duplicate_candidate_count, 1);
        assert_eq!(first.stats.maximum_candidate_path_edges, 3);
        assert!(first.stats.peak_resident_bytes < MAX_STABLING_SEARCH_RESIDENT_BYTES);
        let path_ids = |result: &super::StablingSearchResult| {
            result.candidates[0]
                .path
                .iter()
                .map(|edge| edge.track.id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(path_ids(&first), path_ids(&second));
    }

    #[test]
    fn abstellfront_budget_gilt_gemeinsam_fuer_cache_labels_und_kandidaten() {
        let cache = DirectedTrackCache {
            resident_bytes: 40,
            ..DirectedTrackCache::default()
        };
        let mut stats = StablingSearchStats::default();
        require_stabling_search_budget_with_limit(
            "route:within-budget",
            &cache,
            30,
            30,
            &mut stats,
            0,
            100,
        )
        .expect("exakt gemeinsames Budget");
        let error = require_stabling_search_budget_with_limit(
            "route:over-budget",
            &cache,
            30,
            31,
            &mut stats,
            0,
            100,
        )
        .expect_err("eine gemeinsame Suchfront ueber dem Budget muss scheitern");
        assert!(
            error
                .to_string()
                .contains("gemeinsame Suchspeicherbudget von 100 Bytes")
        );
        assert!(error.to_string().contains("Peak=101 Bytes"));
    }

    fn asymmetric_stabling_search(
        shared_berth_length_mm: i64,
        target_shared_node: Option<i64>,
    ) -> super::PairedStablingSearch {
        asymmetric_stabling_search_with(
            46_560,
            shared_berth_length_mm,
            target_shared_node,
            Some("siding"),
            BerthSearchMode::ObservedSiding,
            3,
            1_000_000,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn asymmetric_stabling_search_with(
        formation_length_mm: i64,
        shared_berth_length_mm: i64,
        target_shared_node: Option<i64>,
        shared_service: Option<&str>,
        search_mode: BerthSearchMode,
        maximum_path_edges: u32,
        maximum_path_length_mm: i64,
    ) -> super::PairedStablingSearch {
        let root = ScratchDirectory::create(&std::env::temp_dir()).expect("Testverzeichnis");
        let database =
            Database::create(root.join("asymmetric-stabling.redb")).expect("Abstell-Testdatenbank");
        let source_terminal = stabling_test_track("terminal:source", 1, 2, 100_000, None);
        let target_terminal = stabling_test_track("terminal:target", 3, 4, 100_000, None);
        let mut tracks = vec![
            source_terminal.clone(),
            target_terminal.clone(),
            stabling_test_track("access:source", 2, 5, 10_000, None),
            stabling_test_track("berth:source-first", 5, 6, 100_000, Some("siding")),
            stabling_test_track("connector:source-to-shared", 5, 7, 10_000, None),
            stabling_test_track(
                "berth:shared-a",
                7,
                8,
                shared_berth_length_mm,
                shared_service,
            ),
            stabling_test_track(
                "berth:shared-z",
                7,
                11,
                shared_berth_length_mm,
                shared_service,
            ),
            stabling_test_track("access:target", 3, 9, 10_000, None),
        ];
        if let Some(shared_node) = target_shared_node {
            tracks.push(stabling_test_track(
                "connector:target-to-shared",
                9,
                shared_node,
                10_000,
                None,
            ));
        }
        let write = database.begin_write().expect("Abstell-Testtransaktion");
        {
            let mut table = write.open_table(TRACKS).expect("Track-Tabelle");
            for track in &tracks {
                let serialized = serde_json::to_string(track).expect("Track serialisieren");
                table
                    .insert(track.id.as_str(), serialized.as_str())
                    .expect("Track einfuegen");
            }
        }
        {
            let mut by_node = write
                .open_multimap_table(TRACKS_BY_NODE)
                .expect("Knotenindex");
            for track in &tracks {
                for node_id in [track.from_node_id, track.to_node_id] {
                    let node = node_id.to_string();
                    by_node
                        .insert(node.as_str(), track.id.as_str())
                        .expect("Track indexieren");
                }
            }
        }
        write.commit().expect("Abstell-Testdaten committen");
        let read = database.begin_read().expect("Abstell-Testleser");
        let source_access = TerminalNodeAccess {
            terminal_track: source_terminal,
            node_id: 2,
            connecting_leg: None,
        };
        let target_access = TerminalNodeAccess {
            terminal_track: target_terminal,
            node_id: 3,
            connecting_leg: None,
        };
        let search = paired_stabling_candidates(
            &read,
            &source_access,
            &target_access,
            StablingSearchPolicy {
                formation_length_mm,
                minimum_clearance_mm: 10_000,
                maximum_path_edges,
                maximum_path_length_mm,
                search_mode,
            },
            "passenger:source",
            "passenger:target",
        )
        .expect("asymmetrische Abstellpfadsuche");
        drop(read);
        drop(database);
        drop(root);
        search
    }

    fn cross_berth_demand() -> TurnaroundPairDemand {
        TurnaroundPairDemand {
            id: "turnaround:cross-berth:test".to_owned(),
            lot_id: "lot:test".to_owned(),
            asset_compatibility_key: "asset:test".to_owned(),
            source_circulation_id: "circulation:test".to_owned(),
            target_circulation_id: "circulation:test".to_owned(),
            source_passenger_leg_id: "inbound".to_owned(),
            target_passenger_leg_id: "outbound".to_owned(),
            inbound_route_version_id: "passenger:source".to_owned(),
            outbound_route_version_id: "passenger:target".to_owned(),
            source_location_id: "location:shared".to_owned(),
            target_location_id: "location:shared".to_owned(),
            source_physical_stop_id: "stop:shared".to_owned(),
            target_physical_stop_id: "stop:shared".to_owned(),
            earliest_departure_s: 18_060,
            latest_arrival_s: 18_780,
            available_window_s: 720,
            daily_boundary: false,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn with_cross_berth_fixture<R>(
        arrival_berth_length_mm: i64,
        departure_berth_length_mm: i64,
        berth_service: Option<&str>,
        include_terminal_connector: bool,
        maximum_path_edges: u32,
        maximum_path_length_mm: i64,
        demand: &TurnaroundPairDemand,
        callback: impl FnOnce(
            &redb::ReadTransaction,
            &PolicySpec,
            &TerminalNodeAccess,
            &TerminalNodeAccess,
            &TimetableRouteInput,
            &TimetableRouteInput,
            &TurnaroundPairDemand,
            super::Result<super::PairedStablingSearch>,
        ) -> R,
    ) -> R {
        let root = ScratchDirectory::create(&std::env::temp_dir()).expect("Testverzeichnis");
        let database =
            Database::create(root.join("cross-berth.redb")).expect("Cross-Berth-Testdatenbank");
        initialize_database(&database).expect("Cross-Berth-Tabellen");
        let source_terminal = stabling_test_track("terminal:source", 1, 2, 100_000, None);
        let target_terminal = stabling_test_track("terminal:target", 10, 11, 100_000, None);
        let mut tracks = vec![
            source_terminal.clone(),
            target_terminal.clone(),
            stabling_test_track("access:arrival", 2, 3, 10_000, None),
            stabling_test_track(
                "berth:arrival",
                3,
                4,
                arrival_berth_length_mm,
                berth_service,
            ),
            stabling_test_track("access:departure", 9, 10, 10_000, None),
            stabling_test_track(
                "berth:departure",
                8,
                9,
                departure_berth_length_mm,
                berth_service,
            ),
        ];
        if include_terminal_connector {
            tracks.extend([
                stabling_test_track("connector:a", 2, 20, 60_000, None),
                stabling_test_track("connector:b", 20, 10, 60_000, None),
            ]);
        }
        let write = database
            .begin_write()
            .expect("Cross-Berth-Schreibtransaktion");
        {
            let mut table = write.open_table(TRACKS).expect("Track-Tabelle");
            let mut by_node = write
                .open_multimap_table(TRACKS_BY_NODE)
                .expect("Knotenindex");
            let mut blocks = write.open_table(BLOCK_RESOURCES).expect("Blockressourcen");
            let mut track_blocks = write
                .open_multimap_table(TRACK_BLOCKS)
                .expect("Track-Block-Index");
            for track in &tracks {
                let serialized = serde_json::to_string(track).expect("Track serialisieren");
                table
                    .insert(track.id.as_str(), serialized.as_str())
                    .expect("Track einfuegen");
                for node_id in [track.from_node_id, track.to_node_id] {
                    let node = node_id.to_string();
                    by_node
                        .insert(node.as_str(), track.id.as_str())
                        .expect("Track indexieren");
                }
                let block_id = format!("resource:block:{}", track.id);
                blocks
                    .insert(block_id.as_str(), &())
                    .expect("Blockressource einfuegen");
                track_blocks
                    .insert(track.id.as_str(), block_id.as_str())
                    .expect("Track-Block-Bindung einfuegen");
            }
        }
        write.commit().expect("Cross-Berth-Testdaten committen");
        let inbound = TimetableRouteInput {
            route_version_id: "passenger:source".to_owned(),
            template_id: "template:passenger:source".to_owned(),
            predecessor_id: None,
            transition_route_mm: None,
            legs: vec![super::derived_leg(&source_terminal, "along", 0, 100_000)],
        };
        let outbound = TimetableRouteInput {
            route_version_id: "passenger:target".to_owned(),
            template_id: "template:passenger:target".to_owned(),
            predecessor_id: None,
            transition_route_mm: None,
            legs: vec![super::derived_leg(&target_terminal, "along", 0, 100_000)],
        };
        let source_access = TerminalNodeAccess {
            terminal_track: source_terminal,
            node_id: 2,
            connecting_leg: None,
        };
        let target_access = TerminalNodeAccess {
            terminal_track: target_terminal,
            node_id: 10,
            connecting_leg: None,
        };
        let policy = transfer_partition_policy();
        let read = database.begin_read().expect("Cross-Berth-Testleser");
        let search = paired_stabling_candidates_with_fallback(
            &read,
            &source_access,
            &target_access,
            46_560,
            policy.minimum_berth_end_clearance_mm,
            maximum_path_edges,
            maximum_path_length_mm,
            &inbound.route_version_id,
            &outbound.route_version_id,
            demand,
        );
        callback(
            &read,
            &policy,
            &source_access,
            &target_access,
            &inbound,
            &outbound,
            demand,
            search,
        )
    }

    fn paired_candidate_ids(search: &super::PairedStablingSearch) -> Vec<(Vec<&str>, Vec<&str>)> {
        search
            .candidates
            .iter()
            .map(|candidate| {
                (
                    candidate
                        .inbound_path
                        .iter()
                        .map(|edge| edge.track.id.as_str())
                        .collect(),
                    candidate
                        .outbound_path
                        .iter()
                        .map(|edge| edge.track.id.as_str())
                        .collect(),
                )
            })
            .collect()
    }

    #[test]
    fn asymmetrischer_router_ueberspringt_fruehen_fremdberth_und_sortiert_stabil() {
        let first = asymmetric_stabling_search(100_000, Some(7));
        assert_eq!(first.inbound_candidate_count, 3);
        assert_eq!(first.outbound_candidate_count, 2);
        assert_eq!(first.candidates.len(), 2);
        let ids = paired_candidate_ids(&first);
        assert_eq!(
            ids[0].0,
            vec![
                "access:source",
                "connector:source-to-shared",
                "berth:shared-a",
            ]
        );
        assert_eq!(
            ids[0].1,
            vec![
                "access:target",
                "connector:target-to-shared",
                "berth:shared-a",
            ]
        );
        assert_eq!(
            ids.iter()
                .map(|(inbound, _)| *inbound.last().expect("Berth-ID"))
                .collect::<Vec<_>>(),
            vec!["berth:shared-a", "berth:shared-z"]
        );
        assert_eq!(
            ids,
            paired_candidate_ids(&asymmetric_stabling_search(100_000, Some(7)))
        );
    }

    #[test]
    fn asymmetrischer_router_verwirft_luecke_und_zu_kurzen_berth_aber_bildet_richtung_ab() {
        let disconnected = asymmetric_stabling_search(100_000, None);
        assert!(disconnected.candidates.is_empty());
        assert_eq!(disconnected.outbound_candidate_count, 0);

        let too_short = asymmetric_stabling_search(60_000, Some(7));
        assert!(too_short.candidates.is_empty());

        let wrong_direction = asymmetric_stabling_search(100_000, Some(8));
        let opposite_access = wrong_direction
            .candidates
            .iter()
            .find(|candidate| {
                candidate
                    .inbound_path
                    .last()
                    .is_some_and(|edge| edge.track.id == "berth:shared-a")
            })
            .expect("gegenlaeufig erreichbarer realer Berth");
        assert_ne!(
            opposite_access
                .inbound_path
                .last()
                .expect("Inbound-Berth")
                .direction,
            opposite_access
                .outbound_path
                .last()
                .expect("Outbound-Berth")
                .direction,
            "die signierte Dispatch-Continuity muss den Berth-Richtungsfall unterscheiden"
        );
    }

    #[test]
    fn synthetische_betriebszuordnung_bleibt_reale_osm_geometrie_und_strikt_typisiert() {
        let terminal = stabling_test_track("terminal", 100, 101, 100_000, None);
        for (service, subtype) in [
            (Some("yard"), BerthAssignmentSubtype::ServiceYard),
            (Some("spur"), BerthAssignmentSubtype::ServiceSpur),
            (None, BerthAssignmentSubtype::UnclassifiedRail),
        ] {
            let track = stabling_test_track("candidate", 101, 102, 100_000, service);
            let assignment = berth_assignment(
                &track,
                &terminal,
                BerthSearchMode::SimulatedOperationalFallback,
            )
            .expect("freigegebene synthetische Betriebszuordnung");
            assert_eq!(assignment.kind, BerthAssignmentKind::SimulatedOperational);
            assert_eq!(assignment.subtype, subtype);
            assert!(berth_assignment(&track, &terminal, BerthSearchMode::ObservedSiding).is_none());
        }
        for service in [Some("crossover"), Some("draisine"), Some("siding;yard")] {
            let track = stabling_test_track("rejected", 101, 102, 100_000, service);
            assert!(
                berth_assignment(
                    &track,
                    &terminal,
                    BerthSearchMode::SimulatedOperationalFallback
                )
                .is_none(),
                "sonstige OSM-Serviceklasse {service:?} darf nicht als Berth umgedeutet werden"
            );
        }
        let mut invented = stabling_test_track("invented", 101, 102, 100_000, Some("yard"));
        invented.osm_way_id = 0;
        assert!(
            berth_assignment(
                &invented,
                &terminal,
                BerthSearchMode::SimulatedOperationalFallback
            )
            .is_none(),
            "ohne reale OSM-Lineage darf keine synthetische Betriebszuordnung entstehen"
        );
    }

    #[test]
    fn synthetischer_berth_ist_deterministisch_passend_und_policybegrenzt() {
        for formation_length_mm in [46_560, 69_860] {
            let exact_length = formation_length_mm + 20_000;
            let first = asymmetric_stabling_search_with(
                formation_length_mm,
                exact_length,
                Some(7),
                Some("yard"),
                BerthSearchMode::SimulatedOperationalFallback,
                3,
                1_000_000,
            );
            assert_eq!(first.candidates.len(), 2);
            assert!(first.candidates.iter().all(|candidate| {
                candidate.arrival_berth_assignment.kind == BerthAssignmentKind::SimulatedOperational
                    && candidate.arrival_berth_assignment.subtype
                        == BerthAssignmentSubtype::ServiceYard
                    && candidate.departure_berth_assignment == candidate.arrival_berth_assignment
            }));
            assert_eq!(
                paired_candidate_ids(&first),
                paired_candidate_ids(&asymmetric_stabling_search_with(
                    formation_length_mm,
                    exact_length,
                    Some(7),
                    Some("yard"),
                    BerthSearchMode::SimulatedOperationalFallback,
                    3,
                    1_000_000,
                ))
            );
            assert!(
                asymmetric_stabling_search_with(
                    formation_length_mm,
                    exact_length - 1,
                    Some(7),
                    Some("yard"),
                    BerthSearchMode::SimulatedOperationalFallback,
                    3,
                    1_000_000,
                )
                .candidates
                .is_empty(),
                "Formation und beide Clearance-Enden muessen exakt passen"
            );
        }
        assert!(
            asymmetric_stabling_search_with(
                46_560,
                100_000,
                Some(7),
                Some("yard"),
                BerthSearchMode::SimulatedOperationalFallback,
                2,
                1_000_000,
            )
            .candidates
            .is_empty(),
            "die reale gemeinsame Kante liegt hinter der expliziten Hopgrenze"
        );
        assert!(
            asymmetric_stabling_search_with(
                46_560,
                100_000,
                Some(7),
                Some("yard"),
                BerthSearchMode::SimulatedOperationalFallback,
                3,
                100_000,
            )
            .candidates
            .is_empty(),
            "die reale gemeinsame Kante liegt hinter der expliziten Distanzgrenze"
        );
    }

    #[test]
    fn cross_berth_kette_bindet_reale_geometrie_continuity_laufzeit_und_ressourcen() {
        let demand = cross_berth_demand();
        with_cross_berth_fixture(
            80_000,
            80_000,
            Some("siding"),
            true,
            4,
            100_000,
            &demand,
            |read, policy, _, _, inbound, outbound, demand, search| {
                let search = search.expect("Cross-Berth-Suche");
                assert_eq!(search.candidates.len(), 1);
                let candidate = &search.candidates[0];
                assert_eq!(candidate.stabling_kind, StablingKind::CrossBerthTransfer);
                assert_eq!(
                    candidate
                        .inbound_path
                        .last()
                        .expect("Ankunfts-Berth")
                        .track
                        .id,
                    "berth:arrival"
                );
                assert_eq!(
                    candidate
                        .outbound_path
                        .last()
                        .expect("Abfahrts-Berth")
                        .track
                        .id,
                    "berth:departure"
                );
                let provenance = candidate
                    .berth_transfer_provenance
                    .as_ref()
                    .expect("Cross-Berth-Provenienz");
                assert_eq!(provenance.location_id, demand.source_location_id);
                assert_eq!(provenance.physical_stop_id, demand.source_physical_stop_id);
                assert_eq!(provenance.maximum_path_edges_per_side, 4);
                assert_eq!(provenance.maximum_path_length_mm_per_side, 100_000);

                let built =
                    build_stabling_routes(read, policy, inbound, outbound, 46_560, candidate)
                        .expect("Cross-Berth-Laufwegkette");
                let berth_transfer = built
                    .berth_transfer
                    .as_ref()
                    .expect("expliziter interner Berth-Transfer");
                assert_eq!(
                    berth_transfer.predecessor_id.as_deref(),
                    Some(built.shunt_in.route_version_id.as_str())
                );
                assert_eq!(
                    built.shunt_out.predecessor_id.as_deref(),
                    Some(berth_transfer.route_version_id.as_str())
                );
                assert_eq!(
                    built.outbound.predecessor_id.as_deref(),
                    Some(built.shunt_out.route_version_id.as_str())
                );
                assert_eq!(
                    built.shunt_out_continuity,
                    MovementContinuity::ReverseDirection
                );
                assert!(
                    berth_transfer
                        .legs
                        .iter()
                        .any(|leg| leg.edge_id == "connector:a")
                        && berth_transfer
                            .legs
                            .iter()
                            .any(|leg| leg.edge_id == "connector:b"),
                    "der interne Transfer muss beide realen Connector-Kanten befahren"
                );
                assert!(
                    stabling_minimum_runtime_ms(read, &built, 46_560)
                        .expect("native Rangierlaufzeit")
                        <= demand.available_window_s * 1_000
                );

                let mut interlocking = BTreeMap::new();
                let mut signals = BTreeSet::new();
                let mut resources = BTreeSet::new();
                let (shunt_in_dispatch, _) = generate_movement_route_artifacts(
                    read,
                    inbound,
                    &built.shunt_in,
                    "shunting",
                    46_560,
                    MovementContinuity::SameDirection,
                    GeneratedMovementArtifacts {
                        interlocking: &mut interlocking,
                        signals: &mut signals,
                        resources: &mut resources,
                    },
                )
                .expect("Shunt-in-Fahrstrasse");
                let (berth_transfer_dispatch, _) = generate_movement_route_artifacts(
                    read,
                    &built.shunt_in,
                    berth_transfer,
                    "shunting",
                    46_560,
                    MovementContinuity::ReverseDirection,
                    GeneratedMovementArtifacts {
                        interlocking: &mut interlocking,
                        signals: &mut signals,
                        resources: &mut resources,
                    },
                )
                .expect("Berth-Transfer-Fahrstrasse");
                let (shunt_out_dispatch, _) = generate_movement_route_artifacts(
                    read,
                    berth_transfer,
                    &built.shunt_out,
                    "shunting",
                    46_560,
                    MovementContinuity::ReverseDirection,
                    GeneratedMovementArtifacts {
                        interlocking: &mut interlocking,
                        signals: &mut signals,
                        resources: &mut resources,
                    },
                )
                .expect("Shunt-out-Fahrstrasse");
                let (outbound_dispatch, _) = generate_movement_route_artifacts(
                    read,
                    &built.shunt_out,
                    &built.outbound,
                    "train",
                    46_560,
                    MovementContinuity::SameDirection,
                    GeneratedMovementArtifacts {
                        interlocking: &mut interlocking,
                        signals: &mut signals,
                        resources: &mut resources,
                    },
                )
                .expect("Outbound-Fahrstrasse");
                assert_eq!(
                    shunt_in_dispatch.continuity,
                    MovementContinuity::SameDirection
                );
                assert_eq!(
                    berth_transfer_dispatch.continuity,
                    MovementContinuity::ReverseDirection
                );
                assert_eq!(
                    shunt_out_dispatch.continuity,
                    MovementContinuity::ReverseDirection
                );
                assert_eq!(
                    outbound_dispatch.continuity,
                    MovementContinuity::SameDirection
                );
                assert!(
                    berth_transfer_dispatch
                        .resource_ids
                        .iter()
                        .any(|id| id.contains("connector:a"))
                        && berth_transfer_dispatch
                            .resource_ids
                            .iter()
                            .any(|id| id.contains("connector:b")),
                    "der signierte Berth-Transfer muss beide Connector-Konfliktressourcen tragen"
                );
                for serialized in interlocking.values() {
                    let route: Value = serde_json::from_str(serialized).expect("Fahrstrassen-JSON");
                    assert!(!route["pathResources"].as_array().unwrap().is_empty());
                    assert!(!route["overlapResources"].as_array().unwrap().is_empty());
                    assert!(!route["flankResources"].as_array().unwrap().is_empty());
                }
            },
        );
    }

    #[test]
    fn cross_berth_schutzwechsel_verlangt_gemeinsame_reale_schutzkomponente() {
        let mut inbound = stabling_test_track("terminal:inbound", 1, 2, 100_000, None);
        inbound.protection_systems = BTreeSet::from(["lzb".to_owned(), "pzb".to_owned()]);
        let mut outbound = stabling_test_track("terminal:outbound", 3, 4, 100_000, None);
        outbound.protection_systems = BTreeSet::from(["pzb".to_owned()]);
        assert!(super::cross_berth_terminal_compatible(&inbound, &outbound));

        let mut connector = stabling_test_track("connector", 2, 3, 100_000, None);
        connector.protection_systems = BTreeSet::from(["pzb".to_owned()]);
        assert!(super::cross_berth_track_compatible(
            &connector, &inbound, &outbound
        ));

        connector.protection_systems = BTreeSet::from(["etcs".to_owned()]);
        assert!(
            !super::cross_berth_track_compatible(&connector, &inbound, &outbound),
            "eine disjunkte Zugsicherung darf nicht als betriebliche Kompatibilitaet geraten werden"
        );
        outbound.protection_systems = BTreeSet::from(["etcs".to_owned()]);
        assert!(
            !super::cross_berth_terminal_compatible(&inbound, &outbound),
            "vollstaendig disjunkte Terminalvertraege bleiben fail-closed"
        );
    }

    #[test]
    fn cross_berth_fallback_ist_deterministisch_und_verwirft_unpassende_realitaet() {
        let demand = cross_berth_demand();
        let candidate_key = |search: super::PairedStablingSearch| {
            search
                .candidates
                .into_iter()
                .map(|candidate| {
                    super::generated_route_ids(
                        "passenger:source",
                        "passenger:target",
                        46_560,
                        &candidate,
                    )
                    .turnaround_id
                })
                .collect::<Vec<_>>()
        };
        let first = with_cross_berth_fixture(
            80_000,
            80_000,
            Some("siding"),
            true,
            4,
            100_000,
            &demand,
            |_, _, _, _, _, _, _, search| candidate_key(search.expect("erste Suche")),
        );
        let second = with_cross_berth_fixture(
            80_000,
            80_000,
            Some("siding"),
            true,
            4,
            100_000,
            &demand,
            |_, _, _, _, _, _, _, search| candidate_key(search.expect("zweite Suche")),
        );
        assert_eq!(first, second);

        for (name, arrival_length, departure_length, service, connector, edges, length) in [
            (
                "missing-connector",
                80_000,
                80_000,
                Some("siding"),
                false,
                4,
                100_000,
            ),
            (
                "short-arrival",
                60_000,
                80_000,
                Some("siding"),
                true,
                4,
                100_000,
            ),
            (
                "short-departure",
                80_000,
                60_000,
                Some("siding"),
                true,
                4,
                100_000,
            ),
            (
                "rejected-crossover",
                80_000,
                80_000,
                Some("crossover"),
                true,
                4,
                100_000,
            ),
            (
                "hop-bound",
                80_000,
                80_000,
                Some("siding"),
                true,
                1,
                100_000,
            ),
            (
                "distance-bound",
                80_000,
                80_000,
                Some("siding"),
                true,
                4,
                89_999,
            ),
        ] {
            with_cross_berth_fixture(
                arrival_length,
                departure_length,
                service,
                connector,
                edges,
                length,
                &demand,
                |_, _, _, _, _, _, _, search| {
                    assert!(
                        search.expect("negative Suche").candidates.is_empty(),
                        "{name} darf keinen Cross-Berth-Kandidaten erzeugen"
                    );
                },
            );
        }

        let mut cross_location = demand;
        cross_location.target_physical_stop_id = "stop:foreign".to_owned();
        with_cross_berth_fixture(
            80_000,
            80_000,
            Some("siding"),
            true,
            4,
            100_000,
            &cross_location,
            |_, _, _, _, _, _, _, search| {
                let error = search.expect_err("ortsverschiedener Demand muss scheitern");
                assert!(error.to_string().contains("identischen autoritativen Ort"));
            },
        );
    }

    #[test]
    fn dispatch_continuity_ist_required_und_enum_strikt() {
        let valid = json!({
            "routeVersionId": "route:successor",
            "predecessorBaseRouteVersionId": "route:predecessor",
            "continuity": "same-direction",
            "dispatchInterlockingRouteId": "interlocking:successor",
            "headRouteMm": 50,
            "minimumRuntimeMs": 1,
            "resourceIds": ["resource:successor"],
            "routeLegCount": 1,
            "protectionContractRuns": [{
                "throughRouteLegIndex": 0,
                "availableProtectionSystems": ["pzb"],
                "simultaneouslyRequiredProtectionSystems": []
            }]
        });
        serde_json::from_value::<TurnaroundRouteDispatch>(valid.clone())
            .expect("gueltige signierte Fortsetzungsrichtung");
        let mut missing = valid.clone();
        missing
            .as_object_mut()
            .expect("Dispatch-Objekt")
            .remove("continuity");
        serde_json::from_value::<TurnaroundRouteDispatch>(missing)
            .expect_err("fehlende continuity muss fail-closed bleiben");
        let mut manipulated = valid;
        manipulated["continuity"] = json!("sideways");
        serde_json::from_value::<TurnaroundRouteDispatch>(manipulated)
            .expect_err("unbekannte continuity muss fail-closed bleiben");
    }

    #[test]
    fn cross_berth_zaehlt_zwei_zuordnungen_aber_nur_ein_stabling_template() {
        let observed = json!({
            "kind": "observed",
            "subtype": "osm-service-siding",
            "geometryProvenance": "real-osm-rail",
            "operationalAssignmentProvenance": "observed-osm-service"
        });
        let simulated = json!({
            "kind": "simulated-operational",
            "subtype": "osm-unclassified-rail",
            "geometryProvenance": "real-osm-rail",
            "operationalAssignmentProvenance": "synthetic-operational-b-policy"
        });
        let templates = vec![
            json!({
                "stablingKind": "shared-berth",
                "arrivalBerthAssignment": observed,
                "departureBerthAssignment": observed
            }),
            json!({
                "stablingKind": "cross-berth-transfer",
                "arrivalBerthAssignment": simulated,
                "departureBerthAssignment": simulated
            }),
        ];
        let (assignments, observed_templates, simulated_templates, cross_templates) =
            stabling_template_provenance_counts(&templates).expect("gueltige Provenienz");
        assert_eq!(assignments.observed_osm_service_siding, 1);
        assert_eq!(assignments.simulated_operational_osm_unclassified_rail, 2);
        assert_eq!(observed_templates, 1);
        assert_eq!(simulated_templates, 1);
        assert_eq!(cross_templates, 1);

        let mut missing_departure = templates[1].clone();
        missing_departure
            .as_object_mut()
            .expect("Template")
            .remove("departureBerthAssignment");
        let error = stabling_template_provenance_counts(&[missing_departure])
            .expect_err("Cross-Berth ohne Abfahrtsprovenienz muss scheitern");
        assert!(error.to_string().contains("Abfahrts-Berth-Provenienz"));
    }

    #[test]
    fn dispatch_continuity_muss_der_vorgaenger_und_zielgeometrie_entsprechen() {
        let mut predecessor = continuity_route("route:predecessor", None, None, "along", 0, 100);
        predecessor.legs.truncate(1);
        let same = continuity_route(
            "route:same",
            Some("route:predecessor"),
            Some(50),
            "along",
            50,
            100,
        );
        assert_eq!(
            require_movement_continuity(
                &predecessor,
                &same,
                50,
                MovementContinuity::SameDirection,
            )
            .expect("Same-Direction-Geometrie"),
            MovementContinuity::SameDirection
        );
        require_movement_continuity(
            &predecessor,
            &same,
            50,
            MovementContinuity::ReverseDirection,
        )
        .expect_err("manipulierte Richtungsbehauptung muss scheitern");

        let displaced = continuity_route(
            "route:displaced",
            Some("route:predecessor"),
            Some(50),
            "along",
            49,
            99,
        );
        require_movement_continuity(
            &predecessor,
            &displaced,
            50,
            MovementContinuity::SameDirection,
        )
        .expect_err("korrekte IDs duerfen eine um 1 mm verschobene Geometrie nicht verdecken");

        let reverse = continuity_route(
            "route:reverse",
            Some("route:predecessor"),
            Some(50),
            "against",
            100,
            50,
        );
        assert_eq!(
            require_movement_continuity(
                &predecessor,
                &reverse,
                50,
                MovementContinuity::ReverseDirection,
            )
            .expect("Reverse-Direction-Geometrie"),
            MovementContinuity::ReverseDirection
        );
        let mut wrong_predecessor = same;
        wrong_predecessor.predecessor_id = Some("route:foreign".to_owned());
        require_movement_continuity(
            &predecessor,
            &wrong_predecessor,
            50,
            MovementContinuity::SameDirection,
        )
        .expect_err("falsche statische Vorgaengerbindung muss scheitern");
    }

    #[test]
    fn generated_batches_flushen_mehrfach_deterministisch_und_kollisionen_rollbacken() {
        let root = ScratchDirectory::create(&std::env::temp_dir()).expect("Testverzeichnis");
        let database =
            Database::create(root.join("generated-batches.redb")).expect("Batch-Testdatenbank");
        initialize_database(&database).expect("Batch-Tabellen");
        let tables = GeneratedBatchTables {
            routes: TURNAROUND_ROUTES,
            interlocking: TURNAROUND_INTERLOCKING,
            templates: TURNAROUND_TEMPLATES,
            route_context: "Test-Laufweg",
            interlocking_context: "Test-Fahrstrasse",
            template_context: "Test-Template",
        };
        let mut batch = GeneratedBatch::default();
        let mut flushes = 0_u32;
        for (suffix, value) in [("b", 2), ("a", 1)] {
            insert_generated(
                &mut batch.routes,
                format!("route:{suffix}"),
                &json!({"value": value}),
                "Test-Laufweg",
            )
            .expect("Laufweg puffern");
            insert_generated(
                &mut batch.interlocking,
                format!("interlocking:{suffix}"),
                &json!({"value": value}),
                "Test-Fahrstrasse",
            )
            .expect("Fahrstrasse puffern");
            insert_generated(
                &mut batch.templates,
                format!("template:{suffix}"),
                &json!({"value": value}),
                "Test-Template",
            )
            .expect("Template puffern");
            batch.signals.insert(format!("signal:{suffix}"));
            batch.resources.insert(format!("resource:{suffix}"));
            assert!(batch.estimated_resident_bytes() > 0);
            if flush_generated_batch(&database, &mut batch, tables, false, 1)
                .expect("Batch flushen")
            {
                flushes += 1;
            }
            assert!(batch.is_empty(), "jeder Flush muss den Heap-Batch leeren");
        }
        assert_eq!(flushes, 2, "der Test muss mehrere echte Commits erzwingen");

        let read = database.begin_read().expect("Batch lesen");
        let routes = read.open_table(TURNAROUND_ROUTES).expect("Laufwegtabelle");
        let rows = routes
            .iter()
            .expect("Laufwege iterieren")
            .map(|entry| {
                let (id, serialized) = entry.expect("Laufwegeintrag");
                (id.value().to_owned(), serialized.value().to_owned())
            })
            .collect::<Vec<_>>();
        assert_eq!(
            rows,
            vec![
                ("route:a".to_owned(), "{\"value\":1}".to_owned()),
                ("route:b".to_owned(), "{\"value\":2}".to_owned()),
            ],
            "redb-Ausgabe bleibt unabhaengig von der Batch-Reihenfolge kanonisch sortiert"
        );
        drop(routes);
        drop(read);

        insert_generated(
            &mut batch.routes,
            "route:a".to_owned(),
            &json!({"value": 1}),
            "Test-Laufweg",
        )
        .expect("identisches Duplikat puffern");
        flush_generated_batch(&database, &mut batch, tables, true, 1)
            .expect("identisches Duplikat ist idempotent");

        insert_generated(
            &mut batch.routes,
            "route:a".to_owned(),
            &json!({"value": 99}),
            "Test-Laufweg",
        )
        .expect("Kollision puffern");
        let error = flush_generated_batch(&database, &mut batch, tables, true, 1)
            .expect_err("abweichende Kollision muss scheitern");
        assert!(error.to_string().contains("Kollidierende Test-Laufweg-ID"));
        let read = database.begin_read().expect("Rollback lesen");
        let routes = read.open_table(TURNAROUND_ROUTES).expect("Laufwegtabelle");
        assert_eq!(
            routes
                .get("route:a")
                .expect("Laufweg lesen")
                .expect("Laufweg vorhanden")
                .value(),
            "{\"value\":1}",
            "der fehlgeschlagene Batch darf den zuvor committeten Wert nicht ersetzen"
        );
    }

    #[test]
    fn generated_record_grenze_blockiert_vor_dem_redb_commit() {
        let mut values = BTreeMap::new();
        let oversized = "x".repeat(MAX_GENERATED_RECORD_BYTES);
        let error = insert_generated(
            &mut values,
            "route:oversized".to_owned(),
            &oversized,
            "Test-Laufweg",
        )
        .expect_err("uebergrosser Einzelrecord muss vor Staging scheitern");
        assert!(error.to_string().contains("Einzelrecord-Grenze"));
        assert!(values.is_empty());

        let mut batch = GeneratedBatch::default();
        insert_generated(
            &mut batch.routes,
            "route:bounded-unit".to_owned(),
            &json!({"value": "bounded"}),
            "Test-Laufweg",
        )
        .expect("kleinen Einzelrecord puffern");
        require_generated_unit_bound(0, &batch, 1, "Test-Fall")
            .expect_err("das Ableitungsbudget muss die Aggregation vor dem Commit begrenzen");
    }

    #[test]
    fn create_new_publish_ueberschreibt_keinen_nachtraeglich_angelegten_target() {
        let root = ScratchDirectory::create(&std::env::temp_dir()).expect("Testverzeichnis");
        let staged = root.join("staged.json");
        let target = root.join("target.json");
        fs::write(&staged, b"validated").expect("Stagingdatei");
        ensure_output_absent(&target, "Testziel").expect("Ziel anfangs frei");
        fs::write(&target, b"foreign").expect("konkurrierendes Ziel");

        publish_create_new(&staged, &target, "Testziel veroeffentlichen")
            .expect_err("create-new darf ein spaetes Ziel nicht ersetzen");
        assert_eq!(fs::read(&target).expect("Ziel lesen"), b"foreign");
        assert_eq!(fs::read(&staged).expect("Staging lesen"), b"validated");
    }

    #[test]
    fn fehlgeschlagener_zweiter_publish_hinterlaesst_keinen_eigenen_kandidaten() {
        let root = ScratchDirectory::create(&std::env::temp_dir()).expect("Testverzeichnis");
        let staged_candidate = root.join("staged-candidate.json");
        let staged_report = root.join("staged-report.json");
        let candidate = root.join("candidate.json");
        let report = root.join("report.json");
        fs::write(&staged_candidate, b"validated-candidate").expect("Kandidat im Staging");
        fs::write(&staged_report, b"validated-report").expect("Bericht im Staging");
        fs::write(&report, b"foreign-report").expect("konkurrierender Bericht");

        publish_pair_create_new(&staged_candidate, &candidate, &staged_report, &report)
            .expect_err("zweiter create-new Publish muss scheitern");
        assert!(
            !candidate.exists(),
            "partieller Kandidat muss entfernt sein"
        );
        assert_eq!(
            fs::read(&report).expect("fremder Bericht"),
            b"foreign-report"
        );
        assert_eq!(
            fs::read(&staged_candidate).expect("Kandidat bleibt nur im privaten Staging"),
            b"validated-candidate"
        );
        assert_eq!(
            fs::read(&staged_report).expect("Bericht bleibt nur im privaten Staging"),
            b"validated-report"
        );
    }
}
