import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "./schema/index.js";
import { worlds } from "./schema/index.js";
import { EventSequenceError, worldEventLog } from "./world-scope.js";

/**
 * Der automatisierte Isolationsnachweis aus M2.2: Zwei Welten teilen sich
 * dieselbe Tabelle, dieselbe Verbindung, denselben Prozess — und sehen
 * einander trotzdem nicht. Das läuft gegen eine echte, wenn auch eingebettete
 * Postgres-Instanz (PGlite), nicht gegen ein Mock, und gegen genau die
 * Migration, die auch im Betrieb angewandt würde.
 */
describe("Weltisolation des Event-Logs (M2.2)", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: join(import.meta.dirname, "..", "drizzle") });
  });

  afterEach(async () => {
    await client.close();
  });

  it("zeigt einer Welt nie die Ereignisse einer anderen", async () => {
    const weltA = randomUUID();
    const weltB = randomUUID();
    await db.insert(worlds).values([
      {
        id: weltA,
        name: "Leipzig–Halle–Erfurt A",
        schedulePeriodWeeks: 4,
        epoch: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: weltB,
        name: "Leipzig–Halle–Erfurt B",
        schedulePeriodWeeks: 4,
        epoch: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const logA = worldEventLog(db, weltA);
    const logB = worldEventLog(db, weltB);

    await logA.append({
      sequence: 1,
      eventType: "welt.angelegt",
      payload: {},
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });
    await logB.append({
      sequence: 1,
      eventType: "welt.angelegt",
      payload: {},
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });
    await logA.append({
      sequence: 2,
      eventType: "zug.abgefahren",
      payload: { zug: "RE1" },
      occurredAt: new Date("2026-01-01T06:00:00Z"),
    });

    const gelesenA = await logA.list();
    const gelesenB = await logB.list();

    expect(gelesenA).toHaveLength(2);
    expect(gelesenB).toHaveLength(1);
    expect(gelesenA.every((ereignis) => ereignis.worldId === weltA)).toBe(true);
    expect(gelesenB.every((ereignis) => ereignis.worldId === weltB)).toBe(true);
    expect(gelesenA.map((ereignis) => ereignis.eventType)).toEqual([
      "welt.angelegt",
      "zug.abgefahren",
    ]);
    await expect(
      logA.appendBatch([
        { sequence: 4, eventType: "lücke", payload: {}, occurredAt: new Date("2026-01-01T07:00:00Z") },
        { sequence: 6, eventType: "lücke", payload: {}, occurredAt: new Date("2026-01-01T07:01:00Z") },
      ]),
    ).rejects.toBeInstanceOf(EventSequenceError);
    await expect(
      logA.append({ sequence: 99, eventType: "startlücke", payload: {}, occurredAt: new Date("2026-01-01T07:00:00Z") }),
    ).rejects.toMatchObject({ message: expect.stringContaining("erwartet Sequenz 3") });
    await expect(logA.append({sequence:2,eventType:"doppelt",payload:{},occurredAt:new Date("2026-01-01T08:00:00Z")})).rejects.toThrow();
    await expect(
      logA.appendBatch([
        { sequence: 3, eventType: "drei", payload: {}, occurredAt: new Date("2026-01-01T09:00:00Z") },
        { sequence: 4, eventType: "vier", payload: {}, occurredAt: new Date("2026-01-01T09:01:00Z") },
      ]),
    ).resolves.toHaveLength(2);
  });
});
