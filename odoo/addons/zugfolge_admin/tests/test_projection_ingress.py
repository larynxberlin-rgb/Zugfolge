import hashlib
import hmac
import json
from datetime import datetime, timezone

from odoo.tests import HttpCase, tagged


@tagged("post_install", "-at_install")
class TestProjectionIngress(HttpCase):
    KEY_ID = "projection-ingress-test"
    SECRET = "projection-ingress-test-secret"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.env["ir.config_parameter"].sudo().set_param(
            "zugfolge_admin.projection_keys_json",
            json.dumps({cls.KEY_ID: cls.SECRET}),
        )

    def _post_projection(self, payload):
        timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        signature = hmac.new(
            self.SECRET.encode("utf-8"),
            (timestamp + "." + canonical).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return self.url_open(
            "/zugfolge/projection",
            data=json.dumps(payload),
            headers={
                "Content-Type": "application/json",
                "X-Zugfolge-Odoo-Key-Id": self.KEY_ID,
                "X-Zugfolge-Odoo-Timestamp": timestamp,
                "X-Zugfolge-Odoo-Signature": signature,
            },
        )

    def _world_start(self, message_id, world_id, deployment_hash, revision):
        return {
            "schemaVersion": "zugfolge-odoo/v1",
            "messageId": message_id,
            "messageType": "world.projection",
            "worldId": world_id,
            "correlationId": "world-start:%s:%s" % (world_id, revision),
            "occurredAt": "2026-08-10T00:00:00Z",
            "payload": {
                "worldName": "Ingress-Weltstart",
                "projectionRevision": deployment_hash,
                "projectionKind": "zugfolge-authoritative-world-start-projection/v1",
                "authoritative": True,
                "freshness": "live",
                "profileKind": "public",
                "blueprintHash": str(revision) * 64,
                "deploymentHash": deployment_hash,
                "deploymentRevision": revision,
                "deploymentAuthorization": {
                    "schemaVersion": "zugfolge-authoritative-world-start-projection/v1",
                    "deploymentHash": deployment_hash,
                    "deploymentRevision": revision,
                    "algorithm": "Ed25519",
                    "keyId": "alpha-release-2026",
                    "valueBase64": "A" * 86 + "==",
                },
            },
        }

    def test_invalid_timestamp_rolls_back_receipt_and_allows_corrected_replay(self):
        message_id = "projection-poison-receipt-test"
        world_id = "22222222-2222-4222-8222-222222222222"
        payload = {
            "schemaVersion": "zugfolge-odoo/v1",
            "messageId": message_id,
            "messageType": "world.projection",
            "worldId": world_id,
            "correlationId": "projection-poison-receipt-correlation",
            "occurredAt": "2026-08-13 18:00:00",
            "payload": {
                "worldName": "Ingress-Testwelt",
                "projectionRevision": "1",
                "freshness": "delayed",
            },
        }

        invalid_response = self._post_projection(payload)
        self.assertEqual(invalid_response.status_code, 200)
        self.assertIn("error", json.loads(invalid_response.text))
        self.assertFalse(self.env["zugfolge.projection.receipt"].sudo().search([("message_id", "=", message_id)]))
        self.assertFalse(self.env["zugfolge.world.projection"].sudo().search([("world_id", "=", world_id)]))

        payload["occurredAt"] = "2026-08-13T16:00:00Z"
        corrected_response = self._post_projection(payload)
        self.assertEqual(corrected_response.status_code, 200)
        result = json.loads(corrected_response.text)["result"]
        self.assertEqual(result, {"accepted": True, "messageId": message_id})
        self.assertTrue(self.env["zugfolge.projection.receipt"].sudo().search([("message_id", "=", message_id)]))
        projection = self.env["zugfolge.world.projection"].sudo().search([("world_id", "=", world_id)])
        self.assertEqual(projection.world_name, "Ingress-Testwelt")

    def test_signed_world_start_is_idempotent_and_other_envelope_cannot_change_hash(self):
        world_id = "33333333-3333-4333-8333-333333333333"
        first = self._world_start("signed-world-start-1", world_id, "a" * 64, 1)
        accepted = json.loads(self._post_projection(first).text)["result"]
        self.assertEqual(accepted, {"accepted": True, "messageId": "signed-world-start-1"})

        duplicate = json.loads(self._post_projection(first).text)["result"]
        self.assertEqual(duplicate, {
            "accepted": True,
            "messageId": "signed-world-start-1",
            "duplicate": True,
        })
        projection = self.env["zugfolge.world.projection"].sudo().search([("world_id", "=", world_id)])
        self.assertEqual(projection.deployment_hash, "a" * 64)
        self.assertEqual(len(projection.deployment_audit_ids), 1)

        wrong_type = self._world_start("signed-world-start-wrong-type", world_id, "b" * 64, 2)
        wrong_type["messageType"] = "admin.capability.projection"
        rejected = json.loads(self._post_projection(wrong_type).text)["result"]
        self.assertEqual(rejected, {"accepted": False, "code": "invalid_projection_type"})
        self.assertFalse(self.env["zugfolge.projection.receipt"].sudo().search([
            ("message_id", "=", "signed-world-start-wrong-type"),
        ]))
        projection.invalidate_recordset()
        self.assertEqual(projection.deployment_hash, "a" * 64)
        self.assertEqual(len(projection.deployment_audit_ids), 1)
