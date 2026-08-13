import {
  alphaWorldProfiles,
  domainEvents,
  fleetMobilizationSnapshots,
  operatingProgramVersions,
  operatorContracts,
  tutorialProgress,
  vehicleAssets,
  worlds,
  type TutorialProgress,
} from "@zugfolge/db";
import { loadEconomyWorldState } from "@zugfolge/economy";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import { AlphaAuthorizationError, AlphaConflictError, AlphaValidationError } from "./errors.js";
import { alphaHash } from "./hash.js";
import type { AlphaDatabase } from "./world.js";

export const TUTORIAL_CHAPTERS = [
  { chapter: 1, code: "first-tender", title: "Erste Ausschreibung", goal: "Ein eigenes, gültiges Gebot liegt im echten Vergabeverfahren." },
  { chapter: 2, code: "lease-vehicle", title: "Fahrzeug leasen", goal: "Ein Fahrzeugmietvertrag ist angenommen und das Fahrzeug autoritativ übergeben." },
  { chapter: 3, code: "request-path", title: "Trasse beantragen", goal: "Der Rust-Flottenzustand enthält einen bestätigten Trassenbeleg." },
  { chapter: 4, code: "operating-program", title: "Betriebsprogramm erstellen", goal: "Ein echtes Betriebsprogramm ist aktiv." },
  { chapter: 5, code: "handle-disruption", title: "Erste Störung bewältigen", goal: "Störung und Dispositionsentscheidung sind im autoritativen Eventlog belegt." },
] as const;

const EXPLANATIONS = {
  "tutorial.welcome": "Beginne mit der veröffentlichten ersten Ausschreibung. Das Tutorial benutzt dieselben Fristen und Prüfungen wie das Spiel.",
  "tutorial.tender.missing": "Noch kein eigenes Gebot gefunden. Öffne die Ausschreibung, prüfe Mindestanforderungen und sende genau ein Gebot ab.",
  "tutorial.vehicle.missing": "Noch keine wirksame Fahrzeugmiete. Angebot, Annahme und autoritative Halterübergabe müssen abgeschlossen sein.",
  "tutorial.path.missing": "Noch kein bestätigter Trassenbeleg im Flotten-Single-Writer. Ein Entwurf allein reicht nicht.",
  "tutorial.program.missing": "Noch kein aktives Betriebsprogramm. Speichern allein reicht nicht; aktiviere eine gueltige Version.",
  "tutorial.disruption.missing": "Eine betriebswirksame Störung und deine darauf folgende Dispositionsentscheidung fehlen noch.",
  "tutorial.completed": "Alle fünf Kapitel sind mit autoritativen Belegen abgeschlossen.",
} as const;

export interface TutorialResetPort {
  resetAndSeedAccount(tx: AlphaDatabase, worldId: string, accountId: string, resetNumber: number, atS: number): Promise<void>;
}

interface TutorialEvidenceBoundary {
  readonly schemaVersion: "zugfolge-tutorial-evidence-boundary/v1";
  readonly bidIds: readonly string[];
  readonly rentalContractIds: readonly string[];
  readonly heldVehicleIds: readonly string[];
  readonly confirmedPathIds: readonly string[];
  readonly activeProgramIds: readonly string[];
}

interface ChapterEvidence {
  readonly completed: boolean;
  readonly references: readonly string[];
  readonly missingCode: keyof typeof EXPLANATIONS;
}

function operatorFromPayload(payload: unknown, operatorId: string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  return Object.entries(payload as Record<string, unknown>).some(([key, value]) =>
    key.toLowerCase().includes("operator") && value === operatorId,
  );
}

function fleetState(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value as readonly string[]
    : undefined;
}

function evidenceBoundary(payload: Record<string, unknown>): TutorialEvidenceBoundary | undefined {
  const candidate = fleetState(payload["evidenceBoundary"]);
  if (candidate?.["schemaVersion"] !== "zugfolge-tutorial-evidence-boundary/v1") return undefined;
  const bidIds = stringArray(candidate["bidIds"]);
  const rentalContractIds = stringArray(candidate["rentalContractIds"]);
  const heldVehicleIds = stringArray(candidate["heldVehicleIds"]);
  const confirmedPathIds = stringArray(candidate["confirmedPathIds"]);
  const activeProgramIds = stringArray(candidate["activeProgramIds"]);
  if (bidIds === undefined || rentalContractIds === undefined || heldVehicleIds === undefined || confirmedPathIds === undefined || activeProgramIds === undefined) return undefined;
  return { schemaVersion: "zugfolge-tutorial-evidence-boundary/v1", bidIds, rentalContractIds, heldVehicleIds, confirmedPathIds, activeProgramIds };
}

export class TutorialService {
  constructor(private readonly db: AlphaDatabase, private readonly resetPort: TutorialResetPort) {}

  private async assertTutorialWorld(worldId: string): Promise<void> {
    const [world] = await this.db.select({
      profileKind: alphaWorldProfiles.profileKind,
      profileState: alphaWorldProfiles.state,
      accelerationFactor: alphaWorldProfiles.accelerationFactor,
      worldKind: worlds.worldKind,
      rankingStatus: worlds.rankingStatus,
      lifecycleStatus: worlds.lifecycleStatus,
    }).from(alphaWorldProfiles)
      .innerJoin(worlds, eq(worlds.id, alphaWorldProfiles.worldId))
      .where(eq(alphaWorldProfiles.worldId, worldId))
      .limit(1);
    if (
      world?.profileKind !== "tutorial"
      || world.profileState !== "running"
      || world.accelerationFactor <= 1
      || world.worldKind !== "private"
      || world.rankingStatus !== "unranked"
      || world.lifecycleStatus !== "active"
    ) {
      throw new AlphaConflictError("Tutorialfortschritt ist nur in einer getrennten, laufenden und beschleunigten Tutorial-Welt erlaubt.", "not_tutorial_world");
    }
  }

  private async accountOperator(worldId: string, accountId: string): Promise<{
    readonly operatorId: string;
    readonly sessionSequence: number;
    readonly evidenceBoundary: TutorialEvidenceBoundary;
  }> {
    const sessions = await this.db.select({ sequence: domainEvents.sequence, payload: domainEvents.payload }).from(domainEvents).where(and(
      eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, "alpha.tutorial-session-seeded"),
    )).orderBy(desc(domainEvents.sequence));
    for (const session of sessions) {
      if (typeof session.payload !== "object" || session.payload === null || Array.isArray(session.payload)) continue;
      const payload = session.payload as Record<string, unknown>;
      const boundary = evidenceBoundary(payload);
      if (payload["accountId"] === accountId && typeof payload["operatorId"] === "string" && boundary !== undefined) {
        return {
          operatorId: payload["operatorId"],
          sessionSequence: session.sequence,
          evidenceBoundary: boundary,
        };
      }
    }
    throw new AlphaAuthorizationError("Tutorialkonto besitzt in dieser Welt keine sequenzgebundene Tutorial-Sitzung.");
  }

  private async evidence(worldId: string, operatorId: string, sessionSequence: number, boundary: TutorialEvidenceBoundary): Promise<readonly ChapterEvidence[]> {
    const economy = await loadEconomyWorldState(this.db as never, worldId);
    const priorBidIds = new Set(boundary.bidIds);
    const bidTenderIds = economy === undefined ? [] : [...economy.tenders.values()]
      .filter((entry) => entry.bids.some((bid) => bid.operatorId === operatorId && !priorBidIds.has(bid.id)))
      .map((entry) => entry.tender.id).sort();

    const priorRentalContractIds = new Set(boundary.rentalContractIds);
    const rentalContracts = (await this.db.select({ id: operatorContracts.id }).from(operatorContracts).where(and(
      eq(operatorContracts.worldId, worldId),
      eq(operatorContracts.contractType, "vehicle-rental"),
      or(eq(operatorContracts.offerorOperatorId, operatorId), eq(operatorContracts.offereeOperatorId, operatorId)),
      inArray(operatorContracts.status, ["accepted", "active", "completed"]),
    )).orderBy(asc(operatorContracts.id))).filter((contract) => !priorRentalContractIds.has(contract.id));
    const priorHeldVehicleIds = new Set(boundary.heldVehicleIds);
    const heldVehicles = (await this.db.select({ id: vehicleAssets.vehicleId }).from(vehicleAssets).where(and(
      eq(vehicleAssets.worldId, worldId), eq(vehicleAssets.holderOperatorId, operatorId),
    )).orderBy(asc(vehicleAssets.vehicleId))).filter((vehicle) => !priorHeldVehicleIds.has(vehicle.id));

    const [checkpoint] = await this.db.select({ payload: fleetMobilizationSnapshots.payload }).from(fleetMobilizationSnapshots)
      .where(eq(fleetMobilizationSnapshots.worldId, worldId)).orderBy(desc(fleetMobilizationSnapshots.revision)).limit(1);
    const snapshot = fleetState(checkpoint?.payload);
    const rawPaths = Array.isArray(snapshot?.["pathReservations"])
      ? snapshot["pathReservations"]
      : [];
    const priorPathIds = new Set(boundary.confirmedPathIds);
    const pathIds = rawPaths.flatMap((candidate) => {
      const path = fleetState(candidate);
      return path?.["operatorId"] === operatorId && path["status"] === "confirmed" && typeof path["id"] === "string" && !priorPathIds.has(path["id"])
        ? [path["id"]]
        : [];
    }).sort();

    const priorActiveProgramIds = new Set(boundary.activeProgramIds);
    const programs = (await this.db.select({ id: operatingProgramVersions.id }).from(operatingProgramVersions).where(and(
      eq(operatingProgramVersions.worldId, worldId), eq(operatingProgramVersions.operatorId, operatorId), eq(operatingProgramVersions.status, "active"),
    )).orderBy(asc(operatingProgramVersions.id))).filter((program) => !priorActiveProgramIds.has(program.id));

    const events = await this.db.select().from(domainEvents).where(and(
      eq(domainEvents.worldId, worldId),
      or(eq(domainEvents.eventType, "disruption.applied"), eq(domainEvents.eventType, "dispatch.decision-applied"), eq(domainEvents.eventType, "dispatch.major-event")),
    )).orderBy(asc(domainEvents.sequence));
    const sessionEvents = events.filter((event) => event.sequence > sessionSequence);
    const disruptions = sessionEvents.filter((event) => event.eventType === "disruption.applied");
    const decisions = sessionEvents.filter((event) => event.eventType.startsWith("dispatch.") && operatorFromPayload(event.payload, operatorId));

    return [
      { completed: bidTenderIds.length > 0, references: bidTenderIds, missingCode: "tutorial.tender.missing" },
      { completed: rentalContracts.length > 0 && heldVehicles.length > 0, references: [...rentalContracts.map((row) => row.id), ...heldVehicles.map((row) => row.id)], missingCode: "tutorial.vehicle.missing" },
      { completed: pathIds.length > 0, references: pathIds, missingCode: "tutorial.path.missing" },
      { completed: programs.length > 0, references: programs.map((row) => row.id), missingCode: "tutorial.program.missing" },
      { completed: disruptions.length > 0 && decisions.length > 0, references: [...disruptions, ...decisions].map((row) => `${row.sequence}:${row.eventType}`), missingCode: "tutorial.disruption.missing" },
    ];
  }

  async resume(worldId: string, accountId: string, atS: number): Promise<TutorialProgress & { readonly explanation: string; readonly chapters: typeof TUTORIAL_CHAPTERS }> {
    if (!Number.isSafeInteger(atS) || atS < 0) throw new AlphaValidationError("Tutorialzeit ist ungültig.");
    await this.assertTutorialWorld(worldId);
    let session;
    try {
      session = await this.accountOperator(worldId, accountId);
    } catch (error) {
      if (!(error instanceof AlphaAuthorizationError)) throw error;
      await this.db.transaction((tx) => this.resetPort.resetAndSeedAccount(tx as unknown as AlphaDatabase, worldId, accountId, 0, atS));
      session = await this.accountOperator(worldId, accountId);
    }
    const evidence = await this.evidence(worldId, session.operatorId, session.sessionSequence, session.evidenceBoundary);
    const firstIncomplete = evidence.findIndex((entry) => !entry.completed);
    const completed = firstIncomplete === -1;
    const chapter = completed ? 5 : firstIncomplete + 1;
    const explanationCode = completed ? "tutorial.completed" : evidence[firstIncomplete]!.missingCode;
    const evidencePayload = Object.fromEntries(evidence.map((entry, index) => [String(index + 1), { completed: entry.completed, references: entry.references }]));
    const checkpointHash = alphaHash("zugfolge-tutorial-checkpoint/v1", { worldId, accountId, sessionSequence: session.sessionSequence, chapter, completed, evidence: evidencePayload });
    let [progress] = await this.db.insert(tutorialProgress).values({
      worldId, accountId, chapter, chapterState: completed ? "completed" : "in-progress", evidence: evidencePayload,
      explanationCode, checkpointHash, completedAtS: completed ? atS : null, updatedAtS: atS,
    }).onConflictDoUpdate({
      target: [tutorialProgress.worldId, tutorialProgress.accountId],
      set: { chapter, chapterState: completed ? "completed" : "in-progress", evidence: evidencePayload, explanationCode, checkpointHash, completedAtS: completed ? atS : null, updatedAtS: atS },
    }).returning();
    if (progress === undefined) throw new Error("Tutorialfortschritt konnte nicht persistiert werden.");
    return { ...progress, explanation: EXPLANATIONS[explanationCode], chapters: TUTORIAL_CHAPTERS };
  }

  async reset(worldId: string, accountId: string, atS: number): Promise<TutorialProgress & { readonly explanation: string; readonly chapters: typeof TUTORIAL_CHAPTERS }> {
    if (!Number.isSafeInteger(atS) || atS < 0) throw new AlphaValidationError("Tutorialzeit ist ungültig.");
    await this.assertTutorialWorld(worldId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
      const [current] = await tx.select().from(tutorialProgress).where(and(
        eq(tutorialProgress.worldId, worldId), eq(tutorialProgress.accountId, accountId),
      )).limit(1);
      const resetNumber = (current?.resetCount ?? 0) + 1;
      if (resetNumber > 5) throw new AlphaConflictError("Mehr als fünf selbsttätige Tutorial-Resets sind gesperrt; Supportprüfung erforderlich.", "tutorial_reset_limit");
      await this.resetPort.resetAndSeedAccount(tx as unknown as AlphaDatabase, worldId, accountId, resetNumber, atS);
      const resetEvidence = Object.fromEntries(TUTORIAL_CHAPTERS.map(({ chapter }) => [String(chapter), { completed: false, references: [] }]));
      const checkpointHash = alphaHash("zugfolge-tutorial-checkpoint/v1", { worldId, accountId, resetNumber, chapter: 1, completed: false, evidence: resetEvidence });
      const [reset] = await tx.insert(tutorialProgress).values({
        worldId, accountId, chapter: 1, chapterState: "in-progress", evidence: resetEvidence,
        explanationCode: "tutorial.welcome", checkpointHash, resetCount: resetNumber, completedAtS: null, updatedAtS: atS,
      }).onConflictDoUpdate({
        target: [tutorialProgress.worldId, tutorialProgress.accountId],
        set: { chapter: 1, chapterState: "in-progress", evidence: resetEvidence, explanationCode: "tutorial.welcome", checkpointHash, resetCount: resetNumber, completedAtS: null, updatedAtS: atS },
      }).returning();
      if (reset === undefined) throw new Error("Tutorialreset konnte nicht gespeichert werden.");
    });
    return this.resume(worldId, accountId, atS);
  }
}
