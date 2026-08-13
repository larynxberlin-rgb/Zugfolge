from odoo import Command
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
