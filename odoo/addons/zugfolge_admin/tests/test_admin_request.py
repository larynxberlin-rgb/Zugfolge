from odoo import Command
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests.common import TransactionCase

from ..controllers.main import (
    GLOBAL_ADMIN_PROJECTION_SCOPE_ID,
    _admin_result_target_world_id,
    _find_admin_request_for_game_result,
)
from ..models.admin_request import format_cents_german, parse_german_currency_to_cents
from ..models.admin_capability import GLOBAL_WORLD_DEPLOY_CAPABILITY_SCOPE_ID
from ..upgrade import backfill_legacy_admin_request_worlds, backfill_legacy_deployment_audit


class TestZugfolgeAdminRequest(TransactionCase):
    def setUp(self):
        super().setUp()
        self.projection = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).create({
            "world_id": "11111111-1111-1111-1111-111111111111", "world_name": "Testwelt", "projection_revision": "1",
            "observed_at": "2026-01-01 00:00:00", "freshness": "delayed", "payload_hash": "a" * 64,
            "profile_kind": "public",
        })

    def test_global_world_close_result_resolves_only_its_typed_target_world(self):
        target_world_id = self.projection.world_id
        payload = {
            "worldId": GLOBAL_ADMIN_PROJECTION_SCOPE_ID,
            "payload": {
                "projectionScope": "global-admin",
                "actionType": "world_close",
                "targetWorldId": target_world_id,
                "outcome": "accepted",
                "state": "completed",
                "authoritative": True,
                "adminRequestId": "request-1",
                "gameAuditEventId": "audit-1",
                "eventId": "event-1",
                "finalStateHash": "a" * 64,
                "evidenceHash": "b" * 64,
                "replayHash": "c" * 64,
                "archivedAtS": 2419200,
            },
        }
        self.assertEqual(_admin_result_target_world_id(payload), target_world_id)
        self.assertFalse(_admin_result_target_world_id({
            **payload,
            "worldId": target_world_id,
        }))
        self.assertFalse(_admin_result_target_world_id({
            **payload,
            "payload": {**payload["payload"], "actionType": "world_access_revoke"},
        }))
        for invalid_result in (
            {key: value for key, value in payload["payload"].items() if key != "evidenceHash"},
            {**payload["payload"], "replayHash": "not-a-sha256"},
            {**payload["payload"], "archivedAtS": "2419200"},
            {**payload["payload"], "archivedAtS": True},
        ):
            self.assertFalse(_admin_result_target_world_id({
                **payload,
                "payload": invalid_result,
            }))

    def _authoritative_world_start_projection(self, world_id, deployment_hash, revision, message_id, blueprint_hash=None):
        blueprint_hash = blueprint_hash or ("b" * 64)
        return {
            "schemaVersion": "zugfolge-odoo/v1",
            "messageId": message_id,
            "messageType": "world.projection",
            "worldId": world_id,
            "correlationId": "world-start:%s:%s" % (world_id, revision),
            "occurredAt": "2026-01-01T00:%02d:00Z" % revision,
            "payload": {
                "worldName": "Testwelt",
                "projectionRevision": deployment_hash,
                "projectionKind": "zugfolge-authoritative-world-start-projection/v1",
                "authoritative": True,
                "freshness": "live",
                "profileKind": "public",
                "blueprintHash": blueprint_hash,
                "deploymentHash": deployment_hash,
                "deploymentRevision": revision,
                "startingCapitalPolicy": {"mode": "finite", "amountCents": "1000000"},
                "deploymentAuthorization": {
                    "schemaVersion": "zugfolge-authoritative-world-start-projection/v1",
                    "deploymentHash": deployment_hash,
                    "deploymentRevision": revision,
                    "algorithm": "Ed25519",
                    "keyId": "alpha-release-2026",
                    "valueBase64": "A" * 86 + "==",
                },
            },
        }

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
            "world_epoch": "2026-12-14 00:00:00",
            "starting_capital_mode": policy["mode"],
            "starting_capital_input": amount_input,
            "deployment_hash": deployment_hash,
            "deployment_revision": 1,
            "signed_world_deployment": {
                "deploymentHash": deployment_hash,
                "deployment": {
                    "worldId": "22222222-2222-4222-8222-222222222222",
                    "deploymentRevision": 1,
                    "worldDefinition": {
                        "name": "Oeffentliche Alpha-Welt",
                        "kind": "public",
                        "rankingStatus": "ranked",
                        "schedulePeriodWeeks": 4,
                        "epoch": "2026-12-14T00:00:00.000Z",
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
            "world_id": self._world_deploy_values()["world_id"],
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
        self.assertEqual(payload["deploymentRevision"], 1)

    def test_world_deploy_capability_of_another_server_or_legacy_global_scope_is_not_authority(self):
        capabilities = self.env["zugfolge.admin.capability"].with_context(zugfolge_game_projection=True)
        base = {"action_type": "world_deploy", "availability": "available", "observed_at": "2026-01-01 00:00:00", "payload_hash": "a" * 64}
        capabilities.create({**base, "world_id": GLOBAL_WORLD_DEPLOY_CAPABILITY_SCOPE_ID})
        capabilities.create({**base, "world_id": "99999999-9999-4999-8999-999999999999"})
        request = self.env["zugfolge.admin.request"].create(self._world_deploy_values())
        self.assertEqual(request.game_capability_state, "prepared")
        capabilities.create({**base, "world_id": request.world_id})
        request._compute_game_capability()
        self.assertEqual(request.game_capability_state, "available")

    def test_world_deploy_draft_exports_configuration_before_external_signature(self):
        values = self._world_deploy_values()
        values.pop("signed_world_deployment")
        values.pop("deployment_hash")
        request = self.env["zugfolge.admin.request"].create(values)
        self.assertEqual(request.signing_configuration["startingCapitalPolicy"], {"mode": "finite", "amountCents": "1000000"})
        self.assertEqual(request.signing_configuration["deploymentRevision"], 1)
        self.assertEqual(request.signing_configuration["worldDefinition"]["epoch"], "2026-12-14T00:00:00Z")
        with self.assertRaises(ValidationError):
            request.action_submit()

    def test_world_deploy_rejects_epoch_outside_monday_midnight_utc(self):
        for invalid_epoch in ("2026-12-13 00:00:00", "2026-12-14 00:00:01"):
            values = self._world_deploy_values()
            values["world_epoch"] = invalid_epoch
            with self.assertRaisesRegex(ValidationError, "Montag um 00:00:00 UTC"):
                self.env["zugfolge.admin.request"].create(values)

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
        profile_values.update({"world_kind": "private", "ranking_status": "unranked"})
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
        request._write_controlled({"state": "dispatched"})
        request.sudo().with_context(zugfolge_game_projection=True).apply_game_result({
            "state": "completed",
            "gameAuditEventId": "world-deploy-audit-1",
            "deploymentHash": "d" * 64,
            "blueprintHash": "b" * 64,
            "startingCapitalPolicy": {"mode": "finite", "amountCents": "1000000"},
        })
        self.assertEqual(request.game_result["deploymentHash"], "d" * 64)
        self.assertEqual(request.game_result["startingCapitalPolicy"]["amountCents"], "1000000")

    def test_upgrade_backfills_legacy_world_binding_idempotently_without_touching_deploy_draft(self):
        legacy_projection = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).create({
            "world_id": "33333333-3333-4333-8333-333333333333",
            "world_name": "Bestandswelt",
            "projection_revision": "legacy-1",
            "observed_at": "2026-01-01 00:00:00",
            "freshness": "delayed",
            "simulation_time": "2026-01-01 00:01:40",
            "payload_hash": "b" * 64,
            "profile_kind": "private",
            "telemetry": {"world": {"schedulePeriodWeeks": 6, "simulationTimeS": 100}},
        })
        legacy_request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": legacy_projection.id,
            "action_type": "world_access_revoke",
            "risk_class": "high",
            "reason": "Vor 19.0.1.4.0 angelegter Zugriffsentzug",
            "effect_preview": {"kind": "world-access-revoke"},
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
        self.assertEqual(legacy_request.world_id, legacy_projection.world_id)
        self.assertEqual(legacy_request.world_name, legacy_projection.world_name)
        self.assertEqual(legacy_request.world_kind, "private")
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

    def test_request_state_and_submitted_decision_fields_cannot_be_changed_over_rpc(self):
        with self.assertRaises(AccessError):
            self.env["zugfolge.admin.request"].create({
                "world_projection_id": self.projection.id,
                "action_type": "world_access_revoke",
                "risk_class": "high",
                "reason": "Manipulierter Direktzustand",
                "effect_preview": {"kind": "world-access-revoke"},
                "target_reference": "stable-subject",
                "state": "approved",
            })
        request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.projection.id,
            "action_type": "world_access_revoke",
            "risk_class": "high",
            "reason": "Nachgewiesener Entzug",
            "effect_preview": {"kind": "world-access-revoke"},
            "target_reference": "stable-subject",
        })
        with self.assertRaises(AccessError):
            request.with_context(zugfolge_admin_request_write_token=True).write({"state": "approved"})
        request.action_submit()
        for values in (
            {"action_type": "world_close"},
            {"risk_class": "standard"},
            {"reason": "Nachtraeglich veraendert"},
            {"target_reference": "anderes-subject"},
        ):
            with self.assertRaises(UserError):
                request.write(values)

    def test_request_correlation_is_server_generated_unique_and_world_bound(self):
        forged = "shared-attacker-controlled-correlation"
        first = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.projection.id,
            "action_type": "world_access_revoke",
            "risk_class": "high",
            "reason": "Erster nachgewiesener Entzug",
            "effect_preview": {"kind": "world-access-revoke"},
            "target_reference": "first-subject",
            "correlation_id": forged,
        })
        second = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.projection.id,
            "action_type": "world_access_revoke",
            "risk_class": "high",
            "reason": "Zweiter nachgewiesener Entzug",
            "effect_preview": {"kind": "world-access-revoke"},
            "target_reference": "second-subject",
            "correlation_id": forged,
        })

        self.assertNotEqual(first.correlation_id, forged)
        self.assertNotEqual(second.correlation_id, forged)
        self.assertNotEqual(first.correlation_id, second.correlation_id)
        with self.assertRaises(AccessError):
            first.write({"correlation_id": second.correlation_id})
        self.env.cr.execute(
            """
                SELECT COUNT(*)
                  FROM pg_constraint
                 WHERE conrelid = 'zugfolge_admin_request'::regclass
                   AND contype = 'u'
                   AND pg_get_constraintdef(oid) = 'UNIQUE (correlation_id)'
            """
        )
        self.assertEqual(self.env.cr.fetchone()[0], 1)
        self.assertEqual(
            _find_admin_request_for_game_result(
                self.env,
                first.correlation_id,
                self.projection.world_id,
            ),
            first,
        )
        self.assertFalse(_find_admin_request_for_game_result(
            self.env,
            first.correlation_id,
            "99999999-9999-4999-8999-999999999999",
        ))

    def test_reject_requires_the_approver_group_server_side(self):
        request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.projection.id,
            "action_type": "world_access_revoke",
            "risk_class": "high",
            "reason": "Nachgewiesener Entzug",
            "effect_preview": {"kind": "world-access-revoke"},
            "target_reference": "stable-subject",
        })
        request.action_submit()
        staff = self.env["res.users"].create({
            "name": "Zugfolge Sachbearbeitung",
            "login": "zugfolge-staff-no-approval",
            "email": "staff-no-approval@example.test",
            "group_ids": [Command.set([
                self.env.ref("base.group_user").id,
                self.env.ref("zugfolge_admin.group_zugfolge_admin").id,
            ])],
        })
        with self.assertRaises(AccessError):
            request.with_user(staff).action_reject()

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
            "role": "player",
        })
        invitation._write_controlled({"state": "sent"})
        invitation.sudo().with_context(zugfolge_game_projection=True)._apply_game_result({
            "outcome": "accepted",
            "requestReference": invitation.request_reference,
            "keycloakSubject": "kc-alpha",
            "gameAccountReference": "account-alpha",
        }, self.projection.world_id)
        action = invitation.action_revoke()
        request = self.env["zugfolge.admin.request"].browse(action["res_id"])
        self.assertEqual(request.action_type, "world_access_revoke")
        self.assertEqual(request.risk_class, "high")
        self.assertEqual(request.target_reference, "kc-alpha")
        self.assertEqual(invitation.state, "revocation_requested")
        with self.assertRaises(AccessError):
            invitation._apply_game_revocation_result(request.id, self.projection.world_id)
        request._write_controlled({"state": "dispatched"})
        request.sudo().with_context(zugfolge_game_projection=True).apply_game_result({
            "state": "completed",
            "gameAuditEventId": "revocation-audit-1",
            "keycloakSubject": "kc-alpha",
        })
        with self.assertRaises(ValidationError):
            invitation.sudo().with_context(zugfolge_game_projection=True)._apply_game_revocation_result(
                request.id + 1,
                self.projection.world_id,
            )
        invitation.sudo().with_context(zugfolge_game_projection=True)._apply_game_revocation_result(
            request.id,
            self.projection.world_id,
        )
        self.assertEqual(invitation.state, "revoked")

    def test_invitation_state_and_game_identity_reject_rpc_forgery(self):
        with self.assertRaises(AccessError):
            self.env["zugfolge.alpha.invitation"].create({
                "email": "forged@example.test",
                "display_name": "Manipuliert",
                "world_projection_id": self.projection.id,
                "role": "player",
                "state": "provisioned",
                "keycloak_subject": "forged-subject",
                "game_account_reference": "forged-account",
            })
        invitation = self.env["zugfolge.alpha.invitation"].create({
            "email": "alpha@example.test",
            "display_name": "Alpha",
            "world_projection_id": self.projection.id,
            "role": "player",
            "state": "draft",
            "request_reference": "forged-request-reference",
            "correlation_id": "forged-correlation",
        })
        self.assertNotEqual(invitation.request_reference, "forged-request-reference")
        self.assertNotEqual(invitation.correlation_id, "forged-correlation")
        for values in (
            {"state": "provisioned"},
            {"keycloak_subject": "forged-subject"},
            {"game_account_reference": "forged-account"},
            {"correlation_id": "forged-correlation"},
        ):
            with self.assertRaises(AccessError):
                invitation.with_context(zugfolge_alpha_invitation_write_token=True).write(values)

    def test_invitation_accepts_only_world_bound_signed_game_result(self):
        invitation = self.env["zugfolge.alpha.invitation"].create({
            "email": "alpha@example.test",
            "display_name": "Alpha",
            "world_projection_id": self.projection.id,
            "role": "player",
        })
        invitation._write_controlled({"state": "sent"})
        result = {
            "outcome": "accepted",
            "requestReference": invitation.request_reference,
            "keycloakSubject": "kc-alpha",
            "gameAccountReference": "account-alpha",
        }
        with self.assertRaises(AccessError):
            invitation._apply_game_result(result, self.projection.world_id)
        with self.assertRaises(ValidationError):
            invitation.sudo().with_context(zugfolge_game_projection=True)._apply_game_result(
                result,
                "99999999-9999-4999-8999-999999999999",
            )
        with self.assertRaises(ValidationError):
            invitation.sudo().with_context(zugfolge_game_projection=True)._apply_game_result(
                {**result, "requestReference": "wrong-request"},
                self.projection.world_id,
            )
        invitation.sudo().with_context(zugfolge_game_projection=True)._apply_game_result(
            result,
            self.projection.world_id,
        )
        self.assertEqual(invitation.state, "provisioned")
        self.assertEqual(invitation.keycloak_subject, "kc-alpha")
        self.assertEqual(invitation.game_account_reference, "account-alpha")
        with self.assertRaises(UserError):
            invitation.write({"email": "changed@example.test"})

    def test_invitation_resend_projection_preserves_authoritative_identity(self):
        invitation = self.env["zugfolge.alpha.invitation"].create({
            "email": "alpha@example.test",
            "display_name": "Alpha",
            "world_projection_id": self.projection.id,
            "role": "player",
        })
        invitation._write_controlled({
            "state": "provisioned",
            "keycloak_subject": "kc-alpha",
            "game_account_reference": "account-alpha",
        })
        invitation.sudo().with_context(zugfolge_game_projection=True)._apply_game_result(
            {"outcome": "accepted"},
            self.projection.world_id,
        )
        self.assertEqual(invitation.state, "provisioned")
        self.assertEqual(invitation.keycloak_subject, "kc-alpha")
        with self.assertRaises(ValidationError):
            invitation.sudo().with_context(zugfolge_game_projection=True)._apply_game_result(
                {"outcome": "accepted", "keycloakSubject": "other-subject"},
                self.projection.world_id,
            )

    def test_invitation_rejected_signed_create_result_transitions_to_failed(self):
        invitation = self.env["zugfolge.alpha.invitation"].create({
            "email": "alpha@example.test",
            "display_name": "Alpha",
            "world_projection_id": self.projection.id,
            "role": "player",
        })
        invitation._write_controlled({"state": "sent"})
        invitation.sudo().with_context(zugfolge_game_projection=True)._apply_game_result(
            {"outcome": "rejected", "failureCode": "keycloak_unavailable"},
            self.projection.world_id,
        )
        self.assertEqual(invitation.state, "failed")

    def test_pseudonymized_feedback_projection_is_immutable_but_triageable(self):
        feedback = self.env["zugfolge.feedback"].with_context(zugfolge_game_projection=True).upsert_game_projection({
            "messageId": "feedback-message-1", "messageType": "alpha.feedback.projection",
            "worldId": self.projection.world_id, "occurredAt": "2026-01-01T00:05:00Z",
            "payload": {
                "feedbackReference": "feedback-1", "participantPseudonym": "a" * 64,
                "releaseHash": "b" * 64, "fromS": 10, "untilS": 20, "category": "usability",
                "message": "Die Warteschlange ist schwer verstaendlich.", "contactAllowed": False,
            },
        })
        self.assertEqual(feedback.participant_pseudonym, "a" * 64)
        self.assertNotIn("@", feedback.participant_pseudonym)
        self.assertEqual(str(feedback.submitted_at), "2026-01-01 00:05:00")
        self.assertFalse(feedback.env.context.get("zugfolge_game_projection"))
        with self.assertRaises(AccessError):
            feedback.write({"body": "Manipuliert"})
        feedback.write({"triage_state": "triaged"})
        self.assertEqual(feedback.triage_state, "triaged")
        replay = self.env["zugfolge.feedback"].with_context(zugfolge_game_projection=True).upsert_game_projection({
            "messageId": "feedback-message-1-replay", "messageType": "alpha.feedback.projection",
            "worldId": self.projection.world_id, "occurredAt": "2026-01-01T00:05:00Z",
            "payload": {
                "feedbackReference": "feedback-1", "participantPseudonym": "a" * 64,
                "releaseHash": "b" * 64, "fromS": 10, "untilS": 20, "category": "usability",
                "message": "Die Warteschlange ist schwer verstaendlich.", "contactAllowed": False,
            },
        })
        self.assertEqual(replay, feedback)
        self.assertFalse(replay.env.context.get("zugfolge_game_projection"))

        with self.assertRaises(ValidationError):
            self.env["zugfolge.feedback"].with_context(zugfolge_game_projection=True).upsert_game_projection({
                "messageId": "feedback-message-invalid-time", "messageType": "alpha.feedback.projection",
                "worldId": self.projection.world_id, "occurredAt": "2026-01-01T00:06:00Z",
                "payload": {
                    "feedbackReference": "feedback-invalid-time", "participantPseudonym": "c" * 64,
                    "message": "Zeitstempel muss abgewiesen werden.", "submittedAt": "",
                },
            })
        self.assertFalse(self.env["zugfolge.feedback"].search([("feedback_reference", "=", "feedback-invalid-time")]))

    def test_monitoring_projection_extracts_live_queue_market_and_release_fields(self):
        projected = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_game_projection({
            "messageId": "projection-2", "worldId": self.projection.world_id,
            "occurredAt": "2026-01-01T00:01:00Z",
            "payload": {
                "worldName": "Testwelt", "projectionRevision": "2", "freshness": "delayed",
                "simulationTime": "2026-01-01T02:01:00+02:00",
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
        self.assertEqual(str(projected.observed_at), "2026-01-01 00:01:00")
        self.assertEqual(str(projected.simulation_time), "2026-01-01 00:01:00")

    def test_projection_rejects_naive_integration_timestamp_without_mutating_record(self):
        with self.assertRaises(ValidationError):
            self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_game_projection({
                "messageId": "projection-invalid-time", "worldId": self.projection.world_id,
                "occurredAt": "2026-01-01 00:01:00",
                "payload": {"worldName": "Manipuliert", "projectionRevision": "invalid"},
            })
        self.projection.invalidate_recordset()
        self.assertEqual(self.projection.world_name, "Testwelt")

    def test_capability_projection_normalizes_offset_and_rejects_missing_time(self):
        capability = self.env["zugfolge.admin.capability"].with_context(zugfolge_game_projection=True).upsert_game_projection({
            "messageId": "capability-time-1", "worldId": self.projection.world_id,
            "occurredAt": "2026-01-01T02:00:00+02:00",
            "payload": {"actionType": "world_close", "availability": "available"},
        })
        self.assertEqual(str(capability.observed_at), "2026-01-01 00:00:00")
        with self.assertRaises(ValidationError):
            self.env["zugfolge.admin.capability"].with_context(zugfolge_game_projection=True).upsert_game_projection({
                "messageId": "capability-time-2", "worldId": self.projection.world_id,
                "payload": {"actionType": "world_close", "availability": "unavailable"},
            })
        capability.invalidate_recordset()
        self.assertEqual(capability.availability, "available")

    def test_projected_deployment_upgrade_is_monotone_audited_and_idempotent(self):
        first = self._authoritative_world_start_projection(
            self.projection.world_id, "d" * 64, 1, "projection-capital-1",
        )
        projected = self.env["zugfolge.world.projection"].with_context(
            zugfolge_game_projection=True,
        ).upsert_game_projection(first)
        self.assertEqual(projected.starting_capital_preview, "10.000,00 \u20ac")
        self.assertEqual(projected.deployment_hash, "d" * 64)
        self.assertEqual(projected.deployment_revision, 1)
        self.assertEqual(projected.deployment_audit_ids.mapped("deployment_hash"), ["d" * 64])
        with self.assertRaises(ValidationError):
            projected.with_context(zugfolge_game_projection=True).write({"deployment_hash": "e" * 64})

        forged = self._authoritative_world_start_projection(
            self.projection.world_id, "e" * 64, 2, "projection-forged-normal",
        )
        forged["payload"].pop("projectionKind")
        forged["payload"].pop("deploymentAuthorization")
        forged["payload"].pop("deploymentRevision")
        with self.assertRaises(ValidationError):
            self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True).upsert_game_projection({
                "messageId": "projection-capital-2", "worldId": self.projection.world_id,
                "occurredAt": "2026-01-01T00:02:00Z",
                "payload": {
                    "worldName": "Testwelt", "projectionRevision": "capital-2", "freshness": "delayed",
                    "profileKind": "public", "blueprintHash": "b" * 64, "deploymentHash": "d" * 64,
                    "startingCapitalPolicy": {"mode": "finite", "amountCents": "0"},
                },
            })
        with self.assertRaises(ValidationError):
            self.env["zugfolge.world.projection"].with_context(
                zugfolge_game_projection=True,
            ).upsert_game_projection(forged)

        second = self._authoritative_world_start_projection(
            self.projection.world_id, "e" * 64, 2, "projection-capital-2-authoritative", "c" * 64,
        )
        projected = self.env["zugfolge.world.projection"].with_context(
            zugfolge_game_projection=True,
        ).upsert_game_projection(second)
        self.assertEqual(projected.deployment_hash, "e" * 64)
        self.assertEqual(projected.deployment_revision, 2)
        self.assertEqual(projected.blueprint_hash, "c" * 64)
        self.assertEqual(projected.deployment_audit_ids.mapped("deployment_hash"), ["d" * 64, "e" * 64])
        self.assertEqual(projected.deployment_audit_ids[-1].previous_deployment_hash, "d" * 64)

        # A delivery replay with a new transport receipt is a projection no-op.
        replay = {**second, "messageId": "projection-capital-2-replay"}
        self.env["zugfolge.world.projection"].with_context(
            zugfolge_game_projection=True,
        ).upsert_game_projection(replay)
        self.assertEqual(len(projected.deployment_audit_ids), 2)

        stale = self._authoritative_world_start_projection(
            self.projection.world_id, "f" * 64, 2, "projection-stale-revision", "a" * 64,
        )
        with self.assertRaisesRegex(ValidationError, "exakt naechste"):
            self.env["zugfolge.world.projection"].with_context(
                zugfolge_game_projection=True,
            ).upsert_game_projection(stale)

        foreign_world_id = "33333333-3333-4333-8333-333333333333"
        foreign = self._authoritative_world_start_projection(
            foreign_world_id, "9" * 64, 1, "projection-foreign-world", "8" * 64,
        )
        self.env["zugfolge.world.projection"].with_context(
            zugfolge_game_projection=True,
        ).upsert_game_projection(foreign)
        projected.invalidate_recordset()
        self.assertEqual(projected.deployment_hash, "e" * 64)
        self.assertEqual(projected.deployment_revision, 2)
        self.assertEqual(
            self.env["zugfolge.world.projection"].search([("world_id", "=", foreign_world_id)]).deployment_hash,
            "9" * 64,
        )

    def test_legacy_deployment_upgrade_backfills_generation_one_without_deleting_the_mirror(self):
        self.env.cr.execute(
            "UPDATE zugfolge_world_projection SET deployment_hash = %s, blueprint_hash = %s WHERE id = %s",
            ["7" * 64, "6" * 64, self.projection.id],
        )
        self.projection.invalidate_recordset()

        self.assertEqual(backfill_legacy_deployment_audit(self.env.cr), 2)
        self.projection.invalidate_recordset()
        self.assertTrue(self.projection.exists())
        self.assertEqual(self.projection.deployment_revision, 1)
        self.assertEqual(self.projection.deployment_audit_ids.deployment_hash, "7" * 64)
        self.assertEqual(backfill_legacy_deployment_audit(self.env.cr), 0)

        upgraded = self._authoritative_world_start_projection(
            self.projection.world_id, "8" * 64, 2, "projection-after-addon-upgrade", "5" * 64,
        )
        self.env["zugfolge.world.projection"].with_context(
            zugfolge_game_projection=True,
        ).upsert_game_projection(upgraded)
        self.projection.invalidate_recordset()
        self.assertEqual(self.projection.deployment_revision, 2)
        self.assertEqual(self.projection.deployment_audit_ids.mapped("deployment_hash"), ["7" * 64, "8" * 64])

    def test_manual_disruption_is_prepared_but_cannot_dispatch_before_m8_capability(self):
        request = self.env["zugfolge.admin.request"].create({
            "world_projection_id": self.projection.id, "action_type": "manual_disruption_create", "risk_class": "high",
            "reason": "Gemaess manueller Meldung", "effect_preview": {"note": "Game prueft Auswirkungen"},
            "manual_disruption_start": "2026-02-01 10:00:00", "manual_disruption_end": "2026-02-01 12:00:00",
            "manual_disruption_cause": "Weichenstoerung", "manual_disruption_resource_ids": ["switch:test:1"],
            "manual_disruption_effect": {"kind": "closure"},
        })
        self.assertEqual(request.game_capability_state, "prepared")
        with self.assertRaises(AccessError):
            request.with_context(zugfolge_game_projection=True).write({"state": "approved"})
        request._write_controlled({"state": "approved"})
        with self.assertRaises(UserError):
            request.action_dispatch()

    def test_disruption_policy_requires_explicit_modes_and_verified_requester_then_freezes_four_eyes_payload(self):
        values = {
            "world_projection_id": self.projection.id, "action_type": "disruption_policy_schedule",
            "reason": "Offen ausgewiesene La zur naechsten Fahrplanperiode",
            "requested_period_start": "2026-08-31 00:00:00",
            "disruption_planned_mode": "SIMULATED", "disruption_incident_mode": "SIMULATED",
            "disruption_simulation_profile": {
                "id": "explicit-policy-test/v1", "eventsPerPeriod": 6,
                "minimumSeverityBasisPoints": 1000, "maximumSeverityBasisPoints": 8000,
                "minimumDurationSeconds": 1800, "maximumDurationSeconds": 1814400,
                "minimumNoticeSeconds": 604800, "maximumNoticeSeconds": 1814400,
                "dailyRestrictionsPerDay": 4, "infrastructureIncidentsPer100Days": 1,
                "vehicleIncidentsPer10000TrainRuns": 1, "dwellIncidentsPer10000Stops": 1,
            },
            "disruption_ruleset_version": "disruption-rules/v1",
        }
        with self.assertRaises(ValidationError):
            self.env["zugfolge.admin.request"].create(values)
        self.env.user.partner_id._bind_zugfolge_keycloak_subject("kc-policy-requester")
        with self.assertRaises(ValidationError):
            self.env["zugfolge.admin.request"].create({**values, "disruption_planned_mode": False})
        with self.assertRaises(ValidationError):
            self.env["zugfolge.admin.request"].create({**values, "disruption_planned_mode": "REALISTIC"})
        request = self.env["zugfolge.admin.request"].create(values)
        self.assertEqual(request.risk_class, "high")
        self.assertEqual(request.game_capability_state, "prepared")
        self.assertIn("wirkungslos", request.effect_preview["notice"])
        request.action_submit()
        with self.assertRaises(UserError):
            request.write({"disruption_incident_mode": "MANUAL"})
        with self.assertRaises(AccessError):
            request.action_approve()
        approver = self.env["res.users"].create({
            "name": "La-Freigabe", "login": "policy-approver", "email": "policy-approver@example.test",
            "group_ids": [Command.set([self.env.ref("base.group_user").id, self.env.ref("zugfolge_admin.group_zugfolge_approver").id])],
        })
        request.with_user(approver).action_approve()
        with self.assertRaises(UserError):
            request.action_dispatch()
        self.env["zugfolge.admin.capability"].with_context(zugfolge_game_projection=True).upsert_game_projection({
            "worldId": self.projection.world_id, "occurredAt": "2026-08-11T12:00:00Z",
            "payload": {"actionType": "disruption_policy_schedule", "availability": "available", "detail": "Nativer Policyhandler vorhanden"},
        })
        request.invalidate_recordset()
        request.action_dispatch()
        first = request._game_command_payload()
        self.assertEqual(first, request._game_command_payload())
        self.assertEqual(first["kind"], "admin.disruption_policy_schedule")
        self.assertEqual(first["worldId"], self.projection.world_id)
        self.assertNotEqual(first["requesterReference"], first["approverReference"])
        self.assertEqual(first["disruptionPolicy"], {
            "schemaVersion": "zugfolge-disruption-policy-schedule/v1", "requesterSubject": "kc-policy-requester",
            "effectiveAt": "2026-08-31T00:00:00Z", "plannedWorksMode": "SIMULATED", "operationalIncidentMode": "SIMULATED",
            "simulationProfile": values["disruption_simulation_profile"], "rulesetVersion": "disruption-rules/v1",
        })

    def test_capability_projection_cannot_be_created_by_staff(self):
        with self.assertRaises(AccessError):
            self.env["zugfolge.admin.capability"].create({
                "world_id": self.projection.world_id, "action_type": "manual_disruption_create", "availability": "available",
                "observed_at": "2026-01-01 00:00:00", "payload_hash": "a" * 64,
            })

    def test_invoice_without_product_mapping_emits_no_entitlement(self):
        invoice = self.env["account.move"].new({"move_type": "out_invoice", "zugfolge_subject_reference": "subject"})
        self.assertFalse(invoice._zugfolge_command_change())
