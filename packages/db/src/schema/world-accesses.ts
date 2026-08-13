import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { worlds } from "./worlds.js";

/**
 * Weltzugang: das Recht eines Keycloak-Subjects, in einer Welt aufzutreten
 * (M2.1). Getrennt vom Konto (`accounts`), damit ein Zugang entzogen werden
 * kann, ohne die Betriebshistorie des Kontos zu verlieren (vgl. E8: „Der
 * Account bleibt bestehen“).
 */
export const worldAccesses = pgTable(
  "world_accesses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    keycloakSubject: text("keycloak_subject").notNull(),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    /** Unveraenderliche Bestaetigung des serverseitig validierten oeffentlichen Weltvertrags. */
    acceptedWorldContractHash: text("accepted_world_contract_hash"),
    acceptedStartingCapitalPolicy: jsonb("accepted_starting_capital_policy"),
    worldContractAcceptedAt: timestamp("world_contract_accepted_at", { withTimezone: true }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("world_accesses_world_subject_idx").on(table.worldId, table.keycloakSubject),
    check("world_accesses_contract_hash_check", sql`${table.acceptedWorldContractHash} is null or ${table.acceptedWorldContractHash} ~ '^[a-f0-9]{64}$'`),
    check("world_accesses_contract_acceptance_check", sql`(
      ${table.acceptedWorldContractHash} is null
      and ${table.acceptedStartingCapitalPolicy} is null
      and ${table.worldContractAcceptedAt} is null
    ) or (
      ${table.acceptedWorldContractHash} is not null
      and ${table.acceptedStartingCapitalPolicy} is not null
      and ${table.worldContractAcceptedAt} is not null
    )`),
    check("world_accesses_starting_capital_policy_check", sql`
      ${table.acceptedStartingCapitalPolicy} is null
      or (
        jsonb_typeof(${table.acceptedStartingCapitalPolicy}) = 'object'
        and (
          ${table.acceptedStartingCapitalPolicy} = '{"kind":"unlimited"}'::jsonb
          or (
            ${table.acceptedStartingCapitalPolicy} ? 'kind'
            and ${table.acceptedStartingCapitalPolicy} ? 'amountCents'
            and (${table.acceptedStartingCapitalPolicy} - 'kind' - 'amountCents') = '{}'::jsonb
            and ${table.acceptedStartingCapitalPolicy}->>'kind' = 'finite'
            and ${table.acceptedStartingCapitalPolicy}->>'amountCents' ~ '^[0-9]+$'
            and length(${table.acceptedStartingCapitalPolicy}->>'amountCents') <= 19
            and (
              length(${table.acceptedStartingCapitalPolicy}->>'amountCents') < 19
              or ${table.acceptedStartingCapitalPolicy}->>'amountCents' <= '9223372036854775807'
            )
          )
        )
      )
    `),
  ],
);

export type WorldAccess = typeof worldAccesses.$inferSelect;
export type NewWorldAccess = typeof worldAccesses.$inferInsert;
