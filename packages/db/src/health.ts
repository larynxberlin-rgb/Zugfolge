import type { HealthCheck } from "@zugfolge/health";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** Jede Postgres-Verbindung, gleich welchen Treibers — wie `AnyDatabase` in `world-scope.ts`. */
type AnyDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

/**
 * Prüft nur die Erreichbarkeit der Verbindung, nicht den Inhalt einer Welt —
 * Health Checks sind betrieblich, nicht weltgebunden, deshalb ohne `world_id`.
 */
export function createDatabaseHealthCheck(db: AnyDatabase): HealthCheck {
  return {
    name: "postgres",
    async check() {
      await db.execute(sql`select 1`);
      return { status: "ok" };
    },
  };
}
