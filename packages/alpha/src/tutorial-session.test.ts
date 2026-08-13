import { PGlite } from "@electric-sql/pglite";
import {
  accounts,
  alphaWorldProfiles,
  MIGRATIONS_FOLDER,
  tutorialSessions,
  tutorialTelemetryEvents,
  worldAccesses,
  worlds,
  type TutorialSession,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AlphaConflictError } from "./errors.js";
import {
  TUTORIAL_BID_LIMITS,
  TUTORIAL_PRESENTATION_SCHEMA,
  TutorialSessionService,
  type TutorialAction,
  type TutorialScenarioEvidence,
  type TutorialWorldFactory,
} from "./tutorial-session.js";
import { TUTORIAL_DIALOGUE_TRIGGERS, TUTORIAL_TEMPLATE, TUTORIAL_TEMPLATE_HASH, validateTutorialTemplate } from "./tutorial-template.js";

const PUBLIC_WORLD = "00000000-0000-4000-8000-000000000101";
const PUBLIC_ACCOUNT_1 = "00000000-0000-4000-8000-000000000102";
const PUBLIC_ACCOUNT_2 = "00000000-0000-4000-8000-000000000103";

function completed(session: TutorialSession): number[] {
  const value = (session.scenarioState as Record<string, unknown>)["completed"];
  return Array.isArray(value) ? value.filter((entry): entry is number => Number.isSafeInteger(entry)) : [];
}

function chapter(action: TutorialAction): number {
  return action.type === "submit-bid" ? 1 : action.type === "accept-lease" ? 2 : action.type === "confirm-path" ? 3 : action.type === "activate-program" ? 4 : 5;
}

class RecordingFactory implements TutorialWorldFactory {
  provisionCalls = 0;
  closeCalls = 0;
  failFirstProvision = false;
  failFirstClose = false;

  async provision(): Promise<Readonly<Record<string, unknown>>> {
    this.provisionCalls += 1;
    if (this.failFirstProvision && this.provisionCalls === 1) throw new Error("simulierter Prozessabbruch");
    return { completed: [], inventory: "prepared-not-completed" };
  }

  async applyAction(session: TutorialSession, action: TutorialAction): Promise<Readonly<Record<string, unknown>>> {
    return { ...(session.scenarioState as Record<string, unknown>), completed: [...new Set([...completed(session), chapter(action)])] };
  }

  async evidence(session: TutorialSession): Promise<TutorialScenarioEvidence> {
    const values = new Set(completed(session));
    const evidence = (item: number) => ({ completed: values.has(item), references: values.has(item) ? [`${session.tutorialWorldId}:proof:${item}`] : [] });
    return { chapters: [evidence(1), evidence(2), evidence(3), evidence(4), evidence(5)] };
  }

  async presentation() {
    return {
      schemaVersion: TUTORIAL_PRESENTATION_SCHEMA,
      tender: {
        id: "tutorial-tender",
        priceWeightBasisPoints: 5_000,
        qualityWeightBasisPoints: 5_000,
        penaltyFocus: "punctuality",
        viabilityThresholdCentsPerTrainKm: "1739",
        limits: TUTORIAL_BID_LIMITS,
      },
      leases: [], paths: [], programmes: [], programmeRuleEffects: [], disruptionOptions: [],
    };
  }
  async summary() { return { startLiquidityCents: "2000000", leasingCostCents: "210000", pathAndOperatingCostCents: "768000", orderingRevenueCents: "1560000", disruptionCostCents: "95000", resultCents: "487000", punctualityBasisPoints: 9180, qualityTargetsMet: ["Puenktlichkeit"], comparison: { selectedAction: "request_reroute" } }; }
  async close(session: TutorialSession) {
    this.closeCalls += 1;
    if (this.failFirstClose && this.closeCalls === 1) throw new Error("simulierter Abschlussabbruch");
    return session.tutorialWorldId.replaceAll("-", "").padEnd(64, "0").slice(0, 64);
  }
}

const actions: readonly TutorialAction[] = [
  { type: "submit-bid", orderingFeeCentsPerTrainKm: "1450", punctualityBasisPoints: 9200, extraSeats: 12 },
  { type: "accept-lease", offerId: "lease-economy" },
  { type: "confirm-path", alternativeId: "path-robust" },
  { type: "activate-program", templateId: "connections", changedRule: "hold-connections", thresholdSeconds: 240 },
  { type: "dispatch", action: "request_reroute" },
];

describe("TutorialSessionService", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let now: Date;
  let factory: RecordingFactory;
  let service: TutorialSessionService;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    now = new Date("2026-08-13T10:00:00.000Z");
    await db.insert(worlds).values({ id: PUBLIC_WORLD, name: "Oeffentliche Alpha", schedulePeriodWeeks: 4, epoch: now, worldKind: "public", rankingStatus: "ranked", lifecycleStatus: "active" });
    await db.insert(accounts).values([
      { id: PUBLIC_ACCOUNT_1, worldId: PUBLIC_WORLD, keycloakSubject: "kc-player-1", displayName: "Spieler 1" },
      { id: PUBLIC_ACCOUNT_2, worldId: PUBLIC_WORLD, keycloakSubject: "kc-player-2", displayName: "Spieler 2" },
    ]);
    factory = new RecordingFactory();
    service = new TutorialSessionService(db, factory, { clock: () => now });
  }, 30_000);

  afterEach(async () => client.close());

  async function start(accountId = PUBLIC_ACCOUNT_1, subject = "kc-player-1") {
    return service.start({ publicWorldId: PUBLIC_WORLD, publicAccountId: accountId, keycloakSubject: subject, displayName: accountId === PUBLIC_ACCOUNT_1 ? "Spieler 1" : "Spieler 2" });
  }

  it("erzeugt genau eine private Welt pro Weltkonto und setzt sie bei Doppelstart fort", async () => {
    const first = await start();
    const replay = await start();
    expect(first.reference).toMatch(/^tut_[a-z2-7]{20,52}$/);
    expect(replay.tutorialWorldId).toBe(first.tutorialWorldId);
    expect(factory.provisionCalls).toBe(1);
    expect(await db.select().from(tutorialSessions)).toHaveLength(1);
    expect(await service.activeForPublicAccount(PUBLIC_WORLD, PUBLIC_ACCOUNT_1)).toMatchObject({ tutorialWorldId: first.tutorialWorldId });
    const [world, profile, access] = await Promise.all([
      db.select().from(worlds), db.select().from(alphaWorldProfiles), db.select().from(worldAccesses),
    ]);
    expect(world.find((entry) => entry.id === first.tutorialWorldId)).toMatchObject({ worldKind: "private", rankingStatus: "unranked" });
    expect(profile).toHaveLength(1);
    expect(profile[0]).toMatchObject({ worldId: first.tutorialWorldId, profileKind: "tutorial", accelerationFactor: 240 });
    expect(access.find((entry) => entry.worldId === first.tutorialWorldId)).toMatchObject({ keycloakSubject: "kc-player-1", status: "active" });
  });

  it("serialisiert parallele Starts und isoliert zwei Spieler vollstaendig", async () => {
    const [sameA, sameB] = await Promise.all([start(), start()]);
    expect(sameA.tutorialWorldId).toBe(sameB.tutorialWorldId);
    const other = await start(PUBLIC_ACCOUNT_2, "kc-player-2");
    expect(other.tutorialWorldId).not.toBe(sameA.tutorialWorldId);
    const sessions = await db.select().from(tutorialSessions);
    expect(new Set(sessions.map((entry) => entry.tutorialWorldId))).toEqual(new Set([sameA.tutorialWorldId, other.tutorialWorldId]));
    expect(sessions.every((entry) => entry.publicWorldId === PUBLIC_WORLD)).toBe(true);
    await expect(service.resume(sameA.tutorialWorldId, sessions.find((entry) => entry.tutorialWorldId === other.tutorialWorldId)!.tutorialAccountId)).rejects.toThrow(/gehoert nicht/);
  });

  it("setzt Provisionierung nach Prozessabbruch idempotent fort", async () => {
    factory.failFirstProvision = true;
    await expect(start()).rejects.toThrow("simulierter Prozessabbruch");
    expect((await db.select().from(tutorialSessions))[0]).toMatchObject({ lifecycle: "provisioning" });
    const restartedProcess = new TutorialSessionService(db, factory, { clock: () => now });
    const resumed = await restartedProcess.start({ publicWorldId: PUBLIC_WORLD, publicAccountId: PUBLIC_ACCOUNT_1, keycloakSubject: "kc-player-1", displayName: "Spieler 1" });
    expect(resumed.lifecycle).toBe("running");
    expect(factory.provisionCalls).toBe(2);
    expect(await db.select().from(tutorialSessions)).toHaveLength(1);
  });

  it("leitet alle Kapitel nur aus Weltbelegen ab, zeigt die Zusammenfassung und schliesst danach", async () => {
    let view = await start();
    const sessionRow = (await db.select().from(tutorialSessions))[0]!;
    expect(Object.values(view.evidence).every((entry) => !entry.completed)).toBe(true);
    for (const action of actions) {
      now = new Date(now.getTime() + 60_000);
      view = await service.act(view.tutorialWorldId, sessionRow.tutorialAccountId, action);
    }
    expect(view.lifecycle).toBe("summary");
    expect(view.summary?.resultCents).toBe("487000");
    now = new Date(now.getTime() + 1_000);
    view = await service.confirmSummary(view.tutorialWorldId, sessionRow.tutorialAccountId);
    expect(view.lifecycle).toBe("archived");
    await expect(service.act(view.tutorialWorldId, sessionRow.tutorialAccountId, actions[4]!)).rejects.toBeInstanceOf(AlphaConflictError);
    expect((await db.select().from(worlds)).find((entry) => entry.id === view.tutorialWorldId)?.lifecycleStatus).toBe("archived");
    expect((await db.select().from(worldAccesses)).find((entry) => entry.worldId === view.tutorialWorldId)?.status).toBe("revoked");
    const telemetry = await db.select().from(tutorialTelemetryEvents);
    expect(telemetry.map((entry) => entry.eventType)).toEqual(expect.arrayContaining(["tutorial_session_started", "tutorial_chapter_started", "tutorial_chapter_completed", "tutorial_completed", "tutorial_world_closed"]));
    expect(telemetry.find((entry) => entry.eventType === "tutorial_completed")).toMatchObject({ chapter: 5, elapsedMilliseconds: 300_000 });
  });

  it("archiviert beim Neustart und uebernimmt keine alten Nachweise", async () => {
    const first = await start();
    const firstRow = (await db.select().from(tutorialSessions))[0]!;
    await service.act(first.tutorialWorldId, firstRow.tutorialAccountId, actions[0]!);
    const second = await service.restart(first.tutorialWorldId, firstRow.tutorialAccountId);
    expect(second.tutorialWorldId).not.toBe(first.tutorialWorldId);
    expect(second.currentChapter).toBe(1);
    expect(Object.values(second.evidence).every((entry) => !entry.completed)).toBe(true);
    const rows = await db.select().from(tutorialSessions);
    expect(rows.find((entry) => entry.tutorialWorldId === first.tutorialWorldId)).toMatchObject({ lifecycle: "archived", closureReason: "restarted" });
    expect(rows.find((entry) => entry.tutorialWorldId === second.tutorialWorldId)).toMatchObject({ lifecycle: "running" });
  });

  it("schliesst inaktive Sitzungen per realer TTL und protokolliert den Abbruchgrund", async () => {
    const view = await start();
    now = new Date(now.getTime() + TUTORIAL_TEMPLATE.idleTtlMilliseconds + 1);
    await expect(service.reap()).resolves.toEqual([view.reference]);
    const [stored] = await db.select().from(tutorialSessions);
    expect(stored).toMatchObject({ lifecycle: "archived", closureReason: "idle-ttl" });
    expect((await db.select().from(tutorialTelemetryEvents)).find((entry) => entry.eventType === "tutorial_abandoned")).toMatchObject({ reason: "idle-ttl" });
  });

  it("setzt einen unterbrochenen Abschluss nach Prozessneustart idempotent fort", async () => {
    let view = await start();
    const sessionRow = (await db.select().from(tutorialSessions))[0]!;
    for (const action of actions) view = await service.act(view.tutorialWorldId, sessionRow.tutorialAccountId, action);
    factory.failFirstClose = true;
    await expect(service.confirmSummary(view.tutorialWorldId, sessionRow.tutorialAccountId)).rejects.toThrow("simulierter Abschlussabbruch");
    expect((await db.select().from(tutorialSessions))[0]).toMatchObject({ lifecycle: "closing", closureReason: "completed-confirmed" });

    const restartedProcess = new TutorialSessionService(db, factory, { clock: () => now });
    await expect(restartedProcess.reap()).resolves.toEqual([view.reference]);
    expect((await db.select().from(tutorialSessions))[0]).toMatchObject({ lifecycle: "archived", closureReason: "completed-confirmed" });
    expect(factory.closeCalls).toBe(2);
  });

  it("haelt Template, Dialoge, endliches Kapital und Hash reproduzierbar", () => {
    expect(() => validateTutorialTemplate(TUTORIAL_TEMPLATE)).not.toThrow();
    expect(TUTORIAL_TEMPLATE_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(TUTORIAL_TEMPLATE.tutorialCapitalCents).toBe(2_000_000n);
    expect(TUTORIAL_TEMPLATE.tutorialCapitalCents > 0n).toBe(true);
    expect(new Set(TUTORIAL_DIALOGUE_TRIGGERS).size).toBe(TUTORIAL_DIALOGUE_TRIGGERS.length);
  });
});
