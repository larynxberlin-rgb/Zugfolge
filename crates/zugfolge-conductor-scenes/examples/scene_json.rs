//! Zeilenbasierte, ausschließlich lokale CLI für echte Native-Nachweise.
use std::io::{self, BufRead};
use zugfolge_conductor_scenes::{
    ConductorSceneReleaseV1, hash_scene_release, project_conductor_scene_json,
    validate_scene_release_infrastructure,
};
use zugfolge_sim::operational::OperationalInfraRelease;

fn main() {
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "project".to_owned());
    for line in io::stdin().lock().lines() {
        let result = line
            .map_err(|_| "scene_input_read_failed".to_owned())
            .and_then(|line| match command.as_str() {
                "project" => project_conductor_scene_json(&line).map_err(|e| e.code),
                "hash-release" => serde_json::from_str::<ConductorSceneReleaseV1>(&line)
                    .map_err(|_| "scene_input_json_invalid".to_owned())
                    .and_then(|r| hash_scene_release(&r).map_err(|e| e.code))
                    .map(|hash| serde_json::json!({"sceneReleaseHash":hash}).to_string()),
                "validate-infrastructure" => serde_json::from_str::<(
                    ConductorSceneReleaseV1,
                    OperationalInfraRelease,
                )>(&line)
                .map_err(|_| "scene_input_json_invalid".to_owned())
                .and_then(|(release, infra)| {
                    validate_scene_release_infrastructure(&release, &infra).map_err(|e| e.code)
                })
                .map(|()| "{\"valid\":true}".to_owned()),
                _ => Err("scene_command_invalid".to_owned()),
            });
        println!(
            "{}",
            match result {
                Ok(value) => value,
                Err(code) => serde_json::json!({"error":code}).to_string(),
            }
        );
    }
}
