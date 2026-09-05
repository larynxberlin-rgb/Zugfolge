import { PGlite } from "@electric-sql/pglite";
import { domainEvents, fleetWorldCheckpoints, MIGRATIONS_FOLDER, operators, simulationCommands, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { applyFleetProducerCommand, initializeFleetProducer, loadFleetProducerCheckpoint } from "@zugfolge/economy";
import { requestWorldAccess } from "@zugfolge/identity";
import { LivemapRegistry, type LivemapReadModel } from "@zugfolge/livemap-stream";
import { loadPlanningRuntime } from "@zugfolge/planning-runtime-native";
import { planningInfrastructureReleaseCatalog, processPlanningCommand, type PlanningInfrastructureRelease } from "@zugfolge/planning-worker";
import { FLEET_FORMATION_COMMAND_SCHEMA, FLEET_INITIALIZE_SCHEMA, loadDemandRuntime, loadOperatingRuntime } from "@zugfolge/runtime-native";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { registerDemandRoutes } from "./demand-routes.js";
import { DemandService, type DemandDeployment } from "./demand-service.js";
import { demandList, demandRecord, DemandStore } from "./demand-store.js";
import { loadCommittedSpfvServices } from "./spfv-demand-projection.js";
import { SpfvService, type SpfvDraft } from "./spfv-service.js";

const WORLD = "91111111-1111-4111-8111-111111111111";
const OPERATOR = "9aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nativeIt = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined
  && process.env["ZUGFOLGE_PLANNING_RUNTIME_NATIVE_PATH"] !== undefined ? it : it.skip;

const infrastructure: PlanningInfrastructureRelease = {
  schemaVersion: "planning.infrastructure-release/v1", worldId: WORLD, releaseId: "native-spfv-infra",
  sourceId: "explicit-integration-fixture", corridorId: "a-c", corridorName: "Testkorridor",
  stations: ["a", "b", "c"].map((id, index) => ({ numericId: index + 1, id, code: id.toUpperCase(), name: `Bahnhof ${id}`,
    distanceMm: index * 1_000_000, latitudeE7: 510_000_000, longitudeE7: 120_000_000,
    stationTrackNumericId: index + 10, stationTrackLengthMm: 150_000, stationMaximumSpeedKph: 80 })),
  segments: [["a", "b"], ["b", "c"]].map(([from, to], index) => ({ edgeNumericId: index + 1, trackNumericId: index + 1,
    id: `${from}-${to}`, label: `${from}-${to}`, fromStationId: from!, toStationId: to!, lengthMm: 1_000_000,
    maximumSpeedKph: 100, mainSignalPositionsMm: [0], maximumVirtualBlockLengthMm: 1_000_000 })),
};

nativeIt("verknüpft HTTP, native Flotte, Nachfrage, Trassenkonkurrenz und Restore ohne Fachmock", async () => {
  const fleet = loadOperatingRuntime(), nativeDemand = loadDemandRuntime(), planner = loadPlanningRuntime();
  const client = new PGlite(), db = drizzle(client, { schema }), app = Fastify();
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD, name: "Explizite SPFV-Integrationstestwelt", schedulePeriodWeeks: 3, epoch: new Date(0) });
    const account = await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "native-spfv-owner", displayName: "Test" });
    await db.insert(operators).values({ id: OPERATOR, worldId: WORLD, foundingAccountId: account.id, name: "Testverkehr" });
    // Explizite Testfakten; der echte Producer persistiert native Revisionen und Kommandobelege.
    const initialized = await initializeFleetProducer({ db, runtime: fleet, ingestedAt: new Date(0), initialization: {
      schemaVersion: FLEET_INITIALIZE_SCHEMA, worldId: WORLD, producedAt: 0,
      authorityRelease: { schemaVersion: "zugfolge-fleet-authority-release/v1", releaseId: "native-spfv-fleet", referenceYear: 2026,
        assets: [{ id: "asset", numericId: 1, operatorId: OPERATOR, vehicleTypeId: 1, classDesignation: "TEST", tradeName: "Testzug",
          buildYear: 2020, acquisitionYear: 2025, procurementChannel: "leasing", approvedLineIds: ["route"],
          maintenanceDeadlines: [{ kind: "inspection", dueAt: 100_000 }], installedProtection: ["pzb"],
          technical: { lengthMm: 70_000, massKg: 120_000, maximumSpeedKph: 160, traction: "electric", electricSystems: ["ac15kv"],
            accelerationMmPerS2: 800, decelerationMmPerS2: 900 },
          passenger: { seats: 120, firstClassSeats: 12, accessible: true, bicyclePlaces: 8, wheelchairPlaces: 2,
            equipment: ["pis"], operatingCostCentsPerTrainKm: 700, replacementPlan: true }, deliveredAt: 0, retiredAt: 100_000 }],
        personnelPools: [], pathReceipts: [{ id: "path", numericRouteId: 1, operatorId: OPERATOR, serviceLineIds: ["route"], decision: "confirmed",
          validFrom: 0, validUntil: 100_000, platformLengthsMm: [150_000], electrifications: ["overhead-ac15kv"], requiredProtection: ["pzb"],
          approvedClasses: ["TEST"], plannerStateHash: "b".repeat(64), conflictCheckHash: "c".repeat(64) }] } } });
    const formation = await applyFleetProducerCommand({ db, runtime: fleet, ingestedAt: new Date(1000), command: {
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA, worldId: WORLD,
      commandId: "native-spfv-formation", expectedStateHash: initialized.stateHash, expectedRevision: 0, atS: 1,
      formationId: "formation", vehicleIds: ["asset"], pathReceiptId: "path" } });
    expect(await loadFleetProducerCheckpoint(db, WORLD)).toMatchObject({
      state: formation.state, stateHash: formation.commandReceipt.resultingStateHash,
      snapshot: formation.snapshot, snapshotHash: formation.commandReceipt.resultingSnapshotHash,
      commandId: formation.commandReceipt.commandId, commandSchema: FLEET_FORMATION_COMMAND_SCHEMA,
      commandJson: formation.commandReceipt.canonicalCommandJson, commandHash: formation.commandReceipt.commandHash,
    });
    expect((await db.select({ revision: fleetWorldCheckpoints.revision }).from(fleetWorldCheckpoints)
      .where(eq(fleetWorldCheckpoints.worldId, WORLD)).orderBy(fleetWorldCheckpoints.revision)).map((row) => row.revision))
      .toEqual([initialized.state.revision, formation.commandReceipt.resultingRevision]);

    const input = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/evaluation.json", import.meta.url), "utf8"));
    const stationIds = new Map([["leipzig-hbf", "a"], ["halle-hbf", "b"], ["erfurt-hbf", "c"]]);
    input.worldId = WORLD;
    for (const zone of input.release.zones) for (const station of zone.stations) station.stationId = stationIds.get(station.stationId);
    for (const train of input.services) {
      train.worldId = WORLD; train.operatorId = OPERATOR;
      for (const stop of train.stops) stop.stationId = stationIds.get(stop.stationId);
    }
    for (const alternative of input.alternatives) alternative.worldId = WORLD;
    const readModel = { async getConfig() { return { infrastructureReleaseId: infrastructure.releaseId }; },
      async getScheduledCall(_world: string, stationId: string, trainId: string, atS: number, kind: string) {
        const train = input.services.find((item: any) => item.trainRunId === trainId);
        return train?.stops.some((stop: any) => stop.stationId === stationId && stop[kind === "arrival" ? "arrivalMs" : "departureMs"] === atS * 1000)
          ? { trainId, scheduledTimeS: atS } : undefined;
      } } as unknown as LivemapReadModel;
    const livemap = new LivemapRegistry(); livemap.initializeWorld(WORLD, { at: 0, trains: [] });
    const deployment: DemandDeployment = { schemaVersion: "zugfolge-demand-deployment/v1", worldId: WORLD,
      infrastructureReleaseId: infrastructure.releaseId, windows: [input] };
    const demand = new DemandService({ db, runtime: nativeDemand, deployment, deploymentHash: "explicit-fixture-pin", readModel,
      livemap, infrastructure: [infrastructure] });
    await demand.refresh(10_000, new Date(10_000));
    const dependencies = { db, fleetRuntime: fleet, infrastructureReleaseForWorld: () => infrastructure,
      timeForWorld: async () => 10, estimate: demand.estimateSpfv.bind(demand) };
    const spfv = new SpfvService(dependencies);
    app.decorateRequest("identity", null);
    registerDemandRoutes(app, { db, demand, spfv, async authenticate(request) {
      request.identity = { keycloakSubject: "native-spfv-owner", displayName: "Test" };
    } });
    const path = `/worlds/${WORLD}/operators/${OPERATOR}/spfv`;
    const draft: SpfvDraft = { name: "Erste Fernlinie", stopIds: ["a", "c"], formationId: "formation", referenceTrainId: "regional-1",
      headwayS: 300, fareCents: "100", validFromS: 200, validUntilS: 600 };
    const previewResponse = await app.inject({ method: "POST", url: `${path}/preview`, payload: draft });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const preview = previewResponse.json();
    expect(preview).toMatchObject({ confirmationAllowed: true, capacity: 120, planningRequestCount: 2 });
    expect(Number(preview.servedPassengers)).toBeGreaterThan(0);
    expect(BigInt(preview.costsCents)).toBeGreaterThan(0n);
    expect(await db.select().from(simulationCommands)).toHaveLength(0);
    const confirmResponse = await app.inject({ method: "POST", url: `${path}/confirm`, payload: { previewId: preview.previewId, commandId: "native-spfv-confirm" } });
    expect(confirmResponse.statusCode, confirmResponse.body).toBe(200);
    const submitted = confirmResponse.json();
    expect(submitted.planningRequestIds).toHaveLength(2);
    expect((await loadCommittedSpfvServices(db, WORLD, input.services)).services).toEqual([]);
    const releases = planningInfrastructureReleaseCatalog([infrastructure]);
    const committed = await processPlanningCommand(db, planner, releases, WORLD, submitted.planningCoordinationId, new Date(11_000));
    expect(committed.projectionRevision).toBe(1);
    const admitted = await loadCommittedSpfvServices(db, WORLD, input.services);
    expect(admitted.services).toHaveLength(2);
    for (const train of admitted.services) {
      expect(train).toMatchObject({ mode: "spfv", operatorId: OPERATOR, capacity: { standardSeats: 108, premiumSeats: 12 } });
      expect(demandList(train["stops"]).map((stop) => stop["stationId"])).toEqual(["a", "c"]);
    }
    await demand.refresh(12_000, new Date(12_000));
    const checkpoint = await demand.checkpoint(WORLD);
    const admittedIds = new Set(admitted.services.map((train) => train["trainRunId"]));
    expect(demandList(checkpoint.result["allocations"]).some((allocation) => admittedIds.has(allocation["trainRunId"]) && Number(allocation["passengers"]) > 0)).toBe(true);
    const totals = demandRecord(checkpoint.result["totals"]);
    expect(Number(totals["rail"]) + Number(totals["alternative"]) + Number(totals["unserved"])).toBe(totals["generated"]);
    expect(await new DemandStore(db, nativeDemand).latest(WORLD, "explicit-fixture-pin")).toEqual(checkpoint);
    expect(await new SpfvService(dependencies).confirm({ worldId: WORLD, operatorId: OPERATOR, accountId: account.id },
      { previewId: preview.previewId, commandId: "native-spfv-confirm" })).toEqual(submitted);

    // A second line with the same departures must compete with real retained
    // occupations. Rejected requests cannot leak into the demand service pool.
    const competingPreview = await spfv.preview({ worldId: WORLD, operatorId: OPERATOR, accountId: account.id }, { ...draft, name: "Konkurrierende Fernlinie" });
    const competing = await spfv.confirm({ worldId: WORLD, operatorId: OPERATOR, accountId: account.id },
      { previewId: competingPreview.previewId, commandId: "native-spfv-competition" });
    await processPlanningCommand(db, planner, releases, WORLD, competing.planningCoordinationId, new Date(13_000));
    expect((await loadCommittedSpfvServices(db, WORLD, input.services)).services.map((train) => train["trainRunId"]).sort()).toEqual([...admittedIds].sort());
    const [latest] = await db.select().from(domainEvents).where(and(eq(domainEvents.worldId, WORLD), eq(domainEvents.eventType, "planning.diagram")))
      .orderBy(desc(domainEvents.sequence)).limit(1);
    expect(demandList(demandRecord(latest!.payload)["conflicts"]).length).toBeGreaterThan(0);
    const count = (await db.select().from(domainEvents)).length;
    expect(await processPlanningCommand(db, planner, releases, WORLD, submitted.planningCoordinationId, new Date(14_000)))
      .toEqual({ ...committed, idempotentReplay: true });
    expect(await db.select().from(domainEvents)).toHaveLength(count);
  } finally { await app.close(); await client.close(); }
}, 60_000);
