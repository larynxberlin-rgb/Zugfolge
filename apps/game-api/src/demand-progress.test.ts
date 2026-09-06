import { PGlite } from "@electric-sql/pglite";
import { domainEvents, MIGRATIONS_FOLDER, regionalSimulationStates, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { demandRuntimeFromAddon, loadDemandRuntime, type DemandRuntime } from "@zugfolge/runtime-native";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DemandProgressConsumer } from "./demand-progress.js";
import { DemandStore, demandHash, demandList, demandRecord } from "./demand-store.js";
import { adaptOperationalDomainEvents } from "./operational-domain-event-adapter.js";
import { decodeOperationalPassengerStop, type OperationalPassengerStopReceipt } from "./operational-passenger-stop.js";

const WORLD = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const PIN = "a".repeat(64);
const services = [{ worldId: WORLD, trainRunId: "train", stops: [0, 1, 2].map((index) => ({ stopId: `train:${index}`,
  stationId: `station:${index}`, passengerStop: true, arrivalMs: 800 + index * 1_000, departureMs: 800 + index * 1_000 })) }];
const template = { worldId: WORLD, periodId: "p1", windowStartMs: 0, windowEndMs: 1_000, release: {}, services };
function receipt(kind: "arrival" | "departure", actualTimeMs: number, stopSequence = 0): OperationalPassengerStopReceipt {
  return { schemaVersion: "zugfolge-operational-passenger-stop-receipt/v1", worldId: WORLD, serviceRunId: "service:day",
    trainRunId: "train", stopId: `train:${stopSequence}`, stopSequence, stopPlanHash: PIN,
    routeVersionId: "route", formationVersionId: "formation", kind, actualTimeMs, receiptId: `receipt:${stopSequence}:${kind}` };
}

describe("Native Haltbelege: strikter Eventtransport", () => {
  it("bindet Quittungen an Welt, Halt und native Ereigniszeit und verwirft Zusatzfelder", () => {
    const value = receipt("arrival", 50);
    expect(decodeOperationalPassengerStop("passenger-stop-arrival", JSON.stringify(value), "train", 50, WORLD)).toEqual(value);
    for (const altered of [{ ...value, worldId: OTHER }, { ...value, actualTimeMs: 49 }, { ...value, kind: "departure" },
      { ...value, stopSequence: 100 }, { ...value, stopPlanHash: "wrong" }, { ...value, fareFact: "invalid" }]) {
      expect(() => decodeOperationalPassengerStop("passenger-stop-arrival", JSON.stringify(altered), "train", 50, WORLD)).toThrow();
    }
    const [event] = adaptOperationalDomainEvents([{ kind: "passenger-stop-arrival", eventSequence: 4, commitSequence: 2,
      atMs: 50, subjectId: "train", detail: JSON.stringify(value) }], [], [], "north", WORLD);
    expect(event).toMatchObject({ eventType: "operations.passenger-stop-arrival", payload: { worldId: WORLD, regionId: "north",
      nativeEventSequence: 4, commitSequence: 2, actualTimeMs: 50, stopId: "train:0" } });
  });
});

describe("Nachfrageconsumer: Journalcursor und atomare Zeitgrenzen (Transportfixture)", () => {
  let client: PGlite, db: ReturnType<typeof drizzle<typeof schema>>;
  const evaluated: Readonly<Record<string, unknown>>[] = [];
  const runtime: DemandRuntime = { evaluate(input) {
    evaluated.push(input);
    return { worldId: input["worldId"], periodId: input["periodId"], nowMs: input["nowMs"], revision: input["revision"],
      stateHash: demandHash(input), operationalProgress: input["operationalProgress"] ?? null, choices: [] };
  } };
  const bindings = () => ["north", "south"].map((regionId) => ({ worldId: WORLD, regionId, initializationHash: PIN }));
  const state = (regionId: string, nowMs: number, eventSequence: number) => ({ world: { worldId: WORLD, regionId, nowMs, eventSequence },
    commandReceipts: Object.fromEntries(Array.from({ length: eventSequence }, (_, index) => [`fixture:${index + 1}`, { commandHash: PIN, appliedRevision: index + 1 }])) });
  beforeEach(async () => {
    evaluated.length = 0;
    client = new PGlite(); db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([WORLD, OTHER].map((id) => ({ id, name: id, schedulePeriodWeeks: 3, epoch: new Date(0) })));
    await db.insert(regionalSimulationStates).values(bindings().map(({ regionId }) => ({ worldId: WORLD, regionId,
      initializationHash: PIN, stateSchema: "zugfolge-operational-simulation-state/v2", state: state(regionId, 0, 0),
      stateHash: PIN, revision: 0, publisherSequence: 0, createdAt: new Date(0), updatedAt: new Date(0) })));
  });
  afterEach(async () => { await client.close(); });
  async function region(regionId: string, nowMs: number, eventSequence: number) {
    await db.update(regionalSimulationStates).set({ state: state(regionId, nowMs, eventSequence), revision: eventSequence, publisherSequence: eventSequence })
      .where(and(eq(regionalSimulationStates.worldId, WORLD), eq(regionalSimulationStates.regionId, regionId)));
  }
  async function append(value: OperationalPassengerStopReceipt, nativeSequence: number, regionId = "north") {
    const [adapted] = adaptOperationalDomainEvents([{ kind: `passenger-stop-${value.kind}`, atMs: value.actualTimeMs, subjectId: value.trainRunId,
      detail: JSON.stringify(value), eventSequence: nativeSequence, commitSequence: nativeSequence }], [], [], regionId, WORLD);
    const events = await db.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, WORLD));
    await db.insert(domainEvents).values({ worldId: WORLD, sequence: Math.max(0, ...events.map((event) => event.sequence)) + 1,
      eventType: adapted!.eventType, payload: adapted!.payload, occurredAt: new Date(value.actualTimeMs) });
  }
  function consumer() { return new DemandProgressConsumer(db, runtime, bindings); }
  function advance() { return consumer().advance(template, services, PIN, new Date(0), {}); }

  it("behält Belege der vorauslaufenden Region nach Restore und schließt die gleiche Zeitgrenze erst beim nächsten Advance", async () => {
    await advance();
    await region("north", 1_000, 2); await region("south", 800, 0);
    await append(receipt("arrival", 0), 1); await append(receipt("departure", 800), 2);
    const waiting = await advance();
    expect(waiting.input["nowMs"]).toBe(799);
    expect(waiting.progressCursor?.["pendingReceipts"]).toEqual([receipt("departure", 800)]);
    expect(demandList(demandRecord(waiting.result["operationalProgress"])["trains"])[0]?.["stops"])
      .toEqual([{ stopId: "train:0", actualArrivalMs: 0, actualDepartureMs: null }]);
    const restored = await new DemandStore(db, runtime).latest(WORLD, PIN);
    expect(restored).toEqual(waiting);
    await region("south", 900, 0);
    const progressed = await advance();
    expect(progressed.progressCursor?.["pendingReceipts"]).toEqual([]);
    expect(evaluated.some((input) => input["nowMs"] === 800 && input["previousEvaluation"] !== undefined)).toBe(true);
    const beforeCount = (await db.select().from(domainEvents)).length;
    expect(await advance()).toEqual(progressed);
    expect(await db.select().from(domainEvents)).toHaveLength(beforeCount);
    expect(await new DemandStore(db, runtime).latest(OTHER)).toBeUndefined();
  });

  it("erfindet durch Sollzeit oder Signalhalt keinen Einsteiger und verwirft widersprüchliche Wiederholung atomar", async () => {
    await advance(); await region("north", 1_000, 1); await region("south", 1_000, 0);
    const clockOnly = await advance();
    expect(clockOnly.result["operationalProgress"]).toBeNull();
    await append(receipt("arrival", 1_000), 1);
    await region("north", 1_001, 1); await region("south", 1_001, 0);
    const before = await advance();
    await append({ ...receipt("arrival", 1_000), receiptId: "different", stopPlanHash: "b".repeat(64) }, 2);
    await region("north", 1_002, 2); await region("south", 1_002, 0);
    await expect(advance()).rejects.toThrow(/wiederholt|Haltbindungen/u);
    expect(await new DemandStore(db, runtime).latest(WORLD, PIN)).toEqual(before);
  });

  it("verweigert einen späten Anfang, fremde Regionspins und einen beschädigten Cursor", async () => {
    await region("north", 900, 0); await region("south", 900, 0);
    await expect(advance()).rejects.toThrow("vor der ersten Abfahrt");
    expect(await db.select().from(domainEvents)).toHaveLength(0);
    await region("north", 0, 0); await region("south", 0, 0);
    await advance();
    const foreign = new DemandProgressConsumer(db, runtime, () => bindings().map((binding) => ({ ...binding, initializationHash: "b".repeat(64) })));
    await expect(foreign.advance(template, services, PIN, new Date(0), {})).rejects.toThrow("Initialisierungspin");
    await region("north", 2, 0); await region("south", 2, 0);
    const checkpoint = await advance();
    const events = await db.select().from(domainEvents);
    await db.insert(domainEvents).values({ worldId: WORLD, sequence: Math.max(...events.map((event) => event.sequence)) + 1,
      eventType: "demand.evaluated", occurredAt: new Date(2), payload: { ...checkpoint, progressCursor: { ...checkpoint.progressCursor, receiptSetHash: "tampered" } } });
    await expect(new DemandStore(db, runtime).latest(WORLD, PIN)).rejects.toThrow("Herkunft");
  });

  it.skipIf(process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] === undefined && process.env["ZUGFOLGE_DEMAND_TEST_BINARY"] === undefined)(
    "führt synthetische Journalbelege durch echten Rust fort und restauriert das gefahrene Manifest bitgleich", async () => {
      const binary = process.env["ZUGFOLGE_DEMAND_TEST_BINARY"];
      const native = binary === undefined ? loadDemandRuntime() : demandRuntimeFromAddon({ evaluatePassengerDemand(input) {
        const result = spawnSync(binary, [], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout;
      } });
      const input = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/evaluation.json", import.meta.url), "utf8"));
      input.worldId = WORLD;
      for (const service of input.services) service.worldId = WORLD;
      for (const alternative of input.alternatives) alternative.worldId = WORLD;
      const service = input.services[0];
      const actualConsumer = () => new DemandProgressConsumer(db, native, bindings);
      const run = () => actualConsumer().advance(input, input.services, PIN, new Date(0), {});
      const initial = await run();
      const firstManifest = demandList(initial.result["manifests"])[0]!;
      expect(demandList(firstManifest["passengers"]).length).toBeGreaterThan(0);
      await region("north", 600_001, 2); await region("south", 600_001, 0);
      await append({ ...receipt("arrival", 0), trainRunId: service.trainRunId, stopId: service.stops[0].stopId }, 1);
      await append({ ...receipt("departure", 600_000), trainRunId: service.trainRunId, stopId: service.stops[0].stopId }, 2);
      const running = await run();
      expect(running.result["projectionMode"]).toBe("progress_bound");
      const preserved = demandList(running.result["manifests"]).find((manifest) => manifest["segmentId"] === firstManifest["segmentId"]);
      expect(preserved?.["passengers"]).toEqual(firstManifest["passengers"]);
      await region("north", 2_000_001, 3); await region("south", 2_000_001, 0);
      await append({ ...receipt("arrival", 2_000_000, 1), trainRunId: service.trainRunId, stopId: service.stops[1].stopId }, 3);
      const delayed = await run();
      expect(demandList(delayed.result["manifests"]).find((manifest) => manifest["segmentId"] === firstManifest["segmentId"])?.["passengers"])
        .toEqual(firstManifest["passengers"]);
      expect(await new DemandStore(db, native).latest(WORLD, PIN)).toEqual(delayed);
    }, 30_000);
});
