use crate::*;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub(crate) const MAX_SAFE: i64 = 9_007_199_254_740_991;
pub(crate) fn require(value: bool, code: &'static str) -> Result<(), ConductorSessionError> {
    if value {
        Ok(())
    } else {
        Err(ConductorSessionError(code))
    }
}
pub(crate) fn id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 500 && !value.chars().any(char::is_control)
}
pub(crate) fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn digest(value: &impl Serialize) -> Result<String, ConductorSessionError> {
    Ok(Sha256::digest(serde_json::to_vec(value)?)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
pub(crate) fn key(parts: &[&str]) -> String {
    digest(&parts).expect("feste Zeichenketten")
}
pub fn conductor_session_state_hash(
    state: &ConductorTrainStateV1,
) -> Result<String, ConductorSessionError> {
    let mut state = state.clone();
    state.state_hash.clear();
    digest(&state)
}
pub fn conductor_session_policy_hash(
    policy: &ConductorSessionPolicyV1,
) -> Result<String, ConductorSessionError> {
    let mut policy = policy.clone();
    policy.content_hash.clear();
    digest(&policy)
}
pub fn operational_world_hash(world: &zugfolge_sim::operational::OperationalWorld) -> String {
    world.state_hash().to_hex()
}
pub(crate) fn validate_policy(
    policy: &ConductorSessionPolicyV1,
) -> Result<(), ConductorSessionError> {
    require(
        policy.schema_version == POLICY_SCHEMA
            && [&policy.policy_id, &policy.world_id, &policy.period_id]
                .into_iter()
                .all(|v| id(v))
            && policy.revision > 0
            && policy.revision <= u64::try_from(MAX_SAFE).expect("positiv")
            && hash(&policy.content_hash)
            && conductor_session_policy_hash(policy)? == policy.content_hash,
        "invalid_session_policy",
    )?;
    require(
        (5_000..=600_000).contains(&policy.lease_duration_ms)
            && (100..=60_000).contains(&policy.command_window_ms)
            && (1..=1000).contains(&policy.max_commands_per_window)
            && (0..=1000).contains(&policy.min_command_interval_ms)
            && (100..=3000).contains(&policy.walk_speed_mm_per_second)
            && (1..=10_000).contains(&policy.max_movement_burst_mm)
            && (500..=2500).contains(&policy.inspection_range_mm)
            && (128..=262_144).contains(&policy.max_receipts),
        "invalid_session_policy_bounds",
    )
}
pub(crate) fn add_time(at: i64, duration: i64) -> Result<i64, ConductorSessionError> {
    let value = at
        .checked_add(duration)
        .ok_or(ConductorSessionError("session_time_overflow"))?;
    require((0..=MAX_SAFE).contains(&value), "session_time_overflow")?;
    Ok(value)
}
