import { randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER } from "./migrations.js";
import * as schema from "./schema/index.js";
import { regionalSimulationStates, worlds } from "./schema/index.js";

function row(worldId: string, stateHash: string, initializationHash = "f".repeat(64)) {
  return {
    worldId,
    regionId: "leipzig",
    stateSchema: "zugfolge-operational-simulation-state/v2",
    state: {
      schemaVersion: "zugfolge-operational-simulation-state/v2",
      worldId,
      regionId: "leipzig",
      revision: 0,
      publisherSequence: 0,
      commands: [],
    },
    initializationHash,
    stateHash,
    revision: 0,
    publisherSequence: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("regionale Simulationszustaende", () => {
  it("erzwingt Welt-FK, Welt-Region-PK und weltgebundene Abfragen", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const worldA = randomUUID();
    const worldB = randomUUID();
    try {
      await expect(
        db.insert(regionalSimulationStates).values(row(worldA, "0".repeat(64))),
      ).rejects.toThrow();
      await db.insert(worlds).values([
        { id: worldA, name: "A", schedulePeriodWeeks: 4, epoch: new Date(0) },
        { id: worldB, name: "B", schedulePeriodWeeks: 4, epoch: new Date(0) },
      ]);
      await db.insert(regionalSimulationStates).values([
        row(worldA, "a".repeat(64)),
        row(worldB, "b".repeat(64)),
      ]);
      await expect(
        db.insert(regionalSimulationStates).values(row(worldA, "c".repeat(64))),
      ).rejects.toThrow();
      await expect(
        db.insert(regionalSimulationStates).values(row(worldA, "d".repeat(64), "ungueltig")),
      ).rejects.toThrow();

      const selected = await db
        .select()
        .from(regionalSimulationStates)
        .where(
          and(
            eq(regionalSimulationStates.worldId, worldA),
            eq(regionalSimulationStates.regionId, "leipzig"),
          ),
        );
      expect(selected).toEqual([
        expect.objectContaining({
          worldId: worldA,
          regionId: "leipzig",
          initializationHash: "f".repeat(64),
          stateHash: "a".repeat(64),
        }),
      ]);
    } finally {
      await client.close();
    }
  });
});
