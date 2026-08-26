//! Autoritative öffentliche InfraRelease- und Jahresplanbildung (E5/M1.12).
//!
//! Dateizugriff und Prozessstart dürfen außerhalb dieses Moduls orchestriert
//! werden. Schema-, Rechte-, Qualitäts- und Freigabeentscheidung liegen hier
//! im Rust-Kern der Release-Pipeline.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::Path;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use zugfolge_sim::operational::OperationalInfraRelease;

const SHA256_LENGTH: usize = 64;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA: &str = "operational-infrastructure-v2";

/// Fehler einer autoritativen Manifestentscheidung.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseManifestError(String);

impl ReleaseManifestError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ReleaseManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ReleaseManifestError {}

type Result<T> = std::result::Result<T, ReleaseManifestError>;

fn require(condition: bool, message: impl Into<String>) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(ReleaseManifestError::new(message))
    }
}

fn non_empty(value: &str) -> bool {
    !value.trim().is_empty()
}

fn is_sha256(value: &str) -> bool {
    value.len() == SHA256_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => output.push_str(
            &serde_json::to_string(value).expect("eine Zeichenkette ist immer serialisierbar"),
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .expect("ein JSON-Objektschlüssel ist immer serialisierbar"),
                );
                output.push(':');
                canonical(&values[key], output);
            }
            output.push('}');
        }
    }
}

fn sha256(value: &Value) -> String {
    let mut serialized = String::new();
    canonical(value, &mut serialized);
    let digest = Sha256::digest(serialized.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn domain_separated_sha256(schema: &str, value: &Value) -> String {
    sha256(&json!({ "schema": schema, "value": value }))
}

fn require_safe_integers(value: &Value) -> Result<()> {
    match value {
        Value::Number(number) => require(
            number
                .as_i64()
                .is_some_and(|value| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value)),
            "Statische Operational-v2-Infrastruktur enthält keine sichere kanonische Ganzzahl.",
        ),
        Value::Array(values) => values.iter().try_for_each(require_safe_integers),
        Value::Object(values) => values.values().try_for_each(require_safe_integers),
        _ => Ok(()),
    }
}

fn operational_infrastructure_v2_state_hash(
    value: &Value,
    expected_release_id: &str,
) -> Result<String> {
    require_safe_integers(value)?;
    let infrastructure: OperationalInfraRelease =
        serde_json::from_value(value.clone()).map_err(|error| {
            ReleaseManifestError::new(format!(
                "Statische Operational-v2-Infrastruktur ist ungueltig: {error}"
            ))
        })?;
    require(
        infrastructure.id == expected_release_id,
        "Statische Operational-v2-Infrastruktur verletzt die InfraRelease-ID-Bindung.",
    )?;
    infrastructure.validate().map_err(|error| {
        ReleaseManifestError::new(format!(
            "Statische Operational-v2-Infrastruktur verletzt den nativen Runtimevertrag: {error}"
        ))
    })?;
    let canonical_infrastructure = serde_json::to_value(&infrastructure).map_err(|error| {
        ReleaseManifestError::new(format!(
            "Statische Operational-v2-Infrastruktur kann nicht kanonisiert werden: {error}"
        ))
    })?;
    require(
        &canonical_infrastructure == value,
        "Statische Operational-v2-Infrastruktur ist nicht in der kanonischen nativen Darstellung.",
    )?;
    Ok(domain_separated_sha256(
        OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA,
        &canonical_infrastructure,
    ))
}

/// Validiert einen weltfreien Operational-v2-Infrastrukturkandidaten mit dem
/// identischen typisierten Vertrag wie die Runtime und liefert seine
/// domänengetrennte kanonische Bindung.
pub fn validate_operational_infrastructure_v2(
    value: &Value,
    expected_release_id: &str,
) -> Result<Value> {
    require(
        non_empty(expected_release_id),
        "Erwartete InfraRelease-ID fehlt.",
    )?;
    let state_hash = operational_infrastructure_v2_state_hash(value, expected_release_id)?;
    Ok(json!({
        "schema": OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA,
        "infraReleaseId": expected_release_id,
        "stateHash": state_hash,
    }))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path).map_err(|error| {
        ReleaseManifestError::new(format!(
            "Datei {} kann nicht gelesen werden: {error}",
            path.display()
        ))
    })?;
    Ok(sha256_bytes(&bytes))
}

fn read_json(path: &Path, what: &str) -> Result<Value> {
    let bytes = fs::read(path).map_err(|error| {
        ReleaseManifestError::new(format!(
            "{what} {} kann nicht gelesen werden: {error}",
            path.display()
        ))
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        ReleaseManifestError::new(format!(
            "{what} {} ist kein gueltiges JSON: {error}",
            path.display()
        ))
    })
}

fn file_descriptor(root: &Path, file: &str, extra: Value) -> Result<Value> {
    let path = root.join(file);
    let metadata = fs::metadata(&path).map_err(|error| {
        ReleaseManifestError::new(format!("Datei {} fehlt: {error}", path.display()))
    })?;
    require(
        metadata.is_file(),
        format!("{} ist keine Datei.", path.display()),
    )?;
    let mut descriptor = extra.as_object().cloned().unwrap_or_default();
    descriptor.insert("file".into(), Value::String(file.into()));
    descriptor.insert("bytes".into(), Value::Number(metadata.len().into()));
    descriptor.insert("sha256".into(), Value::String(sha256_file(&path)?));
    Ok(Value::Object(descriptor))
}

fn repository_file_descriptor(root: &Path, relative: &str) -> Result<Value> {
    Ok(json!({
        "path": relative.replace('\\', "/"),
        "sha256": sha256_file(&root.join(relative))?,
    }))
}

fn pointer<'a>(value: &'a Value, path: &str, what: &str) -> Result<&'a Value> {
    value
        .pointer(path)
        .ok_or_else(|| ReleaseManifestError::new(format!("{what} fehlt ({path}).")))
}

fn pointer_string<'a>(value: &'a Value, path: &str, what: &str) -> Result<&'a str> {
    pointer(value, path, what)?
        .as_str()
        .filter(|text| non_empty(text))
        .ok_or_else(|| ReleaseManifestError::new(format!("{what} ist ungueltig ({path}).")))
}

fn pointer_i64(value: &Value, path: &str, what: &str) -> Result<i64> {
    pointer(value, path, what)?
        .as_i64()
        .ok_or_else(|| ReleaseManifestError::new(format!("{what} ist ungueltig ({path}).")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GermanyConfig {
    schema: String,
    release: GermanyReleaseConfig,
    pipeline: PipelineConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GermanyReleaseConfig {
    release_id: String,
    timetable_year: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PipelineConfig {
    version: String,
    official_adapters: OfficialAdapters,
    post_processors: PostProcessors,
    operational_deriver: Option<OperationalDeriverConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OperationalDeriverConfig {
    entrypoint: String,
    specification: String,
    candidate: String,
    report: String,
    output: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficialAdapters {
    db_infra_go_geo_package: Adapter,
    open_station_netex: Adapter,
    copernicus_dem_glo30: DemAdapter,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Adapter {
    source_id: String,
    entrypoint: String,
    outputs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemAdapter {
    source_id: String,
    rights_source_id: String,
    entrypoint: String,
    sampling_policy: DemSamplingPolicy,
    outputs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemSamplingPolicy {
    interval_mm: i64,
    minimum_baseline_mm: i64,
    analysis_window_mm: i64,
    maximum_absolute_gradient_permille: i64,
    maximum_uncertainty_permille: i64,
    class_a_eligible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PostProcessors {
    merge_track_gradient: GradientMerge,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GradientMerge {
    entrypoint: String,
    join_key: String,
    geometry_must_match: bool,
    existing_properties_preserved: bool,
    output: String,
    report: String,
}

#[derive(Debug, Deserialize)]
struct SourceCatalog {
    schema: String,
    sources: Vec<CatalogSource>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogSource {
    id: String,
    rights_source_id: String,
    role: SourceRole,
    source_license: String,
    ship_attribution: bool,
    #[serde(default)]
    attribution: String,
    #[serde(default)]
    modifications: String,
    class_a_eligible: Option<bool>,
    #[serde(default)]
    forbidden_shipping_tokens: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum SourceRole {
    ReleaseInput,
    OptionalReleaseInput,
    InternalValidation,
}

#[derive(Debug, Deserialize)]
struct RightsRegistry {
    version: i64,
    quellen: Vec<RightsSource>,
}

#[derive(Debug, Deserialize)]
struct RightsSource {
    id: String,
    status: String,
    entscheidung: Option<RightsDecision>,
}

#[derive(Debug, Deserialize)]
struct RightsDecision {
    datum: String,
    pruefer: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureManifest {
    schema: String,
    release_id: Option<String>,
    timetable_year: Option<i64>,
    capture_plan_sha256: Option<String>,
    captured_at: String,
    internal_evidence_ledger_sha256: Option<String>,
    sources: Vec<CapturedSource>,
}

#[derive(Debug, Deserialize)]
struct CapturedSource {
    id: String,
    version: String,
    file: String,
    bytes: i64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct Artifact {
    id: String,
    file: String,
    bytes: i64,
    sha256: String,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

fn validate_operational_infrastructure_artifact_binding(
    artifacts: &[Artifact],
    expected_release_id: &str,
) -> Result<()> {
    let bindings: Vec<_> = artifacts
        .iter()
        .filter(|artifact| {
            artifact.extra.get("kind").and_then(Value::as_str)
                == Some(OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA)
        })
        .collect();
    require(
        bindings.len() == 1,
        "Oeffentliches InfraRelease muss genau eine statische Operational-v2-Infrastruktur binden.",
    )?;
    let artifact = bindings[0];
    let allowed: BTreeSet<&str> = BTreeSet::from(["infraReleaseId", "kind", "stateHash"]);
    let actual: BTreeSet<&str> = artifact.extra.keys().map(String::as_str).collect();
    require(
        actual == allowed,
        "Operational-v2-Infrastrukturartefakt besitzt unbekannte oder weltbezogene Manifestfelder.",
    )?;
    require(
        artifact.file == "operational-infrastructure-v2.json",
        "Operational-v2-Infrastrukturartefakt besitzt keinen kanonischen Dateinamen.",
    )?;
    require(
        artifact.extra.get("infraReleaseId").and_then(Value::as_str) == Some(expected_release_id),
        "Operational-v2-Infrastrukturartefakt verletzt die InfraRelease-ID-Bindung.",
    )?;
    let state_hash = artifact
        .extra
        .get("stateHash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    require(
        is_sha256(state_hash),
        "Operational-v2-Infrastrukturartefakt besitzt keinen kanonischen Zustandshash.",
    )?;
    require(
        state_hash != artifact.sha256,
        "Byte-SHA-256 und kanonischer Operational-v2-Zustandshash duerfen nicht gleichgesetzt werden.",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegionalInfraReleaseBuildConfig {
    schema: String,
    release_id: String,
    region_id: String,
    region_variant: String,
    timetable_year: i64,
    service_date: String,
    gtfs_artifact: String,
    operational_infrastructure_artifact: String,
    release_approval: RegionalReleaseApproval,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegionalReleaseApproval {
    release_responsible: String,
    responsibility_granted_by: String,
    activation_allowed: bool,
    activation_authority: String,
}

fn is_calendar_date(value: &str) -> bool {
    if value.len() != 8 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let number = |start: usize, end: usize| {
        value
            .get(start..end)
            .and_then(|part| part.parse::<u32>().ok())
    };
    let (Some(year), Some(month), Some(day)) = (number(0, 4), number(4, 6), number(6, 8)) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    day != 0 && day <= days
}

fn regional_build_config(input: &Value) -> Result<RegionalInfraReleaseBuildConfig> {
    let config: RegionalInfraReleaseBuildConfig =
        serde_json::from_value(input.clone()).map_err(|error| {
            ReleaseManifestError::new(format!("Regionaler Buildvertrag ist ungueltig: {error}"))
        })?;
    require(
        config.schema == "zugfolge-regional-infra-release-build/v2",
        "Regionaler Buildvertrag hat ein unbekanntes Schema.",
    )?;
    require(
        config.region_id == "mitteldeutschland-b" && config.region_variant == "B",
        "Regionaler Buildvertrag verletzt die freigegebene Regionsbindung.",
    )?;
    require(
        is_calendar_date(&config.service_date),
        "serviceDate muss ein gueltiges Kalenderdatum im Format YYYYMMDD sein.",
    )?;
    require(
        config
            .service_date
            .get(0..4)
            .and_then(|year| year.parse::<i64>().ok())
            == Some(config.timetable_year),
        "serviceDate und timetableYear laufen auseinander.",
    )?;
    let release_prefix = format!("infra-mitteldeutschland-b-{}.", config.timetable_year);
    let release_revision = config.release_id.strip_prefix(&release_prefix);
    require(
        release_revision.is_some_and(|revision| {
            !revision.is_empty()
                && !revision.starts_with('0')
                && revision.bytes().all(|byte| byte.is_ascii_digit())
        }),
        "releaseId muss eine positive versionierte Mitteldeutschland-Freigabe desselben Fahrplanjahres sein.",
    )?;
    let expected_gtfs = format!("gtfs-region-{}-v2.json", config.service_date);
    require(
        config.gtfs_artifact == expected_gtfs && safe_relative_path(&config.gtfs_artifact),
        format!("gtfsArtifact muss exakt {expected_gtfs} sein."),
    )?;
    require(
        config.operational_infrastructure_artifact == "operational-infrastructure-v2.json"
            && safe_relative_path(&config.operational_infrastructure_artifact),
        "operationalInfrastructureArtifact muss exakt operational-infrastructure-v2.json sein.",
    )?;
    require(
        non_empty(&config.release_approval.release_responsible)
            && non_empty(&config.release_approval.responsibility_granted_by)
            && config.release_approval.activation_allowed
            && config.release_approval.activation_authority == "game-system-only",
        "Releasefreigabe fehlt oder erlaubt keine Aktivierung durch das Spielsystem.",
    )?;
    Ok(config)
}

const LEGACY_PIPELINE_FILES: [&str; 18] = [
    "tools/region-import/import-mitteldeutschland-b.sh",
    "tools/region-import/import-mitteldeutschland-b.ps1",
    "tools/region-import/build-gtfs-region.mjs",
    "tools/region-import/service-scope.mjs",
    "tools/region-import/build-operational-network.mjs",
    "tools/region-import/operational-network.mjs",
    "tools/region-import/map-layers.mjs",
    "tools/region-import/build-map-layers.mjs",
    "tools/region-import/validation-set.mjs",
    "tools/region-import/build-validation-set.mjs",
    "tools/region-import/build-infra-release.mjs",
    "tools/region-import/regional-release-contract.mjs",
    "tools/region-import/operational-infrastructure-binding.mjs",
    "tools/region-import/materialize-operational-infrastructure-v2.mjs",
    "tools/region-import/release-crypto.mjs",
    "tools/region-import/sign-release.mjs",
    "tools/region-import/verify-release.mjs",
    "crates/zugfolge-infra/examples/pbf_release_report.rs",
];

/// Baut den von der Alpha-Laufzeit konsumierten regionalen Release.
///
/// Releasekennung, Verkehrstag, GTFS-Artefakt und Freigabe kommen aus einem
/// expliziten, strikt dekodierten Buildvertrag. Die Pfade sind reine Eingaben
/// des Orchestrators. Dateiinventar, fachliche Qualifikation und Manifest
/// entstehen vollständig in Rust, damit der Einstieg ADR-0005 einhält.
pub fn build_mitteldeutschland_infra_release(
    build_config: &Value,
    workspace_root: &Path,
    source_root: &Path,
    artifact_root: &Path,
) -> Result<Value> {
    let config = regional_build_config(build_config)?;
    let gtfs = read_json(
        &artifact_root.join(&config.gtfs_artifact),
        "GTFS-Planungssnapshot",
    )?;
    let operational = read_json(
        &artifact_root.join("operational-network.json"),
        "Betriebsnetz",
    )?;
    let operational_infrastructure_path =
        artifact_root.join(&config.operational_infrastructure_artifact);
    let operational_infrastructure_metadata =
        fs::symlink_metadata(&operational_infrastructure_path).map_err(|error| {
            ReleaseManifestError::new(format!(
                "Statische Operational-v2-Infrastruktur {} kann nicht geprüft werden: {error}",
                operational_infrastructure_path.display()
            ))
        })?;
    require(
        operational_infrastructure_metadata.file_type().is_file()
            && !operational_infrastructure_metadata.file_type().is_symlink()
            && operational_infrastructure_metadata.len() > 0,
        "Statische Operational-v2-Infrastruktur ist keine nichtleere reguläre Datei.",
    )?;
    let operational_infrastructure = read_json(
        &operational_infrastructure_path,
        "statische Operational-v2-Infrastruktur",
    )?;
    let operational_infrastructure_state_hash =
        operational_infrastructure_v2_state_hash(&operational_infrastructure, &config.release_id)?;
    let operational_infrastructure_byte_hash = sha256_file(&operational_infrastructure_path)?;
    require(
        operational_infrastructure_byte_hash != operational_infrastructure_state_hash,
        "Byte-SHA-256 und kanonischer Operational-v2-Zustandshash duerfen nicht gleichgesetzt werden.",
    )?;
    let pbf = read_json(
        &artifact_root.join("pbf-release-report.json"),
        "PBF-Releasebericht",
    )?;
    let validation = read_json(
        &artifact_root.join("independent-validation-set.json"),
        "unabhaengiger Validierungssatz",
    )?;

    require(
        pointer_string(&gtfs, "/snapshot/regionId", "GTFS-Region")? == config.region_id
            && pointer_string(&gtfs, "/snapshot/regionVariant", "GTFS-Regionsvariante")?
                == config.region_variant
            && pointer_string(&gtfs, "/snapshot/serviceDate", "GTFS-Verkehrstag")?
                == config.service_date,
        "GTFS-Planungssnapshot und regionaler Buildvertrag laufen auseinander.",
    )?;
    require(
        pointer_string(&operational, "/network/regionId", "Betriebsnetz-Region")?
            == config.region_id
            && pointer_i64(
                &operational,
                "/network/timetableYear",
                "Betriebsnetz-Fahrplanjahr",
            )? == config.timetable_year,
        "Betriebsnetz und regionaler Buildvertrag laufen auseinander.",
    )?;
    let service_date_iso = format!(
        "{}-{}-{}",
        &config.service_date[0..4],
        &config.service_date[4..6],
        &config.service_date[6..8]
    );
    let valid_from = pointer_string(&operational, "/network/validFrom", "Gueltigkeitsbeginn")?;
    let valid_until = pointer_string(&operational, "/network/validUntil", "Gueltigkeitsende")?;
    require(
        valid_from <= service_date_iso.as_str() && service_date_iso.as_str() <= valid_until,
        "serviceDate liegt ausserhalb der Betriebsnetzgueltigkeit.",
    )?;

    require(
        pointer_string(&validation, "/artifact/result", "Validierungsergebnis")? == "passed"
            && pointer(
                &validation,
                "/artifact/selection/calibrationDataUsed",
                "Holdout-Vertrag",
            )?
            .as_bool()
                == Some(false),
        "Der unabhaengige technische Validierungssatz ist nicht bestanden.",
    )?;
    let quality_c = pointer_i64(
        &operational,
        "/network/metrics/qualityCSegmentCount",
        "Klasse-C-Segmentzahl",
    )?;
    let pbf_quality_c = pointer_i64(&pbf, "/quality/classes/C", "PBF-Klasse-C-Abschnittszahl")?;
    let segment_qualifications = pointer(
        &operational,
        "/network/segmentQualifications",
        "Segmentqualifikationen",
    )?
    .as_array()
    .ok_or_else(|| ReleaseManifestError::new("Segmentqualifikationen sind ungueltig."))?;
    require(
        quality_c == 0
            && pbf_quality_c == 0
            && !segment_qualifications
                .iter()
                .any(|segment| segment.get("qualityClass").and_then(Value::as_str) == Some("C")),
        "Klasse-C-Abschnitte duerfen nur in interner Diagnose, nicht im freigegebenen Regionalrelease vorkommen.",
    )?;

    let source_specs = [
        (
            "sachsen-latest.osm.pbf",
            json!({
                "id": "geofabrik-sachsen-2026-08-10",
                "rightsSourceId": "osm-pbf-mitteldeutschland-b",
                "url": "https://download.geofabrik.de/europe/germany/sachsen-latest.osm.pbf",
                "sourceLicense": "ODbL-1.0",
                "attribution": "OpenStreetMap contributors; Geofabrik GmbH",
            }),
        ),
        (
            "sachsen-anhalt-latest.osm.pbf",
            json!({
                "id": "geofabrik-sachsen-anhalt-2026-08-10",
                "rightsSourceId": "osm-pbf-mitteldeutschland-b",
                "url": "https://download.geofabrik.de/europe/germany/sachsen-anhalt-latest.osm.pbf",
                "sourceLicense": "ODbL-1.0",
                "attribution": "OpenStreetMap contributors; Geofabrik GmbH",
            }),
        ),
        (
            "thueringen-latest.osm.pbf",
            json!({
                "id": "geofabrik-thueringen-2026-08-10",
                "rightsSourceId": "osm-pbf-mitteldeutschland-b",
                "url": "https://download.geofabrik.de/europe/germany/thueringen-latest.osm.pbf",
                "sourceLicense": "ODbL-1.0",
                "attribution": "OpenStreetMap contributors; Geofabrik GmbH",
            }),
        ),
        (
            "gtfs-rv-free-2026-08-10.zip",
            json!({
                "id": "gtfs-de-rv-free-2026-08-10",
                "rightsSourceId": "gtfs-de-rv",
                "url": "https://download.gtfs.de/germany/rv_free/latest.zip",
                "sourceLicense": "CC-BY-4.0",
                "attribution": "DELFI e.V.; GTFS.DE",
            }),
        ),
    ];
    let mut sources = source_specs
        .into_iter()
        .map(|(file, extra)| file_descriptor(source_root, file, extra))
        .collect::<Result<Vec<_>>>()?;
    sources.push(file_descriptor(
        artifact_root,
        "trassenfinder-infrastruktur-2026.json",
        json!({
            "id": "trassenfinder-infrastruktur-7-2026",
            "rightsSourceId": "trassenfinder-infrastruktur-api",
            "url": "https://openapi.trassenfinder.de/api/v10/infrastrukturen/7",
            "sourceLicense": "Keine veroeffentlichten Nutzungsbedingungen",
            "attribution": "DB InfraGO",
        }),
    )?);

    let artifact_specs = [
        (
            "mitteldeutschland-b-ebo.osm.pbf",
            json!({ "kind": "ebo-pbf-extract" }),
        ),
        (
            config.gtfs_artifact.as_str(),
            json!({
                "kind": "gtfs-planning-snapshot",
                "serviceDate": config.service_date,
                "stateHash": pointer_string(&gtfs, "/snapshotHash", "GTFS-Zustandshash")?,
            }),
        ),
        (
            "operational-network.json",
            json!({
                "kind": "operational-network",
                "stateHash": pointer_string(&operational, "/networkHash", "Betriebsnetz-Zustandshash")?,
            }),
        ),
        (
            config.operational_infrastructure_artifact.as_str(),
            json!({
                "kind": OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA,
                "infraReleaseId": config.release_id,
                "stateHash": operational_infrastructure_state_hash,
            }),
        ),
        (
            "pbf-release-report.json",
            json!({
                "kind": "blocks-routes-quality",
                "blocksHash": pointer_string(&pbf, "/derivations/blocksHash", "Blockhash")?,
                "interlockingRoutesHash": pointer_string(&pbf, "/derivations/interlockingRoutesHash", "Fahrstrassenhash")?,
            }),
        ),
        (
            "independent-validation-set.json",
            json!({
                "kind": "independent-technical-validation",
                "stateHash": pointer_string(&validation, "/validationHash", "Validierungshash")?,
            }),
        ),
        (
            "mitteldeutschland-b.pmtiles",
            json!({ "kind": "livemap-pmtiles" }),
        ),
    ];
    let artifacts = artifact_specs
        .into_iter()
        .map(|(file, extra)| file_descriptor(artifact_root, file, extra))
        .collect::<Result<Vec<_>>>()?;
    let manifested_operational_infrastructure_hash = artifacts
        .iter()
        .find(|artifact| {
            artifact.get("kind").and_then(Value::as_str)
                == Some(OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA)
        })
        .and_then(|artifact| artifact.get("sha256"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    require(
        manifested_operational_infrastructure_hash == operational_infrastructure_byte_hash,
        "Operational-v2-Infrastruktur änderte sich während der Manifestbildung.",
    )?;
    let pipeline_scripts = LEGACY_PIPELINE_FILES
        .iter()
        .map(|path| repository_file_descriptor(workspace_root, path))
        .collect::<Result<Vec<_>>>()?;
    let approved_source_ids: BTreeSet<_> = sources
        .iter()
        .filter_map(|source| source.get("rightsSourceId").and_then(Value::as_str))
        .collect();
    let boundary_path = "tools/region-import/mitteldeutschland-b.geojson";
    let mut boundary = file_descriptor(workspace_root, boundary_path, json!({}))?;
    let boundary_object = boundary
        .as_object_mut()
        .expect("Dateideskriptor ist immer ein Objekt");
    boundary_object.insert("file".into(), Value::String(boundary_path.into()));
    boundary_object.insert(
        "polygonFile".into(),
        Value::String("tools/region-import/mitteldeutschland-b.poly".into()),
    );
    boundary_object.insert(
        "polygonSha256".into(),
        Value::String(sha256_file(
            &workspace_root.join("tools/region-import/mitteldeutschland-b.poly"),
        )?),
    );

    let quality_sections = pointer(&pbf, "/quality/classes", "Qualitaetsklassen")?.clone();
    let interlocking_routes = pointer(&pbf, "/derivations/interlockingRoutes", "Fahrstrassen")?
        .as_array()
        .ok_or_else(|| ReleaseManifestError::new("Fahrstrassen sind ungueltig."))?;
    let release = json!({
        "schema": "zugfolge-infra-release/v1",
        "releaseId": config.release_id,
        "status": "qualified",
        "regionId": config.region_id,
        "regionVariant": config.region_variant,
        "timetableYear": config.timetable_year,
        "buildContract": {
            "schema": config.schema,
            "sha256": sha256(build_config),
            "serviceDate": config.service_date,
            "gtfsArtifact": config.gtfs_artifact,
        },
        "validFrom": pointer_string(&operational, "/network/validFrom", "Gueltigkeitsbeginn")?,
        "validUntil": pointer_string(&operational, "/network/validUntil", "Gueltigkeitsende")?,
        "decisions": [
            { "id": "E22", "adr": "docs/adr/0022-jaehrliche-infrastrukturaktualisierung.md" },
            { "id": "E24", "adr": "docs/adr/0024-erweiterter-alpha-schnitt.md", "issue": "https://github.com/larynxberlin-rgb/Zugfolge/issues/201" },
            { "id": "E25", "adr": "docs/adr/0025-gebietsueberschreitende-fahrtketten.md" },
        ],
        "boundary": boundary,
        "sources": sources,
        "pipeline": {
            "scripts": pipeline_scripts,
            "tools": [
                { "name": "osmium-tool", "version": "1.16.0" },
                { "name": "tippecanoe", "version": "2.79.0", "commit": "68ab8dcc229f95b8b25877697d5e8d66783af503" },
                { "name": "go-pmtiles", "version": "1.31.2", "commit": "a3e4951ea6a0477b784c27c1dcbfd9c130878c5a", "linuxX8664Sha256": "3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f" },
            ],
        },
        "artifacts": artifacts,
        "quality": {
            "sections": quality_sections,
            "operationalSegments": {
                "B": pointer_i64(&operational, "/network/metrics/qualityBSegmentCount", "Klasse-B-Segmentzahl")?,
                "C": quality_c,
            },
            "classCVisible": false,
            "classCOrderable": false,
            "orderableJourneyChains": pointer_i64(&operational, "/network/metrics/orderableJourneyChainCount", "bestellbare Fahrtketten")?,
            "conflictResources": pointer_i64(&operational, "/network/metrics/conflictResourceCount", "Konfliktressourcen")?,
            "blocks": pointer_i64(&pbf, "/topology/conservativeConflictResources", "Bloecke")?,
            "interlockingRoutes": interlocking_routes.len(),
        },
        "rights": {
            "registry": "tools/guards/quellenregister.json",
            "approvedSourceIds": approved_source_ids,
            "stationSource": "trassenfinder-infrastruktur-api",
            "elevation": {
                "included": false,
                "rightsApproved": true,
                "reason": "Kein versionierter Copernicus-DEM-Snapshot im Release; deshalb keine Hoehenwerte geraten oder importiert.",
                "operationalEffect": "Abschnitte ohne unabhaengigen Neigungsnachweis bleiben hoechstens Klasse B; Klasse A wird nicht behauptet.",
            },
            "attributionReport": "docs/mitteldeutschland-alpha.md",
        },
        "validation": {
            "issue": "https://github.com/larynxberlin-rgb/Zugfolge/issues/48",
            "independentFromCalibration": true,
            "result": "passed",
            "checkCount": pointer_i64(&validation, "/artifact/metrics/checkCount", "Validierungspruefungen")?,
            "failedCount": pointer_i64(&validation, "/artifact/metrics/failedCount", "fehlgeschlagene Validierungspruefungen")?,
            "validationHash": pointer_string(&validation, "/validationHash", "Validierungshash")?,
        },
        "releaseApproval": {
            "releaseResponsible": config.release_approval.release_responsible,
            "responsibilityGrantedBy": config.release_approval.responsibility_granted_by,
            "activationAllowed": config.release_approval.activation_allowed,
            "activationAuthority": config.release_approval.activation_authority,
        },
    });
    Ok(release)
}

fn safe_relative_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    non_empty(path)
        && !Path::new(path).is_absolute()
        && !normalized.starts_with('/')
        && normalized
            .as_bytes()
            .get(1)
            .is_none_or(|separator| *separator != b':')
        && !normalized.split('/').any(|component| component == "..")
}

fn artifact_record<'a>(input: &'a Value, key: &str) -> Result<&'a Value> {
    let record = input
        .get(key)
        .ok_or_else(|| ReleaseManifestError::new(format!("{key} fehlt.")))?;
    require(record.is_object(), format!("{key} fehlt."))?;
    let path = record
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    require(
        safe_relative_path(path),
        format!("{key}.path muss ein sicherer relativer Artefaktpfad sein."),
    )?;
    require(
        record
            .get("sha256")
            .and_then(Value::as_str)
            .is_some_and(is_sha256),
        format!("{key}.sha256 muss ein SHA-256-Hash sein."),
    )?;
    Ok(record)
}

fn is_iso_8601_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return false;
    }
    let number = |start: usize, end: usize| {
        value
            .get(start..end)
            .and_then(|part| part.parse::<u32>().ok())
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        number(0, 4),
        number(5, 7),
        number(8, 10),
        number(11, 13),
        number(14, 16),
        number(17, 19),
    ) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    if day == 0 || day > days || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let suffix = &value[19..];
    let (fraction, timezone) = if let Some(fraction) = suffix.strip_suffix('Z') {
        (fraction, "Z")
    } else if let Some(index) = suffix.find(['+', '-']) {
        (&suffix[..index], &suffix[index..])
    } else {
        return false;
    };
    if !fraction.is_empty()
        && (!fraction.starts_with('.')
            || fraction.len() == 1
            || !fraction[1..].bytes().all(|byte| byte.is_ascii_digit()))
    {
        return false;
    }
    if timezone == "Z" {
        return true;
    }
    timezone.len() == 6
        && timezone.as_bytes().get(3) == Some(&b':')
        && timezone
            .get(1..3)
            .and_then(|part| part.parse::<u32>().ok())
            .is_some_and(|hour| hour <= 23)
        && timezone
            .get(4..6)
            .and_then(|part| part.parse::<u32>().ok())
            .is_some_and(|minute| minute <= 59)
}

fn decode_hex_bytes(value: &str, what: &str) -> Result<Vec<u8>> {
    require(
        value.len() % 2 == 0,
        format!("{what}.bytesHex ist ungueltig."),
    )?;
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|text| u8::from_str_radix(text, 16).ok())
                .ok_or_else(|| ReleaseManifestError::new(format!("{what}.bytesHex ist ungueltig.")))
        })
        .collect()
}

fn loaded_json_artifact(input: &Value, key: &str) -> Result<(Value, Value)> {
    let artifact = input
        .get("artifacts")
        .and_then(|artifacts| artifacts.get(key))
        .ok_or_else(|| ReleaseManifestError::new(format!("artifacts.{key} fehlt.")))?;
    let record = artifact_record(artifact, "record")?.clone();
    let bytes = decode_hex_bytes(
        artifact
            .get("bytesHex")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        &format!("artifacts.{key}"),
    )?;
    require(
        sha256_bytes(&bytes) == record["sha256"].as_str().unwrap_or_default(),
        format!("artifacts.{key}: Artefakthash stimmt nicht mit den Bytes ueberein."),
    )?;
    let value = serde_json::from_slice(&bytes).map_err(|error| {
        ReleaseManifestError::new(format!("artifacts.{key} ist kein gueltiges JSON: {error}"))
    })?;
    Ok((record, value))
}

fn loaded_bytes_artifact(input: &Value, key: &str) -> Result<(Value, Vec<u8>)> {
    let artifact = input
        .get("artifacts")
        .and_then(|artifacts| artifacts.get(key))
        .ok_or_else(|| ReleaseManifestError::new(format!("artifacts.{key} fehlt.")))?;
    loaded_bytes_entry(artifact, &format!("artifacts.{key}"))
}

fn loaded_bytes_entry(artifact: &Value, what: &str) -> Result<(Value, Vec<u8>)> {
    let record = artifact_record(artifact, "record")?.clone();
    let bytes = decode_hex_bytes(
        artifact
            .get("bytesHex")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        what,
    )?;
    require(
        sha256_bytes(&bytes) == record["sha256"].as_str().unwrap_or_default(),
        format!("{what}: Artefakthash stimmt nicht mit den Bytes ueberein."),
    )?;
    Ok((record, bytes))
}

fn required_string<'a>(value: &'a Value, pointer: &str, what: &str) -> Result<&'a str> {
    let text = value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default();
    require(non_empty(text), format!("{what} fehlt."))?;
    Ok(text)
}

fn required_i64(value: &Value, pointer: &str, what: &str, minimum: i64) -> Result<i64> {
    let number = value
        .pointer(pointer)
        .and_then(Value::as_i64)
        .ok_or_else(|| ReleaseManifestError::new(format!("{what} muss eine ganze Zahl sein.")))?;
    require(
        number >= minimum,
        format!("{what} muss mindestens {minimum} sein."),
    )?;
    Ok(number)
}

fn sorted_unique_strings(
    value: &Value,
    pointer: &str,
    what: &str,
    minimum: usize,
) -> Result<Vec<String>> {
    let values = value
        .pointer(pointer)
        .and_then(Value::as_array)
        .ok_or_else(|| ReleaseManifestError::new(format!("{what} muss eine Liste sein.")))?;
    require(
        values.len() >= minimum,
        format!("{what} enthaelt zu wenige Eintraege."),
    )?;
    let mut strings = values
        .iter()
        .map(|value| {
            let text = value.as_str().unwrap_or_default();
            require(
                non_empty(text),
                format!("{what} enthaelt eine leere Identitaet."),
            )?;
            Ok(text.to_owned())
        })
        .collect::<Result<Vec<_>>>()?;
    strings.sort_unstable();
    require(
        strings.windows(2).all(|window| window[0] != window[1]),
        format!("{what} enthaelt doppelte Identitaeten."),
    )?;
    Ok(strings)
}

fn exact_value(actual: &Value, expected: &Value, what: &str) -> Result<()> {
    require(
        actual == expected,
        format!("{what} stimmt nicht exakt mit der Artefaktkette ueberein."),
    )
}

fn validate_partition(
    evidence: &Value,
    role: &str,
    minimum: usize,
    dataset_record: &Value,
    config_record: &Value,
) -> Result<Vec<String>> {
    let partition = evidence.get(role).unwrap_or(&Value::Null);
    require(
        partition.get("purpose").and_then(Value::as_str) == Some(role),
        format!("{role}.purpose ist ungueltig."),
    )?;
    required_string(partition, "/datasetId", &format!("{role}.datasetId"))?;
    required_string(partition, "/configId", &format!("{role}.configId"))?;
    let frozen_at = required_string(partition, "/frozenAt", &format!("{role}.frozenAt"))?;
    require(
        is_iso_8601_timestamp(frozen_at),
        format!("{role}.frozenAt ist ungueltig."),
    )?;
    exact_value(
        partition.get("dataset").unwrap_or(&Value::Null),
        dataset_record,
        &format!("{role}.dataset"),
    )?;
    exact_value(
        partition.get("config").unwrap_or(&Value::Null),
        config_record,
        &format!("{role}.config"),
    )?;
    let ids = sorted_unique_strings(
        partition,
        "/sampleIds",
        &format!("{role}.sampleIds"),
        minimum,
    )?;
    let ids_hash = sha256(&json!(ids));
    require(
        partition.get("sampleIdsSha256").and_then(Value::as_str) == Some(ids_hash.as_str()),
        format!("{role}.sampleIdsSha256 stimmt nicht."),
    )?;
    Ok(ids)
}

fn validate_dataset(
    dataset: &Value,
    partition: &Value,
    role: &str,
) -> Result<BTreeMap<String, Value>> {
    require(
        dataset.get("schema").and_then(Value::as_str)
            == Some("zugfolge-technical-reference-dataset/v1"),
        format!("{role}: unbekanntes Datensatz-Schema."),
    )?;
    for field in ["purpose", "datasetId", "frozenAt"] {
        require(
            dataset.get(field) == partition.get(field),
            format!("{role}.{field} stimmt nicht mit dem Nachweis ueberein."),
        )?;
    }
    for field in [
        "id",
        "sourceLicense",
        "attribution",
        "retrievedAt",
        "method",
    ] {
        required_string(
            dataset,
            &format!("/source/{field}"),
            &format!("{role}.source.{field}"),
        )?;
    }
    require(
        is_iso_8601_timestamp(required_string(
            dataset,
            "/source/retrievedAt",
            "source.retrievedAt",
        )?),
        format!("{role}.source.retrievedAt ist ungueltig."),
    )?;
    let source_id = required_string(dataset, "/source/id", "source.id")?.to_owned();
    let samples = dataset
        .get("samples")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ReleaseManifestError::new(format!("{role}.samples muss eine Liste sein."))
        })?;
    let mut by_id = BTreeMap::new();
    for sample in samples {
        let id = required_string(sample, "/id", &format!("{role}.sample.id"))?.to_owned();
        required_string(sample, "/groupId", &format!("{role}.{id}.groupId"))?;
        required_string(
            sample,
            "/characteristicsId",
            &format!("{role}.{id}.characteristicsId"),
        )?;
        require(
            sample.get("sourceId").and_then(Value::as_str) == Some(source_id.as_str()),
            format!("{role}.{id}.sourceId ist ungueltig."),
        )?;
        required_i64(
            sample,
            "/technicalRunningSeconds",
            &format!("{role}.{id}.technicalRunningSeconds"),
            1,
        )?;
        require(
            by_id.insert(id.clone(), sample.clone()).is_none(),
            format!("{role}: Stichprobe {id} ist doppelt."),
        )?;
    }
    let ids = sorted_unique_strings(partition, "/sampleIds", &format!("{role}.sampleIds"), 1)?;
    require(
        by_id.keys().cloned().collect::<Vec<_>>() == ids,
        format!("{role}: Datensatz enthaelt nicht exakt die eingefrorenen Stichproben."),
    )?;
    Ok(by_id)
}

fn validate_evaluation_config(
    config: &Value,
    partition: &Value,
    role: &str,
    dataset_record: &Value,
) -> Result<()> {
    require(
        config.get("schema").and_then(Value::as_str)
            == Some("zugfolge-technical-evaluation-config/v1"),
        format!("{role}: unbekanntes Konfigurations-Schema."),
    )?;
    for field in ["purpose", "configId", "frozenAt"] {
        require(
            config.get(field) == partition.get(field),
            format!("{role}.config.{field} stimmt nicht mit dem Nachweis ueberein."),
        )?;
    }
    require(
        config.get("datasetSha256") == dataset_record.get("sha256"),
        format!("{role}: Konfiguration ist nicht an die Datensatzbytes gebunden."),
    )?;
    required_string(config, "/method", &format!("{role}.config.method"))?;
    Ok(())
}

fn with_fields(base: &Value, fields: &[(&str, Value)]) -> Result<Value> {
    let mut object = base
        .as_object()
        .cloned()
        .ok_or_else(|| ReleaseManifestError::new("Artefaktbindung muss ein Objekt sein."))?;
    for (key, value) in fields {
        object.insert((*key).to_owned(), value.clone());
    }
    Ok(Value::Object(object))
}

/// Bildet den gehaerteten technischen v3-Abweichungsreport autoritativ in Rust.
/// Alle fachlich relevanten Eingaben werden als exakte Bytes selbst gehasht,
/// geparst und gegen den eingefrorenen disjunkten Holdout ausgewertet.
pub fn build_reference_report(input: &Value) -> Result<Value> {
    let (capture_record, capture) = loaded_json_artifact(input, "captureConfig")?;
    let (reference_record, corpus) = loaded_json_artifact(input, "referenceCorpus")?;
    let (evidence_record, evidence) = loaded_json_artifact(input, "qualificationEvidence")?;
    let (calibration_dataset_record, calibration_dataset) =
        loaded_json_artifact(input, "calibrationDataset")?;
    let (calibration_config_record, calibration_config) =
        loaded_json_artifact(input, "calibrationConfig")?;
    let (validation_dataset_record, validation_dataset) =
        loaded_json_artifact(input, "validationDataset")?;
    let (validation_config_record, validation_config) =
        loaded_json_artifact(input, "validationConfig")?;
    let (model_config_record, model_config) = loaded_json_artifact(input, "modelConfig")?;
    let (model_record, model_results) = loaded_json_artifact(input, "modelResults")?;

    require(
        capture.get("schema").and_then(Value::as_str) == Some("zugfolge-gtfs-capture/v2"),
        "Nur eine gehaertete Capture-Konfiguration ist releasefaehig.",
    )?;
    require(
        corpus.get("schema").and_then(Value::as_str) == Some("zugfolge-reference-corpus/v3"),
        "Nur ein gehaerteter Referenzkorpus ist releasefaehig.",
    )?;
    require(
        evidence.get("schema").and_then(Value::as_str)
            == Some("zugfolge-qualification-evidence/v1"),
        "Unbekanntes Qualifikationsnachweis-Schema.",
    )?;
    require(
        model_results.get("schema").and_then(Value::as_str) == Some("zugfolge-model-results/v3"),
        "Nur gehaertete Modellergebnisse sind releasefaehig.",
    )?;
    require(
        is_iso_8601_timestamp(required_string(
            &evidence,
            "/frozenAt",
            "qualificationEvidence.frozenAt",
        )?),
        "qualificationEvidence.frozenAt ist ungueltig.",
    )?;
    exact_value(
        evidence.get("policy").unwrap_or(&Value::Null),
        capture.get("qualificationPolicy").unwrap_or(&Value::Null),
        "Qualifikationsmindestmengen",
    )?;
    let minimum_calibration = usize::try_from(required_i64(
        &evidence,
        "/policy/minimumCalibrationSamples",
        "minimumCalibrationSamples",
        1,
    )?)
    .map_err(|_| ReleaseManifestError::new("minimumCalibrationSamples ist zu gross."))?;
    let minimum_validation = usize::try_from(required_i64(
        &evidence,
        "/policy/minimumValidationSamples",
        "minimumValidationSamples",
        1,
    )?)
    .map_err(|_| ReleaseManifestError::new("minimumValidationSamples ist zu gross."))?;
    let calibration_ids = validate_partition(
        &evidence,
        "calibration",
        minimum_calibration,
        &calibration_dataset_record,
        &calibration_config_record,
    )?;
    let validation_ids = validate_partition(
        &evidence,
        "validation",
        minimum_validation,
        &validation_dataset_record,
        &validation_config_record,
    )?;
    let calibration_partition = &evidence["calibration"];
    let validation_partition = &evidence["validation"];
    require(
        calibration_partition["datasetId"] != validation_partition["datasetId"],
        "Kalibrierungs- und Validierungsdatensatz haben dieselbe Identitaet.",
    )?;
    require(
        calibration_dataset_record["sha256"] != validation_dataset_record["sha256"],
        "Kalibrierungs- und Validierungsdatensatz haben denselben Hash.",
    )?;
    require(
        calibration_partition["configId"] != validation_partition["configId"],
        "Kalibrierungs- und Validierungskonfiguration haben dieselbe Identitaet.",
    )?;
    require(
        calibration_config_record["sha256"] != validation_config_record["sha256"],
        "Kalibrierungs- und Validierungskonfiguration haben denselben Hash.",
    )?;
    let calibration_set: BTreeSet<_> = calibration_ids.iter().collect();
    require(
        validation_ids
            .iter()
            .all(|identity| !calibration_set.contains(identity)),
        "Kalibrierungs- und Validierungsstichproben ueberlappen.",
    )?;
    let _calibration_samples =
        validate_dataset(&calibration_dataset, calibration_partition, "calibration")?;
    let validation_samples =
        validate_dataset(&validation_dataset, validation_partition, "validation")?;
    validate_evaluation_config(
        &calibration_config,
        calibration_partition,
        "calibration",
        &calibration_dataset_record,
    )?;
    validate_evaluation_config(
        &validation_config,
        validation_partition,
        "validation",
        &validation_dataset_record,
    )?;

    let corpus_binding = corpus.get("artifactBinding").unwrap_or(&Value::Null);
    require(
        corpus_binding.get("captureConfigSha256") == capture_record.get("sha256"),
        "Referenzkorpus ist nicht an die exakten Capture-Konfigurationsbytes gebunden.",
    )?;
    exact_value(
        corpus.get("source").unwrap_or(&Value::Null),
        capture.get("source").unwrap_or(&Value::Null),
        "Referenzkorpus.source",
    )?;
    let expected_bindings = with_fields(
        corpus_binding,
        &[
            ("referenceCorpusSha256", reference_record["sha256"].clone()),
            (
                "qualificationEvidenceSha256",
                evidence_record["sha256"].clone(),
            ),
            (
                "calibrationDatasetSha256",
                calibration_dataset_record["sha256"].clone(),
            ),
            (
                "calibrationConfigSha256",
                calibration_config_record["sha256"].clone(),
            ),
            (
                "validationDatasetSha256",
                validation_dataset_record["sha256"].clone(),
            ),
            (
                "validationConfigSha256",
                validation_config_record["sha256"].clone(),
            ),
        ],
    )?;
    exact_value(
        model_config.get("artifactBinding").unwrap_or(&Value::Null),
        &expected_bindings,
        "modelConfig.artifactBinding",
    )?;
    exact_value(
        model_results.get("artifactBinding").unwrap_or(&Value::Null),
        &expected_bindings,
        "modelResults.artifactBinding",
    )?;
    exact_value(
        model_results.get("assumptions").unwrap_or(&Value::Null),
        model_config.get("assumptions").unwrap_or(&Value::Null),
        "Modellannahmen",
    )?;
    required_string(&model_config, "/schema", "modelConfig.schema")?;
    required_string(&model_config, "/method", "modelConfig.method")?;
    for role in ["infrastructure", "vehicle"] {
        sorted_unique_strings(
            &model_results,
            &format!("/assumptions/{role}"),
            &format!("assumptions.{role}"),
            1,
        )?;
    }
    require(
        model_results.get("modelInputSha256") == model_config_record.get("sha256"),
        "Modellergebnis ist nicht an die exakten Modellkonfigurationsbytes gebunden.",
    )?;
    require(
        model_results.get("qualification").is_none(),
        "Modellergebnis darf kein vertrauensbasiertes qualification-Feld enthalten.",
    )?;

    let groups = corpus
        .get("groups")
        .and_then(Value::as_array)
        .ok_or_else(|| ReleaseManifestError::new("Referenzkorpus.groups muss eine Liste sein."))?;
    let mut groups_by_id = BTreeMap::new();
    for group in groups {
        let group_id = required_string(group, "/id", "Referenzgruppe.id")?.to_owned();
        required_string(
            group,
            "/characteristicsId",
            &format!("{group_id}.characteristicsId"),
        )?;
        required_string(
            group,
            "/trainCategory",
            &format!("{group_id}.trainCategory"),
        )?;
        required_i64(
            group,
            "/scheduledDurationP20Seconds",
            &format!("{group_id}.scheduledDurationP20Seconds"),
            1,
        )?;
        required_i64(
            group,
            "/scheduledRunningP20Seconds",
            &format!("{group_id}.scheduledRunningP20Seconds"),
            1,
        )?;
        required_i64(
            group,
            "/scheduledDwellP20Seconds",
            &format!("{group_id}.scheduledDwellP20Seconds"),
            0,
        )?;
        required_i64(group, "/sampleCount", &format!("{group_id}.sampleCount"), 1)?;
        require(
            groups_by_id.insert(group_id.clone(), group).is_none(),
            format!("Referenzgruppe {group_id} ist doppelt."),
        )?;
    }
    let results = model_results
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| ReleaseManifestError::new("modelResults.results muss eine Liste sein."))?;
    let absolute = required_i64(&capture, "/tolerance/absoluteSeconds", "absoluteSeconds", 0)?;
    let basis_points = required_i64(
        &capture,
        "/tolerance/relativeBasisPoints",
        "relativeBasisPoints",
        0,
    )?;
    let mut comparisons = Vec::new();
    let mut seen_groups = BTreeSet::new();
    let mut used_validation = BTreeSet::new();
    for result in results {
        let group_id = required_string(result, "/groupId", "modelResults.results.groupId")?;
        require(
            seen_groups.insert(group_id.to_owned()),
            format!("Modellergebnis fuer Gruppe {group_id} ist doppelt."),
        )?;
        let group = groups_by_id.get(group_id).ok_or_else(|| {
            ReleaseManifestError::new(format!("Referenzgruppe {group_id} fehlt."))
        })?;
        require(
            result.get("characteristicsId") == group.get("characteristicsId"),
            format!("{group_id}: Zugcharakteristik stimmt nicht ueberein."),
        )?;
        let validation_id = required_string(
            result,
            "/validationSampleId",
            &format!("{group_id}.validationSampleId"),
        )?;
        require(
            validation_ids
                .iter()
                .any(|identity| identity == validation_id),
            format!("{group_id}: Validierungsstichprobe ist nicht im Holdout."),
        )?;
        require(
            used_validation.insert(validation_id.to_owned()),
            format!("{group_id}: Validierungsstichprobe wird mehrfach verwendet."),
        )?;
        let sample = validation_samples.get(validation_id).ok_or_else(|| {
            ReleaseManifestError::new(format!("{group_id}: Validierungsstichprobe fehlt."))
        })?;
        require(
            sample.get("groupId").and_then(Value::as_str) == Some(group_id),
            format!("{group_id}: Validierungsstichprobe gehoert zu einer anderen Gruppe."),
        )?;
        require(
            sample.get("characteristicsId") == group.get("characteristicsId"),
            format!("{group_id}: Validierungsstichprobe hat eine andere Zugcharakteristik."),
        )?;
        let reference_seconds = required_i64(
            sample,
            "/technicalRunningSeconds",
            "technicalRunningSeconds",
            1,
        )?;
        require(
            result
                .get("technicalReferenceSeconds")
                .and_then(Value::as_i64)
                == Some(reference_seconds),
            format!("{group_id}: technische Referenz stimmt nicht mit dem Holdout ueberein."),
        )?;
        let raw = required_i64(result, "/rawRunningSeconds", "rawRunningSeconds", 1)?;
        let running = required_i64(result, "/runningSeconds", "runningSeconds", 1)?;
        let dwell = required_i64(result, "/dwellSeconds", "dwellSeconds", 0)?;
        let modeled = required_i64(
            result,
            "/modeledTimetableSeconds",
            "modeledTimetableSeconds",
            1,
        )?;
        require(
            modeled
                == running
                    .checked_add(dwell)
                    .ok_or_else(|| ReleaseManifestError::new("Fahrplanzeit ueberlaeuft."))?,
            format!("{group_id}: modellierte Fahrplanzeit ist ungueltig."),
        )?;
        let relative = reference_seconds
            .checked_mul(basis_points)
            .ok_or_else(|| ReleaseManifestError::new("Toleranzberechnung ueberlaeuft."))?;
        let allowance = absolute.max(
            relative
                .checked_add(9_999)
                .ok_or_else(|| ReleaseManifestError::new("Toleranzberechnung ueberlaeuft."))?
                / 10_000,
        );
        let deviation = running
            .checked_sub(reference_seconds)
            .ok_or_else(|| ReleaseManifestError::new("Abweichungsberechnung ueberlaeuft."))?;
        let scheduled_duration = required_i64(
            group,
            "/scheduledDurationP20Seconds",
            "scheduledDurationP20Seconds",
            1,
        )?;
        let allowance_unsigned = u64::try_from(allowance)
            .map_err(|_| ReleaseManifestError::new("Toleranz darf nicht negativ sein."))?;
        comparisons.push(json!({
            "groupId": group_id,
            "characteristicsId": group["characteristicsId"],
            "trainCategory": group["trainCategory"],
            "calibrationMethod": required_string(result, "/calibrationMethod", "calibrationMethod")?,
            "validationSampleId": validation_id,
            "validationSourceId": sample["sourceId"],
            "rawRunningSeconds": raw,
            "calculatedTechnicalSeconds": running,
            "technicalReferenceSeconds": reference_seconds,
            "technicalDeviationSeconds": deviation,
            "toleranceSeconds": allowance,
            "technicalWithinTolerance": deviation.unsigned_abs() <= allowance_unsigned,
            "scheduledDurationP20Seconds": group["scheduledDurationP20Seconds"],
            "scheduledRunningP20Seconds": group["scheduledRunningP20Seconds"],
            "scheduledDwellP20Seconds": group["scheduledDwellP20Seconds"],
            "modeledTimetableSeconds": modeled,
            "scheduledAllowanceSeconds": scheduled_duration - modeled,
            "sampleCount": group["sampleCount"],
        }));
    }
    require(
        seen_groups.len() == groups_by_id.len(),
        "Modellergebnis enthaelt nicht exakt alle Referenzgruppen.",
    )?;
    require(
        used_validation.into_iter().collect::<Vec<_>>() == validation_ids,
        "Modellergebnis wertet nicht exakt alle eingefrorenen Validierungsstichproben aus.",
    )?;
    let passed = !comparisons.is_empty()
        && comparisons
            .iter()
            .all(|comparison| comparison["technicalWithinTolerance"] == Value::Bool(true));
    let report_binding = with_fields(
        &expected_bindings,
        &[
            (
                "modelInputSha256",
                model_results["modelInputSha256"].clone(),
            ),
            ("modelResultsSha256", model_record["sha256"].clone()),
        ],
    )?;
    let expected_report = json!({
        "schema": "zugfolge-reference-report/v3",
        "artifactBinding": report_binding,
        "releaseChecksum": model_results["releaseChecksum"],
        "modelInputSha256": model_results["modelInputSha256"],
        "sources": {
            "timetableHoldout": corpus["source"],
            "technicalValidation": {
                "datasetId": validation_partition["datasetId"],
                "datasetSha256": validation_dataset_record["sha256"],
                "sampleIdsSha256": validation_partition["sampleIdsSha256"],
                "source": validation_dataset["source"],
            },
        },
        "assumptions": model_results["assumptions"],
        "qualification": {
            "basis": "verified-disjoint-frozen-artifacts",
            "frozenAt": evidence["frozenAt"],
            "calibrationDatasetId": calibration_partition["datasetId"],
            "validationDatasetId": validation_partition["datasetId"],
            "calibrationSampleCount": calibration_ids.len(),
            "validationSampleCount": validation_ids.len(),
            "disjoint": true,
        },
        "tolerance": capture["tolerance"],
        "passed": passed,
        "releaseQualified": passed,
        "comparisons": comparisons,
    });
    Ok(expected_report)
}

/// Qualifiziert ein technisches Referenzkorpus-Release nach E5 vollständig in Rust.
/// Der übergebene Report wird nicht vertraut, sondern bytegenau gegen den hier
/// erneut gebildeten autoritativen Report geprüft.
pub fn build_qualified_reference_release(input: &Value) -> Result<Value> {
    let expected_report = build_reference_report(input)?;
    let (_, model_config) = loaded_json_artifact(input, "modelConfig")?;
    let (reference_record, _) = loaded_json_artifact(input, "referenceCorpus")?;
    let (evidence_record, _) = loaded_json_artifact(input, "qualificationEvidence")?;
    let (model_record, _) = loaded_json_artifact(input, "modelResults")?;
    let (report_record, report) = loaded_json_artifact(input, "report")?;
    let (candidate_record, candidate) = loaded_json_artifact(input, "candidateManifest")?;
    exact_value(
        report.get("tolerance").unwrap_or(&Value::Null),
        expected_report.get("tolerance").unwrap_or(&Value::Null),
        "Reporttoleranz",
    )?;
    exact_value(&report, &expected_report, "Abweichungsreport")?;
    require(
        expected_report.get("passed").and_then(Value::as_bool) == Some(true)
            && expected_report
                .get("releaseQualified")
                .and_then(Value::as_bool)
                == Some(true),
        "Fahrzeitvergleich liegt ausserhalb der dokumentierten Toleranz.",
    )?;
    require(
        candidate.get("schema").and_then(Value::as_str)
            == Some("zugfolge-infra-release-manifest/v1"),
        "Unbekanntes Release-Kandidaten-Schema.",
    )?;
    if let Some(embedded_model_config) = candidate.get("modelConfig") {
        exact_value(
            embedded_model_config,
            &model_config,
            "Release-Kandidat.modelConfig",
        )?;
    }
    let created_at = input
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    require(
        is_iso_8601_timestamp(created_at),
        "createdAt muss ein ISO-8601-Zeitpunkt sein.",
    )?;
    let release_checksum =
        required_string(&expected_report, "/releaseChecksum", "releaseChecksum")?;
    let model_input_sha256 =
        required_string(&expected_report, "/modelInputSha256", "modelInputSha256")?;
    require(
        is_sha256(release_checksum)
            && candidate.get("releaseChecksum").and_then(Value::as_str) == Some(release_checksum),
        "Release-Kandidat und Modell haben verschiedene Release-Checksummen.",
    )?;
    require(
        is_sha256(model_input_sha256)
            && candidate.get("modelInputSha256").and_then(Value::as_str)
                == Some(model_input_sha256),
        "Release-Kandidat und Modell haben verschiedene Modelleingaben.",
    )?;

    Ok(json!({
        "schema": "zugfolge-qualified-infra-release-manifest/v1",
        "releaseChecksum": release_checksum,
        "modelInputSha256": model_input_sha256,
        "createdAt": created_at,
        "candidateManifest": candidate_record,
        "qualification": {
            "referenceCorpusSha256": reference_record["sha256"],
            "qualificationEvidenceSha256": evidence_record["sha256"],
            "modelResultsSha256": model_record["sha256"],
            "reportSha256": report_record["sha256"],
        },
    }))
}

/// Verifiziert die vollständige produktive Referenzkorpus-Artefaktkette in Rust.
/// Der Aufrufer darf Dateien einlesen, aber keine fachliche Bindung vorprüfen
/// oder eine Freigabeentscheidung treffen.
pub fn verify_reference_artifact_chain(input: &Value) -> Result<Value> {
    let artifacts = input.get("artifacts").unwrap_or(&Value::Null);
    let (capture_config_record, capture_config) = loaded_json_artifact(input, "captureConfig")?;
    let (capture_manifest_record, capture_manifest) =
        loaded_json_artifact(input, "captureManifest")?;
    let (source_archive_record, source_archive_bytes) =
        loaded_bytes_artifact(input, "sourceArchive")?;
    let (normalized_record, normalized) = loaded_json_artifact(input, "normalizedObservations")?;
    let (corpus_record, corpus) = loaded_json_artifact(input, "referenceCorpus")?;
    require(
        capture_config.get("schema").and_then(Value::as_str) == Some("zugfolge-gtfs-capture/v2"),
        "Unbekanntes Capture-Konfigurations-Schema.",
    )?;
    require(
        capture_manifest.get("schema").and_then(Value::as_str) == Some("zugfolge-gtfs-capture/v2"),
        "Unbekanntes Capture-Manifest-Schema.",
    )?;
    require(
        capture_manifest.get("configArtifactSha256") == capture_config_record.get("sha256"),
        "Capture-Manifest ist nicht an die exakten Konfigurationsbytes gebunden.",
    )?;
    require(
        capture_manifest.get("configSha256").and_then(Value::as_str)
            == Some(sha256(&capture_config).as_str()),
        "Capture-Manifest ist nicht an den kanonischen Konfigurationsinhalt gebunden.",
    )?;
    require(
        capture_manifest.get("feedUrl") == capture_config.get("feedUrl"),
        "Capture-Manifest und Feed-URL stimmen nicht ueberein.",
    )?;
    exact_value(
        capture_manifest.get("source").unwrap_or(&Value::Null),
        capture_config.get("source").unwrap_or(&Value::Null),
        "Capture-Quelle",
    )?;
    require(
        capture_manifest.get("archiveSha256") == source_archive_record.get("sha256"),
        "Capture-Manifest und Quellarchiv stimmen nicht ueberein.",
    )?;
    require(
        capture_manifest.get("archiveBytes").and_then(Value::as_u64)
            == u64::try_from(source_archive_bytes.len()).ok(),
        "Capture-Manifest und Quellarchivgroesse stimmen nicht ueberein.",
    )?;

    let source_table_entries = artifacts
        .get("sourceTables")
        .and_then(Value::as_array)
        .ok_or_else(|| ReleaseManifestError::new("artifacts.sourceTables muss eine Liste sein."))?;
    let manifest_tables = capture_manifest
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| ReleaseManifestError::new("captureManifest.files muss eine Liste sein."))?;
    require(
        !source_table_entries.is_empty() && source_table_entries.len() == manifest_tables.len(),
        "Artefaktkette enthaelt nicht exakt alle Capture-Tabellen.",
    )?;
    let mut seen_paths = BTreeSet::new();
    for key in [
        "captureConfig",
        "captureManifest",
        "sourceArchive",
        "normalizedObservations",
        "referenceCorpus",
        "qualificationEvidence",
        "calibrationDataset",
        "calibrationConfig",
        "validationDataset",
        "validationConfig",
        "modelConfig",
        "modelResults",
        "report",
        "candidateManifest",
        "releaseManifest",
    ] {
        let artifact = artifacts
            .get(key)
            .ok_or_else(|| ReleaseManifestError::new(format!("artifacts.{key} fehlt.")))?;
        let record = artifact_record(artifact, "record")?;
        let normalized_path = record["path"]
            .as_str()
            .unwrap_or_default()
            .replace('\\', "/")
            .to_lowercase();
        require(
            seen_paths.insert(normalized_path),
            format!("Artefaktpfad fuer {key} ist doppelt."),
        )?;
    }
    for (index, entry) in source_table_entries.iter().enumerate() {
        let (record, bytes) =
            loaded_bytes_entry(entry, &format!("artifacts.sourceTables[{index}]"))?;
        let source_path = required_string(
            entry,
            "/sourcePath",
            &format!("sourceTables[{index}].sourcePath"),
        )?;
        require(
            safe_relative_path(source_path),
            format!("sourceTables[{index}].sourcePath ist ungueltig."),
        )?;
        let manifest = &manifest_tables[index];
        require(
            manifest.get("path").and_then(Value::as_str) == Some(source_path),
            format!("Capture-Tabelle {index} hat einen anderen Quellpfad."),
        )?;
        require(
            manifest.get("sha256") == record.get("sha256"),
            format!("Capture-Tabelle {index} hat einen anderen Hash."),
        )?;
        require(
            manifest.get("bytes").and_then(Value::as_u64) == u64::try_from(bytes.len()).ok(),
            format!("Capture-Tabelle {index} hat eine andere Groesse."),
        )?;
        let normalized_path = record["path"]
            .as_str()
            .unwrap_or_default()
            .replace('\\', "/")
            .to_lowercase();
        require(
            seen_paths.insert(normalized_path),
            format!("Capture-Tabellenpfad {index} ist doppelt."),
        )?;
    }

    require(
        normalized.get("schema").and_then(Value::as_str)
            == Some("zugfolge-normalized-observations/v1"),
        "Unbekanntes Schema der normalisierten Beobachtungen.",
    )?;
    require(
        normalized.pointer("/capture/manifestSha256") == capture_manifest_record.get("sha256"),
        "Normalisierung ist nicht an das Capture-Manifest gebunden.",
    )?;
    require(
        normalized.pointer("/capture/configSha256") == capture_config_record.get("sha256"),
        "Normalisierung ist nicht an die Capture-Konfiguration gebunden.",
    )?;
    require(
        normalized.pointer("/capture/archiveSha256") == source_archive_record.get("sha256"),
        "Normalisierung ist nicht an das Quellarchiv gebunden.",
    )?;
    let source_tables_hash = sha256(&Value::Array(manifest_tables.clone()));
    require(
        normalized
            .pointer("/capture/sourceTablesSha256")
            .and_then(Value::as_str)
            == Some(source_tables_hash.as_str()),
        "Normalisierung ist nicht an alle Quelltabellen gebunden.",
    )?;
    let observations_hash = sha256(normalized.get("observations").unwrap_or(&Value::Null));
    require(
        normalized.get("observationsSha256").and_then(Value::as_str)
            == Some(observations_hash.as_str()),
        "Hash der normalisierten Beobachtungen stimmt nicht.",
    )?;
    let expected_corpus_binding = json!({
        "captureConfigSha256": capture_config_record["sha256"],
        "captureManifestSha256": capture_manifest_record["sha256"],
        "sourceArchiveSha256": source_archive_record["sha256"],
        "sourceTablesSha256": source_tables_hash,
        "normalizedObservationsSha256": normalized_record["sha256"],
        "observationsSha256": observations_hash,
    });
    exact_value(
        corpus.get("artifactBinding").unwrap_or(&Value::Null),
        &expected_corpus_binding,
        "Referenzkorpus.artifactBinding",
    )?;
    exact_value(
        corpus.get("source").unwrap_or(&Value::Null),
        capture_config.get("source").unwrap_or(&Value::Null),
        "Referenzkorpus.source",
    )?;

    let expected_report = build_reference_report(input)?;
    let (_, report) = loaded_json_artifact(input, "report")?;
    exact_value(
        report.get("tolerance").unwrap_or(&Value::Null),
        expected_report.get("tolerance").unwrap_or(&Value::Null),
        "Reporttoleranz",
    )?;
    exact_value(&report, &expected_report, "Abweichungsreport")?;
    let expected_release = build_qualified_reference_release(input)?;
    let (_, release_manifest) = loaded_json_artifact(input, "releaseManifest")?;
    exact_value(
        &release_manifest,
        &expected_release,
        "Qualifiziertes Release-Manifest",
    )?;
    Ok(json!({
        "report": expected_report,
        "releaseManifest": expected_release,
        "referenceCorpusSha256": corpus_record["sha256"],
    }))
}

fn decode<T: for<'de> Deserialize<'de>>(value: &Value, what: &str) -> Result<T> {
    serde_json::from_value(value.clone())
        .map_err(|error| ReleaseManifestError::new(format!("{what}: {error}")))
}

fn validate_config(config: &GermanyConfig) -> Result<()> {
    require(
        config.schema == "zugfolge-germany-release-config/v1",
        "Unbekannte Deutschland-Konfiguration.",
    )?;
    require(
        non_empty(&config.release.release_id),
        "Deutschland-Konfiguration ohne Release-ID.",
    )?;
    require(
        config.release.timetable_year > 0,
        "Deutschland-Konfiguration ohne Fahrplanjahr.",
    )?;
    require(
        non_empty(&config.pipeline.version),
        "Deutschland-Konfiguration ohne Pipelineversion.",
    )?;

    let release_prefix = format!("infra-deutschland-{}.", config.release.timetable_year);
    let release_revision = config
        .release
        .release_id
        .strip_prefix(&release_prefix)
        .and_then(|revision| {
            revision
                .parse::<u64>()
                .ok()
                .filter(|parsed| parsed.to_string() == revision)
        });
    require(
        release_revision.is_some_and(|revision| revision > 0),
        "Deutschland-Release-ID muss Fahrplanjahr und positive Revision exakt binden.",
    )?;
    let release_revision = release_revision.expect("zuvor validierte positive Release-Revision");
    let release_version = config
        .release
        .release_id
        .strip_prefix("infra-deutschland-")
        .expect("zuvor validierter Deutschland-Release-Präfix");
    let requires_operational_deriver = config.release.timetable_year > 2026
        || (config.release.timetable_year == 2026 && release_revision >= 3);
    require(
        !requires_operational_deriver || config.pipeline.operational_deriver.is_some(),
        "Deutschland-Releases ab 2026.3 brauchen den OperationalDeriver-v2-Subvertrag.",
    )?;
    let Some(operational_deriver) = &config.pipeline.operational_deriver else {
        return Ok(());
    };
    require(
        operational_deriver.entrypoint
            == "tools/region-import/germany/run-operational-infrastructure-v2.mjs",
        "OperationalDeriver besitzt nicht den festgelegten EntryPoint.",
    )?;
    require(
        operational_deriver.specification
            == format!(
                "tools/region-import/germany/operational-infrastructure.annual-{release_version}.json"
            ),
        "OperationalDeriver-Spezifikation ist nicht exakt an den Deutschland-Release gebunden.",
    )?;
    let derived_root = format!("var/derived/germany-{release_version}");
    require(
        operational_deriver.candidate
            == format!("{derived_root}/operational-infrastructure-v2.candidate.json"),
        "OperationalDeriver-Candidate ist nicht exakt an den Deutschland-Release gebunden.",
    )?;
    require(
        operational_deriver.report
            == format!("{derived_root}/operational-infrastructure-v2.derivation-report.json"),
        "OperationalDeriver-Bericht ist nicht exakt an den Deutschland-Release gebunden.",
    )?;
    require(
        operational_deriver.output == format!("{derived_root}/operational-infrastructure-v2.json"),
        "OperationalDeriver-Ausgabe ist nicht exakt an den Deutschland-Release gebunden.",
    )
}

fn validate_catalog(catalog: &SourceCatalog) -> Result<()> {
    require(
        catalog.schema == "zugfolge-germany-source-catalog/v1",
        "Unbekanntes Quellenkatalogschema.",
    )?;
    require(!catalog.sources.is_empty(), "Quellenkatalog ist leer.")?;
    let mut ids = BTreeSet::new();
    for source in &catalog.sources {
        require(non_empty(&source.id), "Quelle ohne ID.")?;
        require(
            ids.insert(source.id.as_str()),
            format!("Doppelte Quelle {}.", source.id),
        )?;
        require(
            non_empty(&source.rights_source_id),
            format!("Quelle {} ohne Rechte-ID.", source.id),
        )?;
        require(
            non_empty(&source.source_license),
            format!("Quelle {} ohne Quellenlizenz.", source.id),
        )?;
        if source.role == SourceRole::InternalValidation {
            require(
                !source.ship_attribution,
                format!(
                    "Interne Evidenz {} darf keine Auslieferungsattribution erzeugen.",
                    source.id
                ),
            )?;
            require(
                source.class_a_eligible == Some(false),
                format!(
                    "Interne Evidenz {} darf nicht allein Klasse A erzeugen.",
                    source.id
                ),
            )?;
        } else {
            require(
                source.ship_attribution,
                format!(
                    "Releasequelle {} darf nicht aus der oeffentlichen Quellenbindung verschwinden.",
                    source.id
                ),
            )?;
        }
        if source.ship_attribution {
            require(
                non_empty(&source.attribution),
                format!("Quelle {} ohne Attribution.", source.id),
            )?;
        }
    }
    Ok(())
}

fn validate_rights(catalog: &SourceCatalog, registry: &RightsRegistry) -> Result<()> {
    validate_catalog(catalog)?;
    require(registry.version > 0, "Unbekanntes Rechte-Registerschema.")?;
    let mut by_id = BTreeMap::new();
    for rights in &registry.quellen {
        require(non_empty(&rights.id), "Rechtequelle ohne ID.")?;
        require(
            by_id.insert(rights.id.as_str(), rights).is_none(),
            format!("Doppelte Rechtequelle {}.", rights.id),
        )?;
    }
    for source in &catalog.sources {
        let rights = by_id.get(source.rights_source_id.as_str()).ok_or_else(|| {
            ReleaseManifestError::new(format!(
                "Rechtequelle {} für {} ist nicht registriert.",
                source.rights_source_id, source.id
            ))
        })?;
        match source.role {
            SourceRole::ReleaseInput | SourceRole::OptionalReleaseInput => require(
                rights.status == "freigegeben",
                format!(
                    "Rechtequelle {} für {} ist nicht freigegeben.",
                    source.rights_source_id, source.id
                ),
            )?,
            SourceRole::InternalValidation => require(
                rights.status == "entwicklung" || rights.status == "freigegeben",
                format!(
                    "Interne Evidenzquelle {} ist nicht zur Entwicklung freigegeben.",
                    source.rights_source_id
                ),
            )?,
        }
        let decision = rights.entscheidung.as_ref().ok_or_else(|| {
            ReleaseManifestError::new(format!(
                "Rechtequelle {} ohne datierte Freigabe.",
                source.rights_source_id
            ))
        })?;
        require(
            non_empty(&decision.datum) && non_empty(&decision.pruefer),
            format!(
                "Rechtequelle {} ohne datierte Freigabe.",
                source.rights_source_id
            ),
        )?;
    }
    Ok(())
}

fn validate_capture(
    capture: &CaptureManifest,
    catalog: &SourceCatalog,
    config: &GermanyConfig,
) -> Result<()> {
    require(
        capture.schema == "zugfolge-source-capture/v1"
            || capture.schema == "zugfolge-source-capture/v2",
        "Unbekanntes Capture-Schema.",
    )?;
    if capture.schema == "zugfolge-source-capture/v2" {
        require(
            capture.release_id.as_deref() == Some(config.release.release_id.as_str())
                && capture.timetable_year == Some(config.release.timetable_year)
                && capture
                    .capture_plan_sha256
                    .as_deref()
                    .is_some_and(is_sha256),
            "Capture v2 ist nicht an Jahresrelease, Fahrplanjahr und Capture-Plan gebunden.",
        )?;
    } else {
        let requires_annual_capture_v2 = config
            .release
            .release_id
            .strip_prefix("infra-deutschland-2026.")
            .and_then(|revision| {
                revision
                    .parse::<u64>()
                    .ok()
                    .filter(|parsed| parsed.to_string() == revision)
            })
            .is_some_and(|revision| revision >= 3);
        require(
            !requires_annual_capture_v2,
            "Deutschland-2026-Releases ab Patch 3 duerfen das historische Source-Capture v1 nicht verwenden.",
        )?;
        require(
            capture
                .internal_evidence_ledger_sha256
                .as_deref()
                .is_some_and(is_sha256),
            "Capture v1 ohne Hash des internen Evidenzledgers.",
        )?;
    }
    require(
        capture.captured_at.as_bytes().get(4) == Some(&b'-')
            && capture.captured_at.as_bytes().get(7) == Some(&b'-')
            && capture.captured_at.as_bytes().get(10) == Some(&b'T'),
        "Capture ohne UTC-Zeitpunkt.",
    )?;
    require(
        capture.captured_at.ends_with('Z'),
        "Capture-Zeitpunkt ist nicht als UTC gekennzeichnet.",
    )?;
    let catalog_ids: BTreeSet<_> = catalog
        .sources
        .iter()
        .map(|source| source.id.as_str())
        .collect();
    let mut captured_ids = BTreeSet::new();
    for source in &capture.sources {
        require(
            catalog_ids.contains(source.id.as_str()),
            format!("Capture nennt unbekannte Quelle {}.", source.id),
        )?;
        require(
            captured_ids.insert(source.id.as_str()),
            format!("Capture nennt Quelle {} doppelt.", source.id),
        )?;
        require(
            non_empty(&source.version),
            format!("Capture {} ohne Version.", source.id),
        )?;
        require(
            non_empty(&source.file) && !source.file.contains(".."),
            format!("Capture {} mit ungültigem Dateipfad.", source.id),
        )?;
        require(
            source.bytes > 0,
            format!("Capture {} ohne Bytezahl.", source.id),
        )?;
        require(
            is_sha256(&source.sha256),
            format!("Capture {} ohne SHA-256.", source.id),
        )?;
    }
    for source in catalog
        .sources
        .iter()
        .filter(|source| source.role == SourceRole::ReleaseInput)
    {
        require(
            captured_ids.contains(source.id.as_str()),
            format!("Pflichtquelle {} fehlt im Capture.", source.id),
        )?;
    }
    Ok(())
}

fn quality_summary(report: &Value, config: &GermanyConfig) -> Result<Value> {
    let schema = report
        .get("schema")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if schema == "zugfolge-infrastructure-quality-report/v2" {
        let total = report
            .get("totalLengthMm")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        require(total > 0, "Qualitätsbericht ohne positive Gesamtlänge.")?;
        let classes = report.get("byClassLengthMm").and_then(Value::as_object);
        require(
            ["A", "B", "C"].into_iter().all(|class| {
                classes
                    .and_then(|values| values.get(class))
                    .and_then(Value::as_i64)
                    .is_some_and(|value| value >= 0)
            }),
            "Qualitätsbericht ohne vollständige Klassenlängen.",
        )?;
        let sum = ["A", "B", "C"]
            .into_iter()
            .map(|class| {
                classes
                    .and_then(|values| values.get(class))
                    .and_then(Value::as_i64)
                    .expect("Klassenlaengen wurden unmittelbar zuvor validiert")
            })
            .try_fold(0_i64, |sum, value| sum.checked_add(value))
            .ok_or_else(|| ReleaseManifestError::new("Klassenlaengen laufen ueber."))?;
        require(
            sum == total,
            "Klassenlaengen des Qualitaetsberichts ergeben nicht die Gesamtlaenge.",
        )?;
        require(
            classes
                .and_then(|values| values.get("C"))
                .and_then(Value::as_i64)
                == Some(0),
            "Klasse-C-Abschnitte duerfen nur in interner Diagnose, nicht im freigegebenen InfraRelease vorkommen.",
        )?;
        return Ok(json!({
            "totalLengthMm": total,
            "byClassLengthMm": report["byClassLengthMm"].clone(),
        }));
    }

    require(
        schema == "zugfolge-final-infrastructure-quality-report/v1",
        "Unbekannter Qualitätsbericht.",
    )?;
    require(
        report.get("releaseId").and_then(Value::as_str) == Some(&config.release.release_id),
        "Qualitätsbericht und InfraRelease nennen verschiedene Release-IDs.",
    )?;
    require(
        report.get("timetableYear").and_then(Value::as_i64) == Some(config.release.timetable_year),
        "Qualitätsbericht und InfraRelease nennen verschiedene Fahrplanjahre.",
    )?;
    require(
        report.get("deterministic").and_then(Value::as_bool) == Some(true)
            && report
                .pointer("/policy/classAFromSingleSourceOrAutomatedInference")
                .and_then(Value::as_bool)
                == Some(false),
        "Deutschland-Qualitätsbericht besitzt keinen konservativen Nachweisvertrag.",
    )?;
    let visible_features = report
        .pointer("/summary/visibleFeatures")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    require(
        visible_features > 0,
        "Deutschland-Qualitätsbericht ohne sichtbaren Korpus.",
    )?;
    let visible_layers = report
        .pointer("/summary/visibleLayers")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    require(
        visible_layers > 0,
        "Deutschland-Qualitaetsbericht ohne sichtbare Layer.",
    )?;
    let tracks = report
        .get("layers")
        .and_then(Value::as_array)
        .and_then(|layers| {
            layers
                .iter()
                .find(|layer| layer.get("name").and_then(Value::as_str) == Some("tracks"))
        })
        .ok_or_else(|| {
            ReleaseManifestError::new("Deutschland-Qualitätsbericht ohne Gleislänge.")
        })?;
    let total = tracks
        .get("totalLengthMm")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    require(total > 0, "Deutschland-Qualitätsbericht ohne Gleislänge.")?;
    let class_lengths = tracks
        .get("qualityClassLengthMm")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ReleaseManifestError::new("Deutschland-Qualitätsbericht ohne Gleislängen je Klasse.")
        })?;
    let mut sum = 0_i64;
    for class in ["A", "B", "C"] {
        let value = class_lengths
            .get(class)
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                ReleaseManifestError::new(
                    "Deutschland-Qualitätsbericht ohne Gleislängen je Klasse.",
                )
            })?;
        require(
            value >= 0,
            "Deutschland-Qualitätsbericht ohne Gleislängen je Klasse.",
        )?;
        sum = sum.checked_add(value).ok_or_else(|| {
            ReleaseManifestError::new("Gleislängen des Deutschland-Qualitätsberichts laufen über.")
        })?;
    }
    require(
        sum == total,
        "Gleislängen des Deutschland-Qualitätsberichts sind nicht vollständig.",
    )?;
    require(
        class_lengths.get("C").and_then(Value::as_i64) == Some(0),
        "Klasse-C-Abschnitte duerfen nur in interner Diagnose, nicht im freigegebenen InfraRelease vorkommen.",
    )?;
    let feature_classes = report
        .pointer("/summary/qualityClassFeatureCount")
        .cloned()
        .ok_or_else(|| {
            ReleaseManifestError::new(
                "Deutschland-Qualitätsbericht ohne vollständige Objektklassen.",
            )
        })?;
    for class in ["A", "B", "C"] {
        require(
            feature_classes
                .get(class)
                .and_then(Value::as_i64)
                .is_some_and(|value| value >= 0),
            "Deutschland-Qualitätsbericht ohne vollständige Objektklassen.",
        )?;
    }
    let feature_sum = ["A", "B", "C"]
        .into_iter()
        .map(|class| feature_classes[class].as_i64().expect("validiert"))
        .try_fold(0_i64, |sum, value| sum.checked_add(value))
        .ok_or_else(|| ReleaseManifestError::new("Objektklassen laufen ueber."))?;
    require(
        feature_sum == visible_features,
        "Objektklassen des Deutschland-Qualitaetsberichts ergeben nicht die sichtbaren Objekte.",
    )?;
    require(
        feature_classes.get("C").and_then(Value::as_i64) == Some(0),
        "Klasse-C-Objekte duerfen nur in interner Diagnose, nicht im freigegebenen InfraRelease vorkommen.",
    )?;
    Ok(json!({
        "totalLengthMm": total,
        "byClassLengthMm": tracks["qualityClassLengthMm"].clone(),
        "visibleFeatures": visible_features,
        "byClassFeatureCount": feature_classes,
        "visibleLayers": visible_layers,
    }))
}

fn class_count(value: &Value, context: &str) -> Result<(i64, i64, i64)> {
    let object = value
        .as_object()
        .ok_or_else(|| ReleaseManifestError::new(format!("{context} ist kein Objekt.")))?;
    let actual: BTreeSet<_> = object.keys().map(String::as_str).collect();
    require(
        actual == BTreeSet::from(["A", "B", "C"]),
        format!("{context} besitzt nicht exakt A, B und C."),
    )?;
    let read = |class: &str| {
        object
            .get(class)
            .and_then(Value::as_i64)
            .filter(|value| *value >= 0)
            .ok_or_else(|| ReleaseManifestError::new(format!("{context}.{class} ist ungueltig.")))
    };
    Ok((read("A")?, read("B")?, read("C")?))
}

fn static_map_quality_summary(report: &Value, config: &GermanyConfig) -> Result<Value> {
    require(
        report.get("schema").and_then(Value::as_str) == Some("zugfolge-static-map-quality/v2"),
        "Getrennter Kartenqualitaetsbericht ist kein Static-Map-Quality-v2.",
    )?;
    let release_version = config
        .release
        .release_id
        .strip_prefix("infra-deutschland-")
        .ok_or_else(|| ReleaseManifestError::new("Deutschland-Release-ID ist ungueltig."))?;
    require(
        report.get("releaseId").and_then(Value::as_str)
            == Some(format!("karte-deutschland-{release_version}-v2").as_str())
            && report.get("infrastructureCorpusId").and_then(Value::as_str)
                == Some(config.release.release_id.as_str())
            && report.get("timetableYear").and_then(Value::as_i64)
                == Some(config.release.timetable_year),
        "Static-Map-Quality-v2 verletzt Karten-, Korpus- oder Jahresbindung.",
    )?;
    require(
        report.get("purpose").and_then(Value::as_str) == Some("static-map-visible-quality")
            && report.get("deterministic").and_then(Value::as_bool) == Some(true),
        "Static-Map-Quality-v2 ist keine deterministische sichtbare Kartenqualitaet.",
    )?;
    require(
        report
            .pointer("/claims/detailedSourceReportShipped")
            .and_then(Value::as_bool)
            == Some(false)
            && report
                .pointer("/claims/operationalInfraRelease")
                .and_then(Value::as_bool)
                == Some(false)
            && report
                .pointer("/claims/productionActivationEligible")
                .and_then(Value::as_bool)
                == Some(false),
        "Static-Map-Quality-v2 lockert seine nichtbetriebliche Kartengrenze.",
    )?;
    for (class, meaning) in [
        ("A", "complete-evidence"),
        ("B", "conservative-visible-model"),
        ("C", "visible-not-operationally-orderable"),
    ] {
        require(
            report
                .pointer(&format!("/classification/{class}"))
                .and_then(Value::as_str)
                == Some(meaning),
            "Static-Map-Quality-v2 veraendert die oeffentliche A/B/C-Semantik.",
        )?;
    }
    require(
        report
            .pointer("/sourceReport/content")
            .and_then(Value::as_str)
            == Some("detailed-infrastructure-quality-report")
            && report
                .pointer("/sourceReport/binding")
                .and_then(Value::as_str)
                == Some("sha256")
            && report
                .pointer("/sourceReport/bytes")
                .and_then(Value::as_i64)
                .is_some_and(|bytes| bytes > 0)
            && report
                .pointer("/sourceReport/sha256")
                .and_then(Value::as_str)
                .is_some_and(is_sha256)
            && report
                .pointer("/sourceReport/shipped")
                .and_then(Value::as_bool)
                == Some(false),
        "Static-Map-Quality-v2 besitzt keine gueltige Detailberichtbindung.",
    )?;
    let visible_layers = report
        .pointer("/summary/visibleLayers")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let visible_features = report
        .pointer("/summary/visibleFeatures")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let summary_classes = report
        .pointer("/summary/qualityClassFeatureCount")
        .ok_or_else(|| ReleaseManifestError::new("Static-Map-Quality-v2 ohne Objektklassen."))?;
    let (summary_a, summary_b, summary_c) = class_count(
        summary_classes,
        "Static-Map-Quality-v2.summary.qualityClassFeatureCount",
    )?;
    require(
        visible_layers == 10
            && visible_features > 0
            && summary_a
                .checked_add(summary_b)
                .and_then(|sum| sum.checked_add(summary_c))
                == Some(visible_features),
        "Static-Map-Quality-v2 besitzt keinen vollstaendigen sichtbaren Zehn-Layer-Korpus.",
    )?;
    let expected_layers = [
        "rail_corridors",
        "operating_points",
        "stations",
        "tracks",
        "platforms",
        "switches",
        "signals",
        "blocks",
        "conflict_resources",
        "rail_context",
    ];
    let layers = report
        .get("layers")
        .and_then(Value::as_array)
        .filter(|layers| layers.len() == expected_layers.len())
        .ok_or_else(|| {
            ReleaseManifestError::new("Static-Map-Quality-v2 besitzt nicht exakt zehn Layer.")
        })?;
    let mut aggregate = (0_i64, 0_i64, 0_i64);
    let mut aggregate_features = 0_i64;
    let mut track_summary = None;
    for (index, layer) in layers.iter().enumerate() {
        require(
            layer.get("name").and_then(Value::as_str) == Some(expected_layers[index]),
            "Static-Map-Quality-v2 verletzt die kanonische Layerreihenfolge.",
        )?;
        let features = layer
            .get("features")
            .and_then(Value::as_i64)
            .filter(|features| *features > 0)
            .ok_or_else(|| ReleaseManifestError::new("Static-Map-Layer ohne Features."))?;
        let classes = layer
            .get("qualityClassFeatureCount")
            .ok_or_else(|| ReleaseManifestError::new("Static-Map-Layer ohne Objektklassen."))?;
        let count = class_count(classes, "Static-Map-Layer.qualityClassFeatureCount")?;
        require(
            count
                .0
                .checked_add(count.1)
                .and_then(|sum| sum.checked_add(count.2))
                == Some(features),
            "Static-Map-Layerklassen ergeben nicht seine Features.",
        )?;
        aggregate.0 = aggregate
            .0
            .checked_add(count.0)
            .ok_or_else(|| ReleaseManifestError::new("Static-Map-Objektklassen laufen ueber."))?;
        aggregate.1 = aggregate
            .1
            .checked_add(count.1)
            .ok_or_else(|| ReleaseManifestError::new("Static-Map-Objektklassen laufen ueber."))?;
        aggregate.2 = aggregate
            .2
            .checked_add(count.2)
            .ok_or_else(|| ReleaseManifestError::new("Static-Map-Objektklassen laufen ueber."))?;
        aggregate_features = aggregate_features
            .checked_add(features)
            .ok_or_else(|| ReleaseManifestError::new("Static-Map-Featurezahl laeuft ueber."))?;
        if expected_layers[index] == "tracks" {
            let total = layer
                .get("totalLengthMm")
                .and_then(Value::as_i64)
                .filter(|total| *total > 0)
                .ok_or_else(|| ReleaseManifestError::new("Static-Map-Gleise ohne Laenge."))?;
            let lengths = layer.get("qualityClassLengthMm").ok_or_else(|| {
                ReleaseManifestError::new("Static-Map-Gleise ohne Klassenlaengen.")
            })?;
            let (a, b, c) = class_count(lengths, "Static-Map-Gleislaengen")?;
            require(
                a.checked_add(b).and_then(|sum| sum.checked_add(c)) == Some(total),
                "Static-Map-Gleislaengen sind unvollstaendig.",
            )?;
            track_summary = Some((total, lengths.clone(), c));
        }
    }
    require(
        aggregate == (summary_a, summary_b, summary_c) && aggregate_features == visible_features,
        "Static-Map-Layeraggregation und Gesamtsumme weichen ab.",
    )?;
    let (total_length_mm, by_class_length_mm, class_c_length_mm) = track_summary
        .ok_or_else(|| ReleaseManifestError::new("Static-Map-Quality-v2 ohne Gleislayer."))?;
    Ok(json!({
        "totalLengthMm": total_length_mm,
        "byClassLengthMm": by_class_length_mm,
        "visibleFeatures": visible_features,
        "byClassFeatureCount": summary_classes,
        "visibleLayers": visible_layers,
        "classCVisible": summary_c > 0 || class_c_length_mm > 0,
    }))
}

fn operational_quality_summary(
    report: &Value,
    report_bytes: &[u8],
    config: &GermanyConfig,
    artifacts: &[Artifact],
    static_quality: &Value,
    static_quality_bytes: &[u8],
) -> Result<Value> {
    require(
        report.get("schema").and_then(Value::as_str)
            == Some("zugfolge-operational-infrastructure-quality-report/v1")
            && report.get("deterministic").and_then(Value::as_bool) == Some(true),
        "Operational-v2-Qualitaet besitzt nicht das getrennte Operational-Quality-v1-Schema.",
    )?;
    require(
        report.get("releaseId").and_then(Value::as_str) == Some(config.release.release_id.as_str())
            && report.get("timetableYear").and_then(Value::as_i64)
                == Some(config.release.timetable_year)
            && report.get("scopeId").and_then(Value::as_str)
                == Some("deutschland-ebo-operational-v2"),
        "Operational-v2-Qualitaet verletzt Release-, Jahres- oder Scope-Bindung.",
    )?;
    for (path, expected) in [
        ("/separation/mapClassCReclassified", false),
        ("/separation/mapClassCBlocksOperationalQualityGate", false),
        ("/separation/mapObjectsRemoved", false),
        ("/qualityGate/closureReceiptVerified", true),
        ("/qualityGate/nativeOperationalValidationVerified", true),
        ("/qualityGate/operationalClassCZero", true),
        ("/qualityGate/ordinaryAssumptionsPromoted", false),
        ("/qualityGate/mapClassCReclassified", false),
        ("/qualityGate/operationalQualityEligible", true),
        ("/qualityGate/signatureImplied", false),
        ("/qualityGate/activationImplied", false),
    ] {
        require(
            report.pointer(path).and_then(Value::as_bool) == Some(expected),
            format!("Operational-v2-Qualitaetsgate verletzt `{path}`."),
        )?;
    }
    require(
        report
            .pointer("/separation/mapEvidencePurpose")
            .and_then(Value::as_str)
            == Some("visible-map-quality-evidence")
            && report
                .pointer("/separation/operationalEvidencePurpose")
                .and_then(Value::as_str)
                == Some("closed-operational-v2-model"),
        "Operational-v2-Qualitaet vermischt Karten- und Betriebszweck.",
    )?;
    let map = report
        .get("mapEvidence")
        .ok_or_else(|| ReleaseManifestError::new("Operational-v2-Qualitaet ohne Kartenbeleg."))?;
    let map_object = map
        .as_object()
        .ok_or_else(|| ReleaseManifestError::new("Operational-v2-Kartenbeleg ist kein Objekt."))?;
    let map_keys: BTreeSet<_> = map_object.keys().map(String::as_str).collect();
    require(
        map_keys
            == BTreeSet::from([
                "bytes",
                "infrastructureCorpusId",
                "mapReleaseId",
                "qualityClassFeatureCount",
                "schema",
                "sha256",
                "sourceReport",
                "trackLengthMm",
                "trackQualityClassLengthMm",
                "visibleFeatures",
                "visibleLayers",
            ]),
        "Operational-v2-Kartenbeleg besitzt nicht exakt den Static-v2-Doppelbindungsvertrag.",
    )?;
    let source_report = map.get("sourceReport").ok_or_else(|| {
        ReleaseManifestError::new("Operational-v2-Kartenbeleg ohne Detailberichtbindung.")
    })?;
    let source_report_object = source_report.as_object().ok_or_else(|| {
        ReleaseManifestError::new("Operational-v2-Detailberichtbindung ist kein Objekt.")
    })?;
    let source_report_keys: BTreeSet<_> = source_report_object.keys().map(String::as_str).collect();
    require(
        source_report_keys == BTreeSet::from(["bytes", "schema", "sha256", "shipped"]),
        "Operational-v2-Detailberichtbindung besitzt nicht exakt den v1-SourceReport-Vertrag.",
    )?;
    let actual_static_bytes = i64::try_from(static_quality_bytes.len()).map_err(|_| {
        ReleaseManifestError::new("Static-Map-Quality-v2-Dateigroesse laeuft ueber.")
    })?;
    let actual_static_sha256 = sha256_bytes(static_quality_bytes);
    require(
        map.get("schema").and_then(Value::as_str) == Some("zugfolge-static-map-quality/v2")
            && map.get("mapReleaseId") == static_quality.get("releaseId")
            && map.get("infrastructureCorpusId") == static_quality.get("infrastructureCorpusId")
            && map.get("bytes").and_then(Value::as_i64) == Some(actual_static_bytes)
            && map.get("sha256").and_then(Value::as_str) == Some(actual_static_sha256.as_str())
            && source_report.get("schema").and_then(Value::as_str)
                == Some("zugfolge-final-infrastructure-quality-report/v1")
            && source_report.get("bytes") == static_quality.pointer("/sourceReport/bytes")
            && source_report.get("sha256") == static_quality.pointer("/sourceReport/sha256")
            && source_report.get("shipped").and_then(Value::as_bool) == Some(false)
            && source_report.get("shipped") == static_quality.pointer("/sourceReport/shipped")
            && map.get("visibleFeatures") == static_quality.pointer("/summary/visibleFeatures")
            && map.get("visibleLayers") == static_quality.pointer("/summary/visibleLayers")
            && map.get("qualityClassFeatureCount")
                == static_quality.pointer("/summary/qualityClassFeatureCount"),
        "Operational-v2-Qualitaet bindet nicht denselben sichtbaren Kartenbeleg wie Static-Map-v2.",
    )?;
    let static_tracks = static_quality
        .get("layers")
        .and_then(Value::as_array)
        .and_then(|layers| {
            layers
                .iter()
                .find(|layer| layer.get("name").and_then(Value::as_str) == Some("tracks"))
        })
        .ok_or_else(|| ReleaseManifestError::new("Static-Map-v2 ohne Gleislayer."))?;
    require(
        map.get("trackLengthMm") == static_tracks.get("totalLengthMm")
            && map.get("trackQualityClassLengthMm") == static_tracks.get("qualityClassLengthMm"),
        "Operational-v2-Qualitaet veraendert die sichtbaren Kartengleisklassen.",
    )?;
    let model = report.get("operationalModel").ok_or_else(|| {
        ReleaseManifestError::new("Operational-v2-Qualitaet ohne Betriebsmodell.")
    })?;
    let model_object = model.as_object().ok_or_else(|| {
        ReleaseManifestError::new("Operational-v2-Betriebsmodell ist kein Objekt.")
    })?;
    let model_keys: BTreeSet<_> = model_object.keys().map(String::as_str).collect();
    require(
        model_keys
            == BTreeSet::from([
                "closureReceiptSha256",
                "coverage",
                "objectLevelProvenanceShipped",
                "observedAndSyntheticObjectsShareRuntimeCollections",
                "operationalArtifact",
                "policyId",
                "policySha256",
                "provenance",
                "qualityClass",
                "realGeometry",
                "realInterlockingFactsClaimed",
                "simulatedOperationalAssignment",
                "syntheticOperationalDetailsShipped",
                "timetableRouteEvidence",
            ]),
        "Operational-v2-Betriebsmodell besitzt nicht exakt den ehrlichen v2-Provenienzvertrag.",
    )?;
    require(
        model.get("policyId").and_then(Value::as_str) == Some("synthetic-operational-b/v2")
            && model
                .get("policySha256")
                .and_then(Value::as_str)
                .is_some_and(is_sha256)
            && model
                .get("closureReceiptSha256")
                .and_then(Value::as_str)
                .is_some_and(is_sha256)
            && model.get("qualityClass").and_then(Value::as_str) == Some("B")
            && model.get("provenance").and_then(Value::as_str) == Some("derived")
            && model.get("realGeometry").and_then(Value::as_bool) == Some(true)
            && model
                .get("simulatedOperationalAssignment")
                .and_then(Value::as_bool)
                == Some(true)
            && model
                .get("realInterlockingFactsClaimed")
                .and_then(Value::as_bool)
                == Some(false)
            && model
                .get("syntheticOperationalDetailsShipped")
                .and_then(Value::as_bool)
                == Some(true)
            && model
                .get("objectLevelProvenanceShipped")
                .and_then(Value::as_bool)
                == Some(false)
            && model
                .get("observedAndSyntheticObjectsShareRuntimeCollections")
                .and_then(Value::as_bool)
                == Some(true),
        "Operational-v2-Qualitaet besitzt keine ehrliche Derived/B-Simulationsprovenienz.",
    )?;
    let timetable_route_evidence = model.get("timetableRouteEvidence").ok_or_else(|| {
        ReleaseManifestError::new("Operational-v2-Betriebsmodell ohne freien GTFS-Fahrwegbeleg.")
    })?;
    let timetable_route_evidence_object = timetable_route_evidence
        .as_object()
        .ok_or_else(|| ReleaseManifestError::new("Freier GTFS-Fahrwegbeleg ist kein Objekt."))?;
    let timetable_route_evidence_keys: BTreeSet<_> = timetable_route_evidence_object
        .keys()
        .map(String::as_str)
        .collect();
    require(
        timetable_route_evidence_keys
            == BTreeSet::from([
                "archive",
                "archiveSha256",
                "completeRouteCount",
                "derivationRule",
                "externalOperationalNetworkProvenance",
                "gtfsSnapshotBytes",
                "gtfsSnapshotSha256",
                "policyId",
                "realGeometry",
                "realInterlockingFactsClaimed",
                "reportBytes",
                "reportSchema",
                "reportSha256",
                "routeRecordCount",
                "routeSetSha256",
                "routesBytes",
                "routesSha256",
                "sameStopTransitionCount",
                "selectedSegmentCount",
                "selectionRule",
                "simulatedOperationalAssignment",
                "snapshotHash",
                "sourceLicense",
                "sourceLicenseAsPublished",
            ]),
        "Freier GTFS-Fahrwegbeleg besitzt nicht exakt den v2-Closure-Vertrag.",
    )?;
    let selected_segment_count = timetable_route_evidence
        .get("selectedSegmentCount")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let complete_route_count = timetable_route_evidence
        .get("completeRouteCount")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let route_record_count = timetable_route_evidence
        .get("routeRecordCount")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    require(
        timetable_route_evidence
            .get("reportSchema")
            .and_then(Value::as_str)
            == Some("zugfolge-germany-timetable-route-report/v2")
            && timetable_route_evidence.get("policyId") == model.get("policyId")
            && timetable_route_evidence
                .get("derivationRule")
                .and_then(Value::as_str)
                == Some("all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2")
            && timetable_route_evidence
                .get("selectionRule")
                .and_then(Value::as_str)
                == Some(
                    "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
                )
            && timetable_route_evidence
                .get("sourceLicense")
                .and_then(Value::as_str)
                == Some("CC-BY-4.0")
            && timetable_route_evidence
                .get("sourceLicenseAsPublished")
                .and_then(Value::as_str)
                == Some("CC BY 4.0")
            && timetable_route_evidence
                .get("archive")
                .and_then(Value::as_str)
                .is_some_and(|archive| !archive.is_empty())
            && ["reportBytes", "routesBytes", "gtfsSnapshotBytes"]
                .iter()
                .all(|field| {
                    timetable_route_evidence
                        .get(*field)
                        .and_then(Value::as_i64)
                        .is_some_and(|bytes| bytes > 0)
                })
            && [
                "reportSha256",
                "routesSha256",
                "gtfsSnapshotSha256",
                "snapshotHash",
                "archiveSha256",
                "routeSetSha256",
            ]
            .iter()
            .all(|field| {
                timetable_route_evidence
                    .get(*field)
                    .and_then(Value::as_str)
                    .is_some_and(is_sha256)
            })
            && timetable_route_evidence.get("routesSha256")
                == timetable_route_evidence.get("routeSetSha256")
            && selected_segment_count > 0
            && selected_segment_count == complete_route_count
            && complete_route_count == route_record_count
            && timetable_route_evidence
                .get("sameStopTransitionCount")
                .and_then(Value::as_i64)
                .is_some_and(|count| count >= 0)
            && timetable_route_evidence
                .get("realGeometry")
                .and_then(Value::as_bool)
                == Some(true)
            && timetable_route_evidence
                .get("simulatedOperationalAssignment")
                .and_then(Value::as_bool)
                == Some(true)
            && timetable_route_evidence
                .get("realInterlockingFactsClaimed")
                .and_then(Value::as_bool)
                == Some(false)
            && timetable_route_evidence
                .get("externalOperationalNetworkProvenance")
                .and_then(Value::as_bool)
                == Some(false),
        "Freier GTFS-Fahrwegbeleg verletzt Policy, Bytebindung, Vollstaendigkeit oder Provenienz.",
    )?;
    for field in [
        "blockResources",
        "directedEdges",
        "edgeGeometries",
        "interlockingRoutes",
        "platformIntervals",
        "regionBoundaries",
        "routeVersions",
        "rzueLayouts",
        "signals",
        "switches",
    ] {
        require(
            model
                .pointer(&format!("/coverage/{field}"))
                .and_then(Value::as_i64)
                .is_some_and(|count| count > 0),
            format!("Operational-v2-Qualitaet besitzt keinen positiven `{field}`-Abschluss."),
        )?;
    }
    let (class_a, class_b, class_c) = class_count(
        report
            .pointer("/summary/operationalQualityClassArtifactCount")
            .ok_or_else(|| {
                ReleaseManifestError::new("Operational-v2-Qualitaet ohne operative Klassenbilanz.")
            })?,
        "Operational-v2-Qualitaet.summary.operationalQualityClassArtifactCount",
    )?;
    let map_class_c = map
        .pointer("/qualityClassFeatureCount/C")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    require(
        class_a == 0
            && class_b == 1
            && class_c == 0
            && report
                .pointer("/summary/unresolvedRequired")
                .and_then(Value::as_i64)
                == Some(0)
            && report
                .pointer("/summary/visibleMapClassCFeatureCount")
                .and_then(Value::as_i64)
                == Some(map_class_c),
        "Operational-v2-Qualitaet besitzt keine geschlossene B=1/C=0-Bilanz.",
    )?;
    let artifact = artifacts
        .iter()
        .find(|artifact| {
            artifact.extra.get("kind").and_then(Value::as_str)
                == Some(OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA)
        })
        .ok_or_else(|| ReleaseManifestError::new("Operational-v2-Artefakt fehlt."))?;
    let candidate_bytes = model
        .pointer("/operationalArtifact/bytes")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let candidate_sha256 = model
        .pointer("/operationalArtifact/sha256")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let candidate_state_hash = model
        .pointer("/operationalArtifact/stateHash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    require(
        candidate_bytes == artifact.bytes
            && candidate_sha256 == artifact.sha256
            && artifact.extra.get("stateHash").and_then(Value::as_str)
                == Some(candidate_state_hash)
            && is_sha256(candidate_sha256)
            && is_sha256(candidate_state_hash)
            && candidate_sha256 != candidate_state_hash,
        "Operational-v2-Qualitaet und natives Artefakt besitzen keine identische Byte-/Zustandsbindung.",
    )?;
    Ok(json!({
        "reportSha256": sha256_bytes(report_bytes),
        "policyId": model["policyId"],
        "policySha256": model["policySha256"],
        "closureReceiptSha256": model["closureReceiptSha256"],
        "qualityClass": "B",
        "provenance": "derived",
        "candidateBytes": candidate_bytes,
        "candidateSha256": candidate_sha256,
        "candidateStateHash": candidate_state_hash,
        "staticMapQualityBytes": actual_static_bytes,
        "staticMapQualitySha256": actual_static_sha256,
        "staticMapSourceReportSha256": source_report["sha256"],
        "realInterlockingFactsClaimed": false,
        "syntheticOperationalDetailsShipped": true,
        "objectLevelProvenanceShipped": false,
        "observedAndSyntheticObjectsShareRuntimeCollections": true,
        "timetableRouteEvidence": timetable_route_evidence,
        "operationalQualityEligible": true,
        "signatureImplied": false,
        "activationImplied": false,
        "unresolvedRequired": 0,
    }))
}

enum ReleaseQualityInput<'a> {
    Legacy(&'a Value),
    Operational {
        static_report: &'a Value,
        static_bytes: &'a [u8],
        operational_report: &'a Value,
        operational_bytes: &'a [u8],
    },
}

fn build_public_infra_release_internal(
    config_value: &Value,
    catalog_value: &Value,
    rights_value: &Value,
    capture_value: &Value,
    artifacts_value: &Value,
    quality_input: ReleaseQualityInput<'_>,
) -> Result<Value> {
    let config: GermanyConfig = decode(config_value, "Deutschland-Konfiguration")?;
    let catalog: SourceCatalog = decode(catalog_value, "Quellenkatalog")?;
    let rights: RightsRegistry = decode(rights_value, "Rechte-Register")?;
    let capture: CaptureManifest = decode(capture_value, "Capture-Manifest")?;
    let artifacts: Vec<Artifact> = decode(artifacts_value, "Artefaktliste")?;

    validate_config(&config)?;
    validate_rights(&catalog, &rights)?;
    validate_capture(&capture, &catalog, &config)?;
    require(!artifacts.is_empty(), "InfraRelease ohne Artefakte.")?;
    let mut artifact_ids = BTreeSet::new();
    for artifact in &artifacts {
        require(non_empty(&artifact.id), "Artefakt ohne ID.")?;
        require(
            artifact_ids.insert(artifact.id.as_str()),
            format!("Artefakt {} ist doppelt.", artifact.id),
        )?;
        require(
            non_empty(&artifact.file)
                && !artifact.file.contains("..")
                && !artifact.file.starts_with('/')
                && !artifact.file.starts_with('\\')
                && !artifact.file.contains(':'),
            format!(
                "Artefakt {} besitzt keinen sicheren relativen Pfad.",
                artifact.id
            ),
        )?;
        require(
            artifact.bytes > 0,
            format!("Artefakt {} ohne Bytezahl.", artifact.id),
        )?;
        require(
            is_sha256(&artifact.sha256),
            format!("Artefakt {} ohne SHA-256.", artifact.id),
        )?;
        require(
            artifact.extra.get("kind").and_then(Value::as_str) != Some("train-map-projection"),
            "Weltbezogene Zugprojektionen gehoeren nicht in den statischen InfraRelease-Artefaktvertrag.",
        )?;
    }
    validate_operational_infrastructure_artifact_binding(&artifacts, &config.release.release_id)?;
    let (quality_report, operational_quality_report, static_quality_bytes) = match quality_input {
        ReleaseQualityInput::Legacy(report) => (report, None, None),
        ReleaseQualityInput::Operational {
            static_report,
            static_bytes,
            operational_report,
            operational_bytes,
        } => (
            static_report,
            Some((operational_report, operational_bytes)),
            Some(static_bytes),
        ),
    };
    let quality = operational_quality_report.map_or_else(
        || quality_summary(quality_report, &config),
        |_| static_map_quality_summary(quality_report, &config),
    )?;
    let operational_quality = operational_quality_report
        .map(|(report, report_bytes)| {
            let bytes = static_quality_bytes.ok_or_else(|| {
                ReleaseManifestError::new(
                    "Operational-v2-Qualitaet besitzt keine bindbaren Static-v2-Dateibytes.",
                )
            })?;
            operational_quality_summary(
                report,
                report_bytes,
                &config,
                &artifacts,
                quality_report,
                bytes,
            )
        })
        .transpose()?;
    let captured: BTreeMap<_, _> = capture
        .sources
        .iter()
        .map(|source| (source.id.as_str(), source))
        .collect();
    let mut public_sources = Vec::new();
    for source in catalog.sources.iter().filter(|source| {
        matches!(
            source.role,
            SourceRole::ReleaseInput | SourceRole::OptionalReleaseInput
        ) && source.ship_attribution
            && captured.contains_key(source.id.as_str())
    }) {
        let item = captured[source.id.as_str()];
        public_sources.push(json!({
            "id": source.id,
            "rightsSourceId": source.rights_source_id,
            "version": item.version,
            "sha256": item.sha256,
            "sourceLicense": source.source_license,
            "attribution": source.attribution,
            "modifications": source.modifications,
        }));
    }
    public_sources.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));

    let mut artifacts_json = Vec::new();
    for artifact in artifacts {
        let mut value = artifact.extra;
        value.insert("id".into(), Value::String(artifact.id));
        value.insert("file".into(), Value::String(artifact.file));
        value.insert("bytes".into(), Value::Number(artifact.bytes.into()));
        value.insert("sha256".into(), Value::String(artifact.sha256));
        artifacts_json.push(Value::Object(value));
    }
    artifacts_json.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));

    let public_capture = json!({
        "schema": "zugfolge-public-source-capture/v1",
        "capturedAt": capture.captured_at,
        "sources": public_sources.iter().map(|source| json!({
            "id": source["id"],
            "version": source["version"],
            "sha256": source["sha256"],
        })).collect::<Vec<_>>(),
    });
    let internal_sources: Vec<_> = catalog
        .sources
        .iter()
        .filter(|source| source.role == SourceRole::InternalValidation)
        .collect();
    let mut quality_value = json!({
        "reportSha256": sha256(quality_report),
        "totalLengthMm": quality["totalLengthMm"],
        "byClassLengthMm": quality["byClassLengthMm"],
        "classCPlayable": false,
    });
    if let Some(object) = quality_value.as_object_mut()
        && quality.get("visibleFeatures").is_some()
    {
        for key in ["visibleFeatures", "byClassFeatureCount", "visibleLayers"] {
            object.insert(key.into(), quality[key].clone());
        }
    }
    if let (Some(object), Some(operational_quality)) =
        (quality_value.as_object_mut(), operational_quality)
    {
        object.insert(
            "classCVisible".into(),
            Value::Bool(
                quality
                    .get("classCVisible")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
        );
        object.insert("operationalClosure".into(), operational_quality);
    }
    let modelled_scope = if operational_quality_report.is_some() {
        "operational-v2-closure-with-visible-static-context"
    } else {
        "quality-a-and-b"
    };
    let release = json!({
        "schema": "zugfolge-infra-release/v2",
        "releaseId": config.release.release_id,
        "timetableYear": config.release.timetable_year,
        "corpus": {
            "id": "deutschland-ebo",
            "loadedOnServer": "complete",
            "visibleScope": "complete-germany",
            "modelledScope": modelled_scope,
            "playableScope": "separate-world-mask",
        },
        "sources": public_sources,
        "artifacts": artifacts_json,
        "quality": quality_value,
        "validation": {
            "additionalInternalValidationApplied": internal_sources
                .iter()
                .any(|source| captured.contains_key(source.id.as_str())),
            "rawValidationMaterialShipped": false,
        },
        "annualBuild": {
            "pipelineVersion": config.pipeline.version,
            "configSha256": sha256(config_value),
            "publicCaptureSha256": sha256(&public_capture),
        },
    });
    let serialized = {
        let mut value = String::new();
        canonical(&release, &mut value);
        value.to_lowercase()
    };
    for source in internal_sources {
        require(
            !serialized.contains(&source.id.to_lowercase()),
            format!(
                "Interne Evidenzquelle {} ist in den auszuliefernden Release gelangt.",
                source.id
            ),
        )?;
        for token in &source.forbidden_shipping_tokens {
            require(
                !serialized.contains(&token.to_lowercase()),
                format!(
                    "Interne Evidenzkennung {token} ist in den auszuliefernden Release gelangt."
                ),
            )?;
        }
    }
    Ok(json!({ "releaseHash": sha256(&release), "release": release }))
}

/// Baut den historischen, einteiligen InfraRelease-Qualitaetsvertrag. Klasse C
/// bleibt in diesem Legacy-Pfad weiterhin nicht freigabefaehig.
pub fn build_public_infra_release(
    config_value: &Value,
    catalog_value: &Value,
    rights_value: &Value,
    capture_value: &Value,
    artifacts_value: &Value,
    quality_report: &Value,
) -> Result<Value> {
    build_public_infra_release_internal(
        config_value,
        catalog_value,
        rights_value,
        capture_value,
        artifacts_value,
        ReleaseQualityInput::Legacy(quality_report),
    )
}

/// Baut einen InfraRelease mit strikt getrennten Qualitaetsgrenzen: Die
/// Static-Map-v2 darf sichtbare Klasse-C-Kontextobjekte behalten, waehrend nur
/// der native, closure-basierte Operational-v2-Bericht die Betriebsfreigabe
/// qualifiziert. Beide Berichte werden gegen ihre tatsaechlichen Dateibytes
/// gebunden; keine Kartenklasse wird dabei umetikettiert.
pub fn build_public_infra_release_with_operational_quality(
    config_value: &Value,
    catalog_value: &Value,
    rights_value: &Value,
    capture_value: &Value,
    artifacts_value: &Value,
    static_map_quality_bytes: &[u8],
    operational_quality_bytes: &[u8],
) -> Result<Value> {
    require(
        !static_map_quality_bytes.is_empty(),
        "Static-Map-Quality-v2-Datei ist leer.",
    )?;
    let static_map_quality_report: Value = serde_json::from_slice(static_map_quality_bytes)
        .map_err(|error| {
            ReleaseManifestError::new(format!(
                "Static-Map-Quality-v2-Datei ist kein gueltiges JSON: {error}"
            ))
        })?;
    require(
        !operational_quality_bytes.is_empty(),
        "Operational-v2-Quality-Datei ist leer.",
    )?;
    let operational_quality_envelope: Value = serde_json::from_slice(operational_quality_bytes)
        .map_err(|error| {
            ReleaseManifestError::new(format!(
                "Operational-v2-Quality-Datei ist kein gueltiges JSON: {error}"
            ))
        })?;
    let operational_quality_report = operational_quality_envelope
        .get("report")
        .unwrap_or(&operational_quality_envelope);
    build_public_infra_release_internal(
        config_value,
        catalog_value,
        rights_value,
        capture_value,
        artifacts_value,
        ReleaseQualityInput::Operational {
            static_report: &static_map_quality_report,
            static_bytes: static_map_quality_bytes,
            operational_report: operational_quality_report,
            operational_bytes: operational_quality_bytes,
        },
    )
}

/// Baut nach Quellen- und Adapterprüfung den jährlichen Infrastrukturplan.
pub fn build_annual_infra_plan(
    config_value: &Value,
    catalog_value: &Value,
    rights_value: &Value,
) -> Result<Value> {
    let config: GermanyConfig = decode(config_value, "Deutschland-Konfiguration")?;
    let catalog: SourceCatalog = decode(catalog_value, "Quellenkatalog")?;
    let rights: RightsRegistry = decode(rights_value, "Rechte-Register")?;
    validate_rights(&catalog, &rights)?;
    validate_config(&config)?;
    let source_ids: BTreeSet<_> = catalog
        .sources
        .iter()
        .map(|source| source.id.as_str())
        .collect();
    let infrago = &config.pipeline.official_adapters.db_infra_go_geo_package;
    require(
        infrago.source_id == "db-infrago-infrastructure-open-data",
        "Offizieller DB-InfraGO-GeoPackage-Adapter fehlt in der Deutschland-Konfiguration.",
    )?;
    require(
        non_empty(&infrago.entrypoint),
        "DB-InfraGO-GeoPackage-Adapter ohne Einstiegspunkt.",
    )?;
    require(
        infrago.outputs.len() == 3,
        "DB-InfraGO-GeoPackage-Adapter ohne vollständigen Ausgabevertrag.",
    )?;
    require(
        source_ids.contains(infrago.source_id.as_str()),
        format!(
            "Adapterquelle {} fehlt im Quellenkatalog.",
            infrago.source_id
        ),
    )?;
    let openstation = &config.pipeline.official_adapters.open_station_netex;
    require(
        openstation.source_id == "openstation-enrichment",
        "OpenStation-NeTEx-Adapter fehlt in der Deutschland-Konfiguration.",
    )?;
    require(
        non_empty(&openstation.entrypoint),
        "OpenStation-NeTEx-Adapter ohne Einstiegspunkt.",
    )?;
    require(
        openstation.outputs.len() == 4,
        "OpenStation-NeTEx-Adapter ohne vollständigen Ausgabevertrag.",
    )?;
    require(
        source_ids.contains(openstation.source_id.as_str()),
        format!(
            "Adapterquelle {} fehlt im Quellenkatalog.",
            openstation.source_id
        ),
    )?;
    let dem = &config.pipeline.official_adapters.copernicus_dem_glo30;
    require(
        dem.source_id == "copernicus-dem-germany" && dem.rights_source_id == "dem-hoehenmodell",
        "Copernicus-GLO-30-Adapter fehlt in der Deutschland-Konfiguration.",
    )?;
    require(
        non_empty(&dem.entrypoint),
        "Copernicus-GLO-30-Adapter ohne Einstiegspunkt.",
    )?;
    let policy = &dem.sampling_policy;
    require(
        policy.interval_mm > 0,
        "Copernicus-GLO-30-Adapter ohne Stichprobenabstand.",
    )?;
    require(
        policy.minimum_baseline_mm >= 200_000,
        "Copernicus-GLO-30-Adapter unterschreitet die 200-m-Mindeststuetzweite.",
    )?;
    require(
        policy.analysis_window_mm >= policy.minimum_baseline_mm,
        "Copernicus-GLO-30-Analysefenster ist kuerzer als die Mindeststuetzweite.",
    )?;
    require(
        policy.maximum_absolute_gradient_permille > 0,
        "Copernicus-GLO-30-Adapter ohne Neigungsplausibilitaetsgrenze.",
    )?;
    require(
        policy.maximum_uncertainty_permille > 0,
        "Copernicus-GLO-30-Adapter ohne Unsicherheitsgrenze.",
    )?;
    require(
        !policy.class_a_eligible,
        "Copernicus DEM darf allein keine Klasse-A-Evidenz sein.",
    )?;
    require(
        dem.outputs.len() == 3,
        "Copernicus-GLO-30-Adapter ohne vollstaendigen Ausgabevertrag.",
    )?;
    require(
        catalog.sources.iter().any(|source| {
            source.id == dem.source_id && source.rights_source_id == dem.rights_source_id
        }),
        format!("Adapterquelle {} fehlt im Quellenkatalog.", dem.source_id),
    )?;
    let merge = &config.pipeline.post_processors.merge_track_gradient;
    require(
        non_empty(&merge.entrypoint),
        "DEM-Gleis-Join ohne Einstiegspunkt.",
    )?;
    require(
        merge.join_key == "properties.feature_id"
            && merge.geometry_must_match
            && merge.existing_properties_preserved,
        "DEM-Gleis-Join ist nicht streng an Kennung, Geometrie und Bestandseigenschaften gebunden.",
    )?;
    require(
        merge.output.ends_with("/tracks.geojsonseq"),
        "DEM-Gleis-Join ohne finalen Tracklayer.",
    )?;
    require(
        merge.report.ends_with(".report.json"),
        "DEM-Gleis-Join ohne Hashreport.",
    )?;

    let mut stages = vec![
        json!({ "id": "rights-gate", "mutatesRelease": false, "proof": "all-source-rights-approved" }),
        json!({ "id": "capture", "mutatesRelease": false, "proof": "version-size-sha256-for-every-input" }),
    ];
    stages.extend([
        json!({ "id": "official-infrago-normalization", "mutatesRelease": true, "sourceId": infrago.source_id, "entrypoint": infrago.entrypoint, "outputs": infrago.outputs, "proof": "strict-schema-report-and-deterministic-jsonseq-hashes" }),
        json!({ "id": "openstation-normalization", "mutatesRelease": true, "sourceId": openstation.source_id, "entrypoint": openstation.entrypoint, "outputs": openstation.outputs, "proof": "streamed-netex-report-and-deterministic-station-layer-hashes" }),
        json!({ "id": "ebo-filter", "mutatesRelease": true, "proof": "filter-report" }),
        json!({ "id": "copernicus-dem-gradient", "mutatesRelease": true, "sourceId": dem.source_id, "entrypoint": dem.entrypoint, "outputs": dem.outputs, "proof": "pinned-cog-hashes-complete-sampling-and-uncertainty-report" }),
        json!({ "id": "copernicus-dem-track-merge", "mutatesRelease": true, "entrypoint": merge.entrypoint, "output": merge.output, "report": merge.report, "proof": "strict-feature-id-geometry-count-and-sha256-report" }),
        json!({ "id": "topology-and-conservative-model", "mutatesRelease": true, "proof": "deterministic-corpus-hash" }),
        json!({ "id": "internal-validation", "mutatesRelease": true, "proof": "accepted-evidence-receipts" }),
        json!({ "id": "quality-report", "mutatesRelease": false, "proof": "dimension-cause-length-report" }),
    ]);
    if let Some(operational_deriver) = &config.pipeline.operational_deriver {
        stages.extend([
            json!({ "id": "operational-v2-derivation", "mutatesRelease": true, "entrypoint": operational_deriver.entrypoint, "proof": "a-b-only-exact-geometry-routes-and-interlocking-report" }),
            json!({ "id": "operational-v2-native-validation", "mutatesRelease": false, "entrypoint": "tools/region-import/materialize-operational-infrastructure-v2.mjs", "proof": "matching-javascript-and-rust-state-hashes" }),
        ]);
    }
    stages.push(
        json!({ "id": "tiles", "mutatesRelease": true, "proof": "self-hosted-pmtiles-hashes" }),
    );
    if config.pipeline.operational_deriver.is_some() {
        stages.extend([
            json!({ "id": "release-artifact-inventory", "mutatesRelease": true, "entrypoint": "tools/region-import/germany/run-release-artifacts.mjs", "proof": "typed-operational-v2-byte-and-state-binding" }),
            json!({ "id": "public-manifest", "mutatesRelease": true, "proof": "rust-compiler-operational-v2-binding-and-internal-evidence-scan" }),
            json!({ "id": "operational-v2-acceptance", "mutatesRelease": false, "proof": "native-worker-livemap-rzue-replay-restore-load-and-negative-gates" }),
        ]);
    }
    stages.extend([
        json!({ "id": "independent-validation", "mutatesRelease": false, "proof": "holdout-pass" }),
        json!({ "id": "signature", "mutatesRelease": false, "proof": "release-responsible-signature" }),
    ]);

    Ok(json!({
        "schema": "zugfolge-annual-infra-plan/v1",
        "releaseId": config.release.release_id,
        "stages": stages,
    }))
}
