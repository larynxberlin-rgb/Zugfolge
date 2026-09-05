import { readFile } from "node:fs/promises";
import { createPublicKey, verify as verifySignature } from "node:crypto";

import {
  AlphaWorldService,
  alphaHash,
  validateWorldBlueprint,
  type AlphaDatabase,
  type AlphaWorldBlueprint,
  type WorldStartPort,
  type WorldStartVerification,
} from "@zugfolge/alpha";
import { enqueueAuthoritativeWorldStartProjection } from "@zugfolge/commerce";
import {
  alphaWorldDeployments,
  alphaWorldProfiles,
  domainEvents,
  odooProjectionOutbox,
  regionalSimulationStates,
  worlds,
} from "@zugfolge/db";
import type { OperationsDecision, OperationsRegistry } from "@zugfolge/dispatch";
import {
  buildEconomyRelease,
  decodeEconomyValue,
  encodeEconomyValue,
  initializeFleetProducer,
  loadEconomyWorldState,
  loadFleetProducerCheckpoint,
  lotsFromGtfsPlanning,
  persistEconomyTransition,
  startEconomyWorld,
  type AuthorityBudget,
  type EconomyRelease,
  type Lot,
  type GtfsPlanningEnvelope,
  type TenderGenerationPolicy,
  type EconomyWorldState,
} from "@zugfolge/economy";
import {
  verifiedBaseTrainRunId,
  type LivemapRegistry,
  type LiveSnapshot,
  type PublicExternalTrain,
} from "@zugfolge/livemap-stream";
import {
  parsePlanningInfrastructureRelease,
  type PlanningInfrastructureRelease,
} from "@zugfolge/planning-worker";
import {
  FLEET_AUTHORITY_RELEASE_SCHEMA_V2,
  OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA,
  OPERATIONAL_INFRASTRUCTURE_FILE,
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  operationalMovementContinuationsEvidence,
  operationalProtectionModeSelectionEvidence,
  type OperationalSimulationInitialization,
  type FleetRuntime,
  type FleetWorldInitialization,
} from "@zugfolge/runtime-native";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { projectLivemapOperationEvent } from "./livemap-operation-projection.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";
import { canonicalEd25519SpkiPublicKeyPem } from "./trusted-release-keys.js";
import {
  type VehicleCatalogDeploymentBindingV2,
  validateVehicleCatalogDeploymentBinding,
} from "./vehicle-catalog-deployment-binding.js";
import type { RegionalSimulationWorker } from "./regional-simulation-worker.js";

export const ALPHA_WORLD_DEPLOYMENT_SCHEMA = "zugfolge-alpha-world-deployment/v2" as const;
export const ACTIVE_WORLD_DEPLOYMENT_CUTOVER_ERROR_CODE =
  "active_world_requires_operational_v2_cutover" as const;

interface RegionalSimulationBootstrapWorker {
  initialize(
    initialization: OperationalSimulationInitialization,
    persistedAt: Date,
  ): Promise<unknown>;
  restore(
    worldId: string,
    regionId: string,
    expectedInitializationHash: string,
  ): Promise<unknown>;
}

export async function initializeOrRestoreRegionalSimulation(
  worker: RegionalSimulationBootstrapWorker,
  initialization: OperationalSimulationInitialization,
  persistedInitializationHash: string | null | undefined,
  persistedAt: Date,
): Promise<"initialized" | "restored"> {
  const expectedInitializationHash = operationalSimulationInitializationHash(initialization);
  if (persistedInitializationHash === undefined) {
    await worker.initialize(initialization, persistedAt);
    return "initialized";
  }
  if (persistedInitializationHash !== expectedInitializationHash) {
    throw new Error(
      `Persistierter operativer Zustand '${initialization.worldId}/${initialization.regionId}' gehoert nicht zum signierten Deployment.`,
    );
  }
  await worker.restore(
    initialization.worldId,
    initialization.regionId,
    expectedInitializationHash,
  );
  return "restored";
}

/**
 * Stabiler, maschinenlesbarer letzter Schutz am Serverstart, falls das
 * Vor-Migrations-Preflight umgangen wurde. V1 wird damit nie in der V2-
 * Runtime interpretiert oder ueber eine Kompatibilitaetsschicht geladen.
 */
export class ActiveWorldDeploymentCutoverError extends Error {
  readonly code = ACTIVE_WORLD_DEPLOYMENT_CUTOVER_ERROR_CODE;

  constructor(readonly worldId: string, cause?: unknown) {
    super(
      `[${ACTIVE_WORLD_DEPLOYMENT_CUTOVER_ERROR_CODE}] Aktive Welt '${worldId}' muss vor dem Operational-v2-Start archiviert und durch eine neue V2-Welt ersetzt werden.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ActiveWorldDeploymentCutoverError";
  }
}

export interface AlphaDeploymentWorldDefinition {
  readonly name: string;
  readonly kind: "public" | "private" | "test";
  readonly rankingStatus: "ranked" | "unranked";
  readonly schedulePeriodWeeks: number;
  readonly epoch: string;
}

interface SerializedEconomyRelease extends Omit<EconomyRelease, "rates" | "rules" | "checksum"> {
  readonly rates: EconomyRelease["rates"];
  readonly rules: EconomyRelease["rules"];
}

export interface AlphaPlanningAuthority {
  readonly accountId: string;
  readonly keycloakSubject: string;
  readonly displayName: string;
}

export interface AlphaWorldDeployment {
  readonly schema: typeof ALPHA_WORLD_DEPLOYMENT_SCHEMA;
  readonly worldId: string;
  /**
   * Monotone, signierte Generation dieses Welt-Deployments. Alte v1-Artefakte
   * ohne das Feld sind ausschliesslich als Generation 1 lesbar; jeder neue
   * Build muss die Generation explizit binden.
   */
  readonly deploymentRevision?: number;
  /** Vom Deployment-Hash und der Ed25519-Signatur gebundene Weltparameter. */
  readonly worldDefinition: AlphaDeploymentWorldDefinition;
  readonly infraReleaseHash: string;
  readonly blueprint: AlphaWorldBlueprint;
  readonly economy: {
    readonly durationMonths: 6 | 12 | 18 | "unlimited";
    readonly release: SerializedEconomyRelease;
    readonly lots: readonly Lot[];
    /** Bei historischen Deployments lesbar; fuer jeden neuen Weltstart Pflicht. */
    readonly planning?: GtfsPlanningEnvelope;
    readonly tenderGeneration?: TenderGenerationPolicy;
    readonly authorityBudgets: readonly AuthorityBudget[];
    readonly accounts: readonly string[];
    readonly publicVehiclePoolByLot: Readonly<Record<string, readonly string[]>>;
  };
  readonly fleet: FleetWorldInitialization;
  /** Pflichtbeweis fuer neue Authority-v2-Kataloge; Legacy-v1 besitzt ihn nicht. */
  readonly vehicleCatalogBinding?: VehicleCatalogDeploymentBindingV2;
  readonly regionalSimulation: OperationalSimulationInitialization;
  readonly repeatEveryS: number;
  /**
   * Kein Prozess- oder Env-Geheimnis: Konto und Release sind Bestandteil des
   * signierten, gehashten Weltvertrags und werden nur fuer aktive Welten
   * materialisiert.
   */
  readonly planning: {
    readonly authority: AlphaPlanningAuthority;
    readonly infrastructureRelease: PlanningInfrastructureRelease;
  };
  readonly provenance: {
    readonly infraReleaseId: string;
    /** Nur fuer eingebettete Legacy-Infrastruktur; kompakte v2 nutzt den Zustandsbeleg. */
    readonly operationalNetworkHash?: string;
    /** Byte- und Zustandshash der extern gehaltenen Operational-v2-Datei. */
    readonly operationalInfrastructureSha256?: string;
    readonly operationalInfrastructureStateHash?: string;
    readonly gtfsSnapshotHash: string;
    readonly fleetSourceSha256: string;
    readonly operationalSimulationSourceSha256: string;
    readonly generationScriptSha256: string;
  };
}

export interface SignedAlphaWorldDeployment {
  readonly deployment: AlphaWorldDeployment;
  readonly deploymentHash: string;
  readonly signature: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly valueBase64: string;
  };
}

/** Alte signierte Welten bleiben lesbar; neue Starts duerfen nicht ohne Ausschreibungen entstehen. */
export function validateAlphaEconomyPlanningBinding(deployment: Pick<AlphaWorldDeployment, "worldId" | "economy" | "blueprint" | "provenance">, required = false): void {
  const { planning, tenderGeneration } = deployment.economy;
  if (planning === undefined && tenderGeneration === undefined && !required) return;
  if (planning === undefined || tenderGeneration === undefined) {
    throw new Error("Neuer Weltstart braucht eine signierte Spielplanung und Ausschreibungsgenerierung. Historisches Deployment mit dem Spiel-Fahrplan neu bauen und signieren.");
  }
  const lots = lotsFromGtfsPlanning(planning, deployment.worldId);
  if (
    planning.snapshot.infrastructureVersion !== deployment.provenance.infraReleaseId
    || planning.snapshot.sourceTimetableHash !== deployment.provenance.gtfsSnapshotHash
    || planning.snapshot.sourceTimetableHash !== deployment.blueprint.releases.timetable
    || alphaHash("zugfolge-alpha-planning-lots/v1", lots) !== alphaHash("zugfolge-alpha-planning-lots/v1", deployment.economy.lots)
    || lots.map((lot) => lot.id).sort().join("\u0000") !== deployment.blueprint.lots.map((lot) => lot.lotId).sort().join("\u0000")
  ) throw new Error("Spielplanung verletzt die signierte Welt-, Infrastruktur-, Fahrplan- oder Losbindung.");
}

export function validateAlphaOperationalPlanningBinding(deployment: AlphaWorldDeployment): void {
  const planning = deployment.economy.planning;
  if (planning === undefined) return;
  const generation = planning.snapshot.timetableGeneration;
  const plannedTrainIds = planning.snapshot.patterns.flatMap((pattern) => pattern.journeys.map((journey) => journey.id));
  const passengerTrains = deployment.regionalSimulation.trains.filter((train) => train.publicPassengerStop);
  const initialization = deployment.regionalSimulation as unknown as Record<string, unknown>;
  if (
    generation?.specification.schemaVersion !== "zugfolge-game-timetable-generation/v1"
    || generation.specification.requireEligibleTerminals !== true
    || generation.seed !== deployment.blueprint.seed.toString()
    || plannedTrainIds.some((id) => typeof id !== "string" || !id.startsWith("game-trip-"))
    || new Set(plannedTrainIds).size !== plannedTrainIds.length
    || plannedTrainIds.sort().join("\u0000") !== passengerTrains.map((train) => train.id).sort().join("\u0000")
    || (Array.isArray(initialization["externalTrains"]) && initialization["externalTrains"].length > 0)
  ) throw new Error("Neuer Weltstart braucht ausschliesslich generierte Binnenfahrten mit identischer operativer Fahrplanbindung.");
  if (deployment.repeatEveryS !== 86_400) throw new Error("Spielplanung braucht eine taegliche operative Wiederholung.");
  const patternById = new Map(planning.snapshot.patterns.map((pattern) => [pattern.id, pattern]));
  const blueprintLotById = new Map(deployment.blueprint.lots.map((lot) => [lot.lotId, lot]));
  const nativeById = new Map(passengerTrains.map((train) => [train.id, train]));
  const serviceDay = new Date(deployment.worldDefinition.epoch).toISOString().slice(0, 10);
  for (const lot of planning.snapshot.lots) {
    const journeys = lot.patternIds.flatMap((patternId) => patternById.get(patternId)?.journeys ?? []);
    const expectedIds = journeys.map((journey) => journey.id!).sort();
    const assignedIds = [...(blueprintLotById.get(lot.id)?.trainRunIds ?? [])].sort();
    if (expectedIds.join("\u0000") !== assignedIds.join("\u0000")) {
      throw new Error("Spielplanung und Weltentwurf ordnen einem Los unterschiedliche Fahrten zu.");
    }
    for (const journey of journeys) {
      const native = nativeById.get(journey.id!);
      const outcome = native?.serviceOutcome;
      const departureS = journey.departureServiceSeconds;
      const arrivalS = journey.arrivalServiceSeconds;
      const departureMs = departureS % deployment.repeatEveryS * 1_000;
      const arrivalMs = departureMs + (arrivalS - departureS) * 1_000;
      if (
        outcome === undefined
        || !Number.isSafeInteger(departureS) || departureS < 0
        || !Number.isSafeInteger(arrivalS) || arrivalS <= departureS
        || !Number.isSafeInteger(departureMs) || !Number.isSafeInteger(arrivalMs)
        || native?.scheduledDepartureMs !== departureMs
        || outcome.serviceId !== journey.id
        || outcome.lotId !== lot.id
        || outcome.scheduledArrivalMs !== arrivalMs
        || outcome.serviceDay !== serviceDay
        || outcome.serviceRunId !== `${journey.id}:service-day:${serviceDay}`
      ) throw new Error("Spielplanung und Betriebsfahrplan besitzen unterschiedliche Los-, Abfahrts- oder Ankunftsbindungen.");
    }
  }
}

export function startAlphaDeploymentEconomy(deployment: AlphaWorldDeployment): ReturnType<typeof startEconomyWorld> {
  validateAlphaEconomyPlanningBinding(deployment, true);
  validateAlphaOperationalPlanningBinding(deployment);
  const release = buildEconomyRelease({
    version: deployment.economy.release.version,
    rates: deployment.economy.release.rates,
    rules: deployment.economy.release.rules,
    tenderProfiles: deployment.economy.release.tenderProfiles,
  });
  if (release.checksum !== deployment.blueprint.releases.economy) throw new Error("EconomyRelease stimmt nicht mit dem Weltentwurf ueberein.");
  const { lots: _lots, ...economy } = deployment.economy;
  const started = startEconomyWorld({
    worldId: deployment.worldId,
    seed: deployment.blueprint.seed,
    ...economy,
    release,
  });
  if (alphaHash("zugfolge-alpha-tender-calendar/v1", started.state.calendar) !== deployment.blueprint.tenderCalendarHash) {
    throw new Error("Vergabekalender stimmt nicht mit dem Weltentwurf ueberein.");
  }
  if (![...started.state.tenders.values()].some((tender) => tender.phase === "open")) {
    throw new Error("Neuer Weltstart hat keine offene Startausschreibung erzeugt.");
  }
  return started;
}

export function validatePersistedAlphaEconomyPlanning(
  deployment: Pick<AlphaWorldDeployment, "economy">,
  state: Pick<EconomyWorldState, "planning" | "tenderGeneration">,
): void {
  if (deployment.economy.planning !== undefined && (
    state.planning?.snapshotHash !== deployment.economy.planning.snapshotHash
    || alphaHash("zugfolge-alpha-tender-generation-binding/v1", state.tenderGeneration ?? null)
      !== alphaHash("zugfolge-alpha-tender-generation-binding/v1", deployment.economy.tenderGeneration ?? null)
  )) throw new Error("Bestehende Wirtschaftswelt besitzt eine andere Spielplanung oder Ausschreibungsgenerierung als das signierte Deployment.");
}

export interface OperationalProgramRegistration {
  readonly deploymentHash: string;
  readonly initializationHash: string;
  readonly trainRunIds: readonly string[];
}

/** Read-only Sicht auf tatsaechlich in den Scheduler aufgenommene Programme. */
export interface OperationalProgramRegistrationCatalog {
  operationalProgramRegistration(
    worldId: string,
    regionId: string,
  ): OperationalProgramRegistration | undefined;
}

/** Defense-in-depth fuer Loader und aktive Registry: v2 nie ohne Receipt-Beweis. */
export function validateAlphaVehicleCatalogBinding(deployment: AlphaWorldDeployment): void {
  if (deployment.fleet.authorityRelease.schemaVersion !== FLEET_AUTHORITY_RELEASE_SCHEMA_V2) {
    validateVehicleCatalogDeploymentBinding(deployment.vehicleCatalogBinding, {
      worldId: deployment.worldId,
      economyReleaseId: "",
      economyReleaseSha256: "",
      blueprintFleetHash: "",
      fleet: deployment.fleet,
      regionalSimulation: deployment.regionalSimulation,
    });
    return;
  }
  const economyRelease = buildEconomyRelease({
    version: deployment.economy.release.version,
    rates: deployment.economy.release.rates,
    rules: deployment.economy.release.rules,
    tenderProfiles: deployment.economy.release.tenderProfiles,
  });
  validateVehicleCatalogDeploymentBinding(deployment.vehicleCatalogBinding, {
    worldId: deployment.worldId,
    economyReleaseId: economyRelease.version,
    economyReleaseSha256: economyRelease.checksum,
    blueprintFleetHash: deployment.blueprint.releases.fleet,
    fleet: deployment.fleet,
    regionalSimulation: deployment.regionalSimulation,
  });
}

export function signedDeploymentRevision(deployment: AlphaWorldDeployment): number {
  const revision = deployment.deploymentRevision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Alpha-Deployment besitzt keine gueltige monotone Deployment-Revision.");
  }
  return revision;
}

function verifiedExternalBaseTrainRunId(train: PublicExternalTrain): string | undefined {
  const base = train.journeyChainId;
  if (base.includes(":day-")) return undefined;
  if (train.id === base) return base;
  const prefix = `${base}:day-`;
  return train.id.startsWith(prefix) && /^[1-9][0-9]*$/u.test(train.id.slice(prefix.length))
    ? base
    : undefined;
}

/**
 * Reduziert den autoritativen Runtime-Snapshot auf die signierten Basisfahrten.
 * Wiederholte Tagesinstanzen und Aussenlaeufe sind legitime Laufzeitzustaende;
 * fremde oder nichtkanonische IDs duerfen die Restart-Pruefung nicht erfuellen.
 */
export function publicOperationSnapshotVerification(
  snapshot: LiveSnapshot | undefined,
  expectedTrainRunIds: readonly string[],
  expectedOperationalRegion?: Readonly<{
    regionId: string;
    infrastructureReleaseId: string;
  }>,
): Pick<WorldStartVerification, "livemapReady" | "runningTrainRunIds"> {
  if (snapshot === undefined) return { livemapReady: false, runningTrainRunIds: [] };
  const expected = new Set(expectedTrainRunIds);
  const visible = new Set<string>();
  for (const train of snapshot.trains) {
    const base = train.baseTrainRunId === undefined
      ? train.id.includes(":day-") ? undefined : train.id
      : verifiedBaseTrainRunId(train);
    if (
      base !== undefined
      && expected.has(base)
      && train.operationMarker?.kind === "public-operator"
    ) visible.add(base);
  }
  for (const train of snapshot.externalTrains ?? []) {
    // Der oeffentliche Aussenlaufvertrag enthaelt absichtlich keinen Marker.
    // Seine Basisidentitaet stammt stattdessen aus dem signierten Grenzvertrag;
    // das dauerhafte Eigenbetriebsereignis wird daneben separat verifiziert.
    const base = verifiedExternalBaseTrainRunId(train);
    if (base !== undefined && expected.has(base)) visible.add(base);
  }
  const runningTrainRunIds = [...expected].filter((trainRunId) => visible.has(trainRunId));
  if (expectedOperationalRegion !== undefined) {
    const frames = snapshot.operationalRegions ?? [];
    const frame = frames.length === 1 ? frames[0] : undefined;
    if (
      frame !== undefined
      && frame.regionId === expectedOperationalRegion.regionId
      && frame.infrastructureReleaseId === expectedOperationalRegion.infrastructureReleaseId
      && Number.isSafeInteger(frame.commitSequence)
      && frame.commitSequence >= 0
      && Number.isSafeInteger(frame.simulationTimeMs)
      && frame.simulationTimeMs >= 0
      && Number.isSafeInteger(frame.staleAfterMs)
      && frame.staleAfterMs >= frame.simulationTimeMs
    ) {
      // Operational-v2 startet absichtlich mit einem leeren dynamischen
      // Zugzustand. Der gebundene Frame belegt die Livemap-Hydrierung, darf
      // aber niemals noch nicht materialisierte Fahrten als laufend erfinden.
      return {
        livemapReady: true,
        runningTrainRunIds,
      };
    }
    return { livemapReady: false, runningTrainRunIds };
  }
  return {
    livemapReady: runningTrainRunIds.length === expectedTrainRunIds.length,
    runningTrainRunIds,
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} ist kein Objekt.`);
  return value as Record<string, unknown>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validatePlanningBinding(deployment: AlphaWorldDeployment): void {
  const planning = record(deployment.planning, "Alpha-Deployment-Planning");
  const authority = record(planning["authority"], "Alpha-Deployment-Planning-Authority");
  if (
    Object.keys(planning).length !== 2
    || !Object.hasOwn(planning, "authority")
    || !Object.hasOwn(planning, "infrastructureRelease")
    || Object.keys(authority).length !== 3
    || !["accountId", "keycloakSubject", "displayName"].every((key) => Object.hasOwn(authority, key))
    || typeof authority["accountId"] !== "string"
    || !UUID_PATTERN.test(authority["accountId"])
    || typeof authority["keycloakSubject"] !== "string"
    || authority["keycloakSubject"].trim() === ""
    || typeof authority["displayName"] !== "string"
    || authority["displayName"].trim() === ""
  ) throw new Error("Alpha-Deployment besitzt keine gueltige signierte Planning-Authority.");
  const release = parsePlanningInfrastructureRelease(
    planning["infrastructureRelease"],
    deployment.worldId,
    deployment.provenance.infraReleaseId,
  );
  if (release.sourceId !== deployment.infraReleaseHash) {
    throw new Error("Planning-Infrastrukturrelease ist nicht an den signierten InfraRelease-Hash gebunden.");
  }
}

function validateOperationalSimulationBinding(deployment: AlphaWorldDeployment): void {
  const initialization = record(
    deployment.regionalSimulation,
    "Alpha-Deployment-Betriebsengine",
  );
  const infraRelease = record(
    initialization["infraRelease"],
    "Alpha-Deployment-Betriebsengine-InfraRelease",
  );
  const compactInfrastructure = infraRelease["schemaVersion"]
    === OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA;
  const compactInfrastructureValid = !compactInfrastructure || (
    Object.keys(infraRelease).sort().join("\u0000")
      === ["schemaVersion", "infraReleaseId", "file", "bytes", "sha256", "stateHash"]
        .sort().join("\u0000")
    && infraRelease["infraReleaseId"] === deployment.provenance.infraReleaseId
    && infraRelease["file"] === OPERATIONAL_INFRASTRUCTURE_FILE
    && Number.isSafeInteger(infraRelease["bytes"])
    && (infraRelease["bytes"] as number) > 0
    && typeof infraRelease["sha256"] === "string"
    && /^[a-f0-9]{64}$/u.test(infraRelease["sha256"])
    && infraRelease["sha256"] === deployment.provenance.operationalInfrastructureSha256
    && typeof infraRelease["stateHash"] === "string"
    && /^[a-f0-9]{64}$/u.test(infraRelease["stateHash"])
    && infraRelease["stateHash"] === deployment.provenance.operationalInfrastructureStateHash
  );
  if (
    initialization["schemaVersion"] !== OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA
    || initialization["worldId"] !== deployment.worldId
    || initialization["regionId"] !== deployment.blueprint.regionId
    || !Number.isSafeInteger(initialization["nowMs"])
    || (initialization["nowMs"] as number) < 0
    || !Number.isSafeInteger(initialization["repeatEveryMs"])
    || initialization["repeatEveryMs"] !== deployment.repeatEveryS * 1_000
    || initialization["protectionModeSelectionPolicy"]
      !== OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY
    || compactInfrastructureValid === false
    || (compactInfrastructure
      ? infraRelease["infraReleaseId"] !== deployment.provenance.infraReleaseId
      : infraRelease["id"] !== deployment.provenance.infraReleaseId)
    || !Array.isArray(initialization["vehicleTypes"])
    || !Array.isArray(initialization["vehicles"])
    || !Array.isArray(initialization["formations"])
    || !Array.isArray(initialization["trains"])
    || !Array.isArray(initialization["movementContinuations"])
    || !/^[a-f0-9]{64}$/u.test(deployment.provenance.operationalSimulationSourceSha256)
  ) {
    throw new Error(
      "Alpha-Deployment besitzt keinen vollstaendigen gebundenen Betriebsengine-v2-Vertrag.",
    );
  }
  operationalProtectionModeSelectionEvidence(
    initialization as unknown as OperationalSimulationInitialization,
  );
  operationalMovementContinuationsEvidence(
    initialization as unknown as OperationalSimulationInitialization,
  );
}

export function validateDeploymentWorldDefinition(
  value: unknown,
  profileKind: AlphaWorldBlueprint["profileKind"],
): asserts value is AlphaDeploymentWorldDefinition {
  const definition = record(value, "Alpha-Deployment-Weltdefinition");
  const epoch = typeof definition["epoch"] === "string"
    ? new Date(definition["epoch"])
    : undefined;
  if (
    Object.keys(definition).length !== 5
    || !["name", "kind", "rankingStatus", "schedulePeriodWeeks", "epoch"].every((key) => Object.hasOwn(definition, key))
    || typeof definition["name"] !== "string"
    || definition["name"].trim() === ""
    || definition["kind"] !== profileKind
    || !["public", "private", "test"].includes(definition["kind"] as string)
    || !["ranked", "unranked"].includes(definition["rankingStatus"] as string)
    || (definition["kind"] === "public") !== (definition["rankingStatus"] === "ranked")
    || !Number.isSafeInteger(definition["schedulePeriodWeeks"])
    || (definition["schedulePeriodWeeks"] as number) < 3
    || (definition["schedulePeriodWeeks"] as number) > 8
    || epoch === undefined
    || Number.isNaN(epoch.getTime())
    || epoch.getUTCDay() !== 1
    || epoch.getUTCHours() !== 0
    || epoch.getUTCMinutes() !== 0
    || epoch.getUTCSeconds() !== 0
    || epoch.getUTCMilliseconds() !== 0
  ) {
    throw new Error("Alpha-Deployment besitzt keine gueltige signierte Weltdefinition.");
  }
}

export function parseSignedAlphaWorldDeployment(
  value: unknown,
  trustedKeys: Readonly<Record<string, string>>,
): SignedAlphaWorldDeployment {
  const parsed = record(value, "Alpha-Deployment");
  const signature = record(parsed["signature"], "Alpha-Deployment-Signatur");
  if (signature["algorithm"] !== "Ed25519" || typeof signature["keyId"] !== "string" || typeof signature["valueBase64"] !== "string") {
    throw new Error("Alpha-Deployment-Signatur ist unvollstaendig.");
  }
  const key = trustedKeys[signature["keyId"]];
  if (key === undefined) throw new Error(`Alpha-Deployment-Schluessel '${signature["keyId"]}' ist nicht vertrauenswuerdig.`);
  const deployment = decodeEconomyValue(parsed["deployment"]) as AlphaWorldDeployment;
  if (deployment.schema !== ALPHA_WORLD_DEPLOYMENT_SCHEMA || deployment.worldId.trim() === "") {
    throw new Error("Alpha-Deployment verletzt Schema- oder Weltbindung.");
  }
  signedDeploymentRevision(deployment);
  validateWorldBlueprint(deployment.blueprint);
  validateDeploymentWorldDefinition(deployment.worldDefinition, deployment.blueprint.profileKind);
  validatePlanningBinding(deployment);
  validateAlphaEconomyPlanningBinding(deployment);
  validateOperationalSimulationBinding(deployment);
  validateAlphaOperationalPlanningBinding(deployment);
  const economyRelease = buildEconomyRelease({
    version: deployment.economy.release.version,
    rates: deployment.economy.release.rates,
    rules: deployment.economy.release.rules,
    tenderProfiles: deployment.economy.release.tenderProfiles,
  });
  const operationalConflictHash = deployment.regionalSimulation.infraRelease.schemaVersion
    === OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA
    ? deployment.provenance.operationalInfrastructureStateHash
    : deployment.provenance.operationalNetworkHash;
  if (
    deployment.infraReleaseHash !== deployment.blueprint.releases.infra
    || operationalConflictHash !== deployment.blueprint.conflictCheckHash
    || deployment.provenance.gtfsSnapshotHash !== deployment.blueprint.releases.timetable
    || economyRelease.checksum !== deployment.blueprint.releases.economy
  ) {
    throw new Error("Alpha-Deployment besitzt widerspruechliche interne Release-Hashbindungen.");
  }
  validateAlphaVehicleCatalogBinding(deployment);
  const deploymentHash = alphaHash(ALPHA_WORLD_DEPLOYMENT_SCHEMA, deployment);
  if (parsed["deploymentHash"] !== deploymentHash) throw new Error("Alpha-Deployment-Hash stimmt nicht mit dem Inhalt ueberein.");
  const signatureBytes = Buffer.from(signature["valueBase64"], "base64");
  if (signatureBytes.length !== 64 || !verifySignature(
    null,
    Buffer.from(deploymentHash, "hex"),
    createPublicKey(canonicalEd25519SpkiPublicKeyPem(key, signature["keyId"])),
    signatureBytes,
  )) throw new Error("Alpha-Deployment besitzt keine gueltige Ed25519-Signatur.");
  return {
    deployment,
    deploymentHash,
    signature: {
      algorithm: "Ed25519",
      keyId: signature["keyId"],
      valueBase64: signature["valueBase64"],
    },
  };
}

function serializedDeploymentSchema(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const deployment = (value as Record<string, unknown>)["deployment"];
  if (typeof deployment !== "object" || deployment === null || Array.isArray(deployment)) return undefined;
  return (deployment as Record<string, unknown>)["schema"];
}

export function parsePersistedActiveAlphaWorldDeployment(
  worldId: string,
  value: unknown,
  trustedKeys: Readonly<Record<string, string>>,
): SignedAlphaWorldDeployment {
  if (serializedDeploymentSchema(value) !== ALPHA_WORLD_DEPLOYMENT_SCHEMA) {
    throw new ActiveWorldDeploymentCutoverError(worldId);
  }
  try {
    return parseSignedAlphaWorldDeployment(value, trustedKeys);
  } catch (cause) {
    if (serializedDeploymentSchema(value) !== ALPHA_WORLD_DEPLOYMENT_SCHEMA) {
      throw new ActiveWorldDeploymentCutoverError(worldId, cause);
    }
    throw cause;
  }
}

/** Kanonisch JSON-faehige Huelle fuer die dauerhafte, erneute Signaturpruefung. */
export function serializeSignedAlphaWorldDeployment(
  signed: SignedAlphaWorldDeployment,
): Readonly<Record<string, unknown>> {
  return {
    deployment: encodeEconomyValue(signed.deployment) as Readonly<Record<string, unknown>>,
    deploymentHash: signed.deploymentHash,
    signature: signed.signature,
  };
}

export async function persistSignedAlphaWorldDeployment(
  db: AlphaDatabase,
  signed: SignedAlphaWorldDeployment,
): Promise<void> {
  const authorityAccountId = signed.deployment.planning.authority.accountId;
  const serialized = serializeSignedAlphaWorldDeployment(signed);
  let [stored] = await db.insert(alphaWorldDeployments).values({
    worldId: signed.deployment.worldId,
    deploymentHash: signed.deploymentHash,
    signedDeployment: serialized,
    planningAuthorityAccountId: authorityAccountId,
  }).onConflictDoNothing({ target: alphaWorldDeployments.worldId }).returning();
  if (stored === undefined) {
    [stored] = await db.select().from(alphaWorldDeployments)
      .where(eq(alphaWorldDeployments.worldId, signed.deployment.worldId)).limit(1);
  }
  if (
    stored === undefined
    || stored.deploymentHash !== signed.deploymentHash
    || stored.planningAuthorityAccountId !== authorityAccountId
  ) throw new Error("Persistiertes Alpha-Deployment steht im Konflikt zum signierten Weltvertrag.");
}

interface PersistedAlphaWorldDeploymentBindingRow {
  readonly worldId: string;
  readonly deploymentHash: string;
  readonly planningAuthorityAccountId: string;
  readonly signedDeployment: unknown;
  readonly name: string;
  readonly schedulePeriodWeeks: number;
  readonly epoch: Date;
  readonly worldKind: "public" | "private";
  readonly rankingStatus: "ranked" | "unranked";
}

function validatePersistedAlphaWorldDeploymentBinding(
  row: PersistedAlphaWorldDeploymentBindingRow,
  trustedKeys: Readonly<Record<string, string>>,
): SignedAlphaWorldDeployment {
  const signed = parsePersistedActiveAlphaWorldDeployment(
    row.worldId,
    row.signedDeployment,
    trustedKeys,
  );
  if (
    signed.deployment.worldId !== row.worldId
    || signed.deploymentHash !== row.deploymentHash
    || signed.deployment.planning.authority.accountId !== row.planningAuthorityAccountId
    || signed.deployment.worldDefinition.name !== row.name
    || signed.deployment.worldDefinition.schedulePeriodWeeks !== row.schedulePeriodWeeks
    || new Date(signed.deployment.worldDefinition.epoch).getTime() !== row.epoch.getTime()
    || (signed.deployment.worldDefinition.kind === "public" ? "public" : "private") !== row.worldKind
    || signed.deployment.worldDefinition.rankingStatus !== row.rankingStatus
  ) throw new Error(`Persistiertes Alpha-Deployment fuer '${row.worldId}' verletzt seine DB-Bindung.`);
  return signed;
}

export async function loadPersistedActiveAlphaWorldDeployments(
  db: AlphaDatabase,
  trustedKeys: Readonly<Record<string, string>>,
): Promise<readonly { readonly signed: SignedAlphaWorldDeployment; readonly epoch: Date }[]> {
  const rows = await db.select({
    worldId: alphaWorldDeployments.worldId,
    deploymentHash: alphaWorldDeployments.deploymentHash,
    planningAuthorityAccountId: alphaWorldDeployments.planningAuthorityAccountId,
    signedDeployment: alphaWorldDeployments.signedDeployment,
    name: worlds.name,
    schedulePeriodWeeks: worlds.schedulePeriodWeeks,
    epoch: worlds.epoch,
    worldKind: worlds.worldKind,
    rankingStatus: worlds.rankingStatus,
  }).from(alphaWorldDeployments).innerJoin(worlds, and(
    eq(worlds.id, alphaWorldDeployments.worldId),
    eq(worlds.lifecycleStatus, "active"),
  )).orderBy(alphaWorldDeployments.worldId);
  return rows.map((row) => {
    return {
      signed: validatePersistedAlphaWorldDeploymentBinding(row, trustedKeys),
      epoch: row.epoch,
    };
  });
}

/**
 * Ein dauerhaft archivierter Deployment-Pfad darf beim Neustart nur ignoriert
 * werden, wenn seine erneut verifizierte Signaturhuelle exakt dem ebenfalls
 * erneut verifizierten, DB-gebundenen Archivkopf entspricht. Damit kann eine
 * unveraenderte Deployment-Umgebung andere aktive Welten nicht blockieren,
 * ohne einen fremden oder manipulierten Archivpfad stillschweigend zu dulden.
 */
export async function assertArchivedAlphaWorldDeploymentHead(
  db: AlphaDatabase,
  configured: SignedAlphaWorldDeployment,
  trustedKeys: Readonly<Record<string, string>>,
): Promise<void> {
  const worldId = configured.deployment.worldId;
  const [row] = await db.select({
    worldId: alphaWorldDeployments.worldId,
    deploymentHash: alphaWorldDeployments.deploymentHash,
    planningAuthorityAccountId: alphaWorldDeployments.planningAuthorityAccountId,
    signedDeployment: alphaWorldDeployments.signedDeployment,
    name: worlds.name,
    schedulePeriodWeeks: worlds.schedulePeriodWeeks,
    epoch: worlds.epoch,
    worldKind: worlds.worldKind,
    rankingStatus: worlds.rankingStatus,
  }).from(alphaWorldDeployments).innerJoin(worlds, and(
    eq(worlds.id, alphaWorldDeployments.worldId),
    eq(worlds.lifecycleStatus, "archived"),
  )).where(eq(alphaWorldDeployments.worldId, worldId)).limit(1);
  if (row === undefined) {
    throw new Error(`Archivierte Welt '${worldId}' besitzt keinen verifizierbaren Deploymentkopf.`);
  }
  const persisted = validatePersistedAlphaWorldDeploymentBinding(row, trustedKeys);
  if (
    persisted.deploymentHash !== configured.deploymentHash
    || persisted.signature.algorithm !== configured.signature.algorithm
    || persisted.signature.keyId !== configured.signature.keyId
    || persisted.signature.valueBase64 !== configured.signature.valueBase64
  ) {
    throw new Error(`Deploymentpfad fuer archivierte Welt '${worldId}' widerspricht dem autoritativen Deploymentkopf.`);
  }
}

export interface AlphaWorldStartupDeploymentResolution {
  readonly persistedActiveDeployments: readonly {
    readonly signed: SignedAlphaWorldDeployment;
    readonly epoch: Date;
  }[];
  readonly signedDeployments: Map<string, SignedAlphaWorldDeployment>;
  readonly archivedWorldIds: readonly string[];
}

/**
 * Vereint persistierte aktive Koepfe mit statischen Startpfaden. Archivierte
 * Pfade werden erst nach exakter Archivkopfpruefung ausgesiebt; alle anderen
 * Lifecycle-Zustaende und widerspruechliche aktive Koepfe bleiben fail-closed.
 */
export async function resolveAlphaWorldStartupDeployments(
  db: AlphaDatabase,
  trustedKeys: Readonly<Record<string, string>>,
  configuredDeployments: readonly SignedAlphaWorldDeployment[],
): Promise<AlphaWorldStartupDeploymentResolution> {
  const persistedActiveDeployments = await loadPersistedActiveAlphaWorldDeployments(db, trustedKeys);
  const signedDeployments = new Map(
    persistedActiveDeployments.map((persisted) => [persisted.signed.deployment.worldId, persisted.signed] as const),
  );
  const configuredWorldIds = new Set<string>();
  const archivedWorldIds: string[] = [];
  for (const configured of configuredDeployments) {
    const worldId = configured.deployment.worldId;
    if (configuredWorldIds.has(worldId)) {
      throw new Error(`Mehrere Alpha-Deploymentpfade sind an dieselbe Welt '${worldId}' gebunden.`);
    }
    configuredWorldIds.add(worldId);
    const [world] = await db.select({ lifecycleStatus: worlds.lifecycleStatus })
      .from(worlds)
      .where(eq(worlds.id, worldId))
      .limit(1);
    if (world === undefined) {
      throw new Error(`Signiertes Alpha-Deployment ist an die unbekannte Welt '${worldId}' gebunden.`);
    }
    if (world.lifecycleStatus === "archived") {
      await assertArchivedAlphaWorldDeploymentHead(db, configured, trustedKeys);
      signedDeployments.delete(worldId);
      archivedWorldIds.push(worldId);
      continue;
    }
    if (world.lifecycleStatus !== "active") {
      throw new Error(`Signiertes Alpha-Deployment ist an die nicht aktive Welt '${worldId}' gebunden.`);
    }
    const persisted = signedDeployments.get(worldId);
    if (persisted !== undefined && persisted.deploymentHash !== configured.deploymentHash) {
      throw new Error(`Deploymentpfad fuer '${worldId}' widerspricht dem autoritativ persistierten Deployment.`);
    }
    signedDeployments.set(worldId, configured);
  }
  const archived = new Set(archivedWorldIds);
  return Object.freeze({
    persistedActiveDeployments: Object.freeze(
      persistedActiveDeployments.filter(({ signed }) => !archived.has(signed.deployment.worldId)),
    ),
    signedDeployments,
    archivedWorldIds: Object.freeze(archivedWorldIds),
  });
}

/**
 * Odoo-Monitoring sieht ausschliesslich voll gestartete, aktive Welten.
 * Ein retrybares `provisioning`-Profil darf weder projiziert werden noch den
 * gemeinsamen Projektionszyklus anderer Welten abbrechen.
 */
export async function loadActiveAlphaWorldProjectionProfiles(db: AlphaDatabase) {
  return db.select({
    worldId: alphaWorldProfiles.worldId,
    profileKind: alphaWorldProfiles.profileKind,
    blueprintHash: alphaWorldProfiles.blueprintHash,
    deploymentHash: alphaWorldProfiles.deploymentHash,
    blueprint: alphaWorldProfiles.blueprint,
  }).from(alphaWorldProfiles).innerJoin(worlds, eq(worlds.id, alphaWorldProfiles.worldId)).where(and(
    eq(alphaWorldProfiles.state, "running"),
    eq(worlds.lifecycleStatus, "active"),
  )).orderBy(asc(alphaWorldProfiles.worldId));
}

/**
 * Startup-Gate fuer die oeffentliche 1:1-Runtime. Eine aktive, laufende
 * Public-Welt darf weder ohne erneut verifiziertes persistiertes Deployment
 * sichtbar werden noch darf ein verifiziertes Public-Deployment ohne sein
 * laufendes Profil in Scheduler und Livemap gelangen.
 */
export async function assertActivePublicWorldDeploymentCoverage(
  db: AlphaDatabase,
  trustedKeys: Readonly<Record<string, string>>,
): Promise<readonly string[]> {
  const [profiles, persistedDeployments] = await Promise.all([
    loadActiveAlphaWorldProjectionProfiles(db),
    loadPersistedActiveAlphaWorldDeployments(db, trustedKeys),
  ]);
  const activePublicWorldIds = profiles
    .filter(({ profileKind }) => profileKind === "public")
    .map(({ worldId }) => worldId)
    .sort();
  const deployedPublicWorldIds = persistedDeployments
    .filter(({ signed }) => signed.deployment.blueprint.profileKind === "public")
    .map(({ signed }) => signed.deployment.worldId)
    .sort();
  const active = new Set(activePublicWorldIds);
  const deployed = new Set(deployedPublicWorldIds);
  const missingDeployment = activePublicWorldIds.filter((worldId) => !deployed.has(worldId));
  const missingProfile = deployedPublicWorldIds.filter((worldId) => !active.has(worldId));
  if (missingDeployment.length > 0 || missingProfile.length > 0) {
    throw new Error(
      "Aktive oeffentliche Welten stimmen nicht mit den verifizierten persistierten Deployments ueberein "
      + `(ohne Deployment: ${missingDeployment.join(", ") || "keine"}; ohne laufendes Public-Profil: ${missingProfile.join(", ") || "keine"}).`,
    );
  }
  return activePublicWorldIds;
}

/**
 * Verifiziert die laufende Profilprojektion gegen die dauerhaft gespeicherte
 * Ed25519-Huelle. Ein manipuliertes Blueprint+Hash-Paar wird dadurch nicht
 * allein aufgrund interner Selbstkonsistenz akzeptiert.
 */
export async function loadSignedRunningWorldDeployment(
  db: AlphaDatabase,
  worldId: string,
  trustedKeys: Readonly<Record<string, string>>,
): Promise<SignedAlphaWorldDeployment> {
  const [row] = await db.select({
    deploymentHash: alphaWorldDeployments.deploymentHash,
    signedDeployment: alphaWorldDeployments.signedDeployment,
    profileDeploymentHash: alphaWorldProfiles.deploymentHash,
    blueprintHash: alphaWorldProfiles.blueprintHash,
    blueprint: alphaWorldProfiles.blueprint,
    state: alphaWorldProfiles.state,
    lifecycleStatus: worlds.lifecycleStatus,
  }).from(alphaWorldDeployments)
    .innerJoin(alphaWorldProfiles, eq(alphaWorldProfiles.worldId, alphaWorldDeployments.worldId))
    .innerJoin(worlds, eq(worlds.id, alphaWorldDeployments.worldId))
    .where(eq(alphaWorldDeployments.worldId, worldId))
    .limit(1);
  if (row === undefined || row.state !== "running" || row.lifecycleStatus !== "active") {
    throw new Error(`Welt '${worldId}' besitzt kein aktives signiertes Deployment.`);
  }
  const signed = parseSignedAlphaWorldDeployment(row.signedDeployment, trustedKeys);
  const projectedBlueprint = decodeEconomyValue(row.blueprint) as AlphaWorldBlueprint;
  if (
    signed.deployment.worldId !== worldId
    || signed.deploymentHash !== row.deploymentHash
    || row.profileDeploymentHash !== row.deploymentHash
    || validateWorldBlueprint(projectedBlueprint) !== row.blueprintHash
    || row.blueprintHash !== validateWorldBlueprint(signed.deployment.blueprint)
  ) throw new Error(`Welt '${worldId}' weicht von ihrem signierten Deployment ab.`);
  return signed;
}

export async function loadSignedAlphaWorldDeployment(
  path: string,
  trustedKeys: Readonly<Record<string, string>>,
): Promise<SignedAlphaWorldDeployment> {
  return parseSignedAlphaWorldDeployment(JSON.parse(await readFile(path, "utf8")), trustedKeys);
}

function publicStartDecision(sequence: number, worldId: string, occurredAt: Date, trainRunCount: number): OperationsDecision {
  return {
    sequence,
    occurredAt: occurredAt.toISOString(),
    trainRunId: "",
    decisionId: `public-operation-start:${worldId}`,
    action: "monitor_public_operation",
    cause: "world-start",
    causeCode: null,
    causeLabel: "Weltstart mit Eigenbetrieb",
    fineCauseId: "",
    fineCauseLabel: "",
    affectedResource: "regional-network",
    outcomeReason: "Vollstaendiges SPNV-Angebot ab Simulationssekunde null.",
    impact: { trainRunCount },
    manualOverride: false,
    major: false,
  };
}

export class ProductionWorldStartPort implements WorldStartPort {
  constructor(
    private readonly db: AlphaDatabase,
    private readonly signed: SignedAlphaWorldDeployment,
    private readonly fleetRuntime: FleetRuntime,
    private readonly regionalSimulation: RegionalSimulationWorker,
    private readonly livemap: LivemapRegistry,
    private readonly operations: OperationsRegistry,
    private readonly operationalPrograms: OperationalProgramRegistrationCatalog,
    private readonly economyQueueClock: () => Date = () => new Date(),
  ) {}

  #deployment(worldId: string, blueprint: AlphaWorldBlueprint): AlphaWorldDeployment {
    const deployment = this.signed.deployment;
    if (deployment.worldId !== worldId || validateWorldBlueprint(blueprint) !== validateWorldBlueprint(deployment.blueprint)) {
      throw new Error("Weltstart verwendet nicht das signierte Alpha-Deployment.");
    }
    return deployment;
  }

  async verifyDurable(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void> {
    const deployment = this.#deployment(worldId, blueprint);
    const correlationId = `alpha-world-start:${worldId}:${this.signed.deploymentHash}`;
    const [economy, fleet, operationsEvent, projection] = await Promise.all([
      loadEconomyWorldState(this.db, worldId),
      loadFleetProducerCheckpoint(this.db, worldId),
      this.db.select({ sequence: domainEvents.sequence }).from(domainEvents).where(and(
        eq(domainEvents.worldId, worldId),
        eq(domainEvents.eventType, "alpha.public-operation-visible"),
      )).limit(1),
      this.db.select({ id: odooProjectionOutbox.id }).from(odooProjectionOutbox).where(and(
        eq(odooProjectionOutbox.worldId, worldId),
        eq(odooProjectionOutbox.correlationId, correlationId),
      )).limit(1),
    ]);
    if (economy !== undefined) validatePersistedAlphaEconomyPlanning(deployment, economy);
    if (
      economy?.releasePin.releaseChecksum !== blueprint.releases.economy
      || fleet?.state.authorityReleaseHash !== blueprint.releases.fleet
      || operationsEvent.length !== 1
      || projection.length !== 1
    ) throw new Error("Laufende Alpha-Welt besitzt keine vollstaendige dauerhafte Startprojektion.");
  }

  async initializeEconomy(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void> {
    const deployment = this.#deployment(worldId, blueprint);
    const existing = await loadEconomyWorldState(this.db, worldId);
    if (existing !== undefined) {
      if (existing.releasePin.releaseChecksum !== blueprint.releases.economy) throw new Error("Bestehende Wirtschaftswelt besitzt einen fremden Release.");
      validatePersistedAlphaEconomyPlanning(deployment, existing);
      return;
    }
    const started = startAlphaDeploymentEconomy(deployment);
    await persistEconomyTransition(this.db, { expectedRevision: null, ...started, committedAt: new Date(0), enqueuedAt: this.economyQueueClock() });
  }

  async initializeFleet(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void> {
    const deployment = this.#deployment(worldId, blueprint);
    if (deployment.fleet.worldId !== worldId) throw new Error("Fleet-Release verletzt Weltisolation.");
    const probe = this.fleetRuntime.initializeFleet(deployment.fleet);
    if (probe.state.authorityReleaseHash !== blueprint.releases.fleet) throw new Error("Fleet-Release stimmt nicht mit dem Weltentwurf ueberein.");
    await initializeFleetProducer({
      db: this.db,
      runtime: this.fleetRuntime,
      initialization: deployment.fleet,
      ingestedAt: new Date(0),
    });
  }

  async #ensureOperationsEvent(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void> {
    const eventType = "alpha.public-operation-visible";
    const [world] = await this.db.select({ epoch: worlds.epoch }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
    if (world === undefined) throw new Error("Welt fuer Betriebszentralenprojektion fehlt.");
    let [event] = await this.db.select().from(domainEvents).where(and(
      eq(domainEvents.worldId, worldId),
      eq(domainEvents.eventType, eventType),
    )).limit(1);
    if (event === undefined) {
      [event] = await this.db.transaction(async (tx) => {
        await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
        const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents)
          .where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
        return tx.insert(domainEvents).values({
          worldId,
          sequence: (head?.sequence ?? 0) + 1,
          eventType,
          payload: {
            schemaVersion: "zugfolge-public-operation-visible/v1",
            operatorIds: ["public"],
            lotIds: blueprint.lots.map((lot) => lot.lotId),
            trainRunIds: blueprint.lots.flatMap((lot) => lot.trainRunIds),
            deploymentHash: this.signed.deploymentHash,
          },
          occurredAt: world.epoch,
        }).returning();
      });
    }
    if (event === undefined) throw new Error("Betriebszentralenprojektion konnte nicht erzeugt werden.");
    const payload = record(event.payload, "Dauerhafte Betriebszentralenprojektion");
    const expectedLotIds = blueprint.lots.map((lot) => lot.lotId);
    const expectedTrainRunIds = blueprint.lots.flatMap((lot) => lot.trainRunIds);
    if (
      payload["schemaVersion"] !== "zugfolge-public-operation-visible/v1"
      || JSON.stringify(payload["operatorIds"]) !== JSON.stringify(["public"])
      || JSON.stringify(payload["lotIds"]) !== JSON.stringify(expectedLotIds)
      || JSON.stringify(payload["trainRunIds"]) !== JSON.stringify(expectedTrainRunIds)
      || payload["deploymentHash"] !== this.signed.deploymentHash
    ) {
      throw new Error("Dauerhafte Betriebszentralenprojektion widerspricht dem signierten Deployment.");
    }
    projectLivemapOperationEvent(this.livemap, {
      worldId,
      eventType,
      atS: 0,
      payload,
    });
    this.operations.forOperator(worldId, "public").publish({
      worldId,
      operatorId: "public",
      sequence: event.sequence,
      decision: publicStartDecision(event.sequence, worldId, event.occurredAt, expectedTrainRunIds.length),
    });
  }

  async initializeRegionalSimulation(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void> {
    const deployment = this.#deployment(worldId, blueprint);
    const expectedInitializationHash = operationalSimulationInitializationHash(
      deployment.regionalSimulation,
    );
    if (!this.regionalSimulation.isReady(
      worldId,
      deployment.regionalSimulation.regionId,
      expectedInitializationHash,
    )) {
      const [persistedRegion] = await this.db.select({
        initializationHash: regionalSimulationStates.initializationHash,
      }).from(regionalSimulationStates).where(and(
        eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, deployment.regionalSimulation.regionId),
      )).limit(1);
      await initializeOrRestoreRegionalSimulation(
        this.regionalSimulation,
        deployment.regionalSimulation,
        persistedRegion === undefined ? undefined : persistedRegion.initializationHash,
        new Date(0),
      );
    }
    await this.#ensureOperationsEvent(worldId, blueprint);
    const correlationId = `alpha-world-start:${worldId}:${this.signed.deploymentHash}`;
    const [queued] = await this.db.select({ id: odooProjectionOutbox.id }).from(odooProjectionOutbox).where(and(
      eq(odooProjectionOutbox.worldId, worldId),
      eq(odooProjectionOutbox.correlationId, correlationId),
    )).limit(1);
    if (queued === undefined) {
      const [world] = await this.db.select({
        name: worlds.name,
        schedulePeriodWeeks: worlds.schedulePeriodWeeks,
      }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
      if (world === undefined) throw new Error("Welt fuer Odoo-Startprojektion fehlt.");
      await enqueueAuthoritativeWorldStartProjection(this.db, {
      worldId,
      correlationId,
      signedDeployment: this.signed,
      deploymentRevision: signedDeploymentRevision(this.signed.deployment),
      occurredAt: new Date(0),
      payload: {
        worldName: world.name,
        projectionRevision: this.signed.deploymentHash,
        lifecycle: "starting",
        worldStatus: "starting",
        operator: "public",
        regionId: blueprint.regionId,
        releases: blueprint.releases,
        infraReleaseHash: blueprint.releases.infra,
        economyReleaseHash: blueprint.releases.economy,
        profileKind: blueprint.profileKind,
        blueprintHash: validateWorldBlueprint(blueprint),
        lotCount: blueprint.lots.length,
        trainRunCount: blueprint.lots.flatMap((lot) => lot.trainRunIds).length,
        startingCapitalPolicy: blueprint.startingCapitalPolicy,
        schedulePeriod: `${world.schedulePeriodWeeks} Wochen`,
        authoritative: true,
        freshness: "live",
      },
    });
    }
  }

  async verify(worldId: string, blueprint: AlphaWorldBlueprint): Promise<WorldStartVerification> {
    const deployment = this.#deployment(worldId, blueprint);
    const [economy, fleet, operationsEvent, projection] = await Promise.all([
      loadEconomyWorldState(this.db, worldId),
      loadFleetProducerCheckpoint(this.db, worldId),
      this.db.select({ sequence: domainEvents.sequence }).from(domainEvents).where(and(
        eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, "alpha.public-operation-visible"),
      )).limit(1),
      this.db.select({ id: odooProjectionOutbox.id }).from(odooProjectionOutbox).where(and(
        eq(odooProjectionOutbox.worldId, worldId),
        eq(odooProjectionOutbox.correlationId, `alpha-world-start:${worldId}:${this.signed.deploymentHash}`),
      )).limit(1),
    ]);
    const snapshot = this.livemap.initializedWorld(worldId)?.snapshot();
    const expectedTrainRunIds = blueprint.lots.flatMap((lot) => lot.trainRunIds);
    const expectedInitializationHash = operationalSimulationInitializationHash(
      deployment.regionalSimulation,
    );
    const operationalProgram = this.operationalPrograms.operationalProgramRegistration(
      worldId,
      deployment.regionalSimulation.regionId,
    );
    const operationalProgramReady = operationalProgram !== undefined
      && operationalProgram.deploymentHash === this.signed.deploymentHash
      && operationalProgram.initializationHash === expectedInitializationHash;
    const regionalSimulationReady = this.regionalSimulation.isReady(
      worldId,
      deployment.regionalSimulation.regionId,
      expectedInitializationHash,
    );
    const publicOperation = publicOperationSnapshotVerification(
      snapshot,
      expectedTrainRunIds,
      regionalSimulationReady
        && deployment.regionalSimulation.infraRelease.schemaVersion
          === OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA
        ? {
            regionId: deployment.regionalSimulation.regionId,
            infrastructureReleaseId: deployment.provenance.infraReleaseId,
          }
        : undefined,
    );
    return {
      economyReady: economy !== undefined && economy.publicOperations.size === blueprint.lots.length,
      fleetReady: fleet !== undefined
        && Object.keys(fleet.state.formations).length > 0
        && Object.keys(fleet.state.personnelDuties).length > 0
        && Object.keys(fleet.state.pathReservations).length > 0,
      regionalSimulationReady,
      operationalProgramReady,
      livemapReady: publicOperation.livemapReady,
      operationsCenterReady: operationsEvent.length === 1,
      odooProjectionQueued: projection.length === 1,
      lotIds: economy === undefined ? [] : [...economy.publicOperations.keys()],
      scheduledTrainRunIds: operationalProgramReady ? [...operationalProgram.trainRunIds] : [],
      runningTrainRunIds: publicOperation.runningTrainRunIds,
    };
  }
}

export async function startSignedAlphaWorld(
  db: AlphaDatabase,
  signed: SignedAlphaWorldDeployment,
  port: ProductionWorldStartPort,
) {
  return new AlphaWorldService(db, port).start(
    signed.deployment.worldId,
    signed.deployment.blueprint,
    0,
    signed.deploymentHash,
  );
}
