import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, alphaWorldProfiles, domainEvents, gameAdminRequests, infraReleaseChanges, odooCommandQueue, regionalSimulationStates, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { alphaHash } from "./hash.js";
import {
  InfraUpdateService,
  type InfraActivationSafety,
  type OperationalInfrastructureBinding,
  type QualifiedInfraPackageCandidate,
} from "./infra-update.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const EPOCH = new Date("2026-01-01T00:00:00.000Z");
const VALID_FROM = new Date("2026-01-22T00:00:00.000Z");
const OLD = "a".repeat(64);
const PACKAGE_MANIFEST_SHA256 = "1".repeat(64);
const QUALIFIED_INFRA_RELEASE_HASH = "2".repeat(64);
const QUALIFIED_KEY_ID = "delivery-2027";
const QUALIFIED_KEYS = generateKeyPairSync("ed25519");
const QUALIFIED_PUBLIC_KEY = QUALIFIED_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const NEXT_PERIOD_START = new Date("2026-01-01T08:24:00.000Z");
const INITIALIZATION_HASH = "5".repeat(64);
const INITIAL_STATE_HASH = "6".repeat(64);
const PREDECESSOR_INFRASTRUCTURE: OperationalInfrastructureBinding = Object.freeze({
  schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
  infraReleaseId: "infra-deutschland-2026.3",
  file: "operational-infrastructure-v2.json",
  bytes: 4_096,
  sha256: "8".repeat(64),
  stateHash: "9".repeat(64),
});
const TARGET_INFRASTRUCTURE: OperationalInfrastructureBinding = Object.freeze({
  schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
  infraReleaseId: "infra-deutschland-2026.4",
  file: "operational-infrastructure-v2.json",
  bytes: 8_192,
  sha256: "0".repeat(64),
  stateHash: "4".repeat(64),
});

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values({ id: WORLD, name: "Infra-Testwelt", schedulePeriodWeeks: 3, epoch: EPOCH });
  await db.insert(alphaWorldProfiles).values({
    worldId: WORLD, profileKind: "test", regionId: "mitteldeutschland-b", regionVariant: "B",
    worldSeed: 42n, accelerationFactor: 60, infraReleaseHash: OLD,
    timetableReleaseHash: "b".repeat(64), fleetReleaseHash: "c".repeat(64), economyReleaseHash: "d".repeat(64),
    blueprint: { schemaVersion: "zugfolge-alpha-world-blueprint/v1" }, blueprintHash: "e".repeat(64),
    currentPeriod: 0, state: "running", startedAtS: 0,
  });
  await db.insert(regionalSimulationStates).values({
    worldId: WORLD,
    regionId: "mitteldeutschland-b",
    stateSchema: "zugfolge-operational-simulation-state/v2",
    initializationHash: INITIALIZATION_HASH,
    stateHash: INITIAL_STATE_HASH,
    revision: 0,
    publisherSequence: 0,
    state: {
      schemaVersion: "zugfolge-operational-simulation-state/v2",
      initializationHash: INITIALIZATION_HASH,
      infraRelease: PREDECESSOR_INFRASTRUCTURE,
      world: {
        worldId: WORLD,
        regionId: "mitteldeutschland-b",
        infraReleaseId: PREDECESSOR_INFRASTRUCTURE.infraReleaseId,
        nowMs: 0,
        commitSequence: 0,
        eventSequence: 0,
      },
      revision: 0,
      publisherSequence: 0,
      stateHash: INITIAL_STATE_HASH,
      commandReceipts: {},
    },
    createdAt: EPOCH,
    updatedAt: EPOCH,
  });
}, 30_000);

afterEach(async () => client.close());

async function adminRequest(releaseHash: string, state: "approved" | "dispatched" = "dispatched") {
  const [queue] = await db.insert(odooCommandQueue).values({
    eventId: `infra-${releaseHash.slice(0, 12)}`, worldId: WORLD, commandType: "admin.infra_release_adoption",
    actorReference: "odoo-admin", payload: {}, correlationId: `corr-${releaseHash.slice(0, 12)}`,
    status: "accepted", receivedAt: EPOCH,
  }).returning();
  const [request] = await db.insert(gameAdminRequests).values({
    worldId: WORLD, commandId: queue!.id, actionType: "infra_release_adoption", riskClass: "high",
    requesterReference: "one", approverReference: "two", reason: "Jaehrlicher Fahrplanwechsel",
    effectPreview: { releaseHash }, state, correlationId: queue!.correlationId,
  }).returning();
  return request!;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function qualifiedSignatureProof(
  releaseId: string,
  releaseHash: string,
  timetableYear: number,
  infrastructure: OperationalInfrastructureBinding,
): QualifiedInfraPackageCandidate["signatureProof"] {
  const signingPayload = {
    schema: "zugfolge-map-delivery-release/v2",
    releaseId,
    timetableYear,
    packageId: "infra-deutschland-test-package",
    packageVersion: releaseId.replace("infra-deutschland-", ""),
    scope: {},
    artifacts: [{
      id: "operational-infrastructure-v2",
      kind: "operational-infrastructure-v2",
      infraReleaseId: infrastructure.infraReleaseId,
      installPath: infrastructure.file,
      bytes: infrastructure.bytes,
      sha256: infrastructure.sha256,
      stateHash: infrastructure.stateHash,
    }],
    bindings: {
      packageManifestSchema: "zugfolge-map-package/v2",
      infraReleaseSchema: "zugfolge-infra-release/v2",
      mapReleaseSchema: "zugfolge-map-release/v1",
      infraReleaseHash: releaseHash,
      mapReleaseHash: "7".repeat(64),
      sourcesSha256: "8".repeat(64),
      qualitySha256: "9".repeat(64),
    },
    approvalGates: {
      rights: { status: "passed" },
      quality: { status: "passed" },
      signature: { status: "passed", algorithm: "Ed25519", keyId: QUALIFIED_KEY_ID },
    },
  };
  const deliveryReleaseHash = createHash("sha256").update(canonicalBytes(signingPayload)).digest("hex");
  const valueBase64 = sign(null, Buffer.from(deliveryReleaseHash, "hex"), QUALIFIED_KEYS.privateKey).toString("base64");
  const deliveryRelease = {
    ...signingPayload,
    releaseHash: deliveryReleaseHash,
    signature: { algorithm: "Ed25519", keyId: QUALIFIED_KEY_ID, valueBase64 },
  };
  return {
    schema: "zugfolge-infra-package-activation-proof/v1",
    deliveryReleaseId: releaseId,
    timetableYear,
    packageManifestSha256: PACKAGE_MANIFEST_SHA256,
    deliveryReleaseHash,
    infraReleaseHash: releaseHash,
    deliveryReleaseBase64: canonicalBytes(deliveryRelease).toString("base64"),
    algorithm: "Ed25519",
    keyId: QUALIFIED_KEY_ID,
    valueBase64,
    signatureStatus: "verified",
    nativeOperationalValidationStatus: "verified",
    operationalStateHash: infrastructure.stateHash,
  };
}

function qualifiedPackageCandidate(
  overrides: Partial<QualifiedInfraPackageCandidate> = {},
): QualifiedInfraPackageCandidate {
  return {
    releaseId: "infra-deutschland-2026.4",
    releaseHash: QUALIFIED_INFRA_RELEASE_HASH,
    timetableYear: 2026,
    packageManifestSha256: PACKAGE_MANIFEST_SHA256,
    signatureProof: qualifiedSignatureProof(
      "infra-deutschland-2026.4",
      QUALIFIED_INFRA_RELEASE_HASH,
      2026,
      TARGET_INFRASTRUCTURE,
    ),
    coverageReport: {
      classASections: 0,
      classBSections: 1,
      classCSections: 0,
      orderableClassCSections: 0,
    },
    rightsReport: { approved: true, sourceIds: ["db-infrago", "gtfs-de"] },
    deviationReport: { unresolvedRequired: 0 },
    impactPreview: { operationalStateHash: "4".repeat(64) },
    operationalInfrastructure: TARGET_INFRASTRUCTURE,
    ...overrides,
  };
}

describe("M9.10 InfraRelease-Uebernahme", () => {
  it("laesst einen alten Kandidaten ohne Operational-v2-Zielbindung am Periodenwechsel fail-closed", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const manifest = { schema: "zugfolge-infra-release-manifest/v1", region: "mitteldeutschland-b", year: 2027, blocks: 1200 };
    const releaseHash = alphaHash("zugfolge-infra-release-manifest/v1", manifest);
    const safety: InfraActivationSafety = { verify: async () => ({
      safe: true, conflictCount: 0, invalidPathCount: 0, invalidCirculationCount: 0, invalidContractCount: 0,
      invariantOneProofHash: "f".repeat(64), explanation: "Konfliktfrei gegen aktiven Bindungsstand.",
    }) };
    const service = new InfraUpdateService(db, { "release-owner-2027": publicPem }, safety);
    const candidate = await service.stageCandidate({
      worldId: WORLD, releaseId: "infra-md-b-2027", predecessorHash: OLD, timetableYear: 2027,
      validFrom: VALID_FROM, validUntil: new Date("2027-12-31T23:59:59.000Z"), manifest,
      coverageReport: { classASections: 900, classBSections: 250, classCSections: 50, orderableClassCSections: 0 },
      rightsReport: { approved: true, sourceIds: ["osm-geofabrik-2026-08", "e22-infra-master-2027"] },
      deviationReport: { unresolved: 0 }, impactPreview: { paths: 200, circulations: 25, contracts: 4 },
      signature: { algorithm: "ed25519", keyId: "release-owner-2027", signedHash: releaseHash, valueBase64: sign(null, Buffer.from(releaseHash, "utf8"), keys.privateKey).toString("base64") },
      activateAtPeriod: 1,
    });
    expect(candidate).toMatchObject({ status: "validated", requestedByAdminRequestId: null, releaseHash });
    const request = await adminRequest(releaseHash);
    await expect(service.approveStagedAt(WORLD, releaseHash, request.id, VALID_FROM))
      .rejects.toMatchObject({ code: "infra_hot_activation_requires_full_deployment" });
    const [profile] = await db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, WORLD));
    const [unchanged] = await db.select().from(infraReleaseChanges).where(eq(infraReleaseChanges.id, candidate.id));
    expect(profile).toMatchObject({ currentPeriod: 0, infraReleaseHash: OLD });
    expect(unchanged).toMatchObject({ status: "validated", requestedByAdminRequestId: null });
    expect(await db.select().from(domainEvents).where(eq(domainEvents.eventType, "infrastructure.release-activated"))).toHaveLength(0);
  });

  it("weist Klasse C als bestellbar bereits vor Signatur- und Odoo-Wirkung ab", async () => {
    const keys = generateKeyPairSync("ed25519");
    const service = new InfraUpdateService(db, { owner: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }, { verify: async () => { throw new Error("darf nicht laufen"); } });
    const manifest = { region: "mitteldeutschland-b" };
    const releaseHash = alphaHash("zugfolge-infra-release-manifest/v1", manifest);
    await expect(service.stageCandidate({
      worldId: WORLD, releaseId: "bad", predecessorHash: OLD, timetableYear: 2027,
      validFrom: VALID_FROM, validUntil: new Date("2027-12-31T23:59:59.000Z"), manifest,
      coverageReport: { classASections: 1, classBSections: 1, classCSections: 1, orderableClassCSections: 1 },
      rightsReport: { approved: true, sourceIds: ["source"] }, deviationReport: {}, impactPreview: {},
      signature: { algorithm: "ed25519", keyId: "owner", signedHash: releaseHash, valueBase64: sign(null, Buffer.from(releaseHash), keys.privateKey).toString("base64") }, activateAtPeriod: 1,
    })).rejects.toThrow(/Klasse C|Qualitaetsklasse C/);
    expect(await db.select().from(infraReleaseChanges)).toHaveLength(0);
  });

  it("bindet den qualifizierten Kandidaten korrekt, laesst ihn aber nur ueber ein vollstaendig signiertes Deployment-Cutover weiter", async () => {
    const safety: InfraActivationSafety = { verify: async () => ({
      safe: true, conflictCount: 0, invalidPathCount: 0, invalidCirculationCount: 0, invalidContractCount: 0,
      invariantOneProofHash: "f".repeat(64), explanation: "Qualifizierter Paketwechsel ist konfliktfrei.",
    }) };
    const service = new InfraUpdateService(db, { [QUALIFIED_KEY_ID]: QUALIFIED_PUBLIC_KEY }, safety);
    const candidate = qualifiedPackageCandidate();

    await expect(service.stageQualifiedPackageCandidateAt(
      WORLD,
      candidate,
      new Date(NEXT_PERIOD_START.getTime() + 1_000),
    )).rejects.toMatchObject({ code: "infra_period_start_mismatch" });
    expect(await db.select().from(infraReleaseChanges)).toHaveLength(0);

    const staged = await service.stageQualifiedPackageCandidateAt(WORLD, candidate, NEXT_PERIOD_START);
    expect(staged).toMatchObject({
      worldId: WORLD,
      releaseId: candidate.releaseId,
      releaseHash: QUALIFIED_INFRA_RELEASE_HASH,
      predecessorHash: OLD,
      validFrom: NEXT_PERIOD_START,
      validUntil: new Date("2026-01-01T16:48:00.000Z"),
      activateAtPeriod: 1,
      status: "validated",
    });
    expect(staged.releaseHash).not.toBe(PACKAGE_MANIFEST_SHA256);
    expect(staged.signature).toMatchObject({ packageManifestSha256: PACKAGE_MANIFEST_SHA256 });

    const competingInfrastructure = {
      ...TARGET_INFRASTRUCTURE,
      infraReleaseId: "infra-deutschland-2026.3" as const,
      sha256: "d".repeat(64),
    };
    const competing = qualifiedPackageCandidate({
      releaseId: "infra-deutschland-2026.3",
      releaseHash: "c".repeat(64),
      signatureProof: qualifiedSignatureProof("infra-deutschland-2026.3", "c".repeat(64), 2026, competingInfrastructure),
      operationalInfrastructure: competingInfrastructure,
    });
    await expect(service.stageQualifiedPackageCandidateAt(WORLD, competing, NEXT_PERIOD_START))
      .rejects.toMatchObject({ code: "infra_period_candidate_conflict" });

    const request = await adminRequest(candidate.releaseHash, "approved");
    await expect(service.approveStagedAt(WORLD, candidate.releaseHash, request.id, NEXT_PERIOD_START))
      .rejects.toMatchObject({ code: "odoo_approval_missing" });
    await db.update(gameAdminRequests).set({ state: "dispatched" }).where(eq(gameAdminRequests.id, request.id));
    await expect(service.approveStagedAt(WORLD, candidate.releaseHash, request.id, NEXT_PERIOD_START))
      .rejects.toMatchObject({ code: "infra_hot_activation_requires_full_deployment" });
    await expect(service.approveStagedAt(WORLD, candidate.releaseHash, request.id, NEXT_PERIOD_START))
      .rejects.toMatchObject({ code: "infra_hot_activation_requires_full_deployment" });

    const replayedStage = await service.stageQualifiedPackageCandidateAt(WORLD, candidate, NEXT_PERIOD_START);
    expect(replayedStage).toMatchObject({ id: staged.id, status: "validated" });
    const [profile] = await db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, WORLD));
    const [regional] = await db.select().from(regionalSimulationStates).where(eq(regionalSimulationStates.worldId, WORLD));
    const [unchanged] = await db.select().from(infraReleaseChanges).where(eq(infraReleaseChanges.id, staged.id));
    expect(profile).toMatchObject({ currentPeriod: 0, infraReleaseHash: OLD });
    expect(regional).toMatchObject({ stateHash: INITIAL_STATE_HASH, revision: 0, publisherSequence: 0 });
    expect(regional?.state).toMatchObject({ infraRelease: PREDECESSOR_INFRASTRUCTURE });
    expect(unchanged).toMatchObject({ status: "validated", requestedByAdminRequestId: null });
    expect(await db.select().from(domainEvents).where(eq(domainEvents.eventType, "infrastructure.release-activated"))).toHaveLength(0);
    expect(await db.select().from(infraReleaseChanges)).toHaveLength(1);
  });

  it("weist auch einen historisch geplanten Hot-Cutover und dessen Profil-only-Rollback ohne Mutation ab", async () => {
    const safety: InfraActivationSafety = { verify: async () => ({
      safe: true, conflictCount: 0, invalidPathCount: 0, invalidCirculationCount: 0, invalidContractCount: 0,
      invariantOneProofHash: "f".repeat(64), explanation: "Qualifizierter Paketwechsel ist konfliktfrei.",
    }) };
    const service = new InfraUpdateService(
      db,
      { [QUALIFIED_KEY_ID]: QUALIFIED_PUBLIC_KEY },
      safety,
    );
    const candidate = qualifiedPackageCandidate();
    const staged = await service.stageQualifiedPackageCandidateAt(WORLD, candidate, NEXT_PERIOD_START);
    const request = await adminRequest(candidate.releaseHash);
    await db.update(infraReleaseChanges).set({
      status: "scheduled",
      requestedByAdminRequestId: request.id,
    }).where(eq(infraReleaseChanges.id, staged.id));

    await expect(service.activateAtPeriodBoundary(WORLD, 1, 3 * 7 * 86_400))
      .rejects.toMatchObject({ code: "infra_hot_activation_requires_full_deployment" });

    const [profile] = await db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, WORLD));
    const [regional] = await db.select().from(regionalSimulationStates).where(eq(regionalSimulationStates.worldId, WORLD));
    const [change] = await db.select().from(infraReleaseChanges).where(eq(infraReleaseChanges.id, staged.id));
    expect(profile).toMatchObject({ currentPeriod: 0, infraReleaseHash: OLD });
    expect(regional).toMatchObject({ stateHash: INITIAL_STATE_HASH, revision: 0, publisherSequence: 0 });
    expect(regional?.state).toMatchObject({ infraRelease: PREDECESSOR_INFRASTRUCTURE });
    expect(change).toMatchObject({ status: "scheduled", activatedAtS: null, activationEventId: null });
    expect(await db.select().from(domainEvents).where(eq(domainEvents.eventType, "infrastructure.release-activated"))).toHaveLength(0);

    await db.update(infraReleaseChanges).set({
      status: "activated",
      activatedAtS: 3 * 7 * 86_400,
      activationEventId: `infra-release:${staged.id}:activated`,
    }).where(eq(infraReleaseChanges.id, staged.id));
    await expect(service.rollback(WORLD, staged.id, request.id, 3 * 7 * 86_400 + 1))
      .rejects.toMatchObject({ code: "infra_runtime_rollback_requires_recovery" });
    const [afterRejectedRollback] = await db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, WORLD));
    expect(afterRejectedRollback).toMatchObject({ infraReleaseHash: OLD, currentPeriod: 0 });
  });

  it("verifiziert den Delivery-v2-Beleg am autoritativen Kandidatenwriter erneut kryptografisch", async () => {
    const service = new InfraUpdateService(
      db,
      { [QUALIFIED_KEY_ID]: QUALIFIED_PUBLIC_KEY },
      { verify: async () => { throw new Error("darf nicht laufen"); } },
    );
    const valid = qualifiedPackageCandidate();
    const delivery = JSON.parse(Buffer.from(valid.signatureProof.deliveryReleaseBase64, "base64").toString("utf8"));
    delivery.signature.valueBase64 = Buffer.alloc(64).toString("base64");
    const forged = qualifiedPackageCandidate({
      signatureProof: {
        ...valid.signatureProof,
        valueBase64: Buffer.alloc(64).toString("base64"),
        deliveryReleaseBase64: canonicalBytes(delivery).toString("base64"),
      },
    });

    await expect(service.stageQualifiedPackageCandidateAt(WORLD, forged, NEXT_PERIOD_START))
      .rejects.toThrow(/keine gueltige vertrauenswuerdige Ed25519-Signatur/);
    expect(await db.select().from(infraReleaseChanges)).toHaveLength(0);
  });

  it("verwirft bei identischer gueltiger Signatur jedes substituierte Candidate-Proof-Feld", async () => {
    const service = new InfraUpdateService(
      db,
      { [QUALIFIED_KEY_ID]: QUALIFIED_PUBLIC_KEY },
      { verify: async () => { throw new Error("darf nicht laufen"); } },
    );
    const valid = qualifiedPackageCandidate();
    const substitutedHash = "f".repeat(64);
    const substituted = qualifiedPackageCandidate({
      releaseHash: substitutedHash,
      signatureProof: {
        ...valid.signatureProof,
        infraReleaseHash: substitutedHash,
      },
    });

    expect(substituted.signatureProof.valueBase64).toBe(valid.signatureProof.valueBase64);
    expect(substituted.signatureProof.deliveryReleaseBase64).toBe(valid.signatureProof.deliveryReleaseBase64);
    await expect(service.stageQualifiedPackageCandidateAt(WORLD, substituted, NEXT_PERIOD_START))
      .rejects.toThrow(/kanonischen signierten Releasebytes/u);
    expect(await db.select().from(infraReleaseChanges)).toHaveLength(0);
  });

  it("weist unbekannte oder zukuenftige Deutschland-Delivery-IDs statt eines Legacy-Downgrades ab", async () => {
    const service = new InfraUpdateService(
      db,
      { [QUALIFIED_KEY_ID]: QUALIFIED_PUBLIC_KEY },
      { verify: async () => { throw new Error("darf nicht laufen"); } },
    );
    const base = qualifiedPackageCandidate();
    for (const releaseId of ["infra-deutschland-2026.2", "infra-deutschland-2026.6", "infra-deutschland-2027.1", "infra-deutschland-2026.5-near-miss"]) {
      const candidate = qualifiedPackageCandidate({
        releaseId,
        signatureProof: { ...base.signatureProof, deliveryReleaseId: releaseId },
        operationalInfrastructure: { ...TARGET_INFRASTRUCTURE, infraReleaseId: releaseId },
      });
      await expect(service.stageQualifiedPackageCandidateAt(WORLD, candidate, NEXT_PERIOD_START))
        .rejects.toThrow(/nicht als Deutschland-Delivery-v2-Version freigegeben/u);
    }
    expect(await db.select().from(infraReleaseChanges)).toHaveLength(0);
  });

  it("verweigert dem aktuellen Deutschland-Release einen v1- oder unvollstaendigen Ausfuehrungsprovenienzbeleg", async () => {
    const service = new InfraUpdateService(
      db,
      { [QUALIFIED_KEY_ID]: QUALIFIED_PUBLIC_KEY },
      { verify: async () => { throw new Error("darf nicht laufen"); } },
    );
    const base = qualifiedPackageCandidate();
    const currentBinding = {
      ...TARGET_INFRASTRUCTURE,
      infraReleaseId: "infra-deutschland-2026.5",
    };
    const legacyProof = {
      ...base.signatureProof,
      deliveryReleaseId: "infra-deutschland-2026.5",
      timetableYear: 2026,
    };
    const legacy = qualifiedPackageCandidate({
      releaseId: "infra-deutschland-2026.5",
      timetableYear: 2026,
      signatureProof: legacyProof,
      operationalInfrastructure: currentBinding,
    });
    await expect(service.stageQualifiedPackageCandidateAt(WORLD, legacy, NEXT_PERIOD_START))
      .rejects.toThrow(/keinen vollstaendigen Game-Qualifikationsbeleg/);

    const incompleteProof = {
      ...legacyProof,
      schema: "zugfolge-infra-package-activation-proof/v2" as const,
      operationalProvenanceStatus: "verified" as const,
      operationalProvenanceSha256: "5".repeat(64),
      operationalExecutionProofSha256: "6".repeat(64),
    };
    const incomplete = qualifiedPackageCandidate({
      releaseId: "infra-deutschland-2026.5",
      timetableYear: 2026,
      signatureProof: incompleteProof,
      operationalInfrastructure: currentBinding,
    });
    await expect(service.stageQualifiedPackageCandidateAt(WORLD, incomplete, NEXT_PERIOD_START))
      .rejects.toThrow(/keinen vollstaendigen Game-Qualifikationsbeleg/);
    expect(await db.select().from(infraReleaseChanges)).toHaveLength(0);
  });
});
