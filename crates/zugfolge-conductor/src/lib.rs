//! Deterministische private M15.2-Projektion der tatsächlichen M10-SPNV-Belegung.
//! Fachvertrag: docs/schaffnermodus.md, Abschnitte 3 und 4.
#![allow(missing_docs, reason = "Versionierte Felder folgen dem Fachvertrag")]

mod engine;
mod places;
mod types;

pub use engine::{
    interior_places_hash, project_conductor_passengers, project_conductor_passengers_json,
};
pub use types::*;

/// Stabile datensparsame Fehler ohne Fahrgastkennung oder Fahrausweisfakt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConductorError(pub String);

impl std::fmt::Display for ConductorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConductorError {}

impl From<serde_json::Error> for ConductorError {
    fn from(_: serde_json::Error) -> Self {
        Self("invalid_conductor_json".into())
    }
}

fn ensure(valid: bool, reason: &str) -> Result<(), ConductorError> {
    if valid {
        Ok(())
    } else {
        Err(ConductorError(reason.into()))
    }
}
