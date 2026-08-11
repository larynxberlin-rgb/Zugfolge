import { PGlite } from "@electric-sql/pglite";
import { accounts, dailyOperationReports, MIGRATIONS_FOLDER, operators, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { generateDailyOperationReports, previousBerlinServiceDay } from "./daily-reports.js";

describe("M7-Tagesberichtskalender", () => {
  it("bestimmt den vorherigen Berliner Betriebstag auch an Zeitumstellungen kalendarisch", () => {
    expect(previousBerlinServiceDay(new Date("2026-08-11T10:00:00Z"))).toBe("2026-08-10");
    expect(previousBerlinServiceDay(new Date("2026-03-29T12:00:00Z"))).toBe("2026-03-28");
    expect(previousBerlinServiceDay(new Date("2026-10-25T12:00:00Z"))).toBe("2026-10-24");
  });

  it("bleibt bei Worker-Neustart idempotent und ersetzt genau dieselbe Welt-EVU-Tagesprojektion", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const worldId = "11111111-1111-1111-1111-111111111111";
    const accountId = "22222222-2222-2222-2222-222222222222";
    const operatorId = "33333333-3333-3333-3333-333333333333";
    try {
      await db.insert(worlds).values({ id: worldId, name: "Berichtswelt", schedulePeriodWeeks: 4, epoch: new Date("2026-08-11T00:00:00Z") });
      await db.insert(accounts).values({ id: accountId, worldId, keycloakSubject: "daily-report-owner", displayName: "Berichtsleitung" });
      await db.insert(operators).values({ id: operatorId, worldId, foundingAccountId: accountId, name: "Berichtsbahn" });
      expect(await generateDailyOperationReports(db, "2026-08-10", new Date("2026-08-11T01:00:00Z"))).toBe(1);
      expect(await generateDailyOperationReports(db, "2026-08-10", new Date("2026-08-11T02:00:00Z"))).toBe(1);
      const rows = await db.select().from(dailyOperationReports).where(eq(dailyOperationReports.worldId, worldId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ worldId, operatorId, serviceDay: "2026-08-10", sourceFromSequence: 0, sourceThroughSequence: 0, generatedAt: new Date("2026-08-11T02:00:00Z") });
    } finally {
      await client.close();
    }
  });
});
