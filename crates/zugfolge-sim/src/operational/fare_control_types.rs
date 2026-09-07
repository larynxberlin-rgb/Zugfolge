//! Versionierter Kontrollhaltvertrag; Fachgrundlage: docs/conductor-hold.md.
#![allow(
    missing_docs,
    reason = "Die vollständigen Transportverträge stehen im Fachvertrag"
)]
use super::{DispatchRequest, MovementAuthority};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const FARE_CONTROL_POLICY_SCHEMA: &str = "zugfolge-fare-control-policy/v1";
pub const FARE_CONTROL_HOLD_SCHEMA: &str = "zugfolge-fare-control-hold/v1";
pub const FARE_CONTROL_CAUSE: &str = "authority.police.fare-control";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FareControlReasonV1 {
    IdentityRefusal,
    ConcreteDanger,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareControlPolicyV1 {
    pub schema: String,
    pub policy_id: String,
    pub revision: u64,
    pub world_id: String,
    pub schedule_period_id: String,
    pub content_hash: String,
    pub max_police_holds_per_train_run: u8,
    pub eligible_reasons: BTreeSet<FareControlReasonV1>,
    pub target_rule: String,
    pub provider_by_stop_id: BTreeMap<String, String>,
    pub max_wait_ms: i64,
    pub police_response_model_id: String,
    pub police_response_model_hash: String,
    pub public_cause: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FareControlHoldStatusV1 {
    Requested,
    Active,
    Released,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FareControlHoldOutcomeV1 {
    IdentityConfirmed,
    IdentityNotConfirmed,
    Unavailable,
    Timeout,
    TargetUnavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolveFareControlHoldOutcomeV1 {
    IdentityConfirmed,
    IdentityNotConfirmed,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareControlHoldV1 {
    pub schema_version: String,
    pub world_id: String,
    pub train_run_id: String,
    pub hold_id: String,
    pub case_ids: BTreeSet<String>,
    pub target_stop_id: String,
    pub requested_at_ms: i64,
    pub activated_at_ms: Option<i64>,
    pub deadline_ms: Option<i64>,
    pub released_at_ms: Option<i64>,
    pub status: FareControlHoldStatusV1,
    pub outcome: Option<FareControlHoldOutcomeV1>,
    pub revision: u64,
    pub causality_id: String,
    pub provider_id: String,
    pub policy_hash: String,
    pub model_hash: String,
    pub policy: FareControlPolicyV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestFareControlHoldInputV1 {
    pub train_id: String,
    pub case_id: String,
    pub reason: FareControlReasonV1,
    pub causality_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveFareControlHoldInputV1 {
    pub train_id: String,
    pub hold_id: String,
    pub expected_revision: u64,
    pub model_hash: String,
    pub outcome: ResolveFareControlHoldOutcomeV1,
    pub causality_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareControlHoldEventV1 {
    pub schema_version: String,
    pub world_id: String,
    pub train_run_id: String,
    pub hold_id: String,
    pub target_stop_id: String,
    pub at_ms: i64,
    pub status: FareControlHoldStatusV1,
    pub outcome: Option<FareControlHoldOutcomeV1>,
    pub revision: u64,
    pub cause: String,
    pub causality_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ScheduledFareControlHold {
    pub at_ms: i64,
    pub train_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FareControlState {
    pub policy: Option<FareControlPolicyV1>,
    pub holds: BTreeMap<String, FareControlHoldV1>,
    pub scheduled: BTreeSet<ScheduledFareControlHold>,
    pub resume_requests: BTreeMap<String, DispatchRequest>,
    pub revoked_authorities: BTreeMap<String, MovementAuthority>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareControlHandoverV1 {
    pub hold: FareControlHoldV1,
    pub resume_request: Option<DispatchRequest>,
    pub revoked_authority: Option<MovementAuthority>,
}
