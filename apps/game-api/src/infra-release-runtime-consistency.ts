import {
  alphaWorldProfiles,
  infraReleaseChanges,
  regionalSimulationStates,
} from "@zugfolge/db";
import type { HealthCheck } from "@zugfolge/health";
import {
  OPERATIONAL_SIMULATION_STATE_SCHEMA,
  operationalInfrastructureBindingsEqual,
  type OperationalInfrastructureBinding,
} from "@zugfolge/runtime-native";
import { and, eq, inArray } from "drizzle-orm";

import type { AlphaDatabase } from "@zugfolge/alpha";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface OperationalInfrastructureRuntimeRegistry {
  operationalInfrastructureBinding(
    worldId: string,
    regionId: string,
  ): OperationalInfrastructureBinding | undefined;
  revalidateOperationalInfrastructure(
    worldId: string,
    expected: OperationalInfrastructureBinding,
  ): void;
}

export interface ActiveWorldInfrastructureBaseline {
  readonly worldId: string;
  /** Hash des signierten InfraRelease-Wrappers im unveraenderlichen Weltvertrag. */
  readonly infraReleaseHash: string;
  readonly regions: readonly Readonly<{
    regionId: string;
    initializationHash: string;
    infrastructure: OperationalInfrastructureBinding;
  }>[];
}

interface PersistedRegionalHead {
  readonly regionId: string;
  readonly stateSchema: string;
  readonly initializationHash: string | null;
  readonly stateHash: string;
  readonly revision: number;
  readonly publisherSequence: number;
  readonly state: unknown;
}

interface PersistedWorldInfrastructure {
  readonly worldId: string;
  readonly profileState: string;
  readonly profileInfraReleaseHash: string;
  readonly regions: readonly PersistedRegionalHead[];
}

function record(value: unknown, detail: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(detail);
  }
  return value as Readonly<Record<string, unknown>>;
}

function infrastructureBinding(value: unknown, detail: string): OperationalInfrastructureBinding {
  if (!operationalInfrastructureBindingsEqual(value, value)) throw new Error(detail);
  return value as OperationalInfrastructureBinding;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

async function loadPersistedWorldInfrastructure(
  db: AlphaDatabase,
  worldId: string,
): Promise<PersistedWorldInfrastructure> {
  const rows = await db.select({
    profileState: alphaWorldProfiles.state,
    profileInfraReleaseHash: alphaWorldProfiles.infraReleaseHash,
    regionId: regionalSimulationStates.regionId,
    stateSchema: regionalSimulationStates.stateSchema,
    initializationHash: regionalSimulationStates.initializationHash,
    stateHash: regionalSimulationStates.stateHash,
    revision: regionalSimulationStates.revision,
    publisherSequence: regionalSimulationStates.publisherSequence,
    state: regionalSimulationStates.state,
  }).from(alphaWorldProfiles)
    .leftJoin(
      regionalSimulationStates,
      eq(regionalSimulationStates.worldId, alphaWorldProfiles.worldId),
    )
    .where(eq(alphaWorldProfiles.worldId, worldId));
  const first = rows[0];
  if (first === undefined) throw new Error(`Aktive Welt '${worldId}' besitzt kein Alpha-Profil.`);
  return Object.freeze({
    worldId,
    profileState: first.profileState,
    profileInfraReleaseHash: first.profileInfraReleaseHash,
    regions: Object.freeze(rows.flatMap((row): readonly PersistedRegionalHead[] => row.regionId === null
      ? []
      : [Object.freeze({
        regionId: row.regionId,
        stateSchema: row.stateSchema!,
        initializationHash: row.initializationHash,
        stateHash: row.stateHash!,
        revision: row.revision!,
        publisherSequence: row.publisherSequence!,
        state: row.state,
      })]).sort((left, right) => compareUtf8(left.regionId, right.regionId))),
  });
}

/**
 * Loest ausschliesslich den im signierten Deployment festgelegten DB-Kopf auf.
 * Ein alter Hot-Aktivierungsbeleg ist keine Laufzeitautoritaet und kann weder
 * ein abweichendes Profil noch abweichende Regionalzustaende legitimieren.
 */
export function resolveActiveWorldInfrastructure(
  baseline: ActiveWorldInfrastructureBaseline,
  persisted: PersistedWorldInfrastructure,
): OperationalInfrastructureBinding {
  if (persisted.worldId !== baseline.worldId || persisted.profileState !== "running") {
    throw new Error(`InfraRelease-Laufzeitpruefung ist nicht an die laufende Welt '${baseline.worldId}' gebunden.`);
  }
  if (baseline.regions.length === 0) {
    throw new Error(`Signierte Welt '${baseline.worldId}' besitzt keine Operational-v2-Region.`);
  }
  const expectedRegions = [...baseline.regions].sort((left, right) => compareUtf8(left.regionId, right.regionId));
  if (
    persisted.regions.length !== expectedRegions.length
    || persisted.regions.some((region, index) => region.regionId !== expectedRegions[index]!.regionId)
  ) {
    throw new Error(`Operational-v2-Regionsmenge von '${baseline.worldId}' widerspricht dem signierten Deployment.`);
  }
  const signedInfrastructure = expectedRegions[0]!.infrastructure;
  if (expectedRegions.some(({ infrastructure }) => !operationalInfrastructureBindingsEqual(
    infrastructure,
    signedInfrastructure,
  ))) {
    throw new Error(`Signiertes Deployment von '${baseline.worldId}' verwendet verschiedene regionale InfraReleases.`);
  }
  if (persisted.profileInfraReleaseHash !== baseline.infraReleaseHash) {
    throw new Error(
      `InfraRelease-Profilkopf von '${baseline.worldId}' weicht vom signierten Deployment ab; eine Aenderung erfordert ein vollstaendig signiertes Deployment-Cutover inklusive Planning und Livemap.`,
    );
  }
  for (let index = 0; index < persisted.regions.length; index += 1) {
    const row = persisted.regions[index]!;
    const expected = expectedRegions[index]!;
    const state = record(row.state, `Operational-v2-Zustand '${baseline.worldId}/${row.regionId}' ist ungueltig.`);
    const world = record(state["world"], `Operational-v2-Zustand '${baseline.worldId}/${row.regionId}' besitzt keine Weltbindung.`);
    const binding = infrastructureBinding(
      state["infraRelease"],
      `Operational-v2-Zustand '${baseline.worldId}/${row.regionId}' besitzt keine gueltige InfraRelease-Bindung.`,
    );
    if (
      row.stateSchema !== OPERATIONAL_SIMULATION_STATE_SCHEMA
      || state["schemaVersion"] !== OPERATIONAL_SIMULATION_STATE_SCHEMA
      || !SHA256.test(row.initializationHash ?? "")
      || row.initializationHash !== expected.initializationHash
      || state["initializationHash"] !== row.initializationHash
      || state["stateHash"] !== row.stateHash
      || state["revision"] !== row.revision
      || state["publisherSequence"] !== row.publisherSequence
      || world["worldId"] !== baseline.worldId
      || world["regionId"] !== row.regionId
      || world["infraReleaseId"] !== binding.infraReleaseId
      || world["commitSequence"] !== row.revision
      || row.revision !== row.publisherSequence
    ) {
      throw new Error(`Operational-v2-Zustandskopf '${baseline.worldId}/${row.regionId}' verletzt seine DB- oder Weltbindung.`);
    }
    if (!operationalInfrastructureBindingsEqual(binding, expected.infrastructure)) {
      throw new Error(
        `Operational-v2-Zustandskopf '${baseline.worldId}/${row.regionId}' weicht vom signierten Deployment ab; eine Aenderung erfordert ein vollstaendig signiertes Deployment-Cutover inklusive Planning und Livemap.`,
      );
    }
  }
  return signedInfrastructure;
}

async function resolvePersistedInfrastructure(
  db: AlphaDatabase,
  baseline: ActiveWorldInfrastructureBaseline,
): Promise<OperationalInfrastructureBinding> {
  return resolveActiveWorldInfrastructure(
    baseline,
    await loadPersistedWorldInfrastructure(db, baseline.worldId),
  );
}

/**
 * Alte Hot-Aktivierungen duerfen keinen zweiten Releasewriter neben dem
 * signierten Deployment-Cutover offenhalten. Validierte, noch nicht
 * eingeplante Kandidaten bleiben reine Staging-Daten.
 */
export async function assertNoLegacyHotInfrastructureChanges(
  db: AlphaDatabase,
  worldIds: readonly string[],
): Promise<void> {
  const uniqueWorldIds = [...new Set(worldIds)].sort(compareUtf8);
  if (uniqueWorldIds.length === 0) return;
  const blockers = await db.select({
    id: infraReleaseChanges.id,
    worldId: infraReleaseChanges.worldId,
    status: infraReleaseChanges.status,
  }).from(infraReleaseChanges)
    .innerJoin(alphaWorldProfiles, and(
      eq(alphaWorldProfiles.worldId, infraReleaseChanges.worldId),
      eq(alphaWorldProfiles.state, "running"),
    ))
    .where(and(
      inArray(infraReleaseChanges.worldId, uniqueWorldIds),
      inArray(infraReleaseChanges.status, ["scheduled", "activated"]),
    ));
  if (blockers.length === 0) return;
  const blocker = blockers.sort((left, right) =>
    compareUtf8(left.worldId, right.worldId) || compareUtf8(left.id, right.id))[0]!;
  throw new Error(
    `Laufende Welt '${blocker.worldId}' besitzt einen alten ${blocker.status}-Hot-Aktivierungsbeleg '${blocker.id}'; eine Aenderung erfordert ein vollstaendig signiertes Deployment-Cutover inklusive Planning und Livemap.`,
  );
}

/** Startup-Reconciliation inklusive erneuter nativer Programmpruefung. */
export async function reconcileActiveWorldInfrastructureRuntimes(
  db: AlphaDatabase,
  deployments: OperationalInfrastructureRuntimeRegistry,
  baselines: readonly ActiveWorldInfrastructureBaseline[],
): Promise<void> {
  await assertNoLegacyHotInfrastructureChanges(db, baselines.map(({ worldId }) => worldId));
  const worldIds = new Set<string>();
  for (const baseline of [...baselines].sort((left, right) => compareUtf8(left.worldId, right.worldId))) {
    if (worldIds.has(baseline.worldId)) throw new Error(`Operational-v2-Baseline fuer '${baseline.worldId}' ist doppelt.`);
    worldIds.add(baseline.worldId);
    const active = await resolvePersistedInfrastructure(db, baseline);
    const currentBindings = baseline.regions.map(({ regionId }) =>
      deployments.operationalInfrastructureBinding(baseline.worldId, regionId));
    const current = currentBindings[0];
    if (
      current === undefined
      || currentBindings.some((binding) => !operationalInfrastructureBindingsEqual(binding, current))
      || !operationalInfrastructureBindingsEqual(current, active)
    ) {
      throw new Error(
        `Operational-v2-Registry von '${baseline.worldId}' weicht vom signierten Deployment ab; eine Aenderung erfordert ein vollstaendig signiertes Deployment-Cutover inklusive Planning und Livemap.`,
      );
    }
    deployments.revalidateOperationalInfrastructure(baseline.worldId, active);
    if (baseline.regions.some(({ regionId }) => !operationalInfrastructureBindingsEqual(
      deployments.operationalInfrastructureBinding(baseline.worldId, regionId),
      active,
    ))) {
      throw new Error(`Operational-v2-Registry von '${baseline.worldId}' konnte nicht atomar restauriert werden.`);
    }
  }
}

/** Readiness bleibt nach dem Start gegen nachtraegliche DB-/Registry-Drift zu. */
export function createInfraReleaseRuntimeConsistencyHealthCheck(
  db: AlphaDatabase,
  deployments: OperationalInfrastructureRuntimeRegistry,
  baselines: () => readonly ActiveWorldInfrastructureBaseline[],
): HealthCheck {
  return {
    name: "infra-release-runtime-consistency",
    async check() {
      try {
        const activeBaselines = baselines();
        await assertNoLegacyHotInfrastructureChanges(
          db,
          activeBaselines.map(({ worldId }) => worldId),
        );
        for (const baseline of activeBaselines) {
          const active = await resolvePersistedInfrastructure(db, baseline);
          if (baseline.regions.some(({ regionId }) => !operationalInfrastructureBindingsEqual(
            deployments.operationalInfrastructureBinding(baseline.worldId, regionId),
            active,
          ))) {
            return { status: "down", code: "infra_release_runtime_split_brain" };
          }
        }
        return { status: "ok", code: "infra_release_runtime_consistent" };
      } catch {
        return { status: "down", code: "infra_release_runtime_split_brain" };
      }
    },
  };
}
