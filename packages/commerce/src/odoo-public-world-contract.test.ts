import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const addon = resolve(import.meta.dirname, "../../../odoo/addons/zugfolge_admin");

describe("Odoo-Website-, Portal- und Payment-Vertrag", () => {
  it("installiert echte Odoo-19-Website-, Portal-, Verkauf-, Forum- und OIDC-Bausteine", async () => {
    const manifest = await readFile(resolve(addon, "__manifest__.py"), "utf8");
    for (const dependency of ["website", "portal", "website_sale", "website_forum", "auth_oauth", "auth_signup", "queue_job"]) {
      expect(manifest).toContain(`"${dependency}"`);
    }
    expect(manifest).toContain("web.assets_frontend");
    expect(manifest).toContain("website.assets_wysiwyg");
    expect(manifest).toContain("website.website_builder_assets");
  });

  it("registriert vier echte Builder-Snippets mit Welt-/Gruppenauswahl", async () => {
    const snippets = await readFile(resolve(addon, "views/snippets.xml"), "utf8");
    const options = await readFile(resolve(addon, "static/src/website_builder/world_snippet_option.xml"), "utf8");
    const plugin = await readFile(resolve(addon, "static/src/website_builder/world_snippet_option_plugin.js"), "utf8");
    expect(snippets).toContain('inherit_id="website.snippets"');
    expect(snippets).not.toContain('inherit_id="website.snippet_options"');
    for (const id of ["s_zugfolge_worlds", "s_zugfolge_world_banner", "s_zugfolge_live_stats", "s_zugfolge_evu_stats"]) {
      expect(snippets).toContain(`id="${id}"`);
    }
    expect(options).toContain("dataAttributeAction=\"'worldId'\"");
    expect(options).toContain("dataAttributeAction=\"'worldSelector'\"");
    expect(plugin).toContain('registry.category("website-plugins")');
    expect(plugin).toContain('static selector = "[data-zugfolge-worlds]"');
  });

  it("pollt begrenzt nur den Odoo-Cache und liefert keine Game-Endpunkte oder Geheimnisse aus", async () => {
    const javascript = await readFile(resolve(addon, "static/src/js/world_snippets.js"), "utf8");
    const website = await readFile(resolve(addon, "controllers/website.py"), "utf8");
    expect(javascript).toContain("const POLL_MS = 60_000");
    expect(javascript).toContain("/zugfolge/public/worlds");
    expect(javascript).not.toMatch(/GAME_|webhook_secret|projection_keys|DATABASE_URL|\/zugfolge\/projection/);
    expect(javascript).not.toContain("innerHTML");
    expect(website).toContain("game_world_origin(request.env, participation.world_id)");
    expect(website).toContain('request.redirect(origin + "/?world=" + participation.world_id, local=False)');
    expect(website).not.toContain("participation.offer_id.game_url_template");
  });

  it("verwendet signierte Commands und niemals eine direkte Game-Datenbank", async () => {
    const participation = await readFile(resolve(addon, "models/participation.py"), "utf8");
    const invoice = await readFile(resolve(addon, "models/account_move.py"), "utf8");
    const service = await readFile(resolve(addon, "services.py"), "utf8");
    expect(participation).toContain('"world.participation.change"');
    expect(participation).toContain('"idempotencyKey"');
    expect(invoice).toContain("payment_state");
    expect(service).toContain("dispatch_signed_game_command");
    expect(`${participation}\n${invoice}\n${service}`).not.toMatch(/psycopg|GAME_DATABASE|DATABASE_URL/);
  });

  it("gibt die private Commerce-Schreibfaehigkeit nie an einen Recordset-Aufrufer weiter", async () => {
    const participation = await readFile(resolve(addon, "models/participation.py"), "utf8");
    expect(participation).toContain("return participation.with_env(self.env)");
    expect(participation).toContain("is _COMMERCE_WRITE_TOKEN");
  });

  it("unterdrueckt doppelte Zahlungswirkungen und Projektion-Replays vor der Wirkung", async () => {
    const invoice = await readFile(resolve(addon, "models/account_move.py"), "utf8");
    const controller = await readFile(resolve(addon, "controllers/main.py"), "utf8");
    expect(invoice).toContain('participation.payment_reference == payment_reference');
    expect(invoice).toContain('"provisioning", "active", "rejected", "cancelled", "refunded"');
    expect(controller).toContain('"code": "replay_conflict"');
    expect(controller.indexOf("if existing:")).toBeLessThan(controller.indexOf('model = request.env["zugfolge.world.projection"]'));
  });

  it("erzwingt verifizierte Keycloak-Identitaet und Portal statt interner Nutzer", async () => {
    const users = await readFile(resolve(addon, "models/res_users.py"), "utf8");
    expect(users).toContain('validation.get("email_verified") is not True');
    expect(users).toContain("_is_internal()");
    expect(users).toContain("base.template_portal_user_id");
    expect(users).toContain("_create_user_from_template");
    expect(users).toContain("zugfolge_keycloak_subject");
    expect(users).not.toMatch(/realm_access|resource_access|Keycloak.*role/i);
  });

  it("behandelt Bannerrechte, Alt-Text, Fallback, leere und veraltete Daten sichtbar", async () => {
    const model = await readFile(resolve(addon, "models/public_world.py"), "utf8");
    const templates = await readFile(resolve(addon, "views/website_templates.xml"), "utf8");
    expect(model).toContain("banner_rights_approved");
    expect(model).toContain("world-fallback.svg");
    expect(model).toContain("public_is_stale");
    expect(templates).toContain("Daten möglicherweise veraltet");
    expect(templates).toContain("Noch keine Welt veröffentlicht");
    expect(templates).toContain("t-att-alt");
  });
});
