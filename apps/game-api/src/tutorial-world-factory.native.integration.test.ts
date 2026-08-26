import { PGlite } from "@electric-sql/pglite";
import { fileURLToPath } from "node:url";
import { TutorialSessionService, TUTORIAL_TEMPLATE } from "@zugfolge/alpha";
import {
  accounts,
  domainEvents,
  economyOutbox,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  MIGRATIONS_FOLDER,
  operatingProgramVersions,
  odooProjectionOutbox,
  operatorContracts,
  tutorialSessions,
  tutorialTelemetryEvents,
  vehicleAssets,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { OperationsRegistry } from "@zugfolge/dispatch";
import { LivemapRegistry } from "@zugfolge/livemap-stream";
import { loadPlanningRuntime } from "@zugfolge/planning-runtime-native";
import {
  OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV,
  loadOperatingRuntime,
  loadOperationalSimulationRuntime,
} from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import { GameTutorialWorldFactory } from "./tutorial-world-factory.js";

const PUBLIC_WORLD = "00000000-0000-4000-8000-000000000111";
const PUBLIC_ACCOUNT = "00000000-0000-4000-8000-000000000112";
const TUTORIAL_INFRA_RELEASE_ID = "tutorial-minimal-2026.1:operational-infra";
const TUTORIAL_INFRASTRUCTURE_ROOT = fileURLToPath(new URL(
  "../tutorial-infrastructure/tutorial-minimal-2026.1/",
  import.meta.url,
));
const PREVIOUS_INFRASTRUCTURE_ROOTS = process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
const nativeAvailable = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined
  && process.env["ZUGFOLGE_PLANNING_RUNTIME_NATIVE_PATH"] !== undefined;

(nativeAvailable ? describe : describe.skip)("TutorialWorldFactory mit echten Rust-/Fachpfaden", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = JSON.stringify({
      [TUTORIAL_INFRA_RELEASE_ID]: TUTORIAL_INFRASTRUCTURE_ROOT,
    });
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: PUBLIC_WORLD, name: "Alpha", schedulePeriodWeeks: 4, epoch: new Date(0), worldKind: "public", rankingStatus: "ranked", lifecycleStatus: "active" });
    await db.insert(accounts).values({ id: PUBLIC_ACCOUNT, worldId: PUBLIC_WORLD, keycloakSubject: "kc-player", displayName: "Spieler" });
  });

  afterEach(async () => {
    await client.close();
    if (PREVIOUS_INFRASTRUCTURE_ROOTS === undefined) {
      delete process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
    } else {
      process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = PREVIOUS_INFRASTRUCTURE_ROOTS;
    }
  });

  it("durchlaeuft alle fuenf Kapitel ohne vorerfuelltes Inventar und archiviert mit finalem Hash", async () => {
    const operating = loadOperatingRuntime();
    const planning = loadPlanningRuntime();
    const livemap = new LivemapRegistry();
    const regional = new RegionalSimulationWorker(db, loadOperationalSimulationRuntime(), livemap, new OperationsRegistry());
    let current = new Date("2026-08-13T10:00:00.000Z");
    const clock = () => { current = new Date(current.getTime() + 30_000); return current; };
    const service = new TutorialSessionService(
      db,
      new GameTutorialWorldFactory(db, operating, planning, regional, { clock }),
      { clock },
    );
    let view = await service.start({ publicWorldId: PUBLIC_WORLD, publicAccountId: PUBLIC_ACCOUNT, keycloakSubject: "kc-player", displayName: "Spieler" });
    const [stored] = await db.select().from(tutorialSessions);
    expect(stored).toBeDefined();
    expect(regional.isReady(view.tutorialWorldId, TUTORIAL_TEMPLATE.region.id)).toBe(true);
    expect(livemap.initializedWorld(view.tutorialWorldId)).toBeDefined();
    const lessorOperatorId = (stored!.scenarioState as Record<string, unknown>)["lessorOperatorId"];
    expect(typeof lessorOperatorId).toBe("string");
    expect(await db.select().from(ledgerAccounts).where(and(
      eq(ledgerAccounts.worldId, view.tutorialWorldId),
      eq(ledgerAccounts.operatorId, lessorOperatorId as string),
      eq(ledgerAccounts.name, "Bank"),
    ))).toHaveLength(1);
    expect(Object.values(view.evidence).every((entry) => !entry.completed)).toBe(true);
    expect((await db.select().from(operatorContracts).where(eq(operatorContracts.worldId, view.tutorialWorldId))).every((contract) => contract.status === "offered")).toBe(true);
    expect(await db.select().from(operatingProgramVersions).where(eq(operatingProgramVersions.worldId, view.tutorialWorldId))).toHaveLength(0);

    view = await service.act(view.tutorialWorldId, stored!.tutorialAccountId, { type: "submit-bid", orderingFeeCentsPerTrainKm: "1450", punctualityBasisPoints: 9200, extraSeats: 12 });
    expect(view.currentChapter).toBe(2);
    view = await service.act(view.tutorialWorldId, stored!.tutorialAccountId, { type: "accept-lease", offerId: "lease-economy" });
    expect(view.currentChapter).toBe(3);
    view = await service.act(view.tutorialWorldId, stored!.tutorialAccountId, { type: "confirm-path", alternativeId: "path-robust" });
    expect(view.currentChapter).toBe(4);
    view = await service.act(view.tutorialWorldId, stored!.tutorialAccountId, { type: "activate-program", templateId: "connections", changedRule: "hold-connections", thresholdSeconds: 240 });
    expect(view.currentChapter).toBe(5);
    view = await service.act(view.tutorialWorldId, stored!.tutorialAccountId, { type: "dispatch", action: "request_reroute" });
    expect(view.lifecycle).toBe("summary");
    const outbox = await db.select().from(economyOutbox).where(eq(economyOutbox.worldId, view.tutorialWorldId));
    expect(outbox.every((effect) => effect.processedAt !== null)).toBe(true);
    const settlementEffect = outbox.find((effect) => effect.effectId === `${view.reference}:settlement:settlement`);
    expect(settlementEffect?.enqueuedAt.getTime()).toBeLessThan(
      stored!.startedAt.getTime() + 93_600_000,
    );
    expect(view.summary).toMatchObject({ punctualityBasisPoints: 9180 });
    expect(view.summary?.resultCents).toMatch(/^-?[0-9]+$/);
    expect(view.summary?.comparison).toMatchObject({
      bidOrderingFeeCentsPerTrainKm: "1450",
      leaseLabel: "T442",
      pathLabel: "Robust mit Puffer",
      programmeRuleLabel: "Anschlüsse abwarten",
      disruptionLabel: "Umleitung anfordern",
    });
    expect(view.summary?.qualityTargetsMet).toContain("Pünktlichkeit");

    const [contracts, assets, programs, events, transactions, entries] = await Promise.all([
      db.select().from(operatorContracts).where(eq(operatorContracts.worldId, view.tutorialWorldId)),
      db.select().from(vehicleAssets).where(eq(vehicleAssets.worldId, view.tutorialWorldId)),
      db.select().from(operatingProgramVersions).where(eq(operatingProgramVersions.worldId, view.tutorialWorldId)),
      db.select().from(domainEvents).where(eq(domainEvents.worldId, view.tutorialWorldId)),
      db.select().from(ledgerTransactions).where(eq(ledgerTransactions.worldId, view.tutorialWorldId)),
      db.select().from(ledgerEntries).where(eq(ledgerEntries.worldId, view.tutorialWorldId)),
    ]);
    expect(contracts.some((contract) => ["accepted", "active", "completed"].includes(contract.status))).toBe(true);
    expect(assets.some((asset) => asset.holderOperatorId === stored!.tutorialOperatorId)).toBe(true);
    expect(programs).toEqual([expect.objectContaining({ status: "active", operatorId: stored!.tutorialOperatorId })]);
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining(["disruption.applied", "dispatch.decision-applied"]));
    expect(transactions.length).toBeGreaterThanOrEqual(2);
    for (const transaction of transactions) {
      const sum = entries.filter((entry) => entry.transactionId === transaction.id).reduce((total, entry) => total + entry.amountCents, 0n);
      expect(sum).toBe(0n);
      expect(transaction.worldId).toBe(view.tutorialWorldId);
    }

    view = await service.confirmSummary(view.tutorialWorldId, stored!.tutorialAccountId);
    expect(view.lifecycle).toBe("archived");
    expect(regional.isReady(view.tutorialWorldId, TUTORIAL_TEMPLATE.region.id)).toBe(false);
    expect(livemap.peekWorld(view.tutorialWorldId)).toBeUndefined();
    await expect(service.reap(new Date("2026-08-14T10:00:00.000Z"))).resolves.toEqual([]);
    expect((await db.select().from(tutorialSessions))[0]?.finalStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await db.select().from(tutorialTelemetryEvents)).every((event) => event.worldId === view.tutorialWorldId && event.templateVersion === TUTORIAL_TEMPLATE.version)).toBe(true);
    expect(await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, view.tutorialWorldId))).toHaveLength(0);
    expect((await db.select().from(economyOutbox).where(eq(economyOutbox.worldId, view.tutorialWorldId))).every((effect) => effect.processedAt !== null)).toBe(true);
  }, 30_000);
});
