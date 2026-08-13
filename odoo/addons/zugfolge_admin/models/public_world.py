import hashlib
import json
import re
from datetime import datetime, timezone

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, ValidationError

from .admin_request import validate_serialized_starting_capital_policy

PUBLIC_SNAPSHOT_VERSION = "zugfolge-public-world-snapshot/v1"
MAX_SAFE_INTEGER = 9_007_199_254_740_991
RFC3339_WITH_ZONE = re.compile(r"^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$")
FORBIDDEN_PUBLIC_KEYS = {
    "keycloakSubject", "email", "partnerId", "partnerReference", "accountId", "playerId",
    "operatorId", "operatorIds", "activityHistory", "loginAt", "paymentReference", "orderReference",
}


def _assert_public_payload(value, path="snapshot"):
    if isinstance(value, list):
        for index, item in enumerate(value):
            _assert_public_payload(item, "%s[%s]" % (path, index))
    elif isinstance(value, dict):
        for key, item in value.items():
            if key in FORBIDDEN_PUBLIC_KEYS:
                raise ValidationError(_("Personenbezogenes Feld %s ist in einer oeffentlichen Projektion verboten.") % (path + "." + key))
            _assert_public_payload(item, path + "." + key)


def _rfc3339_utc(value, field_name, required=True):
    if value is None and not required:
        return False
    if not isinstance(value, str) or not RFC3339_WITH_ZONE.fullmatch(value):
        raise ValidationError(_("%(field)s braucht einen RFC3339-Zeitstempel mit Zeitzone.", field=field_name))
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValidationError(_("%(field)s braucht einen gueltigen RFC3339-Zeitstempel.", field=field_name)) from error
    if parsed.utcoffset() is None:
        raise ValidationError(_("%(field)s braucht eine explizite Zeitzone.", field=field_name))
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


class ZugfolgeWorldProjectionPublic(models.Model):
    _inherit = "zugfolge.world.projection"

    public_projection_version = fields.Char(readonly=True)
    public_description = fields.Text(readonly=True)
    public_phase = fields.Selection([
        ("planned", "Geplant"), ("registration_open", "Anmeldung offen"), ("active", "Aktiv"),
        ("ended", "Beendet"), ("archived", "Archiviert"),
    ], readonly=True)
    public_starts_at = fields.Datetime(readonly=True)
    public_ends_at = fields.Datetime(readonly=True)
    authoritative_as_of = fields.Datetime(readonly=True)
    remaining_runtime_seconds = fields.Integer(readonly=True)
    unlimited_runtime = fields.Boolean(readonly=True)
    total_operators = fields.Integer(readonly=True)
    strongly_active_operators = fields.Integer(readonly=True)
    activity_policy_status = fields.Selection([("configured", "Konfiguriert"), ("unconfigured", "Nicht freigegeben")], readonly=True)
    activity_explanation = fields.Char(readonly=True)
    public_capacity = fields.Integer(readonly=True)
    public_free_places = fields.Integer(readonly=True)
    admission_status = fields.Selection([
        ("planned", "Geplant"), ("open", "Offen"), ("waitlist", "Warteliste"),
        ("closed", "Geschlossen"), ("full", "Ausgebucht"),
    ], readonly=True)
    public_region = fields.Char(readonly=True)
    public_rule_release = fields.Char(readonly=True)
    public_releases = fields.Json(readonly=True)
    public_banner_metadata = fields.Json(readonly=True)
    public_generated_at = fields.Datetime(readonly=True)
    public_payload_hash = fields.Char(readonly=True)

    @api.model
    def upsert_public_snapshot(self, envelope):
        if not self.env.context.get("zugfolge_game_projection"):
            raise AccessError(_("Oeffentliche Game-Projektionen brauchen den signierten Integrationspfad."))
        body = envelope.get("payload")
        world_id = envelope.get("worldId")
        if not isinstance(body, dict) or body.get("projectionVersion") != PUBLIC_SNAPSHOT_VERSION or body.get("worldId") != world_id:
            raise ValidationError(_("Oeffentlicher Weltsnapshot verletzt Version oder Weltbindung."))
        _assert_public_payload(body)
        for field_name in ("totalOperators", "capacity", "freePlaces"):
            if (not isinstance(body.get(field_name), int) or isinstance(body.get(field_name), bool)
                    or body[field_name] < 0 or body[field_name] > MAX_SAFE_INTEGER):
                raise ValidationError(_("Oeffentliche Zaehler muessen nichtnegative Ganzzahlen sein."))
        if body["freePlaces"] > body["capacity"]:
            raise ValidationError(_("Freie Plaetze duerfen die Weltkapazitaet nicht ueberschreiten."))
        policy_status = body.get("activityPolicyStatus")
        if policy_status not in ("configured", "unconfigured"):
            raise ValidationError(_("Unbekannter ActivityPolicy-Status."))
        configured = policy_status == "configured"
        strong = body.get("stronglyActiveOperators")
        if configured:
            if not isinstance(strong, int) or isinstance(strong, bool) or strong < 0 or strong > body["totalOperators"]:
                raise ValidationError(_("Stark-aktive EVU sind ungueltig."))
        elif strong is not None:
            raise ValidationError(_("Ohne freigegebene ActivityPolicy darf keine Aktivitaetszahl projiziert werden."))
        remaining = body.get("remainingRuntimeSeconds")
        if remaining is not None and (not isinstance(remaining, int) or isinstance(remaining, bool) or remaining < 0 or remaining > MAX_SAFE_INTEGER):
            raise ValidationError(_("Verbleibende Weltlaufzeit muss eine nichtnegative Ganzzahl oder null sein."))
        mode, amount, display = validate_serialized_starting_capital_policy(body.get("startingCapitalPolicy"))
        generated_at = _rfc3339_utc(body.get("generatedAt"), "generatedAt")
        authoritative_as_of = _rfc3339_utc(body.get("authoritativeAsOf"), "authoritativeAsOf")
        starts_at = _rfc3339_utc(body.get("startsAt"), "startsAt")
        ends_at = _rfc3339_utc(body.get("endsAt"), "endsAt", required=False)
        values = {
            "public_projection_version": PUBLIC_SNAPSHOT_VERSION,
            "public_description": body.get("shortDescription"),
            "public_phase": body.get("phase"),
            "public_starts_at": starts_at,
            "public_ends_at": ends_at,
            "authoritative_as_of": authoritative_as_of,
            "remaining_runtime_seconds": remaining or 0,
            "unlimited_runtime": remaining is None,
            "starting_capital_mode": mode,
            "starting_capital_amount_cents": amount,
            "starting_capital_preview": display,
            "total_operators": body["totalOperators"],
            "strongly_active_operators": strong or 0,
            "activity_policy_status": body.get("activityPolicyStatus"),
            "activity_explanation": body.get("activityExplanation"),
            "public_capacity": body["capacity"],
            "public_free_places": body["freePlaces"],
            "admission_status": body.get("admissionStatus"),
            "public_region": body.get("region"),
            "public_rule_release": body.get("ruleRelease"),
            "public_releases": body.get("releases"),
            "public_banner_metadata": body.get("banner"),
            "public_generated_at": generated_at,
            "public_payload_hash": hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest(),
        }
        record = self.search([("world_id", "=", world_id)], limit=1)
        if not record:
            # Monitoring kann kurz nach dem ersten öffentlichen Snapshot folgen.
            values.update({
                "world_id": world_id, "world_name": body.get("worldName", world_id),
                "projection_revision": body.get("authoritativeAsOf"),
                "observed_at": _rfc3339_utc(envelope.get("occurredAt"), "occurredAt"),
                "freshness": "delayed", "payload_hash": values["public_payload_hash"],
            })
            return self.with_context(zugfolge_game_projection=True).create(values)
        if record.public_generated_at and generated_at < fields.Datetime.to_datetime(record.public_generated_at):
            return record
        record.with_context(zugfolge_game_projection=True).write(values)
        return record

    def public_is_stale(self, now=None):
        self.ensure_one()
        now = now or datetime.now(timezone.utc)
        generated = fields.Datetime.to_datetime(self.public_generated_at)
        if not generated:
            return True
        if generated.tzinfo is None:
            generated = generated.replace(tzinfo=timezone.utc)
        return (now - generated).total_seconds() > 180

    def public_runtime_display(self):
        self.ensure_one()
        if self.unlimited_runtime:
            return _("Unbefristet")
        seconds = max(0, self.remaining_runtime_seconds or 0)
        days, remainder = divmod(seconds, 86_400)
        hours = remainder // 3_600
        if days:
            return _("%(days)s Tage %(hours)s Stunden", days=days, hours=hours)
        return _("%(hours)s Stunden", hours=hours)


class ZugfolgeWorldOffer(models.Model):
    _name = "zugfolge.world.offer"
    _description = "Zugfolge Weltangebot"
    _inherit = ["mail.thread", "mail.activity.mixin"]

    projection_id = fields.Many2one("zugfolge.world.projection", required=True, ondelete="restrict", index=True, tracking=True)
    website_group = fields.Selection([("public", "Oeffentliche Welten"), ("featured", "Hervorgehoben")], default="public", required=True)
    published = fields.Boolean(default=False, tracking=True)
    participation_conditions = fields.Text(required=True, translate=True)
    product_tmpl_id = fields.Many2one("product.template", ondelete="restrict")
    game_url_template = fields.Char(default="/game/worlds/{world_id}")
    banner_original = fields.Image(attachment=True, max_width=3840, max_height=2160)
    banner_1920 = fields.Image(related="banner_original", max_width=1920, max_height=1080, store=True)
    banner_1024 = fields.Image(related="banner_original", max_width=1024, max_height=576, store=True)
    banner_512 = fields.Image(related="banner_original", max_width=512, max_height=288, store=True)
    banner_alt = fields.Char(translate=True)
    banner_source = fields.Char()
    banner_author = fields.Char()
    banner_license = fields.Char()
    banner_attribution = fields.Char()
    banner_rights_approved = fields.Boolean(default=False, tracking=True)
    focal_x_permille = fields.Integer(default=500)
    focal_y_permille = fields.Integer(default=500)
    fallback_url = fields.Char(default="/zugfolge_admin/static/src/img/world-fallback.svg", readonly=True)

    _projection_unique = models.Constraint(
        "unique(projection_id)",
        "Je Game-Welt darf nur ein Weltangebot existieren.",
    )

    def write(self, values):
        if {"projection_id", "product_tmpl_id"}.intersection(values):
            for record in self:
                if self.env["zugfolge.world.participation"].sudo().search_count([("offer_id", "=", record.id)]):
                    raise ValidationError(_("Welt- und Produktbindung eines bereits verwendeten Angebots sind unveraenderlich."))
        return super().write(values)

    @api.constrains("product_tmpl_id")
    def _check_product_kind(self):
        for record in self:
            if record.product_tmpl_id and record.product_tmpl_id.zugfolge_product_kind != "public_world_slot":
                raise ValidationError(_("Ein bezahltes Weltangebot braucht genau das Produktmerkmal Oeffentlicher Weltplatz."))

    @api.constrains("published", "banner_original", "banner_alt", "banner_source", "banner_author", "banner_license", "banner_rights_approved", "focal_x_permille", "focal_y_permille")
    def _check_banner_rights(self):
        for record in self:
            if not 0 <= record.focal_x_permille <= 1000 or not 0 <= record.focal_y_permille <= 1000:
                raise ValidationError(_("Banner-Brennpunkte muessen zwischen 0 und 1000 liegen."))
            if record.banner_original and (not record.banner_alt or not record.banner_source or not record.banner_author or not record.banner_license):
                raise ValidationError(_("Banner brauchen Alt-Text, Quelle, Urheber und Lizenz."))
            if record.published and record.banner_original and not record.banner_rights_approved:
                raise ValidationError(_("Ein Banner ohne dokumentierte Rechtefreigabe darf nicht produktiv veroeffentlicht werden."))

    def banner_url(self, size=1024):
        self.ensure_one()
        if not self.banner_original or not self.banner_rights_approved:
            return self.fallback_url
        field_name = {512: "banner_512", 1024: "banner_1024", 1920: "banner_1920"}.get(size, "banner_1024")
        return "/web/image/zugfolge.world.offer/%s/%s" % (self.id, field_name)

    def banner_object_position(self):
        self.ensure_one()
        x_whole, x_decimal = divmod(self.focal_x_permille, 10)
        y_whole, y_decimal = divmod(self.focal_y_permille, 10)
        return f"object-position:{x_whole}.{x_decimal}% {y_whole}.{y_decimal}%"

    def public_price_display(self):
        self.ensure_one()
        if not self.product_tmpl_id:
            return _("Teilnahme auf Anfrage")
        return "%.2f %s" % (self.product_tmpl_id.list_price, self.product_tmpl_id.currency_id.name)
