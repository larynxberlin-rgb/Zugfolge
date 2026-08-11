import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { worlds } from "./worlds.js";

/** Unveränderliche, zum Fahrplanstichtag wirksame Störungsrichtlinie einer Welt. */
export const disruptionPolicies = pgTable(
  "disruption_policies",
  {
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    version: integer("version").notNull(),
    status: text("status", { enum: ["scheduled", "active", "superseded"] }).notNull(),
    plannedWorksMode: text("planned_works_mode", { enum: ["REALISTIC", "SIMULATED", "MANUAL"] }).notNull(),
    operationalIncidentMode: text("operational_incident_mode", { enum: ["REALISTIC", "SIMULATED", "MANUAL"] }).notNull(),
    providerSetId: text("provider_set_id"),
    simulationProfile: jsonb("simulation_profile").notNull(),
    rulesetVersion: text("ruleset_version").notNull(),
    validFromS: bigint("valid_from_s", { mode: "number" }).notNull(),
    validUntilS: bigint("valid_until_s", { mode: "number" }),
    requestedByAccountId: uuid("requested_by_account_id").notNull(),
    changeReason: text("change_reason").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ name: "disruption_policies_pk", columns: [table.worldId, table.version] }),
    index("disruption_policies_world_status_valid_idx").on(table.worldId, table.status, table.validFromS),
    foreignKey({
      name: "disruption_policies_world_account_fk",
      columns: [table.worldId, table.requestedByAccountId],
      foreignColumns: [accounts.worldId, accounts.id],
    }),
    check("disruption_policies_version_positive", sql`${table.version} > 0`),
    check("disruption_policies_valid_window", sql`${table.validFromS} >= 0 and (${table.validUntilS} is null or ${table.validUntilS} > ${table.validFromS})`),
    check("disruption_policies_reason_nonempty", sql`length(trim(${table.changeReason})) >= 8`),
    check("disruption_policies_realistic_provider", sql`((${table.plannedWorksMode} <> 'REALISTIC' and ${table.operationalIncidentMode} <> 'REALISTIC') or ${table.providerSetId} is not null)`),
  ],
);

/** Rechte- und Cachezustand eines deaktivierbaren externen Provider-Sets. */
export const disruptionProviderStates = pgTable(
  "disruption_provider_states",
  {
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    providerSetId: text("provider_set_id").notNull(),
    rightsStatus: text("rights_status", { enum: ["pending", "approved", "rejected"] }).notNull(),
    enabled: text("enabled", { enum: ["disabled", "enabled"] }).notNull().default("disabled"),
    rightsReference: text("rights_reference"),
    lastSafeAtS: bigint("last_safe_at_s", { mode: "number" }),
    lastSafeSnapshot: jsonb("last_safe_snapshot"),
    lastFailure: text("last_failure"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ name: "disruption_provider_states_pk", columns: [table.worldId, table.providerSetId] }),
    index("disruption_provider_states_world_enabled_idx").on(table.worldId, table.enabled),
    check("disruption_provider_states_safe_pair", sql`(${table.lastSafeAtS} is null) = (${table.lastSafeSnapshot} is null)`),
    check("disruption_provider_states_rights_gate", sql`${table.enabled} = 'disabled' or (${table.rightsStatus} = 'approved' and ${table.rightsReference} is not null)`),
  ],
);

/** Append-only Roh- und Normalisierungsbeleg eines erfolgreichen Providerabrufs. */
export const disruptionProviderSnapshots = pgTable(
  "disruption_provider_snapshots",
  {
    worldId: uuid("world_id").notNull().references(() => worlds.id),
    providerSetId: text("provider_set_id").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    providerRevision: integer("provider_revision").notNull(),
    sourceVersion: text("source_version").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    rawSnapshot: jsonb("raw_snapshot").notNull(),
    normalizedSnapshot: jsonb("normalized_snapshot").notNull(),
    acceptedCount: integer("accepted_count").notNull(),
    discardedCount: integer("discarded_count").notNull(),
  },
  (table) => [
    primaryKey({ name: "disruption_provider_snapshots_pk", columns: [table.worldId, table.providerSetId, table.snapshotHash] }),
    index("disruption_provider_snapshots_world_fetched_idx").on(table.worldId, table.providerSetId, table.fetchedAt),
    check("disruption_provider_snapshots_hash", sql`${table.snapshotHash} ~ '^[a-f0-9]{64}$'`),
    check("disruption_provider_snapshots_revision_positive", sql`${table.providerRevision} > 0`),
    check("disruption_provider_snapshots_counts", sql`${table.acceptedCount} >= 0 and ${table.discardedCount} >= 0`),
  ],
);

/** Sollstand der bereits an regionale Single-Writer übergebenen Provider-Einträge. */
export const disruptionProviderApplications = pgTable(
  "disruption_provider_applications",
  {
    worldId: uuid("world_id").notNull(),
    providerSetId: text("provider_set_id").notNull(),
    regionId: text("region_id").notNull(),
    disruptionId: text("disruption_id").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    registration: jsonb("registration").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "disruption_provider_applications_pk",
      columns: [table.worldId, table.providerSetId, table.regionId, table.disruptionId],
    }),
    index("disruption_provider_applications_world_idx").on(table.worldId, table.providerSetId),
    foreignKey({
      name: "disruption_provider_applications_state_fk",
      columns: [table.worldId, table.providerSetId],
      foreignColumns: [disruptionProviderStates.worldId, disruptionProviderStates.providerSetId],
    }),
    check("disruption_provider_applications_hash", sql`${table.snapshotHash} ~ '^[a-f0-9]{64}$'`),
    check("disruption_provider_applications_region_nonempty", sql`length(trim(${table.regionId})) > 0`),
    check("disruption_provider_applications_disruption_nonempty", sql`length(trim(${table.disruptionId})) > 0`),
  ],
);

export type DisruptionPolicyRow = typeof disruptionPolicies.$inferSelect;
export type DisruptionProviderState = typeof disruptionProviderStates.$inferSelect;
export type DisruptionProviderSnapshot = typeof disruptionProviderSnapshots.$inferSelect;
export type DisruptionProviderApplication = typeof disruptionProviderApplications.$inferSelect;
