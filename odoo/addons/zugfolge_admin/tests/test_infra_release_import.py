import hashlib
import json
from unittest.mock import patch

from odoo import Command
from odoo.exceptions import AccessError, UserError
from odoo.tests.common import TransactionCase

from .. import services as service_module
from ..models import infra_release_import as import_module


def _sha256(value):
    return hashlib.sha256(value).hexdigest()


def _compact(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _fixture(raw_data_policy_field="nonPublicSourceRawDataShipped"):
    quality = _compact({
        "schema": "zugfolge-final-infrastructure-quality-report/v1",
        "releaseId": "infra-deutschland-2026.1",
        "policy": {
            "classAFromSingleSourceOrAutomatedInference": False,
            "classC": "visible but not orderable",
            raw_data_policy_field: False,
        },
        "summary": {"visibleLayers": 10, "visibleFeatures": 42},
    })
    sources = _compact({
        "schema": "zugfolge-map-delivery-sources/v1",
        "releaseId": "infra-deutschland-2026.1",
        "sources": [{
            "approved": True,
            "attribution": "© OpenStreetMap-Mitwirkende; Basemap-Aufbereitung Protomaps",
            "id": "basemap-protomaps",
            "license": "ODbL-1.0",
        }],
    })
    base_files = [
        {"id": "basemap", "kind": "basemap", "installPath": "basemap.pmtiles", "content": b"basemap"},
        {"id": "glyph", "kind": "glyph", "installPath": "assets/fonts/font.pbf", "content": b"glyph"},
        {"id": "infrastructure", "kind": "infrastructure", "installPath": "infra.pmtiles", "content": b"infra"},
        {"id": "quality", "kind": "quality-manifest", "installPath": "manifests/quality.json", "content": quality},
        {"id": "read-model", "kind": "read-model", "installPath": "read-model.sqlite", "content": b"read-model"},
        {"id": "sprite", "kind": "sprite", "installPath": "assets/sprites/dark.png", "content": b"sprite"},
        {"id": "style", "kind": "style", "installPath": "style.json", "content": b"{}"},
        {"id": "train-projection", "kind": "train-map-projection", "installPath": "train-map-projection.sqlite", "content": b"train-projection"},
    ]
    artifacts = sorted([{
        "id": entry["id"], "kind": entry["kind"], "installPath": entry["installPath"],
        "bytes": len(entry["content"]), "sha256": _sha256(entry["content"]),
    } for entry in base_files], key=lambda entry: entry["id"])
    release = _compact({
        "schema": "zugfolge-map-delivery-release/v1",
        "releaseId": "infra-deutschland-2026.1",
        "packageId": "zugfolge-map-deutschland",
        "packageVersion": "2026.1",
        "artifacts": artifacts,
        "bindings": {
            "packageManifestSchema": "zugfolge-map-package/v1",
            "qualitySha256": _sha256(quality),
            "sourcesSha256": _sha256(sources),
        },
        "approvalGates": {
            "quality": {"status": "passed"},
            "rights": {"status": "passed"},
            "signature": {"status": "missing"},
        },
        "signature": None,
    })
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
            "bytes": len(entry["content"]), "sha256": _sha256(entry["content"]),
            "parts": [{"path": path, "bytes": len(entry["content"]), "sha256": _sha256(entry["content"])}],
        })
        parts.append((path.rsplit("/", 1)[-1], entry["content"]))
    manifest = _canonical({
        "schema": "zugfolge-map-package/v1",
        "packageId": "zugfolge-map-deutschland",
        "version": "2026.1",
        "format": "directory-parts",
        "partBytes": 100 * 1024 * 1024,
        "artifacts": [entry for entry in descriptors if entry["kind"] in ("basemap", "infrastructure")],
        "auxiliaryFiles": [entry for entry in descriptors if entry["kind"] not in ("basemap", "infrastructure")],
    })
    return manifest, parts


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

    def _verify(self, record):
        record.action_verify()
        self.assertEqual(record.state, "verifying")
        record._verify_job()
        self.assertEqual(record.state, "verified", record.failure_detail)
        return record

    def test_only_infra_reviewer_can_create_import_and_role_does_not_imply_approver(self):
        self.assertFalse(self.reviewer.has_group("zugfolge_admin.group_zugfolge_approver"))
        with self.assertRaises(AccessError):
            self.env["zugfolge.infra.release.import"].with_user(self.outsider).create({})

    def test_streaming_verification_persists_immutable_exact_audit_and_missing_signature_gate(self):
        record = self._verify(self._create_import())
        self.assertEqual(record.delivery_release_id, "infra-deutschland-2026.1")
        self.assertEqual(record.signature_status, "missing")
        self.assertFalse(record.activation_eligible)
        self.assertEqual(record.part_count, len(self.part_attachments))
        self.assertRegex(record.manifest_sha256, r"^[a-f0-9]{64}$")
        self.assertRegex(record.verification_inventory_sha256, r"^[a-f0-9]{64}$")
        with self.assertRaises(AccessError):
            record.write({"part_attachment_ids": [Command.clear()]})
        with self.assertRaises(UserError):
            record.action_create_adoption_request()

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
        result = {
            "accepted": True,
            "packageId": record.package_id,
            "packageVersion": record.package_version,
            "manifestSha256": record.manifest_sha256,
            "deliveryReleaseId": record.delivery_release_id,
            "signatureStatus": "missing",
            "activationEligible": False,
        }
        with patch.object(import_module, "stage_infra_package", return_value=result) as staged:
            record.action_stage()
            self.assertTrue(record.staging_requested_at)
            record._stage_job()
        self.assertEqual(record.state, "staged")
        self.assertFalse(record.activation_eligible)
        staged.assert_called_once()

    def test_stage_rejects_unauthenticated_verified_activation_claim(self):
        record = self._verify(self._create_import())
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
                return _Response({"accepted": True})
            self.assertEqual(kwargs.get("data"), b"")
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
            result = service_module.stage_infra_package(self.env, record.import_id, manifest, parts)
        self.assertEqual(result["signatureStatus"], "missing")
        self.assertEqual(len(post_calls), 2)

    def test_corrupt_part_fails_closed_and_remains_auditable(self):
        record = self._create_import()
        record.action_verify()
        self.part_attachments[0].write({"raw": b"corrupt"})
        record._verify_job()
        self.assertEqual(record.state, "failed")
        self.assertEqual(record.failure_code, "verification_failed")
        self.assertFalse(record.activation_eligible)

    def test_legacy_raw_data_policy_field_is_rejected(self):
        manifest, parts = _fixture("internalStationPlanRawDataShipped")
        manifest_attachment = self.env["ir.attachment"].create({"name": "manifest.json", "type": "binary", "raw": manifest, "mimetype": "application/json"})
        part_attachments = self.env["ir.attachment"]
        for name, content in parts:
            part_attachments |= self.env["ir.attachment"].create({"name": name, "type": "binary", "raw": content, "mimetype": "application/octet-stream"})
        record = self.env["zugfolge.infra.release.import"].with_user(self.reviewer).create({
            "manifest_attachment_ids": [Command.set(manifest_attachment.ids)],
            "part_attachment_ids": [Command.set(part_attachments.ids)],
        })
        record.action_verify()
        record._verify_job()
        self.assertEqual(record.state, "failed")
        self.assertEqual(record.failure_code, "verification_failed")
        self.assertIn("konservativen Zehn-Layer-Vertrag", record.failure_detail)
