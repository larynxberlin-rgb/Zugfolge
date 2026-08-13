import uuid
from datetime import datetime, timezone

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

from ..services import dispatch_signed_game_command


PRODUCT_KINDS = [
    ("zugfolge_plus", "Zugfolge Plus"),
    ("cosmetic", "Kosmetik"),
    ("public_world_slot", "Zusätzlicher öffentlicher Weltplatz"),
    ("private_unranked_world", "Private ungewertete Welt"),
]


class ProductTemplate(models.Model):
    """Native Odoo product catalogue receives only the harmless product mapping."""

    _inherit = "product.template"

    zugfolge_product_kind = fields.Selection(PRODUCT_KINDS, string="Zugfolge-Entitlement")

    @api.constrains("zugfolge_product_kind")
    def _check_world_offer_product_kind(self):
        for product in self:
            if self.env["zugfolge.world.offer"].sudo().search_count([("product_tmpl_id", "=", product.id)]) and product.zugfolge_product_kind != "public_world_slot":
                raise ValidationError(_("Ein konkretes Weltangebot muss das Produkt als oeffentlichen Weltplatz kennzeichnen."))


class AccountMove(models.Model):
    """Use native invoices/payments; emit only a signed, idempotent commerce event."""

    _inherit = "account.move"

    zugfolge_subject_reference = fields.Char(string="Zugfolge-Kontoreferenz", copy=False)
    zugfolge_correlation_id = fields.Char(default=lambda self: str(uuid.uuid4()), readonly=True, copy=False, index=True)
    zugfolge_event_state = fields.Selection(
        [("none", "Nicht relevant"), ("queued", "Wird übertragen"), ("accepted", "Vom Game angenommen"), ("failed", "Übertragung fehlgeschlagen")],
        default="none", readonly=True, copy=False,
    )
    zugfolge_participation_id = fields.Many2one("zugfolge.world.participation", readonly=True, copy=False)

    def _zugfolge_product_line(self):
        lines = self.invoice_line_ids.filtered(lambda line: line.product_id.product_tmpl_id.zugfolge_product_kind)
        if len(lines) > 1:
            raise ValidationError(_("Eine Zugfolge-Rechnung darf genau eine Entitlement-Produktzeile enthalten."))
        return lines[:1]

    def _zugfolge_command_change(self):
        self.ensure_one()
        line = self._zugfolge_product_line()
        if not line or not self.zugfolge_subject_reference:
            return None
        product_template = line.product_id.product_tmpl_id
        if (
            product_template.zugfolge_product_kind == "public_world_slot"
            and self.env["zugfolge.world.offer"].sudo().search_count([("product_tmpl_id", "=", product_template.id)])
        ):
            # Der bezahlte konkrete Weltplatz wird ausschliesslich ueber den
            # weltgebundenen Participation-Command autorisiert. Ein zusaetzlicher
            # generischer Slot-Grant waere eine zweite kommerzielle Wirkung.
            return None
        if self.payment_state == "paid" and self.move_type == "out_invoice":
            change = "grant"
        elif self.payment_state == "reversed" or self.move_type == "out_refund":
            change = "revoke"
        else:
            return None
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        return {
            "kind": "entitlement.change",
            "subject": self.zugfolge_subject_reference,
            "productKind": line.product_id.product_tmpl_id.zugfolge_product_kind,
            "change": change,
            "validFrom": now,
            "quantity": max(1, int(line.quantity)),
            "sourceReference": self.name,
        }

    def write(self, values):
        result = super().write(values)
        if self.env.context.get("zugfolge_skip_dispatch") or "payment_state" not in values:
            return result
        for move in self:
            if move._zugfolge_command_change() is not None:
                move.with_context(zugfolge_skip_dispatch=True).write({"zugfolge_event_state": "queued"})
                move.with_delay(description="Zugfolge-Entitlement an Game senden")._dispatch_zugfolge_entitlement()
            move._sync_zugfolge_world_participation()
        return result

    def _invoice_paid_hook(self):
        """Odoo 19 calls this after reconciliation changed an invoice to paid."""
        result = super()._invoice_paid_hook()
        if not self.env.context.get("zugfolge_skip_dispatch"):
            self._sync_zugfolge_world_participation()
        return result

    def _zugfolge_world_offer(self):
        self.ensure_one()
        template_ids = self.invoice_line_ids.product_id.product_tmpl_id.ids
        # Der Payment-Status ist bereits durch Odoos Accounting-Rechte geschuetzt.
        # Die daraus abgeleitete Integration darf keine Zugfolge-Adminrolle des
        # buchenden Benutzers voraussetzen.
        offers = self.env["zugfolge.world.offer"].sudo().search([("product_tmpl_id", "in", template_ids)])
        if len(offers) > 1:
            raise ValidationError(_("Eine Rechnung darf nur eine konkrete Zugfolge-Weltteilnahme enthalten."))
        return offers[:1]

    def _sync_zugfolge_world_participation(self):
        """Native payment_state ist kommerziell; das Game-Ergebnis bleibt fachlich autoritativ."""
        for move in self:
            offer = move._zugfolge_world_offer()
            if not offer:
                continue
            subject = move.partner_id.zugfolge_keycloak_subject
            if not subject:
                raise ValidationError(_("Das Portalprofil besitzt noch keine verifizierte Keycloak-sub-Referenz."))
            payment_reference = move.name or str(move.id)
            order_reference = move.invoice_origin or move.name or str(move.id)
            participation_model = self.env["zugfolge.world.participation"].sudo()
            participation = participation_model.search([
                ("partner_id", "=", move.partner_id.id), ("world_id", "=", offer.projection_id.world_id),
            ], limit=1)
            if move.payment_state == "paid" and move.move_type == "out_invoice":
                deterministic_key = str(uuid.uuid5(uuid.NAMESPACE_URL, "zugfolge:%s:%s:%s" % (offer.projection_id.world_id, move.partner_id.id, payment_reference)))
                values = {
                    "partner_id": move.partner_id.id, "offer_id": offer.id, "keycloak_subject": subject,
                    "odoo_order_reference": order_reference, "payment_reference": payment_reference,
                    "idempotency_key": deterministic_key, "state": "paid",
                }
                if participation:
                    if participation.payment_reference == payment_reference and (
                        participation.state in ("provisioning", "active", "rejected", "cancelled", "refunded")
                        or participation.state == "refund_pending"
                    ):
                        move.with_context(zugfolge_skip_dispatch=True).write({"zugfolge_participation_id": participation.id})
                        continue
                    if participation.state == "active":
                        raise ValidationError(_("Fuer diese Welt besteht bereits eine aktive Teilnahme; eine zweite Zahlung wird nicht provisioniert."))
                    values["correlation_id"] = str(uuid.uuid4())
                    participation._write_from_commerce(values)
                else:
                    participation = participation_model._create_from_commerce(values)
                move.with_context(zugfolge_skip_dispatch=True).write({"zugfolge_participation_id": participation.id})
                participation.queue_provisioning()
            elif (move.payment_state == "reversed" or move.move_type == "out_refund") and participation:
                if participation.state in ("refund_pending", "refunded"):
                    continue
                participation._write_from_commerce({"state": "refund_pending"})
                participation.with_delay(description="Zugfolge-Weltteilnahme erstatten")._dispatch("refund")

    def _dispatch_zugfolge_entitlement(self):
        """OCA queue_job retried transport; duplicate attempts share the Game event ID."""
        for move in self:
            command = move._zugfolge_command_change()
            if command is None:
                continue
            try:
                dispatch_signed_game_command(move.env, move.zugfolge_correlation_id, "commerce-service", command)
                move.with_context(zugfolge_skip_dispatch=True).write({"zugfolge_event_state": "accepted"})
            except Exception:
                move.with_context(zugfolge_skip_dispatch=True).write({"zugfolge_event_state": "failed"})
                raise
