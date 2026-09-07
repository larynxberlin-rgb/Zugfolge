//! Reiner autoritativer Sitzungskern; Vertrag: docs/conductor-session.md.
#![allow(
    missing_docs,
    reason = "Versionierte Transportfelder stehen im Fachvertrag"
)]
mod types;
pub use types::*;
mod commands;
mod common;
mod source;
mod state;
mod transport;
pub use commands::{apply_conductor_session_command, synchronize_conductor_session};
pub use common::{
    conductor_session_policy_hash, conductor_session_state_hash, operational_world_hash,
};
pub use state::{
    initialize_conductor_session_state, project_conductor_session_snapshot,
    restore_conductor_session_state,
};
pub use transport::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConductorSessionError(pub &'static str);
impl std::fmt::Display for ConductorSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ConductorSessionError {}
impl From<serde_json::Error> for ConductorSessionError {
    fn from(_: serde_json::Error) -> Self {
        Self("invalid_conductor_session_json")
    }
}
