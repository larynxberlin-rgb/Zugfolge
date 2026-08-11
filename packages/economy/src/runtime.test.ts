import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, schema, worldEventLog, worlds } from "@zugfolge/db";
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
  resolveVehicleConcept,
  verifyMobilizationReference,
  type FleetMobilizationSnapshot,
} from "./fleet-snapshot.js";
import { EconomySchedulerMonitor, createEconomySchedulerHealthCheck, runEconomySchedulerCycle } from "./runtime.js";
import { loadEconomyWorldState, persistEconomyTransition } from "./state-store.js";
import { announceTender, startEconomyWorld, submitBid, submitMobilizationReference } from "./workflow.js";

const WORLD = "55555555-5555-4555-8555-555555555555";
const OPEN = 100;
const CLOSE = OPEN + 3 * 86_400;
const OPERATING = CLOSE + 10_000;

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
      id: "formation-1", operatorId: "operator-1", vehicleIds: ["vehicle-1"], serviceLineIds: ["S1"],
      availability: "available", procurement: "delivered", availableFrom: 0, availableUntil: OPERATING + 10_000,
      characteristics: { seats: 120, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 4, wheelchairPlaces: 1, equipment: ["pis"], vehicleAgeYears: 2, maximumSpeedKph: 160, operatingCostCentsPerTrainKm: 700, homologatedLineIds: ["S1"], maintenanceValidUntil: OPERATING + 10_000, traction: "electric", replacementPlan: true },
    }],
    personnelDuties: [{ id: "duty-1", operatorId: "operator-1", formationIds: ["formation-1"], status: "ready", validFrom: 0, validUntil: OPERATING + 10_000 }],
    pathReservations: [{ id: "path-1", operatorId: "operator-1", serviceLineIds: ["S1"], status: "confirmed", validFrom: 0, validUntil: OPERATING + 10_000 }],
  };
}

describe("restart-sicherer Economy-Scheduler", () => {
  let client: PGlite;
  let db: EconomyDatabase;

  beforeEach(async () => {
    client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    await database.insert(worlds).values({ id: WORLD, name: "Scheduler", schedulePeriodWeeks: 3, epoch: new Date(0) });
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
    await persistEconomyTransition(db, { expectedRevision: null, ...started, committedAt: new Date(0) });
    const announced = announceTender(started.state, {
      commandId: "api:announce", release, recipients: ["account-1"],
      automation: { authorityId: "authority", budgetPeriod: 0, vehiclePool: [], recipientByOperator: { "operator-1": "account-1" }, failurePenaltyCents: 1_000n },
      tender: { id: "tender-1", worldId: WORLD, lotId: "lot-0", incumbentOperatorId: "public", specification, announcedAt: 0, opensAt: OPEN, closesAt: CLOSE, operatingFrom: OPERATING, contractPeriods: 2, periodDurationSeconds: 21 * 86_400, smallLot: false },
    });
    await persistEconomyTransition(db, { expectedRevision: 0, ...announced, committedAt: new Date(1_000) });

    const sendNotice = vi.fn(async () => undefined);
    const postJournal = vi.fn(async () => undefined);
    const publishRuntimeEvents = vi.fn(async () => undefined);
    const adapters = { sendNotice, postJournal, operatingRuntime: testOperatingRuntime, publishRuntimeEvents };
    const firstMonitor = new EconomySchedulerMonitor(0);
    expect(await runEconomySchedulerCycle(db, new Date(OPEN * 1_000), adapters, firstMonitor)).toMatchObject({ transitions: 1 });

    let state = (await loadEconomyWorldState(db, WORLD))!;
    const fleetEnvelope = createFleetMobilizationEnvelope(fleet());
    await persistFleetMobilizationSnapshot(db, WORLD, fleetEnvelope, new Date(OPEN * 1_000));
    const vehicle = resolveVehicleConcept(fleetEnvelope.snapshot, { fleetRevision: 4, snapshotHash: fleetEnvelope.snapshotHash, formationId: "formation-1" }, { operatorId: "operator-1", serviceLineIds: ["S1"], operatingFrom: OPERATING });
    const bidState = submitBid(state, "api:bid", "tender-1", { id: "bid-1", operatorId: "operator-1", orderingFeeCentsPerTrainKm: 1n, vehicle, promises: { extraSeats: 0, punctualityBasisPoints: 9_000, additionalStops: 0 }, submittedAt: OPEN }, { accountId: "account-1", period: 0, smallLot: false, minimumScore: 0 });
    await persistEconomyTransition(db, { expectedRevision: state.revision, state: bidState, effects: { notices: [], journal: [] }, committedAt: new Date(OPEN * 1_000) });

    // Neuer Monitor simuliert einen Prozessneustart vor dem Zuschlag.
    const restartedMonitor = new EconomySchedulerMonitor(CLOSE * 1_000 - 1);
    expect(await runEconomySchedulerCycle(db, new Date((CLOSE + 5) * 1_000), adapters, restartedMonitor)).toMatchObject({ transitions: 1 });
    state = (await loadEconomyWorldState(db, WORLD))!;
    expect(state.tenders.get("tender-1")?.phase).toBe("awarded");

    const reference = { fleetRevision: 4, snapshotHash: fleetEnvelope.snapshotHash, formationIds: ["formation-1"], personnelDutyIds: ["duty-1"], pathReservationIds: ["path-1"] };
    verifyMobilizationReference(fleetEnvelope.snapshot, reference, { operatorId: "operator-1", winningFormationId: "formation-1", serviceLineIds: ["S1"], operatingFrom: OPERATING });
    const referenced = submitMobilizationReference(state, { commandId: "api:mobilization", tenderId: "tender-1", operatorId: "operator-1", at: CLOSE + 5, reference });
    await persistEconomyTransition(db, { expectedRevision: state.revision, state: referenced, effects: { notices: [], journal: [] }, committedAt: new Date((CLOSE + 5) * 1_000) });

    expect(await runEconomySchedulerCycle(db, new Date((OPERATING + 10) * 1_000), adapters, restartedMonitor)).toMatchObject({ transitions: 1 });
    const completed = (await loadEconomyWorldState(db, WORLD))!;
    expect(completed.contracts.get("tender-1")?.operatorId).toBe("operator-1");
    expect(completed.mobilizations.get("tender-1")?.proof?.snapshotHash).toBe(fleetEnvelope.snapshotHash);
    expect(completed.operatingRuntimeByLot.get("lot-0")?.stateHash).toBe("b".repeat(64));
    expect((await worldEventLog(db, WORLD).list()).map((event) => event.eventType)).toContain("operating-transition-completed");
    expect(publishRuntimeEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ eventType: "operating-transition-completed", worldId: WORLD }),
    ]));
    const replay = await runEconomySchedulerCycle(db, new Date((OPERATING + 20) * 1_000), adapters, restartedMonitor);
    expect(replay.transitions).toBe(0);
    expect(completed.processedCommands).toEqual((await loadEconomyWorldState(db, WORLD))?.processedCommands);
    expect(sendNotice).toHaveBeenCalled();
    expect(postJournal).not.toHaveBeenCalled();
    expect(await createEconomySchedulerHealthCheck(restartedMonitor, 30_000, () => (OPERATING + 20) * 1_000).check()).toMatchObject({ status: "ok", code: "scheduler_current" });
  });
});
