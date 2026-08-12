//! Persistierbare, versionierte Befehlsgrenze vor dem regionalen M4-Single-Writer.
//!
//! Der Zustand enthält ausschließlich Initialdaten und das kanonische
//! Kommandolog. Jeder Aufruf rekonstruiert daraus [`zugfolge_sim::Simulation`]
//! und [`zugfolge_sim::DeltaPublisher`]. Damit gibt es weder native Handles
//! noch einen Prozesszustand, der bei einem Neustart verloren gehen kann.
#![allow(
    missing_docs,
    reason = "die versionierten JSON-Felder werden durch Vertragstests beschrieben"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zugfolge_disruption::{CauseType, delay_cause_code, fine_cause_code};
use zugfolge_sim::{
    Command, ConservativeDispatcher, DeltaPublisher, DispatchDecision, DispatchTrigger,
    DisruptionApplication, DomainEvent, EventKind, ExternalLegContract, ExternalOperatingStatus,
    ExternalZone, LiveDelta, LiveSnapshot, MaterializationWindow, OperatingStatus,
    PublicExternalTrain, PublicTrain, SimError, Simulation, TrainCategory, TrainRun, Waypoint,
};

pub const INITIALIZE_SCHEMA: &str = "zugfolge-regional-simulation-initialize/v1";
pub const COMMAND_SCHEMA: &str = "zugfolge-regional-simulation-command/v1";
pub const STATE_SCHEMA: &str = "zugfolge-regional-simulation-state/v1";
pub const INITIALIZED_SCHEMA: &str = "zugfolge-regional-simulation-initialized/v1";
pub const RESTORED_SCHEMA: &str = "zugfolge-regional-simulation-restored/v1";
pub const RESULT_SCHEMA: &str = "zugfolge-regional-simulation-result/v1";
pub const LIVEMAP_SNAPSHOT_SCHEMA: &str = "zugfolge-regional-livemap-snapshot/v1";
pub const LIVEMAP_DELTA_SCHEMA: &str = "zugfolge-regional-livemap-delta/v1";

const INTERNAL_WORLD_ID: u64 = 1;
const INTERNAL_REGION_ID: u32 = 1;
const EXTERNAL_ZONE_REGION_ID: u32 = u32::MAX;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeError {
    code: &'static str,
    detail: String,
}

impl RuntimeError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl Error for RuntimeError {}

impl From<SimError> for RuntimeError {
    fn from(error: SimError) -> Self {
        Self::new("simulation_rejected", error.to_string())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Initialization {
    schema_version: String,
    world_id: String,
    region_id: String,
    materialization_window_hours: u8,
    now_s: i64,
    trains: Vec<TrainInput>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrainInput {
    train_run_id: String,
    operator: String,
    train_number: String,
    category: WireTrainCategory,
    route: Vec<WaypointInput>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WaypointInput {
    operating_point: String,
    position_mm: i64,
    arrival_s: i64,
    minimum_dwell_seconds: u32,
    departure_s: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum WireTrainCategory {
    Regional,
    LongDistance,
    Freight,
    EmptyStock,
    Engineering,
}

impl From<WireTrainCategory> for TrainCategory {
    fn from(category: WireTrainCategory) -> Self {
        match category {
            WireTrainCategory::Regional => Self::Regional,
            WireTrainCategory::LongDistance => Self::LongDistance,
            WireTrainCategory::Freight => Self::Freight,
            WireTrainCategory::EmptyStock => Self::EmptyStock,
            WireTrainCategory::Engineering => Self::Engineering,
        }
    }
}

impl From<&TrainCategory> for WireTrainCategory {
    fn from(category: &TrainCategory) -> Self {
        match category {
            TrainCategory::Regional => Self::Regional,
            TrainCategory::LongDistance => Self::LongDistance,
            TrainCategory::Freight => Self::Freight,
            TrainCategory::EmptyStock => Self::EmptyStock,
            TrainCategory::Engineering => Self::Engineering,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandEnvelope {
    schema_version: String,
    world_id: String,
    region_id: String,
    command_id: String,
    expected_state_hash: String,
    expected_revision: u64,
    expected_publisher_sequence: u64,
    command: WireCommand,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum WireCommand {
    Materialize {
        train: TrainInput,
    },
    AdvanceTo {
        #[serde(rename = "atS")]
        at_s: i64,
    },
    AddDelay {
        train_run_id: String,
        seconds: u32,
    },
    DematerializeBefore {
        #[serde(rename = "beforeS")]
        before_s: i64,
    },
    RegisterDisruption {
        disruption: WireDisruption,
    },
    ActivateDisruption {
        #[serde(rename = "disruptionId")]
        disruption_id: String,
        #[serde(rename = "affectedTrainRunIds")]
        affected_train_run_ids: Vec<String>,
        #[serde(rename = "delaySeconds")]
        delay_seconds: u32,
    },
    ClearDisruption {
        #[serde(rename = "disruptionId")]
        disruption_id: String,
    },
    EnterExternalZone {
        #[serde(rename = "trainRunId")]
        train_run_id: String,
        #[serde(rename = "externalLeg")]
        external_leg: WireExternalLeg,
    },
    ReenterFromExternal {
        #[serde(rename = "trainRunId")]
        train_run_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireExternalLeg {
    journey_chain_id: String,
    external_leg_id: String,
    from_portal_id: String,
    to_portal_id: Option<String>,
    scheduled_start_s: i64,
    scheduled_end_s: i64,
    reentry_earliest_s: Option<i64>,
    reentry_latest_s: Option<i64>,
    fixed_cost_cents: String,
    bound_vehicle_ids: Vec<String>,
    bound_personnel_duty_ids: Vec<String>,
    reentry_route: Vec<WaypointInput>,
    first_resources: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum WireDisruptionKind {
    Planned,
    Unplanned,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireDisruption {
    disruption_id: String,
    kind: WireDisruptionKind,
    published_at_s: i64,
    starts_at_s: i64,
    valid_until_s: i64,
    position_mm: i64,
    cause_code: u8,
    fine_cause_id: String,
    effect: String,
    affected_resource: String,
    affected_train_run_ids: Vec<String>,
    delay_seconds: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCommand {
    command_id: String,
    command_hash: String,
    command: WireCommand,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeState {
    schema_version: String,
    world_id: String,
    region_id: String,
    materialization_window_hours: u8,
    initial_now_s: i64,
    now_s: i64,
    initial_trains: Vec<TrainInput>,
    revision: u64,
    publisher_sequence: u64,
    commands: Vec<StoredCommand>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WirePublicTrain {
    id: String,
    operator: String,
    train_number: String,
    category: WireTrainCategory,
    position_mm: i64,
    speed_mm_per_second: u32,
    delay_seconds: i64,
    next_operating_point: String,
    status: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireSnapshot {
    schema_version: &'static str,
    world_id: String,
    region_id: String,
    producer_sequence: u64,
    at_s: i64,
    trains: Vec<WirePublicTrain>,
    external_trains: Vec<WirePublicExternalTrain>,
    disruptions: Vec<WirePublicDisruption>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireDelta {
    schema_version: &'static str,
    world_id: String,
    region_id: String,
    producer_sequence: u64,
    at_s: i64,
    changed: Vec<WirePublicTrain>,
    removed: Vec<String>,
    changed_external_trains: Vec<WirePublicExternalTrain>,
    removed_external_train_ids: Vec<String>,
    changed_disruptions: Vec<WirePublicDisruption>,
    removed_disruption_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WirePublicExternalTrain {
    id: String,
    operator: String,
    train_number: String,
    category: WireTrainCategory,
    journey_chain_id: String,
    external_leg_id: String,
    from_portal_id: String,
    to_portal_id: Option<String>,
    scheduled_end_s: i64,
    reentry_earliest_s: Option<i64>,
    reentry_latest_s: Option<i64>,
    delay_seconds: i64,
    fixed_cost_cents: String,
    bound_vehicle_ids: Vec<String>,
    bound_personnel_duty_ids: Vec<String>,
    status: &'static str,
    progress_basis_points: u16,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WirePublicDisruption {
    schema_version: &'static str,
    disruption_id: String,
    kind: WireDisruptionKind,
    published_at_s: i64,
    starts_at_s: i64,
    valid_until_s: i64,
    position_mm: i64,
    cause_code: u8,
    cause_label: String,
    fine_cause_id: String,
    fine_cause_label: String,
    effect: String,
    affected_resource: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireEvent {
    event_id: String,
    world_id: String,
    region_id: String,
    simulation_sequence: u64,
    event_type: &'static str,
    at_s: i64,
    payload: Value,
}

struct Machine {
    simulation: Simulation<ConservativeDispatcher>,
    publisher: DeltaPublisher,
    internal_by_external: BTreeMap<String, u64>,
    external_by_internal: BTreeMap<u64, String>,
    next_internal_id: u64,
    disruptions: BTreeMap<String, WirePublicDisruption>,
    activated_disruptions: BTreeSet<String>,
    pending_disruption_effects: BTreeMap<String, (Vec<String>, u32)>,
    external_zone: ExternalZone,
}

struct Applied {
    events: Vec<WireEvent>,
    delta: WireDelta,
}

fn decode<T: for<'de> Deserialize<'de>>(json: &str, name: &str) -> Result<T, RuntimeError> {
    serde_json::from_str(json)
        .map_err(|error| RuntimeError::new("invalid_json", format!("{name}: {error}")))
}

fn encode<T: Serialize>(value: &T, name: &str) -> Result<String, RuntimeError> {
    serde_json::to_string(value)
        .map_err(|error| RuntimeError::new("serialization_failed", format!("{name}: {error}")))
}

fn validate_identity(value: &str, name: &str) -> Result<(), RuntimeError> {
    if value.is_empty() || value.len() > 200 {
        return Err(RuntimeError::new(
            "invalid_identity",
            format!("{name} muss 1 bis 200 Zeichen besitzen"),
        ));
    }
    Ok(())
}

fn public_disruption(input: &WireDisruption) -> Result<WirePublicDisruption, RuntimeError> {
    validate_identity(&input.disruption_id, "disruptionId")?;
    validate_identity(&input.affected_resource, "affectedResource")?;
    if input.published_at_s < 0
        || input.starts_at_s < 0
        || input.valid_until_s <= input.starts_at_s
        || input.published_at_s > input.starts_at_s
        || input.position_mm < 0
        || !matches!(
            input.effect.as_str(),
            "closure"
                | "single-track"
                | "speed-restriction"
                | "platform-change"
                | "traffic-hold"
                | "route-deviation"
                | "vehicle-restriction"
                | "platform-usable-length"
        )
    {
        return Err(RuntimeError::new(
            "invalid_disruption",
            "Störungszeit, Position oder Wirkung ist ungültig",
        ));
    }
    let cause = delay_cause_code(input.cause_code)
        .filter(|entry| {
            matches!(
                entry.cause_type,
                CauseType::Primary | CauseType::DangerousEvent
            )
        })
        .ok_or_else(|| RuntimeError::new("invalid_cause_code", input.cause_code.to_string()))?;
    let fine = fine_cause_code(&input.fine_cause_id, input.cause_code)
        .ok_or_else(|| RuntimeError::new("invalid_fine_cause_code", input.fine_cause_id.clone()))?;
    let mut train_run_ids = BTreeSet::new();
    for train_run_id in &input.affected_train_run_ids {
        validate_identity(train_run_id, "affectedTrainRunId")?;
        if !train_run_ids.insert(train_run_id) {
            return Err(RuntimeError::new(
                "invalid_disruption",
                "betroffener Zuglauf ist doppelt",
            ));
        }
    }
    Ok(WirePublicDisruption {
        schema_version: "zugfolge-livemap-disruption/v1",
        disruption_id: input.disruption_id.clone(),
        kind: input.kind,
        published_at_s: input.published_at_s,
        starts_at_s: input.starts_at_s,
        valid_until_s: input.valid_until_s,
        position_mm: input.position_mm,
        cause_code: cause.code,
        cause_label: cause.label.into(),
        fine_cause_id: fine.id.into(),
        fine_cause_label: fine.label.into(),
        effect: input.effect.clone(),
        affected_resource: input.affected_resource.clone(),
    })
}

fn validate_train(train: &TrainInput) -> Result<(), RuntimeError> {
    validate_identity(&train.train_run_id, "trainRunId")?;
    validate_identity(&train.operator, "operator")?;
    validate_identity(&train.train_number, "trainNumber")?;
    if train.route.is_empty() {
        return Err(RuntimeError::new(
            "invalid_train",
            "route darf nicht leer sein",
        ));
    }
    for waypoint in &train.route {
        validate_identity(&waypoint.operating_point, "operatingPoint")?;
        if waypoint.position_mm < 0 || waypoint.arrival_s < 0 || waypoint.departure_s < 0 {
            return Err(RuntimeError::new(
                "invalid_train",
                "Positionen und Fahrplanzeiten duerfen nicht negativ sein",
            ));
        }
    }
    Ok(())
}

fn external_leg_contract(
    machine: &Machine,
    train_run_id: &str,
    input: &WireExternalLeg,
) -> Result<ExternalLegContract, RuntimeError> {
    validate_identity(&input.journey_chain_id, "journeyChainId")?;
    validate_identity(&input.external_leg_id, "externalLegId")?;
    validate_identity(&input.from_portal_id, "fromPortalId")?;
    if let Some(to_portal_id) = &input.to_portal_id {
        validate_identity(to_portal_id, "toPortalId")?;
    }
    for vehicle_id in &input.bound_vehicle_ids {
        validate_identity(vehicle_id, "boundVehicleId")?;
    }
    for duty_id in &input.bound_personnel_duty_ids {
        validate_identity(duty_id, "boundPersonnelDutyId")?;
    }
    for resource in &input.first_resources {
        validate_identity(resource, "firstResource")?;
    }
    let fixed_cost_cents = input.fixed_cost_cents.parse::<i64>().map_err(|_| {
        RuntimeError::new(
            "invalid_external_leg",
            "fixedCostCents ist keine i64-Dezimalzahl",
        )
    })?;
    let internal_id = machine
        .internal_by_external
        .get(train_run_id)
        .copied()
        .ok_or_else(|| RuntimeError::new("unknown_train", train_run_id.to_owned()))?;
    let reentry_route = input
        .reentry_route
        .iter()
        .map(|point| Waypoint {
            operating_point: point.operating_point.clone(),
            position_mm: point.position_mm,
            arrival: point.arrival_s,
            minimum_dwell_seconds: point.minimum_dwell_seconds,
            departure: point.departure_s,
        })
        .collect::<Vec<_>>();
    if !reentry_route.is_empty() {
        let probe = TrainInput {
            train_run_id: train_run_id.to_owned(),
            operator: "external-zone".into(),
            train_number: internal_id.to_string(),
            category: WireTrainCategory::Regional,
            route: input.reentry_route.clone(),
        };
        validate_train(&probe)?;
    }
    Ok(ExternalLegContract {
        world_id: INTERNAL_WORLD_ID,
        journey_chain_id: input.journey_chain_id.clone(),
        external_leg_id: input.external_leg_id.clone(),
        source_region: INTERNAL_REGION_ID,
        target_region: (!reentry_route.is_empty()).then_some(INTERNAL_REGION_ID),
        from_portal: input.from_portal_id.clone(),
        to_portal: input.to_portal_id.clone(),
        scheduled_start: input.scheduled_start_s,
        scheduled_end: input.scheduled_end_s,
        reentry_earliest: input.reentry_earliest_s,
        reentry_latest: input.reentry_latest_s,
        fixed_cost_cents,
        bound_vehicle_ids: input.bound_vehicle_ids.clone(),
        bound_personnel_duty_ids: input.bound_personnel_duty_ids.clone(),
        reentry_route,
        first_resources: input.first_resources.clone(),
    })
}

fn canonical_hash<T: Serialize>(domain: &str, value: &T) -> Result<String, RuntimeError> {
    let json = encode(value, "kanonischer Zustand")?;
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(json.as_bytes());
    let digest = hasher.finalize();
    let mut output = String::with_capacity(64);
    for byte in digest {
        write!(&mut output, "{byte:02x}")
            .map_err(|error| RuntimeError::new("hash_failed", error.to_string()))?;
    }
    Ok(output)
}

fn state_hash(state: &RuntimeState) -> Result<String, RuntimeError> {
    canonical_hash("zugfolge/regional-simulation-state/v1", state)
}

fn command_hash(envelope: &CommandEnvelope) -> Result<String, RuntimeError> {
    canonical_hash(
        "zugfolge/regional-simulation-command/v1",
        &json!({
            "worldId": envelope.world_id,
            "regionId": envelope.region_id,
            "command": envelope.command,
        }),
    )
}

fn make_train(input: &TrainInput, internal_id: u64) -> TrainRun {
    TrainRun {
        world_id: INTERNAL_WORLD_ID,
        id: internal_id,
        region_id: INTERNAL_REGION_ID,
        operator: input.operator.clone(),
        train_number: input.train_number.clone(),
        category: input.category.into(),
        route: input
            .route
            .iter()
            .map(|point| Waypoint {
                operating_point: point.operating_point.clone(),
                position_mm: point.position_mm,
                arrival: point.arrival_s,
                minimum_dwell_seconds: point.minimum_dwell_seconds,
                departure: point.departure_s,
            })
            .collect(),
        next_waypoint: 0,
        delay_seconds: 0,
        position_mm: 0,
        speed_mm_per_second: 0,
        status: OperatingStatus::Planned,
    }
}

fn allocate_train(machine: &mut Machine, train: &TrainInput) -> Result<u64, RuntimeError> {
    validate_train(train)?;
    if machine
        .internal_by_external
        .contains_key(&train.train_run_id)
    {
        return Err(RuntimeError::new(
            "duplicate_train",
            format!("Zuglauf '{}' existiert bereits", train.train_run_id),
        ));
    }
    let internal_id = machine.next_internal_id;
    machine.next_internal_id = machine
        .next_internal_id
        .checked_add(1)
        .ok_or_else(|| RuntimeError::new("identity_exhausted", "interne Zugkennung erschoepft"))?;
    machine
        .internal_by_external
        .insert(train.train_run_id.clone(), internal_id);
    machine
        .external_by_internal
        .insert(internal_id, train.train_run_id.clone());
    Ok(internal_id)
}

fn external_train_id(machine: &Machine, internal_id: u64) -> Result<String, RuntimeError> {
    machine
        .external_by_internal
        .get(&internal_id)
        .cloned()
        .ok_or_else(|| RuntimeError::new("unknown_internal_train", internal_id.to_string()))
}

fn affected_operators(machine: &Machine, internal_ids: &[u64]) -> Vec<String> {
    let selected = internal_ids.iter().copied().collect::<BTreeSet<_>>();
    machine
        .simulation
        .snapshot()
        .trains
        .into_iter()
        .filter(|train| selected.contains(&train.id))
        .map(|train| train.operator)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn apply_registered_disruption(
    machine: &mut Machine,
    disruption_id: &str,
    affected_train_run_ids: &[String],
    delay_seconds: u32,
) -> Result<Vec<DomainEvent>, RuntimeError> {
    validate_identity(disruption_id, "disruptionId")?;
    if affected_train_run_ids.is_empty() {
        return Err(RuntimeError::new(
            "invalid_disruption",
            "mindestens ein betroffener Zuglauf ist erforderlich",
        ));
    }
    if machine.activated_disruptions.contains(disruption_id) {
        return Err(RuntimeError::new(
            "disruption_already_activated",
            disruption_id.to_owned(),
        ));
    }
    let marker = machine
        .disruptions
        .get(disruption_id)
        .cloned()
        .ok_or_else(|| RuntimeError::new("unknown_disruption", disruption_id.to_owned()))?;
    let now = machine.simulation.snapshot().at;
    if now < marker.starts_at_s || now >= marker.valid_until_s {
        return Err(RuntimeError::new(
            "disruption_not_active",
            "Störung liegt außerhalb ihres Wirkungszeitraums",
        ));
    }
    let mut external_ids = BTreeSet::new();
    let mut internal_ids = Vec::with_capacity(affected_train_run_ids.len());
    for train_run_id in affected_train_run_ids {
        validate_identity(train_run_id, "affectedTrainRunId")?;
        if !external_ids.insert(train_run_id) {
            return Err(RuntimeError::new(
                "invalid_disruption",
                "betroffener Zuglauf ist doppelt",
            ));
        }
        internal_ids.push(
            machine
                .internal_by_external
                .get(train_run_id)
                .copied()
                .ok_or_else(|| RuntimeError::new("unknown_train", train_run_id.clone()))?,
        );
    }
    let events = machine
        .simulation
        .apply(Command::ApplyDisruption(DisruptionApplication {
            disruption_id: marker.disruption_id.clone(),
            affected_train_run_ids: internal_ids,
            delay_seconds,
            cause_code: marker.cause_code,
            fine_cause_id: marker.fine_cause_id.clone(),
            affected_resource: marker.affected_resource.clone(),
            effect: marker.effect.clone(),
            planned: matches!(marker.kind, WireDisruptionKind::Planned),
        }))?;
    machine
        .activated_disruptions
        .insert(disruption_id.to_owned());
    machine.pending_disruption_effects.remove(disruption_id);
    Ok(events)
}

fn advance_with_pending_disruptions(
    machine: &mut Machine,
    target: i64,
) -> Result<Vec<DomainEvent>, RuntimeError> {
    let initial_now = machine.simulation.snapshot().at;
    if target < initial_now {
        return Ok(machine.simulation.apply(Command::AdvanceTo(target))?);
    }
    let mut due = machine
        .pending_disruption_effects
        .keys()
        .filter_map(|disruption_id| {
            machine
                .disruptions
                .get(disruption_id)
                .filter(|marker| marker.starts_at_s >= initial_now && marker.starts_at_s <= target)
                .map(|marker| (marker.starts_at_s, disruption_id.clone()))
        })
        .collect::<Vec<_>>();
    due.sort();
    let mut events = Vec::new();
    for (starts_at_s, disruption_id) in due {
        if machine.simulation.snapshot().at < starts_at_s {
            events.extend(machine.simulation.apply(Command::AdvanceTo(starts_at_s))?);
        }
        let Some((affected_train_run_ids, delay_seconds)) = machine
            .pending_disruption_effects
            .get(&disruption_id)
            .cloned()
        else {
            continue;
        };
        events.extend(apply_registered_disruption(
            machine,
            &disruption_id,
            &affected_train_run_ids,
            delay_seconds,
        )?);
    }
    if machine.simulation.snapshot().at < target || target == initial_now {
        events.extend(machine.simulation.apply(Command::AdvanceTo(target))?);
    }
    Ok(events)
}

fn wire_train(machine: &Machine, train: PublicTrain) -> Result<WirePublicTrain, RuntimeError> {
    Ok(WirePublicTrain {
        id: external_train_id(machine, train.id)?,
        operator: train.operator,
        train_number: train.train_number,
        category: WireTrainCategory::from(&train.category),
        position_mm: train.position_mm,
        speed_mm_per_second: train.speed_mm_per_second,
        delay_seconds: train.delay_seconds,
        next_operating_point: train.next_operating_point,
        status: match train.status {
            OperatingStatus::Planned => "planned",
            OperatingStatus::Running => "running",
            OperatingStatus::Waiting => "waiting",
            OperatingStatus::AtPlatform => "at_platform",
            OperatingStatus::Completed => "completed",
            OperatingStatus::Cancelled => "cancelled",
        },
    })
}

fn wire_external_train(
    machine: &Machine,
    train: PublicExternalTrain,
) -> Result<WirePublicExternalTrain, RuntimeError> {
    Ok(WirePublicExternalTrain {
        id: external_train_id(machine, train.id)?,
        operator: train.operator,
        train_number: train.train_number,
        category: WireTrainCategory::from(&train.category),
        journey_chain_id: train.journey_chain_id,
        external_leg_id: train.external_leg_id,
        from_portal_id: train.from_portal,
        to_portal_id: train.to_portal,
        scheduled_end_s: train.scheduled_end,
        reentry_earliest_s: train.reentry_earliest,
        reentry_latest_s: train.reentry_latest,
        delay_seconds: train.delay_seconds,
        fixed_cost_cents: train.fixed_cost_cents.to_string(),
        bound_vehicle_ids: train.bound_vehicle_ids,
        bound_personnel_duty_ids: train.bound_personnel_duty_ids,
        status: match train.status {
            ExternalOperatingStatus::Outside => "outside",
            ExternalOperatingStatus::ReadyAtBoundary => "ready-at-boundary",
            ExternalOperatingStatus::WaitingForCapacity => "waiting-for-capacity",
            ExternalOperatingStatus::CompletedOutside => "completed-outside",
        },
        progress_basis_points: train.progress_basis_points,
    })
}

fn wire_snapshot(
    state: &RuntimeState,
    machine: &Machine,
    snapshot: LiveSnapshot,
    producer_sequence: u64,
) -> Result<WireSnapshot, RuntimeError> {
    let trains = snapshot
        .trains
        .into_iter()
        .map(|train| wire_train(machine, train))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WireSnapshot {
        schema_version: LIVEMAP_SNAPSHOT_SCHEMA,
        world_id: state.world_id.clone(),
        region_id: state.region_id.clone(),
        producer_sequence,
        at_s: snapshot.at,
        trains,
        external_trains: machine
            .external_zone
            .snapshot()
            .into_iter()
            .map(|train| wire_external_train(machine, train))
            .collect::<Result<Vec<_>, _>>()?,
        disruptions: machine
            .disruptions
            .values()
            .filter(|item| item.valid_until_s > snapshot.at)
            .cloned()
            .collect(),
    })
}

fn wire_delta(
    state: &RuntimeState,
    machine: &Machine,
    delta: LiveDelta,
    changed_disruptions: Vec<WirePublicDisruption>,
    removed_disruption_ids: Vec<String>,
    previous_external_trains: &[PublicExternalTrain],
) -> Result<WireDelta, RuntimeError> {
    let changed = delta
        .changed
        .into_iter()
        .map(|train| wire_train(machine, train))
        .collect::<Result<Vec<_>, _>>()?;
    let removed = delta
        .removed
        .into_iter()
        .map(|id| external_train_id(machine, id))
        .collect::<Result<Vec<_>, _>>()?;
    let current_external = machine.external_zone.snapshot();
    let previous_by_id = previous_external_trains
        .iter()
        .map(|train| (train.id, train))
        .collect::<BTreeMap<_, _>>();
    let current_by_id = current_external
        .iter()
        .map(|train| (train.id, train))
        .collect::<BTreeMap<_, _>>();
    let changed_external_trains = current_external
        .iter()
        .filter(|train| previous_by_id.get(&train.id).copied() != Some(train))
        .cloned()
        .map(|train| wire_external_train(machine, train))
        .collect::<Result<Vec<_>, _>>()?;
    let removed_external_train_ids = previous_by_id
        .keys()
        .filter(|id| !current_by_id.contains_key(id))
        .map(|id| external_train_id(machine, *id))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WireDelta {
        schema_version: LIVEMAP_DELTA_SCHEMA,
        world_id: state.world_id.clone(),
        region_id: state.region_id.clone(),
        producer_sequence: delta.sequence,
        at_s: delta.at,
        changed,
        removed,
        changed_external_trains,
        removed_external_train_ids,
        changed_disruptions,
        removed_disruption_ids,
    })
}

fn event_payload(
    machine: &Machine,
    kind: &EventKind,
) -> Result<(&'static str, Value), RuntimeError> {
    let result = match kind {
        EventKind::Materialized { train_run_id } => (
            "simulation.train-materialized",
            json!({ "trainRunId": external_train_id(machine, *train_run_id)? }),
        ),
        EventKind::Arrived {
            train_run_id,
            operating_point,
        } => (
            "simulation.train-arrived",
            json!({ "trainRunId": external_train_id(machine, *train_run_id)?, "operatingPoint": operating_point }),
        ),
        EventKind::Departed {
            train_run_id,
            operating_point,
        } => (
            "simulation.train-departed",
            json!({ "trainRunId": external_train_id(machine, *train_run_id)?, "operatingPoint": operating_point }),
        ),
        EventKind::DelayChanged {
            train_run_id,
            delay_seconds,
        } => (
            "simulation.delay-changed",
            json!({ "trainRunId": external_train_id(machine, *train_run_id)?, "delaySeconds": delay_seconds }),
        ),
        EventKind::HandoverRequested {
            train_run_id,
            token,
            target_region,
        } => (
            "simulation.handover-requested",
            json!({ "trainRunId": external_train_id(machine, *train_run_id)?, "token": token, "targetRegion": target_region }),
        ),
        EventKind::HandoverCompleted {
            train_run_id,
            token,
            target_region,
        } => (
            "simulation.handover-completed",
            json!({ "trainRunId": external_train_id(machine, *train_run_id)?, "token": token, "targetRegion": target_region }),
        ),
        EventKind::Completed { train_run_id } => (
            "simulation.train-completed",
            json!({ "trainRunId": external_train_id(machine, *train_run_id)? }),
        ),
        EventKind::DispatchApplied {
            train_run_id,
            decision_id,
            trigger,
            decision,
        } => (
            "simulation.dispatch-applied",
            json!({
                "trainRunId": external_train_id(machine, *train_run_id)?,
                "decisionId": decision_id,
                "trigger": dispatch_trigger_name(*trigger),
                "decision": dispatch_decision_name(*decision),
            }),
        ),
        EventKind::DisruptionApplied {
            disruption_id,
            affected_train_run_ids,
            delay_seconds,
            cause_code,
            fine_cause_id,
            affected_resource,
            effect,
            planned,
        } => (
            "disruption.applied",
            json!({
                "disruptionId": disruption_id,
                "kind": if *planned { "planned" } else { "unplanned" },
                "operatorIds": affected_operators(machine, affected_train_run_ids),
                "affectedTrainRunIds": affected_train_run_ids
                    .iter()
                    .map(|train_run_id| external_train_id(machine, *train_run_id))
                    .collect::<Result<Vec<_>, _>>()?,
                "delaySeconds": delay_seconds,
                "causeCode": cause_code,
                "causeLabel": delay_cause_code(*cause_code).map(|cause| cause.label).unwrap_or("Unbekannte Ursache"),
                "fineCauseId": fine_cause_id,
                "fineCauseLabel": fine_cause_code(fine_cause_id, *cause_code).map(|cause| cause.label).unwrap_or("Unbekannte Einordnung"),
                "affectedResource": affected_resource,
                "effect": effect,
                "action": "apply_disruption",
                "outcomeReason": "Betriebswirksame Einschränkung im regionalen Single-Writer angewendet",
                "impact": {
                    "affected_train_runs": affected_train_run_ids.len(),
                    "affected_resource": affected_resource,
                    "infrastructure_effect": effect,
                    "cause_code": cause_code,
                    "fine_cause_id": fine_cause_id,
                },
            }),
        ),
    };
    Ok(result)
}

fn dispatch_trigger_name(trigger: DispatchTrigger) -> &'static str {
    match trigger {
        DispatchTrigger::Arrival => "arrival",
        DispatchTrigger::Departure => "departure",
        DispatchTrigger::DelayThreshold => "delay-threshold",
        DispatchTrigger::ConnectionRisk => "connection-risk",
        DispatchTrigger::VehicleFailure => "vehicle-failure",
        DispatchTrigger::PersonnelDutyExceeded => "personnel-duty-exceeded",
        DispatchTrigger::RouteClosure => "route-closure",
        DispatchTrigger::PlatformChange => "platform-change",
        DispatchTrigger::TurnaroundShortfall => "turnaround-shortfall",
        DispatchTrigger::AdHocPathConflict => "ad-hoc-path-conflict",
    }
}

fn dispatch_decision_name(decision: DispatchDecision) -> &'static str {
    match decision {
        DispatchDecision::Proceed => "proceed",
        DispatchDecision::HoldUntil(_) => "hold-until",
        DispatchDecision::BreakConnection => "break-connection",
        DispatchDecision::SkipStop => "skip-stop",
        DispatchDecision::ShortTurn => "short-turn",
        DispatchDecision::ShortenTrain => "shorten-train",
        DispatchDecision::StrengthenTrain => "strengthen-train",
        DispatchDecision::Cancel => "cancel",
        DispatchDecision::ActivateReserveRotation => "activate-reserve-rotation",
        DispatchDecision::ProvideReplacementVehicle => "provide-replacement-vehicle",
        DispatchDecision::RequestReroute => "request-reroute",
        DispatchDecision::ReturnPath => "return-path",
        DispatchDecision::TriggerRailReplacement => "trigger-rail-replacement",
    }
}

fn wire_events(
    state: &RuntimeState,
    machine: &Machine,
    events: Vec<DomainEvent>,
) -> Result<Vec<WireEvent>, RuntimeError> {
    events
        .into_iter()
        .map(|event| {
            let (event_type, payload) = event_payload(machine, &event.kind)?;
            Ok(WireEvent {
                event_id: format!(
                    "simulation:{}:{}:{}",
                    state.world_id, state.region_id, event.sequence
                ),
                world_id: state.world_id.clone(),
                region_id: state.region_id.clone(),
                simulation_sequence: event.sequence,
                event_type,
                at_s: event.at,
                payload,
            })
        })
        .collect()
}

fn external_wire_event(
    state: &RuntimeState,
    machine: &Machine,
    train_run_id: &str,
    external_leg_id: &str,
    event_type: &'static str,
    payload: Value,
) -> WireEvent {
    WireEvent {
        event_id: format!(
            "external:{}:{}:{}:{}:{}",
            state.world_id, state.region_id, train_run_id, external_leg_id, event_type
        ),
        world_id: state.world_id.clone(),
        region_id: state.region_id.clone(),
        simulation_sequence: machine.simulation.snapshot().sequence,
        event_type,
        at_s: machine.simulation.snapshot().at,
        payload,
    }
}

fn apply_wire_command(
    state: &RuntimeState,
    machine: &mut Machine,
    command: &WireCommand,
) -> Result<Applied, RuntimeError> {
    let previous_disruption_ids: BTreeSet<String> = machine.disruptions.keys().cloned().collect();
    let previous_external_trains = machine.external_zone.snapshot();
    let mut changed_disruptions = Vec::new();
    let mut additional_events = Vec::new();
    let events = match command {
        WireCommand::Materialize { train } => {
            let internal_id = allocate_train(machine, train)?;
            machine
                .simulation
                .apply(Command::Materialize(make_train(train, internal_id)))?
        }
        WireCommand::AdvanceTo { at_s } => {
            let events = advance_with_pending_disruptions(machine, *at_s)?;
            machine.external_zone.advance_to(*at_s)?;
            events
        }
        WireCommand::AddDelay {
            train_run_id,
            seconds,
        } => {
            let internal_id = machine
                .internal_by_external
                .get(train_run_id)
                .copied()
                .ok_or_else(|| RuntimeError::new("unknown_train", train_run_id.clone()))?;
            machine.simulation.apply(Command::AddDelay {
                train_run_id: internal_id,
                seconds: *seconds,
            })?
        }
        WireCommand::DematerializeBefore { before_s } => {
            machine.simulation.dematerialize_before(*before_s);
            Vec::new()
        }
        WireCommand::RegisterDisruption { disruption } => {
            let marker = public_disruption(disruption)?;
            let now = machine.simulation.snapshot().at;
            if marker.valid_until_s <= now {
                return Err(RuntimeError::new(
                    "invalid_disruption",
                    "bereits abgelaufene Störung kann nicht registriert werden",
                ));
            }
            if machine
                .disruptions
                .insert(marker.disruption_id.clone(), marker.clone())
                .is_some()
            {
                return Err(RuntimeError::new(
                    "duplicate_disruption",
                    marker.disruption_id,
                ));
            }
            changed_disruptions.push(marker);
            if disruption.affected_train_run_ids.is_empty() || now >= disruption.valid_until_s {
                Vec::new()
            } else if now < disruption.starts_at_s {
                machine.pending_disruption_effects.insert(
                    disruption.disruption_id.clone(),
                    (
                        disruption.affected_train_run_ids.clone(),
                        disruption.delay_seconds,
                    ),
                );
                Vec::new()
            } else {
                apply_registered_disruption(
                    machine,
                    &disruption.disruption_id,
                    &disruption.affected_train_run_ids,
                    disruption.delay_seconds,
                )?
            }
        }
        WireCommand::ActivateDisruption {
            disruption_id,
            affected_train_run_ids,
            delay_seconds,
        } => apply_registered_disruption(
            machine,
            disruption_id,
            affected_train_run_ids,
            *delay_seconds,
        )?,
        WireCommand::ClearDisruption { disruption_id } => {
            machine.pending_disruption_effects.remove(disruption_id);
            machine.disruptions.remove(disruption_id);
            Vec::new()
        }
        WireCommand::EnterExternalZone {
            train_run_id,
            external_leg,
        } => {
            let contract = external_leg_contract(machine, train_run_id, external_leg)?;
            let internal_id = machine
                .internal_by_external
                .get(train_run_id)
                .copied()
                .ok_or_else(|| RuntimeError::new("unknown_train", train_run_id.clone()))?;
            let (envelope, requested) = machine
                .simulation
                .prepare_handover(internal_id, EXTERNAL_ZONE_REGION_ID)?;
            let confirmation = machine.external_zone.accept_handover(&envelope, contract)?;
            let mut domain_events = vec![requested];
            domain_events.extend(machine.simulation.apply(confirmation)?);
            additional_events.push(external_wire_event(
                state,
                machine,
                train_run_id,
                &external_leg.external_leg_id,
                "simulation.external-leg-entered",
                json!({
                    "trainRunId": train_run_id,
                    "journeyChainId": external_leg.journey_chain_id,
                    "externalLegId": external_leg.external_leg_id,
                    "fromPortalId": external_leg.from_portal_id,
                    "toPortalId": external_leg.to_portal_id,
                    "scheduledEndS": external_leg.scheduled_end_s,
                    "fixedCostCents": external_leg.fixed_cost_cents,
                    "boundVehicleIds": external_leg.bound_vehicle_ids,
                    "boundPersonnelDutyIds": external_leg.bound_personnel_duty_ids,
                    "outsidePenaltyApplied": false,
                }),
            ));
            domain_events
        }
        WireCommand::ReenterFromExternal { train_run_id } => {
            let internal_id = machine
                .internal_by_external
                .get(train_run_id)
                .copied()
                .ok_or_else(|| RuntimeError::new("unknown_train", train_run_id.clone()))?;
            let external = machine
                .external_zone
                .snapshot()
                .into_iter()
                .find(|train| train.id == internal_id)
                .ok_or_else(|| RuntimeError::new("unknown_external_train", train_run_id.clone()))?;
            let envelope = machine.external_zone.prepare_reentry(internal_id)?;
            machine.simulation.accept_handover(&envelope)?;
            machine
                .external_zone
                .confirm_reentry(internal_id, envelope.token)?;
            additional_events.push(external_wire_event(
                state,
                machine,
                train_run_id,
                &external.external_leg_id,
                "simulation.external-leg-reentered",
                json!({
                    "trainRunId": train_run_id,
                    "journeyChainId": external.journey_chain_id,
                    "externalLegId": external.external_leg_id,
                    "fromPortalId": external.from_portal,
                    "toPortalId": external.to_portal,
                    "delaySeconds": external.delay_seconds,
                    "outsidePenaltyApplied": false,
                }),
            ));
            Vec::new()
        }
    };
    let now = machine.simulation.snapshot().at;
    machine
        .disruptions
        .retain(|_, disruption| disruption.valid_until_s > now);
    let current_disruption_ids: BTreeSet<String> = machine.disruptions.keys().cloned().collect();
    let removed_disruption_ids = previous_disruption_ids
        .difference(&current_disruption_ids)
        .cloned()
        .collect();
    let delta = machine.publisher.publish(&machine.simulation.snapshot())?;
    let mut events = wire_events(state, machine, events)?;
    events.extend(additional_events);
    Ok(Applied {
        events,
        delta: wire_delta(
            state,
            machine,
            delta,
            changed_disruptions,
            removed_disruption_ids,
            &previous_external_trains,
        )?,
    })
}

fn build_machine(
    state: &RuntimeState,
) -> Result<(Machine, Vec<WireEvent>, Vec<Applied>), RuntimeError> {
    if state.schema_version != STATE_SCHEMA {
        return Err(RuntimeError::new(
            "wrong_schema",
            "unbekanntes Zustandsschema",
        ));
    }
    validate_identity(&state.world_id, "worldId")?;
    validate_identity(&state.region_id, "regionId")?;
    if state.revision != u64::try_from(state.commands.len()).unwrap_or(u64::MAX)
        || state.publisher_sequence != state.revision
        || state.publisher_sequence > MAX_JSON_SAFE_INTEGER
        || state.initial_now_s < 0
        || state.now_s < 0
    {
        return Err(RuntimeError::new(
            "corrupt_state",
            "Revision, Publisher-Sequenz und Kommandolog widersprechen sich",
        ));
    }
    let window = MaterializationWindow::new(state.materialization_window_hours)?;
    let simulation = Simulation::new(
        INTERNAL_WORLD_ID,
        INTERNAL_REGION_ID,
        state.initial_now_s,
        window,
        ConservativeDispatcher,
    );
    let placeholder_snapshot = simulation.snapshot();
    let mut machine = Machine {
        simulation,
        publisher: DeltaPublisher::new(&placeholder_snapshot),
        internal_by_external: BTreeMap::new(),
        external_by_internal: BTreeMap::new(),
        next_internal_id: 1,
        disruptions: BTreeMap::new(),
        activated_disruptions: BTreeSet::new(),
        pending_disruption_effects: BTreeMap::new(),
        external_zone: ExternalZone::new(
            INTERNAL_WORLD_ID,
            EXTERNAL_ZONE_REGION_ID,
            state.initial_now_s,
        ),
    };
    let mut initial_domain_events = Vec::new();
    for train in &state.initial_trains {
        let internal_id = allocate_train(&mut machine, train)?;
        initial_domain_events.extend(
            machine
                .simulation
                .apply(Command::Materialize(make_train(train, internal_id)))?,
        );
    }
    machine.publisher = DeltaPublisher::new(&machine.simulation.snapshot());
    let initial_events = wire_events(state, &machine, initial_domain_events)?;

    let mut command_ids = BTreeSet::new();
    let mut applied = Vec::with_capacity(state.commands.len());
    for stored in &state.commands {
        validate_identity(&stored.command_id, "commandId")?;
        if !command_ids.insert(stored.command_id.clone()) {
            return Err(RuntimeError::new("corrupt_state", "doppelte commandId"));
        }
        let expected_hash = canonical_hash(
            "zugfolge/regional-simulation-command/v1",
            &json!({
                "worldId": state.world_id,
                "regionId": state.region_id,
                "command": stored.command,
            }),
        )?;
        if stored.command_hash != expected_hash {
            return Err(RuntimeError::new(
                "corrupt_state",
                format!(
                    "Kommando '{}' besitzt einen falschen Hash",
                    stored.command_id
                ),
            ));
        }
        applied.push(apply_wire_command(state, &mut machine, &stored.command)?);
    }
    if machine.simulation.snapshot().at != state.now_s {
        return Err(RuntimeError::new(
            "corrupt_state",
            "gespeicherte Simulationszeit stimmt nicht mit Replay ueberein",
        ));
    }
    Ok((machine, initial_events, applied))
}

/// Initialisiert einen echten regionalen M4-Kern samt DeltaPublisher.
pub fn initialize_regional_simulation(input_json: &str) -> Result<String, RuntimeError> {
    let mut input: Initialization = decode(input_json, "Initialisierung")?;
    if input.schema_version != INITIALIZE_SCHEMA {
        return Err(RuntimeError::new(
            "wrong_schema",
            "unbekanntes Initialisierungsschema",
        ));
    }
    validate_identity(&input.world_id, "worldId")?;
    validate_identity(&input.region_id, "regionId")?;
    if input.now_s < 0 {
        return Err(RuntimeError::new(
            "invalid_time",
            "Initialzeit darf nicht negativ sein",
        ));
    }
    MaterializationWindow::new(input.materialization_window_hours)?;
    let mut ids = BTreeSet::new();
    for train in &input.trains {
        validate_train(train)?;
        if !ids.insert(train.train_run_id.clone()) {
            return Err(RuntimeError::new(
                "duplicate_train",
                train.train_run_id.clone(),
            ));
        }
    }
    input
        .trains
        .sort_by(|left, right| left.train_run_id.cmp(&right.train_run_id));
    let state = RuntimeState {
        schema_version: STATE_SCHEMA.to_owned(),
        world_id: input.world_id,
        region_id: input.region_id,
        materialization_window_hours: input.materialization_window_hours,
        initial_now_s: input.now_s,
        now_s: input.now_s,
        initial_trains: input.trains,
        revision: 0,
        publisher_sequence: 0,
        commands: Vec::new(),
    };
    let (machine, events, _) = build_machine(&state)?;
    let snapshot = wire_snapshot(&state, &machine, machine.simulation.snapshot(), 0)?;
    encode(
        &json!({
            "schemaVersion": INITIALIZED_SCHEMA,
            "state": state,
            "stateHash": state_hash(&state)?,
            "snapshot": snapshot,
            "events": events,
        }),
        "Initialisierungsergebnis",
    )
}

/// Rekonstruiert einen persistierten Zustand durch vollstaendiges Replay und
/// liefert den aktuellen Rust-Snapshot fuer einen kalten Prozessstart.
pub fn restore_regional_simulation(state_json: &str) -> Result<String, RuntimeError> {
    let state: RuntimeState = decode(state_json, "Regionalzustand")?;
    let (machine, _, _) = build_machine(&state)?;
    let snapshot = wire_snapshot(
        &state,
        &machine,
        machine.simulation.snapshot(),
        state.publisher_sequence,
    )?;
    encode(
        &json!({
            "schemaVersion": RESTORED_SCHEMA,
            "state": state,
            "stateHash": state_hash(&state)?,
            "snapshot": snapshot,
        }),
        "Wiederherstellungsergebnis",
    )
}

/// Wendet genau ein idempotentes Kommando an und liefert echte Rust-Ereignisse
/// sowie das von [`DeltaPublisher`] erzeugte Delta.
pub fn apply_regional_simulation_command(
    state_json: &str,
    command_json: &str,
) -> Result<String, RuntimeError> {
    let mut state: RuntimeState = decode(state_json, "Regionalzustand")?;
    let envelope: CommandEnvelope = decode(command_json, "Regionalkommando")?;
    if envelope.schema_version != COMMAND_SCHEMA {
        return Err(RuntimeError::new(
            "wrong_schema",
            "unbekanntes Kommandoschema",
        ));
    }
    if envelope.world_id != state.world_id || envelope.region_id != state.region_id {
        return Err(RuntimeError::new(
            "wrong_scope",
            "Kommando und Regionalzustand gehoeren nicht zusammen",
        ));
    }
    validate_identity(&envelope.command_id, "commandId")?;
    let incoming_hash = command_hash(&envelope)?;
    let (mut machine, _, replayed) = build_machine(&state)?;
    if let Some((index, stored)) = state
        .commands
        .iter()
        .enumerate()
        .find(|(_, stored)| stored.command_id == envelope.command_id)
    {
        if stored.command_hash != incoming_hash {
            return Err(RuntimeError::new(
                "idempotency_conflict",
                "commandId wurde mit anderem Inhalt wiederholt",
            ));
        }
        let original = replayed
            .get(index)
            .ok_or_else(|| RuntimeError::new("corrupt_state", "Replay-Ergebnis fehlt"))?;
        return encode(
            &json!({
                "schemaVersion": RESULT_SCHEMA,
                "state": state,
                "stateHash": state_hash(&state)?,
                "events": original.events,
                "delta": original.delta,
                "appliedCommandId": envelope.command_id,
                "idempotentReplay": true,
            }),
            "Replay-Ergebnis",
        );
    }
    let current_hash = state_hash(&state)?;
    if envelope.expected_state_hash != current_hash {
        return Err(RuntimeError::new(
            "state_hash_conflict",
            "Zustandshash ist veraltet",
        ));
    }
    if envelope.expected_revision != state.revision {
        return Err(RuntimeError::new(
            "revision_conflict",
            "Zustandsrevision ist veraltet",
        ));
    }
    if envelope.expected_publisher_sequence != state.publisher_sequence {
        return Err(RuntimeError::new(
            "publisher_sequence_gap",
            "Publisher-Sequenz ist nicht lueckenlos",
        ));
    }
    if state.revision >= MAX_JSON_SAFE_INTEGER {
        return Err(RuntimeError::new(
            "sequence_exhausted",
            "JSON-sichere Revisionssequenz ist erschoepft",
        ));
    }
    match &envelope.command {
        WireCommand::AdvanceTo { at_s } if *at_s < 0 => {
            return Err(RuntimeError::new(
                "invalid_time",
                "Simulationszeit darf nicht negativ sein",
            ));
        }
        WireCommand::DematerializeBefore { before_s } if *before_s < 0 => {
            return Err(RuntimeError::new(
                "invalid_time",
                "Dematerialisierungsgrenze darf nicht negativ sein",
            ));
        }
        _ => {}
    }
    let applied = apply_wire_command(&state, &mut machine, &envelope.command)?;
    if applied.delta.producer_sequence != state.publisher_sequence.saturating_add(1) {
        return Err(RuntimeError::new(
            "publisher_sequence_gap",
            "Rust-Delta besitzt eine unerwartete Sequenz",
        ));
    }
    let applied_command_id = envelope.command_id.clone();
    state.commands.push(StoredCommand {
        command_id: envelope.command_id,
        command_hash: incoming_hash,
        command: envelope.command,
    });
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or_else(|| RuntimeError::new("revision_exhausted", "Revision ist erschoepft"))?;
    state.publisher_sequence = applied.delta.producer_sequence;
    state.now_s = applied.delta.at_s;
    encode(
        &json!({
            "schemaVersion": RESULT_SCHEMA,
            "state": state,
            "stateHash": state_hash(&state)?,
            "events": applied.events,
            "delta": applied.delta,
            "appliedCommandId": applied_command_id,
            "idempotentReplay": false,
        }),
        "Kommandoergebnis",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn train(id: &str) -> Value {
        json!({
            "trainRunId": id,
            "operator": "operator-1",
            "trainNumber": "RE 1",
            "category": "regional",
            "route": [
                { "operatingPoint": "A", "positionMm": 0, "arrivalS": 100, "minimumDwellSeconds": 30, "departureS": 130 },
                { "operatingPoint": "B", "positionMm": 3_600_000, "arrivalS": 3_700, "minimumDwellSeconds": 30, "departureS": 3_730 }
            ]
        })
    }

    fn initialize(world_id: &str) -> Value {
        let result = initialize_regional_simulation(
            &json!({
                "schemaVersion": INITIALIZE_SCHEMA,
                "worldId": world_id,
                "regionId": "region-leipzig",
                "materializationWindowHours": 48,
                "nowS": 0,
                "trains": [train("pattern-1:trip-1:20260811:4600")]
            })
            .to_string(),
        )
        .unwrap();
        serde_json::from_str(&result).unwrap()
    }

    fn command(state: &Value, id: &str, body: Value) -> Value {
        json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": state["state"]["worldId"],
            "regionId": state["state"]["regionId"],
            "commandId": id,
            "expectedStateHash": state["stateHash"],
            "expectedRevision": state["state"]["revision"],
            "expectedPublisherSequence": state["state"]["publisherSequence"],
            "command": body,
        })
    }

    fn apply(state: &Value, id: &str, body: Value) -> Value {
        let result = apply_regional_simulation_command(
            &state["state"].to_string(),
            &command(state, id, body).to_string(),
        )
        .unwrap();
        serde_json::from_str(&result).unwrap()
    }

    #[test]
    fn materialize_advance_remove_uses_real_publisher() {
        let initialized = initialize("11111111-1111-4111-8111-111111111111");
        assert_eq!(initialized["snapshot"]["producerSequence"], 0);
        assert_eq!(
            initialized["snapshot"]["trains"][0]["id"],
            "pattern-1:trip-1:20260811:4600"
        );

        let materialized = apply(
            &initialized,
            "materialize-2",
            json!({ "type": "materialize", "train": train("pattern-2:trip-2:20260811:4700") }),
        );
        assert_eq!(materialized["delta"]["producerSequence"], 1);
        assert_eq!(
            materialized["delta"]["changed"][0]["id"],
            "pattern-2:trip-2:20260811:4700"
        );

        let advanced = apply(
            &materialized,
            "advance",
            json!({ "type": "advance-to", "atS": 4_000 }),
        );
        assert_eq!(advanced["delta"]["producerSequence"], 2);
        assert!(
            advanced["events"]
                .as_array()
                .is_some_and(|events| !events.is_empty())
        );

        let removed = apply(
            &advanced,
            "remove",
            json!({ "type": "dematerialize-before", "beforeS": 5_000 }),
        );
        assert_eq!(removed["delta"]["producerSequence"], 3);
        assert_eq!(
            removed["delta"]["removed"].as_array().map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn external_leg_is_productive_replayable_and_reenters_only_through_resources() {
        let initialized = initialize("11111111-1111-4111-8111-111111111111");
        let advanced = apply(
            &initialized,
            "advance-to-boundary",
            json!({ "type": "advance-to", "atS": 4_000 }),
        );
        let entered = apply(
            &advanced,
            "enter-external",
            json!({
                "type": "enter-external-zone",
                "trainRunId": "pattern-1:trip-1:20260811:4600",
                "externalLeg": {
                    "journeyChainId": "jc-re1",
                    "externalLegId": "el-b-c",
                    "fromPortalId": "B",
                    "toPortalId": "C",
                    "scheduledStartS": 3_730,
                    "scheduledEndS": 5_000,
                    "reentryEarliestS": 4_900,
                    "reentryLatestS": 5_300,
                    "fixedCostCents": "10500",
                    "boundVehicleIds": ["vehicle-1"],
                    "boundPersonnelDutyIds": ["duty-1"],
                    "reentryRoute": [
                        { "operatingPoint": "C", "positionMm": 0, "arrivalS": 5_000, "minimumDwellSeconds": 30, "departureS": 5_030 },
                        { "operatingPoint": "D", "positionMm": 3_000_000, "arrivalS": 5_600, "minimumDwellSeconds": 30, "departureS": 5_630 }
                    ],
                    "firstResources": ["block:C:entry"]
                }
            }),
        );
        assert_eq!(
            entered["delta"]["removed"],
            json!(["pattern-1:trip-1:20260811:4600"])
        );
        assert_eq!(
            entered["delta"]["changedExternalTrains"][0]["status"],
            "outside"
        );
        assert!(
            entered["events"]
                .as_array()
                .is_some_and(|events| events.iter().any(|event| {
                    event["eventType"] == "simulation.external-leg-entered"
                        && event["payload"]["outsidePenaltyApplied"] == false
                }))
        );

        let ready = apply(
            &entered,
            "advance-external",
            json!({ "type": "advance-to", "atS": 5_100 }),
        );
        assert_eq!(
            ready["delta"]["changedExternalTrains"][0]["status"],
            "ready-at-boundary"
        );
        let reentered = apply(
            &ready,
            "reenter",
            json!({
                "type": "reenter-from-external",
                "trainRunId": "pattern-1:trip-1:20260811:4600"
            }),
        );
        assert_eq!(
            reentered["delta"]["removedExternalTrainIds"],
            json!(["pattern-1:trip-1:20260811:4600"])
        );
        assert_eq!(reentered["delta"]["changed"][0]["nextOperatingPoint"], "C");
        let restored: Value = serde_json::from_str(
            &restore_regional_simulation(&reentered["state"].to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(restored["stateHash"], reentered["stateHash"]);
        assert_eq!(restored["snapshot"]["externalTrains"], json!([]));
        assert_eq!(restored["snapshot"]["trains"][0]["nextOperatingPoint"], "C");
    }

    #[test]
    fn restart_and_idempotency_are_hash_equal() {
        let initialized = initialize("11111111-1111-4111-8111-111111111111");
        let first_command = command(
            &initialized,
            "advance-1",
            json!({ "type": "advance-to", "atS": 100 }),
        );
        let first: Value = serde_json::from_str(
            &apply_regional_simulation_command(
                &initialized["state"].to_string(),
                &first_command.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        let retry: Value = serde_json::from_str(
            &apply_regional_simulation_command(
                &first["state"].to_string(),
                &first_command.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(retry["idempotentReplay"], true);
        assert_eq!(retry["stateHash"], first["stateHash"]);
        assert_eq!(retry["delta"], first["delta"]);

        let restarted = apply(
            &first,
            "advance-2",
            json!({ "type": "advance-to", "atS": 130 }),
        );
        let repeated = apply(
            &first,
            "advance-2",
            json!({ "type": "advance-to", "atS": 130 }),
        );
        assert_eq!(restarted["stateHash"], repeated["stateHash"]);
        assert_eq!(restarted["delta"], repeated["delta"]);

        let restored: Value = serde_json::from_str(
            &restore_regional_simulation(&restarted["state"].to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(restored["schemaVersion"], RESTORED_SCHEMA);
        assert_eq!(restored["stateHash"], restarted["stateHash"]);
        assert_eq!(
            restored["snapshot"]["producerSequence"],
            restarted["state"]["publisherSequence"]
        );
        assert_eq!(restored["snapshot"]["atS"], restarted["state"]["nowS"]);
    }

    #[test]
    fn planned_disruption_is_visible_before_single_writer_activation_and_replays() {
        let initialized = initialize("11111111-1111-4111-8111-111111111111");
        let registered = apply(
            &initialized,
            "register-planned-disruption",
            json!({
                "type": "register-disruption",
                "disruption": {
                    "disruptionId": "planned-closure-1",
                    "kind": "planned",
                    "publishedAtS": 0,
                    "startsAtS": 100,
                    "validUntilS": 3_600,
                    "positionMm": 1_200_000,
                    "causeCode": 25,
                    "fineCauseId": "signalling.interlocking",
                    "effect": "closure",
                    "affectedResource": "block:A:B:1",
                    "affectedTrainRunIds": ["pattern-1:trip-1:20260811:4600"],
                    "delaySeconds": 300
                }
            }),
        );
        assert_eq!(registered["events"].as_array().map(Vec::len), Some(0));
        assert_eq!(
            registered["delta"]["changedDisruptions"][0]["kind"],
            "planned"
        );
        assert_eq!(
            registered["delta"]["changedDisruptions"][0]["fineCauseId"],
            "signalling.interlocking"
        );

        let advanced = apply(
            &registered,
            "advance-to-start",
            json!({ "type": "advance-to", "atS": 100 }),
        );
        assert!(advanced["events"].as_array().is_some_and(|events| {
            events.iter().any(|event| {
                event["eventType"] == "disruption.applied"
                    && event["payload"]["fineCauseId"] == "signalling.interlocking"
                    && event["payload"]["kind"] == "planned"
            })
        }));
        assert!(
            advanced["delta"]["changed"]
                .as_array()
                .is_some_and(|trains| {
                    trains.iter().any(|train| {
                        train["id"] == "pattern-1:trip-1:20260811:4600"
                            && train["delaySeconds"] == 300
                    })
                })
        );

        let replayed = apply(
            &registered,
            "advance-to-start",
            json!({ "type": "advance-to", "atS": 100 }),
        );
        assert_eq!(replayed["stateHash"], advanced["stateHash"]);
        assert_eq!(replayed["delta"], advanced["delta"]);

        let restored: Value = serde_json::from_str(
            &restore_regional_simulation(&advanced["state"].to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(restored["stateHash"], advanced["stateHash"]);
        assert_eq!(
            restored["snapshot"]["disruptions"][0]["disruptionId"],
            "planned-closure-1"
        );
        assert_eq!(restored["snapshot"]["trains"][0]["delaySeconds"], 300);
    }

    #[test]
    fn effectless_and_mismatched_disruptions_never_enter_runtime() {
        let initialized = initialize("11111111-1111-4111-8111-111111111111");
        for (id, effect, fine_cause_id) in [
            ("radio", "radio-unavailable", "signalling.interlocking"),
            ("wrong-fine", "closure", "weather.storm"),
        ] {
            let envelope = command(
                &initialized,
                id,
                json!({
                    "type": "register-disruption",
                    "disruption": {
                        "disruptionId": id,
                        "kind": "unplanned",
                        "publishedAtS": 0,
                        "startsAtS": 0,
                        "validUntilS": 3_600,
                        "positionMm": 1_200_000,
                        "causeCode": 25,
                        "fineCauseId": fine_cause_id,
                        "effect": effect,
                        "affectedResource": "block:A:B:1",
                        "affectedTrainRunIds": [],
                        "delaySeconds": 0
                    }
                }),
            );
            let error = apply_regional_simulation_command(
                &initialized["state"].to_string(),
                &envelope.to_string(),
            )
            .unwrap_err();
            assert!(
                error.to_string().starts_with("invalid_disruption:")
                    || error.to_string().starts_with("invalid_fine_cause_code:")
            );
        }
    }

    #[test]
    fn provider_reconciliation_can_clear_a_visible_disruption() {
        let initialized = initialize("11111111-1111-4111-8111-111111111111");
        let registered = apply(
            &initialized,
            "provider-register",
            json!({
                "type": "register-disruption",
                "disruption": {
                    "disruptionId": "provider-restriction-1",
                    "kind": "unplanned",
                    "publishedAtS": 0,
                    "startsAtS": 0,
                    "validUntilS": 3_600,
                    "positionMm": 100,
                    "causeCode": 26,
                    "fineCauseId": "switch.drive",
                    "effect": "single-track",
                    "affectedResource": "track:LL:UEF",
                    "affectedTrainRunIds": [],
                    "delaySeconds": 0
                }
            }),
        );
        let cleared = apply(
            &registered,
            "provider-clear",
            json!({
                "type": "clear-disruption",
                "disruptionId": "provider-restriction-1"
            }),
        );
        assert_eq!(
            cleared["delta"]["removedDisruptionIds"],
            json!(["provider-restriction-1"])
        );
        let restored: Value = serde_json::from_str(
            &restore_regional_simulation(&cleared["state"].to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            restored["snapshot"]["disruptions"].as_array().map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn rejects_publisher_gap_and_wrong_world() {
        let initialized = initialize("11111111-1111-4111-8111-111111111111");
        let mut gap = command(
            &initialized,
            "gap",
            json!({ "type": "advance-to", "atS": 100 }),
        );
        gap["expectedPublisherSequence"] = json!(7);
        let error =
            apply_regional_simulation_command(&initialized["state"].to_string(), &gap.to_string())
                .unwrap_err();
        assert!(error.to_string().starts_with("publisher_sequence_gap:"));

        let mut foreign = command(
            &initialized,
            "foreign",
            json!({ "type": "advance-to", "atS": 100 }),
        );
        foreign["worldId"] = json!("22222222-2222-4222-8222-222222222222");
        let error = apply_regional_simulation_command(
            &initialized["state"].to_string(),
            &foreign.to_string(),
        )
        .unwrap_err();
        assert!(error.to_string().starts_with("wrong_scope:"));
    }

    #[test]
    fn rejects_tampered_persisted_state() {
        let initialized = initialize("11111111-1111-4111-8111-111111111111");
        let mut state = initialized["state"].clone();
        state["nowS"] = json!(99);
        let envelope = command(
            &initialized,
            "tampered",
            json!({ "type": "advance-to", "atS": 100 }),
        );
        let error = apply_regional_simulation_command(&state.to_string(), &envelope.to_string())
            .unwrap_err();
        assert!(error.to_string().starts_with("corrupt_state:"));
    }
}
