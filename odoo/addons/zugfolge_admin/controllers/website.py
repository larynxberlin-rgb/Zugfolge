import hashlib
import json
import secrets
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime

from odoo import _, http
from odoo.exceptions import UserError
from odoo.http import request
from odoo.addons.portal.controllers.portal import CustomerPortal

from ..services import game_world_origin


_BUCKET_LOCK = threading.Lock()
_BUCKET_SALT = secrets.token_bytes(32)
_BUCKETS = OrderedDict()
_RATE_WINDOW_SECONDS = 60
_RATE_LIMIT = 30
_MAX_RATE_BUCKETS = 4096


def _rate_allowed(remote_address, now=None):
    key = hashlib.sha256(_BUCKET_SALT + (remote_address or "unknown").encode()).hexdigest()
    with _BUCKET_LOCK:
        now = time.monotonic() if now is None else now
        # Neue Zeitfenster stehen hinten; abgelaufene Eintraege werden einmal
        # entfernt statt bei jeder Anfrage den gesamten Bestand zu durchsuchen.
        while _BUCKETS and now - next(iter(_BUCKETS.values()))[0] >= _RATE_WINDOW_SECONDS:
            _BUCKETS.popitem(last=False)
        if key not in _BUCKETS and len(_BUCKETS) >= _MAX_RATE_BUCKETS:
            return False
        start, count = _BUCKETS.get(key, (now, 0))
        if count >= _RATE_LIMIT:
            return False
        _BUCKETS[key] = (start, count + 1)
        return True


def _published_offers():
    offers = request.env["zugfolge.world.offer"].sudo().search([
        ("published", "=", True), ("projection_id.public_projection_version", "!=", False),
    ])
    return offers.sorted(key=lambda offer: (
        offer.projection_id.public_starts_at or datetime.max,
        (offer.projection_id.world_name or "").casefold(),
        offer.id,
    ))


def _offer_payload(offer):
    projection = offer.projection_id
    product = offer.product_tmpl_id
    return {
        "worldId": projection.world_id,
        "name": projection.world_name,
        "description": projection.public_description,
        "phase": projection.public_phase,
        "startsAt": projection.public_starts_at.isoformat() if projection.public_starts_at else None,
        "endsAt": projection.public_ends_at.isoformat() if projection.public_ends_at else None,
        "authoritativeAsOf": projection.authoritative_as_of.isoformat() if projection.authoritative_as_of else None,
        "remainingRuntimeSeconds": None if projection.unlimited_runtime else projection.remaining_runtime_seconds,
        "startingCapital": projection.starting_capital_preview,
        "totalOperators": projection.total_operators,
        "stronglyActiveOperators": projection.strongly_active_operators if projection.activity_policy_status == "configured" else None,
        "activityPolicyStatus": projection.activity_policy_status,
        "activityExplanation": projection.activity_explanation,
        "capacity": projection.public_capacity,
        "freePlaces": projection.public_free_places,
        "admissionStatus": projection.admission_status,
        "region": projection.public_region,
        "ruleRelease": projection.public_rule_release,
        "releases": projection.public_releases,
        "generatedAt": projection.public_generated_at.isoformat() if projection.public_generated_at else None,
        "stale": projection.public_is_stale(),
        "price": product.list_price if product else None,
        "currency": product.currency_id.name if product else None,
        "conditions": offer.participation_conditions,
        "banner": {
            "url512": offer.banner_url(512), "url1024": offer.banner_url(1024), "url1920": offer.banner_url(1920),
            "alt": offer.banner_alt or (projection.public_banner_metadata or {}).get("altText") or _("Banner der Welt %s") % projection.world_name,
            "attribution": offer.banner_attribution or (projection.public_banner_metadata or {}).get("attribution"),
            "source": offer.banner_source or (projection.public_banner_metadata or {}).get("source"),
            "author": offer.banner_author or (projection.public_banner_metadata or {}).get("author"),
            "license": offer.banner_license or (projection.public_banner_metadata or {}).get("license"),
            "focalXPermille": offer.focal_x_permille, "focalYPermille": offer.focal_y_permille,
        },
    }


class ZugfolgeWebsiteController(CustomerPortal):
    def _prepare_home_portal_values(self, counters):
        values = super()._prepare_home_portal_values(counters)
        if "zugfolge_world_count" in counters:
            values["zugfolge_world_count"] = request.env["zugfolge.world.participation"].search_count([
                ("partner_id", "=", request.env.user.partner_id.id),
            ])
        return values

    @http.route("/welten", type="http", auth="public", website=True, sitemap=True)
    def public_worlds(self, **_kwargs):
        return request.render("zugfolge_admin.public_worlds_page", {"offers": _published_offers()})

    @http.route("/welten/<string:world_id>", type="http", auth="public", website=True, sitemap=True)
    def public_world_detail(self, world_id, **_kwargs):
        offer = request.env["zugfolge.world.offer"].sudo().search([
            ("published", "=", True), ("projection_id.world_id", "=", world_id),
        ], limit=1)
        if not offer:
            return request.not_found()
        return request.render("zugfolge_admin.public_world_detail_page", {"offer": offer})

    @http.route("/zugfolge/public/worlds", type="http", auth="public", methods=["GET"], csrf=False)
    def public_worlds_refresh(self, **_kwargs):
        if not _rate_allowed(request.httprequest.remote_addr):
            return request.make_json_response({"error": "rate_limited"}, status=429, headers={"Retry-After": "60", "Cache-Control": "no-store"})
        selector = request.httprequest.args.get("selector", "all")
        world_id = request.httprequest.args.get("world_id")
        offers = _published_offers()
        if world_id:
            offers = offers.filtered(lambda offer: offer.projection_id.world_id == world_id)
        elif selector == "active":
            offers = offers.filtered(lambda offer: offer.projection_id.public_phase == "active")
        elif selector == "open":
            offers = offers.filtered(lambda offer: offer.projection_id.admission_status == "open")
        body = {"schemaVersion": "zugfolge-public-world-api/v1", "worlds": [_offer_payload(offer) for offer in offers]}
        raw = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        etag = '"%s"' % hashlib.sha256(raw.encode()).hexdigest()
        if request.httprequest.headers.get("If-None-Match") == etag:
            return request.make_response("", status=304, headers=[("ETag", etag), ("Cache-Control", "public, max-age=60, stale-while-revalidate=120")])
        return request.make_json_response(body, headers={"ETag": etag, "Cache-Control": "public, max-age=60, stale-while-revalidate=120"})

    @http.route("/my/worlds", type="http", auth="user", website=True)
    def portal_worlds(self, **_kwargs):
        partner = request.env.user.partner_id
        participations = request.env["zugfolge.world.participation"].search([("partner_id", "=", partner.id)])
        return request.render("zugfolge_admin.portal_worlds_page", {
            "page_name": "zugfolge_worlds", "participations": participations, "offers": _published_offers(),
        })

    @http.route("/my/worlds/<string:world_id>/join", type="http", auth="user", website=True, methods=["POST"], csrf=True)
    def portal_join_world(self, world_id, **_kwargs):
        offer = request.env["zugfolge.world.offer"].sudo().search([
            ("published", "=", True), ("projection_id.world_id", "=", world_id),
        ], limit=1)
        if not offer or offer.projection_id.admission_status not in ("open", "waitlist"):
            return request.not_found()
        partner = request.env.user.partner_id
        if not partner.zugfolge_keycloak_subject:
            return request.redirect("/my/worlds?error=verified_oidc_required")
        participation = request.env["zugfolge.world.participation"].search([
            ("partner_id", "=", partner.id), ("world_id", "=", world_id),
        ], limit=1)
        if not participation:
            request.env["zugfolge.world.participation"].sudo().create({
                "partner_id": partner.id, "offer_id": offer.id, "keycloak_subject": partner.zugfolge_keycloak_subject,
                "odoo_order_reference": ("checkout:" if offer.product_tmpl_id else "request:") + str(uuid.uuid4()),
                "payment_reference": "pending-payment" if offer.product_tmpl_id else "pending-commercial-approval",
            })
        elif participation.state == "active":
            return request.redirect("/my/worlds")
        if offer.product_tmpl_id:
            return request.redirect(offer.product_tmpl_id.website_url)
        return request.redirect("/my/worlds")

    @http.route("/my/worlds/<string:world_id>/open", type="http", auth="user", website=True)
    def portal_open_world(self, world_id, **_kwargs):
        participation = request.env["zugfolge.world.participation"].search([
            ("partner_id", "=", request.env.user.partner_id.id), ("world_id", "=", world_id), ("state", "=", "active"),
        ], limit=1)
        if not participation:
            return request.not_found()
        try:
            origin = game_world_origin(request.env, participation.world_id)
        except UserError:
            return request.make_response(_("Der Weltserver ist derzeit nicht erreichbar. Bitte versuchen Sie es spaeter erneut."),
                                         status=503, headers=[("Cache-Control", "no-store"), ("Content-Type", "text/plain; charset=utf-8")])
        # Only the trusted canonical registry may choose an external destination.
        # Odoo's default local redirect would strip its world-specific hostname.
        return request.redirect(origin + "/?world=" + participation.world_id, local=False)
