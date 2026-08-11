import { dailyOperationReports, operators, worldEventLog, worlds } from "@zugfolge/db";
import { buildDailyReport } from "@zugfolge/dispatch";
import type { IdentityDatabase } from "@zugfolge/identity";
import { eq } from "drizzle-orm";

/** Vorheriger Berliner Kalendertag; bewusst außerhalb des Simulationskerns. */
export function previousBerlinServiceDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  if (![year, month, day].every(Number.isSafeInteger)) throw new Error("Betriebstag konnte nicht bestimmt werden.");
  return new Date(Date.UTC(year, month - 1, day) - 86_400_000).toISOString().slice(0, 10);
}

/** Idempotenter Tagesjob über alle Welten und deren EVU. */
export async function generateDailyOperationReports(
  db: IdentityDatabase,
  serviceDay: string,
  generatedAt: Date,
): Promise<number> {
  let generated = 0;
  const worldRows = await db.select({ worldId: worlds.id }).from(worlds);
  for (const world of worldRows) {
    const operatorRows = await db
      .select({ operatorId: operators.id })
      .from(operators)
      .where(eq(operators.worldId, world.worldId));
    const events = await worldEventLog(db, world.worldId).list();
    for (const operator of operatorRows) {
      const report = buildDailyReport(events, operator.operatorId, serviceDay);
      await db.insert(dailyOperationReports).values({
        worldId: world.worldId,
        operatorId: operator.operatorId,
        serviceDay,
        sourceFromSequence: report.sourceFromSequence,
        sourceThroughSequence: report.sourceThroughSequence,
        projection: report,
        generatedAt,
      }).onConflictDoUpdate({
        target: [dailyOperationReports.worldId, dailyOperationReports.operatorId, dailyOperationReports.serviceDay],
        set: {
          sourceFromSequence: report.sourceFromSequence,
          sourceThroughSequence: report.sourceThroughSequence,
          projection: report,
          generatedAt,
        },
      });
      generated += 1;
    }
  }
  return generated;
}

