//! Dünne Datei-I/O-Orchestrierung für den autoritativen Rust-Releasecompiler.

use std::env;
use std::error::Error;
use std::fs;
use std::io::{self, Read};

use serde_json::Value;
use zugfolge_infra::{
    build_annual_infra_plan, build_mitteldeutschland_infra_release, build_public_infra_release,
    build_qualified_reference_release, build_reference_report, verify_reference_artifact_chain,
};

fn read_json(path: &str) -> Result<Value, Box<dyn Error>> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn write_json(path: &str, value: &Value) -> Result<(), Box<dyn Error>> {
    let mut serialized = serde_json::to_string_pretty(value)?;
    serialized.push('\n');
    fs::write(path, serialized)?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<_> = env::args().skip(1).collect();
    match arguments.as_slice() {
        [command] if command == "qualified-reference-manifest" => {
            let mut serialized = Vec::new();
            io::stdin().read_to_end(&mut serialized)?;
            let envelope: Value = serde_json::from_slice(&serialized)?;
            let input = envelope.get("input").ok_or("Compiler-Eingabe fehlt.")?;
            let release = build_qualified_reference_release(input)?;
            println!("{}", serde_json::to_string(&release)?);
        }
        [command] if command == "reference-report" => {
            let mut serialized = Vec::new();
            io::stdin().read_to_end(&mut serialized)?;
            let envelope: Value = serde_json::from_slice(&serialized)?;
            let input = envelope.get("input").ok_or("Compiler-Eingabe fehlt.")?;
            let report = build_reference_report(input)?;
            println!("{}", serde_json::to_string(&report)?);
        }
        [command] if command == "verify-reference-chain" => {
            let mut serialized = Vec::new();
            io::stdin().read_to_end(&mut serialized)?;
            let envelope: Value = serde_json::from_slice(&serialized)?;
            let input = envelope.get("input").ok_or("Compiler-Eingabe fehlt.")?;
            let verified = verify_reference_artifact_chain(input)?;
            println!("{}", serde_json::to_string(&verified)?);
        }
        [command, source_root, artifact_root, output] if command == "legacy-manifest" => {
            let workspace_root = env::current_dir()?;
            let release = build_mitteldeutschland_infra_release(
                &workspace_root,
                source_root.as_ref(),
                artifact_root.as_ref(),
            )?;
            write_json(output, &release)?;
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({
                    "releaseId": release["releaseId"],
                    "schema": release["schema"],
                }))?
            );
        }
        [command, config, catalog, rights] if command == "plan" => {
            let plan = build_annual_infra_plan(
                &read_json(config)?,
                &read_json(catalog)?,
                &read_json(rights)?,
            )?;
            println!("{}", serde_json::to_string_pretty(&plan)?);
        }
        [
            command,
            config,
            catalog,
            rights,
            capture,
            artifacts,
            quality,
            output,
        ] if command == "manifest" => {
            let artifacts_envelope = read_json(artifacts)?;
            let artifacts = artifacts_envelope
                .get("artifacts")
                .unwrap_or(&artifacts_envelope);
            let quality_envelope = read_json(quality)?;
            let quality = quality_envelope.get("report").unwrap_or(&quality_envelope);
            let release = build_public_infra_release(
                &read_json(config)?,
                &read_json(catalog)?,
                &read_json(rights)?,
                &read_json(capture)?,
                artifacts,
                quality,
            )?;
            write_json(output, &release)?;
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({
                    "releaseId": release["release"]["releaseId"],
                    "releaseHash": release["releaseHash"],
                }))?
            );
        }
        _ => {
            return Err(
                "Aufruf: zugfolge-infra-release reference-report|qualified-reference-manifest|verify-reference-chain < INPUT | legacy-manifest SOURCE_ROOT ARTIFACT_ROOT OUTPUT | plan CONFIG CATALOG RIGHTS | manifest CONFIG CATALOG RIGHTS CAPTURE ARTIFACTS QUALITY OUTPUT"
                    .into(),
            );
        }
    }
    Ok(())
}
