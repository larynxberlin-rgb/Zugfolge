"""Small HMAC boundary; no Game database driver is imported or configured here."""
import hashlib
import hmac
import json
from datetime import datetime, timezone

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
    payload = {
        "schemaVersion": "zugfolge-odoo/v1",
        "eventId": "odoo-%s" % correlation_id,
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
