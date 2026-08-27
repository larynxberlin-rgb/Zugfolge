//! Integrationsbeweise fuer die datentraegergestuetzte Operational-v2-Validierung.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zugfolge_infra::{
    open_operational_infrastructure_v2_store, validate_operational_infrastructure_v2,
    validate_operational_infrastructure_v2_file,
};
use zugfolge_sim::operational::OperationalInfrastructure;

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn create() -> Self {
        let id = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "zugfolge-operational-streaming-test-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("eindeutiges Testverzeichnis");
        Self(path)
    }

    fn join(&self, file: &str) -> PathBuf {
        self.0.join(file)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn candidate(release_id: &str) -> Value {
    json!({
        "id": release_id,
        "directedEdges": { "edge-1": 1_000 },
        "edgeGeometries": {
            "edge-1": [
                {
                    "edgeOffsetMm": 0,
                    "latitudeE7": 510_000_000,
                    "longitudeE7": 120_000_000,
                    "bearingMilliDegrees": 90_000
                },
                {
                    "edgeOffsetMm": 1_000,
                    "latitudeE7": 510_000_000,
                    "longitudeE7": 120_001_000,
                    "bearingMilliDegrees": null
                }
            ]
        },
        "routeVersions": {
            "route-1": {
                "id": "route-1",
                "templateId": "template-1",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [{
                    "edgeId": "edge-1",
                    "direction": "along",
                    "edgeEntryMm": 0,
                    "edgeExitMm": 1_000,
                    "routeStartMm": 0,
                    "blockIds": ["block-1"],
                    "speedLimitMmps": 20_000,
                    "gradientPerMille": 0,
                    "availableProtectionSystems": ["pzb"],
                    "simultaneouslyRequiredProtectionSystems": []
                }]
            }
        },
        "interlockingRoutes": {
            "interlocking-1": {
                "id": "interlocking-1",
                "routeTemplateId": "template-1",
                "signalId": "signal-1",
                "movementKind": "train",
                "pathResources": ["block-1"],
                "overlapResources": ["overlap-1"],
                "flankResources": ["flank-1"],
                "switchPositions": {},
                "authorityStartRouteMm": 0,
                "authorityEndRouteMm": 1_000,
                "releaseAfterTailRouteMm": 1_000
            }
        },
        "signals": ["signal-1"],
        "switches": [],
        "blockResources": ["block-1", "flank-1", "overlap-1"],
        "platformIntervals": {},
        "regionBoundaries": [],
        "rzueLayoutId": "rzue-layout-1"
    })
}

fn segmented_candidate(release_id: &str) -> Value {
    let mut value = candidate(release_id);
    value["directedEdges"]["edge-2"] = json!(1_500);
    value["edgeGeometries"]["edge-2"] = json!([
        {
            "edgeOffsetMm": 0,
            "latitudeE7": 510_000_000,
            "longitudeE7": 120_001_000,
            "bearingMilliDegrees": 90_000
        },
        {
            "edgeOffsetMm": 1_500,
            "latitudeE7": 510_000_000,
            "longitudeE7": 120_002_500,
            "bearingMilliDegrees": null
        }
    ]);
    value["routeVersions"]["route-1"]["legs"]
        .as_array_mut()
        .expect("Laufweg-Legs")
        .push(json!({
            "edgeId": "edge-2",
            "direction": "along",
            "edgeEntryMm": 0,
            "edgeExitMm": 1_500,
            "routeStartMm": 1_000,
            "blockIds": ["block-2"],
            "speedLimitMmps": 20_000,
            "gradientPerMille": 0,
            "availableProtectionSystems": ["pzb"],
            "simultaneouslyRequiredProtectionSystems": []
        }));
    value["interlockingRoutes"]["interlocking-2"] = json!({
        "id": "interlocking-2",
        "routeTemplateId": "template-1",
        "signalId": "signal-2",
        "movementKind": "train",
        "pathResources": ["block-2"],
        "overlapResources": ["overlap-2"],
        "flankResources": ["flank-2"],
        "switchPositions": {},
        "authorityStartRouteMm": 1_000,
        "authorityEndRouteMm": 2_500,
        "releaseAfterTailRouteMm": 2_500
    });
    value["interlockingRoutes"]["interlocking-shunting"] = json!({
        "id": "interlocking-shunting",
        "routeTemplateId": "template-1",
        "signalId": "signal-shunting",
        "movementKind": "shunting",
        "pathResources": ["block-1"],
        "overlapResources": ["overlap-1"],
        "flankResources": ["flank-1"],
        "switchPositions": {},
        "authorityStartRouteMm": 0,
        "authorityEndRouteMm": 1_000,
        "releaseAfterTailRouteMm": 1_000
    });
    value["signals"] = json!(["signal-1", "signal-2", "signal-shunting"]);
    value["blockResources"] = json!([
        "block-1",
        "block-2",
        "flank-1",
        "flank-2",
        "overlap-1",
        "overlap-2"
    ]);
    value
}

fn write_json(path: &Path, value: &Value) {
    fs::write(
        path,
        serde_json::to_vec_pretty(value).expect("Operational-v2-Test-JSON"),
    )
    .expect("Operational-v2-Testdatei");
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn streaming_validator_bindet_quelle_kanonisches_artefakt_und_nativer_hash_identisch() {
    let root = TestDirectory::create();
    let release_id = "infra-deutschland-streaming-test";
    let value = candidate(release_id);
    let candidate_path = root.join("candidate.json");
    let output_path = root.join("operational-infrastructure-v2.json");
    write_json(&candidate_path, &value);

    let in_memory = validate_operational_infrastructure_v2(&value, release_id)
        .expect("bestehender nativer Vertrag");
    let streaming = validate_operational_infrastructure_v2_file(
        &candidate_path,
        release_id,
        Some(&output_path),
    )
    .expect("streamende native Validierung");
    let output = fs::read(&output_path).expect("kanonisches Operational-v2-Artefakt");

    assert_eq!(streaming["stateHash"], in_memory["stateHash"]);
    assert_eq!(streaming["validationMode"], "native-streaming-redb-v1");
    assert_eq!(streaming["bytes"], output.len());
    assert_eq!(streaming["sha256"], sha256(&output));
    assert_eq!(
        streaming["sourceBytes"],
        fs::metadata(&candidate_path)
            .expect("Candidate-Metadaten")
            .len()
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output).expect("kanonische Ausgabe lesen"),
        value
    );
    assert_eq!(output.last(), Some(&b'\n'));
}

#[test]
fn runtimeindex_liefert_lueckenlose_zugfahrstrassensegmente_ueber_exakten_startschluessel() {
    let root = TestDirectory::create();
    let release_id = "infra-deutschland-streaming-segments";
    let candidate_path = root.join("candidate.json");
    let artifact_path = root.join("operational-infrastructure-v2.json");
    write_json(&candidate_path, &segmented_candidate(release_id));
    let receipt = validate_operational_infrastructure_v2_file(
        &candidate_path,
        release_id,
        Some(&artifact_path),
    )
    .expect("lueckenlose Segmentfolge validieren");
    let store = open_operational_infrastructure_v2_store(
        &artifact_path
            .canonicalize()
            .expect("absoluter Operational-v2-Pfad"),
        release_id,
        receipt["bytes"].as_u64().expect("Artefaktbytes"),
        receipt["sha256"].as_str().expect("Artefakt-SHA"),
        receipt["stateHash"].as_str().expect("Zustandshash"),
    )
    .expect("Runtimeindex oeffnen");

    let first = store
        .train_interlocking_route("template-1", 0)
        .expect("erstes Segment lesen")
        .expect("erstes Segment vorhanden");
    let second = store
        .train_interlocking_route("template-1", first.authority_end_route_mm)
        .expect("zweites Segment lesen")
        .expect("zweites Segment vorhanden");
    assert_eq!(first.id, "interlocking-1");
    assert_eq!(first.authority_start_route_mm, 0);
    assert_eq!(first.authority_end_route_mm, 1_000);
    assert_eq!(second.id, "interlocking-2");
    assert_eq!(
        second.authority_start_route_mm,
        first.authority_end_route_mm
    );
    assert_eq!(second.authority_end_route_mm, 2_500);
    assert_eq!(first.path_resources.len() + second.path_resources.len(), 2);
    let shunting = store
        .shunting_interlocking_routes(0)
        .expect("Rangierfahrstrassen lesen");
    assert_eq!(shunting.len(), 1);
    assert_eq!(shunting[0].id, "interlocking-shunting");
    assert_eq!(shunting[0].authority_start_route_mm, 0);
    assert!(
        store
            .train_interlocking_route("template-1", 500)
            .expect("fehlenden exakten Start lesen")
            .is_none()
    );
    assert!(
        store
            .train_interlocking_route("unknown-template", 0)
            .expect("fremde Vorlage lesen")
            .is_none()
    );
}

#[test]
fn native_cli_materialisiert_optional_create_new_und_liefert_den_vollen_beleg() {
    let root = TestDirectory::create();
    let release_id = "infra-deutschland-streaming-cli";
    let candidate_path = root.join("candidate.json");
    let output_path = root.join("operational-infrastructure-v2.json");
    write_json(&candidate_path, &candidate(release_id));

    let invocation = Command::new(env!("CARGO_BIN_EXE_zugfolge-infra-release"))
        .arg("validate-operational-infrastructure-v2")
        .arg(&candidate_path)
        .arg(release_id)
        .arg(&output_path)
        .output()
        .expect("nativen Streaming-Compiler starten");
    assert!(
        invocation.status.success(),
        "CLI muss gelingen: {}",
        String::from_utf8_lossy(&invocation.stderr)
    );
    let receipt: Value =
        serde_json::from_slice(&invocation.stdout).expect("vollstaendiger CLI-Beleg");
    assert_eq!(receipt["infraReleaseId"], release_id);
    assert_eq!(receipt["validationMode"], "native-streaming-redb-v1");
    assert!(
        receipt["sourceSha256"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64)
    );
    assert!(
        receipt["sha256"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64)
    );
    assert!(
        receipt["stateHash"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64)
    );
    assert!(output_path.is_file());

    let second = Command::new(env!("CARGO_BIN_EXE_zugfolge-infra-release"))
        .arg("validate-operational-infrastructure-v2")
        .arg(&candidate_path)
        .arg(release_id)
        .arg(&output_path)
        .output()
        .expect("zweiten nativen Streaming-Compiler starten");
    assert!(
        !second.status.success(),
        "bestehende Ausgabe darf nie ersetzt werden"
    );
}

#[test]
fn streaming_validator_verwirft_nichtkanonische_sets_und_gebrochene_referenzen() {
    let root = TestDirectory::create();
    let release_id = "infra-deutschland-streaming-negative";
    let candidate_path = root.join("candidate.json");

    let mut duplicate_set = candidate(release_id);
    duplicate_set["signals"] = json!(["signal-1", "signal-1"]);
    write_json(&candidate_path, &duplicate_set);
    let error = validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("doppelte native Set-Darstellung muss scheitern");
    assert!(
        error
            .to_string()
            .contains("kanonischen nativen Darstellung")
    );

    let mut duplicate_protection = candidate(release_id);
    duplicate_protection["routeVersions"]["route-1"]["legs"][0]["availableProtectionSystems"] =
        json!(["pzb", "pzb"]);
    write_json(&candidate_path, &duplicate_protection);
    validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("doppelte Zugsicherungsalternativen muessen scheitern");

    let mut impossible_simultaneous = candidate(release_id);
    impossible_simultaneous["routeVersions"]["route-1"]["legs"][0]["simultaneouslyRequiredProtectionSystems"] =
        json!(["lzb"]);
    write_json(&candidate_path, &impossible_simultaneous);
    validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("gleichzeitige Pflicht ausserhalb der Alternativenmenge muss scheitern");

    let mut segment_gap = segmented_candidate(release_id);
    segment_gap["interlockingRoutes"]["interlocking-2"]["authorityStartRouteMm"] = json!(999);
    write_json(&candidate_path, &segment_gap);
    let error = validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("Luecke in der Zugfahrstrassenfolge muss scheitern");
    assert!(error.to_string().contains("keine Zugfahrstrasse"));

    let mut foreign_segment_path = segmented_candidate(release_id);
    foreign_segment_path["interlockingRoutes"]["interlocking-2"]["pathResources"] =
        json!(["block-1"]);
    write_json(&candidate_path, &foreign_segment_path);
    let error = validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("Segmentpfad muss exakt den Leg-Ressourcen entsprechen");
    assert!(
        error
            .to_string()
            .contains("keine exakte Segmentfahrstrasse")
    );

    let mut duplicate_train_key = segmented_candidate(release_id);
    duplicate_train_key["interlockingRoutes"]["interlocking-duplicate"] = json!({
        "id": "interlocking-duplicate",
        "routeTemplateId": "template-1",
        "signalId": "signal-duplicate",
        "movementKind": "train",
        "pathResources": ["block-2"],
        "overlapResources": ["overlap-2"],
        "flankResources": ["flank-2"],
        "switchPositions": {},
        "authorityStartRouteMm": 1_000,
        "authorityEndRouteMm": 2_500,
        "releaseAfterTailRouteMm": 2_500
    });
    duplicate_train_key["signals"] = json!([
        "signal-1",
        "signal-2",
        "signal-duplicate",
        "signal-shunting"
    ]);
    write_json(&candidate_path, &duplicate_train_key);
    let error = validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("doppelter Train-Startschluessel muss fail-closed scheitern");
    assert!(
        error
            .to_string()
            .contains("doppelter Zugfahrstrassen-Schluessel")
    );

    let mut legacy_alias = candidate(release_id);
    legacy_alias["routeVersions"]["route-1"]["legs"][0]
        .as_object_mut()
        .expect("Test-Leg ist ein Objekt")
        .insert(["required", "ProtectionSystems"].concat(), json!(["pzb"]));
    write_json(&candidate_path, &legacy_alias);
    validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("der entfernte Legacy-Feldname darf nie akzeptiert werden");

    let mut unknown_block = candidate(release_id);
    unknown_block["routeVersions"]["route-1"]["legs"][0]["blockIds"] = json!(["unknown-block"]);
    write_json(&candidate_path, &unknown_block);
    let error = validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("gebrochene Konfliktressourcenreferenz muss scheitern");
    assert!(error.to_string().contains("Ressourcenbezug"));

    let mut unsafe_integer = candidate(release_id);
    unsafe_integer["directedEdges"]["edge-1"] = json!(9_007_199_254_740_992_i64);
    write_json(&candidate_path, &unsafe_integer);
    let error = validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("unsichere Ganzzahl muss vor der Fachpruefung scheitern");
    assert!(error.to_string().contains("unsicher"));

    let mut two_documents = serde_json::to_vec(&candidate(release_id)).expect("erstes Dokument");
    two_documents.extend_from_slice(b"{}");
    fs::write(&candidate_path, two_documents).expect("zwei JSON-Dokumente");
    let error = validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("zweites JSON-Dokument muss als ungueltiger Nachlauf scheitern");
    assert!(error.to_string().contains("Nachlauf"));
}

#[test]
fn eingechecktes_tutorial_artefakt_ist_kanonisch_und_descriptorgebunden() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/game-api/tutorial-infrastructure/tutorial-minimal-2026.1");
    let artifact = root.join("operational-infrastructure-v2.json");
    let descriptor: Value = serde_json::from_slice(
        &fs::read(root.join("descriptor.json")).expect("Tutorialdescriptor lesen"),
    )
    .expect("Tutorialdescriptor ist JSON");
    let binding = &descriptor["binding"];
    let release_id = binding["infraReleaseId"]
        .as_str()
        .expect("Tutorialdescriptor besitzt InfraRelease-ID");
    let evidence = validate_operational_infrastructure_v2_file(&artifact, release_id, None)
        .expect("eingechecktes Tutorialartefakt ist nativ operational-v2-gueltig");

    assert_eq!(
        descriptor["schemaVersion"],
        "zugfolge-tutorial-operational-infrastructure-descriptor/v1"
    );
    assert_eq!(descriptor["templateVersion"], "tutorial-minimal-2026.1");
    assert_eq!(binding["file"], "operational-infrastructure-v2.json");
    assert_eq!(evidence["sourceBytes"], binding["bytes"]);
    assert_eq!(evidence["sourceSha256"], binding["sha256"]);
    assert_eq!(evidence["stateHash"], binding["stateHash"]);
    assert_eq!(evidence["bytes"], binding["bytes"]);
    assert_eq!(evidence["sha256"], binding["sha256"]);
    open_operational_infrastructure_v2_store(
        &artifact
            .canonicalize()
            .expect("absoluter Tutorialartefaktpfad"),
        release_id,
        binding["bytes"].as_u64().expect("Tutorial-Bytebindung"),
        binding["sha256"].as_str().expect("Tutorial-SHA-Bindung"),
        binding["stateHash"]
            .as_str()
            .expect("Tutorial-Zustandshashbindung"),
    )
    .expect("Runtime-Store akzeptiert exakt den eingecheckten Tutorialdescriptor");
}

#[test]
fn streaming_validator_verwirft_einen_einzelnen_unbegrenzt_grossen_laufweg() {
    const RAW_ROUTE_BYTES: usize = 10 * 1024 * 1024;
    let root = TestDirectory::create();
    let release_id = "infra-deutschland-streaming-single-record-limit";
    let mut value = candidate(release_id);
    let leg = serde_json::to_string(&value["routeVersions"]["route-1"]["legs"][0])
        .expect("Laufwegbein serialisieren");
    value["routeVersions"]["route-1"]["legs"] = json!([]);
    let compact = serde_json::to_string(&value).expect("Testkandidat serialisieren");
    let marker = "\"legs\":[]";
    let marker_start = compact.find(marker).expect("leere Laufwegbeine finden");
    let array_start = marker_start + "\"legs\":".len();
    let candidate_path = root.join("single-oversized-route.json");
    let mut writer = BufWriter::new(File::create(&candidate_path).expect("Testdatei anlegen"));
    writer
        .write_all(&compact.as_bytes()[..array_start])
        .expect("Testkandidatkopf schreiben");
    writer.write_all(b"[").expect("Laufwegfolge beginnen");
    let repetitions = RAW_ROUTE_BYTES.div_ceil(leg.len());
    for index in 0..repetitions {
        if index > 0 {
            writer.write_all(b",").expect("Laufwegbeine trennen");
        }
        writer
            .write_all(leg.as_bytes())
            .expect("Laufwegbein schreiben");
    }
    writer.write_all(b"]").expect("Laufwegfolge abschliessen");
    writer
        .write_all(&compact.as_bytes()[array_start + 2..])
        .expect("Testkandidatende schreiben");
    writer.flush().expect("Testdatei abschliessen");
    drop(writer);

    let error = validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("ein einzelner unbeschraenkter Laufweg muss fail-closed scheitern");
    assert!(
        error.to_string().contains("Einzeldatensatz")
            && (error.to_string().contains("Speichergroesse")
                || error.to_string().contains("Strukturgrenze")),
        "unerwarteter Fehler: {error}"
    );
}

#[test]
fn streaming_validator_verwirft_eine_unbegrenzt_grosse_json_zeichenkette() {
    const RAW_STRING_BYTES: usize = 1024 * 1024 + 1;
    let root = TestDirectory::create();
    let release_id = "infra-deutschland-streaming-string-limit";
    let mut value = candidate(release_id);
    value["signals"] = json!([]);
    let compact = serde_json::to_string(&value).expect("Testkandidat serialisieren");
    let marker = "\"signals\":[]";
    let marker_start = compact.find(marker).expect("leere Signalliste finden");
    let array_start = marker_start + "\"signals\":".len();
    let candidate_path = root.join("single-oversized-string.json");
    let mut writer = BufWriter::new(File::create(&candidate_path).expect("Testdatei anlegen"));
    writer
        .write_all(&compact.as_bytes()[..array_start])
        .expect("Testkandidatkopf schreiben");
    writer
        .write_all(b"[\"")
        .expect("ueberlange Zeichenkette beginnen");
    let chunk = vec![b'x'; 64 * 1024];
    let mut remaining = RAW_STRING_BYTES;
    while remaining > 0 {
        let length = remaining.min(chunk.len());
        writer
            .write_all(&chunk[..length])
            .expect("Zeichenkettenblock schreiben");
        remaining -= length;
    }
    writer
        .write_all(b"\"]")
        .expect("ueberlange Zeichenkette abschliessen");
    writer
        .write_all(&compact.as_bytes()[array_start + 2..])
        .expect("Testkandidatende schreiben");
    writer.flush().expect("Testdatei abschliessen");
    drop(writer);

    let error = validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect_err("eine unbeschraenkte JSON-Zeichenkette muss fail-closed scheitern");
    assert!(
        error.to_string().contains("JSON-Zeichenkette")
            && error.to_string().contains("1-MiB-Grenze"),
        "unerwarteter Fehler: {error}"
    );
}

#[test]
fn streaming_validator_validiert_echte_datei_jenseits_von_64_mib() {
    const MIB: usize = 1024 * 1024;
    const BOUNDARY_COUNT: usize = 65 * 64;
    const BOUNDARY_BYTES: usize = 16 * 1024;
    let root = TestDirectory::create();
    let release_id = "infra-deutschland-streaming-large";
    let value = candidate(release_id);
    let candidate_path = root.join("candidate-over-64-mib.json");
    let mut writer = BufWriter::new(File::create(&candidate_path).expect("grosse Testdatei"));
    let compact = serde_json::to_string(&value).expect("kompakter Operational-v2-Testkandidat");
    let marker = "\"regionBoundaries\":[]";
    let marker_start = compact
        .find(marker)
        .expect("leere Regionsgrenzen im Testkandidaten");
    let array_start = marker_start + "\"regionBoundaries\":".len();
    writer
        .write_all(&compact.as_bytes()[..array_start])
        .expect("Testkandidatkopf schreiben");
    writer.write_all(b"[").expect("Regionsgrenzen beginnen");
    for index in 0..BOUNDARY_COUNT {
        if index > 0 {
            writer.write_all(b",").expect("Regionsgrenzen trennen");
        }
        let boundary = format!(
            "{index:08}-{}",
            "x".repeat(BOUNDARY_BYTES.saturating_sub(9))
        );
        writer
            .write_all(
                serde_json::to_string(&boundary)
                    .expect("Regionsgrenze serialisieren")
                    .as_bytes(),
            )
            .expect("Regionsgrenze schreiben");
    }
    writer.write_all(b"]").expect("Regionsgrenzen abschliessen");
    writer
        .write_all(&compact.as_bytes()[marker_start + marker.len()..])
        .expect("Testkandidatende schreiben");
    writer.flush().expect("grosse Testdatei abschliessen");
    drop(writer);
    assert!(
        fs::metadata(&candidate_path)
            .expect("grosse Candidate-Metadaten")
            .len()
            > 64 * u64::try_from(MIB).expect("MiB passt in u64")
    );

    let streaming = validate_operational_infrastructure_v2_file(&candidate_path, release_id, None)
        .expect("streamende Validierung jenseits von 64 MiB");

    assert!(streaming["sourceBytes"].as_u64().expect("Quellgroesse") > 64 * MIB as u64);
    assert!(streaming["bytes"].as_u64().expect("Artefaktgroesse") > 64 * MIB as u64);
    assert_eq!(
        streaming["stateHash"].as_str().map(str::len),
        Some(64),
        "kanonischer Zustandshash muss vollstaendig entstehen"
    );
}
