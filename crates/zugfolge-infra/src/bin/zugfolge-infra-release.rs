//! Dünne Datei-I/O-Orchestrierung für den autoritativen Rust-Releasecompiler.

use std::env;
use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::{collections::BTreeMap, collections::BTreeSet};

use serde_json::Value;
use sha2::{Digest, Sha256};
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

const DIRECT_LAUNCH_CONTEXT_SCHEMA: &str =
    "zugfolge-operational-v2-direct-system-launch-context/v1";
const DIRECT_LAUNCH_CONTEXT_KEYS: [&str; 9] = [
    "candidatePath",
    "candidateSidecarPath",
    "executionPinsPath",
    "nativeReceiptPath",
    "reportPath",
    "runtimePath",
    "schema",
    "sourceRoot",
    "specificationPath",
];

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or_default();
        let third = chunk.get(2).copied().unwrap_or_default();
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn canonical_launch_context(value: &Value) -> Result<Vec<u8>, Box<dyn Error>> {
    let object = value
        .as_object()
        .ok_or("Annual-Launch-Kontext muss ein Objekt sein.")?;
    let actual: BTreeSet<_> = object.keys().map(String::as_str).collect();
    let expected: BTreeSet<_> = DIRECT_LAUNCH_CONTEXT_KEYS.into_iter().collect();
    if actual != expected {
        return Err("Annual-Launch-Kontext besitzt fremde oder fehlende Felder.".into());
    }
    let mut canonical = BTreeMap::new();
    for key in DIRECT_LAUNCH_CONTEXT_KEYS {
        let content = object[key]
            .as_str()
            .ok_or("Annual-Launch-Kontextwerte muessen Zeichenketten sein.")?;
        if content.is_empty() || content.chars().any(char::is_control) {
            return Err("Annual-Launch-Kontext besitzt einen leeren oder ungueltigen Wert.".into());
        }
        canonical.insert(key.to_owned(), content.to_owned());
    }
    if canonical["schema"] != DIRECT_LAUNCH_CONTEXT_SCHEMA {
        return Err("Annual-Launch-Kontext besitzt ein unbekanntes Schema.".into());
    }
    Ok(serde_json::to_vec(&canonical)?)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn direct_launch_stage(plan: &Value) -> Result<&Value, Box<dyn Error>> {
    if plan["schema"] != "zugfolge-annual-infra-plan/v1" {
        return Err("Direkter Operational-v2-Start erhielt keinen Annual-Plan-v1.".into());
    }
    plan["stages"]
        .as_array()
        .and_then(|stages| {
            stages
                .iter()
                .find(|stage| stage["id"] == "operational-v2-derivation")
        })
        .ok_or_else(|| "Annual-Plan besitzt keine Operational-v2-Ableitung.".into())
}

fn verify_current_executor(direct: &Value) -> Result<PathBuf, Box<dyn Error>> {
    let proof = &direct["trustedExecutor"];
    if proof["mode"] != "pinned-rust-command-env-clear-v1"
        || proof["command"] != "run-annual-operational-v2"
    {
        return Err("Annual-Plan besitzt keinen gepinnten Rust-Executorvertrag.".into());
    }
    let relative_file = proof["file"]
        .as_str()
        .ok_or("Annual-Plan besitzt keinen Executorpfad.")?;
    if Path::new(relative_file).is_absolute()
        || relative_file.split('/').any(|segment| {
            segment.is_empty() || segment == "." || segment == ".." || segment.contains('\\')
        })
    {
        return Err("Annual-Plan besitzt keinen sicheren portablen Executorpfad.".into());
    }
    let current = fs::canonicalize(env::current_exe()?)?;
    let mut workspace_root = current.clone();
    for _ in relative_file.split('/') {
        if !workspace_root.pop() {
            return Err("Executorpfad kann keine Arbeitswurzel ableiten.".into());
        }
    }
    let expected = fs::canonicalize(workspace_root.join(relative_file))?;
    if current != expected {
        return Err(
            "Der laufende Rust-Executor ist nicht die im Annual-Plan gepinnte Datei.".into(),
        );
    }
    let bytes = fs::read(&current)?;
    if proof["bytes"].as_u64() != u64::try_from(bytes.len()).ok()
        || proof["sha256"].as_str() != Some(sha256_bytes(&bytes).as_str())
    {
        return Err("Der laufende Rust-Executor driftet von seinem Annual-Plan-Bytebeleg.".into());
    }
    Ok(workspace_root)
}

fn direct_command_line_code_units(command: &str, arguments: &[String]) -> usize {
    let quoted_command = command.encode_utf16().count() + 2;
    quoted_command
        + arguments
            .iter()
            .map(|argument| {
                let content = argument.encode_utf16().count();
                1 + if argument.chars().any(char::is_whitespace) {
                    content + 2
                } else {
                    content
                }
            })
            .sum::<usize>()
}

fn execute_direct_annual_launch(plan: &Value, context: &Value) -> Result<(), Box<dyn Error>> {
    let stage = direct_launch_stage(plan)?;
    if stage["executionMode"] != "held-contract-direct-system-launch-v1" {
        return Err("Annual-Plan besitzt keinen direkten gehaltenen Operational-v2-Start.".into());
    }
    let direct = &stage["directSystemLaunch"];
    let context_bytes = canonical_launch_context(context)?;
    let workspace_root = verify_current_executor(direct)?;
    let command = direct["command"]
        .as_str()
        .ok_or("Annual-Plan besitzt keinen direkten Systembefehl.")?;
    let working_directory = direct["workingDirectory"]
        .as_str()
        .ok_or("Annual-Plan besitzt kein direktes Arbeitsverzeichnis.")?;
    if command != r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        || working_directory != r"C:\Windows\System32"
        || direct["environmentMode"] != "replace-exactly-no-inheritance-v1"
        || direct["windowsProcessContract"]["mode"]
            != "create-process-argv-and-explicit-environment-v1"
    {
        return Err("Annual-Plan verletzt den festen Windows-Prozessvertrag.".into());
    }
    let arguments: Vec<String> = direct["arguments"]
        .as_array()
        .ok_or("Annual-Plan besitzt keine direkten Systemargumente.")?
        .iter()
        .map(|argument| {
            argument
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or("Annual-Plan-Systemargument ist keine Zeichenkette.")
        })
        .collect::<Result<_, _>>()?;
    if arguments.len() != 7
        || arguments[..6]
            != [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
            ]
        || arguments[6].is_empty()
        || direct_command_line_code_units(command, &arguments) > 30_000
    {
        return Err(
            "Annual-Plan besitzt keine begrenzte kanonische PowerShell-Kommandozeile.".into(),
        );
    }
    let environment_object = direct["environment"]
        .as_object()
        .ok_or("Annual-Plan besitzt keine direkte Ersatzumgebung.")?;
    let mut environment = BTreeMap::new();
    for (name, value) in environment_object {
        if name.is_empty() || name.contains('=') || name.chars().any(char::is_control) {
            return Err("Annual-Plan besitzt einen ungueltigen Umgebungsnamen.".into());
        }
        let value = value
            .as_str()
            .ok_or("Annual-Plan-Umgebungswert ist keine Zeichenkette.")?;
        if value.chars().any(char::is_control) {
            return Err("Annual-Plan besitzt einen ungueltigen Umgebungswert.".into());
        }
        environment.insert(name.clone(), value.to_owned());
    }
    let context_binding = environment
        .get_mut("ZUGFOLGE_OPERATIONAL_LAUNCH_CONTEXT_BASE64")
        .ok_or("Annual-Plan besitzt keine Kontextbindung.")?;
    if context_binding != "{launchContextBase64}" {
        return Err("Annual-Plan besitzt keine unmaterialisierte Kontextbindung.".into());
    }
    *context_binding = base64_encode(&context_bytes);
    let workspace_binding = environment
        .get_mut("ZUGFOLGE_OPERATIONAL_WORKSPACE_ROOT")
        .ok_or("Annual-Plan besitzt keine kausal abgeleitete Arbeitswurzelbindung.")?;
    if workspace_binding != "{trustedExecutorWorkspaceRoot}" {
        return Err("Annual-Plan besitzt keine unmaterialisierte Arbeitswurzelbindung.".into());
    }
    let workspace_text = workspace_root
        .to_str()
        .ok_or("Kausal abgeleitete Arbeitswurzel ist nicht Unicode.")?;
    *workspace_binding = if let Some(path) = workspace_text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else {
        workspace_text
            .strip_prefix(r"\\?\")
            .unwrap_or(workspace_text)
            .to_owned()
    };

    let status = Command::new(command)
        .args(&arguments)
        .current_dir(working_directory)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;
    if !status.success() {
        return Err(format!("Direkter Operational-v2-Systemstart scheiterte mit {status}.").into());
    }
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
        [command, config, catalog, rights, context] if command == "run-annual-operational-v2" => {
            let plan = build_annual_infra_plan(
                &read_json(config)?,
                &read_json(catalog)?,
                &read_json(rights)?,
            )?;
            execute_direct_annual_launch(&plan, &read_json(context)?)?;
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
                "Aufruf: zugfolge-infra-release reference-report|qualified-reference-manifest|verify-reference-chain < INPUT | validate-operational-infrastructure-v2 CANDIDATE EXPECTED_RELEASE_ID [OUTPUT] | preflight-germany-turnarounds-v2 SPEC SOURCE_ROOT | derive-germany-operational-v2 SPEC SOURCE_ROOT CANDIDATE REPORT | regional-manifest CONFIG SOURCE_ROOT ARTIFACT_ROOT OUTPUT | plan CONFIG CATALOG RIGHTS | run-annual-operational-v2 CONFIG CATALOG RIGHTS CONTEXT | manifest CONFIG CATALOG RIGHTS CAPTURE ARTIFACTS QUALITY OUTPUT | manifest CONFIG CATALOG RIGHTS CAPTURE ARTIFACTS STATIC_QUALITY OPERATIONAL_QUALITY OUTPUT"
                    .into(),
            );
        }
    }
    Ok(())
}
