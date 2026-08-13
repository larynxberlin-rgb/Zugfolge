import hashlib
import json

from odoo import api, fields, models
from odoo.exceptions import AccessError, ValidationError


class ZugfolgeFeedback(models.Model):
    """Native Odoo activity-backed feedback, always linked to a defined projection."""

    _name = "zugfolge.feedback"
    _description = "Zugfolge Feedback"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "create_date desc"

    name = fields.Char(required=True, tracking=True)
    world_projection_id = fields.Many2one("zugfolge.world.projection", required=True, ondelete="restrict", index=True)
    source = fields.Selection([("game", "Spielerfeedback aus Game"), ("operator", "Betriebsnotiz")], required=True, default="operator", readonly=True)
    feedback_reference = fields.Char(readonly=True, copy=False, index=True)
    participant_pseudonym = fields.Char(readonly=True, copy=False, index=True)
    period_reference = fields.Char()
    release_hash = fields.Char()
    metric_key = fields.Char()
    authoritative_event_url = fields.Char()
    report_reference = fields.Char()
    body = fields.Html(required=True)
    from_s = fields.Integer(readonly=True)
    until_s = fields.Integer(readonly=True)
    contact_allowed = fields.Boolean(readonly=True)
    submitted_at = fields.Datetime(readonly=True)
    payload_hash = fields.Char(readonly=True, copy=False)
    triage_state = fields.Selection([("new", "Neu"), ("triaged", "Triage"), ("resolved", "Geloest"), ("rejected", "Verworfen")], required=True, default="new", tracking=True)

    _feedback_reference_unique = models.Constraint(
        "unique(feedback_reference)",
        "Eine Game-Feedbackreferenz darf nur einmal angenommen werden.",
    )
    _projected_fields = {
        "source", "feedback_reference", "participant_pseudonym", "world_projection_id", "period_reference",
        "release_hash", "metric_key", "report_reference", "body", "from_s", "until_s", "contact_allowed",
        "submitted_at", "payload_hash",
    }

    @api.model
    def upsert_game_projection(self, envelope):
        if not self.env.context.get("zugfolge_game_projection"):
            raise AccessError("Spielerfeedback darf nur ueber den signierten Game-Pfad projiziert werden.")
        body = envelope.get("payload")
        world_id = envelope.get("worldId")
        if not isinstance(body, dict) or not isinstance(world_id, str):
            raise ValidationError("Unvollstaendige Feedbackprojektion.")
        feedback_reference = body.get("feedbackReference")
        participant_pseudonym = body.get("participantPseudonym")
        message = body.get("message")
        if not all(isinstance(value, str) and value.strip() for value in (feedback_reference, participant_pseudonym, message)):
            raise ValidationError("Feedbackprojektion braucht Referenz, Pseudonym und Nachricht.")
        projection = self.env["zugfolge.world.projection"].search([("world_id", "=", world_id)], limit=1)
        if not projection:
            raise ValidationError("Feedbackprojektion verweist auf keine bekannte Weltprojektion.")
        payload_hash = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")).hexdigest()
        existing = self.search([("feedback_reference", "=", feedback_reference)], limit=1)
        if existing:
            if existing.payload_hash != payload_hash:
                raise ValidationError("Feedbackreferenz besitzt eine abweichende Nutzlast.")
            return existing.with_context(zugfolge_game_projection=False)
        values = {
            "name": "%s: %s" % (body.get("category", "Feedback"), feedback_reference),
            "world_projection_id": projection.id,
            "source": "game",
            "feedback_reference": feedback_reference,
            "participant_pseudonym": participant_pseudonym,
            "period_reference": "%s-%s" % (body.get("fromS"), body.get("untilS")),
            "release_hash": body.get("releaseHash"),
            "metric_key": body.get("category"),
            "report_reference": body.get("reportReference"),
            "body": message,
            "from_s": body.get("fromS"),
            "until_s": body.get("untilS"),
            "contact_allowed": body.get("contactAllowed", False),
            "submitted_at": body.get("submittedAt") or envelope.get("occurredAt"),
            "payload_hash": payload_hash,
        }
        created = self.with_context(zugfolge_game_projection=True).create(values)
        return created.with_context(zugfolge_game_projection=False)

    @api.model_create_multi
    def create(self, values_list):
        if any(values.get("source") == "game" for values in values_list) and not self.env.context.get("zugfolge_game_projection"):
            raise AccessError("Game-Feedback darf nicht manuell angelegt werden.")
        return super().create(values_list)

    def write(self, values):
        if self._projected_fields.intersection(values) and not self.env.context.get("zugfolge_game_projection"):
            raise AccessError("Projizierte Feedbackdaten sind unveraenderlich; nur die Triage darf bearbeitet werden.")
        return super().write(values)
