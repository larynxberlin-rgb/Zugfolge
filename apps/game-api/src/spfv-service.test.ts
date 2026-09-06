import { PGlite } from "@electric-sql/pglite";
import { domainEvents, fleetMobilizationSnapshots, fleetWorldCheckpoints, MIGRATIONS_FOLDER, operators, planningTrainNumbers, simulationCommands, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { createFleetMobilizationEnvelope, type FleetMobilizationSnapshot } from "@zugfolge/economy";
import { requestWorldAccess } from "@zugfolge/identity";
import type { PlanningInfrastructureRelease } from "@zugfolge/planning-worker";
import type { FleetRuntime, NativeFleetWorldState } from "@zugfolge/runtime-native";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendDemandEvent, demandHash } from "./demand-store.js";
import { parseSpfvDraft, SpfvService, type SpfvDraft, type SpfvEstimate, type SpfvScope, type SpfvServiceDependencies } from "./spfv-service.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const OTHER_WORLD = "22222222-2222-4222-8222-222222222222";
const OPERATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRAFT: SpfvDraft = { name: "Fernlinie", stopIds: ["a", "c"], headwayS: 3_600, fareCents: "1200",
  formationId: "formation", validFromS: 3_600, validUntilS: 10_800, referenceTrainId: "reference" };
const ESTIMATE: SpfvEstimate = { source: { kind: "balanced", releaseId: "demand-fixture", revision: 1 }, requested: 120,
  served: 100, unserved: 20, fareRevenueCents: "120000", costsCents: "70000", conflicts: [], connectionEffects: ["20 Reisende bleiben zurück."] };

function release(): PlanningInfrastructureRelease {
  return { schemaVersion: "planning.infrastructure-release/v1", worldId: WORLD, releaseId: "infra", sourceId: "fixture", corridorId: "corridor", corridorName: "Testkorridor",
    stations: ["a", "b", "c"].map((id, index) => ({ numericId: index + 1, id, code: id.toUpperCase(), name: `Bahnhof ${id}`,
      distanceMm: index * 1_000_000, latitudeE7: 510_000_000, longitudeE7: 120_000_000, stationTrackNumericId: index + 10,
      stationTrackLengthMm: 150_000, stationMaximumSpeedKph: 80 })),
    segments: [["a", "b"], ["b", "c"]].map(([from, to], index) => ({ edgeNumericId: index + 1, trackNumericId: index + 1,
      id: `${from}-${to}`, label: `${from}-${to}`, fromStationId: from!, toStationId: to!, lengthMm: 1_000_000,
      maximumSpeedKph: 100, mainSignalPositionsMm: [0], maximumVirtualBlockLengthMm: 1_000_000 })) };
}

async function fixture(db: ReturnType<typeof drizzle<typeof schema>>) {
  const state: NativeFleetWorldState = { schemaVersion: "zugfolge-fleet-world-state/v2", worldId: WORLD, revision: 0, producedAt: 0,
    authorityReleaseHash: "a".repeat(64), authorityRelease: { schemaVersion: "zugfolge-fleet-authority-release/v1", releaseId: "fleet", referenceYear: 2026,
      assets: [{ id: "asset", numericId: 1, operatorId: OPERATOR, vehicleTypeId: 1, classDesignation: "TEST", tradeName: "Testzug",
        buildYear: 2020, acquisitionYear: 2025, procurementChannel: "leasing", approvedLineIds: ["route"],
        maintenanceDeadlines: [{ kind: "inspection", dueAt: 100_000 }], installedProtection: ["pzb"],
        technical: { lengthMm: 70_000, massKg: 120_000, maximumSpeedKph: 160, traction: "electric", electricSystems: ["ac15kv"],
          accelerationMmPerS2: 800, decelerationMmPerS2: 900 },
        passenger: { seats: 120, firstClassSeats: 12, accessible: true, bicyclePlaces: 8, wheelchairPlaces: 2,
          equipment: ["pis"], operatingCostCentsPerTrainKm: 700, replacementPlan: true }, deliveredAt: 0, retiredAt: 100_000 }],
      personnelPools: [], pathReceipts: [{ id: "path", numericRouteId: 1, operatorId: OPERATOR, serviceLineIds: ["route"], decision: "confirmed",
        validFrom: 0, validUntil: 100_000, platformLengthsMm: [150_000], electrifications: ["overhead-ac15kv"], requiredProtection: ["pzb"],
        approvedClasses: ["TEST"], plannerStateHash: "b".repeat(64), conflictCheckHash: "c".repeat(64) }] },
    formations: { formation: { id: "formation", vehicleIds: ["asset"], pathReceiptId: "path" } }, personnelDuties: {}, pathReservations: {},
    assetHoldings: { asset: { ownerOperatorId: OPERATOR, holderOperatorId: OPERATOR, lessorOperatorId: null, contractId: null, validUntilS: null, historyHash: "d".repeat(64) } } };
  const snapshot: FleetMobilizationSnapshot = { schema: "zugfolge-fleet-mobilization/v1", worldId: WORLD, revision: 0, producedAt: 0,
    formations: [{ id: "formation", operatorId: OPERATOR, vehicleIds: ["asset"], pathReceiptId: "path", serviceLineIds: ["route"],
      availability: "available", procurement: "delivered", availableFrom: 0, availableUntil: 100_000,
      characteristics: { seats: 120, firstClassBasisPoints: 1_000, accessible: true, bicyclePlaces: 8, wheelchairPlaces: 2, equipment: ["pis"],
        vehicleAgeYears: 6, maximumSpeedKph: 160, operatingCostCentsPerTrainKm: 700, homologatedLineIds: ["route"], maintenanceValidUntil: 100_000,
        traction: "electric", replacementPlan: true } }], personnelDuties: [], pathReservations: [] };
  const snapshotHash = createFleetMobilizationEnvelope(snapshot).snapshotHash;
  const stateHash = demandHash(state);
  await db.insert(fleetMobilizationSnapshots).values({ worldId: WORLD, revision: 0, snapshotHash, payload: snapshot, producedAt: new Date(0), ingestedAt: new Date(0) });
  await db.insert(fleetWorldCheckpoints).values({ worldId: WORLD, revision: 0, stateSchema: state.schemaVersion, state, stateHash, snapshotHash,
    producedAt: new Date(0), ingestedAt: new Date(0) });
  const runtime: Pick<FleetRuntime, "verifyFleetWorldState"> = { verifyFleetWorldState(current, expected) {
    if (demandHash(current) !== expected) throw new Error("Checkpoint manipuliert.");
    return { schemaVersion: "zugfolge-fleet-world-state-verification/v1", worldId: current.worldId, revision: current.revision,
      producedAt: current.producedAt, authorityReleaseHash: current.authorityReleaseHash, stateHash: expected, snapshotHash };
  } };
  return runtime;
}

describe("SPFV: persistente Vorschau und bestehende Trassenautorität", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let deps: SpfvServiceDependencies;
  let service: SpfvService;
  let scope: SpfvScope;
  let time: number;
  let estimate: SpfvEstimate;

  beforeEach(async () => {
    client = new PGlite(); db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([{ id: WORLD, name: "Welt A", schedulePeriodWeeks: 3, epoch: new Date("2026-01-01T00:00:00Z") },
      { id: OTHER_WORLD, name: "Welt B", schedulePeriodWeeks: 3, epoch: new Date(0) }]);
    const access = await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "owner", displayName: "Owner" });
    await db.insert(operators).values({ id: OPERATOR, worldId: WORLD, foundingAccountId: access.id, name: "Fernverkehr" });
    scope = { worldId: WORLD, operatorId: OPERATOR, accountId: access.id }; time = 10; estimate = ESTIMATE;
    deps = { db, fleetRuntime: await fixture(db), timeForWorld: async () => time, infrastructureReleaseForWorld: () => release(), estimate: async () => estimate };
    service = new SpfvService(deps);
  }, 30_000);
  afterEach(async () => { await client.close(); });

  it("bindet echte Flottenkapazität, bewahrt fehlende Nachfrage und verbraucht in der Vorschau keine Zugnummer", async () => {
    const catalog = await service.catalog(scope);
    expect(catalog).toMatchObject({ schema: "zugfolge-spfv-catalog/v1", stops: [{ id: "a" }, { id: "b" }, { id: "c" }], formations: [{ id: "formation", seats: 120 }] });
    const preview = await service.preview(scope, DRAFT);
    expect(preview).toMatchObject({ schema: "zugfolge-spfv-preview/v1", source: "assumption", provenance: ESTIMATE.source, capacity: 120, requestedPassengers: 120, servedPassengers: 100,
      unservedPassengers: 20, confirmationAllowed: true, planningRequestCount: 2, planningStatus: "not-yet-allocated" });
    expect(await db.select().from(planningTrainNumbers)).toHaveLength(0);
    expect(await db.select().from(simulationCommands)).toHaveLength(0);
    expect(await service.preview(scope, DRAFT)).toEqual(preview);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.eventType, "spfv.preview"))).toHaveLength(1);
    estimate = { ...ESTIMATE, requested: 200 };
    expect(await service.preview(scope, DRAFT)).toMatchObject({ requestedPassengers: 200, servedPassengers: 100, unservedPassengers: 20, confirmationAllowed: true });
    estimate = { ...ESTIMATE, requested: null, served: null, unserved: null, fareRevenueCents: null, costsCents: null, conflicts: ["Referenz fehlt."] };
    expect(await service.preview(scope, DRAFT)).toMatchObject({ requestedPassengers: null, confirmationAllowed: false });
  });

  it("persistiert alle Anträge atomar und liefert nach Neustart und Ablauf denselben Bestätigungsbeleg", async () => {
    const preview = await service.preview(scope, DRAFT);
    const submitted = await service.confirm(scope, { previewId: preview.previewId, commandId: "confirm" });
    expect(submitted.status).toBe("submitted"); expect(submitted.planningRequestIds).toHaveLength(2);
    const requests = await db.select().from(simulationCommands).where(eq(simulationCommands.commandType, "planning.path-request"));
    expect(requests.map(({ payload }) => (payload as { desiredDepartureS: number }).desiredDepartureS)).toEqual([3_600, 7_200]);
    expect(requests[0]?.payload).toMatchObject({ worldId: WORLD, operatorId: OPERATOR, trainCategory: "long-distance", fleetRevision: 0 });
    expect(requests[0]?.payload).toHaveProperty("serviceWindow", { validFromS: 3600, validUntilS: 3601 });
    const [coordination] = await db.select().from(simulationCommands).where(eq(simulationCommands.id, submitted.planningCoordinationId));
    expect(coordination).toMatchObject({ commandType: "planning.coordinate", status: "pending",
      payload: { schemaVersion: "planning.coordinate/v2", requestCommandIds: submitted.planningRequestIds } });
    expect(requests[0]?.submittedAt.toISOString()).toBe("2026-01-01T00:00:10.000Z");
    time = 2_000;
    expect(await new SpfvService(deps).confirm(scope, { previewId: preview.previewId, commandId: "confirm" })).toEqual(submitted);
    expect(await service.confirm(scope, { previewId: preview.previewId, commandId: "retry-alias" })).toEqual(submitted);
    expect(await db.select().from(planningTrainNumbers)).toHaveLength(2);
    await expect(service.confirm(scope, { previewId: "different", commandId: "confirm" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rollt den ersten Antrag und seine Nummer zurück, wenn ein späterer Queue-Write fehlschlägt", async () => {
    const preview = await service.preview(scope, DRAFT);
    await db.execute(sql`alter table simulation_commands add constraint spfv_test_window check (command_type <> 'planning.path-request' or (payload->>'desiredDepartureS')::integer < 7000)`);
    await expect(service.confirm(scope, { previewId: preview.previewId, commandId: "fail" })).rejects.toThrow();
    expect(await db.select().from(simulationCommands)).toHaveLength(0);
    expect(await db.select().from(planningTrainNumbers)).toHaveLength(0);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.eventType, "spfv.submitted"))).toHaveLength(0);
  });

  it("ersetzt nur eigene künftig betroffene native Reservierungen und wartet auf ausstehende Planung", async () => {
    const firstPreview = await service.preview(scope, DRAFT);
    const first = await service.confirm(scope, { previewId: firstPreview.previewId, commandId: "first" });
    const editDraft = { ...DRAFT, lineId: first.lineId, validFromS: 7200, fareCents: "900" };
    const edit = await service.preview(scope, editDraft);
    await expect(service.confirm(scope, { previewId: edit.previewId, commandId: "edit" })).rejects.toThrow("Trassenkoordinierung");
    const old = await db.select().from(simulationCommands).where(eq(simulationCommands.commandType, "planning.path-request"));
    const reservations = Object.fromEntries(old.map(({ payload }) => {
      const request = payload as {trainId: string; trainNumber: number; desiredDepartureS: number};
      return [request.trainId, {number: request.trainNumber, passengerStops: [
        {stationId: "a", departureS: request.desiredDepartureS}, {stationId: "c", departureS: request.desiredDepartureS + 600}]}];
    }));
    // Transport fixture: the native tests independently prove reservation and time validity.
    const sequence = (await db.select().from(domainEvents)).length + 1;
    await db.insert(domainEvents).values({ worldId: WORLD, sequence, eventType: "planning.runtime-state", occurredAt: new Date(),
      payload: { projectionRevision: 1, state: { infrastructureHash: "f".repeat(64), reservations } } });
    await db.update(simulationCommands).set({ status: "processed" });
    await expect(service.confirm(scope, { previewId: edit.previewId, commandId: "edit" })).rejects.toThrow("Trassenzuordnung");
    const freshEdit = await service.preview(scope, editDraft);
    const expectedTrip = old.map(({payload}) => payload as {trainId: string; trainNumber: number; desiredDepartureS: number})
      .find((request) => request.desiredDepartureS === 7200)!;
    expect(freshEdit.replacementTrips).toEqual([{trainId: expectedTrip.trainId, trainNumber: expectedTrip.trainNumber,
      departureS: 7200, originLabel: "Bahnhof a", destinationLabel: "Bahnhof c"}]);
    const changed = structuredClone(reservations);
    changed[expectedTrip.trainId]!.passengerStops[0]!.departureS = 7201;
    await appendDemandEvent(db, WORLD, "planning.runtime-state", {
      projectionRevision: 2, state: {infrastructureHash: "f".repeat(64), reservations: changed}}, new Date(0));
    await expect(service.confirm(scope, {previewId: freshEdit.previewId, commandId: "edit"})).rejects.toThrow("Trassenzuordnung");
    await appendDemandEvent(db, WORLD, "planning.runtime-state", {
      projectionRevision: 3, state: {infrastructureHash: "f".repeat(64), reservations}}, new Date(0));
    const second = await service.confirm(scope, { previewId: freshEdit.previewId, commandId: "edit" });
    const [coordinate] = await db.select().from(simulationCommands).where(eq(simulationCommands.id, second.planningCoordinationId));
    const expected = old.filter(({ payload }) => (payload as { desiredDepartureS: number }).desiredDepartureS >= 7200)
      .map(({ payload }) => (payload as { trainId: string }).trainId);
    expect(coordinate?.payload).toMatchObject({ expectedProjectionRevision: 3, replaceTrainIds: expected, effectiveFromS: 10 });
    expect(freshEdit.replacementTrainIds).toEqual(expected);
    expect(second.planningRequestIds).toHaveLength(1);
    expect(second.planningRequestIds[0]).not.toBe(first.planningRequestIds[0]);
    expect((await service.catalog(scope)).lines).toMatchObject([{ lineId: first.lineId, fareCents: "900" }]);
  });

  it("verweigert fremde Welten, fremde Konten, veraltete Prognosen und ungültige Laufwege", async () => {
    await expect(service.preview({ ...scope, worldId: OTHER_WORLD }, DRAFT)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.preview({ ...scope, accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, DRAFT)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.preview(scope, { ...DRAFT, stopIds: ["a", "c", "b"] })).rejects.toMatchObject({ statusCode: 409 });
    const preview = await service.preview(scope, DRAFT);
    estimate = { ...ESTIMATE, costsCents: "80000" };
    await expect(service.confirm(scope, { previewId: preview.previewId, commandId: "changed" })).rejects.toMatchObject({ statusCode: 409 });
    estimate = ESTIMATE; time = 311;
    await expect(service.confirm(scope, { previewId: preview.previewId, commandId: "expired" })).rejects.toMatchObject({ statusCode: 409 });
    expect(await db.select().from(simulationCommands)).toHaveLength(0);
  });
});

it("begrenzt Integer, Fristen und Batchgröße vor jeder Datenbankmutation", () => {
  expect(parseSpfvDraft(DRAFT)).toEqual(DRAFT);
  for (const input of [{ ...DRAFT, fareCents: "9223372036854775808" }, { ...DRAFT, headwayS: 60.5 },
    { ...DRAFT, validUntilS: Number.MAX_SAFE_INTEGER }, { ...DRAFT, seats: 99999 }, { ...DRAFT, stopIds: ["a", "a"] }]) {
    expect(() => parseSpfvDraft(input)).toThrow();
  }
});
