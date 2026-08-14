from datetime import datetime, timedelta, timezone

from odoo.exceptions import AccessDenied, AccessError, ValidationError
from odoo.tests.common import TransactionCase

from ..controllers.website import _rate_allowed, _BUCKETS
from ..models.rfc3339 import rfc3339_utc
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

    def test_integration_timestamps_are_normalized_to_naive_utc(self):
        self.assertEqual(
            rfc3339_utc("2026-01-01T01:00:00.000+01:00", "occurredAt"),
            datetime(2026, 1, 1, 0, 0, 0),
        )
        self.assertFalse(rfc3339_utc(None, "simulationTime", required=False))
        for invalid in (None, "2026-01-01 00:00:00", "2026-01-01T00:00:00", "2026-02-30T00:00:00Z"):
            with self.assertRaises(ValidationError):
                rfc3339_utc(invalid, "occurredAt")

    def test_snapshot_zero_positive_and_unlimited_capital(self):
        for index, (capital, expected) in enumerate([
            ({"mode": "finite", "amountCents": "0"}, "0,00 €"),
            ({"mode": "finite", "amountCents": "2500000"}, "25.000,00 €"),
            ({"mode": "unlimited"}, "∞"),
        ]):
            world_id = "11111111-1111-4111-8111-%012d" % (111111111111 + index)
            if index == 0:
                projection = self.projection
            else:
                projection = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).create({
                    "world_id": world_id, "world_name": "Kapitalwelt %s" % index, "projection_revision": "1",
                    "observed_at": "2026-01-01 00:00:00", "freshness": "delayed", "payload_hash": str(index) * 64,
                })
            snapshot = self.snapshot(capital=capital)
            snapshot["worldId"] = world_id
            snapshot["payload"]["worldId"] = world_id
            self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_public_snapshot(snapshot)
            self.assertEqual(projection.starting_capital_preview, expected)

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
            offer.write({
                "banner_original": b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                "banner_alt": "", "banner_source": "Quelle", "banner_author": "Urheber", "banner_license": "Lizenz",
            })
        with self.assertRaises(ValidationError):
            offer.write({"focal_x_permille": 1001})

    def test_paid_world_offer_requires_exact_world_slot_product_kind(self):
        wrong_product = self.env["product.template"].create({
            "name": "Falsches Weltprodukt",
            "zugfolge_product_kind": "cosmetic",
        })
        with self.assertRaises(ValidationError):
            self.env["zugfolge.world.offer"].create({
                "projection_id": self.projection.id,
                "participation_conditions": "Bezahlte Teilnahme",
                "product_tmpl_id": wrong_product.id,
            })
        world_product = self.env["product.template"].create({
            "name": "Konkreter Weltplatz",
            "zugfolge_product_kind": "public_world_slot",
        })
        self.env["zugfolge.world.offer"].create({
            "projection_id": self.projection.id,
            "participation_conditions": "Bezahlte Teilnahme",
            "product_tmpl_id": world_product.id,
        })
        with self.assertRaises(ValidationError):
            world_product.write({"zugfolge_product_kind": "cosmetic"})

    def test_participation_is_world_bound_and_command_has_all_references(self):
        partner = self.env["res.partner"].create({"name": "Portal"})
        partner._bind_zugfolge_keycloak_subject("kc-sub")
        offer = self.env["zugfolge.world.offer"].create({"projection_id": self.projection.id, "participation_conditions": "Bezahlung"})
        with self.assertRaises(AccessError):
            self.env["zugfolge.world.participation"].create({
                "partner_id": partner.id, "offer_id": offer.id, "keycloak_subject": "kc-sub",
                "odoo_order_reference": "SO-FORGED", "payment_reference": "PAY-FORGED", "state": "active",
            })
        participation = self.env["zugfolge.world.participation"]._create_from_commerce({
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
            participation.sudo().with_context(zugfolge_game_projection=True).apply_game_result({
                "worldId": "wrong", "action": "provision", "idempotencyKey": command["idempotencyKey"], "state": "active",
            })
        with self.assertRaises(ValidationError):
            participation.sudo().with_context(zugfolge_game_projection=True).apply_game_result({
                "worldId": self.world_id, "action": "refund", "idempotencyKey": command["idempotencyKey"], "state": "refunded",
            })
        with self.assertRaises(AccessError):
            participation.apply_game_result({
                "worldId": self.world_id, "action": "provision", "idempotencyKey": command["idempotencyKey"], "state": "active",
            })
        with self.assertRaises(AccessError):
            participation.write({"keycloak_subject": "manipulated-sub"})
        with self.assertRaises(AccessError):
            participation.with_context(zugfolge_game_projection=True, zugfolge_commerce_transition=True).write({"state": "active"})
        participation._write_from_commerce({"state": "provisioning"})
        with self.assertRaises(ValidationError):
            participation.sudo().with_context(zugfolge_game_projection=True).apply_game_result({
                "worldId": self.world_id, "action": "provision", "idempotencyKey": command["idempotencyKey"], "state": "refunded",
            })
        participation.sudo().with_context(zugfolge_game_projection=True).apply_game_result({
            "worldId": self.world_id, "action": "provision", "idempotencyKey": command["idempotencyKey"], "state": "active",
            "participationId": "game-participation-1", "gameAccountReference": "game-account-1",
        })
        self.assertEqual(participation.state, "active")
        self.assertEqual(participation.game_participation_reference, "game-participation-1")

    def test_keycloak_subject_can_only_be_bound_by_verified_oidc_path(self):
        with self.assertRaises(AccessError):
            self.env["res.partner"].create({"name": "Manipuliert", "zugfolge_keycloak_subject": "forged-sub"})
        partner = self.env["res.partner"].create({"name": "OIDC Portal"})
        with self.assertRaises(AccessError):
            partner.write({"zugfolge_keycloak_subject": "forged-sub"})
        partner._bind_zugfolge_keycloak_subject("verified-sub")
        self.assertEqual(partner.zugfolge_keycloak_subject, "verified-sub")
        with self.assertRaises(AccessDenied):
            partner._bind_zugfolge_keycloak_subject("different-sub")

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
