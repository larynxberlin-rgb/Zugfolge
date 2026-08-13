import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Die Welt — vollständig isolierte Instanz von Netz, Wirtschaft und Spielern
 * (`architektur.md` 1, 5). Jede andere Tabelle trägt eine `world_id`, die
 * hierher zeigt; diese Tabelle selbst nicht, denn sie *ist* die Welt, keine
 * ihrer Zeilen — Invariante 4 greift erst eine Ebene tiefer. Der Wächter
 * `world-id` kennt genau diese eine Ausnahme namentlich (`worlds`).
 */
export const worlds = pgTable("worlds", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Weltparameter, 3 bis 8 Wochen; 8 bedeutet eine unbefristete Welt (E3). */
  schedulePeriodWeeks: integer("schedule_period_weeks").notNull(),
  /** Weltepoche — der Nullpunkt der `SimTime` dieser Welt (`architektur.md` 4). */
  epoch: timestamp("epoch", { withTimezone: true }).notNull(),
  /** Private Welten sind stets ungewertet; die DB-Constraint steht in Migration 0012. */
  worldKind: text("world_kind", { enum: ["public", "private"] }).notNull().default("public"),
  rankingStatus: text("ranking_status", { enum: ["ranked", "unranked"] }).notNull().default("ranked"),
  lifecycleStatus: text("lifecycle_status", { enum: ["provisioning", "active", "archived"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type World = typeof worlds.$inferSelect;
export type NewWorld = typeof worlds.$inferInsert;
