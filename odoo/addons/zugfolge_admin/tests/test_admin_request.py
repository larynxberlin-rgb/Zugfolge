from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests.common import TransactionCase


class TestZugfolgeAdminRequest(TransactionCase):
    def setUp(self):
        super().setUp()
        self.projection = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).create({
            "world_id": "11111111-1111-1111-1111-111111111111", "world_name": "Testwelt", "projection_revision": "1",
            "observed_at": "2026-01-01 00:00:00", "freshness": "delayed", "payload_hash": "a" * 64,
        })

    def test_projection_is_not_writable_by_staff(self):
        with self.assertRaises(AccessError):
            self.projection.write({"world_name": "Manipuliert"})

    def test_high_risk_request_rejects_self_approval(self):
        request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.projection.id, "action_type": "infra_release_adoption", "risk_class": "high",
            "reason": "Nachweis", "effect_preview": {}, "release_hash": "a" * 64,
            "requested_period_start": "2026-02-01 00:00:00",
        })
        request.action_submit()
        with self.assertRaises(AccessError):
            request.action_approve()

    def test_reason_is_mandatory(self):
        with self.assertRaises(ValidationError):
            self.env["zugfolge.admin.request"].create({
                "world_projection_id": self.projection.id, "action_type": "world_access_revoke", "reason": " ", "effect_preview": {},
            })

    def test_manual_disruption_is_prepared_but_cannot_dispatch_before_m8_capability(self):
        request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.projection.id, "action_type": "manual_disruption_create", "risk_class": "high",
            "reason": "Gemaess manueller Meldung", "effect_preview": {"note": "Game prueft Auswirkungen"},
            "manual_disruption_start": "2026-02-01 10:00:00", "manual_disruption_end": "2026-02-01 12:00:00",
            "manual_disruption_cause": "Weichenstoerung", "manual_disruption_resource_ids": ["switch:test:1"],
            "manual_disruption_effect": {"kind": "closure"},
        })
        self.assertEqual(request.game_capability_state, "prepared")
        request.with_context(zugfolge_game_projection=True).write({"state": "approved"})
        with self.assertRaises(UserError):
            request.action_dispatch()

    def test_capability_projection_cannot_be_created_by_staff(self):
        with self.assertRaises(AccessError):
            self.env["zugfolge.admin.capability"].create({
                "world_id": self.projection.world_id, "action_type": "manual_disruption_create", "availability": "available",
                "observed_at": "2026-01-01 00:00:00", "payload_hash": "a" * 64,
            })

    def test_invoice_without_product_mapping_emits_no_entitlement(self):
        invoice = self.env["account.move"].new({"move_type": "out_invoice", "zugfolge_subject_reference": "subject"})
        self.assertFalse(invoice._zugfolge_command_change())
