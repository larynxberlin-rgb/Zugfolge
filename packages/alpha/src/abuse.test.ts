import { PGlite } from "@electric-sql/pglite";
import { abuseObservations, abuseSanctions, MIGRATIONS_FOLDER, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AbuseGuard, type AbuseFacts } from "./abuse.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
let client: PGlite;
let db: ReturnType<typeof drizzle>;
beforeEach(async () => {
  client = new PGlite(); db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values({ id: WORLD, name: "Audit", schedulePeriodWeeks: 4, epoch: new Date("2026-01-01Z") });
});
afterEach(async () => { await client.close(); });
const facts = (): AbuseFacts => ({ worldId: WORLD, identityHash: "a".repeat(64), identityClass: "authenticated", endpointClass: "/one", actionClass: "test", atS: 10, requestCount: 1, actionCount: 1, distinctTargetCount: 1, replayCount: 0, coordinatedIdentityCount: 1, correlationId: "client-trace" });

it("trennt Trace-Korrelation von unveraenderlichen Beobachtungen und prueft echte Replays", async () => {
  const guard = new AbuseGuard(db);
  const first = await guard.evaluate({ ...facts(), observationKey: "server-request" });
  expect((await guard.evaluate({ ...facts(), observationKey: "server-request" })).id).toBe(first.id);
  for (const changed of [{ identityHash: "b".repeat(64) }, { endpointClass: "/two" }, { actionClass: "other" }, { atS: 3_000 }, { requestCount: 2 }, { actionCount: 2 }]) {
    await expect(guard.evaluate({ ...facts(), ...changed, observationKey: "server-request" })).rejects.toMatchObject({ code: "abuse_replay_conflict" });
    const separate = await guard.evaluate({ ...facts(), ...changed });
    expect(separate.id).not.toBe(first.id);
    expect(separate.identityHash).toBe(changed.identityHash ?? facts().identityHash);
  }
  const rows = await db.select().from(abuseObservations).where(eq(abuseObservations.worldId, WORLD));
  expect(rows).toHaveLength(7);
});

it("erzwingt aktivierte Sperren nach Fensterwechsel und Neustart bis zur exklusiven Zeitgrenze", async () => {
  const guard = new AbuseGuard(db);
  const observation = await guard.evaluate({ ...facts(), replayCount: 5, requestCount: 1_000, actionCount: 1_000 });
  const [proposed] = await db.select().from(abuseSanctions).where(and(eq(abuseSanctions.worldId, WORLD), eq(abuseSanctions.observationId, observation.id)));
  await db.update(abuseSanctions).set({ sanction: "temporary-block", startsAtS: 10, endsAtS: 1_000 }).where(and(eq(abuseSanctions.worldId, WORLD), eq(abuseSanctions.id, proposed!.id)));
  await guard.activateSevere(WORLD, proposed!.id, ADMIN);
  const restarted = new AbuseGuard(db);
  const request = { ...facts(), targetHash: "c".repeat(64), replayKeyHash: "d".repeat(64), atS: 120 };
  expect((await restarted.consume(request)).response).toBe("block");
  await restarted.appeal(WORLD, facts().identityHash, proposed!.id, "Bitte administrative Pruefung");
  expect((await restarted.consume({ ...request, atS: 999 })).response).toBe("block");
  expect((await restarted.consume({ ...request, atS: 1_000 })).response).toBe("observe");
  expect((await restarted.evaluate({ ...facts(), identityHash: "b".repeat(64), atS: 120 })).response).toBe("observe");
  await db.update(abuseSanctions).set({ status: "revoked" }).where(and(eq(abuseSanctions.worldId, WORLD), eq(abuseSanctions.id, proposed!.id)));
  expect((await restarted.evaluate({ ...facts(), atS: 121 })).response).toBe("observe");
});

it("wertet jeden HTTP-Versuch trotz gleicher Client-Korrelation eigenstaendig", async () => {
  const guard = new AbuseGuard(db);
  const request = { ...facts(), targetHash: "c".repeat(64), replayKeyHash: "d".repeat(64) };
  const first = await guard.consume(request);
  const second = await guard.consume(request);
  expect(second.id).not.toBe(first.id);
  expect(second.requestCount).toBe(2);
  expect(second.replayCount).toBe(1);
});
