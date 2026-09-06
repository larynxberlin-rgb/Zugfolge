//! Produktiver M3-Adapter zwischen versionierten Planungsfakten, dem echten
//! [`zugfolge_planner::PlanningRun`] und der Browserprojektion.
//!
//! Die TypeScript-Plattform ordnet Kommandos und persistiert Ergebnisse. Jede
//! fachliche Entscheidung bleibt hier: Infrastruktur und Trassenantraege werden
//! aus dem versionierten Eingabevertrag aufgebaut, der `PlanningRun` wird mit
//! dem angegebenen Weltseed ausgefuehrt, und nur dessen gepruefte Kandidaten
//! duerfen als Alternativen in den revisionierten Zustand gelangen.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zugfolge_conflict::{
    BlockingTime, ConflictResource, Infrastructure, OccupationLedger, OperatingDays,
    SECONDS_PER_DAY, ServiceWindow, TrainCategory, TrainNumber, TrainRun,
    derive_occupation_profile,
};
use zugfolge_determinism::{SimTime, WorldSeed};
use zugfolge_infra::{
    Acceleration, BandProfile, Confidence, Coordinate, Electrification, Gradient, Length, Mass,
    OperatingGraph, OperatingPoint, OperatingPointCode, OperatingPointId, OperatingPointKind,
    Platform, PlatformId, ProtectionSystem, Provenance, Signal, SourceId, Speed, SpeedCategory,
    SpeedLimit, Track, TrackDirection, TrackEdge, TrackEdgeId, TrackId, TrackKind, TrackOwner,
    TractionType, TrainCharacteristics, TrainCharacteristicsId, TrainProtection, TravelDirection,
    derive_block_sections,
};
use zugfolge_planner::{
    BoundaryDirection, BoundaryPlanningWindow, PathDecision, PathRequest, PathRequestId,
    PathTolerances, PlannerOptions, PlanningRun, RequestOutcome, RequestedStop, TrainPathPlanner,
    enumerate_itineraries,
};

const COORDINATE_SCHEMA_V1: &str = "planning-coordinate/v1";
const COORDINATE_SCHEMA: &str = "planning-coordinate/v2";
const APPLY_SCHEMA: &str = "planning-apply-alternative/v1";
const PROJECTION_SCHEMA: &str = "planning-projection/v1";
const STATE_SCHEMA: &str = "zugfolge-planning-runtime-state/v1";
const RESULT_SCHEMA: &str = "zugfolge-planning-runtime-result/v1";
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Stabiler Fehler an der nativen Grenze.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningRuntimeError {
    code: &'static str,
    detail: String,
}

impl PlanningRuntimeError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl core::fmt::Display for PlanningRuntimeError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for PlanningRuntimeError {}

fn invalid(detail: impl Into<String>) -> PlanningRuntimeError {
    PlanningRuntimeError::new("invalid_input", detail)
}

fn map_domain(error: impl core::fmt::Display) -> PlanningRuntimeError {
    PlanningRuntimeError::new("planning_failed", error.to_string())
}

fn non_empty(value: &str, field: &str) -> Result<(), PlanningRuntimeError> {
    if value.trim().is_empty() {
        return Err(invalid(format!("{field} darf nicht leer sein")));
    }
    Ok(())
}

fn safe_non_negative(value: i64, field: &str) -> Result<(), PlanningRuntimeError> {
    if !(0..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(invalid(format!(
            "{field} muss eine nichtnegative JavaScript-sichere Ganzzahl sein"
        )));
    }
    Ok(())
}

fn sha256_json<T: Serialize>(value: &T) -> Result<String, PlanningRuntimeError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| PlanningRuntimeError::new("serialization_failed", error.to_string()))?;
    let mut result = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        write!(&mut result, "{byte:02x}").map_err(|error| {
            PlanningRuntimeError::new("serialization_failed", error.to_string())
        })?;
    }
    Ok(result)
}

/// Eine Betriebsstelle des linearen Projektionskorridors.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinateStationInput {
    /// Numerische Kernkennung.
    pub numeric_id: u32,
    /// Stabile Plattformkennung.
    pub id: String,
    /// Ril-100-artiges Kuerzel.
    pub code: String,
    /// Anzeigename.
    pub name: String,
    /// Entfernung vom Korridoranfang.
    pub distance_mm: i64,
    /// Ganzzahlige WGS-84-Breite in 1e-7 Grad.
    pub latitude_e7: i32,
    /// Ganzzahlige WGS-84-Laenge in 1e-7 Grad.
    pub longitude_e7: i32,
    /// Numerische Kennung des Bahnhofsgleises.
    pub station_track_numeric_id: u32,
    /// Nutzlaenge des Bahnhofsgleises.
    pub station_track_length_mm: i64,
    /// Vmax des Bahnhofsgleises.
    pub station_maximum_speed_kph: i64,
}

/// Ein Streckensegment samt den fuer M3 notwendigen Konfliktfakten.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinateSegmentInput {
    /// Numerische Kantenkennung.
    pub edge_numeric_id: u32,
    /// Numerische Gleiskennung.
    pub track_numeric_id: u32,
    /// Stabile Projektionskennung.
    pub id: String,
    /// Anzeigename der Konfliktressource.
    pub label: String,
    /// Anfangsbetriebsstelle der Kilometrierung.
    pub from_station_id: String,
    /// Endbetriebsstelle der Kilometrierung.
    pub to_station_id: String,
    /// Laenge in Millimetern.
    pub length_mm: i64,
    /// Strecken-Vmax.
    pub maximum_speed_kph: i64,
    /// Hauptsignalpositionen entlang der Kilometrierung.
    pub main_signal_positions_mm: Vec<i64>,
    /// Konservative Obergrenze fuer virtuelle Bloecke.
    pub maximum_virtual_block_length_mm: i64,
}

/// Ein Fahrgast- oder Betriebshalt im Antrag.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinateStopInput {
    /// Externe Betriebsstellenkennung.
    pub station_id: String,
    /// Mindesthaltezeit in Sekunden.
    pub minimum_dwell_s: i64,
}

/// Zugcharakteristik als versionierter Antragsfakt.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinateTrainCharacteristicsInput {
    /// Numerische Kernkennung.
    pub numeric_id: u32,
    /// Bezeichnung.
    pub name: String,
    /// Masse in Kilogramm.
    pub mass_kg: i64,
    /// Laenge in Millimetern.
    pub length_mm: i64,
    /// Legacy-v1-Fahrzeug-Vmax; nur `planning-coordinate/v1` darf sie setzen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_speed_kph: Option<i64>,
    /// Verlustfreie Fahrzeug-Vmax; `planning-coordinate/v2` muss sie setzen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_speed_mmps: Option<i64>,
    /// Anfahrvermoegen in Millimetern je Quadratsekunde.
    pub acceleration_mm_per_s2: i64,
    /// Bremsvermoegen in Millimetern je Quadratsekunde.
    pub deceleration_mm_per_s2: i64,
}

/// Ein Trassenantrag im Koordinierungslauf.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinateRequestInput {
    /// Numerische PlanningRun-Kennung.
    pub request_numeric_id: u32,
    /// Stabile Zuglaufkennung fuer API und Projektion.
    pub train_id: String,
    /// Zuggattung: long-distance, suburban, regional, freight oder supplementary.
    pub train_category: String,
    /// Nummer innerhalb der Zuggattung.
    pub train_number: u32,
    /// Anfangsbetriebsstelle.
    pub origin_station_id: String,
    /// Zielbetriebsstelle.
    pub destination_station_id: String,
    /// Beantragte Abfahrt seit Weltepoche.
    pub desired_departure_s: i64,
    /// Optionales absolutes Abfahrtsfenster; ohne Feld gilt der historische Tagesvertrag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_window: Option<CoordinateServiceWindowInput>,
    /// Verkehrstage: daily, workdays oder weekend.
    pub operating_days: String,
    /// Beantragte Zwischenhalte.
    pub stops: Vec<CoordinateStopInput>,
    /// Fruehere Lage im Toleranzband.
    pub earlier_s: i64,
    /// Spaetere Lage im Toleranzband.
    pub later_s: i64,
    /// Suchraster in Sekunden.
    pub step_s: i64,
    /// Zulaessige Fahrzeitverlaengerung.
    pub extra_running_time_s: i64,
    /// Zulaessige Betriebshalte.
    pub max_operational_stops: u32,
    /// Fahrdynamische Fakten.
    pub train: CoordinateTrainCharacteristicsInput,
    /// Vom Game-Server aus dem gepinnten Release aufgeloeste Grenzfenster.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundary_windows: Vec<CoordinateBoundaryWindowInput>,
}

/// Absolute Abfahrtsgültigkeit in Weltsekunden, halboffen.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinateServiceWindowInput {
    /// Erste zulässige Abfahrt einschließlich.
    pub valid_from_s: i64,
    /// Betriebsende ausschließlich.
    pub valid_until_s: i64,
}

impl CoordinateServiceWindowInput {
    fn window(&self) -> Result<ServiceWindow, PlanningRuntimeError> {
        safe_non_negative(self.valid_from_s, "serviceWindow.validFromS")?;
        safe_non_negative(self.valid_until_s, "serviceWindow.validUntilS")?;
        ServiceWindow::new(
            SimTime::from_seconds(self.valid_from_s),
            SimTime::from_seconds(self.valid_until_s),
        )
        .map_err(map_domain)
    }
}

/// Ein unveraenderliches Ein- oder Ausfahrfenster eines BoundaryPortal.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinateBoundaryWindowInput {
    /// Stabile Fensterkennung aus der JourneyChain.
    pub window_id: String,
    /// Benanntes Grenzportal.
    pub portal_id: String,
    /// `entry` oder `exit`.
    pub direction: String,
    /// Frueheste zulaessige Weltsekunde.
    pub earliest_s: i64,
    /// Zielzeit des gepinnten GTFS.
    pub target_s: i64,
    /// Spaeteste zulaessige Weltsekunde.
    pub latest_s: i64,
}

/// Versionierter produktiver Eingang fuer einen echten `PlanningRun`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningCoordinateInput {
    /// Vertrag `planning-coordinate/v1` (Legacy-KPH) oder v2 (exakte mm/s).
    pub schema_version: String,
    /// Weltbindung.
    pub world_id: String,
    /// Stabile Laufkennung und serverseitige Idempotenzbasis.
    pub run_id: String,
    /// Erwartete vorherige Fachrevision; `null` initialisiert die Projektion.
    pub expected_projection_revision: Option<u64>,
    /// Numerischer Weltanteil des Seeds als Dezimalstring.
    pub seed_world: String,
    /// Fahrplanperiode des Seeds.
    pub seed_period: u32,
    /// Freigegebene Quellenkennung der Infrastrukturangaben.
    pub source_id: String,
    /// Korridorkennung.
    pub corridor_id: String,
    /// Korridorname.
    pub corridor_name: String,
    /// Betriebsstellen.
    pub stations: Vec<CoordinateStationInput>,
    /// Streckensegmente.
    pub segments: Vec<CoordinateSegmentInput>,
    /// Gemeinsamer Antragsbestand des Fensters.
    pub requests: Vec<CoordinateRequestInput>,
    /// Ausschließlich vom Worker geladener vorheriger Commit; kein Spielereingang.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_state: Option<PlanningRuntimeState>,
    /// Serverseitig autorisierte, noch nicht begonnene Fahrten einer Linienänderung.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replace_train_ids: Vec<String>,
    /// Explizite autoritative Weltzeit der Linienänderung.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_from_s: Option<i64>,
}

/// Das von `game-api` eingereihte, ausschliesslich serverabgeleitete Kommando.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningApplyAlternativeCommand {
    /// Vertrag `planning-apply-alternative/v1`.
    pub schema_version: String,
    /// Revision, in der das Angebot sichtbar war.
    pub projection_revision: u64,
    /// Serverautoritaere Angebotskennung.
    pub alternative_id: String,
    /// Serverautoritaere Konfliktkennung.
    pub conflict_id: String,
    /// Serverautoritaerer Zuglauf.
    pub train_id: String,
    /// Vom Rust-Kandidaten abgeleitete Verschiebung.
    pub departure_shift_s: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CorridorProjection {
    id: String,
    name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StationProjection {
    id: String,
    name: String,
    distance_mm: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrainCallProjection {
    station_id: String,
    time_s: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrainProjection {
    id: String,
    number: String,
    direction: String,
    calls: Vec<TrainCallProjection>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    boundary_windows: Vec<BoundaryWindowProjection>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundaryWindowProjection {
    window_id: String,
    portal_id: String,
    direction: String,
    earliest_s: i64,
    target_s: i64,
    latest_s: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceProjection {
    id: String,
    kind: String,
    label: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OccupationProjection {
    train_id: String,
    resource: ResourceProjection,
    governing_station_id: String,
    phase: String,
    start_s: i64,
    end_s: i64,
    start_distance_mm: i64,
    end_distance_mm: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictWindowProjection {
    start_s: i64,
    end_s: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlternativeProjection {
    alternative_id: String,
    train_id: String,
    departure_shift_s: i64,
    explanation: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictProjection {
    id: String,
    kind: String,
    resource: ResourceProjection,
    window: ConflictWindowProjection,
    train_ids: Vec<String>,
    explanation: String,
    alternative: Option<AlternativeProjection>,
}

/// Exakt serialisierbare `planning-projection/v1`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningProjection {
    schema_version: String,
    projection_revision: u64,
    world_id: String,
    corridor: CorridorProjection,
    stations: Vec<StationProjection>,
    trains: Vec<TrainProjection>,
    occupations: Vec<OccupationProjection>,
    conflicts: Vec<ConflictProjection>,
}

impl PlanningProjection {
    /// Fachliche Revision.
    pub const fn projection_revision(&self) -> u64 {
        self.projection_revision
    }

    /// Weltkennung.
    pub fn world_id(&self) -> &str {
        &self.world_id
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredAlternative {
    conflict_id: String,
    train_id: String,
    departure_shift_s: i64,
    replacement_train: TrainProjection,
    replacement_occupations: Vec<OccupationProjection>,
    resolved_conflict_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reservation: Option<StoredReservation>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredReservation {
    number: u32,
    train: TrainProjection,
    occupations: Vec<OccupationProjection>,
    operating_days: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    service_window: Option<CoordinateServiceWindowInput>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    passenger_stops: Vec<PassengerStopProjection>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PassengerStopProjection {
    station_id: String,
    arrival_s: i64,
    departure_s: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessedCommand {
    command_hash: String,
    resulting_projection_revision: u64,
}

/// Persistierbarer Zustand des M3-Single-Writers.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningRuntimeState {
    schema_version: String,
    world_id: String,
    projection_revision: u64,
    projection: PlanningProjection,
    alternatives: BTreeMap<String, StoredAlternative>,
    processed_commands: BTreeMap<String, ProcessedCommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    infrastructure_hash: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    reservations: BTreeMap<String, StoredReservation>,
}

impl PlanningRuntimeState {
    /// Weltkennung.
    pub fn world_id(&self) -> &str {
        &self.world_id
    }

    /// Fachliche Revision.
    pub const fn projection_revision(&self) -> u64 {
        self.projection_revision
    }
}

/// Ergebnis von Koordinierung oder Alternativanwendung.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningRuntimeResult {
    schema_version: String,
    state: PlanningRuntimeState,
    state_hash: String,
    projection: PlanningProjection,
    idempotent_replay: bool,
}

impl PlanningRuntimeResult {
    /// Persistierbarer Rust-Zustand.
    pub const fn state(&self) -> &PlanningRuntimeState {
        &self.state
    }

    /// Browserprojektion.
    pub const fn projection(&self) -> &PlanningProjection {
        &self.projection
    }

    /// Deterministischer Zustandshash.
    pub fn state_hash(&self) -> &str {
        &self.state_hash
    }

    /// Ob derselbe Befehl bereits im Rust-Zustand enthalten war.
    pub const fn idempotent_replay(&self) -> bool {
        self.idempotent_replay
    }
}

#[derive(Clone)]
struct MaterializedRequest {
    input: CoordinateRequestInput,
    request: PathRequest,
}

#[derive(Clone)]
struct ResourceLocation {
    projection: ResourceProjection,
    start_distance_mm: i64,
    end_distance_mm: i64,
}

struct MaterializedRun {
    infrastructure: Infrastructure,
    requests: Vec<MaterializedRequest>,
    station_by_external: BTreeMap<String, CoordinateStationInput>,
    station_external_by_numeric: BTreeMap<OperatingPointId, String>,
    resource_locations: BTreeMap<ConflictResource, ResourceLocation>,
}

fn category(value: &str) -> Result<TrainCategory, PlanningRuntimeError> {
    match value {
        "long-distance" => Ok(TrainCategory::LongDistance),
        "suburban" => Ok(TrainCategory::Suburban),
        "regional" => Ok(TrainCategory::Regional),
        "freight" => Ok(TrainCategory::Freight),
        "supplementary" => Ok(TrainCategory::Supplementary),
        _ => Err(invalid(format!("unbekannte Zuggattung '{value}'"))),
    }
}

fn days(value: &str) -> Result<OperatingDays, PlanningRuntimeError> {
    match value {
        "daily" => Ok(OperatingDays::DAILY),
        "workdays" => Ok(OperatingDays::WORKDAYS),
        "weekend" => Ok(OperatingDays::WEEKEND),
        _ => Err(invalid(format!("unbekannte Verkehrstage '{value}'"))),
    }
}

fn uniform_track(
    id: TrackId,
    owner: TrackOwner,
    designation: &str,
    length: Length,
    maximum_speed_kph: i64,
    kind: TrackKind,
    provenance: &Provenance,
) -> Result<Track, PlanningRuntimeError> {
    let speed = BandProfile::uniform(
        "Vmax",
        length,
        SpeedLimit::uniform(Speed::from_km_h(maximum_speed_kph)).map_err(map_domain)?,
        provenance.clone(),
    )
    .map_err(map_domain)?;
    let gradient = BandProfile::uniform("Neigung", length, Gradient::LEVEL, provenance.clone())
        .map_err(map_domain)?;
    let electrification = BandProfile::uniform(
        "Elektrifizierung",
        length,
        Electrification::Unelectrified,
        provenance.clone(),
    )
    .map_err(map_domain)?;
    let protection = BandProfile::uniform(
        "Zugsicherung",
        length,
        TrainProtection::single(ProtectionSystem::Pzb),
        provenance.clone(),
    )
    .map_err(map_domain)?;
    Track::builder(id, owner, designation, length)
        .kind(kind)
        .direction(TrackDirection::Bidirectional)
        .speed(speed)
        .gradient(gradient)
        .electrification(electrification)
        .protection(protection)
        .build()
        .map_err(map_domain)
}

fn coordinate_train_speed(
    schema_version: &str,
    train: &CoordinateTrainCharacteristicsInput,
) -> Result<Speed, PlanningRuntimeError> {
    let (value, field, speed) = match (
        schema_version,
        train.maximum_speed_kph,
        train.maximum_speed_mmps,
    ) {
        (COORDINATE_SCHEMA_V1, Some(value), None) => (
            value,
            "requests[].train.maximumSpeedKph",
            Speed::from_km_h(value),
        ),
        (COORDINATE_SCHEMA, None, Some(value)) => (
            value,
            "requests[].train.maximumSpeedMmps",
            Speed::from_millimetres_per_second(value),
        ),
        (COORDINATE_SCHEMA_V1, _, _) => {
            return Err(invalid(
                "planning-coordinate/v1 verlangt exakt maximumSpeedKph",
            ));
        }
        (COORDINATE_SCHEMA, _, _) => {
            return Err(invalid(
                "planning-coordinate/v2 verlangt exakt maximumSpeedMmps",
            ));
        }
        (unknown, _, _) => {
            return Err(PlanningRuntimeError::new(
                "unsupported_schema",
                unknown.to_owned(),
            ));
        }
    };
    safe_non_negative(value, field)?;
    if value == 0 {
        return Err(invalid(format!("{field} muss positiv sein")));
    }
    Ok(speed)
}

fn materialize(input: &PlanningCoordinateInput) -> Result<MaterializedRun, PlanningRuntimeError> {
    if input.schema_version != COORDINATE_SCHEMA && input.schema_version != COORDINATE_SCHEMA_V1 {
        return Err(PlanningRuntimeError::new(
            "unsupported_schema",
            input.schema_version.clone(),
        ));
    }
    for (value, field) in [
        (&input.world_id, "worldId"),
        (&input.run_id, "runId"),
        (&input.source_id, "sourceId"),
        (&input.corridor_id, "corridorId"),
        (&input.corridor_name, "corridorName"),
    ] {
        non_empty(value, field)?;
    }
    if input.stations.len() < 2 {
        return Err(invalid("mindestens zwei Betriebsstellen sind erforderlich"));
    }
    let minimum = if input.schema_version == COORDINATE_SCHEMA_V1 {
        2
    } else {
        1
    };
    if input.segments.is_empty() || input.requests.len() < minimum || input.requests.len() > 256 {
        return Err(invalid(
            "ein PlanningRun braucht ein Segment und 1 bis 256 Anträge (Legacy-v1 mindestens zwei)",
        ));
    }

    let source = SourceId::new(&input.source_id).map_err(map_domain)?;
    let provenance = Provenance::new(source.clone(), Confidence::Surveyed);
    let mut graph = OperatingGraph::builder();
    let mut station_by_external = BTreeMap::new();
    let mut station_external_by_numeric = BTreeMap::new();
    let mut station_ids = BTreeSet::new();
    let mut station_track_ids = BTreeSet::new();

    let mut sorted_stations = input.stations.clone();
    sorted_stations.sort_by_key(|station| (station.distance_mm, station.id.clone()));
    for (index, station) in sorted_stations.iter().enumerate() {
        non_empty(&station.id, "stations[].id")?;
        non_empty(&station.name, "stations[].name")?;
        safe_non_negative(station.distance_mm, "stations[].distanceMm")?;
        safe_non_negative(
            station.station_track_length_mm,
            "stations[].stationTrackLengthMm",
        )?;
        if station.station_track_length_mm == 0 || station.station_maximum_speed_kph <= 0 {
            return Err(invalid("Bahnhofsgleis braucht positive Laenge und Vmax"));
        }
        if !station_ids.insert(station.numeric_id)
            || station_by_external
                .insert(station.id.clone(), station.clone())
                .is_some()
            || !station_track_ids.insert(station.station_track_numeric_id)
        {
            return Err(invalid("Betriebsstellen- oder Gleiskennung ist doppelt"));
        }
        if index > 0 && sorted_stations[index - 1].distance_mm >= station.distance_mm {
            return Err(invalid(
                "Betriebsstellenentfernungen muessen streng ansteigen",
            ));
        }
        let numeric = OperatingPointId::new(station.numeric_id);
        station_external_by_numeric.insert(numeric, station.id.clone());
        let point = OperatingPoint::new(
            numeric,
            OperatingPointCode::new(&station.code).map_err(map_domain)?,
            &station.name,
            OperatingPointKind::Station,
            Coordinate::new(station.latitude_e7, station.longitude_e7).map_err(map_domain)?,
            provenance.clone(),
        )
        .map_err(map_domain)?;
        let track_id = TrackId::new(station.station_track_numeric_id);
        let track_length = Length::from_millimetres(station.station_track_length_mm);
        let track = uniform_track(
            track_id,
            TrackOwner::OperatingPoint(numeric),
            &format!("{} Hauptgleis", station.code),
            track_length,
            station.station_maximum_speed_kph,
            TrackKind::ThroughMainTrack,
            &provenance,
        )?;
        let platform_numeric = u32::try_from(index)
            .map_err(|_| invalid("zu viele Betriebsstellen"))?
            .saturating_add(1);
        let platform = Platform::new(
            PlatformId::new(platform_numeric),
            track_id,
            format!("{} Bahnsteig", station.code),
            Length::ZERO,
            track_length,
            Length::from_millimetres(550),
            provenance.clone(),
        )
        .map_err(map_domain)?;
        graph = graph.operating_point(point).track(track).platform(platform);
    }

    let mut segment_track_ids = BTreeSet::new();
    let mut edge_ids = BTreeSet::new();
    let mut line_tracks = BTreeMap::new();
    let mut resource_locations = BTreeMap::new();
    let mut sorted_segments = input.segments.clone();
    sorted_segments.sort_by_key(|segment| segment.edge_numeric_id);
    for segment in &sorted_segments {
        non_empty(&segment.id, "segments[].id")?;
        non_empty(&segment.label, "segments[].label")?;
        safe_non_negative(segment.length_mm, "segments[].lengthMm")?;
        safe_non_negative(
            segment.maximum_virtual_block_length_mm,
            "segments[].maximumVirtualBlockLengthMm",
        )?;
        if segment.length_mm == 0
            || segment.maximum_virtual_block_length_mm == 0
            || segment.maximum_speed_kph <= 0
        {
            return Err(invalid(
                "Segment braucht positive Laenge, Blocklaenge und Vmax",
            ));
        }
        let from = station_by_external
            .get(&segment.from_station_id)
            .ok_or_else(|| {
                invalid(format!(
                    "unbekannte Betriebsstelle '{}'",
                    segment.from_station_id
                ))
            })?;
        let to = station_by_external
            .get(&segment.to_station_id)
            .ok_or_else(|| {
                invalid(format!(
                    "unbekannte Betriebsstelle '{}'",
                    segment.to_station_id
                ))
            })?;
        if from.id == to.id
            || !edge_ids.insert(segment.edge_numeric_id)
            || !segment_track_ids.insert(segment.track_numeric_id)
            || station_track_ids.contains(&segment.track_numeric_id)
        {
            return Err(invalid(
                "Segmentkennung ist doppelt oder bildet eine Selbstkante",
            ));
        }
        if (to.distance_mm - from.distance_mm).saturating_abs() != segment.length_mm {
            return Err(invalid(format!(
                "Segment '{}' stimmt nicht mit den Korridorentfernungen ueberein",
                segment.id
            )));
        }
        let edge_id = TrackEdgeId::new(segment.edge_numeric_id);
        let edge = TrackEdge::new(
            edge_id,
            OperatingPointId::new(from.numeric_id),
            OperatingPointId::new(to.numeric_id),
            &segment.label,
            Length::from_millimetres(segment.length_mm),
            provenance.clone(),
        )
        .map_err(map_domain)?;
        let track_id = TrackId::new(segment.track_numeric_id);
        let track = uniform_track(
            track_id,
            TrackOwner::Edge(edge_id),
            &segment.label,
            Length::from_millimetres(segment.length_mm),
            segment.maximum_speed_kph,
            TrackKind::ThroughMainTrack,
            &provenance,
        )?;
        graph = graph.edge(edge).track(track.clone());
        line_tracks.insert(track_id, track);
    }
    let operating_graph = graph.build().map_err(map_domain)?;
    let mut infrastructure_builder = Infrastructure::builder(operating_graph);
    for segment in &sorted_segments {
        let track_id = TrackId::new(segment.track_numeric_id);
        let track = line_tracks
            .get(&track_id)
            .ok_or_else(|| invalid("intern fehlendes Streckengleis"))?;
        let mut signal_positions = segment.main_signal_positions_mm.clone();
        signal_positions.sort_unstable();
        if signal_positions.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(invalid("Hauptsignalposition ist doppelt"));
        }
        let signals = signal_positions
            .into_iter()
            .map(|position| {
                safe_non_negative(position, "segments[].mainSignalPositionsMm")?;
                Ok(Signal::main(Length::from_millimetres(position)))
            })
            .collect::<Result<Vec<_>, PlanningRuntimeError>>()?;
        let blocks = derive_block_sections(
            track,
            &signals,
            Length::from_millimetres(segment.maximum_virtual_block_length_mm),
            source.clone(),
        )
        .map_err(map_domain)?;
        let from = station_by_external
            .get(&segment.from_station_id)
            .ok_or_else(|| invalid("intern fehlender Segmentanfang"))?;
        let to = station_by_external
            .get(&segment.to_station_id)
            .ok_or_else(|| invalid("intern fehlendes Segmentende"))?;
        for (ordinal, block) in blocks.iter().enumerate() {
            let ordinal =
                u32::try_from(ordinal).map_err(|_| invalid("zu viele Blockabschnitte"))?;
            let location = if to.distance_mm >= from.distance_mm {
                (
                    from.distance_mm.saturating_add(block.start().millimetres()),
                    from.distance_mm.saturating_add(block.end().millimetres()),
                )
            } else {
                (
                    from.distance_mm.saturating_sub(block.start().millimetres()),
                    from.distance_mm.saturating_sub(block.end().millimetres()),
                )
            };
            resource_locations.insert(
                ConflictResource::Block {
                    track: track_id,
                    ordinal,
                },
                ResourceLocation {
                    projection: ResourceProjection {
                        id: format!("{}:block:{ordinal}", segment.id),
                        kind: "block".to_owned(),
                        label: format!("{} Block {}", segment.label, ordinal.saturating_add(1)),
                    },
                    start_distance_mm: location.0,
                    end_distance_mm: location.1,
                },
            );
        }
        infrastructure_builder = infrastructure_builder.blocks(track_id, blocks);
    }
    for station in &sorted_stations {
        resource_locations.insert(
            ConflictResource::Track(TrackId::new(station.station_track_numeric_id)),
            ResourceLocation {
                projection: ResourceProjection {
                    id: format!("{}:track", station.id),
                    kind: "track".to_owned(),
                    label: format!("{} Hauptgleis", station.name),
                },
                start_distance_mm: station.distance_mm,
                end_distance_mm: station.distance_mm,
            },
        );
    }
    let infrastructure = infrastructure_builder.build().map_err(map_domain)?;

    let mut request_ids = BTreeSet::new();
    let mut train_ids = BTreeSet::new();
    let mut train_numbers = BTreeSet::new();
    let mut train_characteristic_ids = BTreeMap::new();
    let mut requests = Vec::with_capacity(input.requests.len());
    let mut sorted_requests = input.requests.clone();
    sorted_requests.sort_by_key(|request| request.request_numeric_id);
    for request in sorted_requests {
        non_empty(&request.train_id, "requests[].trainId")?;
        safe_non_negative(request.desired_departure_s, "requests[].desiredDepartureS")?;
        if !request_ids.insert(request.request_numeric_id)
            || !train_ids.insert(request.train_id.clone())
        {
            return Err(invalid(
                "Antrags-, Zuglauf- oder Zugcharakteristikkennung ist doppelt",
            ));
        }
        let characteristics_hash = sha256_json(&request.train)?;
        if train_characteristic_ids
            .insert(request.train.numeric_id, characteristics_hash.clone())
            .is_some_and(|previous| previous != characteristics_hash)
        {
            return Err(invalid(
                "Zugcharakteristikkennung ist mit widersprüchlichen Fakten belegt",
            ));
        }
        let category = category(&request.train_category)?;
        let number = TrainNumber::new(category, request.train_number).map_err(map_domain)?;
        if !train_numbers.insert(number) {
            return Err(invalid("Zugnummer ist im PlanningRun doppelt"));
        }
        let origin = station_by_external
            .get(&request.origin_station_id)
            .ok_or_else(|| {
                invalid(format!(
                    "unbekannter Ursprung '{}'",
                    request.origin_station_id
                ))
            })?;
        let destination = station_by_external
            .get(&request.destination_station_id)
            .ok_or_else(|| {
                invalid(format!(
                    "unbekanntes Ziel '{}'",
                    request.destination_station_id
                ))
            })?;
        let train = TrainCharacteristics::new(
            TrainCharacteristicsId::new(request.train.numeric_id),
            &request.train.name,
            Mass::from_kilograms(request.train.mass_kg),
            Length::from_millimetres(request.train.length_mm),
            coordinate_train_speed(&input.schema_version, &request.train)?,
            if category == TrainCategory::Freight {
                SpeedCategory::Freight
            } else {
                SpeedCategory::Standard
            },
            Acceleration::from_millimetres_per_second_squared(request.train.acceleration_mm_per_s2),
            Acceleration::from_millimetres_per_second_squared(request.train.deceleration_mm_per_s2),
            TractionType::Diesel,
            TrainProtection::single(ProtectionSystem::Pzb),
        )
        .map_err(map_domain)?;
        let stops = request
            .stops
            .iter()
            .map(|stop| {
                let station = station_by_external
                    .get(&stop.station_id)
                    .ok_or_else(|| invalid(format!("unbekannter Halt '{}'", stop.station_id)))?;
                RequestedStop::new(
                    OperatingPointId::new(station.numeric_id),
                    stop.minimum_dwell_s,
                )
                .map_err(map_domain)
            })
            .collect::<Result<Vec<_>, PlanningRuntimeError>>()?;
        let boundary_windows = request
            .boundary_windows
            .iter()
            .map(|window| {
                for (name, value) in [
                    ("boundaryWindows[].earliestS", window.earliest_s),
                    ("boundaryWindows[].targetS", window.target_s),
                    ("boundaryWindows[].latestS", window.latest_s),
                ] {
                    safe_non_negative(value, name)?;
                }
                non_empty(&window.window_id, "boundaryWindows[].windowId")?;
                non_empty(&window.portal_id, "boundaryWindows[].portalId")?;
                let direction = match window.direction.as_str() {
                    "entry" => BoundaryDirection::Entry,
                    "exit" => BoundaryDirection::Exit,
                    _ => return Err(invalid("boundaryWindows[].direction ist unbekannt")),
                };
                BoundaryPlanningWindow::new(
                    window.window_id.clone(),
                    window.portal_id.clone(),
                    direction,
                    SimTime::from_seconds(window.earliest_s),
                    SimTime::from_seconds(window.target_s),
                    SimTime::from_seconds(window.latest_s),
                )
                .map_err(map_domain)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut path_request = PathRequest::new(
            PathRequestId::new(request.request_numeric_id),
            number,
            train,
            OperatingPointId::new(origin.numeric_id),
            OperatingPointId::new(destination.numeric_id),
            stops,
            SimTime::from_seconds(request.desired_departure_s),
            days(&request.operating_days)?,
            PathTolerances::new(
                request.earlier_s,
                request.later_s,
                request.step_s,
                request.extra_running_time_s,
                request.max_operational_stops,
            )
            .map_err(map_domain)?,
        )
        .map_err(map_domain)?
        .with_boundary_windows(boundary_windows)
        .map_err(map_domain)?;
        if let Some(window) = &request.service_window {
            if input.schema_version != COORDINATE_SCHEMA {
                return Err(invalid("serviceWindow verlangt planning-coordinate/v2"));
            }
            path_request = path_request
                .with_service_window(window.window()?)
                .map_err(map_domain)?;
        }
        requests.push(MaterializedRequest {
            input: request,
            request: path_request,
        });
    }

    Ok(MaterializedRun {
        infrastructure,
        requests,
        station_by_external,
        station_external_by_numeric,
        resource_locations,
    })
}

fn desired_run(
    infrastructure: &Infrastructure,
    request: &PathRequest,
    options: PlannerOptions,
) -> Result<TrainRun, PlanningRuntimeError> {
    let itineraries = enumerate_itineraries(
        infrastructure.graph(),
        request,
        options.max_route_candidates(),
    )
    .map_err(map_domain)?;
    let mut candidates = itineraries
        .into_iter()
        .filter_map(|itinerary| {
            derive_occupation_profile(infrastructure, &itinerary, request.train())
                .ok()
                .map(|profile| (itinerary, profile))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(itinerary, profile)| (profile.running_time_s(), itinerary.length()));
    let (_, profile) = candidates
        .first()
        .ok_or_else(|| PlanningRuntimeError::new("planning_failed", "kein befahrbarer Laufweg"))?;
    Ok(TrainRun::new(
        request.number(),
        request.desired_departure(),
        profile,
    ))
}

fn fallback_resource(resource: ConflictResource, governing_distance_mm: i64) -> ResourceLocation {
    ResourceLocation {
        projection: ResourceProjection {
            id: resource.to_string(),
            kind: resource.tag().to_owned(),
            label: format!("{} {resource}", resource.label()),
        },
        start_distance_mm: governing_distance_mm,
        end_distance_mm: governing_distance_mm,
    }
}

fn project_occupations(
    train_id: &str,
    run: &TrainRun,
    materialized: &MaterializedRun,
) -> Result<Vec<OccupationProjection>, PlanningRuntimeError> {
    let mut result = Vec::new();
    for step in run.staircase().steps() {
        let governing_station_id = materialized
            .station_external_by_numeric
            .get(&step.governing_point())
            .ok_or_else(|| invalid("Sperrzeit verweist auf unbekannte Betriebsstelle"))?;
        let governing_distance = materialized
            .station_by_external
            .get(governing_station_id)
            .map_or(0, |station| station.distance_mm);
        let location = materialized
            .resource_locations
            .get(&step.resource())
            .cloned()
            .unwrap_or_else(|| fallback_resource(step.resource(), governing_distance));
        for (phase, start, end) in step.phases() {
            safe_non_negative(start.seconds(), "occupation.startS")?;
            safe_non_negative(end.seconds(), "occupation.endS")?;
            result.push(OccupationProjection {
                train_id: train_id.to_owned(),
                resource: location.projection.clone(),
                governing_station_id: governing_station_id.clone(),
                phase: phase.tag().to_owned(),
                start_s: start.seconds(),
                end_s: end.seconds(),
                start_distance_mm: location.start_distance_mm,
                end_distance_mm: location.end_distance_mm,
            });
        }
    }
    Ok(result)
}

fn project_train(
    input: &CoordinateRequestInput,
    request: &PathRequest,
    run: &TrainRun,
    materialized: &MaterializedRun,
) -> Result<TrainProjection, PlanningRuntimeError> {
    let origin = materialized
        .station_by_external
        .get(&input.origin_station_id)
        .ok_or_else(|| invalid("intern unbekannter Ursprung"))?;
    let destination = materialized
        .station_by_external
        .get(&input.destination_station_id)
        .ok_or_else(|| invalid("intern unbekanntes Ziel"))?;
    let arrival = run.staircase().arrival().seconds();
    safe_non_negative(arrival, "trains[].calls[].timeS")?;
    Ok(TrainProjection {
        id: input.train_id.clone(),
        number: request.number().to_string(),
        direction: if destination.distance_mm >= origin.distance_mm {
            "with-chainage".to_owned()
        } else {
            "against-chainage".to_owned()
        },
        calls: vec![
            TrainCallProjection {
                station_id: origin.id.clone(),
                time_s: run.departure().seconds(),
            },
            TrainCallProjection {
                station_id: destination.id.clone(),
                time_s: arrival,
            },
        ],
        boundary_windows: input
            .boundary_windows
            .iter()
            .map(|window| BoundaryWindowProjection {
                window_id: window.window_id.clone(),
                portal_id: window.portal_id.clone(),
                direction: window.direction.clone(),
                earliest_s: window.earliest_s,
                target_s: window.target_s,
                latest_s: window.latest_s,
            })
            .collect(),
    })
}

fn passenger_stops(
    input: &CoordinateRequestInput,
    candidate: &zugfolge_planner::PathCandidate,
    materialized: &MaterializedRun,
) -> Result<Vec<PassengerStopProjection>, PlanningRuntimeError> {
    candidate
        .profile()
        .station_calls()
        .iter()
        .filter_map(|call| {
            let Some(station_id) = materialized.station_external_by_numeric.get(&call.station)
            else {
                return Some(Err(invalid(
                    "Verkehrshalt verweist auf unbekannte Betriebsstelle",
                )));
            };
            if station_id != &input.origin_station_id
                && station_id != &input.destination_station_id
                && !input
                    .stops
                    .iter()
                    .any(|stop| &stop.station_id == station_id)
            {
                return None;
            }
            Some((|| {
                let arrival_s = candidate
                    .first_departure()
                    .seconds()
                    .checked_add(call.arrival_s)
                    .ok_or_else(|| invalid("Überlauf bei Verkehrshaltankunft"))?;
                let departure_s = candidate
                    .first_departure()
                    .seconds()
                    .checked_add(call.departure_s)
                    .ok_or_else(|| invalid("Überlauf bei Verkehrshaltabfahrt"))?;
                safe_non_negative(arrival_s, "passengerStops[].arrivalS")?;
                safe_non_negative(departure_s, "passengerStops[].departureS")?;
                Ok(PassengerStopProjection {
                    station_id: station_id.clone(),
                    arrival_s,
                    departure_s,
                })
            })())
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlternativeIdentity<'a> {
    world_id: &'a str,
    request_numeric_id: u32,
    train_id: &'a str,
    departure_shift_s: i64,
    extra_running_time_s: i64,
    tracks: Vec<u32>,
    operational_stops: Vec<u32>,
}

fn alternative_id(
    world_id: &str,
    request: &MaterializedRequest,
    candidate: &zugfolge_planner::PathCandidate,
) -> Result<String, PlanningRuntimeError> {
    let identity = AlternativeIdentity {
        world_id,
        request_numeric_id: request.input.request_numeric_id,
        train_id: &request.input.train_id,
        departure_shift_s: candidate.deviation().shift_s(),
        extra_running_time_s: candidate.deviation().extra_running_time_s(),
        tracks: candidate
            .itinerary()
            .legs()
            .iter()
            .map(|leg| leg.track().value())
            .collect(),
        operational_stops: candidate
            .deviation()
            .operational_stops()
            .iter()
            .map(|point| point.value())
            .collect(),
    };
    Ok(format!("alt-{}", &sha256_json(&identity)?[..24]))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictIdentity<'a> {
    train_id: &'a str,
    other_train_id: &'a str,
    resource_id: &'a str,
    start_s: i64,
    end_s: i64,
}

fn conflict_id(
    train_id: &str,
    other_train_id: &str,
    resource_id: &str,
    start_s: i64,
    end_s: i64,
) -> Result<String, PlanningRuntimeError> {
    let identity = ConflictIdentity {
        train_id,
        other_train_id,
        resource_id,
        start_s,
        end_s,
    };
    Ok(format!("conflict-{}", &sha256_json(&identity)?[..24]))
}

fn build_projection(
    input: &PlanningCoordinateInput,
    materialized: &MaterializedRun,
    outcome: &zugfolge_planner::PlanningRunOutcome,
    revision: u64,
) -> Result<(PlanningProjection, BTreeMap<String, StoredAlternative>), PlanningRuntimeError> {
    let options = PlannerOptions::default();
    let mut trains = Vec::new();
    let mut occupations = Vec::new();
    let mut desired_runs = BTreeMap::new();
    let mut train_id_by_number = BTreeMap::new();
    if let Some(previous) = &input.previous_state {
        for reservation in previous.reservations.values() {
            let number = TrainNumber::new(
                TrainCategory::of_number(reservation.number)
                    .ok_or_else(|| invalid("Reservierung enthält ungültige Zugnummer"))?,
                reservation.number,
            )
            .map_err(map_domain)?;
            train_id_by_number.insert(number, reservation.train.id.clone());
            trains.push(reservation.train.clone());
            occupations.extend(reservation.occupations.clone());
        }
    }
    for request in &materialized.requests {
        let run = desired_run(&materialized.infrastructure, &request.request, options)?;
        let projected_run = if input.schema_version == COORDINATE_SCHEMA {
            match outcome.outcome(request.request.id()) {
                Some(RequestOutcome::Planned(planned))
                    if planned.decision() == PathDecision::Granted =>
                {
                    let candidate = planned
                        .candidates()
                        .first()
                        .ok_or_else(|| invalid("Zuteilung ohne Kandidat"))?;
                    TrainRun::new(
                        request.request.number(),
                        candidate.first_departure(),
                        candidate.profile(),
                    )
                }
                _ => run.clone(),
            }
        } else {
            run.clone()
        };
        trains.push(project_train(
            &request.input,
            &request.request,
            &projected_run,
            materialized,
        )?);
        occupations.extend(project_occupations(
            &request.input.train_id,
            &projected_run,
            materialized,
        )?);
        train_id_by_number.insert(request.request.number(), request.input.train_id.clone());
        desired_runs.insert(request.request.id(), run);
    }
    trains.sort_by(|left, right| left.id.cmp(&right.id));
    occupations.sort_by(|left, right| {
        (
            left.train_id.as_str(),
            left.start_s,
            left.resource.id.as_str(),
            left.phase.as_str(),
        )
            .cmp(&(
                right.train_id.as_str(),
                right.start_s,
                right.resource.id.as_str(),
                right.phase.as_str(),
            ))
    });

    let mut conflicts = Vec::new();
    let mut alternatives = BTreeMap::new();
    for request in &materialized.requests {
        let Some(RequestOutcome::Planned(planned)) = outcome.outcome(request.request.id()) else {
            continue;
        };
        let desired_conflicts = planned.desired_conflicts().conflicts();
        if desired_conflicts.is_empty() {
            continue;
        }
        let candidate = planned
            .offer()
            .filter(|_| planned.decision() == PathDecision::Alternative);
        let offered_id = candidate
            .map(|candidate| alternative_id(&input.world_id, request, candidate))
            .transpose()?;
        let mut projected_ids = Vec::new();
        for conflict in desired_conflicts {
            let other_train_id = train_id_by_number
                .get(&conflict.other_run().number())
                .ok_or_else(|| invalid("Konflikt verweist auf unbekannten Gegenzug"))?;
            let governing_station = materialized
                .station_external_by_numeric
                .get(&conflict.own().governing_point())
                .ok_or_else(|| invalid("Konflikt verweist auf unbekannte Betriebsstelle"))?;
            let governing_distance = materialized
                .station_by_external
                .get(governing_station)
                .map_or(0, |station| station.distance_mm);
            let resource = materialized
                .resource_locations
                .get(&conflict.resource())
                .cloned()
                .unwrap_or_else(|| fallback_resource(conflict.resource(), governing_distance));
            let start_s = conflict.overlap_start().seconds();
            let end_s = conflict.overlap_end().seconds();
            safe_non_negative(start_s, "conflicts[].window.startS")?;
            safe_non_negative(end_s, "conflicts[].window.endS")?;
            let id = conflict_id(
                &request.input.train_id,
                other_train_id,
                &resource.projection.id,
                start_s,
                end_s,
            )?;
            projected_ids.push(id.clone());
            conflicts.push(ConflictProjection {
                id,
                kind: conflict.kind().tag().to_owned(),
                resource: resource.projection,
                window: ConflictWindowProjection { start_s, end_s },
                train_ids: vec![request.input.train_id.clone(), other_train_id.clone()],
                explanation: conflict.explain(),
                alternative: None,
            });
        }
        if let (Some(candidate), Some(offered_id), Some(first_conflict_id)) =
            (candidate, offered_id, projected_ids.first())
        {
            let replacement_run = TrainRun::new(
                request.request.number(),
                candidate.first_departure(),
                candidate.profile(),
            );
            let replacement_train = project_train(
                &request.input,
                &request.request,
                &replacement_run,
                materialized,
            )?;
            let replacement_occupations =
                project_occupations(&request.input.train_id, &replacement_run, materialized)?;
            let replacement_stops = passenger_stops(&request.input, candidate, materialized)?;
            let explanation = format!(
                "PlanningRun {} bietet die gepruefte Zeitlage an: {}",
                input.run_id,
                candidate.explain()
            );
            if let Some(conflict) = conflicts
                .iter_mut()
                .find(|conflict| conflict.id == *first_conflict_id)
            {
                conflict.alternative = Some(AlternativeProjection {
                    alternative_id: offered_id.clone(),
                    train_id: request.input.train_id.clone(),
                    departure_shift_s: candidate.deviation().shift_s(),
                    explanation,
                });
            }
            alternatives.insert(
                offered_id,
                StoredAlternative {
                    conflict_id: first_conflict_id.clone(),
                    train_id: request.input.train_id.clone(),
                    departure_shift_s: candidate.deviation().shift_s(),
                    reservation: (input.schema_version == COORDINATE_SCHEMA).then(|| {
                        StoredReservation {
                            number: request.request.number().value(),
                            train: replacement_train.clone(),
                            occupations: replacement_occupations.clone(),
                            operating_days: request.input.operating_days.clone(),
                            service_window: request.input.service_window.clone(),
                            passenger_stops: replacement_stops,
                        }
                    }),
                    replacement_train,
                    replacement_occupations,
                    resolved_conflict_ids: projected_ids,
                },
            );
        }
    }
    conflicts.sort_by(|left, right| left.id.cmp(&right.id));

    Ok((
        PlanningProjection {
            schema_version: PROJECTION_SCHEMA.to_owned(),
            projection_revision: revision,
            world_id: input.world_id.clone(),
            corridor: CorridorProjection {
                id: input.corridor_id.clone(),
                name: input.corridor_name.clone(),
            },
            stations: input
                .stations
                .iter()
                .map(|station| StationProjection {
                    id: station.id.clone(),
                    name: station.name.clone(),
                    distance_mm: station.distance_mm,
                })
                .collect::<Vec<_>>(),
            trains,
            occupations,
            conflicts,
        },
        alternatives,
    ))
}

fn result(
    state: PlanningRuntimeState,
    replay: bool,
) -> Result<PlanningRuntimeResult, PlanningRuntimeError> {
    let state_hash = sha256_json(&state)?;
    let projection = state.projection.clone();
    Ok(PlanningRuntimeResult {
        schema_version: RESULT_SCHEMA.to_owned(),
        state,
        state_hash,
        projection,
        idempotent_replay: replay,
    })
}

fn infrastructure_hash(input: &PlanningCoordinateInput) -> Result<String, PlanningRuntimeError> {
    let mut stations = input.stations.clone();
    stations.sort_by(|left, right| left.id.cmp(&right.id));
    let mut segments = input.segments.clone();
    segments.sort_by(|left, right| left.id.cmp(&right.id));
    sha256_json(&(&input.source_id, &input.corridor_id, stations, segments))
}

const RESERVATION_PHASES: [&str; 6] = [
    "route-setting",
    "signal-sighting",
    "approach",
    "running",
    "clearing",
    "route-release",
];

/// Reconstitutes exact native intervals, never an estimate of the reserved route.
fn reservation_steps(
    reservation: &StoredReservation,
    materialized: &MaterializedRun,
    shift_s: i64,
) -> Result<Vec<BlockingTime>, PlanningRuntimeError> {
    let direction = match reservation.train.direction.as_str() {
        "with-chainage" => TravelDirection::WithChainage,
        "against-chainage" => TravelDirection::AgainstChainage,
        _ => return Err(invalid("Reservierte Fahrtrichtung ist ungültig")),
    };
    let mut groups: BTreeMap<(&str, &str), [Vec<&OccupationProjection>; 6]> = BTreeMap::new();
    for occupation in &reservation.occupations {
        if occupation.train_id != reservation.train.id {
            return Err(invalid("Reservierung enthält fremde Belegung"));
        }
        let phase = RESERVATION_PHASES
            .iter()
            .position(|phase| *phase == occupation.phase)
            .ok_or_else(|| invalid("Reservierung enthält unbekannte Sperrzeitphase"))?;
        safe_non_negative(occupation.start_s, "reservation.startS")?;
        safe_non_negative(occupation.end_s, "reservation.endS")?;
        if occupation.end_s < occupation.start_s {
            return Err(invalid("Reservierung enthält rückläufige Belegung"));
        }
        groups
            .entry((&occupation.resource.id, &occupation.governing_station_id))
            .or_default()[phase]
            .push(occupation);
    }
    let mut steps = Vec::new();
    for ((resource_id, station_id), mut phases) in groups {
        let count = phases[0].len();
        if count == 0 || phases.iter().any(|items| items.len() != count) {
            return Err(invalid(
                "Reservierung enthält kein vollständiges Sechsphasenprofil",
            ));
        }
        for items in &mut phases {
            items.sort_by_key(|occupation| (occupation.start_s, occupation.end_s));
        }
        let resource = materialized
            .resource_locations
            .iter()
            .find(|(_, location)| location.projection.id == resource_id)
            .map(|(resource, _)| *resource)
            .ok_or_else(|| {
                invalid("Reservierte Ressource fehlt im gebundenen Infrastrukturrelease")
            })?;
        let point = materialized
            .station_by_external
            .get(station_id)
            .ok_or_else(|| invalid("Reservierte Betriebsstelle fehlt im Release"))?;
        for (index, first_phase) in phases[0].iter().enumerate() {
            for phase in 1..6 {
                if phases[phase - 1][index].end_s != phases[phase][index].start_s {
                    return Err(invalid("Reservierte Sperrzeitphasen sind nicht lückenlos"));
                }
            }
            let start = first_phase
                .start_s
                .checked_add(shift_s)
                .ok_or_else(|| invalid("Reservierungszeit läuft über"))?;
            let end = phases[5][index]
                .end_s
                .checked_add(shift_s)
                .ok_or_else(|| invalid("Reservierungszeit läuft über"))?;
            if start == end {
                continue;
            }
            let step = BlockingTime::reserved_interval(
                resource,
                direction,
                OperatingPointId::new(point.numeric_id),
                SimTime::from_seconds(start),
                SimTime::from_seconds(end),
            )
            .ok_or_else(|| invalid("Reserviertes Intervall ist ungültig"))?;
            steps.push(step);
        }
    }
    if steps.is_empty() {
        return Err(invalid("Reservierte Fahrt besitzt keine Belegungen"));
    }
    Ok(steps)
}

fn restore_baseline(
    input: &PlanningCoordinateInput,
    materialized: &MaterializedRun,
    infrastructure_hash: &str,
) -> Result<OccupationLedger, PlanningRuntimeError> {
    let mut ledger = OccupationLedger::new(materialized.infrastructure.exclusions().clone());
    let Some(previous) = &input.previous_state else {
        return Ok(ledger);
    };
    if input.schema_version != COORDINATE_SCHEMA
        || previous.schema_version != STATE_SCHEMA
        || previous.world_id != input.world_id
        || previous.projection.world_id != input.world_id
        || Some(previous.projection_revision) != input.expected_projection_revision
        || previous.projection.projection_revision != previous.projection_revision
    {
        return Err(invalid(
            "Ausgangszustand gehört nicht zur Welt, Revision oder zum Koordinierungsvertrag",
        ));
    }
    if previous.infrastructure_hash.as_deref() != Some(infrastructure_hash) {
        return Err(invalid(
            "Ausgangszustand besitzt keinen exakt gebundenen Infrastrukturbeleg; vollständige Neukoodinierung erforderlich",
        ));
    }
    let earliest = input
        .requests
        .iter()
        .map(|request| {
            request
                .desired_departure_s
                .saturating_sub(request.earlier_s)
        })
        .min()
        .unwrap_or(0);
    let latest = input
        .requests
        .iter()
        .map(|request| request.desired_departure_s.saturating_add(request.later_s))
        .max()
        .unwrap_or(0);
    if latest.saturating_sub(earliest) > 56 * SECONDS_PER_DAY {
        return Err(invalid(
            "Ein Planungsbatch darf höchstens acht Wochen umfassen",
        ));
    }
    let last_day = latest
        .div_euclid(SECONDS_PER_DAY)
        .saturating_add(PlannerOptions::default().horizon_days());
    let mut numbers = BTreeSet::new();
    for (train_id, reservation) in &previous.reservations {
        if train_id != &reservation.train.id
            || input.requests.iter().any(|request| {
                request.train_id == *train_id || request.train_number == reservation.number
            })
            || !numbers.insert(reservation.number)
        {
            return Err(invalid(
                "Ein neuer Antrag ersetzt oder dupliziert eine bestehende Reservierung",
            ));
        }
        if !previous.projection.trains.contains(&reservation.train)
            || previous
                .projection
                .occupations
                .iter()
                .filter(|occupation| occupation.train_id == *train_id)
                .cloned()
                .collect::<Vec<_>>()
                != reservation.occupations
        {
            return Err(invalid(
                "Reservierung und bestätigte Projektion widersprechen sich",
            ));
        }
        let days = days(&reservation.operating_days)?;
        let window = reservation
            .service_window
            .as_ref()
            .map(CoordinateServiceWindowInput::window)
            .transpose()?;
        let departure = reservation
            .train
            .calls
            .first()
            .ok_or_else(|| invalid("Reservierte Abfahrt fehlt"))?
            .time_s;
        safe_non_negative(departure, "reservation.departureS")?;
        if window.is_some_and(|window| !window.contains(SimTime::from_seconds(departure))) {
            return Err(invalid(
                "Reservierte Abfahrt liegt außerhalb ihrer Gültigkeit",
            ));
        }
        let number = TrainNumber::new(
            TrainCategory::of_number(reservation.number)
                .ok_or_else(|| invalid("Reservierte Zugnummer ist ungültig"))?,
            reservation.number,
        )
        .map_err(map_domain)?;
        let longest = reservation
            .occupations
            .iter()
            .map(|occupation| occupation.end_s.saturating_sub(departure))
            .max()
            .unwrap_or(0);
        let first_day = earliest
            .saturating_sub(longest)
            .div_euclid(SECONDS_PER_DAY)
            .max(0);
        for day in first_day..=last_day {
            let at_s = day
                .checked_mul(SECONDS_PER_DAY)
                .and_then(|seconds| seconds.checked_add(departure.rem_euclid(SECONDS_PER_DAY)))
                .ok_or_else(|| invalid("Reservierte Abfahrt läuft über"))?;
            let at = SimTime::from_seconds(at_s);
            if !days.contains_day(day) || window.is_some_and(|window| !window.contains(at)) {
                continue;
            }
            let run = TrainRun::from_blocking_times(
                number,
                at,
                reservation_steps(reservation, materialized, at_s - departure)?,
            );
            ledger
                .try_insert(&run)
                .map_err(|_| invalid("Bestehende Reservierungen kollidieren im Ausgangszustand"))?;
        }
    }
    Ok(ledger)
}

fn replace_future_reservations(
    input: &mut PlanningCoordinateInput,
) -> Result<(), PlanningRuntimeError> {
    if input.replace_train_ids.is_empty() {
        if input.effective_from_s.is_some() {
            return Err(invalid("Änderungszeit ohne betroffene Fahrten"));
        }
        return Ok(());
    }
    if input.schema_version != COORDINATE_SCHEMA || input.replace_train_ids.len() > 256 {
        return Err(invalid(
            "Linienänderung verlangt v2 und höchstens 256 Fahrten",
        ));
    }
    let effective_from = input
        .effective_from_s
        .ok_or_else(|| invalid("Autoritative Änderungszeit fehlt"))?;
    safe_non_negative(effective_from, "effectiveFromS")?;
    let ids: BTreeSet<_> = input.replace_train_ids.iter().cloned().collect();
    if ids.len() != input.replace_train_ids.len() {
        return Err(invalid("Linienänderung nennt eine Fahrt doppelt"));
    }
    let previous = input
        .previous_state
        .as_mut()
        .ok_or_else(|| invalid("Linienänderung besitzt keinen Ausgangszustand"))?;
    if previous.world_id != input.world_id
        || Some(previous.projection_revision) != input.expected_projection_revision
    {
        return Err(invalid(
            "Linienänderung verletzt Welt- oder Revisionsbindung",
        ));
    }
    for id in &ids {
        let reservation = previous.reservations.get(id).ok_or_else(|| {
            invalid("Die zu ändernde Fahrt besitzt keine bestehende Reservierung")
        })?;
        let window = reservation.service_window.as_ref().ok_or_else(|| invalid("Unbefristete Altangebote lassen sich nicht als zukünftige Einzelfahrt ersetzen"))?.window()?;
        if window.valid_from().seconds() <= effective_from {
            return Err(invalid(
                "Die zu ändernde Fahrt hat ihr Gültigkeitsfenster bereits begonnen",
            ));
        }
    }
    previous.reservations.retain(|id, _| !ids.contains(id));
    previous
        .projection
        .trains
        .retain(|train| !ids.contains(&train.id));
    previous
        .projection
        .occupations
        .retain(|occupation| !ids.contains(&occupation.train_id));
    previous
        .projection
        .conflicts
        .retain(|conflict| !conflict.train_ids.iter().any(|id| ids.contains(id)));
    previous
        .alternatives
        .retain(|_, alternative| !ids.contains(&alternative.train_id));
    Ok(())
}

fn coordinate(
    mut input: PlanningCoordinateInput,
) -> Result<PlanningRuntimeResult, PlanningRuntimeError> {
    replace_future_reservations(&mut input)?;
    let materialized = materialize(&input)?;
    let infrastructure_hash = infrastructure_hash(&input)?;
    let seed_world = input
        .seed_world
        .parse::<u64>()
        .map_err(|_| invalid("seedWorld ist keine u64-Dezimalzahl"))?;
    let requests = materialized
        .requests
        .iter()
        .map(|request| request.request.clone())
        .collect::<Vec<_>>();
    let planner = TrainPathPlanner::new(&materialized.infrastructure);
    let baseline = restore_baseline(&input, &materialized, &infrastructure_hash)?;
    let mut run = PlanningRun::new(
        planner,
        WorldSeed::new(seed_world, input.seed_period),
        baseline,
        requests,
    )
    .map_err(map_domain)?;
    run.coordinate().map_err(map_domain)?;
    let outcome = run.finalize().map_err(map_domain)?;
    if !input.replace_train_ids.is_empty() && materialized.requests.iter().any(|request| {
        !matches!(outcome.outcome(request.request.id()), Some(RequestOutcome::Planned(planned)) if planned.decision() == PathDecision::Granted)
    }) {
        return Err(PlanningRuntimeError::new("replacement_conflict", "Linienänderung ist nicht vollständig zuteilbar; bisherige Reservierungen bleiben erhalten"));
    }
    let revision = input
        .expected_projection_revision
        .map_or(1, |current| current.saturating_add(1));
    if revision > u64::try_from(MAX_SAFE_INTEGER).unwrap_or(u64::MAX) {
        return Err(invalid(
            "projectionRevision ueberschreitet JavaScripts sicheren Bereich",
        ));
    }
    let (mut projection, alternatives) =
        build_projection(&input, &materialized, outcome, revision)?;
    let mut reservations = input
        .previous_state
        .as_ref()
        .map_or_else(BTreeMap::new, |previous| previous.reservations.clone());
    if input.schema_version == COORDINATE_SCHEMA {
        for request in &materialized.requests {
            if let Some(RequestOutcome::Planned(planned)) = outcome.outcome(request.request.id()) {
                if planned.decision() == PathDecision::Granted {
                    let candidate = planned
                        .candidates()
                        .first()
                        .ok_or_else(|| invalid("Zuteilung ohne Kandidat"))?;
                    let train = projection
                        .trains
                        .iter()
                        .find(|train| train.id == request.input.train_id)
                        .ok_or_else(|| invalid("Zuteilung fehlt in Projektion"))?
                        .clone();
                    let occupations = projection
                        .occupations
                        .iter()
                        .filter(|occupation| occupation.train_id == train.id)
                        .cloned()
                        .collect();
                    reservations.insert(
                        train.id.clone(),
                        StoredReservation {
                            number: request.request.number().value(),
                            train,
                            occupations,
                            operating_days: request.input.operating_days.clone(),
                            service_window: request.input.service_window.clone(),
                            passenger_stops: passenger_stops(
                                &request.input,
                                candidate,
                                &materialized,
                            )?,
                        },
                    );
                }
            }
        }
    }
    projection
        .stations
        .sort_by_key(|station| (station.distance_mm, station.id.clone()));
    result(
        PlanningRuntimeState {
            schema_version: STATE_SCHEMA.to_owned(),
            world_id: input.world_id,
            projection_revision: revision,
            projection,
            alternatives,
            processed_commands: BTreeMap::new(),
            infrastructure_hash: (input.schema_version == COORDINATE_SCHEMA)
                .then_some(infrastructure_hash),
            reservations,
        },
        false,
    )
}

fn apply(
    mut state: PlanningRuntimeState,
    command_id: &str,
    command: PlanningApplyAlternativeCommand,
) -> Result<PlanningRuntimeResult, PlanningRuntimeError> {
    if state.schema_version != STATE_SCHEMA || command.schema_version != APPLY_SCHEMA {
        return Err(PlanningRuntimeError::new(
            "unsupported_schema",
            format!("{} / {}", state.schema_version, command.schema_version),
        ));
    }
    non_empty(command_id, "commandId")?;
    if state.world_id != state.projection.world_id
        || state.projection_revision != state.projection.projection_revision
    {
        return Err(PlanningRuntimeError::new(
            "state_corrupt",
            "Zustand und Projektion stimmen nicht ueberein",
        ));
    }
    let command_hash = sha256_json(&command)?;
    if let Some(processed) = state.processed_commands.get(command_id) {
        if processed.command_hash != command_hash {
            return Err(PlanningRuntimeError::new(
                "idempotency_conflict",
                "commandId wurde bereits mit anderen Nutzdaten verarbeitet",
            ));
        }
        return result(state, true);
    }
    if command.projection_revision != state.projection_revision {
        return Err(PlanningRuntimeError::new(
            "revision_conflict",
            format!(
                "erwartet Revision {}, erhielt {}",
                state.projection_revision, command.projection_revision
            ),
        ));
    }
    let offered = state
        .alternatives
        .get(&command.alternative_id)
        .cloned()
        .ok_or_else(|| {
            PlanningRuntimeError::new("unknown_alternative", command.alternative_id.clone())
        })?;
    if offered.conflict_id != command.conflict_id
        || offered.train_id != command.train_id
        || offered.departure_shift_s != command.departure_shift_s
    {
        return Err(PlanningRuntimeError::new(
            "alternative_mismatch",
            "Kommando stimmt nicht mit dem PlanningRun-Angebot ueberein",
        ));
    }
    let train = state
        .projection
        .trains
        .iter_mut()
        .find(|train| train.id == offered.train_id)
        .ok_or_else(|| PlanningRuntimeError::new("state_corrupt", "angebotener Zug fehlt"))?;
    *train = offered.replacement_train;
    if let Some(reservation) = offered.reservation {
        state
            .reservations
            .insert(reservation.train.id.clone(), reservation);
    }
    state
        .projection
        .occupations
        .retain(|occupation| occupation.train_id != offered.train_id);
    state
        .projection
        .occupations
        .extend(offered.replacement_occupations);
    state.projection.occupations.sort_by(|left, right| {
        (
            left.train_id.as_str(),
            left.start_s,
            left.resource.id.as_str(),
            left.phase.as_str(),
        )
            .cmp(&(
                right.train_id.as_str(),
                right.start_s,
                right.resource.id.as_str(),
                right.phase.as_str(),
            ))
    });
    if let Some(reservation) = state.reservations.get_mut(&offered.train_id) {
        reservation.occupations = state
            .projection
            .occupations
            .iter()
            .filter(|occupation| occupation.train_id == offered.train_id)
            .cloned()
            .collect();
    }
    let resolved = offered
        .resolved_conflict_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    state
        .projection
        .conflicts
        .retain(|conflict| !resolved.contains(&conflict.id));
    state.alternatives.retain(|_, alternative| {
        !alternative
            .resolved_conflict_ids
            .iter()
            .any(|conflict| resolved.contains(conflict))
    });
    state.projection_revision = state.projection_revision.saturating_add(1);
    state.projection.projection_revision = state.projection_revision;
    state.processed_commands.insert(
        command_id.to_owned(),
        ProcessedCommand {
            command_hash,
            resulting_projection_revision: state.projection_revision,
        },
    );
    result(state, false)
}

/// Fuehrt einen echten `PlanningRun` aus und liefert Zustand plus Projektion.
///
/// # Errors
///
/// Unbekannte Felder, gebrochene Infrastruktur- oder Antragsbeziehungen und
/// fachlich nicht planbare Eingaben werden mit stabilem Fehlercode abgewiesen.
pub fn coordinate_planning_run(input_json: &str) -> Result<String, PlanningRuntimeError> {
    let input: PlanningCoordinateInput = serde_json::from_str(input_json)
        .map_err(|error| PlanningRuntimeError::new("invalid_json", error.to_string()))?;
    serde_json::to_string(&coordinate(input)?)
        .map_err(|error| PlanningRuntimeError::new("serialization_failed", error.to_string()))
}

/// Wendet genau eine zuvor vom `PlanningRun` angebotene Alternative an.
///
/// `command_id` liegt bewusst ausserhalb des fachlichen v1-Payloads: Das
/// persistierte API-Kommando bleibt exakt, waehrend der Rust-Zustand Replay und
/// Kollisionen trotzdem selbst pruefen kann.
///
/// # Errors
///
/// Bei fremder Revision, unbekanntem Angebot, manipulierten serverseitigen
/// Ableitungen oder wiederverwendeter Kommando-ID mit anderen Daten.
pub fn apply_planning_alternative(
    state_json: &str,
    command_id: &str,
    command_json: &str,
) -> Result<String, PlanningRuntimeError> {
    let state: PlanningRuntimeState = serde_json::from_str(state_json)
        .map_err(|error| PlanningRuntimeError::new("invalid_state", error.to_string()))?;
    let command: PlanningApplyAlternativeCommand = serde_json::from_str(command_json)
        .map_err(|error| PlanningRuntimeError::new("invalid_json", error.to_string()))?;
    serde_json::to_string(&apply(state, command_id, command)?)
        .map_err(|error| PlanningRuntimeError::new("serialization_failed", error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::{Value, json};

    use super::{
        COORDINATE_SCHEMA, COORDINATE_SCHEMA_V1, CoordinateTrainCharacteristicsInput,
        apply_planning_alternative, coordinate_planning_run, coordinate_train_speed,
    };

    #[test]
    fn v2_fahrzeug_vmax_bleibt_exakt_und_v1_hat_einen_getrennten_kph_pfad() {
        let train = |maximum_speed_kph, maximum_speed_mmps| CoordinateTrainCharacteristicsInput {
            numeric_id: 1,
            name: "Vmax-Test".to_owned(),
            mass_kg: 1,
            length_mm: 1,
            maximum_speed_kph,
            maximum_speed_mmps,
            acceleration_mm_per_s2: 1,
            deceleration_mm_per_s2: 1,
        };

        assert_eq!(
            coordinate_train_speed(COORDINATE_SCHEMA, &train(None, Some(27_777)))
                .unwrap()
                .millimetres_per_second(),
            27_777
        );
        assert_eq!(
            coordinate_train_speed(COORDINATE_SCHEMA, &train(None, Some(27_000)))
                .unwrap()
                .millimetres_per_second(),
            27_000
        );
        assert_eq!(
            coordinate_train_speed(COORDINATE_SCHEMA_V1, &train(Some(100), None))
                .unwrap()
                .millimetres_per_second(),
            27_778,
            "Legacy-v1 behaelt die historische KPH-Aufrundung"
        );
        assert!(coordinate_train_speed(COORDINATE_SCHEMA, &train(None, None)).is_err());
        assert!(coordinate_train_speed(COORDINATE_SCHEMA, &train(Some(100), None)).is_err());
        assert!(coordinate_train_speed(COORDINATE_SCHEMA, &train(None, Some(0))).is_err());
    }

    fn coordinate_input(requests_reversed: bool) -> Value {
        let first = json!({
            "requestNumericId": 1,
            "trainId": "train-east",
            "trainCategory": "regional",
            "trainNumber": 26802,
            "originStationId": "west",
            "destinationStationId": "east",
            "desiredDepartureS": 28800,
            "operatingDays": "daily",
            "stops": [],
            "earlierS": 0,
            "laterS": 1800,
            "stepS": 60,
            "extraRunningTimeS": 0,
            "maxOperationalStops": 0,
            "train": {
                "numericId": 1,
                "name": "Regionaltriebwagen Ost",
                "massKg": 120000,
                "lengthMm": 140000,
                "maximumSpeedKph": 140,
                "accelerationMmPerS2": 600,
                "decelerationMmPerS2": 800
            }
        });
        let second = json!({
            "requestNumericId": 2,
            "trainId": "train-west",
            "trainCategory": "regional",
            "trainNumber": 26804,
            "originStationId": "east",
            "destinationStationId": "west",
            "desiredDepartureS": 28800,
            "operatingDays": "daily",
            "stops": [],
            "earlierS": 0,
            "laterS": 1800,
            "stepS": 60,
            "extraRunningTimeS": 0,
            "maxOperationalStops": 0,
            "train": {
                "numericId": 2,
                "name": "Regionaltriebwagen West",
                "massKg": 120000,
                "lengthMm": 140000,
                "maximumSpeedKph": 140,
                "accelerationMmPerS2": 600,
                "decelerationMmPerS2": 800
            }
        });
        let requests = if requests_reversed {
            vec![second, first]
        } else {
            vec![first, second]
        };
        json!({
            "schemaVersion": "planning-coordinate/v1",
            "worldId": "11111111-1111-4111-8111-111111111111",
            "runId": "period-2026-window-1",
            "expectedProjectionRevision": null,
            "seedWorld": "78193085935",
            "seedPeriod": 1,
            "sourceId": "infra-release-lhe-2026",
            "corridorId": "corridor-west-east",
            "corridorName": "West–Ost",
            "stations": [
                {
                    "numericId": 1,
                    "id": "west",
                    "code": "LWE",
                    "name": "West",
                    "distanceMm": 0,
                    "latitudeE7": 510000000,
                    "longitudeE7": 120000000,
                    "stationTrackNumericId": 101,
                    "stationTrackLengthMm": 400000,
                    "stationMaximumSpeedKph": 80
                },
                {
                    "numericId": 2,
                    "id": "east",
                    "code": "LOE",
                    "name": "Ost",
                    "distanceMm": 5000000,
                    "latitudeE7": 510100000,
                    "longitudeE7": 120100000,
                    "stationTrackNumericId": 201,
                    "stationTrackLengthMm": 400000,
                    "stationMaximumSpeedKph": 80
                }
            ],
            "segments": [{
                "edgeNumericId": 1,
                "trackNumericId": 1001,
                "id": "west-east",
                "label": "West–Ost",
                "fromStationId": "west",
                "toStationId": "east",
                "lengthMm": 5000000,
                "maximumSpeedKph": 120,
                "mainSignalPositionsMm": [2000000, 4000000],
                "maximumVirtualBlockLengthMm": 2000000
            }],
            "requests": requests
        })
    }

    fn coordinate_input_v2() -> Value {
        let mut input = coordinate_input(false);
        input["schemaVersion"] = json!(COORDINATE_SCHEMA);
        for (request, speed) in input["requests"]
            .as_array_mut()
            .expect("Antragsliste")
            .iter_mut()
            .zip([27_777, 27_000])
        {
            let train = request["train"].as_object_mut().expect("Zugdaten");
            train.remove("maximumSpeedKph");
            train.insert("maximumSpeedMmps".to_owned(), json!(speed));
        }
        input
    }

    #[test]
    fn v2_coordinate_verlangt_das_exakte_mmps_feld_fail_closed() {
        let valid = coordinate_input_v2();
        coordinate_planning_run(&valid.to_string()).expect("v2 mit exakten mm/s gelingt");

        let mut missing = valid.clone();
        missing["requests"][0]["train"]
            .as_object_mut()
            .expect("Zugdaten")
            .remove("maximumSpeedMmps");
        assert!(coordinate_planning_run(&missing.to_string()).is_err());

        let mut legacy_field = missing.clone();
        legacy_field["requests"][0]["train"]["maximumSpeedKph"] = json!(100);
        assert!(coordinate_planning_run(&legacy_field.to_string()).is_err());

        let mut unknown_field = valid;
        unknown_field["requests"][0]["train"]["maximumSpeedMps"] = json!(27);
        assert!(coordinate_planning_run(&unknown_field.to_string()).is_err());
    }

    fn coordinate_value(reversed: bool) -> Value {
        serde_json::from_str(
            &coordinate_planning_run(&coordinate_input(reversed).to_string())
                .expect("echter PlanningRun gelingt"),
        )
        .expect("gueltiges Ergebnis")
    }

    fn single_absolute_input(departure: i64, id: &str, number: u32) -> Value {
        let mut input = coordinate_input_v2();
        input["requests"].as_array_mut().unwrap().truncate(1);
        input["requests"][0]["trainId"] = json!(id);
        input["requests"][0]["trainNumber"] = json!(number);
        input["requests"][0]["desiredDepartureS"] = json!(departure);
        input["requests"][0]["serviceWindow"] =
            json!({"validFromS": departure, "validUntilS": departure + 1});
        input
    }

    #[test]
    fn verkehrshalte_nutzen_native_ankunft_und_haltezeit_ohne_durchfahrten() {
        let mut input = single_absolute_input(28_800, "with-stop", 26802);
        let mut middle = input["stations"][0].clone();
        middle["id"] = json!("middle");
        middle["numericId"] = json!(3);
        middle["code"] = json!("LMI");
        middle["name"] = json!("Mitte");
        middle["stationTrackNumericId"] = json!(301);
        middle["distanceMm"] = json!(2_500_000);
        input["stations"].as_array_mut().unwrap().push(middle);
        let mut first_segment = input["segments"][0].clone();
        first_segment["id"] = json!("west-middle");
        first_segment["toStationId"] = json!("middle");
        first_segment["lengthMm"] = json!(2_500_000);
        first_segment["mainSignalPositionsMm"] = json!([1_000_000, 2_000_000]);
        let mut second_segment = first_segment.clone();
        second_segment["id"] = json!("middle-east");
        second_segment["edgeNumericId"] = json!(2);
        second_segment["trackNumericId"] = json!(1002);
        second_segment["fromStationId"] = json!("middle");
        second_segment["toStationId"] = json!("east");
        input["segments"] = json!([first_segment, second_segment]);
        let direct = evaluate_json(&input);
        assert_eq!(
            direct["state"]["reservations"]["with-stop"]["passengerStops"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        input["requests"][0]["stops"] = json!([{"stationId":"middle", "minimumDwellS":60}]);
        let stopping = evaluate_json(&input);
        let calls = stopping["state"]["reservations"]["with-stop"]["passengerStops"]
            .as_array()
            .unwrap();
        assert_eq!(
            calls
                .iter()
                .map(|call| call["stationId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["west", "middle", "east"]
        );
        assert_eq!(calls[0]["arrivalS"], 28_800);
        assert_eq!(calls[0]["departureS"], 28_800);
        assert_eq!(
            calls[1]["departureS"].as_i64().unwrap() - calls[1]["arrivalS"].as_i64().unwrap(),
            60
        );
        assert!(calls[1]["arrivalS"].as_i64().unwrap() > 28_800);
        assert!(calls[2]["arrivalS"].as_i64().unwrap() > calls[1]["departureS"].as_i64().unwrap());
        assert_eq!(
            calls[2]["arrivalS"],
            stopping["projection"]["trains"][0]["calls"][1]["timeS"]
        );
    }

    fn evaluate_json(input: &Value) -> Value {
        serde_json::from_str(
            &coordinate_planning_run(&input.to_string()).expect("nativer PlanningRun"),
        )
        .unwrap()
    }

    #[test]
    fn einzelantrag_und_selbe_formation_in_mehreren_absoluten_fahrten_sind_zulaessig() {
        let mut input = single_absolute_input(7 * 86_400 + 28_800, "one", 26802);
        let first = evaluate_json(&input);
        assert_eq!(first["state"]["reservations"].as_object().unwrap().len(), 1);
        assert_eq!(
            first["projection"]["trains"][0]["calls"][0]["timeS"],
            7 * 86_400 + 28_800
        );
        let second =
            single_absolute_input(8 * 86_400 + 28_800, "two", 26804)["requests"][0].clone();
        input["requests"].as_array_mut().unwrap().push(second);
        input["requests"][1]["requestNumericId"] = json!(2);
        let result = evaluate_json(&input);
        assert_eq!(
            result["state"]["reservations"].as_object().unwrap().len(),
            2
        );
        assert!(
            result["projection"]["conflicts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        input["requests"].as_array_mut().unwrap().reverse();
        assert_eq!(evaluate_json(&input)["stateHash"], result["stateHash"]);
    }

    #[test]
    fn spaetere_tagesfahrt_konkurriert_nicht_mit_abgelaufener_einzelfahrt() {
        let initial = evaluate_json(&single_absolute_input(28_800, "reserved", 26802));
        let mut next = single_absolute_input(86_400 + 28_800, "next-day", 26804);
        next["expectedProjectionRevision"] = json!(1);
        next["previousState"] = initial["state"].clone();
        let result = evaluate_json(&next);
        assert_eq!(
            result["state"]["reservations"].as_object().unwrap().len(),
            2
        );
        assert!(
            result["projection"]["conflicts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn bestehende_exakte_reservierung_blockiert_neuen_antrag_ohne_ihre_belegung_zu_verlieren() {
        let initial = evaluate_json(&single_absolute_input(28_800, "reserved", 26802));
        let mut next = single_absolute_input(28_800, "competitor", 26804);
        next["expectedProjectionRevision"] = json!(1);
        next["previousState"] = initial["state"].clone();
        let result = evaluate_json(&next);
        assert_eq!(
            result["state"]["reservations"],
            initial["state"]["reservations"]
        );
        assert!(
            !result["projection"]["conflicts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            result["state"]["alternatives"]
                .as_object()
                .unwrap()
                .is_empty(),
            "alternative außerhalb des einsekündigen Fensters ist unzulässig"
        );
        let kept: Vec<_> = result["projection"]["occupations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|occupation| occupation["trainId"] == "reserved")
            .cloned()
            .collect();
        assert_eq!(json!(kept), initial["projection"]["occupations"]);
        assert_eq!(
            evaluate_json(&next)["stateHash"],
            result["stateHash"],
            "Restore wiederholt bitgleich"
        );
    }

    #[test]
    fn baseline_welt_revision_infrastruktur_und_zeitfenster_werden_fail_closed_geprueft() {
        let initial = evaluate_json(&single_absolute_input(28_800, "reserved", 26802));
        let mut next = single_absolute_input(32_400, "next", 26804);
        next["expectedProjectionRevision"] = json!(1);
        next["previousState"] = initial["state"].clone();
        for (field, value) in [
            ("worldId", json!("foreign")),
            ("projectionRevision", json!(2)),
            ("infrastructureHash", json!("incorrect")),
        ] {
            let mut broken = next.clone();
            broken["previousState"][field] = value;
            assert!(coordinate_planning_run(&broken.to_string()).is_err());
        }
        let mut broken = next.clone();
        broken["requests"][0]["serviceWindow"]["validUntilS"] = json!(32_400);
        assert!(coordinate_planning_run(&broken.to_string()).is_err());
        next["segments"][0]["maximumSpeedKph"] = json!(90);
        assert!(coordinate_planning_run(&next.to_string()).is_err());
    }

    #[test]
    fn nur_zukuenftige_bestehende_einzelfahrten_duerfen_ersetzt_werden() {
        let initial = evaluate_json(&single_absolute_input(28_800, "old", 26802));
        let mut next = single_absolute_input(28_800, "replacement", 26804);
        next["expectedProjectionRevision"] = json!(1);
        next["previousState"] = initial["state"].clone();
        next["replaceTrainIds"] = json!(["old"]);
        next["effectiveFromS"] = json!(600);
        let result = evaluate_json(&next);
        assert_eq!(
            result["state"]["reservations"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["replacement".to_owned()]
        );
        assert_eq!(result["projection"]["trains"].as_array().unwrap().len(), 1);
        assert!(
            result["projection"]["conflicts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let mut started = next.clone();
        started["effectiveFromS"] = json!(28_800);
        assert!(coordinate_planning_run(&started.to_string()).is_err());
        let mut unknown = next.clone();
        unknown["replaceTrainIds"] = json!(["foreign"]);
        assert!(coordinate_planning_run(&unknown.to_string()).is_err());
        let mut foreign = next;
        foreign["previousState"]["worldId"] = json!("other-world");
        assert!(coordinate_planning_run(&foreign.to_string()).is_err());
    }

    #[test]
    fn angenommene_alternative_bleibt_nach_restore_eine_exakte_reservierung() {
        let initial = evaluate_json(&coordinate_input_v2());
        let conflict = initial["projection"]["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|conflict| conflict["alternative"].is_object())
            .unwrap();
        let alternative = &conflict["alternative"];
        let command = json!({"schemaVersion": "planning-apply-alternative/v1", "projectionRevision": 1, "alternativeId": alternative["alternativeId"], "conflictId": conflict["id"], "trainId": alternative["trainId"], "departureShiftS": alternative["departureShiftS"]});
        let applied: Value = serde_json::from_str(
            &apply_planning_alternative(
                &initial["state"].to_string(),
                "accept-for-baseline",
                &command.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            applied["state"]["reservations"].as_object().unwrap().len(),
            2
        );
        let departure = applied["projection"]["trains"]
            .as_array()
            .unwrap()
            .iter()
            .find(|train| train["id"] == alternative["trainId"])
            .unwrap()["calls"][0]["timeS"]
            .as_i64()
            .unwrap();
        let mut next = single_absolute_input(departure, "new-competitor", 26806);
        next["previousState"] = applied["state"].clone();
        next["expectedProjectionRevision"] = json!(2);
        let result = evaluate_json(&next);
        assert_eq!(
            result["state"]["reservations"],
            applied["state"]["reservations"]
        );
        assert!(
            !result["projection"]["conflicts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn abgelehnte_linienaenderung_liefert_keinen_zustand_mit_geloeschten_altfahrten() {
        let initial = evaluate_json(&single_absolute_input(28_800, "old", 26802));
        let mut replacement = single_absolute_input(28_800, "replacement-one", 26804);
        let mut conflicting = replacement["requests"][0].clone();
        conflicting["trainId"] = json!("replacement-two");
        conflicting["trainNumber"] = json!(26806);
        conflicting["requestNumericId"] = json!(2);
        replacement["requests"]
            .as_array_mut()
            .unwrap()
            .push(conflicting);
        replacement["previousState"] = initial["state"].clone();
        replacement["expectedProjectionRevision"] = json!(1);
        replacement["replaceTrainIds"] = json!(["old"]);
        replacement["effectiveFromS"] = json!(600);
        assert!(
            coordinate_planning_run(&replacement.to_string())
                .unwrap_err()
                .to_string()
                .starts_with("replacement_conflict:")
        );
    }

    #[test]
    fn batchgrenze_nimmt_256_fahrten_an_und_weist_die_257te_ab() {
        let mut input = single_absolute_input(28_800, "batch-0", 26802);
        let template = input["requests"][0].clone();
        input["requests"] = json!(
            (0..256)
                .map(|index| {
                    let mut request = template.clone();
                    let departure = 28_800 + index * 3_600;
                    request["trainId"] = json!(format!("batch-{index}"));
                    request["requestNumericId"] = json!(index + 1);
                    request["trainNumber"] = json!(26_802 + index * 2);
                    request["desiredDepartureS"] = json!(departure);
                    request["serviceWindow"] =
                        json!({"validFromS":departure,"validUntilS":departure+1});
                    request
                })
                .collect::<Vec<_>>()
        );
        assert_eq!(
            evaluate_json(&input)["state"]["reservations"]
                .as_object()
                .unwrap()
                .len(),
            256
        );
        input["requests"].as_array_mut().unwrap().push(template);
        assert!(coordinate_planning_run(&input.to_string()).is_err());
    }

    #[test]
    fn echter_planning_run_projiziert_konflikt_sechs_phasen_und_stabiles_angebot() {
        let result = coordinate_value(false);
        assert_eq!(
            result["projection"]["schemaVersion"],
            "planning-projection/v1"
        );
        assert_eq!(result["projection"]["projectionRevision"], 1);
        let occupations = result["projection"]["occupations"]
            .as_array()
            .expect("Sperrzeiten");
        let phases = occupations
            .iter()
            .map(|entry| entry["phase"].as_str().expect("Phase"))
            .collect::<BTreeSet<_>>();
        assert_eq!(
            phases,
            BTreeSet::from([
                "route-setting",
                "signal-sighting",
                "approach",
                "running",
                "clearing",
                "route-release",
            ])
        );
        let conflicts = result["projection"]["conflicts"]
            .as_array()
            .expect("Konflikte");
        assert!(!conflicts.is_empty(), "der echte Gegenfahrtkonflikt fehlt");
        assert!(
            conflicts
                .iter()
                .any(|conflict| conflict["kind"] == "opposing-move")
        );
        assert!(
            conflicts
                .iter()
                .any(|conflict| conflict["alternative"].is_object())
        );

        let reordered = coordinate_value(true);
        assert_eq!(result["stateHash"], reordered["stateHash"]);
        assert_eq!(result["projection"], reordered["projection"]);
    }

    #[test]
    fn rust_wendet_nur_das_echte_angebot_an_und_replay_bleibt_hashgleich() {
        let initial = coordinate_value(false);
        let conflict = initial["projection"]["conflicts"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["alternative"].is_object()))
            .expect("Konflikt mit Angebot");
        let alternative = &conflict["alternative"];
        let command = json!({
            "schemaVersion": "planning-apply-alternative/v1",
            "projectionRevision": 1,
            "alternativeId": alternative["alternativeId"],
            "conflictId": conflict["id"],
            "trainId": alternative["trainId"],
            "departureShiftS": alternative["departureShiftS"]
        });
        let applied: Value = serde_json::from_str(
            &apply_planning_alternative(
                &initial["state"].to_string(),
                "command-1",
                &command.to_string(),
            )
            .expect("Rust wendet Angebot an"),
        )
        .expect("gueltiges Ergebnis");
        assert_eq!(applied["projection"]["projectionRevision"], 2);
        assert_eq!(applied["projection"]["conflicts"], json!([]));
        assert_eq!(applied["idempotentReplay"], false);

        let replay: Value = serde_json::from_str(
            &apply_planning_alternative(
                &applied["state"].to_string(),
                "command-1",
                &command.to_string(),
            )
            .expect("Replay gelingt"),
        )
        .expect("gueltiger Replay");
        assert_eq!(replay["idempotentReplay"], true);
        assert_eq!(replay["stateHash"], applied["stateHash"]);
        assert_eq!(replay["projection"], applied["projection"]);

        let forged = json!({
            "schemaVersion": "planning-apply-alternative/v1",
            "projectionRevision": 1,
            "alternativeId": alternative["alternativeId"],
            "conflictId": conflict["id"],
            "trainId": alternative["trainId"],
            "departureShiftS": 1
        });
        let error = apply_planning_alternative(
            &initial["state"].to_string(),
            "forged",
            &forged.to_string(),
        )
        .expect_err("manipulierte Verschiebung muss scheitern");
        assert!(error.to_string().starts_with("alternative_mismatch:"));
    }
}
