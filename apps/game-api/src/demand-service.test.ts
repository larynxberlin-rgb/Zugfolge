import { PGlite } from "@electric-sql/pglite";
import { domainEvents, MIGRATIONS_FOLDER, operators, worldAccesses, worldEventLog, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { requestWorldAccess } from "@zugfolge/identity";
import { LivemapRegistry, type LivemapReadModel } from "@zugfolge/livemap-stream";
import { demandRuntimeFromAddon, loadDemandRuntime, type DemandRuntime } from "@zugfolge/runtime-native";
import type { PlanningInfrastructureRelease } from "@zugfolge/planning-worker";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerDemandRoutes } from "./demand-routes.js";
import { DemandService, poolDemandWindows, type DemandDeployment } from "./demand-service.js";
import { DemandStore, demandHash, demandList, demandRecord } from "./demand-store.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OPERATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input = { worldId: WORLD, periodId: "p1", revision: 1, nowMs: 0, windowStartMs: 0, windowEndMs: 10000, release: { id: "test" } };
const fixtureRuntime: DemandRuntime = { evaluate(value) { return { ...value, stateHash: demandHash(value), passengers: "only-a-transport-fixture" }; } };

describe("Nachfrage: Persistenz, Replay und Zugriff", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  beforeEach(async () => {
    client = new PGlite(); db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([{ id: WORLD, name: "A", schedulePeriodWeeks: 3, epoch: new Date(0) }, { id: OTHER, name: "B", schedulePeriodWeeks: 3, epoch: new Date(0) }]);
  });
  afterEach(async () => { await client.close(); });

  it("speichert identische Kommandos einmal und prüft den Inhalt nach Restore durch denselben Kern", async () => {
    const store = new DemandStore(db, fixtureRuntime);
    const checkpoint = await store.commit(input, "pin", new Date(0));
    await store.commit(input, "pin", new Date(0));
    expect(await db.select().from(domainEvents)).toHaveLength(1);
    expect(await new DemandStore(db, fixtureRuntime).latest(WORLD, "pin")).toEqual(checkpoint);
    expect(await store.latest(OTHER)).toBeUndefined();
    await expect(store.commit({ ...input, nowMs: 1000 }, "pin", new Date(1000))).rejects.toThrow("veraltet");
    await expect(store.commit({ ...input, revision: 2 }, "changed", new Date(1000))).rejects.toThrow("gepinnt");
    await store.commit({ ...input, periodId: "p2", windowStartMs: 10000, windowEndMs: 20000, nowMs: 10000, revision: 2 }, "changed", new Date(10000));
    expect((await new DemandStore(db, fixtureRuntime).latest(WORLD, "changed"))?.input["periodId"]).toBe("p2");
  });

  it("verweigert veränderte Ergebnisse und spätere Writes auf archivierte Welten", async () => {
    await worldEventLog(db, WORLD).append({ sequence: 1, eventType: "demand.evaluated", occurredAt: new Date(0), payload: {
      schemaVersion: "zugfolge-demand-checkpoint/v1", worldId: WORLD, deploymentHash: "pin", inputHash: demandHash(input), input,
      result: { ...fixtureRuntime.evaluate(input), passengers: "tampered" },
    } });
    await expect(new DemandStore(db, fixtureRuntime).latest(WORLD)).rejects.toThrow("Replay");
    await db.update(worlds).set({ lifecycleStatus: "archived" }).where(eq(worlds.id, OTHER));
    await expect(new DemandStore(db, fixtureRuntime).commit({ ...input, worldId: OTHER }, "pin", new Date(0))).rejects.toThrow("nicht aktiv");
  });

  it("prüft jede Nachfrage- und Manifestabfrage auf aktiven Weltzugang und Unternehmenseigentum", async () => {
    const owner = await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "owner", displayName: "Owner" });
    await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "visitor", displayName: "Visitor" });
    await db.insert(operators).values({ id: OPERATOR, worldId: WORLD, foundingAccountId: owner.id, name: "Eigene Bahn", color: "#123456" });
    const app = Fastify(); app.decorateRequest("identity", null);
    registerDemandRoutes(app, { db, async authenticate(request, reply) {
      const subject = request.headers["x-test-subject"];
      if (typeof subject !== "string") { await reply.code(401).send({ error: "unauthorized" }); return; }
      request.identity = { keycloakSubject: subject, displayName: subject };
    } });
    const url = `/worlds/${WORLD}/operators/${OPERATOR}/demand/trains/train/manifest`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { "x-test-subject": "visitor" } })).statusCode).toBe(403);
    expect((await app.inject({ url, headers: { "x-test-subject": "owner" } })).statusCode).toBe(503);
    expect((await app.inject({ url: `/worlds/${OTHER}/demand/overview`, headers: { "x-test-subject": "owner" } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/worlds/${WORLD}/demand/overview?limit=51`, headers: { "x-test-subject": "owner" } })).statusCode).toBe(400);
    await db.update(worldAccesses).set({ status: "revoked" }).where(eq(worldAccesses.keycloakSubject, "owner"));
    expect((await app.inject({ url, headers: { "x-test-subject": "owner" } })).statusCode).toBe(403);
    await app.close();
  });
});

// Die reguläre Native-ABI-CI setzt den echten Addonpfad. Kein JS-Ersatz für Fachnachweise.
describe.skipIf(process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] === undefined && process.env["ZUGFOLGE_DEMAND_TEST_BINARY"] === undefined)("Nachfrage: echter Rust → Journal → Spielerprojektion", () => {
  it("verknüpft Einwohner, Klassen und Wunschziele mit der Spielkarte und restauriert unbediente Stationen", async () => {
    const binary = process.env["ZUGFOLGE_DEMAND_TEST_BINARY"];
    const runtime = binary === undefined ? loadDemandRuntime() : demandRuntimeFromAddon({ evaluatePassengerDemand(input) {
      const result = spawnSync(binary, [], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    } });
    // Ausdrücklich synthetischer Vertragstest mit demselben nativen Erzeuger.
    const input = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/evaluation.json", import.meta.url), "utf8"));
    input.worldId = WORLD; input.services = []; input.alternatives = [];
    input.release.sources = [{ id: "fixture", url: "https://example.org/synthetic", license: "CC0-1.0", artifactSha256: "a".repeat(64), rightsApproved: true }];
    input.release.populationModel = {
      schemaVersion: "zugfolge-station-population-demand/v1",
      settlements: input.release.zones.map((zone: any) => ({ id: zone.id, name: zone.id, population: zone.population, sourceId: "fixture" })),
      stationAreas: input.release.zones.map((zone: any) => ({ zoneId: zone.id, stationId: zone.stations[0].stationId,
        demandClass: 1, populationAllocations: [{ settlementId: zone.id, population: zone.population }] })),
      referenceTimetable: { id: "fixture-reference", artifactSha256: "b".repeat(64), sourceIds: ["fixture"],
        serviceDates: Array.from({ length: 7 }, (_, day) => `2026-09-${String(day + 7).padStart(2, "0")}`) },
      destinationPreferences: [{ originZoneId: "leipzig", destinationZoneId: "erfurt", referenceConnections: 120 }],
    };
    const infrastructure = { worldId: WORLD, releaseId: "infra", stations: input.release.zones.map((zone: any) => ({
      id: zone.stations[0].stationId, name: `Station ${zone.id}`, latitudeE7: 510000000, longitudeE7: 120000000,
    })) } as PlanningInfrastructureRelease;
    const client = new PGlite(), db = drizzle(client, { schema });
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await db.insert(worlds).values({ id: WORLD, name: "Einwohnerfixture", schedulePeriodWeeks: 3, epoch: new Date(0) });
      const livemap = new LivemapRegistry(); livemap.initializeWorld(WORLD, { at: 0, trains: [] });
      const readModel = { async getConfig() { return { infrastructureReleaseId: "infra" }; }, async getScheduledCall() { return undefined; } } as unknown as LivemapReadModel;
      const deployment: DemandDeployment = { schemaVersion: "zugfolge-demand-deployment/v1", worldId: WORLD, infrastructureReleaseId: "infra", windows: [input] };
      const staleInfrastructure = { ...infrastructure, releaseId: "old-infra", stations: infrastructure.stations.map((station) => ({ ...station, name: "Veraltete Station", latitudeE7: 520000000 })) };
      const deps = { db, runtime, deployment, deploymentHash: "population-pin", readModel, livemap, infrastructure: [infrastructure, staleInfrastructure] };
      const service = new DemandService(deps);
      await service.refresh(120000, new Date(120000));
      const overview = await service.overview(WORLD);
      expect(overview.source).toBe("assumption"); expect(overview.items).toHaveLength(3);
      expect(overview.items.every((station) => station.servedPassengers === 0)).toBe(true);
      expect(overview.items.reduce((sum, station) => sum + station.populationDemand!.catchmentPopulation, 0)).toBe(160);
      expect(overview.items.reduce((sum, station) => sum + station.populationDemand!.requestedPassengers, 0)).toBe(40);
      const leipzig = overview.items.find((station) => station.stationId === "leipzig-hbf")!;
      expect(leipzig.label).toBe("Station leipzig"); expect(leipzig.latitudeE7).toBe(510000000);
      expect(leipzig.populationDemand).toMatchObject({ demandClass: 1, catchmentPopulation: 80, requestedPassengers: 20,
        topDestinations: [{ stationId: "erfurt-hbf", label: "Station erfurt", passengers: 16, referenceConnections: 120 },
          { stationId: "halle-hbf", label: "Station halle", passengers: 4, referenceConnections: 0 }] });
      expect(overview.populationBasis?.referenceEndDate).toBe("2026-09-13");
      const restarted = new DemandService(deps); await restarted.refresh(120000, new Date(120000));
      expect(await restarted.overview(WORLD)).toEqual(overview);
      const missingStation = new DemandService({ ...deps, infrastructure: [{ ...infrastructure, stations: infrastructure.stations.slice(1) }] });
      await expect(missingStation.refresh(120000, new Date(120000))).rejects.toThrow("gepinnten Spielkarte");
      expect(JSON.stringify(overview)).not.toMatch(/fareFact|passengerKey|seed|populationAllocations|artifactSha256/);
    } finally { await client.close(); }
  }, 30_000);
  it("verwendet nur gepinnte Referenzen, auch wenn bestätigter Spieler-SPFV im Nachfragecheckpoint steht", async () => {
    const binary = process.env["ZUGFOLGE_DEMAND_TEST_BINARY"];
    const native = binary === undefined ? loadDemandRuntime() : demandRuntimeFromAddon({ evaluatePassengerDemand(input) {
      const result = spawnSync(binary, [], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    } });
    const nativeCalls: Readonly<Record<string, unknown>>[] = [];
    const runtime: DemandRuntime = { evaluate(input) { nativeCalls.push(input); return native.evaluate(input); } };
    const original = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/evaluation.json", import.meta.url), "utf8"));
    original.worldId = WORLD;
    for (const service of original.services) { service.worldId = WORLD; service.operatorId = OPERATOR; }
    for (const alternative of original.alternatives) alternative.worldId = WORLD;
    const client = new PGlite(), db = drizzle(client, { schema });
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await db.insert(worlds).values({ id: WORLD, name: "Referenzbindung", schedulePeriodWeeks: 3, epoch: new Date(0) });
      const registry = new LivemapRegistry();
      registry.initializeWorld(WORLD, { at: 0, trains: [] });
      const readModel = { async getConfig() { return { infrastructureReleaseId: "infra" }; },
        async getScheduledCall(_world: string, stationId: string, trainId: string, atS: number, kind: string) {
          const train = original.services.find((service: any) => service.trainRunId === trainId);
          return train?.stops.some((stop: any) => stop.stationId === stationId && stop[kind === "arrival" ? "arrivalMs" : "departureMs"] === atS * 1000)
            ? { trainId, scheduledTimeS: atS } : undefined;
        } } as unknown as LivemapReadModel;
      const deployment: DemandDeployment = { schemaVersion: "zugfolge-demand-deployment/v1", worldId: WORLD,
        infrastructureReleaseId: "infra", windows: [original] };
      const service = new DemandService({ db, runtime, deployment, deploymentHash: "pin", readModel, livemap: registry, infrastructure: [] });
      await service.refresh(120_000, new Date(120_000));
      const checkpoint = await service.checkpoint(WORLD);
      // Explicit admitted-service transport fixture, at the same persisted input
      // boundary produced by loadCommittedSpfvServices; acceptance is tested there.
      const admitted = { ...original.services.find((train: any) => train.mode === "spfv"),
        trainRunId: "accepted-player-service", reliabilityBasisPoints: 7_777, comfortBasisPoints: 7_777 };
      await service.store.commit({ ...checkpoint.input, revision: 2, services: [admitted, ...original.services] }, "pin", new Date(120_000));
      const estimateInput = { worldId: WORLD, operatorId: OPERATOR, atS: 120,
        draft: { name: "Referenzprobe", stopIds: ["leipzig-hbf", "erfurt-hbf"], headwayS: 3600,
          fareCents: "100", formationId: "formation", validFromS: 200, validUntilS: 201 },
        capacity: 20, firstClassSeats: 0, bicyclePlaces: 1, wheelchairPlaces: 1, operatingCostCentsPerTrainKm: 50,
        routeDistanceMm: 100_000_000, fleetRevision: 1, fleetStateHash: "f".repeat(64), infrastructureReleaseId: "infra" };
      const explicit = await service.estimateSpfv({ ...estimateInput, draft: { ...estimateInput.draft, referenceTrainId: admitted.trainRunId } });
      expect(explicit.requested).toBeNull();
      expect(explicit.conflicts).toEqual([expect.stringContaining("freigegebenen Nachfragekorpus")]);
      const implicit = await service.estimateSpfv(estimateInput);
      expect(implicit.requested).not.toBeNull();
      const proposal = demandList(nativeCalls.at(-1)!["services"]).find((train) => String(train["trainRunId"]).startsWith("spfv-proposal:"));
      expect(proposal).toMatchObject({ reliabilityBasisPoints: 9800, comfortBasisPoints: 8500 });
      expect((await service.checkpoint(WORLD)).input["revision"]).toBe(2);
    } finally { await client.close(); }
  }, 30_000);

  it("revidiert Kapazität nach Ausfall, schützt Fahrberechtigungen und restauriert bitgleich", async () => {
    const binary = process.env["ZUGFOLGE_DEMAND_TEST_BINARY"];
    const native = binary === undefined ? loadDemandRuntime() : demandRuntimeFromAddon({ evaluatePassengerDemand(input) {
      const result = spawnSync(binary, [], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    } });
    const nativeCalls: Readonly<Record<string, unknown>>[] = [];
    const observedRuntime: DemandRuntime = { evaluate(input) { nativeCalls.push(input); return native.evaluate(input); } };
    const original = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/evaluation.json", import.meta.url), "utf8"));
    original.worldId = WORLD;
    for (const service of original.services) { service.worldId = WORLD; service.operatorId = OPERATOR; }
    for (const alternative of original.alternatives) alternative.worldId = WORLD;
    const client = new PGlite(), db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD, name: "Pilot", schedulePeriodWeeks: 3, epoch: new Date(0) });
    const registry = new LivemapRegistry();
    registry.initializeWorld(WORLD, { at: 0, trains: original.services.map((service: any) => ({ id: service.trainRunId, operatorId: OPERATOR,
      operator: "Test", trainNumber: "1", category: service.mode, positionMm: 0, speedMmPerSecond: 0, delaySeconds: 0, status: "running" })) });
    const readModel = { async getConfig() { return { infrastructureReleaseId: "infra" }; }, async getScheduledCall(_world: string, stationId: string, trainId: string, atS: number, kind: string) {
      const train = original.services.find((service: any) => service.trainRunId === trainId);
      return train?.stops.some((stop: any) => stop.stationId === stationId && stop[kind === "arrival" ? "arrivalMs" : "departureMs"] === atS * 1000) ? { trainId, scheduledTimeS: atS } : undefined;
    }, async getStationBoard(_world: string, stationId: string) {
      return { arrivals: [], departures: original.services.filter((service: any) => service.stops.some((stop: any) => stop.stationId === stationId))
        .map((service: any) => ({ trainId: service.trainRunId })) };
    } } as unknown as LivemapReadModel;
    const deployment: DemandDeployment = { schemaVersion: "zugfolge-demand-deployment/v1", worldId: WORLD, infrastructureReleaseId: "infra", windows: [original] };
    const service = new DemandService({ db, runtime: observedRuntime, deployment, deploymentHash: "pin", readModel, livemap: registry, infrastructure: [] });
    try {
      await service.refresh(120000, new Date(120000));
      const overview = await service.overview(WORLD);
      expect(overview.zones.reduce((sum, zone) => sum + zone.requestedPassengers, 0)).toBe(40);
      const checkpoint = await service.checkpoint(WORLD);
      expect(await new DemandStore(db, native).latest(WORLD, "pin")).toEqual(checkpoint);
      const trainId = original.services.find((train: any) => train.mode === "spnv").trainRunId;
      const aggregate = await service.train(WORLD, trainId);
      expect(aggregate.segments.every((segment) => segment.onboard !== null && segment.capacity !== null)).toBe(true);
      const estimateInput = { worldId: WORLD, operatorId: OPERATOR, atS: 120,
        draft: { name: "Native Probe", stopIds: ["leipzig-hbf", "erfurt-hbf"], headwayS: 3600,
          fareCents: "100", formationId: "formation", validFromS: 200, validUntilS: 201 },
        capacity: 20, firstClassSeats: 0, bicyclePlaces: 1, wheelchairPlaces: 1, operatingCostCentsPerTrainKm: 50,
        routeDistanceMm: 100_000_000, fleetRevision: 1, fleetStateHash: "f".repeat(64), infrastructureReleaseId: "infra" };
      // The real SPFV preview holds a transaction while reading demand. This
      // must share its connection, including on a single-connection database.
      const estimate = await db.transaction((tx) => service.estimateSpfv(estimateInput, tx));
      expect(estimate.served).not.toBeNull();
      expect(estimate.costsCents).toBe("5000");
      await service.estimateSpfv({ ...estimateInput, replaceTrainIds: ["express-1"] });
      expect(demandList(nativeCalls.at(-1)!["services"]).some((row) => row["trainRunId"] === "express-1")).toBe(false);
      expect((await service.checkpoint(WORLD)).inputHash).toBe(checkpoint.inputHash);
      await expect(service.manifest(WORLD, OPERATOR, trainId)).rejects.toThrow("aktiven Fahrgastabschnitt");
      // Das Erzeugungsfenster endet vor der Reise. Der Pool bleibt während der Fahrt verfügbar.
      await service.refresh(601000, new Date(601000));
      const privateView = await service.manifest(WORLD, OPERATOR, trainId);
      const output = JSON.stringify([overview, aggregate, privateView]);
      for (const hidden of ["fareFact", "farePolicyProvenance", "seed", "valid_unpresentable"]) expect(output).not.toContain(hidden);
      await expect(service.manifest(WORLD, "foreign", trainId)).rejects.toThrow("berechtigtes");
      const feed = registry.initializedWorld(WORLD)!;
      const previous = feed.snapshot().trains.find((train) => train.id === trainId)!;
      registry.publishRegionDelta(WORLD, "__single_region__", { at: 602, changed: [{ ...previous, status: "cancelled" }], removed: [] });
      await service.refresh(602000, new Date(602000));
      const revised = await service.checkpoint(WORLD);
      expect(revised.result["revision"]).toBe(2);
      expect(demandList(revised.result["allocations"]).filter((row) => row["trainRunId"] === trainId).every((row) => row["passengers"] === 0)).toBe(true);
      expect(demandRecord(revised.result["totals"])["generated"]).toBe(40);
      registry.publishRegionDelta(WORLD, "__single_region__", { at: 603, changed: [], removed: [trainId] });
      const restarted = new DemandService({ db, runtime: native, deployment, deploymentHash: "pin", readModel, livemap: registry, infrastructure: [] });
      await restarted.refresh(603000, new Date(603000));
      const afterRemoval = await restarted.checkpoint(WORLD);
      expect(afterRemoval.result["revision"]).toBe(2);
      expect(demandList(afterRemoval.input["services"]).find((row) => row["trainRunId"] === trainId)?.["cancelled"]).toBe(true);
    } finally { await client.close(); }
  }, 30_000);
});

it("poolt disjunkte Tagesgangfenster unter gemeinsamen Fahrtfakten und lehnt widersprüchliche Kapazitäten ab", () => {
  const common = { worldId: WORLD, periodId: "period", seed: "42", release: {}, alternatives: [], services: [{ trainRunId: "train", capacity: 4 }] };
  const first = { ...common, daySliceId: "a", windowStartMs: 0, windowEndMs: 1000 };
  const next = { ...common, daySliceId: "b", windowStartMs: 1000, windowEndMs: 2000 };
  const [pooled] = poolDemandWindows([first, next]);
  expect(pooled).toMatchObject({ daySliceId: "pooled", windowStartMs: 0, windowEndMs: 2000,
    services: common.services, generationWindows: [{ daySliceId: "a" }, { daySliceId: "b" }] });
  expect(() => poolDemandWindows([first, { ...next, services: [{ trainRunId: "train", capacity: 8 }] }])).toThrow("widersprüchliche Fakten");
});
