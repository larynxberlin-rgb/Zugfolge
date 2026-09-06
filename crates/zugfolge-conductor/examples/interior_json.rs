//! JSON-Prüfgrenze für den tatsächlichen M5-Innenraumkern.
use std::io::{Read, Write};
use zugfolge_conductor::*;
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let command=std::env::args().nth(1).ok_or("Erforderlich: build, bind, path, movement, policy-hash, configuration-hash oder authority-hash")?;
    let mut json = String::new();
    std::io::stdin()
        .take(128 * 1024 * 1024 + 1)
        .read_to_string(&mut json)?;
    if json.len() > 128 * 1024 * 1024 {
        return Err("interior_input_size_limit".into());
    }
    let output = match command.as_str() {
        "build" => build_interior_layout_json(&json)?,
        "bind" => bind_interior_passenger_places_json(&json)?,
        "path" => find_interior_path_json(&json)?,
        "movement" => check_interior_movement_json(&json)?,
        "project-v2" => project_conductor_passengers_v2_json(&json)?,
        "policy-hash" => interior_geometry_policy_hash(
            &serde_json::from_str(&json).map_err(|_| "invalid_conductor_json")?,
        )?,
        "configuration-hash" => vehicle_configuration_hash(
            &serde_json::from_str(&json).map_err(|_| "invalid_conductor_json")?,
        )?,
        "authority-hash" => interior_authority_hash(
            &serde_json::from_str(&json).map_err(|_| "invalid_conductor_json")?,
        )?,
        _ => return Err("Unbekannter Innenraum-Prüfbefehl".into()),
    };
    std::io::stdout().write_all(output.as_bytes())?;
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
