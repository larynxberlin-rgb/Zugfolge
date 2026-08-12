//! Validiert einen erzeugten Fleet-Bootstrap mit dem echten Rust-Single-Writer.
use std::fs;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let input_path = std::env::args()
        .nth(1)
        .ok_or("Aufruf: fleet_release_hash INPUT.json")?;
    let input = fs::read_to_string(input_path)?;
    let initialized = zugfolge_runtime::initialize_fleet_world(&input)?;
    let result: serde_json::Value = serde_json::from_str(&initialized)?;
    let release_hash = result
        .get("state")
        .and_then(|state| state.get("authorityReleaseHash"))
        .and_then(serde_json::Value::as_str)
        .ok_or("Authority-Release-Hash fehlt")?;
    let formations = result
        .get("state")
        .and_then(|state| state.get("formations"))
        .and_then(serde_json::Value::as_object)
        .map_or(0, serde_json::Map::len);
    let duties = result
        .get("state")
        .and_then(|state| state.get("personnelDuties"))
        .and_then(serde_json::Value::as_object)
        .map_or(0, serde_json::Map::len);
    let paths = result
        .get("state")
        .and_then(|state| state.get("pathReservations"))
        .and_then(serde_json::Value::as_object)
        .map_or(0, serde_json::Map::len);
    println!(
        "{}",
        serde_json::json!({
            "authorityReleaseHash": release_hash,
            "formationCount": formations,
            "personnelDutyCount": duties,
            "pathReservationCount": paths,
        })
    );
    Ok(())
}
