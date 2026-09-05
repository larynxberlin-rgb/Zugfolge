//! Reiner, ganzzahliger Personenverkehrskern. Fachvertrag: docs/personenverkehr.md.
#![allow(
    missing_docs,
    reason = "Öffentliche Felder folgen dem versionierten Fachvertrag"
)]

mod calibration;
mod engine;
mod types;

pub use calibration::*;
pub use engine::{evaluate_demand, evaluate_demand_json, release_hash};
pub use types::*;

/// Strukturierter Fehler ohne individuelle Fahrgastdaten.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DemandError(pub String);

impl std::fmt::Display for DemandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DemandError {}

impl From<serde_json::Error> for DemandError {
    fn from(_: serde_json::Error) -> Self {
        Self("invalid_demand_json".into())
    }
}

pub(crate) fn ensure(valid: bool, reason: &str) -> Result<(), DemandError> {
    if valid {
        Ok(())
    } else {
        Err(DemandError(reason.into()))
    }
}
