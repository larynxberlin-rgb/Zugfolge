from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests.common import TransactionCase

from ..models.admin_request import format_cents_german, parse_german_currency_to_cents
from ..models.admin_capability import GLOBAL_WORLD_DEPLOY_CAPABILITY_SCOPE_ID
from ..upgrade import backfill_legacy_admin_request_worlds


class TestZugfolgeAdminRequest(TransactionCase):
    def setUp(self):
        super().setUp()
        self.projection = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).create({
            "world_id": "11111111-1111-1111-1111-111111111111", "world_name": "Testwelt", "projection_revision": "1",
            "observed_at": "2026-01-01 00:00:00", "freshness": "delayed", "payload_hash": "a" * 64,
            "profile_kind": "public",
        })

    def _world_deploy_values(self, policy=None, amount_input="10.000,00"):
        policy = policy or {"mode": "finite", "amountCents": "1000000"}
        deployment_hash = "d" * 64
        return {
            "action_type": "world_deploy",
            "risk_class": "high",
            "reason": "Signierte Alpha-Welt kontrolliert bereitstellen",
            "world_id": "22222222-2222-4222-8222-222222222222",
            "world_name": "Oeffentliche Alpha-Welt",
            "world_kind": "public",
            "ranking_status": "ranked",
            "schedule_period_weeks": 4,
            "world_epoch": "2026-12-13 00:00:00",
            "starting_capital_mode": policy["mode"],
            "starting_capital_input": amount_input,
            "deployment_hash": deployment_hash,
            "signed_world_deployment": {
                "deploymentHash": deployment_hash,
                "deployment": {
                    "worldId": "22222222-2222-4222-8222-222222222222",
                    "worldDefinition": {
                        "name": "Oeffentliche Alpha-Welt",
                        "kind": "public",
                        "rankingStatus": "ranked",
                        "schedulePeriodWeeks": 4,
                        "epoch": "2026-12-13T00:00:00.000Z",
                    },
                    "blueprint": {"profileKind": "public", "startingCapitalPolicy": policy},
                },
                "signature": {
                    "algorithm": "Ed25519",
                    "keyId": "alpha-release-2026",
                    "valueBase64": "A" * 86 + "==",
                },
            },
        }

    def test_german_starting_capital_parser_is_exact_and_float_free(self):
        self.assertEqual(parse_german_currency_to_cents("10.000,00 \u20ac"), "1000000")
        self.assertEqual(parse_german_currency_to_cents("0,00"), "0")
        self.assertEqual(format_cents_german("1000000"), "10.000,00 \u20ac")
        for invalid in ("-1,00", "1e3", "1.000,001", "\u221e", "1.00"):
            with self.assertRaises(ValidationError):
                parse_german_currency_to_cents(invalid)

    def test_world_deploy_without_projection_serializes_finite_policy_and_world_definition(self):
        self.env["zugfolge.admin.capability"].with_context(zugfolge_game_projection=True).create({
            "world_id": GLOBAL_WORLD_DEPLOY_CAPABILITY_SCOPE_ID,
            "action_type": "world_deploy",
            "availability": "available",
            "observed_at": "2026-01-01 00:00:00",
            "payload_hash": "f" * 64,
        })
        request = self.env["zugfolge.admin.request"].create(self._world_deploy_values())
        self.assertFalse(request.world_projection_id)
        self.assertEqual(request.game_capability_state, "available")
        self.assertEqual(request.starting_capital_amount_cents, "1000000")
        self.assertEqual(request.starting_capital_preview, "10.000,00 \u20ac")
        payload = request._game_command_payload()
        self.assertEqual(payload["kind"], "admin.world_deploy")
        self.assertEqual(payload["startingCapitalPolicy"], {"mode": "finite", "amountCents": "1000000"})
        self.assertEqual(payload["worldDefinition"]["kind"], "public")
        self.assertEqual(payload["signedDeployment"]["deploymentHash"], "d" * 64)

    def test_world_deploy_draft_exports_configuration_before_external_signature(self):
        values = self._world_deploy_values()
        values.pop("signed_world_deployment")
        values.pop("deployment_hash")
        request = self.env["zugfolge.admin.request"].create(values)
        self.assertEqual(request.signing_configuration["startingCapitalPolicy"], {"mode": "finite", "amountCents": "1000000"})
        self.assertEqual(request.signing_configuration["worldDefinition"]["epoch"], "2026-12-13T00:00:00Z")
        with self.assertRaises(ValidationError):
            request.action_submit()

    def test_public_world_deploy_draft_defaults_to_zero_starting_capital(self):
        values = self._world_deploy_values()
        values.pop("signed_world_deployment")
        values.pop("deployment_hash")
        values.pop("starting_capital_mode")
        values.pop("starting_capital_input")
        request = self.env["zugfolge.admin.request"].create(values)

        self.assertEqual(request.starting_capital_mode, "finite")
        self.assertEqual(request.starting_capital_input, "0,00")
        self.assertEqual(request.starting_capital_amount_cents, "0")
        self.assertEqual(request.starting_capital_preview, "0,00 \u20ac")
        self.assertEqual(request.signing_configuration["startingCapitalPolicy"], {
            "mode": "finite",
            "amountCents": "0",
        })

    def test_world_deploy_unlimited_is_a_mode_without_numeric_amount(self):
        values = self._world_deploy_values({"mode": "unlimited"})
        request = self.env["zugfolge.admin.request"].create(values)
        self.assertFalse(request.starting_capital_amount_cents)
        self.assertEqual(request.starting_capital_preview, "\u221e")
        self.assertEqual(request._game_command_payload()["startingCapitalPolicy"], {"mode": "unlimited"})

    def test_world_deploy_rejects_invalid_or_divergent_policy(self):
        with self.assertRaises(ValidationError):
            self.env["zugfolge.admin.request"].create(self._world_deploy_values(amount_input="-1,00"))
        values = self._world_deploy_values()
        values["signed_world_deployment"]["deployment"]["blueprint"]["startingCapitalPolicy"] = {"mode": "finite", "amountCents": "0"}
        with self.assertRaises(ValidationError):
            self.env["zugfolge.admin.request"].create(values)
        profile_values = self._world_deploy_values()
        profile_values.update({"world_kind": "tutorial", "ranking_status": "unranked"})
        with self.assertRaises(ValidationError):
            self.env["zugfolge.admin.request"].create(profile_values)

    def test_world_deploy_fields_are_immutable_after_submit(self):
        request = self.env["zugfolge.admin.request"].create(self._world_deploy_values())
        request.action_submit()
        with self.assertRaises(UserError):
            request.write({"starting_capital_input": "0,00"})
        with self.assertRaises(UserError):
            request.write({"signed_world_deployment": {}})

    def test_world_deploy_keeps_full_authoritative_game_result(self):
        request = self.env["zugfolge.admin.request"].create(self._world_deploy_values())
        request.with_context(zugfolge_game_projection=True).apply_game_result({
            "state": "completed",
            "gameAuditEventId": "world-deploy-audit-1",
            "deploymentHash": "d" * 64,
            "blueprintHash": "b" * 64,
            "startingCapitalPolicy": {"mode": "finite", "amountCents": "1000000"},
        })
        self.assertEqual(request.game_result["deploymentHash"], "d" * 64)
        self.assertEqual(request.game_result["startingCapitalPolicy"]["amountCents"], "1000000")

    def test_upgrade_backfills_legacy_world_binding_idempotently_without_touching_deploy_draft(self):
        tutorial_projection = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).create({
            "world_id": "33333333-3333-4333-8333-333333333333",
            "world_name": "Legacy-Tutorial",
            "projection_revision": "legacy-1",
            "observed_at": "2026-01-01 00:00:00",
            "freshness": "delayed",
            "simulation_time": "2026-01-01 00:01:40",
            "payload_hash": "b" * 64,
            "profile_kind": "tutorial",
            "telemetry": {"world": {"schedulePeriodWeeks": 6, "simulationTimeS": 100}},
        })
        legacy_request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": tutorial_projection.id,
            "action_type": "tutorial_account_reset",
            "risk_class": "standard",
            "reason": "Vor 19.0.1.4.0 angelegter Tutorial-Reset",
            "effect_preview": {"kind": "tutorial-reset"},
            "target_reference": "legacy-account",
            "requested_at_s": 100,
        })
        deploy_request = self.env["zugfolge.admin.request"].create(self._world_deploy_values())
        deploy_snapshot = {
            "world_id": deploy_request.world_id,
            "world_name": deploy_request.world_name,
            "world_kind": deploy_request.world_kind,
            "ranking_status": deploy_request.ranking_status,
            "signed_world_deployment": deploy_request.signed_world_deployment,
        }

        self.env.cr.execute(
            """
                UPDATE zugfolge_admin_request
                   SET world_id = NULL,
                       world_name = NULL,
                       world_kind = NULL,
                       ranking_status = NULL,
                       schedule_period_weeks = 4,
                       world_epoch = NULL
                 WHERE id = %s
            """,
            [legacy_request.id],
        )
        self.env.invalidate_all()

        self.assertEqual(backfill_legacy_admin_request_worlds(self.env.cr), 1)
        self.env.invalidate_all()
        legacy_request = self.env["zugfolge.admin.request"].browse(legacy_request.id)
        deploy_request = self.env["zugfolge.admin.request"].browse(deploy_request.id)
        self.assertEqual(legacy_request.world_id, tutorial_projection.world_id)
        self.assertEqual(legacy_request.world_name, tutorial_projection.world_name)
        self.assertEqual(legacy_request.world_kind, "tutorial")
        self.assertEqual(legacy_request.ranking_status, "unranked")
        self.assertEqual(legacy_request.schedule_period_weeks, 6)
        self.assertEqual(str(legacy_request.world_epoch), "2026-01-01 00:00:00")
        self.assertEqual(
            {
                "world_id": deploy_request.world_id,
                "world_name": deploy_request.world_name,
                "world_kind": deploy_request.world_kind,
                "ranking_status": deploy_request.ranking_status,
                "signed_world_deployment": deploy_request.signed_world_deployment,
            },
            deploy_snapshot,
        )

        self.assertEqual(backfill_legacy_admin_request_worlds(self.env.cr), 0)
        legacy_request.action_submit()
        self.assertEqual(legacy_request.state, "submitted")

    def test_projection_is_not_writable_by_staff(self):
        with self.assertRaises(AccessError):
            self.projection.with_context(zugfolge_game_projection=False).write({"world_name": "Manipuliert"})

    def test_high_risk_request_rejects_self_approval(self):
        request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.projection.id, "action_type": "infra_release_adoption", "risk_class": "high",
            "reason": "Nachweis", "effect_preview": {"kind": "infra-release", "releaseHash": "a" * 64}, "release_hash": "a" * 64,
            "requested_period_start": "2026-02-01 00:00:00",
        })
        request.action_submit()
        with self.assertRaises(AccessError):
            request.action_approve()

    def test_reason_is_mandatory(self):
        with self.assertRaises(ValidationError):
            self.env["zugfolge.admin.request"].create({
                "world_projection_id": self.projection.id, "action_type": "world_access_revoke", "reason": " ",
                "effect_preview": {"kind": "world-access-revoke"},
            })

    def test_world_access_revoke_requires_stable_target(self):
        with self.assertRaises(ValidationError):
            self.env["zugfolge.admin.request"].create({
                "world_projection_id": self.projection.id, "action_type": "world_access_revoke",
                "reason": "Bestaetigter Supportfall", "effect_preview": {"kind": "world-access-revoke"},
            })

    def test_invitation_revoke_creates_high_risk_request_instead_of_direct_command(self):
        invitation = self.env["zugfolge.alpha.invitation"].create({
            "email": "alpha@example.test", "display_name": "Alpha", "world_projection_id": self.projection.id,
            "role": "player", "keycloak_subject": "kc-alpha", "game_account_reference": "account-alpha", "state": "provisioned",
        })
        action = invitation.action_revoke()
        request = self.env["zugfolge.admin.request"].browse(action["res_id"])
        self.assertEqual(request.action_type, "world_access_revoke")
        self.assertEqual(request.risk_class, "high")
        self.assertEqual(request.target_reference, "kc-alpha")
        self.assertEqual(invitation.state, "revocation_requested")

    def test_pseudonymized_feedback_projection_is_immutable_but_triageable(self):
        feedback = self.env["zugfolge.feedback"].with_context(zugfolge_game_projection=True).upsert_game_projection({
            "messageId": "feedback-message-1", "messageType": "alpha.feedback.projection",
            "worldId": self.projection.world_id, "occurredAt": "2026-01-01 00:05:00",
            "payload": {
                "feedbackReference": "feedback-1", "participantPseudonym": "a" * 64,
                "releaseHash": "b" * 64, "fromS": 10, "untilS": 20, "category": "usability",
                "message": "Die Warteschlange ist schwer verstaendlich.", "contactAllowed": False,
            },
        })
        self.assertEqual(feedback.participant_pseudonym, "a" * 64)
        self.assertNotIn("@", feedback.participant_pseudonym)
        self.assertFalse(feedback.env.context.get("zugfolge_game_projection"))
        with self.assertRaises(AccessError):
            feedback.write({"body": "Manipuliert"})
        feedback.write({"triage_state": "triaged"})
        self.assertEqual(feedback.triage_state, "triaged")
        replay = self.env["zugfolge.feedback"].with_context(zugfolge_game_projection=True).upsert_game_projection({
            "messageId": "feedback-message-1-replay", "messageType": "alpha.feedback.projection",
            "worldId": self.projection.world_id, "occurredAt": "2026-01-01 00:05:00",
            "payload": {
                "feedbackReference": "feedback-1", "participantPseudonym": "a" * 64,
                "releaseHash": "b" * 64, "fromS": 10, "untilS": 20, "category": "usability",
                "message": "Die Warteschlange ist schwer verstaendlich.", "contactAllowed": False,
            },
        })
        self.assertEqual(replay, feedback)
        self.assertFalse(replay.env.context.get("zugfolge_game_projection"))

    def test_monitoring_projection_extracts_live_queue_market_and_release_fields(self):
        projected = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_game_projection({
            "messageId": "projection-2", "worldId": self.projection.world_id,
            "occurredAt": "2026-01-01 00:01:00",
            "payload": {
                "worldName": "Testwelt", "projectionRevision": "2", "freshness": "delayed",
                "runtimeStatus": "healthy: aktuell", "workerStatus": "healthy: bereit",
                "infraReleaseHash": "a" * 64, "economyReleaseHash": "b" * 64,
                "telemetry": {
                    "world": {"releases": {"timetable": "c" * 64, "fleet": "d" * 64}},
                    "live": {"runningTrains": 42, "delayedTrains": 3, "cancelledTrains": 1, "disruptions": 2, "replacementConcepts": 1, "eventRatePerMinute": 19},
                    "operationShares": {"publicLots": 7, "playerLots": 4},
                    "workers": {"planningQueueDepth": 2, "economyOutboxDepth": 3, "odooCommandQueue": {"pending": 1}},
                    "bridges": {"odooProjection": {"pending": 1}, "provider": [{"status": "healthy"}], "reconciliation": {"open": 0}},
                    "economy": {"conflicts": 1, "capacityBottlenecks": 2, "penaltiesAndDeductions": 3, "anomalies": 4},
                    "market": {"listings": {"open": 5}, "contracts": {"traction:active": 1}},
                    "freshness": {"eventAgeSeconds": 4, "projectionAgeSeconds": 7},
                    "drillDown": {"latestAuthoritativeEvents": [{"sequence": 8}]},
                },
            },
        })
        self.assertEqual(projected.running_trains, 42)
        self.assertEqual(projected.market_activity["listings"]["open"], 5)
        self.assertEqual(projected.timetable_release_hash, "c" * 64)
        self.assertEqual(projected.event_age_seconds, 4)

    def test_projected_starting_capital_and_deployment_hash_are_readonly_and_immutable(self):
        projected = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_game_projection({
            "messageId": "projection-capital-1", "worldId": self.projection.world_id,
            "occurredAt": "2026-01-01 00:01:00",
            "payload": {
                "worldName": "Testwelt", "projectionRevision": "capital-1", "freshness": "delayed",
                "profileKind": "public", "blueprintHash": "b" * 64, "deploymentHash": "d" * 64,
                "startingCapitalPolicy": {"mode": "finite", "amountCents": "1000000"},
            },
        })
        self.assertEqual(projected.starting_capital_preview, "10.000,00 \u20ac")
        self.assertEqual(projected.deployment_hash, "d" * 64)
        with self.assertRaises(ValidationError):
            projected.with_context(zugfolge_game_projection=True).write({"deployment_hash": "e" * 64})
        with self.assertRaises(ValidationError):
            self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_game_projection({
                "messageId": "projection-capital-2", "worldId": self.projection.world_id,
                "occurredAt": "2026-01-01 00:02:00",
                "payload": {
                    "worldName": "Testwelt", "projectionRevision": "capital-2", "freshness": "delayed",
                    "profileKind": "public", "blueprintHash": "b" * 64, "deploymentHash": "d" * 64,
                    "startingCapitalPolicy": {"mode": "finite", "amountCents": "0"},
                },
            })

    def test_manual_disruption_is_prepared_but_cannot_dispatch_before_m8_capability(self):
        request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.projection.id, "action_type": "manual_disruption_create", "risk_class": "high",
            "reason": "Gemaess manueller Meldung", "effect_preview": {"note": "Game prueft Auswirkungen"},
            "manual_disruption_start": "2026-02-01 10:00:00", "manual_disruption_end": "2026-02-01 12:00:00",
            "manual_disruption_cause": "Weichenstoerung", "manual_disruption_resource_ids": ["switch:test:1"],
            "manual_disruption_effect": {"kind": "closure"},
        })
        self.assertEqual(request.game_capability_state, "prepared")
        request.with_context(zugfolge_game_projection=True).write({"state": "approved"})
        with self.assertRaises(UserError):
            request.action_dispatch()

    def test_capability_projection_cannot_be_created_by_staff(self):
        with self.assertRaises(AccessError):
            self.env["zugfolge.admin.capability"].create({
                "world_id": self.projection.world_id, "action_type": "manual_disruption_create", "availability": "available",
                "observed_at": "2026-01-01 00:00:00", "payload_hash": "a" * 64,
            })

    def test_invoice_without_product_mapping_emits_no_entitlement(self):
        invoice = self.env["account.move"].new({"move_type": "out_invoice", "zugfolge_subject_reference": "subject"})
        self.assertFalse(invoice._zugfolge_command_change())
