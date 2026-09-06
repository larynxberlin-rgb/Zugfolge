import { PGlite } from "@electric-sql/pglite";
import { domainEvents, MIGRATIONS_FOLDER, regionalSimulationStates, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { demandRuntimeFromAddon, loadDemandRuntime, type DemandRuntime } from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMAND_POPULATION_EVENT, loadPopulationDataHistory, savePopulationData, type PopulationRevision } from "./demand-population-data.js";
import { loadDemandPoolSeed, pinDemandPoolSeeds } from "./demand-pool-seeds.js";
import { DemandProgressConsumer } from "./demand-progress.js";
import { DemandStore, demandHash, demandInteger, demandList, demandRecord } from "./demand-store.js";
import { adaptOperationalDomainEvents } from "./operational-domain-event-adapter.js";
import type { OperationalPassengerStopReceipt } from "./operational-passenger-stop.js";

const WORLD = "11111111-1111-4111-8111-111111111111", PIN = "a".repeat(64), DAY = 86_400_000;
const bindings = [{ worldId: WORLD, regionId: "north", initializationHash: PIN }];
const nativeAvailable = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined || process.env["ZUGFOLGE_DEMAND_TEST_BINARY"] !== undefined;

function template(startMs = 0): Record<string, unknown> {
  const input = demandRecord(JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/population-evaluation.json", import.meta.url), "utf8")));
  const release = demandRecord(input["release"]);
  release["daySlices"] = [{ id: "instant", startOffsetMs: 0, endOffsetMs: 1, shareBasisPoints: 10_000 },
    { id: "rest", startOffsetMs: 1, endOffsetMs: DAY, shareBasisPoints: 0 }];
  const generationWindows = [{ daySliceId: "instant", windowStartMs: startMs, windowEndMs: startMs + 1 },
    { daySliceId: "rest", windowStartMs: startMs + 1, windowEndMs: startMs + DAY }];
  return { ...input, worldId: WORLD, periodId: `population-period-${startMs}`, windowStartMs: startMs, windowEndMs: startMs + DAY,
    daySliceId: "pooled", generationWindows, services: demandList(input["services"]).map((service) => ({ ...service,
      worldId: WORLD, trainRunId: `${service["trainRunId"]}:${startMs}`, stops: demandList(service["stops"]).map((stop, index) => ({
        ...stop, stopId: `${stop["stopId"]}:${startMs}`, arrivalMs: startMs + index * 1_000, departureMs: startMs + index * 1_000,
      })) })), alternatives: [] };
}

function snapshot(input: Readonly<Record<string, unknown>>, revision: number, effectiveAtMs: number, factor: number): PopulationRevision {
  const release = demandRecord(input["release"]), model = structuredClone(demandRecord(release["populationModel"]));
  for (const settlement of demandList(model["settlements"])) settlement["population"] = demandInteger(settlement["population"]) * factor;
  for (const area of demandList(model["stationAreas"])) {
    for (const allocation of demandList(area["populationAllocations"])) allocation["population"] = demandInteger(allocation["population"]) * factor;
    area["demandClass"] = factor === 0 ? 0 : 1;
  }
  return { schemaVersion: "zugfolge-demand-population-revision/v1", worldId: WORLD, revision, effectiveAtMs, populationModel: model,
    zonePopulations: demandList(release["zones"]).map((zone) => ({ zoneId: String(zone["id"]), population: demandInteger(zone["population"]) * factor })) };
}

describe.skipIf(!nativeAvailable)("Datenrevisionen beim Poolanfang: echte Rust-Nachfrage und PGlite-Journal", () => {
  let client: PGlite, db: ReturnType<typeof drizzle<typeof schema>>, runtime: DemandRuntime, nativeSequence: number;
  beforeEach(async () => {
    const binary = process.env["ZUGFOLGE_DEMAND_TEST_BINARY"];
    runtime = binary === undefined ? loadDemandRuntime() : demandRuntimeFromAddon({ evaluatePassengerDemand(input) {
      const result = spawnSync(binary, [], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(result.stderr); return result.stdout;
    } });
    client = new PGlite(); db = drizzle(client, { schema }); nativeSequence = 0;
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD, name: "Population initialization test", schedulePeriodWeeks: 3, epoch: new Date(0) });
    await db.insert(regionalSimulationStates).values({ worldId: WORLD, regionId: "north", initializationHash: PIN,
      stateSchema: "zugfolge-operational-simulation-state/v2", state: state(0), stateHash: PIN, revision: 0, publisherSequence: 0,
      createdAt: new Date(0), updatedAt: new Date(0) });
  });
  afterEach(async () => { await client.close(); });
  function state(nowMs: number) { return { world: { worldId: WORLD, regionId: "north", nowMs, eventSequence: nativeSequence },
    commandReceipts: Object.fromEntries(Array.from({ length: nativeSequence }, (_, index) => [`fixture:${index + 1}`, { commandHash: PIN, appliedRevision: index + 1 }])) }; }
  async function advanceRegion(nowMs: number) {
    await db.update(regionalSimulationStates).set({ state: state(nowMs), revision: nativeSequence, publisherSequence: nativeSequence })
      .where(and(eq(regionalSimulationStates.worldId, WORLD), eq(regionalSimulationStates.regionId, "north")));
  }
  async function head() {
    const events = await db.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, WORLD));
    return Math.max(0, ...events.map((event) => event.sequence));
  }
  async function dataEvents(input: Readonly<Record<string, unknown>>, snapshots: readonly PopulationRevision[]) {
    const sequence = await head();
    await db.insert(domainEvents).values(snapshots.map((value, index) => ({ worldId: WORLD, sequence: sequence + index + 1,
      eventType: DEMAND_POPULATION_EVENT, occurredAt: new Date(value.effectiveAtMs), payload: {
        schemaVersion: "zugfolge-demand-population-data-event/v1", worldId: WORLD, baseReleaseId: demandRecord(input["release"])["id"],
        sourceRevision: value.revision, commandHash: demandHash(value), snapshot: value, snapshotHash: demandHash(value),
      } })));
  }
  async function saveData(inputs: readonly Readonly<Record<string, unknown>>[], value: PopulationRevision) {
    return db.transaction((tx) => savePopulationData(tx, runtime, { kind: "demand.data.update", schemaVersion: "zugfolge-demand-data-update/v1",
      worldId: WORLD, baseReleaseId: String(demandRecord(inputs[0]!["release"])["id"]), sourceRevision: value.revision,
      populationModel: value.populationModel, zonePopulations: value.zonePopulations }, inputs, value.effectiveAtMs, new Date(value.effectiveAtMs)));
  }
  async function receipt(input: Readonly<Record<string, unknown>>, kind: "arrival" | "departure", atMs: number) {
    const train = demandList(input["services"])[0]!, stop = demandList(train["stops"])[0]!;
    const value: OperationalPassengerStopReceipt = { schemaVersion: "zugfolge-operational-passenger-stop-receipt/v1", worldId: WORLD,
      serviceRunId: "main-service", trainRunId: String(train["trainRunId"]), stopId: String(stop["stopId"]), stopSequence: 0,
      stopPlanHash: PIN, routeVersionId: "route", formationVersionId: "formation", kind, actualTimeMs: atMs, receiptId: `main-${kind}` };
    nativeSequence += 1;
    const [adapted] = adaptOperationalDomainEvents([{ kind: `passenger-stop-${kind}`, atMs, subjectId: value.trainRunId,
      detail: JSON.stringify(value), eventSequence: nativeSequence, commitSequence: nativeSequence }], [], [], "north", WORLD);
    await db.insert(domainEvents).values({ worldId: WORLD, sequence: await head() + 1, eventType: adapted!.eventType,
      payload: adapted!.payload, occurredAt: new Date(atMs) });
  }
  function run(input: Readonly<Record<string, unknown>>) {
    return new DemandProgressConsumer(db, runtime, () => bindings).advance(input, demandList(input["services"]), PIN, new Date(0), {});
  }

  it("erhält Wünsche und bereits abgefahrene Personen bei einem späteren Save zur selben Weltzeit null", async () => {
    const input = template();
    const [seed] = await pinDemandPoolSeeds(db, runtime, WORLD, [input], PIN, new Date(0), bindings);
    const original = demandList(seed!.result["manifests"])[0]!;
    expect(demandList(original["passengers"]).length).toBeGreaterThan(0);
    expect(demandList(seed!.result["cohorts"]).every((cohort) => cohort["desiredDepartureMs"] === 0)).toBe(true);
    await receipt(input, "arrival", 0); await receipt(input, "departure", 0);
    await dataEvents(input, [snapshot(input, 1, 0, 2)]); await advanceRegion(1);
    const result = await run(input);
    expect(result.result["cohorts"]).toEqual(seed!.result["cohorts"]);
    expect(demandRecord(result.result["totals"])["generated"]).toBe(160);
    expect(demandRecord(result.input["populationRevision"])["revision"]).toBe(1);
    expect(demandList(result.result["manifests"]).find((manifest) => manifest["segmentId"] === original["segmentId"])?.["passengers"])
      .toEqual(original["passengers"]);
    expect(result.progressCursor?.["initialInputHash"]).toBe(seed!.inputHash);
    expect(await loadDemandPoolSeed(db, runtime, WORLD, String(input["periodId"]), PIN)).toEqual(seed);
    expect(await new DemandStore(db, runtime).latest(WORLD, PIN)).toEqual(result);
    expect(await run(input)).toEqual(result);
  }, 30_000);

  it("öffnet einen Folgepool nach mehr als 256 früheren Saves und erhält Änderungen genau am ersten Wunschzeitpunkt", async () => {
    const previous = template(), input = template(DAY);
    const seeds = await pinDemandPoolSeeds(db, runtime, WORLD, [previous, input], PIN, new Date(0), bindings);
    await run(previous);
    const updates = Array.from({ length: 260 }, (_, index) => snapshot(input, index + 1, index + 1, 2));
    updates.push(snapshot(input, 261, DAY, 0));
    await dataEvents(input, updates); await advanceRegion(DAY + 1);
    const result = await run(input);
    expect(demandRecord(result.input["populationRevision"])["revision"]).toBe(261);
    expect(demandRecord(result.result["totals"])["generated"]).toBe(320);
    expect(demandList(result.result["cohorts"]).every((cohort) => cohort["desiredDepartureMs"] === DAY)).toBe(true);
    const firstData = runtime.evaluate({ ...input, nowMs: 260, populationRevision: updates[259] });
    expect(result.result["cohorts"]).toEqual(firstData["cohorts"]);
    expect(result.progressCursor?.["initialInputHash"]).toBe(seeds[1]!.inputHash);
    expect(await loadDemandPoolSeed(db, runtime, WORLD, String(input["periodId"]), PIN)).toEqual(seeds[1]);
    expect(await new DemandStore(db, runtime).latest(WORLD, PIN)).toEqual(result);
    expect(await run(input)).toEqual(result);
  }, 30_000);

  it("übernimmt einen schon vor dem Seed gespeicherten Zahlenstand ausschließlich für vollständig zukünftige Fenster", async () => {
    const input = template(DAY);
    await dataEvents(input, [snapshot(input, 1, 500, 2)]); await advanceRegion(1_000);
    const [seed] = await pinDemandPoolSeeds(db, runtime, WORLD, [input], PIN, new Date(0), bindings);
    expect(demandRecord(seed!.result["totals"])["generated"]).toBe(160);
    await advanceRegion(1_001);
    const result = await run(input);
    expect(demandRecord(result.input["populationRevision"])["revision"]).toBe(1);
    expect(demandRecord(result.result["totals"])["generated"]).toBe(320);
    expect(await loadDemandPoolSeed(db, runtime, WORLD, String(input["periodId"]), PIN)).toEqual(seed);
    expect(await new DemandStore(db, runtime).latest(WORLD, PIN)).toEqual(result);
  }, 30_000);

  it.each([false, true])("hält den 257. noch offenen Save für den Retry zurück (Checkpoint: %s)", async (withCheckpoint) => {
    const input = template();
    if (withCheckpoint) await run(input);
    await dataEvents(input, Array.from({ length: 255 }, (_, index) => snapshot(input, index + 1, 0, 1)));
    expect(await saveData([input], snapshot(input, 256, 0, 1))).toEqual({ outcome: "accepted" });
    const beforeHead = await head();
    await expect(saveData([input], snapshot(input, 257, 0, 1))).rejects.toMatchObject({ statusCode: 503, code: "pending_population_data_limit" });
    expect(await head()).toBe(beforeHead);
    const history = await loadPopulationDataHistory(db, WORLD, String(demandRecord(input["release"])["id"]), 0, beforeHead);
    expect(history).toHaveLength(256);
    expect(history.at(-1)?.snapshot.revision).toBe(256);
  }, 30_000);

  it("fasst vor dem ersten Seed nur reine Zukunftsstände zusammen und begrenzt Stände am ersten Wunschzeitpunkt", async () => {
    const input = template(DAY);
    await dataEvents(input, Array.from({ length: 260 }, (_, index) => snapshot(input, index + 1, index + 1, 1)));
    expect(await saveData([input], snapshot(input, 261, 261, 1))).toEqual({ outcome: "accepted" });
    await dataEvents(input, Array.from({ length: 254 }, (_, index) => snapshot(input, index + 262, DAY, 1)));
    expect(await saveData([input], snapshot(input, 516, DAY, 1))).toEqual({ outcome: "accepted" });
    const beforeHead = await head();
    await expect(saveData([input], snapshot(input, 517, DAY, 1))).rejects.toMatchObject({ statusCode: 503, code: "pending_population_data_limit" });
    expect(await head()).toBe(beforeHead);
    const history = await loadPopulationDataHistory(db, WORLD, String(demandRecord(input["release"])["id"]), 0, beforeHead, DAY - 1);
    expect(history).toHaveLength(256);
    expect(history[0]?.snapshot.revision).toBe(261);
    expect(history.at(-1)?.snapshot.revision).toBe(516);
  }, 30_000);
});
