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
    await db.insert(alphaWorldProfiles).values({
      worldId: WORLD_ID, profileKind: "tutorial", regionId: "lhe", regionVariant: "B", worldSeed: 7n,
      accelerationFactor: 60, infraReleaseHash: "a".repeat(64), timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64), economyReleaseHash: "d".repeat(64), blueprint: {},
      blueprintHash: "e".repeat(64), state: "running",
    });
    await db.insert(accounts).values({ id: ACCOUNT_ID, worldId: WORLD_ID, keycloakSubject: "kc-external", displayName: "Extern" });
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

  it("serialisiert und dedupliziert den Reset als weltgesperrtes Fachkommando", async () => {
    const writer = new GameAlphaJourneyCommandWriter(db, {} as never, configuration);
    const command = {
      schemaVersion: "zugfolge-alpha-tutorial-reset-command/v1" as const,
      commandId: `tutorial-reset:${WORLD_ID}:${ACCOUNT_ID}:1`,
      worldId: WORLD_ID,
      accountId: ACCOUNT_ID,
      resetNumber: 1,
    };
    await writer.resetTutorial(command);
    await writer.resetTutorial(command);

    const [created, events] = await Promise.all([
      db.select().from(operators),
      db.select().from(domainEvents),
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ worldId: WORLD_ID, foundingAccountId: ACCOUNT_ID, name: expect.stringContaining("R1") });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ worldId: WORLD_ID, eventType: "alpha.tutorial-session-seeded" });
    expect(events[0]?.payload).toMatchObject({ commandId: command.commandId, operatorId: created[0]?.id, resetNumber: 1 });
    expect((await loadEconomyWorldState(db, WORLD_ID))?.prequalifications.get(ACCOUNT_ID)).toMatchObject({
      worldId: WORLD_ID, accountId: ACCOUNT_ID, score: 5_000,
    });
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
