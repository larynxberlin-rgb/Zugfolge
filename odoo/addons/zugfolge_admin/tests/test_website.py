import json

from odoo.tests import HttpCase, tagged


@tagged("post_install", "-at_install")
class TestZugfolgeWebsite(HttpCase):
    def test_public_worlds_empty_state_and_snippets_are_installed(self):
        response = self.url_open("/welten")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Noch keine Welt veröffentlicht", response.text)
        for key in (
            "zugfolge_admin.s_zugfolge_worlds", "zugfolge_admin.s_zugfolge_world_banner",
            "zugfolge_admin.s_zugfolge_live_stats", "zugfolge_admin.s_zugfolge_evu_stats",
        ):
            self.assertTrue(self.env["ir.ui.view"]._get(key))
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
