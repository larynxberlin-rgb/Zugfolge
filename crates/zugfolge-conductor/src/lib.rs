//! Deterministische private M15.2-Projektion der tatsächlichen M10-SPNV-Belegung.
//! Fachvertrag: docs/schaffnermodus.md, Abschnitte 3 und 4.
#![allow(missing_docs, reason = "Versionierte Felder folgen dem Fachvertrag")]

mod engine;
mod interior;
mod interior_geometry;
mod interior_movement;
mod interior_types;
mod places;
mod projection_v2;
mod types;

pub use engine::{
    interior_places_hash, project_conductor_passengers, project_conductor_passengers_json,
};
pub use interior::{
    bind_interior_passenger_places, bind_interior_passenger_places_json, build_interior_layout,
    build_interior_layout_json, interior_authority_hash, interior_geometry_policy_hash,
    interior_layout_hash, vehicle_configuration_hash,
};
pub use interior_movement::{
    check_interior_movement, check_interior_movement_json, find_interior_path,
    find_interior_path_json,
};
pub use interior_types::*;
pub use projection_v2::{
    interior_places_v2_hash, project_conductor_passengers_v2, project_conductor_passengers_v2_json,
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
