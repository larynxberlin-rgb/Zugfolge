import { PGlite } from "@electric-sql/pglite";
import { domainEvents, MIGRATIONS_FOLDER, operators, regionalSimulationStates, simulationCommands, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { requestWorldAccess } from "@zugfolge/identity";
import { demandRuntimeFromAddon, loadDemandRuntime } from "@zugfolge/runtime-native";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDemandOfferHistory } from "./demand-offer-history.js";
import { DemandProgressConsumer } from "./demand-progress.js";
import { pinDemandPoolSeeds } from "./demand-pool-seeds.js";
import { DemandStore, demandHash, demandList } from "./demand-store.js";
import { adaptOperationalDomainEvents } from "./operational-domain-event-adapter.js";
import { loadCommittedSpfvServices } from "./spfv-demand-projection.js";

const WORLD = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const OPERATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", PIN = "a".repeat(64);
const nativeIt = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined || process.env["ZUGFOLGE_DEMAND_TEST_BINARY"] !== undefined ? it : it.skip;
function nativeRuntime() {
  const binary = process.env["ZUGFOLGE_DEMAND_TEST_BINARY"];
  return binary === undefined ? loadDemandRuntime() : demandRuntimeFromAddon({ evaluatePassengerDemand(input) {
    const result = spawnSync(binary, [], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  } });
}

describe("Kausale Angebotshistorie: gepinnte Transportbelege, echter Rust-Nachfragekern", () => {
  let client: PGlite, db: ReturnType<typeof drizzle<typeof schema>>, accountId: string, sequence: number, nativeSequence: number;
  let template: Record<string, any>;
  const bindings = () => [{ worldId: WORLD, regionId: "north", initializationHash: PIN }];
  beforeEach(async () => {
    client = new PGlite(); db = drizzle(client, { schema }); sequence = 0; nativeSequence = 0;
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([WORLD, OTHER].map((id) => ({ id, name: "Explizite Angebotshistorienfixture", schedulePeriodWeeks: 3, epoch: new Date(0) })));
    const access = await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "offer-history", displayName: "Fixture" });
    accountId = access.id;
    await db.insert(operators).values({ id: OPERATOR, worldId: WORLD, foundingAccountId: accountId, name: "Fixture-Verkehr" });
    await db.insert(regionalSimulationStates).values({ worldId: WORLD, regionId: "north", initializationHash: PIN,
      stateSchema: "zugfolge-operational-simulation-state/v2", state: { world: { worldId: WORLD, nowMs: 0, eventSequence: 0 } },
      stateHash: PIN, revision: 0, publisherSequence: 0, createdAt: new Date(0), updatedAt: new Date(0) });
    template = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/evaluation.json", import.meta.url), "utf8"));
    template.worldId = WORLD; template.windowEndMs = 60_000; template.alternatives = []; template.daySliceId = "pooled";
    template.generationWindows = [{ windowStartMs: 0, windowEndMs: 500, daySliceId: "morning" },
      { windowStartMs: 500, windowEndMs: 60_000, daySliceId: "empty" }];
    template.release.zones = template.release.zones.filter((zone: any) => zone.id !== "halle");
    template.release.daySlices = [{ id: "morning", startOffsetMs: 0, endOffsetMs: 500, shareBasisPoints: 10_000 },
      { id: "empty", startOffsetMs: 500, endOffsetMs: 60_000, shareBasisPoints: 0 },
      { id: "rest", startOffsetMs: 60_000, endOffsetMs: 86_400_000, shareBasisPoints: 0 }];
    template.release.maxTransfers = 0;
    const base = template.services[1]; base.worldId = WORLD; base.trainRunId = "reference"; base.operatorId = OPERATOR; base.mode = "spnv";
    base.stops = base.stops.map((stop: any, index: number) => ({ ...stop, stopId: `reference:${index}`, arrivalMs: 50_000 + index * 300_000, departureMs: 50_000 + index * 300_000 }));
    base.capacity.standardSeats = 200; base.serviceIntervalMs = 0;
    template.services = [base];
  }, 30_000);
  afterEach(async () => { await client.close(); });
  async function event(type: string, payload: unknown, atMs = 0) {
    const head = await db.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, WORLD));
    sequence = head.reduce((max, row) => Math.max(max, row.sequence), 0) + 1;
    await db.insert(domainEvents).values({ worldId: WORLD, sequence, eventType: type, payload, occurredAt: new Date(atMs) });
  }
  // The transport fixtures bind requests/owners/previews exactly like the
  // productive adapter. Native planner acceptance has its own NAPI E2E.
  async function submitted(id: string, departureS: number, fareCents: string) {
    const draft = { lineId: id, name: id, stopIds: ["leipzig-hbf", "erfurt-hbf"], headwayS: 60, fareCents,
      formationId: "formation", validFromS: departureS, validUntilS: departureS + 60, referenceTrainId: "reference" };
    const body = { schemaVersion: "zugfolge-spfv-preview/v1", worldId: WORLD, operatorId: OPERATOR, lineId: id, draft,
      fleetStateHash: PIN, capacityFacts: { standardSeats: 200, premiumSeats: 0, bicycleSpaces: 1, wheelchairSpaces: 1 } };
    const previewId = demandHash(body);
    await event("spfv.preview", { ...body, previewId, accountId });
    const payload = { schemaVersion: "planning.path-request/v4", worldId: WORLD, operatorId: OPERATOR, requestingAccountId: accountId,
      trainId: id, formationId: "formation", fleetStateHash: PIN, trainCategory: "long-distance", desiredDepartureS: departureS,
      serviceWindow: { validFromS: departureS, validUntilS: departureS + 1 } };
    const [request] = await db.insert(simulationCommands).values({ worldId: WORLD, requestingAccountId: accountId, idempotencyKey: `request:${id}`,
      commandType: "planning.path-request", payload, submittedAt: new Date(0), status: "processed", resultEventSequence: 0 }).returning();
    const [coordinate] = await db.insert(simulationCommands).values({ worldId: WORLD, requestingAccountId: accountId, idempotencyKey: `coordinate:${id}`,
      commandType: "planning.coordinate", payload: { worldId: WORLD, requestCommandIds: [request!.id] }, submittedAt: new Date(0), status: "processed", resultEventSequence: 0 }).returning();
    await event("spfv.submitted", { worldId: WORLD, operatorId: OPERATOR, accountId, lineId: id, previewId, draft,
      submission: { worldId: WORLD, operatorId: OPERATOR, lineId: id, previewId, status: "submitted", planningRequestIds: [request!.id], planningCoordinationId: coordinate!.id } });
    return { requestId: request!.id, coordinateId: coordinate!.id, reservation: { train: { id }, serviceWindow: payload.serviceWindow,
      passengerStops: [{ stationId: "leipzig-hbf", arrivalS: departureS, departureS }, { stationId: "erfurt-hbf", arrivalS: departureS + 300, departureS: departureS + 300 }] } };
  }
  async function committed(reservations: Record<string, unknown>, atMs: number, revision: number, newCommands: readonly string[] = []) {
    const projection = { worldId: WORLD, projectionRevision: revision };
    const state = { schemaVersion: "zugfolge-planning-runtime-state/v1", worldId: WORLD, projectionRevision: revision, projection, reservations };
    await event("planning.runtime-state", { schemaVersion: "planning-runtime-state-event/v1", worldId: WORLD, projectionRevision: revision, stateHash: demandHash(state), state }, atMs);
    await event("planning.diagram", projection, atMs);
    for (const id of newCommands) await db.update(simulationCommands).set({ resultEventSequence: sequence }).where(eq(simulationCommands.id, id));
    return sequence;
  }
  async function region(atMs: number) {
    await db.update(regionalSimulationStates).set({ state: { world: { worldId: WORLD, nowMs: atMs, eventSequence: nativeSequence },
      commandReceipts: Object.fromEntries(Array.from({ length: nativeSequence }, (_, index) => [`fixture:${index + 1}`, { commandHash: PIN, appliedRevision: index + 1 }])) },
      revision: nativeSequence, publisherSequence: nativeSequence }).where(eq(regionalSimulationStates.worldId, WORLD));
  }
  async function receipt(trainRunId: string, kind: "arrival" | "departure", atMs: number) {
    const value = { schemaVersion: "zugfolge-operational-passenger-stop-receipt/v1", worldId: WORLD, serviceRunId: `${trainRunId}:day:0`,
      trainRunId, stopId: `${trainRunId}:0`, stopSequence: 0, stopPlanHash: PIN, routeVersionId: "route", formationVersionId: "formation",
      kind, actualTimeMs: atMs, receiptId: `${trainRunId}:${kind}` };
    const [adapted] = adaptOperationalDomainEvents([{ kind: `passenger-stop-${kind}`, atMs, subjectId: trainRunId, detail: JSON.stringify(value),
      eventSequence: ++nativeSequence, commitSequence: nativeSequence }], [], [], "north", WORLD);
    await event(adapted!.eventType, adapted!.payload, atMs);
  }
  async function offers() { return loadCommittedSpfvServices(db, WORLD, template.services, { windowStartMs: 0, windowEndMs: 60_000 }); }
  const count = (result: Readonly<Record<string, unknown>>, id: string) => demandList(result["choices"])
    .filter((choice) => demandList(choice["trains"]).some((train) => train["trainRunId"] === id))
    .reduce((sum, choice) => sum + Number(choice["passengers"]), 0);

  it("bindet historische Diagramme und tatsächliche Commitzeiten statt der Antragszeit", async () => {
    const a = await submitted("a", 30, "100"), b = await submitted("b", 20, "200");
    const first = await committed({ a: a.reservation, b: b.reservation }, 100, 1, [a.requestId, a.coordinateId, b.requestId, b.coordinateId]);
    const second = await committed({ b: b.reservation }, 1_000, 2);
    const history = await loadDemandOfferHistory(db, WORLD, template, first, second, 0);
    expect(history.map((revision) => revision.effectiveAtMs)).toEqual([100, 1_000]);
    expect(history[0]!.services.map((service) => service["trainRunId"])).toEqual(["reference", "a", "b"]);
    expect(history[1]!.services.map((service) => service["trainRunId"])).toEqual(["reference", "b"]);
    await expect(loadDemandOfferHistory(db, OTHER, template, 0, second)).rejects.toThrow("fremde Welt");
    await expect(loadCommittedSpfvServices(db, WORLD, template.services, undefined, first - 1)).rejects.toThrow("atomaren Commit");
    const invalid = await committed({}, -1, 3);
    await expect(loadDemandOfferHistory(db, WORLD, template, second, invalid)).rejects.toThrow("sichere Ganzzahl");
  });

  nativeIt.each([1_000, 25_000])("revidiert Ersatzfahrgäste kausal bei Commit %i; Catch-up und Restore erhalten native Ergebnisse", async (changedAtMs) => {
    const runtime = nativeRuntime();
    const consumer = () => new DemandProgressConsumer(db, runtime, bindings);
    const advance = async () => { const accepted = await offers(); return consumer().advance(template,
      [...template.services, ...accepted.services], PIN, new Date(0), accepted.provenance); };
    await advance();
    const a = await submitted("a", 30, "100"), b = await submitted("b", 20, "200");
    await committed({ a: a.reservation, b: b.reservation }, 0, 1, [a.requestId, a.coordinateId, b.requestId, b.coordinateId]);
    await region(1); const initial = await advance();
    expect(count(initial.result, "a")).toBeGreaterThan(0);
    if (changedAtMs < 20_000) await committed({ b: b.reservation }, changedAtMs, 2);
    await receipt("b", "arrival", 0); await receipt("b", "departure", 20_000);
    if (changedAtMs > 20_000) await committed({ b: b.reservation }, changedAtMs, 2);
    await region(26_000);
    const after = await advance();
    if (changedAtMs < 20_000) expect(count(after.result, "b")).toBeGreaterThan(0);
    else expect(count(after.result, "b")).toBe(0);
    expect(demandList(after.input["services"]).find((service) => service["trainRunId"] === "a")?.["cancelled"]).toBe(true);
    expect(await new DemandStore(db, runtime).latest(WORLD, PIN)).toEqual(after);
    expect(await advance()).toEqual(after);
  }, 30_000);

  nativeIt.each(["before", "after"] as const)("ordnet gleichzeitigen Angebotscommit %s Abfahrt nach Weltsequenz", async (ordering) => {
    const runtime = nativeRuntime();
    const advance = async () => { const accepted = await offers(); return new DemandProgressConsumer(db, runtime, bindings).advance(template,
      [...template.services, ...accepted.services], PIN, new Date(0), accepted.provenance); };
    await advance();
    const a = await submitted("a", 30, "100"), b = await submitted("b", 20, "200");
    await committed({ a: a.reservation, b: b.reservation }, 0, 1, [a.requestId, a.coordinateId, b.requestId, b.coordinateId]);
    await region(1); await advance(); await receipt("b", "arrival", 0);
    if (ordering === "before") await committed({ b: b.reservation }, 20_000, 2);
    await receipt("b", "departure", 20_000);
    if (ordering === "after") await committed({ b: b.reservation }, 20_000, 2);
    await region(20_001); const result = await advance();
    if (ordering === "before") expect(count(result.result, "b")).toBeGreaterThan(0);
    else expect(count(result.result, "b")).toBe(0);
    expect(await new DemandStore(db, runtime).latest(WORLD, PIN)).toEqual(result);
  }, 30_000);

  nativeIt("lädt Planungsstände vor dem Seed, bewahrt das neue vorauseilende Angebot und führt es nach Restore vor seinem ersten Halt ein", async () => {
    const runtime = nativeRuntime();
    const advance = async () => { const accepted = await offers(); return new DemandProgressConsumer(db, runtime, bindings).advance(template,
      [...template.services, ...accepted.services], PIN, new Date(0), accepted.provenance); };
    const a = await submitted("a", 30, "100");
    await committed({ a: a.reservation }, 0, 1, [a.requestId, a.coordinateId]);
    const b = await submitted("b", 20, "200");
    await committed({ b: b.reservation }, 1_000, 2, [b.requestId, b.coordinateId]);
    // Beide Commits liegen vor dem Seedcursor. Die Region steht noch bei0;
    // ausschließlich der erste Planungsstand ist zu dieser Zeit wirksam.
    await pinDemandPoolSeeds(db, runtime, WORLD, [template], PIN, new Date(0), bindings());
    await region(500); const waiting = await advance();
    expect(waiting.progressCursor?.["pendingOffers"]).toHaveLength(1);
    expect(count(waiting.result, "a")).toBeGreaterThan(0);
    expect(count(waiting.result, "b")).toBe(0);
    expect(await new DemandStore(db, runtime).latest(WORLD, PIN)).toEqual(waiting);
    await receipt("b", "arrival", 1_000); await receipt("b", "departure", 20_000); await region(20_001);
    const after = await advance();
    expect(after.progressCursor?.["pendingOffers"]).toEqual([]);
    expect(count(after.result, "b")).toBeGreaterThan(0);
    expect(await advance()).toEqual(after);
  }, 30_000);

  nativeIt("weist einen unhistorisierten Snapshot-Ausfall atomar zurück", async () => {
    const runtime = nativeRuntime();
    await expect(new DemandProgressConsumer(db, runtime, bindings).advance(template,
      template.services.map((service: any) => ({ ...service, cancelled: true })), PIN, new Date(0), {}))
      .rejects.toThrow("keinen zeitgebundenen autoritativen Beleg");
    expect(await new DemandStore(db, runtime).latest(WORLD)).toBeUndefined();
    expect(await db.select().from(domainEvents)).toEqual([]);
  }, 30_000);
});
