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
use std::sync::atomic::{AtomicU64, Ordering};

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
const MOVEMENT_ROUTE_SIDECAR_SCHEMA: &str = "movement-route-templates-v2";
const TRANSFER_DEMAND_SCHEMA: &str = "zugfolge-timetable-transfer-demands/v1";
const DAILY_CIRCULATION_PLAN_SCHEMA: &str = "zugfolge-daily-circulation-plan/v1";
const MAX_TRANSFER_DEMAND_BYTES: u64 = 128 * 1024 * 1024;
const MAX_STABLING_PATH_EDGES: usize = 8;
const MAX_STABLING_PATH_LENGTH_MM: i64 = 1_000_000;
const STANDARD_GAUGE_MM: i64 = 1_435;
const DATABASE_CACHE_BYTES: usize = 16 * 1024 * 1024;
const MAX_GEOJSON_SEQUENCE_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_PLATFORM_SEARCH_CELLS: u128 = 1_000_000;
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
    inbound_route_version_id: String,
    outbound_route_version_id: String,
    terminal_edge_id: String,
    terminal_node_id: i64,
    inbound_direction: String,
    outbound_direction: String,
    formation_length_mm: i64,
    candidate_rank: u32,
    stabling_path_length_mm: i64,
    terminal_intervals: Vec<TurnaroundTerminalInterval>,
    shunt_in: TurnaroundRouteDispatch,
    berth: TurnaroundBerth,
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
    transfer_demand_count: u64,
    transfer_lot_count: u64,
    turnaround_demand_count: u64,
    turnaround_pair_count: u64,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct TurnaroundPairDemand {
    inbound_route_version_id: String,
    outbound_route_version_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectTemplateRecord {
    id: String,
    inbound_route_version_id: String,
    outbound_route_version_id: String,
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
    track: TrackRecord,
    direction: String,
}

#[derive(Clone, Debug)]
struct StablingCandidate {
    total_length_mm: i64,
    path: Vec<DirectedTrack>,
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
            "transferDemandCount",
            "transferLotCount",
        ],
        "transferDemands.dailyPlan.metrics",
    )?;
    let circulation_count = required_u64(metrics, "circulationCount", "dailyPlan.metrics")?;
    let transfer_demand_count = required_u64(metrics, "transferDemandCount", "dailyPlan.metrics")?;
    let transfer_lot_count = required_u64(metrics, "transferLotCount", "dailyPlan.metrics")?;
    let daily_demands = daily_plan["transferDemands"].as_array().ok_or_else(|| {
        GermanyOperationalV2Error::new("dailyPlan.transferDemands ist kein Array.")
    })?;
    require(
        u64::try_from(daily_plan["circulations"].as_array().map_or(0, Vec::len)).ok()
            == Some(circulation_count)
            && u64::try_from(daily_demands.len()).ok() == Some(transfer_demand_count),
        "dailyPlan-Metriken stimmen nicht mit den gebundenen Mengen ueberein.",
    )?;
    let circulations = daily_plan["circulations"]
        .as_array()
        .expect("Circulation-Metrik validierte ein Array");
    let mut circulation_by_id = BTreeMap::<String, &Value>::new();
    let mut turnaround_demands = Vec::<TurnaroundPairDemand>::new();
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
            turnaround_demands.push(TurnaroundPairDemand {
                inbound_route_version_id: format!("route:gtfs:{}:v1", pair[0]),
                outbound_route_version_id: format!("route:gtfs:{}:v1", pair[1]),
            });
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
    let mut transfer_rollover_pairs = BTreeSet::<(String, String)>::new();
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
            "same-location" => {
                require(
                    source["end"]["locationId"] == target["start"]["locationId"],
                    "Direct-Rollover ist nicht ortsgleich.",
                )?;
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
                turnaround_demands.push(TurnaroundPairDemand {
                    inbound_route_version_id: format!("route:gtfs:{inbound}:v1"),
                    outbound_route_version_id: format!("route:gtfs:{outbound}:v1"),
                });
            }
            "transfer" => {
                require(
                    source["end"]["locationId"] != target["start"]["locationId"],
                    "Transfer-Rollover ist bereits ortsgleich.",
                )?;
                transfer_rollover_pairs.insert((source_id.to_owned(), target_id.to_owned()));
            }
            _ => {
                return Err(GermanyOperationalV2Error::new(format!(
                    "Unbekannte Rollover-Art `{kind}`."
                )));
            }
        }
    }
    require(
        rollover_sources.len() == circulation_by_id.len()
            && rollover_targets.len() == circulation_by_id.len(),
        "Rollover-Zuordnung ist keine vollstaendige Circulation-Permutation.",
    )?;
    let demand_fields = [
        "id",
        "lotId",
        "assetCompatibilityKey",
        "sourceCirculationId",
        "targetCirculationId",
        "sourcePassengerLegId",
        "targetPassengerLegId",
        "sourceLocationId",
        "targetLocationId",
        "sourcePhysicalStopId",
        "targetPhysicalStopId",
        "earliestDepartureS",
        "latestArrivalS",
        "availableWindowS",
        "movementKind",
    ];
    let mut daily_demand_by_id = BTreeMap::<String, &Value>::new();
    let mut daily_demand_pairs = BTreeSet::<(String, String)>::new();
    let mut transfer_lots = BTreeSet::<String>::new();
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
            daily_demand_by_id.insert(id.to_owned(), demand).is_none(),
            format!("Doppelte Daily-Demand-ID `{id}`."),
        )?;
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
        require(
            daily_demand_pairs.insert((source_id.to_owned(), target_id.to_owned()))
                && demand["lotId"] == source["lotId"]
                && demand["lotId"] == target["lotId"]
                && demand["assetCompatibilityKey"] == source["assetCompatibilityKey"]
                && demand["assetCompatibilityKey"] == target["assetCompatibilityKey"]
                && demand["sourcePassengerLegId"] == source["end"]["legId"]
                && demand["targetPassengerLegId"] == target["start"]["legId"]
                && demand["sourceLocationId"] == source["end"]["locationId"]
                && demand["targetLocationId"] == target["start"]["locationId"]
                && demand["sourcePhysicalStopId"] == source["end"]["physicalStopId"]
                && demand["targetPhysicalStopId"] == target["start"]["physicalStopId"]
                && demand["movementKind"]
                    .as_str()
                    .is_some_and(|kind| matches!(kind, "train" | "shunting"))
                && demand["availableWindowS"]
                    .as_i64()
                    .is_some_and(|value| value > 0)
                && demand["latestArrivalS"]
                    .as_i64()
                    .zip(demand["earliestDepartureS"].as_i64())
                    .and_then(|(latest, earliest)| latest.checked_sub(earliest))
                    == demand["availableWindowS"].as_i64(),
            format!(
                "Daily-Demand `{id}` driftet von Rollover, Lot, Asset, Endpunkten oder Zeitfenster ab."
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
        daily_demand_pairs == transfer_rollover_pairs
            && u64::try_from(transfer_lots.len()).ok() == Some(transfer_lot_count),
        "Daily-Transferanforderungen decken die Lot-kompatiblen Transfer-Rollover nicht 1:1 ab.",
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

fn directed_track_from_node(track: TrackRecord, node_id: i64) -> Option<(DirectedTrack, i64)> {
    if track.from_node_id == node_id && track.to_node_id != node_id {
        let next = track.to_node_id;
        Some((
            DirectedTrack {
                track,
                direction: "along".to_owned(),
            },
            next,
        ))
    } else if track.to_node_id == node_id && track.from_node_id != node_id {
        let next = track.from_node_id;
        Some((
            DirectedTrack {
                track,
                direction: "against".to_owned(),
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
        && track.service.as_deref() == Some("siding")
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

fn adjacent_directed_tracks(
    transaction: &redb::ReadTransaction,
    node_id: i64,
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
        let serialized = tracks
            .get(edge_id.as_str())
            .map_err(db_error)?
            .ok_or_else(|| {
                GermanyOperationalV2Error::new(format!(
                    "Knotenindex verweist auf unbekannte Gleiskante `{edge_id}`."
                ))
            })?;
        let track = track_from_json(serialized.value(), "Knotenindex-Gleiskante")?;
        if let Some(directed) = directed_track_from_node(track, node_id) {
            result.push(directed);
        }
    }
    Ok(result)
}

fn terminal_has_observed_siding_entry(
    transaction: &redb::ReadTransaction,
    terminal_edge_id: &str,
    terminal_node_id: i64,
) -> Result<bool> {
    let by_node = transaction
        .open_multimap_table(TRACKS_BY_NODE)
        .map_err(db_error)?;
    let tracks = transaction.open_table(TRACKS).map_err(db_error)?;
    let node_key = terminal_node_id.to_string();
    let mut values = by_node.get(node_key.as_str()).map_err(db_error)?;
    while let Some(value) = values.next().transpose().map_err(db_error)? {
        let edge_id = value.value();
        if edge_id == terminal_edge_id {
            continue;
        }
        let serialized = tracks.get(edge_id).map_err(db_error)?.ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Knotenindex verweist auf unbekannte Gleiskante `{edge_id}`."
            ))
        })?;
        let track = track_from_json(serialized.value(), "Terminal-Knotenindex-Gleiskante")?;
        if track.service.as_deref() == Some("siding") {
            return Ok(true);
        }
    }
    Ok(false)
}

#[allow(clippy::too_many_arguments)]
fn collect_stabling_paths(
    transaction: &redb::ReadTransaction,
    terminal: &TrackRecord,
    node_id: i64,
    formation_length_mm: i64,
    minimum_clearance_mm: i64,
    path: &mut Vec<DirectedTrack>,
    visited_edges: &mut BTreeSet<String>,
    visited_nodes: &mut BTreeSet<i64>,
    total_length_mm: i64,
    candidates: &mut Vec<StablingCandidate>,
) -> Result<()> {
    if path.len() >= MAX_STABLING_PATH_EDGES {
        return Ok(());
    }
    for (directed, next_node) in adjacent_directed_tracks(transaction, node_id)? {
        if !stabling_track_compatible(&directed.track, terminal)
            || visited_edges.contains(&directed.track.id)
            || visited_nodes.contains(&next_node)
        {
            continue;
        }
        let next_total = total_length_mm
            .checked_add(directed.track.length_mm)
            .ok_or_else(|| GermanyOperationalV2Error::new("Abstellpfadlaenge laeuft ueber."))?;
        if next_total > MAX_STABLING_PATH_LENGTH_MM {
            continue;
        }
        visited_edges.insert(directed.track.id.clone());
        visited_nodes.insert(next_node);
        path.push(directed);
        let berth_required = formation_length_mm
            .checked_add(minimum_clearance_mm.saturating_mul(2))
            .ok_or_else(|| GermanyOperationalV2Error::new("Berth-Laenge laeuft ueber."))?;
        if path
            .last()
            .is_some_and(|edge| edge.track.length_mm >= berth_required)
        {
            candidates.push(StablingCandidate {
                total_length_mm: next_total,
                path: path.clone(),
            });
        } else {
            collect_stabling_paths(
                transaction,
                terminal,
                next_node,
                formation_length_mm,
                minimum_clearance_mm,
                path,
                visited_edges,
                visited_nodes,
                next_total,
                candidates,
            )?;
        }
        let removed = path.pop().expect("soeben angehaengte Abstellkante");
        visited_edges.remove(&removed.track.id);
        visited_nodes.remove(&next_node);
    }
    Ok(())
}

fn stabling_path_key(candidate: &StablingCandidate) -> (i64, Vec<&str>) {
    (
        candidate.total_length_mm,
        candidate
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
    formation_length_mm: i64,
    minimum_clearance_mm: i64,
    inbound_route_id: &str,
) -> Result<Vec<StablingCandidate>> {
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
    let mut candidates = Vec::new();
    let mut path = Vec::new();
    let mut visited_edges = BTreeSet::from([terminal.id.clone()]);
    let mut visited_nodes = BTreeSet::from([terminal_node_id]);
    collect_stabling_paths(
        transaction,
        terminal,
        terminal_node_id,
        formation_length_mm,
        minimum_clearance_mm,
        &mut path,
        &mut visited_edges,
        &mut visited_nodes,
        0,
        &mut candidates,
    )?;
    let _ = inbound_route_id;
    candidates.sort_by(|left, right| stabling_path_key(left).cmp(&stabling_path_key(right)));
    let mut by_berth_edge = BTreeMap::<String, StablingCandidate>::new();
    for candidate in candidates {
        let berth_edge_id = candidate
            .path
            .last()
            .expect("Abstellkandidat ist nicht leer")
            .track
            .id
            .clone();
        by_berth_edge.entry(berth_edge_id).or_insert(candidate);
    }
    let mut result: Vec<_> = by_berth_edge.into_values().collect();
    result.sort_by(|left, right| stabling_path_key(left).cmp(&stabling_path_key(right)));
    Ok(result)
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

fn outbound_routes_for_terminal(
    transaction: &redb::ReadTransaction,
    inbound: &TimetableRouteInput,
    terminal_leg: &TimetableLegInput,
) -> Result<Vec<TimetableRouteInput>> {
    let direction = reverse_direction(&terminal_leg.direction)?;
    let key = timetable_route_start_key_parts(
        &terminal_leg.edge_id,
        direction,
        terminal_leg.edge_exit_mm,
    );
    let by_start = transaction
        .open_multimap_table(TIMETABLE_ROUTES_BY_START)
        .map_err(db_error)?;
    let routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    let mut ids = Vec::new();
    let mut values = by_start.get(key.as_str()).map_err(db_error)?;
    while let Some(value) = values.next().transpose().map_err(db_error)? {
        if value.value() != inbound.route_version_id {
            ids.push(value.value().to_owned());
        }
    }
    ids.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    let mut result = Vec::new();
    for id in ids {
        let serialized = routes.get(id.as_str()).map_err(db_error)?.ok_or_else(|| {
            GermanyOperationalV2Error::new(format!(
                "Timetable-Startindex verweist auf unbekannten Laufweg `{id}`."
            ))
        })?;
        result.push(route_from_json(
            serialized.value(),
            "Ausgangs-Personenlaufweg im Timetable-Index",
        )?);
    }
    Ok(result)
}

fn generated_route_ids(
    inbound_route_id: &str,
    outbound_route_id: &str,
    formation_length_mm: i64,
    candidate: &StablingCandidate,
) -> (String, String, String, String, String, String, String) {
    let length = formation_length_mm.to_string();
    let path = candidate
        .path
        .iter()
        .map(|edge| format!("{}:{}", edge.track.id, edge.direction))
        .collect::<Vec<_>>()
        .join("\n");
    let parts = [
        inbound_route_id,
        outbound_route_id,
        length.as_str(),
        path.as_str(),
    ];
    (
        stable_id("route:synthetic-turnaround-shunt-in:", &parts),
        stable_id("template:synthetic-turnaround-shunt-in:", &parts),
        stable_id("route:synthetic-turnaround-shunt-out:", &parts),
        stable_id("template:synthetic-turnaround-shunt-out:", &parts),
        stable_id("route:synthetic-turnaround-outbound:", &parts),
        stable_id("template:synthetic-turnaround-outbound:", &parts),
        stable_id("turnaround:synthetic-physical:", &parts),
    )
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
    if let Some(previous) = values.insert(id.clone(), serialized.clone()) {
        require(
            previous == serialized,
            format!("Kollidierende abgeleitete ID `{id}` fuer {context}."),
        )?;
    }
    Ok(())
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

fn discover_turnaround_pairs(
    transaction: &redb::ReadTransaction,
) -> Result<Vec<TurnaroundPairDemand>> {
    let routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    let mut values = Vec::new();
    for entry in routes.iter().map_err(db_error)? {
        let (_, serialized) = entry.map_err(db_error)?;
        values.push(route_from_json(
            serialized.value(),
            "Timetable-Laufweg fuer Paarableitung",
        )?);
    }
    let mut pairs = BTreeSet::new();
    for inbound in &values {
        let inbound_leg = inbound.legs.last().expect("validierter Timetable-Laufweg");
        let inbound_track = get_track(transaction, &inbound_leg.edge_id)?;
        for outbound in &values {
            if inbound.route_version_id == outbound.route_version_id {
                continue;
            }
            let outbound_leg = outbound
                .legs
                .first()
                .expect("validierter Timetable-Laufweg");
            let outbound_track = get_track(transaction, &outbound_leg.edge_id)?;
            if same_physical_point(
                &inbound_track,
                inbound_leg.edge_exit_mm,
                &outbound_track,
                outbound_leg.edge_entry_mm,
            ) {
                pairs.insert(TurnaroundPairDemand {
                    inbound_route_version_id: inbound.route_version_id.clone(),
                    outbound_route_version_id: outbound.route_version_id.clone(),
                });
            }
        }
    }
    Ok(pairs.into_iter().collect())
}

fn derive_direct_templates(
    database: &Database,
    policy: &PolicySpec,
    required_pairs: Option<&[TurnaroundPairDemand]>,
) -> Result<BTreeSet<(String, String, i64)>> {
    if policy.terminal_formation_lengths_mm.is_empty() {
        return Ok(BTreeSet::new());
    }
    let transaction = database.begin_read().map_err(db_error)?;
    let routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    let pairs = required_pairs.map_or_else(
        || discover_turnaround_pairs(&transaction),
        |pairs| Ok(pairs.to_vec()),
    )?;
    let mut generated_routes = BTreeMap::<String, String>::new();
    let mut generated_interlocking = BTreeMap::<String, String>::new();
    let mut generated_templates = BTreeMap::<String, String>::new();
    let mut generated_signals = BTreeSet::<String>::new();
    let mut generated_resources = BTreeSet::<String>::new();
    let mut covered = BTreeSet::new();

    for pair in pairs {
        let inbound_serialized = routes
            .get(pair.inbound_route_version_id.as_str())
            .map_err(db_error)?
            .ok_or_else(|| {
                GermanyOperationalV2Error::new(format!(
                    "Turnaround-Paar verweist auf unbekannte Ankunftsroute `{}`.",
                    pair.inbound_route_version_id
                ))
            })?;
        let outbound_serialized = routes
            .get(pair.outbound_route_version_id.as_str())
            .map_err(db_error)?
            .ok_or_else(|| {
                GermanyOperationalV2Error::new(format!(
                    "Turnaround-Paar verweist auf unbekannte Ausgangsroute `{}`.",
                    pair.outbound_route_version_id
                ))
            })?;
        let inbound = route_from_json(inbound_serialized.value(), "Direct-Ankunftsroute")?;
        let outbound_base = route_from_json(outbound_serialized.value(), "Direct-Ausgangsroute")?;
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
        for &formation_length_mm in &policy.terminal_formation_lengths_mm {
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
                        interlocking: &mut generated_interlocking,
                        signals: &mut generated_signals,
                        resources: &mut generated_resources,
                    },
                    "Direct-Through-Fahrstrasse",
                )?;
                occupancy_resources
                    .extend(occupancy_resources_for_legs(&transaction, &outbound_seed)?);
                occupancy_resources.extend(movement_resources);
                add_generated_route_resources(&transaction, &route, &mut generated_resources)?;
                insert_generated(
                    &mut generated_routes,
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
                    interlocking: &mut generated_interlocking,
                    signals: &mut generated_signals,
                    resources: &mut generated_resources,
                },
                "Direct-Ausgangsfahrstrasse",
            )?;
            add_generated_route_resources(&transaction, &qualified, &mut generated_resources)?;
            insert_generated(
                &mut generated_routes,
                route_id,
                &qualified,
                "Direct-Ausgangslaufweg",
            )?;
            generated_resources.extend(occupancy_resources.iter().cloned());
            let direct = DirectTemplateRecord {
                id: direct_id.clone(),
                inbound_route_version_id: inbound.route_version_id.clone(),
                outbound_route_version_id: outbound_base.route_version_id.clone(),
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
            insert_generated(
                &mut generated_templates,
                direct_id,
                &direct,
                "Direct-Template",
            )?;
            covered.insert((
                inbound.route_version_id.clone(),
                outbound_base.route_version_id.clone(),
                formation_length_mm,
            ));
        }
    }
    drop(routes);
    drop(transaction);

    let mut write = database.begin_write().map_err(db_error)?;
    write.set_durability(Durability::None);
    for (definition, values, context) in [
        (TURNAROUND_ROUTES, &generated_routes, "Direct-Laufweg"),
        (
            TURNAROUND_INTERLOCKING,
            &generated_interlocking,
            "Direct-Fahrstrasse",
        ),
        (DIRECT_TEMPLATES, &generated_templates, "Direct-Template"),
    ] {
        let mut table = write.open_table(definition).map_err(db_error)?;
        for (id, serialized) in values {
            require(
                table
                    .insert(id.as_str(), serialized.as_str())
                    .map_err(db_error)?
                    .is_none(),
                format!("Doppelte {context}-ID `{id}`."),
            )?;
        }
    }
    {
        let mut signals = write.open_table(SIGNALS).map_err(db_error)?;
        for id in generated_signals {
            let _ = signals.insert(id.as_str(), &()).map_err(db_error)?;
        }
    }
    {
        let mut resources = write.open_table(BLOCK_RESOURCES).map_err(db_error)?;
        for id in generated_resources {
            let _ = resources.insert(id.as_str(), &()).map_err(db_error)?;
        }
    }
    write.commit().map_err(db_error)?;
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

fn derive_transfer_templates(
    database: &Database,
    policy: &PolicySpec,
    inputs: &[TransferRouteInput],
) -> Result<()> {
    if inputs.is_empty() {
        return Ok(());
    }
    let transaction = database.begin_read().map_err(db_error)?;
    let routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    let mut generated_routes = BTreeMap::<String, String>::new();
    let mut generated_interlocking = BTreeMap::<String, String>::new();
    let mut generated_templates = BTreeMap::<String, String>::new();
    let mut generated_signals = BTreeSet::<String>::new();
    let mut generated_resources = BTreeSet::<String>::new();

    for input in inputs {
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
                && input.source_location_id != input.target_location_id
                && input.available_window_s > 0
                && input
                    .latest_arrival_s
                    .checked_sub(input.earliest_departure_s)
                    == Some(input.available_window_s)
                && matches!(input.movement_kind.as_str(), "train" | "shunting")
                && input.total_length_mm > 0
                && input.weighted_cost_mm >= input.total_length_mm
                && input.minimum_runtime_ms > 0
                && input.formation_lengths_mm == policy.terminal_formation_lengths_mm,
            format!(
                "Transferanforderung `{}` besitzt keinen vollstaendigen fail-closed Vertrag.",
                input.id
            ),
        )?;
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
        let raw = TimetableRouteInput {
            route_version_id: input.route_version_id.clone(),
            template_id: input.template_id.clone(),
            predecessor_id: None,
            transition_route_mm: None,
            legs: input.legs.clone(),
        };
        validate_derived_route(&transaction, &raw)?;
        let raw_length_mm = route_length(&raw)?;
        let raw_runtime_ms = minimum_route_runtime_ms(&transaction, &raw, 0)?;
        require(
            raw_length_mm == input.total_length_mm && raw_runtime_ms == input.minimum_runtime_ms,
            format!(
                "Transferanforderung `{}` driftet in nativer Laenge/Laufzeit: {} mm/{raw_runtime_ms} ms statt {} mm/{} ms.",
                input.id, raw_length_mm, input.total_length_mm, input.minimum_runtime_ms
            ),
        )?;
        let source_last = source.legs.last().expect("validierte Quellroute");
        let target_first = target.legs.first().expect("validierte Zielroute");
        let source_track = get_track(&transaction, &source_last.edge_id)?;
        let target_track = get_track(&transaction, &target_first.edge_id)?;
        let raw_first = raw.legs.first().expect("validierte Transferroute");
        let raw_last = raw.legs.last().expect("validierte Transferroute");
        let raw_first_track = get_track(&transaction, &raw_first.edge_id)?;
        let raw_last_track = get_track(&transaction, &raw_last.edge_id)?;
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

        for &formation_length_mm in &input.formation_lengths_mm {
            let source_seed = formation_tail_legs(
                &source,
                formation_length_mm,
                &format!("Transferquelle `{}`", input.id),
            )?;
            let (target_seed, target_remainder) = formation_prefix_and_remainder(
                &target,
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
                &source.route_version_id,
                &target.route_version_id,
                formation_length_mm,
            );
            let mut transfer_legs = Vec::with_capacity(
                raw.legs
                    .len()
                    .saturating_add(source_seed.len())
                    .saturating_add(target_seed.len()),
            );
            transfer_legs.extend(source_seed);
            transfer_legs.extend(raw.legs.iter().cloned());
            transfer_legs.extend(target_seed.iter().cloned());
            let transfer = TimetableRouteInput {
                route_version_id: transfer_route_id.clone(),
                template_id: transfer_template_id,
                predecessor_id: Some(source.route_version_id.clone()),
                transition_route_mm: Some(formation_length_mm),
                legs: transfer_legs,
            };
            validate_derived_route(&transaction, &transfer)?;

            let mut target_outbound_legs = target_seed;
            target_outbound_legs.extend(target_remainder);
            require(
                target_outbound_legs.len() >= 2,
                format!(
                    "Transferzielroute `{}` besitzt keine Bewegung hinter dem Formation-Seed.",
                    target.route_version_id
                ),
            )?;
            let target_outbound = TimetableRouteInput {
                route_version_id: target_outbound_route_id.clone(),
                template_id: target_outbound_template_id,
                predecessor_id: Some(transfer_route_id.clone()),
                transition_route_mm: Some(formation_length_mm),
                legs: target_outbound_legs,
            };
            validate_derived_route(&transaction, &target_outbound)?;

            let (transfer_dispatch, movement_resources) = generate_movement_route_artifacts(
                &transaction,
                &source,
                &transfer,
                &input.movement_kind,
                formation_length_mm,
                MovementContinuity::SameDirection,
                GeneratedMovementArtifacts {
                    interlocking: &mut generated_interlocking,
                    signals: &mut generated_signals,
                    resources: &mut generated_resources,
                },
            )?;
            let (target_outbound_dispatch, _) = generate_train_route_artifacts(
                &transaction,
                &transfer,
                &target_outbound,
                formation_length_mm,
                MovementContinuity::SameDirection,
                GeneratedMovementArtifacts {
                    interlocking: &mut generated_interlocking,
                    signals: &mut generated_signals,
                    resources: &mut generated_resources,
                },
                "Transfer-Zielausgangsfahrstrasse",
            )?;
            let window_ms = input.available_window_s.checked_mul(1_000).ok_or_else(|| {
                GermanyOperationalV2Error::new("Transfer-Zeitfenster laeuft ueber.")
            })?;
            require(
                transfer_dispatch.minimum_runtime_ms <= window_ms,
                format!(
                    "Transferanforderung `{}` braucht {} ms, besitzt aber nur {window_ms} ms.",
                    input.id, transfer_dispatch.minimum_runtime_ms
                ),
            )?;
            for route in [&transfer, &target_outbound] {
                add_generated_route_resources(&transaction, route, &mut generated_resources)?;
                insert_generated(
                    &mut generated_routes,
                    route.route_version_id.clone(),
                    route,
                    "Transfer-Laufweg",
                )?;
            }
            let record = TransferTemplateRecord {
                id: record_id.clone(),
                demand_id: input.id.clone(),
                formation_length_mm,
                source_passenger_route_version_id: source.route_version_id.clone(),
                target_passenger_route_version_id: target.route_version_id.clone(),
                source_location_id: input.source_location_id.clone(),
                target_location_id: input.target_location_id.clone(),
                earliest_departure_s: input.earliest_departure_s,
                latest_arrival_s: input.latest_arrival_s,
                available_window_s: input.available_window_s,
                movement_kind: input.movement_kind.clone(),
                transfer: transfer_dispatch,
                target_outbound: target_outbound_dispatch,
                resource_set_sha256: resource_set_sha256(&movement_resources),
                resource_ids: movement_resources,
            };
            insert_generated(
                &mut generated_templates,
                record_id,
                &record,
                "Transfer-Template",
            )?;
        }
    }
    drop(routes);
    drop(transaction);

    let mut write = database.begin_write().map_err(db_error)?;
    write.set_durability(Durability::None);
    for (definition, values, context) in [
        (TRANSFER_ROUTES, &generated_routes, "Transfer-Laufweg"),
        (
            TRANSFER_INTERLOCKING,
            &generated_interlocking,
            "Transfer-Fahrstrasse",
        ),
        (
            TRANSFER_TEMPLATES,
            &generated_templates,
            "Transfer-Template",
        ),
    ] {
        let mut table = write.open_table(definition).map_err(db_error)?;
        for (id, serialized) in values {
            require(
                table
                    .insert(id.as_str(), serialized.as_str())
                    .map_err(db_error)?
                    .is_none(),
                format!("Doppelte {context}-ID `{id}`."),
            )?;
        }
    }
    {
        let mut signals = write.open_table(SIGNALS).map_err(db_error)?;
        for id in generated_signals {
            let _ = signals.insert(id.as_str(), &()).map_err(db_error)?;
        }
    }
    {
        let mut resources = write.open_table(BLOCK_RESOURCES).map_err(db_error)?;
        for id in generated_resources {
            let _ = resources.insert(id.as_str(), &()).map_err(db_error)?;
        }
    }
    write.commit().map_err(db_error)
}

fn derive_turnaround_templates(
    database: &Database,
    policy: &PolicySpec,
    required_pairs: Option<&[TurnaroundPairDemand]>,
) -> Result<BTreeSet<(String, String, i64)>> {
    if policy.terminal_formation_lengths_mm.is_empty() {
        return Ok(BTreeSet::new());
    }
    let transaction = database.begin_read().map_err(db_error)?;
    let routes = transaction.open_table(TIMETABLE_ROUTES).map_err(db_error)?;
    require(
        !routes.is_empty().map_err(db_error)?,
        "terminalFormationLengthsMm verlangt einen gepinnten timetableRoutes-Layer.",
    )?;
    let mut generated_routes = BTreeMap::<String, String>::new();
    let mut generated_interlocking = BTreeMap::<String, String>::new();
    let mut generated_templates = BTreeMap::<String, String>::new();
    let mut generated_signals = BTreeSet::<String>::new();
    let mut generated_resources = BTreeSet::<String>::new();
    let mut covered = BTreeSet::new();
    let required_by_inbound = required_pairs.map(|pairs| {
        let mut result = BTreeMap::<String, BTreeSet<String>>::new();
        for pair in pairs {
            result
                .entry(pair.inbound_route_version_id.clone())
                .or_default()
                .insert(pair.outbound_route_version_id.clone());
        }
        result
    });

    for entry in routes.iter().map_err(db_error)? {
        let (_, serialized) = entry.map_err(db_error)?;
        let inbound = route_from_json(serialized.value(), "Ankunfts-Personenlaufweg")?;
        let required_outbound = required_by_inbound
            .as_ref()
            .and_then(|pairs| pairs.get(&inbound.route_version_id));
        if required_by_inbound.is_some() && required_outbound.is_none() {
            continue;
        }
        let inbound_terminal_leg = inbound
            .legs
            .last()
            .ok_or_else(|| GermanyOperationalV2Error::new("Ankunftslaufweg ist leer."))?;
        let terminal_track = get_track(&transaction, &inbound_terminal_leg.edge_id)?;
        let Some(terminal_node_id) =
            node_at_offset(&terminal_track, inbound_terminal_leg.edge_exit_mm)
        else {
            // Ein Halt innerhalb einer realen Kante kann eine Direct-Kontinuitaet
            // besitzen. Eine Abstellpfadsuche darf dort jedoch keinen OSM-Knoten
            // erfinden; fehlt auch Direct, schliesst das gemeinsame Coverage-Gate.
            continue;
        };
        if !terminal_has_observed_siding_entry(&transaction, &terminal_track.id, terminal_node_id)?
        {
            continue;
        }
        let outbound_routes =
            outbound_routes_for_terminal(&transaction, &inbound, inbound_terminal_leg)?
                .into_iter()
                .filter(|outbound| {
                    required_outbound.is_none_or(|ids| ids.contains(&outbound.route_version_id))
                })
                .collect::<Vec<_>>();
        if outbound_routes.is_empty() {
            continue;
        }

        for &formation_length_mm in &policy.terminal_formation_lengths_mm {
            let inbound_seed = formation_tail_legs(
                &inbound,
                formation_length_mm,
                &format!(
                    "Ankunftslaufweg `{}` fuer Formation {formation_length_mm}",
                    inbound.route_version_id
                ),
            )?;
            let terminal_intervals = terminal_intervals(&inbound_seed);
            let reversed_inbound_occupancy = canonical_terminal_occupancy(&inbound_seed, true);
            let candidates = stabling_candidates(
                &transaction,
                &terminal_track,
                terminal_node_id,
                formation_length_mm,
                policy.minimum_berth_end_clearance_mm,
                &inbound.route_version_id,
            )?;
            if candidates.is_empty() {
                continue;
            }

            for outbound_base in &outbound_routes {
                let outbound_first = outbound_base
                    .legs
                    .first()
                    .ok_or_else(|| GermanyOperationalV2Error::new("Ausgangslaufweg ist leer."))?;
                let (outbound_seed, outbound_remainder) = formation_prefix_and_remainder(
                    outbound_base,
                    formation_length_mm,
                    &format!("Ausgangslaufweg `{}`", outbound_base.route_version_id),
                )?;
                if outbound_first.edge_id != terminal_track.id
                    || outbound_first.direction
                        != reverse_direction(&inbound_terminal_leg.direction)?
                    || outbound_first.edge_entry_mm != inbound_terminal_leg.edge_exit_mm
                    || canonical_terminal_occupancy(&outbound_seed, false)
                        != reversed_inbound_occupancy
                {
                    continue;
                }

                for (candidate_rank, candidate) in candidates.iter().enumerate() {
                    let (
                        shunt_in_route_id,
                        shunt_in_template_id,
                        shunt_out_route_id,
                        shunt_out_template_id,
                        outbound_route_id,
                        outbound_template_id,
                        turnaround_id,
                    ) = generated_route_ids(
                        &inbound.route_version_id,
                        &outbound_base.route_version_id,
                        formation_length_mm,
                        candidate,
                    );
                    let berth_edge = &candidate
                        .path
                        .last()
                        .expect("Abstellpfad besitzt eine Zielkante")
                        .track;
                    let berth_from_mm = berth_edge
                        .length_mm
                        .checked_sub(formation_length_mm)
                        .ok_or_else(|| {
                            GermanyOperationalV2Error::new("Berth-Laenge laeuft ueber.")
                        })?
                        / 2;
                    let berth_to_mm =
                        berth_from_mm
                            .checked_add(formation_length_mm)
                            .ok_or_else(|| {
                                GermanyOperationalV2Error::new("Berth-Ende laeuft ueber.")
                            })?;
                    let berth = TurnaroundBerth {
                        edge_id: berth_edge.id.clone(),
                        from_mm: berth_from_mm,
                        to_mm: berth_to_mm,
                        left_clearance_mm: berth_from_mm,
                        right_clearance_mm: berth_edge.length_mm - berth_to_mm,
                    };
                    require(
                        berth.left_clearance_mm >= policy.minimum_berth_end_clearance_mm
                            && berth.right_clearance_mm >= policy.minimum_berth_end_clearance_mm,
                        format!("Abstellkante `{}` ist zu kurz.", berth.edge_id),
                    )?;

                    let mut shunt_in_legs = inbound_seed.clone();
                    for (index, directed) in candidate.path.iter().enumerate() {
                        let (entry_mm, full_exit_mm) =
                            directed_offsets(&directed.track, &directed.direction)?;
                        let exit_mm = if index + 1 == candidate.path.len() {
                            if directed.direction == "along" {
                                berth.to_mm
                            } else {
                                berth.from_mm
                            }
                        } else {
                            full_exit_mm
                        };
                        shunt_in_legs.push(derived_leg(
                            &directed.track,
                            &directed.direction,
                            entry_mm,
                            exit_mm,
                        ));
                    }
                    let shunt_in = TimetableRouteInput {
                        route_version_id: shunt_in_route_id.clone(),
                        template_id: shunt_in_template_id,
                        predecessor_id: Some(inbound.route_version_id.clone()),
                        transition_route_mm: Some(formation_length_mm),
                        legs: shunt_in_legs,
                    };
                    validate_derived_route(&transaction, &shunt_in)?;

                    let berth_direction = candidate
                        .path
                        .last()
                        .expect("Abstellpfad besitzt Zielkante")
                        .direction
                        .as_str();
                    let reverse_berth_direction = reverse_direction(berth_direction)?;
                    let (shunt_out_seed_entry, shunt_out_seed_exit) =
                        if reverse_berth_direction == "along" {
                            (berth.from_mm, berth.to_mm)
                        } else {
                            (berth.to_mm, berth.from_mm)
                        };
                    let mut shunt_out_legs = vec![derived_leg(
                        berth_edge,
                        reverse_berth_direction,
                        shunt_out_seed_entry,
                        shunt_out_seed_exit,
                    )];
                    let berth_terminal_exit = if reverse_berth_direction == "along" {
                        berth_edge.length_mm
                    } else {
                        0
                    };
                    shunt_out_legs.push(derived_leg(
                        berth_edge,
                        reverse_berth_direction,
                        shunt_out_seed_exit,
                        berth_terminal_exit,
                    ));
                    for directed in candidate.path.iter().rev().skip(1) {
                        let direction = reverse_direction(&directed.direction)?;
                        let (entry_mm, exit_mm) = directed_offsets(&directed.track, direction)?;
                        shunt_out_legs.push(derived_leg(
                            &directed.track,
                            direction,
                            entry_mm,
                            exit_mm,
                        ));
                    }
                    let outbound_direction = outbound_first.direction.as_str();
                    shunt_out_legs.extend(outbound_seed.iter().cloned());
                    let shunt_out = TimetableRouteInput {
                        route_version_id: shunt_out_route_id.clone(),
                        template_id: shunt_out_template_id,
                        predecessor_id: Some(shunt_in_route_id.clone()),
                        transition_route_mm: Some(formation_length_mm),
                        legs: shunt_out_legs,
                    };
                    validate_derived_route(&transaction, &shunt_out)?;

                    let mut outbound_legs = outbound_seed.clone();
                    outbound_legs.extend(outbound_remainder.iter().cloned());
                    require(
                        outbound_legs.len() >= 2,
                        format!(
                            "Ausgangslaufweg `{}` endet bereits am Formation-Seed.",
                            outbound_base.route_version_id
                        ),
                    )?;
                    let outbound = TimetableRouteInput {
                        route_version_id: outbound_route_id.clone(),
                        template_id: outbound_template_id,
                        predecessor_id: Some(shunt_out_route_id.clone()),
                        transition_route_mm: Some(formation_length_mm),
                        legs: outbound_legs,
                    };
                    validate_derived_route(&transaction, &outbound)?;

                    let (shunt_in_interlocking_id, shunt_in_interlocking) =
                        shunting_template_value(&transaction, &shunt_in, formation_length_mm)?;
                    let (shunt_out_interlocking_id, shunt_out_interlocking) =
                        shunting_template_value(&transaction, &shunt_out, formation_length_mm)?;
                    let mut outbound_dispatch = None;
                    for leg_index in 0..outbound.legs.len() {
                        let authority_start = outbound
                            .legs
                            .iter()
                            .take(leg_index)
                            .try_fold(0_i64, |total, leg| {
                                total.checked_add(
                                    i64::try_from(leg.edge_entry_mm.abs_diff(leg.edge_exit_mm))
                                        .unwrap_or(i64::MAX),
                                )
                            })
                            .ok_or_else(|| {
                                GermanyOperationalV2Error::new(
                                    "Ausgangssegmentanfang laeuft ueber.",
                                )
                            })?;
                        let (id, value, _) =
                            template_value(&transaction, &outbound, leg_index, authority_start)?;
                        if authority_start == formation_length_mm {
                            outbound_dispatch =
                                Some((id.clone(), resources_from_template_value(&value)?));
                        }
                        generated_signals.insert(
                            value["signalId"]
                                .as_str()
                                .expect("synthetische Signal-ID")
                                .to_owned(),
                        );
                        generated_resources.extend(resources_from_template_value(&value)?);
                        insert_generated(
                            &mut generated_interlocking,
                            id,
                            &value,
                            "Ausgangs-Segmentfahrstrasse",
                        )?;
                    }
                    let (outbound_interlocking_id, outbound_resources) =
                        outbound_dispatch.ok_or_else(|| {
                            GermanyOperationalV2Error::new(format!(
                                "Ausgangslaufweg `{}` besitzt bei Formationlaenge keine erste Fahrstrasse.",
                                outbound.route_version_id
                            ))
                        })?;
                    let shunt_in_runtime_ms =
                        minimum_route_runtime_ms(&transaction, &shunt_in, formation_length_mm)?;
                    let shunt_out_runtime_ms =
                        minimum_route_runtime_ms(&transaction, &shunt_out, formation_length_mm)?;
                    let outbound_runtime_ms =
                        minimum_route_runtime_ms(&transaction, &outbound, formation_length_mm)?;
                    let shunt_in_resources = resources_from_template_value(&shunt_in_interlocking)?;
                    let shunt_out_resources =
                        resources_from_template_value(&shunt_out_interlocking)?;
                    generated_resources.extend(shunt_in_resources.iter().cloned());
                    generated_resources.extend(shunt_out_resources.iter().cloned());
                    generated_signals.insert(
                        shunt_in_interlocking["signalId"]
                            .as_str()
                            .expect("Rangiersignal-ID")
                            .to_owned(),
                    );
                    generated_signals.insert(
                        shunt_out_interlocking["signalId"]
                            .as_str()
                            .expect("Rangiersignal-ID")
                            .to_owned(),
                    );
                    insert_generated(
                        &mut generated_interlocking,
                        shunt_in_interlocking_id.clone(),
                        &shunt_in_interlocking,
                        "Rangierfahrstrasse zur Abstellung",
                    )?;
                    insert_generated(
                        &mut generated_interlocking,
                        shunt_out_interlocking_id.clone(),
                        &shunt_out_interlocking,
                        "Rangierfahrstrasse aus der Abstellung",
                    )?;
                    for route in [&shunt_in, &shunt_out, &outbound] {
                        for leg in &route.legs {
                            let track = get_track(&transaction, &leg.edge_id)?;
                            generated_resources
                                .insert(boundary_resource(&track, leg.edge_entry_mm)?);
                            generated_resources
                                .insert(boundary_resource(&track, leg.edge_exit_mm)?);
                        }
                        insert_generated(
                            &mut generated_routes,
                            route.route_version_id.clone(),
                            route,
                            "Turnaround-Laufweg",
                        )?;
                    }
                    let candidate_rank = u32::try_from(candidate_rank).map_err(|_| {
                        GermanyOperationalV2Error::new("Zu viele Abstellkandidaten.")
                    })?;
                    let record = TurnaroundTemplateRecord {
                        id: turnaround_id.clone(),
                        inbound_route_version_id: inbound.route_version_id.clone(),
                        outbound_route_version_id: outbound_base.route_version_id.clone(),
                        terminal_edge_id: terminal_track.id.clone(),
                        terminal_node_id,
                        inbound_direction: inbound_terminal_leg.direction.clone(),
                        outbound_direction: outbound_direction.to_owned(),
                        formation_length_mm,
                        candidate_rank,
                        stabling_path_length_mm: candidate.total_length_mm,
                        terminal_intervals: terminal_intervals.clone(),
                        shunt_in: TurnaroundRouteDispatch {
                            route_version_id: shunt_in_route_id,
                            predecessor_base_route_version_id: inbound.route_version_id.clone(),
                            continuity: require_movement_continuity(
                                &inbound,
                                &shunt_in,
                                formation_length_mm,
                                MovementContinuity::SameDirection,
                            )?,
                            dispatch_interlocking_route_id: shunt_in_interlocking_id,
                            head_route_mm: formation_length_mm,
                            minimum_runtime_ms: shunt_in_runtime_ms,
                            resource_ids: shunt_in_resources,
                            route_leg_count: u32::try_from(shunt_in.legs.len()).map_err(|_| {
                                GermanyOperationalV2Error::new("Zu viele Shunt-in-Legs.")
                            })?,
                            protection_contract_runs: protection_contract_runs(&shunt_in.legs)?,
                        },
                        berth: berth.clone(),
                        shunt_out: TurnaroundRouteDispatch {
                            route_version_id: shunt_out_route_id,
                            predecessor_base_route_version_id: shunt_in.route_version_id.clone(),
                            continuity: require_movement_continuity(
                                &shunt_in,
                                &shunt_out,
                                formation_length_mm,
                                MovementContinuity::ReverseDirection,
                            )?,
                            dispatch_interlocking_route_id: shunt_out_interlocking_id,
                            head_route_mm: formation_length_mm,
                            minimum_runtime_ms: shunt_out_runtime_ms,
                            resource_ids: shunt_out_resources,
                            route_leg_count: u32::try_from(shunt_out.legs.len()).map_err(|_| {
                                GermanyOperationalV2Error::new("Zu viele Shunt-out-Legs.")
                            })?,
                            protection_contract_runs: protection_contract_runs(&shunt_out.legs)?,
                        },
                        outbound: TurnaroundRouteDispatch {
                            route_version_id: outbound_route_id,
                            predecessor_base_route_version_id: shunt_out.route_version_id.clone(),
                            continuity: require_movement_continuity(
                                &shunt_out,
                                &outbound,
                                formation_length_mm,
                                MovementContinuity::SameDirection,
                            )?,
                            dispatch_interlocking_route_id: outbound_interlocking_id,
                            head_route_mm: formation_length_mm,
                            minimum_runtime_ms: outbound_runtime_ms,
                            resource_ids: outbound_resources,
                            route_leg_count: u32::try_from(outbound.legs.len()).map_err(|_| {
                                GermanyOperationalV2Error::new("Zu viele Ausgangsroute-Legs.")
                            })?,
                            protection_contract_runs: protection_contract_runs(&outbound.legs)?,
                        },
                    };
                    insert_generated(
                        &mut generated_templates,
                        turnaround_id,
                        &record,
                        "Turnaround-Template",
                    )?;
                    covered.insert((
                        inbound.route_version_id.clone(),
                        outbound_base.route_version_id.clone(),
                        formation_length_mm,
                    ));
                }
            }
        }
    }
    drop(routes);
    drop(transaction);

    let mut write = database.begin_write().map_err(db_error)?;
    write.set_durability(Durability::None);
    {
        let mut routes = write.open_table(TURNAROUND_ROUTES).map_err(db_error)?;
        for (id, serialized) in &generated_routes {
            require(
                routes
                    .insert(id.as_str(), serialized.as_str())
                    .map_err(db_error)?
                    .is_none(),
                format!("Doppelte Turnaround-Laufweg-ID `{id}`."),
            )?;
        }
    }
    {
        let mut interlocking = write
            .open_table(TURNAROUND_INTERLOCKING)
            .map_err(db_error)?;
        for (id, serialized) in &generated_interlocking {
            require(
                interlocking
                    .insert(id.as_str(), serialized.as_str())
                    .map_err(db_error)?
                    .is_none(),
                format!("Doppelte Turnaround-Fahrstrassen-ID `{id}`."),
            )?;
        }
    }
    {
        let mut templates = write.open_table(TURNAROUND_TEMPLATES).map_err(db_error)?;
        for (id, serialized) in &generated_templates {
            require(
                templates
                    .insert(id.as_str(), serialized.as_str())
                    .map_err(db_error)?
                    .is_none(),
                format!("Doppelte Turnaround-Template-ID `{id}`."),
            )?;
        }
    }
    {
        let mut signals = write.open_table(SIGNALS).map_err(db_error)?;
        for signal in &generated_signals {
            require(
                signals
                    .insert(signal.as_str(), &())
                    .map_err(db_error)?
                    .is_none(),
                format!("Kollidierende Turnaround-Signal-ID `{signal}`."),
            )?;
        }
    }
    {
        let mut resources = write.open_table(BLOCK_RESOURCES).map_err(db_error)?;
        for resource in &generated_resources {
            let _ = resources.insert(resource.as_str(), &()).map_err(db_error)?;
        }
    }
    write.commit().map_err(db_error)?;
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

fn string_table_values(
    transaction: &redb::ReadTransaction,
    definition: TableDefinition<&str, &str>,
    context: &str,
) -> Result<Vec<Value>> {
    let table = transaction.open_table(definition).map_err(db_error)?;
    let mut values =
        Vec::with_capacity(usize::try_from(table.len().map_err(db_error)?).unwrap_or(0));
    for entry in table.iter().map_err(db_error)? {
        let (_, serialized) = entry.map_err(db_error)?;
        values.push(serde_json::from_str(serialized.value()).map_err(|error| {
            GermanyOperationalV2Error::new(format!(
                "{context} im Ableitungsindex ist ungueltig: {error}"
            ))
        })?);
    }
    Ok(values)
}

fn write_movement_route_sidecar(
    transaction: &redb::ReadTransaction,
    path: &Path,
    infra_release_id: &str,
    operational_state_hash: &str,
    transfer_evidence: Option<&TransferEvidence>,
) -> Result<(u64, String, String)> {
    let direct_templates = string_table_values(transaction, DIRECT_TEMPLATES, "Direct-Template")?;
    let stabling_templates =
        string_table_values(transaction, TURNAROUND_TEMPLATES, "Stabling-Template")?;
    let transfer_templates =
        string_table_values(transaction, TRANSFER_TEMPLATES, "Transfer-Template")?;
    let transfer_set_sha256 = transfer_evidence
        .map(|evidence| Value::String(evidence.transfer_set_sha256.clone()))
        .unwrap_or(Value::Null);
    let body = json!({
        "schema": MOVEMENT_ROUTE_SIDECAR_SCHEMA,
        "infraReleaseId": infra_release_id,
        "operationalStateHash": operational_state_hash,
        "timetableTransferSetSha256": transfer_set_sha256,
        "directTemplates": direct_templates,
        "templates": stabling_templates,
        "transferTemplates": transfer_templates,
        "metrics": {
            "directTemplateCount": direct_templates.len(),
            "stablingTemplateCount": stabling_templates.len(),
            "transferTemplateCount": transfer_templates.len(),
            "transferDemandCount": transfer_evidence.map_or(0, |evidence| evidence.transfer_demand_count),
            "turnaroundDemandCount": transfer_evidence.map_or(0, |evidence| evidence.turnaround_demand_count),
            "turnaroundPairCount": transfer_evidence.map_or(0, |evidence| evidence.turnaround_pair_count),
        },
    });
    let envelope = json!({
        "schema": MOVEMENT_ROUTE_SIDECAR_SCHEMA,
        "value": body,
    });
    let mut canonical_envelope = String::new();
    canonical_json(&envelope, &mut canonical_envelope);
    let state_hash = sha256(canonical_envelope.as_bytes());
    let mut sidecar = body;
    sidecar
        .as_object_mut()
        .expect("Movement-Sidecar-Body ist ein Objekt")
        .insert("stateHash".to_owned(), Value::String(state_hash.clone()));
    exact_keys(
        &sidecar,
        &[
            "schema",
            "infraReleaseId",
            "operationalStateHash",
            "timetableTransferSetSha256",
            "directTemplates",
            "templates",
            "transferTemplates",
            "metrics",
            "stateHash",
        ],
        "movement-route-templates-v2",
    )?;
    let mut canonical_sidecar = String::new();
    canonical_json(&sidecar, &mut canonical_sidecar);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| io_error("Movement-Route-Sidecar", path, error))?;
    let mut writer = BufWriter::new(file);
    write_bytes(
        &mut writer,
        canonical_sidecar.as_bytes(),
        "Movement-Route-Sidecar",
        path,
    )?;
    write_bytes(&mut writer, b"\n", "Movement-Route-Sidecar", path)?;
    writer
        .flush()
        .map_err(|error| io_error("Movement-Route-Sidecar", path, error))?;
    drop(writer);
    let bytes = fs::read(path).map_err(|error| io_error("Movement-Route-Sidecar", path, error))?;
    Ok((
        u64::try_from(bytes.len())
            .map_err(|_| GermanyOperationalV2Error::new("Sidecargroesse laeuft ueber."))?,
        sha256(&bytes),
        state_hash,
    ))
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
    let (sidecar_bytes, sidecar_sha256, sidecar_state_hash) = write_movement_route_sidecar(
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
    });
    let timetable_route_evidence = transfer_evidence.as_ref().map(|evidence| {
        json!({
            "timetableRoutes": timetable_evidence,
            "transferDemands": evidence.file,
            "dailyPlanSha256": evidence.daily_plan_sha256,
            "transferSetSha256": evidence.transfer_set_sha256,
            "circulationCount": evidence.circulation_count,
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
            },
        },
        "scope": {
            "routeModel": route_coverage,
            "interlockingModel": "deterministic-linear-segment-node-stellzone-mutex-and-progressive-authority/v3",
            "platformModel": "deterministic-nearest-observed-track-within-policy-radius/v1",
            "capacityBias": "conservative-under-capacity",
            "minimumOverlapMmPolicy": spec.policy.minimum_overlap_mm,
            "turnaroundModel": "real-osm-simple-bidirectional-siding-path-with-centered-single-berth-per-target-edge/v1",
            "minimumBerthEndClearanceMmPolicy": spec.policy.minimum_berth_end_clearance_mm,
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
        MovementContinuity, ScratchDirectory, TimetableLegInput, TimetableRouteInput,
        TurnaroundRouteDispatch, ensure_output_absent, publish_create_new, publish_pair_create_new,
        require_movement_continuity,
    };
    use std::fs;

    use serde_json::json;

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
