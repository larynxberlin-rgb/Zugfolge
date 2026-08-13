//! Golden-Master- und Fail-closed-Nachweis des Rust-Releasecompilers.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zugfolge_infra::{
    build_annual_infra_plan, build_mitteldeutschland_infra_release, build_public_infra_release,
    build_qualified_reference_release, build_reference_report,
};

fn fixture() -> (Value, Value, Value, Value, Value, Value) {
    let input: Value = serde_json::from_str(include_str!("fixtures/release-manifest-input.json"))
        .expect("gültige Übergangsfixtur");
    (
        input["config"].clone(),
        input["catalog"].clone(),
        input["rights"].clone(),
        input["capture"].clone(),
        input["artifacts"].clone(),
        input["quality"].clone(),
    )
}

fn bytes_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("ASCII-Hex"), 16)
                .expect("gueltiges Hex")
        })
        .collect()
}

fn json_artifact(path: &str, value: &Value) -> (Value, Value) {
    let bytes = serde_json::to_vec(value).expect("JSON-Artefakt");
    let sha256 = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let record = json!({ "path": path, "sha256": sha256 });
    (
        record.clone(),
        json!({ "record": record, "bytesHex": bytes_hex(&bytes) }),
    )
}

fn qualified_input() -> Value {
    let frozen = "2026-08-10T00:00:00.000Z";
    let timetable_source = json!({ "id": "timetable", "sourceLicense": "CC0-1.0", "attribution": "Fixture", "retrievedAt": frozen });
    let capture_value = json!({
        "schema": "zugfolge-gtfs-capture/v2",
        "source": timetable_source,
        "tolerance": { "absoluteSeconds": 30, "relativeBasisPoints": 500 },
        "qualificationPolicy": { "minimumCalibrationSamples": 1, "minimumValidationSamples": 1 }
    });
    let (capture_record, capture) = json_artifact("capture.json", &capture_value);
    let calibration_value = json!({
        "schema": "zugfolge-technical-reference-dataset/v1", "purpose": "calibration",
        "datasetId": "calibration-v1", "frozenAt": frozen,
        "source": { "id": "calibration-source", "sourceLicense": "CC0-1.0", "attribution": "Fixture", "retrievedAt": frozen, "method": "fixture" },
        "samples": [{ "id": "cal-1", "groupId": "group-1", "characteristicsId": "emu-v1", "sourceId": "calibration-source", "technicalRunningSeconds": 590 }]
    });
    let (calibration_record, calibration) =
        json_artifact("evidence/calibration.json", &calibration_value);
    let validation_value = json!({
        "schema": "zugfolge-technical-reference-dataset/v1", "purpose": "validation",
        "datasetId": "validation-v1", "frozenAt": frozen,
        "source": { "id": "validation-source", "sourceLicense": "CC0-1.0", "attribution": "Fixture", "retrievedAt": frozen, "method": "fixture" },
        "samples": [{ "id": "val-1", "groupId": "group-1", "characteristicsId": "emu-v1", "sourceId": "validation-source", "technicalRunningSeconds": 610 }]
    });
    let (validation_record, validation) =
        json_artifact("evidence/validation.json", &validation_value);
    let calibration_config_value = json!({
        "schema": "zugfolge-technical-evaluation-config/v1", "purpose": "calibration",
        "configId": "calibration-config-v1", "frozenAt": frozen,
        "datasetSha256": calibration_record["sha256"], "method": "fixture"
    });
    let (calibration_config_record, calibration_config) = json_artifact(
        "evidence/calibration-config.json",
        &calibration_config_value,
    );
    let validation_config_value = json!({
        "schema": "zugfolge-technical-evaluation-config/v1", "purpose": "validation",
        "configId": "validation-config-v1", "frozenAt": frozen,
        "datasetSha256": validation_record["sha256"], "method": "fixture"
    });
    let (validation_config_record, validation_config) =
        json_artifact("evidence/validation-config.json", &validation_config_value);
    let cal_ids = json!(["cal-1"]);
    let val_ids = json!(["val-1"]);
    let canonical_hash = |value: &Value| {
        let serialized = if value == &cal_ids {
            "[\"cal-1\"]"
        } else {
            "[\"val-1\"]"
        };
        Sha256::digest(serialized.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let evidence_value = json!({
        "schema": "zugfolge-qualification-evidence/v1", "frozenAt": frozen,
        "policy": capture_value["qualificationPolicy"],
        "calibration": { "purpose": "calibration", "datasetId": "calibration-v1", "dataset": calibration_record, "configId": "calibration-config-v1", "config": calibration_config_record, "frozenAt": frozen, "sampleIds": cal_ids, "sampleIdsSha256": canonical_hash(&cal_ids) },
        "validation": { "purpose": "validation", "datasetId": "validation-v1", "dataset": validation_record, "configId": "validation-config-v1", "config": validation_config_record, "frozenAt": frozen, "sampleIds": val_ids, "sampleIdsSha256": canonical_hash(&val_ids) }
    });
    let (evidence_record, evidence) = json_artifact("evidence.json", &evidence_value);
    let source = timetable_source;
    let corpus_value = json!({
        "schema": "zugfolge-reference-corpus/v3", "source": source, "artifactBinding": { "captureConfigSha256": capture_record["sha256"] },
        "groups": [{ "id": "group-1", "characteristicsId": "emu-v1", "trainCategory": "RE", "scheduledDurationP20Seconds": 650, "scheduledRunningP20Seconds": 640, "scheduledDwellP20Seconds": 10, "sampleCount": 5 }]
    });
    let (corpus_record, corpus) = json_artifact("corpus.json", &corpus_value);
    let bindings = json!({
        "captureConfigSha256": capture_record["sha256"],
        "referenceCorpusSha256": corpus_record["sha256"], "qualificationEvidenceSha256": evidence_record["sha256"],
        "calibrationDatasetSha256": calibration_record["sha256"], "calibrationConfigSha256": calibration_config_record["sha256"],
        "validationDatasetSha256": validation_record["sha256"], "validationConfigSha256": validation_config_record["sha256"]
    });
    let assumptions = json!({ "infrastructure": ["fixture"], "vehicle": ["fixture"] });
    let model_config_value = json!({ "schema": "fixture-model/v1", "artifactBinding": bindings, "method": "fixture", "assumptions": assumptions });
    let (model_config_record, model_config) =
        json_artifact("model-config.json", &model_config_value);
    let release_checksum = "a".repeat(64);
    let model_value = json!({
        "schema": "zugfolge-model-results/v3", "releaseChecksum": release_checksum,
        "modelInputSha256": model_config_record["sha256"], "artifactBinding": bindings, "assumptions": assumptions,
        "results": [{ "groupId": "group-1", "characteristicsId": "emu-v1", "calibrationMethod": "fixture", "validationSampleId": "val-1", "rawRunningSeconds": 600, "runningSeconds": 612, "dwellSeconds": 10, "modeledTimetableSeconds": 622, "technicalReferenceSeconds": 610 }]
    });
    let (model_record, model) = json_artifact("model-results.json", &model_value);
    let mut report_bindings = bindings.as_object().expect("Bindings").clone();
    report_bindings.insert(
        "modelInputSha256".into(),
        model_config_record["sha256"].clone(),
    );
    report_bindings.insert("modelResultsSha256".into(), model_record["sha256"].clone());
    let report_value = json!({
        "schema": "zugfolge-reference-report/v3", "artifactBinding": report_bindings,
        "releaseChecksum": release_checksum, "modelInputSha256": model_config_record["sha256"],
        "sources": { "timetableHoldout": source, "technicalValidation": { "datasetId": "validation-v1", "datasetSha256": validation_record["sha256"], "sampleIdsSha256": evidence_value["validation"]["sampleIdsSha256"], "source": validation_value["source"] } },
        "assumptions": assumptions,
        "qualification": { "basis": "verified-disjoint-frozen-artifacts", "frozenAt": frozen, "calibrationDatasetId": "calibration-v1", "validationDatasetId": "validation-v1", "calibrationSampleCount": 1, "validationSampleCount": 1, "disjoint": true },
        "tolerance": capture_value["tolerance"], "passed": true, "releaseQualified": true,
        "comparisons": [{ "groupId": "group-1", "characteristicsId": "emu-v1", "trainCategory": "RE", "calibrationMethod": "fixture", "validationSampleId": "val-1", "validationSourceId": "validation-source", "rawRunningSeconds": 600, "calculatedTechnicalSeconds": 612, "technicalReferenceSeconds": 610, "technicalDeviationSeconds": 2, "toleranceSeconds": 31, "technicalWithinTolerance": true, "scheduledDurationP20Seconds": 650, "scheduledRunningP20Seconds": 640, "scheduledDwellP20Seconds": 10, "modeledTimetableSeconds": 622, "scheduledAllowanceSeconds": 28, "sampleCount": 5 }]
    });
    let (_report_record, report) = json_artifact("report.json", &report_value);
    let candidate_value = json!({ "schema": "zugfolge-infra-release-manifest/v1", "releaseChecksum": release_checksum, "modelInputSha256": model_config_record["sha256"] });
    let (_candidate_record, candidate) = json_artifact("candidate.json", &candidate_value);
    json!({ "createdAt": frozen, "artifacts": {
        "captureConfig": capture, "referenceCorpus": corpus, "qualificationEvidence": evidence,
        "calibrationDataset": calibration, "calibrationConfig": calibration_config,
        "validationDataset": validation, "validationConfig": validation_config,
        "modelConfig": model_config, "modelResults": model, "report": report, "candidateManifest": candidate
    }})
}

fn replace_artifact_value(input: &mut Value, key: &str, value: &Value) {
    let (_, artifact) = json_artifact(&format!("{key}.json"), value);
    input["artifacts"][key] = artifact;
}

#[test]
fn qualifiziertes_referenzrelease_bleibt_byteidentisch() {
    let input = qualified_input();
    let first = build_qualified_reference_release(&input).expect("qualifiziertes Referenzrelease");
    let second = build_qualified_reference_release(&input).expect("deterministische Wiederholung");
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
    assert_eq!(
        first["schema"],
        "zugfolge-qualified-infra-release-manifest/v1"
    );
}

#[test]
fn autoritativer_referenzreport_ist_byteidentisch_und_bildet_fehlschlag_selbst() {
    let valid = qualified_input();
    let expected_bytes = decode_hex(valid["artifacts"]["report"]["bytesHex"].as_str().unwrap());
    let expected: Value = serde_json::from_slice(&expected_bytes).unwrap();
    let report = build_reference_report(&valid).expect("autoritativer Report");
    assert_eq!(report, expected);
    assert_eq!(
        serde_json::to_vec(&report).unwrap(),
        serde_json::to_vec(&expected).unwrap()
    );

    let mut failed = valid;
    let mut model: Value = serde_json::from_slice(&decode_hex(
        failed["artifacts"]["modelResults"]["bytesHex"]
            .as_str()
            .unwrap(),
    ))
    .unwrap();
    model["results"][0]["runningSeconds"] = json!(900);
    model["results"][0]["modeledTimetableSeconds"] = json!(910);
    replace_artifact_value(&mut failed, "modelResults", &model);
    let failed_report = build_reference_report(&failed).expect("fachlich negativer Report");
    assert_eq!(failed_report["passed"], false);
    assert_eq!(failed_report["releaseQualified"], false);
    assert!(build_qualified_reference_release(&failed).is_err());
}

#[test]
fn referenzrelease_verweigert_forged_flags_hashfehler_und_manipulierte_artefakte() {
    let valid = qualified_input();
    let mut forged = valid.clone();
    let mut failed_model: Value = serde_json::from_slice(&decode_hex(
        forged["artifacts"]["modelResults"]["bytesHex"]
            .as_str()
            .unwrap(),
    ))
    .unwrap();
    failed_model["results"][0]["runningSeconds"] = json!(900);
    failed_model["results"][0]["modeledTimetableSeconds"] = json!(910);
    replace_artifact_value(&mut forged, "modelResults", &failed_model);
    let mut forged_report: Value = serde_json::from_slice(&decode_hex(
        forged["artifacts"]["report"]["bytesHex"].as_str().unwrap(),
    ))
    .unwrap();
    forged_report["artifactBinding"]["modelResultsSha256"] =
        forged["artifacts"]["modelResults"]["record"]["sha256"].clone();
    forged_report["passed"] = Value::Bool(true);
    forged_report["releaseQualified"] = Value::Bool(true);
    replace_artifact_value(&mut forged, "report", &forged_report);
    assert!(
        build_qualified_reference_release(&forged).is_err(),
        "forged passed=true darf ein fachlich gescheitertes Modell nicht qualifizieren"
    );

    let mut claimed = valid.clone();
    let mut claimed_model: Value = serde_json::from_slice(&decode_hex(
        claimed["artifacts"]["modelResults"]["bytesHex"]
            .as_str()
            .unwrap(),
    ))
    .unwrap();
    claimed_model["qualification"] = json!("validation");
    replace_artifact_value(&mut claimed, "modelResults", &claimed_model);
    assert!(build_reference_report(&claimed).is_err());

    let mut overlap = valid.clone();
    let mut overlap_evidence: Value = serde_json::from_slice(&decode_hex(
        overlap["artifacts"]["qualificationEvidence"]["bytesHex"]
            .as_str()
            .unwrap(),
    ))
    .unwrap();
    overlap_evidence["validation"]["sampleIds"] = json!(["cal-1"]);
    overlap_evidence["validation"]["sampleIdsSha256"] = json!(
        Sha256::digest(b"[\"cal-1\"]")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    replace_artifact_value(&mut overlap, "qualificationEvidence", &overlap_evidence);
    assert!(build_reference_report(&overlap).is_err());

    let mut candidate_mismatch = valid.clone();
    candidate_mismatch["artifacts"]["candidateManifest"]["bytesHex"] =
        Value::String(bytes_hex(b"{}"));
    assert!(build_qualified_reference_release(&candidate_mismatch).is_err());

    for key in ["referenceCorpus", "qualificationEvidence", "modelResults"] {
        let mut manipulated = valid.clone();
        let bytes = decode_hex(manipulated["artifacts"][key]["bytesHex"].as_str().unwrap());
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value["tampered"] = Value::Bool(true);
        replace_artifact_value(&mut manipulated, key, &value);
        assert!(
            build_qualified_reference_release(&manipulated).is_err(),
            "Manipulation von {key} muss fail-closed enden"
        );
    }
}

#[test]
fn release_manifest_bleibt_byteidentisch() {
    let (config, catalog, rights, capture, artifacts, quality) = fixture();
    let result =
        build_public_infra_release(&config, &catalog, &rights, &capture, &artifacts, &quality)
            .expect("gültiger öffentlicher Release");
    let golden: Value = serde_json::from_str(include_str!("fixtures/public-release.golden.json"))
        .expect("gültiger Golden Master");
    assert_eq!(result, golden);
    assert_eq!(
        serde_json::to_vec(&result).expect("kanonische Ergebnisbytes"),
        serde_json::to_vec(&golden).expect("kanonische Golden-Master-Bytes"),
    );
    let shipped = serde_json::to_string(&result)
        .expect("serialisierbar")
        .to_lowercase();
    assert!(!shipped.contains("internal-evidence"));
    assert!(!shipped.contains("secret-station-plan"));
}

#[test]
fn jahresplan_endet_mit_holdout_und_signatur() {
    let (config, catalog, rights, ..) = fixture();
    let plan = build_annual_infra_plan(&config, &catalog, &rights).expect("gültiger Jahresplan");
    let stages = plan["stages"].as_array().expect("Stufen");
    assert_eq!(stages[stages.len() - 2]["id"], "independent-validation");
    assert_eq!(stages[stages.len() - 1]["id"], "signature");
}

#[test]
fn fehlende_rechte_und_interner_hash_schliessen_fail_closed() {
    let (config, catalog, mut rights, mut capture, artifacts, quality) = fixture();
    let valid_rights = rights.clone();
    rights["quellen"]
        .as_array_mut()
        .expect("Quellen")
        .retain(|source| source["id"] != "internal");
    assert!(build_annual_infra_plan(&config, &catalog, &rights).is_err());
    capture["internalEvidenceLedgerSha256"] = Value::String(String::new());
    assert!(
        build_public_infra_release(
            &config,
            &catalog,
            &valid_rights,
            &capture,
            &artifacts,
            &quality
        )
        .is_err()
    );
}

#[test]
fn interne_validierung_wird_nur_bei_echtem_capture_behauptet() {
    let (config, catalog, rights, mut capture, artifacts, quality) = fixture();
    capture["sources"]
        .as_array_mut()
        .expect("Capturequellen")
        .retain(|source| source["id"] != "internal-evidence");
    let result =
        build_public_infra_release(&config, &catalog, &rights, &capture, &artifacts, &quality)
            .expect("Release ohne optionale interne Evidenz");
    assert_eq!(
        result["release"]["validation"]["additionalInternalValidationApplied"],
        false,
    );
}

#[test]
fn widerspruechliche_summen_und_doppelte_ids_schliessen_fail_closed() {
    let (config, catalog, mut rights, capture, mut artifacts, mut quality) = fixture();
    quality["byClassLengthMm"]["B"] = Value::from(898);
    assert!(
        build_public_infra_release(&config, &catalog, &rights, &capture, &artifacts, &quality,)
            .is_err()
    );

    quality["byClassLengthMm"]["B"] = Value::from(899);
    let duplicate_artifact = artifacts[0].clone();
    artifacts
        .as_array_mut()
        .expect("Artefakte")
        .push(duplicate_artifact);
    assert!(
        build_public_infra_release(&config, &catalog, &rights, &capture, &artifacts, &quality,)
            .is_err()
    );

    let duplicate_rights = rights["quellen"][0].clone();
    rights["quellen"]
        .as_array_mut()
        .expect("Rechtequellen")
        .push(duplicate_rights);
    assert!(build_annual_infra_plan(&config, &catalog, &rights).is_err());
}

fn write(path: &Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("Testverzeichnis");
    }
    fs::write(path, bytes).expect("Testdatei");
}

#[test]
fn alter_v1_einstieg_wird_ebenfalls_in_rust_gebildet() {
    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
    let suffix = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "zugfolge-legacy-release-{}-{suffix}",
        std::process::id()
    ));
    let source_root = root.join("sources");
    let artifact_root = root.join("artifacts");
    for source in [
        "sachsen-latest.osm.pbf",
        "sachsen-anhalt-latest.osm.pbf",
        "thueringen-latest.osm.pbf",
        "gtfs-rv-free-2026-08-10.zip",
    ] {
        write(&source_root.join(source), source.as_bytes());
    }
    for (artifact, bytes) in [
        ("mitteldeutschland-b-ebo.osm.pbf", b"pbf".as_slice()),
        ("trassenfinder-infrastruktur-2026.json", b"{}".as_slice()),
        ("mitteldeutschland-b.pmtiles", b"tiles".as_slice()),
    ] {
        write(&artifact_root.join(artifact), bytes);
    }
    write(
        &artifact_root.join("gtfs-region-20260812-v2.json"),
        serde_json::to_string(&serde_json::json!({ "snapshotHash": "a".repeat(64) }))
            .expect("JSON")
            .as_bytes(),
    );
    write(
        &artifact_root.join("operational-network.json"),
        serde_json::to_string(&serde_json::json!({
            "networkHash": "b".repeat(64),
            "network": {
                "validFrom": "2025-12-14",
                "validUntil": "2026-12-12",
                "metrics": {
                    "qualityBSegmentCount": 2,
                    "qualityCSegmentCount": 1,
                    "orderableJourneyChainCount": 3,
                    "conflictResourceCount": 4,
                },
                "segmentQualifications": [{ "qualityClass": "C", "orderable": false }],
            },
        }))
        .expect("JSON")
        .as_bytes(),
    );
    write(
        &artifact_root.join("pbf-release-report.json"),
        serde_json::to_string(&serde_json::json!({
            "quality": { "classes": { "A": 0, "B": 2, "C": 1 } },
            "derivations": {
                "blocksHash": "c".repeat(64),
                "interlockingRoutesHash": "d".repeat(64),
                "interlockingRoutes": [{}],
            },
            "topology": { "conservativeConflictResources": 5 },
        }))
        .expect("JSON")
        .as_bytes(),
    );
    write(
        &artifact_root.join("independent-validation-set.json"),
        serde_json::to_string(&serde_json::json!({
            "artifact": {
                "result": "passed",
                "selection": { "calibrationDataUsed": false },
                "metrics": { "checkCount": 6, "failedCount": 0 },
            },
            "validationHash": "e".repeat(64),
        }))
        .expect("JSON")
        .as_bytes(),
    );
    write(
        &root.join("tools/region-import/mitteldeutschland-b.geojson"),
        b"{}",
    );
    write(
        &root.join("tools/region-import/mitteldeutschland-b.poly"),
        b"polygon",
    );
    for path in [
        "tools/region-import/import-mitteldeutschland-b.sh",
        "tools/region-import/import-mitteldeutschland-b.ps1",
        "tools/region-import/build-gtfs-region.mjs",
        "tools/region-import/service-scope.mjs",
        "tools/region-import/build-operational-network.mjs",
        "tools/region-import/operational-network.mjs",
        "tools/region-import/map-layers.mjs",
        "tools/region-import/build-map-layers.mjs",
        "tools/region-import/validation-set.mjs",
        "tools/region-import/build-validation-set.mjs",
        "tools/region-import/build-infra-release.mjs",
        "tools/region-import/release-crypto.mjs",
        "tools/region-import/sign-release.mjs",
        "tools/region-import/verify-release.mjs",
        "crates/zugfolge-infra/examples/pbf_release_report.rs",
    ] {
        write(&root.join(path), path.as_bytes());
    }

    let release = build_mitteldeutschland_infra_release(&root, &source_root, &artifact_root)
        .expect("qualifizierter v1-Release");
    assert_eq!(release["schema"], "zugfolge-infra-release/v1");
    assert_eq!(release["status"], "qualified");
    assert_eq!(release["sources"].as_array().expect("Quellen").len(), 5);
    assert_eq!(
        release["pipeline"]["scripts"]
            .as_array()
            .expect("Pipelineskripte")
            .len(),
        15,
    );
    fs::remove_dir_all(root).expect("Testverzeichnis aufraeumen");
}
