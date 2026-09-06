import type { HealthCheck } from "@zugfolge/health";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** Jede Postgres-Verbindung, gleich welchen Treibers — wie `AnyDatabase` in `world-scope.ts`. */
type AnyDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

/** Zahl der mit diesem Quellstand ausgelieferten Drizzle-Migrationen. */
export const EXPECTED_SCHEMA_MIGRATIONS = 36;

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
      // guards:allow world-id — Die Migrationshistorie ist globale Schema-Metadaten und besitzt fachlich keine Welt.
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
        sql`select world_id, status, accepted_world_contract_hash, accepted_starting_capital_policy from world_accesses limit 0`,
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
      await db.execute(
        sql`select world_id, revision, snapshot_hash from fleet_mobilization_snapshots limit 0`,
      );
      await db.execute(
        sql`select world_id, revision, state_hash, command_hash from fleet_world_checkpoints limit 0`,
      );
      await db.execute(
        sql`select world_id, message_type, delivered_at from odoo_projection_outbox limit 0`,
      );
      await db.execute(
        sql`select event_id, tenant_id from odoo_webhook_receipts limit 0`,
      );
      await db.execute(
        sql`select world_id, keycloak_subject, state from world_participations limit 0`,
      );
      await db.execute(
        sql`select world_id, region_id, initialization_hash, revision, publisher_sequence from regional_simulation_states limit 0`,
      );
      await db.execute(
        sql`select world_id, region_id, command_id, command_hash, applied_revision from regional_simulation_command_receipts limit 0`,
      );
      await db.execute(
        sql`select world_id, provider_set_id, snapshot_hash from disruption_provider_snapshots limit 0`,
      );
      await db.execute(
        sql`select world_id, provider_set_id, region_id, disruption_id from disruption_provider_applications limit 0`,
      );
      await db.execute(
        sql`select world_id, offeror_operator_id, offeree_operator_id, status, termination_requested_at_s, termination_effective_at_s, termination_evidence_reference from operator_contracts limit 0`,
      );
      await db.execute(
        sql`select world_id, vehicle_id, owner_operator_id, holder_operator_id from vehicle_assets limit 0`,
      );
      await db.execute(
        sql`select world_id, vehicle_id, status from vehicle_market_listings limit 0`,
      );
      await db.execute(
        sql`select world_id, profile_kind, state from alpha_world_profiles limit 0`,
      );
      await db.execute(
        sql`select world_id, account_id, operator_id, policy_kind from operator_starting_capital limit 0`,
      );
      await db.execute(
        sql`select world_id, identity_hash, response, observation_key, facts_hash from abuse_observations limit 0`,
      );
      await db.execute(sql`select world_id, recipient_account_id, content_hash, purged_at from mailbox_messages limit 0`);
      await db.execute(sql`select world_id, message_id, issue_kind from odoo_projection_quarantine limit 0`);
      await db.execute(
        sql`select world_id, identity_hash, request_count from rate_limit_buckets limit 0`,
      );
      await db.execute(
        sql`select world_id, release_hash, status from infra_release_changes limit 0`,
      );
      await db.execute(sql`select world_id, account_id, owner_ref from conductor_owners limit 0`);
      await db.execute(sql`select world_id, train_run_id, region_id, state_hash, revision, at_ms from conductor_train_states limit 0`);
      await db.execute(sql`select world_id, account_id, owner_ref, train_run_id, session_id, lease_until_ms from conductor_leases limit 0`);
      await db.execute(sql`select world_id, train_run_id, command_id, owner_ref, request_hash, receipt from conductor_command_receipts limit 0`);
      await db.execute(sql`select world_id, train_run_id, session_id, owner_ref, sequence, snapshot from conductor_snapshots limit 0`);
      await db.execute(sql`select world_id, operator_id, state_hash, revision, at_ms from conductor_control_states limit 0`);
      return { status: "ok", code: "schema_current" };
    },
  };
}

/** Lesbarkeit des persistierten Simulationslogs; fachlich ruhige Welten sind bewusst gesund/idle. */
export function createEventLogHealthCheck(
  db: AnyDatabase,
  maximumAgeMs = 5 * 60_000,
  now: () => number = Date.now,
): HealthCheck {
  return {
    name: "simulation-event-log",
    async check() {
      // guards:allow world-id — Der Betriebs-Healthcheck aggregiert nur den global jüngsten Event-Zeitpunkt ohne Payload.
      const result = await db.execute(
        sql`select extract(epoch from max(occurred_at)) * 1000 as latest_ms from domain_events`,
      );
      const raw = firstRow(result)?.["latest_ms"];
      if (raw === null || raw === undefined) return { status: "ok", code: "event_log_idle" };
      const latestMs = Number(raw);
      const ageMs = Math.max(0, now() - latestMs);
      // `domain_events` ist ein fachliches Journal, kein Heartbeat. Auch eine
      // laufende Simulation darf länger als dieses Beobachtungsfenster kein
      // neues Domänenereignis erzeugen. Scheduler-Liveness besitzt einen
      // eigenen Healthcheck; hier beweist bereits die erfolgreiche Abfrage die
      // technische Verfügbarkeit des Eventlogs.
      return ageMs > maximumAgeMs
        ? { status: "ok", code: "event_log_idle" }
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
      // guards:allow world-id — Der Betriebs-Healthcheck aggregiert ausschließlich globale Queue-Metadaten ohne Payload.
      const result = await db.execute(sql`
        select count(*)::int as pending_count,
               extract(epoch from min(enqueued_at)) * 1000 as oldest_ms,
               count(*) filter (where attempts > 0)::int as failed_count,
               coalesce(max(attempts), 0)::int as maximum_attempts
        from economy_outbox
        where processed_at is null
      `);
      const row = firstRow(result);
      const pendingCount = Number(row?.["pending_count"] ?? 0);
      if (pendingCount === 0) return { status: "ok", code: "outbox_empty" };
      const failedCount = Number(row?.["failed_count"] ?? 0);
      const maximumAttempts = Number(row?.["maximum_attempts"] ?? 0);
      if (failedCount > 0) {
        return {
          status: maximumAttempts >= 3 ? "down" : "degraded",
          code: "outbox_failures",
          detail: `${failedCount} Effekte fehlgeschlagen; maximal ${maximumAttempts} Versuche`,
        };
      }
      const oldestMs = Number(row?.["oldest_ms"]);
      const ageMs = Math.max(0, now() - oldestMs);
      return ageMs > maximumPendingAgeMs
        ? { status: "degraded", code: "outbox_stalled", detail: `${pendingCount} Effekte warten seit ${Math.round(ageMs / 1_000)} s` }
        : { status: "ok", code: "outbox_pending", detail: `${pendingCount} Effekte in Bearbeitung` };
    },
  };
}
