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


class AccountMove(models.Model):
    """Use native invoices/payments; emit only a signed, idempotent commerce event."""

    _inherit = "account.move"

    zugfolge_subject_reference = fields.Char(string="Zugfolge-Kontoreferenz", copy=False)
    zugfolge_correlation_id = fields.Char(default=lambda self: str(uuid.uuid4()), readonly=True, copy=False, index=True)
    zugfolge_event_state = fields.Selection(
        [("none", "Nicht relevant"), ("queued", "Wird übertragen"), ("accepted", "Vom Game angenommen"), ("failed", "Übertragung fehlgeschlagen")],
        default="none", readonly=True, copy=False,
    )

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
        return result

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
