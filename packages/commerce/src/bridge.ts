import type { HealthCheck } from "@zugfolge/health";
import { sql } from "drizzle-orm";

import { projectionEnvelope, listPendingOdooProjections, markOdooProjectionDelivered, recordOdooProjectionFailure, type CommerceDatabase } from "./store.js";
import type { OdooProjectionEnvelope } from "./contracts.js";
import { signPayload, type SigningKey } from "./signing.js";

export interface OdooProjectionClient {
  project(message: OdooProjectionEnvelope): Promise<void>;
}

/** Minimaler HTTP-Adapter; der Game-Prozess kennt weder Odoo-Datenbank noch RPC. */
export function createHttpOdooProjectionClient(
  url: string,
  key: SigningKey,
  fetchImplementation: (input: string, init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body: string }) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }> = globalThis.fetch,
): OdooProjectionClient {
  return {
    async project(message) {
      const signed = signPayload(message, key);
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zugfolge-odoo-key-id": signed.keyId,
          "x-zugfolge-odoo-timestamp": signed.timestamp,
          "x-zugfolge-odoo-signature": signed.signature,
        },
        body: JSON.stringify(message),
      });
      if (!response.ok) throw new Error(`Odoo-Projektion antwortete mit HTTP ${response.status}.`);
      const parsed = await response.json();
      const result = typeof parsed === "object" && parsed !== null && "result" in parsed
        ? (parsed as { readonly result: unknown }).result
        : parsed;
      if (typeof result !== "object" || result === null || (result as Readonly<Record<string, unknown>>)["accepted"] !== true) {
        const code = typeof result === "object" && result !== null && typeof (result as Readonly<Record<string, unknown>>)["code"] === "string"
          ? (result as Readonly<Record<string, unknown>>)["code"]
          : "invalid_response";
        throw new Error(`Odoo-Projektion wurde fachlich abgelehnt: ${code}.`);
      }
    },
  };
}

/** Retryfaehiger Fanout; jeder Fehler bleibt in der Outbox und blockiert nie das Game. */
export async function dispatchOdooProjectionOutbox(db: CommerceDatabase, client: OdooProjectionClient, now = new Date()): Promise<{ readonly delivered: number; readonly failed: number }> {
  let delivered = 0;
  let failed = 0;
  for (const row of await listPendingOdooProjections(db)) {
    try {
      await client.project(projectionEnvelope(row));
      await markOdooProjectionDelivered(db, row.id, now);
      delivered += 1;
    } catch (error) {
      await recordOdooProjectionFailure(db, row.id, error instanceof Error ? error.name : "bridge_error");
      failed += 1;
    }
  }
  return { delivered, failed };
}

/** Eine fehlende Odoo-Verbindung degradiert nur die Projektion, nicht Readiness des Spiels. */
export function createOdooBridgeHealthCheck(db: CommerceDatabase, maximumAgeMs = 15 * 60_000, now: () => number = Date.now): HealthCheck {
  return {
    name: "odoo-bridge",
    async check() {
      const result = await db.execute(sql`
        select count(*)::int as pending_count,
               extract(epoch from min(enqueued_at)) * 1000 as oldest_ms,
               coalesce(max(attempts::integer), 0)::int as maximum_attempts
        from odoo_projection_outbox where delivered_at is null
      `);
      const row = Array.isArray(result) ? result[0] as Record<string, unknown> | undefined : undefined;
      const pending = Number(row?.["pending_count"] ?? 0);
      if (pending === 0) return { status: "ok", code: "projection_current" };
      const age = Math.max(0, now() - Number(row?.["oldest_ms"] ?? now()));
      return {
        status: "degraded",
        code: age > maximumAgeMs ? "projection_stale" : "projection_pending",
        detail: `${pending} Projektionen warten; maximal ${Number(row?.["maximum_attempts"] ?? 0)} Versuche`,
      };
    },
  };
}
