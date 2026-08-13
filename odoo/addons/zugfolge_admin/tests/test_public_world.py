from datetime import datetime, timedelta, timezone

from odoo.exceptions import AccessDenied, AccessError, ValidationError
from odoo.tests.common import TransactionCase

from ..controllers.website import _rate_allowed, _BUCKETS
from ..models.res_users import validate_keycloak_identity


class TestPublicWorld(TransactionCase):
    def setUp(self):
        super().setUp()
        self.world_id = "11111111-1111-4111-8111-111111111111"
        self.projection = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).create({
            "world_id": self.world_id, "world_name": "Leipzig–Halle–Erfurt", "projection_revision": "1",
            "observed_at": "2026-01-01 00:00:00", "freshness": "delayed", "payload_hash": "a" * 64,
        })

    def snapshot(self, capital=None, strong=None, policy_status="unconfigured", generated_at="2026-08-13T06:00:00Z"):
        return {
            "schemaVersion": "zugfolge-odoo/v1", "messageId": "public-1", "messageType": "public.world.snapshot",
            "worldId": self.world_id, "occurredAt": generated_at, "correlationId": "public-world-test",
            "payload": {
                "projectionVersion": "zugfolge-public-world-snapshot/v1", "worldId": self.world_id,
                "worldName": "Leipzig–Halle–Erfurt", "shortDescription": "Persistente Welt", "phase": "active",
                "startsAt": "2026-01-01T00:00:00Z", "endsAt": None, "authoritativeAsOf": "2026-08-13T06:00:00Z",
                "remainingRuntimeSeconds": None, "startingCapitalPolicy": capital or {"mode": "finite", "amountCents": "0"},
                "totalOperators": 4, "stronglyActiveOperators": strong, "activityPolicyStatus": policy_status,
                "activityExplanation": "Nur autoritative Spielhandlungen.", "capacity": 10, "freePlaces": 6,
                "admissionStatus": "open", "region": "Leipzig–Halle–Erfurt", "ruleRelease": "alpha-2026",
                "releases": {"infra": "a" * 64, "timetable": "b" * 64, "fleet": "c" * 64, "economy": "d" * 64},
                "banner": {"altText": "Strecke", "source": "Zugfolge", "author": "Zugfolge", "license": "Eigenes Werk", "attribution": None, "focalPointXPermille": 500, "focalPointYPermille": 500, "rightsApproved": True},
                "generatedAt": generated_at,
            },
        }

    def test_snapshot_zero_positive_and_unlimited_capital(self):
        for capital, expected in [
            ({"mode": "finite", "amountCents": "0"}, "0,00 €"),
            ({"mode": "finite", "amountCents": "2500000"}, "25.000,00 €"),
            ({"mode": "unlimited"}, "Unbegrenzt (∞)"),
        ]:
            self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_public_snapshot(self.snapshot(capital=capital))
            self.assertEqual(self.projection.starting_capital_preview, expected)

    def test_unconfigured_activity_never_publishes_a_number(self):
        with self.assertRaises(ValidationError):
            self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_public_snapshot(self.snapshot(strong=1))
        self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_public_snapshot(self.snapshot(strong=2, policy_status="configured"))
        self.assertEqual(self.projection.strongly_active_operators, 2)

    def test_snapshot_rejects_inconsistent_capacity_and_runtime(self):
        inconsistent = self.snapshot()
        inconsistent["payload"]["freePlaces"] = 11
        with self.assertRaises(ValidationError):
            self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_public_snapshot(inconsistent)
        negative = self.snapshot()
        negative["payload"]["remainingRuntimeSeconds"] = -1
        with self.assertRaises(ValidationError):
            self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_public_snapshot(negative)

    def test_public_snapshot_rejects_personal_fields_and_wrong_world(self):
        unsafe = self.snapshot()
        unsafe["payload"]["playerId"] = "person-1"
        with self.assertRaises(ValidationError):
            self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_public_snapshot(unsafe)
        wrong = self.snapshot()
        wrong["payload"]["worldId"] = "22222222-2222-4222-8222-222222222222"
        with self.assertRaises(ValidationError):
            self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_public_snapshot(wrong)

    def test_missing_and_stale_snapshot_are_explicit(self):
        self.assertTrue(self.projection.public_is_stale())
        old = (datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat().replace("+00:00", "Z")
        self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_public_snapshot(self.snapshot(generated_at=old))
        self.assertTrue(self.projection.public_is_stale())

    def test_banner_fallback_rights_alt_and_focal_point(self):
        offer = self.env["zugfolge.world.offer"].create({
            "projection_id": self.projection.id, "participation_conditions": "Portalprofil und kommerzielle Freigabe.",
        })
        self.assertEqual(offer.banner_url(), "/zugfolge_admin/static/src/img/world-fallback.svg")
        with self.assertRaises(ValidationError):
            offer.write({"banner_original": b"not-an-image", "banner_alt": "", "banner_source": "Quelle", "banner_author": "Urheber", "banner_license": "Lizenz"})
        with self.assertRaises(ValidationError):
            offer.write({"focal_x_permille": 1001})

    def test_participation_is_world_bound_and_command_has_all_references(self):
        partner = self.env["res.partner"].create({"name": "Portal", "zugfolge_keycloak_subject": "kc-sub"})
        offer = self.env["zugfolge.world.offer"].create({"projection_id": self.projection.id, "participation_conditions": "Bezahlung"})
        participation = self.env["zugfolge.world.participation"].create({
            "partner_id": partner.id, "offer_id": offer.id, "keycloak_subject": "kc-sub",
            "odoo_order_reference": "SO001", "payment_reference": "PAY001", "state": "paid",
        })
        command = participation._command("provision")
        self.assertEqual(command["worldId"], self.world_id)
        self.assertEqual(command["keycloakSubject"], "kc-sub")
        self.assertEqual(command["odooPartnerReference"], str(partner.id))
        self.assertEqual(command["odooOrderReference"], "SO001")
        self.assertEqual(command["paymentReference"], "PAY001")
        self.assertTrue(command["idempotencyKey"].endswith(":provision"))
        with self.assertRaises(ValidationError):
            participation.with_context(zugfolge_game_projection=True).apply_game_result({
                "worldId": "wrong", "action": "provision", "idempotencyKey": command["idempotencyKey"], "state": "active",
            })
        with self.assertRaises(ValidationError):
            participation.with_context(zugfolge_game_projection=True).apply_game_result({
                "worldId": self.world_id, "action": "refund", "idempotencyKey": command["idempotencyKey"], "state": "refunded",
            })
        with self.assertRaises(AccessError):
            participation.apply_game_result({
                "worldId": self.world_id, "action": "provision", "idempotencyKey": command["idempotencyKey"], "state": "active",
            })
        with self.assertRaises(AccessError):
            participation.write({"keycloak_subject": "manipulated-sub"})

    def test_keycloak_requires_verified_email_and_stable_subject(self):
        with self.assertRaises(AccessDenied):
            validate_keycloak_identity({"email_verified": False, "email": "a@example.test", "sub": "kc"})
        self.assertEqual(validate_keycloak_identity({"email_verified": True, "email": "a@example.test", "sub": "kc"}), "kc")

    def test_public_refresh_rate_limit_is_bounded(self):
        _BUCKETS.clear()
        for _ in range(30):
            self.assertTrue(_rate_allowed("192.0.2.1", now=1.0))
        self.assertFalse(_rate_allowed("192.0.2.1", now=1.0))
        self.assertTrue(_rate_allowed("192.0.2.1", now=62.0))
