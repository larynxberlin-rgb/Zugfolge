//! Expliziter Realtest des signierten Deutschland-Alpha-Deployments.
//!
//! Der Test ist absichtlich ignoriert. Er braucht das lokal aus den gepinnten
//! 2026.4-Artefakten gebaute und ausserhalb von Git signierte Deployment sowie
//! die vollstaendige Operational-v2-Datei. Er beweist nativen Start, eine
//! committed Regionsrevision, kompakten Checkpoint und Restore unter 512 MiB.

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;

use serde_json::{Value, json};
use zugfolge_sim_runtime::operational_runtime::{
    COMMAND_SCHEMA, RESTORE_SCHEMA, apply_operational_simulation_command,
    initialize_operational_simulation, restore_operational_simulation,
};

const WORLD_ID: &str = "0db56535-a466-44a8-a991-38a8a1f7566c";
const REGION_ID: &str = "mitteldeutschland-b";
const INFRA_RELEASE_ID: &str = "infra-deutschland-2026.4";
const INFRA_BYTES: u64 = 983_736_272;
const INFRA_SHA256: &str = "64260fb3aca24d6ed8784c2a6891e1269b8f390c7b7db185bbee3001565f47e6";
const INFRA_STATE_HASH: &str = "deb038434d53963ba6436d4b6811ffc096374ffd1c75887b4945b4a46ea3c788";
const ALPHA_KEY_ID: &str = "zugfolge-alpha-2026.3";
const MAX_RSS_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES: usize = 16 * 1024 * 1024;

fn required_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} fehlt.")))
}

fn object<'a>(value: &'a Value, detail: &str) -> &'a serde_json::Map<String, Value> {
    value
        .as_object()
        .unwrap_or_else(|| panic!("{detail} ist kein Objekt."))
}

fn string(value: &Value, detail: &str) -> String {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| panic!("{detail} ist keine nichtleere Zeichenfolge."))
        .to_owned()
}

#[cfg(target_os = "linux")]
fn peak_rss_bytes() -> Result<u64, String> {
    let status = fs::read_to_string("/proc/self/status")
        .map_err(|error| format!("/proc/self/status kann nicht gelesen werden: {error}"))?;
    let line = status
        .lines()
        .find(|line| line.starts_with("VmHWM:"))
        .ok_or_else(|| "VmHWM fehlt in /proc/self/status.".to_owned())?;
    line.split_ascii_whitespace()
        .nth(1)
        .ok_or_else(|| "VmHWM besitzt keinen Zahlenwert.".to_owned())?
        .parse::<u64>()
        .map_err(|error| format!("VmHWM ist ungueltig: {error}"))?
        .checked_mul(1024)
        .ok_or_else(|| "VmHWM laeuft ueber.".to_owned())
}

#[cfg(windows)]
fn peak_rss_bytes() -> Result<u64, String> {
    let expression = format!("(Get-Process -Id {}).PeakWorkingSet64", std::process::id());
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &expression])
        .output()
        .map_err(|error| format!("PowerShell-Peak-RSS-Abfrage kann nicht starten: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "PowerShell-Peak-RSS-Abfrage ist fehlgeschlagen: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u64>()
        .map_err(|error| format!("PowerShell-PeakWorkingSet64 ist ungueltig: {error}"))
}

#[cfg(not(any(target_os = "linux", windows)))]
fn peak_rss_bytes() -> Result<u64, String> {
    Err("Deutschland-Runtime-Realtest unterstuetzt nur Linux und Windows.".to_owned())
}

fn write_evidence(path: &Path, evidence: &Value) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("Evidence-Verzeichnis anlegen");
    }
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .expect("Runtime-Evidence muss create-new sein");
    let mut writer = BufWriter::new(file);
    serde_json::to_writer(&mut writer, evidence).expect("Runtime-Evidence serialisieren");
    writer
        .write_all(b"\n")
        .expect("Runtime-Evidence abschliessen");
    writer.flush().expect("Runtime-Evidence flushen");
    writer
        .into_inner()
        .expect("Runtime-Evidence-Writer abschliessen")
        .sync_all()
        .expect("Runtime-Evidence synchronisieren");
}

#[test]
#[ignore = "braucht das echte signierte Deutschland-2026.4-Alpha-Deployment"]
fn signiertes_deutschland_deployment_startet_revisioniert_und_restored_kompakt() {
    assert_eq!(
        std::env::var("ZUGFOLGE_RUN_GERMANY_ALPHA_RUNTIME_REAL").as_deref(),
        Ok("1"),
        "Realtest braucht ZUGFOLGE_RUN_GERMANY_ALPHA_RUNTIME_REAL=1."
    );
    let signed_path = required_path("ZUGFOLGE_GERMANY_ALPHA_SIGNED_DEPLOYMENT");
    let infrastructure_root = required_path("ZUGFOLGE_GERMANY_ALPHA_OPERATIONAL_ROOT");
    let evidence_path = required_path("ZUGFOLGE_GERMANY_ALPHA_RUNTIME_EVIDENCE");
    assert!(
        signed_path.is_absolute(),
        "Deploymentpfad muss absolut sein."
    );
    assert!(
        infrastructure_root.is_absolute(),
        "Operational-v2-Wurzel muss absolut sein."
    );
    assert!(
        !evidence_path.exists(),
        "Vorhandene Runtime-Evidence darf nicht wiederverwendet werden."
    );

    let infrastructure_path = infrastructure_root.join("operational-infrastructure-v2.json");
    assert_eq!(
        fs::metadata(&infrastructure_path)
            .expect("Operational-v2-Datei fehlt")
            .len(),
        INFRA_BYTES,
        "Operational-v2-Datei verletzt die signierte Bytebindung."
    );

    let signed: Value = serde_json::from_reader(
        File::open(&signed_path).expect("signiertes Alpha-Deployment oeffnen"),
    )
    .expect("signiertes Alpha-Deployment ist kein JSON");
    assert_eq!(signed["signature"]["algorithm"], "Ed25519");
    assert_eq!(signed["signature"]["keyId"], ALPHA_KEY_ID);
    assert!(
        signed["deploymentHash"]
            .as_str()
            .is_some_and(|value| value.len() == 64),
        "Deployment-Hash fehlt."
    );
    let deployment = object(&signed["deployment"], "signiertes Deployment");
    assert_eq!(deployment["schema"], "zugfolge-alpha-world-deployment/v2");
    assert_eq!(deployment["worldId"], WORLD_ID);
    assert_eq!(deployment["deploymentRevision"], 1);
    let initialization = deployment
        .get("regionalSimulation")
        .expect("regionalSimulation fehlt");
    let binding = object(&initialization["infraRelease"], "Operational-v2-Bindung");
    assert_eq!(
        binding.len(),
        6,
        "Operational-v2-Bindung ist nicht kompakt."
    );
    assert_eq!(binding["infraReleaseId"], INFRA_RELEASE_ID);
    assert_eq!(binding["file"], "operational-infrastructure-v2.json");
    assert_eq!(binding["bytes"], INFRA_BYTES);
    assert_eq!(binding["sha256"], INFRA_SHA256);
    assert_eq!(binding["stateHash"], INFRA_STATE_HASH);
    for forbidden in [
        "directedEdges",
        "edgeGeometries",
        "routeVersions",
        "interlockingRoutes",
        "blockResources",
        "platformIntervals",
    ] {
        assert!(
            !binding.contains_key(forbidden),
            "Statische Infrastruktur wurde in '{forbidden}' eingebettet."
        );
    }

    let initialized: Value = serde_json::from_str(
        &initialize_operational_simulation(
            &serde_json::to_string(initialization).expect("Initialisierung serialisieren"),
            infrastructure_path
                .to_str()
                .expect("Operational-v2-Pfad ist nicht UTF-8"),
        )
        .expect("echter nativer Deutschland-Start ist fehlgeschlagen"),
    )
    .expect("nativer Startbeleg ist kein JSON");
    assert_eq!(initialized["state"]["revision"], 0);
    assert_eq!(initialized["state"]["world"]["commitSequence"], 0);
    assert_eq!(initialized["state"]["world"]["worldId"], WORLD_ID);
    assert_eq!(initialized["state"]["world"]["regionId"], REGION_ID);
    assert_eq!(initialized["validationReceipt"]["dynamicTrainCount"], 0);
    assert_eq!(
        initialized["validationReceipt"]["validationMode"],
        "native-streaming-redb-v1"
    );

    let initial_state = initialized["state"].clone();
    let initial_hash = string(&initialized["stateHash"], "initialer Zustandshash");
    let initialization_hash = string(
        &initialized["initializationHash"],
        "initialer Initialisierungshash",
    );
    let command = json!({
        "schemaVersion": COMMAND_SCHEMA,
        "worldId": WORLD_ID,
        "regionId": REGION_ID,
        "commandId": "germany-2026.4-readiness-revision-1",
        "expectedStateHash": initial_hash,
        "expectedRevision": 0,
        "expectedPublisherSequence": 0,
        "command": { "type": "advance-to", "atMs": 1 },
    });
    let applied: Value = serde_json::from_str(
        &apply_operational_simulation_command(
            &serde_json::to_string(&initial_state).expect("Startzustand serialisieren"),
            &serde_json::to_string(&command).expect("Revisionskommando serialisieren"),
            infrastructure_path
                .to_str()
                .expect("Operational-v2-Pfad ist nicht UTF-8"),
        )
        .expect("erste echte Deutschland-Regionsrevision ist fehlgeschlagen"),
    )
    .expect("Regionsrevision ist kein JSON");
    assert_eq!(applied["idempotentReplay"], false);
    assert_eq!(applied["state"]["revision"], 1);
    assert_eq!(applied["state"]["publisherSequence"], 1);
    assert_eq!(applied["state"]["world"]["commitSequence"], 1);
    assert_eq!(applied["state"]["world"]["nowMs"], 1);
    assert_eq!(applied["liveMap"]["commitSequence"], 1);
    assert_eq!(applied["rzue"]["commitSequence"], 1);
    assert_eq!(
        applied["state"]["infraRelease"],
        initialization["infraRelease"]
    );
    assert_eq!(applied["state"]["world"].get("infra"), None);
    let checkpoint_bytes = serde_json::to_vec(&applied["state"])
        .expect("kompakten Regionscheckpoint serialisieren")
        .len();
    assert!(
        checkpoint_bytes <= MAX_CHECKPOINT_BYTES,
        "Checkpoint mit {checkpoint_bytes} Bytes ist nicht kompakt."
    );

    let applied_hash = string(&applied["stateHash"], "angewendeter Zustandshash");
    let restored: Value = serde_json::from_str(
        &restore_operational_simulation(
            &json!({
                "schemaVersion": RESTORE_SCHEMA,
                "expectedInitializationHash": initialization_hash,
                "state": applied["state"],
            })
            .to_string(),
            infrastructure_path
                .to_str()
                .expect("Operational-v2-Pfad ist nicht UTF-8"),
        )
        .expect("echter Deutschland-Restore ist fehlgeschlagen"),
    )
    .expect("Restore-Beleg ist kein JSON");
    assert_eq!(restored["stateHash"], applied_hash);
    assert_eq!(restored["state"]["revision"], 1);
    assert_eq!(restored["liveMap"]["commitSequence"], 1);
    assert_eq!(restored["rzue"]["commitSequence"], 1);
    assert_eq!(
        restored["state"]["infraRelease"],
        initialization["infraRelease"]
    );

    let peak_rss = peak_rss_bytes().expect("Peak-RSS kann nicht gemessen werden");
    assert!(
        peak_rss <= MAX_RSS_BYTES,
        "Peak-RSS {peak_rss} ueberschreitet {MAX_RSS_BYTES}."
    );
    let evidence = json!({
        "schema": "zugfolge-germany-alpha-runtime-acceptance/v1",
        "worldId": WORLD_ID,
        "regionId": REGION_ID,
        "deploymentHash": signed["deploymentHash"],
        "signatureKeyId": ALPHA_KEY_ID,
        "infraRelease": initialization["infraRelease"],
        "initializationHash": initialization_hash,
        "initialStateHash": initialized["stateHash"],
        "committedRevision": 1,
        "committedStateHash": applied_hash,
        "restoreHashEqual": true,
        "checkpointBytes": checkpoint_bytes,
        "maxCheckpointBytes": MAX_CHECKPOINT_BYTES,
        "peakRssBytes": peak_rss,
        "maxRssBytes": MAX_RSS_BYTES,
        "validationMode": initialized["validationReceipt"]["validationMode"],
        "liveMapCommitSequence": restored["liveMap"]["commitSequence"],
        "rzueCommitSequence": restored["rzue"]["commitSequence"],
        "platform": std::env::consts::OS,
        "runtimeBoundary": "rust-core",
    });
    write_evidence(&evidence_path, &evidence);
    println!(
        "{}",
        serde_json::to_string(&evidence).expect("Runtime-Evidence fuer Ausgabe serialisieren")
    );
}
