import {
  alphaWorldProfiles,
  domainEvents,
  fleetWorldCheckpoints,
  operatingProgramVersions,
  operatorContracts,
  operators,
  tutorialProgress,
  vehicleAssets,
  type TutorialProgress,
} from "@zugfolge/db";
import { loadEconomyWorldState } from "@zugfolge/economy";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";

import { AlphaAuthorizationError, AlphaConflictError, AlphaValidationError } from "./errors.js";
import { alphaHash } from "./hash.js";
import type { AlphaDatabase } from "./world.js";

export const TUTORIAL_CHAPTERS = [
  { chapter: 1, code: "first-tender", title: "Erste Ausschreibung", goal: "Ein eigenes, gueltiges Gebot liegt im echten Vergabeverfahren." },
  { chapter: 2, code: "lease-vehicle", title: "Fahrzeug leasen", goal: "Ein Fahrzeugmietvertrag ist angenommen und das Fahrzeug autoritativ uebergeben." },
  { chapter: 3, code: "request-path", title: "Trasse beantragen", goal: "Der Rust-Flottenzustand enthaelt einen bestaetigten Trassenbeleg." },
  { chapter: 4, code: "operating-program", title: "Betriebsprogramm erstellen", goal: "Ein echtes Betriebsprogramm ist aktiv." },
  { chapter: 5, code: "handle-disruption", title: "Erste Stoerung bewaeltigen", goal: "Stoerung und Dispositionsentscheidung sind im autoritativen Eventlog belegt." },
] as const;

const EXPLANATIONS = {
  "tutorial.welcome": "Beginne mit der veroeffentlichten ersten Ausschreibung. Das Tutorial benutzt dieselben Fristen und Pruefungen wie das Spiel.",
  "tutorial.tender.missing": "Noch kein eigenes Gebot gefunden. Oeffne die Ausschreibung, pruefe Mindestanforderungen und sende genau ein Gebot ab.",
  "tutorial.vehicle.missing": "Noch keine wirksame Fahrzeugmiete. Angebot, Annahme und autoritative Halteruebergabe muessen abgeschlossen sein.",
  "tutorial.path.missing": "Noch kein bestaetigter Trassenbeleg im Flotten-Single-Writer. Ein Entwurf allein reicht nicht.",
  "tutorial.program.missing": "Noch kein aktives Betriebsprogramm. Speichern allein reicht nicht; aktiviere eine gueltige Version.",
  "tutorial.disruption.missing": "Eine betriebswirksame Stoerung und deine darauf folgende Dispositionsentscheidung fehlen noch.",
  "tutorial.completed": "Alle fuenf Kapitel sind mit autoritativen Belegen abgeschlossen.",
} as const;

export interface TutorialResetPort {
  resetAndSeedAccount(worldId: string, accountId: string, resetNumber: number): Promise<void>;
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

export class TutorialService {
  constructor(private readonly db: AlphaDatabase, private readonly resetPort: TutorialResetPort) {}

  private async accountOperator(worldId: string, accountId: string): Promise<string> {
    const [operator] = await this.db.select({ id: operators.id }).from(operators)
      .where(and(eq(operators.worldId, worldId), eq(operators.foundingAccountId, accountId))).limit(1);
    if (operator === undefined) throw new AlphaAuthorizationError("Tutorialkonto besitzt in dieser Welt kein EVU.");
    return operator.id;
  }

  private async evidence(worldId: string, operatorId: string): Promise<readonly ChapterEvidence[]> {
    const economy = await loadEconomyWorldState(this.db as never, worldId);
    const bidTenderIds = economy === undefined ? [] : [...economy.tenders.values()]
      .filter((entry) => entry.bids.some((bid) => bid.operatorId === operatorId))
      .map((entry) => entry.tender.id).sort();

    const rentalContracts = await this.db.select({ id: operatorContracts.id }).from(operatorContracts).where(and(
      eq(operatorContracts.worldId, worldId),
      eq(operatorContracts.contractType, "vehicle-rental"),
      or(eq(operatorContracts.offerorOperatorId, operatorId), eq(operatorContracts.offereeOperatorId, operatorId)),
      inArray(operatorContracts.status, ["accepted", "active", "completed"]),
    )).orderBy(asc(operatorContracts.id));
    const heldVehicles = await this.db.select({ id: vehicleAssets.vehicleId }).from(vehicleAssets).where(and(
      eq(vehicleAssets.worldId, worldId), eq(vehicleAssets.holderOperatorId, operatorId),
    )).orderBy(asc(vehicleAssets.vehicleId));

    const [checkpoint] = await this.db.select({ state: fleetWorldCheckpoints.state }).from(fleetWorldCheckpoints)
      .where(eq(fleetWorldCheckpoints.worldId, worldId)).orderBy(desc(fleetWorldCheckpoints.revision)).limit(1);
    const state = fleetState(checkpoint?.state);
    const pathReservations = fleetState(state?.["pathReservations"]);
    const pathIds = Object.keys(pathReservations ?? {}).sort();

    const programs = await this.db.select({ id: operatingProgramVersions.id }).from(operatingProgramVersions).where(and(
      eq(operatingProgramVersions.worldId, worldId), eq(operatingProgramVersions.operatorId, operatorId), eq(operatingProgramVersions.status, "active"),
    )).orderBy(asc(operatingProgramVersions.id));

    const events = await this.db.select().from(domainEvents).where(and(
      eq(domainEvents.worldId, worldId),
      or(eq(domainEvents.eventType, "disruption.applied"), eq(domainEvents.eventType, "dispatch.decision-applied"), eq(domainEvents.eventType, "dispatch.major-event")),
    )).orderBy(asc(domainEvents.sequence));
    const disruptions = events.filter((event) => event.eventType === "disruption.applied");
    const decisions = events.filter((event) => event.eventType.startsWith("dispatch.") && operatorFromPayload(event.payload, operatorId));

    return [
      { completed: bidTenderIds.length > 0, references: bidTenderIds, missingCode: "tutorial.tender.missing" },
      { completed: rentalContracts.length > 0 && heldVehicles.length > 0, references: [...rentalContracts.map((row) => row.id), ...heldVehicles.map((row) => row.id)], missingCode: "tutorial.vehicle.missing" },
      { completed: pathIds.length > 0, references: pathIds, missingCode: "tutorial.path.missing" },
      { completed: programs.length > 0, references: programs.map((row) => row.id), missingCode: "tutorial.program.missing" },
      { completed: disruptions.length > 0 && decisions.length > 0, references: [...disruptions, ...decisions].map((row) => `${row.sequence}:${row.eventType}`), missingCode: "tutorial.disruption.missing" },
    ];
  }

  async resume(worldId: string, accountId: string, atS: number): Promise<TutorialProgress & { readonly explanation: string; readonly chapters: typeof TUTORIAL_CHAPTERS }> {
    if (!Number.isSafeInteger(atS) || atS < 0) throw new AlphaValidationError("Tutorialzeit ist ungueltig.");
    const [profile] = await this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
    if (profile?.profileKind !== "tutorial" || profile.accelerationFactor <= 1) {
      throw new AlphaConflictError("Tutorialfortschritt ist nur in einer getrennten, beschleunigten Tutorial-Welt erlaubt.", "not_tutorial_world");
    }
    const operatorId = await this.accountOperator(worldId, accountId);
    const evidence = await this.evidence(worldId, operatorId);
    const firstIncomplete = evidence.findIndex((entry) => !entry.completed);
    const completed = firstIncomplete === -1;
    const chapter = completed ? 5 : firstIncomplete + 1;
    const explanationCode = completed ? "tutorial.completed" : evidence[firstIncomplete]!.missingCode;
    const evidencePayload = Object.fromEntries(evidence.map((entry, index) => [String(index + 1), { completed: entry.completed, references: entry.references }]));
    const checkpointHash = alphaHash("zugfolge-tutorial-checkpoint/v1", { worldId, accountId, chapter, completed, evidence: evidencePayload });
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
    const [current] = await this.db.select().from(tutorialProgress).where(and(
      eq(tutorialProgress.worldId, worldId), eq(tutorialProgress.accountId, accountId),
    )).limit(1);
    const resetNumber = (current?.resetCount ?? 0) + 1;
    if (resetNumber > 5) throw new AlphaConflictError("Mehr als fuenf selbsttaetige Tutorial-Resets sind gesperrt; Supportpruefung erforderlich.", "tutorial_reset_limit");
    await this.resetPort.resetAndSeedAccount(worldId, accountId, resetNumber);
    await this.db.delete(tutorialProgress).where(and(eq(tutorialProgress.worldId, worldId), eq(tutorialProgress.accountId, accountId)));
    const progress = await this.resume(worldId, accountId, atS);
    const [updated] = await this.db.update(tutorialProgress).set({ resetCount: resetNumber }).where(and(
      eq(tutorialProgress.worldId, worldId), eq(tutorialProgress.accountId, accountId),
    )).returning();
    if (updated === undefined) throw new Error("Tutorialreset konnte nicht gespeichert werden.");
    return { ...progress, ...updated };
  }
}
