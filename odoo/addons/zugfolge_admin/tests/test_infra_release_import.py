import base64
import hashlib
import hmac
import json
from pathlib import Path
from unittest.mock import patch

from odoo import Command
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests.common import TransactionCase

from .. import services as service_module
from ..models import infra_release_import as import_module


def _sha256(value):
    return hashlib.sha256(value).hexdigest()


def _compact(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


OPERATIONAL_STATE_HASH = "d" * 64
HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64
OPERATIONAL_BYTES = b'{"id":"infra-deutschland-2026.1","schema":"zugfolge-operational-infrastructure/v2"}\n'
OPERATIONAL_SHA256 = _sha256(OPERATIONAL_BYTES)
MOVEMENT_ROUTE_TEMPLATES_BYTES = b'{"infraReleaseId":"infra-deutschland-2026.1","schema":"movement-route-templates-v2"}\n'
MOVEMENT_ROUTE_TEMPLATES_SHA256 = _sha256(MOVEMENT_ROUTE_TEMPLATES_BYTES)
TRANSFER_DEMANDS_BYTES = b'{"infraReleaseId":"infra-deutschland-2026.1","schema":"zugfolge-timetable-transfer-demands/v2"}\n'
TRANSFER_DEMANDS_SHA256 = _sha256(TRANSFER_DEMANDS_BYTES)
UNSIGNED_REASON = "Kein produktiver privater Signaturschluessel vorhanden; Aktivierung bleibt gesperrt."
FINALIZATION_KEY_ID = "test-key"
FINALIZATION_TEST_KEY_MATERIAL = "unit-test-only-key-material-0001"
PRODUCER_GOLDEN_PATH = Path(__file__).with_name("fixtures") / "delivery_v2_producer_golden.json"


def _set_path(path, value):
    def mutate(root):
        target = root
        for segment in path[:-1]:
            target = target[segment]
        target[path[-1]] = value
    return mutate


def _delete_path(path):
    def mutate(root):
        target = root
        for segment in path[:-1]:
            target = target[segment]
        target.pop(path[-1], None)
    return mutate


def _remove_import_closure_file(suffix):
    def mutate(root):
        runner = root["operationalProvenance"]["executionProof"]["runner"]
        runner["importClosure"] = [
            item for item in runner["importClosure"] if not item["file"].endswith(suffix)
        ]
    return mutate


def _mutate_launcher_closure_proof(field, value):
    def mutate(root):
        closure = root["operationalProvenance"]["executionProof"]["runner"]["importClosure"]
        source = next(item for item in closure if item["file"].endswith("system-launcher.windows.ps1"))
        source[field] = value
    return mutate


def _duplicate_launcher_closure():
    def mutate(root):
        closure = root["operationalProvenance"]["executionProof"]["runner"]["importClosure"]
        index = next(index for index, item in enumerate(closure) if item["file"].endswith("system-launcher.windows.ps1"))
        closure.insert(index, dict(closure[index]))
    return mutate


def _unsort_import_closure():
    def mutate(root):
        closure = root["operationalProvenance"]["executionProof"]["runner"]["importClosure"]
        closure[0], closure[1] = closure[1], closure[0]
    return mutate


def _mutate_execution_pins(field, value):
    def mutate(root):
        provenance = root["operationalProvenance"]
        provenance["executionPins"][field] = value
        if field == "sha256":
            provenance["executionProof"]["executionPinsSha256"] = value
    return mutate


def _mutate_validator_proof(field, value):
    def mutate(root):
        validator = root["operationalProvenance"]["executionProof"]["validator"]
        validator["preserved"][field] = value
        if field in ("bytes", "sha256"):
            validator["executed"][field] = value
    return mutate


def _mutate_validator_build_commit(value):
    def mutate(root):
        proof = root["operationalProvenance"]["executionProof"]
        proof["validator"]["buildCommit"] = value
        proof["rebuild"]["sourceCommit"] = value
    return mutate


def _notice(text):
    raw = text.encode("utf-8")
    return {"text": text, "bytes": len(raw), "sha256": _sha256(raw)}


def _asset_tree(files, kind, install_directory):
    prefix = "%s/" % install_directory
    rows = sorted((
        {
            "path": entry["installPath"][len(prefix):],
            "bytes": len(entry["content"]),
            "sha256": _sha256(entry["content"]),
        }
        for entry in files
        if entry["kind"] == kind and entry["installPath"].startswith(prefix)
    ), key=lambda row: row["path"])
    canonical = ("\n".join(
        "%s\0%s\0%s" % (row["path"], row["bytes"], row["sha256"])
        for row in rows
    ) + "\n").encode("utf-8")
    return {
        "installDirectory": install_directory,
        "files": len(rows),
        "bytes": sum(row["bytes"] for row in rows),
        "sha256": _sha256(canonical),
    }


def _asset_notices(files):
    noto_copyright = "Copyright 2022 The Noto Project Authors (https://github.com/notofonts)"
    sprite_copyright = "Copyright (c) 2017 Mapzen"
    return {
        "schema": "zugfolge-map-asset-notices/v2",
        "assets": [
            {
                "id": "noto-glyphs",
                "rightsSourceId": "noto-glyphs",
                "kind": "glyph",
                "license": "OFL-1.1",
                "copyright": noto_copyright,
                "modifications": "PBF-Glyphen werden unveraendert selbst gehostet.",
                "source": {
                    "repository": "https://github.com/protomaps/basemaps-assets",
                    "commit": "a" * 40,
                    "path": "fonts",
                },
                "derivedFrom": None,
                "notice": {
                    "url": "https://raw.githubusercontent.com/protomaps/basemaps-assets/%s/fonts/OFL.txt" % ("a" * 40),
                    **_notice("%s\nSIL OPEN FONT LICENSE Version 1.1\n" % noto_copyright),
                },
                "tree": _asset_tree(files, "glyph", "assets/fonts"),
            },
            {
                "id": "protomaps-sprites",
                "rightsSourceId": "protomaps-sprites",
                "kind": "sprite",
                "license": "MIT",
                "copyright": sprite_copyright,
                "modifications": "Dunkle Sprites werden unveraendert selbst gehostet.",
                "source": {
                    "repository": "https://github.com/protomaps/basemaps-assets",
                    "commit": "a" * 40,
                    "path": "sprites/v4",
                },
                "derivedFrom": {
                    "repository": "https://github.com/tangrams/icons",
                    "commit": "b" * 40,
                    "license": "MIT",
                },
                "notice": {
                    "url": "https://raw.githubusercontent.com/tangrams/icons/%s/LICENSE.md" % ("b" * 40),
                    **_notice("The MIT License (MIT)\n%s\n" % sprite_copyright),
                },
                "tree": _asset_tree(files, "sprite", "assets/sprites"),
            },
        ],
    }


def _operational_quality(release_id="infra-deutschland-2026.1", package_version="2026.1"):
    return {
        "schema": "zugfolge-operational-infrastructure-quality-report/v1",
        "releaseId": release_id,
        "timetableYear": 2026,
        "scopeId": "deutschland-ebo-operational-v2",
        "deterministic": True,
        "separation": {
            "mapEvidencePurpose": "visible-map-quality-evidence",
            "operationalEvidencePurpose": "closed-operational-v2-model",
            "mapClassCReclassified": False,
            "mapClassCBlocksOperationalQualityGate": False,
            "mapObjectsRemoved": False,
        },
        "mapEvidence": {
            "schema": "zugfolge-static-map-quality/v2",
            "mapReleaseId": "karte-deutschland-%s-v2" % package_version,
            "infrastructureCorpusId": release_id,
            "bytes": 4321,
            "sha256": HASH_A,
            "sourceReport": {
                "schema": "zugfolge-final-infrastructure-quality-report/v1",
                "bytes": 9876,
                "sha256": HASH_B,
                "shipped": False,
            },
            "visibleFeatures": 42,
            "visibleLayers": 10,
            "qualityClassFeatureCount": {"A": 12, "B": 28, "C": 2},
            "trackLengthMm": 3000,
            "trackQualityClassLengthMm": {"A": 1000, "B": 1900, "C": 100},
        },
        "operationalModel": {
            "policyId": "synthetic-operational-b/v2",
            "policySha256": HASH_A,
            "closureReceiptSha256": HASH_B,
            "qualityClass": "B",
            "provenance": "derived",
            "realGeometry": True,
            "simulatedOperationalAssignment": True,
            "realInterlockingFactsClaimed": False,
            "syntheticOperationalDetailsShipped": True,
            "objectLevelProvenanceShipped": False,
            "observedAndSyntheticObjectsShareRuntimeCollections": True,
            "movementRouteTemplates": {
                "bytes": len(MOVEMENT_ROUTE_TEMPLATES_BYTES),
                "sha256": MOVEMENT_ROUTE_TEMPLATES_SHA256,
                "stateHash": HASH_B,
                "operationalStateHash": OPERATIONAL_STATE_HASH,
                "timetableTransferSetSha256": HASH_A,
            },
            "timetableRouteEvidence": {
                "reportSchema": "zugfolge-germany-timetable-route-report/v4",
                "policyId": "synthetic-operational-b/v2",
                "derivationRule": "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2",
                "selectionRule": "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
                "reportBytes": 1234,
                "reportSha256": HASH_A,
                "routesBytes": 5678,
                "routesSha256": HASH_B,
                "gtfsSnapshotBytes": 9012,
                "gtfsSnapshotSha256": HASH_C,
                "transferDemandsSchema": "zugfolge-timetable-transfer-demands/v2",
                "transferDemandsBytes": len(TRANSFER_DEMANDS_BYTES),
                "transferDemandsSha256": TRANSFER_DEMANDS_SHA256,
                "snapshotHash": HASH_A,
                "archive": "gtfs-free.zip",
                "archiveSha256": HASH_B,
                "sourceLicense": "CC-BY-4.0",
                "sourceLicenseAsPublished": "CC BY 4.0",
                "selectedSegmentCount": 4,
                "completeRouteCount": 4,
                "routeRecordCount": 4,
                "sameStopTransitionCount": 1,
                "routeSetSha256": HASH_B,
                "dailyCirculationPlanSha256": HASH_C,
                "transferSetSha256": HASH_A,
                "transferDemandsProduced": True,
                "dailyCirculation": {
                    "lotCount": 1,
                    "journeyChainCount": 4,
                    "circulationCount": 2,
                    "rolloverAssignmentCount": 2,
                    "plannedTransitionCount": 4,
                    "turnaroundDemandCount": 3,
                    "transferDemandCount": 1,
                    "transferLotCount": 1,
                },
                "transferRouteCount": 1,
                "transferRouteLegCount": 2,
                "transferRouteLengthMm": 1000,
                "realGeometry": True,
                "simulatedOperationalAssignment": True,
                "realInterlockingFactsClaimed": False,
                "externalOperationalNetworkProvenance": False,
            },
            "operationalArtifact": {
                "bytes": len(OPERATIONAL_BYTES),
                "sha256": OPERATIONAL_SHA256,
                "stateHash": OPERATIONAL_STATE_HASH,
            },
            "coverage": {
                "blockResources": 3,
                "directedEdges": 2,
                "edgeGeometries": 2,
                "interlockingRoutes": 2,
                "platformIntervals": 1,
                "regionBoundaries": 1,
                "routeVersions": 4,
                "rzueLayouts": 1,
                "signals": 2,
                "switches": 1,
            },
        },
        "summary": {
            "operationalQualityClassArtifactCount": {"A": 0, "B": 1, "C": 0},
            "unresolvedRequired": 0,
            "visibleMapClassCFeatureCount": 2,
        },
        "qualityGate": {
            "closureReceiptVerified": True,
            "nativeOperationalValidationVerified": True,
            "operationalClassCZero": True,
            "ordinaryAssumptionsPromoted": False,
            "mapClassCReclassified": False,
            "operationalQualityEligible": True,
            "signatureImplied": False,
            "activationImplied": False,
        },
    }


def _integrated_operational_provenance():
    repin = import_module.GERMANY_2026_5_OPERATIONAL_REPIN
    return {
        "schema": "zugfolge-germany-operational-v2-provenance/v1",
        "producerKind": "integrated-runner-v1",
        "releaseEvidenceEligible": True,
        "productionActivationEligible": True,
        "executionPins": dict(repin["executionPins"]),
        "executionProof": {
            "schema": "zugfolge-germany-operational-v2-execution-proof/v1",
            "executionPinsSha256": repin["executionPins"]["sha256"],
            "runner": {
                "anchorHelper": dict(repin["anchorHelper"]),
                "bundle": dict(repin["bundle"]),
                "entrypoint": dict(repin["entrypoint"]),
                "importClosure": [dict(entry) for entry in repin["importClosure"]],
                "invocation": {
                    "mode": "system-launcher-held-bundle-stdin-v1",
                    "nodeArguments": ["--input-type=module", "-"],
                    "nodeOptions": None,
                },
                "launcher": {
                    "mode": repin["launcher"]["mode"],
                    "sourceBytes": repin["launcher"]["sourceBytes"],
                    "sourceSha256": repin["launcher"]["sourceSha256"],
                },
                "runtime": dict(repin["runtime"]),
            },
            "validator": {
                "buildCommit": repin["validator"]["buildCommit"],
                "preserved": dict(repin["validator"]["preserved"]),
                "executed": {
                    "mode": repin["validator"]["executedMode"],
                    "bytes": repin["validator"]["preserved"]["bytes"],
                    "sha256": repin["validator"]["preserved"]["sha256"],
                },
            },
            "rebuild": {
                "specification": {"file": "tools/region-import/germany/operational-validator-rebuild.annual-2026.5.json", "bytes": 201, "sha256": "7" * 64},
                "evidence": {"file": "var/derived/germany-2026.5/toolchain/rebuild-evidence.json", "bytes": 202, "sha256": "8" * 64, "schema": "zugfolge-operational-validator-rebuild-evidence/v3"},
                "sourceCommit": repin["validator"]["buildCommit"],
            },
            "invocation": {
                "command": "derive-germany-operational-v2",
                "argumentPrefix": [],
                "argumentFiles": [],
                "arguments": ["derive-germany-operational-v2", "spec.json", "source", "candidate.json", "report.json"],
            },
            "stdout": {"bytes": 401, "sha256": "a" * 64, "recordCount": 1, "structuredReceiptSha256": "b" * 64},
            "exit": {"code": 0, "signal": None},
        },
    }


def _integrated_operational_authority():
    source_commit = "c" * 40
    rebuild_bundle = {
        "file": "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json",
        "bytes": 501,
        "sha256": "1" * 64,
    }
    plan = {"file": "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json", "bytes": 502, "sha256": "2" * 64}
    plan_completion = {"file": "%s.zugfolge-complete.json" % plan["file"], "bytes": 503, "sha256": "3" * 64}
    start_evidence = {"file": "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json", "bytes": 504, "sha256": "4" * 64}
    start_completion = {"file": "%s.zugfolge-complete.json" % start_evidence["file"], "bytes": 505, "sha256": "5" * 64}
    outer_receipt = {"file": "var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json", "bytes": 506, "sha256": "6" * 64}
    outer_completion = {"file": "%s.zugfolge-complete.json" % outer_receipt["file"], "bytes": 507, "sha256": "7" * 64}
    predicate = {
        "schema": "zugfolge-operational-v2-execution-authority/v1",
        "releaseId": "infra-deutschland-2026.5",
        "origin": "local-held-runner",
        "verificationScope": "operator-approved-hash-binding-not-source-reexecution-v1",
        "protectedEnvironment": "operational-release-approval",
        "requiredPhases": ["materialize-annual-plan-evidence-v1", "execute-annual-operational-v2-v1", "derive-and-capture-v1"],
        "executionJob": {"mode": "windows-kill-on-job-close-root-exit-bounded-io-v1", "timeoutMilliseconds": 21_600_000},
        "source": {"repository": "larynxberlin-rgb/Zugfolge", "ref": "refs/heads/main", "commit": source_commit},
        "planAuthority": {
            "artifact": {"digest": "sha256:%s" % ("8" * 64), "id": 123, "workflowRunId": 456},
            "bundle": dict(rebuild_bundle),
            "plan": plan,
            "planCompletion": plan_completion,
            "startEvidence": start_evidence,
            "startEvidenceCompletion": start_completion,
        },
        "outerExecutionReceipt": outer_receipt,
        "outerExecutionCompletion": outer_completion,
    }
    return {
        "schema": "zugfolge-map-build-operational-authority/v1",
        "rebuild": {
            "bundle": rebuild_bundle,
            "denySelfHostedRunners": True,
            "predicateType": "https://slsa.dev/provenance/v1",
            "repository": "larynxberlin-rgb/Zugfolge",
            "signerWorkflow": "larynxberlin-rgb/Zugfolge/.github/workflows/operational-validator-rebuild-evidence.yml",
            "sourceDigest": source_commit,
            "sourceRef": "refs/heads/main",
            "subjects": sorted((plan, plan_completion, start_evidence, start_completion), key=lambda proof: proof["file"]),
        },
        "execution": {
            "bundle": {
                "file": "var/derived/germany-2026.5/toolchain/zugfolge-operational-v2-execution-authority.sigstore.json",
                "bytes": 508,
                "sha256": "9" * 64,
            },
            "denySelfHostedRunners": True,
            "predicateType": "https://zugfolge.de/attestations/operational-v2-execution-authority/v1",
            "repository": "larynxberlin-rgb/Zugfolge",
            "signerWorkflow": "larynxberlin-rgb/Zugfolge/.github/workflows/operational-v2-execution-authority.yml",
            "sourceDigest": source_commit,
            "sourceRef": "refs/heads/main",
            "subjects": sorted((outer_receipt, outer_completion), key=lambda proof: proof["file"]),
            "predicate": predicate,
            "predicateSha256": _sha256(_compact(predicate)),
        },
        "trustedRoot": {
            "id": "operational-attestation-trusted-root",
            "kind": "derived-input",
            "version": "infra-deutschland-2026.5",
            "file": "var/derived/germany-2026.5/toolchain/github-attestation-trusted-root.jsonl",
            "bytes": 34_634,
            "sha256": "65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c",
        },
        "verifier": {
            "id": "operational-attestation-verifier",
            "kind": "derived-input",
            "version": "infra-deutschland-2026.5",
            "file": "var/derived/germany-2026.5/toolchain/gh-2.94.0-windows-amd64.exe",
            "bytes": 40_998_712,
            "sha256": "91ed1eff1819a96b34bc2ca3adc01822c807ae1bb883c01ad9fdf335bf242b38",
        },
    }


def _fixture(
    delivery_operational_state_hash=None,
    operational_infra_release_id=None,
    signed=False,
    signature_value_base64=None,
    release_hash_override=None,
    sources_mutator=None,
    quality_mutator=None,
    delivery_mutator=None,
    release_mutator=None,
    package_version="2026.1",
    release_id=None,
):
    release_id = release_id or "infra-deutschland-%s" % package_version
    quality_value = _operational_quality(release_id, package_version)
    if quality_mutator:
        quality_mutator(quality_value)
    quality = _canonical(quality_value)
    base_files = [
        {"id": "basemap", "kind": "basemap", "installPath": "basemap.pmtiles", "content": b"basemap"},
        {"id": "glyph", "kind": "glyph", "installPath": "assets/fonts/font.pbf", "content": b"glyph"},
        {"id": "infrastructure", "kind": "infrastructure", "installPath": "infra.pmtiles", "content": b"infra"},
        {"id": "quality", "kind": "quality-manifest", "installPath": "manifests/quality.json", "content": quality},
        {"id": "read-model", "kind": "read-model", "installPath": "read-model.sqlite", "content": b"read-model"},
        {"id": "sprite-json", "kind": "sprite", "installPath": "assets/sprites/dark.json", "content": b"{}\n"},
        {"id": "sprite-png", "kind": "sprite", "installPath": "assets/sprites/dark.png", "content": bytes((0x89, 0x50, 0x4E, 0x47))},
        {"id": "style", "kind": "style", "installPath": "style.json", "content": b"{}\n"},
        {
            "id": "operational-infrastructure-%s" % package_version,
            "kind": "operational-infrastructure-v2",
            "installPath": "operational-infrastructure-v2.json",
            "content": OPERATIONAL_BYTES,
            "infraReleaseId": operational_infra_release_id or release_id,
            "stateHash": OPERATIONAL_STATE_HASH,
        },
        {
            "id": "operational-movement-routes-%s" % package_version,
            "kind": "movement-route-templates-v2",
            "installPath": "operational-infrastructure-v2.movement-route-templates-v2.json",
            "content": MOVEMENT_ROUTE_TEMPLATES_BYTES,
        },
        {
            "id": "timetable-transfer-demands-%s" % package_version,
            "kind": "timetable-transfer-demands-v2",
            "installPath": "timetable-routes-v2.transfer-demands-v2.json",
            "content": TRANSFER_DEMANDS_BYTES,
        },
    ]
    sources_value = {
        "schema": "zugfolge-map-delivery-sources/v2",
        "releaseId": release_id,
        "sources": [
            {
                "id": "basemap-protomaps",
                "scope": "basemap",
                "approved": True,
                "license": "ODbL-1.0 Produced Work",
                "version": "20260812",
                "attribution": "© OpenStreetMap-Mitwirkende, ODbL 1.0; Basemap-Aufbereitung Protomaps",
                "modifications": "Welt und Deutschlanddetail zusammengefuehrt.",
            },
            {
                "id": "infrastructure-official-infrastructure",
                "scope": "infrastructure",
                "approved": True,
                "license": "CC-BY-4.0",
                "version": "2026-08-12",
                "attribution": "Datenquelle DB InfraGO, CC BY 4.0; durch Zugfolge bearbeitet.",
                "modifications": "Normalisiert und konservativ modelliert.",
            },
        ],
        "assetInventoryPlanSha256": "9" * 64,
        "assetNotices": _asset_notices(base_files),
    }
    if sources_mutator:
        sources_mutator(sources_value)
    sources = _canonical(sources_value)
    artifacts = sorted([{
        "id": entry["id"], "kind": entry["kind"], "installPath": entry["installPath"],
        **({
            "infraReleaseId": entry["infraReleaseId"],
            "stateHash": delivery_operational_state_hash or entry["stateHash"],
        } if entry["kind"] == "operational-infrastructure-v2" else {}),
        "bytes": len(entry["content"]), "sha256": _sha256(entry["content"]),
    } for entry in base_files], key=lambda entry: entry["id"])
    release_payload = {
        "schema": "zugfolge-map-delivery-release/v2",
        "releaseId": release_id,
        "timetableYear": 2026,
        "packageId": "zugfolge-map-deutschland",
        "packageVersion": package_version,
        "scope": {
            "basemap": "world-z0-10-and-germany-z11-15",
            "infrastructure": "germany-ebo-complete-visible-corpus",
            "playableArea": "configured-separately-by-world",
        },
        "artifacts": artifacts,
        "bindings": {
            "packageManifestSchema": "zugfolge-map-package/v2",
            "infraReleaseSchema": "zugfolge-infra-release/v2",
            "mapReleaseSchema": "zugfolge-map-release/v1",
            "infraReleaseHash": HASH_B,
            "mapReleaseHash": HASH_C,
            "qualitySha256": _sha256(quality),
            "sourcesSha256": _sha256(sources),
            **({"operationalProvenanceSha256": _sha256(_compact(_integrated_operational_provenance()) + b"\n")} if package_version == "2026.5" else {}),
            **({"operationalAuthoritySha256": _sha256(_compact(_integrated_operational_authority()))} if package_version == "2026.5" else {}),
        },
        **({"operationalProvenance": _integrated_operational_provenance()} if package_version == "2026.5" else {}),
        **({"operationalAuthority": _integrated_operational_authority()} if package_version == "2026.5" else {}),
        "approvalGates": {
            "rights": {
                "status": "passed",
                "sourceManifestSchema": "zugfolge-map-delivery-sources/v2",
                "sourceCount": 2,
                "assetGroupCount": 2,
                "assetFileCount": 3,
            },
            "quality": {
                "status": "passed",
                "reportSchema": "zugfolge-operational-infrastructure-quality-report/v1",
                "visibleLayers": 10,
                "visibleFeatures": 42,
                "visibleMapClassCFeatureCount": 2,
                "operationalClassCArtifactCount": 0,
                "classCOrderable": False,
            },
            "signature": (
                {"status": "passed", "algorithm": "Ed25519", "keyId": "delivery-2026"}
                if signed else {"status": "missing", "reason": UNSIGNED_REASON}
            ),
        },
    }
    if delivery_mutator:
        delivery_mutator(release_payload)
    if signed:
        release_value = {
            **release_payload,
            "releaseHash": release_hash_override if release_hash_override is not None else _sha256(_canonical(release_payload)),
            "signature": {
                "algorithm": "Ed25519",
                "keyId": "delivery-2026",
                "valueBase64": signature_value_base64 or base64.b64encode(
                    b"not-a-real-ed25519-signature".ljust(64, b"!"),
                ).decode("ascii"),
            },
        }
    else:
        release_value = {**release_payload, "releaseHash": None, "signature": None}
    if release_mutator:
        release_mutator(release_value)
    release = _canonical(release_value)
    files = base_files + [
        {"id": "release", "kind": "release-manifest", "installPath": "manifests/release.json", "content": release},
        {"id": "sources", "kind": "source-manifest", "installPath": "manifests/sources.json", "content": sources},
    ]
    descriptors = []
    parts = []
    for entry in files:
        path = "parts/%s.part-00001" % entry["id"]
        descriptors.append({
            "id": entry["id"], "kind": entry["kind"], "installPath": entry["installPath"],
            **({
                "infraReleaseId": entry["infraReleaseId"],
                "stateHash": entry["stateHash"],
            } if entry["kind"] == "operational-infrastructure-v2" else {}),
            "bytes": len(entry["content"]), "sha256": _sha256(entry["content"]),
            "parts": [{"path": path, "bytes": len(entry["content"]), "sha256": _sha256(entry["content"])}],
        })
        parts.append((path.rsplit("/", 1)[-1], entry["content"]))
    manifest = _canonical({
        "schema": "zugfolge-map-package/v2",
        "packageId": "zugfolge-map-deutschland",
        "version": package_version,
        "format": "directory-parts",
        "partBytes": 100 * 1024 * 1024,
        "artifacts": [entry for entry in descriptors if entry["kind"] in ("basemap", "infrastructure")],
        "auxiliaryFiles": [entry for entry in descriptors if entry["kind"] not in ("basemap", "infrastructure")],
    })
    return manifest, parts


def _producer_golden_fixture():
    value = json.loads(PRODUCER_GOLDEN_PATH.read_text(encoding="utf-8"))
    if value.get("schema") != "zugfolge-delivery-v2-producer-golden/v1":
        raise AssertionError("Unbekanntes gemeinsames Delivery-v2-Producer-Fixture.")
    manifest = base64.b64decode(value["manifestBase64"], validate=True)
    parts = [
        (
            part["path"].rsplit("/", 1)[-1],
            base64.b64decode(part["contentBase64"], validate=True),
        )
        for part in value["parts"]
    ]
    return value, manifest, parts


def _finalization_result(
    record,
    native_status="verified",
    receipt_overrides=None,
    top_overrides=None,
    signature_override=None,
    receipt_mutator=None,
):
    signature_status = "verified" if record.signature_status == "present" else "missing"
    if signature_status == "missing":
        native_status = "missing"
        operational_state_hash = None
        blocker = "delivery-signature-missing"
        eligible = False
    elif native_status == "missing":
        operational_state_hash = None
        blocker = "operational-v2-native-validation-missing"
        eligible = False
    else:
        operational_state_hash = record.expected_operational_state_hash
        blocker = None
        eligible = True
    receipt = {
        "schema": (
            "zugfolge-infra-package-finalization-receipt/v2"
            if record.package_version == "2026.5"
            else "zugfolge-infra-package-finalization-receipt/v1"
        ),
        "signatureAlgorithm": "HMAC-SHA256",
        "keyId": FINALIZATION_KEY_ID,
        "nonce": record.game_finalization_nonce,
        "requestedAt": "2026-08-25T12:00:00.000Z",
        "finalizedAt": "2026-08-25T12:00:01.000Z",
        "importId": record.import_id,
        "packageId": record.package_id,
        "packageVersion": record.package_version,
        "manifestSha256": record.manifest_sha256,
        "deliveryReleaseId": record.delivery_release_id,
        "operationalStateHash": operational_state_hash,
        "signatureStatus": signature_status,
        "nativeOperationalValidationStatus": native_status,
        "activationBlocker": blocker,
        "activationEligible": eligible,
        **({
            "operationalProvenanceStatus": "missing" if signature_status == "missing" else "verified",
            "operationalProvenanceSha256": None if signature_status == "missing" else record.operational_provenance_sha256,
            "operationalExecutionProofSha256": None if signature_status == "missing" else record.operational_execution_proof_sha256,
            "operationalValidatorSha256": None if signature_status == "missing" else record.operational_validator_sha256,
            "operationalAuthorityStatus": "missing" if signature_status == "missing" else "verified",
            "operationalAuthoritySha256": None if signature_status == "missing" else record.operational_authority_sha256,
            "operationalRebuildAttestationSha256": None if signature_status == "missing" else record.operational_rebuild_attestation_sha256,
            "operationalExecutionAuthorityAttestationSha256": None if signature_status == "missing" else record.operational_execution_authority_attestation_sha256,
            "operationalOuterExecutionReceiptSha256": None if signature_status == "missing" else record.operational_outer_execution_receipt_sha256,
            "operationalOuterExecutionCompletionSha256": None if signature_status == "missing" else record.operational_outer_execution_completion_sha256,
            "operationalAuthoritySourceCommit": None if signature_status == "missing" else record.operational_authority_source_commit,
        } if record.package_version == "2026.5" else {}),
        **(receipt_overrides or {}),
    }
    if receipt_mutator:
        receipt_mutator(receipt)
    response_fields = (
        "importId", "packageId", "packageVersion", "manifestSha256", "deliveryReleaseId", "operationalStateHash",
        "signatureStatus", "nativeOperationalValidationStatus", "activationBlocker", "activationEligible",
        *((
            "operationalProvenanceStatus", "operationalProvenanceSha256",
            "operationalExecutionProofSha256", "operationalValidatorSha256",
            "operationalAuthorityStatus", "operationalAuthoritySha256", "operationalRebuildAttestationSha256",
            "operationalExecutionAuthorityAttestationSha256", "operationalOuterExecutionReceiptSha256",
            "operationalOuterExecutionCompletionSha256", "operationalAuthoritySourceCommit",
        ) if record.package_version == "2026.5" else ()),
    )
    result = {
        "accepted": True,
        **{key: receipt[key] for key in response_fields if key in receipt},
        "finalizationReceipt": receipt,
        "finalizationReceiptSignature": signature_override or hmac.new(
            FINALIZATION_TEST_KEY_MATERIAL.encode("utf-8"), _compact(receipt), hashlib.sha256,
        ).hexdigest(),
        **(top_overrides or {}),
    }
    return result


class _Response:
    def __init__(self, value, status_code=200):
        self.status_code = status_code
        self._value = value

    def json(self):
        return self._value


class TestZugfolgeInfraReleaseImport(TransactionCase):
    def setUp(self):
        super().setUp()
        reviewer_group = self.env.ref("zugfolge_admin.group_zugfolge_infra_reviewer")
        internal_group = self.env.ref("base.group_user")
        self.reviewer = self.env["res.users"].with_context(no_reset_password=True).create({
            "name": "Infra Reviewer", "login": "infra-reviewer@example.test",
            "group_ids": [Command.set([internal_group.id, reviewer_group.id])],
        })
        self.outsider = self.env["res.users"].with_context(no_reset_password=True).create({
            "name": "Kein Reviewer", "login": "no-reviewer@example.test",
            "group_ids": [Command.set([internal_group.id])],
        })
        manifest, parts = _fixture()
        reviewer_attachments = self.env["ir.attachment"].with_user(self.reviewer)
        self.manifest_attachment = reviewer_attachments.create({"name": "manifest.json", "type": "binary", "raw": manifest, "mimetype": "application/json"})
        self.part_attachments = reviewer_attachments
        for name, content in parts:
            self.part_attachments |= reviewer_attachments.create({"name": name, "type": "binary", "raw": content, "mimetype": "application/octet-stream"})

    def _create_import(self):
        return self.env["zugfolge.infra.release.import"].with_user(self.reviewer).create({
            "manifest_attachment_ids": [Command.set(self.manifest_attachment.ids)],
            "part_attachment_ids": [Command.set(self.part_attachments.ids)],
        })

    def _create_fixture_import(self, **fixture_options):
        manifest, parts = _fixture(**fixture_options)
        return self._create_package_import(manifest, parts)

    def _create_package_import(self, manifest, parts):
        attachments = self.env["ir.attachment"].with_user(self.reviewer)
        manifest_attachment = attachments.create({
            "name": "manifest.json", "type": "binary", "raw": manifest, "mimetype": "application/json",
        })
        part_attachments = attachments
        for name, content in parts:
            part_attachments |= attachments.create({
                "name": name, "type": "binary", "raw": content, "mimetype": "application/octet-stream",
            })
        return self.env["zugfolge.infra.release.import"].with_user(self.reviewer).create({
            "manifest_attachment_ids": [Command.set(manifest_attachment.ids)],
            "part_attachment_ids": [Command.set(part_attachments.ids)],
        })

    def _verify(self, record):
        record.action_verify()
        self.assertEqual(record.state, "verifying")
        record._verify_job()
        self.assertEqual(record.state, "verified", record.failure_detail)
        return record

    def _set_finalization_credentials(self):
        parameters = self.env["ir.config_parameter"].sudo()
        parameters.set_param("zugfolge_admin.infra_upload_key_id", FINALIZATION_KEY_ID)
        parameters.set_param("zugfolge_admin.infra_upload_secret", FINALIZATION_TEST_KEY_MATERIAL)

    def test_only_infra_reviewer_can_create_import_and_role_does_not_imply_approver(self):
        self.assertFalse(self.reviewer.has_group("zugfolge_admin.group_zugfolge_approver"))
        with self.assertRaises(AccessError):
            self.env["zugfolge.infra.release.import"].with_user(self.outsider).create({})

    def test_producer_shaped_v2_delivery_persists_exact_audit_and_missing_signature_gate(self):
        record = self._verify(self._create_import())
        self.assertEqual(record.delivery_release_id, "infra-deutschland-2026.1")
        self.assertEqual(record.infra_release_hash, HASH_B)
        self.assertEqual(record.timetable_year, 2026)
        self.assertEqual(record.signature_status, "missing")
        self.assertFalse(record.activation_eligible)
        self.assertEqual(record.expected_operational_state_hash, OPERATIONAL_STATE_HASH)
        self.assertEqual(record.part_count, len(self.part_attachments))
        self.assertRegex(record.manifest_sha256, r"^[a-f0-9]{64}$")
        self.assertRegex(record.verification_inventory_sha256, r"^[a-f0-9]{64}$")
        with self.assertRaises(AccessError):
            record.write({"part_attachment_ids": [Command.clear()]})
        with self.assertRaises(UserError):
            record.action_create_adoption_request()

    def test_exact_js_builder_golden_is_accepted_by_odoo(self):
        golden, manifest, parts = _producer_golden_fixture()
        parsed_manifest = json.loads(manifest)
        transfer_descriptor = next(
            item for item in parsed_manifest["auxiliaryFiles"]
            if item["id"] == "timetable-transfer-demands-2026.1"
        )
        self.assertEqual(transfer_descriptor["kind"], "timetable-transfer-demands-v2")
        self.assertEqual(transfer_descriptor["installPath"], "timetable-routes-v2.transfer-demands-v2.json")
        record = self._verify(self._create_package_import(manifest, parts))
        self.assertEqual(record.delivery_release_id, golden["release"]["releaseId"])
        self.assertEqual(record.infra_release_hash, golden["release"]["bindings"]["infraReleaseHash"])
        self.assertEqual(record.timetable_year, golden["release"]["timetableYear"])
        self.assertEqual(golden["release"]["schema"], "zugfolge-map-delivery-release/v2")
        self.assertEqual(golden["sources"]["schema"], "zugfolge-map-delivery-sources/v2")
        self.assertIsNone(golden["release"]["releaseHash"])
        self.assertIsNone(golden["release"]["signature"])
        self.assertEqual(record.signature_status, "missing")
        self.assertFalse(record.activation_eligible)
        self.assertEqual(record.expected_operational_state_hash, OPERATIONAL_STATE_HASH)
        self.assertEqual(record.part_count, len(parts))
        with self.assertRaises(UserError):
            record.action_create_adoption_request()

    def test_js_builder_golden_mutated_to_transfer_v1_is_rejected_without_fallback(self):
        _golden, manifest, parts = _producer_golden_fixture()
        legacy_manifest = json.loads(manifest)
        transfer_demands = next(
            item for item in legacy_manifest["auxiliaryFiles"]
            if item["kind"] == "timetable-transfer-demands-v2"
        )
        transfer_demands["kind"] = "timetable-transfer-demands-v1"
        transfer_demands["installPath"] = "timetable-routes-v2.transfer-demands-v1.json"

        record = self._create_package_import(_canonical(legacy_manifest), parts)
        record.action_verify()
        record._verify_job()

        self.assertEqual(record.state, "failed")
        self.assertEqual(record.failure_code, "verification_failed")
        self.assertIn("transfer-demands-v2", record.failure_detail)

    def test_rpc_context_cannot_forge_audit_state_or_pass_adoption_gate(self):
        record = self._create_import()
        forged_values = {
            "state": "staged",
            "signature_status": "verified",
            "activation_eligible": True,
        }
        for context in (
            {"zugfolge_infra_import_internal": True},
            {"_zugfolge_infra_import_write_capability": True},
            {"_zugfolge_infra_import_write_capability": "internal"},
        ):
            with self.assertRaises(AccessError):
                record.with_context(**context).write(forged_values)
        record.invalidate_recordset()
        self.assertEqual(record.state, "draft")
        self.assertFalse(record.signature_status)
        self.assertFalse(record.activation_eligible)
        with self.assertRaises(UserError):
            record.action_create_adoption_request()

    def test_total_part_bytes_uses_exact_wide_numeric_storage(self):
        record = self._create_import()
        real_package_bytes = 14_408_875_328
        field = record._fields["total_part_bytes"]
        self.assertEqual(field.column_type[0], "numeric")
        record._internal_write({"total_part_bytes": real_package_bytes})
        record.invalidate_recordset(["total_part_bytes"])
        self.assertEqual(record.total_part_bytes, real_package_bytes)

    def test_stage_is_non_activating_and_rechecks_attachments(self):
        record = self._verify(self._create_import())
        self._set_finalization_credentials()
        record.action_stage()
        result = _finalization_result(record)
        with patch.object(import_module, "stage_infra_package", return_value=result) as staged:
            self.assertTrue(record.staging_requested_at)
            record._stage_job()
        self.assertEqual(record.state, "staged")
        self.assertFalse(record.activation_eligible)
        self.assertEqual(record.activation_blocker, "delivery-signature-missing")
        staged.assert_called_once()

    def test_remote_commit_with_lost_response_retries_same_nonce_and_reconciles(self):
        record = self._verify(self._create_fixture_import(signed=True))
        self._set_finalization_credentials()
        record.action_stage()
        nonce = record.game_finalization_nonce
        result = _finalization_result(record)

        with patch.object(
            import_module,
            "stage_infra_package",
            side_effect=RuntimeError("client timeout after remote commit"),
        ):
            record._stage_job()

        self.assertEqual(record.state, "verified")
        self.assertEqual(record.failure_code, "staging_retryable")
        self.assertFalse(record.activation_eligible)
        self.assertEqual(record.game_finalization_nonce, nonce)

        record.action_stage()
        self.assertEqual(record.game_finalization_nonce, nonce)
        with patch.object(import_module, "stage_infra_package", return_value=result):
            record._stage_job()

        self.assertEqual(record.state, "staged", record.failure_detail)
        self.assertTrue(record.activation_eligible)
        self.assertEqual(record.game_finalization_nonce, nonce)

    def test_stage_rejects_unauthenticated_verified_activation_claim(self):
        record = self._verify(self._create_import())
        self._set_finalization_credentials()
        forged_result = {
            "accepted": True,
            "packageId": record.package_id,
            "packageVersion": record.package_version,
            "manifestSha256": record.manifest_sha256,
            "deliveryReleaseId": record.delivery_release_id,
            "signatureStatus": "verified",
            "activationEligible": True,
        }
        with patch.object(import_module, "stage_infra_package", return_value=forged_result):
            record.action_stage()
            record._stage_job()
        self.assertEqual(record.state, "failed")
        self.assertEqual(record.failure_code, "staging_failed")
        self.assertFalse(record.activation_eligible)
        with self.assertRaises(UserError):
            record.action_create_adoption_request()

    def test_signed_delivery_is_accepted_but_only_marked_present_before_game_verification(self):
        record = self._verify(self._create_fixture_import(signed=True))
        self.assertEqual(record.signature_status, "present")
        self.assertFalse(record.activation_eligible)
        self.assertEqual(record.expected_operational_state_hash, OPERATIONAL_STATE_HASH)
        with self.assertRaises(UserError):
            record.action_create_adoption_request()

    def test_authenticated_game_receipt_promotes_verified_verified_null_true(self):
        record = self._verify(self._create_fixture_import(signed=True))
        self._set_finalization_credentials()
        record.action_stage()
        result = _finalization_result(record)
        with patch.object(import_module, "stage_infra_package", return_value=result):
            record._stage_job()
        self.assertEqual(record.state, "staged", record.failure_detail)
        self.assertEqual(record.signature_status, "verified")
        self.assertEqual(record.native_operational_validation_status, "verified")
        self.assertFalse(record.activation_blocker)
        self.assertTrue(record.activation_eligible)
        self.assertEqual(record.operational_state_hash, OPERATIONAL_STATE_HASH)
        self.assertEqual(record.game_finalization_key_id, FINALIZATION_KEY_ID)
        self.assertRegex(record.game_finalization_receipt_sha256, r"^[a-f0-9]{64}$")
        with self.assertRaisesRegex(ValidationError, "Welt"):
            record.action_create_adoption_request()

    def test_delivery_generation_allows_only_exact_legacy_and_current_versions(self):
        for version in ("2026.1", "2026.3", "2026.4"):
            self.assertEqual(import_module._delivery_v2_generation(version), "legacy-v1")
        self.assertEqual(import_module._delivery_v2_generation("2026.5"), "integrated-provenance-v2")
        for version in ("2026.2", "2026.6", "2027.1", "2026.5-near-miss"):
            with self.assertRaisesRegex(ValidationError, "nicht als Deutschland-Delivery-v2-Version freigegeben"):
                import_module._delivery_v2_generation(version)

    def test_odoo_repin_is_derived_byte_exactly_from_checked_in_2026_5_execution_pins(self):
        repository_path = (
            Path(__file__).resolve().parents[4]
            / "tools" / "region-import" / "germany"
            / "operational-infrastructure-v2-execution-pins.annual-2026.5.json"
        )
        mounted_ci_path = Path(
            "/mnt/zugfolge-contracts/operational-infrastructure-v2-execution-pins.annual-2026.5.json"
        )
        pins_path = next((path for path in (repository_path, mounted_ci_path) if path.is_file()), None)
        if pins_path is None:
            self.skipTest("Execution-Pins-Quellvertrag ist in diesem installierten Odoo-Lauf nicht gemountet.")
        pins_bytes = pins_path.read_bytes()
        pins = json.loads(pins_bytes)
        repin = import_module.GERMANY_2026_5_OPERATIONAL_REPIN
        self.assertEqual(repin["executionPins"], {
            "file": "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
            "bytes": len(pins_bytes),
            "sha256": _sha256(pins_bytes),
            "schema": pins["schema"],
        })
        self.assertEqual(repin["runtime"], pins["runner"]["runtime"])
        self.assertEqual(repin["anchorHelper"], pins["runner"]["anchorHelper"])
        self.assertEqual(repin["bundle"], pins["runner"]["bundle"])
        self.assertEqual(repin["entrypoint"], pins["runner"]["entrypoint"])
        self.assertEqual(repin["validator"], {
            "buildCommit": pins["validator"]["buildCommit"],
            "preserved": {
                "file": pins["validator"]["file"],
                "bytes": pins["validator"]["bytes"],
                "sha256": pins["validator"]["sha256"],
            },
            "executedMode": "windows-exclusive-handle-launch-v1",
        })
        self.assertEqual(repin["launcher"], {
            "file": "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1",
            "mode": pins["runner"]["launcher"]["mode"],
            "sourceBytes": pins["runner"]["launcher"]["sourceBytes"],
            "sourceSha256": pins["runner"]["launcher"]["sourceSha256"],
        })
        self.assertEqual(list(repin["importClosure"]), pins["runner"]["importClosure"])

    def test_current_delivery_and_authenticated_v2_receipt_bind_integrated_operational_provenance(self):
        record = self._verify(self._create_fixture_import(package_version="2026.5", signed=True))
        self.assertEqual(record.delivery_release_id, "infra-deutschland-2026.5")
        self.assertRegex(record.operational_provenance_sha256, r"^[a-f0-9]{64}$")
        self.assertRegex(record.operational_execution_proof_sha256, r"^[a-f0-9]{64}$")
        self.assertEqual(
            record.operational_validator_sha256,
            import_module.GERMANY_2026_5_OPERATIONAL_REPIN["validator"]["preserved"]["sha256"],
        )
        authority = import_module._validate_operational_authority(_integrated_operational_authority())
        self.assertEqual(record.operational_authority_sha256, authority["sha256"])
        self.assertEqual(record.operational_rebuild_attestation_sha256, authority["rebuild_attestation_sha256"])
        self.assertEqual(record.operational_execution_authority_attestation_sha256, authority["execution_authority_attestation_sha256"])
        self.assertEqual(record.operational_outer_execution_receipt_sha256, authority["outer_execution_receipt_sha256"])
        self.assertEqual(record.operational_outer_execution_completion_sha256, authority["outer_execution_completion_sha256"])
        self.assertEqual(record.operational_authority_source_commit, authority["source_commit"])
        self._set_finalization_credentials()
        record.action_stage()
        result = _finalization_result(record)
        self.assertEqual(result["finalizationReceipt"]["schema"], "zugfolge-infra-package-finalization-receipt/v2")
        with patch.object(import_module, "stage_infra_package", return_value=result):
            record._stage_job()
        self.assertEqual(record.state, "staged", record.failure_detail)
        self.assertTrue(record.activation_eligible)
        self.assertEqual(record.signature_status, "verified")
        self.assertEqual(record.operational_authority_status, "verified")

    def test_current_delivery_rejects_missing_tampered_forensic_or_wrong_schema_provenance(self):
        scenarios = (
            ("missing-provenance", _delete_path(("operationalProvenance",))),
            ("missing-provenance-hash", _delete_path(("bindings", "operationalProvenanceSha256"))),
            ("tampered-provenance-hash", _set_path(("bindings", "operationalProvenanceSha256"), "f" * 64)),
            ("forensic-provenance", _set_path(("operationalProvenance", "producerKind"), "forensic-stdin-v1")),
            ("wrong-provenance-schema", _set_path(("operationalProvenance", "schema"), "zugfolge-germany-operational-v2-provenance/v0")),
            ("missing-authority", _delete_path(("operationalAuthority",))),
            ("missing-authority-hash", _delete_path(("bindings", "operationalAuthoritySha256"))),
            ("tampered-authority-hash", _set_path(("bindings", "operationalAuthoritySha256"), "e" * 64)),
            (
                "missing-phase-1-authority-subject",
                _set_path(("operationalAuthority", "rebuild", "subjects"), _integrated_operational_authority()["rebuild"]["subjects"][1:]),
            ),
            (
                "authority-source-commit-drift",
                _set_path(("operationalAuthority", "execution", "sourceDigest"), "d" * 40),
            ),
            (
                "authority-outer-completion-swapped",
                _set_path(
                    ("operationalAuthority", "execution", "predicate", "outerExecutionReceipt"),
                    _integrated_operational_authority()["execution"]["predicate"]["outerExecutionCompletion"],
                ),
            ),
            ("authority-extra-field", _set_path(("operationalAuthority", "execution", "predicate", "unexpected"), True)),
            ("missing-execution-pins", _delete_path(("operationalProvenance", "executionPins"))),
            (
                "wrong-execution-pins-bytes",
                _mutate_execution_pins("bytes", import_module.GERMANY_2026_5_OPERATIONAL_REPIN["executionPins"]["bytes"] + 1),
            ),
            ("wrong-execution-pins-sha", _mutate_execution_pins("sha256", "f" * 64)),
            ("missing-runner-bundle", _delete_path(("operationalProvenance", "executionProof", "runner", "bundle"))),
            (
                "wrong-runner-bundle-sha",
                _set_path(("operationalProvenance", "executionProof", "runner", "bundle", "sha256"), "f" * 64),
            ),
            (
                "wrong-runner-entrypoint-sha",
                _set_path(("operationalProvenance", "executionProof", "runner", "entrypoint", "sha256"), "f" * 64),
            ),
            (
                "missing-windows-anchor-helper",
                _delete_path(("operationalProvenance", "executionProof", "runner", "anchorHelper")),
            ),
            (
                "drifting-windows-anchor-helper",
                _set_path(
                    ("operationalProvenance", "executionProof", "runner", "anchorHelper", "sha256"),
                    "e" * 64,
                ),
            ),
            (
                "windows-anchor-helper-missing-from-import-closure",
                _remove_import_closure_file("operational-windows-anchor-helper.dll"),
            ),
            (
                "legacy-runner-invocation",
                _set_path(("operationalProvenance", "executionProof", "runner", "invocation"), {"execArgv": [], "nodeOptions": None}),
            ),
            (
                "wrong-runner-node-arguments",
                _set_path(("operationalProvenance", "executionProof", "runner", "invocation", "nodeArguments"), ["--input-type=module", "runner.mjs"]),
            ),
            (
                "wrong-runner-invocation-mode",
                _set_path(("operationalProvenance", "executionProof", "runner", "invocation", "mode"), "process-execfile-runner-v1"),
            ),
            (
                "wrong-runner-launcher-mode",
                _set_path(("operationalProvenance", "executionProof", "runner", "launcher", "mode"), "windows-exclusive-handle-launch-v1"),
            ),
            ("missing-runner-launcher-source", _remove_import_closure_file("system-launcher.windows.ps1")),
            (
                "wrong-runner-launcher-source-bytes",
                _set_path(
                    ("operationalProvenance", "executionProof", "runner", "launcher", "sourceBytes"),
                    import_module.GERMANY_2026_5_OPERATIONAL_REPIN["launcher"]["sourceBytes"] + 1,
                ),
            ),
            (
                "wrong-runner-launcher-source-valid-sha",
                _set_path(("operationalProvenance", "executionProof", "runner", "launcher", "sourceSha256"), "f" * 64),
            ),
            (
                "runner-launcher-source-closure-byte-mismatch",
                _mutate_launcher_closure_proof(
                    "bytes", import_module.GERMANY_2026_5_OPERATIONAL_REPIN["launcher"]["sourceBytes"] + 1,
                ),
            ),
            ("duplicate-runner-launcher-source", _duplicate_launcher_closure()),
            ("unsorted-runner-import-closure", _unsort_import_closure()),
            (
                "wrong-runner-launcher-source",
                _set_path(("operationalProvenance", "executionProof", "runner", "launcher", "sourceSha256"), "not-a-sha256"),
            ),
            (
                "wrong-runner-runtime-id",
                _set_path(("operationalProvenance", "executionProof", "runner", "runtime", "id"), "nodejs-path-only-v1"),
            ),
            (
                "wrong-runner-platform-coupling",
                _set_path(("operationalProvenance", "executionProof", "runner", "runtime", "platform"), "linux"),
            ),
            (
                "wrong-runner-runtime-bytes",
                _set_path(
                    ("operationalProvenance", "executionProof", "runner", "runtime", "bytes"),
                    import_module.GERMANY_2026_5_OPERATIONAL_REPIN["runtime"]["bytes"] + 1,
                ),
            ),
            (
                "wrong-runner-runtime-sha",
                _set_path(("operationalProvenance", "executionProof", "runner", "runtime", "sha256"), "f" * 64),
            ),
            ("wrong-validator-build-commit", _mutate_validator_build_commit("f" * 40)),
            (
                "wrong-preserved-validator-bytes",
                _mutate_validator_proof(
                    "bytes", import_module.GERMANY_2026_5_OPERATIONAL_REPIN["validator"]["preserved"]["bytes"] + 1,
                ),
            ),
            ("wrong-preserved-validator-sha", _mutate_validator_proof("sha256", "f" * 64)),
            ("boolean-runner-runtime-bytes", _set_path(("operationalProvenance", "executionProof", "runner", "runtime", "bytes"), True)),
            ("boolean-record-count", _set_path(("operationalProvenance", "executionProof", "stdout", "recordCount"), True)),
            ("boolean-exit-code", _set_path(("operationalProvenance", "executionProof", "exit", "code"), False)),
        )
        for label, mutator in scenarios:
            with self.subTest(label=label):
                record = self._create_fixture_import(package_version="2026.5", signed=True, delivery_mutator=mutator)
                record.action_verify()
                record._verify_job()
                self.assertEqual(record.state, "failed")
                self.assertEqual(record.failure_code, "verification_failed")
                self.assertFalse(record.activation_eligible)

    def test_delivery_v2_rejects_unknown_future_and_mismatched_version_release_pairs(self):
        for version in ("2026.2", "2026.6", "2027.1", "2026.5-near-miss"):
            with self.subTest(version=version):
                record = self._create_fixture_import(package_version=version, signed=True)
                record.action_verify()
                record._verify_job()
                self.assertEqual(record.state, "failed")
                self.assertEqual(record.failure_code, "verification_failed")
        mismatched = self._create_fixture_import(
            package_version="2026.3",
            signed=True,
            delivery_mutator=_set_path(("releaseId",), "infra-deutschland-2026.4"),
        )
        mismatched.action_verify()
        mismatched._verify_job()
        self.assertEqual(mismatched.state, "failed")
        self.assertEqual(mismatched.failure_code, "verification_failed")

    def test_unsigned_current_v2_receipt_is_hmac_bound_as_explicitly_blocked(self):
        record = self._verify(self._create_fixture_import(package_version="2026.5", signed=False))
        self._set_finalization_credentials()
        record.action_stage()
        result = _finalization_result(record)
        self.assertEqual(result["finalizationReceipt"]["operationalProvenanceStatus"], "missing")
        self.assertIsNone(result["finalizationReceipt"]["operationalProvenanceSha256"])
        self.assertEqual(result["finalizationReceipt"]["operationalAuthorityStatus"], "missing")
        self.assertIsNone(result["finalizationReceipt"]["operationalAuthoritySha256"])
        with patch.object(import_module, "stage_infra_package", return_value=result):
            record._stage_job()
        self.assertEqual(record.state, "staged", record.failure_detail)
        self.assertFalse(record.activation_eligible)
        self.assertEqual(record.activation_blocker, "delivery-signature-missing")

    def test_current_v2_receipt_rejects_missing_tampered_forensic_or_schema_mismatched_provenance(self):
        scenarios = (
            ("missing-provenance-field", None, _delete_path(("operationalExecutionProofSha256",))),
            ("tampered-provenance-hash", {"operationalProvenanceSha256": "f" * 64}, None),
            ("tampered-execution-proof-hash", {"operationalExecutionProofSha256": "e" * 64}, None),
            ("tampered-validator-hash", {"operationalValidatorSha256": "d" * 64}, None),
            ("forensic-provenance-status", {"operationalProvenanceStatus": "forensic"}, None),
            ("missing-authority-field", None, _delete_path(("operationalOuterExecutionCompletionSha256",))),
            ("tampered-authority-hash", {"operationalAuthoritySha256": "c" * 64}, None),
            ("tampered-rebuild-attestation-hash", {"operationalRebuildAttestationSha256": "b" * 64}, None),
            ("tampered-execution-attestation-hash", {"operationalExecutionAuthorityAttestationSha256": "a" * 64}, None),
            ("tampered-outer-receipt-hash", {"operationalOuterExecutionReceiptSha256": "9" * 64}, None),
            ("tampered-outer-completion-hash", {"operationalOuterExecutionCompletionSha256": "8" * 64}, None),
            ("tampered-authority-source-commit", {"operationalAuthoritySourceCommit": "f" * 40}, None),
            ("forensic-authority-status", {"operationalAuthorityStatus": "forensic"}, None),
            ("legacy-schema", {"schema": "zugfolge-infra-package-finalization-receipt/v1"}, None),
        )
        for label, overrides, mutator in scenarios:
            with self.subTest(label=label):
                record = self._verify(self._create_fixture_import(package_version="2026.5", signed=True))
                self._set_finalization_credentials()
                record.action_stage()
                result = _finalization_result(record, receipt_overrides=overrides, receipt_mutator=mutator)
                with patch.object(import_module, "stage_infra_package", return_value=result):
                    record._stage_job()
                self.assertEqual(record.state, "failed")
                self.assertEqual(record.failure_code, "staging_failed")
                self.assertFalse(record.activation_eligible)

    def test_adoption_request_keeps_package_and_infra_hashes_separate_and_requires_explicit_utc_period(self):
        projection = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).create({
            "world_id": "11111111-1111-4111-8111-111111111111",
            "world_name": "Infra-Zielwelt",
            "projection_revision": "infra-adoption-1",
            "observed_at": "2026-01-01 00:00:00",
            "freshness": "delayed",
            "profile_kind": "public",
            "payload_hash": "e" * 64,
        })
        record = self._create_fixture_import(signed=True)
        record.write({"world_projection_id": projection.id})
        self._verify(record)
        self._set_finalization_credentials()
        record.action_stage()
        with patch.object(import_module, "stage_infra_package", return_value=_finalization_result(record)):
            record._stage_job()

        action = record.action_create_adoption_request()
        request = self.env["zugfolge.admin.request"].browse(action["res_id"])
        self.assertEqual(request.release_hash, record.infra_release_hash)
        self.assertNotEqual(request.release_hash, record.manifest_sha256)
        self.assertFalse(request.requested_period_start)
        self.assertEqual(request.effect_preview, {
            "kind": "infra-release",
            "importId": record.import_id,
            "deliveryReleaseId": record.delivery_release_id,
            "manifestSha256": record.manifest_sha256,
            "infraReleaseHash": record.infra_release_hash,
        })
        with self.assertRaisesRegex(ValidationError, "SHA-256"):
            with self.env.cr.savepoint():
                request.write({"release_hash": "g" * 64})
        with self.assertRaisesRegex(ValidationError, "exakten naechsten Periodenwechsel"):
            request.action_submit()

        request.write({"requested_period_start": "2026-01-22 00:00:00"})
        self.assertEqual(request._game_command_payload()["requestedPeriodStart"], "2026-01-22T00:00:00Z")
        request.action_submit()
        self.assertEqual(request.state, "submitted")

    def test_authenticated_receipt_rejects_false_hmac_replay_wrong_binding_and_tampered_state(self):
        scenarios = (
            ("false-hmac", {}, "0" * 64),
            ("replay", {"nonce": "e" * 64}, None),
            ("wrong-import-binding", {"importId": "anderer-import"}, None),
            ("wrong-manifest-binding", {"manifestSha256": "e" * 64}, None),
            ("wrong-release-binding", {"deliveryReleaseId": "infra-deutschland-fremd"}, None),
            ("tampered-state", {"operationalStateHash": "e" * 64}, None),
        )
        for label, receipt_overrides, signature_override in scenarios:
            with self.subTest(label=label):
                record = self._verify(self._create_fixture_import(signed=True))
                self._set_finalization_credentials()
                record.action_stage()
                result = _finalization_result(
                    record,
                    receipt_overrides=receipt_overrides,
                    signature_override=signature_override,
                )
                with patch.object(import_module, "stage_infra_package", return_value=result):
                    record._stage_job()
                self.assertEqual(record.state, "failed")
                self.assertEqual(record.failure_code, "staging_failed")
                self.assertFalse(record.activation_eligible)

    def test_missing_native_receipt_stays_staged_but_fail_closed(self):
        record = self._verify(self._create_fixture_import(signed=True))
        self._set_finalization_credentials()
        record.action_stage()
        result = _finalization_result(record, native_status="missing")
        with patch.object(import_module, "stage_infra_package", return_value=result):
            record._stage_job()
        self.assertEqual(record.state, "staged", record.failure_detail)
        self.assertEqual(record.signature_status, "verified")
        self.assertEqual(record.native_operational_validation_status, "missing")
        self.assertEqual(record.activation_blocker, "operational-v2-native-validation-missing")
        self.assertFalse(record.activation_eligible)
        self.assertFalse(record.operational_state_hash)
        with self.assertRaises(UserError):
            record.action_create_adoption_request()

    def test_malformed_signed_delivery_contract_fails_before_upload(self):
        for fixture_options in (
            {"signed": True, "signature_value_base64": "not-base64"},
            {"signed": True, "release_hash_override": "e" * 64},
            {"signed": True, "release_mutator": _set_path(("approvalGates", "signature", "unexpected"), True)},
            {"signed": True, "release_mutator": _set_path(("signature", "unexpected"), True)},
        ):
            with self.subTest(fixture_options=fixture_options):
                record = self._create_fixture_import(**fixture_options)
                record.action_verify()
                record._verify_job()
                self.assertEqual(record.state, "failed")
                self.assertEqual(record.failure_code, "verification_failed")
                self.assertFalse(record.activation_eligible)

    def test_unknown_or_inconsistent_signed_delivery_v2_metadata_fails_closed(self):
        scenarios = (
            (
                "legacy-delivery-schema",
                {"signed": True, "delivery_mutator": _set_path(("schema",), "zugfolge-map-delivery-release/v1")},
            ),
            (
                "unknown-signature-gate-status",
                {"signed": True, "delivery_mutator": _set_path(("approvalGates", "signature", "status"), "pending")},
            ),
            (
                "unsupported-signature-algorithm",
                {
                    "signed": True,
                    "delivery_mutator": _set_path(("approvalGates", "signature", "algorithm"), "RSA-PSS"),
                    "release_mutator": _set_path(("signature", "algorithm"), "RSA-PSS"),
                },
            ),
            (
                "signature-key-mismatch",
                {"signed": True, "release_mutator": _set_path(("signature", "keyId"), "other-delivery-key")},
            ),
            (
                "unsafe-signature-key-id",
                {"signed": True, "release_mutator": _set_path(("signature", "keyId"), "Unknown Key")},
            ),
            (
                "missing-signature-object",
                {"signed": True, "release_mutator": _set_path(("signature",), None)},
            ),
        )
        for label, fixture_options in scenarios:
            with self.subTest(label=label):
                record = self._create_fixture_import(**fixture_options)
                record.action_verify()
                record._verify_job()
                self.assertEqual(record.state, "failed")
                self.assertEqual(record.failure_code, "verification_failed")
                self.assertFalse(record.activation_eligible)

    def test_http_begin_body_is_exactly_the_bytes_bound_by_hmac(self):
        record = self._verify(self._create_import())
        _parsed, manifest, parts = record._staging_payload()
        parameters = self.env["ir.config_parameter"].sudo()
        parameters.set_param("zugfolge_admin.infra_upload_base_url", "http://game.test/imports")
        parameters.set_param("zugfolge_admin.infra_upload_key_id", "test-key")
        parameters.set_param("zugfolge_admin.infra_upload_secret", "s" * 32)
        expected_begin = json.dumps({
            "manifestBytes": manifest["bytes"],
            "manifestSha256": manifest["sha256"],
        }, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        post_calls = []

        def post(_url, **kwargs):
            post_calls.append(kwargs)
            if len(post_calls) == 1:
                self.assertEqual(kwargs.get("data"), expected_begin)
                self.assertNotIn("json", kwargs)
                self.assertEqual(kwargs["headers"]["X-Zugfolge-Infra-Content-Sha256"], _sha256(expected_begin))
                return _Response({"accepted": True, "status": "created"})
            finalize_body = json.loads(kwargs.get("data"))
            self.assertEqual(finalize_body["schema"], "zugfolge-infra-package-finalization-challenge/v1")
            self.assertEqual(finalize_body["nonce"], "f" * 64)
            self.assertRegex(finalize_body["requestedAt"], r"Z$")
            self.assertEqual(kwargs["headers"]["X-Zugfolge-Infra-Content-Sha256"], _sha256(kwargs["data"]))
            return _Response({
                "accepted": True,
                "packageId": record.package_id,
                "packageVersion": record.package_version,
                "manifestSha256": record.manifest_sha256,
                "deliveryReleaseId": record.delivery_release_id,
                "signatureStatus": "missing",
                "activationEligible": False,
            })

        def put(url, **_kwargs):
            if url.endswith("/manifest"):
                return _Response({"accepted": True, "parts": [{
                    "packagePath": part["package_path"],
                    "bytes": part["bytes"],
                    "sha256": part["sha256"],
                    "partId": part["part_id"],
                } for part in parts]})
            return _Response({"accepted": True})

        with patch.object(service_module.requests, "post", side_effect=post), patch.object(service_module.requests, "put", side_effect=put):
            result = service_module.stage_infra_package(self.env, record.import_id, manifest, parts, "f" * 64)
        self.assertEqual(result["signatureStatus"], "missing")
        self.assertEqual(len(post_calls), 2)

    def test_lost_finalize_response_is_recovered_from_terminal_begin_without_reupload(self):
        record = self._verify(self._create_import())
        _parsed, manifest, parts = record._staging_payload()
        parameters = self.env["ir.config_parameter"].sudo()
        parameters.set_param("zugfolge_admin.infra_upload_base_url", "http://game.test/imports")
        parameters.set_param("zugfolge_admin.infra_upload_key_id", FINALIZATION_KEY_ID)
        parameters.set_param("zugfolge_admin.infra_upload_secret", FINALIZATION_TEST_KEY_MATERIAL)
        record._internal_write({"game_finalization_nonce": "f" * 64})
        terminal = {**_finalization_result(record), "status": "finalized"}

        with patch.object(service_module.requests, "post", return_value=_Response(terminal)) as posted, patch.object(
            service_module.requests, "put",
        ) as uploaded:
            result = service_module.stage_infra_package(self.env, record.import_id, manifest, parts, "f" * 64)

        self.assertEqual(result, terminal)
        posted.assert_called_once()
        uploaded.assert_not_called()

    def test_generic_closed_begin_is_rebound_without_reupload_after_restart(self):
        record = self._verify(self._create_import())
        _parsed, manifest, parts = record._staging_payload()
        parameters = self.env["ir.config_parameter"].sudo()
        parameters.set_param("zugfolge_admin.infra_upload_base_url", "http://game.test/imports")
        parameters.set_param("zugfolge_admin.infra_upload_key_id", FINALIZATION_KEY_ID)
        parameters.set_param("zugfolge_admin.infra_upload_secret", FINALIZATION_TEST_KEY_MATERIAL)
        record._internal_write({"game_finalization_nonce": "f" * 64})
        terminal = _finalization_result(record)
        post_calls = []

        def post(url, **kwargs):
            post_calls.append((url, kwargs))
            if len(post_calls) == 1:
                return _Response({"accepted": True, "status": "closed"})
            self.assertTrue(url.endswith("/finalize"))
            challenge = json.loads(kwargs["data"])
            self.assertEqual(challenge["nonce"], "f" * 64)
            return _Response(terminal)

        with patch.object(service_module.requests, "post", side_effect=post), patch.object(
            service_module.requests, "put",
        ) as uploaded:
            result = service_module.stage_infra_package(self.env, record.import_id, manifest, parts, "f" * 64)

        self.assertEqual(result, terminal)
        self.assertEqual(len(post_calls), 2)
        uploaded.assert_not_called()

    def test_corrupt_part_fails_closed_and_remains_auditable(self):
        record = self._create_import()
        record.action_verify()
        self.part_attachments[0].write({"raw": b"corrupt"})
        record._verify_job()
        self.assertEqual(record.state, "failed")
        self.assertEqual(record.failure_code, "verification_failed")
        self.assertFalse(record.activation_eligible)

    def test_manifest_requires_exact_public_manifests_operational_v2_sidecars_and_no_legacy_projection(self):
        manifest, _parts = _fixture()
        parsed = json.loads(manifest)
        without_operational = {
            **parsed,
            "auxiliaryFiles": [
                item for item in parsed["auxiliaryFiles"]
                if item["kind"] != "operational-infrastructure-v2"
            ],
        }
        with_legacy_projection = {
            **parsed,
            "auxiliaryFiles": parsed["auxiliaryFiles"] + [{
                "id": "train-projection",
                "kind": "train-map-projection",
                "installPath": "train-map-projection.sqlite",
                "bytes": 1,
                "sha256": "a" * 64,
                "parts": [{
                    "path": "parts/train-projection.part-00001",
                    "bytes": 1,
                    "sha256": "a" * 64,
                }],
            }],
        }
        missing_or_duplicate_public_manifest = []
        for kind in ("release-manifest", "source-manifest", "quality-manifest"):
            descriptor = next(item for item in parsed["auxiliaryFiles"] if item["kind"] == kind)
            without_kind = {
                **parsed,
                "auxiliaryFiles": [item for item in parsed["auxiliaryFiles"] if item["kind"] != kind],
            }
            duplicate = json.loads(json.dumps(descriptor))
            duplicate["id"] = "%s-duplicate" % descriptor["id"]
            duplicate["installPath"] = "duplicate/%s.json" % kind
            duplicate["parts"][0]["path"] = "parts/%s-duplicate.part-00001" % kind
            with_duplicate = {**parsed, "auxiliaryFiles": parsed["auxiliaryFiles"] + [duplicate]}
            missing_or_duplicate_public_manifest.extend((without_kind, with_duplicate))
        invalid_sidecars = []
        for kind in ("movement-route-templates-v2", "timetable-transfer-demands-v2"):
            descriptor = next(item for item in parsed["auxiliaryFiles"] if item["kind"] == kind)
            without_kind = {
                **parsed,
                "auxiliaryFiles": [item for item in parsed["auxiliaryFiles"] if item["kind"] != kind],
            }
            duplicate = json.loads(json.dumps(descriptor))
            duplicate["id"] = "%s-duplicate" % descriptor["id"]
            duplicate["installPath"] = "duplicate/%s.json" % kind
            duplicate["parts"][0]["path"] = "parts/%s-duplicate.part-00001" % kind
            misplaced = json.loads(json.dumps(parsed))
            next(item for item in misplaced["auxiliaryFiles"] if item["kind"] == kind)["installPath"] = "wrong/%s.json" % kind
            invalid_sidecars.extend((without_kind, {**parsed, "auxiliaryFiles": parsed["auxiliaryFiles"] + [duplicate]}, misplaced))
        legacy_transfer_demands = json.loads(json.dumps(parsed))
        legacy_transfer_descriptor = next(
            item for item in legacy_transfer_demands["auxiliaryFiles"]
            if item["kind"] == "timetable-transfer-demands-v2"
        )
        legacy_transfer_descriptor["kind"] = "timetable-transfer-demands-v1"
        legacy_transfer_descriptor["installPath"] = "timetable-routes-v2.transfer-demands-v1.json"
        for candidate in (
            without_operational,
            with_legacy_projection,
            *missing_or_duplicate_public_manifest,
            *invalid_sidecars,
            legacy_transfer_demands,
        ):
            with self.assertRaises(ValidationError):
                import_module._parse_package_manifest(_canonical(candidate))

    def test_delivery_operational_state_binding_must_equal_package_binding(self):
        record = self._create_fixture_import(delivery_operational_state_hash="e" * 64)
        record.action_verify()
        record._verify_job()
        self.assertEqual(record.state, "failed")
        self.assertEqual(record.failure_code, "verification_failed")
        self.assertIn("bindet nicht exakt alle auszuliefernden Artefakte", record.failure_detail)

    def test_operational_infrastructure_must_bind_delivery_release_id(self):
        record = self._create_fixture_import(operational_infra_release_id="infra-deutschland-fremd")
        record.action_verify()
        record._verify_job()
        self.assertEqual(record.state, "failed")
        self.assertEqual(record.failure_code, "verification_failed")
        self.assertIn("nicht an die Delivery-InfraRelease-ID gebunden", record.failure_detail)

    def test_unsigned_delivery_requires_reason_and_explicit_null_release_hash(self):
        scenarios = (
            ("missing-reason", {"delivery_mutator": _delete_path(("approvalGates", "signature", "reason"))}),
            ("empty-reason", {"delivery_mutator": _set_path(("approvalGates", "signature", "reason"), "")}),
            ("unexpected-signature-gate-field", {"delivery_mutator": _set_path(("approvalGates", "signature", "unexpected"), True)}),
            ("missing-release-hash", {"release_mutator": _delete_path(("releaseHash",))}),
            ("claimed-release-hash", {"release_mutator": _set_path(("releaseHash",), HASH_A)}),
        )
        for label, fixture_options in scenarios:
            with self.subTest(label=label):
                record = self._create_fixture_import(**fixture_options)
                record.action_verify()
                record._verify_job()
                self.assertEqual(record.state, "failed")
                self.assertEqual(record.failure_code, "verification_failed")
                self.assertFalse(record.activation_eligible)

    def test_sources_v2_exact_fields_and_asset_notices_fail_closed(self):
        scenarios = (
            ("legacy-schema", _set_path(("schema",), "zugfolge-map-delivery-sources/v1")),
            ("unexpected-top-level-field", _set_path(("legacy",), True)),
            ("missing-asset-notices", _delete_path(("assetNotices",))),
            ("unexpected-source-field", _set_path(("sources", 0, "legacy"), True)),
            ("tampered-asset-tree", _set_path(("assetNotices", "assets", 0, "tree", "sha256"), HASH_A)),
        )
        for label, mutator in scenarios:
            with self.subTest(label=label):
                record = self._create_fixture_import(sources_mutator=mutator)
                record.action_verify()
                record._verify_job()
                self.assertEqual(record.state, "failed")
                self.assertEqual(record.failure_code, "verification_failed")

    def test_operational_quality_v1_exact_fields_and_separation_fail_closed(self):
        scenarios = (
            ("legacy-schema", _set_path(("schema",), "zugfolge-final-infrastructure-quality-report/v1")),
            ("unexpected-top-level-field", _set_path(("policy",), {})),
            ("missing-quality-gate-field", _delete_path(("qualityGate", "activationImplied"))),
            ("operational-class-c", _set_path(("summary", "operationalQualityClassArtifactCount"), {"A": 0, "B": 0, "C": 1})),
            ("map-class-c-reclassified", _set_path(("separation", "mapClassCReclassified"), True)),
            ("wrong-operational-artifact", _set_path(("operationalModel", "operationalArtifact", "sha256"), HASH_A)),
            ("wrong-movement-artifact", _set_path(("operationalModel", "movementRouteTemplates", "sha256"), HASH_A)),
            ("wrong-movement-operational-state", _set_path(("operationalModel", "movementRouteTemplates", "operationalStateHash"), HASH_A)),
            ("wrong-movement-transfer-set", _set_path(("operationalModel", "movementRouteTemplates", "timetableTransferSetSha256"), HASH_B)),
            ("wrong-transfer-artifact", _set_path(("operationalModel", "timetableRouteEvidence", "transferDemandsSha256"), HASH_A)),
            ("legacy-route-report-v3", _set_path(("operationalModel", "timetableRouteEvidence", "reportSchema"), "zugfolge-germany-timetable-route-report/v3")),
            ("legacy-transfer-schema-v1", _set_path(("operationalModel", "timetableRouteEvidence", "transferDemandsSchema"), "zugfolge-timetable-transfer-demands/v1")),
            ("missing-planned-transition-count", _delete_path(("operationalModel", "timetableRouteEvidence", "dailyCirculation", "plannedTransitionCount"))),
            ("rollover-circulation-mismatch", _set_path(("operationalModel", "timetableRouteEvidence", "dailyCirculation", "rolloverAssignmentCount"), 1)),
            ("transition-partition-mismatch", _set_path(("operationalModel", "timetableRouteEvidence", "dailyCirculation", "turnaroundDemandCount"), 2)),
            ("planned-journey-chain-mismatch", _set_path(("operationalModel", "timetableRouteEvidence", "dailyCirculation", "journeyChainCount"), 5)),
        )
        for label, mutator in scenarios:
            with self.subTest(label=label):
                record = self._create_fixture_import(quality_mutator=mutator)
                record.action_verify()
                record._verify_job()
                self.assertEqual(record.state, "failed")
                self.assertEqual(record.failure_code, "verification_failed")
                self.assertIn("Operational-v2", record.failure_detail)

    def test_delivery_bindings_and_approval_gates_are_exact_and_byte_bound(self):
        scenarios = (
            ("unexpected-delivery-field", _set_path(("legacy",), True)),
            ("missing-delivery-scope", _delete_path(("scope",))),
            ("missing-map-release-hash", _delete_path(("bindings", "mapReleaseHash"))),
            ("unexpected-binding", _set_path(("bindings", "legacyHash"), HASH_A)),
            ("wrong-source-count", _set_path(("approvalGates", "rights", "sourceCount"), 1)),
            ("wrong-asset-count", _set_path(("approvalGates", "rights", "assetFileCount"), 2)),
            ("wrong-map-class-c", _set_path(("approvalGates", "quality", "visibleMapClassCFeatureCount"), 0)),
            ("unexpected-gate-field", _set_path(("approvalGates", "quality", "legacy"), False)),
        )
        for label, mutator in scenarios:
            with self.subTest(label=label):
                record = self._create_fixture_import(delivery_mutator=mutator)
                record.action_verify()
                record._verify_job()
                self.assertEqual(record.state, "failed")
                self.assertEqual(record.failure_code, "verification_failed")
