from odoo.addons.account.tests.common import AccountTestInvoicingCommon


class TestWorldPaymentParticipation(AccountTestInvoicingCommon):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.world_id = "11111111-1111-4111-8111-111111111111"
        cls.partner_a.zugfolge_keycloak_subject = "keycloak-payment-test"
        projection = cls.env["zugfolge.world.projection"].sudo().with_context(zugfolge_game_projection=True).create({
            "world_id": cls.world_id,
            "world_name": "Zahlungswelt",
            "projection_revision": "payment-test-1",
            "observed_at": "2026-08-13 06:00:00",
            "freshness": "delayed",
            "payload_hash": "a" * 64,
        })
        cls.product_a.product_tmpl_id.zugfolge_product_kind = "public_world_slot"
        cls.offer = cls.env["zugfolge.world.offer"].sudo().create({
            "projection_id": projection.id,
            "participation_conditions": "Bezahlte Teilnahme",
            "product_tmpl_id": cls.product_a.product_tmpl_id.id,
        })
        cls.sale_journal = cls.company_data["default_journal_sale"] or cls.env["account.journal"].create({
            "name": "Zugfolge Test Sales", "code": "ZFS", "type": "sale", "company_id": cls.env.company.id,
        })

    def test_paid_invoice_queues_exactly_one_world_participation(self):
        invoice = self.init_invoice(
            "out_invoice",
            partner=self.partner_a,
            post=True,
            products=[self.product_a],
            taxes=[],
            journal=self.sale_journal,
        )
        self._register_payment(invoice)
        invoice.invalidate_recordset()
        self.assertEqual(invoice.payment_state, "paid")

        participations = self.env["zugfolge.world.participation"].search([
            ("partner_id", "=", self.partner_a.id),
            ("world_id", "=", self.world_id),
        ])
        self.assertEqual(len(participations), 1)
        self.assertEqual(participations.state, "provisioning")
        first_key = participations.idempotency_key

        # Doppelte Provider-/Reconciliation-Zustellung darf keine zweite
        # Teilnahme und keinen neuen fachlichen Payment-Key erzeugen.
        invoice._sync_zugfolge_world_participation()
        invoice._sync_zugfolge_world_participation()
        replay = self.env["zugfolge.world.participation"].search([
            ("partner_id", "=", self.partner_a.id),
            ("world_id", "=", self.world_id),
        ])
        self.assertEqual(len(replay), 1)
        self.assertEqual(replay.idempotency_key, first_key)
