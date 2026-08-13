import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { ledgerTransactions } from "./ledger-transactions.js";
import { operators } from "./operators.js";
import { worlds } from "./worlds.js";

/**
 * Einmaliger Geldstart eines oeffentlichen EVU. Der zusammengesetzte
 * Primaerschluessel ist zugleich der atomare Claim gegen parallele
 * Gruendungsversuche desselben Weltkontos.
 *
 * `unlimited` bleibt absichtlich nichtnumerisch: nur die finite Variante darf
 * einen i64-Centbetrag und eine Startbuchung besitzen.
 */
export const operatorStartingCapital = pgTable("operator_starting_capital", {
  worldId: uuid("world_id").notNull().references(() => worlds.id),
  accountId: uuid("account_id").notNull(),
  operatorId: uuid("operator_id"),
  blueprintHash: text("blueprint_hash").notNull(),
  policyKind: text("policy_kind", { enum: ["finite", "unlimited"] }).notNull(),
  finiteAmountCents: bigint("finite_amount_cents", { mode: "bigint" }),
  ledgerTransactionId: uuid("ledger_transaction_id"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "operator_starting_capital_pk", columns: [table.worldId, table.accountId] }),
  uniqueIndex("operator_starting_capital_world_operator_idx")
    .on(table.worldId, table.operatorId)
    .where(sql`${table.operatorId} is not null`),
  foreignKey({
    name: "operator_starting_capital_world_account_fk",
    columns: [table.worldId, table.accountId],
    foreignColumns: [accounts.worldId, accounts.id],
  }),
  foreignKey({
    name: "operator_starting_capital_world_operator_fk",
    columns: [table.worldId, table.operatorId],
    foreignColumns: [operators.worldId, operators.id],
  }),
  foreignKey({
    name: "operator_starting_capital_world_transaction_fk",
    columns: [table.worldId, table.ledgerTransactionId],
    foreignColumns: [ledgerTransactions.worldId, ledgerTransactions.id],
  }),
  check("operator_starting_capital_blueprint_hash_check", sql`${table.blueprintHash} ~ '^[a-f0-9]{64}$'`),
  check("operator_starting_capital_policy_check", sql`(
    (${table.policyKind} = 'finite' and ${table.finiteAmountCents} is not null and ${table.finiteAmountCents} >= 0)
    or (${table.policyKind} = 'unlimited' and ${table.finiteAmountCents} is null and ${table.ledgerTransactionId} is null)
  )`),
  check("operator_starting_capital_completion_check", sql`(
    (${table.operatorId} is null and ${table.ledgerTransactionId} is null and ${table.appliedAt} is null)
    or (
      ${table.operatorId} is not null
      and ${table.appliedAt} is not null
      and (
        (${table.policyKind} = 'finite' and ${table.ledgerTransactionId} is not null)
        or (${table.policyKind} = 'unlimited' and ${table.ledgerTransactionId} is null)
      )
    )
  )`),
]);

export type OperatorStartingCapital = typeof operatorStartingCapital.$inferSelect;
export type NewOperatorStartingCapital = typeof operatorStartingCapital.$inferInsert;
