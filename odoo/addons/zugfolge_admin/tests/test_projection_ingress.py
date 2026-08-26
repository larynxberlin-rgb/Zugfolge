import hashlib
import hmac
import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from odoo.tests import HttpCase, tagged

from odoo.addons.zugfolge_admin.models.canonical_json import canonical_json, canonical_sha256
from odoo.addons.zugfolge_admin.services import signature


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
        canonical = canonical_json(payload)
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

    def _v1_v2_contract(self):
        fixture_path = Path(__file__).with_name("fixtures") / "v1_v2_postgres_odoo_contract.json"
        return json.loads(fixture_path.read_text(encoding="utf-8"))

    def _unicode_golden(self):
        fixture_path = Path(__file__).with_name("fixtures") / "projection_envelope_unicode_golden.json"
        return json.loads(fixture_path.read_text(encoding="utf-8"))

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

    def test_invalid_global_world_close_does_not_poison_corrected_message_id(self):
        message_id = "global-world-close-poison-receipt-test"
        target_world_id = "44444444-4444-4444-8444-444444444444"
        payload = {
            "schemaVersion": "zugfolge-odoo/v1",
            "messageId": message_id,
            "messageType": "admin.command.result",
            "worldId": "00000000-0000-0000-0000-000000000000",
            "correlationId": "global-world-close-poison-correlation",
            "occurredAt": "2026-08-25T16:00:00Z",
            "payload": {
                "actionType": "world_close",
                "targetWorldId": target_world_id,
                "outcome": "accepted",
                "state": "completed",
                "authoritative": True,
                "adminRequestId": "request-world-close-1",
                "gameAuditEventId": "audit-world-close-1",
                "eventId": "event-world-close-1",
                "finalStateHash": "a" * 64,
                "evidenceHash": "b" * 64,
                "replayHash": "c" * 64,
                "archivedAtS": 2419200,
            },
        }

        invalid = json.loads(self._post_projection(payload).text)["result"]
        self.assertEqual(invalid, {"accepted": False, "code": "invalid_schema"})
        receipts = self.env["zugfolge.projection.receipt"].sudo()
        self.assertFalse(receipts.search([("message_id", "=", message_id)]))

        payload["payload"]["projectionScope"] = "global-admin"
        missing = json.loads(self._post_projection(payload).text)["result"]
        self.assertEqual(missing, {"accepted": False, "code": "missing_target"})
        self.assertFalse(receipts.search([("message_id", "=", message_id)]))

        projection = self.env["zugfolge.world.projection"].sudo().with_context(
            zugfolge_game_projection=True,
        ).create({
            "world_id": target_world_id,
            "world_name": "Abschlussziel",
            "profile_kind": "public",
        })
        foreign_request = self.env["zugfolge.admin.request"].sudo().create({
            "world_projection_id": projection.id,
            "action_type": "infra_release_adoption",
            "risk_class": "high",
            "reason": "Fremde Aktion darf den Weltabschluss nicht quittieren",
            "effect_preview": {"kind": "infra-release"},
            "release_hash": "d" * 64,
            "requested_period_start": "2026-12-13 00:00:00",
        })
        foreign_request._write_controlled({"state": "dispatched"})
        payload["correlationId"] = foreign_request.correlation_id
        foreign = json.loads(self._post_projection(payload).text)["result"]
        self.assertEqual(foreign, {"accepted": False, "code": "missing_target"})
        self.assertFalse(receipts.search([("message_id", "=", message_id)]))

        close_request = self.env["zugfolge.admin.request"].sudo().create({
            "world_projection_id": projection.id,
            "action_type": "world_close",
            "risk_class": "high",
            "reason": "Dispatchter Antrag bindet den autoritativen Weltabschluss",
            "effect_preview": {"kind": "world-close"},
            "requested_at_s": payload["payload"]["archivedAtS"],
        })
        close_request._write_controlled({"state": "dispatched"})
        payload["correlationId"] = close_request.correlation_id
        accepted = json.loads(self._post_projection(payload).text)["result"]
        self.assertEqual(accepted, {"accepted": True, "messageId": message_id})
        self.assertEqual(receipts.search_count([("message_id", "=", message_id)]), 1)
        self.assertEqual(close_request.state, "completed")

        duplicate = json.loads(self._post_projection(payload).text)["result"]
        self.assertEqual(duplicate, {"accepted": True, "messageId": message_id, "duplicate": True})
        self.assertEqual(receipts.search_count([("message_id", "=", message_id)]), 1)

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
        receipt = self.env["zugfolge.projection.receipt"].sudo().search([
            ("message_id", "=", first["messageId"]),
        ])
        self.assertEqual(
            receipt.envelope_hash_schema,
            "zugfolge-projection-envelope-sha256/v1",
        )
        self.assertEqual(
            receipt.envelope_hash,
            canonical_sha256(first),
        )
        conflicting_type = deepcopy(first)
        conflicting_type["messageType"] = "admin.capability.projection"
        conflict = json.loads(self._post_projection(conflicting_type).text)["result"]
        self.assertEqual(conflict, {"accepted": False, "code": "replay_conflict"})
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

    def test_receipt_replay_binds_message_type_and_occurred_at(self):
        message_id = "full-envelope-receipt-binding"
        world_id = "55555555-5555-4555-8555-555555555555"
        payload = {
            "schemaVersion": "zugfolge-odoo/v1",
            "messageId": message_id,
            "messageType": "world.projection",
            "worldId": world_id,
            "correlationId": "full-envelope-receipt-binding-correlation",
            "occurredAt": "2026-08-25T18:00:00Z",
            "payload": {
                "worldName": "Voll gebundener Receipt",
                "projectionRevision": "1",
                "freshness": "delayed",
            },
        }

        accepted = json.loads(self._post_projection(payload).text)["result"]
        self.assertEqual(accepted, {"accepted": True, "messageId": message_id})

        changed_type = deepcopy(payload)
        changed_type["messageType"] = "public.world.snapshot"
        type_conflict = json.loads(self._post_projection(changed_type).text)["result"]
        self.assertEqual(type_conflict, {"accepted": False, "code": "replay_conflict"})

        changed_occurrence = deepcopy(payload)
        changed_occurrence["occurredAt"] = "2026-08-25T18:00:01Z"
        occurrence_conflict = json.loads(self._post_projection(changed_occurrence).text)["result"]
        self.assertEqual(occurrence_conflict, {"accepted": False, "code": "replay_conflict"})

        receipt = self.env["zugfolge.projection.receipt"].sudo().search([
            ("message_id", "=", message_id),
        ])
        self.assertEqual(len(receipt), 1)
        self.assertEqual(receipt.world_id, world_id)
        projection = self.env["zugfolge.world.projection"].sudo().search([("world_id", "=", world_id)])
        self.assertEqual(projection.projection_revision, "1")

    def test_unicode_envelope_matches_typescript_signature_and_reconciliation_golden(self):
        golden = self._unicode_golden()
        envelope = golden["envelope"]
        self.assertEqual(canonical_json(envelope), golden["canonical"])
        self.assertEqual(canonical_sha256(envelope), golden["envelopeSha256"])
        self.assertEqual(
            hmac.new(
                golden["secret"].encode("utf-8"),
                (golden["timestamp"] + "." + golden["canonical"]).encode("utf-8"),
                hashlib.sha256,
            ).hexdigest(),
            golden["hmacSha256"],
        )
        self.assertEqual(
            signature(golden["secret"], golden["timestamp"], envelope),
            golden["hmacSha256"],
        )
        with self.assertRaises(TypeError):
            canonical_json({"fraction": 1e-7})
        with self.assertRaises(TypeError):
            canonical_json({"unsafe": 9_007_199_254_740_992})

        accepted = json.loads(self._post_projection(envelope).text)["result"]
        self.assertEqual(accepted, {"accepted": True, "messageId": envelope["messageId"]})
        receipt = self.env["zugfolge.projection.receipt"].sudo().search([
            ("message_id", "=", envelope["messageId"]),
        ])
        self.assertEqual(receipt.envelope_hash, golden["envelopeSha256"])
        self.assertEqual(receipt.payload_hash, canonical_sha256(envelope["payload"]))
        projection = self.env["zugfolge.world.projection"].sudo().search([
            ("world_id", "=", envelope["worldId"]),
        ])
        self.assertEqual(projection.world_name, "Leipzig–Halle ÄÖÜ äöü ß")
        self.assertEqual(projection.payload_hash, canonical_sha256(envelope["payload"]))

    def test_legacy_body_only_receipt_rejects_lost_response_across_upgrade(self):
        message_id = "legacy-body-only-lost-response"
        world_id = "66666666-6666-4666-8666-666666666666"
        payload = {
            "schemaVersion": "zugfolge-odoo/v1",
            "messageId": message_id,
            "messageType": "world.projection",
            "worldId": world_id,
            "correlationId": "legacy-body-only-lost-response-correlation",
            "occurredAt": "2026-08-25T18:05:00Z",
            "payload": {
                "worldName": "Historischer Body-Receipt",
                "projectionRevision": "1",
                "freshness": "delayed",
            },
        }
        body_digest = canonical_sha256(payload["payload"])
        legacy_receipt = self.env["zugfolge.projection.receipt"].sudo().with_context(
            zugfolge_game_projection=True,
        ).create({
            "message_id": message_id,
            "world_id": world_id,
            "correlation_id": payload["correlationId"],
            "payload_hash": body_digest,
        })
        self.assertFalse(legacy_receipt.envelope_hash_schema)
        self.assertFalse(legacy_receipt.envelope_hash)

        replay = json.loads(self._post_projection(payload).text)["result"]
        self.assertEqual(replay, {"accepted": False, "code": "replay_conflict"})
        self.assertFalse(self.env["zugfolge.world.projection"].sudo().search([
            ("world_id", "=", world_id),
        ]))
        self.assertEqual(
            self.env["zugfolge.projection.receipt"].sudo().search_count([
                ("message_id", "=", message_id),
            ]),
            1,
        )

    def test_v1_v2_contract_keeps_revision_one_per_new_world_and_rejects_candidate_collision(self):
        contract = self._v1_v2_contract()
        self.assertEqual(contract["schema"], "zugfolge-v1-v2-postgres-odoo-contract/v1")

        predecessor_envelope = contract["odooPredecessorProjection"]
        predecessor_result = json.loads(self._post_projection(predecessor_envelope).text)["result"]
        self.assertEqual(predecessor_result, {
            "accepted": True,
            "messageId": predecessor_envelope["messageId"],
        })

        candidate_envelope = contract["odooProjection"]
        candidate_result = json.loads(self._post_projection(candidate_envelope).text)["result"]
        self.assertEqual(candidate_result, {
            "accepted": True,
            "messageId": candidate_envelope["messageId"],
        })

        projections = self.env["zugfolge.world.projection"].sudo()
        predecessor = projections.search([("world_id", "=", contract["predecessor"]["deployment"]["worldId"])])
        candidate = projections.search([("world_id", "=", contract["candidate"]["deployment"]["worldId"])])
        self.assertEqual(predecessor.deployment_hash, contract["predecessor"]["deploymentHash"])
        self.assertEqual(predecessor.deployment_revision, 1)
        self.assertEqual(candidate.deployment_hash, contract["candidate"]["deploymentHash"])
        self.assertEqual(candidate.deployment_revision, 1)
        self.assertEqual(candidate.deployment_authority_key_id, contract["trustedKey"]["keyId"])
        self.assertEqual(len(predecessor.deployment_audit_ids), 1)
        self.assertEqual(len(candidate.deployment_audit_ids), 1)

        duplicate = json.loads(self._post_projection(candidate_envelope).text)["result"]
        self.assertEqual(duplicate, {
            "accepted": True,
            "messageId": candidate_envelope["messageId"],
            "duplicate": True,
        })

        collision = deepcopy(candidate_envelope)
        collision["messageId"] = "0db56535-a466-44a8-a991-38a8a1f7566e"
        collision["correlationId"] = "v1-v2-contract-candidate-id-collision"
        collision["payload"]["projectionRevision"] = "9" * 64
        collision["payload"]["deploymentHash"] = "9" * 64
        collision["payload"]["deploymentAuthorization"]["deploymentHash"] = "9" * 64
        collision_response = json.loads(self._post_projection(collision).text)
        self.assertIn("error", collision_response)
        self.assertEqual(collision_response["error"]["data"]["name"], "odoo.exceptions.ValidationError")
        self.assertIn(
            "exakt naechste weltgebundene Revision",
            collision_response["error"]["data"]["message"],
        )
        self.assertFalse(self.env["zugfolge.projection.receipt"].sudo().search([
            ("message_id", "=", collision["messageId"]),
        ]))
        candidate.invalidate_recordset()
        self.assertEqual(candidate.deployment_hash, contract["candidate"]["deploymentHash"])
        self.assertEqual(candidate.deployment_revision, 1)
        self.assertEqual(len(candidate.deployment_audit_ids), 1)

        corrected = deepcopy(candidate_envelope)
        corrected["messageId"] = collision["messageId"]
        corrected["correlationId"] = collision["correlationId"]
        corrected_response = json.loads(self._post_projection(corrected).text)["result"]
        self.assertEqual(corrected_response, {
            "accepted": True,
            "messageId": collision["messageId"],
        })
        self.assertEqual(self.env["zugfolge.projection.receipt"].sudo().search_count([
            ("message_id", "=", collision["messageId"]),
        ]), 1)

        corrected_duplicate = json.loads(self._post_projection(corrected).text)["result"]
        self.assertEqual(corrected_duplicate, {
            "accepted": True,
            "messageId": collision["messageId"],
            "duplicate": True,
        })
        candidate.invalidate_recordset()
        self.assertEqual(candidate.deployment_hash, contract["candidate"]["deploymentHash"])
        self.assertEqual(candidate.deployment_revision, 1)
        self.assertEqual(len(candidate.deployment_audit_ids), 1)
