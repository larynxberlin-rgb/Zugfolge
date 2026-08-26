import { alphaHash } from "@zugfolge/alpha";
import {
  parsePlanningInfrastructureRelease,
  type PlanningInfrastructureRelease,
  type PlanningInfrastructureReleaseCatalog,
} from "@zugfolge/planning-worker";
import {
  FLEET_AUTHORITY_RELEASE_SCHEMA_V2,
  OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE,
  OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA,
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  assertOperationalTrainNumbers,
  operationalInfrastructureBindingsEqual,
  operationalProtectionModeSelectionEvidence,
  type FleetAuthorityRelease,
  type OperationalInfrastructureBinding,
  type OperationalDispatchRequest,
  type OperationalInitializationValidationReceipt,
  type OperationalSimulationInitialization,
  type OperationalTrainInitialization,
} from "@zugfolge/runtime-native";

import {
  validateAlphaVehicleCatalogBinding,
  type SignedAlphaWorldDeployment,
} from "./alpha-world-start.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";
import type { FleetAuthorityWorldConfiguration } from "./fleet-configuration.js";
import {
  REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT,
  type OperationalScheduledCommand,
  type OperationalScheduledCommandBoundary,
  type RegionalRealtimeRegistration,
  type RegionalScheduledCommandCatalog,
} from "./regional-simulation-scheduler.js";
import { compareUtf8 } from "./utf8.js";

function realtimeRegionKey(worldId: string, regionId: string): string {
  return `${worldId}\u0000${regionId}`;
}

interface OperationalProgramTrain {
  readonly train: OperationalTrainInitialization;
  readonly interlockingRouteId: string;
  readonly departureOffsetMs: number;
}

interface OperationalProgramBoundary {
  readonly departureOffsetMs: number;
  readonly trains: readonly OperationalProgramTrain[];
}

interface OperationalProgramPredecessor {
  readonly train: OperationalProgramTrain;
  readonly previousDay: boolean;
}

interface OperationalDeploymentProgram {
  readonly deploymentHash: string;
  readonly worldId: string;
  readonly regionId: string;
  readonly initializationHash: string;
  readonly initialization: OperationalSimulationInitialization;
  readonly repeatEveryMs: number;
  readonly trains: readonly OperationalProgramTrain[];
  readonly boundaries: readonly OperationalProgramBoundary[];
  readonly predecessors: ReadonlyMap<string, OperationalProgramPredecessor>;
}

function safeNonnegativeInteger(value: unknown, detail: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(detail);
  return value as number;
}

function validateNativeInitializationReceipt(
  worldId: string,
  initialization: OperationalSimulationInitialization,
  receipt: OperationalInitializationValidationReceipt | undefined,
): OperationalInitializationValidationReceipt {
  assertOperationalTrainNumbers(initialization.trains, "signiertes Operational-v2-Programm");
  const expectedRouteVersionCount = new Set(
    initialization.trains.map((train) => train.routeVersionId),
  ).size;
  const expectedDispatchInterlockingRouteCount = new Set(
    initialization.trains.map((train) => train.dispatchInterlockingRouteId),
  ).size;
  const expectedFormationBindingCount = new Set(
    initialization.trains.map((train) => train.formationVersionId),
  ).size;
  const protectionModeSelectionEvidence = operationalProtectionModeSelectionEvidence(initialization);
  if (
    receipt === undefined
    || receipt.schemaVersion !== OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA
    || receipt.worldId !== worldId
    || receipt.regionId !== initialization.regionId
    || receipt.initializationHash !== operationalSimulationInitializationHash(initialization)
    || !operationalInfrastructureBindingsEqual(receipt.infraRelease, initialization.infraRelease)
    || receipt.programTrainCount !== initialization.trains.length
    || receipt.validatedProgramTemplateCount !== initialization.trains.length
    || receipt.validatedRouteVersionCount !== expectedRouteVersionCount
    || receipt.validatedDispatchInterlockingRouteCount !== expectedDispatchInterlockingRouteCount
    || receipt.validatedFormationBindingCount !== expectedFormationBindingCount
    || receipt.validatedTrainNumberCount !== initialization.trains.length
    || initialization.protectionModeSelectionPolicy !== OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY
    || receipt.protectionModeSelectionPolicy !== initialization.protectionModeSelectionPolicy
    || receipt.validatedProtectionModeSelectionCount !== protectionModeSelectionEvidence.count
    || receipt.protectionModeSelectionsSha256 !== protectionModeSelectionEvidence.sha256
    || receipt.protectionModeSelectionsValidated !== true
    || !/^[a-f0-9]{64}$/u.test(receipt.stateHash)
    || receipt.dynamicTrainCount !== 0
    || receipt.resourceBindingsValidated !== true
    || receipt.formationBindingsValidated !== true
    || receipt.trainNumbersValidated !== true
    || receipt.validationMode !== OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE
    || (initialization.trains.length > 0 && (
      receipt.validatedRouteVersionCount <= 0
      || receipt.validatedDispatchInterlockingRouteCount <= 0
      || receipt.validatedResourceBindingCount <= 0
      || receipt.validatedFormationBindingCount <= 0
    ))
  ) {
    throw new Error("Signiertes Betriebsprogramm besitzt keinen passenden nativen Streaming-Pruefbeleg.");
  }
  return receipt;
}

export function validateNativeProgramReceipt(
  signed: SignedAlphaWorldDeployment,
  receipt: OperationalInitializationValidationReceipt | undefined,
): OperationalInitializationValidationReceipt {
  return validateNativeInitializationReceipt(
    signed.deployment.worldId,
    signed.deployment.regionalSimulation,
    receipt,
  );
}

function deploymentOperationalProgram(
  signed: SignedAlphaWorldDeployment,
  receipt: OperationalInitializationValidationReceipt | undefined,
): OperationalDeploymentProgram {
  const { deployment, deploymentHash } = signed;
  validateNativeProgramReceipt(signed, receipt);
  // Eine einzige private Kopie traegt sowohl Revalidation als auch die
  // wiederholbaren Zugvorlagen. Ein zweiter vollstaendiger Zugkorpus wuerde
  // gerade beim Deutschland-Catch-up unnoetig die Speichermarge verbrauchen.
  const initialization: OperationalSimulationInitialization = structuredClone(
    deployment.regionalSimulation,
  );
  const repeatEveryMs = deployment.repeatEveryS * 1_000;
  if (
    !Number.isSafeInteger(deployment.repeatEveryS)
    || deployment.repeatEveryS <= 0
    || !Number.isSafeInteger(repeatEveryMs)
    || initialization.nowMs !== 0
    || initialization.trains.length === 0
  ) {
    throw new Error("Signiertes Deployment besitzt keinen gueltigen wiederholbaren v2-Betriebstakt.");
  }
  const seen = new Set<string>();
  const formationDepartures = new Set<string>();
  const trains = initialization.trains.map((train): OperationalProgramTrain => {
    const departureOffsetMs = safeNonnegativeInteger(
      train.scheduledDepartureMs,
      `Fahrt '${train.id}' besitzt keine signierte Abfahrtsgrenze.`,
    );
    if (
      seen.has(train.id)
      || /:day-\d+$/u.test(train.id)
      || departureOffsetMs >= repeatEveryMs
    ) {
      throw new Error(`Fahrt '${train.id}' ist fuer die signierte Tageswiederholung ungueltig.`);
    }
    seen.add(train.id);
    const formationDeparture = `${train.formationVersionId}\u0000${departureOffsetMs}`;
    if (formationDepartures.has(formationDeparture)) {
      throw new Error(
        `Formation '${train.formationVersionId}' ist zur Betriebsprogrammgrenze '${departureOffsetMs}' mehrfach verplant.`,
      );
    }
    formationDepartures.add(formationDeparture);
    if (
      typeof train.dispatchInterlockingRouteId !== "string"
      || train.dispatchInterlockingRouteId.trim() === ""
    ) {
      throw new Error(`Fahrt '${train.id}' besitzt keine nativ validierte signierte Fahrstrasse.`);
    }
    return Object.freeze({
      train,
      interlockingRouteId: train.dispatchInterlockingRouteId,
      departureOffsetMs,
    });
  }).sort((left, right) =>
    left.departureOffsetMs - right.departureOffsetMs
    || compareUtf8(left.train.id, right.train.id));
  const trainsPerBoundary = new Map<number, OperationalProgramTrain[]>();
  for (const train of trains) {
    const boundary = trainsPerBoundary.get(train.departureOffsetMs) ?? [];
    boundary.push(train);
    trainsPerBoundary.set(train.departureOffsetMs, boundary);
  }
  const boundaries = [...trainsPerBoundary].map(([departureOffsetMs, boundaryTrains]) =>
    Object.freeze({
      departureOffsetMs,
      trains: Object.freeze(boundaryTrains),
    }));
  for (const { departureOffsetMs, trains: boundaryTrains } of boundaries) {
    // Im stationaeren Tageszyklus entstehen je Fahrt hoechstens Retire und
    // Materialize, dazu genau ein Dispatch sowie der Scheduler-Advance auf
    // dieselbe Millisekunde. Diese atomare Grenze darf spaeter nie aufgrund
    // einer blossen Speichergrenze geteilt werden muessen.
    const maximumBoundaryCommands = boundaryTrains.length * 2 + 2;
    if (maximumBoundaryCommands > REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT) {
      throw new Error(
        `Signierte Betriebsprogrammgrenze '${departureOffsetMs}' ueberschreitet mit ${maximumBoundaryCommands} atomaren Kommandos das Limit ${REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT}.`,
      );
    }
  }
  const formations = new Map<string, OperationalProgramTrain[]>();
  for (const train of trains) {
    const formation = formations.get(train.train.formationVersionId) ?? [];
    formation.push(train);
    formations.set(train.train.formationVersionId, formation);
  }
  const predecessors = new Map<string, OperationalProgramPredecessor>();
  for (const formation of formations.values()) {
    for (let index = 0; index < formation.length; index += 1) {
      predecessors.set(formation[index]!.train.id, Object.freeze({
        train: index === 0 ? formation.at(-1)! : formation[index - 1]!,
        previousDay: index === 0,
      }));
    }
  }
  return Object.freeze({
    deploymentHash,
    worldId: deployment.worldId,
    regionId: initialization.regionId,
    initializationHash: operationalSimulationInitializationHash(initialization),
    initialization,
    repeatEveryMs,
    trains: Object.freeze(trains),
    boundaries: Object.freeze(boundaries),
    predecessors,
  });
}

function recurringTrainId(baseId: string, day: number): string {
  return day === 0 ? baseId : `${baseId}:day-${day}`;
}

function predecessorTrain(
  program: OperationalDeploymentProgram,
  train: OperationalProgramTrain,
  day: number,
): { readonly train: OperationalProgramTrain; readonly day: number } | undefined {
  const predecessor = program.predecessors.get(train.train.id);
  if (predecessor === undefined) {
    throw new Error(`Fahrt '${train.train.id}' fehlt im signierten Betriebsprogramm.`);
  }
  if (predecessor.previousDay && day === 0) return undefined;
  return {
    train: predecessor.train,
    day: predecessor.previousDay ? day - 1 : day,
  };
}

function dispatchRequest(
  train: OperationalProgramTrain,
  trainId: string,
  atMs: number,
): OperationalDispatchRequest {
  return Object.freeze({
    trainId,
    interlockingRouteId: train.interlockingRouteId,
    committedRank: 0,
    timetableDeviationMs: 0,
    passengerImpact: 0,
    contractualImpact: 0,
    networkImpact: 0,
    resourceConsequence: 0,
    recoveryRank: 0,
    waitingSinceMs: atMs,
  });
}

function boundaryCommands(
  program: OperationalDeploymentProgram,
  boundary: OperationalProgramBoundary,
  day: number,
): readonly OperationalScheduledCommand[] {
  const { departureOffsetMs, trains } = boundary;
  const atMs = departureOffsetMs + day * program.repeatEveryMs;
  if (!Number.isSafeInteger(atMs)) throw new RangeError("Betriebsprogrammgrenze liegt ausserhalb des sicheren Bereichs.");
  const prefix = `${program.deploymentHash}:operational:${program.regionId}:${day}:${departureOffsetMs}`;
  const commands: OperationalScheduledCommand[] = [];
  for (const train of trains) {
    const predecessor = predecessorTrain(program, train, day);
    if (predecessor !== undefined) {
      commands.push(Object.freeze({
        commandId: `${prefix}:retire:${train.train.id}`,
        atMs,
        command: Object.freeze({
          type: "retire",
          trainId: recurringTrainId(predecessor.train.train.id, predecessor.day),
        }),
      }));
    }
    commands.push(Object.freeze({
      commandId: `${prefix}:materialize:${train.train.id}`,
      atMs,
      command: Object.freeze({
        type: "materialize",
        train: Object.freeze({
          ...structuredClone(train.train),
          id: recurringTrainId(train.train.id, day),
          scheduledDepartureMs: atMs,
        }),
      }),
    }));
  }
  commands.push(Object.freeze({
    commandId: `${prefix}:dispatch`,
    atMs,
    command: Object.freeze({
      type: "dispatch",
      requests: Object.freeze(trains.map((train) => dispatchRequest(
        train,
        recurringTrainId(train.train.id, day),
        atMs,
      ))),
    }),
  }));
  return Object.freeze(commands);
}

class PlanningInfrastructureReleaseRegistry implements PlanningInfrastructureReleaseCatalog {
  readonly #releases = new Map<string, PlanningInfrastructureRelease>();
  readonly #hashes = new Map<string, string>();

  constructor(initial: readonly unknown[]) {
    for (const release of initial) this.register(release);
  }

  register(value: unknown): PlanningInfrastructureRelease {
    const release = parsePlanningInfrastructureRelease(value);
    const key = `${release.worldId}\u0000${release.releaseId}`;
    const hash = alphaHash("zugfolge-planning-infrastructure-release/v1", release);
    const existingHash = this.#hashes.get(key);
    if (existingHash !== undefined && existingHash !== hash) {
      throw new Error(`Planning-Infrastrukturrelease '${release.releaseId}' steht fuer Welt '${release.worldId}' im Konflikt.`);
    }
    if (existingHash === undefined) {
      this.#hashes.set(key, hash);
      this.#releases.set(key, structuredClone(release));
    }
    return this.#releases.get(key)!;
  }

  get(worldId: string, releaseId: string): PlanningInfrastructureRelease | undefined {
    return this.#releases.get(`${worldId}\u0000${releaseId}`);
  }

  releaseWorld(worldId: string): void {
    const prefix = `${worldId}\u0000`;
    for (const key of this.#releases.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.#releases.delete(key);
      this.#hashes.delete(key);
    }
  }
}

export interface ActiveWorldRuntimeSeed {
  readonly activeWorlds: readonly { readonly worldId: string; readonly epoch: Date }[];
  /** Reiner nativer Preflight: validiert die externe Operational-v2-Datei und materialisiert keine Zugzustaende. */
  readonly operationalProgramPreflight: (
    initialization: OperationalSimulationInitialization,
  ) => OperationalInitializationValidationReceipt;
  readonly fleetAuthorityConfigurations?: Readonly<Record<string, FleetAuthorityWorldConfiguration>>;
  /** Legacy-Test-/Bootstrap-Pfad: fehlende Zeitbindung bedeutet ausschliesslich t=0. */
  readonly fleetAuthorityReleases?: Readonly<Record<string, FleetAuthorityRelease>>;
  readonly planningAuthorityAccountIds?: Readonly<Record<string, string>>;
  readonly planningInfrastructureReleases?: readonly unknown[];
}

/**
 * Prozesslokale Projektion ausschliesslich aktiver, signierter Weltvertraege.
 * Ihre Quellen bleiben das persistierte Deployment bzw. explizite Legacy-
 * Startkonfiguration; die Registry erfindet keine Authority-Fakten.
 */
export class ActiveWorldDeploymentRuntime implements RegionalScheduledCommandCatalog {
  readonly fleetAuthorityConfigurations: Record<string, FleetAuthorityWorldConfiguration>;
  readonly fleetAuthorityReleases: Record<string, FleetAuthorityRelease>;
  readonly planningAuthorityAccountIds: Record<string, string>;
  readonly planningInfrastructureReleases: PlanningInfrastructureReleaseCatalog;
  readonly worldEpochs = new Map<string, Date>();

  readonly #activeWorldIds = new Set<string>();
  readonly #realtimeWorldIds = new Set<string>();
  readonly #deploymentHashes = new Map<string, string>();
  readonly #realtimeRegions = new Map<string, RegionalRealtimeRegistration>();
  readonly #operationalPrograms = new Map<string, OperationalDeploymentProgram>();
  readonly #operationalInfrastructure = new Map<string, OperationalInfrastructureBinding>();
  readonly #committedOperationalProgramKeys = new Set<string>();
  readonly #planningRegistry: PlanningInfrastructureReleaseRegistry;
  readonly #operationalProgramPreflight: ActiveWorldRuntimeSeed["operationalProgramPreflight"];

  constructor(seed: ActiveWorldRuntimeSeed) {
    this.#operationalProgramPreflight = seed.operationalProgramPreflight;
    this.fleetAuthorityConfigurations = { ...(seed.fleetAuthorityConfigurations ?? {}) };
    for (const [worldId, authorityRelease] of Object.entries(seed.fleetAuthorityReleases ?? {})) {
      if (this.fleetAuthorityConfigurations[worldId] === undefined) {
        this.fleetAuthorityConfigurations[worldId] = { producedAt: 0, authorityRelease };
      }
    }
    this.fleetAuthorityReleases = Object.fromEntries(
      Object.entries(this.fleetAuthorityConfigurations).map(([worldId, configuration]) => [
        worldId,
        configuration.authorityRelease,
      ]),
    );
    this.planningAuthorityAccountIds = { ...(seed.planningAuthorityAccountIds ?? {}) };
    this.#planningRegistry = new PlanningInfrastructureReleaseRegistry(seed.planningInfrastructureReleases ?? []);
    this.planningInfrastructureReleases = this.#planningRegistry;
    for (const world of seed.activeWorlds) {
      if (Number.isNaN(world.epoch.getTime())) throw new Error(`Weltepoche fuer '${world.worldId}' ist ungueltig.`);
      this.#activeWorldIds.add(world.worldId);
      this.worldEpochs.set(world.worldId, new Date(world.epoch));
    }
  }

  /**
   * Registriert nur das nativ validierte Schedulerprogramm fuer den harten
   * Weltstart-Gate. Der Aufrufer muss bei einem vor-dauerhaften Startfehler den
   * zurueckgegebenen Lease zurueckrollen; `register` vervollstaendigt danach
   * die aktive Runtimeprojektion idempotent.
   */
  prepareOperationalProgram(signed: SignedAlphaWorldDeployment): { readonly rollback: () => void } {
    validateAlphaVehicleCatalogBinding(signed.deployment);
    const key = realtimeRegionKey(
      signed.deployment.worldId,
      signed.deployment.regionalSimulation.regionId,
    );
    const expectedInitializationHash = operationalSimulationInitializationHash(
      signed.deployment.regionalSimulation,
    );
    const existing = this.#operationalPrograms.get(key);
    if (existing !== undefined) {
      if (
        existing.deploymentHash !== signed.deploymentHash
        || existing.initializationHash !== expectedInitializationHash
      ) {
        throw new Error(`Betriebsprogramm fuer '${existing.worldId}/${existing.regionId}' steht im Konflikt.`);
      }
      return Object.freeze({ rollback: () => undefined });
    }
    const program = deploymentOperationalProgram(
      signed,
      this.#operationalProgramPreflight(signed.deployment.regionalSimulation),
    );
    this.#operationalPrograms.set(key, program);
    let owned = true;
    return Object.freeze({
      rollback: () => {
        if (
          owned
          && !this.#committedOperationalProgramKeys.has(key)
          && this.#operationalPrograms.get(key) === program
        ) {
          this.#operationalPrograms.delete(key);
        }
        owned = false;
      },
    });
  }

  operationalProgramRegistration(
    worldId: string,
    regionId: string,
  ): Readonly<{
    deploymentHash: string;
    initializationHash: string;
    trainRunIds: readonly string[];
  }> | undefined {
    const program = this.#operationalPrograms.get(realtimeRegionKey(worldId, regionId));
    if (program === undefined) return undefined;
    return Object.freeze({
      deploymentHash: program.deploymentHash,
      initializationHash: program.initializationHash,
      trainRunIds: Object.freeze(program.trains.map(({ train }) => train.id)),
    });
  }

  operationalInfrastructureBinding(
    worldId: string,
    regionId: string,
  ): OperationalInfrastructureBinding | undefined {
    const binding = this.#operationalInfrastructure.get(realtimeRegionKey(worldId, regionId));
    return binding === undefined ? undefined : Object.freeze(structuredClone(binding));
  }

  /**
   * Revalidiert ausschliesslich den bereits signierten, unveraenderten
   * Deployment-Kopf. Ein anderer Operational-v2-Kopf waere ohne gleichzeitige
   * Planning- und Livemap-Bindung ein Split-Brain und braucht deshalb ein
   * vollstaendig neues signiertes Deployment.
   */
  revalidateOperationalInfrastructure(
    worldId: string,
    expected: OperationalInfrastructureBinding,
  ): void {
    const programs = [...this.#operationalPrograms.entries()]
      .filter(([, program]) => program.worldId === worldId)
      .sort(([left], [right]) => compareUtf8(left, right));
    if (programs.length === 0) {
      throw new Error(`Aktive Welt '${worldId}' besitzt kein signiertes Operational-v2-Programm.`);
    }
    for (const [key, program] of programs) {
      const current = this.#operationalInfrastructure.get(key);
      if (
        current === undefined
        || !operationalInfrastructureBindingsEqual(current, expected)
        || !operationalInfrastructureBindingsEqual(program.initialization.infraRelease, expected)
      ) {
        throw new Error(
          `Operational-v2-Registry fuer '${program.worldId}/${program.regionId}' weicht vom signierten Deployment ab; eine Aenderung erfordert ein vollstaendig signiertes Deployment-Cutover inklusive Planning und Livemap.`,
        );
      }
      validateNativeInitializationReceipt(
        worldId,
        program.initialization,
        this.#operationalProgramPreflight(program.initialization),
      );
    }
  }

  /** Idempotente Live- oder Restart-Projektion eines bereits aktiven Deployments. */
  register(signed: SignedAlphaWorldDeployment, epoch: Date): void {
    const { deployment, deploymentHash } = signed;
    validateAlphaVehicleCatalogBinding(deployment);
    const signedEpoch = new Date(deployment.worldDefinition.epoch);
    if (Number.isNaN(epoch.getTime()) || epoch.getTime() !== signedEpoch.getTime()) {
      throw new Error(`Weltepoche fuer '${deployment.worldId}' weicht vom signierten Deployment ab.`);
    }
    const existingHash = this.#deploymentHashes.get(deployment.worldId);
    if (existingHash !== undefined && existingHash !== deploymentHash) {
      throw new Error(`Aktive Welt '${deployment.worldId}' besitzt bereits ein anderes Deployment.`);
    }
    const operationalProgramKey = realtimeRegionKey(
      deployment.worldId,
      deployment.regionalSimulation.regionId,
    );
    const expectedInitializationHash = operationalSimulationInitializationHash(
      deployment.regionalSimulation,
    );
    const preparedOperationalProgram = this.#operationalPrograms.get(operationalProgramKey);
    if (
      preparedOperationalProgram !== undefined
      && (
        preparedOperationalProgram.deploymentHash !== deploymentHash
        || preparedOperationalProgram.initializationHash !== expectedInitializationHash
      )
    ) {
      throw new Error(`Betriebsprogramm fuer '${deployment.worldId}/${deployment.regionalSimulation.regionId}' steht im Konflikt.`);
    }
    const operationalProgram = preparedOperationalProgram ?? deploymentOperationalProgram(
      signed,
      this.#operationalProgramPreflight(deployment.regionalSimulation),
    );
    const fleetHash = alphaHash("zugfolge-fleet-authority-runtime/v1", deployment.fleet.authorityRelease);
    const existingFleet = this.fleetAuthorityConfigurations[deployment.worldId];
    if (existingFleet !== undefined && (
      alphaHash("zugfolge-fleet-authority-runtime/v1", existingFleet.authorityRelease) !== fleetHash
      || existingFleet.producedAt !== deployment.fleet.producedAt
    )) {
      throw new Error(`Fleet-Authority oder Seed-Zeit fuer '${deployment.worldId}' steht im Konflikt zum signierten Deployment.`);
    }
    const authorityId = deployment.planning.authority.accountId;
    const existingAuthority = this.planningAuthorityAccountIds[deployment.worldId];
    if (existingAuthority !== undefined && existingAuthority !== authorityId) {
      throw new Error(`Planning-Authority fuer '${deployment.worldId}' steht im Konflikt zum signierten Deployment.`);
    }
    this.#planningRegistry.register(deployment.planning.infrastructureRelease);
    this.fleetAuthorityConfigurations[deployment.worldId] = {
      producedAt: deployment.fleet.producedAt,
      authorityRelease: deployment.fleet.authorityRelease,
    };
    this.fleetAuthorityReleases[deployment.worldId] = deployment.fleet.authorityRelease;
    this.planningAuthorityAccountIds[deployment.worldId] = authorityId;
    this.worldEpochs.set(deployment.worldId, new Date(epoch));
    const region = Object.freeze({
      worldId: deployment.worldId,
      regionId: deployment.regionalSimulation.regionId,
      initializationHash: operationalSimulationInitializationHash(
        deployment.regionalSimulation,
      ),
    });
    this.#realtimeRegions.set(
      realtimeRegionKey(region.worldId, region.regionId),
      region,
    );
    this.#operationalPrograms.set(operationalProgramKey, operationalProgram);
    if (!this.#operationalInfrastructure.has(operationalProgramKey)) {
      this.#operationalInfrastructure.set(
        operationalProgramKey,
        structuredClone(deployment.regionalSimulation.infraRelease),
      );
    }
    this.#committedOperationalProgramKeys.add(operationalProgramKey);
    this.#realtimeWorldIds.add(deployment.worldId);
    this.#activeWorldIds.add(deployment.worldId);
    this.#deploymentHashes.set(deployment.worldId, deploymentHash);
  }

  /** Authority v2 darf erst nach erfolgreicher Signatur- und Binderpruefung starten. */
  assertVehicleCatalogDeploymentBindings(
    signedDeployments: ReadonlyMap<string, SignedAlphaWorldDeployment>,
  ): void {
    for (const [worldId, configuration] of Object.entries(this.fleetAuthorityConfigurations)) {
      if (configuration.authorityRelease.schemaVersion !== FLEET_AUTHORITY_RELEASE_SCHEMA_V2) {
        continue;
      }
      const signed = signedDeployments.get(worldId);
      if (signed === undefined) {
        throw new Error(
          `Authority-v2 fuer '${worldId}' besitzt kein verifiziertes signiertes Fahrzeugkatalog-Deployment.`,
        );
      }
      validateAlphaVehicleCatalogBinding(signed.deployment);
      if (
        signed.deployment.worldId !== worldId
        || signed.deployment.fleet.producedAt !== configuration.producedAt
        || alphaHash("zugfolge-fleet-authority-runtime/v1", signed.deployment.fleet.authorityRelease)
          !== alphaHash("zugfolge-fleet-authority-runtime/v1", configuration.authorityRelease)
      ) {
        throw new Error(
          `Authority-v2 fuer '${worldId}' steht im Konflikt zum verifizierten signierten Deployment.`,
        );
      }
    }
  }

  worldIds(): readonly string[] {
    return [...this.#activeWorldIds].sort(compareUtf8);
  }

  /** Nur signierte 1:1-Deployments, niemals bloss restaurierte Laufzeitregionen. */
  realtimeRegions(): readonly RegionalRealtimeRegistration[] {
    return [...this.#realtimeRegions.values()].sort(
      (left, right) =>
        compareUtf8(left.worldId, right.worldId) ||
        compareUtf8(left.regionId, right.regionId),
    );
  }

  at(worldId: string, regionId: string, atMs: number): readonly OperationalScheduledCommand[] {
    const program = this.#operationalPrograms.get(realtimeRegionKey(worldId, regionId));
    if (program === undefined) return [];
    safeNonnegativeInteger(atMs, "Betriebsprogrammzeit ist ungueltig.");
    const commands: OperationalScheduledCommand[] = [];
    for (const boundary of program.boundaries) {
      if (atMs < boundary.departureOffsetMs) continue;
      const elapsed = atMs - boundary.departureOffsetMs;
      if (elapsed % program.repeatEveryMs !== 0) continue;
      commands.push(...boundaryCommands(program, boundary, elapsed / program.repeatEveryMs));
    }
    return Object.freeze(commands);
  }

  *dueBoundaries(
    worldId: string,
    regionId: string,
    afterMs: number,
    throughMs: number,
  ): IterableIterator<OperationalScheduledCommandBoundary> {
    const program = this.#operationalPrograms.get(realtimeRegionKey(worldId, regionId));
    if (program === undefined) return;
    safeNonnegativeInteger(afterMs, "Betriebsprogrammstart ist ungueltig.");
    safeNonnegativeInteger(throughMs, "Betriebsprogrammende ist ungueltig.");
    if (throughMs < afterMs) throw new RangeError("Betriebsprogrammende liegt vor dem Start.");
    const firstDay = Math.max(0, Math.floor(afterMs / program.repeatEveryMs));
    const lastDay = Math.floor(throughMs / program.repeatEveryMs);
    for (let day = firstDay; day <= lastDay; day += 1) {
      for (const boundary of program.boundaries) {
        const atMs = boundary.departureOffsetMs + day * program.repeatEveryMs;
        if (!Number.isSafeInteger(atMs)) {
          throw new RangeError("Betriebsprogrammgrenze liegt ausserhalb des sicheren Bereichs.");
        }
        if (atMs <= afterMs || atMs > throughMs) continue;
        yield Object.freeze({
          atMs,
          commands: boundaryCommands(program, boundary, day),
        });
      }
    }
  }

  /** Weltkennungen mit einem verifizierten, explizit registrierten 1:1-Takt. */
  realtimeWorldIds(): readonly string[] {
    return [...this.#realtimeWorldIds].sort(compareUtf8);
  }

  isRealtimeWorld(worldId: string): boolean {
    return this.#realtimeWorldIds.has(worldId);
  }

  /** Entfernt nur die prozesslokale Projektion einer dauerhaft archivierten Welt. */
  releaseWorld(worldId: string): void {
    const prefix = `${worldId}\u0000`;
    this.#activeWorldIds.delete(worldId);
    this.#realtimeWorldIds.delete(worldId);
    this.#deploymentHashes.delete(worldId);
    this.worldEpochs.delete(worldId);
    delete this.fleetAuthorityConfigurations[worldId];
    delete this.fleetAuthorityReleases[worldId];
    delete this.planningAuthorityAccountIds[worldId];
    this.#planningRegistry.releaseWorld(worldId);
    for (const key of this.#realtimeRegions.keys()) {
      if (key.startsWith(prefix)) this.#realtimeRegions.delete(key);
    }
    for (const key of this.#operationalPrograms.keys()) {
      if (key.startsWith(prefix)) this.#operationalPrograms.delete(key);
    }
    for (const key of this.#operationalInfrastructure.keys()) {
      if (key.startsWith(prefix)) this.#operationalInfrastructure.delete(key);
    }
    for (const key of this.#committedOperationalProgramKeys) {
      if (key.startsWith(prefix)) this.#committedOperationalProgramKeys.delete(key);
    }
  }

  /** Global freshness gilt erst ab der signierten Epoche einer Echtzeitwelt. */
  expectsLivemapFreshness(worldId: string, nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) throw new RangeError("Livemap-Pruefzeit ist ungueltig.");
    const epoch = this.worldEpochs.get(worldId);
    return this.#realtimeWorldIds.has(worldId)
      && epoch !== undefined
      && epoch.getTime() <= nowMs;
  }
}
