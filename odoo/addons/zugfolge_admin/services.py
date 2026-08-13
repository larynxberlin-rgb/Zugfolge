"""Small HMAC boundary; no Game database driver is imported or configured here."""
import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit

import requests

from odoo.exceptions import UserError


def _parameter(env, key):
    value = env["ir.config_parameter"].sudo().get_param(key)
    if not value:
        raise UserError("Zugfolge-Integrationsparameter '%s' fehlt." % key)
    return value


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def signature(secret, timestamp, payload):
    return hmac.new(secret.encode("utf-8"), (timestamp + "." + canonical_json(payload)).encode("utf-8"), hashlib.sha256).hexdigest()


def dispatch_signed_game_command(env, correlation_id, actor_reference, command):
    """Only called after Odoo-native approval. Game validates again independently."""
    url = _parameter(env, "zugfolge_admin.game_webhook_url")
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
    response = requests.post(url, json=payload, headers={
        "X-Zugfolge-Odoo-Key-Id": key_id,
        "X-Zugfolge-Odoo-Timestamp": timestamp,
        "X-Zugfolge-Odoo-Signature": signature(secret, timestamp, payload),
    }, timeout=10)
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


def _infra_headers(env, method, url, content_bytes, content_sha256):
    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    secret = env["ir.config_parameter"].sudo().get_param("zugfolge_admin.infra_upload_secret") or os.environ.get("ZUGFOLGE_INFRA_UPLOAD_SECRET")
    key_id = env["ir.config_parameter"].sudo().get_param("zugfolge_admin.infra_upload_key_id") or os.environ.get("ZUGFOLGE_INFRA_UPLOAD_KEY_ID")
    if not secret or not key_id:
        raise UserError("Zugfolge-Infra-Uploadschluessel ist nicht konfiguriert.")
    pathname = urlsplit(url).path
    return {
        "X-Zugfolge-Infra-Key-Id": key_id,
        "X-Zugfolge-Infra-Timestamp": timestamp,
        "X-Zugfolge-Infra-Content-Bytes": str(content_bytes),
        "X-Zugfolge-Infra-Content-Sha256": content_sha256,
        "X-Zugfolge-Infra-Signature": infra_upload_signature(secret, timestamp, method, pathname, content_bytes, content_sha256),
    }


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


def stage_infra_package(env, import_id, manifest, parts):
    """Stream an das lokale Game-Staging; weder Odoo noch dieser Client aktiviert einen Release."""
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
    _infra_response(response, "Start")

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

    empty_sha256 = hashlib.sha256(b"").hexdigest()
    finalize_url = "%s/finalize" % import_url
    response = requests.post(
        finalize_url,
        data=b"",
        headers=_infra_headers(env, "POST", finalize_url, 0, empty_sha256),
        timeout=(10, 3600),
    )
    result = _infra_response(response, "Abschluss")
    if result.get("signatureStatus") == "missing" and result.get("activationEligible") is not False:
        raise UserError("Game hat einen unsignierten Release unerwartet als aktivierbar markiert.")
    return result
