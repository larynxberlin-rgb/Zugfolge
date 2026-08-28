import { PGlite } from "@electric-sql/pglite";
import { accounts, alphaWorldProfiles, economyOutbox, MIGRATIONS_FOLDER, operators, schema, worldEventLog, worlds } from "@zugfolge/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatingRuntime } from "@zugfolge/runtime-native";

import type { EconomyDatabase } from "./ledger.js";
import { buildEconomyRelease } from "./release.js";
import {
  createFleetMobilizationEnvelope,
  fleetSnapshotHash,
  persistFleetMobilizationSnapshot,
  PUBLIC_ENTRY_FACILITY_SCHEMA,
  resolvePublicEntryFacilityVehicleConcept,
  resolveVehicleConcept,
  verifyMobilizationReference,
  type FleetMobilizationSnapshot,
} from "./fleet-snapshot.js";
import { EconomySchedulerMonitor, createEconomySchedulerHealthCheck, runEconomySchedulerCycle } from "./runtime.js";
import { loadEconomyWorldState, persistEconomyTransition } from "./state-store.js";
import { announceTender, startEconomyWorld, submitBid, submitMobilizationReference } from "./workflow.js";

const WORLD = "55555555-5555-4555-8555-555555555555";
const FAILING_WORLD = "11111111-1111-4111-8111-111111111111";
const CASH_WRITER_ACCOUNT = "66666666-6666-4666-8666-666666666666";
const CASH_WRITER_OPERATOR = "77777777-7777-4777-8777-777777777777";
const OPEN = 100;
const CLOSE = OPEN + 3 * 86_400;
const OPERATING = CLOSE + 10_000;
const WORLD_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");
const worldInstant = (seconds: number): Date => new Date(WORLD_EPOCH_MS + seconds * 1_000);

const testOperatingRuntime: OperatingRuntime = {
  verifyFleetMobilizationSnapshot(snapshot) {
    const fleetSnapshot = snapshot as FleetMobilizationSnapshot;
    return {
      schemaVersion: "zugfolge-fleet-mobilization-verification/v1",
      worldId: fleetSnapshot.worldId,
      fleetRevision: fleetSnapshot.revision,
      snapshotHash: fleetSnapshotHash(fleetSnapshot),
    };
  },
  initialize(input) {
    return {
      schemaVersion: "zugfolge-operating-world-initialized/v1",
      state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId: input.worldId, revision: 0 },
      stateHash: "a".repeat(64),
    };
  },
  applyTransition(_state, command) {
    const success = command.mobilizationProof !== null;
    const operatorId = success ? command.winnerOperatorId : "public";
    return {
      schemaVersion: "zugfolge-operating-transition-result/v1",
      state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId: command.worldId, revision: command.expectedRevision + 1 },
      stateHash: "b".repeat(64),
      outcome: { lotId: command.lotId, previousOperatorId: "public", operatorId, kind: success ? "operator-change" : "public-operation", seamless: false, penaltyRequired: !success, trainRunIds: ["test-train-1"], livemapMarker: success ? null : "public-operator" },
      events: [
        { eventId: `${command.commandId}:0`, worldId: command.worldId, eventType: "operating-duty-ended", atS: command.atS, payload: { worldId: command.worldId, lotId: command.lotId } },
        { eventId: `${command.commandId}:1`, worldId: command.worldId, eventType: "operating-transition-completed", atS: command.atS, payload: { worldId: command.worldId, lotId: command.lotId } },
        { eventId: `${command.commandId}:2`, worldId: command.worldId, eventType: "train-operation-assigned", atS: command.atS, payload: { worldId: command.worldId, trainRunId: "test-train-1" } },
        { eventId: `${command.commandId}:3`, worldId: command.worldId, eventType: success ? "livemap-operation-cleared" : "livemap-operation-marked", atS: command.atS, payload: { worldId: command.worldId, trainRunIds: ["test-train-1"], marker: success ? null : "public-operator" } },
      ],
      idempotentReplay: false,
    };
  },
};

const release = buildEconomyRelease({
  version: "scheduler-v1",
  rates: {
    trackPerTrainKmCents: 1n, stationPerStopCents: 1n, facilityPerHourCents: 1n,
    energyPerKwhCents: 1n, personnelPerHourCents: 1n, administrationPerPeriodCents: 1n,
    vehiclePerPeriodCents: 1n, overnightStablingPerPeriodCents: 1n,
    protectionEquipmentPerPeriodCents: 1n, lateInterestBasisPoints: 1,
  },
  rules: {
    qualityBaselinePunctualityBasisPoints: 8_500, pointsPerExtraSeat: 1,
    pointsPerPunctualityBasisPoint: 1, pointsPerAdditionalStop: 1,
    requirementFocusMaximumPoints: 1_000, contractBonusCentsPerPeriod: 1n,
    penaltyRates: { punctuality: 1n, cancellation: 1n, seats: 1n, connections: 1n },
    penaltyFocusMultiplierBasisPoints: 10_000, publicOperationSurchargeBasisPoints: 0,
    failedPackageFeeStepBasisPoints: 0, failedPackageReductionStepBasisPoints: 0,
  },
  tenderProfiles: [
    { id: "a", weights: { price: 5_000, quality: 5_000 }, requirementFocus: "capacity", penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 10_000 },
    { id: "b", weights: { price: 5_000, quality: 5_000 }, requirementFocus: "bicycle", penaltyFocus: "connections", viabilitySurchargeBasisPoints: 10_000 },
  ],
});

const specification = {
  lines: ["S1"], trainKmPerPeriod: 100n, stopsPerPeriod: 10n,
  serviceHoursPerPeriod: 10n, facilityHoursPerPeriod: 1n, energyKwhPerPeriod: 10n,
  vehicleCount: 1n, overnightUnits: 1n, protectionUnits: 1n,
  requirements: { minimumSeats: 100, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 2, wheelchairPlaces: 1, requiredEquipment: ["pis"] },
};

function fleet(): FleetMobilizationSnapshot {
  return {
    schema: "zugfolge-fleet-mobilization/v1",
    worldId: WORLD,
    revision: 4,
    producedAt: 50,
    formations: [{
      id: "formation-1", operatorId: "operator-1", vehicleIds: ["vehicle-1"], pathReceiptId: "path-receipt-1", serviceLineIds: ["S1"],
      availability: "available", procurement: "delivered", availableFrom: 0, availableUntil: OPERATING + 10_000,
      characteristics: { seats: 120, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 4, wheelchairPlaces: 1, equipment: ["pis"], vehicleAgeYears: 2, maximumSpeedKph: 160, operatingCostCentsPerTrainKm: 700, homologatedLineIds: ["S1"], maintenanceValidUntil: OPERATING + 10_000, traction: "electric", replacementPlan: true },
    }],
    personnelDuties: [{ id: "duty-1", operatorId: "operator-1", formationIds: ["formation-1"], pathReceiptId: "path-receipt-1", status: "ready", validFrom: 0, validUntil: OPERATING + 10_000 }],
    pathReservations: [{ id: "path-1", operatorId: "operator-1", pathReceiptId: "path-receipt-1", serviceLineIds: ["S1"], status: "confirmed", validFrom: 0, validUntil: OPERATING + 10_000 }],
  };
}

function publicFleet(): FleetMobilizationSnapshot {
  const source = fleet();
  return {
    ...source,
    formations: source.formations.map((formation) => ({ ...formation, operatorId: "public" })),
    personnelDuties: source.personnelDuties.map((duty) => ({ ...duty, operatorId: "public" })),
    pathReservations: source.pathReservations.map((path) => ({ ...path, operatorId: "public" })),
  };
}

describe("restart-sicherer Economy-Scheduler", () => {
  let client: PGlite;
  let db: EconomyDatabase;

  beforeEach(async () => {
    client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    await database.insert(worlds).values({ id: WORLD, name: "Scheduler", schedulePeriodWeeks: 3, epoch: worldInstant(0) });
    db = database;
  });

  afterEach(async () => client.close());

  it("verarbeitet exakte Fristen nachholbar, persistent und ohne Duplikate", async () => {
    const started = startEconomyWorld({
      worldId: WORLD, seed: 1n, durationMonths: 6, release,
      lots: Array.from({ length: 8 }, (_, index) => ({ id: `lot-${index}`, size: 100 - index, attractiveness: index })),
      authorityBudgets: [{ authorityId: "authority", period: 0, availableCents: 10_000_000n, committedCents: 0n }],
      accounts: ["account-1"],
    });
    await persistEconomyTransition(db, { expectedRevision: null, ...started, committedAt: worldInstant(0), enqueuedAt: worldInstant(0) });
    const announced = announceTender(started.state, {
      commandId: "api:announce", release, recipients: ["account-1"],
      automation: { authorityId: "authority", budgetPeriod: 0, vehiclePool: [], recipientByOperator: { "operator-1": "account-1" }, failurePenaltyCents: 1_000n },
      tender: { id: "tender-1", worldId: WORLD, lotId: "lot-0", incumbentOperatorId: "public", specification, announcedAt: 0, opensAt: OPEN, closesAt: CLOSE, operatingFrom: OPERATING, contractPeriods: 2, periodDurationSeconds: 21 * 86_400, smallLot: false },
    });
    await persistEconomyTransition(db, { expectedRevision: 0, ...announced, committedAt: worldInstant(1), enqueuedAt: worldInstant(1) });

    const sendNotice = vi.fn(async () => undefined);
    const postJournal = vi.fn(async () => undefined);
    const publishRuntimeEvents = vi.fn(async () => undefined);
    const adapters = { sendNotice, postJournal, operatingRuntime: testOperatingRuntime, publishRuntimeEvents };
    const firstMonitor = new EconomySchedulerMonitor(WORLD_EPOCH_MS);
    expect(await runEconomySchedulerCycle(db, worldInstant(OPEN), adapters, firstMonitor)).toMatchObject({ transitions: 1 });

    let state = (await loadEconomyWorldState(db, WORLD))!;
    const fleetEnvelope = createFleetMobilizationEnvelope(fleet());
    await persistFleetMobilizationSnapshot(db, WORLD, fleetEnvelope, worldInstant(OPEN));
    const vehicle = resolveVehicleConcept(fleetEnvelope.snapshot, { fleetRevision: 4, snapshotHash: fleetEnvelope.snapshotHash, formationId: "formation-1" }, { operatorId: "operator-1", serviceLineIds: ["S1"], operatingFrom: OPERATING });
    const bidState = submitBid(state, "api:bid", "tender-1", { id: "bid-1", operatorId: "operator-1", orderingFeeCentsPerTrainKm: 1n, vehicle, promises: { extraSeats: 0, punctualityBasisPoints: 9_000, additionalStops: 0 }, submittedAt: OPEN }, { accountId: "account-1", period: 0, smallLot: false, minimumScore: 0 });
    await persistEconomyTransition(db, { expectedRevision: state.revision, state: bidState, effects: { notices: [], journal: [] }, committedAt: worldInstant(OPEN), enqueuedAt: worldInstant(OPEN) });

    // Neuer Monitor simuliert einen Prozessneustart vor dem Zuschlag.
    const restartedMonitor = new EconomySchedulerMonitor(worldInstant(CLOSE).getTime() - 1);
    expect(await runEconomySchedulerCycle(db, worldInstant(CLOSE + 5), adapters, restartedMonitor)).toMatchObject({ transitions: 1 });
    state = (await loadEconomyWorldState(db, WORLD))!;
    expect(state.tenders.get("tender-1")?.phase).toBe("awarded");

    const reference = { fleetRevision: 4, snapshotHash: fleetEnvelope.snapshotHash, formationIds: ["formation-1"], personnelDutyIds: ["duty-1"], pathReservationIds: ["path-1"] };
    verifyMobilizationReference(fleetEnvelope.snapshot, reference, { operatorId: "operator-1", winningFormationId: "formation-1", serviceLineIds: ["S1"], operatingFrom: OPERATING });
    const referenced = submitMobilizationReference(state, { commandId: "api:mobilization", tenderId: "tender-1", operatorId: "operator-1", at: CLOSE + 5, reference });
    await persistEconomyTransition(db, { expectedRevision: state.revision, state: referenced, effects: { notices: [], journal: [] }, committedAt: worldInstant(CLOSE + 5), enqueuedAt: worldInstant(CLOSE + 5) });

    expect(await runEconomySchedulerCycle(db, worldInstant(OPERATING + 10), adapters, restartedMonitor)).toMatchObject({ transitions: 1 });
    const completed = (await loadEconomyWorldState(db, WORLD))!;
    expect(completed.contracts.get("tender-1")?.operatorId).toBe("operator-1");
    expect(completed.mobilizations.get("tender-1")?.proof?.snapshotHash).toBe(fleetEnvelope.snapshotHash);
    expect(completed.operatingRuntimeByLot.get("lot-0")?.stateHash).toBe("b".repeat(64));
    expect((await worldEventLog(db, WORLD).list()).map((event) => event.eventType)).toContain("operating-transition-completed");
    expect(publishRuntimeEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ eventType: "operating-transition-completed", worldId: WORLD }),
    ]));
    const replay = await runEconomySchedulerCycle(db, worldInstant(OPERATING + 20), adapters, restartedMonitor);
    expect(replay.transitions).toBe(0);
    expect(completed.processedCommands).toEqual((await loadEconomyWorldState(db, WORLD))?.processedCommands);
    expect(sendNotice).toHaveBeenCalled();
    expect(postJournal).not.toHaveBeenCalled();
    expect(await createEconomySchedulerHealthCheck(restartedMonitor, 30_000, () => worldInstant(OPERATING + 20).getTime()).check()).toMatchObject({ status: "ok", code: "scheduler_current" });
  });

  it("isoliert den Outbox-Fehler einer aktiven Welt von allen anderen aktiven Welten", async () => {
    await db.insert(worlds).values({
      id: FAILING_WORLD,
      name: "Fehlerhafte zweite Welt",
      schedulePeriodWeeks: 3,
      epoch: worldInstant(0),
      worldKind: "private",
      rankingStatus: "unranked",
    });
    const notice = (worldId: string) => ({
      id: `notice:${worldId}`,
      worldId,
      recipientAccountId: `account:${worldId}`,
      type: "recovery-test",
      at: 1,
      payload: {},
    });
    await db.insert(economyOutbox).values([
      {
        worldId: FAILING_WORLD,
        effectId: "failing-notice",
        effectType: "notice",
        payload: notice(FAILING_WORLD),
        occurredAt: worldInstant(1),
        enqueuedAt: worldInstant(2),
      },
      {
        worldId: WORLD,
        effectId: "active-notice",
        effectType: "notice",
        payload: notice(WORLD),
        occurredAt: worldInstant(1),
        enqueuedAt: worldInstant(2),
      },
    ]);
    const delivered: string[] = [];
    const failingAdapters = {
      async sendNotice(value: ReturnType<typeof notice>) {
        if (value.worldId === FAILING_WORLD) throw new Error("secondary adapter failure");
        delivered.push(value.worldId);
      },
      postJournal: vi.fn(async () => undefined),
      operatingRuntime: testOperatingRuntime,
      publishRuntimeEvents: vi.fn(async () => undefined),
    };
    const monitor = new EconomySchedulerMonitor(WORLD_EPOCH_MS);

    await expect(runEconomySchedulerCycle(db, worldInstant(3), failingAdapters, monitor)).rejects.toThrow("secondary adapter failure");
    expect(delivered).toEqual([WORLD]);
    expect((await db.select().from(economyOutbox).where(eq(economyOutbox.worldId, FAILING_WORLD)))[0]).toMatchObject({ processedAt: null, attempts: 1 });
    expect((await db.select().from(economyOutbox).where(eq(economyOutbox.worldId, WORLD)))[0]?.processedAt).toEqual(worldInstant(3));

    const recoverySend = vi.fn(async () => undefined);
    await expect(runEconomySchedulerCycle(db, worldInstant(4), {
      ...failingAdapters,
      sendNotice: recoverySend,
    }, monitor)).resolves.toMatchObject({ worlds: 0, transitions: 0, effects: 1 });
    expect(recoverySend).toHaveBeenCalledWith(expect.objectContaining({ worldId: FAILING_WORLD }));
    expect((await db.select().from(economyOutbox).where(eq(economyOutbox.worldId, FAILING_WORLD)))[0]).toMatchObject({
      processedAt: worldInstant(4),
      attempts: 1,
      lastErrorCode: null,
    });
  });

  it("macht den Nullstart erst nach Zuschlag ueber die signierte Public-Facility mobilisierbar", async () => {
    const fleetState = publicFleet();
    const started = startEconomyWorld({
      worldId: WORLD, seed: 1n, durationMonths: 6, release,
      lots: Array.from({ length: 8 }, (_, index) => ({ id: `lot-${index}`, size: 100 - index, attractiveness: index })),
      authorityBudgets: [{ authorityId: "authority", period: 0, availableCents: 10_000_000n, committedCents: 0n }],
      accounts: ["account-1"],
      publicVehiclePoolByLot: { "lot-0": ["vehicle-1"] },
    });
    await persistEconomyTransition(db, { expectedRevision: null, ...started, committedAt: worldInstant(0), enqueuedAt: worldInstant(0) });
    await db.insert(alphaWorldProfiles).values({
      worldId: WORLD, profileKind: "public", regionId: "mitteldeutschland-b", regionVariant: "B", worldSeed: 1n,
      accelerationFactor: 1, infraReleaseHash: "a".repeat(64), timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64), economyReleaseHash: "d".repeat(64),
      blueprint: {
        entryFacilityPolicy: {
          schemaVersion: PUBLIC_ENTRY_FACILITY_SCHEMA,
          mode: "award-contingent-wet-lease",
          providerOperatorId: "public",
          costBasis: "formation-operating-cost",
        },
        lots: [{
          lotId: "lot-0",
          vehicleIds: ["vehicle-1"],
          personnelDutyIds: ["duty-1"],
          pathReceiptIds: ["path-receipt-1"],
        }],
      },
      blueprintHash: "e".repeat(64), deploymentHash: "f".repeat(64), state: "running",
    });
    let state = announceTender(started.state, {
      commandId: "facility:announce", release, recipients: ["account-1"],
      automation: { authorityId: "authority", budgetPeriod: 0, vehiclePool: ["vehicle-1"], recipientByOperator: { "operator-1": "account-1" }, failurePenaltyCents: 1_000n },
      tender: { id: "tender-facility", worldId: WORLD, lotId: "lot-0", incumbentOperatorId: "public", specification, announcedAt: 0, opensAt: OPEN, closesAt: CLOSE, operatingFrom: OPERATING, contractPeriods: 2, periodDurationSeconds: 21 * 86_400, smallLot: false },
    }).state;
    await persistEconomyTransition(db, { expectedRevision: 0, state, effects: { notices: [], journal: [] }, committedAt: worldInstant(1), enqueuedAt: worldInstant(1) });
    const adapters = { sendNotice: vi.fn(async () => undefined), postJournal: vi.fn(async () => undefined), operatingRuntime: testOperatingRuntime, publishRuntimeEvents: vi.fn(async () => undefined) };
    const monitor = new EconomySchedulerMonitor(WORLD_EPOCH_MS);
    await runEconomySchedulerCycle(db, worldInstant(OPEN), adapters, monitor);
    state = (await loadEconomyWorldState(db, WORLD))!;
    const envelope = createFleetMobilizationEnvelope(fleetState);
    await persistFleetMobilizationSnapshot(db, WORLD, envelope, worldInstant(OPEN));
    const vehicle = resolvePublicEntryFacilityVehicleConcept(envelope.snapshot, {
      fleetRevision: 4,
      snapshotHash: envelope.snapshotHash,
      formationId: "formation-1",
      personnelDutyIds: ["duty-1"],
      pathReservationIds: ["path-1"],
      entryFacility: { schemaVersion: PUBLIC_ENTRY_FACILITY_SCHEMA, providerOperatorId: "public" },
    }, {
      providerOperatorId: "public",
      signedLotVehicleIds: ["vehicle-1"],
      signedLotPersonnelDutyIds: ["duty-1"],
      signedLotPathReceiptIds: ["path-receipt-1"],
      serviceLineIds: ["S1"],
      operatingFrom: OPERATING,
    });
    state = submitBid(state, "facility:bid", "tender-facility", {
      id: "facility-bid", operatorId: "operator-1", orderingFeeCentsPerTrainKm: 1n, vehicle,
      promises: { extraSeats: 0, punctualityBasisPoints: 9_000, additionalStops: 0 }, submittedAt: OPEN,
    }, { accountId: "account-1", period: 0, smallLot: false, minimumScore: 0 });
    await persistEconomyTransition(db, { expectedRevision: state.revision - 1, state, effects: { notices: [], journal: [] }, committedAt: worldInstant(OPEN), enqueuedAt: worldInstant(OPEN) });
    await runEconomySchedulerCycle(db, worldInstant(CLOSE), adapters, monitor);
    state = (await loadEconomyWorldState(db, WORLD))!;
    const reference = {
      fleetRevision: 4, snapshotHash: envelope.snapshotHash,
      formationIds: ["formation-1"], personnelDutyIds: ["duty-1"], pathReservationIds: ["path-1"],
      entryFacility: { schemaVersion: PUBLIC_ENTRY_FACILITY_SCHEMA, providerOperatorId: "public" },
    } as const;
    state = submitMobilizationReference(state, { commandId: "facility:mobilization", tenderId: "tender-facility", operatorId: "operator-1", at: CLOSE, reference });
    await persistEconomyTransition(db, { expectedRevision: state.revision - 1, state, effects: { notices: [], journal: [] }, committedAt: worldInstant(CLOSE), enqueuedAt: worldInstant(CLOSE) });

    await runEconomySchedulerCycle(db, worldInstant(OPERATING), adapters, monitor);
    const completed = (await loadEconomyWorldState(db, WORLD))!;
    expect(completed.contracts.get("tender-facility")?.operatorId).toBe("operator-1");
    expect(completed.mobilizations.get("tender-facility")?.proof).toMatchObject({
      formationIds: ["formation-1"], personnelDutyIds: ["duty-1"], pathReservationIds: ["path-1"],
    });
  });

  it("verwirft eine erst nach dem Zuschlag eingeschleuste Fremdlos-Trasse nochmals im Scheduler", async () => {
    await db.insert(accounts).values({
      id: CASH_WRITER_ACCOUNT,
      worldId: WORLD,
      keycloakSubject: "cash-writer-test",
      displayName: "Cash Writer Test",
    });
    await db.insert(operators).values({
      id: CASH_WRITER_OPERATOR,
      worldId: WORLD,
      foundingAccountId: CASH_WRITER_ACCOUNT,
      name: "Cash Writer Test EVU",
    });
    const sourceFleet = publicFleet();
    const fleetState: FleetMobilizationSnapshot = {
      ...sourceFleet,
      pathReservations: [
        sourceFleet.pathReservations[0]!,
        {
          ...sourceFleet.pathReservations[0]!,
          id: "path-foreign-lot",
          pathReceiptId: "path-receipt-foreign-lot",
        },
      ],
    };
    const started = startEconomyWorld({
      worldId: WORLD,
      seed: 1n,
      durationMonths: 6,
      release,
      lots: Array.from({ length: 8 }, (_, index) => ({ id: `lot-${index}`, size: 100 - index, attractiveness: index })),
      authorityBudgets: [{ authorityId: "authority", period: 0, availableCents: 10_000_000n, committedCents: 0n }],
      accounts: ["account-1"],
      publicVehiclePoolByLot: { "lot-0": ["vehicle-1"] },
    });
    await persistEconomyTransition(db, { expectedRevision: null, ...started, committedAt: worldInstant(0), enqueuedAt: worldInstant(0) });
    await db.insert(alphaWorldProfiles).values({
      worldId: WORLD,
      profileKind: "public",
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      worldSeed: 1n,
      accelerationFactor: 1,
      infraReleaseHash: "a".repeat(64),
      timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64),
      blueprint: {
        entryFacilityPolicy: {
          schemaVersion: PUBLIC_ENTRY_FACILITY_SCHEMA,
          mode: "award-contingent-wet-lease",
          providerOperatorId: "public",
          costBasis: "formation-operating-cost",
        },
        lots: [{
          lotId: "lot-0",
          vehicleIds: ["vehicle-1"],
          personnelDutyIds: ["duty-1"],
          pathReceiptIds: ["path-receipt-1"],
        }],
      },
      blueprintHash: "e".repeat(64),
      deploymentHash: "f".repeat(64),
      state: "running",
    });
    const announced = announceTender(started.state, {
      commandId: "facility:defense:announce",
      release,
      recipients: ["account-1"],
      automation: {
        authorityId: "authority",
        budgetPeriod: 0,
        vehiclePool: ["vehicle-1"],
        recipientByOperator: { [CASH_WRITER_OPERATOR]: "account-1" },
        failurePenaltyCents: 1_000n,
      },
      tender: {
        id: "tender-facility-defense",
        worldId: WORLD,
        lotId: "lot-0",
        incumbentOperatorId: "public",
        specification,
        announcedAt: 0,
        opensAt: OPEN,
        closesAt: CLOSE,
        operatingFrom: OPERATING,
        contractPeriods: 2,
        periodDurationSeconds: 21 * 86_400,
        smallLot: false,
      },
    });
    await persistEconomyTransition(db, { expectedRevision: 0, ...announced, committedAt: worldInstant(1), enqueuedAt: worldInstant(1) });
    const adapters = {
      sendNotice: vi.fn(async () => undefined),
      postJournal: vi.fn(async () => undefined),
      operatingRuntime: testOperatingRuntime,
      publishRuntimeEvents: vi.fn(async () => undefined),
    };
    const monitor = new EconomySchedulerMonitor(WORLD_EPOCH_MS);
    await runEconomySchedulerCycle(db, worldInstant(OPEN), adapters, monitor);
    let state = (await loadEconomyWorldState(db, WORLD))!;
    const envelope = createFleetMobilizationEnvelope(fleetState);
    await persistFleetMobilizationSnapshot(db, WORLD, envelope, worldInstant(OPEN));
    const entryFacility = { schemaVersion: PUBLIC_ENTRY_FACILITY_SCHEMA, providerOperatorId: "public" } as const;
    const vehicle = resolvePublicEntryFacilityVehicleConcept(envelope.snapshot, {
      fleetRevision: 4,
      snapshotHash: envelope.snapshotHash,
      formationId: "formation-1",
      personnelDutyIds: ["duty-1"],
      pathReservationIds: ["path-1"],
      entryFacility,
    }, {
      providerOperatorId: "public",
      signedLotVehicleIds: ["vehicle-1"],
      signedLotPersonnelDutyIds: ["duty-1"],
      signedLotPathReceiptIds: ["path-receipt-1"],
      serviceLineIds: ["S1"],
      operatingFrom: OPERATING,
    });
    state = submitBid(state, "facility:defense:bid", "tender-facility-defense", {
      id: "facility-defense-bid",
      operatorId: CASH_WRITER_OPERATOR,
      orderingFeeCentsPerTrainKm: 1n,
      vehicle,
      promises: { extraSeats: 0, punctualityBasisPoints: 9_000, additionalStops: 0 },
      submittedAt: OPEN,
    }, { accountId: "account-1", period: 0, smallLot: false, minimumScore: 0 });
    await persistEconomyTransition(db, { expectedRevision: state.revision - 1, state, effects: { notices: [], journal: [] }, committedAt: worldInstant(OPEN), enqueuedAt: worldInstant(OPEN) });
    await runEconomySchedulerCycle(db, worldInstant(CLOSE), adapters, monitor);
    state = (await loadEconomyWorldState(db, WORLD))!;
    state = submitMobilizationReference(state, {
      commandId: "facility:defense:mobilization",
      tenderId: "tender-facility-defense",
      operatorId: CASH_WRITER_OPERATOR,
      at: CLOSE,
      reference: {
        fleetRevision: 4,
        snapshotHash: envelope.snapshotHash,
        formationIds: ["formation-1"],
        personnelDutyIds: ["duty-1"],
        pathReservationIds: ["path-foreign-lot"],
        entryFacility,
      },
    });
    await persistEconomyTransition(db, { expectedRevision: state.revision - 1, state, effects: { notices: [], journal: [] }, committedAt: worldInstant(CLOSE), enqueuedAt: worldInstant(CLOSE) });

    await runEconomySchedulerCycle(db, worldInstant(OPERATING), adapters, monitor);
    const completed = (await loadEconomyWorldState(db, WORLD))!;
    expect(completed.contracts.has("tender-facility-defense")).toBe(false);
    expect(completed.publicOperations.has("lot-0")).toBe(true);
    expect(completed.mobilizations.get("tender-facility-defense")).toMatchObject({ completed: true });
    expect(completed.mobilizations.get("tender-facility-defense")?.proof).toBeUndefined();
    expect(adapters.postJournal).toHaveBeenCalledWith(expect.objectContaining({
      postings: [expect.objectContaining({ costType: "penalty", amountCents: 1_000n })],
    }));
  });
});
