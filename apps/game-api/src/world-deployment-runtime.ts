import { alphaHash } from "@zugfolge/alpha";
import {
  parsePlanningInfrastructureRelease,
  type PlanningInfrastructureRelease,
  type PlanningInfrastructureReleaseCatalog,
} from "@zugfolge/planning-worker";
import type {
  FleetAuthorityRelease,
  OperationalDispatchRequest,
  OperationalSimulationInitialization,
  OperationalTrainInitialization,
} from "@zugfolge/runtime-native";

import type { SignedAlphaWorldDeployment } from "./alpha-world-start.js";
import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";
import type {
  OperationalScheduledCommand,
  RegionalRealtimeRegistration,
  RegionalScheduledCommandCatalog,
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

interface OperationalDeploymentProgram {
  readonly deploymentHash: string;
  readonly worldId: string;
  readonly regionId: string;
  readonly repeatEveryMs: number;
  readonly trains: readonly OperationalProgramTrain[];
}

function object(value: unknown, detail: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(detail);
  return value as Readonly<Record<string, unknown>>;
}

function safeNonnegativeInteger(value: unknown, detail: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(detail);
  return value as number;
}

function routeLengthMm(route: Readonly<Record<string, unknown>>): number {
  if (!Array.isArray(route["legs"]) || route["legs"].length === 0) {
    throw new Error("Signiertes Betriebsprogramm besitzt keinen vollstaendigen Laufweg.");
  }
  const last = object(route["legs"].at(-1), "Signiertes Betriebsprogramm besitzt ein ungueltiges Laufwegende.");
  const start = safeNonnegativeInteger(last["routeStartMm"], "Laufwegstart ist ungueltig.");
  const entry = safeNonnegativeInteger(last["edgeEntryMm"], "Laufwegeintritt ist ungueltig.");
  const exit = safeNonnegativeInteger(last["edgeExitMm"], "Laufwegaustritt ist ungueltig.");
  const length = start + Math.abs(exit - entry);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error("Laufweglaenge ist ungueltig.");
  return length;
}

function deploymentFormationLengthsMm(
  initialization: OperationalSimulationInitialization,
): ReadonlyMap<string, number> {
  const vehicleTypeLengths = new Map<string, number>();
  for (const rawEntry of initialization.vehicleTypes) {
    const entry = object(rawEntry, "Signiertes Betriebsprogramm besitzt einen ungueltigen Fahrzeugtypeintrag.");
    const vehicleType = object(
      entry["vehicleType"],
      "Signiertes Betriebsprogramm besitzt einen ungueltigen Fahrzeugtyp.",
    );
    const vehicleTypeId = vehicleType["id"];
    const lengthMm = safeNonnegativeInteger(
      vehicleType["lengthMm"],
      "Signierter Fahrzeugtyp besitzt keine gueltige Laenge.",
    );
    if (typeof vehicleTypeId !== "string" || vehicleTypeId.length === 0 || lengthMm === 0) {
      throw new Error("Signierter Fahrzeugtyp besitzt keine gueltige Kennung oder Laenge.");
    }
    if (vehicleTypeLengths.has(vehicleTypeId)) {
      throw new Error(`Signierter Fahrzeugtyp '${vehicleTypeId}' ist nicht eindeutig.`);
    }
    vehicleTypeLengths.set(vehicleTypeId, lengthMm);
  }

  const vehicleLengths = new Map<string, number>();
  for (const rawVehicle of initialization.vehicles) {
    const vehicle = object(rawVehicle, "Signiertes Betriebsprogramm besitzt ein ungueltiges Fahrzeug.");
    const vehicleId = vehicle["id"];
    const vehicleTypeId = vehicle["typeId"];
    if (
      typeof vehicleId !== "string"
      || vehicleId.length === 0
      || typeof vehicleTypeId !== "string"
      || vehicleTypeId.length === 0
    ) {
      throw new Error("Signiertes Fahrzeug besitzt keine gueltige Kennung oder Typbindung.");
    }
    const lengthMm = vehicleTypeLengths.get(vehicleTypeId);
    if (lengthMm === undefined) {
      throw new Error(`Fahrzeug '${vehicleId}' verweist auf keinen signierten Fahrzeugtyp.`);
    }
    if (vehicleLengths.has(vehicleId)) {
      throw new Error(`Signiertes Fahrzeug '${vehicleId}' ist nicht eindeutig.`);
    }
    vehicleLengths.set(vehicleId, lengthMm);
  }

  const formationLengths = new Map<string, number>();
  for (const formation of initialization.formations) {
    if (formation.id.length === 0 || formation.vehicleIds.length === 0) {
      throw new Error("Signierte Formation besitzt keine gueltige Kennung oder Fahrzeuge.");
    }
    if (formationLengths.has(formation.id)) {
      throw new Error(`Signierte Formation '${formation.id}' ist nicht eindeutig.`);
    }
    let lengthMm = 0;
    for (const vehicleId of formation.vehicleIds) {
      const vehicleLengthMm = vehicleLengths.get(vehicleId);
      if (vehicleLengthMm === undefined) {
        throw new Error(`Formation '${formation.id}' verweist auf kein signiertes Fahrzeug '${vehicleId}'.`);
      }
      lengthMm += vehicleLengthMm;
      if (!Number.isSafeInteger(lengthMm)) {
        throw new Error(`Formation '${formation.id}' ueberschreitet den sicheren Laengenbereich.`);
      }
    }
    formationLengths.set(formation.id, lengthMm);
  }
  return formationLengths;
}

function deploymentOperationalProgram(
  signed: SignedAlphaWorldDeployment,
): OperationalDeploymentProgram {
  const { deployment, deploymentHash } = signed;
  const initialization: OperationalSimulationInitialization = deployment.regionalSimulation;
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
  const infra = object(initialization.infraRelease, "Signiertes Betriebsprogramm besitzt kein operatives InfraRelease.");
  const routes = object(infra["routeVersions"], "Signiertes Betriebsprogramm besitzt keine Laufwegversionen.");
  const interlockingRoutes = object(
    infra["interlockingRoutes"],
    "Signiertes Betriebsprogramm besitzt keine Fahrstrassenvorlagen.",
  );
  const formationLengthsMm = deploymentFormationLengthsMm(initialization);
  const seen = new Set<string>();
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
    const route = object(routes[train.routeVersionId], `Fahrt '${train.id}' besitzt keinen signierten Laufweg.`);
    const templateId = route["templateId"];
    const lengthMm = routeLengthMm(route);
    const formationLengthMm = formationLengthsMm.get(train.formationVersionId);
    if (formationLengthMm === undefined) {
      throw new Error(`Fahrt '${train.id}' besitzt keine signierte Formation.`);
    }
    const tailAtRouteEndMm = lengthMm - formationLengthMm;
    if (tailAtRouteEndMm < 0) {
      throw new Error(`Fahrt '${train.id}' ist laenger als ihr signierter Laufweg.`);
    }
    const completeCandidates = Object.values(interlockingRoutes)
      .map((value) => object(value, "Signierte Fahrstrassenvorlage ist ungueltig."))
      .filter((candidate) =>
        candidate["routeTemplateId"] === templateId
        && candidate["movementKind"] === train.movementKind
        && candidate["authorityEndRouteMm"] === lengthMm
        && typeof candidate["id"] === "string"
        && candidate["id"].length > 0);
    if (completeCandidates.length === 0) {
      throw new Error(`Fahrt '${train.id}' besitzt keine vollstaendige signierte Fahrstrasse bis zum Laufwegende.`);
    }
    const candidates = completeCandidates
      .filter((candidate) => safeNonnegativeInteger(
        candidate["releaseAfterTailRouteMm"],
        `Fahrstrasse '${String(candidate["id"])}' besitzt keine gueltige Freigabegrenze.`,
      ) <= tailAtRouteEndMm)
      .map((candidate) => candidate["id"] as string)
      .sort(compareUtf8);
    if (candidates.length === 0) {
      throw new Error(
        `Fahrt '${train.id}' kann ihre signierte Fahrstrasse am Laufwegende mit ihrer Formation nicht freigeben.`,
      );
    }
    return Object.freeze({
      train: structuredClone(train),
      interlockingRouteId: candidates[0]!,
      departureOffsetMs,
    });
  }).sort((left, right) =>
    left.departureOffsetMs - right.departureOffsetMs
    || compareUtf8(left.train.id, right.train.id));
  return Object.freeze({
    deploymentHash,
    worldId: deployment.worldId,
    regionId: initialization.regionId,
    repeatEveryMs,
    trains: Object.freeze(trains),
  });
}

function recurringTrainId(baseId: string, day: number): string {
  return day === 0 ? baseId : `${baseId}:day-${day}`;
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
  departureOffsetMs: number,
  day: number,
): readonly OperationalScheduledCommand[] {
  const atMs = departureOffsetMs + day * program.repeatEveryMs;
  if (!Number.isSafeInteger(atMs)) throw new RangeError("Betriebsprogrammgrenze liegt ausserhalb des sicheren Bereichs.");
  const trains = program.trains.filter((train) => train.departureOffsetMs === departureOffsetMs);
  const prefix = `${program.deploymentHash}:operational:${program.regionId}:${day}:${departureOffsetMs}`;
  const commands: OperationalScheduledCommand[] = [];
  if (day > 0) {
    for (const train of trains) {
      commands.push(Object.freeze({
        commandId: `${prefix}:retire:${train.train.id}`,
        atMs,
        command: Object.freeze({
          type: "retire",
          trainId: recurringTrainId(train.train.id, day - 1),
        }),
      }));
    }
    for (const train of trains) {
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
}

export interface ActiveWorldRuntimeSeed {
  readonly activeWorlds: readonly { readonly worldId: string; readonly epoch: Date }[];
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
  readonly fleetAuthorityReleases: Record<string, FleetAuthorityRelease>;
  readonly planningAuthorityAccountIds: Record<string, string>;
  readonly planningInfrastructureReleases: PlanningInfrastructureReleaseCatalog;
  readonly worldEpochs = new Map<string, Date>();

  readonly #activeWorldIds = new Set<string>();
  readonly #realtimeWorldIds = new Set<string>();
  readonly #deploymentHashes = new Map<string, string>();
  readonly #realtimeRegions = new Map<string, RegionalRealtimeRegistration>();
  readonly #operationalPrograms = new Map<string, OperationalDeploymentProgram>();
  readonly #planningRegistry: PlanningInfrastructureReleaseRegistry;

  constructor(seed: ActiveWorldRuntimeSeed) {
    this.fleetAuthorityReleases = { ...(seed.fleetAuthorityReleases ?? {}) };
    this.planningAuthorityAccountIds = { ...(seed.planningAuthorityAccountIds ?? {}) };
    this.#planningRegistry = new PlanningInfrastructureReleaseRegistry(seed.planningInfrastructureReleases ?? []);
    this.planningInfrastructureReleases = this.#planningRegistry;
    for (const world of seed.activeWorlds) {
      if (Number.isNaN(world.epoch.getTime())) throw new Error(`Weltepoche fuer '${world.worldId}' ist ungueltig.`);
      this.#activeWorldIds.add(world.worldId);
      this.worldEpochs.set(world.worldId, new Date(world.epoch));
    }
  }

  /** Idempotente Live- oder Restart-Projektion eines bereits aktiven Deployments. */
  register(signed: SignedAlphaWorldDeployment, epoch: Date): void {
    const { deployment, deploymentHash } = signed;
    const signedEpoch = new Date(deployment.worldDefinition.epoch);
    if (Number.isNaN(epoch.getTime()) || epoch.getTime() !== signedEpoch.getTime()) {
      throw new Error(`Weltepoche fuer '${deployment.worldId}' weicht vom signierten Deployment ab.`);
    }
    const existingHash = this.#deploymentHashes.get(deployment.worldId);
    if (existingHash !== undefined && existingHash !== deploymentHash) {
      throw new Error(`Aktive Welt '${deployment.worldId}' besitzt bereits ein anderes Deployment.`);
    }
    const operationalProgram = deploymentOperationalProgram(signed);
    const fleetHash = alphaHash("zugfolge-fleet-authority-runtime/v1", deployment.fleet.authorityRelease);
    const existingFleet = this.fleetAuthorityReleases[deployment.worldId];
    if (existingFleet !== undefined && alphaHash("zugfolge-fleet-authority-runtime/v1", existingFleet) !== fleetHash) {
      throw new Error(`Fleet-Authority fuer '${deployment.worldId}' steht im Konflikt zum signierten Deployment.`);
    }
    const authorityId = deployment.planning.authority.accountId;
    const existingAuthority = this.planningAuthorityAccountIds[deployment.worldId];
    if (existingAuthority !== undefined && existingAuthority !== authorityId) {
      throw new Error(`Planning-Authority fuer '${deployment.worldId}' steht im Konflikt zum signierten Deployment.`);
    }
    this.#planningRegistry.register(deployment.planning.infrastructureRelease);
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
    this.#operationalPrograms.set(
      realtimeRegionKey(region.worldId, region.regionId),
      operationalProgram,
    );
    this.#realtimeWorldIds.add(deployment.worldId);
    this.#activeWorldIds.add(deployment.worldId);
    this.#deploymentHashes.set(deployment.worldId, deploymentHash);
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
    for (const departureOffsetMs of new Set(program.trains.map((train) => train.departureOffsetMs))) {
      if (atMs < departureOffsetMs) continue;
      const elapsed = atMs - departureOffsetMs;
      if (elapsed % program.repeatEveryMs !== 0) continue;
      commands.push(...boundaryCommands(program, departureOffsetMs, elapsed / program.repeatEveryMs));
    }
    return Object.freeze(commands);
  }

  due(
    worldId: string,
    regionId: string,
    afterMs: number,
    throughMs: number,
  ): readonly OperationalScheduledCommand[] {
    const program = this.#operationalPrograms.get(realtimeRegionKey(worldId, regionId));
    if (program === undefined) return [];
    safeNonnegativeInteger(afterMs, "Betriebsprogrammstart ist ungueltig.");
    safeNonnegativeInteger(throughMs, "Betriebsprogrammende ist ungueltig.");
    if (throughMs < afterMs) throw new RangeError("Betriebsprogrammende liegt vor dem Start.");
    const boundaries: Array<{ departureOffsetMs: number; day: number; atMs: number }> = [];
    for (const departureOffsetMs of new Set(program.trains.map((train) => train.departureOffsetMs))) {
      const firstDay = Math.max(0, Math.floor((afterMs - departureOffsetMs) / program.repeatEveryMs) + 1);
      const lastDay = Math.floor((throughMs - departureOffsetMs) / program.repeatEveryMs);
      for (let day = firstDay; day <= lastDay; day += 1) {
        const atMs = departureOffsetMs + day * program.repeatEveryMs;
        if (!Number.isSafeInteger(atMs)) throw new RangeError("Betriebsprogrammgrenze liegt ausserhalb des sicheren Bereichs.");
        boundaries.push({ departureOffsetMs, day, atMs });
      }
    }
    boundaries.sort((left, right) =>
      left.atMs - right.atMs || left.departureOffsetMs - right.departureOffsetMs);
    const commands = boundaries.flatMap(({ departureOffsetMs, day }) =>
      boundaryCommands(program, departureOffsetMs, day));
    return Object.freeze(commands);
  }

  /** Weltkennungen mit einem verifizierten, explizit registrierten 1:1-Takt. */
  realtimeWorldIds(): readonly string[] {
    return [...this.#realtimeWorldIds].sort(compareUtf8);
  }

  isRealtimeWorld(worldId: string): boolean {
    return this.#realtimeWorldIds.has(worldId);
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
