import hashlib
import hmac
import json
from datetime import datetime, timezone

from odoo import http
from odoo.http import request


def _valid_signature(payload, key_id, timestamp, supplied):
    keys_json = request.env["ir.config_parameter"].sudo().get_param("zugfolge_admin.projection_keys_json")
    if not keys_json or not key_id or not timestamp or not supplied:
        return False
    try:
        keys = json.loads(keys_json)
        secret = keys[key_id]
        issued_at = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False
    if abs((datetime.now(timezone.utc) - issued_at).total_seconds()) > 300:
        return False
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    expected = hmac.new(secret.encode("utf-8"), (timestamp + "." + canonical).encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, supplied)


class ZugfolgeProjectionController(http.Controller):
    @http.route("/zugfolge/metrics", type="http", auth="none", methods=["GET"], csrf=False)
    def prometheus_metrics(self, **_kwargs):
        body = "# HELP zugfolge_odoo_ready Odoo process and database request path are ready.\n# TYPE zugfolge_odoo_ready gauge\nzugfolge_odoo_ready 1\n"
        return request.make_response(body, headers=[("Content-Type", "text/plain; version=0.0.4; charset=utf-8"), ("Cache-Control", "no-store")])

    @http.route("/zugfolge/projection", type="json", auth="none", methods=["POST"], csrf=False)
    def ingest_projection(self, **_kwargs):
        payload = request.jsonrequest
        headers = request.httprequest.headers
        if not isinstance(payload, dict) or not _valid_signature(payload, headers.get("X-Zugfolge-Odoo-Key-Id"), headers.get("X-Zugfolge-Odoo-Timestamp"), headers.get("X-Zugfolge-Odoo-Signature")):
            return {"accepted": False, "code": "invalid_signature"}
        if payload.get("schemaVersion") != "zugfolge-odoo/v1" or payload.get("messageType") not in ("world.projection", "alpha.feedback.projection", "admin.command.result", "admin.capability.projection", "reconciliation.task"):
            return {"accepted": False, "code": "invalid_schema"}
        model = request.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True)
        if payload["messageType"] == "world.projection":
            model.upsert_game_projection(payload)
        if payload["messageType"] == "admin.capability.projection":
            request.env["zugfolge.admin.capability"].with_context(zugfolge_game_projection=True).upsert_game_projection(payload)
        if payload["messageType"] == "alpha.feedback.projection":
            request.env["zugfolge.feedback"].with_context(zugfolge_game_projection=True).upsert_game_projection(payload)
        receipt = request.env["zugfolge.projection.receipt"].with_context(zugfolge_game_projection=True)
        existing = receipt.search([("message_id", "=", payload.get("messageId"))], limit=1)
        if not existing:
            body = payload.get("payload", {})
            digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")).hexdigest()
            receipt.create({"message_id": payload.get("messageId"), "world_id": payload.get("worldId"), "correlation_id": payload.get("correlationId"), "payload_hash": digest})
        if payload["messageType"] == "admin.command.result":
            result = payload.get("payload", {})
            request_record = request.env["zugfolge.admin.request"].search([("correlation_id", "=", payload.get("correlationId"))], limit=1)
            if request_record:
                state = result.get("state") if result.get("state") in ("accepted", "completed", "failed", "rejected") else ("accepted" if result.get("outcome") == "accepted" else "rejected")
                request_record.with_context(zugfolge_game_projection=True).apply_game_result({**result, "state": state})
                if request_record.action_type == "world_access_revoke" and state == "completed":
                    invitation = request.env["zugfolge.alpha.invitation"].search([
                        ("world_projection_id", "=", request_record.world_projection_id.id),
                        ("keycloak_subject", "=", result.get("keycloakSubject") or request_record.target_reference),
                        ("revocation_request_id", "=", request_record.id),
                    ], limit=1)
                    if invitation:
                        invitation.with_context(zugfolge_game_projection=True).write({"state": "revoked"})
            invitation = request.env["zugfolge.alpha.invitation"].search([("correlation_id", "=", payload.get("correlationId"))], limit=1)
            if invitation:
                values = {"state": "provisioned" if result.get("outcome") == "accepted" else "failed"}
                if result.get("keycloakSubject"):
                    values.update({"keycloak_subject": result.get("keycloakSubject"), "game_account_reference": result.get("gameAccountReference")})
                invitation.with_context(zugfolge_game_projection=True).write(values)
        return {"accepted": True, "messageId": payload.get("messageId")}

    @http.route("/zugfolge/reconciliation/snapshot", type="json", auth="none", methods=["POST"], csrf=False)
    def reconciliation_snapshot(self, **_kwargs):
        payload = request.jsonrequest
        headers = request.httprequest.headers
        if not isinstance(payload, dict) or payload.get("schemaVersion") != "zugfolge-odoo/v1" or not _valid_signature(payload, headers.get("X-Zugfolge-Odoo-Key-Id"), headers.get("X-Zugfolge-Odoo-Timestamp"), headers.get("X-Zugfolge-Odoo-Signature")):
            return {"accepted": False, "code": "invalid_signature"}
        receipts = request.env["zugfolge.projection.receipt"].sudo().search_read([], ["message_id", "world_id", "correlation_id", "payload_hash"])
        return [{"messageId": item["message_id"], "worldId": item["world_id"], "correlationId": item["correlation_id"], "payloadHash": item["payload_hash"]} for item in receipts]
