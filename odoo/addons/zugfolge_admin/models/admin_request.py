import uuid

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from ..services import dispatch_signed_game_command


class ZugfolgeAdminRequest(models.Model):
    """Native Odoo approval UI; Game remains the authoritative executor."""

    _name = "zugfolge.admin.request"
    _description = "Zugfolge Administrationsantrag"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "write_date desc"

    name = fields.Char(compute="_compute_name", store=True)
    world_projection_id = fields.Many2one("zugfolge.world.projection", required=True, ondelete="restrict", index=True)
    action_type = fields.Selection(
        [("world_access_revoke", "Weltzugang entziehen"), ("infra_release_adoption", "InfraRelease zur Periode uebernehmen")],
        required=True,
        tracking=True,
    )
    risk_class = fields.Selection([( "standard", "Standard"), ("high", "Hochrisiko")], required=True, default="standard", tracking=True)
    requester_id = fields.Many2one("res.users", required=True, default=lambda self: self.env.user, readonly=True)
    approver_id = fields.Many2one("res.users", readonly=True, tracking=True)
    reason = fields.Text(required=True, tracking=True)
    effect_preview = fields.Json(required=True, default=dict, readonly=True)
    correlation_id = fields.Char(required=True, default=lambda self: str(uuid.uuid4()), readonly=True, copy=False, index=True)
    state = fields.Selection(
        [("draft", "Entwurf"), ("submitted", "Eingereicht"), ("approved", "Freigegeben"), ("rejected", "Abgelehnt"), ("dispatched", "An Game gesendet"), ("accepted", "Vom Game angenommen"), ("completed", "Abgeschlossen"), ("failed", "Fehlgeschlagen")],
        required=True,
        default="draft",
        tracking=True,
        readonly=True,
    )
    game_audit_event_id = fields.Char(readonly=True, copy=False)
    game_result = fields.Json(readonly=True, copy=False)
    release_hash = fields.Char()
    requested_period_start = fields.Datetime()

    @api.depends("action_type", "world_projection_id")
    def _compute_name(self):
        for record in self:
            record.name = "%s: %s" % (record.world_projection_id.world_name or "Welt", dict(record._fields["action_type"].selection).get(record.action_type, "Antrag"))

    @api.constrains("reason", "risk_class", "requester_id", "approver_id", "action_type", "release_hash", "requested_period_start")
    def _check_authoritative_shape(self):
        for record in self:
            if not record.reason or not record.reason.strip():
                raise ValidationError(_("Eine Begruendung ist Pflicht."))
            if record.risk_class == "high" and record.approver_id and record.approver_id == record.requester_id:
                raise ValidationError(_("Antragsteller und Freigeber duerfen nicht dieselbe Person sein."))
            if record.action_type == "infra_release_adoption" and record.risk_class != "high":
                raise ValidationError(_("Die Uebernahme eines InfraRelease ist immer hochriskant."))
            if record.action_type == "infra_release_adoption" and record.release_hash and len(record.release_hash) != 64:
                raise ValidationError(_("Der InfraRelease-Hash muss SHA-256 besitzen."))

    def _require_state(self, expected):
        if any(record.state != expected for record in self):
            raise UserError(_("Dieser Schritt ist im aktuellen Antragszustand nicht moeglich."))

    def action_submit(self):
        self._require_state("draft")
        if any(not request.reason.strip() for request in self):
            raise ValidationError(_("Eine Begruendung ist Pflicht."))
        self.write({"state": "submitted"})

    def action_approve(self):
        self._require_state("submitted")
        if not self.env.user.has_group("zugfolge_admin.group_zugfolge_approver"):
            raise AccessError(_("Nur Freigeber duerfen Antraege genehmigen."))
        for record in self:
            if record.risk_class == "high" and record.requester_id == self.env.user:
                raise AccessError(_("Hochrisikoantraege duerfen nicht selbst freigegeben werden."))
        self.write({"state": "approved", "approver_id": self.env.user.id})

    def action_reject(self):
        self._require_state("submitted")
        self.write({"state": "rejected", "approver_id": self.env.user.id})

    def action_dispatch(self):
        self._require_state("approved")
        self.write({"state": "dispatched"})
        for record in self:
            record.with_delay(description="Zugfolge-Administrationsantrag an Game senden")._dispatch_signed_game_command()

    def _dispatch_signed_game_command(self):
        """OCA queue_job retried this transport; the Game remains authoritative."""
        self._require_state("dispatched")
        for record in self:
            payload = {
                "kind": "admin.%s" % record.action_type,
                "worldId": record.world_projection_id.world_id,
                "actionType": record.action_type,
                "riskClass": record.risk_class,
                "requesterReference": str(record.requester_id.id),
                "approverReference": str(record.approver_id.id),
                "reason": record.reason,
                "effectPreview": record.effect_preview,
                "releaseHash": record.release_hash or None,
                "requestedPeriodStart": record.requested_period_start.isoformat() if record.requested_period_start else None,
            }
            dispatch_signed_game_command(self.env, record.correlation_id, str(self.env.user.id), payload)

    def apply_game_result(self, result):
        """Controller-only projection of the resulting authoritative Game audit event."""
        if not self.env.context.get("zugfolge_game_projection"):
            raise AccessError(_("Nur das Game darf Game-Ergebnisse projizieren."))
        state = result.get("state")
        if state not in ("accepted", "completed", "failed", "rejected"):
            raise ValidationError(_("Unbekannter Game-Ergebniszustand."))
        self.with_context(zugfolge_game_projection=True).write({
            "state": state,
            "game_audit_event_id": result.get("gameAuditEventId"),
            "game_result": result,
        })
