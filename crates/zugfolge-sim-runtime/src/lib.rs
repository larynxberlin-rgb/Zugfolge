//! Persistierbare, versionierte Befehlsgrenze der autoritativen Operational-v2-Runtime.
//!
//! Die produktive Laufzeit kennt nur noch den physischen Betriebszustand aus
//! [`operational_runtime`]. Der historische Waypoint-/`AddDelay`-Vertrag ist
//! absichtlich nicht mehr Bestandteil dieses Crates.
#![allow(
    missing_docs,
    reason = "die versionierten JSON-Felder werden durch Vertragstests beschrieben"
)]

pub mod daily_restrictions;
mod initialization_hash;
pub mod operational_runtime;
