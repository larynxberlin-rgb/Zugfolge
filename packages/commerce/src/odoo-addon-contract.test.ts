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
  });

  it("hat eine signierte Projektions-, Replay- und Reconciliation-Grenze", async () => {
    const controller = await readFile(resolve(addon, "controllers/main.py"), "utf8");
    const receipt = await readFile(resolve(addon, "models/projection_receipt.py"), "utf8");
    expect(controller).toContain("hmac.compare_digest");
    expect(controller).toContain("/zugfolge/reconciliation/snapshot");
    expect(receipt).toContain("unique(message_id)");
    expect(receipt).toContain("unveränderlich");
  });
});
