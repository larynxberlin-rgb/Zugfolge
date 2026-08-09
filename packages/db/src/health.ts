import type { HealthCheck } from "@zugfolge/health";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** Jede Postgres-Verbindung, gleich welchen Treibers — wie `AnyDatabase` in `world-scope.ts`. */
type AnyDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

/** Zahl der mit diesem Quellstand ausgelieferten Drizzle-Migrationen. */
export const EXPECTED_SCHEMA_MIGRATIONS = 8;

function firstRow(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result)) return result[0] as Record<string, unknown> | undefined;
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  }
  return undefined;
}

/**
 * Prüft nur die Erreichbarkeit der Verbindung, nicht den Inhalt einer Welt —
 * Health Checks sind betrieblich, nicht weltgebunden, deshalb ohne `world_id`.
 */
export function createDatabaseHealthCheck(db: AnyDatabase): HealthCheck {
  return {
    name: "postgres",
    async check() {
      const result = await db.execute(
        sql`select count(*)::int as migration_count from drizzle.__drizzle_migrations`,
      );
      const value = firstRow(result)?.["migration_count"];
      const migrationCount = typeof value === "number" ? value : Number(value);
      if (!Number.isSafeInteger(migrationCount) || migrationCount < EXPECTED_SCHEMA_MIGRATIONS) {
        return {
          status: "down",
          code: "schema_outdated",
          detail: `Schema ${migrationCount || 0}/${EXPECTED_SCHEMA_MIGRATIONS}`,
        };
      }
      // Verifiziert zusätzlich die für die Kernfunktionen erwarteten Tabellen
      // und Spalten; ein fremdes Schema mit gleicher Migrationszahl reicht nicht.
      await db.execute(
        sql`select world_id, sequence from domain_events limit 0`,
      );
      await db.execute(
        sql`select world_id, status from world_accesses limit 0`,
      );
      await db.execute(
        sql`select world_id, effect_id from economy_effects limit 0`,
      );
      await db.execute(
        sql`select world_id, revision from economy_world_states limit 0`,
      );
      await db.execute(
        sql`select world_id, effect_id, processed_at from economy_outbox limit 0`,
      );
      await db.execute(
        sql`select world_id, status from simulation_commands limit 0`,
      );
      return { status: "ok", code: "schema_current" };
    },
  };
}

/** Fortschritt des persistierten Simulationslogs; leere Installationen sind bewusst gesund/idle. */
export function createEventLogHealthCheck(
  db: AnyDatabase,
  maximumAgeMs = 5 * 60_000,
  now: () => number = Date.now,
): HealthCheck {
  return {
    name: "simulation-event-log",
    async check() {
      const result = await db.execute(
        sql`select extract(epoch from max(occurred_at)) * 1000 as latest_ms from domain_events`,
      );
      const raw = firstRow(result)?.["latest_ms"];
      if (raw === null || raw === undefined) return { status: "ok", code: "event_log_idle" };
      const latestMs = Number(raw);
      const ageMs = Math.max(0, now() - latestMs);
      return ageMs > maximumAgeMs
        ? { status: "degraded", code: "event_log_stale", detail: `Letztes Ereignis vor ${Math.round(ageMs / 1_000)} s` }
        : { status: "ok", code: "event_log_current" };
    },
  };
}

/** Meldet einen festhängenden M6-Outbox-Worker, ohne Payload oder Fehlertext offenzulegen. */
export function createEconomyOutboxHealthCheck(
  db: AnyDatabase,
  maximumPendingAgeMs = 60_000,
  now: () => number = Date.now,
): HealthCheck {
  return {
    name: "economy-outbox",
    async check() {
      const result = await db.execute(sql`
        select count(*)::int as pending_count,
               extract(epoch from min(enqueued_at)) * 1000 as oldest_ms
        from economy_outbox
        where processed_at is null
      `);
      const row = firstRow(result);
      const pendingCount = Number(row?.["pending_count"] ?? 0);
      if (pendingCount === 0) return { status: "ok", code: "outbox_empty" };
      const oldestMs = Number(row?.["oldest_ms"]);
      const ageMs = Math.max(0, now() - oldestMs);
      return ageMs > maximumPendingAgeMs
        ? { status: "degraded", code: "outbox_stalled", detail: `${pendingCount} Effekte warten seit ${Math.round(ageMs / 1_000)} s` }
        : { status: "ok", code: "outbox_pending", detail: `${pendingCount} Effekte in Bearbeitung` };
    },
  };
}
