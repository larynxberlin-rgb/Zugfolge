import base64
from copy import deepcopy
import hashlib
import hmac
import json
from datetime import datetime, timezone

from odoo.tests import HttpCase, tagged

from ..models.canonical_json import canonical_json
from .test_demand_data_contract import release_fixture


@tagged("post_install", "-at_install")
class TestDemandDataIngress(HttpCase):
    KEY_ID = "demand-data-test"
    SECRET = "demand-data-test-secret"

    def setUp(self):
        super().setUp()
        self.env["ir.config_parameter"].sudo().set_param(
            "zugfolge_admin.projection_keys_json", json.dumps({self.KEY_ID: self.SECRET}),
        )
        self.data = self.env["zugfolge.demand.data"].with_user(self.env.ref("base.user_admin")).create({
            "world_id": "33333333-3333-4333-8333-333333333333",
            "initial_file": base64.b64encode(json.dumps(release_fixture()).encode()),
        })
        self.data.action_import()
        self.event = self.data.event_ids[:1]

    def _payload(self):
        return {
            "schemaVersion": "zugfolge-odoo/v1", "messageId": "demand-data-result-test",
            "messageType": "demand.data.result", "worldId": self.data.world_id,
            "correlationId": self.event.correlation_id, "occurredAt": "2026-09-06T12:00:00Z",
            "payload": {"baseReleaseId": self.data.base_release_id,
                        "sourceRevision": self.event.source_revision, "outcome": "accepted"},
        }

    def _post(self, payload, invalid_signature=False):
        timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        digest = hmac.new(self.SECRET.encode(), (timestamp + "." + canonical_json(payload)).encode(), hashlib.sha256).hexdigest()
        response = self.url_open("/zugfolge/projection", data=json.dumps(payload), headers={
            "Content-Type": "application/json", "X-Zugfolge-Odoo-Key-Id": self.KEY_ID,
            "X-Zugfolge-Odoo-Timestamp": timestamp,
            "X-Zugfolge-Odoo-Signature": "0" * 64 if invalid_signature else digest,
        })
        self.assertEqual(response.status_code, 200)
        return json.loads(response.text)["result"]

    def test_signed_result_applies_once_and_cannot_be_rewritten(self):
        payload = self._payload()
        self.assertEqual(self._post(payload), {"accepted": True, "messageId": payload["messageId"]})
        self.event.invalidate_recordset()
        self.assertEqual(self.event.state, "accepted")
        self.assertEqual(self._post(payload), {"accepted": True, "messageId": payload["messageId"], "duplicate": True})
        altered = deepcopy(payload)
        altered["payload"]["outcome"] = "rejected"
        self.assertEqual(self._post(altered), {"accepted": False, "code": "replay_conflict"})
        self.assertEqual(self.env["zugfolge.projection.receipt"].sudo().search_count([("message_id", "=", payload["messageId"])]), 1)
        self.assertEqual(self.event.state, "accepted")

    def test_result_binds_signature_world_basis_revision_and_correlation(self):
        payload = self._payload()
        self.assertEqual(self._post(payload, invalid_signature=True), {"accepted": False, "code": "invalid_signature"})
        variants = []
        for field, value in (("worldId", "44444444-4444-4444-8444-444444444444"), ("correlationId", "foreign-event")):
            changed = deepcopy(payload)
            changed[field] = value
            variants.append(changed)
        for field, value in (("baseReleaseId", "foreign-basis"), ("sourceRevision", self.event.source_revision + 1)):
            changed = deepcopy(payload)
            changed["payload"][field] = value
            variants.append(changed)
        for changed in variants:
            with self.subTest(payload=changed):
                self.assertEqual(self._post(changed), {"accepted": False, "code": "missing_target"})
                self.assertFalse(self.env["zugfolge.projection.receipt"].sudo().search([("message_id", "=", payload["messageId"])]))
        changed = deepcopy(payload)
        changed["payload"]["sourceRevision"] = True
        self.assertEqual(self._post(changed), {"accepted": False, "code": "invalid_schema"})
        payload["payload"].update({"outcome": "rejected", "code": "station_binding", "detail": "Stationsbindung prüfen"})
        self.assertEqual(self._post(payload), {"accepted": True, "messageId": payload["messageId"]})
        self.event.invalidate_recordset()
        self.assertEqual(self.event.state, "rejected")
        self.assertEqual(self.event.detail, "Stationsbindung prüfen")
