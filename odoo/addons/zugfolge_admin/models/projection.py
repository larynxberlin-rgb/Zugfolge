import hashlib
import json

from odoo import api, fields, models
from odoo.exceptions import AccessError, ValidationError


class ZugfolgeWorldProjection(models.Model):
    """Read-only, versioned Game projection; never a second simulation truth."""

    _name = "zugfolge.world.projection"
    _description = "Zugfolge Weltprojektion"
    _rec_name = "world_name"
    _order = "observed_at desc, world_id"

    world_id = fields.Char(required=True, index=True, readonly=True)
    world_name = fields.Char(required=True, readonly=True)
    projection_revision = fields.Char(required=True, readonly=True)
    observed_at = fields.Datetime(required=True, readonly=True)
    freshness = fields.Selection(
        [("live", "Live"), ("delayed", "Verzoegerte Projektion"), ("historical", "Historischer Bericht"), ("derived", "Abgeleitete Kennzahl")],
        required=True,
        readonly=True,
    )
    simulation_time = fields.Datetime(readonly=True)
    world_status = fields.Char(readonly=True)
    schedule_period = fields.Char(readonly=True)
    infra_release_hash = fields.Char(readonly=True)
    economy_release_hash = fields.Char(readonly=True)
    runtime_status = fields.Char(readonly=True)
    worker_status = fields.Char(readonly=True)
    telemetry = fields.Json(readonly=True)
    authoritative_event_url = fields.Char(readonly=True)
    payload_hash = fields.Char(required=True, readonly=True)

    @api.model
    def upsert_game_projection(self, payload):
        """Only the HMAC-verified controller invokes this method with a service context."""
        if not self.env.context.get("zugfolge_game_projection"):
            raise AccessError("Game-Projektionen duerfen nur ueber den signierten Integrationspfad geschrieben werden.")
        world_id = payload.get("worldId")
        body = payload.get("payload")
        if not isinstance(world_id, str) or not isinstance(body, dict):
            raise ValidationError("Unvollstaendige Game-Projektion.")
        body_json = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        values = {
            "world_id": world_id,
            "world_name": body.get("worldName", world_id),
            "projection_revision": str(body.get("projectionRevision", payload.get("messageId"))),
            "observed_at": payload.get("occurredAt"),
            "freshness": body.get("freshness", "delayed"),
            "simulation_time": body.get("simulationTime"),
            "world_status": body.get("worldStatus"),
            "schedule_period": body.get("schedulePeriod"),
            "infra_release_hash": body.get("infraReleaseHash"),
            "economy_release_hash": body.get("economyReleaseHash"),
            "runtime_status": body.get("runtimeStatus"),
            "worker_status": body.get("workerStatus"),
            "telemetry": body.get("telemetry", {}),
            "authoritative_event_url": body.get("authoritativeEventUrl"),
            "payload_hash": hashlib.sha256(body_json.encode("utf-8")).hexdigest(),
        }
        record = self.search([("world_id", "=", world_id)], limit=1)
        if record:
            record.with_context(zugfolge_game_projection=True).write(values)
            return record
        return self.with_context(zugfolge_game_projection=True).create(values)

    @api.model_create_multi
    def create(self, values_list):
        if not self.env.context.get("zugfolge_game_projection"):
            raise AccessError("Weltprojektionen sind nur lesbar.")
        return super().create(values_list)

    def write(self, values):
        if not self.env.context.get("zugfolge_game_projection"):
            raise AccessError("Weltprojektionen sind nur lesbar.")
        return super().write(values)

    def unlink(self):
        raise AccessError("Weltprojektionen sind unveraenderliche Auditprojektionen.")
