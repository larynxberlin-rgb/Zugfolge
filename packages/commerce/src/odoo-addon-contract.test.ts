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
    expect(controller).toContain("admin.capability.projection");
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
    expect(model).toContain("dispatch_signed_game_command");
    expect(views).toContain("Alpha-Einladungen");
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
