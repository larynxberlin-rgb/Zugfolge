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
