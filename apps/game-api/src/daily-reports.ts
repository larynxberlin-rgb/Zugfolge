import { dailyOperationReports, operators, worldEventLog, worlds } from "@zugfolge/db";
import { buildDailyReport, operationsEventOperatorIds } from "@zugfolge/dispatch";
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

/** Aktive Welten; spaete native Abschluesse pflegen auch aeltere Berichtstage nach. */
export async function generateDailyOperationReports(
  db: IdentityDatabase,
  serviceDay: string,
  generatedAt: Date,
): Promise<number> {
  let generated = 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDay) || (Number.isNaN(Date.parse(serviceDay)) || new Date(serviceDay).toISOString().slice(0, 10) !== serviceDay)) throw new Error("Berichtstag ist ungueltig.");
  const worldRows = await db.select({ worldId: worlds.id }).from(worlds).where(eq(worlds.lifecycleStatus, "active"));
  for (const world of worldRows) {
    const operatorRows = await db
      .select({ operatorId: operators.id })
      .from(operators)
      .where(eq(operators.worldId, world.worldId));
    const events = await worldEventLog(db, world.worldId).list();
    const existing = await db.select().from(dailyOperationReports).where(eq(dailyOperationReports.worldId, world.worldId));
    const reportsByOperatorDay = new Map(existing.map((row) => [`${row.operatorId}\u0000${row.serviceDay}`, row]));
    const nativeDaysByOperator = new Map<string, Map<string, number>>();
    for (const event of events) {
      if (event.eventType !== "operations.train-service-planned" && event.eventType !== "operations.train-outcome") continue;
      const value = event.payload as Readonly<Record<string, unknown>> | null;
      const day = value?.["serviceDay"];
      if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day > serviceDay) continue;
      for (const operatorId of operationsEventOperatorIds(event)) {
        const days = nativeDaysByOperator.get(operatorId) ?? new Map<string, number>();
        days.set(day, Math.max(days.get(day) ?? 0, event.sequence));
        nativeDaysByOperator.set(operatorId, days);
      }
    }
    for (const operator of operatorRows) {
      const days = new Map(nativeDaysByOperator.get(operator.operatorId));
      days.set(serviceDay, days.get(serviceDay) ?? 0);
      for (const [reportDay, newestSequence] of [...days].sort(([left], [right]) => left.localeCompare(right))) {
        const previous = reportsByOperatorDay.get(`${operator.operatorId}\u0000${reportDay}`);
        // Der regulaere Vortag bleibt erneuerbar. Historie wird nur bei neuen
        // Belegen oder beim erstmaligen Upgrade auf explizite Vollstaendigkeit gebaut.
        if (reportDay !== serviceDay && previous !== undefined && previous.sourceThroughSequence >= newestSequence
          && typeof previous.projection === "object" && previous.projection !== null
          && Object.hasOwn(previous.projection, "evidenceComplete")) continue;
        const report = buildDailyReport(events, operator.operatorId, reportDay);
        await db.insert(dailyOperationReports).values({
          worldId: world.worldId,
          operatorId: operator.operatorId,
          serviceDay: reportDay,
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
  }
  return generated;
}
