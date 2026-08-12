import {
  AlphaConflictError,
  AlphaValidationError,
  TUTORIAL_TEMPLATE_HASH,
  alphaHash,
  type AlphaDatabase,
  type TutorialAction,
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
  dispatchEconomyEffects,
  encodeEconomyValue,
  initializeFleetProducer,
  listLedgerAccounts,
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
  type EconomyRelease,
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
  REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
  type FleetAuthorityRelease,
  type NativeRuntime,
  type OperatingDispatchCase,
} from "@zugfolge/runtime-native";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { GameFleetAssetTransferWriter } from "./fleet-market-writer.js";
import { RegionalSimulationWorker } from "./regional-simulation-worker.js";

const COST_TYPES: readonly CostType[] = ["track", "station", "facility", "energy", "personnel", "administration", "vehicle", "penalty", "interest"];

const ECONOMY_RELEASE: EconomyRelease = buildEconomyRelease({
  version: "tutorial-economy-2026.1",
  rates: {
    trackPerTrainKmCents: 90n,
    stationPerStopCents: 75n,
    facilityPerHourCents: 500n,
    energyPerKwhCents: 28n,
    personnelPerHourCents: 3_200n,
    administrationPerPeriodCents: 25_000n,
    vehiclePerPeriodCents: 210_000n,
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
    const [existing] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(and(
      eq(domainEvents.worldId, worldId),
      eq(domainEvents.eventType, eventType),
      sql`${domainEvents.payload} ->> 'decisionId' = ${String(payload["decisionId"] ?? "")}`,
    )).limit(1);
    if (existing !== undefined) return existing.sequence;
    const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
    const sequence = (head?.sequence ?? 0) + 1;
    await tx.insert(domainEvents).values({ worldId, sequence, eventType, payload, occurredAt });
    return sequence;
  });
}

function planningCommand(session: TutorialSession, template: TutorialTemplate, alternative: Record<string, unknown>, runIndex: number): PlanningCoordinateCommand {
  const stations = template.region.stations as unknown as PlanningCoordinateCommand["stations"];
  const segments = template.region.segments as unknown as PlanningCoordinateCommand["segments"];
  return {
    schemaVersion: PLANNING_COORDINATE_SCHEMA,
    worldId: session.tutorialWorldId,
    runId: `${session.reference}:${textValue(alternative["id"], "Trassen-ID")}`,
    expectedProjectionRevision: null,
    seedWorld: template.worldSeed.toString(),
    seedPeriod: runIndex,
    sourceId: `${template.version}:corridor`,
    corridorId: template.region.id,
    corridorName: template.region.name,
    stations,
    segments,
    requests: [{
      requestNumericId: runIndex,
      trainId: `${session.reference}:path-train-${runIndex}`,
      trainCategory: "regional",
      trainNumber: 7100 + runIndex,
      originStationId: "tut-kieselgrund",
      destinationStationId: "tut-fichtenhain",
      desiredDepartureS: integer(alternative["desiredDepartureS"], "Trassenabfahrt"),
      operatingDays: "daily",
      stops: [
        { stationId: "tut-muehlenbrueck", minimumDwellS: 30 },
        { stationId: "tut-wiesenrode", minimumDwellS: 30 },
      ],
      earlierS: 0,
      laterS: integer(alternative["bufferSeconds"], "Trassenpuffer"),
      stepS: 15,
      extraRunningTimeS: integer(alternative["bufferSeconds"], "Trassenpuffer"),
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
    }],
  };
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
    maintenanceDeadlines: [{ kind: "inspection", dueAt: 4_000 }],
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
    retiredAt: 4_000,
  }));
  const pathReceipts = template.paths.map((alternative, index) => ({
    id: textValue(alternative["receiptId"], "Trassenbeleg"),
    numericRouteId: index + 1,
    operatorId: session.tutorialOperatorId,
    serviceLineIds: ["T 1"],
    decision: "confirmed" as const,
    validFrom: 180,
    validUntil: 4_000,
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
    submittedAt: 30,
  };
}

function playerBid(session: TutorialSession, action: Extract<TutorialAction, { type: "submit-bid" }>, vehicleId: string): Bid {
  return {
    id: `${session.reference}:player-bid`,
    operatorId: session.tutorialOperatorId,
    orderingFeeCentsPerTrainKm: BigInt(action.orderingFeeCentsPerTrainKm),
    vehicle: {
      formationId: `${session.reference}:planned-formation`,
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
      evidence: { source: "zugfolge-fleet-mobilization/v1", fleetRevision: 0, snapshotHash: TUTORIAL_TEMPLATE_HASH, formationId: `${session.reference}:planned-formation:${vehicleId}` },
    },
    promises: { extraSeats: action.extraSeats, punctualityBasisPoints: action.punctualityBasisPoints, additionalStops: 0 },
    submittedAt: 60,
  };
}

export class GameTutorialWorldFactory implements TutorialWorldFactory {
  readonly #cooperation: CooperationService;

  constructor(
    private readonly db: AlphaDatabase,
    private readonly runtime: NativeRuntime,
    private readonly planning: PlanningRuntime,
    private readonly regional: RegionalSimulationWorker,
  ) {
    this.#cooperation = new CooperationService(db as never, undefined, new GameFleetAssetTransferWriter(runtime));
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
    const cashAccountId = await ensure("Bank");
    const equityAccountId = await ensure("Tutorialkapital");
    const revenueAccountId = await ensure("Bestellererloese");
    const costAccountIds = Object.fromEntries(await Promise.all(COST_TYPES.map(async (type) => [type, await ensure(`Kosten:${type}`)] as const))) as Record<CostType, string>;
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
    if (await loadEconomyWorldState(this.db as never, session.tutorialWorldId) !== undefined) return;
    let started = startEconomyWorld({
      worldId: session.tutorialWorldId,
      seed: 7_219_2026n,
      durationMonths: 6,
      release: ECONOMY_RELEASE,
      lots: [{ id: "tutorial-lot", size: 1, attractiveness: 1 }],
      authorityBudgets: [{ authorityId: "tutorial-authority", period: 0, availableCents: 50_000_000n, committedCents: 0n }],
      accounts: [session.tutorialAccountId, actors.comparisonAccountId],
      publicVehiclePoolByLot: { "tutorial-lot": ["tutorial-public-reserve"] },
    });
    const announced = announceTender(started.state, {
      commandId: `${session.reference}:announce`,
      release: ECONOMY_RELEASE,
      recipients: [session.tutorialAccountId],
      tender: {
        id: "tutorial-tender",
        worldId: session.tutorialWorldId,
        lotId: "tutorial-lot",
        incumbentOperatorId: "public",
        specification: SPECIFICATION,
        announcedAt: 10,
        opensAt: 20,
        closesAt: 120,
        operatingFrom: 180,
        contractPeriods: 1,
        periodDurationSeconds: 1_800,
        smallLot: true,
      },
    });
    let state = openTender(announced.state, `${session.reference}:open`, "tutorial-tender", 20);
    state = submitBid(state, `${session.reference}:comparison-bid`, "tutorial-tender", comparisonBid(actors.comparisonOperatorId), {
      accountId: actors.comparisonAccountId,
      period: 0,
      smallLot: true,
      minimumScore: 0,
    });
    started = { state, effects: { notices: [...started.effects.notices, ...announced.effects.notices], journal: [] } };
    try {
      await persistEconomyTransition(this.db as never, { expectedRevision: null, ...started, committedAt: session.startedAt });
    } catch (error) {
      if (await loadEconomyWorldState(this.db as never, session.tutorialWorldId) === undefined) throw error;
    }
  }

  async provision(session: TutorialSession, template: TutorialTemplate): Promise<Readonly<Record<string, unknown>>> {
    const actors = await this.systemActors(session);
    const accountsForJournal = await this.ledger(session, template);
    const planningResults = template.paths.map((alternative, index) => this.planning.coordinate(planningCommand(session, template, alternative as Record<string, unknown>, index + 1)));
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
        maintenanceDeadlines: [{ kind: "inspection", dueAtS: 4_000 }],
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
        terms: { maintenanceIncluded: true, returnAtS: 2_000, templateVersion: template.version },
        priceCents: BigInt(textValue(offer["monthlyCostCents"], "Mietpreis")),
        validFromS: 130,
        validUntilS: 2_000,
        responseDeadlineS: 170,
        terminationNoticeS: 300,
        offeredAtS: 40,
        idempotencyKey: `${session.reference}:${offer["id"]}`,
      });
      leaseContracts.push({ offerId: offer["id"], contractId: contract.id, vehicleId: offer["vehicleId"] });
    }
    await this.economy(session, actors);
    const [regionalState] = await this.db.select({ worldId: regionalSimulationStates.worldId }).from(regionalSimulationStates).where(and(
      eq(regionalSimulationStates.worldId, session.tutorialWorldId), eq(regionalSimulationStates.regionId, template.region.id),
    )).limit(1);
    if (regionalState === undefined) {
      await this.regional.initialize({
        schemaVersion: REGIONAL_SIMULATION_INITIALIZE_SCHEMA,
        worldId: session.tutorialWorldId,
        regionId: template.region.id,
        materializationWindowHours: 2,
        nowS: 0,
        trains: [{
          trainRunId: "tutorial-run-1",
          operator: session.tutorialOperatorId,
          trainNumber: "T 7101",
          category: "regional",
          route: [
            { operatingPoint: "TKG", positionMm: 0, arrivalS: 200, minimumDwellSeconds: 30, departureS: 230 },
            { operatingPoint: "TMB", positionMm: 9_000_000, arrivalS: 390, minimumDwellSeconds: 30, departureS: 420 },
            { operatingPoint: "TWR", positionMm: 18_000_000, arrivalS: 580, minimumDwellSeconds: 30, departureS: 610 },
            { operatingPoint: "TFH", positionMm: 28_000_000, arrivalS: 790, minimumDwellSeconds: 30, departureS: 820 },
          ],
        }],
      }, session.startedAt);
    } else if (!this.regional.isReady(session.tutorialWorldId, template.region.id)) {
      await this.regional.restore(session.tutorialWorldId, template.region.id);
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
    if (!/^[1-9][0-9]{2,3}$/.test(action.orderingFeeCentsPerTrainKm) || BigInt(action.orderingFeeCentsPerTrainKm) > 1_520n || action.punctualityBasisPoints < 8_800 || action.punctualityBasisPoints > 9_800 || action.extraSeats < 0 || action.extraSeats > 40) {
      throw new AlphaValidationError("Angebot liegt ausserhalb des gefuehrten, auskoemmlichen Loesungsraums.");
    }
    const current = await loadEconomyWorldState(this.db as never, session.tutorialWorldId);
    if (current === undefined) throw new AlphaConflictError("Tutorialwirtschaft ist nicht bereit.", "tutorial_economy_unavailable");
    const lifecycle = current.tenders.get("tutorial-tender");
    if (lifecycle?.phase === "awarded") {
      if (lifecycle.winningBid.operatorId !== session.tutorialOperatorId) throw new AlphaConflictError("Vergabe wurde nicht an das Tutorial-EVU erteilt.", "tutorial_bid_lost");
      return scenario(session);
    }
    const firstVehicleId = textValue(template.leases[0]?.["vehicleId"], "Tutorialfahrzeug");
    let state = submitBid(current, `${session.reference}:player-bid`, "tutorial-tender", playerBid(session, action, firstVehicleId), {
      accountId: session.tutorialAccountId,
      period: 0,
      smallLot: true,
      minimumScore: 0,
    });
    const closed = closeTender(state, {
      commandId: `${session.reference}:close-tender`,
      tenderId: "tutorial-tender",
      at: 120,
      authorityId: "tutorial-authority",
      budgetPeriod: 0,
      vehiclePool: ["tutorial-public-reserve"],
      recipientByOperator: { [session.tutorialOperatorId]: session.tutorialAccountId },
    });
    const awarded = closed.state.tenders.get("tutorial-tender");
    if (awarded?.phase !== "awarded" || awarded.winningBid.operatorId !== session.tutorialOperatorId) {
      throw new AlphaValidationError("Das Angebot gewinnt den deterministischen Vergleich noch nicht.");
    }
    await persistEconomyTransition(this.db as never, { expectedRevision: current.revision, ...closed, committedAt: instant(session, 120) });
    return { ...scenario(session), selectedBid: action, tenderAwardedAtS: 120 };
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
      await this.#cooperation.respondToContract({ worldId: session.tutorialWorldId, contractId, actingAccountId: session.tutorialAccountId, atS: 130, response: "accept" });
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
      await applyFleetProducerCommand({ db: this.db as never, runtime: this.runtime, command: command(head), ingestedAt: instant(session, head.state.revision + 150) });
    };
    await apply((head) => ({
      schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA,
      worldId: session.tutorialWorldId,
      commandId: `${session.reference}:formation`,
      expectedStateHash: head.stateHash,
      expectedRevision: head.state.revision,
      atS: 150,
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
      atS: 160,
      pathReservationId: "tutorial-path-reservation",
      pathReceiptId,
    }));
    await apply((head) => ({
      schemaVersion: FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA,
      worldId: session.tutorialWorldId,
      commandId: `${session.reference}:duty`,
      expectedStateHash: head.stateHash,
      expectedRevision: head.state.revision,
      atS: 170,
      personnelDutyId: "tutorial-duty",
      personnelPoolId: "tutorial-personnel-pool",
      formationIds: ["tutorial-formation"],
      pathReceiptId,
      validFrom: 180,
      validUntil: 2_000,
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
        lots: [{ lotId: "tutorial-lot", incumbentOperatorId: "public", timetableBoundaryS: 180, trainRuns: [{ trainRunId: "tutorial-run-1", formationId: "tutorial-formation" }] }],
      });
      const transition = this.runtime.applyTransition(initialized.state, {
        schemaVersion: OPERATING_TRANSITION_SCHEMA,
        worldId: session.tutorialWorldId,
        commandId: `${session.reference}:operating-transition`,
        expectedStateHash: initialized.stateHash,
        expectedRevision: initialized.state.revision,
        lotId: "tutorial-lot",
        atS: 180,
        winnerOperatorId: session.tutorialOperatorId,
        mobilizationProof: proof,
        publicVehiclePool: ["tutorial-public-reserve"],
      });
      const mobilized = completeMobilization(economy, {
        commandId: `${session.reference}:mobilize`,
        tenderId: "tutorial-tender",
        at: 180,
        proof,
        failurePenaltyCents: 100_000n,
        recipientAccountId: session.tutorialAccountId,
        publicVehiclePool: ["tutorial-public-reserve"],
        operatingTransition: transition,
      });
      await persistEconomyTransition(this.db as never, { expectedRevision: economy.revision, ...mobilized, committedAt: instant(session, 180) });
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
        createdAt: instant(session, 180),
        activatedAt: instant(session, 180),
      }).onConflictDoUpdate({
        target: [operatingProgramVersions.worldId, operatingProgramVersions.operatorId, operatingProgramVersions.version],
        set: {
          schema: canonical.program.schema,
          enabled: canonical.program.enabled,
          canonicalProgram: canonical.program,
          checksum: canonical.checksum,
          status: "active",
          activatedAt: instant(session, 180),
        },
      });
    });
    return {
      ...stateValue,
      selectedProgramTemplateId: action.templateId,
      changedRule: action.changedRule,
      changedThresholdSeconds: action.thresholdSeconds,
      operatingProgramChecksum: canonical.checksum,
      programmeEffect: action.changedRule === "prioritize-punctuality"
        ? { costCents: "25000", qualityBasisPoints: 250, penaltyRiskBasisPoints: -300 }
        : { costCents: "55000", qualityBasisPoints: 400, penaltyRiskBasisPoints: -450 },
    };
  }

  private dispatchCase(action: Extract<TutorialAction, { type: "dispatch" }>, costCents: number, penaltyCents: number, cancelledStops: number): OperatingDispatchCase {
    const limits = Object.fromEntries([
      "capacity_available", "train_characteristics_compatible", "route_knowledge_available", "train_protection_compatible", "electrification_compatible", "train_length_allowed", "vehicle_available", "maintenance_valid", "personnel_qualified", "rest_time_compliant", "rotation_feasible", "contract_allows", "cost_within_limit",
    ].map((key) => [key, true])) as OperatingDispatchCase["limits"];
    return {
      decision_id: 1,
      train_run_id: 1,
      event_at: 420,
      trigger: { type: "route_closure" },
      delay_seconds: 420,
      connection_threatened: true,
      vehicle_failed: false,
      duty_excess_seconds: 0,
      route_closed: true,
      platform_changed: false,
      turnaround_shortfall_seconds: 0,
      adhoc_conflict: false,
      hold_until: 600,
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
    const selected = options[action.action];
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
      command: { type: "advance-to", atS: 420 },
    }, instant(session, 420));
    await this.regional.apply({
      worldId: session.tutorialWorldId,
      regionId: template.region.id,
      commandId: `${session.reference}:disruption`,
      command: {
        type: "register-disruption",
        disruption: {
          disruptionId: textValue(template.disruption["id"], "Stoerungs-ID"),
          kind: "unplanned",
          publishedAtS: 420,
          startsAtS: 420,
          validUntilS: integer(template.disruption["validUntilS"], "Stoerungsende"),
          positionMm: 12_000_000,
          causeCode: integer(template.disruption["causeCode"], "Ursachencode"),
          fineCauseId: textValue(template.disruption["fineCauseId"], "Feinursache"),
          effect: "closure",
          affectedResource: textValue(template.disruption["resourceId"], "Konfliktressource"),
          affectedTrainRunIds: [textValue(template.disruption["trainRunId"], "Zuglauf")],
          delaySeconds: integer(template.disruption["delaySeconds"], "Stoerungsverspaetung"),
        },
      },
    }, instant(session, 420));
    const explanation = this.runtime.evaluateDecision(program.canonicalProgram as Readonly<Record<string, unknown>>, this.dispatchCase(action, selected.cost, selected.penalty, selected.cancelledStops));
    if (!explanation.manual_override || explanation.selected_action !== action.action) throw new AlphaConflictError("Rust-Dispatcher hat die gewaehlte Massnahme nicht autorisiert.", "tutorial_dispatch_rejected");
    const decisionId = `${session.reference}:decision:1`;
    const decisionSequence = await appendEvent(this.db, session.tutorialWorldId, "dispatch.decision-applied", {
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
    }, instant(session, 421));
    let economy = await loadEconomyWorldState(this.db as never, session.tutorialWorldId);
    if (economy === undefined) throw new AlphaConflictError("Tutorialwirtschaft fehlt.", "tutorial_economy_unavailable");
    if (!economy.settledPeriods.has("tutorial-tender:1")) {
      const settled = settleContractPeriod(economy, {
        commandId: `${session.reference}:settlement`,
        contractId: "tutorial-tender",
        period: 1,
        at: 430,
        performance: {
          trainKm: 840n,
          punctualityBasisPoints: selected.punctuality,
          cancellations: selected.cancelledStops > 0 ? 1 : 0,
          missingSeats: 0,
          missedConnections: action.action === "short_turn" ? 1 : 0,
          evidence: ["tutorial-run-1", decisionId, String(decisionSequence)],
        },
        costs: [
          { amountCents: BigInt(textValue(stateValue["pathCostCents"], "Trassenkosten")), costType: "track", costCentreId: "tutorial-lot", reference: textValue(stateValue["selectedPathReceiptId"], "Trassenbeleg") },
          { amountCents: BigInt(selected.cost), costType: "energy", costCentreId: "tutorial-lot", reference: decisionId },
          { amountCents: template.result.baseOperatingCostCents, costType: "personnel", costCentreId: "tutorial-lot", reference: "tutorial-period-1" },
        ],
      });
      await persistEconomyTransition(this.db as never, { expectedRevision: economy.revision, ...settled, committedAt: instant(session, 430) });
      const journal = object(stateValue["journalAccounts"], "Tutorialkontierung") as unknown as JournalAccounts;
      await dispatchEconomyEffects(settled.effects, createEconomyPlatformAdapters({ db: this.db as never, accountsByOperator: { [session.tutorialOperatorId]: journal } }));
      economy = settled.state;
      return {
        ...stateValue,
        selectedDispatchAction: action.action,
        disruptionEventReference: `${session.reference}:disruption`,
        decisionEventSequence: decisionSequence,
        disruptionCostCents: String(selected.cost),
        disruptionPenaltyCents: String(selected.penalty),
        punctualityBasisPoints: selected.punctuality,
        cancellations: selected.cancelledStops > 0 ? 1 : 0,
        orderingRevenueCents: settled.result.revenueCents.toString(),
        operatingCostCents: Object.values(settled.result.costsByType).reduce((total, amount) => total + amount, 0n).toString(),
        periodResultCents: settled.result.resultCents.toString(),
        economyRevision: economy.revision,
      };
    }
    return stateValue;
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
    return {
      tender: {
        ...template.tender,
        phase: tender?.phase ?? "open",
        profile: tender?.tender.profile,
        viabilityThresholdCentsPerTrainKm: tender?.tender.viabilityThresholdCentsPerTrainKm.toString() ?? template.tender["viabilityThresholdCentsPerTrainKm"],
        expectedMarginCents: "180000",
        ownScoreBasisPoints: state["selectedBid"] === undefined ? 0 : 7_800,
      },
      leases: template.leases.map((offer) => {
        const contract = contracts.find((entry) => entry["offerId"] === offer["id"]);
        return { ...offer, contractId: contract?.["contractId"], status: typeof contract?.["contractId"] === "string" ? statuses.get(contract["contractId"] as string) : "offered" };
      }),
      paths: template.paths.map((alternative) => ({ ...alternative, planning: Array.isArray(state["planning"]) ? state["planning"].find((entry) => object(entry)["alternativeId"] === alternative["id"]) : undefined, selected: state["selectedPathAlternativeId"] === alternative["id"] })),
      programmes: template.programmes.map((programme) => ({ ...programme, selected: state["selectedProgramTemplateId"] === programme["id"], effect: state["programmeEffect"] })),
      disruptionOptions: [
        { action: "short_turn", label: "Vorzeitig wenden", costCents: template.result.disruptionShortTurnCostCents.toString(), punctualityBasisPoints: 8_850, cancellations: 1 },
        { action: "request_reroute", label: "Umleitung anfordern", costCents: template.result.disruptionRerouteCostCents.toString(), punctualityBasisPoints: 9_180, cancellations: 0 },
        { action: "trigger_rail_replacement", label: "Ersatzverkehr ausloesen", costCents: template.result.disruptionReplacementCostCents.toString(), punctualityBasisPoints: 9_000, cancellations: 1 },
      ],
    };
  }

  async summary(session: TutorialSession, template: TutorialTemplate): Promise<TutorialResultSummary> {
    const state = scenario(session);
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
      qualityTargetsMet: punctuality >= template.result.punctualityTargetBasisPoints ? ["Puenktlichkeit", "Kapazitaet", "Barrierefreiheit"] : ["Kapazitaet", "Barrierefreiheit"],
      comparison: { selectedAction: typeof state["selectedDispatchAction"] === "string" ? state["selectedDispatchAction"] : "offen", robustAlternativePunctualityBasisPoints: 9_180, shortTurnAlternativeCostCents: template.result.disruptionShortTurnCostCents.toString() },
    };
  }

  async close(session: TutorialSession, reason: string): Promise<string> {
    const economy = await loadEconomyWorldState(this.db as never, session.tutorialWorldId);
    let economyHash = "";
    if (economy !== undefined) {
      const closed = closeEconomyWorld(economy, `${session.reference}:close-world`);
      if (closed !== economy) {
        await persistEconomyTransition(this.db as never, { expectedRevision: economy.revision, state: closed, effects: { notices: [], journal: [] }, committedAt: instant(session, 900) });
        economyHash = alphaHash("zugfolge-economy-state/v1", encodeEconomyValue(closed));
      } else economyHash = alphaHash("zugfolge-economy-state/v1", encodeEconomyValue(economy));
    }
    const [fleet, regional, programme] = await Promise.all([
      loadFleetProducerCheckpoint(this.db as never, session.tutorialWorldId),
      this.db.select({ stateHash: regionalSimulationStates.stateHash }).from(regionalSimulationStates).where(eq(regionalSimulationStates.worldId, session.tutorialWorldId)).orderBy(asc(regionalSimulationStates.regionId)),
      this.db.select({ checksum: operatingProgramVersions.checksum }).from(operatingProgramVersions).where(and(eq(operatingProgramVersions.worldId, session.tutorialWorldId), eq(operatingProgramVersions.operatorId, session.tutorialOperatorId))).orderBy(desc(operatingProgramVersions.version)).limit(1),
    ]);
    return alphaHash("zugfolge-tutorial-final-state/v1", {
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
  }
}
