//! Echte Kindprozesse prüfen den CLI-Abschluss nach belegtem Cacheaufbau.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use zugfolge_infra::validate_operational_infrastructure_v2_file;
use zugfolge_sim::operational::PROTECTION_MODE_SELECTION_POLICY_V1;
use zugfolge_sim_runtime::operational_runtime::{
    COMMAND_SCHEMA, INITIALIZE_SCHEMA, initialize_operational_simulation,
    release_operational_infrastructure_cache,
};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
const CHILD_ENV: &str = "ZUGFOLGE_OPERATIONAL_CLEANUP_CHILD";

struct Fixture {
    root: PathBuf,
    path: PathBuf,
    initialization: Value,
    initialized_json: String,
}

impl Fixture {
    fn create() -> Self {
        let root = (0..1024)
            .find_map(|_| {
                let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "zugfolge-cli-cleanup-test-{}-{sequence}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => Some(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                    Err(error) => panic!("Eigenes Testverzeichnis anlegen: {error}"),
                }
            })
            .expect("Eindeutiges Testverzeichnis");
        let source = json!({
            "id":"infra:cli-cleanup", "directedEdges":{"edge":1000},
            "edgeGeometries":{"edge":[
                {"edgeOffsetMm":0,"latitudeE7":510000000,"longitudeE7":120000000,"bearingMilliDegrees":90000},
                {"edgeOffsetMm":1000,"latitudeE7":510000000,"longitudeE7":120001000,"bearingMilliDegrees":null}
            ]},
            "routeVersions":{"route":{"id":"route","templateId":"template","predecessorId":null,"transitionRouteMm":null,"legs":[
                {"edgeId":"edge","direction":"along","edgeEntryMm":0,"edgeExitMm":1000,"routeStartMm":0,
                 "blockIds":["block"],"speedLimitMmps":20000,"gradientPerMille":0,
                 "availableProtectionSystems":["pzb"],"simultaneouslyRequiredProtectionSystems":[]}
            ]}},
            "interlockingRoutes":{"interlocking":{"id":"interlocking","routeTemplateId":"template","signalId":"signal",
                "movementKind":"train","pathResources":["block"],"overlapResources":["overlap"],"flankResources":["flank"],
                "switchPositions":{},"authorityStartRouteMm":0,"authorityEndRouteMm":1000,"releaseAfterTailRouteMm":1000}},
            "signals":["signal"],"switches":[],"blockResources":["block","flank","overlap"],
            "platformIntervals":{},"regionBoundaries":[],"rzueLayoutId":"rzue:cli-cleanup"
        });
        let candidate = root.join("candidate.json");
        let path = root.join("operational-infrastructure-v2.json");
        fs::write(&candidate, source.to_string()).expect("Fiktive Infrastrukturquelle schreiben");
        let receipt = validate_operational_infrastructure_v2_file(
            &candidate,
            "infra:cli-cleanup",
            Some(&path),
        )
        .expect("Quelle tatsächlich nativ validieren");
        let initialization = json!({
            "schemaVersion":INITIALIZE_SCHEMA,"worldId":"world:cleanup","regionId":"region:cleanup","nowMs":0,
            "protectionModeSelectionPolicy":PROTECTION_MODE_SELECTION_POLICY_V1,
            "infraRelease":{"schemaVersion":"zugfolge-operational-infrastructure-binding/v2","infraReleaseId":"infra:cli-cleanup",
                "file":"operational-infrastructure-v2.json","bytes":receipt["bytes"],"sha256":receipt["sha256"],"stateHash":receipt["stateHash"]},
            "vehicleTypes":[],"vehicles":[],"formations":[],"trains":[],"repeatEveryMs":null,"movementContinuations":[]
        });
        let result = initialize_operational_simulation(
            &initialization.to_string(),
            path.to_str().expect("UTF-8-Testpfad"),
        );
        release_operational_infrastructure_cache();
        let initialized_json = result.expect("Tatsächlichen restaurierbaren Zustand erzeugen");
        Self {
            root,
            path,
            initialization,
            initialized_json,
        }
    }

    fn invoke(&self, request: &Value) -> Output {
        let scratch = self.root.join("child-temp");
        fs::create_dir(&scratch).expect("Isolierten Kindprozess-Tempbereich anlegen");
        let mut command = Command::new(std::env::current_exe().expect("Aktuelles Testprogramm"));
        command
            .args(["--exact", "tests::cli_process_entry", "--nocapture"])
            .env(CHILD_ENV, "1")
            .env("TMPDIR", &scratch)
            .env("TMP", &scratch)
            .env("TEMP", &scratch)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command
            .spawn()
            .expect("Echten CLI-Einstieg im Kindprozess starten");
        child
            .stdin
            .take()
            .expect("CLI-Standardeingabe")
            .write_all(request.to_string().as_bytes())
            .expect("Request übertragen");
        let output = child.wait_with_output().expect("CLI-Ende abwarten");
        assert_empty(&scratch, &output);
        output
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Ausschließlich das atomar von dieser Fixture selbst angelegte Verzeichnis.
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn assert_empty(path: &Path, output: &Output) {
    let remaining: Vec<_> = fs::read_dir(path)
        .expect("Kindprozess-Tempbereich lesen")
        .map(|entry| entry.expect("Eigenen Verzeichniseintrag lesen").file_name())
        .collect();
    assert!(
        remaining.is_empty(),
        "CLI ließ temporäre Indizes zurück: {remaining:?}; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn cli_process_entry() {
    if std::env::var(CHILD_ENV).as_deref() == Ok("1") {
        // Derselbe main-Einstieg wie das ausgelieferte CLI; kein Cleanup im Testkind.
        super::main();
    }
}

#[test]
fn successful_cli_releases_its_index_and_preserves_exact_result() {
    let fixture = Fixture::create();
    let output = fixture.invoke(
        &json!({"method":"initialize","args":[fixture.initialization.to_string(),fixture.path]}),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(&fixture.initialized_json),
        "Cleanup muss das vollständige native Ergebnis unverändert lassen"
    );
}

#[test]
fn rejected_command_after_restore_releases_its_index() {
    let fixture = Fixture::create();
    let result: Value = serde_json::from_str(&fixture.initialized_json).expect("Natives Ergebnis");
    let state = &result["state"];
    let envelope = json!({"schemaVersion":COMMAND_SCHEMA,"worldId":"world:cleanup","regionId":"foreign-region",
        "commandId":"reject-after-restore","expectedStateHash":state["stateHash"],"expectedRevision":state["revision"],
        "expectedPublisherSequence":state["publisherSequence"],"command":{"type":"advance-to","atMs":1}});
    let output = fixture.invoke(
        &json!({"method":"apply","args":[state.to_string(),envelope.to_string(),fixture.path]}),
    );
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("world_region_mismatch"),
        "Dieser Fehler entsteht erst nach nativem Restore und erfolgreichem Infrastruktur-Anbinden: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
