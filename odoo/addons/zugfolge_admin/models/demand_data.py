"""Direct Odoo data maintenance with automatic, durable world synchronization."""

import base64
import binascii
import uuid

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from ..services import dispatch_signed_game_command
from .canonical_json import canonical_sha256
from .demand_data_contract import build_command, demand_class, integer, parse_release, rebalance_population


_WRITE_KEY = "_zugfolge_demand_data_capability"
_WRITE_TOKEN = object()
_BATCH_KEY = "_zugfolge_demand_data_batch"
_BATCH_TOKEN = object()
_ADMIN_GROUP = "zugfolge_admin.group_zugfolge_admin"


def _internal(record):
    return record.env.context.get(_WRITE_KEY) is _WRITE_TOKEN


def _controlled(record):
    context = {key: value for key, value in record.env.context.items() if not key.startswith("default_")}
    context[_WRITE_KEY] = _WRITE_TOKEN
    return record.with_context(context)


def _require_admin(record):
    if _WRITE_KEY in record.env.context and not _internal(record):
        raise AccessError(_("Die interne Datenpflege kann nicht über einen RPC-Kontext freigegeben werden."))
    if _BATCH_KEY in record.env.context and record.env.context[_BATCH_KEY] is not _BATCH_TOKEN:
        raise AccessError(_("Die Datenänderung kann nicht über einen RPC-Kontext gebündelt werden."))
    if not record.env.user.has_group(_ADMIN_GROUP):
        raise AccessError(_("Nur Zugfolge-Administratoren dürfen Nachfragedaten bearbeiten."))


def _validate(callable_, *arguments):
    try:
        return callable_(*arguments)
    except (ValueError, TypeError, KeyError, UnicodeError, binascii.Error) as error:
        raise ValidationError(str(error)) from error


def _check_defaults(record, allowed):
    # Odoo applies context defaults inside super().create, after our vals check.
    # They must not become a second RPC path to protected source/audit fields.
    if any(key.startswith("default_") and key[8:] in record._fields and key[8:] not in allowed
           for key in record.env.context):
        raise AccessError(_("Geschützte Original- und Auditwerte dürfen nicht als Vorgaben gesetzt werden."))


def _check_numbers(values):
    # Check before Odoo Integer coercion could silently truncate floats or bools.
    for field in ("population", "connections"):
        if field in values:
            _validate(integer, values[field])


class ZugfolgeDemandData(models.Model):
    _name = "zugfolge.demand.data"
    _description = "Zugfolge Nachfragedaten"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "write_date desc"
    _world_basis_unique = models.Constraint("unique(world_id, base_release_id)", "Diese Datengrundlage wird für die Welt bereits gepflegt.")

    name = fields.Char(string="Bezeichnung", required=True, default="Nachfragedaten", tracking=True)
    world_id = fields.Char(string="Weltkennung", required=True, index=True, tracking=True)
    initial_file = fields.Binary(string="Bestehende Datengrundlage", attachment=False, copy=False)
    initial_filename = fields.Char(string="Dateiname", copy=False)
    base_release_id = fields.Char(string="Datengrundlage", readonly=True, copy=False, index=True)
    base_release = fields.Json(string="Unveränderte Originaldaten", readonly=True, copy=False)
    base_sha256 = fields.Char(string="Originaldatei SHA-256", readonly=True, copy=False)
    source_revision = fields.Integer(string="Gespeicherte Datenrevision", default=0, readonly=True, copy=False)
    last_command_hash = fields.Char(readonly=True, copy=False)
    settlement_ids = fields.One2many("zugfolge.demand.settlement", "data_id", string="Orte und Einwohner", copy=False)
    station_ids = fields.One2many("zugfolge.demand.station", "data_id", string="Stationen und Klassen", copy=False)
    allocation_ids = fields.One2many("zugfolge.demand.allocation", "data_id", string="Stationsanteile", copy=False)
    connection_ids = fields.One2many("zugfolge.demand.connection", "data_id", string="Verbindungshinweise", copy=False)
    event_ids = fields.One2many("zugfolge.demand.data.event", "data_id", string="Änderungsverlauf und Übertragung", readonly=True, copy=False)
    sync_state = fields.Selection([("empty", "Noch keine Daten"), ("queued", "Übertragung läuft"),
                                   ("received", "Vom Weltserver empfangen"), ("accepted", "Wirksam"),
                                   ("rejected", "Vom Weltserver abgelehnt")], compute="_compute_sync")
    sync_detail = fields.Char(string="Rückmeldung", compute="_compute_sync")

    @api.depends("event_ids.state", "event_ids.detail", "source_revision")
    def _compute_sync(self):
        for record in self:
            event = record.event_ids.filtered(lambda item: item.source_revision == record.source_revision)[:1]
            record.sync_state = event.state if event else "empty"
            record.sync_detail = event.detail if event else False

    @api.model_create_multi
    def create(self, values_list):
        _require_admin(self)
        allowed = {"name", "world_id", "initial_file", "initial_filename"}
        _check_defaults(self, allowed)
        if any(set(values) - allowed for values in values_list):
            raise AccessError(_("Originaldaten, Datenrevisionen und technische Belege werden ausschließlich intern angelegt."))
        return super().create(values_list)

    def _lock(self):
        if self:
            self.flush_recordset()
            self.env.cr.execute("SELECT id FROM zugfolge_demand_data WHERE id IN %s ORDER BY id FOR UPDATE", (tuple(sorted(self.ids)),))
            self.invalidate_recordset()

    def write(self, values):
        if _internal(self):
            return super().write(values)
        _require_admin(self)
        allowed = {"name", "world_id", "initial_file", "initial_filename", "settlement_ids", "allocation_ids", "connection_ids"}
        if set(values) - allowed:
            raise AccessError(_("Quellen, Stationskennungen und technische Belege sind unveränderlich."))
        self._lock()
        if any(record.base_release_id for record in self) and {"world_id", "initial_file", "initial_filename"}.intersection(values):
            raise AccessError(_("Welt und Originaldaten bleiben nach der ersten Erfassung unverändert."))
        populations_before = {record.id: {line.id: line.population for line in record.settlement_ids} for record in self}
        # The opaque capability batches nested One2many writes into one command.
        result = super(ZugfolgeDemandData, self.with_context(**{_BATCH_KEY: _BATCH_TOKEN})).write(values)
        for record in self:
            for settlement in record.settlement_ids:
                if populations_before[record.id].get(settlement.id) != settlement.population:
                    record._rebalance(settlement)
            record._queue_current()
        return result

    def unlink(self):
        raise AccessError(_("Nachfragedaten und ihre Änderungshistorie dürfen nicht gelöscht werden."))

    def action_import(self):
        _require_admin(self)
        self.ensure_one()
        self._lock()
        if self.base_release_id:
            raise UserError(_("Die Originaldaten sind bereits erfasst. Änderungen werden direkt in den Tabellen gespeichert."))
        if not self.initial_file:
            raise ValidationError(_("Bitte die bestehende einwohnerbasierte Datengrundlage auswählen."))
        encoded = self.initial_file
        if len(encoded) > 24 * 1024 * 1024:
            raise ValidationError(_("Die Originaldatei überschreitet die Größenbegrenzung."))
        release, digest = _validate(parse_release, _validate(base64.b64decode, encoded, None, True))
        model = release["populationModel"]
        _controlled(self).write({"base_release_id": release["id"], "base_release": release,
                                           "base_sha256": digest, "initial_file": False})
        settlements = {}
        for row in model["settlements"]:
            settlements[row["id"]] = _controlled(self.env["zugfolge.demand.settlement"]).create({
                "data_id": self.id, "settlement_id": row["id"], "name": row["name"], "source_id": row["sourceId"],
                "original_population": row["population"], "population": row["population"],
            })
        stations = {}
        for area in model["stationAreas"]:
            stations[area["zoneId"]] = _controlled(self.env["zugfolge.demand.station"]).create({
                "data_id": self.id, "zone_id": area["zoneId"], "station_id": area["stationId"],
            })
            for allocation in area["populationAllocations"]:
                _controlled(self.env["zugfolge.demand.allocation"]).create({
                    "data_id": self.id, "settlement_ref_id": settlements[allocation["settlementId"]].id,
                    "station_ref_id": stations[area["zoneId"]].id, "population": allocation["population"],
                    "original_population": allocation["population"],
                })
        for hint in model["destinationPreferences"]:
            _controlled(self.env["zugfolge.demand.connection"]).create({
                "data_id": self.id, "origin_id": stations[hint["originZoneId"]].id,
                "destination_id": stations[hint["destinationZoneId"]].id,
                "connections": hint["referenceConnections"], "original_connections": hint["referenceConnections"],
            })
        self._queue_current()
        self.message_post(body=_("Originaldaten erfasst. Änderungen an Einwohnern, Stationsanteilen und Verbindungshinweisen werden beim Speichern automatisch wirksam."))
        return True

    def _rebalance(self, settlement):
        lines = self.allocation_ids.filtered(lambda line: line.settlement_ref_id == settlement)
        if sum(lines.mapped("population")) == settlement.population:
            return
        allocated = _validate(rebalance_population, settlement.population, [(line.station_ref_id.zone_id, line.population) for line in lines])
        for line in lines:
            _controlled(line).write({"population": allocated[line.station_ref_id.zone_id]})

    def _command(self, revision):
        self.ensure_one()
        return _validate(build_command, self.world_id, revision, self.base_release,
                         {line.settlement_id: line.population for line in self.settlement_ids},
                         [(line.settlement_ref_id.settlement_id, line.station_ref_id.zone_id, line.population) for line in self.allocation_ids],
                         [(line.origin_id.zone_id, line.destination_id.zone_id, line.connections) for line in self.connection_ids])

    def _queue_current(self):
        self.ensure_one()
        if not self.base_release_id:
            return
        command = self._command(self.source_revision + 1)
        comparison = {key: value for key, value in command.items() if key != "sourceRevision"}
        digest = canonical_sha256(comparison)
        if self.last_command_hash == digest:
            return
        revision = command["sourceRevision"]
        event = _controlled(self.env["zugfolge.demand.data.event"]).create({
            "data_id": self.id, "source_revision": revision, "command_json": command,
            "command_hash": canonical_sha256(command), "correlation_id": str(uuid.uuid4()),
            "editor_id": self.env.user.id,
        })
        _controlled(self).write({"source_revision": revision, "last_command_hash": digest})
        self.message_post(body=_("Nachfragedaten gespeichert: Revision %s. Die automatische Übertragung wurde eingeplant.") % revision)
        event.with_delay(description="Gespeicherte Zugfolge-Nachfragedaten an Weltserver übertragen")._dispatch()


class ZugfolgeDemandLine(models.AbstractModel):
    _name = "zugfolge.demand.line"
    _description = "Geschützte Zeile der Nachfragedatenpflege"
    data_id = fields.Many2one("zugfolge.demand.data", required=True, ondelete="restrict", index=True)
    _editable_fields = frozenset()
    _creatable_fields = frozenset()

    @api.model_create_multi
    def create(self, values_list):
        if _internal(self):
            return super().create(values_list)
        _require_admin(self)
        _check_defaults(self, self._creatable_fields)
        if not self._creatable_fields or any(set(values) - self._creatable_fields for values in values_list):
            raise AccessError(_("Quellorte und Stationen werden aus der Originalgrundlage übernommen."))
        for values in values_list:
            _check_numbers(values)
        for field in ("population", "connections"):
            if "default_" + field in self.env.context:
                _validate(integer, self.env.context["default_" + field])
        parents = self.env["zugfolge.demand.data"].browse([values.get("data_id") for values in values_list]).exists()
        parents._lock()
        if len(parents) == 0 or any(not parent.base_release_id for parent in parents):
            raise ValidationError(_("Eine bereits erfasste Datengrundlage ist erforderlich."))
        records = super().create(values_list)
        if self.env.context.get(_BATCH_KEY) is not _BATCH_TOKEN:
            for parent in parents:
                parent._queue_current()
        return records

    def write(self, values):
        # Nested public parent.write has already checked the outer fields. The
        # child still guards its immutable IDs and source facts against RPC data.
        _require_admin(self)
        if set(values) - self._editable_fields and not _internal(self):
            raise AccessError(_("Kennungen, Originalwerte und Zugehörigkeit sind unveränderlich."))
        if _internal(self):
            return super().write(values)
        _check_numbers(values)
        parents = self.mapped("data_id")
        parents._lock()
        result = super().write(values)
        if self.env.context.get(_BATCH_KEY) is not _BATCH_TOKEN:
            if self._name == "zugfolge.demand.settlement" and "population" in values:
                for line in self:
                    line.data_id._rebalance(line)
            for parent in parents:
                parent._queue_current()
        return result

    def unlink(self):
        raise AccessError(_("Für nicht mehr gewünschte Anteile oder Verbindungen bitte den Wert auf null setzen."))


class ZugfolgeDemandSettlement(models.Model):
    _name = "zugfolge.demand.settlement"
    _inherit = "zugfolge.demand.line"
    _description = "Einwohner eines Nachfrageortes"
    _order = "name, settlement_id"
    _editable_fields = frozenset({"population"})
    _settlement_unique = models.Constraint("unique(data_id, settlement_id)", "Ein Ort darf nur einmal geführt werden.")
    settlement_id = fields.Char(string="Ortskennung", required=True, readonly=True)
    name = fields.Char(string="Ort", required=True, readonly=True)
    source_id = fields.Char(string="Originalquelle", required=True, readonly=True)
    original_population = fields.Integer(string="Einwohner laut Quelle", readonly=True)
    population = fields.Integer(string="Wirksame Einwohner", required=True)

    @api.constrains("population")
    def _check_population(self):
        for line in self:
            _validate(integer, line.population)


class ZugfolgeDemandStation(models.Model):
    _name = "zugfolge.demand.station"
    _inherit = "zugfolge.demand.line"
    _description = "Nachfragestation und abgeleitete Klasse"
    _rec_name = "station_id"
    _order = "station_id"
    _station_unique = models.Constraint("unique(data_id, station_id)", "Eine Station darf nur einmal geführt werden.")
    _zone_unique = models.Constraint("unique(data_id, zone_id)", "Ein Stationsgebiet darf nur einmal geführt werden.")
    zone_id = fields.Char(string="Gebietskennung", required=True, readonly=True)
    station_id = fields.Char(string="Stationskennung", required=True, readonly=True)
    allocation_ids = fields.One2many("zugfolge.demand.allocation", "station_ref_id", readonly=True)
    population = fields.Integer(string="Zugeordnete Einwohner", compute="_compute_population")
    demand_class = fields.Integer(string="Nachfrageklasse (0–10)", compute="_compute_population")

    @api.depends("allocation_ids.population")
    def _compute_population(self):
        for station in self:
            station.population = sum(station.allocation_ids.mapped("population"))
            station.demand_class = demand_class(station.population)


class ZugfolgeDemandAllocation(models.Model):
    _name = "zugfolge.demand.allocation"
    _inherit = "zugfolge.demand.line"
    _description = "Einwohneranteil einer Station"
    _order = "settlement_ref_id, station_ref_id"
    _editable_fields = frozenset({"population"})
    _creatable_fields = frozenset({"data_id", "settlement_ref_id", "station_ref_id", "population"})
    _allocation_unique = models.Constraint("unique(data_id, settlement_ref_id, station_ref_id)", "Dieser Ort ist der Station bereits zugeordnet.")
    settlement_ref_id = fields.Many2one("zugfolge.demand.settlement", string="Ort", required=True, ondelete="restrict")
    station_ref_id = fields.Many2one("zugfolge.demand.station", string="Station", required=True, ondelete="restrict")
    original_population = fields.Integer(string="Anteil der Originalgrundlage", readonly=True, default=0)
    population = fields.Integer(string="Wirksamer Einwohneranteil", required=True)

    @api.constrains("data_id", "settlement_ref_id", "station_ref_id", "population")
    def _check_allocation(self):
        for line in self:
            if line.settlement_ref_id.data_id != line.data_id or line.station_ref_id.data_id != line.data_id:
                raise ValidationError(_("Ort und Station müssen derselben Datengrundlage angehören."))
            _validate(integer, line.population)


class ZugfolgeDemandConnection(models.Model):
    _name = "zugfolge.demand.connection"
    _inherit = "zugfolge.demand.line"
    _description = "Gerichteter Nachfrage-Verbindungshinweis"
    _order = "origin_id, destination_id"
    _editable_fields = frozenset({"connections"})
    _creatable_fields = frozenset({"data_id", "origin_id", "destination_id", "connections"})
    _connection_unique = models.Constraint("unique(data_id, origin_id, destination_id)", "Dieser gerichtete Verbindungshinweis besteht bereits.")
    origin_id = fields.Many2one("zugfolge.demand.station", string="Von Station", required=True, ondelete="restrict")
    destination_id = fields.Many2one("zugfolge.demand.station", string="Nach Station", required=True, ondelete="restrict")
    original_connections = fields.Integer(string="Direktfahrten laut Referenz", readonly=True, default=0)
    connections = fields.Integer(string="Wirksame Direktfahrten / Referenzwoche", required=True)

    @api.constrains("data_id", "origin_id", "destination_id", "connections")
    def _check_connection(self):
        for line in self:
            if line.origin_id == line.destination_id or line.origin_id.data_id != line.data_id or line.destination_id.data_id != line.data_id:
                raise ValidationError(_("Verbindungen brauchen zwei verschiedene Stationen derselben Datengrundlage."))
            _validate(integer, line.connections)


class ZugfolgeDemandDataEvent(models.Model):
    _name = "zugfolge.demand.data.event"
    _description = "Unveränderlicher Nachfragedaten-Änderungsbeleg"
    _order = "source_revision desc"
    _revision_unique = models.Constraint("unique(data_id, source_revision)", "Die Datenrevision ist bereits gespeichert.")
    _correlation_unique = models.Constraint("unique(correlation_id)", "Die Übertragungskorrelation ist bereits vergeben.")
    data_id = fields.Many2one("zugfolge.demand.data", required=True, ondelete="restrict", readonly=True)
    source_revision = fields.Integer(string="Revision", required=True, readonly=True)
    editor_id = fields.Many2one("res.users", string="Bearbeitet von", required=True, readonly=True)
    command_json = fields.Json(string="Gespeicherte Datenänderung", required=True, readonly=True)
    command_hash = fields.Char(string="Änderungsnachweis", required=True, readonly=True)
    correlation_id = fields.Char(required=True, readonly=True)
    state = fields.Selection([("queued", "Übertragung läuft"), ("received", "Vom Weltserver empfangen"),
                              ("accepted", "Wirksam"), ("rejected", "Vom Weltserver abgelehnt")], default="queued", readonly=True)
    detail = fields.Char(string="Rückmeldung", readonly=True)
    result_json = fields.Json(string="Weltserver-Rückmeldung", readonly=True)

    @api.model_create_multi
    def create(self, values_list):
        if not _internal(self):
            raise AccessError(_("Änderungsbelege entstehen nur beim Speichern der Nachfragedaten."))
        return super().create(values_list)

    def write(self, values):
        if not _internal(self) or set(values) - {"state", "detail", "result_json"}:
            raise AccessError(_("Gespeicherte Datenänderungen und ihre Auditfelder sind unveränderlich."))
        return super().write(values)

    def unlink(self):
        raise AccessError(_("Änderungsbelege dürfen nicht gelöscht werden."))

    def _lock_result(self):
        self.ensure_one()
        self.flush_recordset()
        self.env.cr.execute("SELECT id FROM zugfolge_demand_data_event WHERE id = %s FOR UPDATE", (self.id,))
        self.invalidate_recordset()

    def _dispatch(self):
        for event in self:
            if event.state in ("accepted", "rejected"):
                continue
            if canonical_sha256(event.command_json) != event.command_hash:
                raise ValidationError(_("Der gespeicherte Änderungsbeleg ist beschädigt."))
            dispatch_signed_game_command(event.env, event.correlation_id, "admin-service", event.command_json)
            # A result may arrive while the HTTP request is in flight. Never
            # overwrite a concurrently recorded final outcome with receipt-only.
            event._lock_result()
            if event.state == "queued":
                _controlled(event).write({"state": "received"})

    def _apply_game_result(self, result):
        self.ensure_one()
        self._lock_result()
        if (result.get("baseReleaseId") != self.data_id.base_release_id or type(result.get("sourceRevision")) is not int
                or result["sourceRevision"] != self.source_revision or result.get("outcome") not in ("accepted", "rejected")):
            raise ValidationError(_("Die Weltserver-Rückmeldung gehört nicht zu dieser Datenrevision."))
        if self.result_json:
            if self.result_json != result:
                raise ValidationError(_("Widersprüchliche Rückmeldung zur gespeicherten Datenrevision."))
            return
        _controlled(self).write({"state": result["outcome"],
            "detail": result.get("detail") or result.get("code") or False, "result_json": result})
