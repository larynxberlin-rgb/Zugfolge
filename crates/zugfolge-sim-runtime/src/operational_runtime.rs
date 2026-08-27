//! Persistierbare v2-Grenze fuer die eine autoritative Betriebswirklichkeit.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zugfolge_infra::open_operational_infrastructure_v2_store;
use zugfolge_sim::operational::{
    AutomaticShuntingNeed, DispatchRequest, MAX_PENDING_OPERATIONAL_EVENTS, MovementContinuation,
    MovementKind, OperationalDisruption, OperationalError, OperationalEvent,
    OperationalInfrastructure, OperationalProgramTemplatePredicates, OperationalProjection,
    OperationalWorld, PROTECTION_MODE_SELECTION_POLICY_V1, PhysicalVehicle, ProjectionKind,
    ProtectionModeSelectionRun, TrainMaterialization, VehicleType,
    operational_train_number_numeric_part,
};

use crate::initialization_hash::operational_initialization_hash;

pub const INITIALIZE_SCHEMA: &str = "zugfolge-operational-simulation-initialize/v2";
pub const COMMAND_SCHEMA: &str = "zugfolge-operational-simulation-command/v2";
pub const COMMAND_BATCH_SCHEMA: &str = "zugfolge-operational-simulation-command-batch/v1";
pub const STATE_SCHEMA: &str = "zugfolge-operational-simulation-state/v2";
pub const INITIALIZED_SCHEMA: &str = "zugfolge-operational-simulation-initialized/v2";
pub const RESTORE_SCHEMA: &str = "zugfolge-operational-simulation-restore/v2";
pub const RESTORED_SCHEMA: &str = "zugfolge-operational-simulation-restored/v2";
pub const RESULT_SCHEMA: &str = "zugfolge-operational-simulation-result/v2";
pub const BATCH_RESULT_SCHEMA: &str = "zugfolge-operational-simulation-batch-result/v1";
pub const INFRASTRUCTURE_BINDING_SCHEMA: &str = "zugfolge-operational-infrastructure-binding/v2";
pub const INFRASTRUCTURE_FILE: &str = "operational-infrastructure-v2.json";
pub const MAX_COMMAND_RECEIPTS: usize = 4_096;
pub const MAX_COMMAND_BATCH_SIZE: usize = 256;
pub const MAX_BATCH_EVENTS: usize = MAX_PENDING_OPERATIONAL_EVENTS;
pub const MAX_OPERATIONAL_STATE_JSON_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_BATCH_STATE_JSON_BYTES: usize = MAX_OPERATIONAL_STATE_JSON_BYTES;
pub const MAX_INITIALIZATION_JSON_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_RESTORE_JSON_BYTES: usize = MAX_OPERATIONAL_STATE_JSON_BYTES + 1024 * 1024;
pub const MAX_COMMAND_JSON_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_BATCH_JSON_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_BATCH_RESULT_JSON_BYTES: usize = 32 * 1024 * 1024;
const INITIAL_BATCH_RESULT_JSON_CAPACITY: usize = 64 * 1024;
pub const INITIALIZATION_VALIDATION_RECEIPT_SCHEMA: &str =
    "zugfolge-operational-initialization-validation-receipt/v1";
pub const INFRASTRUCTURE_VALIDATION_MODE: &str = "native-streaming-redb-v1";
pub const PROTECTION_MODE_SELECTION_EVIDENCE_SCHEMA: &str =
    "zugfolge-protection-mode-selections-evidence/v1";

type InfrastructureHandle = Arc<dyn OperationalInfrastructure>;
static INFRASTRUCTURE_CACHE: OnceLock<Mutex<BTreeMap<String, InfrastructureHandle>>> =
    OnceLock::new();

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRuntimeError {
    code: &'static str,
    detail: String,
}

impl OperationalRuntimeError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for OperationalRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl Error for OperationalRuntimeError {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VehicleTypeInput {
    vehicle_type: VehicleType,
    powered: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FormationInput {
    id: String,
    predecessor_id: Option<String>,
    vehicle_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrainInput {
    id: String,
    train_number: String,
    operator_id: String,
    movement_kind: MovementKind,
    route_version_id: String,
    formation_version_id: String,
    head_route_mm: i64,
    scheduled_departure_ms: Option<i64>,
    public_passenger_stop: bool,
    dispatch_interlocking_route_id: String,
    protection_mode_selection_runs: Vec<ProtectionModeSelectionRun>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum SuccessorFormationPolicy {
    InheritPredecessor,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MovementContinuationTemplateInput {
    id: String,
    predecessor_train_id: String,
    predecessor_base_route_version_id: String,
    successor_train_id: String,
    successor_day_offset: u8,
    daily_boundary: bool,
    minimum_dwell_ms: i64,
    continuity: zugfolge_sim::operational::MovementContinuity,
    successor_formation: SuccessorFormationPolicy,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InfrastructureBinding {
    schema_version: String,
    infra_release_id: String,
    file: String,
    bytes: u64,
    sha256: String,
    state_hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InitializationValidationReceipt {
    schema_version: &'static str,
    world_id: String,
    region_id: String,
    initialization_hash: String,
    state_hash: String,
    infra_release: InfrastructureBinding,
    program_train_count: usize,
    validated_program_template_count: usize,
    validated_route_version_count: usize,
    validated_dispatch_interlocking_route_count: usize,
    validated_resource_binding_count: usize,
    validated_formation_binding_count: usize,
    validated_train_number_count: usize,
    protection_mode_selection_policy: &'static str,
    validated_protection_mode_selection_count: usize,
    protection_mode_selections_sha256: String,
    validated_movement_continuation_count: usize,
    movement_continuations_sha256: String,
    dynamic_train_count: usize,
    resource_bindings_validated: bool,
    formation_bindings_validated: bool,
    train_numbers_validated: bool,
    protection_mode_selections_validated: bool,
    validation_mode: &'static str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Initialization {
    schema_version: String,
    world_id: String,
    region_id: String,
    now_ms: i64,
    protection_mode_selection_policy: String,
    infra_release: InfrastructureBinding,
    vehicle_types: Vec<VehicleTypeInput>,
    vehicles: Vec<PhysicalVehicle>,
    formations: Vec<FormationInput>,
    trains: Vec<TrainInput>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    repeat_every_ms: Option<i64>,
    movement_continuations: Vec<MovementContinuationTemplateInput>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum CommandPayload {
    Materialize {
        train: TrainInput,
    },
    Retire {
        train_id: String,
    },
    AdvanceTo {
        at_ms: i64,
    },
    Dispatch {
        requests: Vec<DispatchRequest>,
    },
    PlanMotion {
        train_id: String,
    },
    SafeStop {
        train_id: String,
        reason: String,
    },
    ChangeFormation {
        train_id: String,
        formation_id: String,
        vehicle_ids: Vec<String>,
    },
    Reroute {
        train_id: String,
        route_version_id: String,
    },
    QueueMovementContinuation {
        continuation: MovementContinuation,
    },
    AutomaticShunting {
        need: AutomaticShuntingNeed,
    },
    ActivateDisruption {
        disruption_id: String,
        effect: OperationalDisruption,
    },
    ClearDisruption {
        disruption_id: String,
        release_reference: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandEnvelope {
    schema_version: String,
    world_id: String,
    region_id: String,
    command_id: String,
    expected_state_hash: String,
    expected_revision: u64,
    expected_publisher_sequence: u64,
    command: CommandPayload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandBatchItem {
    command_id: String,
    command: CommandPayload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandBatchEnvelope {
    schema_version: String,
    world_id: String,
    region_id: String,
    expected_state_hash: String,
    expected_revision: u64,
    expected_publisher_sequence: u64,
    commands: Vec<CommandBatchItem>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreEnvelope {
    schema_version: String,
    expected_initialization_hash: String,
    state: RuntimeState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandReceipt {
    command_hash: String,
    applied_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeState {
    schema_version: String,
    initialization_hash: String,
    infra_release: InfrastructureBinding,
    world: OperationalWorld,
    revision: u64,
    publisher_sequence: u64,
    state_hash: String,
    command_receipts: BTreeMap<String, CommandReceipt>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InitializedResult {
    schema_version: &'static str,
    state: RuntimeState,
    initialization_hash: String,
    state_hash: String,
    live_map: OperationalProjection,
    rzue: OperationalProjection,
    events: Vec<OperationalEvent>,
    validation_receipt: InitializationValidationReceipt,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoredResult {
    schema_version: &'static str,
    state: RuntimeState,
    initialization_hash: String,
    state_hash: String,
    live_map: OperationalProjection,
    rzue: OperationalProjection,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    schema_version: &'static str,
    state: RuntimeState,
    initialization_hash: String,
    state_hash: String,
    live_map: OperationalProjection,
    rzue: OperationalProjection,
    events: Vec<OperationalEvent>,
    applied_command_id: String,
    idempotent_replay: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandBatchItemResult {
    command_id: String,
    idempotent_replay: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandBatchEventContext {
    command_index: usize,
    command_id: String,
    commit_sequence: u64,
    affected_train_run_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disruption_effect_before: Option<OperationalDisruption>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandBatchResult {
    schema_version: &'static str,
    state: RuntimeState,
    initialization_hash: String,
    state_hash: String,
    live_map: OperationalProjection,
    rzue: OperationalProjection,
    events: Vec<OperationalEvent>,
    command_results: Vec<CommandBatchItemResult>,
    event_contexts: Vec<CommandBatchEventContext>,
}

fn decode<T: for<'de> Deserialize<'de>>(
    json: &str,
    name: &str,
) -> Result<T, OperationalRuntimeError> {
    serde_json::from_str(json).map_err(|error| {
        OperationalRuntimeError::new("invalid_json_contract", format!("{name}: {error}"))
    })
}

#[cfg(test)]
fn encode<T: Serialize>(value: &T) -> Result<String, OperationalRuntimeError> {
    serde_json::to_string(value)
        .map_err(|error| OperationalRuntimeError::new("serialization_failed", error.to_string()))
}

struct BoundedJsonWriter {
    bytes: Vec<u8>,
    limit: usize,
    budget_exceeded: bool,
}

impl BoundedJsonWriter {
    fn new(limit: usize) -> Result<Self, OperationalRuntimeError> {
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(limit.min(INITIAL_BATCH_RESULT_JSON_CAPACITY))
            .map_err(|error| {
                OperationalRuntimeError::new("serialization_failed", error.to_string())
            })?;
        Ok(Self {
            bytes,
            limit,
            budget_exceeded: false,
        })
    }

    fn into_string(self) -> Result<String, OperationalRuntimeError> {
        String::from_utf8(self.bytes).map_err(|error| {
            OperationalRuntimeError::new("serialization_failed", error.to_string())
        })
    }
}

impl Write for BoundedJsonWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let Some(next_len) = self.bytes.len().checked_add(bytes.len()) else {
            self.budget_exceeded = true;
            return Err(io::Error::other("JSON-Ausgabegroesse ist nicht zaehlbar"));
        };
        if next_len > self.limit {
            self.budget_exceeded = true;
            return Err(io::Error::other("JSON-Ausgabebudget ueberschritten"));
        }
        if next_len > self.bytes.capacity() {
            let target_capacity = self
                .bytes
                .capacity()
                .saturating_mul(2)
                .max(next_len)
                .min(self.limit);
            self.bytes
                .try_reserve_exact(target_capacity - self.bytes.len())
                .map_err(|error| io::Error::other(error.to_string()))?;
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn encode_with_budget<T: Serialize>(
    value: &T,
    limit: usize,
    budget_error_code: &'static str,
) -> Result<String, OperationalRuntimeError> {
    let mut writer = BoundedJsonWriter::new(limit)?;
    match serde_json::to_writer(&mut writer, value) {
        Ok(()) => writer.into_string(),
        Err(_) if writer.budget_exceeded => Err(OperationalRuntimeError::new(
            budget_error_code,
            format!("JSON-Ergebnis ueberschreitet {limit} Bytes"),
        )),
        Err(error) => Err(OperationalRuntimeError::new(
            "serialization_failed",
            error.to_string(),
        )),
    }
}

struct BoundedJsonCounter {
    bytes: usize,
    limit: usize,
    budget_exceeded: bool,
}

impl Write for BoundedJsonCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let Some(next_len) = self.bytes.checked_add(bytes.len()) else {
            self.budget_exceeded = true;
            return Err(io::Error::other("JSON-Groesse ist nicht zaehlbar"));
        };
        if next_len > self.limit {
            self.budget_exceeded = true;
            return Err(io::Error::other("JSON-Groessenbudget ueberschritten"));
        }
        self.bytes = next_len;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn ensure_encoded_within_budget<T: Serialize>(
    value: &T,
    limit: usize,
    budget_error_code: &'static str,
    name: &str,
) -> Result<usize, OperationalRuntimeError> {
    let mut counter = BoundedJsonCounter {
        bytes: 0,
        limit,
        budget_exceeded: false,
    };
    match serde_json::to_writer(&mut counter, value) {
        Ok(()) => Ok(counter.bytes),
        Err(_) if counter.budget_exceeded => Err(OperationalRuntimeError::new(
            budget_error_code,
            format!("{name} ueberschreitet {limit} Bytes"),
        )),
        Err(error) => Err(OperationalRuntimeError::new(
            "serialization_failed",
            error.to_string(),
        )),
    }
}

fn reject_json_over_budget(
    json: &str,
    limit: usize,
    error_code: &'static str,
    name: &str,
) -> Result<(), OperationalRuntimeError> {
    if json.len() > limit {
        return Err(OperationalRuntimeError::new(
            error_code,
            format!(
                "{name} besitzt {} Bytes; erlaubt sind hoechstens {limit}",
                json.len()
            ),
        ));
    }
    Ok(())
}

fn reject_embedded_static_infrastructure(
    world: Option<&Value>,
) -> Result<(), OperationalRuntimeError> {
    let Some(world) = world.and_then(Value::as_object) else {
        return Err(OperationalRuntimeError::new(
            "invalid_json_contract",
            "Operational-v2-Zustand besitzt keinen Weltzustand",
        ));
    };
    if [
        "infra",
        "directedEdges",
        "edgeGeometries",
        "routeVersions",
        "interlockingRoutes",
        "platformIntervals",
    ]
    .iter()
    .any(|field| world.contains_key(*field))
    {
        return Err(OperationalRuntimeError::new(
            "embedded_static_infrastructure_forbidden",
            "dynamischer v2-Zustand enthaelt statische Infrastrukturbytes",
        ));
    }
    Ok(())
}

impl InfrastructureBinding {
    fn validate(&self) -> Result<(), OperationalRuntimeError> {
        if self.schema_version != INFRASTRUCTURE_BINDING_SCHEMA
            || self.infra_release_id.trim().is_empty()
            || self.file != INFRASTRUCTURE_FILE
            || self.bytes == 0
            || !is_sha256(&self.sha256)
            || !is_sha256(&self.state_hash)
            || self.sha256 == self.state_hash
        {
            return Err(OperationalRuntimeError::new(
                "invalid_infrastructure_binding",
                "Operational-v2-Infrastruktur besitzt keine vollstaendige kompakte Dateibindung",
            ));
        }
        Ok(())
    }

    fn cache_key(&self, path: &Path) -> String {
        format!(
            "{}\0{}\0{}\0{}\0{}",
            path.display(),
            self.infra_release_id,
            self.bytes,
            self.sha256,
            self.state_hash
        )
    }
}

fn infrastructure_for_binding(
    binding: &InfrastructureBinding,
    resolved_path: &str,
) -> Result<InfrastructureHandle, OperationalRuntimeError> {
    binding.validate()?;
    let path = PathBuf::from(resolved_path);
    if !path.is_absolute()
        || path.file_name().and_then(|name| name.to_str()) != Some(binding.file.as_str())
    {
        return Err(OperationalRuntimeError::new(
            "invalid_infrastructure_path",
            "Operational-v2-Infrastrukturpfad wurde nicht absolut auf die gebundene Datei aufgeloest",
        ));
    }
    let key = binding.cache_key(&path);
    let cache = INFRASTRUCTURE_CACHE.get_or_init(|| Mutex::new(BTreeMap::new()));
    let mut cache = cache.lock().map_err(|_| {
        OperationalRuntimeError::new(
            "infrastructure_cache_unavailable",
            "Operational-v2-Infrastrukturcache ist vergiftet",
        )
    })?;
    if let Some(existing) = cache.get(&key) {
        if existing.release_id() == binding.infra_release_id
            && existing.binding_identity() == binding.state_hash
            && existing.validate_attachment().is_ok()
        {
            return Ok(Arc::clone(existing));
        }
        cache.remove(&key);
    }
    let store = open_operational_infrastructure_v2_store(
        &path,
        &binding.infra_release_id,
        binding.bytes,
        &binding.sha256,
        &binding.state_hash,
    )
    .map_err(|error| {
        OperationalRuntimeError::new("infrastructure_attachment_failed", error.to_string())
    })?;
    let store: InfrastructureHandle = Arc::new(store);
    cache.insert(key, Arc::clone(&store));
    Ok(store)
}

fn command_hash(command: &CommandPayload) -> Result<String, OperationalRuntimeError> {
    let bytes = serde_json::to_vec(command)
        .map_err(|error| OperationalRuntimeError::new("serialization_failed", error.to_string()))?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn update_length_prefixed(hash: &mut Sha256, value: &str) -> Result<(), OperationalRuntimeError> {
    let length = u64::try_from(value.len()).map_err(|_| {
        OperationalRuntimeError::new(
            "protection_mode_selection_evidence_overflow",
            "Zugsicherungsbeleg enthaelt eine unzaehlbare Zeichenkette",
        )
    })?;
    hash.update(length.to_le_bytes());
    hash.update(value.as_bytes());
    Ok(())
}

fn protection_mode_selection_evidence(
    trains: &[TrainInput],
) -> Result<(usize, String), OperationalRuntimeError> {
    let mut ordered = trains.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.route_version_id.cmp(&right.route_version_id))
    });
    let mut hash = Sha256::new();
    hash.update(PROTECTION_MODE_SELECTION_EVIDENCE_SCHEMA.as_bytes());
    hash.update([0]);
    let mut count = 0_usize;
    for train in ordered {
        update_length_prefixed(&mut hash, &train.id)?;
        update_length_prefixed(&mut hash, &train.route_version_id)?;
        let mut first_route_leg_index = 0_usize;
        for run in &train.protection_mode_selection_runs {
            if run.through_route_leg_index < first_route_leg_index {
                return Err(OperationalRuntimeError::new(
                    "invalid_protection_mode_selection_runs",
                    format!(
                        "{} besitzt ueberlappende oder leere Auswahl-Laeufe",
                        train.id
                    ),
                ));
            }
            for route_leg_index in first_route_leg_index..=run.through_route_leg_index {
                let route_leg_index = u64::try_from(route_leg_index).map_err(|_| {
                    OperationalRuntimeError::new(
                        "protection_mode_selection_evidence_overflow",
                        "Zugsicherungsbeleg enthaelt einen unzaehlbaren Leg-Index",
                    )
                })?;
                hash.update(route_leg_index.to_le_bytes());
                update_length_prefixed(&mut hash, &run.selected_protection_system)?;
                count = count.checked_add(1).ok_or_else(|| {
                    OperationalRuntimeError::new(
                        "protection_mode_selection_evidence_overflow",
                        "Zugsicherungsbeleg enthaelt zu viele Leg-Auswahlen",
                    )
                })?;
            }
            first_route_leg_index =
                run.through_route_leg_index.checked_add(1).ok_or_else(|| {
                    OperationalRuntimeError::new(
                        "protection_mode_selection_evidence_overflow",
                        "Zugsicherungsbeleg endet an einem unzaehlbaren Leg-Index",
                    )
                })?;
        }
    }
    Ok((
        count,
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    ))
}

fn movement_continuation_text(
    template: &MovementContinuationTemplateInput,
) -> (&'static str, &'static str) {
    let continuity = match template.continuity {
        zugfolge_sim::operational::MovementContinuity::SameDirection => "same-direction",
        zugfolge_sim::operational::MovementContinuity::ReverseDirection => "reverse-direction",
    };
    let successor_formation = match template.successor_formation {
        SuccessorFormationPolicy::InheritPredecessor => "inherit-predecessor",
    };
    (continuity, successor_formation)
}

fn movement_continuation_evidence(
    templates: &[MovementContinuationTemplateInput],
) -> Result<String, OperationalRuntimeError> {
    let mut ordered = templates.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.id.cmp(&right.id));
    let mut hash = Sha256::new();
    hash.update(b"zugfolge-operational-movement-continuations-evidence/v3\0");
    for template in ordered {
        for value in [
            template.id.as_str(),
            template.predecessor_train_id.as_str(),
            template.predecessor_base_route_version_id.as_str(),
            template.successor_train_id.as_str(),
        ] {
            let length = u64::try_from(value.len()).map_err(|_| {
                OperationalRuntimeError::new(
                    "movement_continuation_evidence_overflow",
                    "Fortsetzungsbeleg enthaelt eine unzaehlbare Zeichenkette",
                )
            })?;
            hash.update(length.to_le_bytes());
            hash.update(value.as_bytes());
        }
        hash.update(u64::from(template.successor_day_offset).to_le_bytes());
        hash.update([u8::from(template.daily_boundary)]);
        hash.update(template.minimum_dwell_ms.to_le_bytes());
        let (continuity, successor_formation) = movement_continuation_text(template);
        for value in [continuity, successor_formation] {
            let length = u64::try_from(value.len()).map_err(|_| {
                OperationalRuntimeError::new(
                    "movement_continuation_evidence_overflow",
                    "Fortsetzungsbeleg enthaelt eine unzaehlbare Zeichenkette",
                )
            })?;
            hash.update(length.to_le_bytes());
            hash.update(value.as_bytes());
        }
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn materialization_from_train_input(train: &TrainInput) -> TrainMaterialization {
    TrainMaterialization {
        id: train.id.clone(),
        train_number: train.train_number.clone(),
        operator_id: train.operator_id.clone(),
        movement_kind: train.movement_kind,
        route_version_id: train.route_version_id.clone(),
        formation_version_id: train.formation_version_id.clone(),
        head_route_mm: train.head_route_mm,
        scheduled_departure_ms: train.scheduled_departure_ms,
        public_passenger_stop: train.public_passenger_stop,
    }
}

fn validate_movement_continuation_templates(
    world: &OperationalWorld,
    trains: &[TrainInput],
    repeat_every_ms: Option<i64>,
    templates: &[MovementContinuationTemplateInput],
) -> Result<(usize, String), OperationalRuntimeError> {
    let evidence = movement_continuation_evidence(templates)?;
    let Some(repeat_every_ms) = repeat_every_ms else {
        return if templates.is_empty() {
            Ok((0, evidence))
        } else {
            Err(OperationalRuntimeError::new(
                "invalid_movement_continuation_repeat",
                "ein nicht wiederholtes Betriebsprogramm darf keinen Fortsetzungsgraph besitzen",
            ))
        };
    };
    if repeat_every_ms <= 0 || (templates.is_empty() != trains.is_empty()) {
        return Err(OperationalRuntimeError::new(
            "invalid_movement_continuation_repeat",
            "ein wiederholtes Betriebsprogramm braucht einen positiven Takt und einen vollstaendigen Fortsetzungsgraph",
        ));
    }
    if templates.is_empty() {
        return Ok((0, evidence));
    }
    let train_by_id: BTreeMap<&str, &TrainInput> = trains
        .iter()
        .map(|train| (train.id.as_str(), train))
        .collect();
    if train_by_id.len() != trains.len() {
        return Err(OperationalRuntimeError::new(
            "invalid_movement_continuation_graph",
            "Basisgraph besitzt keine eindeutigen Zugvorlagen",
        ));
    }
    let mut template_ids = BTreeSet::new();
    let mut incoming: BTreeMap<&str, usize> = BTreeMap::new();
    let mut outgoing: BTreeMap<&str, &MovementContinuationTemplateInput> = BTreeMap::new();
    let mut boundary_outgoing_by_formation = BTreeMap::<&str, &str>::new();
    let mut boundary_incoming_by_formation = BTreeMap::<&str, &str>::new();
    for template in templates {
        if template.id.is_empty()
            || template.predecessor_train_id.is_empty()
            || template.predecessor_base_route_version_id.is_empty()
            || template.successor_train_id.is_empty()
            || template.predecessor_train_id.contains(":day-")
            || template.successor_train_id.contains(":day-")
            || template.successor_day_offset > 1
            || template.minimum_dwell_ms < 0
            || !template_ids.insert(template.id.as_str())
        {
            return Err(OperationalRuntimeError::new(
                "invalid_movement_continuation_graph",
                template.id.clone(),
            ));
        }
        let predecessor = train_by_id
            .get(template.predecessor_train_id.as_str())
            .copied()
            .ok_or_else(|| {
                OperationalRuntimeError::new(
                    "unknown_movement_continuation_train",
                    template.predecessor_train_id.clone(),
                )
            })?;
        let successor = train_by_id
            .get(template.successor_train_id.as_str())
            .copied()
            .ok_or_else(|| {
                OperationalRuntimeError::new(
                    "unknown_movement_continuation_train",
                    template.successor_train_id.clone(),
                )
            })?;
        let expected_minimum_dwell_ms = if predecessor.public_passenger_stop {
            300_000
        } else {
            0
        };
        if template.minimum_dwell_ms != expected_minimum_dwell_ms {
            return Err(OperationalRuntimeError::new(
                "invalid_movement_continuation_dwell",
                template.id.clone(),
            ));
        }
        if outgoing.insert(predecessor.id.as_str(), template).is_some() {
            return Err(OperationalRuntimeError::new(
                "duplicate_movement_continuation_edge",
                predecessor.id.clone(),
            ));
        }
        *incoming.entry(successor.id.as_str()).or_default() += 1;
        if incoming[successor.id.as_str()] > 1
            || (template.successor_day_offset == 1 && !successor.public_passenger_stop)
            || (template.daily_boundary && !successor.public_passenger_stop)
        {
            return Err(OperationalRuntimeError::new(
                "invalid_movement_continuation_graph",
                template.id.clone(),
            ));
        }
        let predecessor_departure = predecessor.scheduled_departure_ms.ok_or_else(|| {
            OperationalRuntimeError::new(
                "invalid_movement_continuation_time",
                predecessor.id.clone(),
            )
        })?;
        let successor_departure = successor.scheduled_departure_ms.ok_or_else(|| {
            OperationalRuntimeError::new("invalid_movement_continuation_time", successor.id.clone())
        })?;
        let absolute_successor = i128::from(successor_departure)
            + i128::from(template.successor_day_offset) * i128::from(repeat_every_ms);
        if absolute_successor < i128::from(predecessor_departure) {
            return Err(OperationalRuntimeError::new(
                "invalid_movement_continuation_time",
                template.id.clone(),
            ));
        }
        let predecessor_formation = world
            .formations
            .get(&predecessor.formation_version_id)
            .ok_or_else(|| {
                OperationalRuntimeError::new(
                    "invalid_movement_continuation_formation",
                    predecessor.formation_version_id.clone(),
                )
            })?;
        let successor_formation = world
            .formations
            .get(&successor.formation_version_id)
            .ok_or_else(|| {
                OperationalRuntimeError::new(
                    "invalid_movement_continuation_formation",
                    successor.formation_version_id.clone(),
                )
            })?;
        // `successor_formation = inherit-predecessor` means that the target
        // train template is a slot, not an ownership binding.  In particular
        // an after-midnight rollover can legitimately have day offset 0 while
        // the physical formation rotates into a different static slot.  The
        // physical predecessor is validated against the target route below;
        // only the signed compatibility class represented here by the exact
        // formation length has to match between both slot templates.
        if predecessor_formation.performance.length_mm != successor_formation.performance.length_mm
        {
            return Err(OperationalRuntimeError::new(
                "invalid_movement_continuation_formation",
                template.id.clone(),
            ));
        }
        if template.daily_boundary {
            if boundary_outgoing_by_formation
                .insert(
                    predecessor.formation_version_id.as_str(),
                    predecessor.id.as_str(),
                )
                .is_some()
                || boundary_incoming_by_formation
                    .insert(
                        successor.formation_version_id.as_str(),
                        successor.id.as_str(),
                    )
                    .is_some()
            {
                return Err(OperationalRuntimeError::new(
                    "invalid_movement_continuation_daily_boundary",
                    template.id.clone(),
                ));
            }
        } else if predecessor.formation_version_id != successor.formation_version_id {
            return Err(OperationalRuntimeError::new(
                "invalid_movement_continuation_daily_boundary",
                template.id.clone(),
            ));
        }
        world
            .validate_movement_continuation_template(
                &template.id,
                &materialization_from_train_input(predecessor),
                &template.predecessor_base_route_version_id,
                &materialization_from_train_input(successor),
                &successor.dispatch_interlocking_route_id,
                template.continuity,
            )
            .map_err(|error| {
                OperationalRuntimeError::new(
                    "invalid_movement_continuation_physical_binding",
                    format!("{}: {error}", template.id),
                )
            })?;
    }
    if trains.iter().any(|train| {
        !outgoing.contains_key(train.id.as_str())
            || incoming.get(train.id.as_str()).copied() != Some(1)
    }) {
        return Err(OperationalRuntimeError::new(
            "incomplete_movement_continuation_graph",
            "jede Zugvorlage braucht genau eine eingehende und ausgehende Fortsetzung",
        ));
    }
    let used_formations = trains
        .iter()
        .map(|train| train.formation_version_id.as_str())
        .collect::<BTreeSet<_>>();
    if boundary_outgoing_by_formation.len() != used_formations.len()
        || boundary_incoming_by_formation.len() != used_formations.len()
        || used_formations.iter().any(|formation_id| {
            !boundary_outgoing_by_formation.contains_key(formation_id)
                || !boundary_incoming_by_formation.contains_key(formation_id)
        })
    {
        return Err(OperationalRuntimeError::new(
            "invalid_movement_continuation_daily_boundary",
            "jede statische Slotformation braucht genau eine ein- und ausgehende DailyPlan-Grenze",
        ));
    }
    let mut path_visited = BTreeSet::new();
    for formation_id in &used_formations {
        let mut cursor = boundary_incoming_by_formation[formation_id];
        let mut slot_visited = BTreeSet::new();
        let mut accumulated_day_offset = 0_u8;
        let mut has_passenger = false;
        loop {
            let current = train_by_id[cursor];
            if current.formation_version_id != **formation_id || !slot_visited.insert(cursor) {
                return Err(OperationalRuntimeError::new(
                    "invalid_movement_continuation_daily_boundary",
                    current.id.clone(),
                ));
            }
            has_passenger |= current.public_passenger_stop;
            let edge = outgoing[cursor];
            accumulated_day_offset = accumulated_day_offset
                .checked_add(edge.successor_day_offset)
                .ok_or_else(|| {
                    OperationalRuntimeError::new(
                        "invalid_movement_continuation_daily_boundary",
                        edge.id.clone(),
                    )
                })?;
            if edge.daily_boundary {
                if boundary_outgoing_by_formation[formation_id] != cursor
                    || accumulated_day_offset != 1
                    || !has_passenger
                {
                    return Err(OperationalRuntimeError::new(
                        "invalid_movement_continuation_daily_boundary",
                        edge.id.clone(),
                    ));
                }
                break;
            }
            cursor = edge.successor_train_id.as_str();
        }
        if trains
            .iter()
            .filter(|train| train.formation_version_id == **formation_id)
            .count()
            != slot_visited.len()
            || slot_visited
                .iter()
                .any(|train_id| !path_visited.insert(*train_id))
        {
            return Err(OperationalRuntimeError::new(
                "invalid_movement_continuation_daily_boundary",
                (*formation_id).to_owned(),
            ));
        }
    }
    if path_visited.len() != trains.len() {
        return Err(OperationalRuntimeError::new(
            "invalid_movement_continuation_daily_boundary",
            "DailyPlan-Pfade decken den Basisgraphen nicht exakt ab",
        ));
    }
    Ok((templates.len(), evidence))
}

/// Kanonischer nativer Payload-Hash fuer ein dauerhaftes externes
/// Idempotenzledger. Er verwendet exakt dieselbe typisierte Serde-Kanonform
/// wie die Receipt-Pruefung beim Anwenden eines Kommandos.
pub fn hash_operational_simulation_command(
    command_json: &str,
) -> Result<String, OperationalRuntimeError> {
    let command: CommandPayload = decode(command_json, "OperationalCommandPayload")?;
    command_hash(&command)
}

fn state_hash(
    initialization_hash: &str,
    infra_release: &InfrastructureBinding,
    world: &OperationalWorld,
    revision: u64,
    publisher_sequence: u64,
    command_receipts: &BTreeMap<String, CommandReceipt>,
) -> String {
    let mut hash = Sha256::new();
    hash.update(b"zugfolge-operational-runtime-state/v2\0");
    hash.update(initialization_hash.as_bytes());
    hash.update(
        serde_json::to_vec(infra_release)
            .expect("kompakte Operational-v2-Bindung ist immer serialisierbar"),
    );
    hash.update(world.state_hash().as_bytes());
    hash.update(revision.to_be_bytes());
    hash.update(publisher_sequence.to_be_bytes());
    hash.update(serde_json::to_vec(command_receipts).expect("BTreeMap serialization cannot fail"));
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn projections(
    world: &OperationalWorld,
) -> Result<(OperationalProjection, OperationalProjection), OperationalRuntimeError> {
    // Die native Commitgrenze liefert stets den vollstaendigen Regionskopf.
    // Sichtkorridorfilterung erfolgt erst im sequenzierten Streaming-Fanout;
    // aus einem leeren Startintervall darf kein Zug verschwinden.
    let visible_edges = Default::default();
    Ok((
        world
            .project(ProjectionKind::LiveMap, &visible_edges)
            .map_err(|error| {
                OperationalRuntimeError::new("projection_failed", error.to_string())
            })?,
        world
            .project(ProjectionKind::Rzue, &visible_edges)
            .map_err(|error| {
                OperationalRuntimeError::new("projection_failed", error.to_string())
            })?,
    ))
}

fn validate_state(state: &RuntimeState) -> Result<(), OperationalRuntimeError> {
    if state.schema_version != STATE_SCHEMA {
        return Err(OperationalRuntimeError::new(
            "unknown_state_schema",
            state.schema_version.clone(),
        ));
    }
    if !is_sha256(&state.initialization_hash) {
        return Err(OperationalRuntimeError::new(
            "invalid_initialization_hash",
            "persistierter v2-Zustand besitzt keine Initialisierungsbindung",
        ));
    }
    state.infra_release.validate()?;
    if state.world.infra_release_id != state.infra_release.infra_release_id {
        return Err(OperationalRuntimeError::new(
            "foreign_infrastructure_binding",
            "persistierter Weltzustand gehoert zu einer anderen Operational-v2-Infrastruktur",
        ));
    }
    if !state.world.events.is_empty() {
        return Err(OperationalRuntimeError::new(
            "non_compact_checkpoint",
            "persistierter v2-Zustand enthaelt Ereignislogbytes",
        ));
    }
    if !state.world.processed_command_ids.is_empty() {
        return Err(OperationalRuntimeError::new(
            "legacy_command_history_forbidden",
            "v2-RuntimeState darf keine unbeschraenkte Command-History im Weltzustand tragen",
        ));
    }
    if state.world.commit_sequence != state.revision || state.revision != state.publisher_sequence {
        return Err(OperationalRuntimeError::new(
            "commit_sequence_gap",
            "Commit-, Revisions- und Publishersequenz sind nicht identisch",
        ));
    }
    if !valid_command_receipt_window(&state.command_receipts, state.revision) {
        return Err(OperationalRuntimeError::new(
            "invalid_command_receipt_window",
            "persistierter v2-Zustand besitzt nicht das exakte begrenzte Idempotenzsuffix",
        ));
    }
    state.world.verify_invariants().map_err(|error| {
        OperationalRuntimeError::new("unsafe_persisted_state", error.to_string())
    })?;
    if state_hash(
        &state.initialization_hash,
        &state.infra_release,
        &state.world,
        state.revision,
        state.publisher_sequence,
        &state.command_receipts,
    ) != state.state_hash
    {
        return Err(OperationalRuntimeError::new(
            "state_hash_mismatch",
            "persistierter operativer Zustand wurde veraendert",
        ));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_command_receipt_window(
    receipts: &BTreeMap<String, CommandReceipt>,
    revision: u64,
) -> bool {
    let expected_count = usize::try_from(revision)
        .unwrap_or(usize::MAX)
        .min(MAX_COMMAND_RECEIPTS);
    if receipts.len() != expected_count {
        return false;
    }
    if expected_count == 0 {
        return true;
    }
    let oldest_revision = revision - u64::try_from(expected_count).unwrap() + 1;
    let mut revisions = BTreeSet::new();
    for (command_id, receipt) in receipts {
        if command_id.is_empty()
            || !is_sha256(&receipt.command_hash)
            || receipt.applied_revision < oldest_revision
            || receipt.applied_revision > revision
            || !revisions.insert(receipt.applied_revision)
        {
            return false;
        }
    }
    revisions.len() == expected_count
        && revisions.first() == Some(&oldest_revision)
        && revisions.last() == Some(&revision)
}

fn insert_bounded_command_receipt(
    receipts: &mut BTreeMap<String, CommandReceipt>,
    command_id: String,
    command_hash: String,
    applied_revision: u64,
) {
    receipts.insert(
        command_id,
        CommandReceipt {
            command_hash,
            applied_revision,
        },
    );
    while receipts.len() > MAX_COMMAND_RECEIPTS {
        let oldest = receipts
            .iter()
            .min_by(|(left_id, left), (right_id, right)| {
                (left.applied_revision, left_id.as_str())
                    .cmp(&(right.applied_revision, right_id.as_str()))
            })
            .map(|(command_id, _)| command_id.clone())
            .expect("uebergrosses Receiptfenster ist nicht leer");
        receipts.remove(&oldest);
    }
}

fn materialize(
    world: &mut OperationalWorld,
    train: TrainInput,
) -> Result<(), OperationalRuntimeError> {
    let TrainInput {
        id,
        train_number,
        operator_id,
        movement_kind,
        route_version_id,
        formation_version_id,
        head_route_mm,
        scheduled_departure_ms,
        public_passenger_stop,
        dispatch_interlocking_route_id,
        protection_mode_selection_runs,
    } = train;
    let materialization = TrainMaterialization {
        id,
        train_number,
        operator_id,
        movement_kind,
        route_version_id,
        formation_version_id,
        head_route_mm,
        scheduled_departure_ms,
        public_passenger_stop,
    };
    world
        .inspect_train_program_template_with_protection_modes(
            &materialization,
            &dispatch_interlocking_route_id,
            PROTECTION_MODE_SELECTION_POLICY_V1,
            &protection_mode_selection_runs,
        )
        .and_then(|predicates| {
            if predicates.is_valid() {
                world.materialize(materialization)
            } else {
                Err(OperationalError::InvalidProgramTemplate(
                    materialization.id.clone(),
                ))
            }
        })
        .map_err(operational_command_rejection)
}

fn operational_command_rejection(error: OperationalError) -> OperationalRuntimeError {
    match error {
        OperationalError::EventBudgetExceeded => OperationalRuntimeError::new(
            "operational_event_budget_exceeded",
            format!(
                "Kommando erzeugt mehr als {MAX_PENDING_OPERATIONAL_EVENTS} noch nicht abgenommene Fachereignisse"
            ),
        ),
        other => OperationalRuntimeError::new("operational_command_rejected", other.to_string()),
    }
}

fn execute(
    world: &mut OperationalWorld,
    command: CommandPayload,
) -> Result<(), OperationalRuntimeError> {
    let rejected = operational_command_rejection;
    match command {
        CommandPayload::Materialize { train } => materialize(world, train),
        CommandPayload::Retire { train_id } => world.retire_train(&train_id).map_err(rejected),
        CommandPayload::AdvanceTo { at_ms } => world.advance_to(at_ms).map_err(rejected),
        CommandPayload::Dispatch { requests } => world
            .submit_dispatch_requests(&requests)
            .map(|_| ())
            .map_err(rejected),
        CommandPayload::PlanMotion { train_id } => {
            world.plan_motion(&train_id).map(|_| ()).map_err(rejected)
        }
        CommandPayload::SafeStop { train_id, reason } => {
            world.safe_stop(&train_id, &reason).map_err(rejected)
        }
        CommandPayload::ChangeFormation {
            train_id,
            formation_id,
            vehicle_ids,
        } => world
            .change_formation(&train_id, formation_id, vehicle_ids)
            .map_err(rejected),
        CommandPayload::Reroute {
            train_id,
            route_version_id,
        } => world
            .reroute_train(&train_id, &route_version_id)
            .map_err(rejected),
        CommandPayload::QueueMovementContinuation { continuation } => world
            .queue_movement_continuation(continuation)
            .map_err(rejected),
        CommandPayload::AutomaticShunting { need } => world
            .execute_automatic_shunting(&need)
            .map(|_| ())
            .map_err(rejected),
        CommandPayload::ActivateDisruption {
            disruption_id,
            effect,
        } => world
            .activate_disruption(disruption_id, effect)
            .map_err(rejected),
        CommandPayload::ClearDisruption {
            disruption_id,
            release_reference,
        } => world
            .clear_disruption(&disruption_id, &release_reference)
            .map_err(rejected),
    }
}

fn inspect_program_template(
    world: &OperationalWorld,
    train: &TrainInput,
    protection_mode_selection_policy: &str,
) -> Result<OperationalProgramTemplatePredicates, OperationalRuntimeError> {
    let materialization = TrainMaterialization {
        id: train.id.clone(),
        train_number: train.train_number.clone(),
        operator_id: train.operator_id.clone(),
        movement_kind: train.movement_kind,
        route_version_id: train.route_version_id.clone(),
        formation_version_id: train.formation_version_id.clone(),
        head_route_mm: train.head_route_mm,
        scheduled_departure_ms: train.scheduled_departure_ms,
        public_passenger_stop: train.public_passenger_stop,
    };
    world
        .inspect_train_program_template_with_protection_modes(
            &materialization,
            &train.dispatch_interlocking_route_id,
            protection_mode_selection_policy,
            &train.protection_mode_selection_runs,
        )
        .map_err(|error| {
            OperationalRuntimeError::new("invalid_train_program_template", error.to_string())
        })
}

pub fn initialize_operational_simulation(
    input_json: &str,
    resolved_infrastructure_path: &str,
) -> Result<String, OperationalRuntimeError> {
    reject_json_over_budget(
        input_json,
        MAX_INITIALIZATION_JSON_BYTES,
        "operational_initialization_budget_exceeded",
        "OperationalInitialization",
    )?;
    let raw_input: Value = decode(input_json, "OperationalInitialization")?;
    let initialization_hash = operational_initialization_hash(&raw_input).map_err(|detail| {
        OperationalRuntimeError::new("invalid_initialization_hash_input", detail)
    })?;
    let input: Initialization = decode(input_json, "OperationalInitialization")?;
    if input.schema_version != INITIALIZE_SCHEMA {
        return Err(OperationalRuntimeError::new(
            "unknown_initialize_schema",
            input.schema_version,
        ));
    }
    if input.protection_mode_selection_policy != PROTECTION_MODE_SELECTION_POLICY_V1 {
        return Err(OperationalRuntimeError::new(
            "unknown_protection_mode_selection_policy",
            input.protection_mode_selection_policy,
        ));
    }
    let infrastructure_binding = input.infra_release.clone();
    let infrastructure =
        infrastructure_for_binding(&infrastructure_binding, resolved_infrastructure_path)?;
    let mut world = OperationalWorld::new_with_infrastructure(
        input.world_id,
        input.region_id,
        input.now_ms,
        infrastructure,
    )
    .map_err(|error| {
        OperationalRuntimeError::new("invalid_operational_release", error.to_string())
    })?;
    for input in input.vehicle_types {
        world
            .register_vehicle_type(input.vehicle_type, input.powered)
            .map_err(|error| {
                OperationalRuntimeError::new("invalid_vehicle_type", error.to_string())
            })?;
    }
    for vehicle in input.vehicles {
        world
            .register_vehicle(vehicle)
            .map_err(|error| OperationalRuntimeError::new("invalid_vehicle", error.to_string()))?;
    }
    for formation in input.formations {
        world
            .create_formation(
                formation.id,
                formation.predecessor_id,
                formation.vehicle_ids,
            )
            .map_err(|error| {
                OperationalRuntimeError::new("invalid_formation", error.to_string())
            })?;
    }
    let program_train_count = input.trains.len();
    let validated_train_numbers = input
        .trains
        .iter()
        .map(|train| {
            operational_train_number_numeric_part(&train.train_number).ok_or_else(|| {
                OperationalRuntimeError::new(
                    "invalid_train_number",
                    format!("{}: {}", train.id, train.train_number),
                )
            })
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if validated_train_numbers.len() != program_train_count {
        return Err(OperationalRuntimeError::new(
            "duplicate_train_number",
            "Operational-v2-Zugprogramm enthaelt doppelte numerische Zugnummern",
        ));
    }
    let validated_route_version_count = input
        .trains
        .iter()
        .map(|train| train.route_version_id.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    let validated_dispatch_interlocking_route_count = input
        .trains
        .iter()
        .map(|train| train.dispatch_interlocking_route_id.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    let validated_formation_binding_count = input
        .trains
        .iter()
        .map(|train| train.formation_version_id.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    let mut validated_resource_binding_count = 0_usize;
    let mut validated_protection_mode_selection_count = 0_usize;
    let mut invalid_program_templates = Vec::new();
    for train in &input.trains {
        match inspect_program_template(&world, train, &input.protection_mode_selection_policy) {
            Ok(predicates) if predicates.is_valid() => {
                validated_resource_binding_count = validated_resource_binding_count
                    .checked_add(predicates.resource_binding_count)
                    .ok_or_else(|| {
                        OperationalRuntimeError::new(
                            "initialization_validation_count_overflow",
                            "Ressourcenbindungen der Programmvorlagen sind nicht zaehlbar",
                        )
                    })?;
                validated_protection_mode_selection_count =
                    validated_protection_mode_selection_count
                        .checked_add(predicates.protection_mode_selection_count)
                        .ok_or_else(|| {
                            OperationalRuntimeError::new(
                                "initialization_validation_count_overflow",
                                "Zugsicherungsmodus-Auswahlen sind nicht zaehlbar",
                            )
                        })?;
            }
            Ok(predicates) => invalid_program_templates.push(format!(
                "{}=[{}]",
                train.id,
                predicates.failed_predicates().join(",")
            )),
            Err(error) => invalid_program_templates.push(format!("{}=[{error}]", train.id)),
        }
    }
    if !invalid_program_templates.is_empty() {
        return Err(OperationalRuntimeError::new(
            "invalid_train_program_template",
            format!(
                "{} von {} Programmvorlagen ungueltig: {}",
                invalid_program_templates.len(),
                program_train_count,
                invalid_program_templates.join(";")
            ),
        ));
    }
    let (protection_mode_selection_count, protection_mode_selections_sha256) =
        protection_mode_selection_evidence(&input.trains)?;
    if protection_mode_selection_count != validated_protection_mode_selection_count {
        return Err(OperationalRuntimeError::new(
            "protection_mode_selection_evidence_mismatch",
            "Kanonischer Zugsicherungsbeleg und vollstaendiger Predicate-Scan weichen ab",
        ));
    }
    let (validated_movement_continuation_count, movement_continuations_sha256) =
        validate_movement_continuation_templates(
            &world,
            &input.trains,
            input.repeat_every_ms,
            &input.movement_continuations,
        )?;
    world
        .verify_invariants()
        .map_err(|error| OperationalRuntimeError::new("unsafe_initial_state", error.to_string()))?;
    let events = std::mem::take(&mut world.events);
    let command_receipts = BTreeMap::new();
    let hash = state_hash(
        &initialization_hash,
        &infrastructure_binding,
        &world,
        0,
        0,
        &command_receipts,
    );
    let state = RuntimeState {
        schema_version: STATE_SCHEMA.to_owned(),
        initialization_hash: initialization_hash.clone(),
        infra_release: infrastructure_binding,
        world,
        revision: 0,
        publisher_sequence: 0,
        state_hash: hash.clone(),
        command_receipts,
    };
    let validation_receipt = InitializationValidationReceipt {
        schema_version: INITIALIZATION_VALIDATION_RECEIPT_SCHEMA,
        world_id: state.world.world_id.clone(),
        region_id: state.world.region_id.clone(),
        initialization_hash: initialization_hash.clone(),
        state_hash: hash.clone(),
        infra_release: state.infra_release.clone(),
        program_train_count,
        validated_program_template_count: program_train_count,
        validated_route_version_count,
        validated_dispatch_interlocking_route_count,
        validated_resource_binding_count,
        validated_formation_binding_count,
        validated_train_number_count: validated_train_numbers.len(),
        protection_mode_selection_policy: PROTECTION_MODE_SELECTION_POLICY_V1,
        validated_protection_mode_selection_count,
        protection_mode_selections_sha256,
        validated_movement_continuation_count,
        movement_continuations_sha256,
        dynamic_train_count: state.world.trains.len(),
        resource_bindings_validated: true,
        formation_bindings_validated: true,
        train_numbers_validated: true,
        protection_mode_selections_validated: true,
        validation_mode: INFRASTRUCTURE_VALIDATION_MODE,
    };
    ensure_encoded_within_budget(
        &state,
        MAX_OPERATIONAL_STATE_JSON_BYTES,
        "operational_initialized_state_budget_exceeded",
        "OperationalState",
    )?;
    let (live_map, rzue) = projections(&state.world)?;
    encode_with_budget(
        &InitializedResult {
            schema_version: INITIALIZED_SCHEMA,
            events,
            state,
            initialization_hash,
            state_hash: hash,
            live_map,
            rzue,
            validation_receipt,
        },
        MAX_BATCH_RESULT_JSON_BYTES,
        "operational_initialized_result_budget_exceeded",
    )
}

pub fn restore_operational_simulation(
    input_json: &str,
    resolved_infrastructure_path: &str,
) -> Result<String, OperationalRuntimeError> {
    reject_json_over_budget(
        input_json,
        MAX_RESTORE_JSON_BYTES,
        "operational_restore_budget_exceeded",
        "OperationalRestore",
    )?;
    let raw_envelope: Value = decode(input_json, "OperationalRestore")?;
    reject_embedded_static_infrastructure(raw_envelope.pointer("/state/world"))?;
    let envelope: RestoreEnvelope = decode(input_json, "OperationalRestore")?;
    if envelope.schema_version != RESTORE_SCHEMA {
        return Err(OperationalRuntimeError::new(
            "unknown_restore_schema",
            envelope.schema_version,
        ));
    }
    if !is_sha256(&envelope.expected_initialization_hash) {
        return Err(OperationalRuntimeError::new(
            "invalid_expected_initialization_hash",
            "Restore besitzt keine gueltige erwartete Initialisierungsbindung",
        ));
    }
    let mut state = envelope.state;
    validate_state(&state)?;
    ensure_encoded_within_budget(
        &state,
        MAX_OPERATIONAL_STATE_JSON_BYTES,
        "operational_restore_state_budget_exceeded",
        "OperationalState",
    )?;
    if envelope.expected_initialization_hash != state.initialization_hash {
        return Err(OperationalRuntimeError::new(
            "initialization_hash_mismatch",
            "persistierter Zustand gehoert zu einer anderen Initialisierung",
        ));
    }
    let infrastructure =
        infrastructure_for_binding(&state.infra_release, resolved_infrastructure_path)?;
    state
        .world
        .attach_infrastructure(infrastructure)
        .map_err(|error| {
            OperationalRuntimeError::new("infrastructure_attachment_failed", error.to_string())
        })?;
    let (live_map, rzue) = projections(&state.world)?;
    encode_with_budget(
        &RestoredResult {
            schema_version: RESTORED_SCHEMA,
            initialization_hash: state.initialization_hash.clone(),
            state_hash: state.state_hash.clone(),
            state,
            live_map,
            rzue,
        },
        MAX_BATCH_RESULT_JSON_BYTES,
        "operational_restored_result_budget_exceeded",
    )
}

pub fn apply_operational_simulation_command(
    state_json: &str,
    command_json: &str,
    resolved_infrastructure_path: &str,
) -> Result<String, OperationalRuntimeError> {
    reject_json_over_budget(
        state_json,
        MAX_OPERATIONAL_STATE_JSON_BYTES,
        "operational_command_state_budget_exceeded",
        "OperationalState",
    )?;
    reject_json_over_budget(
        command_json,
        MAX_COMMAND_JSON_BYTES,
        "operational_command_budget_exceeded",
        "OperationalCommand",
    )?;
    let raw_state: Value = decode(state_json, "OperationalState")?;
    reject_embedded_static_infrastructure(raw_state.get("world"))?;
    let mut state: RuntimeState = decode(state_json, "OperationalState")?;
    validate_state(&state)?;
    let infrastructure =
        infrastructure_for_binding(&state.infra_release, resolved_infrastructure_path)?;
    state
        .world
        .attach_infrastructure(infrastructure)
        .map_err(|error| {
            OperationalRuntimeError::new("infrastructure_attachment_failed", error.to_string())
        })?;
    let envelope: CommandEnvelope = decode(command_json, "OperationalCommand")?;
    if envelope.schema_version != COMMAND_SCHEMA {
        return Err(OperationalRuntimeError::new(
            "unknown_command_schema",
            envelope.schema_version,
        ));
    }
    if envelope.world_id != state.world.world_id || envelope.region_id != state.world.region_id {
        return Err(OperationalRuntimeError::new(
            "world_region_mismatch",
            "Kommando gehoert nicht zu diesem Single-Writer",
        ));
    }
    let receipt_hash = command_hash(&envelope.command)?;
    if let Some(existing) = state.command_receipts.get(&envelope.command_id) {
        if existing.command_hash != receipt_hash {
            return Err(OperationalRuntimeError::new(
                "idempotency_conflict",
                envelope.command_id,
            ));
        }
        let (live_map, rzue) = projections(&state.world)?;
        return encode_with_budget(
            &CommandResult {
                schema_version: RESULT_SCHEMA,
                initialization_hash: state.initialization_hash.clone(),
                state_hash: state.state_hash.clone(),
                state,
                live_map,
                rzue,
                events: Vec::new(),
                applied_command_id: envelope.command_id,
                idempotent_replay: true,
            },
            MAX_BATCH_RESULT_JSON_BYTES,
            "operational_command_result_budget_exceeded",
        );
    }
    if envelope.expected_state_hash != state.state_hash
        || envelope.expected_revision != state.revision
        || envelope.expected_publisher_sequence != state.publisher_sequence
    {
        return Err(OperationalRuntimeError::new(
            "optimistic_concurrency_conflict",
            "Hash, Revision oder Publishersequenz ist veraltet",
        ));
    }
    execute(&mut state.world, envelope.command)?;
    state.world.commit_runtime_command().map_err(|error| {
        OperationalRuntimeError::new("commit_sequence_exhausted", error.to_string())
    })?;
    state
        .world
        .verify_invariants()
        .map_err(|error| OperationalRuntimeError::new("unsafe_result_state", error.to_string()))?;
    state.revision = state.revision.checked_add(1).ok_or_else(|| {
        OperationalRuntimeError::new("revision_exhausted", "operative Revision ist erschoepft")
    })?;
    state.publisher_sequence = state.publisher_sequence.checked_add(1).ok_or_else(|| {
        OperationalRuntimeError::new(
            "publisher_sequence_exhausted",
            "operative Publishersequenz ist erschoepft",
        )
    })?;
    insert_bounded_command_receipt(
        &mut state.command_receipts,
        envelope.command_id.clone(),
        receipt_hash,
        state.revision,
    );
    state.state_hash = state_hash(
        &state.initialization_hash,
        &state.infra_release,
        &state.world,
        state.revision,
        state.publisher_sequence,
        &state.command_receipts,
    );
    let events = std::mem::take(&mut state.world.events);
    ensure_encoded_within_budget(
        &state,
        MAX_OPERATIONAL_STATE_JSON_BYTES,
        "operational_command_result_state_budget_exceeded",
        "OperationalState",
    )?;
    let (live_map, rzue) = projections(&state.world)?;
    encode_with_budget(
        &CommandResult {
            schema_version: RESULT_SCHEMA,
            initialization_hash: state.initialization_hash.clone(),
            state_hash: state.state_hash.clone(),
            state,
            live_map,
            rzue,
            events,
            applied_command_id: envelope.command_id,
            idempotent_replay: false,
        },
        MAX_BATCH_RESULT_JSON_BYTES,
        "operational_command_result_budget_exceeded",
    )
}

fn command_batch_failure(
    command_index: usize,
    command_id: &str,
    error: OperationalRuntimeError,
) -> OperationalRuntimeError {
    OperationalRuntimeError::new(
        "operational_batch_command_failed",
        format!(
            "index={command_index}, commandId={command_id:?}, causeCode={}",
            error.code
        ),
    )
}

fn ensure_batch_event_budget(
    accumulated_events: usize,
    command_events: usize,
    command_index: usize,
    command_id: &str,
) -> Result<(), OperationalRuntimeError> {
    let event_count = accumulated_events
        .checked_add(command_events)
        .ok_or_else(|| {
            OperationalRuntimeError::new(
                "operational_batch_event_budget_exceeded",
                format!(
                    "index={command_index}, commandId={command_id:?}: Ereigniszahl ist nicht zaehlbar"
                ),
            )
        })?;
    if event_count > MAX_BATCH_EVENTS {
        return Err(OperationalRuntimeError::new(
            "operational_batch_event_budget_exceeded",
            format!(
                "index={command_index}, commandId={command_id:?}: {event_count} Ereignisse ueberschreiten das Batchlimit {MAX_BATCH_EVENTS}"
            ),
        ));
    }
    Ok(())
}

fn command_batch_event_context(
    command_index: usize,
    command_id: &str,
    command: &CommandPayload,
    disruption_effect_before: Option<OperationalDisruption>,
    events: &[OperationalEvent],
    world: &OperationalWorld,
) -> Result<Option<CommandBatchEventContext>, OperationalRuntimeError> {
    let disruption_events = events
        .iter()
        .filter(|event| event.kind == "disruption-activated" || event.kind == "disruption-cleared")
        .collect::<Vec<_>>();
    if disruption_events.is_empty() {
        return Ok(None);
    }
    let disruption_id = match command {
        CommandPayload::ActivateDisruption { disruption_id, .. }
        | CommandPayload::ClearDisruption { disruption_id, .. } => disruption_id,
        _ => {
            return Err(OperationalRuntimeError::new(
                "batch_event_context_mismatch",
                "Stoerungsereignis besitzt kein Stoerungskommando",
            ));
        }
    };
    if disruption_events.iter().any(|event| {
        event.commit_sequence != world.commit_sequence || event.subject_id != *disruption_id
    }) {
        return Err(OperationalRuntimeError::new(
            "batch_event_context_mismatch",
            "Stoerungsereignis stimmt nicht mit seinem Batchcommit ueberein",
        ));
    }
    if matches!(command, CommandPayload::ClearDisruption { .. })
        && disruption_effect_before.is_none()
    {
        return Err(OperationalRuntimeError::new(
            "batch_event_context_mismatch",
            "Stoerungsfreigabe besitzt keine gebundene Vorwirkung",
        ));
    }
    let affected_train_run_ids = events
        .iter()
        .filter(|event| world.trains.contains_key(&event.subject_id))
        .map(|event| event.subject_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok(Some(CommandBatchEventContext {
        command_index,
        command_id: command_id.to_owned(),
        commit_sequence: world.commit_sequence,
        affected_train_run_ids,
        disruption_effect_before,
    }))
}

/// Wendet eine begrenzte Kommandofolge atomar in genau einer nativen
/// Zustandsdekodierung und Infrastrukturbindung an. Ein Fehler verwirft den
/// gesamten lokalen Zwischenzustand; erst der Aufrufer darf den Endkopf per
/// Datenbank-CAS persistieren.
pub fn apply_operational_simulation_command_batch(
    state_json: &str,
    batch_json: &str,
    resolved_infrastructure_path: &str,
) -> Result<String, OperationalRuntimeError> {
    reject_json_over_budget(
        state_json,
        MAX_BATCH_STATE_JSON_BYTES,
        "operational_batch_state_budget_exceeded",
        "OperationalState",
    )?;
    reject_json_over_budget(
        batch_json,
        MAX_BATCH_JSON_BYTES,
        "operational_batch_input_budget_exceeded",
        "OperationalCommandBatch",
    )?;
    let raw_state: Value = decode(state_json, "OperationalState")?;
    reject_embedded_static_infrastructure(raw_state.get("world"))?;
    let mut state: RuntimeState = decode(state_json, "OperationalState")?;
    validate_state(&state)?;
    let infrastructure =
        infrastructure_for_binding(&state.infra_release, resolved_infrastructure_path)?;
    state
        .world
        .attach_infrastructure(infrastructure)
        .map_err(|error| {
            OperationalRuntimeError::new("infrastructure_attachment_failed", error.to_string())
        })?;
    let batch: CommandBatchEnvelope = decode(batch_json, "OperationalCommandBatch")?;
    if batch.schema_version != COMMAND_BATCH_SCHEMA {
        return Err(OperationalRuntimeError::new(
            "unknown_command_batch_schema",
            batch.schema_version,
        ));
    }
    if batch.commands.is_empty() || batch.commands.len() > MAX_COMMAND_BATCH_SIZE {
        return Err(OperationalRuntimeError::new(
            "invalid_command_batch_size",
            format!(
                "operative Kommandogruppe muss 1 bis {MAX_COMMAND_BATCH_SIZE} Eintraege enthalten"
            ),
        ));
    }
    if batch.world_id != state.world.world_id || batch.region_id != state.world.region_id {
        return Err(OperationalRuntimeError::new(
            "world_region_mismatch",
            "Kommandogruppe gehoert nicht zu diesem Single-Writer",
        ));
    }
    if batch.expected_state_hash != state.state_hash
        || batch.expected_revision != state.revision
        || batch.expected_publisher_sequence != state.publisher_sequence
    {
        return Err(OperationalRuntimeError::new(
            "optimistic_concurrency_conflict",
            "Batchbasis fuer Hash, Revision oder Publishersequenz ist veraltet",
        ));
    }

    let mut events = Vec::new();
    let mut command_results = Vec::with_capacity(batch.commands.len());
    let mut event_contexts = Vec::new();
    for (command_index, item) in batch.commands.into_iter().enumerate() {
        let receipt_hash = command_hash(&item.command)
            .map_err(|error| command_batch_failure(command_index, &item.command_id, error))?;
        if let Some(existing) = state.command_receipts.get(&item.command_id) {
            if existing.command_hash != receipt_hash {
                return Err(command_batch_failure(
                    command_index,
                    &item.command_id,
                    OperationalRuntimeError::new("idempotency_conflict", &item.command_id),
                ));
            }
            command_results.push(CommandBatchItemResult {
                command_id: item.command_id,
                idempotent_replay: true,
            });
            continue;
        }

        let disruption_effect_before = match &item.command {
            CommandPayload::ClearDisruption { disruption_id, .. } => {
                state.world.active_disruptions.get(disruption_id).cloned()
            }
            _ => None,
        };
        execute(&mut state.world, item.command.clone())
            .map_err(|error| command_batch_failure(command_index, &item.command_id, error))?;
        state.world.commit_runtime_command().map_err(|error| {
            command_batch_failure(
                command_index,
                &item.command_id,
                OperationalRuntimeError::new("commit_sequence_exhausted", error.to_string()),
            )
        })?;
        state.world.verify_invariants().map_err(|error| {
            command_batch_failure(
                command_index,
                &item.command_id,
                OperationalRuntimeError::new("unsafe_result_state", error.to_string()),
            )
        })?;
        state.revision = state.revision.checked_add(1).ok_or_else(|| {
            command_batch_failure(
                command_index,
                &item.command_id,
                OperationalRuntimeError::new(
                    "revision_exhausted",
                    "operative Revision ist erschoepft",
                ),
            )
        })?;
        state.publisher_sequence = state.publisher_sequence.checked_add(1).ok_or_else(|| {
            command_batch_failure(
                command_index,
                &item.command_id,
                OperationalRuntimeError::new(
                    "publisher_sequence_exhausted",
                    "operative Publishersequenz ist erschoepft",
                ),
            )
        })?;
        insert_bounded_command_receipt(
            &mut state.command_receipts,
            item.command_id.clone(),
            receipt_hash,
            state.revision,
        );
        let command_events = std::mem::take(&mut state.world.events);
        ensure_batch_event_budget(
            events.len(),
            command_events.len(),
            command_index,
            &item.command_id,
        )?;
        if let Some(context) = command_batch_event_context(
            command_index,
            &item.command_id,
            &item.command,
            disruption_effect_before,
            &command_events,
            &state.world,
        )
        .map_err(|error| command_batch_failure(command_index, &item.command_id, error))?
        {
            event_contexts.push(context);
        }
        events.extend(command_events);
        command_results.push(CommandBatchItemResult {
            command_id: item.command_id,
            idempotent_replay: false,
        });
    }
    // Der Zwischenhash ist innerhalb der atomaren nativen Ausfuehrung nicht
    // beobachtbar. Ihn erst fuer den finalen CAS-Kopf zu bilden vermeidet bei
    // einem Catch-up tausende Vollzustands-Serialisierungen.
    state.state_hash = state_hash(
        &state.initialization_hash,
        &state.infra_release,
        &state.world,
        state.revision,
        state.publisher_sequence,
        &state.command_receipts,
    );
    validate_state(&state)?;
    ensure_encoded_within_budget(
        &state,
        MAX_BATCH_STATE_JSON_BYTES,
        "operational_batch_result_state_budget_exceeded",
        "OperationalState",
    )?;
    let (live_map, rzue) = projections(&state.world)?;
    encode_with_budget(
        &CommandBatchResult {
            schema_version: BATCH_RESULT_SCHEMA,
            initialization_hash: state.initialization_hash.clone(),
            state_hash: state.state_hash.clone(),
            state,
            live_map,
            rzue,
            events,
            command_results,
            event_contexts,
        },
        MAX_BATCH_RESULT_JSON_BYTES,
        "operational_batch_result_budget_exceeded",
    )
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::{Value, json};
    use zugfolge_infra::validate_operational_infrastructure_v2_file;
    use zugfolge_sim::operational::{
        Direction, EdgeGeometryPoint, InterlockingRouteTemplate, OperationalInfraRelease,
        PhysicalVehicle, RouteLeg, RouteVersion, TrackInterval, VehicleCondition,
    };

    use super::*;

    fn set(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    static TEST_INFRASTRUCTURE: OnceLock<(InfrastructureBinding, String)> = OnceLock::new();
    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    fn materialize_infrastructure_fixture(
        release: &OperationalInfraRelease,
    ) -> (InfrastructureBinding, String) {
        let directory = loop {
            let candidate = std::env::temp_dir().join(format!(
                "zugfolge-sim-runtime-{}-{}",
                std::process::id(),
                NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&candidate) {
                Ok(()) => break candidate,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("Testverzeichnis kann nicht angelegt werden: {error}"),
            }
        };
        let candidate_path = directory.join("candidate.json");
        let deployed_path = directory.join(INFRASTRUCTURE_FILE);
        std::fs::write(
            &candidate_path,
            serde_json::to_vec(release).expect("Testrelease ist serialisierbar"),
        )
        .expect("Testrelease kann geschrieben werden");
        let evidence = validate_operational_infrastructure_v2_file(
            &candidate_path,
            &release.id,
            Some(&deployed_path),
        )
        .expect("Testrelease ist operational-v2-gueltig");
        (
            InfrastructureBinding {
                schema_version: INFRASTRUCTURE_BINDING_SCHEMA.to_owned(),
                infra_release_id: release.id.clone(),
                file: INFRASTRUCTURE_FILE.to_owned(),
                bytes: evidence["bytes"].as_u64().expect("Bytebeleg"),
                sha256: evidence["sha256"].as_str().expect("SHA-Beleg").to_owned(),
                state_hash: evidence["stateHash"]
                    .as_str()
                    .expect("Zustandshash-Beleg")
                    .to_owned(),
            },
            deployed_path
                .to_str()
                .expect("Testpfad ist UTF-8")
                .to_owned(),
        )
    }

    fn infrastructure_fixture(
        release: &OperationalInfraRelease,
    ) -> &'static (InfrastructureBinding, String) {
        TEST_INFRASTRUCTURE.get_or_init(|| materialize_infrastructure_fixture(release))
    }

    fn infrastructure_path() -> &'static str {
        TEST_INFRASTRUCTURE
            .get()
            .expect("initialization() materialisiert zuerst das Testrelease")
            .1
            .as_str()
    }

    fn initialize_operational_simulation(
        input_json: &str,
    ) -> Result<String, OperationalRuntimeError> {
        super::initialize_operational_simulation(input_json, infrastructure_path())
    }

    fn restore_operational_simulation(input_json: &str) -> Result<String, OperationalRuntimeError> {
        super::restore_operational_simulation(input_json, infrastructure_path())
    }

    fn apply_operational_simulation_command(
        state_json: &str,
        command_json: &str,
    ) -> Result<String, OperationalRuntimeError> {
        super::apply_operational_simulation_command(state_json, command_json, infrastructure_path())
    }

    fn apply_operational_simulation_command_batch(
        state_json: &str,
        batch_json: &str,
    ) -> Result<String, OperationalRuntimeError> {
        super::apply_operational_simulation_command_batch(
            state_json,
            batch_json,
            infrastructure_path(),
        )
    }

    fn initialization() -> Initialization {
        let route = RouteVersion {
            id: "route:v1".to_owned(),
            template_id: "template:v1".to_owned(),
            predecessor_id: None,
            transition_route_mm: None,
            legs: vec![RouteLeg {
                edge_id: "edge:1".to_owned(),
                direction: Direction::Along,
                edge_entry_mm: 0,
                edge_exit_mm: 100_000,
                route_start_mm: 0,
                block_ids: set(&["block:1"]),
                speed_limit_mmps: 20_000,
                gradient_per_mille: 0,
                available_protection_systems: vec!["pzb".to_owned()],
                simultaneously_required_protection_systems: Vec::new(),
            }],
        };
        let interlocking = InterlockingRouteTemplate {
            id: "interlocking:1".to_owned(),
            route_template_id: "template:v1".to_owned(),
            authority_start_route_mm: 0,
            signal_id: "signal:1".to_owned(),
            movement_kind: MovementKind::Train,
            path_resources: set(&["block:1"]),
            overlap_resources: set(&["overlap:1"]),
            flank_resources: set(&["flank:1"]),
            switch_positions: BTreeMap::from([("switch:1".to_owned(), "straight".to_owned())]),
            authority_end_route_mm: 100_000,
            release_after_tail_route_mm: 100_000,
        };
        Initialization {
            schema_version: INITIALIZE_SCHEMA.to_owned(),
            world_id: "world:1".to_owned(),
            region_id: "region:1".to_owned(),
            now_ms: 0,
            protection_mode_selection_policy: PROTECTION_MODE_SELECTION_POLICY_V1.to_owned(),
            infra_release: infrastructure_fixture(&OperationalInfraRelease {
                id: "infra:v2".to_owned(),
                directed_edges: BTreeMap::from([("edge:1".to_owned(), 100_000)]),
                edge_geometries: BTreeMap::from([(
                    "edge:1".to_owned(),
                    vec![
                        EdgeGeometryPoint {
                            edge_offset_mm: 0,
                            latitude_e7: 510_000_000,
                            longitude_e7: 120_000_000,
                            bearing_milli_degrees: Some(90_000),
                        },
                        EdgeGeometryPoint {
                            edge_offset_mm: 100_000,
                            latitude_e7: 510_000_000,
                            longitude_e7: 120_100_000,
                            bearing_milli_degrees: None,
                        },
                    ],
                )]),
                route_versions: BTreeMap::from([(route.id.clone(), route)]),
                interlocking_routes: BTreeMap::from([(interlocking.id.clone(), interlocking)]),
                signals: set(&["signal:1"]),
                switches: set(&["switch:1"]),
                block_resources: set(&["block:1", "overlap:1", "flank:1"]),
                platform_intervals: BTreeMap::from([(
                    "platform:1".to_owned(),
                    TrackInterval {
                        edge_id: "edge:1".to_owned(),
                        from_mm: 10_000,
                        to_mm: 30_000,
                        direction: Direction::Along,
                    },
                )]),
                region_boundaries: set(&["boundary:1"]),
                rzue_layout_id: "rzue:v1".to_owned(),
            })
            .0
            .clone(),
            vehicle_types: vec![VehicleTypeInput {
                powered: true,
                vehicle_type: VehicleType {
                    id: "type:1".to_owned(),
                    role: None,
                    control_stands: None,
                    traction: None,
                    electric_systems: None,
                    length_mm: 10_000,
                    mass_kg: 80_000,
                    maximum_speed_mmps: 20_000,
                    power_watts: 4_000_000,
                    starting_tractive_force_newtons: 200_000,
                    raw_formation_dynamics: None,
                    maximum_acceleration_mmps2: 1_000,
                    service_brake_mmps2: 1_000,
                    emergency_brake_mmps2: 1_500,
                    protection_systems: set(&["pzb"]),
                },
            }],
            vehicles: vec![PhysicalVehicle {
                id: "vehicle:1".to_owned(),
                type_id: "type:1".to_owned(),
                powered: true,
                orientation: Direction::Along,
                condition: VehicleCondition {
                    mechanics_basis_points: 9_500,
                    drive_basis_points: 9_500,
                    brakes_basis_points: 9_500,
                    kilometres_since_maintenance: 0,
                    operating_hours_since_maintenance: 0,
                    open_observations: 0,
                },
                restrictions: BTreeMap::new(),
                history: Vec::new(),
            }],
            formations: vec![FormationInput {
                id: "formation:1".to_owned(),
                predecessor_id: None,
                vehicle_ids: vec!["vehicle:1".to_owned()],
            }],
            trains: vec![TrainInput {
                id: "train:1".to_owned(),
                train_number: "RB 1".to_owned(),
                operator_id: "operator:1".to_owned(),
                movement_kind: MovementKind::Train,
                route_version_id: "route:v1".to_owned(),
                formation_version_id: "formation:1".to_owned(),
                head_route_mm: 0,
                scheduled_departure_ms: None,
                public_passenger_stop: false,
                dispatch_interlocking_route_id: "interlocking:1".to_owned(),
                protection_mode_selection_runs: vec![ProtectionModeSelectionRun {
                    through_route_leg_index: 0,
                    selected_protection_system: "pzb".to_owned(),
                }],
            }],
            repeat_every_ms: None,
            movement_continuations: Vec::new(),
        }
    }

    fn movement_graph_fixture() -> (
        OperationalWorld,
        Vec<TrainInput>,
        Vec<MovementContinuationTemplateInput>,
    ) {
        let leg = |edge_id: &str,
                   edge_entry_mm: i64,
                   edge_exit_mm: i64,
                   route_start_mm: i64,
                   block_id: &str| RouteLeg {
            edge_id: edge_id.to_owned(),
            direction: Direction::Along,
            edge_entry_mm,
            edge_exit_mm,
            route_start_mm,
            block_ids: set(&[block_id]),
            speed_limit_mmps: 20_000,
            gradient_per_mille: 0,
            available_protection_systems: vec!["pzb".to_owned()],
            simultaneously_required_protection_systems: Vec::new(),
        };
        let routes = BTreeMap::from([
            (
                "route:graph:a".to_owned(),
                RouteVersion {
                    id: "route:graph:a".to_owned(),
                    template_id: "template:graph:a".to_owned(),
                    predecessor_id: Some("route:graph:b".to_owned()),
                    transition_route_mm: Some(10_000),
                    legs: vec![
                        leg("edge:graph:b", 0, 10_000, 0, "block:graph:a-seed"),
                        leg("edge:graph:a", 10_000, 20_000, 10_000, "block:graph:a-exit"),
                    ],
                },
            ),
            (
                "route:graph:b".to_owned(),
                RouteVersion {
                    id: "route:graph:b".to_owned(),
                    template_id: "template:graph:b".to_owned(),
                    predecessor_id: Some("route:graph:a".to_owned()),
                    transition_route_mm: Some(10_000),
                    legs: vec![
                        leg("edge:graph:a", 10_000, 20_000, 0, "block:graph:b-seed"),
                        leg("edge:graph:b", 0, 10_000, 10_000, "block:graph:b-exit"),
                    ],
                },
            ),
        ]);
        let interlocking =
            |id: &str,
             route_template_id: &str,
             authority_start_route_mm: i64,
             authority_end_route_mm: i64,
             path_resource: &str| InterlockingRouteTemplate {
                id: id.to_owned(),
                route_template_id: route_template_id.to_owned(),
                authority_start_route_mm,
                signal_id: format!("signal:{id}"),
                movement_kind: MovementKind::Train,
                path_resources: set(&[path_resource]),
                overlap_resources: set(&[&format!("overlap:{id}")]),
                flank_resources: set(&[&format!("flank:{id}")]),
                switch_positions: BTreeMap::new(),
                authority_end_route_mm,
                release_after_tail_route_mm: authority_end_route_mm,
            };
        let templates = [
            interlocking(
                "graph:a:seed",
                "template:graph:a",
                0,
                10_000,
                "block:graph:a-seed",
            ),
            interlocking(
                "graph:a:exit",
                "template:graph:a",
                10_000,
                20_000,
                "block:graph:a-exit",
            ),
            interlocking(
                "graph:b:seed",
                "template:graph:b",
                0,
                10_000,
                "block:graph:b-seed",
            ),
            interlocking(
                "graph:b:exit",
                "template:graph:b",
                10_000,
                20_000,
                "block:graph:b-exit",
            ),
        ];
        let mut signals = BTreeSet::new();
        let mut resources = BTreeSet::new();
        let mut interlocking_routes = BTreeMap::new();
        for template in templates {
            signals.insert(template.signal_id.clone());
            resources.extend(template.path_resources.iter().cloned());
            resources.extend(template.overlap_resources.iter().cloned());
            resources.extend(template.flank_resources.iter().cloned());
            interlocking_routes.insert(template.id.clone(), template);
        }
        let geometry = |longitude_e7: i32| {
            vec![
                EdgeGeometryPoint {
                    edge_offset_mm: 0,
                    latitude_e7: 510_000_000,
                    longitude_e7,
                    bearing_milli_degrees: Some(90_000),
                },
                EdgeGeometryPoint {
                    edge_offset_mm: 20_000,
                    latitude_e7: 510_000_000,
                    longitude_e7: longitude_e7 + 20_000,
                    bearing_milli_degrees: None,
                },
            ]
        };
        let release = OperationalInfraRelease {
            id: "infra:movement-graph:v2".to_owned(),
            directed_edges: BTreeMap::from([
                ("edge:graph:a".to_owned(), 20_000),
                ("edge:graph:b".to_owned(), 20_000),
            ]),
            edge_geometries: BTreeMap::from([
                ("edge:graph:a".to_owned(), geometry(120_000_000)),
                ("edge:graph:b".to_owned(), geometry(121_000_000)),
            ]),
            route_versions: routes,
            interlocking_routes,
            signals,
            switches: BTreeSet::new(),
            block_resources: resources,
            platform_intervals: BTreeMap::new(),
            region_boundaries: set(&["boundary:graph"]),
            rzue_layout_id: "rzue:graph:v1".to_owned(),
        };
        let mut world = OperationalWorld::new("world:graph", "region:graph", 0, release).unwrap();
        let vehicle_type = VehicleType {
            id: "type:graph".to_owned(),
            role: None,
            control_stands: None,
            traction: None,
            electric_systems: None,
            length_mm: 10_000,
            mass_kg: 80_000,
            maximum_speed_mmps: 20_000,
            power_watts: 4_000_000,
            starting_tractive_force_newtons: 200_000,
            raw_formation_dynamics: None,
            maximum_acceleration_mmps2: 1_000,
            service_brake_mmps2: 1_000,
            emergency_brake_mmps2: 1_500,
            protection_systems: set(&["pzb"]),
        };
        world
            .register_vehicle_type(vehicle_type.clone(), true)
            .unwrap();
        world
            .register_vehicle_type(
                VehicleType {
                    id: "type:graph:short".to_owned(),
                    length_mm: 9_000,
                    ..vehicle_type.clone()
                },
                true,
            )
            .unwrap();
        world
            .register_vehicle_type(
                VehicleType {
                    id: "type:graph:incompatible".to_owned(),
                    protection_systems: set(&["lzb"]),
                    ..vehicle_type
                },
                true,
            )
            .unwrap();
        let vehicle = |id: &str, type_id: &str| PhysicalVehicle {
            id: id.to_owned(),
            type_id: type_id.to_owned(),
            powered: true,
            orientation: Direction::Along,
            condition: VehicleCondition {
                mechanics_basis_points: 10_000,
                drive_basis_points: 10_000,
                brakes_basis_points: 10_000,
                kilometres_since_maintenance: 0,
                operating_hours_since_maintenance: 0,
                open_observations: 0,
            },
            restrictions: BTreeMap::new(),
            history: Vec::new(),
        };
        for (id, type_id, formation_id) in [
            ("vehicle:graph", "type:graph", "formation:graph"),
            ("vehicle:graph:other", "type:graph", "formation:graph:other"),
            (
                "vehicle:graph:short",
                "type:graph:short",
                "formation:graph:short",
            ),
            (
                "vehicle:graph:incompatible",
                "type:graph:incompatible",
                "formation:graph:incompatible",
            ),
        ] {
            world.register_vehicle(vehicle(id, type_id)).unwrap();
            world
                .create_formation(formation_id, None, vec![id.to_owned()])
                .unwrap();
        }
        let train = |id: &str,
                     train_number: &str,
                     route_version_id: &str,
                     dispatch_interlocking_route_id: &str,
                     scheduled_departure_ms: i64,
                     public_passenger_stop: bool| TrainInput {
            id: id.to_owned(),
            train_number: train_number.to_owned(),
            operator_id: "operator:graph".to_owned(),
            movement_kind: MovementKind::Train,
            route_version_id: route_version_id.to_owned(),
            formation_version_id: "formation:graph".to_owned(),
            head_route_mm: 10_000,
            scheduled_departure_ms: Some(scheduled_departure_ms),
            public_passenger_stop,
            dispatch_interlocking_route_id: dispatch_interlocking_route_id.to_owned(),
            protection_mode_selection_runs: vec![ProtectionModeSelectionRun {
                through_route_leg_index: 1,
                selected_protection_system: "pzb".to_owned(),
            }],
        };
        let mut trains = vec![
            train(
                "train:graph:a-1",
                "RB 201",
                "route:graph:a",
                "graph:a:exit",
                80_000_000,
                true,
            ),
            train(
                "train:graph:a-2",
                "RB 202",
                "route:graph:b",
                "graph:b:exit",
                1_000,
                true,
            ),
            train(
                "train:graph:b-1",
                "RB 203",
                "route:graph:a",
                "graph:a:exit",
                2_000,
                true,
            ),
            train(
                "train:graph:b-2",
                "RB 204",
                "route:graph:b",
                "graph:b:exit",
                3_000,
                true,
            ),
        ];
        trains[2].formation_version_id = "formation:graph:other".to_owned();
        trains[3].formation_version_id = "formation:graph:other".to_owned();
        let continuations = vec![
            MovementContinuationTemplateInput {
                id: "continuation:graph:a-1-a-2".to_owned(),
                predecessor_train_id: "train:graph:a-1".to_owned(),
                predecessor_base_route_version_id: "route:graph:a".to_owned(),
                successor_train_id: "train:graph:a-2".to_owned(),
                successor_day_offset: 1,
                daily_boundary: false,
                minimum_dwell_ms: 300_000,
                continuity: zugfolge_sim::operational::MovementContinuity::SameDirection,
                successor_formation: SuccessorFormationPolicy::InheritPredecessor,
            },
            MovementContinuationTemplateInput {
                id: "continuation:graph:a-2-b-1".to_owned(),
                predecessor_train_id: "train:graph:a-2".to_owned(),
                predecessor_base_route_version_id: "route:graph:b".to_owned(),
                successor_train_id: "train:graph:b-1".to_owned(),
                successor_day_offset: 0,
                daily_boundary: true,
                minimum_dwell_ms: 300_000,
                continuity: zugfolge_sim::operational::MovementContinuity::SameDirection,
                successor_formation: SuccessorFormationPolicy::InheritPredecessor,
            },
            MovementContinuationTemplateInput {
                id: "continuation:graph:b-1-b-2".to_owned(),
                predecessor_train_id: "train:graph:b-1".to_owned(),
                predecessor_base_route_version_id: "route:graph:a".to_owned(),
                successor_train_id: "train:graph:b-2".to_owned(),
                successor_day_offset: 0,
                daily_boundary: false,
                minimum_dwell_ms: 300_000,
                continuity: zugfolge_sim::operational::MovementContinuity::SameDirection,
                successor_formation: SuccessorFormationPolicy::InheritPredecessor,
            },
            MovementContinuationTemplateInput {
                id: "continuation:graph:b-2-a-1".to_owned(),
                predecessor_train_id: "train:graph:b-2".to_owned(),
                predecessor_base_route_version_id: "route:graph:b".to_owned(),
                successor_train_id: "train:graph:a-1".to_owned(),
                successor_day_offset: 1,
                daily_boundary: true,
                minimum_dwell_ms: 300_000,
                continuity: zugfolge_sim::operational::MovementContinuity::SameDirection,
                successor_formation: SuccessorFormationPolicy::InheritPredecessor,
            },
        ];
        (world, trains, continuations)
    }

    fn apply_value(state: &Value, command_id: &str, command: Value) -> Value {
        let envelope = json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": state["world"]["worldId"],
            "regionId": state["world"]["regionId"],
            "commandId": command_id,
            "expectedStateHash": state["stateHash"],
            "expectedRevision": state["revision"],
            "expectedPublisherSequence": state["publisherSequence"],
            "command": command,
        });
        serde_json::from_str(
            &apply_operational_simulation_command(&state.to_string(), &envelope.to_string())
                .unwrap(),
        )
        .unwrap()
    }

    fn restore_value(
        state: &Value,
        expected_initialization_hash: &Value,
    ) -> Result<Value, OperationalRuntimeError> {
        let restored = restore_operational_simulation(
            &json!({
                "schemaVersion": RESTORE_SCHEMA,
                "expectedInitializationHash": expected_initialization_hash,
                "state": state,
            })
            .to_string(),
        )?;
        serde_json::from_str(&restored)
            .map_err(|error| OperationalRuntimeError::new("invalid_test_result", error.to_string()))
    }

    fn two_day_recurrence_hash() -> (String, Value) {
        let mut input = initialization();
        input.trains[0].head_route_mm = 0;
        input.trains[0].scheduled_departure_ms = Some(0);
        input.trains[0].public_passenger_stop = true;
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&input).unwrap()).unwrap(),
        )
        .unwrap();
        let request = |train_id: &str, waiting_since_ms: i64| {
            json!({
                "type": "dispatch",
                "requests": [{
                    "trainId": train_id,
                    "interlockingRouteId": "interlocking:1",
                    "committedRank": 0,
                    "timetableDeviationMs": 0,
                    "passengerImpact": 0,
                    "contractualImpact": 0,
                    "networkImpact": 0,
                    "resourceConsequence": 0,
                    "recoveryRank": 0,
                    "waitingSinceMs": waiting_since_ms
                }]
            })
        };
        let day_ms = 86_400_000_i64;
        let mut result = apply_value(
            &initialized["state"],
            "day:0:materialize",
            json!({
                "type": "materialize",
                "train": {
                    "id": "train:1",
                    "trainNumber": "RB 1",
                    "operatorId": "operator:1",
                    "movementKind": "train",
                    "routeVersionId": "route:v1",
                    "formationVersionId": "formation:1",
                    "headRouteMm": 0,
                    "scheduledDepartureMs": 0,
                    "publicPassengerStop": true,
                    "dispatchInterlockingRouteId": "interlocking:1",
                    "protectionModeSelectionRuns": [{
                        "throughRouteLegIndex": 0,
                        "selectedProtectionSystem": "pzb"
                    }]
                }
            }),
        );
        result = apply_value(&result["state"], "day:0:dispatch", request("train:1", 0));
        result = apply_value(
            &result["state"],
            "day:0:advance",
            json!({ "type": "advance-to", "atMs": day_ms }),
        );
        assert_eq!(result["liveMap"]["trains"][0]["headRouteMm"], 100_000);
        assert_eq!(result["liveMap"]["trains"][0]["tailRouteMm"], 90_000);
        assert_eq!(result["liveMap"]["trains"][0]["motionState"], "standing");
        assert_eq!(result["liveMap"]["routeLocks"], json!([]));
        assert_eq!(result["liveMap"]["signals"], json!({}));
        assert!(
            result["state"]["world"]["trains"]["train:1"]["occupiedBlocks"]
                .as_array()
                .is_some_and(|resources| resources.contains(&json!("overlap:1")))
        );
        result = apply_value(
            &result["state"],
            "day:1:retire",
            json!({ "type": "retire", "trainId": "train:1" }),
        );
        assert_eq!(result["liveMap"]["trains"], json!([]));
        assert_eq!(result["liveMap"]["routeLocks"], json!([]));
        assert_eq!(result["liveMap"]["signals"], json!({}));
        result = apply_value(
            &result["state"],
            "day:1:materialize",
            json!({
                "type": "materialize",
                "train": {
                    "id": "train:1:day-1",
                    "trainNumber": "RB 1",
                    "operatorId": "operator:1",
                    "movementKind": "train",
                    "routeVersionId": "route:v1",
                    "formationVersionId": "formation:1",
                    "headRouteMm": 0,
                    "scheduledDepartureMs": day_ms,
                    "publicPassengerStop": true,
                    "dispatchInterlockingRouteId": "interlocking:1",
                    "protectionModeSelectionRuns": [{
                        "throughRouteLegIndex": 0,
                        "selectedProtectionSystem": "pzb"
                    }]
                }
            }),
        );
        result = apply_value(
            &result["state"],
            "day:1:dispatch",
            request("train:1:day-1", day_ms),
        );
        result = apply_value(
            &result["state"],
            "day:1:advance",
            json!({ "type": "advance-to", "atMs": day_ms * 2 }),
        );
        (result["stateHash"].as_str().unwrap().to_owned(), result)
    }

    #[test]
    fn initializes_one_state_for_livemap_and_rzue_and_restores_hash() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(initialized["schemaVersion"], INITIALIZED_SCHEMA);
        assert_eq!(
            initialized["initializationHash"],
            initialized["state"]["initializationHash"]
        );
        assert_eq!(initialized["state"]["revision"], 0);
        assert_eq!(initialized["state"]["publisherSequence"], 0);
        assert_eq!(initialized["state"]["world"]["commitSequence"], 0);
        assert_eq!(initialized["state"]["world"]["eventSequence"], 1);
        assert_eq!(initialized["liveMap"]["trains"], json!([]));
        assert!(initialized["state"]["world"].get("infra").is_none());
        assert_eq!(
            initialized["state"]["infraRelease"]["schemaVersion"],
            INFRASTRUCTURE_BINDING_SCHEMA
        );
        assert!(
            initialized["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|event| { event["commitSequence"] == 0 })
        );
        assert_eq!(
            initialized["liveMap"]["commitSequence"],
            initialized["rzue"]["commitSequence"]
        );
        assert_eq!(
            initialized["liveMap"]["trains"],
            initialized["rzue"]["trains"]
        );
        let restored =
            restore_value(&initialized["state"], &initialized["initializationHash"]).unwrap();
        assert_eq!(restored["stateHash"], initialized["stateHash"]);
        assert_eq!(
            restored["initializationHash"],
            initialized["initializationHash"]
        );
        assert!(restore_value(&initialized["state"], &json!("f".repeat(64))).is_err());
    }

    #[test]
    fn initialization_hash_binds_world_region_infra_and_formation() {
        let base = initialization();
        let initialized = |input: &Initialization| -> String {
            operational_initialization_hash(
                &serde_json::to_value(input).expect("Initialisierung ist serialisierbar"),
            )
            .expect("Initialisierung ist kanonisch hashbar")
        };
        let base_hash = initialized(&base);

        let mut other_world = base.clone();
        other_world.world_id = "world:2".to_owned();
        let mut other_region = base.clone();
        other_region.region_id = "region:2".to_owned();
        let mut other_infra = base.clone();
        other_infra.infra_release.infra_release_id = "infra:v3".to_owned();
        other_infra.infra_release.state_hash = "e".repeat(64);
        let mut other_formation = base.clone();
        other_formation.formations[0].id = "formation:other".to_owned();
        other_formation.trains[0].formation_version_id = "formation:other".to_owned();
        let mut other_policy = base.clone();
        other_policy.protection_mode_selection_policy =
            "zugfolge-protection-mode-selection/foreign-v1".to_owned();
        let mut other_selection = base.clone();
        other_selection.trains[0].protection_mode_selection_runs[0].selected_protection_system =
            "lzb".to_owned();
        let mut other_repeat = base.clone();
        other_repeat.repeat_every_ms = Some(86_400_000);

        for changed in [
            other_world,
            other_region,
            other_infra,
            other_formation,
            other_policy,
            other_selection,
            other_repeat,
        ] {
            assert_ne!(initialized(&changed), base_hash);
        }
    }

    #[test]
    fn movement_continuation_repeat_contract_and_evidence_are_fail_closed() {
        let template = MovementContinuationTemplateInput {
            id: "continuation:a-b".to_owned(),
            predecessor_train_id: "train:a".to_owned(),
            predecessor_base_route_version_id: "route:a".to_owned(),
            successor_train_id: "train:b".to_owned(),
            successor_day_offset: 0,
            daily_boundary: false,
            minimum_dwell_ms: 165_000,
            continuity: zugfolge_sim::operational::MovementContinuity::ReverseDirection,
            successor_formation: SuccessorFormationPolicy::InheritPredecessor,
        };
        assert_eq!(
            movement_continuation_evidence(std::slice::from_ref(&template)).unwrap(),
            "6c1a2cdcab8ecb7f8182d63e7c95beab94f137c5917050981ded619eb2ae43f5"
        );
        assert_eq!(
            movement_continuation_evidence(&[]).unwrap(),
            "462d0239e9dbd79d82d05b9939675b26fcaee302ddc1f0053db75a1acf774e71"
        );

        let mut repeated_without_graph = initialization();
        repeated_without_graph.repeat_every_ms = Some(86_400_000);
        assert!(
            super::initialize_operational_simulation(
                &encode(&repeated_without_graph).unwrap(),
                infrastructure_path(),
            )
            .unwrap_err()
            .to_string()
            .starts_with("invalid_movement_continuation_repeat:")
        );

        let mut graph_without_repeat = initialization();
        graph_without_repeat.movement_continuations.push(template);
        assert!(
            super::initialize_operational_simulation(
                &encode(&graph_without_repeat).unwrap(),
                infrastructure_path(),
            )
            .unwrap_err()
            .to_string()
            .starts_with("invalid_movement_continuation_repeat:")
        );

        let mut missing_repeat = serde_json::to_value(initialization()).unwrap();
        missing_repeat
            .as_object_mut()
            .unwrap()
            .remove("repeatEveryMs");
        assert!(
            super::initialize_operational_simulation(
                &missing_repeat.to_string(),
                infrastructure_path(),
            )
            .is_err()
        );
    }

    #[test]
    fn native_movement_continuation_preflight_accepts_only_a_complete_physical_day_cycle() {
        let (world, trains, continuations) = movement_graph_fixture();
        let expected_hash = movement_continuation_evidence(&continuations).unwrap();
        assert_eq!(
            validate_movement_continuation_templates(
                &world,
                &trains,
                Some(86_400_000),
                &continuations,
            )
            .unwrap(),
            (4, expected_hash.clone())
        );
        let mut nonpublic_successor_trains = trains.clone();
        nonpublic_successor_trains[3].public_passenger_stop = false;
        let mut nonpublic_successor_continuations = continuations.clone();
        nonpublic_successor_continuations[3].minimum_dwell_ms = 0;
        assert!(
            validate_movement_continuation_templates(
                &world,
                &nonpublic_successor_trains,
                Some(86_400_000),
                &nonpublic_successor_continuations,
            )
            .is_ok()
        );
        let mut missing_passenger_dwell = nonpublic_successor_continuations.clone();
        missing_passenger_dwell[2].minimum_dwell_ms = 0;
        assert!(
            validate_movement_continuation_templates(
                &world,
                &nonpublic_successor_trains,
                Some(86_400_000),
                &missing_passenger_dwell,
            )
            .unwrap_err()
            .to_string()
            .starts_with("invalid_movement_continuation_dwell:")
        );
        let mut movement_to_passenger_dwell = nonpublic_successor_continuations;
        movement_to_passenger_dwell[3].minimum_dwell_ms = 300_000;
        assert!(
            validate_movement_continuation_templates(
                &world,
                &nonpublic_successor_trains,
                Some(86_400_000),
                &movement_to_passenger_dwell,
            )
            .unwrap_err()
            .to_string()
            .starts_with("invalid_movement_continuation_dwell:")
        );
        let mut wrong_length = trains.clone();
        wrong_length[2].formation_version_id = "formation:graph:short".to_owned();
        assert!(
            validate_movement_continuation_templates(
                &world,
                &wrong_length,
                Some(86_400_000),
                &continuations,
            )
            .unwrap_err()
            .to_string()
            .starts_with("invalid_movement_continuation_formation:")
        );
        let mut incompatible = trains.clone();
        incompatible[2].formation_version_id = "formation:graph:incompatible".to_owned();
        incompatible[3].formation_version_id = "formation:graph:incompatible".to_owned();
        assert!(
            validate_movement_continuation_templates(
                &world,
                &incompatible,
                Some(86_400_000),
                &continuations,
            )
            .unwrap_err()
            .to_string()
            .starts_with("invalid_movement_continuation_physical_binding:")
        );
        let mut reversed = continuations.clone();
        reversed.reverse();
        assert_eq!(
            movement_continuation_evidence(&reversed).unwrap(),
            expected_hash
        );

        let mut no_day_edge = continuations.clone();
        no_day_edge[0].successor_day_offset = 0;
        assert!(
            validate_movement_continuation_templates(
                &world,
                &trains,
                Some(86_400_000),
                &no_day_edge,
            )
            .unwrap_err()
            .to_string()
            .starts_with("invalid_movement_continuation_time:")
        );

        let mut missing_daily_boundary = continuations.clone();
        missing_daily_boundary[1].daily_boundary = false;
        assert!(
            validate_movement_continuation_templates(
                &world,
                &trains,
                Some(86_400_000),
                &missing_daily_boundary,
            )
            .unwrap_err()
            .to_string()
            .starts_with("invalid_movement_continuation_daily_boundary:")
        );

        let mut day_edge_to_non_passenger = continuations;
        let mut non_passenger_trains = trains;
        non_passenger_trains[1].public_passenger_stop = false;
        day_edge_to_non_passenger[0].minimum_dwell_ms = 300_000;
        day_edge_to_non_passenger[1].minimum_dwell_ms = 0;
        assert!(
            validate_movement_continuation_templates(
                &world,
                &non_passenger_trains,
                Some(86_400_000),
                &day_edge_to_non_passenger,
            )
            .unwrap_err()
            .to_string()
            .starts_with("invalid_movement_continuation_graph:")
        );
    }

    #[test]
    fn queued_source_absent_continuation_survives_runtime_restore_and_conflicts_atomically() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let continuation = json!({
            "id": "continuation:future",
            "predecessorTrainId": "train:future-source",
            "predecessorBaseRouteVersionId": "route:v1",
            "successor": {
                "id": "train:future-successor",
                "trainNumber": "RB 211",
                "operatorId": "operator:1",
                "movementKind": "train",
                "routeVersionId": "route:v1",
                "formationVersionId": "formation:1",
                "headRouteMm": 0,
                "scheduledDepartureMs": null,
                "publicPassengerStop": false
            },
            "successorDispatch": {
                "trainId": "train:future-successor",
                "interlockingRouteId": "interlocking:1",
                "committedRank": 0,
                "timetableDeviationMs": 0,
                "passengerImpact": 0,
                "contractualImpact": 0,
                "networkImpact": 0,
                "resourceConsequence": 0,
                "recoveryRank": 0,
                "waitingSinceMs": 0
            },
            "notBeforeMs": 0,
            "minimumDwellMs": 0,
            "continuity": "same-direction"
        });
        let queued = apply_value(
            &initialized["state"],
            "continuation:queue",
            json!({
                "type": "queue-movement-continuation",
                "continuation": continuation.clone()
            }),
        );
        assert!(
            queued["state"]["world"]["pendingMovementContinuations"]
                .get("continuation:future")
                .is_some()
        );
        let restored = restore_value(&queued["state"], &queued["initializationHash"]).unwrap();
        assert_eq!(restored["stateHash"], queued["stateHash"]);

        let mut conflicting = continuation.clone();
        conflicting["minimumDwellMs"] = json!(1);
        let state_before = queued["state"].clone();
        let envelope = json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "commandId": "continuation:conflict",
            "expectedStateHash": state_before["stateHash"],
            "expectedRevision": state_before["revision"],
            "expectedPublisherSequence": state_before["publisherSequence"],
            "command": {
                "type": "queue-movement-continuation",
                "continuation": conflicting
            }
        });
        assert!(
            apply_operational_simulation_command(&state_before.to_string(), &envelope.to_string())
                .unwrap_err()
                .to_string()
                .contains("ConflictingMovementContinuationId")
        );
        assert_eq!(queued["state"], state_before);
    }

    #[test]
    fn applies_only_v2_commands_idempotently_and_rejects_add_delay() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let materialized = apply_value(
            &initialized["state"],
            "command:materialize:1",
            json!({
                "type": "materialize",
                "train": serde_json::to_value(&initialization().trains[0]).unwrap(),
            }),
        );
        let command = json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "commandId": "command:dispatch:1",
            "expectedStateHash": materialized["stateHash"],
            "expectedRevision": 1,
            "expectedPublisherSequence": 1,
            "command": {
                "type": "dispatch",
                "requests": [{
                    "trainId": "train:1",
                    "interlockingRouteId": "interlocking:1",
                    "committedRank": 0,
                    "timetableDeviationMs": 0,
                    "passengerImpact": 0,
                    "contractualImpact": 0,
                    "networkImpact": 0,
                    "resourceConsequence": 0,
                    "recoveryRank": 0,
                    "waitingSinceMs": 0
                }]
            }
        });
        let applied: Value = serde_json::from_str(
            &apply_operational_simulation_command(
                &materialized["state"].to_string(),
                &command.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(applied["idempotentReplay"], false);
        assert_eq!(applied["state"]["revision"], 2);
        assert_eq!(applied["state"]["publisherSequence"], 2);
        assert_eq!(applied["state"]["world"]["commitSequence"], 2);
        let events = applied["events"].as_array().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["eventSequence"], 3);
        assert_eq!(events[1]["eventSequence"], 4);
        assert_eq!(events[2]["eventSequence"], 5);
        assert!(events.iter().all(|event| event["commitSequence"] == 2));
        assert_eq!(
            applied["liveMap"]["commitSequence"],
            applied["rzue"]["commitSequence"]
        );
        let replayed: Value = serde_json::from_str(
            &apply_operational_simulation_command(
                &applied["state"].to_string(),
                &command.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(replayed["idempotentReplay"], true);
        assert_eq!(replayed["stateHash"], applied["stateHash"]);
        assert_eq!(replayed["state"]["world"]["commitSequence"], 2);

        let forbidden = command
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<serde_json::Map<String, Value>>();
        let mut forbidden = Value::Object(forbidden);
        forbidden["command"] = json!({ "type": "add-delay", "trainId": "train:1", "seconds": 120 });
        assert!(
            apply_operational_simulation_command(
                &materialized["state"].to_string(),
                &forbidden.to_string(),
            )
            .is_err()
        );
    }

    #[test]
    fn eventless_advance_still_creates_exactly_one_atomic_commit() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let command = json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "commandId": "command:advance:eventless",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "command": { "type": "advance-to", "atMs": 1_000 }
        });
        let applied: Value = serde_json::from_str(
            &apply_operational_simulation_command(
                &initialized["state"].to_string(),
                &command.to_string(),
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(applied["state"]["world"]["commitSequence"], 1);
        assert_eq!(applied["state"]["world"]["eventSequence"], 1);
        assert_eq!(applied["state"]["revision"], 1);
        assert_eq!(applied["events"], json!([]));
    }

    #[test]
    fn active_disruption_is_typed_and_identical_in_both_projections() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let command = json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "commandId": "command:disruption:1",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "command": {
                "type": "activate-disruption",
                "disruptionId": "disruption:signal",
                "effect": { "signal-failed": { "signalId": "signal:1" } }
            }
        });
        let applied: Value = serde_json::from_str(
            &apply_operational_simulation_command(
                &initialized["state"].to_string(),
                &command.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        let expected = json!([{
            "disruptionId": "disruption:signal",
            "effect": { "signal-failed": { "signalId": "signal:1" } }
        }]);
        assert_eq!(applied["liveMap"]["activeDisruptions"], expected);
        assert_eq!(
            applied["liveMap"]["activeDisruptions"],
            applied["rzue"]["activeDisruptions"]
        );
        assert_eq!(applied["liveMap"]["commitSequence"], 1);
    }

    #[test]
    fn native_batch_is_atomic_and_keeps_idempotent_replays_in_order() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let activation = json!({
            "type": "activate-disruption",
            "disruptionId": "disruption:signal",
            "effect": { "signal-failed": { "signalId": "signal:1" } }
        });
        let batch = json!({
            "schemaVersion": COMMAND_BATCH_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "commands": [
                { "commandId": "batch:activate", "command": activation },
                { "commandId": "batch:activate", "command": activation },
                {
                    "commandId": "batch:clear",
                    "command": {
                        "type": "clear-disruption",
                        "disruptionId": "disruption:signal",
                        "releaseReference": "release:test"
                    }
                }
            ]
        });
        let applied: Value = serde_json::from_str(
            &apply_operational_simulation_command_batch(
                &initialized["state"].to_string(),
                &batch.to_string(),
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(applied["schemaVersion"], BATCH_RESULT_SCHEMA);
        assert_eq!(applied["state"]["revision"], 2);
        assert_eq!(applied["state"]["publisherSequence"], 2);
        assert_eq!(applied["state"]["world"]["commitSequence"], 2);
        assert_eq!(
            applied["commandResults"],
            json!([
                { "commandId": "batch:activate", "idempotentReplay": false },
                { "commandId": "batch:activate", "idempotentReplay": true },
                { "commandId": "batch:clear", "idempotentReplay": false }
            ])
        );
        assert_eq!(applied["events"].as_array().unwrap().len(), 2);
        assert_eq!(applied["eventContexts"].as_array().unwrap().len(), 2);
        assert_eq!(applied["eventContexts"][0]["commandIndex"], 0);
        assert_eq!(applied["eventContexts"][1]["commandIndex"], 2);
        assert_eq!(
            applied["eventContexts"][1]["disruptionEffectBefore"],
            json!({ "signal-failed": { "signalId": "signal:1" } })
        );
        assert_eq!(applied["liveMap"]["activeDisruptions"], json!([]));
        assert_eq!(applied["stateHash"], applied["state"]["stateHash"]);
    }

    #[test]
    fn dispatched_resource_closure_emits_safe_stop_in_the_atomic_batch() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let materialized = apply_value(
            &initialized["state"],
            "batch-safe-stop:materialize",
            json!({
                "type": "materialize",
                "train": serde_json::to_value(&initialization().trains[0]).unwrap(),
            }),
        );
        let dispatched = apply_value(
            &materialized["state"],
            "batch-safe-stop:dispatch",
            json!({
                "type": "dispatch",
                "requests": [{
                    "trainId": "train:1",
                    "interlockingRouteId": "interlocking:1",
                    "committedRank": 0,
                    "timetableDeviationMs": 0,
                    "passengerImpact": 0,
                    "contractualImpact": 0,
                    "networkImpact": 0,
                    "resourceConsequence": 0,
                    "recoveryRank": 0,
                    "waitingSinceMs": 0
                }]
            }),
        );
        let first_activation = apply_value(
            &dispatched["state"],
            "batch-safe-stop:first-activation",
            json!({
                "type": "activate-disruption",
                "disruptionId": "block:first",
                "effect": { "resource-closed": { "resourceId": "block:1" } }
            }),
        );
        assert!(
            first_activation["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["kind"] == "safe-stop")
        );
        let cleared = apply_value(
            &first_activation["state"],
            "batch-safe-stop:first-clear",
            json!({
                "type": "clear-disruption",
                "disruptionId": "block:first",
                "releaseReference": "release:first"
            }),
        );
        let activation = json!({
            "type": "activate-disruption",
            "disruptionId": "block:batch",
            "effect": { "resource-closed": { "resourceId": "block:1" } }
        });
        let batch = json!({
            "schemaVersion": COMMAND_BATCH_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "expectedStateHash": cleared["stateHash"],
            "expectedRevision": cleared["state"]["revision"],
            "expectedPublisherSequence": cleared["state"]["publisherSequence"],
            "commands": [
                { "commandId": "batch-safe-stop:activate", "command": activation },
                { "commandId": "batch-safe-stop:activate", "command": activation },
                {
                    "commandId": "batch-safe-stop:clear",
                    "command": {
                        "type": "clear-disruption",
                        "disruptionId": "block:batch",
                        "releaseReference": "release:batch"
                    }
                }
            ]
        });
        let applied: Value = serde_json::from_str(
            &apply_operational_simulation_command_batch(
                &cleared["state"].to_string(),
                &batch.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            applied["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|event| event["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["safe-stop", "disruption-activated", "disruption-cleared"]
        );
        assert_eq!(
            applied["eventContexts"][0]["affectedTrainRunIds"],
            json!(["train:1"])
        );
        assert_eq!(
            applied["eventContexts"][1]["affectedTrainRunIds"],
            json!([])
        );
    }

    #[test]
    fn tutorial_resource_closure_preserves_a_safe_runtime_state() {
        let tutorial_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/game-api/tutorial-infrastructure/tutorial-minimal-2026.1");
        let infrastructure_path = tutorial_root.join(INFRASTRUCTURE_FILE);
        let descriptor: Value =
            serde_json::from_slice(&std::fs::read(tutorial_root.join("descriptor.json")).unwrap())
                .unwrap();
        let mut input = serde_json::to_value(initialization()).unwrap();
        input["regionId"] = json!("tutorial-korridor");
        input["infraRelease"] = descriptor["binding"].clone();
        input["trains"][0]["routeVersionId"] = json!("tutorial-minimal-2026.1:route:v1");
        input["trains"][0]["dispatchInterlockingRouteId"] =
            json!("tutorial-minimal-2026.1:interlocking:v1");
        input["trains"][0]["protectionModeSelectionRuns"] = json!([{
            "throughRouteLegIndex": 2,
            "selectedProtectionSystem": "pzb"
        }]);
        let initialized: Value = serde_json::from_str(
            &super::initialize_operational_simulation(
                &input.to_string(),
                infrastructure_path.to_str().unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        let apply = |head: &Value, command_id: &str, command: Value| -> Value {
            let envelope = json!({
                "schemaVersion": COMMAND_SCHEMA,
                "worldId": head["state"]["world"]["worldId"],
                "regionId": head["state"]["world"]["regionId"],
                "commandId": command_id,
                "expectedStateHash": head["stateHash"],
                "expectedRevision": head["state"]["revision"],
                "expectedPublisherSequence": head["state"]["publisherSequence"],
                "command": command,
            });
            serde_json::from_str(
                &super::apply_operational_simulation_command(
                    &head["state"].to_string(),
                    &envelope.to_string(),
                    infrastructure_path.to_str().unwrap(),
                )
                .unwrap_or_else(|error| panic!("{command_id}: {error:?}")),
            )
            .unwrap()
        };
        let materialized = apply(
            &initialized,
            "tutorial-safe-stop:materialize",
            json!({ "type": "materialize", "train": input["trains"][0] }),
        );
        let dispatched = apply(
            &materialized,
            "tutorial-safe-stop:dispatch",
            json!({
                "type": "dispatch",
                "requests": [{
                    "trainId": "train:1",
                    "interlockingRouteId": "tutorial-minimal-2026.1:interlocking:v1",
                    "committedRank": 0,
                    "timetableDeviationMs": 0,
                    "passengerImpact": 0,
                    "contractualImpact": 0,
                    "networkImpact": 0,
                    "resourceConsequence": 0,
                    "recoveryRank": 0,
                    "waitingSinceMs": 0
                }]
            }),
        );
        let activated = apply(
            &dispatched,
            "tutorial-safe-stop:activate",
            json!({
                "type": "activate-disruption",
                "disruptionId": "tutorial-safe-stop:closure",
                "effect": { "resource-closed": { "resourceId": "track:tut-segment-1" } }
            }),
        );
        assert!(
            activated["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| { event["kind"] == "safe-stop" && event["subjectId"] == "train:1" })
        );
        assert_eq!(
            activated["state"]["world"]["scheduledMotionEnds"],
            json!([])
        );
        assert_eq!(
            activated["state"]["world"]["routeLocks"]
                .as_object()
                .unwrap()
                .len(),
            3,
            "der sichere Halt behaelt die bereits eingestellten Schutzfahrstrassen"
        );
    }

    #[test]
    fn native_batch_rejects_the_whole_group_when_a_later_command_fails() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let batch = json!({
            "schemaVersion": COMMAND_BATCH_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "commands": [
                { "commandId": "batch:advance:first", "command": { "type": "advance-to", "atMs": 1_000 } },
                { "commandId": "batch:advance:invalid", "command": { "type": "advance-to", "atMs": 500 } }
            ]
        });
        let error = apply_operational_simulation_command_batch(
            &initialized["state"].to_string(),
            &batch.to_string(),
        )
        .unwrap_err()
        .to_string();
        assert!(error.starts_with("operational_batch_command_failed:"));
        assert!(error.contains("index=1"));
        assert!(error.contains("causeCode=operational_command_rejected"));

        let applied = apply_value(
            &initialized["state"],
            "batch:advance:first",
            json!({ "type": "advance-to", "atMs": 1_000 }),
        );
        assert_eq!(applied["state"]["revision"], 1);
        assert_eq!(initialized["state"]["revision"], 0);
    }

    #[test]
    fn native_batch_rejects_a_duplicate_id_with_a_different_payload_hash_atomically() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let batch = json!({
            "schemaVersion": COMMAND_BATCH_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "commands": [
                { "commandId": "batch:duplicate", "command": { "type": "advance-to", "atMs": 1_000 } },
                { "commandId": "batch:duplicate", "command": { "type": "advance-to", "atMs": 2_000 } }
            ]
        });
        let error = apply_operational_simulation_command_batch(
            &initialized["state"].to_string(),
            &batch.to_string(),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("index=1"));
        assert!(error.contains("causeCode=idempotency_conflict"));

        let applied = apply_value(
            &initialized["state"],
            "batch:duplicate",
            json!({ "type": "advance-to", "atMs": 2_000 }),
        );
        assert_eq!(applied["state"]["revision"], 1);
        assert_eq!(initialized["state"]["revision"], 0);
    }

    #[test]
    fn native_batch_input_budgets_are_checked_before_json_decode() {
        let oversized_state = " ".repeat(MAX_BATCH_STATE_JSON_BYTES + 1);
        let initialization_error =
            super::initialize_operational_simulation(&oversized_state, "unused-before-decode")
                .unwrap_err()
                .to_string();
        assert!(initialization_error.starts_with("operational_initialization_budget_exceeded:"));

        let command_state_error = super::apply_operational_simulation_command(
            &oversized_state,
            "{}",
            "unused-before-decode",
        )
        .unwrap_err()
        .to_string();
        assert!(command_state_error.starts_with("operational_command_state_budget_exceeded:"));

        let state_error = super::apply_operational_simulation_command_batch(
            &oversized_state,
            "{}",
            "unused-before-decode",
        )
        .unwrap_err()
        .to_string();
        assert!(state_error.starts_with("operational_batch_state_budget_exceeded:"));

        let oversized_restore = " ".repeat(MAX_RESTORE_JSON_BYTES + 1);
        let restore_error =
            super::restore_operational_simulation(&oversized_restore, "unused-before-decode")
                .unwrap_err()
                .to_string();
        assert!(restore_error.starts_with("operational_restore_budget_exceeded:"));

        let oversized_command = " ".repeat(MAX_COMMAND_JSON_BYTES + 1);
        let command_error = super::apply_operational_simulation_command(
            "{}",
            &oversized_command,
            "unused-before-decode",
        )
        .unwrap_err()
        .to_string();
        assert!(command_error.starts_with("operational_command_budget_exceeded:"));

        let oversized_batch = " ".repeat(MAX_BATCH_JSON_BYTES + 1);
        let batch_error = super::apply_operational_simulation_command_batch(
            "{}",
            &oversized_batch,
            "unused-before-decode",
        )
        .unwrap_err()
        .to_string();
        assert!(batch_error.starts_with("operational_batch_input_budget_exceeded:"));
    }

    #[test]
    fn native_batch_event_budget_is_cumulative_and_fail_closed() {
        assert!(
            operational_command_rejection(OperationalError::EventBudgetExceeded)
                .to_string()
                .starts_with("operational_event_budget_exceeded:")
        );
        ensure_batch_event_budget(MAX_BATCH_EVENTS, 0, 0, "batch:exact").unwrap();
        ensure_batch_event_budget(MAX_BATCH_EVENTS - 1, 1, 1, "batch:exact-split").unwrap();

        let error = ensure_batch_event_budget(MAX_BATCH_EVENTS, 1, 2, "batch:over")
            .unwrap_err()
            .to_string();
        assert!(error.starts_with("operational_batch_event_budget_exceeded:"));
        assert!(error.contains("index=2"));
        assert!(error.contains("commandId=\"batch:over\""));

        assert!(
            ensure_batch_event_budget(usize::MAX, 1, 3, "batch:overflow")
                .unwrap_err()
                .to_string()
                .starts_with("operational_batch_event_budget_exceeded:")
        );
    }

    #[test]
    fn native_batch_result_writer_never_grows_past_its_budget() {
        let large_writer = BoundedJsonWriter::new(MAX_BATCH_RESULT_JSON_BYTES).unwrap();
        assert!(large_writer.bytes.capacity() <= INITIAL_BATCH_RESULT_JSON_CAPACITY);
        assert!(large_writer.bytes.capacity() < MAX_BATCH_RESULT_JSON_BYTES);

        let mut writer = BoundedJsonWriter::new(8).unwrap();
        writer.write_all(b"12345678").unwrap();
        assert!(writer.write_all(b"9").is_err());
        assert_eq!(writer.bytes.len(), 8);
        assert!(writer.bytes.capacity() <= 8);

        let mut growing_writer = BoundedJsonWriter::new(100_000).unwrap();
        growing_writer.write_all(&vec![b'x'; 70_000]).unwrap();
        assert_eq!(growing_writer.bytes.len(), 70_000);
        assert!(growing_writer.bytes.capacity() <= 100_000);

        let error = encode_with_budget(&"12345678", 8, "operational_batch_result_budget_exceeded")
            .unwrap_err()
            .to_string();
        assert!(error.starts_with("operational_batch_result_budget_exceeded:"));

        assert_eq!(
            ensure_encoded_within_budget(&"1234", 6, "state-budget", "OperationalState").unwrap(),
            6
        );
        let state_error = ensure_encoded_within_budget(
            &"12345",
            6,
            "operational_batch_result_state_budget_exceeded",
            "OperationalState",
        )
        .unwrap_err()
        .to_string();
        assert!(state_error.starts_with("operational_batch_result_state_budget_exceeded:"));
    }

    #[test]
    fn native_batch_fails_closed_outside_its_bounded_contract() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let commands = (0..MAX_COMMAND_BATCH_SIZE)
            .map(|index| {
                json!({
                    "commandId": format!("batch:advance:{index}"),
                    "command": { "type": "advance-to", "atMs": 0 }
                })
            })
            .collect::<Vec<_>>();
        let maximum = json!({
            "schemaVersion": COMMAND_BATCH_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "commands": commands
        });
        let applied: Value = serde_json::from_str(
            &apply_operational_simulation_command_batch(
                &initialized["state"].to_string(),
                &maximum.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(applied["state"]["revision"], MAX_COMMAND_BATCH_SIZE);
        assert_eq!(
            applied["state"]["commandReceipts"]
                .as_object()
                .unwrap()
                .len(),
            MAX_COMMAND_BATCH_SIZE.min(MAX_COMMAND_RECEIPTS)
        );

        let mut oversized_commands = maximum["commands"].as_array().unwrap().clone();
        oversized_commands.push(json!({
            "commandId": "batch:advance:oversized",
            "command": { "type": "advance-to", "atMs": 0 }
        }));
        let oversized = json!({
            "schemaVersion": COMMAND_BATCH_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "commands": oversized_commands
        });
        assert!(
            apply_operational_simulation_command_batch(
                &initialized["state"].to_string(),
                &oversized.to_string(),
            )
            .unwrap_err()
            .to_string()
            .starts_with("invalid_command_batch_size:")
        );
    }

    #[test]
    fn recurrence_retires_and_rematerializes_safely_across_multiple_days() {
        let (first_hash, first) = two_day_recurrence_hash();
        let (second_hash, second) = two_day_recurrence_hash();

        assert_eq!(first_hash, second_hash);
        assert_eq!(first["state"]["world"]["commitSequence"], 7);
        assert_eq!(first["state"]["revision"], 7);
        assert_eq!(first["liveMap"]["trains"][0]["trainId"], "train:1:day-1");
        assert_eq!(first["liveMap"], second["liveMap"]);
    }

    #[test]
    fn premature_retirement_is_rejected_without_a_commit() {
        let mut input = initialization();
        input.trains[0].head_route_mm = 0;
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&input).unwrap()).unwrap(),
        )
        .unwrap();
        let envelope = json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "commandId": "retire:too-early",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "command": { "type": "retire", "trainId": "train:1" }
        });

        assert!(
            apply_operational_simulation_command(
                &initialized["state"].to_string(),
                &envelope.to_string(),
            )
            .is_err()
        );
        assert_eq!(initialized["state"]["world"]["commitSequence"], 0);
    }

    #[test]
    fn accepts_the_public_camel_case_command_contract_for_variant_fields() {
        let advance: CommandPayload = serde_json::from_value(json!({
            "type": "advance-to",
            "atMs": 1_000
        }))
        .unwrap();
        assert!(matches!(
            advance,
            CommandPayload::AdvanceTo { at_ms: 1_000 }
        ));

        let disruption: CommandPayload = serde_json::from_value(json!({
            "type": "activate-disruption",
            "disruptionId": "disruption:signal",
            "effect": {
                "signal-failed": { "signalId": "signal:1" }
            }
        }))
        .unwrap();
        assert!(matches!(
            disruption,
            CommandPayload::ActivateDisruption {
                disruption_id,
                effect: OperationalDisruption::SignalFailed { signal_id }
            } if disruption_id == "disruption:signal" && signal_id == "signal:1"
        ));

        let queued: CommandPayload = serde_json::from_value(json!({
            "type": "queue-movement-continuation",
            "continuation": {
                "id": "continuation:day-0",
                "predecessorTrainId": "train:source:day-0",
                "predecessorBaseRouteVersionId": "route:v1",
                "successor": {
                    "id": "train:successor:day-0",
                    "trainNumber": "RB 2",
                    "operatorId": "operator:1",
                    "movementKind": "train",
                    "routeVersionId": "route:v1",
                    "formationVersionId": "formation:1",
                    "headRouteMm": 0,
                    "scheduledDepartureMs": null,
                    "publicPassengerStop": false
                },
                "successorDispatch": {
                    "trainId": "train:successor:day-0",
                    "interlockingRouteId": "interlocking:1",
                    "committedRank": 0,
                    "timetableDeviationMs": 0,
                    "passengerImpact": 0,
                    "contractualImpact": 0,
                    "networkImpact": 0,
                    "resourceConsequence": 0,
                    "recoveryRank": 0,
                    "waitingSinceMs": 0
                },
                "notBeforeMs": 0,
                "minimumDwellMs": 165000,
                "continuity": "reverse-direction"
            }
        }))
        .unwrap();
        assert!(matches!(
            &queued,
            CommandPayload::QueueMovementContinuation { continuation }
                if continuation.id == "continuation:day-0"
                    && continuation.minimum_dwell_ms == 165_000
                    && continuation.continuity
                        == zugfolge_sim::operational::MovementContinuity::ReverseDirection
        ));

        let mut non_minimal = serde_json::to_value(queued).unwrap();
        non_minimal["continuation"]["successor"]["dispatchInterlockingRouteId"] =
            json!("interlocking:1");
        assert!(serde_json::from_value::<CommandPayload>(non_minimal).is_err());
    }

    #[test]
    fn native_projection_keeps_standing_trains_without_occupied_start_interval() {
        let mut input = initialization();
        let mut second_vehicle = input.vehicles[0].clone();
        second_vehicle.id = "vehicle:2".to_owned();
        input.vehicles.push(second_vehicle);
        input.formations.push(FormationInput {
            id: "formation:2".to_owned(),
            predecessor_id: None,
            vehicle_ids: vec!["vehicle:2".to_owned()],
        });
        input.trains.push(TrainInput {
            id: "train:standing".to_owned(),
            train_number: "RB 2".to_owned(),
            operator_id: "operator:2".to_owned(),
            movement_kind: MovementKind::Train,
            route_version_id: "route:v1".to_owned(),
            formation_version_id: "formation:2".to_owned(),
            head_route_mm: 0,
            scheduled_departure_ms: None,
            public_passenger_stop: false,
            dispatch_interlocking_route_id: "interlocking:1".to_owned(),
            protection_mode_selection_runs: vec![ProtectionModeSelectionRun {
                through_route_leg_index: 0,
                selected_protection_system: "pzb".to_owned(),
            }],
        });

        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&input).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(initialized["liveMap"]["infraReleaseId"], "infra:v2");
        assert_eq!(initialized["liveMap"]["trains"], json!([]));
        let first = apply_value(
            &initialized["state"],
            "standing:materialize:first",
            json!({ "type": "materialize", "train": input.trains[0] }),
        );
        let materialized = apply_value(
            &first["state"],
            "standing:materialize:second",
            json!({ "type": "materialize", "train": input.trains[1] }),
        );
        assert_eq!(
            materialized["liveMap"]["trains"].as_array().unwrap().len(),
            2
        );
        let standing = materialized["liveMap"]["trains"]
            .as_array()
            .unwrap()
            .iter()
            .find(|train| train["trainId"] == "train:standing")
            .unwrap();
        assert_eq!(standing["headGeometry"]["routeMm"], 0);
        assert_eq!(standing["headGeometry"]["edgeId"], "edge:1");
        assert_eq!(standing["motionState"], "standing");
        assert!(standing["tailGeometry"].is_null());
    }

    #[test]
    fn compact_binding_rejects_missing_foreign_and_tampered_infrastructure() {
        let base = initialization();
        let input_json = encode(&base).unwrap();

        let mut wrong_id = base.clone();
        wrong_id.infra_release.infra_release_id = "infra:foreign".to_owned();
        assert!(
            super::initialize_operational_simulation(
                &encode(&wrong_id).unwrap(),
                infrastructure_path(),
            )
            .is_err()
        );

        let mut wrong_bytes = base.clone();
        wrong_bytes.infra_release.bytes += 1;
        assert!(
            super::initialize_operational_simulation(
                &encode(&wrong_bytes).unwrap(),
                infrastructure_path(),
            )
            .is_err()
        );

        let mut wrong_sha = base.clone();
        wrong_sha.infra_release.sha256 = "f".repeat(64);
        assert!(
            super::initialize_operational_simulation(
                &encode(&wrong_sha).unwrap(),
                infrastructure_path(),
            )
            .is_err()
        );

        let mut wrong_state_hash = base.clone();
        wrong_state_hash.infra_release.state_hash = "d".repeat(64);
        assert!(
            super::initialize_operational_simulation(
                &encode(&wrong_state_hash).unwrap(),
                infrastructure_path(),
            )
            .is_err()
        );

        let missing_directory = std::env::temp_dir().join(format!(
            "zugfolge-sim-runtime-missing-{}-{}",
            std::process::id(),
            NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&missing_directory).unwrap();
        let missing = missing_directory.join(INFRASTRUCTURE_FILE);
        assert!(
            super::initialize_operational_simulation(&input_json, missing.to_str().unwrap(),)
                .is_err()
        );
        let initialized: Value =
            serde_json::from_str(&initialize_operational_simulation(&input_json).unwrap()).unwrap();
        let restore = json!({
            "schemaVersion": RESTORE_SCHEMA,
            "expectedInitializationHash": initialized["initializationHash"],
            "state": initialized["state"],
        });
        assert!(
            super::restore_operational_simulation(&restore.to_string(), missing.to_str().unwrap(),)
                .is_err()
        );
        assert!(
            super::apply_operational_simulation_command(
                &initialized["state"].to_string(),
                "{}",
                missing.to_str().unwrap(),
            )
            .is_err()
        );

        let tampered_directory = std::env::temp_dir().join(format!(
            "zugfolge-sim-runtime-tampered-{}-{}",
            std::process::id(),
            NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&tampered_directory).unwrap();
        let tampered = tampered_directory.join(INFRASTRUCTURE_FILE);
        let mut bytes = std::fs::read(infrastructure_path()).unwrap();
        bytes[0] = if bytes[0] == b'{' { b'[' } else { b'{' };
        std::fs::write(&tampered, bytes).unwrap();
        assert!(
            super::initialize_operational_simulation(&input_json, tampered.to_str().unwrap(),)
                .is_err()
        );
    }

    #[test]
    fn program_templates_require_native_dispatch_binding_and_start_empty() {
        let mut duplicate = initialization();
        let mut second = duplicate.trains[0].clone();
        second.id = "train:2".to_owned();
        second.train_number = "RB 2".to_owned();
        duplicate.trains.push(second);
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&duplicate).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(initialized["state"]["world"]["trains"], json!({}));
        assert_eq!(initialized["liveMap"]["trains"], json!([]));
        let receipt = &initialized["validationReceipt"];
        assert_eq!(
            receipt["schemaVersion"],
            INITIALIZATION_VALIDATION_RECEIPT_SCHEMA
        );
        assert_eq!(receipt["worldId"], "world:1");
        assert_eq!(receipt["regionId"], "region:1");
        assert_eq!(
            receipt["initializationHash"],
            initialized["initializationHash"]
        );
        assert_eq!(receipt["stateHash"], initialized["stateHash"]);
        assert_eq!(
            receipt["infraRelease"],
            initialized["state"]["infraRelease"]
        );
        assert_eq!(receipt["programTrainCount"], 2);
        assert_eq!(receipt["validatedProgramTemplateCount"], 2);
        assert_eq!(receipt["validatedRouteVersionCount"], 1);
        assert_eq!(receipt["validatedDispatchInterlockingRouteCount"], 1);
        assert_eq!(receipt["validatedResourceBindingCount"], 6);
        assert_eq!(receipt["validatedFormationBindingCount"], 1);
        assert_eq!(receipt["validatedTrainNumberCount"], 2);
        assert_eq!(
            receipt["protectionModeSelectionPolicy"],
            PROTECTION_MODE_SELECTION_POLICY_V1
        );
        assert_eq!(receipt["validatedProtectionModeSelectionCount"], 2);
        assert_eq!(
            receipt["protectionModeSelectionsSha256"],
            "208a9b4217bdf68c054bb78717e5c1ba237c84cbf40b143592fe15a3bb338437"
        );
        assert_eq!(receipt["protectionModeSelectionsValidated"], true);
        assert_eq!(receipt["validatedMovementContinuationCount"], 0);
        assert_eq!(
            receipt["movementContinuationsSha256"],
            "462d0239e9dbd79d82d05b9939675b26fcaee302ddc1f0053db75a1acf774e71"
        );
        assert_eq!(receipt["dynamicTrainCount"], 0);
        assert_eq!(receipt["resourceBindingsValidated"], true);
        assert_eq!(receipt["formationBindingsValidated"], true);
        assert_eq!(receipt["trainNumbersValidated"], true);
        assert_eq!(receipt["validationMode"], INFRASTRUCTURE_VALIDATION_MODE);

        let mut duplicate_number = initialization();
        let mut same_number = duplicate_number.trains[0].clone();
        same_number.id = "train:2".to_owned();
        same_number.train_number = "IC-1".to_owned();
        duplicate_number.trains.push(same_number);
        assert!(
            super::initialize_operational_simulation(
                &encode(&duplicate_number).unwrap(),
                infrastructure_path(),
            )
            .unwrap_err()
            .to_string()
            .starts_with("duplicate_train_number:")
        );

        let mut overlong_number = initialization();
        overlong_number.trains[0].train_number = "S4-1667972".to_owned();
        assert!(
            super::initialize_operational_simulation(
                &encode(&overlong_number).unwrap(),
                infrastructure_path(),
            )
            .unwrap_err()
            .to_string()
            .starts_with("invalid_train_number:")
        );

        let mut missing_dispatch = serde_json::to_value(initialization()).unwrap();
        missing_dispatch["trains"][0]
            .as_object_mut()
            .unwrap()
            .remove("dispatchInterlockingRouteId");
        assert!(
            super::initialize_operational_simulation(
                &missing_dispatch.to_string(),
                infrastructure_path(),
            )
            .is_err()
        );

        let mut foreign_dispatch = initialization();
        foreign_dispatch.trains[0].dispatch_interlocking_route_id =
            "interlocking:foreign".to_owned();
        assert!(
            super::initialize_operational_simulation(
                &encode(&foreign_dispatch).unwrap(),
                infrastructure_path(),
            )
            .is_err()
        );
    }

    #[test]
    fn program_template_preflight_scans_every_train_and_all_predicates() {
        let mut input = initialization();
        input.trains[0].head_route_mm = 100_001;
        input.trains[0].protection_mode_selection_runs[0].selected_protection_system =
            "lzb".to_owned();
        let mut second = input.trains[0].clone();
        second.id = "train:2".to_owned();
        second.train_number = "RB 2".to_owned();
        second.head_route_mm = 20_000;
        second.movement_kind = MovementKind::Shunting;
        second.protection_mode_selection_runs.clear();
        input.trains.push(second);

        let error = super::initialize_operational_simulation(
            &encode(&input).expect("Initialisierung serialisieren"),
            infrastructure_path(),
        )
        .expect_err("beide ungueltigen Programmvorlagen muessen gemeinsam scheitern")
        .to_string();
        assert!(error.starts_with("invalid_train_program_template:"));
        assert!(error.contains("2 von 2 Programmvorlagen ungueltig"));
        assert!(
            error.contains(
                "train:1=[head-within-route,protection-mode-selections,route-template,authority-end,release-after-tail]"
            ),
            "{error}"
        );
        assert!(
            error.contains(
                "train:2=[protection-mode-selections,movement-kind,route-template,authority-end,release-after-tail]"
            ),
            "{error}"
        );

        let mut unknown_policy = initialization();
        unknown_policy.protection_mode_selection_policy =
            "zugfolge-protection-mode-selection/foreign-v1".to_owned();
        assert!(
            super::initialize_operational_simulation(
                &encode(&unknown_policy).expect("Initialisierung serialisieren"),
                infrastructure_path(),
            )
            .expect_err("unbekannte Policy muss vor der Initialisierung scheitern")
            .to_string()
            .starts_with("unknown_protection_mode_selection_policy:")
        );
    }

    #[test]
    fn command_receipts_are_bounded_and_legacy_history_is_rejected() {
        let mut receipts = BTreeMap::new();
        for revision in 1..=u64::try_from(MAX_COMMAND_RECEIPTS + 2).unwrap() {
            insert_bounded_command_receipt(
                &mut receipts,
                format!("command:{revision:05}"),
                format!("{revision:064x}"),
                revision,
            );
        }
        assert_eq!(receipts.len(), MAX_COMMAND_RECEIPTS);
        assert!(!receipts.contains_key("command:00001"));
        assert!(!receipts.contains_key("command:00002"));
        assert!(receipts.contains_key(&format!("command:{:05}", MAX_COMMAND_RECEIPTS + 2)));
        assert!(valid_command_receipt_window(
            &receipts,
            u64::try_from(MAX_COMMAND_RECEIPTS + 2).unwrap()
        ));

        let long_running_revision = 52_697_u64;
        let oldest_retained =
            long_running_revision - u64::try_from(MAX_COMMAND_RECEIPTS).unwrap() + 1;
        let long_running_receipts = (oldest_retained..=long_running_revision)
            .map(|revision| {
                (
                    format!("command:{revision:05}"),
                    CommandReceipt {
                        command_hash: format!("{revision:064x}"),
                        applied_revision: revision,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(long_running_receipts.len(), MAX_COMMAND_RECEIPTS);
        assert!(valid_command_receipt_window(
            &long_running_receipts,
            long_running_revision
        ));
        let mut gapped_receipts = long_running_receipts.clone();
        gapped_receipts.remove(&format!("command:{oldest_retained:05}"));
        assert!(!valid_command_receipt_window(
            &gapped_receipts,
            long_running_revision
        ));

        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let mut legacy = initialized["state"].clone();
        legacy["world"]["processedCommandIds"] = json!(["legacy:1"]);
        assert!(restore_value(&legacy, &initialized["initializationHash"]).is_err());
    }

    #[test]
    fn external_command_hash_uses_the_native_typed_payload_canonical_form() {
        let first = hash_operational_simulation_command(
            r#"{"type":"safe-stop","trainId":"train:1","reason":"signal"}"#,
        )
        .unwrap();
        let reordered = hash_operational_simulation_command(
            r#"{"reason":"signal","trainId":"train:1","type":"safe-stop"}"#,
        )
        .unwrap();
        let changed = hash_operational_simulation_command(
            r#"{"type":"safe-stop","trainId":"train:1","reason":"switch"}"#,
        )
        .unwrap();

        assert_eq!(first, reordered);
        assert_ne!(first, changed);
    }

    #[test]
    fn rejects_a_tampered_persisted_world() {
        let mut initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let pristine = initialized["state"].clone();
        initialized["state"]["world"]["nowMs"] = json!(1);
        assert!(restore_value(&initialized["state"], &initialized["initializationHash"],).is_err());

        let mut embedded = pristine;
        embedded["world"]["infra"] = json!({ "routeVersions": {} });
        assert!(restore_value(&embedded, &initialized["initializationHash"]).is_err());
    }
}
