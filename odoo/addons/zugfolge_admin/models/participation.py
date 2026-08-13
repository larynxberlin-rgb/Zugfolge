import uuid
from datetime import datetime, timezone

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from ..services import dispatch_signed_game_command


_COMMERCE_WRITE_TOKEN = object()
_GAME_RESULT_WRITE_TOKEN = object()


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
        ("active", "Aktiv"), ("rejected", "Abgelehnt"), ("refund_pending", "Erstattung wird geprueft"),
        ("cancelled", "Storniert"), ("refunded", "Erstattet"),
    ], required=True, default="pending_payment", tracking=True)
    rejection_code = fields.Char(readonly=True)
    game_participation_reference = fields.Char(readonly=True)
    game_account_reference = fields.Char(readonly=True)

    _partner_world_unique = models.Constraint(
        "unique(partner_id, world_id)",
        "Ein Portalprofil besitzt je Welt nur eine Teilnahme.",
    )
    _idempotency_key_unique = models.Constraint(
        "unique(idempotency_key)",
        "Der Teilnahme-Idempotency-Key muss eindeutig sein.",
    )

    @api.model_create_multi
    def create(self, values_list):
        commerce_write = self.env.context.get("zugfolge_commerce_write_token") is _COMMERCE_WRITE_TOKEN
        for values in values_list:
            if values.get("state", "pending_payment") != "pending_payment" and not commerce_write:
                raise AccessError(_("Bezahl- und Teilnahmezustaende duerfen nur aus dem geprueften Commerce-Pfad entstehen."))
            if any(values.get(field_name) for field_name in ("rejection_code", "game_participation_reference", "game_account_reference")):
                raise AccessError(_("Game-Ergebnisfelder duerfen beim Anlegen einer Teilnahme nicht vorgegeben werden."))
        return super().create(values_list)

    @api.model
    def _create_from_commerce(self, values):
        participation = self.with_context(
            zugfolge_commerce_write_token=_COMMERCE_WRITE_TOKEN,
        ).create(values)
        # Never return a recordset carrying the private capability.  Odoo
        # recordsets retain their environment, so leaking this context would
        # let an ordinary caller perform a later identity/state write.
        return participation.with_env(self.env)

    def _write_from_commerce(self, values):
        return self.with_context(zugfolge_commerce_write_token=_COMMERCE_WRITE_TOKEN).write(values)

    def _write_game_result(self, values):
        return self.with_context(zugfolge_game_result_write_token=_GAME_RESULT_WRITE_TOKEN).write(values)

    def write(self, values):
        identity_fields = {
            "partner_id", "offer_id", "world_id", "keycloak_subject",
            "odoo_order_reference", "payment_reference", "idempotency_key", "correlation_id",
        }
        commerce_write = self.env.context.get("zugfolge_commerce_write_token") is _COMMERCE_WRITE_TOKEN
        game_result_write = self.env.context.get("zugfolge_game_result_write_token") is _GAME_RESULT_WRITE_TOKEN
        if identity_fields.intersection(values) and not commerce_write:
            raise AccessError(_("Identitaets-, Welt- und Belegbindung einer Teilnahme sind nur im geprueften Commerce-Pfad aenderbar."))
        if "state" in values and not (commerce_write or game_result_write):
            raise AccessError(_("Teilnahmezustaende duerfen nur aus Commerce- oder signierten Game-Ergebnissen entstehen."))
        if {"rejection_code", "game_participation_reference", "game_account_reference"}.intersection(values) and not game_result_write:
            raise AccessError(_("Game-Ergebnisfelder duerfen nur aus einer signierten Game-Projektion entstehen."))
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
            record._write_from_commerce({"state": "provisioning"})
            record.with_delay(description="Zugfolge-Weltteilnahme an Game senden")._dispatch("provision")

    def _dispatch(self, action):
        for record in self:
            dispatch_signed_game_command(record.env, record.correlation_id, "commerce-service", record._command(action))

    def apply_game_result(self, payload):
        if not self.env.context.get("zugfolge_game_projection") or not self.env.su:
            raise AccessError(_("Teilnahmeergebnisse duerfen nur signiert aus dem Game kommen."))
        self.ensure_one()
        action = payload.get("action")
        if action not in ("provision", "cancel", "refund"):
            raise ValidationError(_("Teilnahmeergebnis besitzt keine gueltige Aktion."))
        if payload.get("worldId") != self.world_id:
            raise ValidationError(_("Teilnahmeergebnis verletzt Weltisolation."))
        if payload.get("idempotencyKey") != self.idempotency_key + ":" + action:
            raise ValidationError(_("Teilnahmeergebnis verletzt die fachliche Idempotenzbindung."))
        required_state = {"provision": "provisioning", "cancel": "active", "refund": "refund_pending"}[action]
        if self.state != required_state:
            raise ValidationError(_("Teilnahmeergebnis passt nicht zum aktuellen Commerce-Zustand."))
        state = payload.get("state")
        allowed_states = {
            "provision": ("active", "rejected"),
            "cancel": ("cancelled", "rejected"),
            "refund": ("refunded", "rejected"),
        }[action]
        if state not in allowed_states:
            raise ValidationError(_("Unbekannter Game-Teilnahmezustand."))
        self._write_game_result({
            "state": state,
            "rejection_code": payload.get("rejectionCode") or False,
            "game_participation_reference": payload.get("participationId") or False,
            "game_account_reference": payload.get("gameAccountReference") or False,
        })
