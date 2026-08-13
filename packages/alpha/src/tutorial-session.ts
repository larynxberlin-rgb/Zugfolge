import { randomBytes, randomUUID } from "node:crypto";

import {
  accountRoles,
  accounts,
  alphaWorldProfiles,
  operators,
  tutorialProgress,
  tutorialSessions,
  tutorialTelemetryEvents,
  worldAccesses,
  worlds,
  type TutorialSession,
} from "@zugfolge/db";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { AlphaAuthorizationError, AlphaConflictError, AlphaValidationError } from "./errors.js";
import { alphaHash } from "./hash.js";
import {
  TUTORIAL_CHAPTERS,
  TUTORIAL_DIALOGUES,
  TUTORIAL_TEMPLATE,
  type TutorialDialogue,
  type TutorialDialogueTrigger,
  type TutorialTemplate,
} from "./tutorial-template.js";
import type { AlphaDatabase } from "./world.js";

export type TutorialLifecycle = TutorialSession["lifecycle"];
export type TutorialTelemetryEventType = typeof tutorialTelemetryEvents.$inferInsert["eventType"];

export const TUTORIAL_SESSION_SCHEMA = "zugfolge-tutorial-session/v1" as const;
export const TUTORIAL_PRESENTATION_SCHEMA = "zugfolge-tutorial-presentation/v1" as const;

export const TUTORIAL_BID_LIMITS = Object.freeze({
  minimumOrderingFeeCentsPerTrainKm: "100",
  maximumOrderingFeeCentsPerTrainKm: "1520",
  defaultOrderingFeeCentsPerTrainKm: "1450",
  minimumPunctualityBasisPoints: 8_800,
  maximumPunctualityBasisPoints: 9_800,
  defaultPunctualityBasisPoints: 9_200,
  minimumExtraSeats: 0,
  maximumExtraSeats: 40,
  defaultExtraSeats: 12,
} as const);

export type TutorialAction =
  | { readonly type: "submit-bid"; readonly orderingFeeCentsPerTrainKm: string; readonly punctualityBasisPoints: number; readonly extraSeats: number }
  | { readonly type: "accept-lease"; readonly offerId: string }
  | { readonly type: "confirm-path"; readonly alternativeId: string }
  | { readonly type: "activate-program"; readonly templateId: string; readonly changedRule: "hold-connections" | "prioritize-punctuality" | "activate-reserve"; readonly thresholdSeconds: number }
  | { readonly type: "dispatch"; readonly action: "short_turn" | "request_reroute" | "trigger_rail_replacement" };

export type TutorialProgrammeRule = Extract<TutorialAction, { readonly type: "activate-program" }>["changedRule"];

export interface TutorialProgrammeEffect {
  readonly costCents: string;
  readonly qualityBasisPoints: number;
  readonly penaltyRiskBasisPoints: number;
}

export interface TutorialChapterEvidence {
  readonly completed: boolean;
  readonly references: readonly string[];
}

export interface TutorialScenarioEvidence {
  readonly chapters: readonly [
    TutorialChapterEvidence,
    TutorialChapterEvidence,
    TutorialChapterEvidence,
    TutorialChapterEvidence,
    TutorialChapterEvidence,
  ];
}

export interface TutorialResultSummary {
  readonly startLiquidityCents: string;
  readonly leasingCostCents: string;
  readonly pathAndOperatingCostCents: string;
  readonly orderingRevenueCents: string;
  readonly disruptionCostCents: string;
  readonly resultCents: string;
  readonly punctualityBasisPoints: number;
  readonly qualityTargetsMet: readonly string[];
  readonly comparison: Readonly<Record<string, string | number>>;
}

export interface TutorialTenderPresentation {
  readonly id: string;
  readonly priceWeightBasisPoints: number;
  readonly qualityWeightBasisPoints: number;
  readonly penaltyFocus: string;
  readonly viabilityThresholdCentsPerTrainKm: string;
  readonly limits: typeof TUTORIAL_BID_LIMITS;
}

export interface TutorialLeasePresentation {
  readonly id: string;
  readonly vehicleId: string;
  readonly classDesignation: string;
  readonly monthlyCostCents: string;
  readonly seats: number;
  readonly conditionBasisPoints: number;
  readonly reliabilityBasisPoints: number;
  readonly marginEffectCents: string;
  readonly contractId?: string;
  readonly status: string;
}

export interface TutorialPathPresentation {
  readonly id: string;
  readonly receiptId: string;
  readonly label: string;
  readonly desiredDepartureS: number;
  readonly bufferSeconds: number;
  readonly costCents: string;
  readonly selected: boolean;
  readonly planning?: { readonly stateHash: string; readonly projectionRevision: number };
}

export interface TutorialProgrammePresentation {
  readonly id: string;
  readonly label: string;
  readonly baseThresholdSeconds: number;
  readonly selected: boolean;
  readonly effect?: TutorialProgrammeEffect;
}

export interface TutorialProgrammeRuleEffect {
  readonly rule: TutorialProgrammeRule;
  readonly label: string;
  readonly effect: TutorialProgrammeEffect;
}

export interface TutorialDisruptionPresentation {
  readonly action: "short_turn" | "request_reroute" | "trigger_rail_replacement";
  readonly label: string;
  readonly costCents: string;
  readonly punctualityBasisPoints: number;
  readonly cancellations: number;
}

export interface TutorialScenarioPresentation {
  readonly schemaVersion: typeof TUTORIAL_PRESENTATION_SCHEMA;
  readonly tender: TutorialTenderPresentation;
  readonly leases: readonly TutorialLeasePresentation[];
  readonly paths: readonly TutorialPathPresentation[];
  readonly programmes: readonly TutorialProgrammePresentation[];
  readonly programmeRuleEffects: readonly TutorialProgrammeRuleEffect[];
  readonly disruptionOptions: readonly TutorialDisruptionPresentation[];
}

export interface TutorialWorldFactory {
  provision(session: TutorialSession, template: TutorialTemplate): Promise<Readonly<Record<string, unknown>>>;
  applyAction(session: TutorialSession, action: TutorialAction, template: TutorialTemplate): Promise<Readonly<Record<string, unknown>>>;
  evidence(session: TutorialSession, template: TutorialTemplate): Promise<TutorialScenarioEvidence>;
  presentation(session: TutorialSession, template: TutorialTemplate): Promise<TutorialScenarioPresentation>;
  summary(session: TutorialSession, template: TutorialTemplate): Promise<TutorialResultSummary>;
  close(session: TutorialSession, reason: string, template: TutorialTemplate): Promise<string>;
}

export interface TutorialSessionView {
  readonly schemaVersion: typeof TUTORIAL_SESSION_SCHEMA;
  readonly reference: string;
  readonly tutorialWorldId: string;
  readonly publicWorldId: string;
  readonly lifecycle: TutorialLifecycle;
  readonly templateVersion: string;
  readonly templateHash: string;
  readonly currentChapter: number;
  readonly progressLabel: string;
  readonly chapters: readonly (typeof TUTORIAL_CHAPTERS)[number][];
  readonly evidence: Readonly<Record<string, TutorialChapterEvidence>>;
  readonly dialogue: TutorialDialogue;
  readonly presentation: TutorialScenarioPresentation;
  readonly summary?: TutorialResultSummary;
  readonly idleExpiresAt: string;
  readonly maximumExpiresAt: string;
  readonly publicWorldUrl: string;
}

export interface TutorialSessionOptions {
  readonly clock?: () => Date;
  readonly template?: TutorialTemplate;
}

const ACTIVE_LIFECYCLES = ["provisioning", "running", "summary", "closing"] as const;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function tutorialReference(): string {
  const bytes = randomBytes(16);
  let buffer = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += BASE32[(buffer << (5 - bits)) & 31];
  return `tut_${encoded}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numericRecord(value: unknown): Record<string, number> {
  const entries = Object.entries(record(value)).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && (entry[1] as number) >= 0);
  return Object.fromEntries(entries);
}

function booleanRecord(value: unknown): Record<string, boolean> {
  const entries = Object.entries(record(value)).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean");
  return Object.fromEntries(entries);
}

function elapsedMilliseconds(session: TutorialSession, at: Date): number {
  return Math.max(0, at.getTime() - session.startedAt.getTime());
}

function actionChapter(action: TutorialAction): number {
  return action.type === "submit-bid" ? 1
    : action.type === "accept-lease" ? 2
      : action.type === "confirm-path" ? 3
        : action.type === "activate-program" ? 4
          : 5;
}

function triggerFromState(session: TutorialSession): TutorialDialogueTrigger {
  const explicit = record(session.scenarioState)["dialogueTrigger"];
  if (typeof explicit === "string" && TUTORIAL_DIALOGUES.some((entry) => entry.trigger === explicit)) return explicit as TutorialDialogueTrigger;
  if (session.lifecycle === "summary") return "summary.ready";
  if (session.lifecycle === "archived" || session.lifecycle === "closing") return "session.closed";
  return session.currentChapter === 1 && session.lifecycle === "running" ? "session.started" : `chapter.${session.currentChapter}.started` as TutorialDialogueTrigger;
}

function dialogueFor(session: TutorialSession): TutorialDialogue {
  const trigger = triggerFromState(session);
  const found = TUTORIAL_DIALOGUES.find((entry) => entry.trigger === trigger && entry.chapter === session.currentChapter)
    ?? TUTORIAL_DIALOGUES.find((entry) => entry.trigger === trigger)
    ?? TUTORIAL_DIALOGUES.find((entry) => entry.trigger === `chapter.${session.currentChapter}.started`);
  if (found === undefined) throw new Error(`Tutorialdialog fuer '${trigger}' fehlt.`);
  return found;
}

function evidencePayload(evidence: TutorialScenarioEvidence): Readonly<Record<string, TutorialChapterEvidence>> {
  return Object.fromEntries(evidence.chapters.map((item, index) => [String(index + 1), item]));
}

function firstIncomplete(evidence: TutorialScenarioEvidence): number {
  const index = evidence.chapters.findIndex((entry) => !entry.completed);
  return index === -1 ? 6 : index + 1;
}

export class TutorialSessionService {
  readonly #clock: () => Date;
  readonly #template: TutorialTemplate;
  readonly #templateHash: string;

  constructor(
    private readonly db: AlphaDatabase,
    private readonly factory: TutorialWorldFactory,
    options: TutorialSessionOptions = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#template = options.template ?? TUTORIAL_TEMPLATE;
    this.#templateHash = alphaHash(this.#template.schemaVersion, this.#template);
  }

  private async telemetry(
    session: TutorialSession,
    eventType: TutorialTelemetryEventType,
    at: Date,
    options: { readonly chapter?: number; readonly reason?: string; readonly suffix?: string } = {},
  ): Promise<void> {
    const attempts = numericRecord(session.correctionAttempts);
    const hints = booleanRecord(session.hintsUsed);
    const chapter = options.chapter;
    await this.db.insert(tutorialTelemetryEvents).values({
      worldId: session.tutorialWorldId,
      sessionId: session.id,
      idempotencyKey: `${eventType}:${options.suffix ?? chapter ?? "session"}`,
      eventType,
      templateVersion: session.templateVersion,
      chapter,
      elapsedMilliseconds: elapsedMilliseconds(session, at),
      correctionAttempts: chapter === undefined ? 0 : attempts[String(chapter)] ?? 0,
      hintUsed: chapter === undefined ? false : hints[String(chapter)] ?? false,
      reason: options.reason,
      occurredAt: at,
    }).onConflictDoNothing({
      target: [tutorialTelemetryEvents.worldId, tutorialTelemetryEvents.idempotencyKey],
    });
  }

  private active(publicWorldId: string, publicAccountId: string): Promise<TutorialSession | undefined> {
    return this.db.select().from(tutorialSessions).where(and(
      eq(tutorialSessions.publicWorldId, publicWorldId),
      eq(tutorialSessions.publicAccountId, publicAccountId),
      inArray(tutorialSessions.lifecycle, [...ACTIVE_LIFECYCLES]),
    )).orderBy(asc(tutorialSessions.createdAt)).limit(1).then((rows) => rows[0]);
  }

  private async ownedTutorial(tutorialWorldId: string, tutorialAccountId: string): Promise<TutorialSession> {
    const [session] = await this.db.select().from(tutorialSessions).where(and(
      eq(tutorialSessions.tutorialWorldId, tutorialWorldId),
      eq(tutorialSessions.tutorialAccountId, tutorialAccountId),
    )).limit(1);
    if (session === undefined) throw new AlphaAuthorizationError("Tutorialsitzung gehoert nicht zu diesem Weltkonto.");
    return session;
  }

  private async ensureProvisioned(session: TutorialSession): Promise<TutorialSession> {
    if (session.lifecycle !== "provisioning") return session;
    const scenarioState = await this.factory.provision(session, this.#template);
    const now = this.#clock();
    const [updated] = await this.db.update(tutorialSessions).set({
      lifecycle: "running",
      provisioningStep: "ready",
      scenarioState: { ...scenarioState, dialogueTrigger: "session.started" },
      lastActivityAt: now,
      idleExpiresAt: new Date(now.getTime() + this.#template.idleTtlMilliseconds),
      updatedAt: now,
    }).where(and(
      eq(tutorialSessions.id, session.id),
      eq(tutorialSessions.tutorialWorldId, session.tutorialWorldId),
      eq(tutorialSessions.lifecycle, "provisioning"),
    )).returning();
    const current = updated ?? (await this.db.select().from(tutorialSessions).where(and(
      eq(tutorialSessions.id, session.id), eq(tutorialSessions.tutorialWorldId, session.tutorialWorldId),
    )).limit(1))[0];
    if (current === undefined) throw new Error("Provisionierte Tutorialsitzung konnte nicht gelesen werden.");
    if (updated !== undefined) {
      await this.db.update(alphaWorldProfiles).set({ state: "running", startedAtS: 0 }).where(and(
        eq(alphaWorldProfiles.worldId, session.tutorialWorldId), eq(alphaWorldProfiles.state, "draft"),
      ));
      await this.telemetry(current, "tutorial_session_started", now);
      await this.telemetry(current, "tutorial_chapter_started", now, { chapter: 1 });
    }
    return current;
  }

  async start(input: {
    readonly publicWorldId: string;
    readonly publicAccountId: string;
    readonly keycloakSubject: string;
    readonly displayName: string;
  }): Promise<TutorialSessionView> {
    const now = this.#clock();
    let session = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select ${accounts.id} from ${accounts} where ${accounts.worldId} = ${input.publicWorldId} and ${accounts.id} = ${input.publicAccountId} for update`);
      const [publicAccount] = await tx.select().from(accounts).where(and(
        eq(accounts.worldId, input.publicWorldId),
        eq(accounts.id, input.publicAccountId),
        eq(accounts.keycloakSubject, input.keycloakSubject),
      )).limit(1);
      if (publicAccount === undefined || publicAccount.erasedAt !== null) throw new AlphaAuthorizationError("Oeffentliches Weltkonto ist nicht aktiv.");
      const [existing] = await tx.select().from(tutorialSessions).where(and(
        eq(tutorialSessions.publicWorldId, input.publicWorldId),
        eq(tutorialSessions.publicAccountId, input.publicAccountId),
        inArray(tutorialSessions.lifecycle, [...ACTIVE_LIFECYCLES]),
      )).limit(1);
      if (existing !== undefined) return existing;

      const tutorialWorldId = randomUUID();
      const reference = tutorialReference();
      await tx.insert(worlds).values({
        id: tutorialWorldId,
        name: `Tutorial ${reference}`,
        schedulePeriodWeeks: this.#template.schedulePeriodWeeks,
        epoch: now,
        worldKind: "private",
        rankingStatus: "unranked",
        lifecycleStatus: "active",
        createdAt: now,
      });
      await tx.insert(worldAccesses).values({ worldId: tutorialWorldId, keycloakSubject: input.keycloakSubject, status: "active", grantedAt: now });
      const [tutorialAccount] = await tx.insert(accounts).values({
        worldId: tutorialWorldId,
        keycloakSubject: input.keycloakSubject,
        displayName: input.displayName,
        createdAt: now,
      }).returning();
      if (tutorialAccount === undefined) throw new Error("Tutorialkonto konnte nicht angelegt werden.");
      await tx.insert(accountRoles).values({ worldId: tutorialWorldId, accountId: tutorialAccount.id, role: "player", grantedAt: now });
      const [operator] = await tx.insert(operators).values({
        worldId: tutorialWorldId,
        foundingAccountId: tutorialAccount.id,
        name: `Kieselgrund Regional ${reference.slice(-6)}`,
        foundedAt: now,
      }).returning();
      if (operator === undefined) throw new Error("Tutorial-EVU konnte nicht angelegt werden.");
      const blueprint = {
        schemaVersion: this.#template.schemaVersion,
        templateVersion: this.#template.version,
        templateHash: this.#templateHash,
        instanceReference: reference,
      };
      await tx.insert(alphaWorldProfiles).values({
        worldId: tutorialWorldId,
        profileKind: "tutorial",
        regionId: this.#template.region.id,
        regionVariant: "tutorial-minimal",
        worldSeed: this.#template.worldSeed,
        accelerationFactor: this.#template.accelerationFactor,
        infraReleaseHash: this.#templateHash,
        timetableReleaseHash: this.#templateHash,
        fleetReleaseHash: this.#templateHash,
        economyReleaseHash: this.#templateHash,
        blueprint,
        blueprintHash: alphaHash("zugfolge-tutorial-instance-blueprint/v1", blueprint),
        periodCount: 1,
        state: "draft",
        createdAt: now,
      });
      const [created] = await tx.insert(tutorialSessions).values({
        reference,
        publicWorldId: input.publicWorldId,
        publicAccountId: input.publicAccountId,
        tutorialWorldId,
        tutorialAccountId: tutorialAccount.id,
        tutorialOperatorId: operator.id,
        templateVersion: this.#template.version,
        templateHash: this.#templateHash,
        lifecycle: "provisioning",
        provisioningStep: "world-created",
        currentChapter: 1,
        scenarioState: {},
        correctionAttempts: {},
        hintsUsed: {},
        startedAt: now,
        lastActivityAt: now,
        idleExpiresAt: new Date(now.getTime() + this.#template.idleTtlMilliseconds),
        maximumExpiresAt: new Date(now.getTime() + this.#template.maximumDurationMilliseconds),
        createdAt: now,
        updatedAt: now,
      }).returning();
      if (created === undefined) throw new Error("Tutorialsitzung konnte nicht angelegt werden.");
      await tx.insert(tutorialProgress).values({
        worldId: tutorialWorldId,
        accountId: tutorialAccount.id,
        chapter: 1,
        chapterState: "ready",
        evidence: {},
        explanationCode: "tutorial.welcome",
        checkpointHash: alphaHash("zugfolge-tutorial-checkpoint/v2", { tutorialWorldId, reference, chapter: 1, evidence: {} }),
        resetCount: 0,
        completedAtS: null,
        updatedAtS: 0,
      });
      return created;
    });
    if (session.lifecycle === "closing") {
      await this.closeSession(session, session.closureReason ?? "closing-resumed", now);
      return this.start(input);
    }
    session = await this.ensureProvisioned(session);
    return this.view(session);
  }

  async activeForPublicAccount(publicWorldId: string, publicAccountId: string): Promise<TutorialSessionView | undefined> {
    const found = await this.active(publicWorldId, publicAccountId);
    if (found === undefined) return undefined;
    return this.view(await this.ensureProvisioned(found));
  }

  async resume(tutorialWorldId: string, tutorialAccountId: string): Promise<TutorialSessionView> {
    return this.view(await this.ensureProvisioned(await this.ownedTutorial(tutorialWorldId, tutorialAccountId)));
  }

  async act(tutorialWorldId: string, tutorialAccountId: string, action: TutorialAction): Promise<TutorialSessionView> {
    let session = await this.ensureProvisioned(await this.ownedTutorial(tutorialWorldId, tutorialAccountId));
    if (session.lifecycle !== "running") throw new AlphaConflictError("Tutorialwelt akzeptiert in diesem Zustand keine neuen Spielkommandos.", "tutorial_world_closed");
    const chapter = actionChapter(action);
    if (chapter !== session.currentChapter) throw new AlphaConflictError("Aktion gehoert nicht zum aktuellen Tutorialkapitel.", "tutorial_wrong_chapter");
    const pending = session.pendingAction as TutorialAction | null;
    if (pending !== null && JSON.stringify(pending) !== JSON.stringify(action)) throw new AlphaConflictError("Fuer dieses Kapitel wird bereits eine andere Aktion autoritativ verarbeitet.", "tutorial_action_in_progress");
    if (pending === null) {
      const [claimed] = await this.db.update(tutorialSessions).set({ pendingAction: action, actionRevision: session.actionRevision + 1 }).where(and(
        eq(tutorialSessions.id, session.id),
        eq(tutorialSessions.tutorialWorldId, tutorialWorldId),
        eq(tutorialSessions.lifecycle, "running"),
        eq(tutorialSessions.currentChapter, chapter),
        eq(tutorialSessions.actionRevision, session.actionRevision),
        sql`${tutorialSessions.pendingAction} is null`,
      )).returning();
      if (claimed === undefined) return this.act(tutorialWorldId, tutorialAccountId, action);
      session = claimed;
    }

    let scenarioState: Readonly<Record<string, unknown>>;
    try {
      scenarioState = await this.factory.applyAction(session, action, this.#template);
    } catch (error) {
      const attempts = numericRecord(session.correctionAttempts);
      attempts[String(chapter)] = (attempts[String(chapter)] ?? 0) + 1;
      await this.db.update(tutorialSessions).set({
        pendingAction: null,
        correctionAttempts: attempts,
        scenarioState: { ...record(session.scenarioState), dialogueTrigger: `chapter.${chapter}.invalid` },
        updatedAt: this.#clock(),
      }).where(and(eq(tutorialSessions.id, session.id), eq(tutorialSessions.tutorialWorldId, tutorialWorldId)));
      if (error instanceof AlphaValidationError || error instanceof AlphaConflictError) throw error;
      throw new AlphaValidationError(error instanceof Error ? error.message : "Tutorialaktion ist fehlgeschlagen.");
    }

    const evidence = await this.factory.evidence({ ...session, scenarioState } as TutorialSession, this.#template);
    const next = firstIncomplete(evidence);
    if (next <= chapter) throw new AlphaConflictError("Autoritativer Fachnachweis fuer dieses Kapitel fehlt noch.", "tutorial_evidence_missing");
    const now = this.#clock();
    const completed = next === 6;
    const trigger: TutorialDialogueTrigger = completed ? "summary.ready" : `chapter.${chapter}.completed` as TutorialDialogueTrigger;
    const [updated] = await this.db.update(tutorialSessions).set({
      pendingAction: null,
      scenarioState: { ...scenarioState, dialogueTrigger: trigger },
      currentChapter: completed ? 5 : next,
      lifecycle: completed ? "summary" : "running",
      summaryAt: completed ? now : null,
      graceExpiresAt: completed ? new Date(now.getTime() + this.#template.summaryGraceMilliseconds) : null,
      lastActivityAt: now,
      idleExpiresAt: new Date(now.getTime() + this.#template.idleTtlMilliseconds),
      updatedAt: now,
    }).where(and(eq(tutorialSessions.id, session.id), eq(tutorialSessions.tutorialWorldId, tutorialWorldId))).returning();
    if (updated === undefined) throw new Error("Tutorialfortschritt konnte nicht gespeichert werden.");
    const evidenceValue = evidencePayload(evidence);
    await this.db.update(tutorialProgress).set({
      chapter: completed ? 5 : next,
      chapterState: completed ? "completed" : "in-progress",
      evidence: evidenceValue,
      explanationCode: completed ? "tutorial.completed" : `tutorial.chapter.${next}.ready`,
      checkpointHash: alphaHash("zugfolge-tutorial-checkpoint/v2", { tutorialWorldId, reference: session.reference, chapter: completed ? 5 : next, evidence: evidenceValue }),
      completedAtS: completed ? 900 : null,
      updatedAtS: 120 * chapter,
    }).where(and(eq(tutorialProgress.worldId, tutorialWorldId), eq(tutorialProgress.accountId, tutorialAccountId)));
    await this.telemetry(updated, "tutorial_chapter_completed", now, { chapter });
    if (completed) await this.telemetry(updated, "tutorial_completed", now, { chapter: 5 });
    else await this.telemetry(updated, "tutorial_chapter_started", now, { chapter: next });
    return this.view(updated);
  }

  async openHint(tutorialWorldId: string, tutorialAccountId: string): Promise<TutorialSessionView> {
    const session = await this.ownedTutorial(tutorialWorldId, tutorialAccountId);
    if (session.lifecycle !== "running") throw new AlphaConflictError("Hinweis ist nur in einer laufenden Sitzung verfuegbar.", "tutorial_world_closed");
    const hints = booleanRecord(session.hintsUsed);
    hints[String(session.currentChapter)] = true;
    const now = this.#clock();
    const [updated] = await this.db.update(tutorialSessions).set({
      hintsUsed: hints,
      scenarioState: { ...record(session.scenarioState), dialogueTrigger: `chapter.${session.currentChapter}.hint` },
      lastActivityAt: now,
      idleExpiresAt: new Date(now.getTime() + this.#template.idleTtlMilliseconds),
      updatedAt: now,
    }).where(and(eq(tutorialSessions.id, session.id), eq(tutorialSessions.tutorialWorldId, tutorialWorldId))).returning();
    if (updated === undefined) throw new Error("Tutorialhinweis konnte nicht gespeichert werden.");
    await this.telemetry(updated, "tutorial_hint_opened", now, { chapter: session.currentChapter, suffix: `${session.currentChapter}:first` });
    return this.view(updated);
  }

  async dismissDialogue(tutorialWorldId: string, tutorialAccountId: string, dialogueId: string): Promise<TutorialSessionView> {
    const session = await this.ownedTutorial(tutorialWorldId, tutorialAccountId);
    const current = dialogueFor(session);
    if (current.id !== dialogueId || !current.canDismiss) throw new AlphaValidationError("Dieser Lutz-Dialog kann jetzt nicht geschlossen werden.");
    const now = this.#clock();
    await this.telemetry(session, "tutorial_dialogue_dismissed", now, { chapter: session.currentChapter, suffix: dialogueId });
    return this.view(session);
  }

  async restart(tutorialWorldId: string, tutorialAccountId: string): Promise<TutorialSessionView> {
    const session = await this.ownedTutorial(tutorialWorldId, tutorialAccountId);
    const now = this.#clock();
    await this.telemetry(session, "tutorial_restarted", now, { chapter: session.currentChapter, reason: "player-restart" });
    await this.closeSession(session, "restarted", now);
    const [publicAccount] = await this.db.select().from(accounts).where(and(
      eq(accounts.worldId, session.publicWorldId), eq(accounts.id, session.publicAccountId),
    )).limit(1);
    if (publicAccount === undefined) throw new AlphaAuthorizationError("Oeffentliches Weltkonto der Sitzung fehlt.");
    return this.start({
      publicWorldId: session.publicWorldId,
      publicAccountId: session.publicAccountId,
      keycloakSubject: publicAccount.keycloakSubject,
      displayName: publicAccount.displayName,
    });
  }

  async confirmSummary(tutorialWorldId: string, tutorialAccountId: string): Promise<TutorialSessionView> {
    const session = await this.ownedTutorial(tutorialWorldId, tutorialAccountId);
    if (session.lifecycle !== "summary") throw new AlphaConflictError("Ergebniszusammenfassung ist noch nicht bereit.", "tutorial_summary_unavailable");
    await this.closeSession(session, "completed-confirmed", this.#clock());
    return this.view(await this.ownedTutorial(tutorialWorldId, tutorialAccountId));
  }

  private async closeSession(session: TutorialSession, reason: string, now: Date): Promise<void> {
    if (session.lifecycle === "archived") return;
    const [closing] = await this.db.update(tutorialSessions).set({
      lifecycle: "closing",
      closingAt: session.closingAt ?? now,
      closureReason: session.closureReason ?? reason,
      pendingAction: null,
      updatedAt: now,
    }).where(and(
      eq(tutorialSessions.id, session.id),
      eq(tutorialSessions.tutorialWorldId, session.tutorialWorldId),
      inArray(tutorialSessions.lifecycle, ["provisioning", "running", "summary", "closing", "failed"]),
    )).returning();
    const current = closing ?? (await this.db.select().from(tutorialSessions).where(and(
      eq(tutorialSessions.id, session.id), eq(tutorialSessions.tutorialWorldId, session.tutorialWorldId),
    )).limit(1))[0];
    if (current === undefined || current.lifecycle === "archived") return;
    const finalStateHash = await this.factory.close(current, current.closureReason ?? reason, this.#template);
    await this.db.transaction(async (tx) => {
      await tx.update(alphaWorldProfiles).set({ state: "archived", archivedAtS: 900, finalStateHash }).where(eq(alphaWorldProfiles.worldId, session.tutorialWorldId));
      await tx.update(worlds).set({ lifecycleStatus: "archived" }).where(eq(worlds.id, session.tutorialWorldId));
      await tx.update(worldAccesses).set({ status: "revoked", revokedAt: now }).where(and(
        eq(worldAccesses.worldId, session.tutorialWorldId), eq(worldAccesses.keycloakSubject, (await tx.select({ subject: accounts.keycloakSubject }).from(accounts).where(and(eq(accounts.worldId, session.tutorialWorldId), eq(accounts.id, session.tutorialAccountId))).limit(1))[0]?.subject ?? ""),
      ));
      await tx.update(tutorialSessions).set({ lifecycle: "archived", archivedAt: now, finalStateHash, updatedAt: now }).where(and(
        eq(tutorialSessions.id, session.id), eq(tutorialSessions.tutorialWorldId, session.tutorialWorldId), eq(tutorialSessions.lifecycle, "closing"),
      ));
    });
    const archived = await this.ownedTutorial(session.tutorialWorldId, session.tutorialAccountId);
    if (reason !== "completed-confirmed" && !reason.startsWith("summary-grace")) {
      await this.telemetry(archived, "tutorial_abandoned", now, { chapter: session.currentChapter, reason });
    }
    await this.telemetry(archived, "tutorial_world_closed", now, { chapter: session.currentChapter, reason });
  }

  async reap(at = this.#clock()): Promise<readonly string[]> {
    // guards:allow world-id — Der globale Ablauf-Sweeper ermittelt Welt-IDs und schliesst jede Sitzung danach weltgebunden.
    const expired = await this.db.select().from(tutorialSessions).where(and(
      inArray(tutorialSessions.lifecycle, ["provisioning", "running", "summary", "closing", "failed"]),
      or(
        lt(tutorialSessions.maximumExpiresAt, at),
        lt(tutorialSessions.idleExpiresAt, at),
        and(eq(tutorialSessions.lifecycle, "summary"), sql`${tutorialSessions.graceExpiresAt} is not null`, lt(tutorialSessions.graceExpiresAt, at)),
        eq(tutorialSessions.lifecycle, "closing"),
      ),
    )).orderBy(asc(tutorialSessions.createdAt));
    const closed: string[] = [];
    for (const session of expired) {
      const reason = session.lifecycle === "summary" ? "summary-grace-expired"
        : session.lifecycle === "closing" ? session.closureReason ?? "closing-resumed"
          : session.maximumExpiresAt < at ? "maximum-duration" : "idle-ttl";
      await this.closeSession(session, reason, at);
      closed.push(session.reference);
    }
    return closed;
  }

  private async view(session: TutorialSession): Promise<TutorialSessionView> {
    const evidence = await this.factory.evidence(session, this.#template);
    const presentation = await this.factory.presentation(session, this.#template);
    const includeSummary = session.lifecycle === "summary" || session.lifecycle === "closing" || session.lifecycle === "archived";
    return Object.freeze({
      schemaVersion: TUTORIAL_SESSION_SCHEMA,
      reference: session.reference,
      tutorialWorldId: session.tutorialWorldId,
      publicWorldId: session.publicWorldId,
      lifecycle: session.lifecycle,
      templateVersion: session.templateVersion,
      templateHash: session.templateHash,
      currentChapter: session.currentChapter,
      progressLabel: `Kapitel ${session.currentChapter} von 5`,
      chapters: TUTORIAL_CHAPTERS,
      evidence: evidencePayload(evidence),
      dialogue: dialogueFor(session),
      presentation,
      ...(includeSummary ? { summary: await this.factory.summary(session, this.#template) } : {}),
      idleExpiresAt: session.idleExpiresAt.toISOString(),
      maximumExpiresAt: session.maximumExpiresAt.toISOString(),
      publicWorldUrl: `?world=${encodeURIComponent(session.publicWorldId)}`,
    });
  }
}
