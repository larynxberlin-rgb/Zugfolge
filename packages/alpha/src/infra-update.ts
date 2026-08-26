import { createPublicKey, verify } from "node:crypto";

import {
  alphaWorldProfiles,
  gameAdminRequests,
  infraReleaseChanges,
  worlds,
} from "@zugfolge/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

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

/**
 * Weltunabhaengiger Aktivierungsbeleg eines bereits durch den Game-Prozess
 * erneut qualifizierten Delivery-v2-Pakets. Der Pakettransport darf damit
 * weder den aktiven Vorgaenger noch die Zielperiode vorgeben; beide Werte
 * werden erst unter der weltgebundenen DB-Sperre ermittelt.
 */
export interface QualifiedInfraPackageCandidate {
  readonly releaseId: string;
  readonly releaseHash: string;
  readonly timetableYear: number;
  readonly packageManifestSha256: string;
  readonly signatureProof: Readonly<Record<string, unknown>> & {
    readonly schema: "zugfolge-infra-package-activation-proof/v1";
    readonly deliveryReleaseId: string;
    readonly timetableYear: number;
    readonly packageManifestSha256: string;
    readonly deliveryReleaseHash: string;
    readonly infraReleaseHash: string;
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly valueBase64: string;
    readonly signatureStatus: "verified";
    readonly nativeOperationalValidationStatus: "verified";
    readonly operationalStateHash: string;
  };
  readonly coverageReport: Readonly<Record<string, unknown>> & {
    readonly classASections: number;
    readonly classBSections: number;
    readonly classCSections: number;
    readonly orderableClassCSections: 0;
  };
  readonly rightsReport: Readonly<Record<string, unknown>> & {
    readonly approved: true;
    readonly sourceIds: readonly string[];
  };
  readonly deviationReport: Readonly<Record<string, unknown>>;
  readonly impactPreview: Readonly<Record<string, unknown>>;
  readonly operationalInfrastructure: OperationalInfrastructureBinding;
}

/**
 * Kleine persistierbare Bindung an genau ein bereits installiertes und nativ
 * qualifiziertes Operational-v2-Artefakt. Der Dateipfad selbst bleibt im
 * prozesslokalen, ops-gepflegten Release-Root-Katalog.
 */
export interface OperationalInfrastructureBinding {
  readonly schemaVersion: "zugfolge-operational-infrastructure-binding/v2";
  readonly infraReleaseId: string;
  readonly file: "operational-infrastructure-v2.json";
  readonly bytes: number;
  readonly sha256: string;
  readonly stateHash: string;
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

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_RELEASE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

function record(value: unknown, detail: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AlphaValidationError(detail);
  }
  return value as Readonly<Record<string, unknown>>;
}

function operationalInfrastructureBinding(
  value: unknown,
  detail = "Operational-v2-Aktivierungsbindung ist ungueltig.",
): OperationalInfrastructureBinding {
  const binding = record(value, detail);
  if (
    Object.keys(binding).sort().join(",") !== "bytes,file,infraReleaseId,schemaVersion,sha256,stateHash"
    || binding["schemaVersion"] !== "zugfolge-operational-infrastructure-binding/v2"
    || typeof binding["infraReleaseId"] !== "string"
    || !SAFE_RELEASE_ID.test(binding["infraReleaseId"])
    || binding["file"] !== "operational-infrastructure-v2.json"
    || !Number.isSafeInteger(binding["bytes"])
    || (binding["bytes"] as number) <= 0
    || typeof binding["sha256"] !== "string"
    || !SHA256.test(binding["sha256"])
    || typeof binding["stateHash"] !== "string"
    || !SHA256.test(binding["stateHash"])
    || binding["sha256"] === binding["stateHash"]
  ) {
    throw new AlphaValidationError(detail);
  }
  return binding as unknown as OperationalInfrastructureBinding;
}

function sameOperationalInfrastructure(
  left: OperationalInfrastructureBinding,
  right: OperationalInfrastructureBinding,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.infraReleaseId === right.infraReleaseId
    && left.file === right.file
    && left.bytes === right.bytes
    && left.sha256 === right.sha256
    && left.stateHash === right.stateHash;
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

  private verifyQualifiedPackageProof(candidate: QualifiedInfraPackageCandidate): void {
    const proof = candidate.signatureProof;
    const expectedProofKeys = [
      "schema", "deliveryReleaseId", "timetableYear", "packageManifestSha256", "deliveryReleaseHash",
      "infraReleaseHash", "algorithm", "keyId", "valueBase64", "signatureStatus",
      "nativeOperationalValidationStatus", "operationalStateHash",
    ].sort().join(",");
    if (Object.keys(proof).sort().join(",") !== expectedProofKeys
      || proof.schema !== "zugfolge-infra-package-activation-proof/v1"
      || proof.deliveryReleaseId !== candidate.releaseId
      || proof.timetableYear !== candidate.timetableYear
      || proof.packageManifestSha256 !== candidate.packageManifestSha256
      || proof.infraReleaseHash !== candidate.releaseHash
      || !/^[a-f0-9]{64}$/.test(proof.deliveryReleaseHash)
      || !/^[a-f0-9]{64}$/.test(proof.operationalStateHash)
      || proof.algorithm !== "Ed25519"
      || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(proof.keyId)
      || !/^[A-Za-z0-9+/]{86}==$/.test(proof.valueBase64)
      || proof.signatureStatus !== "verified"
      || proof.nativeOperationalValidationStatus !== "verified") {
      throw new AlphaValidationError("Delivery-v2-Kandidat besitzt keinen vollstaendigen Game-Qualifikationsbeleg.");
    }
    const trustedKeyPem = this.trustedKeys[proof.keyId];
    if (trustedKeyPem === undefined) throw new AlphaValidationError("Delivery-v2-Signaturschluessel ist nicht im Trust-Store benannt.");
    let publicKey;
    try { publicKey = createPublicKey(trustedKeyPem); } catch { throw new AlphaValidationError("Delivery-v2-Signaturschluessel ist ungueltig."); }
    const signatureBytes = Buffer.from(proof.valueBase64, "base64");
    if (publicKey.asymmetricKeyType !== "ed25519"
      || signatureBytes.length !== 64
      || !verify(null, Buffer.from(proof.deliveryReleaseHash, "hex"), publicKey, signatureBytes)) {
      throw new AlphaValidationError("Delivery-v2-Qualifikationsbeleg besitzt keine gueltige vertrauenswuerdige Ed25519-Signatur.");
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

  async stageQualifiedPackageCandidateAt(
    worldId: string,
    candidate: QualifiedInfraPackageCandidate,
    requestedPeriodStart: Date,
  ) {
    if (!/^[a-f0-9]{64}$/.test(candidate.releaseHash) || !/^[a-f0-9]{64}$/.test(candidate.packageManifestSha256)) {
      throw new AlphaValidationError("Delivery-v2-Kandidat besitzt keine gueltige Hashbindung.");
    }
    if (!Number.isSafeInteger(candidate.timetableYear) || candidate.timetableYear < 2026 || candidate.timetableYear > 2200) {
      throw new AlphaValidationError("Delivery-v2-Kandidat besitzt kein gueltiges Fahrplanjahr.");
    }
    if (!(requestedPeriodStart instanceof Date) || Number.isNaN(requestedPeriodStart.getTime())) throw new AlphaValidationError("Beantragter Periodenwechsel ist ungueltig.");
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(candidate.releaseId)) throw new AlphaValidationError("Delivery-v2-Kandidat besitzt keine gueltige Release-ID.");
    if (![candidate.coverageReport.classASections, candidate.coverageReport.classBSections, candidate.coverageReport.classCSections]
      .every((count) => Number.isSafeInteger(count) && count >= 0)
      || candidate.coverageReport.classCSections !== 0
      || candidate.coverageReport.orderableClassCSections !== 0) {
      throw new AlphaValidationError("Operational-v2-Kandidat muss Klasse C vollstaendig ausschliessen.");
    }
    if (!candidate.rightsReport.approved
      || candidate.rightsReport.sourceIds.length === 0
      || candidate.rightsReport.sourceIds.some((sourceId) => !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(sourceId))
      || new Set(candidate.rightsReport.sourceIds).size !== candidate.rightsReport.sourceIds.length) {
      throw new AlphaValidationError("Rechtefreigabe aller Datenquellen fehlt.");
    }
    if (candidate.deviationReport["unresolvedRequired"] !== 0
      || candidate.impactPreview["operationalStateHash"] !== candidate.signatureProof.operationalStateHash) {
      throw new AlphaValidationError("Delivery-v2-Kandidat besitzt offene Abweichungen oder keine Operational-v2-Zustandsbindung.");
    }
    const targetInfrastructure = operationalInfrastructureBinding(candidate.operationalInfrastructure);
    if (targetInfrastructure.infraReleaseId !== candidate.releaseId
      || targetInfrastructure.stateHash !== candidate.signatureProof.operationalStateHash) {
      throw new AlphaValidationError("Delivery-v2-Kandidat und Operational-v2-Artefakt besitzen verschiedene Release- oder Zustandbindungen.");
    }
    this.verifyQualifiedPackageProof(candidate);

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${alphaWorldProfiles.worldId}
        from ${alphaWorldProfiles}
        join ${worlds} on ${worlds.id} = ${alphaWorldProfiles.worldId}
        where ${alphaWorldProfiles.worldId} = ${worldId}
        for update of ${alphaWorldProfiles}, ${worlds}
      `);
      const [binding] = await tx.select({
        state: alphaWorldProfiles.state,
        currentPeriod: alphaWorldProfiles.currentPeriod,
        predecessorHash: alphaWorldProfiles.infraReleaseHash,
        accelerationFactor: alphaWorldProfiles.accelerationFactor,
        epoch: worlds.epoch,
        schedulePeriodWeeks: worlds.schedulePeriodWeeks,
      }).from(alphaWorldProfiles).innerJoin(worlds, eq(worlds.id, alphaWorldProfiles.worldId))
        .where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
      if (binding === undefined || binding.state !== "running") throw new AlphaConflictError("InfraRelease kann nur fuer eine laufende Welt beantragt werden.");
      if (!Number.isSafeInteger(binding.currentPeriod) || binding.currentPeriod < 0
        || !Number.isSafeInteger(binding.schedulePeriodWeeks) || binding.schedulePeriodWeeks < 3 || binding.schedulePeriodWeeks > 8
        || !Number.isSafeInteger(binding.accelerationFactor) || binding.accelerationFactor < 1
        || Number.isNaN(binding.epoch.getTime())) {
        throw new AlphaValidationError("Welt besitzt keinen gueltigen Periodenvertrag.");
      }
      if (binding.predecessorHash === candidate.releaseHash) {
        const [activated] = await tx.select().from(infraReleaseChanges).where(and(
          eq(infraReleaseChanges.worldId, worldId),
          eq(infraReleaseChanges.releaseHash, candidate.releaseHash),
        )).limit(1);
        const storedManifest = activated === undefined
          ? undefined
          : (activated.signature as Record<string, unknown>)["packageManifestSha256"];
        if (activated?.status === "activated"
          && activated.releaseId === candidate.releaseId
          && activated.timetableYear === candidate.timetableYear
          && activated.validFrom.getTime() === requestedPeriodStart.getTime()
          && storedManifest === candidate.packageManifestSha256
          && sameOperationalInfrastructure(
            operationalInfrastructureBinding(
              (activated.impactPreview as Readonly<Record<string, unknown>>)["operationalInfrastructure"],
            ),
            targetInfrastructure,
          )) {
          return activated;
        }
        throw new AlphaConflictError("InfraRelease-Kandidat ist bereits aktiv oder gehoert zu einer anderen Aktivierung.", "infra_predecessor_conflict");
      }

      const activateAtPeriod = binding.currentPeriod + 1;
      const periodSeconds = BigInt(binding.schedulePeriodWeeks) * 7n * 86_400n;
      const accelerationFactor = BigInt(binding.accelerationFactor);
      const boundaryWallSeconds = (BigInt(activateAtPeriod) * periodSeconds + accelerationFactor - 1n) / accelerationFactor;
      const followingBoundaryWallSeconds = (BigInt(activateAtPeriod + 1) * periodSeconds + accelerationFactor - 1n) / accelerationFactor;
      const expectedStartMs = BigInt(binding.epoch.getTime()) + boundaryWallSeconds * 1_000n;
      const validUntilMs = BigInt(binding.epoch.getTime()) + followingBoundaryWallSeconds * 1_000n;
      if (expectedStartMs > BigInt(Number.MAX_SAFE_INTEGER) || validUntilMs > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new AlphaValidationError("Periodenwechsel liegt ausserhalb des sicheren Zeitbereichs.");
      }
      if (requestedPeriodStart.getTime() !== Number(expectedStartMs)) {
        throw new AlphaConflictError("Beantragter Zeitpunkt ist nicht der exakte naechste Periodenwechsel.", "infra_period_start_mismatch");
      }

      const [competingCandidate] = await tx.select({ id: infraReleaseChanges.id })
        .from(infraReleaseChanges).where(and(
          eq(infraReleaseChanges.worldId, worldId),
          eq(infraReleaseChanges.activateAtPeriod, activateAtPeriod),
          ne(infraReleaseChanges.releaseHash, candidate.releaseHash),
          inArray(infraReleaseChanges.status, ["validated", "scheduled", "activated"]),
        )).limit(1);
      if (competingCandidate !== undefined) {
        throw new AlphaConflictError(
          "Periodenwechsel ist bereits an einen anderen InfraRelease-Kandidaten gebunden.",
          "infra_period_candidate_conflict",
        );
      }

      let [created] = await tx.insert(infraReleaseChanges).values({
        worldId,
        releaseId: candidate.releaseId,
        releaseHash: candidate.releaseHash,
        predecessorHash: binding.predecessorHash,
        timetableYear: candidate.timetableYear,
        validFrom: requestedPeriodStart,
        validUntil: new Date(Number(validUntilMs)),
        coverageReport: candidate.coverageReport,
        rightsReport: candidate.rightsReport,
        deviationReport: candidate.deviationReport,
        signature: candidate.signatureProof,
        impactPreview: {
          ...candidate.impactPreview,
          operationalInfrastructure: targetInfrastructure,
        },
        activateAtPeriod,
        status: "validated",
      }).onConflictDoNothing().returning();
      if (created === undefined) {
        [created] = await tx.select().from(infraReleaseChanges).where(and(
          eq(infraReleaseChanges.worldId, worldId),
          eq(infraReleaseChanges.releaseHash, candidate.releaseHash),
        )).limit(1);
        if (created === undefined) throw new AlphaConflictError("Delivery-v2-Release-ID gehoert bereits zu einem anderen Hash.", "infra_candidate_conflict");
        const storedManifest = (created.signature as Record<string, unknown>)["packageManifestSha256"];
        if (created.releaseId !== candidate.releaseId
          || created.predecessorHash !== binding.predecessorHash
          || created.timetableYear !== candidate.timetableYear
          || created.validFrom.getTime() !== requestedPeriodStart.getTime()
          || created.validUntil.getTime() !== Number(validUntilMs)
          || created.activateAtPeriod !== activateAtPeriod
          || storedManifest !== candidate.packageManifestSha256
          || !sameOperationalInfrastructure(
            operationalInfrastructureBinding(
              (created.impactPreview as Readonly<Record<string, unknown>>)["operationalInfrastructure"],
            ),
            targetInfrastructure,
          )
          || !["validated", "scheduled"].includes(created.status)) {
          throw new AlphaConflictError("Delivery-v2-Hash gehoert zu einem anderen oder bereits verbrauchten Kandidaten.", "infra_candidate_conflict");
        }
      }
      return created;
    });
  }

  async approveStaged(worldId: string, releaseHash: string, requestedByAdminRequestId: string, activateAtPeriod: number) {
    if (!/^[a-f0-9]{64}$/.test(releaseHash)) throw new AlphaValidationError("InfraRelease-Hash ist ungueltig.");
    const [request] = await this.db.select().from(gameAdminRequests).where(and(
      eq(gameAdminRequests.worldId, worldId), eq(gameAdminRequests.id, requestedByAdminRequestId),
    )).limit(1);
    if (request === undefined || request.actionType !== "infra_release_adoption" || request.riskClass !== "high" || request.state !== "dispatched") {
      throw new AlphaConflictError("Dispatchter Hochrisiko-Odoo-Antrag fuer InfraRelease fehlt.", "odoo_approval_missing");
    }
    if (request.approverReference === null || request.approverReference === request.requesterReference) throw new AlphaConflictError("Vier-Augen-Prinzip ist nicht belegt.", "four_eyes_missing");
    const [candidate] = await this.db.select().from(infraReleaseChanges).where(and(
      eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.releaseHash, releaseHash),
    )).limit(1);
    if (candidate === undefined || !["validated", "scheduled", "activated"].includes(candidate.status)) throw new AlphaConflictError("Signierter und validierter InfraRelease-Kandidat fehlt.", "infra_candidate_missing");
    if (candidate.activateAtPeriod !== activateAtPeriod) throw new AlphaConflictError("Odoo-Wirkungsvorschau und Kandidat nennen verschiedene Perioden.", "infra_period_mismatch");
    void this.safety;
    throw new AlphaConflictError(
      "InfraRelease-Uebernahme erfordert ein vollstaendig signiertes Deployment-Cutover mit Planning- und Livemap-Bindung.",
      "infra_hot_activation_requires_full_deployment",
    );
  }

  async approveStagedAt(worldId: string, releaseHash: string, requestedByAdminRequestId: string, requestedPeriodStart: Date) {
    if (Number.isNaN(requestedPeriodStart.getTime())) throw new AlphaValidationError("Beantragter Periodenwechsel ist ungueltig.");
    const [candidate] = await this.db.select().from(infraReleaseChanges).where(and(
      eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.releaseHash, releaseHash),
    )).limit(1);
    if (candidate === undefined || !["validated", "scheduled", "activated"].includes(candidate.status)) throw new AlphaConflictError("Signierter und validierter InfraRelease-Kandidat fehlt.", "infra_candidate_missing");
    if (candidate.validFrom.getTime() !== requestedPeriodStart.getTime()) throw new AlphaConflictError("Odoo-Periodenwechsel stimmt nicht mit der Release-Geltung ueberein.", "infra_period_start_mismatch");
    return this.approveStaged(worldId, releaseHash, requestedByAdminRequestId, candidate.activateAtPeriod);
  }

  async activateAtPeriodBoundary(worldId: string, period: number, atS: number) {
    if (!Number.isSafeInteger(period) || period < 1 || !Number.isSafeInteger(atS) || atS < 0) throw new AlphaValidationError("Periodenwechsel ist ungueltig.");
    const changes = await this.db.select().from(infraReleaseChanges).where(and(
      eq(infraReleaseChanges.worldId, worldId),
      eq(infraReleaseChanges.activateAtPeriod, period),
      inArray(infraReleaseChanges.status, ["scheduled", "activated"]),
    )).limit(2);
    if (changes.length > 1) {
      throw new AlphaConflictError(
        "Periodenwechsel besitzt mehrere aktive InfraRelease-Kandidaten.",
        "infra_period_activation_ambiguous",
      );
    }
    const [change] = changes;
    if (change === undefined) return undefined;
    void atS;
    throw new AlphaConflictError(
      "InfraRelease-Aktivierung erfordert ein vollstaendig signiertes Deployment-Cutover mit Planning- und Livemap-Bindung.",
      "infra_hot_activation_requires_full_deployment",
    );
  }

  async rollback(worldId: string, changeId: string, adminRequestId: string, atS: number) {
    const [change] = await this.db.select().from(infraReleaseChanges).where(and(eq(infraReleaseChanges.worldId, worldId), eq(infraReleaseChanges.id, changeId))).limit(1);
    if (change?.status !== "activated") throw new AlphaConflictError("Nur ein aktivierter Release kann zurueckgerollt werden.");
    // Ein final aktivierter Operational-v2-Kopf besteht aus Profil, allen
    // regionalen Rust-Zustaenden, durablem Receipt-Ledger und der signierten
    // Programmregistry. Der historische Profil-only-Rollback wuerde diese
    // Autoritaeten unweigerlich trennen. Rueckkehr erfolgt deshalb nur ueber
    // den quieszierten Full-Deployment-Recovery-Vertrag mit DB-Restore.
    void adminRequestId;
    void atS;
    throw new AlphaConflictError(
      "Final aktivierte Operational-v2-Releases koennen nur ueber Full-Deployment-Recovery zurueckgesetzt werden.",
      "infra_runtime_rollback_requires_recovery",
    );
  }
}
