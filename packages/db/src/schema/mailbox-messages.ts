import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { worlds } from "./worlds.js";

/**
 * Postfach-Nachricht (M2.5): Grundgerüst für Nachrichten mit optionaler
 * Frist und Quittierung. `messageType` und `payload` (jsonb) halten die
 * Nachricht generisch — Trassenangebote, Ausschreibungen und
 * Störungsmeldungen (spätere Milestones) sind je ein `messageType`, keine
 * eigene Tabelle.
 */
export const mailboxMessages = pgTable(
  "mailbox_messages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id),
    recipientAccountId: uuid("recipient_account_id")
      .notNull()
      .references(() => accounts.id),
    messageType: text("message_type").notNull(),
    payload: jsonb("payload").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    /** Frist, bis zu der eine Reaktion erwartet wird — optional, nicht jede Nachricht trägt eine. */
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    /** Quittierung durch den Empfänger; `null` heißt ungelesen/unquittiert. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (table) => [index("mailbox_messages_world_recipient_idx").on(table.worldId, table.recipientAccountId)],
);

export type MailboxMessage = typeof mailboxMessages.$inferSelect;
export type NewMailboxMessage = typeof mailboxMessages.$inferInsert;
