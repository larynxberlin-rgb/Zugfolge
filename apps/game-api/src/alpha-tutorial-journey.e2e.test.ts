import { PGlite } from "@electric-sql/pglite";
import { TutorialService, type TutorialResetPort } from "@zugfolge/alpha";
import {
  accounts,
  alphaWorldProfiles,
  domainEvents,
  MIGRATIONS_FOLDER,
  operatingProgramVersions,
  operatorContracts,
  operators,
  tutorialProgress,
  vehicleAssets,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import {
  buildEconomyRelease,
  createFleetMobilizationEnvelope,
  loadEconomyWorldState,
  persistEconomyTransition,
  persistFleetMobilizationSnapshot,
  startEconomyWorld,
} from "@zugfolge/economy";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthoritativeTutorialResetPort } from "./alpha-journey-adapters.js";
import { GameAlphaJourneyCommandWriter } from "./alpha-journey-writer.js";

const WORLD_ID = "00000000-0000-4000-8000-000000000061";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000062";
const SLOT_OPERATOR_ID = "00000000-0000-4000-8000-000000000063";

function release() {
  return buildEconomyRelease({
    version: "tutorial-v1",
    rates: { trackPerTrainKmCents: 1n, stationPerStopCents: 1n, facilityPerHourCents: 1n, energyPerKwhCents: 1n, personnelPerHourCents: 1n, administrationPerPeriodCents: 1n, vehiclePerPeriodCents: 1n, overnightStablingPerPeriodCents: 1n, protectionEquipmentPerPeriodCents: 1n, lateInterestBasisPoints: 1 },
    rules: { qualityBaselinePunctualityBasisPoints: 8_500, pointsPerExtraSeat: 1, pointsPerPunctualityBasisPoint: 1, pointsPerAdditionalStop: 1, requirementFocusMaximumPoints: 1, contractBonusCentsPerPeriod: 1n, penaltyRates: { punctuality: 1n, cancellation: 1n, seats: 1n, connections: 1n }, penaltyFocusMultiplierBasisPoints: 10_000, publicOperationSurchargeBasisPoints: 1, failedPackageFeeStepBasisPoints: 1, failedPackageReductionStepBasisPoints: 1 },
    tenderProfiles: [
      { id: "a", weights: { price: 5_000, quality: 5_000 }, requirementFocus: "capacity", penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 0 },
      { id: "b", weights: { price: 5_000, quality: 5_000 }, requirementFocus: "comfort", penaltyFocus: "connections", viabilitySurchargeBasisPoints: 0 },
    ],
  });
}

describe("Tutorial-E2E ueber alle fuenf Kapitel und Reset", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tutorial: TutorialService;
  let resetPort: AuthoritativeTutorialResetPort;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD_ID, name: "Tutorial", schedulePeriodWeeks: 3, epoch: new Date(0), worldKind: "private", rankingStatus: "unranked", lifecycleStatus: "active" });
    await db.insert(alphaWorldProfiles).values({
      worldId: WORLD_ID, profileKind: "tutorial", regionId: "lhe", regionVariant: "B", worldSeed: 11n, accelerationFactor: 60,
      infraReleaseHash: "a".repeat(64), timetableReleaseHash: "b".repeat(64), fleetReleaseHash: "c".repeat(64), economyReleaseHash: "d".repeat(64),
      blueprint: {}, blueprintHash: "e".repeat(64), state: "running",
    });
    await db.insert(accounts).values({ id: ACCOUNT_ID, worldId: WORLD_ID, keycloakSubject: "kc-tutorial", displayName: "Tutorialspieler" });
    const started = startEconomyWorld({
      worldId: WORLD_ID, seed: 11n, durationMonths: 6, release: release(),
      lots: Array.from({ length: 8 }, (_, index) => ({ id: `lot-${index}`, size: 10, attractiveness: index })), authorityBudgets: [], accounts: [ACCOUNT_ID],
    });
    await persistEconomyTransition(db, { expectedRevision: null, ...started, committedAt: new Date(0) });
    const writer = new GameAlphaJourneyCommandWriter(db, {} as never, {
      tutorialOperatorNamePrefix: "Tutorialbahn",
      startPackageSlots: [{
        worldId: WORLD_ID,
        operatorId: SLOT_OPERATOR_ID,
        operatorName: "Tutorialbahn vorbereiteter Slot",
        vehicleId: "tutorial-slot-vehicle",
        formationId: "tutorial-slot-formation",
        personnelDutyId: "tutorial-slot-duty",
        pathReservationId: "tutorial-slot-path",
        vehicleLeaseReceiptId: "tutorial-slot-lease",
        trainRunIds: ["tutorial-slot-run"],
      }],
    });
    resetPort = new AuthoritativeTutorialResetPort(writer);
    tutorial = new TutorialService(db, resetPort);
  });

  afterEach(async () => client.close());

  it("belegt jedes Kapitel erst durch den jeweiligen autoritativen Zustand und isoliert den Reset", async () => {
    expect(await tutorial.resume(WORLD_ID, ACCOUNT_ID, 0)).toMatchObject({ chapter: 1, chapterState: "in-progress" });
    const [operator] = await db.select().from(operators);
    expect(operator).toMatchObject({ id: SLOT_OPERATOR_ID, foundingAccountId: ACCOUNT_ID });

    const economy = await loadEconomyWorldState(db, WORLD_ID);
    expect(economy).toBeDefined();
    const tenders = new Map(economy!.tenders);
    tenders.set("tutorial-tender", {
      phase: "open",
      tender: { id: "tutorial-tender", lotId: "lot-0" },
      bids: [{ id: "tutorial-bid", operatorId: operator!.id, submittedAt: 1 }],
    } as never);
    await persistEconomyTransition(db, {
      expectedRevision: economy!.revision,
      state: Object.freeze({ ...economy!, tenders, revision: economy!.revision + 1, processedCommands: new Set([...economy!.processedCommands, "tutorial-bid"]) }),
      effects: { notices: [], journal: [] }, committedAt: new Date(1_000),
    });
    expect(await tutorial.resume(WORLD_ID, ACCOUNT_ID, 1)).toMatchObject({ chapter: 2 });

    const [lessor] = await db.insert(operators).values({ worldId: WORLD_ID, foundingAccountId: ACCOUNT_ID, name: "Tutorial-Vermieter" }).returning();
    const [rental] = await db.insert(operatorContracts).values({
      worldId: WORLD_ID, offerorOperatorId: lessor!.id, offereeOperatorId: operator!.id, contractType: "vehicle-rental",
      subject: { vehicleId: "tutorial-vehicle" }, terms: {}, termsHash: "1".repeat(64), priceCents: 0n,
      validFromS: 1_000, validUntilS: 1_000_000, responseDeadlineS: 500, terminationNoticeS: 100,
      status: "active", offeredByAccountId: ACCOUNT_ID, respondedByAccountId: ACCOUNT_ID,
      offeredAtS: 0, respondedAtS: 1, idempotencyKey: "tutorial-lease",
    }).returning();
    await db.insert(vehicleAssets).values({
      worldId: WORLD_ID, vehicleId: "tutorial-vehicle", authorityReleaseId: "fleet-tutorial", classDesignation: "Mireo",
      actualConfiguration: {}, ownerOperatorId: lessor!.id, holderOperatorId: operator!.id, lessorOperatorId: lessor!.id,
      odometerMetres: 0n, conditionBasisPoints: 10_000, damages: [], maintenanceDeadlines: [], approvals: [], operatingLimits: {}, bindings: {},
      valuationSpecId: "tutorial", valueCents: 1n, acquiredAtS: 1, historyHash: "2".repeat(64),
    });
    expect(rental).toBeDefined();
    expect(await tutorial.resume(WORLD_ID, ACCOUNT_ID, 2)).toMatchObject({ chapter: 3 });

    const envelope = createFleetMobilizationEnvelope({
      schema: "zugfolge-fleet-mobilization/v1", worldId: WORLD_ID, revision: 0, producedAt: 3,
      formations: [], personnelDuties: [],
      pathReservations: [{ id: "tutorial-path", operatorId: operator!.id, serviceLineIds: ["S1"], status: "confirmed", validFrom: 0, validUntil: 1_000_000 }],
    });
    await persistFleetMobilizationSnapshot(db, WORLD_ID, envelope, new Date(3_000));
    expect(await tutorial.resume(WORLD_ID, ACCOUNT_ID, 3)).toMatchObject({ chapter: 4 });

    await db.insert(operatingProgramVersions).values({
      worldId: WORLD_ID, operatorId: operator!.id, version: 1, schema: "operating-program/v1", enabled: true,
      canonicalProgram: { rules: ["tutorial"] }, checksum: "3".repeat(64), status: "active", createdByAccountId: ACCOUNT_ID,
      createdAt: new Date(4_000), activatedAt: new Date(4_000),
    });
    expect(await tutorial.resume(WORLD_ID, ACCOUNT_ID, 4)).toMatchObject({ chapter: 5, chapterState: "in-progress" });

    const session = (await db.select().from(domainEvents))[0]!;
    await db.insert(domainEvents).values([
      { worldId: WORLD_ID, sequence: session.sequence + 1, eventType: "disruption.applied", payload: { disruptionId: "tutorial-disruption" }, occurredAt: new Date(5_000) },
      { worldId: WORLD_ID, sequence: session.sequence + 2, eventType: "dispatch.decision-applied", payload: { operatorId: operator!.id, decisionId: "tutorial-decision" }, occurredAt: new Date(6_000) },
    ]);
    expect(await tutorial.resume(WORLD_ID, ACCOUNT_ID, 6)).toMatchObject({ chapter: 5, chapterState: "completed" });

    const beforeReset = await loadEconomyWorldState(db, WORLD_ID);
    const tendersAtResetSecond = new Map(beforeReset!.tenders);
    const tenderAtResetSecond = tendersAtResetSecond.get("tutorial-tender")!;
    tendersAtResetSecond.set("tutorial-tender", {
      ...tenderAtResetSecond,
      bids: [...tenderAtResetSecond.bids, { id: "old-bid-at-reset-second", operatorId: operator!.id, submittedAt: 7 }],
    } as never);
    await persistEconomyTransition(db, {
      expectedRevision: beforeReset!.revision,
      state: Object.freeze({ ...beforeReset!, tenders: tendersAtResetSecond, revision: beforeReset!.revision + 1, processedCommands: new Set([...beforeReset!.processedCommands, "old-bid-at-reset-second"]) }),
      effects: { notices: [], journal: [] }, committedAt: new Date(7_000),
    });

    const reset = await tutorial.reset(WORLD_ID, ACCOUNT_ID, 7);
    expect(reset).toMatchObject({ chapter: 1, chapterState: "in-progress", resetCount: 1 });
    expect((await db.select().from(operators)).filter((candidate) => candidate.id === SLOT_OPERATOR_ID)).toHaveLength(1);
    expect((await db.select().from(domainEvents)).filter((event) => event.eventType === "alpha.tutorial-session-seeded").map((event) => event.payload)).toEqual([
      expect.objectContaining({ operatorId: SLOT_OPERATOR_ID, resetNumber: 0, startedAtS: 0 }),
      expect.objectContaining({
        operatorId: SLOT_OPERATOR_ID,
        resetNumber: 1,
        startedAtS: 7,
        evidenceBoundary: expect.objectContaining({ bidIds: expect.arrayContaining(["old-bid-at-reset-second"]) }),
      }),
    ]);
  });

  it("rollt Writer und Fortschritt gemeinsam zurück, wenn der Reset nach der Writer-Mutation fehlschlägt", async () => {
    await tutorial.resume(WORLD_ID, ACCOUNT_ID, 0);
    const economyBefore = await loadEconomyWorldState(db, WORLD_ID);
    const failingPort: TutorialResetPort = {
      resetAndSeedAccount: async (tx, worldId, accountId, resetNumber, atS) => {
        await resetPort.resetAndSeedAccount(tx, worldId, accountId, resetNumber, atS);
        throw new Error("failure-injection-after-writer");
      },
    };

    await expect(new TutorialService(db, failingPort).reset(WORLD_ID, ACCOUNT_ID, 10)).rejects.toThrow("failure-injection-after-writer");

    expect(await db.select().from(tutorialProgress)).toEqual([
      expect.objectContaining({ worldId: WORLD_ID, accountId: ACCOUNT_ID, chapter: 1, resetCount: 0 }),
    ]);
    expect((await db.select().from(domainEvents)).filter((event) => event.eventType === "alpha.tutorial-session-seeded")).toHaveLength(1);
    expect((await loadEconomyWorldState(db, WORLD_ID))?.revision).toBe(economyBefore?.revision);
  });

  it("serialisiert parallele Resets ohne verlorenen Zähler und setzt das Fünferlimit atomar durch", async () => {
    await tutorial.resume(WORLD_ID, ACCOUNT_ID, 0);

    await Promise.all([
      tutorial.reset(WORLD_ID, ACCOUNT_ID, 10),
      tutorial.reset(WORLD_ID, ACCOUNT_ID, 10),
    ]);
    expect((await db.select().from(tutorialProgress))[0]).toMatchObject({ resetCount: 2, chapter: 1 });

    await tutorial.reset(WORLD_ID, ACCOUNT_ID, 11);
    await tutorial.reset(WORLD_ID, ACCOUNT_ID, 12);
    const limitRace = await Promise.allSettled([
      tutorial.reset(WORLD_ID, ACCOUNT_ID, 13),
      tutorial.reset(WORLD_ID, ACCOUNT_ID, 13),
    ]);
    expect(limitRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(limitRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(limitRace.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "tutorial_reset_limit" }),
    });
    expect((await db.select().from(tutorialProgress))[0]).toMatchObject({ resetCount: 5, chapter: 1 });
    expect((await db.select().from(domainEvents)).filter((event) => event.eventType === "alpha.tutorial-session-seeded")).toHaveLength(6);
  });
});
