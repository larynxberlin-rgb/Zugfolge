use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zugfolge_conductor::{
    BuildInteriorLayoutInputV1, InteriorLayoutV1, InteriorPointV1, PassengerProjectionV2,
    ProjectConductorPassengersInputV2,
};
use zugfolge_conductor_dialogue::{
    DialogueEvidenceV1, DialogueReleaseV1, DialogueStateV1, PassengerEncounterV1,
};
use zugfolge_sim::operational::OperationalWorld;

pub const STATE_SCHEMA: &str = "conductor-train-state/v1";
pub const POLICY_SCHEMA: &str = "conductor-session-policy/v1";
pub const COMMAND_SCHEMA: &str = "conductor-command/v1";
pub const SNAPSHOT_SCHEMA: &str = "conductor-session-snapshot/v1";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorSessionPolicyV1 {
    pub schema_version: String,
    pub policy_id: String,
    pub revision: u64,
    pub world_id: String,
    pub period_id: String,
    pub content_hash: String,
    pub lease_duration_ms: i64,
    pub command_window_ms: i64,
    pub max_commands_per_window: u32,
    pub min_command_interval_ms: i64,
    pub walk_speed_mm_per_second: u32,
    pub max_movement_burst_mm: u32,
    pub inspection_range_mm: u32,
    pub max_receipts: u32,
}

/// Ausschließlich im serialisierten Plattformzugriff aus echten Berechtigungen gebildet.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorSessionAccessV1 {
    pub world_id: String,
    pub operator_id: String,
    pub owner_ref: String,
    pub world_access_active: bool,
    pub operator_active: bool,
    pub train_use_authorized: bool,
    pub other_active_session_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorEncounterEvidenceV1 {
    pub encounter_id: String,
    pub evidence: DialogueEvidenceV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConductorControlReceiptKindV1 {
    Claim,
    Hold,
}

/// Verweis auf eine separat autoritativ angenommene Folge; kein M15.7-Fachentscheid.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorSessionControlReceiptV1 {
    pub world_id: String,
    pub train_run_id: String,
    pub effect_id: String,
    pub encounter_id: String,
    pub kind: ConductorControlReceiptKindV1,
    pub domain_receipt_id: String,
    pub domain_state_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorSessionSourceV1 {
    pub operational_world: OperationalWorld,
    pub expected_operational_world_hash: String,
    pub interior: Option<BuildInteriorLayoutInputV1>,
    pub projection: Option<ProjectConductorPassengersInputV2>,
    pub session_policy: ConductorSessionPolicyV1,
    pub current_dialogue_release_hash: String,
    pub dialogue_releases: Vec<DialogueReleaseV1>,
    pub encounter_evidence: Vec<ConductorEncounterEvidenceV1>,
    pub control_receipts: Vec<ConductorSessionControlReceiptV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorSessionPinsV1 {
    pub period_id: String,
    pub operational_world_hash: String,
    pub operational_formation_id: String,
    pub formation_id: String,
    pub vehicle_ids: Vec<String>,
    pub interior_layout_hash: String,
    pub demand_state_hash: String,
    pub manifest_revision: u64,
    pub projection_hash: String,
    pub dialogue_release_hash: String,
    pub policy_hash: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConductorSessionStatusV1 {
    Active,
    Detached,
    Ended,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConductorSessionEndReasonV1 {
    Requested,
    LeaseExpired,
    AccessRevoked,
    TrainCompleted,
    TrainUnavailable,
    FormationChanged,
    HistoricalExternalLeg,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorSessionV1 {
    pub session_id: String,
    pub operator_id: String,
    pub owner_ref: String,
    pub status: ConductorSessionStatusV1,
    pub revision: u64,
    pub now_ms: i64,
    pub started_at_ms: i64,
    pub lease_until_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub end_reason: Option<ConductorSessionEndReasonV1>,
    pub position: InteriorPointV1,
    pub active_encounter_id: Option<String>,
    pub pins: ConductorSessionPinsV1,
    pub policy: ConductorSessionPolicyV1,
    pub movement_budget_mm: u64,
    pub movement_budget_at_ms: i64,
    pub command_window_start_ms: i64,
    pub commands_in_window: u32,
    pub last_command_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorEncounterRecordV1 {
    pub encounter_id: String,
    pub passenger_key: String,
    pub dialogue: DialogueStateV1,
    pub closed_by_session: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConductorSessionEventKindV1 {
    Started,
    PositionChanged,
    InspectionStarted,
    EncounterAdvanced,
    Detached,
    Resumed,
    Ended,
    SourceSynchronized,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorSessionEventV1 {
    pub schema_version: String,
    pub world_id: String,
    pub train_run_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub revision: u64,
    pub at_ms: i64,
    pub causality_id: String,
    pub kind: ConductorSessionEventKindV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorCommandReceiptV1 {
    pub schema_version: String,
    pub world_id: String,
    pub train_run_id: String,
    pub session_id: String,
    pub idempotency_key: String,
    pub command_hash: String,
    pub revision: u64,
    pub sequence: u64,
    pub event_kind: ConductorSessionEventKindV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorTrainStateV1 {
    pub schema_version: String,
    pub world_id: String,
    pub train_run_id: String,
    pub revision: u64,
    pub sequence: u64,
    pub now_ms: i64,
    pub session: Option<ConductorSessionV1>,
    pub layout: Option<InteriorLayoutV1>,
    pub passengers: Option<PassengerProjectionV2>,
    pub encounters: BTreeMap<String, ConductorEncounterRecordV1>,
    pub control_receipts: BTreeMap<String, ConductorSessionControlReceiptV1>,
    pub command_receipts: BTreeMap<String, ConductorCommandReceiptV1>,
    pub state_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorSessionSnapshotV1 {
    pub schema_version: String,
    pub world_id: String,
    pub train_run_id: String,
    pub session_id: String,
    pub operator_id: String,
    pub status: ConductorSessionStatusV1,
    pub revision: u64,
    pub sequence: u64,
    pub now_ms: i64,
    pub lease_until_ms: i64,
    pub end_reason: Option<ConductorSessionEndReasonV1>,
    pub position: InteriorPointV1,
    pub pins: ConductorSessionPinsV1,
    pub passengers: PassengerProjectionV2,
    pub active_encounter: Option<PassengerEncounterV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_passenger_key: Option<String>,
    pub snapshot_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConductorCommandActionV1 {
    StartSession,
    Move {
        to: InteriorPointV1,
        transition_edge_id: Option<String>,
    },
    StartInspection {
        passenger_key: String,
    },
    ChooseDialogueOption {
        option_id: String,
    },
    RequestPolice {
        option_id: String,
    },
    DetachSession,
    ResumeSession,
    EndSession,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorCommandV1 {
    pub schema_version: String,
    pub world_id: String,
    pub train_run_id: String,
    pub session_id: String,
    pub expected_revision: u64,
    pub expected_manifest_revision: Option<u64>,
    pub idempotency_key: String,
    pub action: ConductorCommandActionV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConductorSessionEffectKindV1 {
    CloseWithoutAction,
    RequestDocumentCheck,
    RequestRegularClaim,
    RequestProvisionalClaim,
    RequestPolice,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorSessionEffectV1 {
    pub world_id: String,
    pub train_run_id: String,
    pub effect_id: String,
    pub encounter_id: String,
    pub passenger_key: String,
    pub kind: ConductorSessionEffectKindV1,
    pub at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializeConductorSessionStateInputV1 {
    pub schema_version: String,
    pub world_id: String,
    pub train_run_id: String,
    pub now_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyConductorSessionCommandInputV1 {
    pub schema_version: String,
    pub state: ConductorTrainStateV1,
    pub expected_state_hash: String,
    pub command: ConductorCommandV1,
    pub access: ConductorSessionAccessV1,
    pub source: ConductorSessionSourceV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SynchronizeConductorSessionInputV1 {
    pub schema_version: String,
    pub state: ConductorTrainStateV1,
    pub expected_state_hash: String,
    pub access: ConductorSessionAccessV1,
    pub source: ConductorSessionSourceV1,
    pub causality_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreConductorSessionStateInputV1 {
    pub schema_version: String,
    pub state: ConductorTrainStateV1,
    pub expected_state_hash: String,
    pub dialogue_releases: Vec<DialogueReleaseV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectConductorSessionSnapshotInputV1 {
    pub schema_version: String,
    pub state: ConductorTrainStateV1,
    pub expected_state_hash: String,
    pub access: ConductorSessionAccessV1,
    pub source: ConductorSessionSourceV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorSessionTransitionV1 {
    pub schema_version: String,
    pub state: ConductorTrainStateV1,
    pub state_hash: String,
    pub receipt: Option<ConductorCommandReceiptV1>,
    pub snapshot: Option<ConductorSessionSnapshotV1>,
    pub events: Vec<ConductorSessionEventV1>,
    pub effects: Vec<ConductorSessionEffectV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConductorSessionReplayStepV1 {
    Command {
        command: Box<ConductorCommandV1>,
        access: ConductorSessionAccessV1,
        source: Box<ConductorSessionSourceV1>,
        expected_result_hash: String,
    },
    Synchronize {
        access: ConductorSessionAccessV1,
        source: Box<ConductorSessionSourceV1>,
        causality_id: String,
        expected_result_hash: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayConductorSessionInputV1 {
    pub schema_version: String,
    pub initial_state: ConductorTrainStateV1,
    pub expected_initial_state_hash: String,
    pub dialogue_releases: Vec<DialogueReleaseV1>,
    pub steps: Vec<ConductorSessionReplayStepV1>,
}
