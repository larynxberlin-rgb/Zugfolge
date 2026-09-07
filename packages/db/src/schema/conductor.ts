import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.js";
import { worlds } from "./worlds.js";
import { operators } from "./operators.js";

/** Löschbare Zuordnung; native Zug- und Fallzustände kennen nur ownerRef. */
export const conductorOwners = pgTable("conductor_owners", {
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  accountId: uuid("account_id").notNull(), ownerRef: uuid("owner_ref").notNull(),
}, (table) => [primaryKey({ columns: [table.worldId, table.accountId] }),
  uniqueIndex("conductor_owners_world_ref_idx").on(table.worldId, table.ownerRef),
  foreignKey({ columns: [table.worldId, table.accountId], foreignColumns: [accounts.worldId, accounts.id] }),
]);

/** Nativ geprüfter privater Zugzustand, ohne Konto- oder Keycloakkennungen. */
export const conductorTrainStates = pgTable("conductor_train_states", {
  worldId: uuid("world_id").notNull().references(() => worlds.id), trainRunId: text("train_run_id").notNull(),
  regionId: text("region_id").notNull(),
  state: jsonb("state").notNull(), stateHash: text("state_hash").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(), atMs: bigint("at_ms", { mode: "number" }).notNull(),
}, (table) => [primaryKey({ columns: [table.worldId, table.trainRunId] }),
  check("conductor_train_states_values", sql`${table.revision} >= 0 AND ${table.atMs} >= 0 AND ${table.stateHash} ~ '^[a-f0-9]{64}$'`),
  check("conductor_train_states_world", sql`coalesce(${table.state}->>'worldId' = ${table.worldId}::text AND ${table.state}->>'trainRunId' = ${table.trainRunId}, false)`),
]);

/** Atomare Reservierung je Konto und Zug; abgelaufene Leases räumt der Weltwriter. */
export const conductorLeases = pgTable("conductor_leases", {
  worldId: uuid("world_id").notNull().references(() => worlds.id), accountId: uuid("account_id").notNull(),
  ownerRef: uuid("owner_ref").notNull(), trainRunId: text("train_run_id").notNull(), sessionId: text("session_id").notNull(),
  leaseUntilMs: bigint("lease_until_ms", { mode: "number" }).notNull(),
}, (table) => [primaryKey({ columns: [table.worldId, table.accountId] }),
  uniqueIndex("conductor_leases_world_train_idx").on(table.worldId, table.trainRunId),
  index("conductor_leases_world_expiry_idx").on(table.worldId, table.leaseUntilMs),
  foreignKey({ columns: [table.worldId, table.accountId], foreignColumns: [accounts.worldId, accounts.id] }),
  check("conductor_leases_time", sql`${table.leaseUntilMs} >= 0`),
]);

/** Private Quittungen werden nicht in das unveränderliche Betriebsjournal geschrieben. */
export const conductorCommandReceipts = pgTable("conductor_command_receipts", {
  worldId: uuid("world_id").notNull().references(() => worlds.id), trainRunId: text("train_run_id").notNull(),
  commandId: text("command_id").notNull(), ownerRef: uuid("owner_ref").notNull(), requestHash: text("request_hash").notNull(),
  receipt: jsonb("receipt").notNull(),
}, (table) => [primaryKey({ columns: [table.worldId, table.trainRunId, table.commandId] }),
  index("conductor_receipts_world_owner_idx").on(table.worldId, table.ownerRef),
  foreignKey({ columns: [table.worldId, table.ownerRef], foreignColumns: [conductorOwners.worldId, conductorOwners.ownerRef] }),
  check("conductor_receipts_hash", sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`),
]);

/** Autorisierte Nachlieferung; begrenztes privates Snapshotjournal mit expliziter Sequenz. */
export const conductorSnapshots = pgTable("conductor_snapshots", {
  worldId: uuid("world_id").notNull().references(() => worlds.id), trainRunId: text("train_run_id").notNull(),
  sessionId: text("session_id").notNull(), ownerRef: uuid("owner_ref").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(), snapshot: jsonb("snapshot").notNull(),
}, (table) => [primaryKey({ columns: [table.worldId, table.trainRunId, table.sequence] }),
  index("conductor_snapshots_world_owner_idx").on(table.worldId, table.ownerRef),
  foreignKey({ columns: [table.worldId, table.ownerRef], foreignColumns: [conductorOwners.worldId, conductorOwners.ownerRef] }),
  check("conductor_snapshots_sequence", sql`${table.sequence} >= 0`),
]);

/** Privater nativer Kontrollzustand; bündelt Fälle und Tagesdeckel aller EVU-Fahrten. */
export const conductorControlStates = pgTable("conductor_control_states", {
  worldId: uuid("world_id").notNull().references(() => worlds.id), operatorId: uuid("operator_id").notNull(),
  state: jsonb("state").notNull(), stateHash: text("state_hash").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(), atMs: bigint("at_ms", { mode: "number" }).notNull(),
}, (table) => [primaryKey({ columns: [table.worldId, table.operatorId] }),
  foreignKey({ columns: [table.worldId, table.operatorId], foreignColumns: [operators.worldId, operators.id] }),
  check("conductor_control_states_values", sql`${table.revision} >= 0 AND ${table.atMs} >= 0 AND ${table.stateHash} ~ '^[a-f0-9]{64}$'`),
  check("conductor_control_states_binding", sql`coalesce(jsonb_typeof(${table.state}) = 'object' AND ${table.state}->>'schemaVersion' = 'fare-control-world-state/v1' AND ${table.state}->>'worldId' = ${table.worldId}::text AND ${table.state}->>'operatorId' = ${table.operatorId}::text AND ${table.state}->>'stateHash' = ${table.stateHash} AND ${table.state}->>'revision' = ${table.revision}::text AND ${table.state}->>'nowMs' = ${table.atMs}::text, false)`),
]);
