import hashlib
import json

from odoo import api, fields, models
from odoo.exceptions import AccessError, ValidationError

from .admin_request import validate_serialized_starting_capital_policy


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
    profile_kind = fields.Selection(
        [("public", "Oeffentlich"), ("tutorial", "Tutorial"), ("private", "Privat"), ("test", "Test")],
        readonly=True,
    )
    schedule_period = fields.Char(readonly=True)
    infra_release_hash = fields.Char(readonly=True)
    economy_release_hash = fields.Char(readonly=True)
    timetable_release_hash = fields.Char(readonly=True)
    fleet_release_hash = fields.Char(readonly=True)
    blueprint_hash = fields.Char(readonly=True)
    deployment_hash = fields.Char(readonly=True)
    starting_capital_mode = fields.Selection(
        [("finite", "Begrenzt"), ("unlimited", "Unbegrenzt (\u221e)")],
        readonly=True,
    )
    starting_capital_amount_cents = fields.Char(readonly=True)
    starting_capital_preview = fields.Char(readonly=True)
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
        if "profileKind" in body and body.get("profileKind") not in ("public", "tutorial", "private", "test"):
            raise ValidationError("Game-Weltprojektion besitzt kein gueltiges Weltprofil.")
        for hash_name in ("blueprintHash", "deploymentHash"):
            hash_value = body.get(hash_name)
            if hash_name in body and (not isinstance(hash_value, str) or len(hash_value) != 64 or any(character not in "0123456789abcdef" for character in hash_value)):
                raise ValidationError("Game-Weltprojektion besitzt keinen gueltigen SHA-256-Hash.")
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
            "profile_kind": body.get("profileKind"),
            "schedule_period": body.get("schedulePeriod"),
            "infra_release_hash": body.get("infraReleaseHash"),
            "economy_release_hash": body.get("economyReleaseHash"),
            "timetable_release_hash": releases.get("timetable"),
            "fleet_release_hash": releases.get("fleet"),
            "blueprint_hash": body.get("blueprintHash"),
            "deployment_hash": body.get("deploymentHash"),
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
        for field_name, body_name in (
            ("profile_kind", "profileKind"),
            ("blueprint_hash", "blueprintHash"),
            ("deployment_hash", "deploymentHash"),
        ):
            if body_name not in body:
                values.pop(field_name, None)
        if record:
            immutable_projection_values = (
                ("profile_kind", "profileKind"),
                ("blueprint_hash", "blueprintHash"),
                ("deployment_hash", "deploymentHash"),
            )
            for field_name, body_name in immutable_projection_values:
                current = record[field_name]
                incoming = body.get(body_name)
                if current and incoming is not None and current != incoming:
                    raise ValidationError("Die signierte Weltprojektion darf Profil und Deployment-Hashes nicht aendern.")
        if "startingCapitalPolicy" in body:
            mode, amount_cents, preview = validate_serialized_starting_capital_policy(body.get("startingCapitalPolicy"))
            if record and record.starting_capital_mode:
                existing = {
                    "mode": record.starting_capital_mode,
                    **({"amountCents": record.starting_capital_amount_cents} if record.starting_capital_mode == "finite" else {}),
                }
                if existing != body["startingCapitalPolicy"]:
                    raise ValidationError("Eine laufende Welt darf ihre Startkapital-Policy nicht aendern.")
            values.update({
                "starting_capital_mode": mode,
                "starting_capital_amount_cents": amount_cents,
                "starting_capital_preview": preview,
            })
        else:
            values.pop("starting_capital_mode", None)
            values.pop("starting_capital_amount_cents", None)
            values.pop("starting_capital_preview", None)
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
        immutable_fields = ("profile_kind", "blueprint_hash", "deployment_hash")
        capital_fields = {"starting_capital_mode", "starting_capital_amount_cents", "starting_capital_preview"}
        for record in self:
            for field_name in immutable_fields:
                if field_name in values and record[field_name] and values[field_name] != record[field_name]:
                    raise ValidationError("Die signierte Weltprojektion darf Profil und Deployment-Hashes nicht aendern.")
            if capital_fields.intersection(values):
                mode = values.get("starting_capital_mode", record.starting_capital_mode)
                amount = values.get("starting_capital_amount_cents", record.starting_capital_amount_cents)
                policy = {"mode": mode, **({"amountCents": amount} if mode == "finite" else {})}
                _, _, preview = validate_serialized_starting_capital_policy(policy)
                if "starting_capital_preview" in values and values["starting_capital_preview"] != preview:
                    raise ValidationError("Die Startkapital-Vorschau muss exakt aus der projizierten Policy stammen.")
                if record.starting_capital_mode:
                    existing = {
                        "mode": record.starting_capital_mode,
                        **({"amountCents": record.starting_capital_amount_cents} if record.starting_capital_mode == "finite" else {}),
                    }
                    if existing != policy:
                        raise ValidationError("Eine laufende Welt darf ihre Startkapital-Policy nicht aendern.")
        return super().write(values)

    def unlink(self):
        raise AccessError("Weltprojektionen sind unveraenderliche Auditprojektionen.")
