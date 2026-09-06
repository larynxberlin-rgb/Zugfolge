//! Schmale Delegation an den autoritativen Kontrollfallkern.
use napi_derive::napi;
/// Liefert nur die nächste fachliche Frist; keine Plattform-Zeitregel.
#[napi(js_name = "nextFareControlWakeup")]
pub fn next_fare_control_wakeup(input_json: String) -> napi::Result<String> {
    zugfolge_fare_control::next_fare_control_wakeup_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Prüft den typisierten Fachvertrag ausschließlich im Rust-Kern.
#[napi(js_name = "initializeFareControl")]
pub fn initialize_fare_control(input_json: String) -> napi::Result<String> {
    zugfolge_fare_control::initialize_fare_control_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Prüft den typisierten Fachvertrag ausschließlich im Rust-Kern.
#[napi(js_name = "applyFareControl")]
pub fn apply_fare_control(input_json: String) -> napi::Result<String> {
    zugfolge_fare_control::apply_fare_control_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Prüft den typisierten Fachvertrag ausschließlich im Rust-Kern.
#[napi(js_name = "restoreFareControl")]
pub fn restore_fare_control(input_json: String) -> napi::Result<String> {
    zugfolge_fare_control::restore_fare_control_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Prüft den typisierten Fachvertrag ausschließlich im Rust-Kern.
#[napi(js_name = "projectFareCases")]
pub fn project_fare_cases(input_json: String) -> napi::Result<String> {
    zugfolge_fare_control::project_fare_cases_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Projiziert Kontrollfälle und den belegten Tagesbericht im selben Kernaufruf.
#[napi(js_name = "projectFareControlReport")]
pub fn project_fare_control_report(input_json: String) -> napi::Result<String> {
    zugfolge_fare_control::project_fare_control_report_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Prüft den typisierten Fachvertrag ausschließlich im Rust-Kern.
#[napi(js_name = "hashFareInspectionPolicy")]
pub fn hash_fare_inspection_policy(input_json: String) -> napi::Result<String> {
    zugfolge_fare_control::fare_inspection_policy_hash_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Prüft den typisierten Fachvertrag ausschließlich im Rust-Kern.
#[napi(js_name = "hashFareJourneyEvidence")]
pub fn hash_fare_journey_evidence(input_json: String) -> napi::Result<String> {
    zugfolge_fare_control::fare_journey_evidence_hash_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Prüft den typisierten Fachvertrag ausschließlich im Rust-Kern.
#[napi(js_name = "hashPoliceResponseModel")]
pub fn hash_police_response_model(input_json: String) -> napi::Result<String> {
    zugfolge_fare_control::police_response_model_hash_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
/// Prüft den typisierten Fachvertrag ausschließlich im Rust-Kern.
#[napi(js_name = "duePoliceResponse")]
pub fn due_police_response(input_json: String) -> napi::Result<String> {
    zugfolge_fare_control::police_response_due_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
