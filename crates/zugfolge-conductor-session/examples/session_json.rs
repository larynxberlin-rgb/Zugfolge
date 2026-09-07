//! JSON-Prüfgrenze für Sitzung, Wiederaufnahme und deterministisches Replay.
use std::io::{Read, Write};
use zugfolge_conductor_session::*;
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let command=std::env::args().nth(1).ok_or("Erforderlich: initialize, apply, synchronize, restore, project, replay, operational-hash oder policy-hash")?;
    let mut input = String::new();
    std::io::stdin()
        .take(128 * 1024 * 1024 + 1)
        .read_to_string(&mut input)?;
    let output = match command.as_str() {
        "initialize" => initialize_conductor_session_state_json(&input)?,
        "apply" => apply_conductor_session_command_json(&input)?,
        "synchronize" => synchronize_conductor_session_json(&input)?,
        "restore" => restore_conductor_session_state_json(&input)?,
        "project" => project_conductor_session_snapshot_json(&input)?,
        "replay" => replay_conductor_session_json(&input)?,
        "operational-hash" => hash_conductor_operational_world_json(&input)?,
        "policy-hash" => hash_conductor_session_policy_json(&input)?,
        _ => return Err("Unbekannter Sitzungsprüfbefehl".into()),
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
