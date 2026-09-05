from odoo import Command
from unittest.mock import patch
from odoo.exceptions import AccessError
from odoo.addons.account.tests.common import AccountTestInvoicingCommon


class TestWorldPaymentParticipation(AccountTestInvoicingCommon):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        company = cls.env.company
        company.account_fiscal_country_id = cls.env.ref("base.us")
        accounts = cls.env["account.account"].create([
            {"name": "Zugfolge Receivable", "code": "11000", "account_type": "asset_receivable", "reconcile": True, "company_ids": [Command.set(company.ids)]},
            {"name": "Zugfolge Payable", "code": "12000", "account_type": "liability_payable", "reconcile": True, "company_ids": [Command.set(company.ids)]},
            {"name": "Zugfolge Revenue", "code": "40000", "account_type": "income", "company_ids": [Command.set(company.ids)]},
            {"name": "Zugfolge Expense", "code": "50000", "account_type": "expense", "company_ids": [Command.set(company.ids)]},
            {"name": "Zugfolge Bank", "code": "10000", "account_type": "asset_cash", "company_ids": [Command.set(company.ids)]},
            {"name": "Zugfolge Outstanding Receipts", "code": "13600", "account_type": "asset_current", "reconcile": True, "company_ids": [Command.set(company.ids)]},
        ])
        receivable, payable, revenue, expense, liquidity, outstanding_receipts = accounts
        cls.product_category.with_company(company).write({
            "property_account_income_categ_id": revenue.id,
            "property_account_expense_categ_id": expense.id,
        })
        cls.partner_a.with_company(company).write({
            "property_account_receivable_id": receivable.id,
            "property_account_payable_id": payable.id,
        })
        cls.world_id = "11111111-1111-4111-8111-111111111111"
        cls.partner_a._bind_zugfolge_keycloak_subject("keycloak-payment-test")
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
        cls.sale_journal = cls.env["account.journal"].create({
            "name": "Zugfolge Test Sales", "code": "ZFS", "type": "sale",
            "company_id": company.id, "default_account_id": revenue.id,
        })
        cls.payment_journal = cls.env["account.journal"].create({
            "name": "Zugfolge Test Bank", "code": "ZFB", "type": "bank",
            "company_id": company.id, "default_account_id": liquidity.id,
        })
        cls.payment_journal.inbound_payment_method_line_ids.payment_account_id = outstanding_receipts

    def test_paid_invoice_queues_exactly_one_world_participation(self):
        invoice = self.init_invoice(
            "out_invoice",
            partner=self.partner_a,
            post=True,
            products=[self.product_a],
            taxes=[],
            journal=self.sale_journal,
        )
        invoice.zugfolge_subject_reference = self.partner_a.zugfolge_keycloak_subject
        self._register_payment(invoice, journal_id=self.payment_journal.id)
        invoice.invalidate_recordset()
        self.assertEqual(invoice.payment_state, "paid")
        self.assertEqual(invoice.zugfolge_event_state, "none")
        self.assertFalse(invoice._zugfolge_command_change())

        participations = self.env["zugfolge.world.participation"].sudo().search([
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
        replay = self.env["zugfolge.world.participation"].sudo().search([
            ("partner_id", "=", self.partner_a.id),
            ("world_id", "=", self.world_id),
        ])
        self.assertEqual(len(replay), 1)
        self.assertEqual(replay.idempotency_key, first_key)

    def test_entitlement_payment_refund_retry_and_server_backfill_use_frozen_revisions(self):
        self.product_b.product_tmpl_id.zugfolge_product_kind = "cosmetic"
        invoice = self.init_invoice("out_invoice", partner=self.partner_a, post=True, products=[self.product_b], taxes=[], journal=self.sale_journal)
        invoice.zugfolge_subject_reference = self.partner_a.zugfolge_keycloak_subject
        self._register_payment(invoice, journal_id=self.payment_journal.id)
        invoice.invalidate_recordset()
        events = list(invoice.zugfolge_entitlement_events)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["command"]["change"], "grant")
        invoice._invoice_paid_hook()
        self.assertEqual(invoice.zugfolge_entitlement_events, events)
        with self.assertRaises(AccessError):
            invoice.zugfolge_subject_reference = "another-subject"
        self.product_b.product_tmpl_id.zugfolge_product_kind = "zugfolge_plus"

        refund = invoice._reverse_moves(default_values_list=[{"date": invoice.date}], cancel=False)
        self.assertFalse(refund._zugfolge_command_change())
        refund.action_post()
        invoice.invalidate_recordset()
        self.assertEqual(len(invoice.zugfolge_entitlement_events), 2)
        revoked = invoice.zugfolge_entitlement_events[1]
        self.assertEqual(revoked["command"]["change"], "revoke")
        self.assertEqual(revoked["command"]["sourceReference"], events[0]["command"]["sourceReference"])
        self.assertEqual(revoked["command"]["subject"], events[0]["command"]["subject"])
        self.assertEqual(revoked["command"]["productKind"], "cosmetic")
        self.assertNotEqual(revoked["correlationId"], events[0]["correlationId"])

        with patch("odoo.addons.zugfolge_admin.models.account_move.dispatch_signed_game_command") as dispatch:
            invoice._dispatch_zugfolge_entitlement(1)
            invoice._dispatch_zugfolge_entitlement(2)
            invoice.invalidate_recordset()
            invoice._dispatch_zugfolge_entitlement(2)
            invoice._dispatch_zugfolge_entitlement()
        self.assertEqual(dispatch.call_count, 5)
        self.assertEqual(dispatch.call_args_list[0].args[3], events[0]["command"])
        self.assertEqual(dispatch.call_args_list[1].args[1:], dispatch.call_args_list[2].args[1:])
        self.assertEqual(dispatch.call_args_list[3].args[3], events[0]["command"])
        self.assertEqual(dispatch.call_args_list[4].args[3], revoked["command"])
        invoice.action_replay_zugfolge_entitlements()
        self.assertEqual(len(invoice.zugfolge_entitlement_events), 2)
        with self.assertRaises(AccessError):
            invoice.write({"zugfolge_entitlement_events": []})

    def test_pre_upgrade_queued_entitlement_materializes_before_transport_instead_of_disappearing(self):
        self.product_b.product_tmpl_id.zugfolge_product_kind = "cosmetic"
        invoice = self.init_invoice("out_invoice", partner=self.partner_a, post=True, products=[self.product_b], taxes=[], journal=self.sale_journal)
        invoice.zugfolge_subject_reference = self.partner_a.zugfolge_keycloak_subject
        # Simuliert den vor 19.0.2.0.5 bereits gequeueten Job ohne neues Journal.
        with patch.object(type(invoice), "_sync_zugfolge_entitlement", return_value=None):
            self._register_payment(invoice, journal_id=self.payment_journal.id)
        invoice.invalidate_recordset()
        self.assertEqual(invoice.payment_state, "paid")
        self.assertFalse(invoice.zugfolge_entitlement_events)
        with patch("odoo.addons.zugfolge_admin.models.account_move.dispatch_signed_game_command") as dispatch:
            invoice._dispatch_zugfolge_entitlement()
            self.assertEqual(invoice.zugfolge_event_state, "queued")
            self.assertEqual(len(invoice.zugfolge_entitlement_events), 1)
            dispatch.assert_not_called()
            invoice.invalidate_recordset()
            invoice._dispatch_zugfolge_entitlement(1)
            dispatch.assert_called_once()
        self.assertEqual(invoice.zugfolge_event_state, "accepted")
