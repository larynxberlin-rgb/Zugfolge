import { PGlite } from "@electric-sql/pglite";
import { domainEvents, MIGRATIONS_FOLDER, regionalSimulationStates, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { LivemapRegistry, type LivemapReadModel } from "@zugfolge/livemap-stream";
import { demandRuntimeFromAddon, loadDemandRuntime, type DemandRuntime } from "@zugfolge/runtime-native";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMAND_POOL_INITIALIZED_EVENT, loadDemandPoolSeed } from "./demand-pool-seeds.js";
import { DemandService, type DemandDeployment } from "./demand-service.js";
import { DEMAND_CHECKPOINT_EVENT, DEMAND_PROGRESS_EVENT, DemandStore, demandHash, demandInteger, demandList, demandRecord } from "./demand-store.js";
import { adaptOperationalDomainEvents } from "./operational-domain-event-adapter.js";
import type { OperationalPassengerStopReceipt } from "./operational-passenger-stop.js";

const WORLD = "11111111-1111-4111-8111-111111111111", PIN = "a".repeat(64), INFRA = "fixture-infra";
const bindings = ["north", "south"].map((regionId) => ({ worldId: WORLD, regionId, initializationHash: PIN }));
type Template = Readonly<Record<string, unknown>>;

function pool(periodId: string, startMs: number, occupied = false, firstDepartureMs = startMs + 1_000): Template {
  const trainRunId = `train:${periodId}`;
  return { schemaVersion: "zugfolge-demand-evaluation/v1", worldId: WORLD, periodId, seed: "42", revision: 1, nowMs: 0,
    windowStartMs: startMs, windowEndMs: startMs + 9_000, daySliceId: "fixture", release: { id: "transport-only", provenance: "balanced" },
    alternatives: [], services: [{ worldId: WORLD, trainRunId, operatorId: "fixture-operator", mode: "spnv", cancelled: false,
      fixtureOccupied: occupied, stops: [0, 1].map((index) => ({ stopId: `${trainRunId}:${index}`, stationId: `station:${index}`,
        passengerStop: true, arrivalMs: firstDepartureMs + index * 2_000, departureMs: firstDepartureMs + index * 2_000 })) }] };
}

/** Ausschließlich Transportfixture: feste Test-Reisezuordnung, keine Nachfragemodellierung. */
const transportRuntime: DemandRuntime = { evaluate(input) {
  const previous = input["previousEvaluation"] === undefined ? undefined : demandRecord(demandRecord(input["previousEvaluation"])["result"]);
  if (previous !== undefined && (demandInteger(previous["revision"]) >= demandInteger(input["revision"])
    || demandInteger(previous["nowMs"]) > demandInteger(input["nowMs"]) || previous["periodId"] !== input["periodId"]))
    throw new Error("Transportfixture: ungültige native Replayreihenfolge");
  return { schemaVersion: "transport-fixture-result/v1", worldId: input["worldId"], periodId: input["periodId"],
    nowMs: input["nowMs"], revision: input["revision"], stateHash: demandHash(input),
    operationalProgress: input["operationalProgress"] ?? null, projectionMode: input["operationalProgress"] === undefined ? "forecast" : "progress_bound",
    choices: demandList(input["services"]).filter((service) => service["fixtureOccupied"] === true).map((service) => ({
      trains: [{ trainRunId: service["trainRunId"], boardingStopId: demandList(service["stops"])[0]!["stopId"],
        alightingStopId: demandList(service["stops"]).at(-1)!["stopId"] }], passengers: 1,
    })) };
} };

describe("Nachfrage-Poollebenszyklus: PGlite und explizite Transportfixture", () => {
  let client: PGlite, db: ReturnType<typeof drizzle<typeof schema>>;
  let regionSequences: Map<string, number>;
  beforeEach(async () => {
    client = new PGlite(); db = drizzle(client, { schema }); regionSequences = new Map();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD, name: "Transport lifecycle fixture", schedulePeriodWeeks: 3, epoch: new Date(0) });
    await db.insert(regionalSimulationStates).values(bindings.map(({ regionId }) => ({ worldId: WORLD, regionId,
      initializationHash: PIN, stateSchema: "zugfolge-operational-simulation-state/v2",
      state: { world: { worldId: WORLD, regionId, nowMs: 0, eventSequence: 0 } }, stateHash: PIN,
      revision: 0, publisherSequence: 0, createdAt: new Date(0), updatedAt: new Date(0) })));
  });
  afterEach(async () => { await client.close(); });

  function service(windows: readonly Template[], runtime = transportRuntime) {
    const registry = new LivemapRegistry(); registry.initializeWorld(WORLD, { at: 0, trains: [] });
    const readModel = { async getConfig() { return { infrastructureReleaseId: INFRA }; },
      async getScheduledCall(worldId: string, stationId: string, trainId: string, atS: number, kind: string) {
        if (worldId !== WORLD) return undefined;
        const train = windows.flatMap((window) => demandList(window["services"])).find((row) => row["trainRunId"] === trainId);
        return train !== undefined && demandList(train["stops"]).some((stop) => stop["stationId"] === stationId
          && stop[kind === "arrival" ? "arrivalMs" : "departureMs"] === atS * 1_000) ? { trainId, scheduledTimeS: atS } : undefined;
      } } as unknown as LivemapReadModel;
    const deployment: DemandDeployment = { schemaVersion: "zugfolge-demand-deployment/v1", worldId: WORLD,
      infrastructureReleaseId: INFRA, windows };
    return new DemandService({ db, runtime, deployment, deploymentHash: PIN, readModel, livemap: registry, infrastructure: [], operationalRegions: () => bindings });
  }

  async function region(regionId: string, nowMs: number) {
    const sequence = regionSequences.get(regionId) ?? 0;
    await db.update(regionalSimulationStates).set({ revision: sequence, publisherSequence: sequence,
      state: { world: { worldId: WORLD, regionId, nowMs, eventSequence: sequence },
        commandReceipts: Object.fromEntries(Array.from({ length: sequence }, (_, index) => [`transport:${index + 1}`,
          { commandHash: PIN, appliedRevision: index + 1 }])) } })
      .where(and(eq(regionalSimulationStates.worldId, WORLD), eq(regionalSimulationStates.regionId, regionId)));
  }
  async function both(nowMs: number) { for (const { regionId } of bindings) await region(regionId, nowMs); }
  async function receipt(template: Template, stopSequence: number, kind: "arrival" | "departure", actualTimeMs: number, regionId = "north", trainIndex = 0) {
    const train = demandList(template["services"])[trainIndex]!, stop = demandList(train["stops"])[stopSequence]!;
    const value: OperationalPassengerStopReceipt = { schemaVersion: "zugfolge-operational-passenger-stop-receipt/v1", worldId: WORLD,
      serviceRunId: `service:${train["trainRunId"]}`, trainRunId: String(train["trainRunId"]), stopId: String(stop["stopId"]), stopSequence,
      stopPlanHash: PIN, routeVersionId: "route", formationVersionId: "formation", kind, actualTimeMs,
      receiptId: `${train["trainRunId"]}:${stopSequence}:${kind}` };
    const sequence = (regionSequences.get(regionId) ?? 0) + 1; regionSequences.set(regionId, sequence);
    const [event] = adaptOperationalDomainEvents([{ kind: `passenger-stop-${kind}`, atMs: actualTimeMs, subjectId: value.trainRunId,
      eventSequence: sequence, commitSequence: sequence, detail: JSON.stringify(value) }], [], [], regionId, WORLD);
    const rows = await db.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, WORLD));
    await db.insert(domainEvents).values({ worldId: WORLD, sequence: Math.max(0, ...rows.map((row) => row.sequence)) + 1,
      eventType: event!.eventType, payload: event!.payload, occurredAt: new Date(actualTimeMs) });
  }
  async function events(type?: string) {
    return db.select().from(domainEvents).where(type === undefined ? eq(domainEvents.worldId, WORLD)
      : and(eq(domainEvents.worldId, WORLD), eq(domainEvents.eventType, type))).orderBy(asc(domainEvents.sequence));
  }
  const cycle = (demand: DemandService) => demand.prepareOperationalCycle(new Date(99_000));
  function checkMonotonePublic(rows: Awaited<ReturnType<typeof events>>) {
    const checkpoints = rows.filter((row) => row.eventType === DEMAND_CHECKPOINT_EVENT).map((row) => demandRecord(demandRecord(row.payload)["input"]));
    for (let index = 1; index < checkpoints.length; index += 1) {
      expect(demandInteger(checkpoints[index]!["nowMs"])).toBeGreaterThanOrEqual(demandInteger(checkpoints[index - 1]!["nowMs"]));
      expect(demandInteger(checkpoints[index]!["revision"])).toBeGreaterThan(demandInteger(checkpoints[index - 1]!["revision"]));
    }
  }

  it("pinnt beide zukünftigen Fenster privat und lässt den vorgeschalteten Betriebs-Advance erreichbar", async () => {
    const demand = service([pool("p1", 1_000), pool("p2", 20_000)]);
    let advanced = false;
    await cycle(demand);
    expect(await new DemandStore(db, transportRuntime).latest(WORLD)).toBeUndefined();
    expect(await events(DEMAND_POOL_INITIALIZED_EVENT)).toHaveLength(2);
    advanced = true; await both(1_000); await cycle(demand);
    expect(advanced).toBe(true);
    expect(await events(DEMAND_POOL_INITIALIZED_EVENT)).toHaveLength(2);
    expect((await demand.checkpoint(WORLD)).input["periodId"]).toBe("p1");
  });

  it("konsumiert beim Cold-Catch-up beide überschrittenen Horizonte in Poolreihenfolge aus den ursprünglichen Seeds", async () => {
    const first = pool("p1", 1_000, true), next = pool("p2", 20_000, true), demand = service([first, next]);
    await cycle(demand); await both(1_000); await cycle(demand);
    const nextSeed = await loadDemandPoolSeed(db, transportRuntime, WORLD, "p2", PIN);
    await receipt(first, 0, "arrival", 1_000); await receipt(first, 0, "departure", 2_000); await receipt(first, 1, "arrival", 4_000);
    await receipt(next, 0, "arrival", 20_000, "south"); await receipt(next, 0, "departure", 21_000, "south"); await receipt(next, 1, "arrival", 23_000, "south");
    await both(50_001); await cycle(demand);
    const checkpoint = await demand.checkpoint(WORLD), rows = await events();
    expect(checkpoint.input).toMatchObject({ periodId: "p2", nowMs: 50_000 });
    expect(checkpoint.progressCursor?.["initialInputHash"]).toBe(nextSeed!.inputHash);
    expect(demandList(checkpoint.progressCursor?.["receipts"])).toHaveLength(3);
    const replay = rows.filter((row) => row.eventType === DEMAND_PROGRESS_EVENT).map((row) => demandRecord(demandRecord(row.payload)["input"]));
    expect(replay.some((input) => input["periodId"] === "p1" && input["nowMs"] === 2_000 && input["operationalProgress"] !== undefined)).toBe(true);
    expect(replay.some((input) => input["periodId"] === "p2" && input["nowMs"] === 21_000 && input["operationalProgress"] !== undefined)).toBe(true);
    const periods = replay.map((input) => input["periodId"]);
    expect(periods.lastIndexOf("p1")).toBeLessThan(periods.indexOf("p2"));
    checkMonotonePublic(rows);
    expect(await new DemandStore(db, transportRuntime).latest(WORLD, PIN)).toEqual(checkpoint);
  });

  it("hält den Betrieb nach dem letzten Fenster nicht fest und kann mit neuem Serviceobjekt fortgesetzt werden", async () => {
    const first = pool("p1", 1_000), next = pool("p2", 20_000), demand = service([first, next]);
    await cycle(demand); await both(50_001); await cycle(demand);
    const restored = service([first, next]);
    await both(90_001); await expect(cycle(restored)).resolves.toBeUndefined();
    expect((await restored.checkpoint(WORLD)).input["periodId"]).toBe("p2");
    await both(100_001); await expect(cycle(restored)).resolves.toBeUndefined();
    const beforeIdle = await events();
    await cycle(restored);
    expect(await events()).toEqual(beforeIdle);
    checkMonotonePublic(await events());
  });

  it("bestätigt Abfahrten bei0 erst nach beiden Regionalgrenzen und dann ausschließlich gemeinsam", async () => {
    const first = pool("p1", 0, true, 0), north = demandList(first["services"])[0]!, south = {
      ...north, trainRunId: "train:south", stops: demandList(north["stops"]).map((stop, index) => ({ ...stop, stopId: `train:south:${index}` })),
    };
    const template = { ...first, services: [north, south] }, demand = service([template, pool("p2", 20_000)]);
    await cycle(demand);
    await receipt(template, 0, "arrival", 0); await receipt(template, 0, "departure", 0); await region("north", 1);
    await cycle(demand);
    const pending = await demand.checkpoint(WORLD);
    expect(demandList(pending.progressCursor?.["receipts"])).toEqual([]);
    expect(demandList(pending.progressCursor?.["pendingReceipts"])).toHaveLength(2);
    await receipt(template, 0, "arrival", 0, "south", 1); await receipt(template, 0, "departure", 0, "south", 1); await region("south", 1);
    await cycle(demand);
    const checkpoint = await demand.checkpoint(WORLD);
    expect(demandList(checkpoint.progressCursor?.["receipts"])).toHaveLength(4);
    const projected = (await events()).filter((row) => [DEMAND_CHECKPOINT_EVENT, DEMAND_PROGRESS_EVENT].includes(row.eventType))
      .map((row) => demandRecord(demandRecord(row.payload)["result"])).filter((result) => result["operationalProgress"] != null);
    expect(projected.length).toBeGreaterThan(0);
    for (const result of projected) {
      const departures = demandList(demandRecord(result["operationalProgress"])["trains"])
        .flatMap((train) => demandList(train["stops"])).filter((stop) => stop["actualDepartureMs"] === 0);
      expect(departures).toHaveLength(2);
    }
  });

  it.each([false, true])("wendet dieselbe Abschlussbedingung vor und während des Poolwechsels an (belegte Reise: %s)", async (occupied) => {
    const first = pool("p1", 1_000, occupied), next = pool("p2", 20_000), demand = service([first, next]);
    await cycle(demand); await both(1_000); await cycle(demand);
    await receipt(first, 0, "arrival", 1_000); await receipt(first, 0, "departure", 2_000); await both(50_001);
    await expect(cycle(demand)).resolves.toBeUndefined();
    expect((await demand.checkpoint(WORLD)).input["periodId"]).toBe(occupied ? "p1" : "p2");
    if (occupied) {
      await receipt(first, 1, "arrival", 55_000); await both(56_001); await cycle(demand);
      expect((await demand.checkpoint(WORLD)).input["periodId"]).toBe("p2");
    }
    checkMonotonePublic(await events());
  });

  it("verweigert dieselbe Fahrtkennung in zwei Perioden vor jedem Seed oder Nachfragewrite", async () => {
    const first = pool("p1", 1_000), next = pool("p2", 20_000);
    const reused = { ...next, services: demandList(next["services"]).map((train) => ({ ...train,
      trainRunId: demandList(first["services"])[0]!["trainRunId"] })) };
    expect(() => service([first, reused])).toThrow();
    expect(await events()).toHaveLength(0);
  });

  it.skipIf(process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] === undefined && process.env["ZUGFOLGE_DEMAND_TEST_BINARY"] === undefined)(
    "wechselt zwei zukünftige Tagespools nach Cold-Catch-up mit echtem Rust und echten Replayhashes", async () => {
      const binary = process.env["ZUGFOLGE_DEMAND_TEST_BINARY"];
      const native = binary === undefined ? loadDemandRuntime() : demandRuntimeFromAddon({ evaluatePassengerDemand(input) {
        const result = spawnSync(binary, [], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        if (result.status !== 0) throw new Error(result.stderr); return result.stdout;
      } });
      const source = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/evaluation.json", import.meta.url), "utf8"));
      const windows = [1, 2].map((day) => {
        const input = structuredClone(source), delta = day * 86_400_000;
        input.worldId = WORLD; input.periodId = `native-day:${day}`; input.windowStartMs += delta; input.windowEndMs += delta;
        for (const train of input.services) {
          train.worldId = WORLD; train.trainRunId += `:day:${day}`;
          for (const stop of train.stops) { stop.stopId += `:day:${day}`; stop.arrivalMs += delta; stop.departureMs += delta; }
        }
        for (const alternative of input.alternatives) alternative.worldId = WORLD;
        return input as Template;
      });
      const demand = service(windows, native);
      await cycle(demand); await both(86_400_000); await cycle(demand);
      for (const window of windows) {
        const trains = demandList(window["services"]);
        for (let index = 0; index < trains.length; index += 1) {
          const stops = demandList(trains[index]!["stops"]);
          for (let stop = 0; stop < stops.length; stop += 1) {
            await receipt(window, stop, "arrival", demandInteger(stops[stop]!["arrivalMs"]), index % 2 === 0 ? "north" : "south", index);
            if (stop + 1 < stops.length) await receipt(window, stop, "departure", demandInteger(stops[stop]!["departureMs"]), index % 2 === 0 ? "north" : "south", index);
          }
        }
      }
      await both(3 * 86_400_000); await cycle(demand);
      const checkpoint = await demand.checkpoint(WORLD);
      expect(checkpoint.input["periodId"]).toBe("native-day:2");
      expect(checkpoint.result["projectionMode"]).toBe("progress_bound");
      expect(await new DemandStore(db, native).latest(WORLD, PIN)).toEqual(checkpoint);
      checkMonotonePublic(await events());
    }, 30_000);
});
