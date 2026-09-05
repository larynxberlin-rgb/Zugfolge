import { PGlite } from "@electric-sql/pglite";
import { accounts, dailyOperationReports, domainEvents, MIGRATIONS_FOLDER, operators, worlds } from "@zugfolge/db";
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

  it("pflegt spaete Abschluesse nach Cold-Catchup im urspruenglichen Betriebstag nach und schreibt keine Archive", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const worldId = "11111111-1111-4111-8111-111111111112";
    const accountId = "22222222-2222-4222-8222-222222222223";
    const operatorId = "33333333-3333-4333-8333-333333333334";
    const archivedWorldId = "11111111-1111-4111-8111-111111111113";
    const serviceDay = "2026-08-10";
    const service = { worldId, operatorId, lotId: "lot-1", serviceId: "run-1", serviceRunId: "run-1:service-day:2026-08-10", trainRunId: "run-1", serviceDay, scheduledArrivalMs: 3_600_000, requiredSeats: null, connectionAssessment: "unavailable" };
    try {
      await db.insert(worlds).values([{ id: worldId, name: "Aktiv", schedulePeriodWeeks: 4, epoch: new Date("2026-08-10T00:00:00Z") }, { id: archivedWorldId, name: "Archiv", schedulePeriodWeeks: 4, epoch: new Date("2026-08-10T00:00:00Z") }]);
      await db.insert(accounts).values([{ id: accountId, worldId, keycloakSubject: "late-owner", displayName: "Leitung" }, { worldId: archivedWorldId, keycloakSubject: "archive-owner", displayName: "Archivleitung" }]);
      const [archivedAccount] = await db.select().from(accounts).where(eq(accounts.worldId, archivedWorldId));
      await db.insert(operators).values([{ id: operatorId, worldId, foundingAccountId: accountId, name: "Spaete Bahn" }, { worldId: archivedWorldId, foundingAccountId: archivedAccount!.id, name: "Archivbahn" }]);
      await db.update(worlds).set({ lifecycleStatus: "archived" }).where(eq(worlds.id, archivedWorldId));
      await db.insert(domainEvents).values({ worldId, sequence: 1, eventType: "operations.train-service-planned", payload: { ...service, schemaVersion: "zugfolge-operational-train-service-planned/v1" }, occurredAt: new Date("2026-08-10T00:00:00Z") });
      expect(await generateDailyOperationReports(db, serviceDay, new Date("2026-08-11T01:00:00Z"))).toBe(1);
      await db.insert(domainEvents).values({ worldId, sequence: 2, eventType: "operations.train-outcome", payload: { ...service, schemaVersion: "zugfolge-operational-train-outcome/v1", status: "completed", delaySeconds: 200_000, distanceMm: "12500000", trainKm: "12", minimumSeatsProvided: 81, capacitySources: ["fleet:1"], missingSeats: null, missedConnections: null, evidenceComplete: false }, occurredAt: new Date("2026-08-13T00:00:00Z") });
      expect(await generateDailyOperationReports(db, "2026-08-12", new Date("2026-08-13T01:00:00Z"))).toBe(2);
      const reports = await db.select().from(dailyOperationReports).where(eq(dailyOperationReports.worldId, worldId));
      expect(reports).toHaveLength(2);
      expect(reports.find((row) => row.serviceDay === serviceDay)).toMatchObject({ sourceThroughSequence: 2, projection: { evidenceComplete: false, trainRuns: { total: 1, distanceMm: "12500000", minimumSeatsProvided: 81 } } });
      expect(await db.select().from(dailyOperationReports).where(eq(dailyOperationReports.worldId, archivedWorldId))).toHaveLength(0);
      expect(await generateDailyOperationReports(db, "2026-08-12", new Date("2026-08-13T02:00:00Z"))).toBe(1);
    } finally { await client.close(); }
  });
});
