import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const addon = resolve(import.meta.dirname, "../../../odoo/addons/zugfolge_admin");

describe("Odoo-Administrationsmodul", () => {
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
    expect(request).toContain("game_capability_state");
    const capability = await readFile(resolve(addon, "models/admin_capability.py"), "utf8");
    expect(capability).toContain("zugfolge_game_projection");
    const invoice = await readFile(resolve(addon, "models/account_move.py"), "utf8");
    expect(invoice).toContain('_inherit = "account.move"');
    expect(invoice).toContain('"entitlement.change"');
  });

  it("hat eine signierte Projektions-, Replay- und Reconciliation-Grenze", async () => {
    const controller = await readFile(resolve(addon, "controllers/main.py"), "utf8");
    const receipt = await readFile(resolve(addon, "models/projection_receipt.py"), "utf8");
    expect(controller).toContain("hmac.compare_digest");
    expect(controller).toContain("/zugfolge/reconciliation/snapshot");
    expect(controller).toContain("/zugfolge/metrics");
    expect(controller).toContain("admin.capability.projection");
    expect(controller).toContain("alpha.feedback.projection");
    expect(receipt).toContain("unique(message_id)");
    expect(receipt).toContain("unveränderlich");
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
