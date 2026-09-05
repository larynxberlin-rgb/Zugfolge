import json
from unittest.mock import Mock, patch

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase

from ..services import dispatch_signed_game_command, game_command_targets


WORLD_A = "11111111-1111-4111-8111-111111111111"
WORLD_B = "22222222-2222-4222-8222-222222222222"


class TestWorldServerRouting(TransactionCase):
    def setUp(self):
        super().setUp()
        self.params = self.env["ir.config_parameter"].sudo()
        self.params.set_param("zugfolge_admin.game_world_origins_json", json.dumps({
            WORLD_A: "https://alpha.example.test", WORLD_B: "https://beta.example.test",
        }))

    def test_world_commands_route_to_exact_canonical_host(self):
        for world_id, host in ((WORLD_A, "alpha"), (WORLD_B, "beta")):
            self.assertEqual(game_command_targets(self.env, {"kind": "world.participation.change", "worldId": world_id}), [
                "https://%s.example.test/api/integrations/odoo/webhooks" % host,
            ])
        with self.assertRaises(UserError):
            game_command_targets(self.env, {"kind": "admin.world_deploy", "worldId": "33333333-3333-4333-8333-333333333333"})

    def test_pre_world_capabilities_remain_bound_to_their_individual_target_server(self):
        capabilities = self.env["zugfolge.admin.capability"].sudo().with_context(zugfolge_game_projection=True)
        for world_id, availability in ((WORLD_A, "available"), (WORLD_B, "unavailable")):
            capabilities.upsert_game_projection({
                "worldId": "00000000-0000-0000-0000-000000000000", "occurredAt": "2026-09-05T10:00:00Z",
                "payload": {"actionType": "world_deploy", "availability": availability, "targetWorldId": world_id},
            })
        self.assertEqual(capabilities.search([("world_id", "=", WORLD_A), ("action_type", "=", "world_deploy")]).availability, "available")
        self.assertEqual(capabilities.search([("world_id", "=", WORLD_B), ("action_type", "=", "world_deploy")]).availability, "unavailable")

    def test_global_entitlements_fan_out_with_stable_event_and_no_redirect(self):
        for key, value in {"tenant_id": "commercial-tenant", "webhook_key_id": "key-2026", "webhook_secret": "test-secret"}.items():
            self.params.set_param("zugfolge_admin." + key, value)
        response = Mock(status_code=202)
        response.json.return_value = {"accepted": True}
        with patch("odoo.addons.zugfolge_admin.services.requests.post", return_value=response) as post:
            dispatch_signed_game_command(self.env, "invoice-42-grant", "commerce-service", {"kind": "entitlement.change"})
        self.assertEqual(post.call_count, 2)
        self.assertEqual([call.args[0] for call in post.call_args_list], [
            "https://alpha.example.test/api/integrations/odoo/webhooks",
            "https://beta.example.test/api/integrations/odoo/webhooks",
        ])
        self.assertEqual(post.call_args_list[0].kwargs["json"], post.call_args_list[1].kwargs["json"])
        self.assertTrue(all(call.kwargs["allow_redirects"] is False for call in post.call_args_list))

    def test_absent_or_ambiguous_mapping_never_falls_back_to_global_url(self):
        self.params.set_param("zugfolge_admin.game_webhook_url", "https://wrong.example.test/api/integrations/odoo/webhooks")
        for mapping in ({}, {WORLD_A: "http://alpha.example.test"}, {WORLD_A: "https://alpha.example.test/path"},
                        {WORLD_A: "https://ALPHA.example.test"}, {WORLD_A: "https://alpha.example.test:443"},
                        {WORLD_A: "https://user:secret@alpha.example.test"},
                        {WORLD_A: "https://alpha.example.test", WORLD_B: "https://alpha.example.test"}):
            self.params.set_param("zugfolge_admin.game_world_origins_json", json.dumps(mapping))
            with self.assertRaises(UserError):
                game_command_targets(self.env, {"kind": "world.participation.change", "worldId": WORLD_A})
