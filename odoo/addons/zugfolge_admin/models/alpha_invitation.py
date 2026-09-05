import uuid

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from ..services import dispatch_signed_game_command


_ALPHA_INVITATION_WRITE_TOKEN = object()


class AlphaInvitation(models.Model):
    """Odoo controls the lifecycle; Keycloak and Game remain authoritative stores."""

    _name = "zugfolge.alpha.invitation"
    _description = "Zugfolge Alpha-Einladung"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "write_date desc"

    email = fields.Char(required=True, tracking=True, index=True)
    display_name = fields.Char(required=True, tracking=True)
    world_projection_id = fields.Many2one(
        "zugfolge.world.projection",
        required=True,
        ondelete="restrict",
        index=True,
        domain=[("profile_kind", "=", "public")],
    )
    world_profile_kind = fields.Selection(related="world_projection_id.profile_kind", readonly=True)
    role = fields.Selection([("player", "Spieler"), ("world_admin", "Weltverwaltung")], required=True, default="player", tracking=True)
    request_reference = fields.Char(required=True, default=lambda self: str(uuid.uuid4()), readonly=True, copy=False, index=True)
    correlation_id = fields.Char(required=True, default=lambda self: str(uuid.uuid4()), readonly=True, copy=False, index=True)
    keycloak_subject = fields.Char(readonly=True, copy=False, index=True)
    game_account_reference = fields.Char(readonly=True, copy=False)
    revocation_request_id = fields.Many2one("zugfolge.admin.request", readonly=True, copy=False, ondelete="restrict")
    state = fields.Selection([("draft", "Entwurf"), ("sent", "Gesendet"), ("provisioned", "Bereitgestellt"), ("revocation_requested", "Entzug beantragt"), ("revoked", "Entzogen"), ("failed", "Fehlgeschlagen")], required=True, default="draft", readonly=True, tracking=True)

    @api.model_create_multi
    def create(self, values_list):
        controlled_write = self.env.context.get("zugfolge_alpha_invitation_write_token") is _ALPHA_INVITATION_WRITE_TOKEN
        normalized_values_list = []
        for values in values_list:
            normalized = dict(values)
            if not controlled_write:
                if normalized.get("state", "draft") != "draft":
                    raise AccessError(_("Einladungszustaende werden ausschliesslich serverseitig gesetzt."))
                if any(normalized.get(field_name) for field_name in (
                    "keycloak_subject", "game_account_reference", "revocation_request_id",
                )):
                    raise AccessError(_("Game-Ergebnisfelder duerfen beim Anlegen einer Einladung nicht vorgegeben werden."))
                # Auch ein aus default_get zurueckgesendeter Wert ist nicht vertrauenswuerdig:
                # die stabilen Referenzen entstehen erst hier im serverseitigen create-Pfad.
                for field_name in (
                    "state", "request_reference", "correlation_id", "keycloak_subject",
                    "game_account_reference", "revocation_request_id",
                ):
                    normalized.pop(field_name, None)
            normalized_values_list.append(normalized)
        return super().create(normalized_values_list)

    def _write_controlled(self, values):
        return self.with_context(zugfolge_alpha_invitation_write_token=_ALPHA_INVITATION_WRITE_TOKEN).write(values)

    def write(self, values):
        controlled_write = self.env.context.get("zugfolge_alpha_invitation_write_token") is _ALPHA_INVITATION_WRITE_TOKEN
        protected_fields = {
            "request_reference", "correlation_id", "keycloak_subject",
            "game_account_reference", "revocation_request_id", "state",
        }
        if protected_fields.intersection(values) and not controlled_write:
            raise AccessError(_("Einladungszustand, Korrelations- und Game-Ergebnisfelder duerfen nicht per RPC veraendert werden."))
        decision_fields = {"email", "display_name", "world_projection_id", "role"}
        if decision_fields.intersection(values) and any(record.state != "draft" for record in self):
            raise UserError(_("Versendete Einladungsdaten sind unveraenderlich; bitte einen neuen Entwurf anlegen."))
        return super().write(values)

    def _require_signed_game_projection(self):
        if not self.env.context.get("zugfolge_game_projection") or not self.env.su:
            raise AccessError(_("Einladungsergebnisse duerfen nur signiert aus dem Game projiziert werden."))

    def _apply_game_result(self, payload, world_id):
        self._require_signed_game_projection()
        self.ensure_one()
        if not isinstance(payload, dict) or payload.get("outcome") not in ("accepted", "rejected"):
            raise ValidationError(_("Einladungsergebnis besitzt keinen gueltigen Ausgang."))
        if world_id != self.world_projection_id.world_id:
            raise ValidationError(_("Einladungsergebnis verletzt Weltisolation."))
        if self.state not in ("sent", "provisioned"):
            raise ValidationError(_("Einladungsergebnis passt nicht zum aktuellen Einladungszustand."))

        if payload["outcome"] == "rejected":
            self._write_controlled({"state": "failed"})
            return

        if self.state == "sent":
            request_reference = payload.get("requestReference")
            keycloak_subject = payload.get("keycloakSubject")
            game_account_reference = payload.get("gameAccountReference")
            if request_reference != self.request_reference:
                raise ValidationError(_("Einladungsergebnis verletzt die stabile Anfragereferenz."))
            if not isinstance(keycloak_subject, str) or not keycloak_subject.strip():
                raise ValidationError(_("Bereitgestellte Einladung braucht ein autoritatives Keycloak-Subject."))
            if not isinstance(game_account_reference, str) or not game_account_reference.strip():
                raise ValidationError(_("Bereitgestellte Einladung braucht eine autoritative Game-Kontoreferenz."))
            self._write_controlled({
                "state": "provisioned",
                "keycloak_subject": keycloak_subject,
                "game_account_reference": game_account_reference,
            })
            return

        # Ein erfolgreiches Resend-Ergebnis besitzt keine neuen Identitaetsfelder.
        # Falls Game sie dennoch sendet, duerfen sie die bestehende Bindung nie umhaengen.
        if payload.get("requestReference") not in (None, self.request_reference):
            raise ValidationError(_("Resend-Ergebnis verletzt die stabile Anfragereferenz."))
        if payload.get("keycloakSubject") not in (None, self.keycloak_subject):
            raise ValidationError(_("Resend-Ergebnis versucht das gebundene Keycloak-Subject zu veraendern."))
        if payload.get("gameAccountReference") not in (None, self.game_account_reference):
            raise ValidationError(_("Resend-Ergebnis versucht die gebundene Game-Kontoreferenz zu veraendern."))

    def _apply_game_revocation_result(self, admin_request_id, world_id):
        self._require_signed_game_projection()
        self.ensure_one()
        if world_id != self.world_projection_id.world_id:
            raise ValidationError(_("Entzugsergebnis verletzt Weltisolation."))
        if (
            self.state != "revocation_requested"
            or self.revocation_request_id.id != admin_request_id
            or self.revocation_request_id.state != "completed"
        ):
            raise ValidationError(_("Entzugsergebnis passt nicht zum offenen Vier-Augen-Antrag."))
        self._write_controlled({"state": "revoked"})

    def _command(self, action):
        self.ensure_one()
        actor = self.env["ir.config_parameter"].sudo().get_param("zugfolge_admin.actor_reference")
        if not actor:
            raise UserError(_("Der Zugfolge-Integrationsakteur ist nicht konfiguriert."))
        payload = {
            "kind": "admin.alpha_invitation_%s" % action,
            "worldId": self.world_projection_id.world_id,
            "actionType": "alpha_invitation_%s" % action,
            "riskClass": "standard",
            "requesterReference": str(self.env.user.id),
            "reason": "Alpha-Kontenlebenszyklus aus Odoo",
            "effectPreview": {"requestReference": self.request_reference, "role": self.role},
            "invitation": {
                "requestReference": self.request_reference,
                "email": self.email,
                "displayName": self.display_name,
                "role": self.role,
                "keycloakSubject": self.keycloak_subject or None,
            },
        }
        dispatch_signed_game_command(self.env, self.correlation_id, actor, payload)

    def action_send(self):
        for record in self:
            if record.state != "draft":
                raise UserError(_("Nur Entwuerfe koennen erstmals versendet werden."))
            if "@" not in record.email:
                raise ValidationError(_("Eine gueltige E-Mail-Adresse ist Pflicht."))
            if record.world_projection_id.profile_kind != "public":
                raise ValidationError(_("Alpha-Einladungen müssen eine öffentliche Zielwelt auf deren eigenem Server wählen."))
            record._command("create")
            record._write_controlled({"state": "sent"})

    def action_resend(self):
        for record in self:
            if not record.keycloak_subject:
                raise UserError(_("Erneutes Senden ist erst nach autoritativer Bereitstellung moeglich."))
            if record.state != "provisioned":
                raise UserError(_("Erneutes Senden ist nur fuer ein bereitgestelltes, aktives Konto moeglich."))
            record._command("resend")

    def action_revoke(self):
        self.ensure_one()
        if not self.keycloak_subject:
            raise UserError(_("Entzug ist erst nach autoritativer Bereitstellung moeglich."))
        if self.state != "provisioned":
            raise UserError(_("Fuer diese Einladung laeuft bereits ein Entzug oder sie ist nicht aktiv."))
        admin_request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.world_projection_id.id,
            "action_type": "world_access_revoke",
            "risk_class": "high",
            "reason": _("Alpha-Konto aus dem freigegebenen Kontenlebenszyklus entziehen"),
            "effect_preview": {
                "requestReference": self.request_reference,
                "keycloakSubject": self.keycloak_subject,
                "gameAccountReference": self.game_account_reference,
                "effect": "Keycloak-Identitaet deaktivieren und Weltzugang entziehen",
            },
            "target_reference": self.keycloak_subject,
        })
        self._write_controlled({"state": "revocation_requested", "revocation_request_id": admin_request.id})
        return {
            "type": "ir.actions.act_window",
            "name": _("Vier-Augen-Entzug"),
            "res_model": "zugfolge.admin.request",
            "res_id": admin_request.id,
            "view_mode": "form",
            "target": "current",
        }
