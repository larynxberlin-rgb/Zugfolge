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
    timetable_release_hash = fields.Char(readonly=True)
    fleet_release_hash = fields.Char(readonly=True)
    runtime_status = fields.Char(readonly=True)
    worker_status = fields.Char(readonly=True)
    running_trains = fields.Integer(readonly=True)
    delayed_trains = fields.Integer(readonly=True)
    cancelled_trains = fields.Integer(readonly=True)
    disruption_count = fields.Integer(readonly=True)
    replacement_count = fields.Integer(readonly=True)
    public_lot_count = fields.Integer(readonly=True)
    player_lot_count = fields.Integer(readonly=True)
    event_rate_per_minute = fields.Integer(readonly=True)
    planning_queue_depth = fields.Integer(readonly=True)
    economy_outbox_depth = fields.Integer(readonly=True)
    odoo_command_queue = fields.Json(readonly=True)
    odoo_bridge_status = fields.Json(readonly=True)
    provider_status = fields.Json(readonly=True)
    reconciliation_status = fields.Json(readonly=True)
    conflict_count = fields.Integer(readonly=True)
    capacity_bottleneck_count = fields.Integer(readonly=True)
    penalties_and_deductions = fields.Integer(readonly=True)
    anomaly_count = fields.Integer(readonly=True)
    market_activity = fields.Json(readonly=True)
    event_age_seconds = fields.Integer(readonly=True)
    projection_age_seconds = fields.Integer(readonly=True)
    drill_down = fields.Json(readonly=True)
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
        telemetry = body.get("telemetry", {}) if isinstance(body.get("telemetry", {}), dict) else {}
        live = telemetry.get("live", {}) if isinstance(telemetry.get("live", {}), dict) else {}
        shares = telemetry.get("operationShares", {}) if isinstance(telemetry.get("operationShares", {}), dict) else {}
        workers = telemetry.get("workers", {}) if isinstance(telemetry.get("workers", {}), dict) else {}
        bridges = telemetry.get("bridges", {}) if isinstance(telemetry.get("bridges", {}), dict) else {}
        economy = telemetry.get("economy", {}) if isinstance(telemetry.get("economy", {}), dict) else {}
        world = telemetry.get("world", {}) if isinstance(telemetry.get("world", {}), dict) else {}
        releases = world.get("releases", {}) if isinstance(world.get("releases", {}), dict) else {}
        age = telemetry.get("freshness", {}) if isinstance(telemetry.get("freshness", {}), dict) else {}
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
            "timetable_release_hash": releases.get("timetable"),
            "fleet_release_hash": releases.get("fleet"),
            "runtime_status": body.get("runtimeStatus"),
            "worker_status": body.get("workerStatus"),
            "running_trains": live.get("runningTrains", 0),
            "delayed_trains": live.get("delayedTrains", 0),
            "cancelled_trains": live.get("cancelledTrains", 0),
            "disruption_count": live.get("disruptions", 0),
            "replacement_count": live.get("replacementConcepts", 0),
            "public_lot_count": shares.get("publicLots", 0),
            "player_lot_count": shares.get("playerLots", 0),
            "event_rate_per_minute": live.get("eventRatePerMinute", 0),
            "planning_queue_depth": workers.get("planningQueueDepth", 0),
            "economy_outbox_depth": workers.get("economyOutboxDepth", 0),
            "odoo_command_queue": workers.get("odooCommandQueue", {}),
            "odoo_bridge_status": bridges.get("odooProjection", {}),
            "provider_status": bridges.get("provider", []),
            "reconciliation_status": bridges.get("reconciliation", {}),
            "conflict_count": economy.get("conflicts", 0),
            "capacity_bottleneck_count": economy.get("capacityBottlenecks", 0),
            "penalties_and_deductions": economy.get("penaltiesAndDeductions", 0),
            "anomaly_count": economy.get("anomalies", 0),
            "market_activity": telemetry.get("market", {}),
            "event_age_seconds": age.get("eventAgeSeconds"),
            "projection_age_seconds": age.get("projectionAgeSeconds"),
            "drill_down": telemetry.get("drillDown", {}),
            "telemetry": telemetry,
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
