//! Dünne Datei-I/O-Orchestrierung für den autoritativen Rust-Releasecompiler.

use std::env;
use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::io::{self, Read};

use serde_json::Value;
use zugfolge_infra::{
    build_annual_infra_plan, build_mitteldeutschland_infra_release, build_public_infra_release,
    build_public_infra_release_with_operational_quality, build_qualified_reference_release,
    build_reference_report, derive_germany_operational_v2, preflight_germany_turnarounds_v2,
    validate_operational_infrastructure_v2_file, verify_reference_artifact_chain,
};

fn read_json(path: &str) -> Result<Value, Box<dyn Error>> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn write_json_new(path: &str, value: &Value) -> Result<(), Box<dyn Error>> {
    let mut serialized = serde_json::to_string_pretty(value)?;
    serialized.push('\n');
    let mut output = OpenOptions::new().write(true).create_new(true).open(path)?;
    output.write_all(serialized.as_bytes())?;
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
        [command, candidate, expected_release_id]
            if command == "validate-operational-infrastructure-v2" =>
        {
            let validated = validate_operational_infrastructure_v2_file(
                candidate.as_ref(),
                expected_release_id,
                None,
            )?;
            println!("{}", serde_json::to_string(&validated)?);
        }
        [command, candidate, expected_release_id, output]
            if command == "validate-operational-infrastructure-v2" =>
        {
            let validated = validate_operational_infrastructure_v2_file(
                candidate.as_ref(),
                expected_release_id,
                Some(output.as_ref()),
            )?;
            println!("{}", serde_json::to_string(&validated)?);
        }
        [command, spec, source_root, candidate, report]
            if command == "derive-germany-operational-v2" =>
        {
            let receipt = derive_germany_operational_v2(
                spec.as_ref(),
                source_root.as_ref(),
                candidate.as_ref(),
                report.as_ref(),
            )?;
            println!("{}", serde_json::to_string(&receipt)?);
        }
        [command, spec, source_root] if command == "preflight-germany-turnarounds-v2" => {
            let report = preflight_germany_turnarounds_v2(spec.as_ref(), source_root.as_ref())?;
            println!("{}", serde_json::to_string(&report)?);
        }
        [command, config, source_root, artifact_root, output] if command == "regional-manifest" => {
            let workspace_root = env::current_dir()?;
            let release = build_mitteldeutschland_infra_release(
                &read_json(config)?,
                &workspace_root,
                source_root.as_ref(),
                artifact_root.as_ref(),
            )?;
            write_json_new(output, &release)?;
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
            write_json_new(output, &release)?;
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({
                    "releaseId": release["release"]["releaseId"],
                    "releaseHash": release["releaseHash"],
                }))?
            );
        }
        [
            command,
            config,
            catalog,
            rights,
            capture,
            artifacts,
            static_quality,
            operational_quality,
            output,
        ] if command == "manifest" => {
            let artifacts_envelope = read_json(artifacts)?;
            let artifacts = artifacts_envelope
                .get("artifacts")
                .unwrap_or(&artifacts_envelope);
            let static_quality_bytes = fs::read(static_quality)?;
            let operational_quality_bytes = fs::read(operational_quality)?;
            let release = build_public_infra_release_with_operational_quality(
                &read_json(config)?,
                &read_json(catalog)?,
                &read_json(rights)?,
                &read_json(capture)?,
                artifacts,
                &static_quality_bytes,
                &operational_quality_bytes,
            )?;
            write_json_new(output, &release)?;
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
                "Aufruf: zugfolge-infra-release reference-report|qualified-reference-manifest|verify-reference-chain < INPUT | validate-operational-infrastructure-v2 CANDIDATE EXPECTED_RELEASE_ID [OUTPUT] | preflight-germany-turnarounds-v2 SPEC SOURCE_ROOT | derive-germany-operational-v2 SPEC SOURCE_ROOT CANDIDATE REPORT | regional-manifest CONFIG SOURCE_ROOT ARTIFACT_ROOT OUTPUT | plan CONFIG CATALOG RIGHTS | manifest CONFIG CATALOG RIGHTS CAPTURE ARTIFACTS QUALITY OUTPUT | manifest CONFIG CATALOG RIGHTS CAPTURE ARTIFACTS STATIC_QUALITY OPERATIONAL_QUALITY OUTPUT"
                    .into(),
            );
        }
    }
    Ok(())
}
