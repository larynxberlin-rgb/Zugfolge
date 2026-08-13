import uuid
from datetime import datetime, timezone

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from ..services import dispatch_signed_game_command


class ZugfolgeWorldParticipation(models.Model):
    _name = "zugfolge.world.participation"
    _description = "Zugfolge Weltteilnahme"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "write_date desc"

    partner_id = fields.Many2one("res.partner", required=True, ondelete="restrict", index=True)
    offer_id = fields.Many2one("zugfolge.world.offer", required=True, ondelete="restrict", index=True)
    world_id = fields.Char(related="offer_id.projection_id.world_id", store=True, index=True, readonly=True)
    keycloak_subject = fields.Char(required=True, index=True, readonly=True)
    odoo_order_reference = fields.Char(required=True, readonly=True)
    payment_reference = fields.Char(required=True, readonly=True)
    idempotency_key = fields.Char(required=True, index=True, readonly=True, default=lambda self: str(uuid.uuid4()))
    correlation_id = fields.Char(required=True, index=True, readonly=True, default=lambda self: str(uuid.uuid4()))
    state = fields.Selection([
        ("pending_payment", "Zahlung offen"), ("paid", "Bezahlt"), ("provisioning", "Wird eingerichtet"),
        ("active", "Aktiv"), ("rejected", "Abgelehnt"), ("cancelled", "Storniert"), ("refunded", "Erstattet"),
    ], required=True, default="pending_payment", tracking=True)
    rejection_code = fields.Char(readonly=True)
    game_participation_reference = fields.Char(readonly=True)
    game_account_reference = fields.Char(readonly=True)

    _sql_constraints = [
        ("zugfolge_participation_partner_world", "unique(partner_id, world_id)", "Ein Portalprofil besitzt je Welt nur eine Teilnahme."),
        ("zugfolge_participation_idempotency", "unique(idempotency_key)", "Der Teilnahme-Idempotency-Key muss eindeutig sein."),
    ]

    def write(self, values):
        protected = {
            "partner_id", "offer_id", "world_id", "keycloak_subject",
            "odoo_order_reference", "payment_reference", "idempotency_key", "correlation_id",
        }
        if protected.intersection(values) and not (
            self.env.context.get("zugfolge_commerce_transition")
            or self.env.context.get("zugfolge_game_projection")
        ):
            raise AccessError(_("Identitaets-, Welt- und Belegbindung einer Teilnahme sind nur im geprueften Commerce-Pfad aenderbar."))
        return super().write(values)

    @api.constrains("keycloak_subject", "world_id", "idempotency_key")
    def _check_contract_keys(self):
        for record in self:
            if not record.keycloak_subject or not record.world_id or len(record.idempotency_key or "") < 8:
                raise ValidationError(_("Weltteilnahme braucht world_id, Keycloak-sub und stabilen Idempotency-Key."))

    def _command(self, action):
        self.ensure_one()
        if action not in ("provision", "cancel", "refund"):
            raise ValidationError(_("Unbekannte Teilnahmeaktion."))
        return {
            "kind": "world.participation.change",
            "schemaVersion": "zugfolge-world-participation/v1",
            "action": action,
            "worldId": self.world_id,
            "keycloakSubject": self.keycloak_subject,
            "displayName": self.partner_id.name,
            "odooPartnerReference": str(self.partner_id.id),
            "odooOrderReference": self.odoo_order_reference,
            "paymentReference": self.payment_reference,
            "idempotencyKey": self.idempotency_key + ":" + action,
            "requestedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }

    def queue_provisioning(self):
        for record in self:
            if record.state not in ("paid", "rejected"):
                raise UserError(_("Nur bezahlte oder nachpruefbare Teilnahmen duerfen provisioniert werden."))
            record.write({"state": "provisioning", "rejection_code": False})
            record.with_delay(description="Zugfolge-Weltteilnahme an Game senden")._dispatch("provision")

    def _dispatch(self, action):
        for record in self:
            dispatch_signed_game_command(record.env, record.correlation_id, "commerce-service", record._command(action))

    def apply_game_result(self, payload):
        if not self.env.context.get("zugfolge_game_projection"):
            raise AccessError(_("Teilnahmeergebnisse duerfen nur signiert aus dem Game kommen."))
        self.ensure_one()
        action = payload.get("action")
        if action not in ("provision", "cancel", "refund"):
            raise ValidationError(_("Teilnahmeergebnis besitzt keine gueltige Aktion."))
        if payload.get("worldId") != self.world_id:
            raise ValidationError(_("Teilnahmeergebnis verletzt Weltisolation."))
        if payload.get("idempotencyKey") != self.idempotency_key + ":" + action:
            raise ValidationError(_("Teilnahmeergebnis verletzt die fachliche Idempotenzbindung."))
        state = payload.get("state")
        if state not in ("active", "rejected", "cancelled", "refunded"):
            raise ValidationError(_("Unbekannter Game-Teilnahmezustand."))
        self.with_context(zugfolge_game_projection=True).write({
            "state": state,
            "rejection_code": payload.get("rejectionCode") or False,
            "game_participation_reference": payload.get("participationId") or False,
            "game_account_reference": payload.get("gameAccountReference") or False,
        })
