import hashlib
import json
import os
import re
import uuid

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from ..services import stage_infra_package


SHA256 = re.compile(r"^[a-f0-9]{64}$")
SAFE_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
PART_BYTES = 100 * 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
PACKAGE_SCHEMA = "zugfolge-map-package/v1"
DELIVERY_SCHEMA = "zugfolge-map-delivery-release/v1"
SOURCES_SCHEMA = "zugfolge-map-delivery-sources/v1"
QUALITY_SCHEMA = "zugfolge-final-infrastructure-quality-report/v1"
_INTERNAL_WRITE_CONTEXT_KEY = "_zugfolge_infra_import_write_capability"
# Identity is intentionally not serializable over JSON/XML-RPC.  Only private
# server-side model code can place this exact capability into an Environment.
_INTERNAL_WRITE_CAPABILITY = object()


def _canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _safe_id(value, label):
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise ValidationError(_("%s ist keine sichere ID.") % label)
    return value


def _portable_path(value, label):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value or "://" in value or value.startswith("/") or re.match(r"^[a-z]:", value, re.I):
        raise ValidationError(_("%s ist kein sicherer relativer Pfad.") % label)
    if any(segment in ("", ".", "..") for segment in value.split("/")):
        raise ValidationError(_("%s enthaelt ein unsicheres Segment.") % label)
    if re.search(r"(?:^|[\s/_.-])apn(?:$|[\s/_.-])|trassenfinder", value, re.I):
        raise ValidationError(_("%s referenziert interne Validierungsdaten.") % label)
    return value


def _attachment_path(attachment):
    if attachment.type != "binary" or not attachment.store_fname:
        raise ValidationError(_("Anhang %s muss als regulaere Filestore-Datei vorliegen.") % attachment.name)
    path = attachment._full_path(attachment.store_fname)
    if os.path.islink(path) or not os.path.isfile(path):
        raise ValidationError(_("Anhang %s ist keine regulaere Datei.") % attachment.name)
    return path


def _hash_file(path):
    digest = hashlib.sha256()
    total = 0
    with open(path, "rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
    return {"bytes": total, "sha256": digest.hexdigest()}


def _parse_package_manifest(raw):
    if not raw or len(raw) > MAX_MANIFEST_BYTES:
        raise ValidationError(_("Paketmanifest hat eine unzulaessige Groesse."))
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(_("Paketmanifest ist kein gueltiges UTF-8-JSON.")) from error
    if not isinstance(manifest, dict) or manifest.get("schema") != PACKAGE_SCHEMA or manifest.get("format") != "directory-parts":
        raise ValidationError(_("Paketmanifest hat ein unbekanntes Schema oder Format."))
    if raw != _canonical(manifest):
        raise ValidationError(_("Paketmanifest ist nicht kanonisch serialisiert."))
    package_id = _safe_id(manifest.get("packageId"), "packageId")
    version = _safe_id(manifest.get("version"), "version")
    if manifest.get("partBytes") != PART_BYTES:
        raise ValidationError(_("Jahrespaket muss das 100-MiB-Transportprofil verwenden."))
    artifacts = manifest.get("artifacts")
    auxiliaries = manifest.get("auxiliaryFiles")
    if not isinstance(artifacts, list) or len(artifacts) != 2 or not isinstance(auxiliaries, list) or len(auxiliaries) < 6:
        raise ValidationError(_("Paketinventar ist unvollstaendig."))
    if sorted(item.get("kind") for item in artifacts if isinstance(item, dict)) != ["basemap", "infrastructure"]:
        raise ValidationError(_("Paket braucht genau Basemap und Infrastruktur."))
    auxiliary_kinds = [item.get("kind") for item in auxiliaries if isinstance(item, dict)]
    if auxiliary_kinds.count("read-model") != 1:
        raise ValidationError(_("Paket braucht genau ein oeffentliches ReadModel."))
    if auxiliary_kinds.count("train-map-projection") != 1:
        raise ValidationError(_("Paket braucht genau eine eigenstaendige Zugpositionsprojektion."))
    read_model = next(item for item in auxiliaries if isinstance(item, dict) and item.get("kind") == "read-model")
    train_projection = next(item for item in auxiliaries if isinstance(item, dict) and item.get("kind") == "train-map-projection")
    if read_model.get("installPath") != "read-model.sqlite" or train_projection.get("installPath") != "train-map-projection.sqlite":
        raise ValidationError(_("SQLite-Laufzeitdateien muessen direkt in derselben Releasewurzel liegen."))

    files = []
    parts = []
    ids = set()
    install_paths = set()
    package_paths = set()
    for descriptor in artifacts + auxiliaries:
        if not isinstance(descriptor, dict):
            raise ValidationError(_("Paketdateieintrag ist kein Objekt."))
        file_id = _safe_id(descriptor.get("id"), "Paketdatei-ID")
        if file_id in ids:
            raise ValidationError(_("Paketdatei-ID %s ist doppelt.") % file_id)
        ids.add(file_id)
        install_path = _portable_path(descriptor.get("installPath"), "%s.installPath" % file_id)
        if install_path.lower() in install_paths:
            raise ValidationError(_("Installationspfad %s ist doppelt.") % install_path)
        install_paths.add(install_path.lower())
        file_bytes = descriptor.get("bytes")
        file_sha256 = descriptor.get("sha256")
        file_parts = descriptor.get("parts")
        if not isinstance(file_bytes, int) or isinstance(file_bytes, bool) or file_bytes <= 0 or not isinstance(file_sha256, str) or not SHA256.fullmatch(file_sha256) or not isinstance(file_parts, list) or not file_parts:
            raise ValidationError(_("Paketdatei %s besitzt keinen Byte-SHA-Vertrag.") % file_id)
        byte_sum = 0
        normalized_parts = []
        for index, part in enumerate(file_parts):
            if not isinstance(part, dict):
                raise ValidationError(_("Paketteil von %s ist kein Objekt.") % file_id)
            package_path = _portable_path(part.get("path"), "%s.parts[%s].path" % (file_id, index))
            part_bytes = part.get("bytes")
            part_sha256 = part.get("sha256")
            if package_path.lower() in package_paths or not isinstance(part_bytes, int) or isinstance(part_bytes, bool) or not 0 < part_bytes <= PART_BYTES or not isinstance(part_sha256, str) or not SHA256.fullmatch(part_sha256):
                raise ValidationError(_("Paketteil %s besitzt keinen eindeutigen Byte-SHA-Vertrag.") % package_path)
            package_paths.add(package_path.lower())
            part_id = hashlib.sha256(("%s\0%s\0%s" % (file_id, index, part_sha256)).encode("utf-8")).hexdigest()[:32]
            normalized = {
                "file_id": file_id,
                "kind": descriptor.get("kind"),
                "index": index,
                "package_path": package_path,
                "filename": os.path.basename(package_path),
                "bytes": part_bytes,
                "sha256": part_sha256,
                "part_id": part_id,
            }
            normalized_parts.append(normalized)
            parts.append(normalized)
            byte_sum += part_bytes
        if byte_sum != file_bytes:
            raise ValidationError(_("Summe der Paketteile von %s stimmt nicht.") % file_id)
        files.append({
            "id": file_id,
            "kind": descriptor.get("kind"),
            "installPath": install_path,
            "bytes": file_bytes,
            "sha256": file_sha256,
            "parts": normalized_parts,
        })
    if len({part["filename"] for part in parts}) != len(parts):
        raise ValidationError(_("Paketteil-Dateinamen sind nicht eindeutig."))
    return {"manifest": manifest, "package_id": package_id, "version": version, "files": files, "parts": parts}


def _read_packaged_json(file_entry, inventory):
    if file_entry["bytes"] > MAX_MANIFEST_BYTES:
        raise ValidationError(_("%s ist als oeffentliches JSON zu gross.") % file_entry["kind"])
    chunks = []
    for part in sorted(file_entry["parts"], key=lambda item: item["index"]):
        attachment_id = inventory[part["package_path"]]["attachment_id"]
        attachment = inventory[part["package_path"]]["attachment"]
        if attachment.id != attachment_id:
            raise ValidationError(_("Paketteilzuordnung wurde veraendert."))
        with open(_attachment_path(attachment), "rb") as source:
            chunks.append(source.read())
    raw = b"".join(chunks)
    if len(raw) != file_entry["bytes"] or hashlib.sha256(raw).hexdigest() != file_entry["sha256"]:
        raise ValidationError(_("%s stimmt nicht mit seinem Dateivertrag ueberein.") % file_entry["kind"])
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(_("%s ist kein gueltiges UTF-8-JSON.") % file_entry["kind"]) from error
    if not isinstance(value, dict):
        raise ValidationError(_("%s muss ein JSON-Objekt sein.") % file_entry["kind"])
    return value, raw


def _qualify_public_delivery(parsed, inventory):
    by_kind = {entry["kind"]: entry for entry in parsed["files"]}
    if not all(kind in by_kind for kind in ("release-manifest", "source-manifest", "quality-manifest")):
        raise ValidationError(_("Oeffentliche Delivery-, Quellen- oder Qualitaetsdatei fehlt."))
    delivery, _delivery_raw = _read_packaged_json(by_kind["release-manifest"], inventory)
    sources, sources_raw = _read_packaged_json(by_kind["source-manifest"], inventory)
    quality, quality_raw = _read_packaged_json(by_kind["quality-manifest"], inventory)
    if delivery.get("schema") != DELIVERY_SCHEMA or delivery.get("packageId") != parsed["package_id"] or delivery.get("packageVersion") != parsed["version"]:
        raise ValidationError(_("release.json ist kein an dieses Paket gebundener Delivery-Release."))
    release_id = _safe_id(delivery.get("releaseId"), "Delivery releaseId")
    bindings = delivery.get("bindings")
    if not isinstance(bindings, dict) or bindings.get("packageManifestSchema") != PACKAGE_SCHEMA or bindings.get("sourcesSha256") != hashlib.sha256(sources_raw).hexdigest() or bindings.get("qualitySha256") != hashlib.sha256(quality_raw).hexdigest():
        raise ValidationError(_("Delivery-Release bindet Paket, Quellen oder Qualitaet nicht bytegenau."))
    expected_artifacts = sorted([
        {key: entry[key] for key in ("id", "kind", "installPath", "bytes", "sha256")}
        for entry in parsed["files"] if entry["kind"] not in ("release-manifest", "source-manifest")
    ], key=lambda item: item["id"])
    delivered_artifacts = delivery.get("artifacts")
    if not isinstance(delivered_artifacts, list) or sorted(delivered_artifacts, key=lambda item: item.get("id", "") if isinstance(item, dict) else "") != expected_artifacts:
        raise ValidationError(_("Delivery-Release bindet nicht exakt alle auszuliefernden Artefakte."))
    source_entries = sources.get("sources")
    if sources.get("schema") != SOURCES_SCHEMA or sources.get("releaseId") != release_id or not isinstance(source_entries, list) or not source_entries:
        raise ValidationError(_("sources.json ist nicht an den Delivery-Release gebunden."))
    if not all(isinstance(source, dict) and source.get("approved") is True and isinstance(source.get("license"), str) and isinstance(source.get("attribution"), str) and source["attribution"].strip() for source in source_entries):
        raise ValidationError(_("Oeffentliche Quellenfreigabe ist unvollstaendig."))
    attributions = " ".join(source["attribution"] for source in source_entries)
    if not re.search("openstreetmap", attributions, re.I) or not re.search("protomaps", attributions, re.I):
        raise ValidationError(_("OpenStreetMap- oder Protomaps-Attribution fehlt."))
    policy = quality.get("policy")
    if quality.get("schema") != QUALITY_SCHEMA or quality.get("releaseId") != release_id or not isinstance(policy, dict):
        raise ValidationError(_("quality.json ist nicht an den Delivery-Release gebunden."))
    if "internalStationPlanRawDataShipped" in policy or policy.get("classAFromSingleSourceOrAutomatedInference") is not False or policy.get("nonPublicSourceRawDataShipped") is not False or not re.search("not orderable", str(policy.get("classC", "")), re.I) or quality.get("summary", {}).get("visibleLayers") != 10:
        raise ValidationError(_("Qualitaetsgate verletzt den konservativen Zehn-Layer-Vertrag."))
    gates = delivery.get("approvalGates")
    if not isinstance(gates, dict) or gates.get("rights", {}).get("status") != "passed" or gates.get("quality", {}).get("status") != "passed":
        raise ValidationError(_("Rechte- oder Qualitaetsgate ist nicht bestanden."))
    signature_status = gates.get("signature", {}).get("status")
    if signature_status != "missing" or delivery.get("signature") is not None:
        raise ValidationError(_("Ohne produktiven Trust-Store darf der Import keine Signatur behaupten."))
    return {"delivery_release_id": release_id, "signature_status": "missing", "activation_eligible": False}


class ZugfolgeInfraReleaseImport(models.Model):
    """Odoo kontrolliert Upload und Audit; nur das Game qualifiziert und aktiviert einen InfraRelease."""

    _name = "zugfolge.infra.release.import"
    _description = "Zugfolge InfraRelease-Jahresimport"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "create_date desc"

    name = fields.Char(compute="_compute_name", store=True)
    import_id = fields.Char(required=True, readonly=True, copy=False, default=lambda self: str(uuid.uuid4()), index=True)
    state = fields.Selection(
        [("draft", "Entwurf"), ("verifying", "Pruefung laeuft"), ("verified", "Geprueft"), ("staged", "Im Game bereitgestellt"), ("failed", "Fehlgeschlagen")],
        required=True, default="draft", readonly=True, tracking=True,
    )
    importer_id = fields.Many2one("res.users", required=True, readonly=True, default=lambda self: self.env.user, copy=False)
    world_projection_id = fields.Many2one("zugfolge.world.projection", ondelete="restrict")
    manifest_attachment_ids = fields.Many2many("ir.attachment", "zugfolge_infra_import_manifest_rel", "import_id", "attachment_id", copy=False)
    part_attachment_ids = fields.Many2many("ir.attachment", "zugfolge_infra_import_attachment_rel", "import_id", "attachment_id", copy=False)
    manifest_bytes = fields.Integer(readonly=True, copy=False)
    manifest_sha256 = fields.Char(readonly=True, copy=False, index=True)
    package_id = fields.Char(readonly=True, copy=False)
    package_version = fields.Char(readonly=True, copy=False)
    delivery_release_id = fields.Char(readonly=True, copy=False, index=True)
    part_count = fields.Integer(readonly=True, copy=False)
    # PostgreSQL int4 (fields.Integer) overflows for the real 14+ GiB package.
    # An exact NUMERIC column keeps the byte counter integral and future-proof.
    total_part_bytes = fields.Float(digits=(20, 0), readonly=True, copy=False)
    part_inventory = fields.Json(readonly=True, copy=False)
    verification_inventory_sha256 = fields.Char(readonly=True, copy=False)
    verification_started_at = fields.Datetime(readonly=True, copy=False)
    verification_completed_at = fields.Datetime(readonly=True, copy=False)
    verified_by_id = fields.Many2one("res.users", readonly=True, copy=False)
    staging_requested_at = fields.Datetime(readonly=True, copy=False)
    staged_at = fields.Datetime(readonly=True, copy=False)
    game_stage_result = fields.Json(readonly=True, copy=False)
    signature_status = fields.Selection([("missing", "Signatur fehlt"), ("verified", "Signatur geprueft")], readonly=True, copy=False)
    activation_eligible = fields.Boolean(readonly=True, copy=False, default=False)
    failure_code = fields.Char(readonly=True, copy=False)
    failure_detail = fields.Text(readonly=True, copy=False)
    adoption_request_id = fields.Many2one("zugfolge.admin.request", readonly=True, copy=False, ondelete="restrict")

    _sql_constraints = [("zugfolge_infra_release_import_id", "unique(import_id)", "Die Import-ID muss eindeutig sein.")]

    _DRAFT_FIELDS = frozenset({"manifest_attachment_ids", "part_attachment_ids", "world_projection_id"})
    _INTERNAL_FIELDS = frozenset({
        "state", "manifest_bytes", "manifest_sha256", "package_id", "package_version", "delivery_release_id", "part_count",
        "total_part_bytes", "part_inventory", "verification_inventory_sha256", "verification_started_at", "verification_completed_at",
        "verified_by_id", "staging_requested_at", "staged_at", "game_stage_result", "signature_status", "activation_eligible",
        "failure_code", "failure_detail", "adoption_request_id",
    })

    @api.depends("import_id", "delivery_release_id")
    def _compute_name(self):
        for record in self:
            record.name = record.delivery_release_id or _("Jahresimport %s") % (record.import_id or "")

    @api.model_create_multi
    def create(self, values_list):
        if not self.env.user.has_group("zugfolge_admin.group_zugfolge_infra_reviewer"):
            raise AccessError(_("Nur InfraReviewer duerfen Jahresimporte anlegen."))
        allowed = self._DRAFT_FIELDS | {"import_id"}
        for values in values_list:
            unexpected = set(values) - allowed
            if unexpected:
                raise AccessError(_("Auditfelder duerfen beim Import nicht vorgegeben werden: %s") % ", ".join(sorted(unexpected)))
        return super().create(values_list)

    def write(self, values):
        capability = self.env.context.get(_INTERNAL_WRITE_CONTEXT_KEY)
        if capability is _INTERNAL_WRITE_CAPABILITY:
            if set(values) - self._INTERNAL_FIELDS:
                raise AccessError(_("Interner Importpfad darf keine Benutzereingaben veraendern."))
            return super().write(values)
        if _INTERNAL_WRITE_CONTEXT_KEY in self.env.context or "zugfolge_infra_import_internal" in self.env.context:
            raise AccessError(_("Die interne Import-Auditspur kann nicht ueber einen RPC-Kontext freigegeben werden."))
        if not self.env.user.has_group("zugfolge_admin.group_zugfolge_infra_reviewer"):
            raise AccessError(_("Nur InfraReviewer duerfen Jahresimporte bearbeiten."))
        if set(values) - self._DRAFT_FIELDS or any(record.state != "draft" for record in self):
            raise AccessError(_("Nach Beginn der Pruefung ist die Import-Auditspur unveraenderlich."))
        return super().write(values)

    def _internal_write(self, values):
        self._require_reviewer()
        return self.with_context(**{_INTERNAL_WRITE_CONTEXT_KEY: _INTERNAL_WRITE_CAPABILITY}).write(values)

    def _require_reviewer(self):
        if not self.env.user.has_group("zugfolge_admin.group_zugfolge_infra_reviewer"):
            raise AccessError(_("Nur InfraReviewer duerfen diesen Schritt ausfuehren."))

    def _require_importer(self):
        if any(record.importer_id != self.env.user for record in self):
            raise AccessError(_("Nur der protokollierte Uploader darf den Import weiterreichen; die spaetere Freigabe braucht eine andere Person."))

    def action_verify(self):
        self._require_reviewer()
        self._require_importer()
        for record in self:
            if record.state != "draft":
                raise UserError(_("Nur ein Entwurf kann geprueft werden."))
            if len(record.manifest_attachment_ids) != 1 or not record.part_attachment_ids:
                raise ValidationError(_("Manifest und alle Paketteile muessen angehaengt sein."))
            record._internal_write({"state": "verifying", "verification_started_at": fields.Datetime.now(), "verified_by_id": self.env.user.id})
            record.with_delay(description="Zugfolge InfraRelease-Paket pruefen")._verify_job()
        return True

    def _verification_values(self):
        self.ensure_one()
        if len(self.manifest_attachment_ids) != 1:
            raise ValidationError(_("Der Import braucht genau einen Manifestanhang."))
        manifest_attachment = self.manifest_attachment_ids[0]
        if manifest_attachment.name != "manifest.json":
            raise ValidationError(_("Der Manifestanhang muss manifest.json heissen."))
        manifest_path = _attachment_path(manifest_attachment)
        manifest_proof = _hash_file(manifest_path)
        if manifest_proof["bytes"] > MAX_MANIFEST_BYTES:
            raise ValidationError(_("Paketmanifest ist zu gross."))
        with open(manifest_path, "rb") as source:
            raw = source.read(MAX_MANIFEST_BYTES + 1)
        parsed = _parse_package_manifest(raw)
        attachments = {}
        for attachment in self.part_attachment_ids:
            if "/" in attachment.name or "\\" in attachment.name or attachment.name in attachments:
                raise ValidationError(_("Paketteilanhaenge brauchen eindeutige reine Dateinamen."))
            attachments[attachment.name] = attachment
        expected_names = {part["filename"] for part in parsed["parts"]}
        if set(attachments) != expected_names:
            raise ValidationError(_("Angehaengte Paketteile entsprechen nicht exakt dem Manifestinventar."))
        inventory = {}
        audit_inventory = []
        for part in parsed["parts"]:
            attachment = attachments[part["filename"]]
            observed = _hash_file(_attachment_path(attachment))
            if observed["bytes"] != part["bytes"] or observed["sha256"] != part["sha256"]:
                raise ValidationError(_("Paketteil %s stimmt nicht mit Bytezahl oder SHA-256 ueberein.") % part["package_path"])
            item = {**part, "attachment_id": attachment.id}
            audit_inventory.append(item)
            inventory[part["package_path"]] = {**item, "attachment": attachment}
        qualification = _qualify_public_delivery(parsed, inventory)
        inventory_bytes = json.dumps(audit_inventory, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        return parsed, audit_inventory, {
            "manifest_bytes": manifest_proof["bytes"],
            "manifest_sha256": manifest_proof["sha256"],
            "package_id": parsed["package_id"],
            "package_version": parsed["version"],
            "delivery_release_id": qualification["delivery_release_id"],
            "part_count": len(audit_inventory),
            "total_part_bytes": sum(item["bytes"] for item in audit_inventory),
            "part_inventory": audit_inventory,
            "verification_inventory_sha256": hashlib.sha256(inventory_bytes).hexdigest(),
            "signature_status": qualification["signature_status"],
            "activation_eligible": qualification["activation_eligible"],
        }

    def _mark_failed(self, code, error):
        detail = str(error).replace("\x00", "")[:2000]
        self._internal_write({"state": "failed", "failure_code": code, "failure_detail": detail, "activation_eligible": False})

    def _verify_job(self):
        self.ensure_one()
        if self.state == "verified":
            return True
        if self.state != "verifying":
            raise UserError(_("Import befindet sich nicht in der Pruefung."))
        try:
            _parsed, _inventory, values = self._verification_values()
            self._internal_write({**values, "state": "verified", "verification_completed_at": fields.Datetime.now(), "failure_code": False, "failure_detail": False})
        except Exception as error:  # queue_job muss den fehlgeschlagenen Auditdatensatz erhalten
            self._mark_failed("verification_failed", error)
        return True

    def _staging_payload(self):
        parsed, inventory, values = self._verification_values()
        if values["manifest_sha256"] != self.manifest_sha256 or values["verification_inventory_sha256"] != self.verification_inventory_sha256:
            raise ValidationError(_("Anhaenge wurden nach der Pruefung veraendert."))
        by_attachment = {attachment.id: attachment for attachment in self.part_attachment_ids}
        parts = []
        for item in inventory:
            attachment = by_attachment.get(item["attachment_id"])
            if not attachment:
                raise ValidationError(_("Ein gepruefter Paketteilanhang fehlt."))
            parts.append({**item, "path": _attachment_path(attachment)})
        return parsed, {
            "bytes": self.manifest_bytes,
            "sha256": self.manifest_sha256,
            "path": _attachment_path(self.manifest_attachment_ids[0]),
        }, parts

    def action_stage(self):
        self._require_reviewer()
        self._require_importer()
        for record in self:
            if record.state != "verified":
                raise UserError(_("Nur ein geprueftes Paket kann bereitgestellt werden."))
            record._internal_write({"staging_requested_at": fields.Datetime.now()})
            record.with_delay(description="Zugfolge InfraRelease-Paket an Game bereitstellen")._stage_job()
        return True

    def _stage_job(self):
        self.ensure_one()
        if self.state == "staged":
            return True
        if self.state != "verified":
            raise UserError(_("Import ist nicht geprueft."))
        try:
            _parsed, manifest, parts = self._staging_payload()
            result = stage_infra_package(self.env, self.import_id, manifest, parts)
            if result.get("packageId") != self.package_id or result.get("packageVersion") != self.package_version or result.get("manifestSha256") != self.manifest_sha256 or result.get("deliveryReleaseId") != self.delivery_release_id:
                raise ValidationError(_("Game-Stagingantwort weicht vom geprueften Import ab."))
            if result.get("signatureStatus") != "missing" or result.get("activationEligible") is not False:
                raise ValidationError(_("Bis zur implementierten Antwortauthentifizierung akzeptiert Odoo nur den fail-closed Status Signatur fehlt/nicht aktivierbar."))
            self._internal_write({
                "state": "staged", "staged_at": fields.Datetime.now(), "game_stage_result": result,
                "signature_status": result.get("signatureStatus"), "activation_eligible": result.get("activationEligible") is True,
                "failure_code": False, "failure_detail": False,
            })
        except Exception as error:  # queue_job muss den fehlgeschlagenen Auditdatensatz erhalten
            self._mark_failed("staging_failed", error)
        return True

    def action_create_adoption_request(self):
        self._require_reviewer()
        self._require_importer()
        self.ensure_one()
        if self.state != "staged" or not self.activation_eligible or self.signature_status != "verified":
            raise UserError(_("Nur ein vom Game erneut gepruefter, signierter und bereitgestellter Release darf in die Vier-Augen-Freigabe."))
        if self.adoption_request_id:
            return {"type": "ir.actions.act_window", "res_model": "zugfolge.admin.request", "res_id": self.adoption_request_id.id, "view_mode": "form"}
        if not self.world_projection_id:
            raise ValidationError(_("Fuer die Uebernahme muss eine Welt gewaehlt sein."))
        request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.world_projection_id.id,
            "action_type": "infra_release_adoption",
            "risk_class": "high",
            "reason": _("Jahresimport %s nach separater Game-Qualifikation uebernehmen.") % self.delivery_release_id,
            "effect_preview": {"kind": "infra-release", "deliveryReleaseId": self.delivery_release_id, "manifestSha256": self.manifest_sha256},
            "release_hash": self.manifest_sha256,
            "requested_period_start": fields.Datetime.now(),
        })
        self._internal_write({"adoption_request_id": request.id})
        return {"type": "ir.actions.act_window", "res_model": "zugfolge.admin.request", "res_id": request.id, "view_mode": "form"}
