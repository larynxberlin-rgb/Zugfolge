//! Schmale echte Rust-CLI für Plattformnachweise und Offlinehashes.
use std::io::{self, Read};
use zugfolge_fare_control::*;
fn run() -> Result<String, FareControlError> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|_| FareControlError("fare_input_invalid"))?;
    match std::env::args().nth(1).as_deref() {
        Some("initialize") => initialize_fare_control_json(&input),
        Some("apply") => apply_fare_control_json(&input),
        Some("restore") => restore_fare_control_json(&input),
        Some("project") => project_fare_cases_json(&input),
        Some("next-wakeup") => next_fare_control_wakeup_json(&input),
        Some("policy-hash") => fare_inspection_policy_hash_json(&input),
        Some("journey-hash") => fare_journey_evidence_hash_json(&input),
        Some("model-hash") => police_response_model_hash_json(&input),
        Some("police-due") => police_response_due_json(&input),
        _ => Err(FareControlError("fare_operation_invalid")),
    }
}
fn main() {
    match run() {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
