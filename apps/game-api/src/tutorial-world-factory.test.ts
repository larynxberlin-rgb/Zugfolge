import { PGlite } from "@electric-sql/pglite";
import { accounts, domainEvents, economyOutbox, MIGRATIONS_FOLDER, operators, tutorialSessions, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";

import { TUTORIAL_TEMPLATE } from "@zugfolge/alpha";
import {
  closeTender,
  createTenderCalendar,
  deriveWorldProfile,
  dispatchEconomyOutbox,
  ECONOMY_COST_TYPES,
  EconomySchedulerMonitor,
  encodeEconomyValue,
  listLedgerTransactions,
  loadEconomyWorldState,
  openLedgerAccount,
  persistEconomyTransition,
  runEconomySchedulerCycle,
  submitBid,
} from "@zugfolge/economy";
import { eq } from "drizzle-orm";

import {
  TUTORIAL_ECONOMY_LOTS,
  TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN,
  TUTORIAL_CONTRACT_PERIOD_SECONDS,
  TUTORIAL_CONTRACT_EVIDENCE,
  TUTORIAL_LEASE_TIMES,
  TUTORIAL_SETTLEMENT_PERIOD,
  TUTORIAL_TIMELINE,
  GameTutorialWorldFactory,
  loadTutorialEconomyPlatformAdapters,
  prepareTutorialEconomy,
  tutorialPlayerBid,
  tutorialPlanningCommand,
} from "./tutorial-world-factory.js";

describe("TutorialWorldFactory PlanningRun-Vertrag", () => {
  it("haelt die Antwortfrist innerhalb des Leasing-Angebotsfensters", () => {
    expect(TUTORIAL_LEASE_TIMES.offeredAtS).toBeLessThanOrEqual(TUTORIAL_LEASE_TIMES.responseDeadlineS);
    expect(TUTORIAL_LEASE_TIMES.responseDeadlineS).toBeLessThanOrEqual(TUTORIAL_LEASE_TIMES.validFromS);
    expect(TUTORIAL_LEASE_TIMES.validFromS).toBeLessThan(TUTORIAL_LEASE_TIMES.validUntilS);
  });

  it("bildet einen gueltigen Sechsmonatskalender mit genau einem sichtbaren Tutoriallos", () => {
    expect(() => createTenderCalendar(deriveWorldProfile(6), TUTORIAL_ECONOMY_LOTS, 7_219_2026n)).not.toThrow();
    expect(TUTORIAL_ECONOMY_LOTS.filter((lot) => lot.id === "tutorial-lot")).toHaveLength(1);
  });

  it("liefert alle vom Servicevertrag verlangten Abrechnungsklassen", () => {
    expect(TUTORIAL_CONTRACT_EVIDENCE).toEqual(["vehicles", "personnel", "paths"]);
  });

  it("rechnet Periode null erst an ihrem serverseitigen Periodenende ab", () => {
    expect(TUTORIAL_SETTLEMENT_PERIOD).toBe(0);
    expect(TUTORIAL_TIMELINE.settlementAtS).toBe(
      TUTORIAL_TIMELINE.operatingFromS + TUTORIAL_CONTRACT_PERIOD_SECONDS,
    );
    expect(TUTORIAL_TIMELINE.settlementAtS).toBeGreaterThan(TUTORIAL_TIMELINE.operatingFromS + 620);
  });

  it("bindet das Tutorialjournal an seinen explizit versionierten Kontenplan", () => {
    expect(TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN).toMatchObject({
      schema: "economy-ledger-account-plan/v1",
      version: "tutorial-template-2026.1",
      cashAccountName: "Bank",
      revenueAccountName: "Bestellererloese",
      costAccountNames: {
        track: "Kosten:track",
        energy: "Kosten:energy",
        personnel: "Kosten:personnel",
      },
    });
  });

  it("oeffnet die echte Ausschreibung mit gueltigen Fristen und Vergleichsangebot", () => {
    const prepared = prepareTutorialEconomy({
      worldId: "11111111-1111-4111-8111-111111111111",
      tutorialAccountId: "tutorial-account",
      comparisonAccountId: "comparison-account",
      comparisonOperatorId: "comparison-operator",
      reference: "tut_contract",
    });
    const lifecycle = prepared.state.tenders.get("tutorial-tender");

    expect(prepared.initial.state.revision).toBe(0);
    expect(prepared.state.revision).toBeGreaterThan(prepared.initial.state.revision);
    expect(lifecycle?.phase).toBe("open");
    if (lifecycle?.phase !== "open") throw new Error("Tutorialausschreibung ist nicht offen.");
    expect(lifecycle.tender.closesAt - lifecycle.tender.opensAt).toBe(86_400);
    expect(lifecycle.tender.contractPeriods).toBe(2);
    expect(lifecycle.tender.operatingFrom).toBe(TUTORIAL_TIMELINE.operatingFromS);
    expect(lifecycle.tender.viabilityThresholdCentsPerTrainKm).toBeGreaterThanOrEqual(1_580n);
    expect(lifecycle.bids.map((bid) => bid.id)).toEqual(["tutorial-comparison-bid"]);

    const bid = tutorialPlayerBid(
      { reference: "tut_contract", tutorialOperatorId: "tutorial-operator" },
      { type: "submit-bid", orderingFeeCentsPerTrainKm: "1450", extraSeats: 12, punctualityBasisPoints: 9_200 },
      "tutorial-vehicle-economy",
    );
    expect(bid.vehicle.evidence.formationId).toBe(bid.vehicle.formationId);
    const withPlayerBid = submitBid(prepared.state, "tut_contract:player-bid", "tutorial-tender", bid, {
      accountId: "tutorial-account",
      period: 0,
      smallLot: true,
      minimumScore: 0,
    });
    const awarded = closeTender(withPlayerBid, {
      commandId: "tut_contract:close",
      tenderId: "tutorial-tender",
      at: TUTORIAL_TIMELINE.tenderClosesAtS,
      authorityId: "tutorial-authority",
      budgetPeriod: 0,
      vehiclePool: ["tutorial-public-reserve"],
      recipientByOperator: { "tutorial-operator": "tutorial-account" },
    }).state.tenders.get("tutorial-tender");
    expect(awarded?.phase).toBe("awarded");
    if (awarded?.phase !== "awarded") throw new Error("Tutorialausschreibung wurde nicht vergeben.");
    expect(awarded.winningBid.operatorId).toBe("tutorial-operator");
  });

  it("weist einen Zuschlagsretry mit geaenderten Angebotsdaten fail-closed zurueck", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const worldId = "11111111-1111-4111-8111-111111111111";
      const operatorId = "22222222-2222-4222-8222-222222222222";
      const reference = "tut_bid_replay_binding";
      const at = new Date("2026-08-13T16:00:00.000Z");
      await db.insert(worlds).values({ id: worldId, name: "Tutorial", schedulePeriodWeeks: 4, epoch: at });
      const prepared = prepareTutorialEconomy({
        worldId,
        tutorialAccountId: "tutorial-account",
        comparisonAccountId: "comparison-account",
        comparisonOperatorId: "comparison-operator",
        reference,
      });
      const original = { type: "submit-bid" as const, orderingFeeCentsPerTrainKm: "1450", extraSeats: 12, punctualityBasisPoints: 9_200 };
      const vehicleId = String(TUTORIAL_TEMPLATE.leases[0]?.["vehicleId"]);
      const withPlayerBid = submitBid(prepared.state, `${reference}:player-bid`, "tutorial-tender", tutorialPlayerBid({ reference, tutorialOperatorId: operatorId }, original, vehicleId), {
        accountId: "tutorial-account",
        period: 0,
        smallLot: true,
        minimumScore: 0,
      });
      const awarded = closeTender(withPlayerBid, {
        commandId: `${reference}:close-tender`,
        tenderId: "tutorial-tender",
        at: TUTORIAL_TIMELINE.tenderClosesAtS,
        authorityId: "tutorial-authority",
        budgetPeriod: 0,
        vehiclePool: ["tutorial-public-reserve"],
        recipientByOperator: { [operatorId]: "tutorial-account" },
      });
      await persistEconomyTransition(db, {
        expectedRevision: null,
        state: prepared.initial.state,
        effects: { notices: [], journal: [] },
        committedAt: at,
        enqueuedAt: at,
      });
      await persistEconomyTransition(db, {
        expectedRevision: prepared.initial.state.revision,
        state: awarded.state,
        effects: { notices: [], journal: [] },
        committedAt: at,
        enqueuedAt: at,
      });
      const apply = vi.fn();
      const factory = new GameTutorialWorldFactory(db, {} as never, {} as never, { apply, releaseWorld: vi.fn() } as never);
      const session = { tutorialWorldId: worldId, tutorialOperatorId: operatorId, reference, scenarioState: {} } as never;

      await expect(factory.applyAction(session, {
        ...original,
        orderingFeeCentsPerTrainKm: "1460",
      }, TUTORIAL_TEMPLATE)).rejects.toMatchObject({ code: "tutorial_action_replay_conflict" });
      expect(apply).not.toHaveBeenCalled();

      await expect(factory.applyAction(session, original, TUTORIAL_TEMPLATE)).resolves.toMatchObject({ selectedBid: original });
    } finally {
      await client.close();
    }
  });

  it("weist einen Settlement-Retry mit einer anderen Dispositionsentscheidung vor Nebenwirkungen ab", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const worldId = "11111111-1111-4111-8111-111111111111";
      const operatorId = "22222222-2222-4222-8222-222222222222";
      const reference = "tut_dispatch_replay_binding";
      const at = new Date("2026-08-13T16:00:00.000Z");
      await db.insert(worlds).values({ id: worldId, name: "Tutorial", schedulePeriodWeeks: 4, epoch: at });
      await db.insert(domainEvents).values({
        worldId,
        sequence: 1,
        eventType: "dispatch.decision-applied",
        payload: {
          decisionId: `${reference}:decision:1`,
          operatorId,
          trainRunId: "tutorial-run-1",
          action: "request_reroute",
        },
        occurredAt: at,
      });
      const evaluateDecision = vi.fn();
      const apply = vi.fn();
      const factory = new GameTutorialWorldFactory(db, { evaluateDecision } as never, {} as never, { apply, releaseWorld: vi.fn() } as never);
      const session = { tutorialWorldId: worldId, tutorialOperatorId: operatorId, reference, scenarioState: {} } as never;

      await expect(factory.applyAction(session, { type: "dispatch", action: "short_turn" }, TUTORIAL_TEMPLATE))
        .rejects.toMatchObject({ code: "tutorial_action_replay_conflict" });
      expect(apply).not.toHaveBeenCalled();
      expect(evaluateDecision).not.toHaveBeenCalled();
      expect(await db.select().from(domainEvents)).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it.each(TUTORIAL_TEMPLATE.paths.map((alternative, index) => [alternative, index + 1] as const))(
    "materialisiert jede Trassenoption mit Segmenten und einem eindeutigen Vergleichsantrag",
    (alternative, runIndex) => {
      const command = tutorialPlanningCommand({
        reference: "tut_contract",
        tutorialWorldId: "11111111-1111-4111-8111-111111111111",
      }, TUTORIAL_TEMPLATE, alternative as Record<string, unknown>, runIndex);

      expect(command.segments.length).toBeGreaterThan(0);
      expect(command.sourceId).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(command.sourceId).toBe("tutorial-minimal-2026-1-corridor");
      expect(command.requests).toHaveLength(2);
      expect(new Set(command.requests.map((request) => request.requestNumericId)).size).toBe(2);
      expect(new Set(command.requests.map((request) => request.trainId)).size).toBe(2);
      expect(new Set(command.requests.map((request) => request.train.numericId)).size).toBe(2);
      expect(new Set(command.requests.map((request) => `${request.trainCategory}:${request.trainNumber}`)).size).toBe(2);
      expect(command.requests.every((request) => request.trainCategory === "regional"
        && request.trainNumber >= 20_000
        && request.trainNumber <= 39_999
        && request.trainNumber % 2 === 0)).toBe(true);
      expect("worldId" in command.requests[0]!).toBe(false);
      expect(command.worldId).toBe("11111111-1111-4111-8111-111111111111");
    },
  );

  it("released den regionalen Tutorialruntime auch bei einem idempotenten Abschlussretry", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const releaseWorld = vi.fn();
      const factory = new GameTutorialWorldFactory(
        db,
        {} as never,
        {} as never,
        { releaseWorld } as never,
      );
      const session = {
        tutorialWorldId: "11111111-1111-4111-8111-111111111111",
        tutorialOperatorId: "22222222-2222-4222-8222-222222222222",
        reference: "tut_release_retry",
        templateHash: "a".repeat(64),
        scenarioState: {},
      } as never;

      const first = await factory.close(session, "idle-ttl", TUTORIAL_TEMPLATE);
      const retry = await factory.close(session, "idle-ttl", TUTORIAL_TEMPLATE);

      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(retry).toBe(first);
      expect(releaseWorld).toHaveBeenNthCalledWith(
        1,
        "11111111-1111-4111-8111-111111111111",
      );
      expect(releaseWorld).toHaveBeenNthCalledWith(
        2,
        "11111111-1111-4111-8111-111111111111",
      );
    } finally {
      await client.close();
    }
  });

  it("schliesst nach einem konkurrierenden Economy-Commit erneut und drainiert erst den schedulerfesten Endstand", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const publicWorldId = "11111111-1111-4111-8111-111111111111";
      const publicAccountId = "22222222-2222-4222-8222-222222222222";
      const tutorialWorldId = "33333333-3333-4333-8333-333333333333";
      const tutorialAccountId = "44444444-4444-4444-8444-444444444444";
      const tutorialOperatorId = "55555555-5555-4555-8555-555555555555";
      const comparisonAccountId = "66666666-6666-4666-8666-666666666666";
      const comparisonOperatorId = "77777777-7777-4777-8777-777777777777";
      const reference = "tut_bbbbbbbbbbbbbbbbbbbb";
      const at = new Date("2026-08-13T16:05:00.000Z");
      await db.insert(worlds).values([
        { id: publicWorldId, name: "Alpha", schedulePeriodWeeks: 4, epoch: at, worldKind: "public", rankingStatus: "ranked", lifecycleStatus: "active" },
        { id: tutorialWorldId, name: "Tutorial im Abschluss", schedulePeriodWeeks: 4, epoch: at, worldKind: "private", rankingStatus: "unranked", lifecycleStatus: "active" },
      ]);
      await db.insert(accounts).values([
        { id: publicAccountId, worldId: publicWorldId, keycloakSubject: "kc-public", displayName: "Public" },
        { id: tutorialAccountId, worldId: tutorialWorldId, keycloakSubject: "kc-tutorial", displayName: "Tutorial" },
        { id: comparisonAccountId, worldId: tutorialWorldId, keycloakSubject: "kc-comparison", displayName: "Vergleich" },
      ]);
      await db.insert(operators).values({ id: tutorialOperatorId, worldId: tutorialWorldId, foundingAccountId: tutorialAccountId, name: "Tutorial EVU" });
      const [session] = await db.insert(tutorialSessions).values({
        reference,
        publicWorldId,
        publicAccountId,
        tutorialWorldId,
        tutorialAccountId,
        tutorialOperatorId,
        templateVersion: TUTORIAL_TEMPLATE.version,
        templateHash: "a".repeat(64),
        lifecycle: "closing",
        closureReason: "completed-confirmed",
        startedAt: at,
        lastActivityAt: at,
        idleExpiresAt: new Date(at.getTime() + 60_000),
        maximumExpiresAt: new Date(at.getTime() + 120_000),
        scenarioState: {},
      }).returning();
      expect(session).toBeDefined();
      for (const name of [
        TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName,
        TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.revenueAccountName,
        ...ECONOMY_COST_TYPES.map((type) => TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.costAccountNames[type]),
      ]) {
        await openLedgerAccount(db, { worldId: tutorialWorldId, operatorId: tutorialOperatorId, name });
      }
      const prepared = prepareTutorialEconomy({
        worldId: tutorialWorldId,
        tutorialAccountId,
        comparisonAccountId,
        comparisonOperatorId,
        reference,
      });
      await persistEconomyTransition(db, {
        expectedRevision: null,
        state: prepared.initial.state,
        effects: { notices: [], journal: [] },
        committedAt: at,
        enqueuedAt: at,
      });

      const originalTransaction = db.transaction.bind(db);
      let transactionCalls = 0;
      let signalFirstCloseTransaction!: () => void;
      const firstCloseTransaction = new Promise<void>((resolve) => { signalFirstCloseTransaction = resolve; });
      let releaseFirstCloseTransaction!: () => void;
      const firstCloseGate = new Promise<void>((resolve) => { releaseFirstCloseTransaction = resolve; });
      vi.spyOn(db, "transaction").mockImplementation((async (...args: Parameters<typeof db.transaction>) => {
        transactionCalls += 1;
        if (transactionCalls === 1) {
          signalFirstCloseTransaction();
          await firstCloseGate;
        }
        return originalTransaction(...args);
      }) as typeof db.transaction);

      const releaseWorld = vi.fn();
      const factory = new GameTutorialWorldFactory(db, {} as never, {} as never, { releaseWorld } as never, { clock: () => at });
      const closePromise = factory.close(session!, "completed-confirmed", TUTORIAL_TEMPLATE);
      await firstCloseTransaction;
      try {
        await persistEconomyTransition(db, {
          expectedRevision: prepared.initial.state.revision,
          state: prepared.state,
          effects: prepared.effects,
          committedAt: new Date(at.getTime() + 1_000),
          enqueuedAt: new Date(at.getTime() + 1_000),
        });
      } finally {
        releaseFirstCloseTransaction();
      }

      await expect(closePromise).resolves.toMatch(/^[a-f0-9]{64}$/);
      expect(transactionCalls).toBeGreaterThanOrEqual(3);
      const closedEconomy = await loadEconomyWorldState(db, tutorialWorldId);
      expect(closedEconomy?.closed).toBe(true);
      expect(closedEconomy?.processedCommands.has(`${reference}:close-world`)).toBe(true);
      const outbox = await db.select().from(economyOutbox).where(eq(economyOutbox.worldId, tutorialWorldId));
      expect(outbox.length).toBeGreaterThan(0);
      expect(outbox.every((effect) => effect.processedAt !== null)).toBe(true);
      await expect(runEconomySchedulerCycle(db, new Date(at.getTime() + 200_000_000), {
        sendNotice: vi.fn(async () => undefined),
        postJournal: vi.fn(async () => undefined),
        operatingRuntime: {} as never,
        publishRuntimeEvents: vi.fn(async () => undefined),
      }, new EconomySchedulerMonitor(at.getTime()))).resolves.toMatchObject({ worlds: 1, transitions: 0, effects: 0 });
      expect(releaseWorld).toHaveBeenCalledWith(tutorialWorldId);
    } finally {
      await client.close();
    }
  });

  it("rekonstruiert die Tutorialkontierung fuer den letzten Retry vor der Archivierungs-Fence", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const publicWorldId = "11111111-1111-4111-8111-111111111111";
      const publicAccountId = "22222222-2222-4222-8222-222222222222";
      const tutorialWorldId = "33333333-3333-4333-8333-333333333333";
      const tutorialAccountId = "44444444-4444-4444-8444-444444444444";
      const tutorialOperatorId = "55555555-5555-4555-8555-555555555555";
      const at = new Date("2026-08-13T16:05:00.000Z");
      await db.insert(worlds).values([
        { id: publicWorldId, name: "Alpha", schedulePeriodWeeks: 4, epoch: at, worldKind: "public", rankingStatus: "ranked", lifecycleStatus: "active" },
        { id: tutorialWorldId, name: "Tutorial vor Archivierung", schedulePeriodWeeks: 4, epoch: at, worldKind: "private", rankingStatus: "unranked", lifecycleStatus: "active" },
      ]);
      await db.insert(accounts).values([
        { id: publicAccountId, worldId: publicWorldId, keycloakSubject: "kc-public", displayName: "Public" },
        { id: tutorialAccountId, worldId: tutorialWorldId, keycloakSubject: "kc-tutorial", displayName: "Tutorial" },
      ]);
      await db.insert(operators).values({ id: tutorialOperatorId, worldId: tutorialWorldId, foundingAccountId: tutorialAccountId, name: "Tutorial EVU" });
      const reference = "tut_aaaaaaaaaaaaaaaaaaaa";
      await db.insert(tutorialSessions).values({
        reference,
        publicWorldId,
        publicAccountId,
        tutorialWorldId,
        tutorialAccountId,
        tutorialOperatorId,
        templateVersion: TUTORIAL_TEMPLATE.version,
        templateHash: "a".repeat(64),
        lifecycle: "closing",
        startedAt: at,
        lastActivityAt: at,
        idleExpiresAt: new Date(at.getTime() + 60_000),
        maximumExpiresAt: new Date(at.getTime() + 120_000),
      });
      const accountIdByName = new Map<string, string>();
      for (const name of [
        TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName,
        TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.revenueAccountName,
        ...ECONOMY_COST_TYPES.map((type) => TUTORIAL_ECONOMY_LEDGER_ACCOUNT_PLAN.costAccountNames[type]),
      ]) {
        accountIdByName.set(name, (await openLedgerAccount(db, { worldId: tutorialWorldId, operatorId: tutorialOperatorId, name })).id);
      }
      const journal = {
        worldId: tutorialWorldId,
        operatorId: tutorialOperatorId,
        idempotencyKey: `${reference}:settlement:settlement`,
        at: 93_600,
        description: "Tutorialabschluss vor Archivierung",
        revenueCents: 1_000n,
        postings: [{ amountCents: 250n, costType: "energy" as const, costCentreId: "tutorial-lot", reference: "period-0" }],
      };
      await db.insert(economyOutbox).values({
        worldId: tutorialWorldId,
        effectId: journal.idempotencyKey,
        effectType: "journal",
        payload: encodeEconomyValue(journal),
        occurredAt: new Date(journal.at * 1_000),
        enqueuedAt: at,
        attempts: 1,
        lastErrorCode: "dispatch_failed",
      });

      const adapters = await loadTutorialEconomyPlatformAdapters(db, tutorialWorldId, tutorialOperatorId);
      expect(adapters).toBeDefined();
      await expect(dispatchEconomyOutbox(db, tutorialWorldId, adapters!, new Date(at.getTime() + 1_000))).resolves.toBe(1);
      expect(await listLedgerTransactions(db, { worldId: tutorialWorldId, operatorId: tutorialOperatorId })).toHaveLength(1);
      expect((await db.select().from(economyOutbox).where(eq(economyOutbox.worldId, tutorialWorldId)))[0]).toMatchObject({
        processedAt: new Date(at.getTime() + 1_000),
        attempts: 1,
        lastErrorCode: null,
      });
      expect(accountIdByName.size).toBe(ECONOMY_COST_TYPES.length + 2);
    } finally {
      await client.close();
    }
  });
});
