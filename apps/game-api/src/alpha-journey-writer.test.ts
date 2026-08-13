import { PGlite } from "@electric-sql/pglite";
import { accounts, alphaWorldProfiles, domainEvents, MIGRATIONS_FOLDER, operators, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { buildEconomyRelease, loadEconomyWorldState, persistEconomyTransition, startEconomyWorld } from "@zugfolge/economy";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GameAlphaJourneyCommandWriter,
  parseAlphaJourneyAuthorityConfiguration,
  parseStartPackageSpec,
} from "./alpha-journey-writer.js";

const WORLD_ID = "00000000-0000-4000-8000-000000000071";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000072";
const SLOT_ID = "00000000-0000-4000-8000-000000000073";
const PUBLIC_WORLD_ID = "00000000-0000-4000-8000-000000000074";
const PUBLIC_ACCOUNT_ID = "00000000-0000-4000-8000-000000000075";

const configuration = {
  tutorialOperatorNamePrefix: "Tutorialbahn",
  startPackageSlots: [{
    worldId: WORLD_ID,
    operatorId: SLOT_ID,
    operatorName: "Alpha Startbahn 1",
    vehicleId: "vehicle-1",
    formationId: "formation-1",
    personnelDutyId: "duty-1",
    pathReservationId: "path-1",
    vehicleLeaseReceiptId: "lease-1",
    trainRunIds: ["run-1"],
  }],
} as const;

const startPackageSpec = {
  schemaVersion: "zugfolge-start-package/v1" as const,
  version: "tutorial-v1",
  emergencyLotId: "lot-0",
  maximumTrainKmPerPeriod: 1_000,
  vehicleClass: "Mireo",
  maximumVehicleValueCents: 900_000_000n,
  durationS: 86_400,
  pathWindowId: "path-1",
  personnelPoolId: "pool-1",
  operatingProgramTemplateId: "balanced",
};

const economyRelease = buildEconomyRelease({
  version: "tutorial-test",
  rates: {
    trackPerTrainKmCents: 1n, stationPerStopCents: 1n, facilityPerHourCents: 1n,
    energyPerKwhCents: 1n, personnelPerHourCents: 1n, administrationPerPeriodCents: 1n,
    vehiclePerPeriodCents: 1n, overnightStablingPerPeriodCents: 1n, protectionEquipmentPerPeriodCents: 1n,
    lateInterestBasisPoints: 1,
  },
  rules: {
    qualityBaselinePunctualityBasisPoints: 8_500, pointsPerExtraSeat: 1, pointsPerPunctualityBasisPoint: 1,
    pointsPerAdditionalStop: 1, requirementFocusMaximumPoints: 1, contractBonusCentsPerPeriod: 1n,
    penaltyRates: { punctuality: 1n, cancellation: 1n, seats: 1n, connections: 1n },
    penaltyFocusMultiplierBasisPoints: 10_000, publicOperationSurchargeBasisPoints: 1,
    failedPackageFeeStepBasisPoints: 1, failedPackageReductionStepBasisPoints: 1,
  },
  tenderProfiles: [
    { id: "price", weights: { price: 5_000, quality: 5_000 }, requirementFocus: "capacity", penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 1 },
    { id: "quality", weights: { price: 4_000, quality: 6_000 }, requirementFocus: "comfort", penaltyFocus: "connections", viabilitySurchargeBasisPoints: 2 },
  ],
});

describe("GameAlphaJourneyCommandWriter", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({
      id: WORLD_ID, name: "Tutorial", schedulePeriodWeeks: 3, epoch: new Date(0),
      worldKind: "private", rankingStatus: "unranked", lifecycleStatus: "active",
    });
    await db.insert(worlds).values({
      id: PUBLIC_WORLD_ID, name: "Oeffentliche Alpha", schedulePeriodWeeks: 3, epoch: new Date(0),
      worldKind: "public", rankingStatus: "ranked", lifecycleStatus: "active",
    });
    await db.insert(alphaWorldProfiles).values({
      worldId: WORLD_ID, profileKind: "tutorial", regionId: "lhe", regionVariant: "B", worldSeed: 7n,
      accelerationFactor: 60, infraReleaseHash: "a".repeat(64), timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64), economyReleaseHash: "d".repeat(64), blueprint: {},
      blueprintHash: "e".repeat(64), state: "running",
    });
    await db.insert(alphaWorldProfiles).values({
      worldId: PUBLIC_WORLD_ID, profileKind: "public", regionId: "lhe", regionVariant: "B", worldSeed: 8n,
      accelerationFactor: 1, infraReleaseHash: "a".repeat(64), timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64), economyReleaseHash: "d".repeat(64), blueprint: {},
      blueprintHash: "f".repeat(64), state: "running",
    });
    await db.insert(accounts).values({ id: ACCOUNT_ID, worldId: WORLD_ID, keycloakSubject: "kc-external", displayName: "Extern" });
    await db.insert(accounts).values({ id: PUBLIC_ACCOUNT_ID, worldId: PUBLIC_WORLD_ID, keycloakSubject: "kc-public", displayName: "Oeffentlich" });
    await persistEconomyTransition(db, {
      expectedRevision: null,
      ...startEconomyWorld({
        worldId: WORLD_ID, seed: 7n, durationMonths: 6, release: economyRelease,
        lots: Array.from({ length: 8 }, (_, index) => ({ id: `lot-${index}`, size: 10, attractiveness: 10 })),
        authorityBudgets: [], accounts: [],
      }),
      committedAt: new Date(0),
    });
  });

  afterEach(async () => client.close());

  it("ordnet Resume und Reset demselben vorbereiteten Tutorial-Slot zu", async () => {
    const writer = new GameAlphaJourneyCommandWriter(db, {} as never, configuration);
    const command = {
      schemaVersion: "zugfolge-alpha-tutorial-reset-command/v1" as const,
      commandId: `tutorial-reset:${WORLD_ID}:${ACCOUNT_ID}:1`,
      worldId: WORLD_ID,
      accountId: ACCOUNT_ID,
      resetNumber: 1,
      atS: 10,
    };
    await writer.resetTutorial(command);
    await writer.resetTutorial(command);
    await writer.resetTutorial({
      ...command,
      commandId: `tutorial-reset:${WORLD_ID}:${ACCOUNT_ID}:2`,
      resetNumber: 2,
      atS: 20,
    });

    const [created, events] = await Promise.all([
      db.select().from(operators),
      db.select().from(domainEvents),
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ id: SLOT_ID, worldId: WORLD_ID, foundingAccountId: ACCOUNT_ID, name: configuration.startPackageSlots[0].operatorName });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ worldId: WORLD_ID, eventType: "alpha.tutorial-session-seeded" });
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({ commandId: command.commandId, operatorId: SLOT_ID, resetNumber: 1, startedAtS: 10 }),
      expect.objectContaining({ commandId: `tutorial-reset:${WORLD_ID}:${ACCOUNT_ID}:2`, operatorId: SLOT_ID, resetNumber: 2, startedAtS: 20 }),
    ]);
    expect((await loadEconomyWorldState(db, WORLD_ID))?.prequalifications.get(ACCOUNT_ID)).toMatchObject({
      worldId: WORLD_ID, accountId: ACCOUNT_ID, score: 5_000,
    });
  });

  it("weist Tutorial-Reset und Startpaket fuer eine oeffentliche Welt vor jeder Writer-Mutation ab", async () => {
    const publicConfiguration = {
      ...configuration,
      startPackageSlots: [{ ...configuration.startPackageSlots[0], worldId: PUBLIC_WORLD_ID }],
    } as const;
    const writer = new GameAlphaJourneyCommandWriter(db, {} as never, publicConfiguration);

    await expect(writer.resetTutorial({
      schemaVersion: "zugfolge-alpha-tutorial-reset-command/v1",
      commandId: `tutorial-reset:${PUBLIC_WORLD_ID}:${PUBLIC_ACCOUNT_ID}:0`,
      worldId: PUBLIC_WORLD_ID,
      accountId: PUBLIC_ACCOUNT_ID,
      resetNumber: 0,
      atS: 0,
    })).rejects.toMatchObject({ code: "not_tutorial_world" });

    await expect(db.transaction((tx) => writer.grantStartPackage({
      schemaVersion: "zugfolge-alpha-start-package-command/v1",
      commandId: `start-package:${PUBLIC_WORLD_ID}:${PUBLIC_ACCOUNT_ID}:tutorial-v1`,
      tx: tx as never,
      worldId: PUBLIC_WORLD_ID,
      accountId: PUBLIC_ACCOUNT_ID,
      keycloakSubject: "kc-public",
      atS: 100,
      spec: startPackageSpec,
    }))).rejects.toMatchObject({ code: "start_package_tutorial_only" });

    expect(await db.select().from(operators)).toHaveLength(0);
    expect(await db.select().from(domainEvents)).toHaveLength(0);
    expect(await loadEconomyWorldState(db, PUBLIC_WORLD_ID)).toBeUndefined();
  });

  it("parst Centwerte als bigint und lehnt unvollstaendige Slot-Konfiguration ab", () => {
    expect(parseAlphaJourneyAuthorityConfiguration(JSON.stringify(configuration)).startPackageSlots).toHaveLength(1);
    expect(() => parseAlphaJourneyAuthorityConfiguration("{}")) .toThrow(/mindestens einen/);
    expect(parseStartPackageSpec(JSON.stringify({
      schemaVersion: "zugfolge-start-package/v1", version: "v1", emergencyLotId: "lot-1",
      maximumTrainKmPerPeriod: 1000, vehicleClass: "Mireo", maximumVehicleValueCents: "900000000",
      durationS: 86400, pathWindowId: "path-1", personnelPoolId: "pool-1", operatingProgramTemplateId: "balanced",
    })).maximumVehicleValueCents).toBe(900_000_000n);
  });
});
