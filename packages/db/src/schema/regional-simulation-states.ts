import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/**
 * Letzter atomar persistierter Replay-Zustand eines regionalen M4-Single-Writers.
 * Der Rust-Zustand selbst bleibt versioniert und enthaelt das kanonische
 * Kommandolog; die Spalten daneben sind transaktionale Compare-and-set-Koepfe.
 */
export const regionalSimulationStates = pgTable(
  "regional_simulation_states",
  {
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    regionId: text("region_id").notNull(),
    stateSchema: text("state_schema").notNull(),
    state: jsonb("state").notNull(),
    /**
     * Kanonischer Hash der signierten OperationalSimulationInitialization.
     *
     * Die Migration laesst v1-Zustaende fuer das eng begrenzte Rollbackfenster
     * physisch ohne Wert stehen. Operational-v2 muss den Hash immer liefern;
     * ein Schemawechsel zwischen beiden Formen wird durch die Datenbank
     * fail-closed abgewiesen.
     */
    initializationHash: text("initialization_hash"),
    /** Nach dem atomaren V2-Cutover darf kein alter V1-Writer diese Headzeile mehr aendern. */
    legacyWriterFenced: boolean("legacy_writer_fenced").notNull().default(false),
    stateHash: text("state_hash").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    publisherSequence: bigint("publisher_sequence", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.worldId, table.regionId],
      name: "regional_simulation_states_pk",
    }),
    index("regional_simulation_states_world_sequence_idx").on(
      table.worldId,
      table.publisherSequence,
    ),
    uniqueIndex("regional_simulation_states_initialization_key_idx").on(
      table.worldId,
      table.regionId,
      table.initializationHash,
    ),
    check(
      "regional_simulation_states_revision_nonnegative",
      sql`${table.revision} >= 0`,
    ),
    check(
      "regional_simulation_states_publisher_sequence_nonnegative",
      sql`${table.publisherSequence} >= 0`,
    ),
    check(
      "regional_simulation_states_sequences_equal",
      sql`${table.revision} = ${table.publisherSequence}`,
    ),
    check(
      "regional_simulation_states_initialization_hash_sha256",
      sql`${table.initializationHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "regional_simulation_states_initialization_hash_present",
      sql`(${table.stateSchema} = 'zugfolge-regional-simulation-state/v1' AND ${table.initializationHash} IS NULL) OR (${table.stateSchema} = 'zugfolge-operational-simulation-state/v2' AND ${table.initializationHash} IS NOT NULL)`,
    ),
    check(
      "regional_simulation_states_legacy_writer_fence_shape",
      sql`NOT ${table.legacyWriterFenced} OR ${table.stateSchema} = 'zugfolge-regional-simulation-state/v1'`,
    ),
  ],
);

export type RegionalSimulationStateRow = typeof regionalSimulationStates.$inferSelect;

/**
 * Dauerhafte, kompakte Idempotenzfence aller jemals angewendeten Operational-
 * v2-Kommandos. Der begrenzte Receipt-Suffix im Rust-Checkpoint beschleunigt
 * nur lokale Replays; diese Tabelle verhindert auch nach dessen Eviction eine
 * erneute fachliche Wirkung derselben command_id.
 */
export const regionalSimulationCommandReceipts = pgTable(
  "regional_simulation_command_receipts",
  {
    worldId: uuid("world_id").notNull(),
    regionId: text("region_id").notNull(),
    initializationHash: text("initialization_hash").notNull(),
    commandId: text("command_id").notNull(),
    commandHash: text("command_hash").notNull(),
    // Schema-29/31 speicherte nur command_id -> command_hash. Solche
    // vollstaendigen Alt-Receipts bleiben dauerhaft idempotenzwirksam, auch
    // wenn sich ihre historische Einzelrevision nicht mehr rekonstruieren
    // laesst. Alle nach 0033 erfassten Objekt-Receipts tragen die Revision.
    appliedRevision: bigint("applied_revision", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.worldId, table.regionId, table.initializationHash, table.commandId],
      name: "regional_simulation_command_receipts_pk",
    }),
    foreignKey({
      columns: [table.worldId, table.regionId, table.initializationHash],
      foreignColumns: [
        regionalSimulationStates.worldId,
        regionalSimulationStates.regionId,
        regionalSimulationStates.initializationHash,
      ],
      name: "regional_simulation_command_receipts_state_fk",
    }).onDelete("cascade"),
    uniqueIndex("regional_simulation_command_receipts_revision_idx").on(
      table.worldId,
      table.regionId,
      table.initializationHash,
      table.appliedRevision,
    ),
    check(
      "regional_simulation_command_receipts_initialization_hash_sha256",
      sql`${table.initializationHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "regional_simulation_command_receipts_command_id_present",
      sql`length(${table.commandId}) > 0`,
    ),
    check(
      "regional_simulation_command_receipts_command_hash_sha256",
      sql`${table.commandHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "regional_simulation_command_receipts_revision_positive",
      sql`${table.appliedRevision} IS NULL OR ${table.appliedRevision} > 0`,
    ),
  ],
);

export type RegionalSimulationCommandReceiptRow =
  typeof regionalSimulationCommandReceipts.$inferSelect;
