import re
import uuid
from datetime import datetime, timezone

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from ..services import dispatch_signed_game_command


MAX_MONEY_CENTS = 9_223_372_036_854_775_807
CANONICAL_CENTS_RE = re.compile(r"^(0|[1-9][0-9]*)$")
GERMAN_CURRENCY_RE = re.compile(
    r"^(?P<euros>(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:\.[0-9]{3})+))(?:,(?P<cents>[0-9]{1,2}))?\s*(?:\u20ac)?$"
)
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
ED25519_SIGNATURE_BASE64_RE = re.compile(r"^[A-Za-z0-9+/]{86}==$")
WORLD_ID_RE = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", re.IGNORECASE)
_ADMIN_REQUEST_WRITE_TOKEN = object()


def parse_german_currency_to_cents(value):
    """Parse a German currency string exactly, without Float/Monetary values."""
    if not isinstance(value, str):
        raise ValidationError(_("Der begrenzte Startkapitalbetrag muss als deutscher Waehrungstext eingegeben werden."))
    match = GERMAN_CURRENCY_RE.fullmatch(value.strip())
    if not match:
        raise ValidationError(_("Startkapital muss im deutschen Format stehen, zum Beispiel 10.000,00. Negative Werte, Exponenten und mehr als zwei Nachkommastellen sind unzulaessig."))
    euros = match.group("euros").replace(".", "")
    cents = (match.group("cents") or "").ljust(2, "0")
    amount = int(euros) * 100 + int(cents or "0")
    if amount > MAX_MONEY_CENTS:
        raise ValidationError(_("Startkapital liegt ausserhalb des vorzeichenbehafteten 64-Bit-Centbereichs."))
    return str(amount)


def format_cents_german(amount_cents):
    if not isinstance(amount_cents, str) or not CANONICAL_CENTS_RE.fullmatch(amount_cents):
        raise ValidationError(_("Startkapital-Cent ist kein kanonischer Dezimalstring."))
    amount = int(amount_cents)
    if amount > MAX_MONEY_CENTS:
        raise ValidationError(_("Startkapital liegt ausserhalb des vorzeichenbehafteten 64-Bit-Centbereichs."))
    euros, cents = divmod(amount, 100)
    grouped = format(euros, ",d").replace(",", ".")
    return "%s,%02d \u20ac" % (grouped, cents)


def validate_serialized_starting_capital_policy(policy):
    if not isinstance(policy, dict) or policy.get("mode") not in ("finite", "unlimited"):
        raise ValidationError(_("Startkapital braucht den Modus Begrenzt oder Unbegrenzt."))
    if policy["mode"] == "unlimited":
        if set(policy) != {"mode"}:
            raise ValidationError(_("Unbegrenztes Startkapital ist ein Modus und besitzt keinen Geldbetrag."))
        return "unlimited", False, "\u221e"
    amount = policy.get("amountCents")
    if set(policy) != {"mode", "amountCents"} or not isinstance(amount, str) or not CANONICAL_CENTS_RE.fullmatch(amount):
        raise ValidationError(_("Begrenztes Startkapital braucht Integer-Cent als kanonischen Dezimalstring."))
    return "finite", amount, format_cents_german(amount)


class ZugfolgeAdminRequest(models.Model):
    """Native Odoo approval UI; Game remains the authoritative executor."""

    _name = "zugfolge.admin.request"
    _description = "Zugfolge Administrationsantrag"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "write_date desc"

    # Keep the database, rather than an ORM-only lookup, as the final
    # authority for correlation idempotence through Odoo 19's descriptor API.
    _correlation_id_unique = models.Constraint(
        "unique(correlation_id)",
        "Die Administrationsantrag-Korrelation muss eindeutig sein.",
    )

    name = fields.Char(compute="_compute_name", store=True)
    world_projection_id = fields.Many2one("zugfolge.world.projection", ondelete="restrict", index=True)
    world_id = fields.Char(index=True, tracking=True)
    world_name = fields.Char(tracking=True)
    world_kind = fields.Selection(
        [("public", "Oeffentlich"), ("private", "Privat"), ("test", "Test")],
        default="public",
        tracking=True,
    )
    ranking_status = fields.Selection([("ranked", "Gewertet"), ("unranked", "Ungewertet")], default="ranked", tracking=True)
    schedule_period_weeks = fields.Integer(default=4, tracking=True)
    world_epoch = fields.Datetime(tracking=True)
    action_type = fields.Selection(
        [
            ("world_access_revoke", "Weltzugang entziehen"),
            ("infra_release_adoption", "InfraRelease zur Periode uebernehmen"),
            ("manual_disruption_create", "Manuelle Stoerung anlegen"),
            ("disruption_policy_schedule", "Stoerungsrichtlinie veroeffentlichen"),
            ("abuse_sanction_activate", "Schwere Missbrauchsmassnahme aktivieren"),
            ("world_close", "Weltabschluss einleiten"),
            ("world_deploy", "Signierte Welt bereitstellen"),
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
    disruption_planned_mode = fields.Selection([("REALISTIC", "Realistisch"), ("SIMULATED", "Simuliert"), ("MANUAL", "Manuell")], string="Geplante Baustellen")
    disruption_incident_mode = fields.Selection([("REALISTIC", "Realistisch"), ("SIMULATED", "Simuliert"), ("MANUAL", "Manuell")], string="Betriebsstoerungen")
    disruption_provider_set = fields.Char(string="Rechtegeprueftes Provider-Set")
    disruption_simulation_profile = fields.Json(string="Vollstaendiges versioniertes Generatorprofil")
    disruption_ruleset_version = fields.Char(string="Stoerungsregelversion")
    starting_capital_mode = fields.Selection(
        [("finite", "Begrenzt"), ("unlimited", "Unbegrenzt (\u221e)")],
        default="finite",
        tracking=True,
    )
    starting_capital_input = fields.Char(default="0,00", tracking=True)
    starting_capital_amount_cents = fields.Char(default="0", readonly=True, copy=False)
    starting_capital_preview = fields.Char(compute="_compute_starting_capital_preview", readonly=True)
    signing_configuration = fields.Json(compute="_compute_signing_configuration", readonly=True)
    signed_world_deployment = fields.Json(copy=False)
    deployment_hash = fields.Char(copy=False, tracking=True)
    deployment_revision = fields.Integer(default=1, copy=False, tracking=True)

    @api.depends("action_type", "world_projection_id", "world_name", "world_id")
    def _compute_name(self):
        for record in self:
            world_name = record.world_projection_id.world_name or record.world_name or record.world_id or "Welt"
            record.name = "%s: %s" % (world_name, dict(record._fields["action_type"].selection).get(record.action_type, "Antrag"))

    @api.depends("action_type", "world_projection_id", "world_id")
    def _compute_game_capability(self):
        capability_model = self.env["zugfolge.admin.capability"].sudo()
        for record in self:
            world_id = record.world_id if record.action_type == "world_deploy" else record.world_projection_id.world_id or record.world_id
            capability = capability_model.search([
                ("world_id", "=", world_id),
                ("action_type", "=", record.action_type),
            ], limit=1) if world_id and record.action_type else capability_model.browse()
            record.game_capability_state = capability.availability if capability else "prepared"
            record.game_capability_detail = capability.detail if capability else "Game-Implementierung und signierte Faehigkeitsprojektion stehen noch aus."

    @api.depends("starting_capital_mode", "starting_capital_amount_cents")
    def _compute_starting_capital_preview(self):
        for record in self:
            if record.starting_capital_mode == "unlimited":
                record.starting_capital_preview = "\u221e"
            else:
                record.starting_capital_preview = format_cents_german(record.starting_capital_amount_cents or "0")

    @api.depends(
        "action_type", "world_id", "world_name", "world_kind", "ranking_status",
        "schedule_period_weeks", "world_epoch", "starting_capital_mode",
        "starting_capital_amount_cents", "deployment_revision",
    )
    def _compute_signing_configuration(self):
        for record in self:
            if record.action_type != "world_deploy" or not record.world_epoch:
                record.signing_configuration = False
                continue
            epoch = fields.Datetime.to_datetime(record.world_epoch).replace(tzinfo=timezone.utc)
            record.signing_configuration = {
                "schemaVersion": "zugfolge-alpha-world-deploy-configuration/v1",
                "worldId": record.world_id,
                "deploymentRevision": record.deployment_revision,
                "worldDefinition": {
                    "name": record.world_name,
                    "kind": record.world_kind,
                    "rankingStatus": record.ranking_status,
                    "schedulePeriodWeeks": record.schedule_period_weeks,
                    "epoch": epoch.isoformat().replace("+00:00", "Z"),
                },
                "startingCapitalPolicy": record._starting_capital_policy(),
            }

    @api.onchange("starting_capital_mode", "starting_capital_input")
    def _onchange_starting_capital(self):
        for record in self:
            if record.starting_capital_mode == "unlimited":
                record.starting_capital_amount_cents = False
                continue
            if not record.starting_capital_input:
                record.starting_capital_input = "0,00"
            record.starting_capital_amount_cents = parse_german_currency_to_cents(record.starting_capital_input)

    @api.onchange("action_type", "world_kind")
    def _onchange_world_deploy_defaults(self):
        for record in self:
            if record.action_type == "world_deploy":
                record.risk_class = "high"
                record.ranking_status = "ranked" if record.world_kind == "public" else "unranked"

    @staticmethod
    def _policy_from_values(mode, amount_cents):
        if mode == "unlimited":
            return {"mode": "unlimited"}
        amount = amount_cents or "0"
        validate_serialized_starting_capital_policy({"mode": "finite", "amountCents": amount})
        return {"mode": "finite", "amountCents": amount}

    @staticmethod
    def _normalize_starting_capital_values(values, current=None):
        normalized = dict(values)
        mode = normalized.get("starting_capital_mode", current.starting_capital_mode if current else "finite")
        if mode == "unlimited":
            normalized["starting_capital_amount_cents"] = False
        else:
            input_value = normalized.get("starting_capital_input", current.starting_capital_input if current else "0,00") or "0,00"
            normalized["starting_capital_input"] = input_value
            normalized["starting_capital_amount_cents"] = parse_german_currency_to_cents(input_value)
        if normalized.get("action_type", current.action_type if current else None) == "world_deploy":
            normalized["risk_class"] = "high"
            policy = ZugfolgeAdminRequest._policy_from_values(mode, normalized.get("starting_capital_amount_cents"))
            normalized["effect_preview"] = {
                "kind": "world-deploy",
                "startingCapitalPolicy": policy,
                "startingCapitalPreview": "\u221e" if mode == "unlimited" else format_cents_german(policy["amountCents"]),
                "deploymentHash": normalized.get("deployment_hash", current.deployment_hash if current else None),
                "deploymentRevision": normalized.get("deployment_revision", current.deployment_revision if current else 1),
            }
        if normalized.get("action_type", current.action_type if current else None) == "disruption_policy_schedule":
            normalized["risk_class"] = "high"
            normalized["effect_preview"] = {
                "kind": "disruption-policy-schedule",
                "supportedEffectContract": "numeric-speed/both-directions/all-traffic/v1",
                "notice": "Das Game prueft das Profil nativ. Nicht darstellbare Wirkungen und Scopes bleiben sichtbar und wirkungslos; auch null anwendbare La sind moeglich.",
            }
        return normalized

    @api.model_create_multi
    def create(self, values_list):
        normalized_values = []
        projection_model = self.env["zugfolge.world.projection"]
        for values in values_list:
            normalized = dict(values)
            if normalized.get("state", "draft") != "draft" or normalized.get("approver_id") or normalized.get("game_result") or normalized.get("game_audit_event_id"):
                raise AccessError(_("Neue Administrationsantraege beginnen immer als eigener Entwurf ohne Game-Ergebnis."))
            if normalized.get("requester_id", self.env.user.id) != self.env.user.id:
                raise AccessError(_("Der Antragsteller wird serverseitig aus der angemeldeten Odoo-Identitaet gebunden."))
            # `readonly=True` ist nur eine Oberflaecheneigenschaft. Ein RPC-Client
            # koennte den Wert beim ORM-create weiterhin mitsenden und dadurch
            # ein fremdes Game-Ergebnis auf diesen Antrag umlenken. Die
            # Korrelation entsteht deshalb ausschliesslich aus dem Feld-Default.
            normalized.pop("correlation_id", None)
            normalized["requester_id"] = self.env.user.id
            normalized["state"] = "draft"
            projection_id = normalized.get("world_projection_id")
            if projection_id:
                projection = projection_model.browse(projection_id).exists()
                if projection:
                    normalized.setdefault("world_id", projection.world_id)
                    normalized.setdefault("world_name", projection.world_name)
                    normalized.setdefault("world_kind", projection.profile_kind)
            normalized_values.append(self._normalize_starting_capital_values(normalized))
        return super().create(normalized_values)

    def _write_controlled(self, values):
        """Private transition path; its object token cannot be forged over RPC."""
        return self.with_context(zugfolge_admin_request_write_token=_ADMIN_REQUEST_WRITE_TOKEN).write(values)

    def write(self, values):
        controlled = {"correlation_id", "state", "approver_id", "game_audit_event_id", "game_result"}
        if controlled.intersection(values) and self.env.context.get("zugfolge_admin_request_write_token") is not _ADMIN_REQUEST_WRITE_TOKEN:
            raise AccessError(_("Antragsstatus, Freigabe und Game-Ergebnis duerfen nur ueber den geprueften Workflow geaendert werden."))
        decision_fields = {
            "world_projection_id", "world_id", "world_name", "world_kind", "ranking_status",
            "schedule_period_weeks", "world_epoch", "action_type", "risk_class", "requester_id", "reason",
            "effect_preview", "release_hash", "requested_period_start", "target_reference", "requested_at_s",
            "manual_disruption_start", "manual_disruption_end", "manual_disruption_cause",
            "manual_disruption_resource_ids", "manual_disruption_effect", "starting_capital_mode", "starting_capital_input",
            "starting_capital_amount_cents", "signed_world_deployment", "deployment_hash", "deployment_revision",
            "disruption_planned_mode", "disruption_incident_mode", "disruption_provider_set", "disruption_simulation_profile", "disruption_ruleset_version",
        }
        if decision_fields.intersection(values) and any(record.state != "draft" for record in self):
            raise UserError(_("Antragsinhalt und Autoritaetsbindungen sind nach dem Einreichen unveraenderlich."))
        result = True
        for record in self:
            normalized = self._normalize_starting_capital_values(values, record)
            result = super(ZugfolgeAdminRequest, record).write(normalized) and result
        return result

    @api.constrains(
        "reason", "risk_class", "requester_id", "approver_id", "action_type", "release_hash",
        "requested_period_start", "target_reference", "requested_at_s", "manual_disruption_start",
        "manual_disruption_end", "manual_disruption_cause", "manual_disruption_resource_ids",
        "manual_disruption_effect", "world_projection_id", "world_id", "world_name", "world_kind",
        "ranking_status", "schedule_period_weeks", "world_epoch", "starting_capital_mode",
        "starting_capital_input", "starting_capital_amount_cents", "signed_world_deployment", "deployment_hash", "deployment_revision", "state",
        "disruption_planned_mode", "disruption_incident_mode", "disruption_provider_set", "disruption_simulation_profile", "disruption_ruleset_version",
    )
    def _check_authoritative_shape(self):
        for record in self:
            if not record.reason or not record.reason.strip():
                raise ValidationError(_("Eine Begruendung ist Pflicht."))
            if record.risk_class == "high" and record.approver_id and record.approver_id == record.requester_id:
                raise ValidationError(_("Antragsteller und Freigeber duerfen nicht dieselbe Person sein."))
            if record.action_type == "infra_release_adoption" and record.risk_class != "high":
                raise ValidationError(_("Die Uebernahme eines InfraRelease ist immer hochriskant."))
            if record.action_type == "infra_release_adoption" and record.release_hash and not SHA256_RE.fullmatch(record.release_hash):
                raise ValidationError(_("Der InfraRelease-Hash muss SHA-256 besitzen."))
            if record.action_type == "disruption_policy_schedule":
                if record.risk_class != "high" or not record.requested_period_start or len(record.reason.strip()) < 8:
                    raise ValidationError(_("Stoerungsrichtlinien brauchen Vier-Augen-Freigabe, Fahrplanstichtag und eine ausfuehrliche Begruendung."))
                if not record.disruption_planned_mode or not record.disruption_incident_mode:
                    raise ValidationError(_("Beide Stoerungsmodi muessen ausdruecklich gewaehlt werden."))
                if not isinstance(record.disruption_simulation_profile, dict) or not record.disruption_simulation_profile or not (record.disruption_ruleset_version or "").strip():
                    raise ValidationError(_("Stoerungsrichtlinien brauchen ein vollstaendiges Generatorprofil und eine Regelversion."))
                if "REALISTIC" in (record.disruption_planned_mode, record.disruption_incident_mode) and not (record.disruption_provider_set or "").strip():
                    raise ValidationError(_("Realistische Modi brauchen ein benanntes rechtegeprueftes Provider-Set."))
                if not record.requester_id.partner_id.zugfolge_keycloak_subject:
                    raise ValidationError(_("Der Antragsteller braucht eine durch OIDC verifizierte Keycloak-Bindung und einen Administratorzugang zur Zielwelt."))
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
            if record.action_type in ("world_access_revoke", "abuse_sanction_activate", "world_close") and record.risk_class != "high":
                raise ValidationError(_("Kontoentzug, schwere Sanktionen und Weltende sind immer hochriskant."))
            if record.action_type in ("world_access_revoke", "abuse_sanction_activate") and not (record.target_reference or "").strip():
                raise ValidationError(_("Die Verwaltungsaktion braucht eine stabile Zielreferenz."))
            if record.action_type == "world_close" and (record.requested_at_s is None or record.requested_at_s < 0):
                raise ValidationError(_("Die Verwaltungsaktion braucht eine gueltige Simulationszeit."))
            if record.world_projection_id and record.world_id != record.world_projection_id.world_id:
                raise ValidationError(_("Antrag und Game-Weltprojektion besitzen unterschiedliche Weltbindungen."))
            if record.action_type != "world_deploy" and not record.world_projection_id:
                raise ValidationError(_("Bestehende Verwaltungsaktionen brauchen eine Game-Weltprojektion."))
            if not (record.world_id or "").strip():
                raise ValidationError(_("Jeder Administrationsantrag braucht eine stabile Welt-ID."))
            if record.action_type == "world_deploy":
                if record.risk_class != "high":
                    raise ValidationError(_("Ein Welt-Deployment ist immer hochriskant."))
                if not WORLD_ID_RE.fullmatch(record.world_id or ""):
                    raise ValidationError(_("Welt-Deployment braucht eine gueltige Welt-ID."))
                if not (record.world_name or "").strip() or record.world_kind not in ("public", "private", "test"):
                    raise ValidationError(_("Welt-Deployment braucht Name und Weltprofil."))
                if record.ranking_status not in ("ranked", "unranked") or ((record.world_kind == "public") != (record.ranking_status == "ranked")):
                    raise ValidationError(_("Nur oeffentliche Welten sind gewertet; alle anderen Weltprofile sind ungewertet."))
                if not isinstance(record.schedule_period_weeks, int) or record.schedule_period_weeks < 3 or record.schedule_period_weeks > 8:
                    raise ValidationError(_("Die Fahrplanperiode muss zwischen drei und acht Wochen liegen."))
                if not record.world_epoch:
                    raise ValidationError(_("Welt-Deployment braucht eine Weltepoche."))
                configured_epoch = fields.Datetime.to_datetime(record.world_epoch).replace(tzinfo=timezone.utc)
                if (
                    configured_epoch.weekday() != 0
                    or configured_epoch.hour != 0
                    or configured_epoch.minute != 0
                    or configured_epoch.second != 0
                    or configured_epoch.microsecond != 0
                ):
                    raise ValidationError(_("Die Weltepoche muss Montag um 00:00:00 UTC beginnen."))
                existing_projection = self.env["zugfolge.world.projection"].sudo().search([
                    ("world_id", "=", record.world_id),
                ], limit=1)
                expected_revision = 1
                if existing_projection and existing_projection.deployment_hash:
                    if existing_projection.deployment_revision < 1:
                        raise ValidationError(_("Der bestehende Weltspiegel braucht vor einem neuen Deployment das Add-on-Upgrade."))
                    expected_revision = (
                        existing_projection.deployment_revision
                        if record.deployment_hash == existing_projection.deployment_hash
                        else existing_projection.deployment_revision + 1
                    )
                if record.deployment_revision != expected_revision:
                    raise ValidationError(_(
                        "Deployment-Revision %(actual)s ist nicht die erwartete weltgebundene Revision %(expected)s.",
                        actual=record.deployment_revision,
                        expected=expected_revision,
                    ))
                policy = record._starting_capital_policy()
                signed = record.signed_world_deployment
                if record.state == "draft" and not signed and not record.deployment_hash:
                    continue
                if not SHA256_RE.fullmatch(record.deployment_hash or ""):
                    raise ValidationError(_("Welt-Deployment braucht einen SHA-256-Hash."))
                if not isinstance(record.deployment_revision, int) or isinstance(record.deployment_revision, bool) or record.deployment_revision < 1:
                    raise ValidationError(_("Welt-Deployment braucht eine positive monotone Deployment-Revision."))
                if not isinstance(signed, dict) or signed.get("deploymentHash") != record.deployment_hash:
                    raise ValidationError(_("Signiertes Welt-Deployment und Deployment-Hash stimmen nicht ueberein."))
                signature = signed.get("signature")
                deployment = signed.get("deployment")
                blueprint = deployment.get("blueprint") if isinstance(deployment, dict) else None
                signed_definition = deployment.get("worldDefinition") if isinstance(deployment, dict) else None
                if (
                    not isinstance(signature, dict)
                    or signature.get("algorithm") != "Ed25519"
                    or not isinstance(signature.get("keyId"), str)
                    or not signature.get("keyId").strip()
                    or not isinstance(signature.get("valueBase64"), str)
                    or not ED25519_SIGNATURE_BASE64_RE.fullmatch(signature.get("valueBase64"))
                    or not isinstance(deployment, dict)
                    or deployment.get("worldId") != record.world_id
                    or deployment.get("deploymentRevision") != record.deployment_revision
                    or not isinstance(blueprint, dict)
                    or blueprint.get("profileKind") != record.world_kind
                ):
                    raise ValidationError(_("Signiertes Welt-Deployment ist unvollstaendig oder an eine andere Welt beziehungsweise ein anderes Profil gebunden."))
                try:
                    signed_epoch = datetime.fromisoformat(signed_definition.get("epoch", "").replace("Z", "+00:00"))
                    signed_epoch = signed_epoch.astimezone(timezone.utc)
                except (AttributeError, TypeError, ValueError):
                    raise ValidationError(_("Signiertes Welt-Deployment besitzt keine gueltige Weltdefinition."))
                if (
                    not isinstance(signed_definition, dict)
                    or set(signed_definition) != {"name", "kind", "rankingStatus", "schedulePeriodWeeks", "epoch"}
                    or signed_definition.get("name") != record.world_name
                    or signed_definition.get("kind") != record.world_kind
                    or signed_definition.get("rankingStatus") != record.ranking_status
                    or signed_definition.get("schedulePeriodWeeks") != record.schedule_period_weeks
                    or signed_epoch != configured_epoch
                ):
                    raise ValidationError(_("Odoo-Weltdefinition und signiertes Deployment weichen voneinander ab."))
                embedded_policy = blueprint.get("startingCapitalPolicy")
                validate_serialized_starting_capital_policy(embedded_policy)
                if embedded_policy != policy:
                    raise ValidationError(_("Odoo-Startkapital und signierter Weltentwurf weichen voneinander ab."))

    def _starting_capital_policy(self):
        self.ensure_one()
        return self._policy_from_values(self.starting_capital_mode, self.starting_capital_amount_cents)

    def _require_state(self, expected):
        if any(record.state != expected for record in self):
            raise UserError(_("Dieser Schritt ist im aktuellen Antragszustand nicht moeglich."))

    def action_submit(self):
        self._require_state("draft")
        if any(not request.reason.strip() for request in self):
            raise ValidationError(_("Eine Begruendung ist Pflicht."))
        if any(
            request.action_type == "infra_release_adoption"
            and (not request.release_hash or not request.requested_period_start)
            for request in self
        ):
            raise ValidationError(_("InfraRelease-Uebernahme braucht den qualifizierten Release-Hash und den exakten naechsten Periodenwechsel."))
        if any(request.action_type == "world_deploy" and (not request.signed_world_deployment or not request.deployment_hash) for request in self):
            raise ValidationError(_("Vor dem Einreichen muss das extern Ed25519-signierte Welt-Deployment importiert sein."))
        self._write_controlled({"state": "submitted"})

    def action_approve(self):
        self._require_state("submitted")
        if not self.env.user.has_group("zugfolge_admin.group_zugfolge_approver"):
            raise AccessError(_("Nur Freigeber duerfen Antraege genehmigen."))
        for record in self:
            if record.risk_class == "high" and record.requester_id == self.env.user:
                raise AccessError(_("Hochrisikoantraege duerfen nicht selbst freigegeben werden."))
        self._write_controlled({"state": "approved", "approver_id": self.env.user.id})

    def action_reject(self):
        self._require_state("submitted")
        if not self.env.user.has_group("zugfolge_admin.group_zugfolge_approver"):
            raise AccessError(_("Nur Freigeber duerfen Antraege ablehnen."))
        self._write_controlled({"state": "rejected", "approver_id": self.env.user.id})

    def action_dispatch(self):
        self._require_state("approved")
        if any(request.game_capability_state != "available" for request in self):
            raise UserError(_("Das Game hat diese Verwaltungsfaehigkeit noch nicht als ausfuehrbar projektiert. Der Antrag bleibt freigegeben und wirkungslos."))
        self._write_controlled({"state": "dispatched"})
        for record in self:
            record.with_delay(description="Zugfolge-Administrationsantrag an Game senden")._dispatch_signed_game_command()

    def _dispatch_signed_game_command(self):
        """OCA queue_job retried this transport; the Game remains authoritative."""
        self._require_state("dispatched")
        for record in self:
            payload = record._game_command_payload()
            actor_reference = self.env["ir.config_parameter"].sudo().get_param("zugfolge_admin.actor_reference")
            if not actor_reference:
                raise UserError(_("Der Zugfolge-Integrationsakteur ist nicht konfiguriert."))
            dispatch_signed_game_command(self.env, record.correlation_id, actor_reference, payload)

    def _game_command_payload(self):
        self.ensure_one()
        requested_period_start = (
            fields.Datetime.to_datetime(self.requested_period_start).replace(tzinfo=timezone.utc)
            if self.requested_period_start
            else None
        )
        payload = {
            "kind": "admin.%s" % self.action_type,
            "worldId": self.world_id,
            "actionType": self.action_type,
            "riskClass": self.risk_class,
            "requesterReference": str(self.requester_id.id),
            "approverReference": str(self.approver_id.id) if self.approver_id else None,
            "reason": self.reason,
            "effectPreview": self.effect_preview,
            "releaseHash": self.release_hash or None,
            "requestedPeriodStart": requested_period_start.isoformat().replace("+00:00", "Z") if requested_period_start else None,
            "targetReference": self.target_reference or None,
            "requestedAtS": self.requested_at_s,
        }
        if self.action_type == "manual_disruption_create":
            payload["manualDisruption"] = {
                "startsAt": self.manual_disruption_start.isoformat(),
                "endsAt": self.manual_disruption_end.isoformat(),
                "cause": self.manual_disruption_cause,
                "affectedResourceIds": self.manual_disruption_resource_ids,
                "declaredEffect": self.manual_disruption_effect,
            }
        if self.action_type == "disruption_policy_schedule":
            payload["disruptionPolicy"] = {
                "schemaVersion": "zugfolge-disruption-policy-schedule/v1",
                "requesterSubject": self.requester_id.partner_id.zugfolge_keycloak_subject,
                "effectiveAt": requested_period_start.isoformat().replace("+00:00", "Z"),
                "plannedWorksMode": self.disruption_planned_mode,
                "operationalIncidentMode": self.disruption_incident_mode,
                "simulationProfile": self.disruption_simulation_profile,
                "rulesetVersion": self.disruption_ruleset_version,
            }
            if self.disruption_provider_set:
                payload["disruptionPolicy"]["providerSetId"] = self.disruption_provider_set
        if self.action_type == "world_deploy":
            epoch = fields.Datetime.to_datetime(self.world_epoch).replace(tzinfo=timezone.utc)
            payload.update({
                "startingCapitalPolicy": self._starting_capital_policy(),
                "worldDefinition": {
                    "name": self.world_name,
                    "kind": self.world_kind,
                    "rankingStatus": self.ranking_status,
                    "schedulePeriodWeeks": self.schedule_period_weeks,
                    "epoch": epoch.isoformat().replace("+00:00", "Z"),
                },
                "signedDeployment": self.signed_world_deployment,
                "deploymentHash": self.deployment_hash,
                "deploymentRevision": self.deployment_revision,
            })
        return payload

    def apply_game_result(self, result):
        """Controller-only projection of the resulting authoritative Game audit event."""
        if not self.env.context.get("zugfolge_game_projection") or not self.env.su:
            raise AccessError(_("Nur das Game darf Game-Ergebnisse projizieren."))
        state = result.get("state")
        if state not in ("accepted", "completed", "failed", "rejected"):
            raise ValidationError(_("Unbekannter Game-Ergebniszustand."))
        if any(record.state not in ("dispatched", "accepted") for record in self):
            raise ValidationError(_("Ein Game-Ergebnis braucht einen zuvor signiert versendeten Antrag."))
        self._write_controlled({
            "state": state,
            "game_audit_event_id": result.get("gameAuditEventId"),
            "game_result": result,
        })
