import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, conductorCommandReceipts, conductorLeases, conductorOwners, conductorSnapshots, conductorTrainStates, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { requestWorldAccess } from "@zugfolge/identity";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { eraseAccountData } from "./erasure.js";
import { exportAccountData } from "./export.js";

it("isoliert private Sitzungsdaten und löscht die Kontoverknüpfung ohne synthetische Betriebsfälle zu entfernen", async () => {
  const client = new PGlite(), db = drizzle(client, { schema });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const a = "10000000-0000-4000-8000-000000000015", b = "20000000-0000-4000-8000-000000000015";
    await db.insert(worlds).values([a, b].map((id) => ({ id, name: id, schedulePeriodWeeks: 3, epoch: new Date(0) })));
    const accountA = await requestWorldAccess(db, { worldId: a, keycloakSubject: "conductor-a", displayName: "A" });
    const accountB = await requestWorldAccess(db, { worldId: b, keycloakSubject: "conductor-b", displayName: "B" });
    const refA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa15", refB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb15";
    await db.insert(conductorOwners).values([{ worldId: a, accountId: accountA.id, ownerRef: refA }, { worldId: b, accountId: accountB.id, ownerRef: refB }]);
    await expect(db.insert(conductorOwners).values({ worldId: a, accountId: accountB.id, ownerRef: refB })).rejects.toThrow();
    for (const [worldId, accountId, ownerRef] of [[a, accountA.id, refA], [b, accountB.id, refB]] as const) {
      await db.insert(conductorLeases).values({ worldId, accountId, ownerRef, trainRunId: "train", sessionId: "session", leaseUntilMs: 10_000 });
      await db.insert(conductorCommandReceipts).values({ worldId, ownerRef, trainRunId: "train", commandId: "command", requestHash: "a".repeat(64), receipt: { worldId, visible: true } });
      await db.insert(conductorSnapshots).values({ worldId, ownerRef, trainRunId: "train", sessionId: "session", sequence: 1, snapshot: { worldId, text: "Bereits sichtbarer Dialog" } });
      // Speichertest, kein nativer Fachbeweis: demonstriert die getrennte Lebensdauer.
      await db.insert(conductorTrainStates).values({ worldId, trainRunId: "train", regionId: "test-region", stateHash: "b".repeat(64), revision: 1, atMs: 0,
        state: { worldId, trainRunId: "train", syntheticCase: "persistent-case", ownerRef } });
    }
    await expect(db.insert(conductorCommandReceipts).values({ worldId: a, ownerRef: refB, trainRunId: "train", commandId: "cross", requestHash: "a".repeat(64), receipt: {} })).rejects.toThrow();
    await expect(db.insert(conductorTrainStates).values({ worldId: a, trainRunId: "missing", regionId: "test-region", stateHash: "b".repeat(64), revision: 0, atMs: 0, state: {} })).rejects.toThrow();
    await expect(db.insert(conductorLeases).values({ worldId: a, accountId: accountA.id, ownerRef: refA, trainRunId: "second", sessionId: "second", leaseUntilMs: 9000 })).rejects.toThrow();
    const exported = await exportAccountData(db, { worldId: a, keycloakSubject: "conductor-a", exportedAt: new Date(1) });
    expect(exported.conductor.ownerRef).toBe(refA);
    expect(exported.conductor.receipts).toHaveLength(1); expect(exported.conductor.snapshots).toHaveLength(1);
    expect(JSON.stringify(exported.conductor)).not.toContain(refB);
    await eraseAccountData(db, { worldId: a, actingKeycloakSubject: "conductor-a", targetKeycloakSubject: "conductor-a", erasedAt: new Date(2) });
    const erased = await exportAccountData(db, { worldId: a, keycloakSubject: "conductor-a", exportedAt: new Date(3) });
    expect(erased.conductor).toEqual({ ownerRef: null, leases: [], receipts: [], snapshots: [] });
    expect(await db.select().from(conductorTrainStates).where(and(eq(conductorTrainStates.worldId, a), eq(conductorTrainStates.trainRunId, "train")))).toHaveLength(1);
    expect((await exportAccountData(db, { worldId: b, keycloakSubject: "conductor-b", exportedAt: new Date(3) })).conductor.snapshots).toHaveLength(1);
  } finally { await client.close(); }
}, 30_000);
