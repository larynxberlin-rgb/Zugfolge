import json

from odoo.tests import HttpCase, tagged
from odoo.tests.common import new_test_user


@tagged("post_install", "-at_install")
class TestZugfolgeWebsite(HttpCase):
    def _portal_participation(self, world_id, partner, active=True):
        projection = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).create({
            "world_id": world_id, "world_name": "Portalwelt", "projection_revision": "portal-1",
            "observed_at": "2026-09-05 10:00:00", "freshness": "live", "payload_hash": "a" * 64,
        })
        offer = self.env["zugfolge.world.offer"].create({
            "projection_id": projection.id, "participation_conditions": "Portaltest",
            "game_url_template": "https://untrusted.example.test/{world_id}",
        })
        participation = self.env["zugfolge.world.participation"]._create_from_commerce({
            "partner_id": partner.id, "offer_id": offer.id, "keycloak_subject": "portal-%s" % partner.id,
            "odoo_order_reference": "portal-order-" + world_id, "payment_reference": "portal-payment-" + world_id,
            "state": "provisioning" if active else "pending_payment",
        })
        if active:
            participation.sudo().with_context(zugfolge_game_projection=True).apply_game_result({
                "worldId": world_id, "action": "provision", "idempotencyKey": participation.idempotency_key + ":provision",
                "state": "active", "participationId": "game-" + world_id, "gameAccountReference": "account-" + world_id,
            })
        return participation

    def test_portal_opens_each_world_on_its_registered_subdomain(self):
        user = new_test_user(self.env, login="world-portal", password="portal-test", groups="base.group_portal")
        worlds = {
            "11111111-1111-4111-8111-111111111111": "https://alpha.example.test",
            "22222222-2222-4222-8222-222222222222": "https://beta.example.test",
        }
        self.env["ir.config_parameter"].sudo().set_param("zugfolge_admin.game_world_origins_json", json.dumps(worlds))
        for world_id in worlds:
            self._portal_participation(world_id, user.partner_id)
        self.authenticate(user.login, "portal-test")
        for world_id, origin in worlds.items():
            response = self.url_open("/my/worlds/%s/open" % world_id, allow_redirects=False)
            self.assertEqual(response.status_code, 303)
            self.assertEqual(response.headers["Location"], origin + "/?world=" + world_id)

    def test_portal_never_opens_foreign_pending_or_unregistered_worlds(self):
        user = new_test_user(self.env, login="restricted-portal", password="portal-test", groups="base.group_portal")
        other_partner = self.env["res.partner"].create({"name": "Anderes Portalprofil"})
        foreign = "11111111-1111-4111-8111-111111111111"
        pending = "22222222-2222-4222-8222-222222222222"
        unregistered = "33333333-3333-4333-8333-333333333333"
        self._portal_participation(foreign, other_partner)
        self._portal_participation(pending, user.partner_id, active=False)
        self._portal_participation(unregistered, user.partner_id)
        self.env["ir.config_parameter"].sudo().set_param("zugfolge_admin.game_world_origins_json", json.dumps({
            foreign: "https://alpha.example.test", pending: "https://beta.example.test",
        }))
        self.authenticate(user.login, "portal-test")
        for world_id, status in ((foreign, 404), (pending, 404), (unregistered, 503)):
            response = self.url_open("/my/worlds/%s/open" % world_id, allow_redirects=False)
            self.assertEqual(response.status_code, status)
            self.assertNotIn("Location", response.headers)

    def test_public_worlds_empty_state_and_snippets_are_installed(self):
        response = self.url_open("/welten")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Noch keine Welt veröffentlicht", response.text)
        for key in (
            "zugfolge_admin.s_zugfolge_worlds", "zugfolge_admin.s_zugfolge_world_banner",
            "zugfolge_admin.s_zugfolge_live_stats", "zugfolge_admin.s_zugfolge_evu_stats",
        ):
            self.assertTrue(self.env.ref(key, raise_if_not_found=False))
            rendered = self.env["ir.ui.view"]._render_template(key)
            if isinstance(rendered, bytes):
                rendered = rendered.decode()
            self.assertIn("data-zugfolge-worlds", rendered)

    def test_public_world_page_and_refresh_endpoint_use_projection_cache(self):
        world_id = "11111111-1111-4111-8111-111111111111"
        projection = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).create({
            "world_id": world_id,
            "world_name": "Leipzig-Halle-Erfurt",
            "projection_revision": "website-test-1",
            "observed_at": "2026-08-13 06:00:00",
            "freshness": "delayed",
            "payload_hash": "a" * 64,
            "public_projection_version": "zugfolge-public-world-snapshot/v1",
            "public_description": "Persistente Testwelt",
            "public_phase": "active",
            "public_starts_at": "2026-01-01 00:00:00",
            "authoritative_as_of": "2026-08-13 06:00:00",
            "starting_capital_mode": "finite",
            "starting_capital_amount_cents": "0",
            "starting_capital_preview": "0,00 €",
            "total_operators": 4,
            "activity_policy_status": "unconfigured",
            "public_capacity": 10,
            "public_free_places": 6,
            "admission_status": "open",
            "public_region": "Leipzig-Halle-Erfurt",
            "public_rule_release": "alpha-2026",
            "public_releases": {"infra": "a" * 64, "timetable": "b" * 64, "fleet": "c" * 64, "economy": "d" * 64},
            "public_generated_at": "2026-08-13 06:00:00",
            "public_payload_hash": "b" * 64,
        })
        self.env["zugfolge.world.offer"].create({
            "projection_id": projection.id,
            "participation_conditions": "Verifiziertes Portalprofil",
            "published": True,
        })

        page = self.url_open("/welten")
        self.assertEqual(page.status_code, 200)
        self.assertIn("Leipzig-Halle-Erfurt", page.text)
        self.assertIn("Daten möglicherweise veraltet", page.text)

        response = self.url_open("/zugfolge/public/worlds")
        self.assertEqual(response.status_code, 200)
        payload = json.loads(response.text)
        self.assertEqual(payload["worlds"][0]["worldId"], world_id)
        self.assertIsNone(payload["worlds"][0]["stronglyActiveOperators"])
        self.assertTrue(payload["worlds"][0]["stale"])
        cached = self.url_open("/zugfolge/public/worlds", headers={"If-None-Match": response.headers["ETag"]})
        self.assertEqual(cached.status_code, 304)
