import base64
import binascii
import hashlib
import json
import os
import re
import secrets
import uuid

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from ..services import stage_infra_package, verify_infra_finalization_receipt


SHA256 = re.compile(r"^[a-f0-9]{64}$")
FINALIZATION_NONCE = re.compile(r"^[a-f0-9]{64}$")
SAFE_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
PART_BYTES = 100 * 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
PACKAGE_SCHEMA = "zugfolge-map-package/v2"
DELIVERY_SCHEMA = "zugfolge-map-delivery-release/v2"
LEGACY_DELIVERY_V2_VERSIONS = frozenset(("2026.1", "2026.3", "2026.4"))
PROVENANCE_DELIVERY_V2_VERSION = "2026.5"
OPERATIONAL_PROVENANCE_SCHEMA = "zugfolge-germany-operational-v2-provenance/v1"
OPERATIONAL_EXECUTION_PINS_SCHEMA = "zugfolge-germany-operational-v2-execution-pins/v1"
OPERATIONAL_EXECUTION_PROOF_SCHEMA = "zugfolge-germany-operational-v2-execution-proof/v1"
OPERATIONAL_AUTHORITY_SCHEMA = "zugfolge-map-build-operational-authority/v1"
OPERATIONAL_EXECUTION_AUTHORITY_SCHEMA = "zugfolge-operational-v2-execution-authority/v1"
OPERATIONAL_REBUILD_ATTESTATION_PREDICATE = "https://slsa.dev/provenance/v1"
OPERATIONAL_EXECUTION_AUTHORITY_PREDICATE = "https://zugfolge.de/attestations/operational-v2-execution-authority/v1"
OPERATIONAL_REBUILD_ATTESTATION_WORKFLOW = "larynxberlin-rgb/Zugfolge/.github/workflows/operational-validator-rebuild-evidence.yml"
OPERATIONAL_EXECUTION_AUTHORITY_WORKFLOW = "larynxberlin-rgb/Zugfolge/.github/workflows/operational-v2-execution-authority.yml"
OPERATIONAL_REBUILD_ATTESTATION_FILE = "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json"
OPERATIONAL_EXECUTION_AUTHORITY_FILE = "var/derived/germany-2026.5/toolchain/zugfolge-operational-v2-execution-authority.sigstore.json"
OPERATIONAL_OUTER_EXECUTION_RECEIPT_FILE = "var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json"
OPERATIONAL_OUTER_EXECUTION_COMPLETION_FILE = "%s.zugfolge-complete.json" % OPERATIONAL_OUTER_EXECUTION_RECEIPT_FILE
OPERATIONAL_ANNUAL_PLAN_FILE = "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json"
OPERATIONAL_ANNUAL_PLAN_COMPLETION_FILE = "%s.zugfolge-complete.json" % OPERATIONAL_ANNUAL_PLAN_FILE
OPERATIONAL_ANNUAL_START_EVIDENCE_FILE = "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json"
OPERATIONAL_ANNUAL_START_COMPLETION_FILE = "%s.zugfolge-complete.json" % OPERATIONAL_ANNUAL_START_EVIDENCE_FILE
OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE = "tools/region-import/germany/operational-windows-anchor-helper.dll"
OPERATIONAL_RUNNER_BUNDLE_FILE = "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs"
OPERATIONAL_RUNNER_ENTRYPOINT_FILE = "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs"
OPERATIONAL_RUNNER_INVOCATION_MODE = "system-launcher-held-bundle-stdin-v1"
# FINAL-REPIN 2026.5: Diesen einen Vertrag nach dem letzten attestierten
# Windows-Lauf atomar aus der finalen Execution-Pins-Datei aktualisieren.
GERMANY_2026_5_OPERATIONAL_REPIN = {
    "executionPins": {
        "file": "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
        "bytes": 4_841,
        "sha256": "0d18d58df6123b6b6c79b214fa3c8f81e75d0ac75b85397e460a782296e0a477",
        "schema": OPERATIONAL_EXECUTION_PINS_SCHEMA,
    },
    "runtime": {
        "id": "nodejs-24-operational-runner-v1",
        "platform": "win32",
        "bytes": 92_825_416,
        "sha256": "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237",
    },
    "anchorHelper": {
        "file": OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
        "bytes": 55_808,
        "sha256": "f142c855875225c62392bac9203adb69bd639bbf00a373c72267168e72aa912f",
    },
    "bundle": {
        "file": OPERATIONAL_RUNNER_BUNDLE_FILE,
        "bytes": 624_393,
        "sha256": "1a384881f68a671dc7bb75830f576f6ff5857ea3ff20d5920e6727fc7435c1ac",
    },
    "entrypoint": {
        "file": OPERATIONAL_RUNNER_ENTRYPOINT_FILE,
        "bytes": 26_551,
        "sha256": "266a142f311b85f38c3c68bbff355e7b38216110a9fb3419b9e3841b58901a32",
    },
    "validator": {
        "buildCommit": "aba354ec1937452a491087626ec0adea36ef6695",
        "preserved": {
            "file": "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-aba354ec1937452a491087626ec0adea36ef6695-c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4.exe",
            "bytes": 8_382_277,
            "sha256": "c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4",
        },
        "executedMode": "windows-exclusive-handle-launch-v1",
    },
    "launcher": {
        "file": "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1",
        "mode": "windows-system-powershell-held-bundle-v1",
        "sourceBytes": 17_635,
        "sourceSha256": "be26ee6d393a1e769b3d7c27c1a9dacfdac29c4d9ebb477bb26dca25b8a25f2b",
    },
    "importClosure": (
        {"file": "tools/region-import/germany/annual-create-new-artifact.mjs", "bytes": 19_192, "sha256": "742f388c1df04507a9c6c656faf6f5d3c6195209b373b27385464ff3465a7340"},
        {"file": "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs", "bytes": 2_525, "sha256": "4224a650f5673d4c948b4a5d05e84330f975f3f6d0d38a15c353ef960d7930e6"},
        {"file": "tools/region-import/germany/operational-infrastructure-v2-execution-pins.mjs", "bytes": 164_645, "sha256": "e0042de4dc8b956d26cd9242f9d0362b3200ba2ce4646e81208e3ea26edab1df"},
        {"file": "tools/region-import/germany/operational-infrastructure-v2-outer-execution-receipt.mjs", "bytes": 23_497, "sha256": "19c17314d72359a1114e6c567b91a74fb2b631eddb4f33d3d482bec011855447"},
        {"file": "tools/region-import/germany/operational-infrastructure-v2-publication.mjs", "bytes": 140_209, "sha256": "b6f92d0143f9e27b58e49248ee65561122154db0b85ebb689323b1847d7716ac"},
        {"file": "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1", "bytes": 17_635, "sha256": "be26ee6d393a1e769b3d7c27c1a9dacfdac29c4d9ebb477bb26dca25b8a25f2b"},
        {"file": "tools/region-import/germany/operational-infrastructure-v2.mjs", "bytes": 93_203, "sha256": "a308b29bdece8fbe7e18b0bb513393834cd6e99ccca5121fe7f12b344a24ab43"},
        {"file": "tools/region-import/germany/operational-validator-rebuild-evidence.mjs", "bytes": 244_110, "sha256": "6275b92b9140779777a5ca5d6ae32a391a9be74ec8d1bef78c58db5825d81182"},
        {"file": OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE, "bytes": 55_808, "sha256": "f142c855875225c62392bac9203adb69bd639bbf00a373c72267168e72aa912f"},
        {"file": "tools/region-import/germany/publish-operational-infrastructure-v2.mjs", "bytes": 3_180, "sha256": "56ca8cb74f2fb3c6147c128116e26a5147866fa507e1d8113273ef81d3ff7aa4"},
        {"file": "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs", "bytes": 26_551, "sha256": "266a142f311b85f38c3c68bbff355e7b38216110a9fb3419b9e3841b58901a32"},
        {"file": "tools/region-import/materialize-operational-infrastructure-v2.mjs", "bytes": 22_300, "sha256": "fe504130e303c0859bc87bfaa2c370e2d3bd0835b3c25c9a75b0eab02958955e"},
        {"file": "tools/region-import/operational-infrastructure-binding.mjs", "bytes": 9_981, "sha256": "a5efe6f0725b9c4ffa82bf42f71f0aa0bf71b8a282802a822dce95ce6b11b16a"},
        {"file": "tools/tiles/create-new-output.mjs", "bytes": 12_485, "sha256": "8947e01163310e80fc7b38b1163982e49c376424dcde34df1377e7db8c512d45"},
    ),
}
SOURCES_SCHEMA = "zugfolge-map-delivery-sources/v2"
MAP_ASSET_NOTICES_SCHEMA = "zugfolge-map-asset-notices/v2"
QUALITY_SCHEMA = "zugfolge-operational-infrastructure-quality-report/v1"
STATIC_MAP_QUALITY_SCHEMA = "zugfolge-static-map-quality/v2"
STATIC_MAP_SOURCE_QUALITY_SCHEMA = "zugfolge-final-infrastructure-quality-report/v1"
OPERATIONAL_INFRASTRUCTURE_KIND = "operational-infrastructure-v2"
MOVEMENT_ROUTE_TEMPLATES_KIND = "movement-route-templates-v2"
TIMETABLE_TRANSFER_DEMANDS_KIND = "timetable-transfer-demands-v2"
QUALITY_CLASSES = ("A", "B", "C")
OPERATIONAL_COVERAGE_FIELDS = (
    "blockResources", "directedEdges", "edgeGeometries", "interlockingRoutes", "platformIntervals",
    "regionBoundaries", "routeVersions", "rzueLayouts", "signals", "switches",
)
GIT_COMMIT = re.compile(r"^[a-f0-9]{40}$")
GITHUB_REPOSITORY = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
MAX_SAFE_INTEGER = (2 ** 53) - 1
_INTERNAL_WRITE_CONTEXT_KEY = "_zugfolge_infra_import_write_capability"
# Identity is intentionally not serializable over JSON/XML-RPC.  Only private
# server-side model code can place this exact capability into an Environment.
_INTERNAL_WRITE_CAPABILITY = object()


def _canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _record(value, label):
    if not isinstance(value, dict):
        raise ValidationError(_("%s muss ein Objekt sein.") % label)
    return value


def _exact_keys(value, expected, label):
    record = _record(value, label)
    if set(record) != set(expected):
        raise ValidationError(_("%s besitzt unerwartete oder fehlende Felder.") % label)
    return record


def _safe_integer(value, minimum=0):
    return type(value) is int and minimum <= value <= MAX_SAFE_INTEGER


def _delivery_v2_generation(version):
    if version == PROVENANCE_DELIVERY_V2_VERSION:
        return "integrated-provenance-v2"
    if version in LEGACY_DELIVERY_V2_VERSIONS:
        return "legacy-v1"
    raise ValidationError(_("Paketversion ist nicht als Deutschland-Delivery-v2-Version freigegeben."))


def _portable_path(value, label):
    if (
        not isinstance(value, str) or not value or len(value) > 512
        or "\\" in value or "\0" in value or value.startswith("/")
        or re.match(r"^[a-zA-Z]:", value)
        or any(segment in ("", ".", "..") for segment in value.split("/"))
    ):
        raise ValidationError(_("%s ist kein portabler relativer Pfad.") % label)
    return value


def _operational_file_proof(value, label, with_schema=False):
    expected = ("file", "bytes", "sha256", "schema") if with_schema else ("file", "bytes", "sha256")
    proof = _exact_keys(value, expected, label)
    _portable_path(proof["file"], "%s.file" % label)
    if not _safe_integer(proof["bytes"], 1) or not isinstance(proof["sha256"], str) or not SHA256.fullmatch(proof["sha256"]):
        raise ValidationError(_("%s besitzt keinen gueltigen Byte-/SHA-256-Beleg.") % label)
    if with_schema and (not isinstance(proof["schema"], str) or not proof["schema"]):
        raise ValidationError(_("%s.schema fehlt.") % label)
    return proof


def _operational_string_list(value, label):
    if not isinstance(value, list):
        raise ValidationError(_("%s muss eine Liste sein.") % label)
    if any(not isinstance(entry, str) or not entry or len(entry) > 1024 or "\0" in entry for entry in value):
        raise ValidationError(_("%s besitzt einen ungueltigen Eintrag.") % label)
    return value


def _operational_provenance_sha256(value):
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_operational_provenance(value):
    provenance = _exact_keys(value, (
        "schema", "producerKind", "releaseEvidenceEligible", "productionActivationEligible",
        "executionPins", "executionProof",
    ), "Delivery Operational-v2-Provenienz")
    if (
        provenance["schema"] != OPERATIONAL_PROVENANCE_SCHEMA
        or provenance["producerKind"] != "integrated-runner-v1"
        or provenance["releaseEvidenceEligible"] is not True
        or provenance["productionActivationEligible"] is not True
    ):
        raise ValidationError(_("Delivery-v2 akzeptiert nur integrierte, evidence- und aktivierungsgeeignete Operational-v2-Provenienz."))
    pins = _operational_file_proof(provenance["executionPins"], "Delivery Operational-v2-Provenienz.executionPins", with_schema=True)
    if pins != GERMANY_2026_5_OPERATIONAL_REPIN["executionPins"]:
        raise ValidationError(_("Delivery Operational-v2-Provenienz bindet nicht die bytegenaue Execution-Pins-Datei des aktuellen Deutschland-Release."))
    proof = _exact_keys(provenance["executionProof"], (
        "schema", "executionPinsSha256", "runner", "validator", "rebuild", "invocation", "stdout", "exit",
    ), "Delivery Operational-v2-Provenienz.executionProof")
    if proof["schema"] != OPERATIONAL_EXECUTION_PROOF_SCHEMA or proof["executionPinsSha256"] != pins["sha256"]:
        raise ValidationError(_("Delivery Operational-v2-Provenienz bindet Execution-Pins und Execution-Proof verschieden."))
    runner = _exact_keys(proof["runner"], ("anchorHelper", "bundle", "entrypoint", "importClosure", "invocation", "launcher", "runtime"), "Delivery Operational-v2-Provenienz.runner")
    bundle = _operational_file_proof(runner["bundle"], "Delivery Operational-v2-Provenienz.runner.bundle")
    entrypoint = _operational_file_proof(runner["entrypoint"], "Delivery Operational-v2-Provenienz.runner.entrypoint")
    if bundle != GERMANY_2026_5_OPERATIONAL_REPIN["bundle"]:
        raise ValidationError(_("Delivery Operational-v2-Provenienz bindet nicht das bytegenaue gehaltene Runner-Bundle."))
    if entrypoint != GERMANY_2026_5_OPERATIONAL_REPIN["entrypoint"]:
        raise ValidationError(_("Delivery Operational-v2-Provenienz bindet nicht den bytegenauen Runner-Entrypoint."))
    runner_invocation = _exact_keys(runner["invocation"], ("mode", "nodeArguments", "nodeOptions"), "Delivery Operational-v2-Provenienz.runner.invocation")
    runner_node_arguments = _operational_string_list(runner_invocation["nodeArguments"], "Delivery Operational-v2-Provenienz.runner.invocation.nodeArguments")
    if (
        runner_invocation["mode"] != OPERATIONAL_RUNNER_INVOCATION_MODE
        or runner_node_arguments != ["--input-type=module", "-"]
        or runner_invocation["nodeOptions"] is not None
    ):
        raise ValidationError(_("Delivery Operational-v2-Provenienz.runner.invocation startet nicht exakt das gehaltene ESM-stdin-Bundle."))
    runtime = _exact_keys(runner["runtime"], ("id", "platform", "bytes", "sha256"), "Delivery Operational-v2-Provenienz.runner.runtime")
    if (
        not _safe_integer(runtime["bytes"], 1)
        or not isinstance(runtime["sha256"], str) or not SHA256.fullmatch(runtime["sha256"])
        or runtime != GERMANY_2026_5_OPERATIONAL_REPIN["runtime"]
    ):
        raise ValidationError(_("Delivery Operational-v2-Provenienz.runner.runtime bindet nicht die bytegenaue Runtime des aktuellen Deutschland-Release."))
    anchor_helper = _operational_file_proof(runner["anchorHelper"], "Delivery Operational-v2-Provenienz.runner.anchorHelper")
    if runtime["platform"] != "win32" or anchor_helper != GERMANY_2026_5_OPERATIONAL_REPIN["anchorHelper"]:
        raise ValidationError(_("Delivery Operational-v2-Provenienz.runner.anchorHelper bindet nicht die bytegenaue Windows-Anchor-Helper-Assembly."))
    launcher = _exact_keys(runner["launcher"], ("mode", "sourceBytes", "sourceSha256"), "Delivery Operational-v2-Provenienz.runner.launcher")
    expected_launcher = GERMANY_2026_5_OPERATIONAL_REPIN["launcher"]
    if (
        not _safe_integer(launcher["sourceBytes"], 1)
        or not isinstance(launcher["sourceSha256"], str) or not SHA256.fullmatch(launcher["sourceSha256"])
        or launcher["mode"] != expected_launcher["mode"]
        or launcher["sourceBytes"] != expected_launcher["sourceBytes"]
        or launcher["sourceSha256"] != expected_launcher["sourceSha256"]
    ):
        raise ValidationError(_("Delivery Operational-v2-Provenienz.runner.launcher bindet nicht exakt den kanonischen win32-Systemlauncher des aktuellen Deutschland-Release."))
    if not isinstance(runner["importClosure"], list) or not runner["importClosure"]:
        raise ValidationError(_("Delivery Operational-v2-Provenienz besitzt keine Runner-Importclosure."))
    closure = [
        _operational_file_proof(item, "Delivery Operational-v2-Provenienz.runner.importClosure[%s]" % index)
        for index, item in enumerate(runner["importClosure"])
    ]
    closure_paths = [item["file"] for item in closure]
    launcher_sources = [item for item in closure if item["file"] == expected_launcher["file"]]
    anchor_helpers = [item for item in closure if item["file"] == anchor_helper["file"]]
    if (
        closure_paths != sorted(set(closure_paths))
        or not any(item == entrypoint for item in closure)
        or len(launcher_sources) != 1
        or launcher_sources[0]["bytes"] != expected_launcher["sourceBytes"]
        or launcher_sources[0]["sha256"] != expected_launcher["sourceSha256"]
        or anchor_helpers != [anchor_helper]
        or tuple(closure) != GERMANY_2026_5_OPERATIONAL_REPIN["importClosure"]
    ):
        raise ValidationError(_("Delivery Operational-v2-Provenienz bindet nicht die bytegenaue streng sortierte Importclosure des aktuellen Deutschland-Release."))
    validator = _exact_keys(proof["validator"], ("buildCommit", "preserved", "executed"), "Delivery Operational-v2-Provenienz.validator")
    if validator["buildCommit"] != GERMANY_2026_5_OPERATIONAL_REPIN["validator"]["buildCommit"]:
        raise ValidationError(_("Delivery Operational-v2-Provenienz bindet nicht den Build-Commit des aktuellen preserved Validators."))
    preserved = _operational_file_proof(validator["preserved"], "Delivery Operational-v2-Provenienz.validator.preserved")
    if preserved != GERMANY_2026_5_OPERATIONAL_REPIN["validator"]["preserved"]:
        raise ValidationError(_("Delivery Operational-v2-Provenienz bindet nicht den bytegenauen preserved Validator des aktuellen Deutschland-Release."))
    executed = _exact_keys(validator["executed"], ("mode", "bytes", "sha256"), "Delivery Operational-v2-Provenienz.validator.executed")
    if (
        executed["mode"] != GERMANY_2026_5_OPERATIONAL_REPIN["validator"]["executedMode"]
        or not _safe_integer(executed["bytes"], 1) or not isinstance(executed["sha256"], str) or not SHA256.fullmatch(executed["sha256"])
        or executed["bytes"] != preserved["bytes"] or executed["sha256"] != preserved["sha256"]
    ):
        raise ValidationError(_("Delivery Operational-v2-Provenienz bindet nicht dieselben preserved und ausgefuehrten Validator-Bytes."))
    rebuild = _exact_keys(proof["rebuild"], ("specification", "evidence", "sourceCommit"), "Delivery Operational-v2-Provenienz.rebuild")
    _operational_file_proof(rebuild["specification"], "Delivery Operational-v2-Provenienz.rebuild.specification")
    _operational_file_proof(rebuild["evidence"], "Delivery Operational-v2-Provenienz.rebuild.evidence", with_schema=True)
    if rebuild["sourceCommit"] != validator["buildCommit"] or not GIT_COMMIT.fullmatch(str(rebuild["sourceCommit"])):
        raise ValidationError(_("Delivery Operational-v2-Provenienz bindet Rebuild und Validator an verschiedene Commits."))
    invocation = _exact_keys(proof["invocation"], ("command", "argumentPrefix", "argumentFiles", "arguments"), "Delivery Operational-v2-Provenienz.invocation")
    if invocation["command"] != "derive-germany-operational-v2":
        raise ValidationError(_("Delivery Operational-v2-Provenienz bindet einen falschen nativen Befehl."))
    argument_prefix = _operational_string_list(invocation["argumentPrefix"], "Delivery Operational-v2-Provenienz.invocation.argumentPrefix")
    if not isinstance(invocation["argumentFiles"], list):
        raise ValidationError(_("Delivery Operational-v2-Provenienz.invocation.argumentFiles fehlt."))
    if argument_prefix or invocation["argumentFiles"]:
        raise ValidationError(_("Delivery Operational-v2-Provenienz-v1 erlaubt keinen Argumentpraefix und keine Argumentdateien."))
    for index, item in enumerate(invocation["argumentFiles"]):
        _operational_file_proof(item, "Delivery Operational-v2-Provenienz.invocation.argumentFiles[%s]" % index)
    arguments = _operational_string_list(invocation["arguments"], "Delivery Operational-v2-Provenienz.invocation.arguments")
    if len(arguments) != 5 or arguments[0] != invocation["command"]:
        raise ValidationError(_("Delivery Operational-v2-Provenienz.invocation.arguments ist unvollstaendig."))
    for index, argument in enumerate(arguments[1:], start=1):
        _portable_path(argument, "Delivery Operational-v2-Provenienz.invocation.arguments[%s]" % index)
    stdout = _exact_keys(proof["stdout"], ("bytes", "sha256", "recordCount", "structuredReceiptSha256"), "Delivery Operational-v2-Provenienz.stdout")
    if (
        not _safe_integer(stdout["bytes"], 1)
        or not isinstance(stdout["sha256"], str) or not SHA256.fullmatch(stdout["sha256"])
        or not _safe_integer(stdout["recordCount"], 1) or stdout["recordCount"] != 1
        or not isinstance(stdout["structuredReceiptSha256"], str) or not SHA256.fullmatch(stdout["structuredReceiptSha256"])
    ):
        raise ValidationError(_("Delivery Operational-v2-Provenienz.stdout ist kein einzelner strukturierter Validatorbeleg."))
    exit_proof = _exact_keys(proof["exit"], ("code", "signal"), "Delivery Operational-v2-Provenienz.exit")
    if not _safe_integer(exit_proof["code"]) or exit_proof != {"code": 0, "signal": None}:
        raise ValidationError(_("Delivery Operational-v2-Provenienz bindet keinen erfolgreichen signal-freien Validatorabschluss."))
    return {
        "value": provenance,
        "sha256": _operational_provenance_sha256(provenance),
        "execution_proof_sha256": _operational_provenance_sha256(proof),
        "validator_sha256": executed["sha256"],
    }


def _operational_authority_sha256(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_authority_subjects(value, label):
    if not isinstance(value, list) or not value:
        raise ValidationError(_("%s besitzt keine Subjects.") % label)
    subjects = [
        _operational_file_proof(subject, "%s[%s]" % (label, index))
        for index, subject in enumerate(value)
    ]
    files = [subject["file"] for subject in subjects]
    if files != sorted(set(files)):
        raise ValidationError(_("%s ist nicht eindeutig und kanonisch sortiert.") % label)
    return subjects


def _validate_authority_tool_binding(value, expected, label):
    binding = _exact_keys(value, ("bytes", "file", "id", "kind", "sha256", "version"), label)
    _operational_file_proof({key: binding[key] for key in ("file", "bytes", "sha256")}, label)
    if (
        binding["id"] != expected["id"]
        or binding["kind"] != "derived-input"
        or binding["version"] != "infra-deutschland-2026.5"
        or binding["file"] != expected["file"]
        or binding["bytes"] != expected["bytes"]
        or binding["sha256"] != expected["sha256"]
    ):
        raise ValidationError(_("%s driftet vom gepinnten aktuellen Authority-Werkzeugvertrag.") % label)


def _validate_authority_block(value, expected, label):
    block = _exact_keys(value, (
        "bundle", "denySelfHostedRunners", "predicateType", "repository", "signerWorkflow",
        "sourceDigest", "sourceRef", "subjects",
    ), label)
    bundle = _operational_file_proof(block["bundle"], "%s.bundle" % label)
    source_digest = block["sourceDigest"]
    if (
        bundle["file"] != expected["bundleFile"]
        or block["denySelfHostedRunners"] is not True
        or block["predicateType"] != expected["predicateType"]
        or block["repository"] != "larynxberlin-rgb/Zugfolge"
        or block["signerWorkflow"] != expected["signerWorkflow"]
        or block["sourceRef"] != "refs/heads/main"
        or not isinstance(source_digest, str) or not GIT_COMMIT.fullmatch(source_digest)
    ):
        raise ValidationError(_("%s driftet von der geschuetzten GitHub-Sigstore-Authority.") % label)
    return {
        "value": block,
        "bundle": bundle,
        "subjects": _validate_authority_subjects(block["subjects"], "%s.subjects" % label),
        "source_digest": source_digest,
    }


def _validate_operational_authority(value):
    authority = _exact_keys(value, ("execution", "rebuild", "schema", "trustedRoot", "verifier"), "Delivery Operational-v2-Build-Authority")
    if authority["schema"] != OPERATIONAL_AUTHORITY_SCHEMA:
        raise ValidationError(_("Delivery Operational-v2-Build-Authority besitzt ein unbekanntes Schema."))
    _validate_authority_tool_binding(authority["verifier"], {
        "id": "operational-attestation-verifier",
        "file": "var/derived/germany-2026.5/toolchain/gh-2.94.0-windows-amd64.exe",
        "bytes": 40_998_712,
        "sha256": "91ed1eff1819a96b34bc2ca3adc01822c807ae1bb883c01ad9fdf335bf242b38",
    }, "Delivery Operational-v2-Build-Authority.verifier")
    _validate_authority_tool_binding(authority["trustedRoot"], {
        "id": "operational-attestation-trusted-root",
        "file": "var/derived/germany-2026.5/toolchain/github-attestation-trusted-root.jsonl",
        "bytes": 34_634,
        "sha256": "65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c",
    }, "Delivery Operational-v2-Build-Authority.trustedRoot")
    rebuild = _validate_authority_block(authority["rebuild"], {
        "bundleFile": OPERATIONAL_REBUILD_ATTESTATION_FILE,
        "predicateType": OPERATIONAL_REBUILD_ATTESTATION_PREDICATE,
        "signerWorkflow": OPERATIONAL_REBUILD_ATTESTATION_WORKFLOW,
    }, "Delivery Operational-v2-Build-Authority.rebuild")
    execution_value = _exact_keys(authority["execution"], (
        "bundle", "denySelfHostedRunners", "predicate", "predicateSha256", "predicateType", "repository",
        "signerWorkflow", "sourceDigest", "sourceRef", "subjects",
    ), "Delivery Operational-v2-Build-Authority.execution")
    execution = _validate_authority_block({
        key: item for key, item in execution_value.items() if key not in ("predicate", "predicateSha256")
    }, {
        "bundleFile": OPERATIONAL_EXECUTION_AUTHORITY_FILE,
        "predicateType": OPERATIONAL_EXECUTION_AUTHORITY_PREDICATE,
        "signerWorkflow": OPERATIONAL_EXECUTION_AUTHORITY_WORKFLOW,
    }, "Delivery Operational-v2-Build-Authority.execution")
    predicate = _exact_keys(execution_value["predicate"], (
        "executionJob", "origin", "outerExecutionCompletion", "outerExecutionReceipt", "planAuthority",
        "protectedEnvironment", "releaseId", "requiredPhases", "schema", "source", "verificationScope",
    ), "Delivery Operational-v2-Build-Authority.execution.predicate")
    if (
        predicate["schema"] != OPERATIONAL_EXECUTION_AUTHORITY_SCHEMA
        or predicate["releaseId"] != "infra-deutschland-2026.5"
        or predicate["origin"] != "local-held-runner"
        or predicate["verificationScope"] != "operator-approved-hash-binding-not-source-reexecution-v1"
        or predicate["protectedEnvironment"] != "operational-release-approval"
        or predicate["requiredPhases"] != [
            "materialize-annual-plan-evidence-v1",
            "execute-annual-operational-v2-v1",
            "derive-and-capture-v1",
        ]
    ):
        raise ValidationError(_("Delivery Operational-v2-Build-Authority.execution.predicate besitzt keinen exakten geschuetzten Authority-Kontext."))
    source = _exact_keys(predicate["source"], ("commit", "ref", "repository"), "Delivery Operational-v2-Build-Authority.execution.predicate.source")
    if (
        source["repository"] != "larynxberlin-rgb/Zugfolge"
        or source["ref"] != "refs/heads/main"
        or source["commit"] != execution["source_digest"]
        or rebuild["source_digest"] != execution["source_digest"]
    ):
        raise ValidationError(_("Delivery Operational-v2-Build-Authority bindet Rebuild, Execution und Predicate nicht an denselben protected-main-Commit."))
    execution_job = _exact_keys(predicate["executionJob"], ("mode", "timeoutMilliseconds"), "Delivery Operational-v2-Build-Authority.execution.predicate.executionJob")
    if execution_job != {"mode": "windows-kill-on-job-close-root-exit-bounded-io-v1", "timeoutMilliseconds": 21_600_000}:
        raise ValidationError(_("Delivery Operational-v2-Build-Authority.execution.predicate besitzt keinen exakten Prozessbaumvertrag."))
    plan_authority = _exact_keys(predicate["planAuthority"], (
        "artifact", "bundle", "plan", "planCompletion", "startEvidence", "startEvidenceCompletion",
    ), "Delivery Operational-v2-Build-Authority.execution.predicate.planAuthority")
    artifact = _exact_keys(plan_authority["artifact"], ("digest", "id", "workflowRunId"), "Delivery Operational-v2-Build-Authority.execution.predicate.planAuthority.artifact")
    if (
        not _safe_integer(artifact["id"], 1)
        or not _safe_integer(artifact["workflowRunId"], 1)
        or not isinstance(artifact["digest"], str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", artifact["digest"])
    ):
        raise ValidationError(_("Delivery Operational-v2-Build-Authority.execution.predicate besitzt keine eindeutigen GitHub-Artefaktmetadaten."))
    plan_bundle = _operational_file_proof(plan_authority["bundle"], "Delivery Operational-v2-Build-Authority.execution.predicate.planAuthority.bundle")
    if plan_bundle != rebuild["bundle"]:
        raise ValidationError(_("Delivery Operational-v2-Build-Authority.execution.predicate bindet ein anderes Rebuild-Bundle."))
    for key, expected_file in (
        ("plan", OPERATIONAL_ANNUAL_PLAN_FILE),
        ("planCompletion", OPERATIONAL_ANNUAL_PLAN_COMPLETION_FILE),
        ("startEvidence", OPERATIONAL_ANNUAL_START_EVIDENCE_FILE),
        ("startEvidenceCompletion", OPERATIONAL_ANNUAL_START_COMPLETION_FILE),
    ):
        proof = _operational_file_proof(plan_authority[key], "Delivery Operational-v2-Build-Authority.execution.predicate.planAuthority.%s" % key)
        if proof["file"] != expected_file or proof not in rebuild["subjects"]:
            raise ValidationError(_("Delivery Operational-v2-Build-Authority.rebuild bindet Phase-1-Subject %s nicht.") % expected_file)
    outer_receipt = _operational_file_proof(predicate["outerExecutionReceipt"], "Delivery Operational-v2-Build-Authority.execution.predicate.outerExecutionReceipt")
    outer_completion = _operational_file_proof(predicate["outerExecutionCompletion"], "Delivery Operational-v2-Build-Authority.execution.predicate.outerExecutionCompletion")
    if outer_receipt["file"] != OPERATIONAL_OUTER_EXECUTION_RECEIPT_FILE or outer_completion["file"] != OPERATIONAL_OUTER_EXECUTION_COMPLETION_FILE:
        raise ValidationError(_("Delivery Operational-v2-Build-Authority.execution.predicate bindet nicht Outer-Receipt und Completion."))
    if execution["subjects"] != sorted((outer_receipt, outer_completion), key=lambda proof: proof["file"]):
        raise ValidationError(_("Delivery Operational-v2-Build-Authority.execution besitzt nicht exakt Outer-Receipt und Completion als Subjects."))
    if execution_value["predicateSha256"] != _operational_authority_sha256(predicate):
        raise ValidationError(_("Delivery Operational-v2-Build-Authority.execution.predicateSha256 bindet das Predicate nicht kanonisch."))
    return {
        "value": authority,
        "sha256": _operational_authority_sha256(authority),
        "rebuild_attestation_sha256": rebuild["bundle"]["sha256"],
        "execution_authority_attestation_sha256": execution["bundle"]["sha256"],
        "outer_execution_receipt_sha256": outer_receipt["sha256"],
        "outer_execution_completion_sha256": outer_completion["sha256"],
        "source_commit": execution["source_digest"],
    }


def _quality_error(detail):
    raise ValidationError(_("Operational-v2-Qualitaetsvertrag verletzt: %s") % detail)


def _quality_class_counts(value, label):
    if not isinstance(value, dict) or sorted(value) != list(QUALITY_CLASSES):
        _quality_error(_("%s muss exakt A, B und C ausweisen") % label)
    if any(not _safe_integer(value[quality_class]) for quality_class in QUALITY_CLASSES):
        _quality_error(_("%s besitzt keine nichtnegativen Ganzzahlen") % label)
    return value


def _validate_timetable_route_evidence(value):
    evidence = _exact_keys(value, (
        "reportSchema", "policyId", "derivationRule", "selectionRule", "reportBytes", "reportSha256",
        "routesBytes", "routesSha256", "gtfsSnapshotBytes", "gtfsSnapshotSha256", "transferDemandsSchema",
        "transferDemandsBytes", "transferDemandsSha256", "snapshotHash", "archive",
        "archiveSha256", "sourceLicense", "sourceLicenseAsPublished", "selectedSegmentCount", "completeRouteCount",
        "routeRecordCount", "sameStopTransitionCount", "routeSetSha256", "dailyCirculationPlanSha256",
        "transferSetSha256", "transferDemandsProduced", "dailyCirculation", "transferRouteCount",
        "transferRouteLegCount", "transferRouteLengthMm", "realGeometry",
        "simulatedOperationalAssignment", "realInterlockingFactsClaimed", "externalOperationalNetworkProvenance",
    ), "Operational-v2.timetableRouteEvidence")
    if (
        evidence["reportSchema"] != "zugfolge-germany-timetable-route-report/v4"
        or evidence["policyId"] != "synthetic-operational-b/v2"
        or evidence["derivationRule"] != "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2"
        or evidence["selectionRule"] != "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2"
        or evidence["transferDemandsSchema"] != "zugfolge-timetable-transfer-demands/v2"
    ):
        _quality_error(_("timetableRouteEvidence verletzt den freien v4-Fahrweg-/V2-Transfervertrag"))
    byte_fields = ("reportBytes", "routesBytes", "gtfsSnapshotBytes", "transferDemandsBytes")
    hash_fields = (
        "reportSha256", "routesSha256", "gtfsSnapshotSha256", "transferDemandsSha256", "snapshotHash",
        "archiveSha256", "routeSetSha256", "dailyCirculationPlanSha256", "transferSetSha256",
    )
    if (
        not all(_safe_integer(evidence[field], 1) for field in byte_fields)
        or not all(isinstance(evidence[field], str) and SHA256.fullmatch(evidence[field]) for field in hash_fields)
        or evidence["routesSha256"] != evidence["routeSetSha256"]
    ):
        _quality_error(_("timetableRouteEvidence besitzt keine konsistente Datei-/RouteSet-Bindung"))
    if (
        not isinstance(evidence["archive"], str) or not evidence["archive"]
        or evidence["sourceLicense"] != "CC-BY-4.0"
        or evidence["sourceLicenseAsPublished"] != "CC BY 4.0"
    ):
        _quality_error(_("timetableRouteEvidence besitzt keine freie GTFS-Lizenz- und Archivbindung"))
    if (
        not _safe_integer(evidence["selectedSegmentCount"], 1)
        or not _safe_integer(evidence["completeRouteCount"], 1)
        or not _safe_integer(evidence["routeRecordCount"], 1)
        or evidence["selectedSegmentCount"] != evidence["completeRouteCount"]
        or evidence["completeRouteCount"] != evidence["routeRecordCount"]
        or not _safe_integer(evidence["sameStopTransitionCount"])
    ):
        _quality_error(_("timetableRouteEvidence schliesst die ausgewaehlten Segmente nicht vollstaendig 1:1"))
    circulation = _exact_keys(evidence["dailyCirculation"], (
        "lotCount", "journeyChainCount", "circulationCount", "rolloverAssignmentCount",
        "plannedTransitionCount", "turnaroundDemandCount", "transferDemandCount", "transferLotCount",
    ), "Operational-v2.timetableRouteEvidence.dailyCirculation")
    if (
        evidence["transferDemandsProduced"] is not True
        or not all(_safe_integer(circulation[field], 1) for field in (
            "lotCount", "journeyChainCount", "circulationCount", "rolloverAssignmentCount",
            "plannedTransitionCount",
        ))
        or not all(_safe_integer(circulation[field]) for field in (
            "turnaroundDemandCount", "transferDemandCount", "transferLotCount",
        ))
        or circulation["rolloverAssignmentCount"] != circulation["circulationCount"]
        or circulation["turnaroundDemandCount"] + circulation["transferDemandCount"] != circulation["plannedTransitionCount"]
        or circulation["plannedTransitionCount"] != circulation["journeyChainCount"]
        or circulation["transferLotCount"] > circulation["lotCount"]
        or not _safe_integer(evidence["transferRouteCount"], 1)
        or evidence["transferRouteCount"] != circulation["transferDemandCount"]
        or not _safe_integer(evidence["transferRouteLegCount"], 1)
        or not _safe_integer(evidence["transferRouteLengthMm"], 1)
    ):
        _quality_error(_("timetableRouteEvidence besitzt keinen vollstaendigen physischen Daily-Circulation-/Transferbeleg"))
    if (
        evidence["realGeometry"] is not True
        or evidence["simulatedOperationalAssignment"] is not True
        or evidence["realInterlockingFactsClaimed"] is not False
        or evidence["externalOperationalNetworkProvenance"] is not False
    ):
        _quality_error(_("timetableRouteEvidence verletzt die ehrliche Geometrie-/Provenienzgrenze"))
    return evidence


def _validate_operational_quality(
    value,
    release_id,
    delivered_operational_artifact,
    delivered_movement_route_templates,
    delivered_transfer_demands,
):
    quality = _exact_keys(value, (
        "schema", "releaseId", "timetableYear", "scopeId", "deterministic", "separation", "mapEvidence",
        "operationalModel", "summary", "qualityGate",
    ), "Operational-v2-Qualitaetsbericht")
    year_match = re.match(r"^infra-deutschland-(\d{4})(?:\.|$)", release_id)
    if (
        quality["schema"] != QUALITY_SCHEMA
        or quality["releaseId"] != release_id
        or not year_match
        or quality["timetableYear"] != int(year_match.group(1))
        or quality["scopeId"] != "deutschland-ebo-operational-v2"
        or quality["deterministic"] is not True
    ):
        _quality_error(_("Bericht verletzt Schema, Release, Jahr oder Scope"))

    separation = _exact_keys(quality["separation"], (
        "mapEvidencePurpose", "operationalEvidencePurpose", "mapClassCReclassified",
        "mapClassCBlocksOperationalQualityGate", "mapObjectsRemoved",
    ), "Operational-v2.separation")
    if (
        separation["mapEvidencePurpose"] != "visible-map-quality-evidence"
        or separation["operationalEvidencePurpose"] != "closed-operational-v2-model"
        or separation["mapClassCReclassified"] is not False
        or separation["mapClassCBlocksOperationalQualityGate"] is not False
        or separation["mapObjectsRemoved"] is not False
    ):
        _quality_error(_("sichtbare Karten-C werden umdeklariert oder Kartenobjekte entfernt"))

    map_evidence = _exact_keys(quality["mapEvidence"], (
        "schema", "mapReleaseId", "infrastructureCorpusId", "bytes", "sha256", "sourceReport", "visibleFeatures",
        "visibleLayers", "qualityClassFeatureCount", "trackLengthMm", "trackQualityClassLengthMm",
    ), "Operational-v2.mapEvidence")
    map_classes = _quality_class_counts(map_evidence["qualityClassFeatureCount"], "Operational-v2.mapEvidence.qualityClassFeatureCount")
    track_classes = _quality_class_counts(map_evidence["trackQualityClassLengthMm"], "Operational-v2.mapEvidence.trackQualityClassLengthMm")
    source_report = _exact_keys(map_evidence["sourceReport"], ("schema", "bytes", "sha256", "shipped"), "Operational-v2.mapEvidence.sourceReport")
    if (
        map_evidence["schema"] != STATIC_MAP_QUALITY_SCHEMA
        or not isinstance(map_evidence["mapReleaseId"], str) or not map_evidence["mapReleaseId"]
        or map_evidence["infrastructureCorpusId"] != release_id
        or not _safe_integer(map_evidence["bytes"], 1)
        or not isinstance(map_evidence["sha256"], str) or not SHA256.fullmatch(map_evidence["sha256"])
        or map_evidence["visibleLayers"] != 10
        or not _safe_integer(map_evidence["visibleFeatures"], 1)
        or sum(map_classes.values()) != map_evidence["visibleFeatures"]
        or not _safe_integer(map_evidence["trackLengthMm"], 1)
        or sum(track_classes.values()) != map_evidence["trackLengthMm"]
        or source_report["schema"] != STATIC_MAP_SOURCE_QUALITY_SCHEMA
        or not _safe_integer(source_report["bytes"], 1)
        or not isinstance(source_report["sha256"], str) or not SHA256.fullmatch(source_report["sha256"])
        or source_report["shipped"] is not False
    ):
        _quality_error(_("mapEvidence besitzt keine ehrliche sichtbare Static-Map-v2-Bindung"))

    model = _exact_keys(quality["operationalModel"], (
        "policyId", "policySha256", "closureReceiptSha256", "qualityClass", "provenance", "realGeometry",
        "simulatedOperationalAssignment", "realInterlockingFactsClaimed", "syntheticOperationalDetailsShipped",
        "objectLevelProvenanceShipped", "observedAndSyntheticObjectsShareRuntimeCollections", "movementRouteTemplates",
        "timetableRouteEvidence", "operationalArtifact", "coverage",
    ), "Operational-v2.operationalModel")
    if (
        model["policyId"] != "synthetic-operational-b/v2"
        or not isinstance(model["policySha256"], str) or not SHA256.fullmatch(model["policySha256"])
        or not isinstance(model["closureReceiptSha256"], str) or not SHA256.fullmatch(model["closureReceiptSha256"])
        or model["qualityClass"] != "B" or model["provenance"] != "derived"
        or model["realGeometry"] is not True or model["simulatedOperationalAssignment"] is not True
        or model["realInterlockingFactsClaimed"] is not False
        or model["syntheticOperationalDetailsShipped"] is not True
        or model["objectLevelProvenanceShipped"] is not False
        or model["observedAndSyntheticObjectsShareRuntimeCollections"] is not True
    ):
        _quality_error(_("operationalModel besitzt keine ehrliche geschlossene Derived/B-Provenienz"))
    route_evidence = _validate_timetable_route_evidence(model["timetableRouteEvidence"])
    if route_evidence["policyId"] != model["policyId"]:
        _quality_error(_("Fahrwegbeleg und Betriebsmodell binden verschiedene Policies"))
    if (
        route_evidence["transferDemandsBytes"] != delivered_transfer_demands["bytes"]
        or route_evidence["transferDemandsSha256"] != delivered_transfer_demands["sha256"]
    ):
        _quality_error(_("Transferbeleg bindet nicht exakt das ausgelieferte timetable-transfer-demands-v2-Artefakt"))

    movement_route_templates = _exact_keys(model["movementRouteTemplates"], (
        "bytes", "sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256",
    ), "Operational-v2.movementRouteTemplates")
    movement_hash_fields = ("sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256")
    if (
        not _safe_integer(movement_route_templates["bytes"], 1)
        or not all(
            isinstance(movement_route_templates[field], str) and SHA256.fullmatch(movement_route_templates[field])
            for field in movement_hash_fields
        )
        or movement_route_templates["sha256"] == movement_route_templates["stateHash"]
        or movement_route_templates["bytes"] != delivered_movement_route_templates["bytes"]
        or movement_route_templates["sha256"] != delivered_movement_route_templates["sha256"]
        or movement_route_templates["timetableTransferSetSha256"] != route_evidence["transferSetSha256"]
    ):
        _quality_error(_("movementRouteTemplates bindet nicht exakt Artefakt, Zustand und Transfer-Set"))

    operational_artifact = _exact_keys(model["operationalArtifact"], ("bytes", "sha256", "stateHash"), "Operational-v2.operationalArtifact")
    if (
        not _safe_integer(operational_artifact["bytes"], 1)
        or not isinstance(operational_artifact["sha256"], str) or not SHA256.fullmatch(operational_artifact["sha256"])
        or not isinstance(operational_artifact["stateHash"], str) or not SHA256.fullmatch(operational_artifact["stateHash"])
        or operational_artifact["sha256"] == operational_artifact["stateHash"]
        or operational_artifact["bytes"] != delivered_operational_artifact["bytes"]
        or operational_artifact["sha256"] != delivered_operational_artifact["sha256"]
        or operational_artifact["stateHash"] != delivered_operational_artifact["stateHash"]
        or movement_route_templates["operationalStateHash"] != operational_artifact["stateHash"]
    ):
        _quality_error(_("Qualitaet bindet nicht exakt Betriebsartefakt, Bewegungsfahrwege und ihren gemeinsamen Zustand"))
    coverage = _exact_keys(model["coverage"], OPERATIONAL_COVERAGE_FIELDS, "Operational-v2.coverage")
    if (
        not all(_safe_integer(coverage[field], 1) for field in OPERATIONAL_COVERAGE_FIELDS)
        or coverage["directedEdges"] != coverage["edgeGeometries"]
        or coverage["rzueLayouts"] != 1
    ):
        _quality_error(_("coverage ist nicht vollstaendig geschlossen"))

    summary = _exact_keys(quality["summary"], (
        "operationalQualityClassArtifactCount", "unresolvedRequired", "visibleMapClassCFeatureCount",
    ), "Operational-v2.summary")
    operational_classes = _quality_class_counts(summary["operationalQualityClassArtifactCount"], "Operational-v2.summary.operationalQualityClassArtifactCount")
    if (
        operational_classes != {"A": 0, "B": 1, "C": 0}
        or not _safe_integer(summary["unresolvedRequired"])
        or summary["unresolvedRequired"] != 0
        or not _safe_integer(summary["visibleMapClassCFeatureCount"])
        or summary["visibleMapClassCFeatureCount"] != map_classes["C"]
    ):
        _quality_error(_("keine getrennte geschlossene B=1/C=0-Bilanz oder sichtbare Karten-C verschwiegen"))

    quality_gate = _exact_keys(quality["qualityGate"], (
        "closureReceiptVerified", "nativeOperationalValidationVerified", "operationalClassCZero",
        "ordinaryAssumptionsPromoted", "mapClassCReclassified", "operationalQualityEligible", "signatureImplied",
        "activationImplied",
    ), "Operational-v2.qualityGate")
    if (
        quality_gate["closureReceiptVerified"] is not True
        or quality_gate["nativeOperationalValidationVerified"] is not True
        or quality_gate["operationalClassCZero"] is not True
        or quality_gate["ordinaryAssumptionsPromoted"] is not False
        or quality_gate["mapClassCReclassified"] is not False
        or quality_gate["operationalQualityEligible"] is not True
        or quality_gate["signatureImplied"] is not False
        or quality_gate["activationImplied"] is not False
    ):
        _quality_error(_("Qualitaetsgate ist offen, klassifiziert Karten-C um oder behauptet Signatur/Aktivierung"))
    return {
        "visible_layers": map_evidence["visibleLayers"],
        "visible_features": map_evidence["visibleFeatures"],
        "visible_map_class_c_feature_count": map_classes["C"],
        "operational_class_c_artifact_count": operational_classes["C"],
    }


def _safe_id(value, label):
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise ValidationError(_("%s ist keine sichere ID.") % label)
    return value


def _portable_path(value, label):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value or "://" in value or value.startswith("/") or re.match(r"^[a-z]:", value, re.I):
        raise ValidationError(_("%s ist kein sicherer relativer Pfad.") % label)
    if any(segment in ("", ".", "..") for segment in value.split("/")):
        raise ValidationError(_("%s enthaelt ein unsicheres Segment.") % label)
    if re.search(r"(?:^|[\s/_.-])apn(?:$|[\s/_.-])|trassenfinder", value, re.I):
        raise ValidationError(_("%s referenziert interne Validierungsdaten.") % label)
    return value


def _validate_map_asset_notices(value, files):
    notices = _exact_keys(value, ("schema", "assets"), "Oeffentliche Asset-Notices")
    assets = notices["assets"]
    if notices["schema"] != MAP_ASSET_NOTICES_SCHEMA or not isinstance(assets, list):
        raise ValidationError(_("sources.json besitzt keinen gueltigen Asset-Notice-Vertrag."))
    if len(assets) != 2:
        raise ValidationError(_("Asset-Notices muessen genau Noto-Glyphen und Protomaps-Sprites enthalten."))
    covered_files = 0
    previous_id = ""
    for index, entry in enumerate(assets):
        asset = _exact_keys(entry, (
            "id", "rightsSourceId", "kind", "license", "copyright", "modifications", "source", "derivedFrom",
            "notice", "tree",
        ), "Asset-Notice[%s]" % index)
        asset_id = _safe_id(asset["id"], "Asset-Notice[%s].id" % index)
        if asset_id <= previous_id:
            raise ValidationError(_("Asset-Notices sind nicht stabil nach ID sortiert."))
        previous_id = asset_id
        kind = asset["kind"]
        expected_id = "noto-glyphs" if kind == "glyph" else "protomaps-sprites" if kind == "sprite" else None
        expected_license = "OFL-1.1" if kind == "glyph" else "MIT" if kind == "sprite" else None
        if (
            asset_id != expected_id or asset["rightsSourceId"] != asset_id or asset["license"] != expected_license
            or not isinstance(asset["copyright"], str) or len(asset["copyright"]) <= 10
            or not isinstance(asset["modifications"], str) or len(asset["modifications"]) <= 10
        ):
            raise ValidationError(_("%s besitzt keine eindeutige Rechte- und Lizenzbindung.") % asset_id)
        source = _exact_keys(asset["source"], ("repository", "commit", "path"), "%s.source" % asset_id)
        if (
            not isinstance(source["repository"], str) or not GITHUB_REPOSITORY.fullmatch(source["repository"])
            or not isinstance(source["commit"], str) or not GIT_COMMIT.fullmatch(source["commit"])
        ):
            raise ValidationError(_("%s.source ist nicht unveraenderlich gepinnt.") % asset_id)
        _portable_path(source["path"], "%s.source.path" % asset_id)
        if kind == "glyph":
            if asset["derivedFrom"] is not None:
                raise ValidationError(_("Noto-Glyphen duerfen keine fremde Ableitungsquelle behaupten."))
        else:
            derived = _exact_keys(asset["derivedFrom"], ("repository", "commit", "license"), "%s.derivedFrom" % asset_id)
            if (
                derived["repository"] != "https://github.com/tangrams/icons"
                or not isinstance(derived["commit"], str) or not GIT_COMMIT.fullmatch(derived["commit"])
                or derived["license"] != "MIT"
            ):
                raise ValidationError(_("Protomaps-Sprites binden die Tangrams-MIT-Ableitung nicht unveraenderlich."))
        notice = _exact_keys(asset["notice"], ("url", "bytes", "sha256", "text"), "%s.notice" % asset_id)
        notice_text = notice["text"]
        notice_bytes = notice_text.encode("utf-8") if isinstance(notice_text, str) else b""
        expected_license_text = "SIL OPEN FONT LICENSE Version 1.1" if kind == "glyph" else "The MIT License (MIT)"
        if (
            not isinstance(notice["url"], str) or not notice["url"].startswith("https://raw.githubusercontent.com/")
            or not isinstance(notice_text, str)
            or not _safe_integer(notice["bytes"], 1) or notice["bytes"] != len(notice_bytes)
            or not isinstance(notice["sha256"], str) or not SHA256.fullmatch(notice["sha256"])
            or hashlib.sha256(notice_bytes).hexdigest() != notice["sha256"]
            or asset["copyright"] not in notice_text or expected_license_text not in notice_text
        ):
            raise ValidationError(_("%s.notice bindet nicht den vollstaendigen Lizenztext.") % asset_id)
        tree = _exact_keys(asset["tree"], ("installDirectory", "files", "bytes", "sha256"), "%s.tree" % asset_id)
        install_directory = _portable_path(tree["installDirectory"], "%s.tree.installDirectory" % asset_id)
        prefix = "%s/" % install_directory
        rows = sorted((
            {
                "path": _portable_path(file_entry["installPath"][len(prefix):], "%s.installPath" % asset_id),
                "bytes": file_entry["bytes"],
                "sha256": file_entry["sha256"],
            }
            for file_entry in files
            if file_entry["kind"] == kind and file_entry["installPath"].startswith(prefix)
        ), key=lambda row: row["path"])
        if not rows or len({row["path"].lower() for row in rows}) != len(rows):
            raise ValidationError(_("%s.tree ist leer oder enthaelt kollidierende Pfade.") % asset_id)
        canonical_tree = ("\n".join(
            "%s\0%s\0%s" % (row["path"], row["bytes"], row["sha256"])
            for row in rows
        ) + "\n").encode("utf-8")
        if (
            not _safe_integer(tree["files"], 1)
            or not _safe_integer(tree["bytes"], 1)
            or tree["files"] != len(rows)
            or tree["bytes"] != sum(row["bytes"] for row in rows)
            or tree["sha256"] != hashlib.sha256(canonical_tree).hexdigest()
        ):
            raise ValidationError(_("%s weicht vom ausgelieferten Assetbaum ab.") % asset_id)
        covered_files += len(rows)
    packaged_asset_files = sum(file_entry["kind"] in ("glyph", "sprite") for file_entry in files)
    if covered_files != packaged_asset_files:
        raise ValidationError(_("Glyphen- oder Sprite-Dateien liegen ausserhalb der lizenzierten Assetbaeume."))
    return {"asset_groups": len(assets), "asset_files": covered_files}


def _attachment_path(attachment):
    if attachment.type != "binary" or not attachment.store_fname:
        raise ValidationError(_("Anhang %s muss als regulaere Filestore-Datei vorliegen.") % attachment.name)
    path = attachment._full_path(attachment.store_fname)
    if os.path.islink(path) or not os.path.isfile(path):
        raise ValidationError(_("Anhang %s ist keine regulaere Datei.") % attachment.name)
    return path


def _hash_file(path):
    digest = hashlib.sha256()
    total = 0
    with open(path, "rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
    return {"bytes": total, "sha256": digest.hexdigest()}


def _parse_package_manifest(raw):
    if not raw or len(raw) > MAX_MANIFEST_BYTES:
        raise ValidationError(_("Paketmanifest hat eine unzulaessige Groesse."))
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(_("Paketmanifest ist kein gueltiges UTF-8-JSON.")) from error
    if not isinstance(manifest, dict) or manifest.get("schema") != PACKAGE_SCHEMA or manifest.get("format") != "directory-parts":
        raise ValidationError(_("Paketmanifest hat ein unbekanntes Schema oder Format."))
    if raw != _canonical(manifest):
        raise ValidationError(_("Paketmanifest ist nicht kanonisch serialisiert."))
    package_id = _safe_id(manifest.get("packageId"), "packageId")
    version = _safe_id(manifest.get("version"), "version")
    _delivery_v2_generation(version)
    if manifest.get("partBytes") != PART_BYTES:
        raise ValidationError(_("Jahrespaket muss das 100-MiB-Transportprofil verwenden."))
    artifacts = manifest.get("artifacts")
    auxiliaries = manifest.get("auxiliaryFiles")
    if not isinstance(artifacts, list) or len(artifacts) != 2 or not isinstance(auxiliaries, list) or len(auxiliaries) < 6:
        raise ValidationError(_("Paketinventar ist unvollstaendig."))
    if sorted(item.get("kind") for item in artifacts if isinstance(item, dict)) != ["basemap", "infrastructure"]:
        raise ValidationError(_("Paket braucht genau Basemap und Infrastruktur."))
    auxiliary_kinds = [item.get("kind") for item in auxiliaries if isinstance(item, dict)]
    if auxiliary_kinds.count("read-model") != 1:
        raise ValidationError(_("Paket braucht genau ein oeffentliches ReadModel."))
    for required_kind in ("release-manifest", "source-manifest", "quality-manifest"):
        if auxiliary_kinds.count(required_kind) != 1:
            raise ValidationError(_("Paket braucht genau ein %s.") % required_kind)
    if auxiliary_kinds.count(OPERATIONAL_INFRASTRUCTURE_KIND) != 1:
        raise ValidationError(_("Paket braucht genau eine statische operational-infrastructure-v2.json."))
    if auxiliary_kinds.count(MOVEMENT_ROUTE_TEMPLATES_KIND) != 1:
        raise ValidationError(_("Paket braucht genau eine operational-infrastructure-v2.movement-route-templates-v2.json."))
    if auxiliary_kinds.count(TIMETABLE_TRANSFER_DEMANDS_KIND) != 1:
        raise ValidationError(_("Paket braucht genau eine timetable-routes-v2.transfer-demands-v2.json."))
    if auxiliary_kinds.count("train-map-projection") != 0:
        raise ValidationError(_("Operational-v2-Paket darf keine weltgebundene Zugpositionsprojektion als Paketvoraussetzung enthalten."))
    read_model = next(item for item in auxiliaries if isinstance(item, dict) and item.get("kind") == "read-model")
    operational_infrastructure = next(item for item in auxiliaries if isinstance(item, dict) and item.get("kind") == OPERATIONAL_INFRASTRUCTURE_KIND)
    movement_route_templates = next(item for item in auxiliaries if isinstance(item, dict) and item.get("kind") == MOVEMENT_ROUTE_TEMPLATES_KIND)
    transfer_demands = next(item for item in auxiliaries if isinstance(item, dict) and item.get("kind") == TIMETABLE_TRANSFER_DEMANDS_KIND)
    if (
        read_model.get("installPath") != "read-model.sqlite"
        or operational_infrastructure.get("installPath") != "operational-infrastructure-v2.json"
        or movement_route_templates.get("installPath") != "operational-infrastructure-v2.movement-route-templates-v2.json"
        or transfer_demands.get("installPath") != "timetable-routes-v2.transfer-demands-v2.json"
    ):
        raise ValidationError(_("ReadModel und alle Operational-v2-Artefakte muessen an ihren kanonischen Pfaden in derselben Releasewurzel liegen."))

    files = []
    parts = []
    ids = set()
    install_paths = set()
    package_paths = set()
    for descriptor in artifacts + auxiliaries:
        if not isinstance(descriptor, dict):
            raise ValidationError(_("Paketdateieintrag ist kein Objekt."))
        file_id = _safe_id(descriptor.get("id"), "Paketdatei-ID")
        if file_id in ids:
            raise ValidationError(_("Paketdatei-ID %s ist doppelt.") % file_id)
        ids.add(file_id)
        install_path = _portable_path(descriptor.get("installPath"), "%s.installPath" % file_id)
        if install_path.lower() in install_paths:
            raise ValidationError(_("Installationspfad %s ist doppelt.") % install_path)
        install_paths.add(install_path.lower())
        file_bytes = descriptor.get("bytes")
        file_sha256 = descriptor.get("sha256")
        file_parts = descriptor.get("parts")
        if not isinstance(file_bytes, int) or isinstance(file_bytes, bool) or file_bytes <= 0 or not isinstance(file_sha256, str) or not SHA256.fullmatch(file_sha256) or not isinstance(file_parts, list) or not file_parts:
            raise ValidationError(_("Paketdatei %s besitzt keinen Byte-SHA-Vertrag.") % file_id)
        byte_sum = 0
        normalized_parts = []
        for index, part in enumerate(file_parts):
            if not isinstance(part, dict):
                raise ValidationError(_("Paketteil von %s ist kein Objekt.") % file_id)
            package_path = _portable_path(part.get("path"), "%s.parts[%s].path" % (file_id, index))
            part_bytes = part.get("bytes")
            part_sha256 = part.get("sha256")
            if package_path.lower() in package_paths or not isinstance(part_bytes, int) or isinstance(part_bytes, bool) or not 0 < part_bytes <= PART_BYTES or not isinstance(part_sha256, str) or not SHA256.fullmatch(part_sha256):
                raise ValidationError(_("Paketteil %s besitzt keinen eindeutigen Byte-SHA-Vertrag.") % package_path)
            package_paths.add(package_path.lower())
            part_id = hashlib.sha256(("%s\0%s\0%s" % (file_id, index, part_sha256)).encode("utf-8")).hexdigest()[:32]
            normalized = {
                "file_id": file_id,
                "kind": descriptor.get("kind"),
                "index": index,
                "package_path": package_path,
                "filename": os.path.basename(package_path),
                "bytes": part_bytes,
                "sha256": part_sha256,
                "part_id": part_id,
            }
            normalized_parts.append(normalized)
            parts.append(normalized)
            byte_sum += part_bytes
        if byte_sum != file_bytes:
            raise ValidationError(_("Summe der Paketteile von %s stimmt nicht.") % file_id)
        operational_binding = {}
        if descriptor.get("kind") == OPERATIONAL_INFRASTRUCTURE_KIND:
            infra_release_id = _safe_id(descriptor.get("infraReleaseId"), "%s.infraReleaseId" % file_id)
            state_hash = descriptor.get("stateHash")
            if not isinstance(state_hash, str) or not SHA256.fullmatch(state_hash) or state_hash == file_sha256:
                raise ValidationError(_("Operational-v2-Artefakt %s besitzt keine getrennte kanonische Zustandsbindung.") % file_id)
            operational_binding = {"infraReleaseId": infra_release_id, "stateHash": state_hash}
        files.append({
            "id": file_id,
            "kind": descriptor.get("kind"),
            "installPath": install_path,
            **operational_binding,
            "bytes": file_bytes,
            "sha256": file_sha256,
            "parts": normalized_parts,
        })
    if len({part["filename"] for part in parts}) != len(parts):
        raise ValidationError(_("Paketteil-Dateinamen sind nicht eindeutig."))
    return {"manifest": manifest, "package_id": package_id, "version": version, "files": files, "parts": parts}


def _read_packaged_json(file_entry, inventory):
    if file_entry["bytes"] > MAX_MANIFEST_BYTES:
        raise ValidationError(_("%s ist als oeffentliches JSON zu gross.") % file_entry["kind"])
    chunks = []
    for part in sorted(file_entry["parts"], key=lambda item: item["index"]):
        attachment_id = inventory[part["package_path"]]["attachment_id"]
        attachment = inventory[part["package_path"]]["attachment"]
        if attachment.id != attachment_id:
            raise ValidationError(_("Paketteilzuordnung wurde veraendert."))
        with open(_attachment_path(attachment), "rb") as source:
            chunks.append(source.read())
    raw = b"".join(chunks)
    if len(raw) != file_entry["bytes"] or hashlib.sha256(raw).hexdigest() != file_entry["sha256"]:
        raise ValidationError(_("%s stimmt nicht mit seinem Dateivertrag ueberein.") % file_entry["kind"])
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(_("%s ist kein gueltiges UTF-8-JSON.") % file_entry["kind"]) from error
    if not isinstance(value, dict):
        raise ValidationError(_("%s muss ein JSON-Objekt sein.") % file_entry["kind"])
    return value, raw


def _validate_delivery_sources(value, release_id, files):
    sources = _exact_keys(value, (
        "schema", "releaseId", "sources", "assetInventoryPlanSha256", "assetNotices",
    ), "Delivery-Quellenvertrag")
    source_entries = sources["sources"]
    if (
        sources["schema"] != SOURCES_SCHEMA or sources["releaseId"] != release_id
        or not isinstance(source_entries, list) or not source_entries
        or not isinstance(sources["assetInventoryPlanSha256"], str)
        or not SHA256.fullmatch(sources["assetInventoryPlanSha256"])
    ):
        raise ValidationError(_("sources.json hat keinen gebundenen oeffentlichen Quellen- und Asset-Inventarvertrag."))
    previous_id = ""
    for index, entry in enumerate(source_entries):
        source = _exact_keys(entry, (
            "id", "scope", "approved", "license", "version", "attribution", "modifications",
        ), "Delivery-Quelle[%s]" % index)
        source_id = _safe_id(source["id"], "Delivery-Quelle[%s].id" % index)
        if source_id <= previous_id:
            raise ValidationError(_("Delivery-Quellen sind nicht stabil nach ID sortiert oder enthalten doppelte IDs."))
        previous_id = source_id
        scope = source["scope"]
        if (
            scope not in ("basemap", "infrastructure") or not source_id.startswith("%s-" % scope)
            or source["approved"] is not True
            or not isinstance(source["license"], str) or not source["license"]
            or not isinstance(source["version"], str) or not source["version"]
            or not isinstance(source["attribution"], str) or not source["attribution"].strip()
            or not isinstance(source["modifications"], str) or not source["modifications"].strip()
        ):
            raise ValidationError(_("Oeffentliche Quellenfreigabe ist unvollstaendig."))
    attributions = " ".join(source["attribution"] for source in source_entries)
    if not re.search("openstreetmap", attributions, re.I) or not re.search("protomaps", attributions, re.I):
        raise ValidationError(_("OpenStreetMap- oder Protomaps-Attribution fehlt."))
    asset_summary = _validate_map_asset_notices(sources["assetNotices"], files)
    return {"entries": source_entries, **asset_summary}


def _qualify_public_delivery(parsed, inventory):
    by_kind = {entry["kind"]: entry for entry in parsed["files"]}
    if not all(kind in by_kind for kind in ("release-manifest", "source-manifest", "quality-manifest")):
        raise ValidationError(_("Oeffentliche Delivery-, Quellen- oder Qualitaetsdatei fehlt."))
    delivery_value, _delivery_raw = _read_packaged_json(by_kind["release-manifest"], inventory)
    sources, sources_raw = _read_packaged_json(by_kind["source-manifest"], inventory)
    quality, quality_raw = _read_packaged_json(by_kind["quality-manifest"], inventory)
    current_operational = _delivery_v2_generation(parsed["version"]) == "integrated-provenance-v2"
    delivery = _exact_keys(delivery_value, (
        "schema", "releaseId", "timetableYear", "packageId", "packageVersion", "scope", "artifacts", "bindings",
        "approvalGates", "releaseHash", "signature", *(("operationalAuthority", "operationalProvenance") if current_operational else ()),
    ), "Delivery-Release")
    if delivery["schema"] != DELIVERY_SCHEMA or delivery["packageId"] != parsed["package_id"] or delivery["packageVersion"] != parsed["version"]:
        raise ValidationError(_("release.json ist kein an dieses Paket gebundener Delivery-Release."))
    release_id = _safe_id(delivery["releaseId"], "Delivery releaseId")
    if release_id != "infra-deutschland-%s" % parsed["version"]:
        raise ValidationError(_("Delivery-v2 bindet Paketversion und InfraRelease-ID nicht exakt."))
    year_match = re.match(r"^infra-deutschland-(\d{4})(?:\.|$)", release_id)
    if not year_match or not _safe_integer(delivery["timetableYear"], 2026) or delivery["timetableYear"] != int(year_match.group(1)):
        raise ValidationError(_("Delivery-Release bindet kein konsistentes Fahrplanjahr."))
    scope = _exact_keys(delivery["scope"], ("basemap", "infrastructure", "playableArea"), "Delivery-Scope")
    if scope != {
        "basemap": "world-z0-10-and-germany-z11-15",
        "infrastructure": "germany-ebo-complete-visible-corpus",
        "playableArea": "configured-separately-by-world",
    }:
        raise ValidationError(_("Delivery-Release besitzt keinen Operational-v2-Auslieferungsscope."))
    bindings = _exact_keys(delivery["bindings"], (
        "packageManifestSchema", "infraReleaseSchema", "mapReleaseSchema", "infraReleaseHash", "mapReleaseHash",
        "sourcesSha256", "qualitySha256", *(("operationalAuthoritySha256", "operationalProvenanceSha256") if current_operational else ()),
    ), "Delivery bindings")
    if (
        bindings["packageManifestSchema"] != PACKAGE_SCHEMA
        or bindings["infraReleaseSchema"] != "zugfolge-infra-release/v2"
        or bindings["mapReleaseSchema"] != "zugfolge-map-release/v1"
        or not isinstance(bindings["infraReleaseHash"], str) or not SHA256.fullmatch(bindings["infraReleaseHash"])
        or not isinstance(bindings["mapReleaseHash"], str) or not SHA256.fullmatch(bindings["mapReleaseHash"])
        or bindings["sourcesSha256"] != hashlib.sha256(sources_raw).hexdigest()
        or bindings["qualitySha256"] != hashlib.sha256(quality_raw).hexdigest()
    ):
        raise ValidationError(_("Delivery-Release bindet Paketvertrag, Infra-/Map-Release-Huellen, Quellen oder Qualitaet nicht bytegenau."))
    if current_operational:
        operational_provenance = _validate_operational_provenance(delivery["operationalProvenance"])
        operational_authority = _validate_operational_authority(delivery["operationalAuthority"])
        if (
            bindings["operationalProvenanceSha256"] != operational_provenance["sha256"]
            or bindings["operationalAuthoritySha256"] != operational_authority["sha256"]
        ):
            raise ValidationError(_("Delivery-Release bindet Operational-v2-Ausfuehrungsprovenienz oder Build-Authority nicht kanonisch."))
    else:
        operational_provenance = None
        operational_authority = None
    expected_artifacts = sorted([
        {
            **{key: entry[key] for key in ("id", "kind", "installPath", "bytes", "sha256")},
            **({key: entry[key] for key in ("infraReleaseId", "stateHash")} if entry["kind"] == OPERATIONAL_INFRASTRUCTURE_KIND else {}),
        }
        for entry in parsed["files"] if entry["kind"] not in ("release-manifest", "source-manifest")
    ], key=lambda item: item["id"])
    delivered_artifacts = delivery["artifacts"]
    if not isinstance(delivered_artifacts, list) or sorted(delivered_artifacts, key=lambda item: item.get("id", "") if isinstance(item, dict) else "") != expected_artifacts:
        raise ValidationError(_("Delivery-Release bindet nicht exakt alle auszuliefernden Artefakte."))
    delivered_operational = [item for item in delivered_artifacts if isinstance(item, dict) and item.get("kind") == OPERATIONAL_INFRASTRUCTURE_KIND]
    if len(delivered_operational) != 1 or delivered_operational[0].get("infraReleaseId") != release_id:
        raise ValidationError(_("Operational-v2-Artefakt ist nicht an die Delivery-InfraRelease-ID gebunden."))
    delivered_movement_route_templates = [
        item for item in delivered_artifacts
        if isinstance(item, dict) and item.get("kind") == MOVEMENT_ROUTE_TEMPLATES_KIND
    ]
    delivered_transfer_demands = [
        item for item in delivered_artifacts
        if isinstance(item, dict) and item.get("kind") == TIMETABLE_TRANSFER_DEMANDS_KIND
    ]
    if len(delivered_movement_route_templates) != 1 or len(delivered_transfer_demands) != 1:
        raise ValidationError(_("Delivery bindet nicht genau je ein Bewegungsfahrweg- und Transfer-Artefakt."))
    source_summary = _validate_delivery_sources(sources, release_id, parsed["files"])
    quality_summary = _validate_operational_quality(
        quality,
        release_id,
        delivered_operational[0],
        delivered_movement_route_templates[0],
        delivered_transfer_demands[0],
    )
    gates = _exact_keys(delivery["approvalGates"], ("rights", "quality", "signature"), "Delivery approvalGates")
    rights_gate = _exact_keys(gates["rights"], (
        "status", "sourceManifestSchema", "sourceCount", "assetGroupCount", "assetFileCount",
    ), "Delivery Rechte-Gate")
    quality_gate = _exact_keys(gates["quality"], (
        "status", "reportSchema", "visibleLayers", "visibleFeatures", "visibleMapClassCFeatureCount",
        "operationalClassCArtifactCount", "classCOrderable",
    ), "Delivery Qualitaets-Gate")
    if (
        rights_gate["status"] != "passed"
        or rights_gate["sourceManifestSchema"] != SOURCES_SCHEMA
        or rights_gate["sourceCount"] != len(source_summary["entries"])
        or rights_gate["assetGroupCount"] != source_summary["asset_groups"]
        or rights_gate["assetFileCount"] != source_summary["asset_files"]
        or quality_gate["status"] != "passed"
        or quality_gate["reportSchema"] != QUALITY_SCHEMA
        or quality_gate["visibleLayers"] != quality_summary["visible_layers"]
        or quality_gate["visibleFeatures"] != quality_summary["visible_features"]
        or quality_gate["visibleMapClassCFeatureCount"] != quality_summary["visible_map_class_c_feature_count"]
        or quality_gate["operationalClassCArtifactCount"] != quality_summary["operational_class_c_artifact_count"]
        or quality_gate["classCOrderable"] is not False
    ):
        raise ValidationError(_("Rechte- oder Qualitaetsgate ist nicht bestanden oder weicht vom Operational-v2-Vertrag ab."))
    signature_gate = _record(gates["signature"], "Delivery-Signaturgate")
    if signature_gate.get("status") == "missing":
        signature_gate = _exact_keys(signature_gate, ("status", "reason"), "Fehlendes Delivery-Signaturgate")
        if (
            not isinstance(signature_gate["reason"], str) or not signature_gate["reason"].strip()
            or delivery["signature"] is not None or delivery["releaseHash"] is not None
        ):
            raise ValidationError(_("Unsignierter Delivery-Release darf keine Signatur oder Hashfreigabe behaupten."))
        return {
            "delivery_release_id": release_id,
            "infra_release_hash": bindings["infraReleaseHash"],
            "timetable_year": delivery["timetableYear"],
            "signature_status": "missing",
            "activation_eligible": False,
            "operational_provenance_sha256": operational_provenance["sha256"] if operational_provenance else None,
            "operational_execution_proof_sha256": operational_provenance["execution_proof_sha256"] if operational_provenance else None,
            "operational_validator_sha256": operational_provenance["validator_sha256"] if operational_provenance else None,
            "operational_authority_sha256": operational_authority["sha256"] if operational_authority else None,
            "operational_rebuild_attestation_sha256": operational_authority["rebuild_attestation_sha256"] if operational_authority else None,
            "operational_execution_authority_attestation_sha256": operational_authority["execution_authority_attestation_sha256"] if operational_authority else None,
            "operational_outer_execution_receipt_sha256": operational_authority["outer_execution_receipt_sha256"] if operational_authority else None,
            "operational_outer_execution_completion_sha256": operational_authority["outer_execution_completion_sha256"] if operational_authority else None,
            "operational_authority_source_commit": operational_authority["source_commit"] if operational_authority else None,
        }
    signature = _record(delivery["signature"], "Delivery-Signatur")
    if signature_gate.get("status") != "passed":
        raise ValidationError(_("Delivery-Signaturgate ist weder bestanden noch explizit fehlend."))
    signature_gate = _exact_keys(signature_gate, ("status", "algorithm", "keyId"), "Bestandenes Delivery-Signaturgate")
    signature = _exact_keys(signature, ("algorithm", "keyId", "valueBase64"), "Delivery-Signatur")
    key_id = _safe_id(signature["keyId"], "Delivery-Signaturschluessel")
    if signature["algorithm"] != "Ed25519" or signature_gate["algorithm"] != "Ed25519" or signature_gate["keyId"] != key_id:
        raise ValidationError(_("Delivery-Signatur und Freigabegate besitzen keine gemeinsame Ed25519-Bindung."))
    release_hash = delivery["releaseHash"]
    if not isinstance(release_hash, str) or not SHA256.fullmatch(release_hash):
        raise ValidationError(_("Delivery-Release besitzt keinen gueltigen Releasehash."))
    signing_payload = dict(delivery)
    signing_payload.pop("releaseHash", None)
    signing_payload.pop("signature", None)
    if hashlib.sha256(_canonical(signing_payload)).hexdigest() != release_hash:
        raise ValidationError(_("Delivery-Releasehash bindet nicht den kanonischen Inhalt."))
    signature_base64 = signature.get("valueBase64")
    try:
        signature_bytes = base64.b64decode(signature_base64, validate=True) if isinstance(signature_base64, str) else b""
    except (binascii.Error, ValueError) as error:
        raise ValidationError(_("Delivery-Signatur besitzt keine kanonische Ed25519-Kodierung.")) from error
    if len(signature_bytes) != 64 or base64.b64encode(signature_bytes).decode("ascii") != signature_base64:
        raise ValidationError(_("Delivery-Signatur besitzt keine kanonische Ed25519-Kodierung."))
    # Odoo akzeptiert den strukturell gebundenen Transport, behauptet aber erst
    # nach der authentifizierten Game-Quittung eine kryptografische Verifikation.
    return {
        "delivery_release_id": release_id,
        "infra_release_hash": bindings["infraReleaseHash"],
        "timetable_year": delivery["timetableYear"],
        "signature_status": "present",
        "activation_eligible": False,
        "operational_provenance_sha256": operational_provenance["sha256"] if operational_provenance else None,
        "operational_execution_proof_sha256": operational_provenance["execution_proof_sha256"] if operational_provenance else None,
        "operational_validator_sha256": operational_provenance["validator_sha256"] if operational_provenance else None,
        "operational_authority_sha256": operational_authority["sha256"] if operational_authority else None,
        "operational_rebuild_attestation_sha256": operational_authority["rebuild_attestation_sha256"] if operational_authority else None,
        "operational_execution_authority_attestation_sha256": operational_authority["execution_authority_attestation_sha256"] if operational_authority else None,
        "operational_outer_execution_receipt_sha256": operational_authority["outer_execution_receipt_sha256"] if operational_authority else None,
        "operational_outer_execution_completion_sha256": operational_authority["outer_execution_completion_sha256"] if operational_authority else None,
        "operational_authority_source_commit": operational_authority["source_commit"] if operational_authority else None,
    }


class ZugfolgeInfraReleaseImport(models.Model):
    """Odoo kontrolliert Upload und Audit; nur das Game qualifiziert und aktiviert einen InfraRelease."""

    _name = "zugfolge.infra.release.import"
    _description = "Zugfolge InfraRelease-Jahresimport"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "create_date desc"

    name = fields.Char(compute="_compute_name", store=True)
    import_id = fields.Char(required=True, readonly=True, copy=False, default=lambda self: str(uuid.uuid4()), index=True)
    state = fields.Selection(
        [("draft", "Entwurf"), ("verifying", "Pruefung laeuft"), ("verified", "Geprueft"), ("staged", "Im Game bereitgestellt"), ("failed", "Fehlgeschlagen")],
        required=True, default="draft", readonly=True, tracking=True,
    )
    importer_id = fields.Many2one("res.users", required=True, readonly=True, default=lambda self: self.env.user, copy=False)
    world_projection_id = fields.Many2one("zugfolge.world.projection", ondelete="restrict")
    manifest_attachment_ids = fields.Many2many("ir.attachment", "zugfolge_infra_import_manifest_rel", "import_id", "attachment_id", copy=False)
    part_attachment_ids = fields.Many2many("ir.attachment", "zugfolge_infra_import_attachment_rel", "import_id", "attachment_id", copy=False)
    manifest_bytes = fields.Integer(readonly=True, copy=False)
    manifest_sha256 = fields.Char(readonly=True, copy=False, index=True)
    package_id = fields.Char(readonly=True, copy=False)
    package_version = fields.Char(readonly=True, copy=False)
    delivery_release_id = fields.Char(readonly=True, copy=False, index=True)
    infra_release_hash = fields.Char(string="Signierter InfraRelease-Hash", readonly=True, copy=False, index=True)
    timetable_year = fields.Integer(string="Fahrplanjahr", readonly=True, copy=False)
    part_count = fields.Integer(readonly=True, copy=False)
    # PostgreSQL int4 (fields.Integer) overflows for the real 14+ GiB package.
    # An exact NUMERIC column keeps the byte counter integral and future-proof.
    total_part_bytes = fields.Float(digits=(20, 0), readonly=True, copy=False)
    part_inventory = fields.Json(readonly=True, copy=False)
    verification_inventory_sha256 = fields.Char(readonly=True, copy=False)
    verification_started_at = fields.Datetime(readonly=True, copy=False)
    verification_completed_at = fields.Datetime(readonly=True, copy=False)
    verified_by_id = fields.Many2one("res.users", readonly=True, copy=False)
    staging_requested_at = fields.Datetime(readonly=True, copy=False)
    staged_at = fields.Datetime(readonly=True, copy=False)
    game_stage_result = fields.Json(readonly=True, copy=False)
    signature_status = fields.Selection([("missing", "Signatur fehlt"), ("present", "Signatur vorhanden"), ("verified", "Signatur geprueft")], readonly=True, copy=False)
    native_operational_validation_status = fields.Selection([("missing", "Nativer Beleg fehlt"), ("verified", "Nativer Beleg geprueft")], readonly=True, copy=False)
    activation_blocker = fields.Selection([
        ("delivery-signature-missing", "Delivery-Signatur fehlt"),
        ("operational-v2-native-validation-missing", "Native Operational-v2-Pruefung fehlt"),
    ], readonly=True, copy=False)
    expected_operational_state_hash = fields.Char(readonly=True, copy=False)
    operational_state_hash = fields.Char(readonly=True, copy=False)
    operational_provenance_sha256 = fields.Char(readonly=True, copy=False)
    operational_execution_proof_sha256 = fields.Char(readonly=True, copy=False)
    operational_validator_sha256 = fields.Char(readonly=True, copy=False)
    operational_authority_status = fields.Selection([("missing", "Build-Authority fehlt"), ("verified", "Build-Authority geprueft")], readonly=True, copy=False)
    operational_authority_sha256 = fields.Char(readonly=True, copy=False)
    operational_rebuild_attestation_sha256 = fields.Char(readonly=True, copy=False)
    operational_execution_authority_attestation_sha256 = fields.Char(readonly=True, copy=False)
    operational_outer_execution_receipt_sha256 = fields.Char(readonly=True, copy=False)
    operational_outer_execution_completion_sha256 = fields.Char(readonly=True, copy=False)
    operational_authority_source_commit = fields.Char(readonly=True, copy=False)
    game_finalization_nonce = fields.Char(readonly=True, copy=False)
    game_finalization_requested_at = fields.Char(readonly=True, copy=False)
    game_finalization_receipt_sha256 = fields.Char(readonly=True, copy=False)
    game_finalization_key_id = fields.Char(readonly=True, copy=False)
    activation_eligible = fields.Boolean(readonly=True, copy=False, default=False)
    failure_code = fields.Char(readonly=True, copy=False)
    failure_detail = fields.Text(readonly=True, copy=False)
    adoption_request_id = fields.Many2one("zugfolge.admin.request", readonly=True, copy=False, ondelete="restrict")

    _import_id_unique = models.Constraint(
        "unique(import_id)",
        "Die Import-ID muss eindeutig sein.",
    )

    _DRAFT_FIELDS = frozenset({"manifest_attachment_ids", "part_attachment_ids", "world_projection_id"})
    _INTERNAL_FIELDS = frozenset({
        "state", "manifest_bytes", "manifest_sha256", "package_id", "package_version", "delivery_release_id", "part_count",
        "total_part_bytes", "part_inventory", "verification_inventory_sha256", "verification_started_at", "verification_completed_at",
        "verified_by_id", "staging_requested_at", "staged_at", "game_stage_result", "signature_status",
        "infra_release_hash", "timetable_year",
        "native_operational_validation_status", "activation_blocker", "expected_operational_state_hash", "operational_state_hash",
        "operational_provenance_sha256", "operational_execution_proof_sha256", "operational_validator_sha256",
        "operational_authority_status", "operational_authority_sha256", "operational_rebuild_attestation_sha256",
        "operational_execution_authority_attestation_sha256", "operational_outer_execution_receipt_sha256",
        "operational_outer_execution_completion_sha256", "operational_authority_source_commit",
        "game_finalization_nonce", "game_finalization_requested_at", "game_finalization_receipt_sha256", "game_finalization_key_id",
        "activation_eligible",
        "failure_code", "failure_detail", "adoption_request_id",
    })

    @api.depends("import_id", "delivery_release_id")
    def _compute_name(self):
        for record in self:
            record.name = record.delivery_release_id or _("Jahresimport %s") % (record.import_id or "")

    @api.model_create_multi
    def create(self, values_list):
        if not self.env.user.has_group("zugfolge_admin.group_zugfolge_infra_reviewer"):
            raise AccessError(_("Nur InfraReviewer duerfen Jahresimporte anlegen."))
        allowed = self._DRAFT_FIELDS | {"import_id"}
        for values in values_list:
            unexpected = set(values) - allowed
            if unexpected:
                raise AccessError(_("Auditfelder duerfen beim Import nicht vorgegeben werden: %s") % ", ".join(sorted(unexpected)))
        return super().create(values_list)

    def write(self, values):
        capability = self.env.context.get(_INTERNAL_WRITE_CONTEXT_KEY)
        if capability is _INTERNAL_WRITE_CAPABILITY:
            if set(values) - self._INTERNAL_FIELDS:
                raise AccessError(_("Interner Importpfad darf keine Benutzereingaben veraendern."))
            return super().write(values)
        if _INTERNAL_WRITE_CONTEXT_KEY in self.env.context or "zugfolge_infra_import_internal" in self.env.context:
            raise AccessError(_("Die interne Import-Auditspur kann nicht ueber einen RPC-Kontext freigegeben werden."))
        if not self.env.user.has_group("zugfolge_admin.group_zugfolge_infra_reviewer"):
            raise AccessError(_("Nur InfraReviewer duerfen Jahresimporte bearbeiten."))
        if set(values) - self._DRAFT_FIELDS or any(record.state != "draft" for record in self):
            raise AccessError(_("Nach Beginn der Pruefung ist die Import-Auditspur unveraenderlich."))
        return super().write(values)

    def _internal_write(self, values):
        self._require_reviewer()
        return self.with_context(**{_INTERNAL_WRITE_CONTEXT_KEY: _INTERNAL_WRITE_CAPABILITY}).write(values)

    def _require_reviewer(self):
        if not self.env.user.has_group("zugfolge_admin.group_zugfolge_infra_reviewer"):
            raise AccessError(_("Nur InfraReviewer duerfen diesen Schritt ausfuehren."))

    def _require_importer(self):
        if any(record.importer_id != self.env.user for record in self):
            raise AccessError(_("Nur der protokollierte Uploader darf den Import weiterreichen; die spaetere Freigabe braucht eine andere Person."))

    def action_verify(self):
        self._require_reviewer()
        self._require_importer()
        for record in self:
            if record.state != "draft":
                raise UserError(_("Nur ein Entwurf kann geprueft werden."))
            if len(record.manifest_attachment_ids) != 1 or not record.part_attachment_ids:
                raise ValidationError(_("Manifest und alle Paketteile muessen angehaengt sein."))
            record._internal_write({"state": "verifying", "verification_started_at": fields.Datetime.now(), "verified_by_id": self.env.user.id})
            record.with_delay(description="Zugfolge InfraRelease-Paket pruefen")._verify_job()
        return True

    def _verification_values(self):
        self.ensure_one()
        if len(self.manifest_attachment_ids) != 1:
            raise ValidationError(_("Der Import braucht genau einen Manifestanhang."))
        manifest_attachment = self.manifest_attachment_ids[0]
        if manifest_attachment.name != "manifest.json":
            raise ValidationError(_("Der Manifestanhang muss manifest.json heissen."))
        manifest_path = _attachment_path(manifest_attachment)
        manifest_proof = _hash_file(manifest_path)
        if manifest_proof["bytes"] > MAX_MANIFEST_BYTES:
            raise ValidationError(_("Paketmanifest ist zu gross."))
        with open(manifest_path, "rb") as source:
            raw = source.read(MAX_MANIFEST_BYTES + 1)
        parsed = _parse_package_manifest(raw)
        attachments = {}
        for attachment in self.part_attachment_ids:
            if "/" in attachment.name or "\\" in attachment.name or attachment.name in attachments:
                raise ValidationError(_("Paketteilanhaenge brauchen eindeutige reine Dateinamen."))
            attachments[attachment.name] = attachment
        expected_names = {part["filename"] for part in parsed["parts"]}
        if set(attachments) != expected_names:
            raise ValidationError(_("Angehaengte Paketteile entsprechen nicht exakt dem Manifestinventar."))
        inventory = {}
        audit_inventory = []
        for part in parsed["parts"]:
            attachment = attachments[part["filename"]]
            observed = _hash_file(_attachment_path(attachment))
            if observed["bytes"] != part["bytes"] or observed["sha256"] != part["sha256"]:
                raise ValidationError(_("Paketteil %s stimmt nicht mit Bytezahl oder SHA-256 ueberein.") % part["package_path"])
            item = {**part, "attachment_id": attachment.id}
            audit_inventory.append(item)
            inventory[part["package_path"]] = {**item, "attachment": attachment}
        qualification = _qualify_public_delivery(parsed, inventory)
        operational_file = next(entry for entry in parsed["files"] if entry["kind"] == OPERATIONAL_INFRASTRUCTURE_KIND)
        inventory_bytes = json.dumps(audit_inventory, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        return parsed, audit_inventory, {
            "manifest_bytes": manifest_proof["bytes"],
            "manifest_sha256": manifest_proof["sha256"],
            "package_id": parsed["package_id"],
            "package_version": parsed["version"],
            "delivery_release_id": qualification["delivery_release_id"],
            "infra_release_hash": qualification["infra_release_hash"],
            "timetable_year": qualification["timetable_year"],
            "part_count": len(audit_inventory),
            "total_part_bytes": sum(item["bytes"] for item in audit_inventory),
            "part_inventory": audit_inventory,
            "verification_inventory_sha256": hashlib.sha256(inventory_bytes).hexdigest(),
            "signature_status": qualification["signature_status"],
            "expected_operational_state_hash": operational_file["stateHash"],
            "operational_provenance_sha256": qualification["operational_provenance_sha256"],
            "operational_execution_proof_sha256": qualification["operational_execution_proof_sha256"],
            "operational_validator_sha256": qualification["operational_validator_sha256"],
            "operational_authority_status": "missing",
            "operational_authority_sha256": qualification["operational_authority_sha256"],
            "operational_rebuild_attestation_sha256": qualification["operational_rebuild_attestation_sha256"],
            "operational_execution_authority_attestation_sha256": qualification["operational_execution_authority_attestation_sha256"],
            "operational_outer_execution_receipt_sha256": qualification["operational_outer_execution_receipt_sha256"],
            "operational_outer_execution_completion_sha256": qualification["operational_outer_execution_completion_sha256"],
            "operational_authority_source_commit": qualification["operational_authority_source_commit"],
            "activation_eligible": qualification["activation_eligible"],
        }

    def _mark_failed(self, code, error):
        detail = str(error).replace("\x00", "")[:2000]
        self._internal_write({"state": "failed", "failure_code": code, "failure_detail": detail, "activation_eligible": False})

    def _mark_staging_retryable(self, error):
        detail = str(error).replace("\x00", "")[:2000]
        self._internal_write({
            "state": "verified",
            "failure_code": "staging_retryable",
            "failure_detail": detail,
            "activation_eligible": False,
        })

    def _verify_job(self):
        self.ensure_one()
        if self.state == "verified":
            return True
        if self.state != "verifying":
            raise UserError(_("Import befindet sich nicht in der Pruefung."))
        try:
            _parsed, _inventory, values = self._verification_values()
            self._internal_write({**values, "state": "verified", "verification_completed_at": fields.Datetime.now(), "failure_code": False, "failure_detail": False})
        except Exception as error:  # queue_job muss den fehlgeschlagenen Auditdatensatz erhalten
            self._mark_failed("verification_failed", error)
        return True

    def _staging_payload(self):
        parsed, inventory, values = self._verification_values()
        if values["manifest_sha256"] != self.manifest_sha256 or values["verification_inventory_sha256"] != self.verification_inventory_sha256:
            raise ValidationError(_("Anhaenge wurden nach der Pruefung veraendert."))
        by_attachment = {attachment.id: attachment for attachment in self.part_attachment_ids}
        parts = []
        for item in inventory:
            attachment = by_attachment.get(item["attachment_id"])
            if not attachment:
                raise ValidationError(_("Ein gepruefter Paketteilanhang fehlt."))
            parts.append({**item, "path": _attachment_path(attachment)})
        return parsed, {
            "bytes": self.manifest_bytes,
            "sha256": self.manifest_sha256,
            "path": _attachment_path(self.manifest_attachment_ids[0]),
        }, parts

    def action_stage(self):
        self._require_reviewer()
        self._require_importer()
        for record in self:
            if record.state != "verified":
                raise UserError(_("Nur ein geprueftes Paket kann bereitgestellt werden."))
            values = {
                "staging_requested_at": fields.Datetime.now(),
                "failure_code": False,
                "failure_detail": False,
            }
            if not record.game_finalization_nonce:
                values["game_finalization_nonce"] = secrets.token_hex(32)
            record._internal_write(values)
            record.with_delay(description="Zugfolge InfraRelease-Paket an Game bereitstellen")._stage_job()
        return True

    def _stage_job(self):
        self.ensure_one()
        if self.state == "staged":
            return True
        if self.state != "verified":
            raise UserError(_("Import ist nicht geprueft."))
        try:
            _parsed, manifest, parts = self._staging_payload()
            if not self.game_finalization_nonce or not FINALIZATION_NONCE.fullmatch(self.game_finalization_nonce):
                raise ValidationError(_("Persistierte Game-Finalisierungsnonce fehlt oder ist ungueltig."))
        except Exception as error:  # lokale Vertragsfehler sind terminal
            self._mark_failed("staging_failed", error)
            return True
        try:
            result = stage_infra_package(self.env, self.import_id, manifest, parts, self.game_finalization_nonce)
        except Exception as error:  # Remote-Commit kann trotz verlorener Antwort bereits erfolgt sein
            self._mark_staging_retryable(error)
            return True
        try:
            receipt = verify_infra_finalization_receipt(self.env, result, {
                "importId": self.import_id,
                "packageId": self.package_id,
                "packageVersion": self.package_version,
                "manifestSha256": self.manifest_sha256,
                "deliveryReleaseId": self.delivery_release_id,
                "operationalStateHash": self.expected_operational_state_hash,
                "operationalProvenanceSha256": self.operational_provenance_sha256 or None,
                "operationalExecutionProofSha256": self.operational_execution_proof_sha256 or None,
                "operationalValidatorSha256": self.operational_validator_sha256 or None,
                "operationalAuthoritySha256": self.operational_authority_sha256 or None,
                "operationalRebuildAttestationSha256": self.operational_rebuild_attestation_sha256 or None,
                "operationalExecutionAuthorityAttestationSha256": self.operational_execution_authority_attestation_sha256 or None,
                "operationalOuterExecutionReceiptSha256": self.operational_outer_execution_receipt_sha256 or None,
                "operationalOuterExecutionCompletionSha256": self.operational_outer_execution_completion_sha256 or None,
                "operationalAuthoritySourceCommit": self.operational_authority_source_commit or None,
            }, self.game_finalization_nonce)
            expected_remote_signature = "verified" if self.signature_status == "present" else "missing"
            if receipt["signatureStatus"] != expected_remote_signature:
                raise ValidationError(_("Game-Signaturstatus widerspricht dem lokal geprueften Delivery-Vertrag."))
            receipt_bytes = json.dumps(receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
            self._internal_write({
                "state": "staged", "staged_at": fields.Datetime.now(), "game_stage_result": result,
                "signature_status": receipt["signatureStatus"],
                "native_operational_validation_status": receipt["nativeOperationalValidationStatus"],
                "activation_blocker": receipt["activationBlocker"] or False,
                "operational_state_hash": receipt["operationalStateHash"] or False,
                "operational_authority_status": receipt.get("operationalAuthorityStatus") or "missing",
                "game_finalization_requested_at": receipt["requestedAt"],
                "game_finalization_receipt_sha256": hashlib.sha256(receipt_bytes).hexdigest(),
                "game_finalization_key_id": receipt["keyId"],
                "activation_eligible": receipt["activationEligible"] is True,
                "failure_code": False, "failure_detail": False,
            })
        except Exception as error:  # eine erhaltene, aber ungueltige Antwort ist terminal
            self._mark_failed("staging_failed", error)
        return True

    def action_create_adoption_request(self):
        self._require_reviewer()
        self._require_importer()
        self.ensure_one()
        current_operational = _delivery_v2_generation(self.package_version) == "integrated-provenance-v2"
        if (
            self.state != "staged"
            or not self.activation_eligible
            or self.signature_status != "verified"
            or self.native_operational_validation_status != "verified"
            or self.activation_blocker
            or self.operational_state_hash != self.expected_operational_state_hash
            or not SHA256.fullmatch(self.game_finalization_receipt_sha256 or "")
            or not FINALIZATION_NONCE.fullmatch(self.game_finalization_nonce or "")
            or not self.game_finalization_requested_at
            or not self.game_finalization_key_id
            or not SHA256.fullmatch(self.infra_release_hash or "")
            or not isinstance(self.timetable_year, int)
            or self.delivery_release_id != "infra-deutschland-%s" % self.package_version
            or (
                current_operational
                and not all(SHA256.fullmatch(value or "") for value in (
                    self.operational_provenance_sha256,
                    self.operational_execution_proof_sha256,
                    self.operational_validator_sha256,
                    self.operational_authority_sha256,
                    self.operational_rebuild_attestation_sha256,
                    self.operational_execution_authority_attestation_sha256,
                    self.operational_outer_execution_receipt_sha256,
                    self.operational_outer_execution_completion_sha256,
                ))
            )
            or (current_operational and (
                self.operational_authority_status != "verified"
                or not GIT_COMMIT.fullmatch(self.operational_authority_source_commit or "")
            ))
            or isinstance(self.timetable_year, bool)
            or self.timetable_year < 2026
        ):
            raise UserError(_("Nur ein vom Game erneut gepruefter, signierter und bereitgestellter Release darf in die Vier-Augen-Freigabe."))
        if self.adoption_request_id:
            return {"type": "ir.actions.act_window", "res_model": "zugfolge.admin.request", "res_id": self.adoption_request_id.id, "view_mode": "form"}
        if not self.world_projection_id:
            raise ValidationError(_("Fuer die Uebernahme muss eine Welt gewaehlt sein."))
        request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.world_projection_id.id,
            "action_type": "infra_release_adoption",
            "risk_class": "high",
            "reason": _("Jahresimport %s nach separater Game-Qualifikation uebernehmen.") % self.delivery_release_id,
            "effect_preview": {
                "kind": "infra-release",
                "importId": self.import_id,
                "deliveryReleaseId": self.delivery_release_id,
                "manifestSha256": self.manifest_sha256,
                "infraReleaseHash": self.infra_release_hash,
            },
            "release_hash": self.infra_release_hash,
        })
        self._internal_write({"adoption_request_id": request.id})
        return {"type": "ir.actions.act_window", "res_model": "zugfolge.admin.request", "res_id": request.id, "view_mode": "form"}
