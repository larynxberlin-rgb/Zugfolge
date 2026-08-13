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


def _find_admin_request_for_game_result(env, correlation_id, world_id):
    """Bind a signed result to both stable correlation and authoritative world."""
    if not isinstance(correlation_id, str) or not correlation_id or not isinstance(world_id, str) or not world_id:
        return env["zugfolge.admin.request"].browse()
    return env["zugfolge.admin.request"].sudo().search([
        ("correlation_id", "=", correlation_id),
        ("world_id", "=", world_id),
    ], limit=1)


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
        message_id = payload.get("messageId")
        if (payload.get("schemaVersion") != "zugfolge-odoo/v1"
                or payload.get("messageType") not in ("world.projection", "public.world.snapshot", "world.participation.result", "alpha.feedback.projection", "admin.command.result", "admin.capability.projection", "reconciliation.task")
                or not isinstance(message_id, str) or not message_id):
            return {"accepted": False, "code": "invalid_schema"}
        body = payload.get("payload", {})
        digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")).hexdigest()
        # Ab hier ist der Integrationsaufruf signiert und zeitlich begrenzt.
        # Nur dieser Pfad darf die schreibgeschuetzten Game-Projektionen pflegen.
        receipt = request.env["zugfolge.projection.receipt"].sudo().with_context(zugfolge_game_projection=True)
        existing = receipt.search([("message_id", "=", message_id)], limit=1)
        if existing:
            if (existing.payload_hash != digest or existing.world_id != payload.get("worldId")
                    or existing.correlation_id != payload.get("correlationId")):
                return {"accepted": False, "code": "replay_conflict"}
            return {"accepted": True, "messageId": message_id, "duplicate": True}
        # Der Beleg wird in derselben Odoo-Transaktion wie die Wirkung angelegt.
        # Wirft die Projektion, rollt beides zurueck; ein Replay kann nie zweimal wirken.
        receipt.create({
            "message_id": message_id, "world_id": payload.get("worldId"),
            "correlation_id": payload.get("correlationId"), "payload_hash": digest,
        })
        model = request.env["zugfolge.world.projection"].sudo().with_context(zugfolge_game_projection=True)
        if payload["messageType"] == "world.projection":
            model.upsert_game_projection(payload)
        if payload["messageType"] == "public.world.snapshot":
            model.upsert_public_snapshot(payload)
        if payload["messageType"] == "admin.capability.projection":
            request.env["zugfolge.admin.capability"].sudo().with_context(zugfolge_game_projection=True).upsert_game_projection(payload)
        if payload["messageType"] == "alpha.feedback.projection":
            request.env["zugfolge.feedback"].sudo().with_context(zugfolge_game_projection=True).upsert_game_projection(payload)
        if payload["messageType"] == "admin.command.result":
            result = payload.get("payload", {})
            request_record = _find_admin_request_for_game_result(
                request.env,
                payload.get("correlationId"),
                payload.get("worldId"),
            )
            if request_record:
                state = result.get("state") if result.get("state") in ("accepted", "completed", "failed", "rejected") else ("accepted" if result.get("outcome") == "accepted" else "rejected")
                request_record.with_context(zugfolge_game_projection=True).apply_game_result({**result, "state": state})
                if request_record.action_type == "world_access_revoke" and state == "completed":
                    invitation = request.env["zugfolge.alpha.invitation"].sudo().search([
                        ("world_projection_id", "=", request_record.world_projection_id.id),
                        ("keycloak_subject", "=", result.get("keycloakSubject") or request_record.target_reference),
                        ("revocation_request_id", "=", request_record.id),
                    ], limit=1)
                    if invitation:
                        invitation.with_context(zugfolge_game_projection=True)._apply_game_revocation_result(
                            request_record.id,
                            payload.get("worldId"),
                        )
            invitation = request.env["zugfolge.alpha.invitation"].sudo().search([
                ("correlation_id", "=", payload.get("correlationId")),
                ("world_projection_id.world_id", "=", payload.get("worldId")),
            ], limit=1)
            if invitation:
                invitation.with_context(zugfolge_game_projection=True)._apply_game_result(
                    result,
                    payload.get("worldId"),
                )
        if payload["messageType"] == "world.participation.result":
            result = payload.get("payload", {})
            participation = request.env["zugfolge.world.participation"].sudo().search([
                ("correlation_id", "=", payload.get("correlationId")),
                ("world_id", "=", payload.get("worldId")),
            ], limit=1)
            if participation:
                participation.with_context(zugfolge_game_projection=True).apply_game_result(result)
        return {"accepted": True, "messageId": message_id}

    @http.route("/zugfolge/reconciliation/snapshot", type="json", auth="none", methods=["POST"], csrf=False)
    def reconciliation_snapshot(self, **_kwargs):
        payload = request.jsonrequest
        headers = request.httprequest.headers
        if not isinstance(payload, dict) or payload.get("schemaVersion") != "zugfolge-odoo/v1" or not _valid_signature(payload, headers.get("X-Zugfolge-Odoo-Key-Id"), headers.get("X-Zugfolge-Odoo-Timestamp"), headers.get("X-Zugfolge-Odoo-Signature")):
            return {"accepted": False, "code": "invalid_signature"}
        receipts = request.env["zugfolge.projection.receipt"].sudo().search_read([], ["message_id", "world_id", "correlation_id", "payload_hash"])
        return [{"messageId": item["message_id"], "worldId": item["world_id"], "correlationId": item["correlation_id"], "payloadHash": item["payload_hash"]} for item in receipts]
