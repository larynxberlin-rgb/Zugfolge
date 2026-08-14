import { alphaHash } from "@zugfolge/alpha";
import {
  parsePlanningInfrastructureRelease,
  type PlanningInfrastructureRelease,
  type PlanningInfrastructureReleaseCatalog,
} from "@zugfolge/planning-worker";
import type { FleetAuthorityRelease } from "@zugfolge/runtime-native";

import type { SignedAlphaWorldDeployment } from "./alpha-world-start.js";
import {
  compareRegionalScheduledCommands,
  RegionalServiceCatalog,
} from "./boundary-transition-scheduler.js";
import type {
  RegionalRealtimeRegistration,
  RegionalScheduledCommandCatalog,
} from "./regional-simulation-scheduler.js";
import { compareUtf8 } from "./utf8.js";

function realtimeRegionKey(worldId: string, regionId: string): string {
  return `${worldId}\u0000${regionId}`;
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
export class ActiveWorldDeploymentRuntime {
  readonly fleetAuthorityReleases: Record<string, FleetAuthorityRelease>;
  readonly planningAuthorityAccountIds: Record<string, string>;
  readonly planningInfrastructureReleases: PlanningInfrastructureReleaseCatalog;
  readonly worldEpochs = new Map<string, Date>();
  readonly boundaryTransitions: RegionalScheduledCommandCatalog;

  readonly #activeWorldIds = new Set<string>();
  readonly #realtimeWorldIds = new Set<string>();
  readonly #deploymentHashes = new Map<string, string>();
  readonly #realtimeRegions = new Map<string, RegionalRealtimeRegistration>();
  readonly #serviceCatalogs = new Map<string, RegionalScheduledCommandCatalog>();
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
    this.boundaryTransitions = {
      at: (worldId, regionId, atS) => [...this.#serviceCatalogs.values()]
        .flatMap((catalog) => catalog.at(worldId, regionId, atS))
        .sort(compareRegionalScheduledCommands),
      due: (worldId, regionId, afterS, throughS) => [...this.#serviceCatalogs.values()]
        .flatMap((catalog) => catalog.due(worldId, regionId, afterS, throughS))
        .sort(compareRegionalScheduledCommands),
    };
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
    });
    this.#realtimeRegions.set(
      realtimeRegionKey(region.worldId, region.regionId),
      region,
    );
    this.#realtimeWorldIds.add(deployment.worldId);
    this.#serviceCatalogs.set(deployment.worldId, new RegionalServiceCatalog(
      deployment.worldId,
      deployment.regionalSimulation.regionId,
      deployment.repeatEveryS,
      deployment.regionalSimulation.trains,
      deployment.boundaryTransitions,
    ));
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
