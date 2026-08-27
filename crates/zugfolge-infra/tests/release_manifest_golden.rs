//! Golden-Master- und Fail-closed-Nachweis des Rust-Releasecompilers.

use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zugfolge_infra::{
    build_annual_infra_plan, build_mitteldeutschland_infra_release, build_public_infra_release,
    build_public_infra_release_with_operational_quality, build_qualified_reference_release,
    build_reference_report,
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

fn static_map_quality_with_visible_class_c() -> Value {
    let layer_names = [
        ("rail_corridors", "rail-corridor"),
        ("operating_points", "operating-point"),
        ("stations", "station"),
        ("tracks", "track"),
        ("platforms", "platform"),
        ("switches", "switch"),
        ("signals", "signal"),
        ("blocks", "block"),
        ("conflict_resources", "conflict_resource"),
        ("rail_context", "rail_context"),
    ];
    let layers: Vec<_> = layer_names
        .iter()
        .enumerate()
        .map(|(index, (name, feature_type))| {
            let mut layer = json!({
                "name": name,
                "featureType": feature_type,
                "features": 1,
                "qualityClassFeatureCount": if index == 9 {
                    json!({"A": 0, "B": 0, "C": 1})
                } else {
                    json!({"A": 0, "B": 1, "C": 0})
                },
            });
            if *name == "tracks" {
                layer["totalLengthMm"] = json!(999);
                layer["qualityClassLengthMm"] = json!({"A": 100, "B": 799, "C": 100});
            }
            layer
        })
        .collect();
    json!({
        "schema": "zugfolge-static-map-quality/v2",
        "releaseId": "karte-deutschland-2027.1-v2",
        "infrastructureCorpusId": "infra-deutschland-2027.1",
        "timetableYear": 2027,
        "scopeId": "deutschland-ebo-visible-corpus",
        "purpose": "static-map-visible-quality",
        "deterministic": true,
        "claims": {
            "detailedSourceReportShipped": false,
            "operationalInfraRelease": false,
            "productionActivationEligible": false
        },
        "classification": {
            "A": "complete-evidence",
            "B": "conservative-visible-model",
            "C": "visible-not-operationally-orderable"
        },
        "sourceReport": {
            "content": "detailed-infrastructure-quality-report",
            "binding": "sha256",
            "bytes": 123,
            "sha256": "6".repeat(64),
            "shipped": false
        },
        "summary": {
            "visibleLayers": 10,
            "visibleFeatures": 10,
            "qualityClassFeatureCount": {"A": 0, "B": 9, "C": 1}
        },
        "layers": layers
    })
}

fn static_map_quality_bytes(report: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(report).expect("Static-Map-Quality-v2");
    bytes.push(b'\n');
    bytes
}

fn operational_quality_bytes(report: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(report).expect("Operational-v2-Quality");
    bytes.push(b'\n');
    bytes
}

fn closed_operational_quality(static_quality: &Value, static_quality_bytes: &[u8]) -> Value {
    let static_quality_sha256 = Sha256::digest(static_quality_bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let timetable_route_evidence = json!({
        "reportSchema": "zugfolge-germany-timetable-route-report/v4",
        "policyId": "synthetic-operational-b/v2",
        "derivationRule": "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2",
        "selectionRule": "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
        "reportBytes": 1234,
        "reportSha256": "9".repeat(64),
        "routesBytes": 5678,
        "routesSha256": "a".repeat(64),
        "gtfsSnapshotBytes": 9012,
        "gtfsSnapshotSha256": "b".repeat(64),
        "transferDemandsSchema": "zugfolge-timetable-transfer-demands/v2",
        "transferDemandsBytes": 3456,
        "transferDemandsSha256": "9".repeat(64),
        "snapshotHash": "c".repeat(64),
        "archive": "gtfs-rv-free.zip",
        "archiveSha256": "d".repeat(64),
        "sourceLicense": "CC-BY-4.0",
        "sourceLicenseAsPublished": "CC BY 4.0",
        "selectedSegmentCount": 1677,
        "completeRouteCount": 1677,
        "routeRecordCount": 1677,
        "sameStopTransitionCount": 2,
        "routeSetSha256": "a".repeat(64),
        "dailyCirculationPlanSha256": "b".repeat(64),
        "transferSetSha256": "c".repeat(64),
        "transferDemandsProduced": true,
        "dailyCirculation": {
            "lotCount": 52,
            "journeyChainCount": 1677,
            "circulationCount": 197,
            "rolloverAssignmentCount": 197,
            "plannedTransitionCount": 1677,
            "turnaroundDemandCount": 1595,
            "transferDemandCount": 82,
            "transferLotCount": 39
        },
        "transferRouteCount": 82,
        "transferRouteLegCount": 1234,
        "transferRouteLengthMm": 3_000_000_000_i64,
        "realGeometry": true,
        "simulatedOperationalAssignment": true,
        "realInterlockingFactsClaimed": false,
        "externalOperationalNetworkProvenance": false
    });
    json!({
        "schema": "zugfolge-operational-infrastructure-quality-report/v1",
        "releaseId": "infra-deutschland-2027.1",
        "timetableYear": 2027,
        "scopeId": "deutschland-ebo-operational-v2",
        "deterministic": true,
        "separation": {
            "mapEvidencePurpose": "visible-map-quality-evidence",
            "operationalEvidencePurpose": "closed-operational-v2-model",
            "mapClassCReclassified": false,
            "mapClassCBlocksOperationalQualityGate": false,
            "mapObjectsRemoved": false
        },
        "mapEvidence": {
            "schema": "zugfolge-static-map-quality/v2",
            "mapReleaseId": static_quality["releaseId"],
            "infrastructureCorpusId": static_quality["infrastructureCorpusId"],
            "bytes": static_quality_bytes.len(),
            "sha256": static_quality_sha256,
            "sourceReport": {
                "schema": "zugfolge-final-infrastructure-quality-report/v1",
                "bytes": static_quality["sourceReport"]["bytes"],
                "sha256": static_quality["sourceReport"]["sha256"],
                "shipped": static_quality["sourceReport"]["shipped"]
            },
            "visibleFeatures": static_quality["summary"]["visibleFeatures"],
            "visibleLayers": static_quality["summary"]["visibleLayers"],
            "qualityClassFeatureCount": static_quality["summary"]["qualityClassFeatureCount"],
            "trackLengthMm": static_quality["layers"][3]["totalLengthMm"],
            "trackQualityClassLengthMm": static_quality["layers"][3]["qualityClassLengthMm"]
        },
        "operationalModel": {
            "policyId": "synthetic-operational-b/v2",
            "policySha256": "4".repeat(64),
            "closureReceiptSha256": "3".repeat(64),
            "qualityClass": "B",
            "provenance": "derived",
            "realGeometry": true,
            "simulatedOperationalAssignment": true,
            "realInterlockingFactsClaimed": false,
            "syntheticOperationalDetailsShipped": true,
            "objectLevelProvenanceShipped": false,
            "observedAndSyntheticObjectsShareRuntimeCollections": true,
            "movementRouteTemplates": {
                "bytes": 789,
                "sha256": "5".repeat(64),
                "stateHash": "6".repeat(64),
                "operationalStateHash": "7".repeat(64),
                "timetableTransferSetSha256": "c".repeat(64)
            },
            "timetableRouteEvidence": timetable_route_evidence,
            "operationalArtifact": {
                "bytes": 456,
                "sha256": "8".repeat(64),
                "stateHash": "7".repeat(64)
            },
            "coverage": {
                "blockResources": 3,
                "directedEdges": 2,
                "edgeGeometries": 2,
                "interlockingRoutes": 2,
                "platformIntervals": 1,
                "regionBoundaries": 1,
                "routeVersions": 1,
                "rzueLayouts": 1,
                "signals": 2,
                "switches": 1
            }
        },
        "summary": {
            "operationalQualityClassArtifactCount": {"A": 0, "B": 1, "C": 0},
            "unresolvedRequired": 0,
            "visibleMapClassCFeatureCount": 1
        },
        "qualityGate": {
            "closureReceiptVerified": true,
            "nativeOperationalValidationVerified": true,
            "operationalClassCZero": true,
            "ordinaryAssumptionsPromoted": false,
            "mapClassCReclassified": false,
            "operationalQualityEligible": true,
            "signatureImplied": false,
            "activationImplied": false
        }
    })
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
    let ids: Vec<&str> = stages
        .iter()
        .map(|stage| stage["id"].as_str().expect("Stufenkennung"))
        .collect();
    for required in [
        "openstation-normalization",
        "operational-v2-derivation",
        "operational-v2-native-validation",
        "release-artifact-inventory",
        "public-manifest",
        "operational-v2-acceptance",
    ] {
        assert!(ids.contains(&required), "Jahresplan fehlt {required}");
    }
    assert!(
        !ids.contains(&"stada-capture-gate"),
        "eine optionale StaDa-Quelle darf den Jahresplan nicht blockieren"
    );
    assert!(
        ids.iter().position(|id| *id == "operational-v2-derivation")
            < ids
                .iter()
                .position(|id| *id == "release-artifact-inventory"),
        "Ableitung muss vor dem typisierten Inventar liegen",
    );
    assert_eq!(stages[stages.len() - 2]["id"], "independent-validation");
    assert_eq!(stages[stages.len() - 1]["id"], "signature");
}

#[test]
fn operational_deriver_subvertrag_ist_exakt_und_releasegebunden() {
    let (config, catalog, rights, ..) = fixture();
    build_annual_infra_plan(&config, &catalog, &rights)
        .expect("exakter OperationalDeriver-Jahresvertrag");

    let mut unbekanntes_feld = config.clone();
    unbekanntes_feld["pipeline"]["operationalDeriver"]["stateHash"] = Value::String("0".repeat(64));
    assert!(build_annual_infra_plan(&unbekanntes_feld, &catalog, &rights).is_err());

    let mut falsche_spezifikation = config.clone();
    falsche_spezifikation["pipeline"]["operationalDeriver"]["specification"] = Value::String(
        "tools/region-import/germany/operational-infrastructure.annual-2026.3.json".to_owned(),
    );
    assert!(build_annual_infra_plan(&falsche_spezifikation, &catalog, &rights).is_err());

    let mut fehlender_subvertrag = config;
    fehlender_subvertrag["pipeline"]
        .as_object_mut()
        .expect("Pipelineobjekt")
        .remove("operationalDeriver");
    assert!(build_annual_infra_plan(&fehlender_subvertrag, &catalog, &rights).is_err());
}

#[test]
fn operational_deriver_bleibt_fuer_historischen_v1_jahresvertrag_optional() {
    let (_, catalog, rights, ..) = fixture();
    for (name, bytes) in [
        (
            "release.config.json",
            include_str!("../../../tools/region-import/germany/release.config.json"),
        ),
        (
            "release.annual-2026.2.config.json",
            include_str!("../../../tools/region-import/germany/release.annual-2026.2.config.json"),
        ),
    ] {
        let legacy: Value = serde_json::from_str(bytes).expect("gültige Legacy-Konfiguration");
        let plan = build_annual_infra_plan(&legacy, &catalog, &rights).unwrap_or_else(|error| {
            panic!("{name} muss ohne OperationalDeriver gültig bleiben: {error}")
        });
        let stage_ids: Vec<&str> = plan["stages"]
            .as_array()
            .expect("Legacy-Stufen")
            .iter()
            .map(|stage| stage["id"].as_str().expect("Legacy-Stufenkennung"))
            .collect();
        for forbidden in [
            "operational-v2-derivation",
            "operational-v2-native-validation",
            "release-artifact-inventory",
            "public-manifest",
            "operational-v2-acceptance",
        ] {
            assert!(
                !stage_ids.contains(&forbidden),
                "{name} darf die neue v2-Stufe {forbidden} nicht nachträglich erhalten"
            );
        }
    }

    let (mut config, ..) = fixture();
    config["release"]["releaseId"] = Value::String("infra-deutschland-2026.2".to_owned());
    config["release"]["timetableYear"] = Value::from(2026);
    config["pipeline"]
        .as_object_mut()
        .expect("Pipelineobjekt")
        .remove("operationalDeriver");
    build_annual_infra_plan(&config, &catalog, &rights)
        .expect("historischer 2026.2/v1-Jahresvertrag ohne OperationalDeriver");

    config["release"]["releaseId"] = Value::String("infra-deutschland-2026.3".to_owned());
    assert!(
        build_annual_infra_plan(&config, &catalog, &rights).is_err(),
        "2026.3 muss ohne OperationalDeriver fail-closed enden"
    );
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
fn source_capture_v2_bindet_release_jahr_und_plan_ohne_historisches_ledger() {
    let (config, catalog, rights, mut capture, artifacts, quality) = fixture();
    capture["schema"] = Value::String("zugfolge-source-capture/v2".to_owned());
    capture
        .as_object_mut()
        .expect("Captureobjekt")
        .remove("internalEvidenceLedgerSha256");
    capture["releaseId"] = config["release"]["releaseId"].clone();
    capture["timetableYear"] = config["release"]["timetableYear"].clone();
    capture["capturePlanSha256"] = Value::String("a".repeat(64));

    build_public_infra_release(&config, &catalog, &rights, &capture, &artifacts, &quality)
        .expect("Source-Capture v2 mit exakter Jahresbindung");

    capture["releaseId"] = Value::String("infra-deutschland-anderes-jahr".to_owned());
    assert!(
        build_public_infra_release(&config, &catalog, &rights, &capture, &artifacts, &quality)
            .is_err(),
        "abweichende Releasebindung muss fail-closed enden"
    );
}

#[test]
fn deutschland_2026_patch_4_verweigert_historisches_source_capture_v1() {
    let (mut config, catalog, rights, capture, mut artifacts, quality) = fixture();
    config["release"]["releaseId"] = Value::String("infra-deutschland-2026.4".to_owned());
    config["release"]["timetableYear"] = Value::from(2026);
    let deriver = &mut config["pipeline"]["operationalDeriver"];
    deriver["specification"] = Value::String(
        "tools/region-import/germany/operational-infrastructure.annual-2026.4.json".to_owned(),
    );
    deriver["candidate"] = Value::String(
        "var/derived/germany-2026.4/operational-infrastructure-v2.candidate.json".to_owned(),
    );
    deriver["report"] = Value::String(
        "var/derived/germany-2026.4/operational-infrastructure-v2.derivation-report.json"
            .to_owned(),
    );
    deriver["output"] =
        Value::String("var/derived/germany-2026.4/operational-infrastructure-v2.json".to_owned());
    let operational = artifacts
        .as_array_mut()
        .expect("Artefaktliste")
        .iter_mut()
        .find(|artifact| artifact["kind"] == "operational-infrastructure-v2")
        .expect("Operational-v2-Artefakt");
    operational["id"] = Value::String("operational-infrastructure-2026.4".to_owned());
    operational["infraReleaseId"] = Value::String("infra-deutschland-2026.4".to_owned());
    for (kind, id) in [
        (
            "movement-route-templates-v2",
            "operational-movement-routes-2026.4",
        ),
        (
            "timetable-transfer-demands-v2",
            "timetable-transfer-demands-2026.4",
        ),
    ] {
        let artifact = artifacts
            .as_array_mut()
            .expect("Artefaktliste")
            .iter_mut()
            .find(|artifact| artifact["kind"] == kind)
            .unwrap_or_else(|| panic!("{kind}-Artefakt"));
        artifact["id"] = Value::String(id.to_owned());
    }

    let error =
        build_public_infra_release(&config, &catalog, &rights, &capture, &artifacts, &quality)
            .expect_err("2026.4 darf kein historisches Source-Capture v1 akzeptieren");
    assert!(error.to_string().contains("ab Patch 3"));

    let mut capture_v2 = capture;
    capture_v2["schema"] = Value::String("zugfolge-source-capture/v2".to_owned());
    capture_v2
        .as_object_mut()
        .expect("Captureobjekt")
        .remove("internalEvidenceLedgerSha256");
    capture_v2["releaseId"] = Value::String("infra-deutschland-2026.4".to_owned());
    capture_v2["timetableYear"] = Value::from(2026);
    capture_v2["capturePlanSha256"] = Value::String("a".repeat(64));
    build_public_infra_release(
        &config,
        &catalog,
        &rights,
        &capture_v2,
        &artifacts,
        &quality,
    )
    .expect("2026.4 akzeptiert das exakt releasegebundene Source-Capture v2");
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

    quality["byClassLengthMm"]["B"] = Value::from(898);
    quality["byClassLengthMm"]["C"] = Value::from(1);
    let error =
        build_public_infra_release(&config, &catalog, &rights, &capture, &artifacts, &quality)
            .expect_err("Klasse C darf nicht freigegeben werden");
    assert!(error.to_string().contains("Klasse-C-Abschnitte"));

    quality["byClassLengthMm"]["B"] = Value::from(899);
    quality["byClassLengthMm"]["C"] = Value::from(0);
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

#[test]
fn sichtbare_static_map_klasse_c_bleibt_getrennt_von_operational_v2_signierbar() {
    let (config, catalog, rights, capture, artifacts, _) = fixture();
    let static_quality_value = static_map_quality_with_visible_class_c();
    let static_quality = static_map_quality_bytes(&static_quality_value);
    let operational_quality_value =
        closed_operational_quality(&static_quality_value, &static_quality);
    let operational_quality = operational_quality_bytes(&operational_quality_value);

    let result = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality,
    )
    .expect("getrennte Karten- und Betriebsqualitaet");
    let release = &result["release"];
    assert_eq!(
        release["quality"]["byClassLengthMm"],
        json!({"A": 100, "B": 799, "C": 100})
    );
    assert_eq!(
        release["quality"]["byClassFeatureCount"],
        json!({"A": 0, "B": 9, "C": 1})
    );
    assert_eq!(release["quality"]["classCVisible"], true);
    assert_eq!(release["quality"]["classCPlayable"], false);
    assert_eq!(
        release["quality"]["operationalClosure"]["qualityClass"],
        "B"
    );
    assert_eq!(
        release["quality"]["operationalClosure"]["operationalQualityEligible"],
        true
    );
    assert_eq!(
        release["quality"]["operationalClosure"]["activationImplied"],
        false
    );
    assert_eq!(
        release["quality"]["operationalClosure"]["candidateSha256"],
        "8".repeat(64)
    );
    assert_eq!(
        release["quality"]["operationalClosure"]["syntheticOperationalDetailsShipped"],
        true
    );
    assert_eq!(
        release["quality"]["operationalClosure"]["objectLevelProvenanceShipped"],
        false
    );
    assert_eq!(
        release["quality"]["operationalClosure"]["observedAndSyntheticObjectsShareRuntimeCollections"],
        true
    );
    assert_eq!(
        release["quality"]["operationalClosure"]["timetableRouteEvidence"]["routeSetSha256"],
        "a".repeat(64)
    );
    assert_eq!(
        release["quality"]["operationalClosure"]["timetableRouteEvidence"]["routeRecordCount"],
        1677
    );
    assert_eq!(
        release["quality"]["operationalClosure"]["timetableRouteEvidence"]["transferRouteCount"],
        82
    );
    assert_eq!(
        release["quality"]["operationalClosure"]["timetableRouteEvidence"]["externalOperationalNetworkProvenance"],
        false
    );
    assert_eq!(
        release["corpus"]["modelledScope"],
        "operational-v2-closure-with-visible-static-context"
    );
    assert_eq!(
        static_quality_value["claims"]["productionActivationEligible"],
        false
    );
}

#[test]
fn manifest_cli_bindet_die_tatsaechlichen_static_und_operational_quality_dateibytes() {
    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
    let suffix = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "zugfolge-two-artifact-manifest-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("CLI-Testverzeichnis");
    let (config, catalog, rights, capture, artifacts, _) = fixture();
    let static_quality_value = static_map_quality_with_visible_class_c();
    let static_quality = static_map_quality_bytes(&static_quality_value);
    let operational_quality = closed_operational_quality(&static_quality_value, &static_quality);
    let values = [
        ("config.json", &config),
        ("catalog.json", &catalog),
        ("rights.json", &rights),
        ("capture.json", &capture),
        ("artifacts.json", &artifacts),
        ("operational-quality.json", &operational_quality),
    ];
    for (name, value) in values {
        write(
            &root.join(name),
            &serde_json::to_vec(value).expect("CLI-Fixture"),
        );
    }
    let static_quality_path = root.join("static-quality.json");
    write(&static_quality_path, &static_quality);
    let operational_quality_path = root.join("operational-quality.json");
    let output_path = root.join("release.json");
    let invoke = |output: &Path| {
        Command::new(env!("CARGO_BIN_EXE_zugfolge-infra-release"))
            .arg("manifest")
            .arg(root.join("config.json"))
            .arg(root.join("catalog.json"))
            .arg(root.join("rights.json"))
            .arg(root.join("capture.json"))
            .arg(root.join("artifacts.json"))
            .arg(&static_quality_path)
            .arg(&operational_quality_path)
            .arg(output)
            .status()
            .expect("Releasecompiler starten")
    };
    assert!(invoke(&output_path).success());
    let original_output_bytes = fs::read(&output_path).expect("CLI-Releasebytes lesen");
    assert!(
        !invoke(&output_path).success(),
        "zweiter Manifestlauf auf dasselbe versionierte Ziel muss create-new scheitern"
    );
    assert_eq!(
        fs::read(&output_path).expect("CLI-Releasebytes nach zweitem Lauf lesen"),
        original_output_bytes,
        "fehlgeschlagener zweiter Manifestlauf darf vorhandene Bytes nicht veraendern"
    );
    let release: Value =
        serde_json::from_slice(&fs::read(&output_path).expect("CLI-Release lesen"))
            .expect("CLI-Release");
    assert_eq!(
        release["release"]["quality"]["operationalClosure"]["staticMapQualitySha256"],
        Sha256::digest(&static_quality)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let original_operational_bytes =
        fs::read(&operational_quality_path).expect("Operational-Quality lesen");
    let original_operational_sha256 = Sha256::digest(&original_operational_bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(
        release["release"]["quality"]["operationalClosure"]["reportSha256"],
        original_operational_sha256
    );

    let mut whitespace_changed_operational_bytes = original_operational_bytes;
    whitespace_changed_operational_bytes.push(b' ');
    write(
        &operational_quality_path,
        &whitespace_changed_operational_bytes,
    );
    let whitespace_output = root.join("release-with-operational-whitespace.json");
    assert!(
        invoke(&whitespace_output).success(),
        "JSON-Whitespace aendert keine operative Semantik"
    );
    let whitespace_release: Value =
        serde_json::from_slice(&fs::read(&whitespace_output).expect("Whitespace-Release lesen"))
            .expect("Whitespace-Release");
    let whitespace_operational_sha256 = Sha256::digest(&whitespace_changed_operational_bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_ne!(
        whitespace_operational_sha256, original_operational_sha256,
        "gueltiger JSON-Whitespace muss die Dateibytebindung aendern"
    );
    assert_eq!(
        whitespace_release["release"]["quality"]["operationalClosure"]["reportSha256"],
        whitespace_operational_sha256
    );

    let mut changed_static_quality = static_quality;
    changed_static_quality.push(b' ');
    write(&static_quality_path, &changed_static_quality);
    assert!(
        !invoke(&root.join("release-with-unbound-static-bytes.json")).success(),
        "selbst gueltiger JSON-Nachlauf muss wegen abweichender Dateibytes scheitern"
    );
    fs::remove_dir_all(root).expect("CLI-Testverzeichnis aufraeumen");
}

#[test]
fn operationaler_zwei_artefakt_gate_verwirft_offene_dimension_und_hashabweichung() {
    let (config, catalog, rights, capture, artifacts, _) = fixture();
    let static_quality_value = static_map_quality_with_visible_class_c();
    let static_quality = static_map_quality_bytes(&static_quality_value);
    let mut unresolved = closed_operational_quality(&static_quality_value, &static_quality);
    unresolved["summary"]["unresolvedRequired"] = json!(1);
    unresolved["qualityGate"]["operationalQualityEligible"] = json!(false);
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&unresolved),
    )
    .expect_err("offene Operational-v2-Dimension muss scheitern");
    assert!(error.to_string().contains("operationalQualityEligible"));

    let mut wrong_hash = closed_operational_quality(&static_quality_value, &static_quality);
    wrong_hash["operationalModel"]["operationalArtifact"]["sha256"] = Value::String("3".repeat(64));
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&wrong_hash),
    )
    .expect_err("abweichender Candidate-Hash muss scheitern");
    assert!(error.to_string().contains("Byte-/Zustandsbindung"));

    let mut changed_static_bytes = static_quality.clone();
    changed_static_bytes.push(b' ');
    let operational_quality = closed_operational_quality(&static_quality_value, &static_quality);
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &changed_static_bytes,
        &operational_quality_bytes(&operational_quality),
    )
    .expect_err("jede Aenderung der tatsaechlichen Static-v2-Dateibytes muss scheitern");
    assert!(error.to_string().contains("sichtbaren Kartenbeleg"));

    let mut extra_map_field = closed_operational_quality(&static_quality_value, &static_quality);
    extra_map_field["mapEvidence"]["unexpected"] = json!(true);
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&extra_map_field),
    )
    .expect_err("MapEvidence muss den exakten Doppelbindungsvertrag besitzen");
    assert!(error.to_string().contains("Doppelbindungsvertrag"));

    let mut wrong_transfer_bytes =
        closed_operational_quality(&static_quality_value, &static_quality);
    wrong_transfer_bytes["operationalModel"]["timetableRouteEvidence"]["transferDemandsBytes"] =
        json!(3457);
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&wrong_transfer_bytes),
    )
    .expect_err("Closure und Transfer-Sidecar muessen dieselben Dateibytes binden");
    assert!(error.to_string().contains("identische Bytebindung"));

    let mut wrong_transfer_hash =
        closed_operational_quality(&static_quality_value, &static_quality);
    wrong_transfer_hash["operationalModel"]["timetableRouteEvidence"]["transferDemandsSha256"] =
        json!("e".repeat(64));
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&wrong_transfer_hash),
    )
    .expect_err("Closure und Transfer-Sidecar muessen denselben SHA-256 binden");
    assert!(error.to_string().contains("identische Bytebindung"));

    let mut wrong_transfer_binding =
        closed_operational_quality(&static_quality_value, &static_quality);
    wrong_transfer_binding["operationalModel"]["timetableRouteEvidence"]["transferSetSha256"] =
        json!("f".repeat(64));
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&wrong_transfer_binding),
    )
    .expect_err("Closure und Movement-Beleg muessen dasselbe Transfer-Set binden");
    assert!(error.to_string().contains("Transfer-Set-Bindung"));

    for (field, value, message) in [
        ("bytes", json!(790), "Byte-"),
        ("sha256", json!("e".repeat(64)), "Byte-"),
        (
            "operationalStateHash",
            json!("e".repeat(64)),
            "Operational-State-",
        ),
        (
            "timetableTransferSetSha256",
            json!("e".repeat(64)),
            "Transfer-Set-",
        ),
    ] {
        let mut wrong_movement = closed_operational_quality(&static_quality_value, &static_quality);
        wrong_movement["operationalModel"]["movementRouteTemplates"][field] = value;
        let error = build_public_infra_release_with_operational_quality(
            &config,
            &catalog,
            &rights,
            &capture,
            &artifacts,
            &static_quality,
            &operational_quality_bytes(&wrong_movement),
        )
        .expect_err("Movement-Beleg muss Sidecar, Operational-State und Transfer-Set binden");
        assert!(error.to_string().contains(message), "{field}: {error}");
    }

    let mut extra_movement_field =
        closed_operational_quality(&static_quality_value, &static_quality);
    extra_movement_field["operationalModel"]["movementRouteTemplates"]["file"] =
        json!("forbidden-path.json");
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&extra_movement_field),
    )
    .expect_err("oeffentlicher Movement-Beleg darf keinen Pfad tragen");
    assert!(
        error
            .to_string()
            .contains("pfadfreien Byte-/Zustandsvertrag")
    );
}

#[test]
fn operationaler_gate_verwirft_v1_policy_und_alte_provenienzfelder() {
    let (config, catalog, rights, capture, artifacts, _) = fixture();
    let static_quality_value = static_map_quality_with_visible_class_c();
    let static_quality = static_map_quality_bytes(&static_quality_value);

    let mut legacy_details = closed_operational_quality(&static_quality_value, &static_quality);
    let model = legacy_details["operationalModel"]
        .as_object_mut()
        .expect("OperationalModel");
    model.remove("syntheticOperationalDetailsShipped");
    model.insert("syntheticObjectDetailsShipped".into(), json!(false));
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&legacy_details),
    )
    .expect_err("altes syntheticObjectDetailsShipped darf nicht akzeptiert werden");
    assert!(error.to_string().contains("v2-Provenienzvertrag"));

    let mut legacy_merge = closed_operational_quality(&static_quality_value, &static_quality);
    let model = legacy_merge["operationalModel"]
        .as_object_mut()
        .expect("OperationalModel");
    model.remove("objectLevelProvenanceShipped");
    model.remove("observedAndSyntheticObjectsShareRuntimeCollections");
    model.insert("observedAndSyntheticProvenanceMerged".into(), json!(false));
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&legacy_merge),
    )
    .expect_err("altes Provenienz-Mergefeld darf nicht akzeptiert werden");
    assert!(error.to_string().contains("v2-Provenienzvertrag"));

    let mut v1_policy = closed_operational_quality(&static_quality_value, &static_quality);
    v1_policy["operationalModel"]["policyId"] = json!("synthetic-operational-b/v1");
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&v1_policy),
    )
    .expect_err("v1-Policy-ID darf nicht akzeptiert werden");
    assert!(error.to_string().contains("Simulationsprovenienz"));

    for (field, wrong_value) in [
        ("syntheticOperationalDetailsShipped", false),
        ("objectLevelProvenanceShipped", true),
        ("observedAndSyntheticObjectsShareRuntimeCollections", false),
    ] {
        let mut report = closed_operational_quality(&static_quality_value, &static_quality);
        report["operationalModel"][field] = json!(wrong_value);
        let error = build_public_infra_release_with_operational_quality(
            &config,
            &catalog,
            &rights,
            &capture,
            &artifacts,
            &static_quality,
            &operational_quality_bytes(&report),
        )
        .expect_err("falscher v2-Provenienzclaim muss scheitern");
        assert!(
            error.to_string().contains("Simulationsprovenienz"),
            "{field}: {error}"
        );
    }
}

#[test]
fn operationaler_gate_verwirft_aufgeweichten_freien_gtfs_fahrwegbeleg() {
    let (config, catalog, rights, capture, artifacts, _) = fixture();
    let static_quality_value = static_map_quality_with_visible_class_c();
    let static_quality = static_map_quality_bytes(&static_quality_value);

    let mut extra_field = closed_operational_quality(&static_quality_value, &static_quality);
    extra_field["operationalModel"]["timetableRouteEvidence"]["operationalNetwork"] =
        json!({"bytes": 1, "sha256": "f".repeat(64)});
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&extra_field),
    )
    .expect_err("externe Operational-Network-Provenienz muss am Strict-Key-Vertrag scheitern");
    assert!(error.to_string().contains("v4-Closure-Vertrag"));

    for (label, field, value) in [
        (
            "externe Operational-Network-Provenienz",
            "externalOperationalNetworkProvenance",
            json!(true),
        ),
        (
            "unvollstaendige Segmentabdeckung",
            "completeRouteCount",
            json!(1676),
        ),
        (
            "abweichender RouteSet-Hash",
            "routeSetSha256",
            json!("e".repeat(64)),
        ),
        (
            "unvollstaendige Transferabdeckung",
            "transferRouteCount",
            json!(78),
        ),
        ("unfreie Lizenz", "sourceLicense", json!("proprietary")),
    ] {
        let mut report = closed_operational_quality(&static_quality_value, &static_quality);
        report["operationalModel"]["timetableRouteEvidence"][field] = value;
        let error = build_public_infra_release_with_operational_quality(
            &config,
            &catalog,
            &rights,
            &capture,
            &artifacts,
            &static_quality,
            &operational_quality_bytes(&report),
        )
        .expect_err(label);
        assert!(
            error
                .to_string()
                .contains("Policy, Bytebindung, Tagesumlauf-/Transferabdeckung, Vollstaendigkeit oder Provenienz"),
            "{label}: {error}"
        );
    }
}

#[test]
fn operationaler_gate_verlangt_exklusiv_report_v4_transfer_v2_und_daily_partition() {
    let (config, catalog, rights, capture, artifacts, _) = fixture();
    let static_quality_value = static_map_quality_with_visible_class_c();
    let static_quality = static_map_quality_bytes(&static_quality_value);

    for (label, field, value) in [
        (
            "Report-v3",
            "reportSchema",
            json!("zugfolge-germany-timetable-route-report/v3"),
        ),
        (
            "Transfer-Schema-v1",
            "transferDemandsSchema",
            json!("zugfolge-timetable-transfer-demands/v1"),
        ),
    ] {
        let mut report = closed_operational_quality(&static_quality_value, &static_quality);
        report["operationalModel"]["timetableRouteEvidence"][field] = value;
        let error = build_public_infra_release_with_operational_quality(
            &config,
            &catalog,
            &rights,
            &capture,
            &artifacts,
            &static_quality,
            &operational_quality_bytes(&report),
        )
        .expect_err(label);
        assert!(
            error
                .to_string()
                .contains("Policy, Bytebindung, Tagesumlauf-/Transferabdeckung, Vollstaendigkeit oder Provenienz"),
            "{label}: {error}"
        );
    }

    for field in ["plannedTransitionCount", "turnaroundDemandCount"] {
        let mut report = closed_operational_quality(&static_quality_value, &static_quality);
        report["operationalModel"]["timetableRouteEvidence"]["dailyCirculation"]
            .as_object_mut()
            .expect("Daily-Circulation")
            .remove(field);
        let error = build_public_infra_release_with_operational_quality(
            &config,
            &catalog,
            &rights,
            &capture,
            &artifacts,
            &static_quality,
            &operational_quality_bytes(&report),
        )
        .expect_err("alle acht Daily-Plan-Metriken sind Pflicht");
        assert!(
            error
                .to_string()
                .contains("Daily-Circulation-Metrik besitzt fehlende oder unerwartete Felder"),
            "{field}: {error}"
        );
    }

    let mut report = closed_operational_quality(&static_quality_value, &static_quality);
    report["operationalModel"]["timetableRouteEvidence"]["dailyCirculation"]["turnaroundPairCount"] =
        json!(1_595);
    let error = build_public_infra_release_with_operational_quality(
        &config,
        &catalog,
        &rights,
        &capture,
        &artifacts,
        &static_quality,
        &operational_quality_bytes(&report),
    )
    .expect_err("turnaroundPairCount gehoert nicht in die acht Daily-Plan-Metriken");
    assert!(
        error
            .to_string()
            .contains("Daily-Circulation-Metrik besitzt fehlende oder unerwartete Felder"),
        "{error}"
    );

    for (label, planned, turnaround, rollover) in [
        ("unvollstaendige Demand-Partition", 1_677, 1_594, 197),
        ("Planned/JourneyChain-Drift", 1_676, 1_594, 197),
        ("Rollover/Circulation-Drift", 1_677, 1_595, 196),
    ] {
        let mut report = closed_operational_quality(&static_quality_value, &static_quality);
        let daily = &mut report["operationalModel"]["timetableRouteEvidence"]["dailyCirculation"];
        daily["plannedTransitionCount"] = json!(planned);
        daily["turnaroundDemandCount"] = json!(turnaround);
        daily["rolloverAssignmentCount"] = json!(rollover);
        let error = build_public_infra_release_with_operational_quality(
            &config,
            &catalog,
            &rights,
            &capture,
            &artifacts,
            &static_quality,
            &operational_quality_bytes(&report),
        )
        .expect_err(label);
        assert!(
            error
                .to_string()
                .contains("Policy, Bytebindung, Tagesumlauf-/Transferabdeckung, Vollstaendigkeit oder Provenienz"),
            "{label}: {error}"
        );
    }
}

#[test]
fn oeffentlicher_release_transportiert_genau_eine_getrennte_v2_paketkomposition() {
    let (config, catalog, rights, capture, artifacts, quality) = fixture();

    let mut missing = artifacts.clone();
    missing
        .as_array_mut()
        .expect("Artefakte")
        .retain(|artifact| artifact["kind"] != "operational-infrastructure-v2");
    let error =
        build_public_infra_release(&config, &catalog, &rights, &capture, &missing, &quality)
            .expect_err("fehlende Operational-v2-Infrastruktur muss scheitern");
    assert!(error.to_string().contains("genau eine statische"));

    for (kind, message) in [
        (
            "movement-route-templates-v2",
            "genau ein Movement-Route-Templates-v2-Artefakt",
        ),
        (
            "timetable-transfer-demands-v2",
            "genau ein Timetable-Transfer-Demands-v2-Artefakt",
        ),
    ] {
        let mut missing_sidecar = artifacts.clone();
        missing_sidecar
            .as_array_mut()
            .expect("Artefakte")
            .retain(|artifact| artifact["kind"] != kind);
        let error = build_public_infra_release(
            &config,
            &catalog,
            &rights,
            &capture,
            &missing_sidecar,
            &quality,
        )
        .unwrap_err();
        assert!(error.to_string().contains(message), "{kind}: {error}");

        let mut duplicate_sidecar = artifacts.clone();
        let mut duplicate = duplicate_sidecar
            .as_array()
            .expect("Artefakte")
            .iter()
            .find(|artifact| artifact["kind"] == kind)
            .expect("Sidecar")
            .clone();
        duplicate["id"] = json!(format!("duplicate-{kind}"));
        duplicate_sidecar
            .as_array_mut()
            .expect("Artefakte")
            .push(duplicate);
        let error = build_public_infra_release(
            &config,
            &catalog,
            &rights,
            &capture,
            &duplicate_sidecar,
            &quality,
        )
        .unwrap_err();
        assert!(error.to_string().contains(message), "{kind}: {error}");
    }

    for (kind, message) in [
        (
            "movement-route-templates-v2",
            "unbekannte oder fehlende Manifestfelder",
        ),
        (
            "timetable-transfer-demands-v2",
            "unbekannte oder fehlende Manifestfelder",
        ),
    ] {
        let mut extra_field = artifacts.clone();
        let artifact = extra_field
            .as_array_mut()
            .expect("Artefakte")
            .iter_mut()
            .find(|artifact| artifact["kind"] == kind)
            .expect("Sidecar");
        artifact["worldId"] = json!("world-must-not-enter-infra-release");
        let error = build_public_infra_release(
            &config,
            &catalog,
            &rights,
            &capture,
            &extra_field,
            &quality,
        )
        .unwrap_err();
        assert!(error.to_string().contains(message), "{kind}: {error}");
    }

    let mut legacy_transfer_kind = artifacts.clone();
    let transfer = legacy_transfer_kind
        .as_array_mut()
        .expect("Artefakte")
        .iter_mut()
        .find(|artifact| artifact["kind"] == "timetable-transfer-demands-v2")
        .expect("Transfer-v2-Sidecar");
    transfer["kind"] = json!("timetable-transfer-demands-v1");
    transfer["file"] = json!("timetable-routes-v2.transfer-demands-v1.json");
    let error = build_public_infra_release(
        &config,
        &catalog,
        &rights,
        &capture,
        &legacy_transfer_kind,
        &quality,
    )
    .expect_err("Transfer-v1 darf nicht als aktuelles Paketartefakt dienen");
    assert!(
        error
            .to_string()
            .contains("genau ein Timetable-Transfer-Demands-v2-Artefakt")
    );

    let mut legacy_transfer_file = artifacts.clone();
    let transfer = legacy_transfer_file
        .as_array_mut()
        .expect("Artefakte")
        .iter_mut()
        .find(|artifact| artifact["kind"] == "timetable-transfer-demands-v2")
        .expect("Transfer-v2-Sidecar");
    transfer["file"] = json!("timetable-routes-v2.transfer-demands-v1.json");
    let error = build_public_infra_release(
        &config,
        &catalog,
        &rights,
        &capture,
        &legacy_transfer_file,
        &quality,
    )
    .expect_err("Transfer-v2 braucht den kanonischen v2-Dateinamen");
    assert!(error.to_string().contains("keinen kanonischen Dateinamen"));

    let mut conflated_hashes = artifacts.clone();
    let artifact = conflated_hashes
        .as_array_mut()
        .expect("Artefakte")
        .iter_mut()
        .find(|artifact| artifact["kind"] == "operational-infrastructure-v2")
        .expect("Operational-v2-Infrastruktur");
    artifact["stateHash"] = artifact["sha256"].clone();
    let error = build_public_infra_release(
        &config,
        &catalog,
        &rights,
        &capture,
        &conflated_hashes,
        &quality,
    )
    .expect_err("gleichgesetzte Hashes muessen scheitern");
    assert!(error.to_string().contains("duerfen nicht gleichgesetzt"));

    let mut wrong_release_id = artifacts.clone();
    let artifact = wrong_release_id
        .as_array_mut()
        .expect("Artefakte")
        .iter_mut()
        .find(|artifact| artifact["kind"] == "operational-infrastructure-v2")
        .expect("Operational-v2-Infrastruktur");
    artifact["infraReleaseId"] = json!("infra-deutschland-foreign");
    let error = build_public_infra_release(
        &config,
        &catalog,
        &rights,
        &capture,
        &wrong_release_id,
        &quality,
    )
    .expect_err("fremde InfraRelease-ID muss scheitern");
    assert!(error.to_string().contains("InfraRelease-ID-Bindung"));

    let mut world_bound = artifacts;
    let artifact = world_bound
        .as_array_mut()
        .expect("Artefakte")
        .iter_mut()
        .find(|artifact| artifact["kind"] == "operational-infrastructure-v2")
        .expect("Operational-v2-Infrastruktur");
    artifact["worldId"] = json!("world-must-not-enter-infra-release");
    let error =
        build_public_infra_release(&config, &catalog, &rights, &capture, &world_bound, &quality)
            .expect_err("weltbezogene Manifestfelder muessen scheitern");
    assert!(error.to_string().contains("weltbezogene Manifestfelder"));

    let mut dynamic_projection = fixture().4;
    dynamic_projection
        .as_array_mut()
        .expect("Artefakte")
        .push(json!({
            "id": "world-train-projection",
            "file": "train-map-projection.sqlite",
            "bytes": 1,
            "sha256": "6".repeat(64),
            "kind": "train-map-projection"
        }));
    let error = build_public_infra_release(
        &config,
        &catalog,
        &rights,
        &capture,
        &dynamic_projection,
        &quality,
    )
    .expect_err("weltbezogene Zugprojektion muss ausserhalb des InfraRelease bleiben");
    assert!(error.to_string().contains("Zugprojektionen"));
}

fn write(path: &Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("Testverzeichnis");
    }
    fs::write(path, bytes).expect("Testdatei");
}

#[test]
fn regionaler_v1_release_wird_aus_explizitem_versioniertem_buildvertrag_gebildet() {
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
        &artifact_root.join("gtfs-region-20260810-v2.json"),
        serde_json::to_string(&serde_json::json!({
            "snapshotHash": "a".repeat(64),
            "snapshot": {
                "regionId": "mitteldeutschland-b",
                "regionVariant": "B",
                "serviceDate": "20260810",
            },
        }))
        .expect("JSON")
        .as_bytes(),
    );
    write(
        &artifact_root.join("operational-network.json"),
        serde_json::to_string(&serde_json::json!({
            "networkHash": "b".repeat(64),
            "network": {
                "regionId": "mitteldeutschland-b",
                "timetableYear": 2026,
                "validFrom": "2025-12-14",
                "validUntil": "2026-12-12",
                "metrics": {
                    "qualityBSegmentCount": 2,
                    "qualityCSegmentCount": 0,
                    "orderableJourneyChainCount": 3,
                    "conflictResourceCount": 4,
                },
                "segmentQualifications": [{ "qualityClass": "B", "orderable": true }],
            },
        }))
        .expect("JSON")
        .as_bytes(),
    );
    let operational_infrastructure = serde_json::json!({
        "id": "infra-mitteldeutschland-b-2026.2",
        "directedEdges": { "edge-1": 1_000 },
        "edgeGeometries": {
            "edge-1": [
                { "edgeOffsetMm": 0, "latitudeE7": 510_000_000, "longitudeE7": 120_000_000, "bearingMilliDegrees": 90_000 },
                { "edgeOffsetMm": 1_000, "latitudeE7": 510_000_000, "longitudeE7": 120_001_000, "bearingMilliDegrees": null }
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
    });
    write(
        &artifact_root.join("operational-infrastructure-v2.json"),
        serde_json::to_string_pretty(&operational_infrastructure)
            .expect("Operational-v2-Infrastruktur")
            .as_bytes(),
    );
    let native_validation = Command::new(env!("CARGO_BIN_EXE_zugfolge-infra-release"))
        .arg("validate-operational-infrastructure-v2")
        .arg(artifact_root.join("operational-infrastructure-v2.json"))
        .arg("infra-mitteldeutschland-b-2026.2")
        .output()
        .expect("native Operational-v2-Validierung starten");
    assert!(
        native_validation.status.success(),
        "native Operational-v2-Validierung muss gelingen: {}",
        String::from_utf8_lossy(&native_validation.stderr)
    );
    let native_receipt: Value = serde_json::from_slice(&native_validation.stdout)
        .expect("nativer Operational-v2-Bindungsbeleg");
    assert_eq!(native_receipt["schema"], "operational-infrastructure-v2");
    assert!(
        native_receipt["stateHash"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64)
    );
    let wrong_release_validation = Command::new(env!("CARGO_BIN_EXE_zugfolge-infra-release"))
        .arg("validate-operational-infrastructure-v2")
        .arg(artifact_root.join("operational-infrastructure-v2.json"))
        .arg("infra-foreign")
        .status()
        .expect("negative native Operational-v2-Validierung starten");
    assert!(
        !wrong_release_validation.success(),
        "fremde InfraRelease-ID muss scheitern"
    );
    write(
        &artifact_root.join("pbf-release-report.json"),
        serde_json::to_string(&serde_json::json!({
            "quality": { "classes": { "A": 0, "B": 3, "C": 0 } },
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
        "tools/region-import/regional-release-contract.mjs",
        "tools/region-import/operational-infrastructure-binding.mjs",
        "tools/region-import/materialize-operational-infrastructure-v2.mjs",
        "tools/region-import/release-crypto.mjs",
        "tools/region-import/sign-release.mjs",
        "tools/region-import/verify-release.mjs",
        "crates/zugfolge-infra/examples/pbf_release_report.rs",
    ] {
        write(&root.join(path), path.as_bytes());
    }

    let build_config = json!({
        "schema": "zugfolge-regional-infra-release-build/v2",
        "releaseId": "infra-mitteldeutschland-b-2026.2",
        "regionId": "mitteldeutschland-b",
        "regionVariant": "B",
        "timetableYear": 2026,
        "serviceDate": "20260810",
        "gtfsArtifact": "gtfs-region-20260810-v2.json",
        "operationalInfrastructureArtifact": "operational-infrastructure-v2.json",
        "releaseApproval": {
            "releaseResponsible": "Sebastian Barowski",
            "responsibilityGrantedBy": "user-approval-2026-08-13-evaluation",
            "activationAllowed": true,
            "activationAuthority": "game-system-only",
        },
    });
    let release =
        build_mitteldeutschland_infra_release(&build_config, &root, &source_root, &artifact_root)
            .expect("qualifizierter v1-Release");
    assert_eq!(release["schema"], "zugfolge-infra-release/v1");
    assert_eq!(release["releaseId"], "infra-mitteldeutschland-b-2026.2");
    assert_eq!(release["buildContract"]["serviceDate"], "20260810");
    assert_eq!(
        release["releaseApproval"]["responsibilityGrantedBy"],
        "user-approval-2026-08-13-evaluation"
    );
    assert_eq!(
        release["artifacts"][1]["file"],
        "gtfs-region-20260810-v2.json"
    );
    assert_eq!(release["status"], "qualified");
    assert_eq!(release["sources"].as_array().expect("Quellen").len(), 5);
    assert_eq!(
        release["pipeline"]["scripts"]
            .as_array()
            .expect("Pipelineskripte")
            .len(),
        18,
    );
    let operational_binding = release["artifacts"]
        .as_array()
        .expect("Artefakte")
        .iter()
        .find(|artifact| artifact["kind"] == "operational-infrastructure-v2")
        .expect("statische Operational-v2-Bindung");
    assert_eq!(
        operational_binding["file"],
        "operational-infrastructure-v2.json"
    );
    assert_eq!(
        operational_binding["infraReleaseId"],
        "infra-mitteldeutschland-b-2026.2"
    );
    assert!(
        operational_binding["sha256"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64)
    );
    assert!(
        operational_binding["stateHash"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64)
    );
    assert_eq!(
        operational_binding["stateHash"],
        native_receipt["stateHash"]
    );
    assert_ne!(
        operational_binding["sha256"],
        operational_binding["stateHash"]
    );
    assert_eq!(release["quality"]["classCVisible"], false);

    let config_path = root.join("regional-build.json");
    write(
        &config_path,
        serde_json::to_string(&build_config)
            .expect("Buildvertrag")
            .as_bytes(),
    );
    let output_path = root.join("infra-mitteldeutschland-b-2026.2.unsigned.json");
    let invoke = || {
        Command::new(env!("CARGO_BIN_EXE_zugfolge-infra-release"))
            .current_dir(&root)
            .arg("regional-manifest")
            .arg(&config_path)
            .arg(&source_root)
            .arg(&artifact_root)
            .arg(&output_path)
            .status()
            .expect("Releasecompiler starten")
    };
    assert!(invoke().success(), "erste Ausgabe muss entstehen");
    assert!(
        !invoke().success(),
        "bestehende versionierte Ausgabe darf nicht ersetzt werden"
    );

    let mut unknown_field = build_config.clone();
    unknown_field["output"] = json!("existing-2026.1.json");
    let error =
        build_mitteldeutschland_infra_release(&unknown_field, &root, &source_root, &artifact_root)
            .expect_err("unbekanntes Konfigurationsfeld muss scheitern");
    assert!(error.to_string().contains("unknown field"));

    let operational_infrastructure_path = artifact_root.join("operational-infrastructure-v2.json");
    let mut non_canonical_infrastructure = operational_infrastructure.clone();
    non_canonical_infrastructure["signals"] = json!(["signal-1", "signal-1"]);
    write(
        &operational_infrastructure_path,
        serde_json::to_string(&non_canonical_infrastructure)
            .expect("nichtkanonische Operational-v2-Infrastruktur")
            .as_bytes(),
    );
    let error =
        build_mitteldeutschland_infra_release(&build_config, &root, &source_root, &artifact_root)
            .expect_err("nichtkanonische Set-Darstellung muss scheitern");
    assert!(
        error
            .to_string()
            .contains("kanonischen nativen Darstellung")
    );
    write(
        &operational_infrastructure_path,
        serde_json::to_string_pretty(&operational_infrastructure)
            .expect("Operational-v2-Infrastruktur wiederherstellen")
            .as_bytes(),
    );

    let mut unsafe_integer_infrastructure = operational_infrastructure.clone();
    unsafe_integer_infrastructure["directedEdges"]["edge-1"] = json!(9_007_199_254_740_992_i64);
    write(
        &operational_infrastructure_path,
        serde_json::to_string(&unsafe_integer_infrastructure)
            .expect("Operational-v2-Infrastruktur mit unsicherer Ganzzahl")
            .as_bytes(),
    );
    let error =
        build_mitteldeutschland_infra_release(&build_config, &root, &source_root, &artifact_root)
            .expect_err("unsichere kanonische Ganzzahl muss scheitern");
    assert!(error.to_string().contains("sichere kanonische Ganzzahl"));
    write(
        &operational_infrastructure_path,
        serde_json::to_string_pretty(&operational_infrastructure)
            .expect("Operational-v2-Infrastruktur erneut wiederherstellen")
            .as_bytes(),
    );

    let pbf_report_path = artifact_root.join("pbf-release-report.json");
    let mut released_pbf_class_c: Value =
        serde_json::from_slice(&fs::read(&pbf_report_path).expect("PBF-Bericht lesen"))
            .expect("PBF-Bericht-JSON");
    released_pbf_class_c["quality"]["classes"]["B"] = json!(2);
    released_pbf_class_c["quality"]["classes"]["C"] = json!(1);
    write(
        &pbf_report_path,
        serde_json::to_string(&released_pbf_class_c)
            .expect("Klasse-C-PBF-Bericht")
            .as_bytes(),
    );
    let error =
        build_mitteldeutschland_infra_release(&build_config, &root, &source_root, &artifact_root)
            .expect_err("Klasse C im PBF-Bericht darf nicht in den Regionalrelease gelangen");
    assert!(error.to_string().contains("Klasse-C-Abschnitte"));
    released_pbf_class_c["quality"]["classes"]["B"] = json!(3);
    released_pbf_class_c["quality"]["classes"]["C"] = json!(0);
    write(
        &pbf_report_path,
        serde_json::to_string(&released_pbf_class_c)
            .expect("PBF-Bericht wiederherstellen")
            .as_bytes(),
    );

    let operational_network_path = artifact_root.join("operational-network.json");
    let mut released_class_c: Value =
        serde_json::from_slice(&fs::read(&operational_network_path).expect("Betriebsnetz lesen"))
            .expect("Betriebsnetz-JSON");
    released_class_c["network"]["metrics"]["qualityCSegmentCount"] = json!(1);
    released_class_c["network"]["segmentQualifications"] =
        json!([{ "qualityClass": "C", "orderable": false }]);
    write(
        &operational_network_path,
        serde_json::to_string(&released_class_c)
            .expect("Klasse-C-Betriebsnetz")
            .as_bytes(),
    );
    let error =
        build_mitteldeutschland_infra_release(&build_config, &root, &source_root, &artifact_root)
            .expect_err("Klasse C darf nicht in den Regionalrelease gelangen");
    assert!(error.to_string().contains("Klasse-C-Abschnitte"));

    let mut world_bound_infrastructure = operational_infrastructure;
    world_bound_infrastructure["worldId"] = json!("world-must-not-enter-infra-release");
    write(
        &operational_infrastructure_path,
        serde_json::to_string(&world_bound_infrastructure)
            .expect("weltbezogene Operational-v2-Infrastruktur")
            .as_bytes(),
    );
    let error =
        build_mitteldeutschland_infra_release(&build_config, &root, &source_root, &artifact_root)
            .expect_err("weltbezogene Infrastruktur muss scheitern");
    assert!(error.to_string().contains("unknown field `worldId`"));

    let mut wrong_date = build_config;
    wrong_date["serviceDate"] = json!("20260812");
    let error =
        build_mitteldeutschland_infra_release(&wrong_date, &root, &source_root, &artifact_root)
            .expect_err("abweichender Artefaktname muss scheitern");
    assert!(error.to_string().contains("gtfsArtifact muss exakt"));
    fs::remove_dir_all(root).expect("Testverzeichnis aufraeumen");
}
