import uuid

from odoo import _, fields, models
from odoo.exceptions import UserError, ValidationError

from ..services import dispatch_signed_game_command


class AlphaInvitation(models.Model):
    """Odoo controls the lifecycle; Keycloak and Game remain authoritative stores."""

    _name = "zugfolge.alpha.invitation"
    _description = "Zugfolge Alpha-Einladung"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "write_date desc"

    email = fields.Char(required=True, tracking=True, index=True)
    display_name = fields.Char(required=True, tracking=True)
    world_projection_id = fields.Many2one("zugfolge.world.projection", required=True, ondelete="restrict", index=True)
    role = fields.Selection([("player", "Spieler"), ("world_admin", "Weltverwaltung")], required=True, default="player", tracking=True)
    start_package = fields.Char(tracking=True)
    request_reference = fields.Char(required=True, default=lambda self: str(uuid.uuid4()), readonly=True, copy=False, index=True)
    correlation_id = fields.Char(required=True, default=lambda self: str(uuid.uuid4()), readonly=True, copy=False, index=True)
    keycloak_subject = fields.Char(readonly=True, copy=False, index=True)
    game_account_reference = fields.Char(readonly=True, copy=False)
    state = fields.Selection([("draft", "Entwurf"), ("sent", "Gesendet"), ("provisioned", "Bereitgestellt"), ("revoked", "Entzogen"), ("failed", "Fehlgeschlagen")], required=True, default="draft", readonly=True, tracking=True)

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
                "startPackage": self.start_package or None,
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
            record._command("create")
            record.state = "sent"

    def action_resend(self):
        for record in self:
            if not record.keycloak_subject:
                raise UserError(_("Erneutes Senden ist erst nach autoritativer Bereitstellung moeglich."))
            record._command("resend")

    def action_revoke(self):
        for record in self:
            if not record.keycloak_subject:
                raise UserError(_("Entzug ist erst nach autoritativer Bereitstellung moeglich."))
            record._command("revoke")
            record.state = "revoked"
