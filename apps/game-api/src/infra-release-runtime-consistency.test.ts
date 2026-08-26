import { PGlite } from "@electric-sql/pglite";
import {
  MIGRATIONS_FOLDER,
  alphaWorldProfiles,
  infraReleaseChanges,
  regionalSimulationStates,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import {
  operationalInfrastructureBindingsEqual,
  type OperationalInfrastructureBinding,
} from "@zugfolge/runtime-native";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInfraReleaseRuntimeConsistencyHealthCheck,
  reconcileActiveWorldInfrastructureRuntimes,
  type ActiveWorldInfrastructureBaseline,
  type OperationalInfrastructureRuntimeRegistry,
} from "./infra-release-runtime-consistency.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const FOREIGN_WORLD = "22222222-2222-4222-8222-222222222222";
const REGION = "deutschland-ebo-operational-v2";
const INITIALIZATION_HASH = "1".repeat(64);
const INITIAL_STATE_HASH = "2".repeat(64);
const BASE_RELEASE_HASH = "3".repeat(64);
const NEXT_RELEASE_HASH = "4".repeat(64);
const EPOCH = new Date("2026-01-01T00:00:00.000Z");

const BASE_INFRASTRUCTURE: OperationalInfrastructureBinding = Object.freeze({
  schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
  infraReleaseId: "infra-deutschland-2026.3",
  file: "operational-infrastructure-v2.json",
  bytes: 10_000,
  sha256: "5".repeat(64),
  stateHash: "6".repeat(64),
});
const NEXT_INFRASTRUCTURE: OperationalInfrastructureBinding = Object.freeze({
  schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
  infraReleaseId: "infra-deutschland-2027.1",
  file: "operational-infrastructure-v2.json",
  bytes: 11_000,
  sha256: "7".repeat(64),
  stateHash: "8".repeat(64),
});

const baseline: ActiveWorldInfrastructureBaseline = Object.freeze({
  worldId: WORLD,
  infraReleaseHash: BASE_RELEASE_HASH,
  regions: Object.freeze([Object.freeze({
    regionId: REGION,
    initializationHash: INITIALIZATION_HASH,
    infrastructure: BASE_INFRASTRUCTURE,
  })]),
});

class RestartRegistry implements OperationalInfrastructureRuntimeRegistry {
  readonly revalidate = vi.fn();
  readonly planningRelease = Object.freeze({ id: "planning-release-stays-signed" });
  #binding: OperationalInfrastructureBinding = BASE_INFRASTRUCTURE;

  operationalInfrastructureBinding(worldId: string, regionId: string) {
    return worldId === WORLD && regionId === REGION ? this.#binding : undefined;
  }

  revalidateOperationalInfrastructure(
    worldId: string,
    expected: OperationalInfrastructureBinding,
  ): void {
    this.revalidate(worldId, expected);
    if (
      worldId !== WORLD
      || !operationalInfrastructureBindingsEqual(this.#binding, expected)
    ) {
      throw new Error("fremder Registrykopf");
    }
  }
}

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

function state(infrastructure: OperationalInfrastructureBinding, worldId = WORLD) {
  return {
    schemaVersion: "zugfolge-operational-simulation-state/v2",
    initializationHash: INITIALIZATION_HASH,
    infraRelease: infrastructure,
    world: {
      worldId,
      regionId: REGION,
      infraReleaseId: infrastructure.infraReleaseId,
      nowMs: 0,
      commitSequence: 0,
      eventSequence: 0,
    },
    revision: 0,
    publisherSequence: 0,
    stateHash: INITIAL_STATE_HASH,
    commandReceipts: {},
  };
}

async function insertWorld(worldId: string, profileReleaseHash = BASE_RELEASE_HASH) {
  await db.insert(worlds).values({
    id: worldId,
    name: `Infra-Startup ${worldId.slice(0, 4)}`,
    schedulePeriodWeeks: 3,
    epoch: EPOCH,
  });
  await db.insert(alphaWorldProfiles).values({
    worldId,
    profileKind: "test",
    regionId: REGION,
    regionVariant: "B",
    worldSeed: 42n,
    infraReleaseHash: profileReleaseHash,
    timetableReleaseHash: "9".repeat(64),
    fleetReleaseHash: "a".repeat(64),
    economyReleaseHash: "b".repeat(64),
    blueprint: { schemaVersion: "zugfolge-alpha-world-blueprint/v1" },
    blueprintHash: "c".repeat(64),
    currentPeriod: 1,
    state: "running",
    startedAtS: 0,
  });
}

async function insertRegionalState(
  worldId: string,
  infrastructure: OperationalInfrastructureBinding,
) {
  await db.insert(regionalSimulationStates).values({
    worldId,
    regionId: REGION,
    stateSchema: "zugfolge-operational-simulation-state/v2",
    initializationHash: INITIALIZATION_HASH,
    stateHash: INITIAL_STATE_HASH,
    revision: 0,
    publisherSequence: 0,
    state: state(infrastructure, worldId),
    createdAt: EPOCH,
    updatedAt: EPOCH,
  });
}

async function insertLegacyHotChange(
  status: "validated" | "scheduled" | "activated",
  impactPreview: Readonly<Record<string, unknown>> = {},
) {
  const id = "33333333-3333-4333-8333-333333333333";
  await db.insert(infraReleaseChanges).values({
    id,
    worldId: WORLD,
    releaseId: NEXT_INFRASTRUCTURE.infraReleaseId,
    releaseHash: NEXT_RELEASE_HASH,
    predecessorHash: BASE_RELEASE_HASH,
    timetableYear: 2027,
    validFrom: EPOCH,
    validUntil: new Date("2027-01-01T00:00:00.000Z"),
    coverageReport: {},
    rightsReport: {},
    deviationReport: {},
    signature: {},
    impactPreview,
    requestedByAdminRequestId: "44444444-4444-4444-8444-444444444444",
    activateAtPeriod: 1,
    status,
    activatedAtS: status === "activated" ? 1 : null,
    activationEventId: status === "activated" ? `infra-release:${id}:activated` : null,
  });
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 30_000);

afterEach(async () => client.close());

describe("Operational-v2 InfraRelease Startup-/Readiness-Bindung", () => {
  it("revalidiert nach einem Prozessneustart nur den identischen signierten Kopf als No-op", async () => {
    await insertWorld(WORLD);
    await insertRegionalState(WORLD, BASE_INFRASTRUCTURE);
    const registry = new RestartRegistry();
    const planningBefore = registry.planningRelease;

    await reconcileActiveWorldInfrastructureRuntimes(db, registry, [baseline]);

    expect(registry.revalidate).toHaveBeenCalledTimes(1);
    expect(registry.revalidate).toHaveBeenCalledWith(
      WORLD,
      BASE_INFRASTRUCTURE,
    );
    expect(registry.operationalInfrastructureBinding(WORLD, REGION)).toEqual(BASE_INFRASTRUCTURE);
    expect(registry.planningRelease).toBe(planningBefore);
    await expect(createInfraReleaseRuntimeConsistencyHealthCheck(db, registry, () => [baseline]).check())
      .resolves.toEqual({ status: "ok", code: "infra_release_runtime_consistent" });
  });

  it("laesst einen alten vollstaendigen Hot-Aktivierungsbeleg keinen abweichenden Kopf legitimieren", async () => {
    await insertWorld(WORLD, NEXT_RELEASE_HASH);
    await insertRegionalState(WORLD, NEXT_INFRASTRUCTURE);
    await insertLegacyHotChange("activated", {
      operationalInfrastructure: NEXT_INFRASTRUCTURE,
      operationalTransition: {
        predecessor: BASE_INFRASTRUCTURE,
        release: NEXT_INFRASTRUCTURE,
      },
    });
    const registry = new RestartRegistry();

    await expect(reconcileActiveWorldInfrastructureRuntimes(db, registry, [baseline]))
      .rejects.toThrow(/vollstaendig signiertes Deployment-Cutover inklusive Planning und Livemap/u);
    expect(registry.revalidate).not.toHaveBeenCalled();
    await expect(createInfraReleaseRuntimeConsistencyHealthCheck(db, registry, () => [baseline]).check())
      .resolves.toEqual({ status: "down", code: "infra_release_runtime_split_brain" });
  });

  it("laesst einen nur validierten Staging-Kandidaten beim Startup und in Readiness zu", async () => {
    await insertWorld(WORLD);
    await insertRegionalState(WORLD, BASE_INFRASTRUCTURE);
    await insertLegacyHotChange("validated");
    const registry = new RestartRegistry();

    await expect(reconcileActiveWorldInfrastructureRuntimes(db, registry, [baseline]))
      .resolves.toBeUndefined();
    expect(registry.revalidate).toHaveBeenCalledOnce();
    await expect(createInfraReleaseRuntimeConsistencyHealthCheck(db, registry, () => [baseline]).check())
      .resolves.toEqual({ status: "ok", code: "infra_release_runtime_consistent" });
  });

  it.each(["scheduled", "activated"] as const)(
    "blockiert einen alten %s-Hot-Kopf bereits im Startup und setzt Readiness auf down",
    async (status) => {
      await insertWorld(WORLD);
      await insertRegionalState(WORLD, BASE_INFRASTRUCTURE);
      await insertLegacyHotChange(status);
      const registry = new RestartRegistry();

      await expect(reconcileActiveWorldInfrastructureRuntimes(db, registry, [baseline]))
        .rejects.toThrow(/vollstaendig signiertes Deployment-Cutover inklusive Planning und Livemap/u);
      expect(registry.revalidate).not.toHaveBeenCalled();
      await expect(createInfraReleaseRuntimeConsistencyHealthCheck(db, registry, () => [baseline]).check())
        .resolves.toEqual({ status: "down", code: "infra_release_runtime_split_brain" });
    },
  );

  it("weist einen abweichenden Regionalzustand auch bei identischem Profil fail-closed ab", async () => {
    await insertWorld(WORLD);
    await insertRegionalState(WORLD, NEXT_INFRASTRUCTURE);
    const registry = new RestartRegistry();

    await expect(reconcileActiveWorldInfrastructureRuntimes(db, registry, [baseline]))
      .rejects.toThrow(/vollstaendig signiertes Deployment-Cutover inklusive Planning und Livemap/u);
    expect(registry.revalidate).not.toHaveBeenCalled();
    await expect(createInfraReleaseRuntimeConsistencyHealthCheck(db, registry, () => [baseline]).check())
      .resolves.toEqual({ status: "down", code: "infra_release_runtime_split_brain" });
  });

  it("bleibt weltisoliert und meldet nachtraegliche DB-Drift in Readiness als down", async () => {
    await insertWorld(WORLD);
    await insertRegionalState(WORLD, BASE_INFRASTRUCTURE);
    await insertWorld(FOREIGN_WORLD, NEXT_RELEASE_HASH);
    await insertRegionalState(FOREIGN_WORLD, BASE_INFRASTRUCTURE);
    const registry = new RestartRegistry();

    await reconcileActiveWorldInfrastructureRuntimes(db, registry, [baseline]);
    expect(registry.operationalInfrastructureBinding(WORLD, REGION)).toEqual(BASE_INFRASTRUCTURE);

    await db.update(alphaWorldProfiles).set({ infraReleaseHash: NEXT_RELEASE_HASH })
      .where(eq(alphaWorldProfiles.worldId, WORLD));
    await expect(createInfraReleaseRuntimeConsistencyHealthCheck(db, registry, () => [baseline]).check())
      .resolves.toEqual({ status: "down", code: "infra_release_runtime_split_brain" });
  });
});
