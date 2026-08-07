import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { worlds } from "./worlds.js";

/**
 * Rolle eines Kontos innerhalb genau einer Welt (M2.1). Ein Konto kann
 * mehrere Rollen gleichzeitig tragen (etwa `player` und `world_admin`).
 */
export const accountRoles = pgTable(
  "account_roles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    role: text("role", { enum: ["player", "world_admin"] }).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("account_roles_world_account_role_idx").on(table.worldId, table.accountId, table.role)],
);

export type AccountRole = typeof accountRoles.$inferSelect;
export type NewAccountRole = typeof accountRoles.$inferInsert;
