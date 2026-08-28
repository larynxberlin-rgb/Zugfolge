import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const addon = resolve(import.meta.dirname, "../../../odoo/addons/zugfolge_admin");

describe("Odoo-Administrationsmodul", () => {
  it("installiert Eindeutigkeit mit der Odoo-19-Constraint-API", async () => {
    const modelFiles = [
      "admin_request.py",
      "admin_capability.py",
      "feedback.py",
      "infra_release_import.py",
      "participation.py",
      "projection_receipt.py",
      "projection.py",
      "public_world.py",
      "res_users.py",
    ];
    const models = await Promise.all(
      modelFiles.map((file) => readFile(resolve(addon, "models", file), "utf8")),
    );
    const source = models.join("\n");
    expect(source).not.toContain("_sql_constraints");
    expect(source.match(/models\.Constraint\(/g)).toHaveLength(12);
    for (const uniqueDefinition of [
      "unique(correlation_id)",
      "unique(world_id, action_type)",
      "unique(feedback_reference)",
      "unique(import_id)",
      "unique(partner_id, world_id)",
      "unique(idempotency_key)",
      "unique(message_id)",
      "unique(world_id, deployment_revision)",
      "unique(world_id, deployment_hash)",
      "unique(projection_id)",
      "unique(zugfolge_keycloak_subject)",
    ]) {
      expect(source).toContain(uniqueDefinition);
    }
  });

  it("macht die Zugfolge-App fuer den Odoo-Administrator sichtbar und verwaltbar", async () => {
    const manifest = await readFile(resolve(addon, "__manifest__.py"), "utf8");
    const security = await readFile(resolve(addon, "security/zugfolge_admin_security.xml"), "utf8");
    const views = await readFile(resolve(addon, "views/zugfolge_admin_views.xml"), "utf8");

    expect(manifest).toContain('"version": "19.0.2.0.4"');
    expect(manifest).toContain('"application": True');
    expect(security.match(/model="res\.groups\.privilege"/g)).toHaveLength(4);
    expect(security.match(/<field name="privilege_id"/g)).toHaveLength(4);
    expect(security).toContain("Command.link(ref('base.group_user'))");
    expect(security).toContain("Command.link(ref('base.group_system'))");
    expect(security).toContain("Command.unlink(ref('zugfolge_admin.group_zugfolge_admin'))");
    expect(security).not.toContain('name="user_ids"');
    expect(security).not.toContain("ref('base.user_admin')");
    expect(security).not.toContain("ref('base.user_root')");
    expect(views).toMatch(
      /<menuitem id="menu_zugfolge_root"[^>]*action="action_zugfolge_world_projection"[^>]*groups="zugfolge_admin\.group_zugfolge_admin,zugfolge_admin\.group_zugfolge_telemetry"/,
    );
  });

  it("verwendet native Odoo-Grundbausteine und kapselt nur die Zugfolge-Grenze", async () => {
    const manifest = await readFile(resolve(addon, "__manifest__.py"), "utf8");
    expect(manifest).toContain('"contacts"');
    expect(manifest).toContain('"crm"');
    expect(manifest).toContain('"account"');
    expect(manifest).toContain('"payment"');
    expect(manifest).toContain('"mail"');
    expect(manifest).toContain('"queue_job"');

    const service = await readFile(resolve(addon, "services.py"), "utf8");
    expect(service).toContain("dispatch_signed_game_command");
    expect(service).not.toContain("psycopg");
    expect(service).not.toContain("DATABASE_URL");
    const request = await readFile(resolve(addon, "models/admin_request.py"), "utf8");
    expect(request).toContain("with_delay");
    expect(request).toContain("manual_disruption_create");
    expect(request).toContain("world_deploy");
    expect(request).toContain("parse_german_currency_to_cents");
    expect(request).toContain("starting_capital_amount_cents");
    expect(request).toContain("signed_world_deployment");
    expect(request).toContain("signing_configuration");
    expect(request).toContain("zugfolge-alpha-world-deploy-configuration/v1");
    expect(request).toContain("game_capability_state");
    const capability = await readFile(resolve(addon, "models/admin_capability.py"), "utf8");
    expect(capability).toContain("zugfolge_game_projection");
    expect(capability).toContain("GLOBAL_WORLD_DEPLOY_CAPABILITY_SCOPE_ID");
    const invoice = await readFile(resolve(addon, "models/account_move.py"), "utf8");
    expect(invoice).toContain('_inherit = "account.move"');
    expect(invoice).toContain('"entitlement.change"');
  });

  it("macht die Zugfolge-App fuer den Odoo-Administrator sichtbar und verwaltbar", async () => {
    const manifest = await readFile(resolve(addon, "__manifest__.py"), "utf8");
    const security = await readFile(resolve(addon, "security/zugfolge_admin_security.xml"), "utf8");
    const views = await readFile(resolve(addon, "views/zugfolge_admin_views.xml"), "utf8");

    expect(manifest).toContain('"application": True');
    expect(security.match(/model="res\.groups\.privilege"/g)).toHaveLength(4);
    expect(security.match(/<field name="privilege_id"/g)).toHaveLength(4);
    expect(security).toContain("Command.link(ref('base.group_user'))");
    expect(security).toContain("Command.link(ref('base.group_system'))");
    expect(security).toContain("Command.unlink(ref('zugfolge_admin.group_zugfolge_admin'))");
    expect(security).not.toContain('name="user_ids"');
    expect(security).not.toContain("ref('base.user_admin')");
    expect(security).not.toContain("ref('base.user_root')");
    expect(views).toMatch(
      /<menuitem id="menu_zugfolge_root"[^>]*action="action_zugfolge_world_projection"[^>]*groups="zugfolge_admin\.group_zugfolge_admin,zugfolge_admin\.group_zugfolge_telemetry"/,
    );
  });

  it("hat eine signierte Projektions-, Replay- und Reconciliation-Grenze", async () => {
    const controller = await readFile(resolve(addon, "controllers/main.py"), "utf8");
    const receipt = await readFile(resolve(addon, "models/projection_receipt.py"), "utf8");
    const canonical = await readFile(resolve(addon, "models/canonical_json.py"), "utf8");
    const timestamp = await readFile(resolve(addon, "models/rfc3339.py"), "utf8");
    const timestampConsumers = await Promise.all(
      ["projection.py", "admin_capability.py", "feedback.py", "public_world.py"].map((file) =>
        readFile(resolve(addon, "models", file), "utf8"),
      ),
    );
    expect(controller).toContain("hmac.compare_digest");
    expect(controller).toContain("RFC3339_WITH_ZONE.fullmatch(timestamp)");
    expect(controller.match(/request\.get_json_data\(\)/g)).toHaveLength(2);
    expect(controller).not.toContain("request.jsonrequest");
    expect(controller.match(/type="jsonrpc"/g)).toHaveLength(2);
    expect(controller).not.toContain('type="json"');
    expect(controller).toContain("/zugfolge/reconciliation/snapshot");
    expect(controller).toContain("/zugfolge/metrics");
    expect(controller).toContain("admin.capability.projection");
    expect(controller).toContain("alpha.feedback.projection");
    expect(controller).toContain("{**result, \"state\": state}");
    expect(receipt).toContain("unique(message_id)");
    expect(receipt).toContain("unveränderlich");
    expect(receipt).toContain("zugfolge-projection-envelope-sha256/v1");
    expect(controller).toContain("existing.envelope_hash != envelope_digest");
    expect(controller).toContain("existing.envelope_hash_schema != PROJECTION_ENVELOPE_HASH_SCHEMA");
    expect(canonical).toContain("ensure_ascii=False");
    expect(canonical).toContain("MAX_SAFE_INTEGER = 9_007_199_254_740_991");
    expect(canonical).toContain("Gleitkommazahlen duerfen nicht kanonisch signiert werden");
    expect(controller).toContain("canonical_sha256(payload)");
    expect(controller).not.toContain("ensure_ascii=True");
    const receiptLookup = controller.indexOf('existing = receipt.search([("message_id", "=", message_id)]');
    const projectionTypeRejection = controller.indexOf('return {"accepted": False, "code": "invalid_projection_type"}');
    expect(receiptLookup).toBeGreaterThanOrEqual(0);
    expect(projectionTypeRejection).toBeGreaterThanOrEqual(0);
    expect(receiptLookup).toBeLessThan(projectionTypeRejection);
    expect(timestamp).toContain("RFC3339_WITH_ZONE");
    expect(timestamp).toContain("astimezone(timezone.utc).replace(tzinfo=None)");
    for (const consumer of timestampConsumers) {
      expect(consumer).toContain("rfc3339_utc");
    }
    expect(timestampConsumers.join("\n")).not.toMatch(
      /["'](?:observed_at|simulation_time|submitted_at)["']:\s*(?:payload|body|envelope)\.get\(/,
    );
    const projection = timestampConsumers[0]!;
    expect(projection).toContain("AUTHORITATIVE_WORLD_START_PROJECTION");
    expect(projection).toContain("record.deployment_revision + 1");
    expect(projection).toContain('self.env["zugfolge.world.deployment.audit"]');
  });
});

describe("Alpha-Einladungen", () => {
  it("stellt den Odoo-Kontrollpfad und die Bedienoberfläche bereit", async () => {
    const model = await readFile(resolve(addon, "models/alpha_invitation.py"), "utf8");
    const views = await readFile(resolve(addon, "views/zugfolge_admin_views.xml"), "utf8");
    expect(model).toContain("class AlphaInvitation");
    expect(model).toContain("action_resend");
    expect(model).toContain("action_revoke");
    expect(model).toContain('"action_type": "world_access_revoke"');
    expect(model).toContain('"risk_class": "high"');
    expect(model).not.toContain('record._command("revoke")');
    expect(model).not.toContain("start_package");
    expect(model).not.toContain("startPackage");
    expect(views).not.toContain("tutorial_account_reset");
    expect(views).toContain("Alpha-Einladungen");
    expect(model).toContain("world_profile_kind");
    expect(model).not.toContain("start_package");
    expect(views).not.toContain('name="start_package"');
    expect(model).toContain("die oeffentliche Zielwelt");
  });

  it("liefert einen isolierten Restore-, Alert- und Dashboard-Drill", async () => {
    const restore = await readFile(resolve(addon, "../../../ops/alpha/restore-odoo.sh"), "utf8");
    const drill = await readFile(resolve(addon, "../../../tools/alpha-ops/phase3-acceptance.sh"), "utf8");
    const dashboard = await readFile(resolve(addon, "../../../ops/alpha/grafana/zugfolge-alpha.json"), "utf8");
    const datasource = await readFile(resolve(addon, "../../../ops/alpha/grafana/provisioning/datasources/prometheus.yml"), "utf8");
    expect(restore).toContain("zugfolge_odoo_restore_");
    expect(restore).toContain("authoritativeStateSha256");
    expect(drill).toContain("--test-enable");
    expect(drill).toContain("ZugfolgeOdooDown");
    expect(drill).toContain("ZugfolgeSubsystemDegraded");
    expect(drill).toContain("attachment");
    expect(dashboard).toContain("zugfolge_alpha_odoo_projection_pending");
    expect(dashboard).toContain("zugfolge_alpha_market_items");
    expect(datasource).toContain("uid: zugfolge-prometheus");
    expect(drill).toContain("/api/datasources/proxy/uid/zugfolge-prometheus");
    expect(drill).toContain("parsed.data.result.length === 0");
  });
  it("versioniert Compose, Keycloak-Realm und secret-freie Beispielkonfiguration", async () => {
    const compose = await readFile(resolve(addon, "../../../compose.alpha.yml"), "utf8");
    const realm = await readFile(resolve(addon, "../../../ops/alpha/keycloak/zugfolge-realm.json"), "utf8");
    const env = await readFile(resolve(addon, "../../../.env.example"), "utf8");
    const odooImage = await readFile(resolve(addon, "../../../ops/alpha/odoo/Dockerfile"), "utf8");
    expect(odooImage).toContain("odoo:19.0-20260723");
    expect(compose).toContain("postgres:16.14-trixie");
    expect(realm).toContain('"clientId":"game-web"');
    expect(realm).toContain('"included.client.audience":"game-api"');
    expect(realm).toContain("VERIFY_EMAIL");
    expect(env).not.toMatch(/=(password|secret)$/im);
  });
});
