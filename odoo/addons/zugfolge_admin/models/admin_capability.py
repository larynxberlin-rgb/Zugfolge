import re
from odoo import api, fields, models
from odoo.exceptions import AccessError, ValidationError

from .canonical_json import canonical_sha256
from .rfc3339 import rfc3339_utc


ADMIN_ACTIONS = [
    ("world_access_revoke", "Weltzugang entziehen"),
    ("infra_release_adoption", "InfraRelease zur Periode uebernehmen"),
    ("manual_disruption_create", "Manuelle Stoerung anlegen"),
    ("disruption_policy_schedule", "Stoerungsrichtlinie veroeffentlichen"),
    ("abuse_sanction_activate", "Schwere Missbrauchsmassnahme aktivieren"),
    ("world_close", "Weltabschluss einleiten"),
    ("world_deploy", "Signierte Welt bereitstellen"),
]
CAPABILITY_STATES = [
    ("prepared", "Vorbereitet: Game-Milestone fehlt"),
    ("available", "Vom Game ausfuehrbar"),
    ("unavailable", "Vom Game vorlaeufig nicht verfuegbar"),
]
GLOBAL_WORLD_DEPLOY_CAPABILITY_SCOPE_ID = "00000000-0000-0000-0000-000000000000"


class ZugfolgeAdminCapability(models.Model):
    """Signed Game projection of an explicitly implemented command capability."""

    _name = "zugfolge.admin.capability"
    _description = "Zugfolge Game-Verwaltungsfaehigkeit"
    _rec_name = "action_type"
    _order = "world_id, action_type"
    _world_action_unique = models.Constraint(
        "unique(world_id, action_type)",
        "Eine Verwaltungsfaehigkeit je Welt und Aktion.",
    )

    world_id = fields.Char(required=True, readonly=True, index=True)
    action_type = fields.Selection(ADMIN_ACTIONS, required=True, readonly=True, index=True)
    availability = fields.Selection(CAPABILITY_STATES, required=True, readonly=True)
    detail = fields.Char(readonly=True)
    observed_at = fields.Datetime(required=True, readonly=True)
    payload_hash = fields.Char(required=True, readonly=True)

    @api.model
    def upsert_game_projection(self, payload):
        """Only the HMAC-verified controller can make a capability executable."""
        if not self.env.context.get("zugfolge_game_projection"):
            raise AccessError("Game-Verwaltungsfaehigkeiten duerfen nur ueber den signierten Integrationspfad geschrieben werden.")
        body = payload.get("payload")
        action_types = dict(ADMIN_ACTIONS)
        states = dict(CAPABILITY_STATES)
        if not isinstance(body, dict) or not isinstance(payload.get("worldId"), str) or body.get("actionType") not in action_types or body.get("availability") not in states:
            raise ValidationError("Unvollstaendige Game-Verwaltungsfaehigkeit.")
        world_id = payload["worldId"]
        if body["actionType"] == "world_deploy" and world_id == GLOBAL_WORLD_DEPLOY_CAPABILITY_SCOPE_ID and body.get("targetWorldId") is not None:
            world_id = body["targetWorldId"]
            if not isinstance(world_id, str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", world_id):
                raise ValidationError("Weltbereitstellung braucht die exakte Hauptwelt des sendenden Servers.")
        values = {
            "world_id": world_id,
            "action_type": body["actionType"],
            "availability": body["availability"],
            "detail": body.get("detail"),
            "observed_at": rfc3339_utc(payload.get("occurredAt"), "occurredAt"),
            "payload_hash": canonical_sha256(body),
        }
        record = self.search([("world_id", "=", values["world_id"]), ("action_type", "=", values["action_type"])], limit=1)
        if record:
            record.with_context(zugfolge_game_projection=True).write(values)
            return record
        return self.with_context(zugfolge_game_projection=True).create(values)

    @api.model_create_multi
    def create(self, values_list):
        if not self.env.context.get("zugfolge_game_projection"):
            raise AccessError("Game-Verwaltungsfaehigkeiten sind nur lesbar.")
        return super().create(values_list)

    def write(self, values):
        if not self.env.context.get("zugfolge_game_projection"):
            raise AccessError("Game-Verwaltungsfaehigkeiten sind nur lesbar.")
        return super().write(values)

    def unlink(self):
        raise AccessError("Game-Verwaltungsfaehigkeiten sind unveraenderliche Projektionen.")
