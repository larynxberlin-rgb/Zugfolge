import { PGlite } from "@electric-sql/pglite";
import { domainEvents, MIGRATIONS_FOLDER, operators, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { requestWorldAccess } from "@zugfolge/identity";
import { LivemapRegistry, type LivemapReadModel } from "@zugfolge/livemap-stream";
import { demandRuntimeFromAddon, loadDemandRuntime, loadOperationalSimulationRuntime,
  operationalSimulationRuntimeFromAddon, OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV,
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY, OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  type OperationalPassengerStopPlan, type OperationalSimulationCommandPayload,
  type OperationalSimulationInitialization, type OperationalTrainInitialization } from "@zugfolge/runtime-native";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import Fastify from "fastify";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { registerDemandRoutes } from "./demand-routes.js";
import { DemandService } from "./demand-service.js";
import { demandHash, demandList, demandRecord, DemandStore } from "./demand-store.js";
import { RegionalSimulationWorker } from "./regional-simulation-worker.js";

const WORLD = "92111111-1111-4111-8111-111111111111", OPERATOR = "92aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REGION = "explicit-three-stop-fixture", INFRA = "explicit-three-stop-infrastructure";
const MAIN = "train:main", CONNECTION = "train:connection";
const STATIONS = ["leipzig-hbf", "halle-hbf", "erfurt-hbf"];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const nativeIt = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined
  || process.env["ZUGFOLGE_OPERATIONAL_TEST_BINARY"] !== undefined ? it : it.skip;

// CI uses the actual NAPI addon. The optional local transport executes the same
// Rust entry points on platforms without a loadable addon; it supplies no facts.
function runtimes() {
  if (process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined)
    return { operational: loadOperationalSimulationRuntime(), demand: loadDemandRuntime() };
  const call = (method: string, ...args: string[]) => {
    const result = spawnSync(process.env["ZUGFOLGE_OPERATIONAL_TEST_BINARY"]!, [], {
      input: JSON.stringify({ method, args }), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(result.stderr || `Rust transport exited ${result.status}`);
    return result.stdout.trim();
  };
  return { operational: operationalSimulationRuntimeFromAddon({
    initializeOperationalSimulation: (...args) => call("initialize", ...args),
    restoreOperationalSimulation: (...args) => call("restore", ...args),
    applyOperationalSimulationCommand: (...args) => call("apply", ...args),
    applyOperationalSimulationCommandBatch: (...args) => call("batch", ...args),
    hashOperationalSimulationCommand: (...args) => call("hash", ...args),
  }), demand: demandRuntimeFromAddon({ evaluatePassengerDemand: (...args) => call("demand", ...args) }) };
}

async function fixture(directory: string) {
  const bindingModule = await import(new URL("../../../tools/region-import/operational-infrastructure-binding.mjs", import.meta.url).href);
  const stopModule = await import(new URL("../../../tools/region-import/passenger-stop-binding-v1.mjs", import.meta.url).href);
  const routes: Record<string, any> = {}, interlocking: Record<string, any> = {};
  const edges: Record<string, number> = { "edge:a": 60_000, "edge:b": 60_000, "edge:connection": 120_000 };
  const platforms: Record<string, any> = {
    "platform:a": { edgeId: "edge:a", direction: "along", fromMm: 0, toMm: 20_000 },
    "platform:b": { edgeId: "edge:a", direction: "along", fromMm: 25_000, toMm: 45_000 },
    "platform:c": { edgeId: "edge:b", direction: "against", fromMm: 0, toMm: 20_000 },
    "platform:connection:b": { edgeId: "edge:connection", direction: "along", fromMm: 0, toMm: 20_000 },
    "platform:connection:c": { edgeId: "edge:connection", direction: "along", fromMm: 110_000, toMm: 120_000 },
  };
  const blocks: string[] = [], signals: string[] = [];
  for (const [name, parts] of [
    ["main", [["edge:a", "along", 0, 10_000], ["edge:a", "along", 10_000, 30_000],
      ["edge:a", "along", 30_000, 60_000], ["edge:b", "against", 60_000, 0]]],
    ["connection", [["edge:connection", "along", 0, 10_000], ["edge:connection", "along", 10_000, 120_000]]],
  ] as const) {
    let start = 0;
    const legs = parts.map(([edgeId, direction, entry, exit], index) => {
      const end = start + Math.abs(exit - entry), block = `block:${name}:${index}`, signal = `signal:${name}:${index}`;
      blocks.push(block, `overlap:${name}:${index}`, `flank:${name}:${index}`); signals.push(signal);
      const id = `interlocking:${name}:${index}`;
      interlocking[id] = { id, routeTemplateId: `template:${name}`, authorityStartRouteMm: start,
        authorityEndRouteMm: end, releaseAfterTailRouteMm: end, signalId: signal, movementKind: "train",
        pathResources: [block], overlapResources: [`overlap:${name}:${index}`], flankResources: [`flank:${name}:${index}`], switchPositions: {} };
      const leg = { edgeId, direction, edgeEntryMm: entry, edgeExitMm: exit, routeStartMm: start,
        blockIds: [block], speedLimitMmps: 20_000, gradientPerMille: 0,
        availableProtectionSystems: ["pzb"], simultaneouslyRequiredProtectionSystems: [] };
      start = end; return leg;
    });
    routes[`route:${name}`] = { id: `route:${name}`, templateId: `template:${name}`, predecessorId: null, transitionRouteMm: null, legs };
  }
  const infrastructure = { id: INFRA, directedEdges: edges, edgeGeometries: Object.fromEntries(Object.entries(edges).map(([edge, length], index) =>
    [edge, [{ edgeOffsetMm: 0, latitudeE7: 510_000_000 + index * 100_000, longitudeE7: 120_000_000, bearingMilliDegrees: 90_000 },
      { edgeOffsetMm: length, latitudeE7: 510_000_000 + index * 100_000, longitudeE7: 120_100_000, bearingMilliDegrees: null }]])),
    routeVersions: routes, interlockingRoutes: interlocking, signals: signals.sort(), switches: [], blockResources: blocks.sort(),
    platformIntervals: platforms, regionBoundaries: [], rzueLayoutId: "explicit-fixture-layout" };
  const json = `${bindingModule.canonicalOperationalInfrastructureV2Json(infrastructure)}\n`;
  writeFileSync(join(directory, "operational-infrastructure-v2.json"), json);
  const binding = { schemaVersion: "zugfolge-operational-infrastructure-binding/v2" as const, infraReleaseId: INFRA,
    file: "operational-infrastructure-v2.json" as const, bytes: Buffer.byteLength(json), sha256: sha(json),
    stateHash: bindingModule.operationalInfrastructureV2StateHash(infrastructure) as string };
  const trains: OperationalTrainInitialization[] = ["main", "connection"].map((name, index) => {
    const main = index === 0;
    const stops = main ? [[0, 1], [10, 15], [30, 30]] : [[12, 12], [24, 24]];
    const route = routes[`route:${name}`];
    const anchorFacts = main ? [["edge:a", "along", 10_000, 0], ["edge:a", "along", 40_000, 30_000],
      ["edge:b", "against", 0, 110_000]] : [["edge:connection", "along", 10_000, 0], ["edge:connection", "along", 120_000, 110_000]];
    const anchors = anchorFacts.map(([edgeId, direction, offsetMm, routeMm], sequence) => ({ stationId: STATIONS[sequence + (main ? 0 : 1)],
      stopSequence: sequence + 4, edgeId, direction, offsetMm, routeMm, sourceEdgeId: edgeId, sourceOffsetMm: offsetMm }));
    const train = { id: `train:${name}`, trainNumber: `RB ${index + 1}`, operatorId: OPERATOR, movementKind: "train" as const,
      routeVersionId: route.id, formationVersionId: `formation:${name}`, headRouteMm: 10_000,
      scheduledDepartureMs: stops[0]![1]! * 1000, publicPassengerStop: true,
      dispatchInterlockingRouteId: `interlocking:${name}:1`,
      protectionModeSelectionRuns: [{ throughRouteLegIndex: route.legs.length - 1, selectedProtectionSystem: "pzb" as const }] };
    const stopPlan = stopModule.bindPassengerStopPlan({ passenger: { trainRunId: train.id, formationVersionId: train.formationVersionId,
      formationLengthMm: 10_000, serviceOutcome: { serviceId: train.id, serviceRunId: `${train.id}:day:0` } }, materialization: train,
      timetableRoute: { routeVersionId: `base:${name}`, legs: route.legs.slice(1), passengerStopAnchors: anchors },
      timetableStops: stops.map(([arrivalS, departureS], sequence) => ({ stopId: anchors[sequence]!.stationId,
        stopSequence: sequence + 4, arrivalS, departureS })), infrastructure: { routes: new Map(Object.entries(routes)), platforms: new Map(Object.entries(platforms)) },
      worldId: WORLD, infrastructureReleaseId: INFRA, timetableReleaseId: "explicit-ordered-stop-fixture",
      sourcePins: { gtfsSnapshotSha256: sha(JSON.stringify(stops)), timetableRoutesSha256: sha(JSON.stringify(anchors)),
        infrastructureStateHash: binding.stateHash, movementRouteStateHash: binding.stateHash } }) as OperationalPassengerStopPlan;
    expect(stopPlan?.stops).toHaveLength(main ? 3 : 2);
    return { ...train, stopPlan };
  });
  const initialization: OperationalSimulationInitialization = { schemaVersion: OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
    worldId: WORLD, regionId: REGION, nowMs: 0, repeatEveryMs: null,
    protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY, infraRelease: binding,
    vehicleTypes: [{ powered: true, vehicleType: { id: "type:fixture", lengthMm: 10_000, massKg: 80_000, maximumSpeedMmps: 20_000,
      powerWatts: 4_000_000, startingTractiveForceNewtons: 240_000, maximumAccelerationMmps2: 1000,
      serviceBrakeMmps2: 1000, emergencyBrakeMmps2: 1500, protectionSystems: ["pzb"] } }],
    vehicles: ["main", "connection"].map((name) => ({ id: `vehicle:${name}`, typeId: "type:fixture", powered: true, orientation: "along",
      condition: { mechanicsBasisPoints: 9500, driveBasisPoints: 9500, brakesBasisPoints: 9500, kilometresSinceMaintenance: 0,
        operatingHoursSinceMaintenance: 0, openObservations: 0 }, restrictions: {}, history: [] })),
    formations: ["main", "connection"].map((name) => ({ id: `formation:${name}`, predecessorId: null, vehicleIds: [`vehicle:${name}`] })),
    trains, movementContinuations: [] };
  const input = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/evaluation.json", import.meta.url), "utf8"));
  input.worldId = WORLD; input.windowEndMs = 500; input.release.minimumTransferMs = 500;
  input.release.daySlices = [{ id: "morning", startOffsetMs: 0, endOffsetMs: 500, shareBasisPoints: 10000 },
    { id: "rest", startOffsetMs: 500, endOffsetMs: 86_400_000, shareBasisPoints: 0 }];
  const service = input.services[0];
  input.services = trains.map((train, index) => ({ ...structuredClone(service), worldId: WORLD, operatorId: OPERATOR, trainRunId: train.id,
    stops: train.stopPlan!.stops.map((stop) => ({ stopId: stop.stopId, stationId: stop.stationId,
      arrivalMs: stop.scheduledArrivalMs, departureMs: stop.scheduledDepartureMs, passengerStop: true })),
    fares: [{ ...service.fares[0], id: `fare:${index}`, centsPerSegment: index === 0 ? 300 : 100 }],
    capacity: { ...service.capacity, standardSeats: 200, standardStanding: 0 } }));
  input.alternatives = [];
  return { initialization, input };
}

nativeIt("bindet echte Drei-Halt-Belege, Signalstörung, Anschlussverlust, Restore und HTTP ohne Fortschrittsmock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zugfolge-demand-native-"));
  const oldRoots = process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
  const client = new PGlite(), db = drizzle(client, { schema }), app = Fastify();
  try {
    const { initialization, input } = await fixture(directory);
    process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = JSON.stringify({ [INFRA]: directory });
    const native = runtimes(), livemap = new LivemapRegistry();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD, name: "Explizites synthetisches Drei-Halt-Szenario", epoch: new Date(0), schedulePeriodWeeks: 3 });
    const account = await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "three-stop-owner", displayName: "Test" });
    await db.insert(operators).values({ id: OPERATOR, worldId: WORLD, foundingAccountId: account.id, name: "Testverkehr" });
    let worker = new RegionalSimulationWorker(db, native.operational, livemap);
    const initialized = await worker.initialize(initialization, new Date(0));
    const readModel = { async getConfig() { return { infrastructureReleaseId: INFRA }; },
      async getScheduledCall(worldId: string, stationId: string, trainId: string, timeS: number, kind: string) {
        return worldId === WORLD && input.services.find((train: any) => train.trainRunId === trainId)?.stops.some((stop: any) =>
          stop.stationId === stationId && stop[kind === "arrival" ? "arrivalMs" : "departureMs"] === timeS * 1000) ? { trainId } : undefined;
      } } as unknown as LivemapReadModel;
    const dependencies = { db, runtime: native.demand, deployment: { schemaVersion: "zugfolge-demand-deployment/v1" as const,
      worldId: WORLD, infrastructureReleaseId: INFRA, windows: [input] }, deploymentHash: demandHash(input), readModel, livemap,
      infrastructure: [], operationalRegions: () => worker.readyRegions() };
    let demand = new DemandService(dependencies);
    const apply = (id: string, command: OperationalSimulationCommandPayload) => worker.apply({ worldId: WORLD, regionId: REGION,
      commandId: id, command }, new Date(0));
    const refresh = () => demand.prepareOperationalCycle(new Date(0));
    const receipts = async () => (await db.select().from(domainEvents).where(eq(domainEvents.worldId, WORLD)))
      .filter((event) => event.eventType.startsWith("operations.passenger-stop-")).map((event) => demandRecord(event.payload));
    const dispatch = (trainId: string, route: string) => ({ trainId, interlockingRouteId: route, committedRank: 0,
      timetableDeviationMs: 0, passengerImpact: 0, contractualImpact: 0, networkImpact: 0, resourceConsequence: 0, recoveryRank: 0, waitingSinceMs: 0 });
    // Persist the allocation before any train can depart. Every later progress
    // object must originate in the native journal through the real consumer.
    await refresh();
    const initial = await demand.checkpoint(WORLD);
    const connecting = demandList(initial.result["choices"]).filter((choice) => demandList(choice["trains"]).length === 2);
    expect(connecting.length).toBeGreaterThan(0);
    for (const train of initialization.trains) await apply(`materialize:${train.id}`, { type: "materialize", train });
    await apply("close-before-b", { type: "activate-disruption", disruptionId: "fixture:signal-block",
      effect: { "resource-closed": { resourceId: "block:main:2" } } });
    await apply("dispatch", { type: "dispatch", requests: [dispatch(MAIN, "interlocking:main:1"), dispatch(CONNECTION, "interlocking:connection:1")] });
    await apply("origin-departure", { type: "advance-to", atMs: 1001 }); await refresh();
    const running = await demand.checkpoint(WORLD);
    const firstSection = demandList(running.result["allocations"]).find((allocation) => allocation["trainRunId"] === MAIN && allocation["fromStopId"] === `${MAIN}:0`)!;
    const prefix = demandList(running.result["manifests"]).find((manifest) => manifest["segmentId"] === firstSection["segmentId"])!;
    expect(demandList(prefix?.["passengers"]).length).toBeGreaterThan(0);
    app.decorateRequest("identity", null);
    registerDemandRoutes(app, { db, get demand() { return demand; }, async authenticate(request) {
      request.identity = { keycloakSubject: "three-stop-owner", displayName: "Test" };
    } });
    const url = `/worlds/${WORLD}/operators/${OPERATOR}/demand/trains/${encodeURIComponent(MAIN)}/manifest`;
    const onboard = await app.inject({ method: "GET", url });
    expect(onboard.statusCode, onboard.body).toBe(200); expect(onboard.json().source).toBe("confirmed");
    expect(onboard.json().items.length).toBeGreaterThan(0);
    expect(onboard.body).not.toMatch(/fareFact|farePolicy|seatNumber|journeyChainId/u);
    const stopped = await apply("wait-at-signal", { type: "advance-to", atMs: 17_000 }); await refresh();
    expect(stopped.liveMap.trains.find((train) => train.trainId === MAIN)).toMatchObject({ headRouteMm: 30_000, speedMmps: 0 });
    expect((await receipts()).filter((receipt) => receipt["trainRunId"] === MAIN && receipt["stopSequence"] === 1)).toEqual([]);
    expect((await receipts()).find((receipt) => receipt["trainRunId"] === CONNECTION && receipt["kind"] === "departure"))
      .toMatchObject({ actualTimeMs: 12_000, stopId: `${CONNECTION}:0` });
    expect(initialization.trains[1]!.stopPlan!.stops[0]!.stationId).toBe(STATIONS[1]);
    worker = new RegionalSimulationWorker(db, native.operational, livemap);
    await worker.restore(WORLD, REGION, initialized.initializationHash);
    demand = new DemandService(dependencies); await refresh();
    await apply("release-signal", { type: "clear-disruption", disruptionId: "fixture:signal-block", releaseReference: "fixture:restored-track" });
    await apply("arrive-b", { type: "advance-to", atMs: 25_000 }); await refresh();
    const after = await demand.checkpoint(WORLD), facts = await receipts();
    const arrivalB = facts.find((receipt) => receipt["trainRunId"] === MAIN && receipt["stopSequence"] === 1 && receipt["kind"] === "arrival")!;
    expect(Number(arrivalB?.["actualTimeMs"])).toBeGreaterThan(17_000);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(409);
    expect(demandList(after.result["manifests"]).find((manifest) => manifest["segmentId"] === prefix["segmentId"])?.["passengers"])
      .toEqual(prefix["passengers"]); // includes passengerKey, seatNumber and hidden fareFact
    for (const original of connecting) {
      const revised = demandList(after.result["choices"]).filter((choice) => choice["cohortId"] === original["cohortId"]);
      expect(revised.length).toBeGreaterThan(0);
      expect(revised.every((choice) => demandList(choice["trains"]).every((train) => train["trainRunId"] !== CONNECTION))).toBe(true);
    }
    await apply("finish", { type: "advance-to", atMs: 60_000 }); await refresh();
    const finished = await demand.checkpoint(WORLD);
    const finalFacts = (await receipts()).filter((receipt) => receipt["trainRunId"] === MAIN);
    expect(finalFacts.map((receipt) => [receipt["stopSequence"], receipt["kind"]])).toEqual([
      [0, "arrival"], [0, "departure"], [1, "arrival"], [1, "departure"], [2, "arrival"],
    ]);
    const departureB = finalFacts.find((receipt) => receipt["stopSequence"] === 1 && receipt["kind"] === "departure")!;
    expect(Number(departureB["actualTimeMs"]) - Number(arrivalB["actualTimeMs"])).toBeGreaterThanOrEqual(5000);
    expect(demandList(demandRecord(finished.result["operationalProgress"])["trains"]).find((train) => train["trainRunId"] === MAIN)?.["stops"])
      .toEqual(initialization.trains[0]!.stopPlan!.stops.map((stop) => ({ stopId: stop.stopId,
        actualArrivalMs: finalFacts.find((receipt) => receipt["stopId"] === stop.stopId && receipt["kind"] === "arrival")!["actualTimeMs"],
        actualDepartureMs: finalFacts.find((receipt) => receipt["stopId"] === stop.stopId && receipt["kind"] === "departure")?.["actualTimeMs"] ?? null })));
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(409);
    const detail = await app.inject({ method: "GET", url: `/worlds/${WORLD}/demand/trains/${encodeURIComponent(MAIN)}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().stops[1].arrivalS).toBe(Math.trunc(Number(arrivalB["actualTimeMs"]) / 1000));
    const count = (await receipts()).length;
    expect((await apply("finish", { type: "advance-to", atMs: 60_000 })).idempotentReplay).toBe(true);
    expect(await receipts()).toHaveLength(count);
    expect(await new DemandStore(db, native.demand).latest(WORLD, dependencies.deploymentHash)).toEqual(finished);
  } finally {
    await app.close(); await client.close();
    if (oldRoots === undefined) delete process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV]; else process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = oldRoots;
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
