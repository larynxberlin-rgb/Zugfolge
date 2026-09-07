import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { worlds } from "./worlds.js";

/** Feste Archivredaktion; Änderungen und Ausführung schützt Migration 37. */
export const archivePrivacyRequests = pgTable("archive_privacy_requests", {
  worldId: uuid("world_id").notNull().references(() => worlds.id), requestId: uuid("request_id").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(), action: text("action").notNull(), objectId: uuid("object_id").notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(), contentHash: text("content_hash"), completed: boolean("completed").notNull().default(false),
}, (table) => [primaryKey({ columns: [table.worldId, table.requestId] }), unique("archive_privacy_requests_world_id_sequence_key").on(table.worldId, table.sequence),
  unique("archive_privacy_requests_world_id_action_object_id_key").on(table.worldId, table.action, table.objectId),
  check("archive_privacy_requests_shape", sql`${table.sequence} > 0 AND ${table.action} IN ('account-request','account-purge','mailbox-purge') AND (${table.contentHash} IS NULL OR ${table.contentHash} ~ '^[a-f0-9]{64}$')`),
]);

/** Keine Altinhalte: nur unabhängig prüfbare Vorher-/Nachher-Hashübergänge. */
export const archivePrivacyRows = pgTable("archive_privacy_rows", {
  worldId: uuid("world_id").notNull(), requestId: uuid("request_id").notNull(), rowSequence: bigint("row_sequence", { mode: "number" }).notNull(),
  tableName: text("table_name").notNull(), beforeSha256: text("before_sha256").notNull(), beforeV1Sha256: text("before_v1_sha256").notNull(),
  beforeV1AddedFacts: boolean("before_v1_added_facts").notNull(), afterSha256: text("after_sha256"),
}, (table) => [primaryKey({ columns: [table.worldId, table.requestId, table.rowSequence] }),
  foreignKey({ name: "archive_privacy_rows_world_id_request_id_fkey", columns: [table.worldId, table.requestId], foreignColumns: [archivePrivacyRequests.worldId, archivePrivacyRequests.requestId] }),
  check("archive_privacy_rows_hashes", sql`${table.beforeSha256} ~ '^[a-f0-9]{64}$' AND ${table.beforeV1Sha256} ~ '^[a-f0-9]{64}$' AND (${table.afterSha256} IS NULL OR ${table.afterSha256} ~ '^[a-f0-9]{64}$')`),
  check("archive_privacy_rows_tables", sql`${table.tableName} IN ('accounts','world_accesses','account_roles','world_participations','mailbox_messages','conductor_owners','conductor_leases','conductor_command_receipts','conductor_snapshots')`),
]);
