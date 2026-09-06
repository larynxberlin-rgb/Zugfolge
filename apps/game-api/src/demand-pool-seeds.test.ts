import { PGlite } from "@electric-sql/pglite";
import { domainEvents, MIGRATIONS_FOLDER, regionalSimulationStates, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { demandRuntimeFromAddon, loadDemandRuntime, type DemandRuntime } from "@zugfolge/runtime-native";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMAND_POOL_INITIALIZED_EVENT, loadDemandPoolSeed, pinDemandPoolSeeds } from "./demand-pool-seeds.js";
import { DEMAND_MAX_BYTES, DemandStore, demandHash } from "./demand-store.js";

const WORLD = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const PIN = "a".repeat(64);
const bindings = ["north", "south"].map((regionId) => ({ worldId: WORLD, regionId, initializationHash: PIN }));
const template = (periodId: string, start: number, departure = start + 100) => ({
  schemaVersion: "zugfolge-demand-evaluation/v1", worldId: WORLD, periodId, windowStartMs: start, windowEndMs: start + 1_000,
  nowMs: start, revision: 20, release: {}, alternatives: [], services: [{ trainRunId: `train:${periodId}`,
    stops: [{ stopId: `${periodId}:0`, departureMs: departure }, { stopId: `${periodId}:1`, departureMs: departure + 100 }] }],
});
const runtime: DemandRuntime = { evaluate(input) {
  return { worldId: input["worldId"], periodId: input["periodId"], nowMs: input["nowMs"], revision: input["revision"],
    stateHash: demandHash(input), choices: [] };
} };

describe("Private Nachfrage-Anfangspools (PGlite-Transportfixture)", () => {
  let client: PGlite, db: ReturnType<typeof drizzle<typeof schema>>;
  beforeEach(async () => {
    client = new PGlite(); db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([WORLD, OTHER].map((id) => ({ id, name: id, schedulePeriodWeeks: 3, epoch: new Date(0) })));
    await db.insert(regionalSimulationStates).values(bindings.map(({ regionId }) => ({ worldId: WORLD, regionId,
      initializationHash: PIN, stateSchema: "zugfolge-operational-simulation-state/v2", state: state(regionId, 0),
      stateHash: PIN, revision: 0, publisherSequence: 0, createdAt: new Date(0), updatedAt: new Date(0) })));
  });
  afterEach(async () => { await client.close(); });
  function state(regionId: string, nowMs: number) { return { world: { worldId: WORLD, regionId, nowMs, eventSequence: 0 } }; }
  async function region(regionId: string, nowMs: number) {
    await db.update(regionalSimulationStates).set({ state: state(regionId, nowMs) })
      .where(and(eq(regionalSimulationStates.worldId, WORLD), eq(regionalSimulationStates.regionId, regionId)));
  }
  async function event(eventType: string, payload: unknown, worldId = WORLD) {
    const events = await db.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, worldId));
    await db.insert(domainEvents).values({ worldId, sequence: Math.max(0, ...events.map((row) => row.sequence)) + 1,
      eventType, payload, occurredAt: new Date(0) });
  }
  const pin = (templates = [template("p1", 0), template("p2", 2_000)]) => pinDemandPoolSeeds(db, runtime, WORLD, templates, PIN, new Date(0), bindings);

  it("pinnt auch zukünftige Pools vor Fensterbeginn, bleibt privat und restauriert bytegleich ohne Neuberechnung des Angebots", async () => {
    const first = await pin();
    expect(first).toHaveLength(2);
    expect(first[1]!.input).toMatchObject({ periodId: "p2", windowStartMs: 2_000, nowMs: 0, revision: 1 });
    expect(await new DemandStore(db, runtime).latest(WORLD)).toBeUndefined();
    await region("north", 9_000); await region("south", 8_000);
    expect(await pin()).toEqual(first);
    expect(await loadDemandPoolSeed(db, runtime, WORLD, "p2", PIN)).toEqual(first[1]);
    expect(await loadDemandPoolSeed(db, runtime, OTHER, "p2", PIN)).toBeUndefined();
    expect(await db.select().from(domainEvents)).toHaveLength(2);
    await expect(pin([template("p1", 0, 101), template("p2", 2_000)])).rejects.toThrow("verändert");
    await expect(loadDemandPoolSeed(db, runtime, WORLD, "p1", "b".repeat(64))).rejects.toThrow("Releasepin");
  });

  it("prüft die vorauslaufende Region und rollt zuvor erstellte Seeds desselben Aufrufs atomar zurück", async () => {
    await region("north", 501); await region("south", 0);
    await expect(pin([template("future", 2_000), template("already-running", 0, 500)])).rejects.toThrow("vor der ersten Abfahrt");
    expect(await db.select().from(domainEvents)).toHaveLength(0);
  });

  it("erlaubt dieselbe Weltzeit ohne Abfahrt und bewahrt bereits journalisierte Origin-Ankünfte im Startcursor", async () => {
    await event("operations.passenger-stop-departure", { trainRunId: "other-train" });
    await event("operations.passenger-stop-arrival", { trainRunId: "train:p1" });
    await event("operations.passenger-stop-arrival", { trainRunId: "other-train" });
    const [seed] = await pin([template("p1", 0, 0)]);
    expect(seed).toMatchObject({ startWorldSequence: 1, throughWorldSequence: 3,
      initialWatermark: { nowMs: 0, maxNowMs: 0 } });
    const after = await db.select().from(domainEvents);
    expect(after.at(-1)?.eventType).toBe(DEMAND_POOL_INITIALIZED_EVENT);
    expect(after.at(-1)?.sequence).toBe(4);
  });

  it("verweigert jede passende bereits vorhandene Abfahrt, auch exakt zum Initialisierungszeitpunkt", async () => {
    await event("operations.passenger-stop-departure", { trainRunId: "train:p1" }, OTHER);
    await event("operations.passenger-stop-departure", { trainRunId: "train:p1" });
    await expect(pin([template("p1", 0, 0)])).rejects.toThrow("Abfahrtsbeleg");
    expect((await db.select().from(domainEvents)).filter((row) => row.eventType === DEMAND_POOL_INITIALIZED_EVENT)).toHaveLength(0);
  });

  it("bindet Cursor und Ergebnis an Hashes und prüft auch ein konsistent umgehashtes falsches Ergebnis nativ", async () => {
    const [seed] = await pin([template("p1", 0)]);
    const { seedHash: _seedHash, ...body } = seed!;
    function reperiod(periodId: string) {
      const nextTemplate = { ...body.template, periodId }, input = { ...body.input, periodId }, result = runtime.evaluate(input);
      return { ...body, periodId, template: nextTemplate, templateHash: demandHash(nextTemplate), input, inputHash: demandHash(input),
        result, resultHash: demandHash(result) };
    }
    // Ein Restore liefert beschädigte Bytes; das append-only Original wird nicht geändert.
    const cursorBody = reperiod("bad-cursor");
    await event(DEMAND_POOL_INITIALIZED_EVENT, { ...cursorBody, seedHash: demandHash(cursorBody), startWorldSequence: 50 });
    await expect(loadDemandPoolSeed(db, runtime, WORLD, "bad-cursor", PIN)).rejects.toThrow("Hash");
    const resultBody = reperiod("bad-result"), result = { ...resultBody.result, stateHash: "b".repeat(64) };
    const corrupted = { ...resultBody, result, resultHash: demandHash(result) };
    await event(DEMAND_POOL_INITIALIZED_EVENT, { ...corrupted, seedHash: demandHash(corrupted) });
    await expect(loadDemandPoolSeed(db, runtime, WORLD, "bad-result", PIN)).rejects.toThrow("Rust-Replay");
  });

  it("verwirft fehlende/fremde Regionen, eingefrorene Welten und doppelte Pool-Identitäten", async () => {
    await expect(pinDemandPoolSeeds(db, runtime, WORLD, [template("p1", 0)], PIN, new Date(0), [])).rejects.toThrow("Nachfragebindung");
    await expect(pinDemandPoolSeeds(db, runtime, WORLD, [template("p1", 0)], PIN, new Date(0),
      bindings.map((binding) => ({ ...binding, initializationHash: "b".repeat(64) })))).rejects.toThrow("Initialisierungspin");
    await expect(pin([template("p1", 0), template("p1", 2_000)])).rejects.toThrow("eindeutige Freigabe");
    await db.update(worlds).set({ lifecycleStatus: "closing" }).where(eq(worlds.id, WORLD));
    await expect(pin()).rejects.toThrow("nicht aktiv");
    expect(await db.select().from(domainEvents)).toHaveLength(0);
  });

  it("verweigert zu große Seeds und persistiert bei nativem Ausfall keinen Teil der Poolmenge", async () => {
    await expect(pin([{ ...template("p1", 0), extra: "x".repeat(DEMAND_MAX_BYTES) } as ReturnType<typeof template>])).rejects.toThrow("Größe");
    const fails: DemandRuntime = { evaluate(input) { if (input["periodId"] === "p2") throw new Error("native failure"); return runtime.evaluate(input); } };
    await expect(pinDemandPoolSeeds(db, fails, WORLD, [template("p1", 0), template("p2", 2_000)], PIN, new Date(0), bindings)).rejects.toThrow("native failure");
    expect(await db.select().from(domainEvents)).toHaveLength(0);
  });

  it("verweigert doppelte persistierte Anfangsbelege und zurückgegangene Regionalstände", async () => {
    await region("north", 50); await region("south", 50);
    const [seed] = await pin([template("p1", 0)]);
    await region("south", 49);
    await expect(pin([template("p1", 0)])).rejects.toThrow("zurückgegangen");
    await event(DEMAND_POOL_INITIALIZED_EVENT, seed);
    await expect(loadDemandPoolSeed(db, runtime, WORLD, "p1", PIN)).rejects.toThrow("mehrere Anfangscheckpoints");
  });

  it.skipIf(process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] === undefined && process.env["ZUGFOLGE_DEMAND_TEST_BINARY"] === undefined)(
    "pinnt einen Folgetag bei Weltzeit0 mit echtem Rust und restauriert dessen ursprüngliches Manifest", async () => {
      const binary = process.env["ZUGFOLGE_DEMAND_TEST_BINARY"];
      const native = binary === undefined ? loadDemandRuntime() : demandRuntimeFromAddon({ evaluatePassengerDemand(input) {
        const result = spawnSync(binary, [], { input, encoding: "utf8", maxBuffer: DEMAND_MAX_BYTES });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout;
      } });
      const input = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/evaluation.json", import.meta.url), "utf8"));
      const day = 86_400_000;
      input.worldId = WORLD; input.periodId = "future-period";
      input.windowStartMs += day; input.windowEndMs += day;
      for (const service of input.services) {
        service.worldId = WORLD;
        for (const stop of service.stops) { stop.arrivalMs += day; stop.departureMs += day; }
      }
      for (const alternative of input.alternatives) alternative.worldId = WORLD;
      const [seed] = await pinDemandPoolSeeds(db, native, WORLD, [input], PIN, new Date(0), bindings);
      expect(seed!.input["nowMs"]).toBe(0);
      expect(seed!.input["windowStartMs"]).toBe(day);
      expect(seed!.result["projectionMode"]).toBe("forecast");
      expect(seed!.result["manifests"]).not.toEqual([]);
      await region("north", day + 10_000_000); await region("south", day + 10_000_000);
      expect(await loadDemandPoolSeed(db, native, WORLD, "future-period", PIN)).toEqual(seed);
      expect(await new DemandStore(db, native).latest(WORLD)).toBeUndefined();
    }, 30_000);
});
