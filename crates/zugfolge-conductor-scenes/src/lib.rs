//! Reine M15.5-Sicht auf committed Operational-Bewegung und gepinnte Szenendaten.
//! Keine Uhr, Datenbank, zufälligen Ersatzdaten oder rückwirkenden Betriebsbefehle.

mod projection;
mod types;
mod validation;

pub use projection::{project_conductor_scene, project_conductor_scene_json};
pub use types::*;
pub use validation::{
    hash_scene_release, validate_scene_release, validate_scene_release_infrastructure,
};

use serde::Serialize;
use sha2::{Digest, Sha256};

fn issue(code: &str) -> ConductorSceneIssueV1 {
    ConductorSceneIssueV1 {
        code: code.to_owned(),
    }
}

fn digest(value: &impl Serialize) -> Result<String, ConductorSceneIssueV1> {
    let bytes = serde_json::to_vec(value).map_err(|_| issue("scene_serialization_failed"))?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
