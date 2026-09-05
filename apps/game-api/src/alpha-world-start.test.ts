import { describe, expect, it, vi } from "vitest";
import { alphaHash } from "@zugfolge/alpha";
import { buildEconomyRelease, deriveTenderAuthorityBudgetCents, lotsFromGtfsPlanning, startEconomyWorld, TENDER_GENERATION_SCHEMA } from "@zugfolge/economy";
import { buildRegionalServicePlanning, createGtfsPlanningEnvelope } from "@zugfolge/gtfs";
import {
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  type OperationalSimulationInitialization,
} from "@zugfolge/runtime-native";

import {
  ACTIVE_WORLD_DEPLOYMENT_CUTOVER_ERROR_CODE,
  ActiveWorldDeploymentCutoverError,
  initializeOrRestoreRegionalSimulation,
  parsePersistedActiveAlphaWorldDeployment,
  publicOperationSnapshotVerification,
  validateDeploymentWorldDefinition,
  startAlphaDeploymentEconomy,
  validateAlphaEconomyPlanningBinding,
  validatePersistedAlphaEconomyPlanning,
  type AlphaWorldDeployment,
} from "./alpha-world-start.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";

const definition = {
  name: "Mitteldeutschland 2026",
  kind: "public",
  rankingStatus: "ranked",
  schedulePeriodWeeks: 4,
  epoch: "2026-08-10T00:00:00.000Z",
};

function plannedDeployment(): AlphaWorldDeployment {
  const planning = buildRegionalServicePlanning({
    worldId: "world-planning", revision: 1, producedAt: 0, serviceDate: "20260810", infrastructureVersion: "infra-planning", rulesVersion: "planning-v1", sourceTimetableHash: "b".repeat(64), smallLotMaximumTrainKmPerDay: 1_000,
    timetableGeneration: { seed: "42", specification: { schemaVersion: "zugfolge-game-timetable-generation/v1", version: "game-timetable/v1", departureGridSeconds: 60, minimumRunningSeconds: 1, requireEligibleTerminals: true } },
    source: { sourceId: "fixture", feedUrl: "https://example.test/fixture.zip", archiveSha256: "a".repeat(64), capturedAt: "2026-08-10T00:00:00Z", timeZone: "Europe/Berlin", sourceLicense: "fixture", attribution: "Fixture" },
    lines: Array.from({ length: 8 }, (_, index) => ({
      peakVehicles: 1,
      policy: { lineId: `line-${index}`, energyWhPerTrainKm: 10_000, facilityMinutesPerVehicleDay: 60, minimumTurnaroundSeconds: 300, overnightBasisPoints: 10_000, requiredProtection: ["pzb"], requirements: { minimumSeats: 100, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 8, wheelchairPlaces: 2, requiredEquipment: [] } },
      journeys: [{ id: `game-trip-${index}`, directionId: "0", sourceRouteId: "reference-route", routeLengthMm: 10_000_000, edgeIds: ["edge"], stops: [{ stopId: "a", name: "A", arrivalS: 3_600, departureS: 3_600 }, { stopId: "b", name: "B", arrivalS: 4_200, departureS: 4_200 }] }],
    })),
  });
  const release = buildEconomyRelease({
    version: "2026.1",
    rates: { trackPerTrainKmCents: 100n, stationPerStopCents: 100n, facilityPerHourCents: 100n, energyPerKwhCents: 100n, personnelPerHourCents: 100n, administrationPerPeriodCents: 100n, vehiclePerPeriodCents: 100n, overnightStablingPerPeriodCents: 100n, protectionEquipmentPerPeriodCents: 100n, lateInterestBasisPoints: 500 },
    rules: { qualityBaselinePunctualityBasisPoints: 8_500, pointsPerExtraSeat: 40, pointsPerPunctualityBasisPoint: 1, pointsPerAdditionalStop: 300, requirementFocusMaximumPoints: 1_500, contractBonusCentsPerPeriod: 100_000n, penaltyRates: { punctuality: 10n, cancellation: 10_000n, seats: 100n, connections: 1_000n }, penaltyFocusMultiplierBasisPoints: 20_000, publicOperationSurchargeBasisPoints: 2_000, failedPackageFeeStepBasisPoints: 500, failedPackageReductionStepBasisPoints: 400 },
    tenderProfiles: [
      { id: "price", weights: { price: 7_000, quality: 3_000 }, requirementFocus: "capacity", penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 1_000 },
      { id: "quality", weights: { price: 3_000, quality: 7_000 }, requirementFocus: "comfort", penaltyFocus: "connections", viabilitySurchargeBasisPoints: 1_500 },
    ],
  });
  const lots = lotsFromGtfsPlanning(planning, "world-planning");
  const tenderGeneration = { schemaVersion: TENDER_GENERATION_SCHEMA, authorityId: "authority", failurePenaltyCents: 0n, authorityBudgetCentsPerPeriod: deriveTenderAuthorityBudgetCents(planning, "world-planning", release, 12) };
  const economy = { durationMonths: 12 as const, release, planning, tenderGeneration, lots, authorityBudgets: [], accounts: [], publicVehiclePoolByLot: {} };
  const { lots: _lots, ...startInput } = economy;
  const started = startEconomyWorld({ worldId: "world-planning", seed: 42n, ...startInput });
  const blueprintLots = planning.snapshot.lots.map((lot) => ({ lotId: lot.id, trainRunIds: planning.snapshot.patterns.filter((pattern) => lot.patternIds.includes(pattern.id)).flatMap((pattern) => pattern.journeys.map((journey) => journey.id!)) }));
  return {
    worldId: "world-planning", economy,
    repeatEveryS: 86_400,
    worldDefinition: { epoch: "2026-08-10T00:00:00Z" },
    regionalSimulation: { trains: blueprintLots.flatMap((lot) => lot.trainRunIds.map((id) => ({ id, publicPassengerStop: true, scheduledDepartureMs: 3_600_000, serviceOutcome: { serviceId: id, serviceRunId: `${id}:service-day:2026-08-10`, lotId: lot.lotId, serviceDay: "2026-08-10", scheduledArrivalMs: 4_200_000 } }))) },
    provenance: { infraReleaseId: "infra-planning", gtfsSnapshotHash: "b".repeat(64) },
    blueprint: { seed: 42n, releases: { timetable: "b".repeat(64), economy: release.checksum }, lots: blueprintLots, tenderCalendarHash: alphaHash("zugfolge-alpha-tender-calendar/v1", started.state.calendar) },
  } as unknown as AlphaWorldDeployment;
}

describe("produktiver Start der Spielplanung", () => {
  it("verdrahtet den signierten Plan mit offenen Ausschreibungen und stabilen Spiel-Fahrtkennungen", () => {
    const deployment = plannedDeployment();
    const started = startAlphaDeploymentEconomy(deployment);
    expect(started.state.revision).toBe(0);
    expect(started.state.planning?.snapshotHash).toBe(deployment.economy.planning?.snapshotHash);
    const open = [...started.state.tenders.values()].filter((entry) => entry.phase === "open");
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((entry) => entry.tender.opensAt === 0 && entry.tender.specification.trainKmPerPeriod > 0n)).toBe(true);
  });

  it("laesst historische Deployments lesen, verhindert aber einen weiteren stillen Leerstart", () => {
    const { planning: _planning, tenderGeneration: _generation, ...legacyEconomy } = plannedDeployment().economy;
    const legacy = { ...plannedDeployment(), economy: legacyEconomy };
    expect(() => validateAlphaEconomyPlanningBinding(legacy)).not.toThrow();
    expect(() => startAlphaDeploymentEconomy(legacy)).toThrow(/neu bauen und signieren/u);
  });

  it("weist fremde Welt-, Infrastruktur-, Fahrplan-, Los- und Kalenderbindungen zurueck", () => {
    const deployment = plannedDeployment();
    for (const altered of [
      { ...deployment, worldId: "foreign" },
      { ...deployment, provenance: { ...deployment.provenance, infraReleaseId: "foreign" } },
      { ...deployment, provenance: { ...deployment.provenance, gtfsSnapshotHash: "c".repeat(64) } },
      { ...deployment, economy: { ...deployment.economy, lots: [] } },
      { ...deployment, blueprint: { ...deployment.blueprint, tenderCalendarHash: "c".repeat(64) } },
      { ...deployment, blueprint: { ...deployment.blueprint, seed: 43n } },
      { ...deployment, regionalSimulation: { ...deployment.regionalSimulation, trains: [] } },
      { ...deployment, regionalSimulation: { ...deployment.regionalSimulation, externalTrains: [{ id: "external" }] } },
    ]) expect(() => startAlphaDeploymentEconomy(altered)).toThrow();
  });

  it("verhindert beim Wiederanlauf eine Mischung aus altem Zustand und neuer Planungsregel", () => {
    const deployment = plannedDeployment();
    const state = startAlphaDeploymentEconomy(deployment).state;
    expect(() => validatePersistedAlphaEconomyPlanning(deployment, state)).not.toThrow();
    expect(() => validatePersistedAlphaEconomyPlanning(deployment, {})).toThrow(/andere Spielplanung/u);
    expect(() => validatePersistedAlphaEconomyPlanning(deployment, {
      ...state,
      tenderGeneration: { ...state.tenderGeneration!, authorityBudgetCentsPerPeriod: 1n },
    })).toThrow(/Ausschreibungsgenerierung/u);
  });

  it("weist verschobene native Zeiten und umgebuchte Lose trotz gleicher Fahrt-ID-Menge ab", () => {
    const deployment = plannedDeployment();
    const first = deployment.regionalSimulation.trains[0]!;
    for (const changed of [
      { ...first, scheduledDepartureMs: first.scheduledDepartureMs + 1_000 },
      { ...first, serviceOutcome: { ...first.serviceOutcome!, scheduledArrivalMs: first.serviceOutcome!.scheduledArrivalMs + 1_000 } },
      { ...first, serviceOutcome: { ...first.serviceOutcome!, lotId: deployment.blueprint.lots[1]!.lotId } },
    ]) expect(() => startAlphaDeploymentEconomy({ ...deployment, regionalSimulation: { ...deployment.regionalSimulation, trains: [changed, ...deployment.regionalSimulation.trains.slice(1)] } })).toThrow(/Abfahrts- oder Ankunftsbindungen/u);
    const [firstLot, secondLot, ...otherLots] = deployment.blueprint.lots;
    expect(() => startAlphaDeploymentEconomy({ ...deployment, blueprint: { ...deployment.blueprint, lots: [{ ...firstLot!, trainRunIds: secondLot!.trainRunIds }, { ...secondLot!, trainRunIds: firstLot!.trainRunIds }, ...otherLots] } })).toThrow(/unterschiedliche Fahrten/u);
  });

  it("bindet Fahrten nach 24 Uhr an dieselbe normalisierte native Tageszeit", () => {
    const deployment = plannedDeployment();
    const snapshot = deployment.economy.planning!.snapshot;
    const planning = createGtfsPlanningEnvelope({ ...snapshot, patterns: snapshot.patterns.map((pattern) => ({
      ...pattern,
      journeys: pattern.journeys.map((journey) => ({ ...journey, departureServiceSeconds: journey.departureServiceSeconds + 86_400, arrivalServiceSeconds: journey.arrivalServiceSeconds + 86_400, departureEpochSeconds: journey.departureEpochSeconds + 86_400, arrivalEpochSeconds: journey.arrivalEpochSeconds + 86_400 })),
    })) });
    expect(() => startAlphaDeploymentEconomy({ ...deployment, economy: { ...deployment.economy, planning } })).not.toThrow();
  });
});

describe("signierte Alpha-Weltepoche", () => {
  it("akzeptiert ausschliesslich einen Montag um 00:00:00 UTC", () => {
    expect(() => validateDeploymentWorldDefinition(definition, "public")).not.toThrow();
    expect(() => validateDeploymentWorldDefinition(
      { ...definition, epoch: "2026-08-10T00:00:00Z" },
      "public",
    )).not.toThrow();
    expect(() => validateDeploymentWorldDefinition(
      { ...definition, epoch: "2026-08-09T00:00:00.000Z" },
      "public",
    )).toThrow(/Weltdefinition/);
    expect(() => validateDeploymentWorldDefinition(
      { ...definition, epoch: "2026-08-10T00:00:01.000Z" },
      "public",
    )).toThrow(/Weltdefinition/);
    expect(() => validateDeploymentWorldDefinition(
      { ...definition, epoch: "2026-08-10T02:00:00+02:00" },
      "public",
    )).not.toThrow();
  });
});

describe("harter Operational-v2-Serverstart", () => {
  const initialization: OperationalSimulationInitialization = {
    schemaVersion: "zugfolge-operational-simulation-initialize/v2",
    worldId: "00000000-0000-4000-8000-000000000014",
    regionId: "deutschland",
    nowMs: 0,
    repeatEveryMs: null,
    protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
    infraRelease: {
      schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
      infraReleaseId: "infra-deutschland-2026.3",
      file: "operational-infrastructure-v2.json",
      bytes: 1,
      sha256: "a".repeat(64),
      stateHash: "b".repeat(64),
    },
    vehicleTypes: [],
    vehicles: [],
    formations: [],
    trains: [],
    movementContinuations: [],
  };

  it("initialisiert einen neuen Kopf ohne vorzeitigen Restore", async () => {
    const initialize = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);

    await expect(initializeOrRestoreRegionalSimulation(
      { initialize, restore },
      initialization,
      undefined,
      new Date(0),
    )).resolves.toBe("initialized");
    expect(initialize).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
  });

  it("restauriert einen vorhandenen Kopf ohne erneute Initialisierung", async () => {
    const initialize = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);
    const expected = operationalSimulationInitializationHash(initialization);

    await expect(initializeOrRestoreRegionalSimulation(
      { initialize, restore },
      initialization,
      expected,
      new Date(0),
    )).resolves.toBe("restored");
    expect(initialize).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith(initialization.worldId, initialization.regionId, expected);
  });

  it("weist einen vorhandenen Kopf mit fremder Initialisierungsbindung ohne Mutation ab", async () => {
    const initialize = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);

    await expect(initializeOrRestoreRegionalSimulation(
      { initialize, restore },
      initialization,
      "f".repeat(64),
      new Date(0),
    )).rejects.toThrow(/gehoert nicht zum signierten Deployment/u);
    expect(initialize).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("meldet fuer ein persistiertes aktives V1-Deployment einen stabilen Cutover-Fehlercode", () => {
    const persistedV1 = {
      deployment: {
        schema: "zugfolge-alpha-world-deployment/v1",
        worldId: "00000000-0000-4000-8000-000000000014",
      },
      deploymentHash: "a".repeat(64),
      signature: {
        algorithm: "Ed25519",
        keyId: "legacy-alpha",
        valueBase64: Buffer.alloc(64).toString("base64"),
      },
    };

    expect(() => parsePersistedActiveAlphaWorldDeployment(
      persistedV1.deployment.worldId,
      persistedV1,
      {},
    )).toThrow(expect.objectContaining({
      name: "ActiveWorldDeploymentCutoverError",
      code: ACTIVE_WORLD_DEPLOYMENT_CUTOVER_ERROR_CODE,
      worldId: persistedV1.deployment.worldId,
    }));
    expect(() => parsePersistedActiveAlphaWorldDeployment(
      persistedV1.deployment.worldId,
      persistedV1,
      {},
    )).toThrow(ActiveWorldDeploymentCutoverError);
  });
});

describe("Eigenbetriebsverifikation nach einem Prozessneustart", () => {
  it("belegt mit exakt gebundenem Operational-v2-Regionsframe die Livemap, erfindet aber keine laufenden Fahrten", () => {
    const snapshot = {
      worldId: "00000000-0000-4000-8000-000000000315",
      streamId: "operational-v2-start",
      sequence: 0,
      at: 0,
      trains: [],
      operationalRegions: [{
        regionId: "deutschland",
        infrastructureReleaseId: "infra-deutschland-2026.3",
        commitSequence: 0,
        simulationTimeMs: 0,
        staleAfterMs: 5_000,
        routeLocks: [],
        signals: {},
        activeDisruptions: [],
      }],
    } as const;
    const binding = {
      regionId: "deutschland",
      infrastructureReleaseId: "infra-deutschland-2026.3",
    } as const;

    expect(publicOperationSnapshotVerification(snapshot, ["run-1", "run-2"], binding))
      .toEqual({ livemapReady: true, runningTrainRunIds: [] });
    expect(publicOperationSnapshotVerification({
      ...snapshot,
      operationalRegions: [{ ...snapshot.operationalRegions[0], regionId: "fremd" }],
    }, ["run-1", "run-2"], binding)).toEqual({ livemapReady: false, runningTrainRunIds: [] });
    expect(publicOperationSnapshotVerification({
      ...snapshot,
      operationalRegions: [{
        ...snapshot.operationalRegions[0],
        infrastructureReleaseId: "infra-fremd",
      }],
    }, ["run-1", "run-2"], binding)).toEqual({ livemapReady: false, runningTrainRunIds: [] });
    expect(publicOperationSnapshotVerification({ ...snapshot, operationalRegions: [] }, ["run-1"], binding))
      .toEqual({ livemapReady: false, runningTrainRunIds: [] });
    expect(publicOperationSnapshotVerification({
      ...snapshot,
      trains: [{
        id: "run-1",
        operator: "public",
        trainNumber: "RE 1",
        category: "regional",
        positionMm: 0,
        speedMmPerSecond: 0,
        delaySeconds: 0,
        nextOperatingPoint: "station-1",
        status: "planned",
        operationMarker: {
          schemaVersion: "zugfolge-livemap-operation-marker/v1",
          kind: "public-operator",
        },
      }],
      operationalRegions: [],
    }, ["run-1"], binding)).toEqual({
      livemapReady: false,
      runningTrainRunIds: ["run-1"],
    });
  });

  it("reduziert kanonische Tagesinstanzen und Aussenlaeufe auf die signierten Basisfahrten", () => {
    const result = publicOperationSnapshotVerification({
      worldId: "00000000-0000-4000-8000-000000000014",
      streamId: "restart-stream",
      sequence: 17,
      at: 3 * 86_400 + 3_600,
      trains: [{
        id: "train-1:day-3",
        baseTrainRunId: "train-1",
        operator: "public",
        trainNumber: "RE 1",
        category: "regional",
        positionMm: 1_000,
        speedMmPerSecond: 20_000,
        delaySeconds: 0,
        nextOperatingPoint: "station-2",
        status: "running",
        operationMarker: {
          schemaVersion: "zugfolge-livemap-operation-marker/v1",
          kind: "public-operator",
        },
      }, {
        id: "train-1:day-2",
        baseTrainRunId: "train-1",
        operator: "public",
        trainNumber: "RE 1",
        category: "regional",
        positionMm: 20_000,
        speedMmPerSecond: 0,
        delaySeconds: 0,
        nextOperatingPoint: "station-3",
        status: "completed",
        operationMarker: {
          schemaVersion: "zugfolge-livemap-operation-marker/v1",
          kind: "public-operator",
        },
      }, {
        id: "player-train",
        operator: "player",
        trainNumber: "P 1",
        category: "regional",
        positionMm: 500,
        speedMmPerSecond: 10_000,
        delaySeconds: 0,
        nextOperatingPoint: "station-2",
        status: "running",
      }],
      externalTrains: [{
        id: "train-2:day-3",
        operator: "public",
        trainNumber: "RB 2",
        category: "regional",
        journeyChainId: "train-2",
        externalLegId: "external-1",
        fromPortalId: "portal-1",
        toPortalId: "portal-2",
        scheduledEndS: 4 * 86_400,
        reentryEarliestS: 4 * 86_400,
        reentryLatestS: 4 * 86_400 + 300,
        delaySeconds: 0,
        status: "outside",
        progressBasisPoints: 5_000,
      }],
    }, ["train-1", "train-2"]);

    expect(result).toEqual({
      livemapReady: true,
      runningTrainRunIds: ["train-1", "train-2"],
    });
  });

  it("akzeptiert weder gefaelschte Basisbindungen noch nichtkanonische Tagesnummern", () => {
    const result = publicOperationSnapshotVerification({
      worldId: "00000000-0000-4000-8000-000000000014",
      streamId: "forged-stream",
      sequence: 1,
      at: 86_400,
      trains: [{
        id: "train-1:day-1",
        baseTrainRunId: "forged-train",
        operator: "public",
        trainNumber: "RE 1",
        category: "regional",
        positionMm: 1_000,
        speedMmPerSecond: 20_000,
        delaySeconds: 0,
        nextOperatingPoint: "station-2",
        status: "running",
        operationMarker: {
          schemaVersion: "zugfolge-livemap-operation-marker/v1",
          kind: "public-operator",
        },
      }],
      externalTrains: [{
        id: "train-2:day-0",
        operator: "public",
        trainNumber: "RB 2",
        category: "regional",
        journeyChainId: "train-2",
        externalLegId: "external-1",
        fromPortalId: "portal-1",
        toPortalId: null,
        scheduledEndS: 86_400,
        reentryEarliestS: null,
        reentryLatestS: null,
        delaySeconds: 0,
        status: "completed-outside",
        progressBasisPoints: 10_000,
      }],
    }, ["train-1", "train-2"]);

    expect(result).toEqual({ livemapReady: false, runningTrainRunIds: [] });
  });
});
