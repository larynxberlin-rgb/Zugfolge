import {
  AlphaConflictError,
  AlphaValidationError,
  TUTORIAL_BID_LIMITS,
  TUTORIAL_PRESENTATION_SCHEMA,
  TUTORIAL_TEMPLATE_HASH,
  alphaHash,
  type AlphaDatabase,
  type TutorialAction,
  type TutorialProgrammeEffect,
  type TutorialProgrammeRule,
  type TutorialResultSummary,
  type TutorialScenarioEvidence,
  type TutorialScenarioPresentation,
  type TutorialTemplate,
  type TutorialWorldFactory,
} from "@zugfolge/alpha";
import { CooperationService } from "@zugfolge/cooperation";
import {
  accounts,
  domainEvents,
  economyOutbox,
  ledgerTransactions,
  operatingProgramVersions,
  operatorContracts,
  operators,
  regionalSimulationStates,
  tutorialSessions,
  vehicleAssets,
  type TutorialSession,
} from "@zugfolge/db";
import { canonicalizeProgram, operatingProgramTemplates, type OperatingProgram } from "@zugfolge/dispatch";
import {
  announceTender,
  applyFleetProducerCommand,
  buildEconomyRelease,
  closeEconomyWorld,
  closeTender,
  completeMobilization,
  createEconomyPlatformAdapters,
  decodeEconomyValue,
  drainEconomyOutbox,
  EconomyStateConflictError,
  encodeEconomyValue,
  initializeFleetProducer,
  listLedgerAccounts,
  listPendingEconomyEffects,
  loadEconomyWorldState,
  loadFleetProducerCheckpoint,
  openLedgerAccount,
  openTender,
  persistEconomyTransition,
  postLedgerTransaction,
  settleContractPeriod,
  startEconomyWorld,
  submitBid,
  type Bid,
  type CostType,
  type EconomyLedgerAccountPlan,
  type EconomyJournalEntry,
  type EconomyRelease,
  type EconomyWorldState,
  type JournalAccounts,
  type ServiceSpecification,
} from "@zugfolge/economy";
import {
  PLANNING_COORDINATE_SCHEMA,
  type PlanningCoordinateCommand,
  type PlanningRuntime,
} from "@zugfolge/planning-runtime-native";
import {
  FLEET_AUTHORITY_RELEASE_SCHEMA,
  FLEET_FORMATION_COMMAND_SCHEMA,
  FLEET_INITIALIZE_SCHEMA,
  FLEET_PATH_RESERVATION_COMMAND_SCHEMA,
  FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA,
  OPERATING_INITIALIZE_SCHEMA,
  OPERATING_TRANSITION_SCHEMA,
  OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  type FleetAuthorityRelease,
  type NativeRuntime,
  type OperationalSimulationInitialization,
  type OperatingDispatchCase,
} from "@zugfolge/runtime-native";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { GameFleetAssetTransferWriter } from "./fleet-market-writer.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";
import { RegionalSimulationWorker } from "./regional-simulation-worker.js";

const COST_TYPES: readonly CostType[] = ["track", "station", "facility", "energy", "personnel", "administration", "vehicle", "penalty", "interest"];

export const TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN: EconomyLedgerAccountPlan = Object.freeze({
  schema: "economy-ledger-account-plan/v1",
  version: "tutorial-template-2026.1",
  cashAccountName: "Bank",
  revenueAccountName: "Bestellererloese",
  costAccountNames: Object.freeze(Object.fromEntries(
    COST_TYPES.map((type) => [type, `Kosten:${type}`]),
  ) as Record<CostType, string>),
});

type TutorialEconomyPlatformAdapters = ReturnType<typeof createEconomyPlatformAdapters>;

/**
 * Rekonstruiert die welt- und EVU-gebundene Tutorialkontierung aus dem Ledger.
 * Dadurch kann derselbe persistierte Outboxpfad auch nach Prozessneustart oder
 * fuer eine bereits archivierte Altzeile sicher weiterlaufen.
 */
export async function loadTutorialEconomyPlatformAdapters(
  db: AlphaDatabase,
  worldId: string,
  operatorId: string,
): Promise<TutorialEconomyPlatformAdapters | undefined> {
  const [session] = await db.select({ id: tutorialSessions.id }).from(tutorialSessions).where(and(
    eq(tutorialSessions.tutorialWorldId, worldId),
    eq(tutorialSessions.tutorialOperatorId, operatorId),
  )).limit(1);
  if (session === undefined) return undefined;

  const accountsByName = new Map((await listLedgerAccounts(db as never, { worldId, operatorId })).map((entry) => [entry.name, entry.id]));
  const required = (name: string): string => {
    const accountId = accountsByName.get(name);
    if (accountId === undefined) throw new Error(`Tutorialkontierung '${name}' fehlt fuer den Economy-Outbox-Retry.`);
    return accountId;
  };
  const accounts: JournalAccounts = {
    cashAccountId: required(TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName),
    revenueAccountId: required(TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.revenueAccountName),
    costAccountIds: Object.fromEntries(COST_TYPES.map((type) => [
      type,
      required(TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.costAccountNames[type]),
    ])) as Record<CostType, string>,
  };
  return createEconomyPlatformAdapters({
    db: db as never,
    accountsByOperator: { [operatorId]: accounts },
    accountPlan: TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN,
  });
}

const ECONOMY_RELEASE: EconomyRelease = buildEconomyRelease({
  version: "tutorial-economy-2026.1",
  rates: {
    trackPerTrainKmCents: 90n,
    stationPerStopCents: 75n,
    facilityPerHourCents: 500n,
    energyPerKwhCents: 28n,
    personnelPerHourCents: 3_200n,
    administrationPerPeriodCents: 25_000n,
    vehiclePerPeriodCents: 900_000n,
    overnightStablingPerPeriodCents: 18_000n,
    protectionEquipmentPerPeriodCents: 8_000n,
    lateInterestBasisPoints: 500,
  },
  rules: {
    qualityBaselinePunctualityBasisPoints: 8_500,
    pointsPerExtraSeat: 40,
    pointsPerPunctualityBasisPoint: 1,
    pointsPerAdditionalStop: 250,
    requirementFocusMaximumPoints: 1_500,
    contractBonusCentsPerPeriod: 100_000n,
    penaltyRates: { punctuality: 20n, cancellation: 60_000n, seats: 200n, connections: 4_000n },
    penaltyFocusMultiplierBasisPoints: 20_000,
    publicOperationSurchargeBasisPoints: 2_000,
    failedPackageFeeStepBasisPoints: 500,
    failedPackageReductionStepBasisPoints: 400,
  },
  tenderProfiles: [
    {
      id: "balanced-quality",
      weights: { price: 5_000, quality: 5_000 },
      requirementFocus: "capacity",
      penaltyFocus: "punctuality",
      specialCondition: { type: "replacement-plan" },
      viabilitySurchargeBasisPoints: 1_000,
    },
    {
      id: "comparison-price",
      weights: { price: 7_000, quality: 3_000 },
      requirementFocus: "capacity",
      penaltyFocus: "punctuality",
      viabilitySurchargeBasisPoints: 800,
    },
  ],
});

const SPECIFICATION: ServiceSpecification = {
  lines: ["T 1"],
  trainKmPerPeriod: 840n,
  stopsPerPeriod: 112n,
  serviceHoursPerPeriod: 44n,
  facilityHoursPerPeriod: 12n,
  energyKwhPerPeriod: 5_200n,
  vehicleCount: 1n,
  overnightUnits: 1n,
  protectionUnits: 1n,
  requirements: {
    minimumSeats: 120,
    firstClassBasisPoints: 0,
    accessible: true,
    bicyclePlaces: 8,
    wheelchairPlaces: 2,
    requiredEquipment: ["passenger-information"],
  },
};

export const TUTORIAL_CONTRACT_PERIOD_SECONDS = 3_600;
export const TUTORIAL_SETTLEMENT_PERIOD = 0;

export const TUTORIAL_TIMELINE = Object.freeze({
  tenderAnnouncedAtS: 10,
  tenderOpensAtS: 20,
  comparisonBidAtS: 30,
  playerBidAtS: 60,
  tenderClosesAtS: 86_420,
  leaseOfferedAtS: 86_500,
  leaseResponseDeadlineS: 86_600,
  leaseValidFromS: 86_700,
  formationAtS: 87_000,
  pathReservationAtS: 87_100,
  personnelDutyAtS: 87_200,
  operatingFromS: 90_000,
  disruptionAtS: 90_220,
  disruptionHoldUntilS: 90_400,
  settlementAtS: 93_600,
  disruptionValidUntilS: 91_000,
  leaseValidUntilS: 100_000,
  archiveAtS: 100_100,
});

export const TUTORIAL_LEASE_TIMES = Object.freeze({
  offeredAtS: TUTORIAL_TIMELINE.leaseOfferedAtS,
  responseDeadlineS: TUTORIAL_TIMELINE.leaseResponseDeadlineS,
  validFromS: TUTORIAL_TIMELINE.leaseValidFromS,
  validUntilS: TUTORIAL_TIMELINE.leaseValidUntilS,
  terminationNoticeS: 300,
});

export const TUTORIAL_ECONOMY_LOTS = Object.freeze([
  Object.freeze({ id: "tutorial-lot", size: 4, attractiveness: 4 }),
  Object.freeze({ id: "tutorial-calendar-lot-1", size: 1, attractiveness: 1 }),
  Object.freeze({ id: "tutorial-calendar-lot-2", size: 1, attractiveness: 1 }),
  Object.freeze({ id: "tutorial-calendar-lot-3", size: 1, attractiveness: 1 }),
]);

export const TUTORIAL_CONTRACT_EVIDENCE = Object.freeze(["vehicles", "personnel", "paths"] as const);

function object(value: unknown, name = "Wert"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} ist kein Objekt.`);
  return value as Record<string, unknown>;
}

function textValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} fehlt.`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} ist keine nichtnegative sichere Ganzzahl.`);
  return value as number;
}

function signedInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} ist keine sichere Ganzzahl.`);
  return value as number;
}

function scenario(session: TutorialSession): Record<string, unknown> {
  return object(session.scenarioState, "Tutorialszenario");
}

function lease(template: TutorialTemplate, id: string): Record<string, unknown> {
  const found = template.leases.find((entry) => entry["id"] === id);
  if (found === undefined) throw new AlphaValidationError("Unbekanntes Leasingangebot.");
  return found as Record<string, unknown>;
}

function path(template: TutorialTemplate, id: string): Record<string, unknown> {
  const found = template.paths.find((entry) => entry["id"] === id);
  if (found === undefined) throw new AlphaValidationError("Unbekannte Trassenalternative.");
  return found as Record<string, unknown>;
}

function programme(template: TutorialTemplate, id: string): Record<string, unknown> {
  const found = template.programmes.find((entry) => entry["id"] === id);
  if (found === undefined) throw new AlphaValidationError("Unbekannte Betriebsprogrammvorlage.");
  return found as Record<string, unknown>;
}

const PROGRAMME_RULE_LABELS: Readonly<Record<TutorialProgrammeRule, string>> = Object.freeze({
  "hold-connections": "Anschlüsse abwarten",
  "prioritize-punctuality": "Pünktlichkeit priorisieren",
  "activate-reserve": "Reserve aktivieren",
});

const DISRUPTION_ACTION_LABELS: Readonly<Record<Extract<TutorialAction, { readonly type: "dispatch" }>["action"], string>> = Object.freeze({
  short_turn: "Vorzeitig wenden",
  request_reroute: "Umleitung anfordern",
  trigger_rail_replacement: "Ersatzverkehr auslösen",
});

function programmeEffect(rule: TutorialProgrammeRule): TutorialProgrammeEffect {
  return rule === "prioritize-punctuality"
    ? { costCents: "25000", qualityBasisPoints: 250, penaltyRiskBasisPoints: -300 }
    : { costCents: "55000", qualityBasisPoints: 400, penaltyRiskBasisPoints: -450 };
}

function instant(session: TutorialSession, atS: number): Date {
  return new Date(session.startedAt.getTime() + atS * 1_000);
}

async function appendEvent(
  db: AlphaDatabase,
  worldId: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
  occurredAt: Date,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select ${tutorialSessions.id} from ${tutorialSessions} where ${tutorialSessions.tutorialWorldId} = ${worldId} for update`);
    const [existing] = await tx.select({ sequence: domainEvents.sequence, payload: domainEvents.payload }).from(domainEvents).where(and(
      eq(domainEvents.worldId, worldId),
      eq(domainEvents.eventType, eventType),
      sql`${domainEvents.payload} ->> 'decisionId' = ${String(payload["decisionId"] ?? "")}`,
    )).limit(1);
    if (existing !== undefined) {
      if (alphaHash("zugfolge-tutorial-domain-event-payload/v1", existing.payload)
        !== alphaHash("zugfolge-tutorial-domain-event-payload/v1", payload)) {
        throw new AlphaConflictError(
          "Tutorialaktion widerspricht dem bereits persistierten Entscheidungsbeleg.",
          "tutorial_action_replay_conflict",
        );
      }
      return existing.sequence;
    }
    const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
    const sequence = (head?.sequence ?? 0) + 1;
    await tx.insert(domainEvents).values({ worldId, sequence, eventType, payload, occurredAt });
    return sequence;
  });
}

type TutorialDispatchAction = Extract<TutorialAction, { readonly type: "dispatch" }>;

interface PersistedTutorialDispatchDecision {
  readonly sequence: number;
  readonly action: TutorialDispatchAction["action"];
}

async function loadPersistedTutorialDispatchDecision(
  db: AlphaDatabase,
  session: Pick<TutorialSession, "reference" | "tutorialWorldId" | "tutorialOperatorId">,
): Promise<PersistedTutorialDispatchDecision | undefined> {
  const decisionId = `${session.reference}:decision:1`;
  const [row] = await db.select({ sequence: domainEvents.sequence, payload: domainEvents.payload }).from(domainEvents).where(and(
    eq(domainEvents.worldId, session.tutorialWorldId),
    eq(domainEvents.eventType, "dispatch.decision-applied"),
    sql`${domainEvents.payload} ->> 'decisionId' = ${decisionId}`,
  )).limit(1);
  if (row === undefined) return undefined;
  const payload = object(row.payload, "Persistierter Tutorial-Entscheidungsbeleg");
  const action = payload["action"];
  if (
    payload["decisionId"] !== decisionId
    || payload["operatorId"] !== session.tutorialOperatorId
    || payload["trainRunId"] !== "tutorial-run-1"
    || typeof action !== "string"
    || !Object.hasOwn(DISRUPTION_ACTION_LABELS, action)
  ) {
    throw new AlphaConflictError(
      "Persistierter Tutorial-Entscheidungsbeleg ist nicht welt- und EVU-konsistent.",
      "tutorial_action_replay_conflict",
    );
  }
  return { sequence: row.sequence, action: action as TutorialDispatchAction["action"] };
}

export function tutorialPlanningCommand(
  session: Pick<TutorialSession, "reference" | "tutorialWorldId">,
  template: TutorialTemplate,
  alternative: Record<string, unknown>,
  runIndex: number,
): PlanningCoordinateCommand {
  const stations = template.region.stations as unknown as PlanningCoordinateCommand["stations"];
  const segments = template.region.segments as unknown as PlanningCoordinateCommand["segments"];
  const desiredDepartureS = integer(alternative["desiredDepartureS"], "Trassenabfahrt");
  const bufferSeconds = integer(alternative["bufferSeconds"], "Trassenpuffer");
  return {
    schemaVersion: PLANNING_COORDINATE_SCHEMA,
    worldId: session.tutorialWorldId,
    runId: `${session.reference}:${textValue(alternative["id"], "Trassen-ID")}`,
    expectedProjectionRevision: null,
    seedWorld: template.worldSeed.toString(),
    seedPeriod: runIndex,
    sourceId: `${template.version.replaceAll(".", "-")}-corridor`,
    corridorId: template.region.id,
    corridorName: template.region.name,
    stations,
    segments,
    requests: [
      {
        requestNumericId: runIndex,
        trainId: `${session.reference}:path-train-${runIndex}`,
        trainCategory: "regional",
        trainNumber: 26_800 + runIndex * 2,
        originStationId: "tut-kieselgrund",
        destinationStationId: "tut-fichtenhain",
        desiredDepartureS,
        operatingDays: "daily",
        stops: [
          { stationId: "tut-muehlenbrueck", minimumDwellS: 30 },
          { stationId: "tut-wiesenrode", minimumDwellS: 30 },
        ],
        earlierS: 0,
        laterS: bufferSeconds,
        stepS: 15,
        extraRunningTimeS: bufferSeconds,
        maxOperationalStops: 2,
        train: {
          numericId: runIndex,
          name: `Tutorialzug ${runIndex}`,
          massKg: 118_000,
          lengthMm: 74_000,
          maximumSpeedKph: 140,
          accelerationMmPerS2: 850,
          decelerationMmPerS2: 900,
        },
      },
      {
        requestNumericId: 10_000 + runIndex,
        trainId: `${session.reference}:comparison-path-train-${runIndex}`,
        trainCategory: "regional",
        trainNumber: 27_800 + runIndex * 2,
        originStationId: "tut-kieselgrund",
        destinationStationId: "tut-fichtenhain",
        desiredDepartureS: desiredDepartureS + 15,
        operatingDays: "daily",
        stops: [
          { stationId: "tut-muehlenbrueck", minimumDwellS: 30 },
          { stationId: "tut-wiesenrode", minimumDwellS: 30 },
        ],
        earlierS: 0,
        laterS: Math.max(60, bufferSeconds),
        stepS: 15,
        extraRunningTimeS: Math.max(60, bufferSeconds),
        maxOperationalStops: 2,
        train: {
          numericId: 10_000 + runIndex,
          name: `Vergleichszug ${runIndex}`,
          massKg: 132_000,
          lengthMm: 82_000,
          maximumSpeedKph: 140,
          accelerationMmPerS2: 780,
          decelerationMmPerS2: 900,
        },
      },
    ],
  };
}

/**
 * Vollstaendige, fiktive Betriebsgrundlage des privaten Tutorialkorridors.
 * Auch das Tutorial durchlaeuft damit denselben operativen v2-Single-Writer;
 * es gibt keinen vereinfachten Positions- oder Stoerungskern daneben.
 */
function tutorialOperationalInitialization(
  session: Pick<TutorialSession, "tutorialWorldId" | "tutorialOperatorId">,
  template: TutorialTemplate,
): OperationalSimulationInitialization {
  const stations = new Map(template.region.stations.map((station) => [
    textValue(station["id"], "Tutorialbetriebsstelle"),
    station,
  ] as const));
  let routeStartMm = 0;
  const routeLegs = template.region.segments.map((segment) => {
    const edgeId = textValue(segment["id"], "Tutorialkante");
    const lengthMm = integer(segment["lengthMm"], "Tutorialkantenlaenge");
    const leg = Object.freeze({
      edgeId,
      direction: "along" as const,
      edgeEntryMm: 0,
      edgeExitMm: lengthMm,
      routeStartMm,
      blockIds: Object.freeze([`track:${edgeId}`]),
      speedLimitMmps: Math.floor(integer(segment["maximumSpeedKph"], "Tutorialgeschwindigkeit") * 1_000_000 / 3_600),
      gradientPerMille: 0,
      requiredProtectionSystems: Object.freeze(["pzb"]),
    });
    routeStartMm += lengthMm;
    return leg;
  });
  const directedEdges = Object.fromEntries(routeLegs.map((leg) => [
    leg.edgeId,
    leg.edgeExitMm,
  ]));
  const edgeGeometries = Object.fromEntries(template.region.segments.map((segment) => {
    const edgeId = textValue(segment["id"], "Tutorialkante");
    const from = stations.get(textValue(segment["fromStationId"], "Tutorialkantenanfang"));
    const to = stations.get(textValue(segment["toStationId"], "Tutorialkantenende"));
    if (from === undefined || to === undefined) {
      throw new AlphaValidationError("Tutorialkante besitzt keine vollstaendige releasegebundene Geometrie.");
    }
    const lengthMm = integer(segment["lengthMm"], "Tutorialkantenlaenge");
    return [edgeId, Object.freeze([
      Object.freeze({
        edgeOffsetMm: 0,
        latitudeE7: integer(from["latitudeE7"], "Tutorialbreitengrad"),
        longitudeE7: integer(from["longitudeE7"], "Tutoriallaengengrad"),
        bearingMilliDegrees: 90_000,
      }),
      Object.freeze({
        edgeOffsetMm: lengthMm,
        latitudeE7: integer(to["latitudeE7"], "Tutorialbreitengrad"),
        longitudeE7: integer(to["longitudeE7"], "Tutoriallaengengrad"),
        bearingMilliDegrees: null,
      }),
    ])] as const;
  }));
  const routeVersionId = `${template.version}:route:v1`;
  const routeTemplateId = `${template.version}:route-template:v1`;
  const interlockingRouteId = `${template.version}:interlocking:v1`;
  const signalId = `${template.version}:signal:entry`;
  const switchId = `${template.version}:switch:muehlenbrueck`;
  const vehicleTypeId = `${template.version}:vehicle-type`;
  const vehicleId = `${template.version}:operational-vehicle`;
  const formationId = `${template.version}:formation:v1`;
  const blockResources = routeLegs.map((leg) => leg.blockIds[0]!);
  return Object.freeze({
    schemaVersion: OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
    worldId: session.tutorialWorldId,
    regionId: template.region.id,
    nowMs: 0,
    infraRelease: Object.freeze({
      id: `${template.version}:operational-infra`,
      directedEdges,
      edgeGeometries,
      routeVersions: Object.freeze({
        [routeVersionId]: Object.freeze({
          id: routeVersionId,
          templateId: routeTemplateId,
          predecessorId: null,
          transitionRouteMm: null,
          legs: Object.freeze(routeLegs),
        }),
      }),
      interlockingRoutes: Object.freeze({
        [interlockingRouteId]: Object.freeze({
          id: interlockingRouteId,
          routeTemplateId,
          signalId,
          movementKind: "train",
          pathResources: Object.freeze(blockResources),
          overlapResources: Object.freeze([]),
          flankResources: Object.freeze([]),
          switchPositions: Object.freeze({ [switchId]: "straight" }),
          authorityEndRouteMm: routeStartMm,
          releaseAfterTailRouteMm: routeStartMm,
        }),
      }),
      signals: Object.freeze([signalId]),
      switches: Object.freeze([switchId]),
      blockResources: Object.freeze(blockResources),
      platformIntervals: Object.freeze({}),
      regionBoundaries: Object.freeze([]),
      rzueLayoutId: `${template.version}:rzue-layout`,
    }),
    vehicleTypes: Object.freeze([Object.freeze({
      powered: true,
      vehicleType: Object.freeze({
        id: vehicleTypeId,
        lengthMm: 74_000,
        massKg: 118_000,
        maximumSpeedMmps: 38_888,
        powerWatts: 2_400_000,
        startingTractiveForceNewtons: 160_000,
        maximumAccelerationMmps2: 850,
        serviceBrakeMmps2: 900,
        emergencyBrakeMmps2: 1_300,
        protectionSystems: Object.freeze(["pzb"]),
      }),
    })]),
    vehicles: Object.freeze([Object.freeze({
      id: vehicleId,
      typeId: vehicleTypeId,
      powered: true,
      orientation: "along",
      condition: Object.freeze({
        mechanicsBasisPoints: 9_500,
        driveBasisPoints: 9_500,
        brakesBasisPoints: 9_500,
        kilometresSinceMaintenance: 0,
        operatingHoursSinceMaintenance: 0,
        openObservations: 0,
      }),
      restrictions: Object.freeze({}),
      history: Object.freeze([]),
    })]),
    formations: Object.freeze([Object.freeze({
      id: formationId,
      predecessorId: null,
      vehicleIds: Object.freeze([vehicleId]),
    })]),
    trains: Object.freeze([Object.freeze({
      id: "tutorial-run-1",
      trainNumber: "T 7101",
      operatorId: session.tutorialOperatorId,
      movementKind: "train",
      routeVersionId,
      formationVersionId: formationId,
      headRouteMm: 0,
      scheduledDepartureMs: TUTORIAL_TIMELINE.operatingFromS * 1_000,
      publicPassengerStop: true,
    })]),
  });
}

function fleetRelease(
  session: TutorialSession,
  template: TutorialTemplate,
  lessorOperatorId: string,
  planningHashes: readonly string[],
): FleetAuthorityRelease {
  const assets = template.leases.map((offer, index) => ({
    id: textValue(offer["vehicleId"], "Fahrzeug-ID"),
    numericId: index + 1,
    operatorId: lessorOperatorId,
    vehicleTypeId: 440 + index,
    classDesignation: textValue(offer["classDesignation"], "Baureihe"),
    tradeName: `Tutorial-Triebzug ${index + 1}`,
    buildYear: index === 0 ? 2018 : 2024,
    acquisitionYear: 2026,
    procurementChannel: "leasing" as const,
    approvedLineIds: ["T 1"],
    maintenanceDeadlines: [{ kind: "inspection", dueAt: TUTORIAL_TIMELINE.leaseValidUntilS }],
    installedProtection: ["pzb" as const],
    technical: {
      lengthMm: 74_000,
      massKg: 118_000,
      maximumSpeedKph: 140,
      accelerationMmPerS2: 850,
      decelerationMmPerS2: 900,
      traction: "electric" as const,
      electricSystems: ["ac15kv" as const],
      role: "powered-unit" as const,
      controlStands: { front: true, rear: true },
    },
    passenger: {
      seats: integer(offer["seats"], "Sitzplaetze"),
      firstClassSeats: 0,
      accessible: true,
      bicyclePlaces: 12,
      wheelchairPlaces: 2,
      equipment: ["passenger-information"],
      operatingCostCentsPerTrainKm: index === 0 ? 760 : 690,
      replacementPlan: true,
    },
    deliveredAt: 0,
    retiredAt: TUTORIAL_TIMELINE.leaseValidUntilS,
  }));
  const pathReceipts = template.paths.map((alternative, index) => ({
    id: textValue(alternative["receiptId"], "Trassenbeleg"),
    numericRouteId: index + 1,
    operatorId: session.tutorialOperatorId,
    serviceLineIds: ["T 1"],
    decision: "confirmed" as const,
    validFrom: TUTORIAL_TIMELINE.leaseValidFromS,
    validUntil: TUTORIAL_TIMELINE.leaseValidUntilS,
    platformLengthsMm: [160_000, 170_000, 180_000],
    electrifications: ["overhead-ac15kv" as const],
    requiredProtection: ["pzb" as const],
    approvedClasses: template.leases.map((offer) => textValue(offer["classDesignation"], "Baureihe")),
    plannerStateHash: planningHashes[index]!,
    conflictCheckHash: alphaHash("zugfolge-tutorial-conflict-check/v1", { worldId: session.tutorialWorldId, alternative: alternative["id"], planningStateHash: planningHashes[index] }),
  }));
  return {
    schemaVersion: FLEET_AUTHORITY_RELEASE_SCHEMA,
    releaseId: `${template.version}:${session.reference}`,
    referenceYear: 2026,
    assets,
    personnelPools: [{
      id: "tutorial-personnel-pool",
      numericId: 1,
      operatorId: session.tutorialOperatorId,
      capacitySeconds: 28_800,
      minimumRestSeconds: 39_600,
      classDesignations: assets.map((asset) => asset.classDesignation),
      pathReceiptIds: pathReceipts.map((receipt) => receipt.id),
      qualificationHash: alphaHash("zugfolge-tutorial-personnel-qualification/v1", { worldId: session.tutorialWorldId, operatorId: session.tutorialOperatorId }),
    }],
    pathReceipts,
  };
}

function comparisonBid(operatorId: string): Bid {
  return {
    id: "tutorial-comparison-bid",
    operatorId,
    orderingFeeCentsPerTrainKm: 1_580n,
    vehicle: {
      formationId: "tutorial-comparison-formation",
      minimumSeats: 132,
      maximumSpeedKph: 140,
      operatingCostCentsPerTrainKm: 780,
      firstClassBasisPoints: 0,
      accessible: true,
      bicyclePlaces: 8,
      wheelchairPlaces: 2,
      requiredEquipment: ["passenger-information"],
      vehicleAgeYears: 7,
      traction: "electric",
      replacementPlan: true,
      evidence: { source: "zugfolge-fleet-mobilization/v1", fleetRevision: 0, snapshotHash: TUTORIAL_TEMPLATE_HASH, formationId: "tutorial-comparison-formation" },
    },
    promises: { extraSeats: 12, punctualityBasisPoints: 8_900, additionalStops: 0 },
    submittedAt: TUTORIAL_TIMELINE.comparisonBidAtS,
  };
}

export function tutorialPlayerBid(
  session: Pick<TutorialSession, "reference" | "tutorialOperatorId">,
  action: Extract<TutorialAction, { type: "submit-bid" }>,
  vehicleId: string,
): Bid {
  const formationId = `${session.reference}:planned-formation:${vehicleId}`;
  return {
    id: `${session.reference}:player-bid`,
    operatorId: session.tutorialOperatorId,
    orderingFeeCentsPerTrainKm: BigInt(action.orderingFeeCentsPerTrainKm),
    vehicle: {
      formationId,
      minimumSeats: 140 + action.extraSeats,
      maximumSpeedKph: 140,
      operatingCostCentsPerTrainKm: 720,
      firstClassBasisPoints: 0,
      accessible: true,
      bicyclePlaces: 12,
      wheelchairPlaces: 2,
      requiredEquipment: ["passenger-information"],
      vehicleAgeYears: 4,
      traction: "electric",
      replacementPlan: true,
      evidence: { source: "zugfolge-fleet-mobilization/v1", fleetRevision: 0, snapshotHash: TUTORIAL_TEMPLATE_HASH, formationId },
    },
    promises: { extraSeats: action.extraSeats, punctualityBasisPoints: action.punctualityBasisPoints, additionalStops: 0 },
    submittedAt: TUTORIAL_TIMELINE.playerBidAtS,
  };
}

type TutorialSubmitBidAction = Extract<TutorialAction, { readonly type: "submit-bid" }>;

function persistedTutorialBidAction(
  session: Pick<TutorialSession, "reference" | "tutorialOperatorId">,
  bid: Bid,
  vehicleId: string,
): TutorialSubmitBidAction {
  const action: TutorialSubmitBidAction = {
    type: "submit-bid",
    orderingFeeCentsPerTrainKm: bid.orderingFeeCentsPerTrainKm.toString(),
    extraSeats: bid.promises.extraSeats,
    punctualityBasisPoints: bid.promises.punctualityBasisPoints,
  };
  const expectedBid = tutorialPlayerBid(session, action, vehicleId);
  if (alphaHash("zugfolge-tutorial-player-bid/v1", expectedBid)
    !== alphaHash("zugfolge-tutorial-player-bid/v1", bid)) {
    throw new AlphaConflictError(
      "Persistierter Tutorial-Zuschlag widerspricht dem gebundenen Spielerangebot.",
      "tutorial_action_replay_conflict",
    );
  }
  return action;
}

function requireSameTutorialAction(
  requested: TutorialSubmitBidAction | TutorialDispatchAction,
  persisted: TutorialSubmitBidAction | TutorialDispatchAction,
): void {
  if (alphaHash("zugfolge-tutorial-action/v1", requested)
    !== alphaHash("zugfolge-tutorial-action/v1", persisted)) {
    throw new AlphaConflictError(
      "Tutorial-Retry verwendet andere Nutzdaten als der persistierte Entscheidungsbeleg.",
      "tutorial_action_replay_conflict",
    );
  }
}

export function prepareTutorialEconomy(input: {
  readonly worldId: string;
  readonly tutorialAccountId: string;
  readonly comparisonAccountId: string;
  readonly comparisonOperatorId: string;
  readonly reference: string;
}) {
  const started = startEconomyWorld({
    worldId: input.worldId,
    seed: 7_219_2026n,
    durationMonths: 6,
    release: ECONOMY_RELEASE,
    lots: TUTORIAL_ECONOMY_LOTS,
    authorityBudgets: [{ authorityId: "tutorial-authority", period: 0, availableCents: 50_000_000n, committedCents: 0n }],
    accounts: [input.tutorialAccountId, input.comparisonAccountId],
    publicVehiclePoolByLot: { "tutorial-lot": ["tutorial-public-reserve"] },
  });
  const announced = announceTender(started.state, {
    commandId: `${input.reference}:announce`,
    release: ECONOMY_RELEASE,
    recipients: [input.tutorialAccountId],
    tender: {
      id: "tutorial-tender",
      worldId: input.worldId,
      lotId: "tutorial-lot",
      incumbentOperatorId: "public",
      specification: SPECIFICATION,
      announcedAt: TUTORIAL_TIMELINE.tenderAnnouncedAtS,
      opensAt: TUTORIAL_TIMELINE.tenderOpensAtS,
      closesAt: TUTORIAL_TIMELINE.tenderClosesAtS,
      operatingFrom: TUTORIAL_TIMELINE.operatingFromS,
      contractPeriods: 2,
      periodDurationSeconds: TUTORIAL_CONTRACT_PERIOD_SECONDS,
      smallLot: true,
    },
  });
  let state = openTender(announced.state, `${input.reference}:open`, "tutorial-tender", TUTORIAL_TIMELINE.tenderOpensAtS);
  state = submitBid(state, `${input.reference}:comparison-bid`, "tutorial-tender", comparisonBid(input.comparisonOperatorId), {
    accountId: input.comparisonAccountId,
    period: 0,
    smallLot: true,
    minimumScore: 0,
  });
  return {
    initial: started,
    state,
    effects: { notices: announced.effects.notices, journal: [] },
  };
}

export class GameTutorialWorldFactory implements TutorialWorldFactory {
  readonly #cooperation: CooperationService;
  readonly #clock: () => Date;

  constructor(
    private readonly db: AlphaDatabase,
    private readonly runtime: NativeRuntime,
    private readonly planning: PlanningRuntime,
    private readonly regional: RegionalSimulationWorker,
    options: { readonly clock?: () => Date } = {},
  ) {
    this.#cooperation = new CooperationService(db as never, undefined, new GameFleetAssetTransferWriter(runtime));
    this.#clock = options.clock ?? (() => new Date());
  }

  private wallClock(): Date {
    const at = this.#clock();
    if (Number.isNaN(at.getTime())) throw new RangeError("Tutorial-Outbox-Zeit ist ungueltig.");
    return at;
  }

  private async drainEconomy(session: TutorialSession): Promise<number> {
    if ((await listPendingEconomyEffects(this.db as never, session.tutorialWorldId, 1)).length === 0) return 0;
    const adapters = await loadTutorialEconomyPlatformAdapters(this.db, session.tutorialWorldId, session.tutorialOperatorId);
    if (adapters === undefined) throw new AlphaConflictError("Tutorialkontierung ist nicht wiederherstellbar.", "tutorial_economy_accounts_unavailable");
    return drainEconomyOutbox(this.db as never, session.tutorialWorldId, adapters, this.wallClock());
  }

  private async settlementJournal(session: TutorialSession): Promise<EconomyJournalEntry> {
    const effectId = `${session.reference}:settlement:settlement`;
    const [row] = await this.db.select({ payload: economyOutbox.payload }).from(economyOutbox).where(and(
      eq(economyOutbox.worldId, session.tutorialWorldId),
      eq(economyOutbox.effectType, "journal"),
      eq(economyOutbox.effectId, effectId),
    )).limit(1);
    const entry = row === undefined ? undefined : decodeEconomyValue(row.payload) as EconomyJournalEntry;
    if (entry === undefined
      || entry.worldId !== session.tutorialWorldId
      || entry.operatorId !== session.tutorialOperatorId
      || entry.idempotencyKey !== effectId
      || !Array.isArray(entry.postings)
      || typeof entry.revenueCents !== "bigint") {
      throw new AlphaConflictError("Persistierter Tutorial-Abrechnungsbeleg fehlt.", "tutorial_settlement_effect_unavailable");
    }
    return entry;
  }

  private async closeEconomyState(session: TutorialSession): Promise<EconomyWorldState | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const economy = await loadEconomyWorldState(this.db as never, session.tutorialWorldId);
      if (economy === undefined) return undefined;
      const closed = closeEconomyWorld(economy, `${session.reference}:close-world`);
      if (closed === economy) return economy;
      try {
        await persistEconomyTransition(this.db as never, {
          expectedRevision: economy.revision,
          state: closed,
          effects: { notices: [], journal: [] },
          committedAt: instant(session, TUTORIAL_TIMELINE.archiveAtS),
          enqueuedAt: this.wallClock(),
        });
        return closed;
      } catch (error) {
        if (!(error instanceof EconomyStateConflictError) || attempt === 2) throw error;
      }
    }
    throw new Error("Tutorialwirtschaft konnte nicht schedulerfest geschlossen werden.");
  }

  private async systemActors(session: TutorialSession): Promise<{
    readonly lessorAccountId: string;
    readonly lessorOperatorId: string;
    readonly comparisonAccountId: string;
    readonly comparisonOperatorId: string;
  }> {
    return this.db.transaction(async (tx) => {
      const actor = async (kind: "lessor" | "comparison", displayName: string, operatorName: string) => {
        const subject = `tutorial-system:${session.reference}:${kind}`;
        let [account] = await tx.insert(accounts).values({
          worldId: session.tutorialWorldId,
          keycloakSubject: subject,
          displayName,
          createdAt: session.startedAt,
        }).onConflictDoNothing({ target: [accounts.worldId, accounts.keycloakSubject] }).returning();
        account ??= (await tx.select().from(accounts).where(and(eq(accounts.worldId, session.tutorialWorldId), eq(accounts.keycloakSubject, subject))).limit(1))[0];
        if (account === undefined) throw new Error("Tutorial-Systemkonto konnte nicht materialisiert werden.");
        let [operator] = await tx.insert(operators).values({
          worldId: session.tutorialWorldId,
          foundingAccountId: account.id,
          name: operatorName,
          foundedAt: session.startedAt,
        }).onConflictDoNothing({ target: [operators.worldId, operators.name] }).returning();
        operator ??= (await tx.select().from(operators).where(and(eq(operators.worldId, session.tutorialWorldId), eq(operators.name, operatorName))).limit(1))[0];
        if (operator === undefined) throw new Error("Tutorial-System-EVU konnte nicht materialisiert werden.");
        return { accountId: account.id, operatorId: operator.id };
      };
      const lessor = await actor("lessor", "Fiktiver Fahrzeugpool", `Fichtenhain Fahrzeugpool ${session.reference.slice(-6)}`);
      const comparison = await actor("comparison", "Fiktiver Vergleichsbieter", `Muehlenbrueck Verkehr ${session.reference.slice(-6)}`);
      return {
        lessorAccountId: lessor.accountId,
        lessorOperatorId: lessor.operatorId,
        comparisonAccountId: comparison.accountId,
        comparisonOperatorId: comparison.operatorId,
      };
    });
  }

  private async ledger(session: TutorialSession, template: TutorialTemplate): Promise<JournalAccounts> {
    const existing = new Map((await listLedgerAccounts(this.db as never, { worldId: session.tutorialWorldId, operatorId: session.tutorialOperatorId })).map((entry) => [entry.name, entry.id]));
    const ensure = async (name: string): Promise<string> => {
      const current = existing.get(name);
      if (current !== undefined) return current;
      const created = await openLedgerAccount(this.db as never, { worldId: session.tutorialWorldId, operatorId: session.tutorialOperatorId, name });
      existing.set(name, created.id);
      return created.id;
    };
    const cashAccountId = await ensure(TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName);
    const equityAccountId = await ensure("Tutorialkapital");
    const revenueAccountId = await ensure(TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.revenueAccountName);
    const costAccountIds = Object.fromEntries(await Promise.all(COST_TYPES.map(async (type) => [
      type,
      await ensure(TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.costAccountNames[type]),
    ] as const))) as Record<CostType, string>;
    await postLedgerTransaction(this.db as never, {
      worldId: session.tutorialWorldId,
      operatorId: session.tutorialOperatorId,
      idempotencyKey: `${session.reference}:tutorial-capital`,
      description: "Endliches Tutorialkapital aus dem versionierten Minimaltemplate",
      postedAt: session.startedAt,
      entries: [
        { ledgerAccountId: cashAccountId, amountCents: template.tutorialCapitalCents },
        { ledgerAccountId: equityAccountId, amountCents: -template.tutorialCapitalCents },
      ],
    });
    return { cashAccountId, revenueAccountId, costAccountIds };
  }

  private async economy(session: TutorialSession, actors: Awaited<ReturnType<GameTutorialWorldFactory["systemActors"]>>): Promise<void> {
    const prepared = prepareTutorialEconomy({
      worldId: session.tutorialWorldId,
      tutorialAccountId: session.tutorialAccountId,
      comparisonAccountId: actors.comparisonAccountId,
      comparisonOperatorId: actors.comparisonOperatorId,
      reference: session.reference,
    });
    let current = await loadEconomyWorldState(this.db as never, session.tutorialWorldId);
    if (current === undefined) {
      try {
        await persistEconomyTransition(this.db as never, { expectedRevision: null, ...prepared.initial, committedAt: session.startedAt, enqueuedAt: this.wallClock() });
      } catch (error) {
        if (await loadEconomyWorldState(this.db as never, session.tutorialWorldId) === undefined) throw error;
      }
      current = await loadEconomyWorldState(this.db as never, session.tutorialWorldId);
    }
    if (current?.tenders.has("tutorial-tender")) {
      await this.drainEconomy(session);
      return;
    }
    if (current === undefined || current.revision !== prepared.initial.state.revision) throw new AlphaConflictError("Tutorialwirtschaft kann nicht deterministisch fortgesetzt werden.", "tutorial_economy_revision_conflict");
    try {
      await persistEconomyTransition(this.db as never, { expectedRevision: current.revision, state: prepared.state, effects: prepared.effects, committedAt: session.startedAt, enqueuedAt: this.wallClock() });
    } catch (error) {
      if (!(await loadEconomyWorldState(this.db as never, session.tutorialWorldId))?.tenders.has("tutorial-tender")) throw error;
    }
    await this.drainEconomy(session);
  }

  async provision(session: TutorialSession, template: TutorialTemplate): Promise<Readonly<Record<string, unknown>>> {
    const actors = await this.systemActors(session);
    const accountsForJournal = await this.ledger(session, template);
    // Entgeltliche Mietannahmen buchen beide EVU-Seiten. Das fiktive
    // Fahrzeugpool-EVU erhält deshalb bereits bei der Tutorialprovisionierung
    // sein explizites Cash-Konto; der Kooperationswriter erzeugt es bewusst
    // niemals während einer Spieleraktion.
    const lessorLedgerAccounts = await listLedgerAccounts(this.db as never, {
      worldId: session.tutorialWorldId,
      operatorId: actors.lessorOperatorId,
    });
    if (!lessorLedgerAccounts.some((account) => account.name === TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName)) {
      await openLedgerAccount(this.db as never, {
        worldId: session.tutorialWorldId,
        operatorId: actors.lessorOperatorId,
        name: TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName,
      });
    }
    const planningResults = template.paths.map((alternative, index) => this.planning.coordinate(tutorialPlanningCommand(session, template, alternative as Record<string, unknown>, index + 1)));
    const authorityRelease = fleetRelease(session, template, actors.lessorOperatorId, planningResults.map((result) => result.stateHash));
    await initializeFleetProducer({
      db: this.db as never,
      runtime: this.runtime,
      initialization: { schemaVersion: FLEET_INITIALIZE_SCHEMA, worldId: session.tutorialWorldId, producedAt: 0, authorityRelease },
      ingestedAt: session.startedAt,
    });
    for (const offer of template.leases) {
      await this.#cooperation.registerVehicle({
        worldId: session.tutorialWorldId,
        vehicleId: textValue(offer["vehicleId"], "Fahrzeug"),
        authorityReleaseId: authorityRelease.releaseId,
        classDesignation: textValue(offer["classDesignation"], "Baureihe"),
        actualConfiguration: { seats: offer["seats"], accessible: true, passengerInformation: true },
        ownerOperatorId: actors.lessorOperatorId,
        odometerMetres: 1_200_000n,
        conditionBasisPoints: integer(offer["conditionBasisPoints"], "Fahrzeugzustand"),
        damages: [],
        maintenanceDeadlines: [{ kind: "inspection", dueAtS: TUTORIAL_TIMELINE.leaseValidUntilS }],
        approvals: ["T 1", "pzb", "ac15kv"],
        operatingLimits: [],
        valuationSpecId: `${template.version}:vehicle-valuation`,
        valueCents: 14_000_000n,
        acquiredAtS: 0,
      });
    }
    const leaseContracts = [];
    for (const offer of template.leases) {
      const contract = await this.#cooperation.offerContract({
        worldId: session.tutorialWorldId,
        offerorOperatorId: actors.lessorOperatorId,
        offereeOperatorId: session.tutorialOperatorId,
        offeredByAccountId: actors.lessorAccountId,
        contractType: "vehicle-rental",
        subject: { vehicleIds: [offer["vehicleId"]], tutorialOfferId: offer["id"] },
        terms: { maintenanceIncluded: true, returnAtS: TUTORIAL_TIMELINE.leaseValidUntilS, templateVersion: template.version },
        priceCents: BigInt(textValue(offer["monthlyCostCents"], "Mietpreis")),
        ...TUTORIAL_LEASE_TIMES,
        idempotencyKey: `${session.reference}:${offer["id"]}`,
      });
      leaseContracts.push({ offerId: offer["id"], contractId: contract.id, vehicleId: offer["vehicleId"] });
    }
    await this.economy(session, actors);
    const [regionalState] = await this.db.select({ worldId: regionalSimulationStates.worldId }).from(regionalSimulationStates).where(and(
      eq(regionalSimulationStates.worldId, session.tutorialWorldId), eq(regionalSimulationStates.regionId, template.region.id),
    )).limit(1);
    const operationalInitialization = tutorialOperationalInitialization(session, template);
    const expectedInitializationHash = operationalSimulationInitializationHash(
      operationalInitialization,
    );
    if (regionalState === undefined) {
      await this.regional.initialize(
        operationalInitialization,
        session.startedAt,
      );
    } else if (!this.regional.isReady(
      session.tutorialWorldId,
      template.region.id,
      expectedInitializationHash,
    )) {
      await this.regional.restore(
        session.tutorialWorldId,
        template.region.id,
        expectedInitializationHash,
      );
    }
    return {
      lessorAccountId: actors.lessorAccountId,
      lessorOperatorId: actors.lessorOperatorId,
      comparisonAccountId: actors.comparisonAccountId,
      comparisonOperatorId: actors.comparisonOperatorId,
      leaseContracts,
      planning: planningResults.map((result, index) => ({ alternativeId: template.paths[index]!["id"], stateHash: result.stateHash, projectionRevision: result.projection.projectionRevision })),
      journalAccounts: accountsForJournal,
      dialogueTrigger: "session.started",
    };
  }

  private async submitTender(session: TutorialSession, action: Extract<TutorialAction, { type: "submit-bid" }>, template: TutorialTemplate): Promise<Record<string, unknown>> {
    if (!/^[1-9][0-9]{2,3}$/.test(action.orderingFeeCentsPerTrainKm)
      || BigInt(action.orderingFeeCentsPerTrainKm) < BigInt(TUTORIAL_BID_LIMITS.minimumOrderingFeeCentsPerTrainKm)
      || BigInt(action.orderingFeeCentsPerTrainKm) > BigInt(TUTORIAL_BID_LIMITS.maximumOrderingFeeCentsPerTrainKm)
      || action.punctualityBasisPoints < TUTORIAL_BID_LIMITS.minimumPunctualityBasisPoints
      || action.punctualityBasisPoints > TUTORIAL_BID_LIMITS.maximumPunctualityBasisPoints
      || action.extraSeats < TUTORIAL_BID_LIMITS.minimumExtraSeats
      || action.extraSeats > TUTORIAL_BID_LIMITS.maximumExtraSeats) {
      throw new AlphaValidationError("Angebot liegt ausserhalb des gefuehrten, auskoemmlichen Loesungsraums.");
    }
    const current = await loadEconomyWorldState(this.db as never, session.tutorialWorldId);
    if (current === undefined) throw new AlphaConflictError("Tutorialwirtschaft ist nicht bereit.", "tutorial_economy_unavailable");
    const lifecycle = current.tenders.get("tutorial-tender");
    const firstVehicleId = textValue(template.leases[0]?.["vehicleId"], "Tutorialfahrzeug");
    if (lifecycle?.phase === "awarded") {
      if (lifecycle.winningBid.operatorId !== session.tutorialOperatorId) throw new AlphaConflictError("Vergabe wurde nicht an das Tutorial-EVU erteilt.", "tutorial_bid_lost");
      const persistedAction = persistedTutorialBidAction(session, lifecycle.winningBid, firstVehicleId);
      requireSameTutorialAction(action, persistedAction);
      await this.drainEconomy(session);
      return { ...scenario(session), selectedBid: persistedAction, tenderAwardedAtS: TUTORIAL_TIMELINE.tenderClosesAtS };
    }
    let state = submitBid(current, `${session.reference}:player-bid`, "tutorial-tender", tutorialPlayerBid(session, action, firstVehicleId), {
      accountId: session.tutorialAccountId,
      period: 0,
      smallLot: true,
      minimumScore: 0,
    });
    const closed = closeTender(state, {
      commandId: `${session.reference}:close-tender`,
      tenderId: "tutorial-tender",
      at: TUTORIAL_TIMELINE.tenderClosesAtS,
      authorityId: "tutorial-authority",
      budgetPeriod: 0,
      vehiclePool: ["tutorial-public-reserve"],
      recipientByOperator: { [session.tutorialOperatorId]: session.tutorialAccountId },
    });
    const awarded = closed.state.tenders.get("tutorial-tender");
    if (awarded?.phase !== "awarded" || awarded.winningBid.operatorId !== session.tutorialOperatorId) {
      throw new AlphaValidationError("Das Angebot gewinnt den deterministischen Vergleich noch nicht.");
    }
    await persistEconomyTransition(this.db as never, { expectedRevision: current.revision, ...closed, committedAt: instant(session, TUTORIAL_TIMELINE.tenderClosesAtS), enqueuedAt: this.wallClock() });
    await this.drainEconomy(session);
    return { ...scenario(session), selectedBid: action, tenderAwardedAtS: TUTORIAL_TIMELINE.tenderClosesAtS };
  }

  private async acceptLease(session: TutorialSession, action: Extract<TutorialAction, { type: "accept-lease" }>, template: TutorialTemplate): Promise<Record<string, unknown>> {
    const state = scenario(session);
    const offers = Array.isArray(state["leaseContracts"]) ? state["leaseContracts"].map((entry) => object(entry, "Mietangebot")) : [];
    const selected = offers.find((entry) => entry["offerId"] === action.offerId);
    if (selected === undefined) throw new AlphaValidationError("Leasingangebot gehoert nicht zu dieser Tutorialsitzung.");
    const contractId = textValue(selected["contractId"], "Mietvertrag");
    const [contract] = await this.db.select().from(operatorContracts).where(and(eq(operatorContracts.worldId, session.tutorialWorldId), eq(operatorContracts.id, contractId))).limit(1);
    if (contract === undefined) throw new AlphaConflictError("Mietvertrag fehlt.", "tutorial_lease_missing");
    if (!(["accepted", "active"] as const).includes(contract.status as "accepted" | "active")) {
      await this.#cooperation.respondToContract({ worldId: session.tutorialWorldId, contractId, actingOperatorId: session.tutorialOperatorId, actingAccountId: session.tutorialAccountId, atS: TUTORIAL_TIMELINE.leaseResponseDeadlineS, response: "accept" });
    }
    const offer = lease(template, action.offerId);
    return { ...state, selectedLeaseOfferId: action.offerId, selectedLeaseContractId: contractId, selectedVehicleId: selected["vehicleId"], leasingCostCents: offer["monthlyCostCents"] };
  }

  private async confirmPath(session: TutorialSession, action: Extract<TutorialAction, { type: "confirm-path" }>, template: TutorialTemplate): Promise<Record<string, unknown>> {
    const selected = path(template, action.alternativeId);
    const state = scenario(session);
    const vehicleId = textValue(state["selectedVehicleId"], "Geleastes Fahrzeug");
    const pathReceiptId = textValue(selected["receiptId"], "Trassenbeleg");
    const apply = async (command: (head: NonNullable<Awaited<ReturnType<typeof loadFleetProducerCheckpoint>>>) => Parameters<typeof applyFleetProducerCommand>[0]["command"]) => {
      const head = await loadFleetProducerCheckpoint(this.db as never, session.tutorialWorldId);
      if (head === undefined) throw new AlphaConflictError("Fleet-Single-Writer ist nicht bereit.", "tutorial_fleet_unavailable");
      const next = command(head);
      await applyFleetProducerCommand({ db: this.db as never, runtime: this.runtime, command: next, ingestedAt: instant(session, next.atS) });
    };
    await apply((head) => ({
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
      worldId: session.tutorialWorldId,
      commandId: `${session.reference}:formation`,
      expectedStateHash: head.stateHash,
      expectedRevision: head.state.revision,
      atS: TUTORIAL_TIMELINE.formationAtS,
      formationId: "tutorial-formation",
      vehicleIds: [vehicleId],
      pathReceiptId,
      dynamics: { accelerationMmPerS2: 850, decelerationMmPerS2: 900 },
    }));
    await apply((head) => ({
      schemaVersion: FLEET_PATH_RESERVATION_COMMAND_SCHEMA,
      worldId: session.tutorialWorldId,
      commandId: `${session.reference}:path`,
      expectedStateHash: head.stateHash,
      expectedRevision: head.state.revision,
      atS: TUTORIAL_TIMELINE.pathReservationAtS,
      pathReservationId: "tutorial-path-reservation",
      pathReceiptId,
    }));
    await apply((head) => ({
      schemaVersion: FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA,
      worldId: session.tutorialWorldId,
      commandId: `${session.reference}:duty`,
      expectedStateHash: head.stateHash,
      expectedRevision: head.state.revision,
      atS: TUTORIAL_TIMELINE.personnelDutyAtS,
      personnelDutyId: "tutorial-duty",
      personnelPoolId: "tutorial-personnel-pool",
      formationIds: ["tutorial-formation"],
      pathReceiptId,
      validFrom: TUTORIAL_TIMELINE.operatingFromS,
      validUntil: TUTORIAL_TIMELINE.leaseValidUntilS,
    }));
    return { ...state, selectedPathAlternativeId: action.alternativeId, selectedPathReceiptId: pathReceiptId, pathCostCents: selected["costCents"] };
  }

  private changedProgram(session: TutorialSession, action: Extract<TutorialAction, { type: "activate-program" }>): OperatingProgram {
    if (action.thresholdSeconds < 60 || action.thresholdSeconds > 900) throw new AlphaValidationError("Regelschwelle muss zwischen 60 und 900 Sekunden liegen.");
    const templateIndex = action.templateId === "connections" ? 1 : action.templateId === "punctuality" ? 0 : -1;
    if (templateIndex < 0) throw new AlphaValidationError("Unbekannte Betriebsprogrammvorlage.");
    const base = operatingProgramTemplates(session.tutorialWorldId, session.tutorialOperatorId, 1)[templateIndex]!;
    const changedRule = action.changedRule === "hold-connections"
      ? { id: "player-connection-hold", priority: 900, enabled: true, trigger: { type: "connection_risk" as const }, condition: { type: "predicate" as const, fact: "connection_threatened" as const, comparison: "equal" as const, value: { type: "boolean" as const, value: true } }, action: "hold_connection" as const }
      : action.changedRule === "activate-reserve"
        ? { id: "player-reserve", priority: 900, enabled: true, trigger: { type: "vehicle_failure" as const }, condition: { type: "predicate" as const, fact: "vehicle_failed" as const, comparison: "equal" as const, value: { type: "boolean" as const, value: true } }, action: "activate_reserve_rotation" as const }
        : { id: "player-delay-threshold", priority: 900, enabled: true, trigger: { type: "delay_threshold" as const, at_least_seconds: action.thresholdSeconds }, condition: { type: "predicate" as const, fact: "delay_seconds" as const, comparison: "greater_or_equal" as const, value: { type: "integer" as const, value: action.thresholdSeconds } }, action: "break_connection" as const };
    return { ...base, rules: [changedRule, ...base.rules] };
  }

  private async activateProgram(session: TutorialSession, action: Extract<TutorialAction, { type: "activate-program" }>): Promise<Record<string, unknown>> {
    const stateValue = scenario(session);
    if (stateValue["selectedPathReceiptId"] === undefined) throw new AlphaConflictError("Bestaetigte Trasse fehlt.", "tutorial_path_missing");
    const canonical = canonicalizeProgram(this.changedProgram(session, action), { worldId: session.tutorialWorldId, operatorId: session.tutorialOperatorId });
    let economy = await loadEconomyWorldState(this.db as never, session.tutorialWorldId);
    if (economy === undefined) throw new AlphaConflictError("Tutorialwirtschaft fehlt.", "tutorial_economy_unavailable");
    if (!economy.contracts.has("tutorial-tender")) {
      const fleet = await loadFleetProducerCheckpoint(this.db as never, session.tutorialWorldId);
      if (fleet === undefined) throw new AlphaConflictError("Mobilisierungsnachweis fehlt.", "tutorial_fleet_unavailable");
      const proof = {
        source: "m5-release" as const,
        verifiedBy: "zugfolge-fleet-mobilization/v1" as const,
        fleetRevision: fleet.snapshot.revision,
        snapshotHash: fleet.snapshotHash,
        formationIds: fleet.snapshot.formations.filter((entry) => entry.operatorId === session.tutorialOperatorId).map((entry) => entry.id),
        personnelDutyIds: fleet.snapshot.personnelDuties.filter((entry) => entry.operatorId === session.tutorialOperatorId).map((entry) => entry.id),
        pathReservationIds: fleet.snapshot.pathReservations.filter((entry) => entry.operatorId === session.tutorialOperatorId).map((entry) => entry.id),
      };
      const initialized = this.runtime.initialize({
        schemaVersion: OPERATING_INITIALIZE_SCHEMA,
        worldId: session.tutorialWorldId,
        lots: [{ lotId: "tutorial-lot", incumbentOperatorId: "public", timetableBoundaryS: TUTORIAL_TIMELINE.operatingFromS, trainRuns: [{ trainRunId: "tutorial-run-1", formationId: "tutorial-formation" }] }],
      });
      const transition = this.runtime.applyTransition(initialized.state, {
        schemaVersion: OPERATING_TRANSITION_SCHEMA,
        worldId: session.tutorialWorldId,
        commandId: `${session.reference}:operating-transition`,
        expectedStateHash: initialized.stateHash,
        expectedRevision: initialized.state.revision,
        lotId: "tutorial-lot",
        atS: TUTORIAL_TIMELINE.operatingFromS,
        winnerOperatorId: session.tutorialOperatorId,
        mobilizationProof: proof,
        publicVehiclePool: ["tutorial-public-reserve"],
      });
      const mobilized = completeMobilization(economy, {
        commandId: `${session.reference}:mobilize`,
        tenderId: "tutorial-tender",
        at: TUTORIAL_TIMELINE.operatingFromS,
        proof,
        failurePenaltyCents: 100_000n,
        recipientAccountId: session.tutorialAccountId,
        publicVehiclePool: ["tutorial-public-reserve"],
        operatingTransition: transition,
      });
      await persistEconomyTransition(this.db as never, { expectedRevision: economy.revision, ...mobilized, committedAt: instant(session, TUTORIAL_TIMELINE.operatingFromS), enqueuedAt: this.wallClock() });
      await this.drainEconomy(session);
      economy = mobilized.state;
    }
    await this.db.transaction(async (tx) => {
      await tx.update(operatingProgramVersions).set({ status: "superseded" }).where(and(
        eq(operatingProgramVersions.worldId, session.tutorialWorldId), eq(operatingProgramVersions.operatorId, session.tutorialOperatorId), eq(operatingProgramVersions.status, "active"),
      ));
      await tx.insert(operatingProgramVersions).values({
        worldId: session.tutorialWorldId,
        operatorId: session.tutorialOperatorId,
        version: 1,
        schema: canonical.program.schema,
        enabled: canonical.program.enabled,
        canonicalProgram: canonical.program,
        checksum: canonical.checksum,
        status: "active",
        createdByAccountId: session.tutorialAccountId,
        createdAt: instant(session, TUTORIAL_TIMELINE.operatingFromS),
        activatedAt: instant(session, TUTORIAL_TIMELINE.operatingFromS),
      }).onConflictDoUpdate({
        target: [operatingProgramVersions.worldId, operatingProgramVersions.operatorId, operatingProgramVersions.version],
        set: {
          schema: canonical.program.schema,
          enabled: canonical.program.enabled,
          canonicalProgram: canonical.program,
          checksum: canonical.checksum,
          status: "active",
          activatedAt: instant(session, TUTORIAL_TIMELINE.operatingFromS),
        },
      });
    });
    return {
      ...stateValue,
      selectedProgramTemplateId: action.templateId,
      changedRule: action.changedRule,
      changedThresholdSeconds: action.thresholdSeconds,
      operatingProgramChecksum: canonical.checksum,
      programmeEffect: programmeEffect(action.changedRule),
    };
  }

  private dispatchCase(action: Extract<TutorialAction, { type: "dispatch" }>, costCents: number, penaltyCents: number, cancelledStops: number): OperatingDispatchCase {
    const limits = Object.fromEntries([
      "capacity_available", "train_characteristics_compatible", "route_knowledge_available", "train_protection_compatible", "electrification_compatible", "train_length_allowed", "vehicle_available", "maintenance_valid", "personnel_qualified", "rest_time_compliant", "rotation_feasible", "contract_allows", "cost_within_limit",
    ].map((key) => [key, true])) as OperatingDispatchCase["limits"];
    return {
      decision_id: 1,
      train_run_id: 1,
      event_at: TUTORIAL_TIMELINE.disruptionAtS,
      trigger: { type: "route_closure" },
      delay_seconds: 420,
      connection_threatened: true,
      vehicle_failed: false,
      duty_excess_seconds: 0,
      route_closed: true,
      platform_changed: false,
      turnaround_shortfall_seconds: 0,
      adhoc_conflict: false,
      hold_until: TUTORIAL_TIMELINE.disruptionHoldUntilS,
      limits,
      impact: {
        affected_train_runs: 1,
        affected_connections: 1,
        affected_rotations: 1,
        affected_personnel_pools: 1,
        affected_vehicles: 1,
        cost_cents: costCents,
        contract_penalty_cents: penaltyCents,
        cancelled_stops: cancelledStops,
        cause: "Weichenstoerung",
        affected_resource: "track:tut-segment-2",
        contract_effect: penaltyCents > 0 ? "Poenalerisiko" : "Qualitaetsziel gehalten",
      },
      manual_action: action.action,
      manual_reason: "Gefuehrte Tutorialentscheidung innerhalb gepruefter Betriebsgrenzen.",
    };
  }

  private async dispatch(session: TutorialSession, action: Extract<TutorialAction, { type: "dispatch" }>, template: TutorialTemplate): Promise<Record<string, unknown>> {
    const stateValue = scenario(session);
    const options = {
      short_turn: { cost: Number(template.result.disruptionShortTurnCostCents), penalty: 60_000, cancelledStops: 2, punctuality: 8_850 },
      request_reroute: { cost: Number(template.result.disruptionRerouteCostCents), penalty: 0, cancelledStops: 0, punctuality: 9_180 },
      trigger_rail_replacement: { cost: Number(template.result.disruptionReplacementCostCents), penalty: 20_000, cancelledStops: 1, punctuality: 9_000 },
    } as const;
    const decisionId = `${session.reference}:decision:1`;
    const persistedDecision = await loadPersistedTutorialDispatchDecision(this.db, session);
    if (persistedDecision !== undefined) {
      requireSameTutorialAction(action, { type: "dispatch", action: persistedDecision.action });
    }
    const authoritativeAction = persistedDecision?.action ?? action.action;
    const authoritativeRequest: TutorialDispatchAction = { type: "dispatch", action: authoritativeAction };
    const selected = options[authoritativeAction];
    let decisionSequence: number;
    if (persistedDecision !== undefined) {
      decisionSequence = persistedDecision.sequence;
    } else {
      const [program] = await this.db.select().from(operatingProgramVersions).where(and(
        eq(operatingProgramVersions.worldId, session.tutorialWorldId),
        eq(operatingProgramVersions.operatorId, session.tutorialOperatorId),
        eq(operatingProgramVersions.status, "active"),
      )).limit(1);
      if (program === undefined) throw new AlphaConflictError("Aktives Betriebsprogramm fehlt.", "tutorial_program_missing");
      await this.regional.apply({
        worldId: session.tutorialWorldId,
        regionId: template.region.id,
        commandId: `${session.reference}:advance-disruption`,
        command: { type: "advance-to", atMs: TUTORIAL_TIMELINE.disruptionAtS * 1_000 },
      }, instant(session, TUTORIAL_TIMELINE.disruptionAtS));
      await this.regional.apply({
        worldId: session.tutorialWorldId,
        regionId: template.region.id,
        commandId: `${session.reference}:disruption`,
        command: {
          type: "activate-disruption",
          disruptionId: textValue(template.disruption["id"], "Stoerungs-ID"),
          effect: {
            "resource-closed": {
              resourceId: textValue(template.disruption["resourceId"], "Konfliktressource"),
            },
          },
        },
      }, instant(session, TUTORIAL_TIMELINE.disruptionAtS));
      const explanation = this.runtime.evaluateDecision(program.canonicalProgram as Readonly<Record<string, unknown>>, this.dispatchCase(authoritativeRequest, selected.cost, selected.penalty, selected.cancelledStops));
      if (!explanation.manual_override || explanation.selected_action !== authoritativeAction) throw new AlphaConflictError("Rust-Dispatcher hat die gewaehlte Massnahme nicht autorisiert.", "tutorial_dispatch_rejected");
      decisionSequence = await appendEvent(this.db, session.tutorialWorldId, "dispatch.decision-applied", {
        decisionId,
        operatorId: session.tutorialOperatorId,
        trainRunId: "tutorial-run-1",
        action: explanation.selected_action,
        cause: "Weichenstoerung",
        causeCode: template.disruption["causeCode"],
        fineCauseId: template.disruption["fineCauseId"],
        affectedResource: template.disruption["resourceId"],
        programVersion: explanation.program_version,
        programChecksum: explanation.program_checksum,
        manualOverride: explanation.manual_override,
        outcomeReason: explanation.outcome_reason,
        conditions: explanation["conditions"],
        limits: explanation["limits"],
        rejectedAlternatives: explanation["rejected_alternatives"],
        impact: explanation.impact,
      }, instant(session, TUTORIAL_TIMELINE.disruptionAtS + 1));
    }
    let economy = await loadEconomyWorldState(this.db as never, session.tutorialWorldId);
    if (economy === undefined) throw new AlphaConflictError("Tutorialwirtschaft fehlt.", "tutorial_economy_unavailable");
    let orderingRevenueCents: bigint | undefined;
    let operatingCostCents: bigint | undefined;
    let periodResultCents: bigint | undefined;
    if (!economy.settledPeriods.has(`tutorial-tender:${TUTORIAL_SETTLEMENT_PERIOD}`)) {
      const settled = settleContractPeriod(economy, {
        commandId: `${session.reference}:settlement`,
        contractId: "tutorial-tender",
        period: TUTORIAL_SETTLEMENT_PERIOD,
        at: TUTORIAL_TIMELINE.settlementAtS,
        performance: {
          trainKm: 840n,
          punctualityBasisPoints: selected.punctuality,
          cancellations: selected.cancelledStops > 0 ? 1 : 0,
          missingSeats: 0,
          missedConnections: authoritativeAction === "short_turn" ? 1 : 0,
          evidence: [...TUTORIAL_CONTRACT_EVIDENCE, "tutorial-run-1", decisionId, String(decisionSequence)],
        },
        costs: [
          { amountCents: BigInt(textValue(stateValue["pathCostCents"], "Trassenkosten")), costType: "track", costCentreId: "tutorial-lot", reference: textValue(stateValue["selectedPathReceiptId"], "Trassenbeleg") },
          { amountCents: BigInt(selected.cost), costType: "energy", costCentreId: "tutorial-lot", reference: decisionId },
          { amountCents: template.result.baseOperatingCostCents, costType: "personnel", costCentreId: "tutorial-lot", reference: `tutorial-period-${TUTORIAL_SETTLEMENT_PERIOD}` },
        ],
      });
      await persistEconomyTransition(this.db as never, { expectedRevision: economy.revision, ...settled, committedAt: instant(session, TUTORIAL_TIMELINE.settlementAtS), enqueuedAt: this.wallClock() });
      economy = settled.state;
      orderingRevenueCents = settled.result.revenueCents;
      operatingCostCents = Object.values(settled.result.costsByType).reduce((total, amount) => total + amount, 0n);
      periodResultCents = settled.result.resultCents;
    }
    await this.drainEconomy(session);
    if (orderingRevenueCents === undefined || operatingCostCents === undefined || periodResultCents === undefined) {
      const journal = await this.settlementJournal(session);
      orderingRevenueCents = journal.revenueCents;
      operatingCostCents = journal.postings.reduce((total, posting) => total + posting.amountCents, 0n);
      periodResultCents = orderingRevenueCents - operatingCostCents;
    }
    return {
      ...stateValue,
      selectedDispatchAction: authoritativeAction,
      disruptionEventReference: `${session.reference}:disruption`,
      decisionEventSequence: decisionSequence,
      disruptionCostCents: String(selected.cost),
      disruptionPenaltyCents: String(selected.penalty),
      punctualityBasisPoints: selected.punctuality,
      cancellations: selected.cancelledStops > 0 ? 1 : 0,
      orderingRevenueCents: orderingRevenueCents.toString(),
      operatingCostCents: operatingCostCents.toString(),
      periodResultCents: periodResultCents.toString(),
      economyRevision: economy.revision,
    };
  }

  async applyAction(session: TutorialSession, action: TutorialAction, template: TutorialTemplate): Promise<Readonly<Record<string, unknown>>> {
    if (action.type === "submit-bid") return this.submitTender(session, action, template);
    if (action.type === "accept-lease") return this.acceptLease(session, action, template);
    if (action.type === "confirm-path") return this.confirmPath(session, action, template);
    if (action.type === "activate-program") return this.activateProgram(session, action);
    return this.dispatch(session, action, template);
  }

  async evidence(session: TutorialSession): Promise<TutorialScenarioEvidence> {
    const [economy, contracts, heldVehicles, fleet, programmes, events, ledger] = await Promise.all([
      loadEconomyWorldState(this.db as never, session.tutorialWorldId),
      this.db.select().from(operatorContracts).where(and(eq(operatorContracts.worldId, session.tutorialWorldId), eq(operatorContracts.offereeOperatorId, session.tutorialOperatorId))).orderBy(asc(operatorContracts.id)),
      this.db.select().from(vehicleAssets).where(and(eq(vehicleAssets.worldId, session.tutorialWorldId), eq(vehicleAssets.holderOperatorId, session.tutorialOperatorId))).orderBy(asc(vehicleAssets.vehicleId)),
      loadFleetProducerCheckpoint(this.db as never, session.tutorialWorldId),
      this.db.select().from(operatingProgramVersions).where(and(eq(operatingProgramVersions.worldId, session.tutorialWorldId), eq(operatingProgramVersions.operatorId, session.tutorialOperatorId), eq(operatingProgramVersions.status, "active"))).orderBy(asc(operatingProgramVersions.id)),
      this.db.select().from(domainEvents).where(and(eq(domainEvents.worldId, session.tutorialWorldId), inArray(domainEvents.eventType, ["disruption.applied", "dispatch.decision-applied"]))).orderBy(asc(domainEvents.sequence)),
      this.db.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(and(eq(ledgerTransactions.worldId, session.tutorialWorldId), eq(ledgerTransactions.operatorId, session.tutorialOperatorId), eq(ledgerTransactions.idempotencyKey, `${session.reference}:settlement:settlement`))).limit(1),
    ]);
    const tender = economy?.tenders.get("tutorial-tender");
    const rental = contracts.find((entry) => entry.contractType === "vehicle-rental" && ["accepted", "active", "completed"].includes(entry.status));
    const paths = fleet?.snapshot.pathReservations.filter((entry) => entry.operatorId === session.tutorialOperatorId && entry.status === "confirmed") ?? [];
    const serviceContract = economy?.contracts.get("tutorial-tender");
    const disruptions = events.filter((entry) => entry.eventType === "disruption.applied");
    const decisions = events.filter((entry) => entry.eventType === "dispatch.decision-applied" && object(entry.payload)["operatorId"] === session.tutorialOperatorId);
    return {
      chapters: [
        { completed: tender?.phase === "awarded" && tender.winningBid.operatorId === session.tutorialOperatorId, references: tender?.phase === "awarded" ? [tender.tender.id, tender.winningBid.id] : [] },
        { completed: rental !== undefined && heldVehicles.length > 0, references: [...(rental === undefined ? [] : [rental.id]), ...heldVehicles.map((entry) => entry.vehicleId)] },
        { completed: paths.length > 0, references: paths.map((entry) => entry.id) },
        { completed: programmes.length > 0 && serviceContract?.operatorId === session.tutorialOperatorId, references: [...programmes.map((entry) => entry.id), ...(serviceContract === undefined ? [] : [serviceContract.id])] },
        { completed: disruptions.length > 0 && decisions.length > 0 && ledger.length > 0, references: [...disruptions.map((entry) => `${entry.sequence}:${entry.eventType}`), ...decisions.map((entry) => `${entry.sequence}:${entry.eventType}`), ...ledger.map((entry) => entry.id)] },
      ],
    };
  }

  async presentation(session: TutorialSession, template: TutorialTemplate): Promise<TutorialScenarioPresentation> {
    const state = scenario(session);
    const economy = await loadEconomyWorldState(this.db as never, session.tutorialWorldId);
    const tender = economy?.tenders.get("tutorial-tender");
    const contracts = Array.isArray(state["leaseContracts"]) ? state["leaseContracts"].map((entry) => object(entry)) : [];
    const statuses = new Map((await this.db.select({ id: operatorContracts.id, status: operatorContracts.status }).from(operatorContracts).where(eq(operatorContracts.worldId, session.tutorialWorldId))).map((entry) => [entry.id, entry.status]));
    if (tender === undefined) throw new AlphaConflictError("Tutorialausschreibung ist nicht bereit.", "tutorial_tender_unavailable");
    return {
      schemaVersion: TUTORIAL_PRESENTATION_SCHEMA,
      tender: {
        id: tender.tender.id,
        priceWeightBasisPoints: tender.tender.profile.weights.price,
        qualityWeightBasisPoints: tender.tender.profile.weights.quality,
        penaltyFocus: tender.tender.profile.penaltyFocus,
        viabilityThresholdCentsPerTrainKm: tender.tender.viabilityThresholdCentsPerTrainKm.toString(),
        limits: TUTORIAL_BID_LIMITS,
      },
      leases: template.leases.map((offer) => {
        const contract = contracts.find((entry) => entry["offerId"] === offer["id"]);
        const contractId = typeof contract?.["contractId"] === "string" ? contract["contractId"] : undefined;
        return {
          id: textValue(offer["id"], "Leasingangebots-ID"),
          vehicleId: textValue(offer["vehicleId"], "Tutorialfahrzeug-ID"),
          classDesignation: textValue(offer["classDesignation"], "Baureihe"),
          monthlyCostCents: textValue(offer["monthlyCostCents"], "Leasingkosten"),
          seats: integer(offer["seats"], "Sitzplaetze"),
          conditionBasisPoints: integer(offer["conditionBasisPoints"], "Fahrzeugzustand"),
          reliabilityBasisPoints: integer(offer["reliabilityBasisPoints"], "Zuverlaessigkeit"),
          marginEffectCents: textValue(offer["marginEffectCents"], "Margenwirkung"),
          ...(contractId === undefined ? {} : { contractId }),
          status: contractId === undefined ? "offered" : statuses.get(contractId) ?? "offered",
        };
      }),
      paths: template.paths.map((alternative) => {
        const rawPlanning = Array.isArray(state["planning"])
          ? state["planning"].find((entry) => object(entry)["alternativeId"] === alternative["id"])
          : undefined;
        const planning = rawPlanning === undefined ? undefined : object(rawPlanning, "Plannergebnis");
        return {
          id: textValue(alternative["id"], "Trassenalternative"),
          receiptId: textValue(alternative["receiptId"], "Trassenbeleg"),
          label: textValue(alternative["label"], "Trassenbezeichnung"),
          desiredDepartureS: integer(alternative["desiredDepartureS"], "Abfahrtssekunde"),
          bufferSeconds: integer(alternative["bufferSeconds"], "Trassenpuffer"),
          costCents: textValue(alternative["costCents"], "Trassenkosten"),
          selected: state["selectedPathAlternativeId"] === alternative["id"],
          ...(planning === undefined ? {} : { planning: {
            stateHash: textValue(planning["stateHash"], "Planner-State-Hash"),
            projectionRevision: integer(planning["projectionRevision"], "Plannerrevision"),
          } }),
        };
      }),
      programmes: template.programmes.map((programme) => {
        const selected = state["selectedProgramTemplateId"] === programme["id"];
        const rawEffect = selected && state["programmeEffect"] !== undefined ? object(state["programmeEffect"], "Programmwirkung") : undefined;
        return {
          id: textValue(programme["id"], "Programmid"),
          label: textValue(programme["label"], "Programmbezeichnung"),
          baseThresholdSeconds: integer(programme["baseThresholdSeconds"], "Programmschwelle"),
          selected,
          ...(rawEffect === undefined ? {} : { effect: {
            costCents: textValue(rawEffect["costCents"], "Programmkosten"),
            qualityBasisPoints: integer(rawEffect["qualityBasisPoints"], "Qualitaetswirkung"),
            penaltyRiskBasisPoints: Number(rawEffect["penaltyRiskBasisPoints"]),
          } }),
        };
      }),
      programmeRuleEffects: (Object.keys(PROGRAMME_RULE_LABELS) as TutorialProgrammeRule[]).map((rule) => ({
        rule,
        label: PROGRAMME_RULE_LABELS[rule],
        effect: programmeEffect(rule),
      })),
      disruptionOptions: [
        { action: "short_turn", label: DISRUPTION_ACTION_LABELS.short_turn, costCents: template.result.disruptionShortTurnCostCents.toString(), punctualityBasisPoints: 8_850, cancellations: 1 },
        { action: "request_reroute", label: DISRUPTION_ACTION_LABELS.request_reroute, costCents: template.result.disruptionRerouteCostCents.toString(), punctualityBasisPoints: 9_180, cancellations: 0 },
        { action: "trigger_rail_replacement", label: DISRUPTION_ACTION_LABELS.trigger_rail_replacement, costCents: template.result.disruptionReplacementCostCents.toString(), punctualityBasisPoints: 9_000, cancellations: 1 },
      ],
    };
  }

  async summary(session: TutorialSession, template: TutorialTemplate): Promise<TutorialResultSummary> {
    const state = scenario(session);
    const bid = object(state["selectedBid"], "Gewähltes Tutorialangebot");
    const selectedLease = lease(template, textValue(state["selectedLeaseOfferId"], "Gewähltes Leasingangebot"));
    const selectedPath = path(template, textValue(state["selectedPathAlternativeId"], "Gewählte Trasse"));
    const selectedProgramme = programme(template, textValue(state["selectedProgramTemplateId"], "Gewähltes Betriebsprogramm"));
    const selectedRule = textValue(state["changedRule"], "Gewählte Betriebsregel") as TutorialProgrammeRule;
    if (!(selectedRule in PROGRAMME_RULE_LABELS)) throw new AlphaConflictError("Gewählte Betriebsregel ist unbekannt.", "tutorial_programme_rule_unknown");
    const selectedProgrammeEffect = object(state["programmeEffect"], "Berechnete Betriebsprogrammwirkung");
    const selectedDispatchAction = textValue(state["selectedDispatchAction"], "Gewählte Störungsreaktion") as Extract<TutorialAction, { readonly type: "dispatch" }>["action"];
    if (!(selectedDispatchAction in DISRUPTION_ACTION_LABELS)) throw new AlphaConflictError("Gewählte Störungsreaktion ist unbekannt.", "tutorial_dispatch_action_unknown");
    const leasingCost = BigInt(typeof state["leasingCostCents"] === "string" ? state["leasingCostCents"] : "0");
    const pathCost = BigInt(typeof state["pathCostCents"] === "string" ? state["pathCostCents"] : "0");
    const disruptionCost = BigInt(typeof state["disruptionCostCents"] === "string" ? state["disruptionCostCents"] : "0");
    const revenue = BigInt(typeof state["orderingRevenueCents"] === "string" ? state["orderingRevenueCents"] : template.result.orderingRevenueCents.toString());
    const operating = template.result.baseOperatingCostCents;
    const result = revenue - leasingCost - pathCost - operating - disruptionCost;
    const punctuality = typeof state["punctualityBasisPoints"] === "number" ? state["punctualityBasisPoints"] : 0;
    return {
      startLiquidityCents: template.tutorialCapitalCents.toString(),
      leasingCostCents: leasingCost.toString(),
      pathAndOperatingCostCents: (pathCost + operating).toString(),
      orderingRevenueCents: revenue.toString(),
      disruptionCostCents: disruptionCost.toString(),
      resultCents: result.toString(),
      punctualityBasisPoints: punctuality,
      qualityTargetsMet: punctuality >= template.result.punctualityTargetBasisPoints ? ["Pünktlichkeit", "Kapazität", "Barrierefreiheit"] : ["Kapazität", "Barrierefreiheit"],
      comparison: {
        bidOrderingFeeCentsPerTrainKm: textValue(bid["orderingFeeCentsPerTrainKm"], "Bestellerentgelt"),
        bidPunctualityBasisPoints: integer(bid["punctualityBasisPoints"], "Pünktlichkeitsversprechen"),
        bidExtraSeats: integer(bid["extraSeats"], "Zusätzliche Sitzplätze"),
        leaseLabel: textValue(selectedLease["classDesignation"], "Gewählte Baureihe"),
        leaseCostCents: textValue(selectedLease["monthlyCostCents"], "Leasingkosten"),
        leaseSeats: integer(selectedLease["seats"], "Sitzplätze"),
        leaseReliabilityBasisPoints: integer(selectedLease["reliabilityBasisPoints"], "Zuverlässigkeit"),
        pathLabel: textValue(selectedPath["label"], "Gewählte Trasse"),
        pathCostCents: textValue(selectedPath["costCents"], "Trassenkosten"),
        pathBufferSeconds: integer(selectedPath["bufferSeconds"], "Trassenpuffer"),
        programmeLabel: textValue(selectedProgramme["label"], "Gewähltes Betriebsprogramm"),
        programmeRuleLabel: PROGRAMME_RULE_LABELS[selectedRule]!,
        programmeThresholdSeconds: integer(state["changedThresholdSeconds"], "Regelschwelle"),
        programmeCostCents: textValue(selectedProgrammeEffect["costCents"], "Programmkosten"),
        programmeQualityBasisPoints: integer(selectedProgrammeEffect["qualityBasisPoints"], "Qualitätswirkung"),
        programmePenaltyRiskBasisPoints: signedInteger(selectedProgrammeEffect["penaltyRiskBasisPoints"], "Pönalerisikowirkung"),
        disruptionLabel: DISRUPTION_ACTION_LABELS[selectedDispatchAction]!,
        disruptionCostCents: disruptionCost.toString(),
        disruptionPunctualityBasisPoints: punctuality,
        disruptionCancellations: integer(state["cancellations"], "Ausfälle"),
      },
    };
  }

  async close(session: TutorialSession, reason: string): Promise<string> {
    // `TutorialSessionService` hat die Sitzung bereits dauerhaft auf `closing`
    // gesetzt. Zuerst sperrt ein optimistisch wiederholter Economy-Commit alle
    // weiteren Scheduler-Uebergaenge fachlich ab; erst danach wird die dadurch
    // endgueltige Outbox vollstaendig quittiert. So kann zwischen Drain und
    // Archivierung kein spaeter Scheduler-Commit mehr Effekte hinterlassen.
    const economy = await this.closeEconomyState(session);
    await this.drainEconomy(session);
    const economyHash = economy === undefined
      ? ""
      : alphaHash("zugfolge-economy-state/v1", encodeEconomyValue(economy));
    const [fleet, regional, programme] = await Promise.all([
      loadFleetProducerCheckpoint(this.db as never, session.tutorialWorldId),
      this.db.select({ stateHash: regionalSimulationStates.stateHash }).from(regionalSimulationStates).where(eq(regionalSimulationStates.worldId, session.tutorialWorldId)).orderBy(asc(regionalSimulationStates.regionId)),
      this.db.select({ checksum: operatingProgramVersions.checksum }).from(operatingProgramVersions).where(and(eq(operatingProgramVersions.worldId, session.tutorialWorldId), eq(operatingProgramVersions.operatorId, session.tutorialOperatorId))).orderBy(desc(operatingProgramVersions.version)).limit(1),
    ]);
    const finalStateHash = alphaHash("zugfolge-tutorial-final-state/v1", {
      worldId: session.tutorialWorldId,
      reference: session.reference,
      templateHash: session.templateHash,
      reason,
      economyHash,
      fleetStateHash: fleet?.stateHash ?? null,
      fleetSnapshotHash: fleet?.snapshotHash ?? null,
      regionalStateHashes: regional.map((entry) => entry.stateHash),
      programmeChecksum: programme[0]?.checksum ?? null,
      scenarioState: session.scenarioState,
    });
    this.regional.releaseWorld(session.tutorialWorldId);
    return finalStateHash;
  }
}
