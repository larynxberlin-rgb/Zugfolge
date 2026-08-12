import { createPublicKey, verify } from "node:crypto";

import {
  alphaWorldProfiles,
  domainEvents,
  gameAdminRequests,
  infraReleaseChanges,
  worlds,
} from "@zugfolge/db";
import { and, desc, eq, sql } from "drizzle-orm";

import { AlphaConflictError, AlphaValidationError } from "./errors.js";
import { alphaHash } from "./hash.js";
import type { AlphaDatabase } from "./world.js";

interface ReleaseSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly signedHash: string;
  readonly valueBase64: string;
}

export interface InfraReleaseProposal {
  readonly worldId: string;
  readonly releaseId: string;
  readonly predecessorHash: string;
  readonly timetableYear: number;
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly coverageReport: Readonly<Record<string, unknown>> & { readonly classASections: number; readonly classBSections: number; readonly classCSections: number; readonly orderableClassCSections: number };
  readonly rightsReport: Readonly<Record<string, unknown>> & { readonly approved: boolean; readonly sourceIds: readonly string[] };
  readonly deviationReport: Readonly<Record<string, unknown>>;
  readonly impactPreview: Readonly<Record<string, unknown>>;
  readonly signature: ReleaseSignature;
  readonly requestedByAdminRequestId: string;
  readonly activateAtPeriod: number;
}

export interface InfraActivationSafety {
  verify(input: {
    readonly worldId: string;
    readonly predecessorHash: string;
    readonly releaseHash: string;
    readonly activateAtPeriod: number;
    readonly impactPreview: Readonly<Record<string, unknown>>;
  }): Promise<{
    readonly safe: boolean;
    readonly conflictCount: number;
    readonly invalidPathCount: number;
    readonly invalidCirculationCount: number;
    readonly invalidContractCount: number;
    readonly invariantOneProofHash: string;
    readonly explanation: string;
  }>;
}

export class InfraUpdateService {
  constructor(
    private readonly db: AlphaDatabase,
    private readonly trustedKeys: Readonly<Record<string, string>>,
    private readonly safety: InfraActivationSafety,
  ) {}

  private verifySignature(releaseHash: string, signature: ReleaseSignature): void {
    if (signature.algorithm !== "ed25519" || signature.signedHash !== releaseHash) throw new AlphaValidationError("Signatur bindet nicht den Release-Hash.");
    const pem = this.trustedKeys[signature.keyId];
    if (pem === undefined) throw new AlphaValidationError("Release-Verantwortung ist nicht im Trust-Store benannt.");
    let bytes: Buffer;
    try { bytes = Buffer.from(signature.valueBase64, "base64"); } catch { throw new AlphaValidationError("Release-Signatur ist nicht Base64."); }
    if (bytes.length !== 64 || !verify(null, Buffer.from(releaseHash, "utf8"), createPublicKey(pem), bytes)) {
      throw new AlphaValidationError("Produktive InfraRelease-Signatur ist kryptografisch ungueltig.");
    }
  }

  async propose(input: InfraReleaseProposal) {
    await this.stageCandidate(input);
    return this.approveStaged(input.worldId, alphaHash("zugfolge-infra-release-manifest/v1", input.manifest), input.requestedByAdminRequestId, input.activateAtPeriod);
  }

  async stageCandidate(input: Omit<InfraReleaseProposal, "requestedByAdminRequestId">) {
    if (!Number.isSafeInteger(input.timetableYear) || input.timetableYear < 2026 || input.timetableYear > 2200) throw new AlphaValidationError("Fahrplanjahr ist ungueltig.");
    if (!(input.validFrom instanceof Date) || !(input.validUntil instanceof Date) || input.validUntil <= input.validFrom) throw new AlphaValidationError("Release-Geltung ist ungueltig.");
    if (input.coverageReport.orderableClassCSections !== 0) throw new AlphaValidationError("Qualitaetsklasse C darf sichtbar, aber nicht bestellbar sein.");
    if (!input.rightsReport.approved || input.rightsReport.sourceIds.length === 0) throw new AlphaValidationError("Rechtefreigabe aller Datenquellen fehlt.");
    const releaseHash = alphaHash("zugfolge-infra-release-manifest/v1", input.manifest);
    this.verifySignature(releaseHash, input.signature);
    const [profile] = await this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, input.worldId)).limit(1);
    if (profile === undefined || profile.state !== "running") throw new AlphaConflictError("InfraRelease kann nur fuer eine laufende Welt beantragt werden.");
    if (profile.infraReleaseHash !== input.predecessorHash) throw new AlphaConflictError("Vorgaenger-Hash ist nicht der aktive InfraRelease.", "infra_predecessor_conflict");
    if (input.activateAtPeriod <= profile.currentPeriod) throw new AlphaValidationError("Aktivierung muss an einem kuenftigen Periodenwechsel liegen.");
    let [created] = await this.db.insert(infraReleaseChanges).values({
      worldId: input.worldId,
      releaseId: input.releaseId,
      releaseHash,
      predecessorHash: input.predecessorHash,
      timetableYear: input.timetableYear,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      coverageReport: input.coverageReport,
      rightsReport: input.rightsReport,
      deviationReport: input.deviationReport,
      signature: input.signature,
      impactPreview: input.impactPreview,
      activateAtPeriod: input.activateAtPeriod,
      status: "validated",
    }).onConflictDoNothing({ target: [infraReleaseChanges.worldId, infraReleaseChanges.releaseHash] }).returning();
    if (created === undefined) {
      [created] = await this.db.select().from(infraReleaseChanges).where(and(
        eq(infraReleaseChanges.worldId, input.worldId), eq(infraReleaseChanges.releaseHash, releaseHash),
      )).limit(1);
      if (created === undefined) throw new Error("InfraRelease-Kandidat konnte nicht gelesen werden.");
      if (created.releaseId !== input.releaseId || created.predecessorHash !== input.predecessorHash || created.activateAtPeriod !== input.activateAtPeriod) {
        throw new AlphaConflictError("InfraRelease-Hash gehoert zu einem anderen Kandidaten.", "infra_candidate_conflict");
      }
    }
    return created;
  }

  async approveStaged(worldId: string, releaseHash: string, requestedByAdminRequestId: string, activateAtPeriod: number) {
    if (!/^[a-f0-9]{64}$/.test(releaseHash)) throw new AlphaValidationError("InfraRelease-Hash ist ungueltig.");
    const [request] = await this.db.select().from(gameAdminRequests).where(and(
      eq(gameAdminRequests.worldId, worldId), eq(gameAdminRequests.id, requestedByAdminRequestId),
    )).limit(1);
    if (request === undefined || request.actionType !== "infra_release_adoption" || request.riskClass !== "high" || request.state !== "approved") {
      throw new AlphaConflictError("Freigegebener Hochrisiko-Odoo-Antrag fuer InfraRelease fehlt.", "odoo_approval_missing");
    }
    if (request.approverReference === null || request.approverReference === request.requesterReference) throw new AlphaConflictError("Vier-Augen-Prinzip ist nicht belegt.", "four_eyes_missing");
    const [candidate] = await this.db.select().from(infraReleaseChanges).where(and(
      eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.releaseHash, releaseHash), eq(infraReleaseChanges.status, "validated"),
    )).limit(1);
    if (candidate === undefined) throw new AlphaConflictError("Signierter und validierter InfraRelease-Kandidat fehlt.", "infra_candidate_missing");
    if (candidate.activateAtPeriod !== activateAtPeriod) throw new AlphaConflictError("Odoo-Wirkungsvorschau und Kandidat nennen verschiedene Perioden.", "infra_period_mismatch");
    const [profile] = await this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
    if (profile?.state !== "running" || profile.infraReleaseHash !== candidate.predecessorHash || activateAtPeriod <= profile.currentPeriod) throw new AlphaConflictError("InfraRelease-Kandidat passt nicht mehr zum laufenden Weltzustand.", "infra_predecessor_conflict");
    const safety = await this.safety.verify({
      worldId, predecessorHash: candidate.predecessorHash, releaseHash,
      activateAtPeriod, impactPreview: candidate.impactPreview as Readonly<Record<string, unknown>>,
    });
    if (!/^[a-f0-9]{64}$/.test(safety.invariantOneProofHash) || !safety.safe || safety.conflictCount !== 0 || safety.invalidPathCount !== 0 || safety.invalidCirculationCount !== 0 || safety.invalidContractCount !== 0) {
      await this.db.update(infraReleaseChanges).set({ status: "aborted" }).where(and(eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.id, candidate.id), eq(infraReleaseChanges.status, "validated")));
      throw new AlphaConflictError(`InfraRelease-Vorabpruefung abgebrochen: ${safety.explanation}`, "infra_activation_unsafe");
    }
    const [scheduled] = await this.db.update(infraReleaseChanges).set({ requestedByAdminRequestId, status: "scheduled" }).where(and(
      eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.id, candidate.id), eq(infraReleaseChanges.status, "validated"),
    )).returning();
    if (scheduled === undefined) throw new AlphaConflictError("InfraRelease-Freigabe verlor ein Parallelrennen.", "infra_schedule_race");
    return scheduled;
  }

  async approveStagedAt(worldId: string, releaseHash: string, requestedByAdminRequestId: string, requestedPeriodStart: Date) {
    if (Number.isNaN(requestedPeriodStart.getTime())) throw new AlphaValidationError("Beantragter Periodenwechsel ist ungueltig.");
    const [candidate] = await this.db.select().from(infraReleaseChanges).where(and(
      eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.releaseHash, releaseHash), eq(infraReleaseChanges.status, "validated"),
    )).limit(1);
    if (candidate === undefined) throw new AlphaConflictError("Signierter und validierter InfraRelease-Kandidat fehlt.", "infra_candidate_missing");
    if (candidate.validFrom.getTime() !== requestedPeriodStart.getTime()) throw new AlphaConflictError("Odoo-Periodenwechsel stimmt nicht mit der Release-Geltung ueberein.", "infra_period_start_mismatch");
    return this.approveStaged(worldId, releaseHash, requestedByAdminRequestId, candidate.activateAtPeriod);
  }

  async activateAtPeriodBoundary(worldId: string, period: number, atS: number) {
    if (!Number.isSafeInteger(period) || period < 1 || !Number.isSafeInteger(atS) || atS < 0) throw new AlphaValidationError("Periodenwechsel ist ungueltig.");
    const [change] = await this.db.select().from(infraReleaseChanges).where(and(
      eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.activateAtPeriod, period), eq(infraReleaseChanges.status, "scheduled"),
    )).limit(1);
    if (change === undefined) return undefined;
    const result = await this.safety.verify({
      worldId,
      predecessorHash: change.predecessorHash,
      releaseHash: change.releaseHash,
      activateAtPeriod: period,
      impactPreview: change.impactPreview as Readonly<Record<string, unknown>>,
    });
    if (!/^[a-f0-9]{64}$/.test(result.invariantOneProofHash)) throw new AlphaConflictError("Sicherheitspruefung lieferte keinen Invariante-1-Beleg.");
    if (!result.safe || result.conflictCount !== 0 || result.invalidPathCount !== 0 || result.invalidCirculationCount !== 0 || result.invalidContractCount !== 0) {
      await this.db.update(infraReleaseChanges).set({ status: "aborted" }).where(and(
        eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.id, change.id), eq(infraReleaseChanges.status, "scheduled"),
      ));
      throw new AlphaConflictError(`InfraRelease-Aktivierung abgebrochen: ${result.explanation}`, "infra_activation_unsafe");
    }
    const [world] = await this.db.select({ epoch: worlds.epoch }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
    if (world === undefined) throw new AlphaValidationError("Welt fehlt.");
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select ${alphaWorldProfiles.worldId} from ${alphaWorldProfiles} where ${alphaWorldProfiles.worldId} = ${worldId} for update`);
      const [profile] = await tx.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
      if (profile === undefined || profile.currentPeriod + 1 !== period || profile.infraReleaseHash !== change.predecessorHash) {
        throw new AlphaConflictError("Aktivierung ist kein exakter naechster Periodenwechsel.", "period_boundary_conflict");
      }
      const eventId = `infra-release:${change.id}:activated`;
      const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
      await tx.insert(domainEvents).values({
        worldId, sequence: (head?.sequence ?? 0) + 1, eventType: "infrastructure.release-activated",
        payload: { eventId, releaseId: change.releaseId, releaseHash: change.releaseHash, predecessorHash: change.predecessorHash, period, invariantOneProofHash: result.invariantOneProofHash, adminRequestId: change.requestedByAdminRequestId },
        occurredAt: new Date(world.epoch.getTime() + atS * 1_000),
      });
      await tx.update(alphaWorldProfiles).set({ infraReleaseHash: change.releaseHash, currentPeriod: period }).where(eq(alphaWorldProfiles.worldId, worldId));
      const [activated] = await tx.update(infraReleaseChanges).set({ status: "activated", activatedAtS: atS, activationEventId: eventId }).where(and(
        eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.id, change.id), eq(infraReleaseChanges.status, "scheduled"),
      )).returning();
      if (activated === undefined) throw new AlphaConflictError("InfraRelease wurde parallel bearbeitet.");
      return activated;
    });
  }

  async rollback(worldId: string, changeId: string, adminRequestId: string, atS: number) {
    const [change] = await this.db.select().from(infraReleaseChanges).where(and(eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.id, changeId))).limit(1);
    if (change?.status !== "activated") throw new AlphaConflictError("Nur ein aktivierter Release kann zurueckgerollt werden.");
    const [request] = await this.db.select().from(gameAdminRequests).where(and(eq(gameAdminRequests.worldId, worldId), eq(gameAdminRequests.id, adminRequestId))).limit(1);
    if (request?.state !== "approved" || request.riskClass !== "high" || request.requesterReference === request.approverReference) throw new AlphaConflictError("Rollback braucht einen eigenen Vier-Augen-Odoo-Antrag.");
    const result = await this.safety.verify({ worldId, predecessorHash: change.releaseHash, releaseHash: change.predecessorHash, activateAtPeriod: change.activateAtPeriod, impactPreview: change.impactPreview as Readonly<Record<string, unknown>> });
    if (!result.safe) throw new AlphaConflictError("Rollback wuerde laufenden Betrieb verletzen.", "infra_rollback_unsafe");
    await this.db.update(alphaWorldProfiles).set({ infraReleaseHash: change.predecessorHash }).where(eq(alphaWorldProfiles.worldId, worldId));
    const [rolledBack] = await this.db.update(infraReleaseChanges).set({ status: "rolled-back", activatedAtS: atS, activationEventId: `infra-release:${change.id}:rolled-back` }).where(and(eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.id, change.id))).returning();
    return rolledBack;
  }
}
