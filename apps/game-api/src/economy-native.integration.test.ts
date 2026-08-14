import { PGlite } from "@electric-sql/pglite";
import {
  domainEvents,
  economyOutbox,
  economyWorldStates,
  fleetMobilizationSnapshots,
  fleetWorldCheckpoints,
  mailboxMessages,
  MIGRATIONS_FOLDER,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import {
  announceTender,
  buildEconomyRelease,
  createEconomyPlatformAdapters,
  EconomySchedulerMonitor,
  ledgerAccountBalance,
  listLedgerTransactions,
  loadFleetProducerCheckpoint,
  loadEconomyWorldState,
  openLedgerAccount,
  persistEconomyTransition,
  resolveVehicleConcept,
  runEconomySchedulerCycle,
  STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN,
  startEconomyWorld,
  submitBid,
  submitMobilizationReference,
  type CostType,
  type EconomyDatabase,
} from "@zugfolge/economy";
import { createGtfsPlanningEnvelope, type GtfsPlanningSnapshot } from "@zugfolge/gtfs";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import { LivemapRegistry } from "@zugfolge/livemap-stream";
import { foundOperator } from "@zugfolge/operators";
import {
  FLEET_FORMATION_COMMAND_SCHEMA,
  FLEET_PATH_RESERVATION_COMMAND_SCHEMA,
  FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA,
  loadOperatingRuntime,
  OPERATING_INITIALIZE_SCHEMA,
  OPERATING_TRANSITION_SCHEMA,
  type FleetAuthorityRelease,
  type NativeFleetMobilizationSnapshot,
  type OperatingRuntimeEvent,
} from "@zugfolge/runtime-native";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { projectLivemapOperationEvent } from "./livemap-operation-projection.js";

const WORLD = "77777777-7777-4777-8777-777777777777";
const OPEN = 100;
const CLOSE = OPEN + 86_400;
const OPERATING = CLOSE + 10_000;
const PUBLIC_REPLACEMENT_FLEET = ["public-replacement-1"] as const;
const COST_TYPES: readonly CostType[] = [
  "track",
  "station",
  "facility",
  "energy",
  "personnel",
  "administration",
  "vehicle",
  "penalty",
  "interest",
];

const nativeAddonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"]?.trim();
const nativeIt = nativeAddonPath === undefined || nativeAddonPath.length === 0 ? it.skip : it;
const FLEET_INGEST_TOKEN = "native-m5-e2e-fleet-ingest-token";

type FleetHttpView = Readonly<{
  revision: number;
  stateHash: string;
  snapshotHash: string;
  snapshot: NativeFleetMobilizationSnapshot;
  idempotentReplay?: boolean;
}>;

const release = buildEconomyRelease({
  version: "native-m6-e2e-v1",
  rates: {
    trackPerTrainKmCents: 1n,
    stationPerStopCents: 1n,
    facilityPerHourCents: 1n,
    energyPerKwhCents: 1n,
    personnelPerHourCents: 1n,
    administrationPerPeriodCents: 1n,
    vehiclePerPeriodCents: 1n,
    overnightStablingPerPeriodCents: 1n,
    protectionEquipmentPerPeriodCents: 1n,
    lateInterestBasisPoints: 1,
  },
  rules: {
    qualityBaselinePunctualityBasisPoints: 8_500,
    pointsPerExtraSeat: 1,
    pointsPerPunctualityBasisPoint: 1,
    pointsPerAdditionalStop: 1,
    requirementFocusMaximumPoints: 1_000,
    contractBonusCentsPerPeriod: 1n,
    penaltyRates: { punctuality: 1n, cancellation: 1n, seats: 1n, connections: 1n },
    penaltyFocusMultiplierBasisPoints: 10_000,
    publicOperationSurchargeBasisPoints: 0,
    failedPackageFeeStepBasisPoints: 0,
    failedPackageReductionStepBasisPoints: 0,
  },
  tenderProfiles: [
    {
      id: "capacity",
      weights: { price: 5_000, quality: 5_000 },
      requirementFocus: "capacity",
      penaltyFocus: "punctuality",
      viabilitySurchargeBasisPoints: 10_000,
    },
    {
      id: "bicycle",
      weights: { price: 5_000, quality: 5_000 },
      requirementFocus: "bicycle",
      penaltyFocus: "connections",
      viabilitySurchargeBasisPoints: 10_000,
    },
  ],
});

function planning() {
  const patterns: GtfsPlanningSnapshot["patterns"] = Array.from({ length: 4 }, (_, index) => ({
    id: `pattern-${index}`,
    lineId: `S${index + 1}`,
    directionId: "0",
    sourceRouteIds: [`route-${index}`],
    stopIds: [`stop-${index}-a`, `stop-${index}-b`],
    stopNames: [`Stop ${index} A`, `Stop ${index} B`],
    nodeIds: [`node-${index}-a`, `node-${index}-b`],
    edgeIds: [`edge-${index}`],
    distanceMeters: 10_000,
    journeys: [{
      sourceTripId: `trip-${index}`,
      serviceDate: "20260811",
      departureServiceSeconds: index * 3_600,
      arrivalServiceSeconds: index * 3_600 + 1_800,
      departureEpochSeconds: 1_000 + index * 3_600,
      arrivalEpochSeconds: 2_800 + index * 3_600,
    }],
    metrics: {
      journeyCount: 1,
      totalTrainMeters: "10000",
      totalStops: "2",
      totalServiceSeconds: "1800",
      totalEnergyWh: "80000",
      medianHeadwaySeconds: null,
      maximumOperatingSpanSeconds: 1_800,
      peakVehicles: 1,
    },
  }));
  const lots: GtfsPlanningSnapshot["lots"] = patterns.map((pattern, index) => ({
    id: `lot-${index}`,
    lineIds: [pattern.lineId],
    patternIds: [pattern.id],
    connectingNodeIds: [],
    size: 100 - index,
    attractiveness: index,
    smallLot: true,
    specificationBasis: {
      sampleServiceDays: 1,
      totalTrainMeters: "10000",
      totalStops: "2",
      totalServiceSeconds: "1800",
      totalEnergyWh: "80000",
      peakVehicles: 1,
      facilityMinutesPerDay: 30,
      overnightUnits: 1,
      protectionUnits: 1,
      requirements: {
        minimumSeats: 100,
        firstClassBasisPoints: 0,
        accessible: true,
        bicyclePlaces: 2,
        wheelchairPlaces: 1,
        requiredEquipment: ["pis"],
      },
    },
  }));
  return createGtfsPlanningEnvelope({
    schema: "zugfolge-gtfs-planning/v1",
    worldId: WORLD,
    revision: 1,
    producedAt: 10,
    source: {
      sourceId: "synthetic-native-m6",
      feedUrl: "https://example.invalid/native-m6.zip",
      archiveSha256: "a".repeat(64),
      capturedAt: "2026-08-11T00:00:00.000Z",
      timeZone: "Europe/Berlin",
      sourceLicense: "synthetic-test-data",
      attribution: "Zugfolge synthetic native integration fixture",
    },
    infrastructureVersion: "native-m6-graph-v1",
    rulesVersion: "native-m6-rules-v1",
    serviceDates: ["20260811"],
    patterns,
    lots,
  });
}

function serviceSpecification(line: string) {
  return {
    lines: [line],
    trainKmPerPeriod: 100n,
    stopsPerPeriod: 10n,
    serviceHoursPerPeriod: 10n,
    facilityHoursPerPeriod: 1n,
    energyKwhPerPeriod: 10n,
    vehicleCount: 1n,
    overnightUnits: 1n,
    protectionUnits: 1n,
    requirements: {
      minimumSeats: 100,
      firstClassBasisPoints: 0,
      accessible: true,
      bicyclePlaces: 2,
      wheelchairPlaces: 1,
      requiredEquipment: ["pis"],
    },
  };
}

function fleetAuthorityRelease(operatorId: string): FleetAuthorityRelease {
  const vehicle = (
    id: string,
    numericId: number,
    serviceLineIds: readonly string[],
    buildYear: number,
    procurementChannel: "new-build" | "leasing",
  ): FleetAuthorityRelease["assets"][number] => ({
    id,
    numericId,
    operatorId,
    vehicleTypeId: 101,
    classDesignation: "ET160",
    tradeName: `Native Testzug ${numericId}`,
    buildYear,
    acquisitionYear: 2026,
    procurementChannel,
    approvedLineIds: [...serviceLineIds],
    maintenanceDeadlines: [{ kind: "inspection", dueAt: OPERATING + 10_000 }],
    installedProtection: ["pzb"],
    technical: {
      lengthMm: 70_000,
      massKg: 120_000,
      maximumSpeedKph: 160,
      accelerationMmPerS2: 800,
      decelerationMmPerS2: 900,
      traction: "electric",
      electricSystems: ["ac15kv"],
    },
    passenger: {
      seats: 120,
      firstClassSeats: 0,
      accessible: true,
      bicyclePlaces: 4,
      wheelchairPlaces: 1,
      equipment: ["pis"],
      operatingCostCentsPerTrainKm: 700,
      replacementPlan: true,
    },
    deliveredAt: 0,
    retiredAt: OPERATING + 10_000,
  });
  const pathReceipt = (
    id: string,
    numericRouteId: number,
    serviceLineIds: readonly string[],
    plannerHashByte: string,
    conflictHashByte: string,
  ): FleetAuthorityRelease["pathReceipts"][number] => ({
    id,
    numericRouteId,
    operatorId,
    serviceLineIds: [...serviceLineIds],
    decision: "confirmed" as const,
    validFrom: 0,
    validUntil: OPERATING + 10_000,
    platformLengthsMm: [200_000],
    electrifications: ["overhead-ac15kv"],
    requiredProtection: ["pzb"],
    approvedClasses: ["ET160"],
    plannerStateHash: plannerHashByte.repeat(64),
    conflictCheckHash: conflictHashByte.repeat(64),
  });
  return {
    schemaVersion: "zugfolge-fleet-authority-release/v1" as const,
    releaseId: "native-m6-fleet-authority-v1",
    referenceYear: 2026,
    assets: [
      vehicle("vehicle-operator", 1, ["S1", "S2"], 2024, "leasing"),
      vehicle("vehicle-success", 2, ["S3"], 2025, "new-build"),
    ],
    personnelPools: [{
      id: "pool-success",
      numericId: 1,
      operatorId,
      capacitySeconds: OPERATING + 10_000,
      minimumRestSeconds: 0,
      classDesignations: ["ET160"],
      pathReceiptIds: ["receipt-success"],
      qualificationHash: "9".repeat(64),
    }],
    pathReceipts: [
      pathReceipt("receipt-operator", 1, ["S1", "S2"], "a", "b"),
      pathReceipt("receipt-success", 2, ["S3"], "c", "d"),
    ],
  };
}

function publicTrain(id: string, operator: string) {
  return {
    id,
    operator,
    trainNumber: id,
    category: "S",
    positionMm: 1_000,
    speedMmPerSecond: 10_000,
    delaySeconds: 0,
    nextOperatingPoint: "Leipzig Hbf",
    status: "running",
  };
}

describe("M6 mit echtem Rust-NAPI-Laufzeitkern", () => {
  nativeIt("verbindet Wiedergewinn, Betreiberwechsel, Ersatzbetrieb und atomare Projektionen deterministisch", async () => {
    const client = new PGlite();
    let fleetApp: FastifyInstance | undefined;
    try {
      const database = drizzle(client, { schema });
      const db = database as unknown as EconomyDatabase;
      const identityDb = database as unknown as IdentityDatabase;
      await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
      await database.insert(worlds).values({
        id: WORLD,
        name: "Native M6 Integration",
        schedulePeriodWeeks: 3,
        epoch: new Date(0),
      });

      const account = await requestWorldAccess(identityDb, {
        worldId: WORLD,
        keycloakSubject: "native-m6-player",
        displayName: "Native M6",
      });
      const operator = await foundOperator(identityDb, {
        worldId: WORLD,
        foundingKeycloakSubject: "native-m6-player",
        name: "Native M6 Bahn",
      });
      const cash = await openLedgerAccount(db, { worldId: WORLD, operatorId: operator.id, name: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName });
      const revenue = await openLedgerAccount(db, { worldId: WORLD, operatorId: operator.id, name: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.revenueAccountName });
      const costAccountIds = Object.fromEntries(await Promise.all(COST_TYPES.map(async (costType) => [
        costType,
        (await openLedgerAccount(db, { worldId: WORLD, operatorId: operator.id, name: STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.costAccountNames[costType] })).id,
      ]))) as Record<CostType, string>;

      const planningEnvelope = planning();
      const operatingRuntime = loadOperatingRuntime(nativeAddonPath);
      const authorityRelease = fleetAuthorityRelease(operator.id);
      fleetApp = buildApp({
        db: identityDb,
        verifyToken: async () => {
          throw new Error("Identity-Token wird fuer die interne Fleet-Route nicht verwendet.");
        },
        fleetIngestToken: FLEET_INGEST_TOKEN,
        fleetRuntime: operatingRuntime,
        fleetAuthorityReleases: { [WORLD]: authorityRelease },
        logger: false,
      });
      await fleetApp.ready();
      const rawBypass = await fleetApp.inject({
        method: "POST",
        url: `/internal/worlds/${WORLD}/fleet/mobilization-snapshots`,
        headers: { authorization: `Bearer ${FLEET_INGEST_TOKEN}` },
        payload: { snapshot: {}, snapshotHash: "0".repeat(64) },
      });
      expect(rawBypass.statusCode).toBe(404);

      const postFleet = async (suffix: "initialize" | "commands", payload: object) => {
        const response = await fleetApp!.inject({
          method: "POST",
          url: `/internal/worlds/${WORLD}/fleet/${suffix}`,
          headers: { authorization: `Bearer ${FLEET_INGEST_TOKEN}` },
          payload,
        });
        expect(response.statusCode, response.body).toBe(200);
        const view = response.json<FleetHttpView>();
        expect(view).not.toHaveProperty("state");
        expect(view).not.toHaveProperty("commandReceipt");
        expect(view).not.toHaveProperty("authorityRelease");
        return view;
      };

      const fleetInitialized = await postFleet("initialize", { producedAt: 50 });
      expect(Object.keys(fleetInitialized).sort()).toEqual([
        "revision",
        "snapshot",
        "snapshotHash",
        "stateHash",
      ]);
      const formationOperatorCommand = {
        schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
        commandId: "fleet:formation:operator",
        expectedStateHash: fleetInitialized.stateHash,
        expectedRevision: fleetInitialized.revision,
        atS: 51,
        formationId: "formation-operator",
        vehicleIds: ["vehicle-operator"],
        pathReceiptId: "receipt-operator",
      } as const;
      const formationOperator = await postFleet("commands", formationOperatorCommand);
      const formationSuccessCommand = {
        schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
        commandId: "fleet:formation:success",
        expectedStateHash: formationOperator.stateHash,
        expectedRevision: formationOperator.revision,
        atS: 52,
        formationId: "formation-success",
        vehicleIds: ["vehicle-success"],
        pathReceiptId: "receipt-success",
      } as const;
      const formationSuccess = await postFleet("commands", formationSuccessCommand);
      const personnelDutyCommand = {
        schemaVersion: FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA,
        commandId: "fleet:personnel-duty:success",
        expectedStateHash: formationSuccess.stateHash,
        expectedRevision: formationSuccess.revision,
        atS: 53,
        personnelDutyId: "duty-success",
        personnelPoolId: "pool-success",
        formationIds: ["formation-success"],
        pathReceiptId: "receipt-success",
        validFrom: 60,
        validUntil: OPERATING + 1_000,
      } as const;
      const personnelDuty = await postFleet("commands", personnelDutyCommand);
      const pathReservationCommand = {
        schemaVersion: FLEET_PATH_RESERVATION_COMMAND_SCHEMA,
        commandId: "fleet:path-reservation:success",
        expectedStateHash: personnelDuty.stateHash,
        expectedRevision: personnelDuty.revision,
        atS: 54,
        pathReservationId: "path-success",
        pathReceiptId: "receipt-success",
      } as const;
      const fleetProjection = await postFleet("commands", pathReservationCommand);
      const fleetReplay = await postFleet("commands", pathReservationCommand);
      expect(fleetReplay).toMatchObject({
        idempotentReplay: true,
        stateHash: fleetProjection.stateHash,
        snapshotHash: fleetProjection.snapshotHash,
      });
      expect(fleetReplay.snapshot).toEqual(fleetProjection.snapshot);
      const historicalFormationReplay = await postFleet("commands", formationOperatorCommand);
      expect(historicalFormationReplay).toMatchObject({
        idempotentReplay: true,
        stateHash: formationOperator.stateHash,
        snapshotHash: formationOperator.snapshotHash,
        revision: 1,
        snapshot: { revision: 1, formations: [{ id: "formation-operator" }] },
      });
      const persistedFleetCheckpoints = (await db.select().from(fleetWorldCheckpoints))
        .sort((left, right) => left.revision - right.revision);
      expect(persistedFleetCheckpoints.map((checkpoint) => checkpoint.revision)).toEqual([0, 1, 2, 3, 4]);
      expect(persistedFleetCheckpoints.slice(1).map((checkpoint) => checkpoint.commandId)).toEqual([
        formationOperatorCommand.commandId,
        formationSuccessCommand.commandId,
        personnelDutyCommand.commandId,
        pathReservationCommand.commandId,
      ]);
      expect(persistedFleetCheckpoints.slice(1).every((checkpoint) =>
        checkpoint.commandJson !== null && /^[a-f0-9]{64}$/.test(checkpoint.commandHash ?? ""),
      )).toBe(true);
      expect(await db.select().from(fleetMobilizationSnapshots)).toHaveLength(5);
      expect(await loadFleetProducerCheckpoint(db, WORLD)).toMatchObject({
        stateHash: fleetProjection.stateHash,
        snapshotHash: fleetProjection.snapshotHash,
        commandId: pathReservationCommand.commandId,
      });
      const fleetEnvelope = {
        snapshot: fleetProjection.snapshot,
        snapshotHash: fleetProjection.snapshotHash,
      } as const;
      expect(fleetEnvelope.snapshot).toMatchObject({
        worldId: WORLD,
        revision: 4,
        formations: [
          {
            id: "formation-operator",
            availability: "available",
            procurement: "delivered",
            characteristics: { seats: 120, maximumSpeedKph: 160 },
          },
          {
            id: "formation-success",
            availability: "available",
            procurement: "delivered",
            characteristics: { seats: 120, maximumSpeedKph: 160 },
          },
        ],
        personnelDuties: [{ id: "duty-success", status: "ready" }],
        pathReservations: [{ id: "path-success", status: "confirmed" }],
      });
      const vehicleFor = (line: string) => {
        const formationId = line === "S3" ? "formation-success" : "formation-operator";
        return resolveVehicleConcept(
          fleetEnvelope.snapshot,
          { fleetRevision: fleetEnvelope.snapshot.revision, snapshotHash: fleetEnvelope.snapshotHash, formationId },
          { operatorId: operator.id, serviceLineIds: [line], operatingFrom: OPERATING },
        );
      };

      let transition = startEconomyWorld({
        worldId: WORLD,
        seed: 1n,
        durationMonths: 6,
        release,
        planning: planningEnvelope,
        authorityBudgets: [{
          authorityId: "authority",
          period: 0,
          availableCents: 10_000_000n,
          committedCents: 0n,
        }],
        accounts: [account.id],
      });
      await persistEconomyTransition(db, {
        expectedRevision: null,
        ...transition,
        committedAt: new Date(0),
        enqueuedAt: new Date(0),
      });
      let state = transition.state;

      const tenders = [
        { id: "tender-rewin", lotId: "lot-0", line: "S1", incumbentOperatorId: operator.id },
        { id: "tender-failed", lotId: "lot-1", line: "S2", incumbentOperatorId: "legacy-operator" },
        { id: "tender-success", lotId: "lot-2", line: "S3", incumbentOperatorId: "legacy-success" },
      ] as const;
      for (const tender of tenders) {
        const expectedRevision = state.revision;
        transition = announceTender(state, {
          commandId: `setup:announce:${tender.id}`,
          release,
          recipients: [account.id],
          automation: {
            authorityId: "authority",
            budgetPeriod: 0,
            vehiclePool: PUBLIC_REPLACEMENT_FLEET,
            recipientByOperator: { [operator.id]: account.id },
            failurePenaltyCents: 5_000n,
          },
          tender: {
            id: tender.id,
            worldId: WORLD,
            lotId: tender.lotId,
            incumbentOperatorId: tender.incumbentOperatorId,
            specification: serviceSpecification(tender.line),
            announcedAt: 0,
            opensAt: OPEN,
            closesAt: CLOSE,
            operatingFrom: OPERATING,
            contractPeriods: 2,
            periodDurationSeconds: 21 * 86_400,
            smallLot: true,
          },
        });
        await persistEconomyTransition(db, {
          expectedRevision,
          ...transition,
          committedAt: new Date(tender.id === "tender-rewin" ? 1_000 : 2_000),
          enqueuedAt: new Date(tender.id === "tender-rewin" ? 1_000 : 2_000),
        });
        state = transition.state;
      }

      const livemap = new LivemapRegistry();
      const platformAdapters = createEconomyPlatformAdapters({
        db,
        accountsByOperator: {
          [operator.id]: {
            cashAccountId: cash.id,
            revenueAccountId: revenue.id,
            costAccountIds,
          },
        },
      });
      const publishedEvents: OperatingRuntimeEvent[] = [];
      let publisherObservedAtomicCommit = false;
      const adapters = {
        ...platformAdapters,
        operatingRuntime,
        async publishRuntimeEvents(events: readonly OperatingRuntimeEvent[]) {
          if (events.length === 0) return;
          const committedState = await loadEconomyWorldState(db, WORLD);
          const persistedEvents = await db.select().from(domainEvents);
          const persistedRuntimeIds = new Set(persistedEvents.map((event) =>
            (event.payload as Record<string, unknown>)["runtimeEventId"],
          ));
          if (
            committedState === undefined
            || !committedState.mobilizations.get("tender-rewin")?.completed
            || !committedState.mobilizations.get("tender-failed")?.completed
            || !committedState.mobilizations.get("tender-success")?.completed
            || events.some((event) => !persistedRuntimeIds.has(event.eventId))
          ) {
            throw new Error("Runtime-Publisher lief vor dem atomaren DB-Commit.");
          }
          publisherObservedAtomicCommit = true;
          publishedEvents.push(...events);
          events.forEach((event) => projectLivemapOperationEvent(livemap, event));
        },
      };

      const monitor = new EconomySchedulerMonitor(0);
      expect(await runEconomySchedulerCycle(db, new Date(OPEN * 1_000), adapters, monitor)).toMatchObject({ transitions: 3 });
      state = (await loadEconomyWorldState(db, WORLD))!;
      for (const tender of tenders) {
        const expectedRevision = state.revision;
        const next = submitBid(state, `setup:bid:${tender.id}`, tender.id, {
          id: `bid:${tender.id}`,
          operatorId: operator.id,
          orderingFeeCentsPerTrainKm: 1n,
          vehicle: vehicleFor(tender.line),
          promises: { extraSeats: 0, punctualityBasisPoints: 9_000, additionalStops: 0 },
          submittedAt: OPEN,
        }, {
          accountId: account.id,
          period: 0,
          smallLot: true,
          minimumScore: 0,
        });
        await persistEconomyTransition(db, {
          expectedRevision,
          state: next,
          effects: { notices: [], journal: [] },
          committedAt: new Date(OPEN * 1_000),
          enqueuedAt: new Date(OPEN * 1_000),
        });
        state = next;
      }

      expect(await runEconomySchedulerCycle(db, new Date(CLOSE * 1_000), adapters, monitor)).toMatchObject({ transitions: 3 });
      state = (await loadEconomyWorldState(db, WORLD))!;
      const successReference = {
        fleetRevision: fleetEnvelope.snapshot.revision,
        snapshotHash: fleetEnvelope.snapshotHash,
        formationIds: ["formation-success"],
        personnelDutyIds: ["duty-success"],
        pathReservationIds: ["path-success"],
      } as const;
      const referenced = submitMobilizationReference(state, {
        commandId: "setup:mobilization:tender-success",
        tenderId: "tender-success",
        operatorId: operator.id,
        at: CLOSE,
        reference: successReference,
      });
      await persistEconomyTransition(db, {
        expectedRevision: state.revision,
        state: referenced,
        effects: { notices: [], journal: [] },
        committedAt: new Date(CLOSE * 1_000),
        enqueuedAt: new Date(CLOSE * 1_000),
      });
      expect(await runEconomySchedulerCycle(db, new Date((OPERATING - 1) * 1_000), adapters, monitor)).toMatchObject({ transitions: 0 });
      const beforeBoundary = (await loadEconomyWorldState(db, WORLD))!;
      expect(beforeBoundary.tenders.get("tender-rewin")).toMatchObject({
        phase: "awarded",
        tender: { incumbentOperatorId: operator.id },
      });
      expect(beforeBoundary.tenders.get("tender-failed")).toMatchObject({
        phase: "awarded",
        tender: { incumbentOperatorId: "legacy-operator" },
      });
      expect(beforeBoundary.tenders.get("tender-success")).toMatchObject({
        phase: "awarded",
        tender: { incumbentOperatorId: "legacy-success" },
      });
      expect(beforeBoundary.mobilizations.get("tender-success")?.reference).toEqual(successReference);
      expect(beforeBoundary.operatingRuntimeByLot.size).toBe(0);
      expect(beforeBoundary.contracts.size).toBe(0);
      expect(await db.select().from(domainEvents)).toHaveLength(0);

      expect(await runEconomySchedulerCycle(db, new Date(OPERATING * 1_000), adapters, monitor)).toMatchObject({
        worlds: 1,
        transitions: 3,
        effects: 4,
      });
      const completed = (await loadEconomyWorldState(db, WORLD))!;
      expect(publisherObservedAtomicCommit).toBe(true);
      expect(completed.contracts.get("tender-rewin")).toMatchObject({ operatorId: operator.id, startsAt: OPERATING });
      expect(completed.contracts.get("tender-success")).toMatchObject({ operatorId: operator.id, startsAt: OPERATING });
      expect(completed.publicOperations.has("lot-0")).toBe(false);
      expect(completed.publicOperations.has("lot-2")).toBe(false);
      expect(completed.publicOperations.get("lot-1")).toMatchObject({
        vehiclePool: PUBLIC_REPLACEMENT_FLEET,
        livemapMarker: "public-operator",
      });
      expect(completed.mobilizations.get("tender-rewin")).toMatchObject({ completed: true });
      expect(completed.mobilizations.get("tender-failed")).toMatchObject({ completed: true });
      expect(completed.mobilizations.get("tender-success")).toMatchObject({
        completed: true,
        proof: {
          snapshotHash: fleetEnvelope.snapshotHash,
          formationIds: ["formation-success"],
          personnelDutyIds: ["duty-success"],
          pathReservationIds: ["path-success"],
        },
      });
      expect(completed.operatingRuntimeByLot.get("lot-0")).toMatchObject({ state: { revision: 1 } });
      expect(completed.operatingRuntimeByLot.get("lot-1")).toMatchObject({ state: { revision: 1 } });
      expect(completed.operatingRuntimeByLot.get("lot-2")).toMatchObject({ state: { revision: 1 } });
      expect([...completed.operatingRuntimeByLot.values()].every((item) => /^[a-f0-9]{64}$/.test(item.stateHash))).toBe(true);

      const persistedEvents = await db.select().from(domainEvents);
      expect(persistedEvents).toHaveLength(12);
      expect(persistedEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(persistedEvents.every((event) => event.occurredAt.getTime() === OPERATING * 1_000)).toBe(true);
      expect(publishedEvents.map((event) => event.eventId).sort()).toEqual(
        persistedEvents.map((event) => (event.payload as Record<string, unknown>)["runtimeEventId"]).sort(),
      );
      const endedOperators = persistedEvents
        .filter((event) => event.eventType === "operating-duty-ended")
        .map((event) => (event.payload as Record<string, unknown>)["operatorId"])
        .sort();
      expect(endedOperators).toEqual(["legacy-operator", "legacy-success", operator.id].sort());
      const successOutcome = persistedEvents.find((event) =>
        event.eventType === "operating-transition-completed"
        && (event.payload as Record<string, unknown>)["lotId"] === "lot-2",
      );
      expect(successOutcome?.payload).toMatchObject({
        previousOperatorId: "legacy-success",
        operatorId: operator.id,
        kind: "operator-change",
        seamless: false,
        penaltyRequired: false,
        livemapMarker: null,
      });
      expect(persistedEvents.filter((event) => event.eventType === "livemap-operation-marked")).toHaveLength(1);
      expect(persistedEvents.filter((event) => event.eventType === "livemap-operation-cleared")).toHaveLength(2);

      const failedTrainRunId = "pattern-1:trip-1:20260811:4600";
      const rewinTrainRunId = "pattern-0:trip-0:20260811:1000";
      const successTrainRunId = "pattern-2:trip-2:20260811:8200";
      livemap.forWorld(WORLD).publish({
        at: OPERATING,
        changed: [
          publicTrain(failedTrainRunId, "public"),
          publicTrain(rewinTrainRunId, operator.id),
          publicTrain(successTrainRunId, operator.id),
        ],
        removed: [],
      });
      const livemapSnapshot = livemap.forWorld(WORLD).snapshot();
      expect(livemapSnapshot.trains.find((train) => train.id === failedTrainRunId)).toMatchObject({
        operationMarker: { kind: "public-operator" },
      });
      expect(livemapSnapshot.trains.find((train) => train.id === rewinTrainRunId)).not.toHaveProperty("operationMarker");
      expect(livemapSnapshot.trains.find((train) => train.id === successTrainRunId)).not.toHaveProperty("operationMarker");

      const transactions = await listLedgerTransactions(db, { worldId: WORLD, operatorId: operator.id });
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({
        idempotencyKey: `scheduler:tender-failed:mobilize:${OPERATING}:penalty`,
        postedAt: new Date(OPERATING * 1_000),
      });
      expect(await ledgerAccountBalance(db, { worldId: WORLD, ledgerAccountId: cash.id })).toBe(-5_000n);
      expect(await ledgerAccountBalance(db, { worldId: WORLD, ledgerAccountId: costAccountIds.penalty })).toBe(5_000n);
      const messages = await db.select().from(mailboxMessages);
      const failureMessages = messages.filter((message) => message.messageType === "mobilization-failed");
      expect(failureMessages).toHaveLength(1);
      expect(failureMessages[0]).toMatchObject({
        recipientAccountId: account.id,
        idempotencyKey: `scheduler:tender-failed:mobilize:${OPERATING}:mobilization-failed:${account.id}`,
        sentAt: new Date(OPERATING * 1_000),
      });
      expect((await db.select().from(economyOutbox)).every((effect) => effect.processedAt !== null)).toBe(true);
      const [persistedState] = await db.select().from(economyWorldStates);
      expect(persistedState).toMatchObject({ worldId: WORLD, revision: completed.revision });

      const failedInitialization = {
        schemaVersion: OPERATING_INITIALIZE_SCHEMA,
        worldId: WORLD,
        lots: [{
          lotId: "lot-1",
          incumbentOperatorId: "legacy-operator",
          timetableBoundaryS: OPERATING,
          trainRuns: [{ trainRunId: failedTrainRunId, formationId: null }],
        }],
      } as const;
      const initializedA = operatingRuntime.initialize(failedInitialization);
      const initializedB = operatingRuntime.initialize(failedInitialization);
      expect(initializedB).toEqual(initializedA);
      const failedCommand = {
        schemaVersion: OPERATING_TRANSITION_SCHEMA,
        worldId: WORLD,
        commandId: `scheduler:tender-failed:mobilize:${OPERATING}`,
        expectedStateHash: initializedA.stateHash,
        expectedRevision: initializedA.state.revision,
        lotId: "lot-1",
        atS: OPERATING,
        winnerOperatorId: operator.id,
        mobilizationProof: null,
        publicVehiclePool: PUBLIC_REPLACEMENT_FLEET,
      } as const;
      const deterministicA = operatingRuntime.applyTransition(initializedA.state, failedCommand);
      const deterministicB = operatingRuntime.applyTransition(initializedB.state, failedCommand);
      expect(deterministicB).toEqual(deterministicA);
      expect(deterministicA.stateHash).toBe(completed.operatingRuntimeByLot.get("lot-1")?.stateHash);
      expect(deterministicA.events).toEqual(
        publishedEvents.filter((event) => event.eventId.startsWith(`${failedCommand.commandId}:`)),
      );
      const nativeReplay = operatingRuntime.applyTransition(
        completed.operatingRuntimeByLot.get("lot-1")!.state,
        failedCommand,
      );
      expect(nativeReplay).toMatchObject({ idempotentReplay: true, stateHash: deterministicA.stateHash });
      expect(nativeReplay.events).toEqual(deterministicA.events);

      const eventCount = persistedEvents.length;
      const messageCount = messages.length;
      const stateHashes = [...completed.operatingRuntimeByLot.entries()].map(([lotId, value]) => [lotId, value.stateHash]);
      const retry = await runEconomySchedulerCycle(
        db,
        new Date((OPERATING + 1) * 1_000),
        { ...adapters, ...createEconomyPlatformAdapters({
          db,
          accountsByOperator: {
            [operator.id]: {
              cashAccountId: cash.id,
              revenueAccountId: revenue.id,
              costAccountIds,
            },
          },
        }) },
        new EconomySchedulerMonitor(OPERATING * 1_000),
      );
      expect(retry).toMatchObject({ transitions: 0, effects: 0 });
      expect(await db.select().from(domainEvents)).toHaveLength(eventCount);
      expect(await db.select().from(mailboxMessages)).toHaveLength(messageCount);
      expect(await listLedgerTransactions(db, { worldId: WORLD, operatorId: operator.id })).toHaveLength(1);
      expect([...(await loadEconomyWorldState(db, WORLD))!.operatingRuntimeByLot.entries()].map(
        ([lotId, value]) => [lotId, value.stateHash],
      )).toEqual(stateHashes);
    } finally {
      await fleetApp?.close();
      await client.close();
    }
  }, 60_000);
});
