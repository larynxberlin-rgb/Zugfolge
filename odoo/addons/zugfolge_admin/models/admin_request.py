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
        [
            ("world_access_revoke", "Weltzugang entziehen"),
            ("infra_release_adoption", "InfraRelease zur Periode uebernehmen"),
            ("manual_disruption_create", "Manuelle Stoerung anlegen"),
            ("abuse_sanction_activate", "Schwere Missbrauchsmassnahme aktivieren"),
            ("world_close", "Weltabschluss einleiten"),
            ("tutorial_account_reset", "Tutorialkonto zuruecksetzen"),
        ],
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
    target_reference = fields.Char()
    requested_at_s = fields.Integer()
    game_capability_state = fields.Selection(
        [("prepared", "Vorbereitet: Game-Milestone fehlt"), ("available", "Vom Game ausfuehrbar"), ("unavailable", "Vom Game vorlaeufig nicht verfuegbar")],
        compute="_compute_game_capability", readonly=True,
    )
    game_capability_detail = fields.Char(compute="_compute_game_capability", readonly=True)
    manual_disruption_start = fields.Datetime()
    manual_disruption_end = fields.Datetime()
    manual_disruption_cause = fields.Text()
    manual_disruption_resource_ids = fields.Json(default=list)
    manual_disruption_effect = fields.Json(default=dict)

    @api.depends("action_type", "world_projection_id")
    def _compute_name(self):
        for record in self:
            record.name = "%s: %s" % (record.world_projection_id.world_name or "Welt", dict(record._fields["action_type"].selection).get(record.action_type, "Antrag"))

    @api.depends("action_type", "world_projection_id")
    def _compute_game_capability(self):
        capability_model = self.env["zugfolge.admin.capability"].sudo()
        for record in self:
            capability = capability_model.search([
                ("world_id", "=", record.world_projection_id.world_id),
                ("action_type", "=", record.action_type),
            ], limit=1) if record.world_projection_id and record.action_type else capability_model.browse()
            record.game_capability_state = capability.availability if capability else "prepared"
            record.game_capability_detail = capability.detail if capability else "Game-Implementierung und signierte Faehigkeitsprojektion stehen noch aus."

    @api.constrains("reason", "risk_class", "requester_id", "approver_id", "action_type", "release_hash", "requested_period_start", "target_reference", "requested_at_s", "manual_disruption_start", "manual_disruption_end", "manual_disruption_cause", "manual_disruption_resource_ids", "manual_disruption_effect")
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
            if record.action_type == "manual_disruption_create":
                if record.risk_class != "high":
                    raise ValidationError(_("Eine manuelle Stoerung ist immer hochriskant."))
                if not record.manual_disruption_start or not record.manual_disruption_end or record.manual_disruption_end <= record.manual_disruption_start:
                    raise ValidationError(_("Manuelle Stoerungen brauchen einen gueltigen Beginn vor dem Ende."))
                if not record.manual_disruption_cause or not record.manual_disruption_cause.strip():
                    raise ValidationError(_("Manuelle Stoerungen brauchen eine Ursache."))
                if not isinstance(record.manual_disruption_resource_ids, list) or not record.manual_disruption_resource_ids or not all(isinstance(resource_id, str) and resource_id.strip() for resource_id in record.manual_disruption_resource_ids):
                    raise ValidationError(_("Manuelle Stoerungen brauchen betroffene Ressourcen mit stabilen Bezeichnern."))
                if not isinstance(record.manual_disruption_effect, dict) or not record.manual_disruption_effect:
                    raise ValidationError(_("Manuelle Stoerungen brauchen eine deklarierte Wirkung."))
            if record.action_type in ("abuse_sanction_activate", "world_close") and record.risk_class != "high":
                raise ValidationError(_("Schwere Sanktionen und Weltende sind immer hochriskant."))
            if record.action_type in ("world_access_revoke", "abuse_sanction_activate", "tutorial_account_reset") and not (record.target_reference or "").strip():
                raise ValidationError(_("Die Verwaltungsaktion braucht eine stabile Zielreferenz."))
            if record.action_type in ("world_close", "tutorial_account_reset") and (record.requested_at_s is None or record.requested_at_s < 0):
                raise ValidationError(_("Die Verwaltungsaktion braucht eine gueltige Simulationszeit."))

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
        if any(request.game_capability_state != "available" for request in self):
            raise UserError(_("Das Game hat diese Verwaltungsfaehigkeit noch nicht als ausfuehrbar projektiert. Der Antrag bleibt freigegeben und wirkungslos."))
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
                "targetReference": record.target_reference or None,
                "requestedAtS": record.requested_at_s,
            }
            if record.action_type == "manual_disruption_create":
                payload["manualDisruption"] = {
                    "startsAt": record.manual_disruption_start.isoformat(),
                    "endsAt": record.manual_disruption_end.isoformat(),
                    "cause": record.manual_disruption_cause,
                    "affectedResourceIds": record.manual_disruption_resource_ids,
                    "declaredEffect": record.manual_disruption_effect,
                }
            actor_reference = self.env["ir.config_parameter"].sudo().get_param("zugfolge_admin.actor_reference")
            if not actor_reference:
                raise UserError(_("Der Zugfolge-Integrationsakteur ist nicht konfiguriert."))
            dispatch_signed_game_command(self.env, record.correlation_id, actor_reference, payload)

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
