import { PGlite } from "@electric-sql/pglite";
import {
  accounts,
  alphaWorldProfiles,
  domainEvents,
  MIGRATIONS_FOLDER,
  onboardingGrants,
  operators,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OnboardingService,
  type OnboardingPort,
  type StartPackageProof,
  type StartPackageSpec,
} from "./onboarding.js";

const PUBLIC_WORLD_ID = "00000000-0000-4000-8000-000000000201";
const TUTORIAL_WORLD_ID = "00000000-0000-4000-8000-000000000202";
const PUBLIC_ACCOUNT_ID = "00000000-0000-4000-8000-000000000203";
const TUTORIAL_ACCOUNT_ID = "00000000-0000-4000-8000-000000000204";
const TUTORIAL_OPERATOR_ID = "00000000-0000-4000-8000-000000000205";

const SPEC: StartPackageSpec = {
  schemaVersion: "zugfolge-start-package/v1",
  version: "tutorial-2026-08",
  emergencyLotId: "tutorial-lot-1",
  maximumTrainKmPerPeriod: 1_000,
  vehicleClass: "Mireo",
  maximumVehicleValueCents: 900_000_000n,
  durationS: 86_400,
  pathWindowId: "tutorial-path-1",
  personnelPoolId: "tutorial-pool-1",
  operatingProgramTemplateId: "balanced",
};

const PROOF: StartPackageProof = {
  operatorId: TUTORIAL_OPERATOR_ID,
  lotId: SPEC.emergencyLotId,
  vehicleId: "tutorial-vehicle-1",
  vehicleLeaseContractId: "tutorial-lease-1",
  pathReceiptId: SPEC.pathWindowId,
  personnelPoolId: SPEC.personnelPoolId,
  operatingProgramId: "tutorial-program-1",
  operatingProgramActive: true,
  fleetStateHash: "a".repeat(64),
  economyStateHash: "b".repeat(64),
};

describe("Tutorial-Startpaket", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([
      {
        id: PUBLIC_WORLD_ID,
        name: "Oeffentliche Alpha",
        schedulePeriodWeeks: 3,
        epoch: new Date(0),
        worldKind: "public",
        rankingStatus: "ranked",
        lifecycleStatus: "active",
      },
      {
        id: TUTORIAL_WORLD_ID,
        name: "Tutorial",
        schedulePeriodWeeks: 3,
        epoch: new Date(0),
        worldKind: "private",
        rankingStatus: "unranked",
        lifecycleStatus: "active",
      },
    ]);
    await db.insert(alphaWorldProfiles).values([
      {
        worldId: PUBLIC_WORLD_ID,
        profileKind: "public",
        regionId: "mitteldeutschland-b",
        regionVariant: "B",
        worldSeed: 201n,
        accelerationFactor: 1,
        infraReleaseHash: "1".repeat(64),
        timetableReleaseHash: "2".repeat(64),
        fleetReleaseHash: "3".repeat(64),
        economyReleaseHash: "4".repeat(64),
        blueprint: {},
        blueprintHash: "5".repeat(64),
        state: "running",
      },
      {
        worldId: TUTORIAL_WORLD_ID,
        profileKind: "tutorial",
        regionId: "mitteldeutschland-b",
        regionVariant: "B",
        worldSeed: 202n,
        accelerationFactor: 60,
        infraReleaseHash: "6".repeat(64),
        timetableReleaseHash: "7".repeat(64),
        fleetReleaseHash: "8".repeat(64),
        economyReleaseHash: "9".repeat(64),
        blueprint: {},
        blueprintHash: "a".repeat(64),
        state: "running",
      },
    ]);
    await db.insert(accounts).values([
      {
        id: PUBLIC_ACCOUNT_ID,
        worldId: PUBLIC_WORLD_ID,
        keycloakSubject: "kc-public-only",
        displayName: "Oeffentlicher Spieler",
      },
      {
        id: TUTORIAL_ACCOUNT_ID,
        worldId: TUTORIAL_WORLD_ID,
        keycloakSubject: "kc-tutorial",
        displayName: "Tutorialspieler",
      },
    ]);
  });

  afterEach(async () => client.close());

  function service() {
    const grantThroughAuthoritativePaths = vi.fn<OnboardingPort["grantThroughAuthoritativePaths"]>(async (input) => {
      await input.tx.insert(operators).values({
        id: TUTORIAL_OPERATOR_ID,
        worldId: input.worldId,
        foundingAccountId: input.accountId,
        name: "Tutorial Startbahn",
      });
      return PROOF;
    });
    const afterGrantCommitted = vi.fn<NonNullable<OnboardingPort["afterGrantCommitted"]>>(async () => undefined);
    const port: OnboardingPort = {
      grantThroughAuthoritativePaths,
      capacityCells: async () => [],
      afterGrantCommitted,
    };
    return { onboarding: new OnboardingService(db, port), grantThroughAuthoritativePaths, afterGrantCommitted };
  }

  it("weist Status und Claim in einer oeffentlichen Welt vor jeder Fachmutation ab", async () => {
    const { onboarding, grantThroughAuthoritativePaths, afterGrantCommitted } = service();

    await expect(onboarding.grantForAccount(PUBLIC_WORLD_ID, PUBLIC_ACCOUNT_ID)).rejects.toMatchObject({
      code: "start_package_tutorial_only",
    });
    await expect(onboarding.claim(PUBLIC_WORLD_ID, "kc-public-only", 100, SPEC)).rejects.toMatchObject({
      code: "start_package_tutorial_only",
    });
    await expect(onboarding.assistantForAccount(PUBLIC_WORLD_ID, PUBLIC_ACCOUNT_ID)).rejects.toMatchObject({
      code: "start_package_tutorial_only",
    });

    expect(grantThroughAuthoritativePaths).not.toHaveBeenCalled();
    expect(afterGrantCommitted).not.toHaveBeenCalled();
    expect(await db.select().from(onboardingGrants)).toHaveLength(0);
    expect(await db.select().from(operators)).toHaveLength(0);
    expect(await db.select().from(domainEvents)).toHaveLength(0);
  });

  it("vergibt das Paket in der laufenden Tutorial-Welt genau einmal und spielt es idempotent wieder ab", async () => {
    const { onboarding, grantThroughAuthoritativePaths, afterGrantCommitted } = service();

    const first = await onboarding.claim(TUTORIAL_WORLD_ID, "kc-tutorial", 100, SPEC);
    const replay = await onboarding.claim(TUTORIAL_WORLD_ID, "kc-tutorial", 100, SPEC);
    const status = await onboarding.grantForAccount(TUTORIAL_WORLD_ID, TUTORIAL_ACCOUNT_ID);

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(status).toMatchObject({ idempotentReplay: true, grant: { operatorId: TUTORIAL_OPERATOR_ID } });
    expect(grantThroughAuthoritativePaths).toHaveBeenCalledTimes(1);
    expect(afterGrantCommitted).toHaveBeenCalledTimes(2);
    expect(await db.select().from(onboardingGrants)).toHaveLength(1);
    expect(await db.select().from(operators)).toHaveLength(1);
    expect(await db.select().from(domainEvents)).toEqual([
      expect.objectContaining({ worldId: TUTORIAL_WORLD_ID, eventType: "alpha.start-package-granted" }),
    ]);
  });

  it("verwendet kein Konto aus einer anderen Welt fuer das Tutorial-Paket", async () => {
    const { onboarding, grantThroughAuthoritativePaths } = service();

    await expect(onboarding.claim(TUTORIAL_WORLD_ID, "kc-public-only", 100, SPEC)).rejects.toMatchObject({
      code: "alpha_forbidden",
    });
    expect(grantThroughAuthoritativePaths).not.toHaveBeenCalled();
    expect(await db.select().from(onboardingGrants)).toHaveLength(0);
  });
});
