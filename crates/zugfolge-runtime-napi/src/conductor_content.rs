//! Geprüfte Offline-Inhalte ohne Plattform-Fachkopie.
use napi_derive::napi;

/// Prüft den Offline-Szenenkatalog unmittelbar gegen die tatsächliche Infrastruktur.
#[napi(js_name = "validateConductorSceneInfrastructure")]
pub fn validate_conductor_scene_infrastructure(input_json: String) -> napi::Result<String> {
    if input_json.len() > 128 * 1024 * 1024 {
        return Err(napi::Error::from_reason("scene_input_size_limit"));
    }
    let (release, infra) = serde_json::from_str(&input_json)
        .map_err(|_| napi::Error::from_reason("scene_input_json_invalid"))?;
    zugfolge_conductor_scenes::validate_scene_release_infrastructure(&release, &infra)
        .map_err(|error| napi::Error::from_reason(error.code))?;
    Ok("{\"valid\":true}".into())
}

/// Berechnet den gepinnten Kontrollhaltpolicyhash in derselben Betriebsdomäne.
#[napi(js_name = "hashFareControlPolicy")]
pub fn hash_fare_control_policy(input_json: String) -> napi::Result<String> {
    zugfolge_sim_runtime::operational_runtime::hash_fare_control_policy(&input_json)
        .map_err(|_| napi::Error::from_reason("invalid_fare_control_policy"))
}
/// Projiziert ausschließlich die gepinnte Betriebsszene.
#[napi(js_name = "projectConductorScene")]
pub fn project_conductor_scene(input_json: String) -> napi::Result<String> {
    zugfolge_conductor_scenes::project_conductor_scene_json(&input_json)
        .map_err(|error| napi::Error::from_reason(error.code))
}
/// Berechnet den tatsächlichen typisierten Szenenreleasehash.
#[napi(js_name = "hashConductorSceneRelease")]
pub fn hash_conductor_scene_release(input_json: String) -> napi::Result<String> {
    if input_json.len() > 128 * 1024 * 1024 {
        return Err(napi::Error::from_reason("conductor_content_size_limit"));
    }
    let release = serde_json::from_str(&input_json)
        .map_err(|_| napi::Error::from_reason("invalid_conductor_scene_json"))?;
    zugfolge_conductor_scenes::hash_scene_release(&release)
        .map_err(|error| napi::Error::from_reason(error.code))
}
/// Prüft den vollständigen versionierten Dialogkorpus im Fachkern.
#[napi(js_name = "validateConductorDialogueRelease")]
pub fn validate_conductor_dialogue_release(input_json: String) -> napi::Result<String> {
    if input_json.len() > 128 * 1024 * 1024 {
        return Err(napi::Error::from_reason("conductor_content_size_limit"));
    }
    let release = serde_json::from_str(&input_json)
        .map_err(|_| napi::Error::from_reason("invalid_conductor_dialogue_json"))?;
    let report = zugfolge_conductor_dialogue::validate_dialogue_release(&release)
        .map_err(|_| napi::Error::from_reason("invalid_conductor_dialogue_release"))?;
    serde_json::to_string(&report)
        .map_err(|_| napi::Error::from_reason("conductor_dialogue_serialization_failed"))
}
