//! Schmale echte Rust-CLI für Plattformnachweise und Offlinehashes.
use std::io::{self, Read};
use zugfolge_fare_control::*;
// Nur die lokale Test-/Browserauswahl spart Prozessstarts. Dieselben echten
// Open-/Inspect-Kommandos laufen isoliert; kein Zustand wird persistiert.
fn candidates(input: &str) -> Result<String, FareControlError> {
    let pins: Vec<FareInspectionPinV1> = serde_json::from_str(input)
        .map_err(|_| FareControlError("fare_candidate_input_invalid"))?;
    if pins.len() > 1000 {
        return Err(FareControlError("fare_candidate_input_invalid"));
    }
    let mut rows = Vec::new();
    for pin in pins {
        let world = pin.world_id.clone();
        let operator = pin.operator_id.clone();
        let now = pin.inspected_at_ms;
        let initial = initialize_fare_control(&world, &operator, now)?;
        let opened = apply_fare_control(
            &initial,
            &initial.state_hash,
            &FareControlCommandV1 {
                world_id: world.clone(),
                operator_id: operator.clone(),
                command_id: "candidate-open".into(),
                expected_revision: 0,
                now_ms: now,
                action: FareControlActionV1::OpenCase {
                    case_id: "candidate".into(),
                    pin: Box::new(pin.clone()),
                },
            },
        )?;
        let checked = apply_fare_control(
            &opened.state,
            &opened.state.state_hash,
            &FareControlCommandV1 {
                world_id: world,
                operator_id: operator,
                command_id: "candidate-check".into(),
                expected_revision: opened.state.revision,
                now_ms: now,
                action: FareControlActionV1::InspectDocument {
                    case_id: "candidate".into(),
                },
            },
        )?;
        rows.push(serde_json::json!({"passengerKey":pin.passenger.passenger_key,"fareFact":pin.passenger.fare_fact,"evidence":checked.state.cases["candidate"].evidence}));
    }
    serde_json::to_string(&rows).map_err(|_| FareControlError("fare_candidate_output_invalid"))
}
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
        Some("report") => project_fare_control_report_json(&input),
        Some("next-wakeup") => next_fare_control_wakeup_json(&input),
        Some("policy-hash") => fare_inspection_policy_hash_json(&input),
        Some("journey-hash") => fare_journey_evidence_hash_json(&input),
        Some("model-hash") => police_response_model_hash_json(&input),
        Some("police-due") => police_response_due_json(&input),
        Some("inspect-candidates") => candidates(&input),
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
