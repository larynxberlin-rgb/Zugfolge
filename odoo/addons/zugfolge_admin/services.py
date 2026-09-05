"""Small HMAC boundary; no Game database driver is imported or configured here."""
import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit

import requests

from odoo.exceptions import UserError

from .models.canonical_json import canonical_json


SHA256 = re.compile(r"^[a-f0-9]{64}$")
FINALIZATION_NONCE = re.compile(r"^[a-f0-9]{64}$")
SAFE_KEY_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
UTC_MILLISECONDS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
FINALIZATION_MAX_DURATION_SECONDS = 65 * 60
FINALIZATION_RECEIPT_V1_FIELDS = {
    "schema", "signatureAlgorithm", "keyId", "nonce", "requestedAt", "finalizedAt", "importId",
    "packageId", "packageVersion", "manifestSha256", "deliveryReleaseId", "operationalStateHash",
    "signatureStatus", "nativeOperationalValidationStatus", "activationBlocker", "activationEligible",
}
FINALIZATION_RECEIPT_V2_PROVENANCE_FIELDS = {
    "operationalProvenanceStatus", "operationalProvenanceSha256",
    "operationalExecutionProofSha256", "operationalValidatorSha256",
    "operationalAuthorityStatus", "operationalAuthoritySha256",
    "operationalRebuildAttestationSha256", "operationalExecutionAuthorityAttestationSha256",
    "operationalOuterExecutionReceiptSha256", "operationalOuterExecutionCompletionSha256",
    "operationalAuthoritySourceCommit",
}
LEGACY_DELIVERY_V2_VERSIONS = frozenset(("2026.1", "2026.3", "2026.4"))
PROVENANCE_DELIVERY_V2_VERSION = "2026.5"


def _delivery_v2_generation(version):
    if version == PROVENANCE_DELIVERY_V2_VERSION:
        return "integrated-provenance-v2"
    if version in LEGACY_DELIVERY_V2_VERSIONS:
        return "legacy-v1"
    raise UserError("Paketversion ist nicht als Deutschland-Delivery-v2-Version freigegeben.")


def _parameter(env, key):
    value = env["ir.config_parameter"].sudo().get_param(key)
    if not value:
        raise UserError("Zugfolge-Integrationsparameter '%s' fehlt." % key)
    return value


def _finalization_canonical(value):
    # Entspricht JSON.stringify auf der Game-Seite; der Beleg enthaelt keine Zahlen.
    return canonical_json(value)


def signature(secret, timestamp, payload):
    return hmac.new(secret.encode("utf-8"), (timestamp + "." + canonical_json(payload)).encode("utf-8"), hashlib.sha256).hexdigest()


def game_command_targets(env, command):
    """Every public/private Game server has exactly one configured canonical origin."""
    try:
        worlds = json.loads(_parameter(env, "zugfolge_admin.game_world_origins_json"))
    except (TypeError, ValueError) as error:
        raise UserError("Zugfolge-Weltserverregister ist kein gueltiges JSON.") from error
    if not isinstance(worlds, dict) or not worlds:
        raise UserError("Zugfolge-Weltserverregister ist leer.")
    origins = set()
    for world_id, origin in worlds.items():
        if not isinstance(world_id, str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", world_id):
            raise UserError("Zugfolge-Weltserverregister enthaelt keine gueltige Hauptwelt-ID.")
        if not isinstance(origin, str):
            raise UserError("Zugfolge-Weltserver braucht eine kanonische HTTPS-Origin.")
        parsed = urlsplit(origin)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment or origin != "https://" + parsed.netloc
                or parsed.hostname != parsed.hostname.lower() or origin in origins):
            raise UserError("Jede Zugfolge-Hauptwelt braucht eine eigene kanonische HTTPS-Origin ohne Pfad.")
        origins.add(origin)
    if not isinstance(command, dict):
        raise UserError("Zugfolge-Kommando ist ungueltig.")
    if command.get("kind") == "entitlement.change":
        # Kontoweite Komfort-/Produktrechte werden explizit auf alle registrierten
        # Hauptweltserver projiziert; ein Retry behaelt dieselbe fachliche Event-ID.
        selected = sorted(worlds)
    else:
        world_id = command.get("worldId")
        if world_id not in worlds:
            raise UserError("Fuer die Zielwelt ist kein eigener Game-Server registriert.")
        selected = [world_id]
    return [worlds[world_id] + "/api/integrations/odoo/webhooks" for world_id in selected]


def dispatch_signed_game_command(env, correlation_id, actor_reference, command):
    """Only called after Odoo-native approval. Game validates again independently."""
    targets = game_command_targets(env, command)
    tenant_id = _parameter(env, "zugfolge_admin.tenant_id")
    key_id = _parameter(env, "zugfolge_admin.webhook_key_id")
    secret = _parameter(env, "zugfolge_admin.webhook_secret")
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    business_event_key = command.get("idempotencyKey") if isinstance(command, dict) else None
    payload = {
        "schemaVersion": "zugfolge-odoo/v1",
        "eventId": "odoo-%s" % (business_event_key or correlation_id),
        "eventType": "commerce.command",
        "occurredAt": timestamp,
        "correlationId": correlation_id,
        "tenantId": tenant_id,
        "actorReference": actor_reference,
        "command": command,
    }
    for url in targets:
        response = requests.post(url, json=payload, headers={
            "X-Zugfolge-Odoo-Key-Id": key_id,
            "X-Zugfolge-Odoo-Timestamp": timestamp,
            "X-Zugfolge-Odoo-Signature": signature(secret, timestamp, payload),
        }, timeout=10, allow_redirects=False)
        if response.status_code not in (200, 202):
            raise UserError("Game hat den Antrag nicht angenommen (%s)." % response.status_code)
        try:
            result = response.json()
        except ValueError as error:
            raise UserError("Game hat keine pruefbare Annahme bestaetigt.") from error
        if not isinstance(result, dict) or result.get("accepted") is not True:
            raise UserError("Game hat den Antrag fachlich abgelehnt (%s)." % (result.get("code", "invalid_response") if isinstance(result, dict) else "invalid_response"))


def infra_upload_signature(secret, timestamp, method, pathname, content_bytes, content_sha256):
    message = "%s\n%s\n%s\n%s\n%s" % (timestamp, method.upper(), pathname, content_bytes, content_sha256)
    return hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


def _infra_credentials(env):
    secret = env["ir.config_parameter"].sudo().get_param("zugfolge_admin.infra_upload_secret") or os.environ.get("ZUGFOLGE_INFRA_UPLOAD_SECRET")
    key_id = env["ir.config_parameter"].sudo().get_param("zugfolge_admin.infra_upload_key_id") or os.environ.get("ZUGFOLGE_INFRA_UPLOAD_KEY_ID")
    if not secret or not key_id or not SAFE_KEY_ID.fullmatch(key_id):
        raise UserError("Zugfolge-Infra-Uploadschluessel ist nicht konfiguriert.")
    return key_id, secret


def _infra_headers(env, method, url, content_bytes, content_sha256):
    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    key_id, secret = _infra_credentials(env)
    pathname = urlsplit(url).path
    return {
        "X-Zugfolge-Infra-Key-Id": key_id,
        "X-Zugfolge-Infra-Timestamp": timestamp,
        "X-Zugfolge-Infra-Content-Bytes": str(content_bytes),
        "X-Zugfolge-Infra-Content-Sha256": content_sha256,
        "X-Zugfolge-Infra-Signature": infra_upload_signature(secret, timestamp, method, pathname, content_bytes, content_sha256),
    }


def _finalization_timestamp(value, label):
    if not isinstance(value, str) or not UTC_MILLISECONDS.fullmatch(value):
        raise UserError("Game-Finalisierungsbeleg besitzt keinen kanonischen %s-Zeitstempel." % label)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise UserError("Game-Finalisierungsbeleg besitzt keinen gueltigen %s-Zeitstempel." % label) from error


def verify_infra_finalization_receipt(env, result, expected, expected_nonce):
    """Verifiziert die Game-Quittung mit demselben rotierbaren HMAC-Key wie den Upload."""
    if not isinstance(result, dict) or result.get("accepted") is not True:
        raise UserError("Game hat keinen strukturierten Finalisierungsbeleg geliefert.")
    receipt = result.get("finalizationReceipt")
    receipt_signature = result.get("finalizationReceiptSignature")
    expected_version = expected.get("packageVersion")
    current_operational = _delivery_v2_generation(expected_version) == "integrated-provenance-v2"
    if expected.get("deliveryReleaseId") != "infra-deutschland-%s" % expected_version:
        raise UserError("Gepruefter Import bindet Paketversion und InfraRelease-ID nicht exakt.")
    expected_fields = FINALIZATION_RECEIPT_V1_FIELDS | (FINALIZATION_RECEIPT_V2_PROVENANCE_FIELDS if current_operational else set())
    if not isinstance(receipt, dict) or set(receipt) != expected_fields:
        raise UserError("Game hat keinen vollstaendigen Finalisierungsbeleg geliefert.")
    key_id, secret = _infra_credentials(env)
    expected_schema = "zugfolge-infra-package-finalization-receipt/v2" if current_operational else "zugfolge-infra-package-finalization-receipt/v1"
    if receipt.get("schema") != expected_schema or receipt.get("signatureAlgorithm") != "HMAC-SHA256" or receipt.get("keyId") != key_id:
        raise UserError("Game-Finalisierungsbeleg besitzt keine vertraute HMAC-Schluesselbindung.")
    if not isinstance(receipt_signature, str) or not SHA256.fullmatch(receipt_signature):
        raise UserError("Game-Finalisierungsbeleg besitzt keine gueltige HMAC-Signatur.")
    expected_signature = hmac.new(secret.encode("utf-8"), _finalization_canonical(receipt).encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(receipt_signature, expected_signature):
        raise UserError("Game-Finalisierungsbeleg besitzt eine falsche HMAC-Signatur.")
    if not isinstance(expected_nonce, str) or not FINALIZATION_NONCE.fullmatch(expected_nonce) or receipt.get("nonce") != expected_nonce:
        raise UserError("Game-Finalisierungsbeleg gehoert zu einer anderen oder wiederverwendeten Nonce.")
    requested_at = _finalization_timestamp(receipt.get("requestedAt"), "requestedAt")
    finalized_at = _finalization_timestamp(receipt.get("finalizedAt"), "finalizedAt")
    finalization_duration = (finalized_at - requested_at).total_seconds()
    if finalization_duration < -5 * 60 or finalization_duration > FINALIZATION_MAX_DURATION_SECONDS:
        raise UserError("Game-Finalisierungsbeleg verletzt das gebundene Zeitfenster.")

    signature_status = receipt.get("signatureStatus")
    bindings = {
        "importId": "importId",
        "packageId": "packageId",
        "packageVersion": "packageVersion",
        "manifestSha256": "manifestSha256",
        "deliveryReleaseId": "deliveryReleaseId",
    }
    if current_operational and signature_status == "verified":
        bindings.update({
            "operationalProvenanceSha256": "operationalProvenanceSha256",
            "operationalExecutionProofSha256": "operationalExecutionProofSha256",
            "operationalValidatorSha256": "operationalValidatorSha256",
            "operationalAuthoritySha256": "operationalAuthoritySha256",
            "operationalRebuildAttestationSha256": "operationalRebuildAttestationSha256",
            "operationalExecutionAuthorityAttestationSha256": "operationalExecutionAuthorityAttestationSha256",
            "operationalOuterExecutionReceiptSha256": "operationalOuterExecutionReceiptSha256",
            "operationalOuterExecutionCompletionSha256": "operationalOuterExecutionCompletionSha256",
            "operationalAuthoritySourceCommit": "operationalAuthoritySourceCommit",
        })
    for receipt_key, expected_key in bindings.items():
        if receipt.get(receipt_key) != expected.get(expected_key):
            raise UserError("Game-Finalisierungsbeleg weicht bei %s vom geprueften Import ab." % receipt_key)
        if result.get(receipt_key) != receipt.get(receipt_key):
            raise UserError("Game-Antwort und signierter Finalisierungsbeleg widersprechen sich bei %s." % receipt_key)

    status_fields = (
        "operationalStateHash", "signatureStatus", "nativeOperationalValidationStatus",
        "activationBlocker", "activationEligible",
        *(tuple(sorted(FINALIZATION_RECEIPT_V2_PROVENANCE_FIELDS)) if current_operational else ()),
    )
    if any(result.get(field) != receipt.get(field) for field in status_fields):
        raise UserError("Game-Antwort und signierter Finalisierungsbeleg widersprechen sich im Qualifikationsstatus.")
    native_status = receipt.get("nativeOperationalValidationStatus")
    state_hash = receipt.get("operationalStateHash")
    blocker = receipt.get("activationBlocker")
    eligible = receipt.get("activationEligible")
    if signature_status == "missing":
        current_provenance_consistent = not current_operational or (
            receipt.get("operationalProvenanceStatus") == "missing"
            and receipt.get("operationalProvenanceSha256") is None
            and receipt.get("operationalExecutionProofSha256") is None
            and receipt.get("operationalValidatorSha256") is None
            and receipt.get("operationalAuthorityStatus") == "missing"
            and receipt.get("operationalAuthoritySha256") is None
            and receipt.get("operationalRebuildAttestationSha256") is None
            and receipt.get("operationalExecutionAuthorityAttestationSha256") is None
            and receipt.get("operationalOuterExecutionReceiptSha256") is None
            and receipt.get("operationalOuterExecutionCompletionSha256") is None
            and receipt.get("operationalAuthoritySourceCommit") is None
        )
        consistent = current_provenance_consistent and native_status == "missing" and state_hash is None and blocker == "delivery-signature-missing" and eligible is False
    elif signature_status == "verified" and native_status == "missing":
        current_provenance_consistent = not current_operational or (
            receipt.get("operationalProvenanceStatus") == "verified"
            and receipt.get("operationalAuthorityStatus") == "verified"
            and all(
                isinstance(receipt.get(field), str) and SHA256.fullmatch(receipt[field])
                for field in (
                    "operationalProvenanceSha256", "operationalExecutionProofSha256", "operationalValidatorSha256",
                    "operationalAuthoritySha256", "operationalRebuildAttestationSha256",
                    "operationalExecutionAuthorityAttestationSha256", "operationalOuterExecutionReceiptSha256",
                    "operationalOuterExecutionCompletionSha256",
                )
            )
            and isinstance(receipt.get("operationalAuthoritySourceCommit"), str)
            and re.fullmatch(r"[a-f0-9]{40}", receipt["operationalAuthoritySourceCommit"])
        )
        consistent = current_provenance_consistent and state_hash is None and blocker == "operational-v2-native-validation-missing" and eligible is False
    elif signature_status == "verified" and native_status == "verified":
        current_provenance_consistent = not current_operational or (
            receipt.get("operationalProvenanceStatus") == "verified"
            and receipt.get("operationalAuthorityStatus") == "verified"
            and all(
                isinstance(receipt.get(field), str) and SHA256.fullmatch(receipt[field])
                for field in (
                    "operationalProvenanceSha256", "operationalExecutionProofSha256", "operationalValidatorSha256",
                    "operationalAuthoritySha256", "operationalRebuildAttestationSha256",
                    "operationalExecutionAuthorityAttestationSha256", "operationalOuterExecutionReceiptSha256",
                    "operationalOuterExecutionCompletionSha256",
                )
            )
            and isinstance(receipt.get("operationalAuthoritySourceCommit"), str)
            and re.fullmatch(r"[a-f0-9]{40}", receipt["operationalAuthoritySourceCommit"])
        )
        consistent = current_provenance_consistent and isinstance(state_hash, str) and SHA256.fullmatch(state_hash) and state_hash == expected.get("operationalStateHash") and blocker is None and eligible is True
    else:
        consistent = False
    if not consistent:
        raise UserError("Game-Finalisierungsbeleg besitzt keine konsistente fail-closed Qualifikation.")
    return receipt


def _infra_response(response, operation):
    if response.status_code not in (200, 201, 202):
        raise UserError("Game hat den Infra-Paket-%s abgelehnt (%s)." % (operation, response.status_code))
    try:
        result = response.json()
    except ValueError as error:
        raise UserError("Game hat fuer den Infra-Paket-%s keine pruefbare Antwort geliefert." % operation) from error
    if not isinstance(result, dict) or result.get("accepted") is not True:
        raise UserError("Game hat den Infra-Paket-%s fachlich abgelehnt (%s)." % (operation, result.get("code", "invalid_response") if isinstance(result, dict) else "invalid_response"))
    return result


def stage_infra_package(env, import_id, manifest, parts, finalization_nonce):
    """Stream an das lokale Game-Staging; weder Odoo noch dieser Client aktiviert einen Release."""
    if not isinstance(finalization_nonce, str) or not FINALIZATION_NONCE.fullmatch(finalization_nonce):
        raise UserError("Zugfolge-Infra-Finalisierungsnonce ist ungueltig.")
    base_url = env["ir.config_parameter"].sudo().get_param("zugfolge_admin.infra_upload_base_url") or os.environ.get("ZUGFOLGE_INFRA_UPLOAD_BASE_URL")
    if not base_url:
        raise UserError("Zugfolge-Infra-Uploadziel ist nicht konfiguriert.")
    base_url = base_url.rstrip("/")
    import_url = "%s/%s" % (base_url, quote(import_id, safe=""))
    begin_body = {
        "manifestBytes": manifest["bytes"],
        "manifestSha256": manifest["sha256"],
    }
    begin_bytes = json.dumps(begin_body, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    response = requests.post(
        import_url,
        data=begin_bytes,
        headers={"Content-Type": "application/json", **_infra_headers(env, "POST", import_url, len(begin_bytes), hashlib.sha256(begin_bytes).hexdigest())},
        timeout=(10, 60),
    )
    begin_result = _infra_response(response, "Start")
    begin_status = begin_result.get("status")
    if begin_status == "finalized":
        return begin_result
    if begin_status not in ("created", "reused", "closed"):
        raise UserError("Game hat fuer den Infra-Paket-Start einen unbekannten Zustand geliefert.")

    if begin_status != "closed":
        manifest_url = "%s/manifest" % import_url
        with open(manifest["path"], "rb") as source:
            response = requests.put(
                manifest_url,
                data=source,
                headers={"Content-Type": "application/octet-stream", **_infra_headers(env, "PUT", manifest_url, manifest["bytes"], manifest["sha256"])},
                timeout=(10, 600),
            )
        accepted_manifest = _infra_response(response, "Manifestupload")
        server_parts = accepted_manifest.get("parts")
        if not isinstance(server_parts, list):
            raise UserError("Game hat kein serverseitiges Paketteilinventar geliefert.")
        by_path = {part["packagePath"]: part for part in server_parts if isinstance(part, dict) and isinstance(part.get("packagePath"), str)}
        if len(by_path) != len(parts) or set(by_path) != {part["package_path"] for part in parts}:
            raise UserError("Game- und Odoo-Paketteilinventar weichen voneinander ab.")

        for part in sorted(parts, key=lambda item: item["package_path"]):
            server_part = by_path[part["package_path"]]
            if server_part.get("bytes") != part["bytes"] or server_part.get("sha256") != part["sha256"] or not isinstance(server_part.get("partId"), str):
                raise UserError("Game hat fuer %s einen abweichenden Byte-SHA-Vertrag geliefert." % part["package_path"])
            part_url = "%s/parts/%s" % (import_url, quote(server_part["partId"], safe=""))
            with open(part["path"], "rb") as source:
                response = requests.put(
                    part_url,
                    data=source,
                    headers={"Content-Type": "application/octet-stream", **_infra_headers(env, "PUT", part_url, part["bytes"], part["sha256"])},
                    timeout=(10, 1800),
                )
            _infra_response(response, "Paketteilupload")

    finalize_url = "%s/finalize" % import_url
    finalize_body = {
        "schema": "zugfolge-infra-package-finalization-challenge/v1",
        "nonce": finalization_nonce,
        "requestedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    finalize_bytes = json.dumps(finalize_body, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    response = requests.post(
        finalize_url,
        data=finalize_bytes,
        headers={"Content-Type": "application/json", **_infra_headers(env, "POST", finalize_url, len(finalize_bytes), hashlib.sha256(finalize_bytes).hexdigest())},
        timeout=(10, 3600),
    )
    result = _infra_response(response, "Abschluss")
    return result
