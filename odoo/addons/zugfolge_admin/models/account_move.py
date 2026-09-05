import uuid
from datetime import datetime, timezone

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, ValidationError

from ..services import dispatch_signed_game_command

_ENTITLEMENT_WRITE_TOKEN = object()


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
    zugfolge_entitlement_events = fields.Json(readonly=True, copy=False, default=list)

    @api.model_create_multi
    def create(self, values_list):
        if any(values.get("zugfolge_entitlement_events") for values in values_list):
            raise AccessError(_("Entitlementbelege duerfen nicht beim Anlegen einer Rechnung vorgegeben werden."))
        return super().create(values_list)

    def _zugfolge_product_line(self):
        lines = self.invoice_line_ids.filtered(lambda line: line.product_id.product_tmpl_id.zugfolge_product_kind)
        if len(lines) > 1:
            raise ValidationError(_("Eine Zugfolge-Rechnung darf genau eine Entitlement-Produktzeile enthalten."))
        return lines[:1]

    def _zugfolge_command_change(self):
        self.ensure_one()
        source = self.reversed_entry_id if self.move_type == "out_refund" else self
        if not source or self.state != "posted":
            return None
        events = source.zugfolge_entitlement_events or []
        first = events[0] if events else None
        frozen = first["command"] if first else None
        line = source.invoice_line_ids.filtered(lambda line: line.product_id.id == first["productId"]) if first else source._zugfolge_product_line()
        subject = frozen["subject"] if frozen else source.zugfolge_subject_reference
        if len(line) != 1 or not subject:
            return None
        product_template = line.product_id.product_tmpl_id
        product_kind = frozen["productKind"] if frozen else product_template.zugfolge_product_kind
        if (
            frozen is None and product_kind == "public_world_slot"
            and self.env["zugfolge.world.offer"].sudo().search_count([("product_tmpl_id", "=", product_template.id)])
        ):
            # Der bezahlte konkrete Weltplatz wird ausschliesslich ueber den
            # weltgebundenen Participation-Command autorisiert. Ein zusaetzlicher
            # generischer Slot-Grant waere eine zweite kommerzielle Wirkung.
            return None
        quantity = int(line.quantity)
        if quantity < 1 or quantity != line.quantity:
            raise ValidationError(_("Ein Entitlement braucht eine positive ganzzahlige Menge."))
        posted_refunds = source.reversal_move_ids.filtered(lambda move: move.state == "posted" and move.move_type == "out_refund")
        returned = sum(refund_line.quantity for refund in posted_refunds for refund_line in refund.invoice_line_ids
                       if refund_line.product_id == line.product_id)
        if returned != int(returned) or returned < 0:
            raise ValidationError(_("Eine Entitlementerstattung braucht eine ganzzahlige Menge."))
        remaining = max(0, quantity - int(returned))
        if remaining == 0 or source.payment_state == "reversed":
            change = "revoke"
        elif source.payment_state == "paid" and source.move_type == "out_invoice":
            change = "grant"
        else:
            return None
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        return {
            "kind": "entitlement.change",
            "subject": subject,
            "productKind": product_kind,
            "change": change,
            "validFrom": now,
            "quantity": remaining if change == "grant" else quantity,
            # Behaelt den historischen v1-Schluessel; Gutschriften benennen
            # dieselbe Ursprungsrechnung statt einen zweiten Berechtigungsvertrag.
            "sourceReference": frozen["sourceReference"] if frozen else source.name,
        }

    def _sync_zugfolge_entitlement(self):
        for move in self:
            command = move._zugfolge_command_change()
            if command is None:
                continue
            source = move.reversed_entry_id if move.move_type == "out_refund" else move
            self.env.cr.execute("SELECT id FROM account_move WHERE id = %s FOR UPDATE", (source.id,))
            source.invalidate_recordset(["zugfolge_entitlement_events", "payment_state", "reversal_move_ids"])
            command = source._zugfolge_command_change()
            if command is None:
                continue
            events = list(source.zugfolge_entitlement_events or [])
            # Aenderungszeit und Revision werden einmal vor dem Queue-Commit
            # eingefroren. Doppelter Payment-Hook erzeugt kein neues Ereignis.
            comparable = {key: value for key, value in command.items() if key != "validFrom"}
            previous = events[-1]["command"] if events else None
            if previous is not None and comparable == {key: value for key, value in previous.items() if key not in ("validFrom", "sourceRevision")}:
                continue
            revision = len(events) + 1
            command["sourceRevision"] = revision
            product_id = events[0]["productId"] if events else source._zugfolge_product_line().product_id.id
            event = {"correlationId": "%s:entitlement:%s" % (source.zugfolge_correlation_id, revision), "productId": product_id, "command": command}
            events.append(event)
            source.with_context(zugfolge_entitlement_write_token=_ENTITLEMENT_WRITE_TOKEN, zugfolge_skip_dispatch=True).write({
                "zugfolge_entitlement_events": events, "zugfolge_event_state": "queued",
            })
            source.with_delay(description="Zugfolge-Entitlementrevision an Game senden")._dispatch_zugfolge_entitlement(revision)

    def write(self, values):
        if "zugfolge_entitlement_events" in values and self.env.context.get("zugfolge_entitlement_write_token") is not _ENTITLEMENT_WRITE_TOKEN:
            raise AccessError(_("Entitlementbelege duerfen nur durch den kaufmaennischen Lifecycle entstehen."))
        if "zugfolge_subject_reference" in values and any(move.zugfolge_entitlement_events and values["zugfolge_subject_reference"] != move.zugfolge_entitlement_events[0]["command"]["subject"] for move in self):
            raise AccessError(_("Die Kontobindung eines ausgestellten Entitlementbelegs ist unveraenderlich."))
        result = super().write(values)
        if self.env.context.get("zugfolge_skip_dispatch") or not {"payment_state", "state"}.intersection(values):
            return result
        for move in self:
            move._sync_zugfolge_entitlement()
            move._sync_zugfolge_world_participation()
        self.mapped("reversed_entry_id")._sync_zugfolge_entitlement()
        return result

    def _invoice_paid_hook(self):
        """Odoo 19 calls this after reconciliation changed an invoice to paid."""
        result = super()._invoice_paid_hook()
        if not self.env.context.get("zugfolge_skip_dispatch"):
            self._sync_zugfolge_entitlement()
            self._sync_zugfolge_world_participation()
        return result

    def _post(self, soft=True):
        posted = super()._post(soft=soft)
        if not self.env.context.get("zugfolge_skip_dispatch"):
            posted._sync_zugfolge_entitlement()
        return posted

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

    def _dispatch_zugfolge_entitlement(self, revision=None):
        """OCA queue_job retried transport; duplicate attempts share the Game event ID."""
        for move in self:
            events = list(move.zugfolge_entitlement_events or [])
            if not events:
                # Ein vor dem Upgrade gequeueter Job muss erst einen dauerhaften
                # Beleg anlegen. Dessen neuer Queuejob sendet nach dem Commit;
                # ein verlorener HTTP-Ack kann so keine Payload neu erzeugen.
                move._sync_zugfolge_entitlement()
                if not move.zugfolge_entitlement_events:
                    raise ValidationError(_("Historischer Entitlementjob besitzt keinen nachweisbaren kaufmaennischen Zustand."))
                continue
            selected = [event for event in events if revision is None or event["command"]["sourceRevision"] == revision]
            if not selected:
                raise ValidationError(_("Die angeforderte Entitlementrevision ist nicht gespeichert."))
            try:
                for event in selected:
                    dispatch_signed_game_command(move.env, event["correlationId"], "commerce-service", event["command"])
                move.with_context(zugfolge_skip_dispatch=True).write({"zugfolge_event_state": "accepted"})
            except Exception:
                move.with_context(zugfolge_skip_dispatch=True).write({"zugfolge_event_state": "failed"})
                raise

    def action_replay_zugfolge_entitlements(self):
        """Expliziter Nachlieferungslauf an alle derzeit registrierten Hauptweltserver."""
        if not self.env.user.has_group("account.group_account_manager"):
            raise AccessError(_("Nur die Buchhaltungsverwaltung darf Entitlements nachliefern."))
        sources = self.filtered(lambda move: move.move_type == "out_invoice" and move.state == "posted")
        sources._sync_zugfolge_entitlement()
        for source in sources:
            if source.zugfolge_entitlement_events:
                source.with_delay(description="Zugfolge-Entitlementhistorie an Weltserver nachliefern")._dispatch_zugfolge_entitlement()
        return True
