import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalInfraBeginBody, canonicalInfraFinalizeBody, registerInfraPackageUploadRoutes } from "./infra-package-routes.js";
import {
  InfraPackageStaging,
  infraFinalizationReceiptSignature,
  infraUploadSignature,
  type InfraPackageFinalizationReceipt,
} from "./infra-package-staging.js";

const key = { id: "odoo-infra-test", secret: "test-secret-with-sufficient-entropy" };
const roots: string[] = [];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signedHeaders(method: string, pathname: string, bytes: Buffer): Record<string, string> {
  const timestamp = new Date().toISOString();
  const contentSha256 = sha256(bytes);
  return {
    "x-zugfolge-infra-key-id": key.id,
    "x-zugfolge-infra-timestamp": timestamp,
    "x-zugfolge-infra-content-bytes": String(bytes.length),
    "x-zugfolge-infra-content-sha256": contentSha256,
    "x-zugfolge-infra-signature": infraUploadSignature({ key, timestamp, method, pathname, contentBytes: bytes.length, contentSha256 }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Odoo-Infra-Paketupload", () => {
  it("versioniert den signierten aktuellen Finalisierungsbeleg mit vollstaendiger Operational-Provenienz als v2", () => {
    const receipt: InfraPackageFinalizationReceipt = {
      schema: "zugfolge-infra-package-finalization-receipt/v2",
      signatureAlgorithm: "HMAC-SHA256",
      keyId: key.id,
      nonce: "a".repeat(64),
      requestedAt: "2026-08-25T08:00:00.000Z",
      finalizedAt: "2026-08-25T08:00:01.000Z",
      importId: "annual-2026-5",
      packageId: "zugfolge-map-deutschland",
      packageVersion: "2026.5",
      manifestSha256: "b".repeat(64),
      deliveryReleaseId: "infra-deutschland-2026.5",
      operationalStateHash: "c".repeat(64),
      operationalProvenanceStatus: "verified",
      operationalProvenanceSha256: "d".repeat(64),
      operationalExecutionProofSha256: "e".repeat(64),
      operationalValidatorSha256: "f".repeat(64),
      operationalAuthorityStatus: "verified",
      operationalAuthoritySha256: "1".repeat(64),
      operationalRebuildAttestationSha256: "2".repeat(64),
      operationalExecutionAuthorityAttestationSha256: "3".repeat(64),
      operationalOuterExecutionReceiptSha256: "4".repeat(64),
      operationalOuterExecutionCompletionSha256: "5".repeat(64),
      operationalAuthoritySourceCommit: "6".repeat(40),
      signatureStatus: "verified",
      nativeOperationalValidationStatus: "verified",
      activationBlocker: null,
      activationEligible: true,
    };
    expect(infraFinalizationReceiptSignature({ key, receipt })).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => infraFinalizationReceiptSignature({ key, receipt: { ...receipt, schema: "zugfolge-infra-package-finalization-receipt/v1" } })).toThrow(/Paketversion/u);
    expect(() => infraFinalizationReceiptSignature({ key, receipt: { ...receipt, operationalExecutionProofSha256: null } })).toThrow(/Ausfuehrungsprovenienz/u);
    expect(() => infraFinalizationReceiptSignature({ key, receipt: { ...receipt, operationalOuterExecutionCompletionSha256: null } })).toThrow(/Authority/u);
    const unsigned: InfraPackageFinalizationReceipt = {
      ...receipt,
      operationalStateHash: null,
      operationalProvenanceStatus: "missing",
      operationalProvenanceSha256: null,
      operationalExecutionProofSha256: null,
      operationalValidatorSha256: null,
      operationalAuthorityStatus: "missing",
      operationalAuthoritySha256: null,
      operationalRebuildAttestationSha256: null,
      operationalExecutionAuthorityAttestationSha256: null,
      operationalOuterExecutionReceiptSha256: null,
      operationalOuterExecutionCompletionSha256: null,
      operationalAuthoritySourceCommit: null,
      signatureStatus: "missing",
      nativeOperationalValidationStatus: "missing",
      activationBlocker: "delivery-signature-missing",
      activationEligible: false,
    };
    expect(infraFinalizationReceiptSignature({ key, receipt: unsigned })).toMatch(/^[a-f0-9]{64}$/u);
    for (const packageVersion of ["2026.2", "2026.6", "2027.1", "2026.5-near-miss"]) {
      expect(() => infraFinalizationReceiptSignature({
        key,
        receipt: { ...receipt, packageVersion, deliveryReleaseId: `infra-deutschland-${packageVersion}` },
      })).toThrow(/nicht als Deutschland-Delivery-v2-Version freigegeben/u);
    }
  });

  it("authentifiziert Steuerkörper bytegenau und beginnt idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-infra-route-"));
    roots.push(root);
    const app = Fastify({ logger: false });
    const staging = new InfraPackageStaging(root, {
      packageVerifier: async () => { throw new Error("wird im Begin-Test nicht aufgerufen"); },
    });
    registerInfraPackageUploadRoutes(app, staging, [key]);
    const pathname = "/integrations/odoo/infra-package-imports/annual-2026";
    const body = { manifestBytes: 2, manifestSha256: sha256(Buffer.from("{}")) };
    const canonical = canonicalInfraBeginBody(body);
    const first = await app.inject({ method: "POST", url: pathname, payload: body, headers: signedHeaders("POST", pathname, canonical) });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ accepted: true, status: "created" });
    const repeated = await app.inject({ method: "POST", url: pathname, payload: body, headers: signedHeaders("POST", pathname, canonical) });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ accepted: true, status: "reused" });

    const manifestPath = `${pathname}/manifest`;
    const wrongBytes = Buffer.from("[]");
    const wrongProof = await app.inject({
      method: "PUT",
      url: manifestPath,
      payload: wrongBytes,
      headers: { "content-type": "application/octet-stream", ...signedHeaders("PUT", manifestPath, wrongBytes) },
    });
    expect(wrongProof.statusCode).toBe(401);
    expect(wrongProof.json()).toMatchObject({ code: "invalid_upload_auth" });

    const invalid = await app.inject({
      method: "POST",
      url: "/integrations/odoo/infra-package-imports/annual-2026-invalid",
      payload: body,
      headers: { ...signedHeaders("POST", "/integrations/odoo/infra-package-imports/annual-2026-invalid", canonical), "x-zugfolge-infra-signature": "00" },
    });
    expect(invalid.statusCode).toBe(401);
    await app.close();
  });

  it("liefert nach verlorener Finalisierungsantwort den gebundenen terminalen Beleg bereits beim erneuten Start", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-infra-route-recover-finalize-"));
    roots.push(root);
    const app = Fastify({ logger: false });
    const staging = new InfraPackageStaging(root, {
      packageVerifier: async () => { throw new Error("wird beim terminalen Begin-Retry nicht aufgerufen"); },
    });
    const importId = "annual-2026-finalize-response-lost";
    const challenge = {
      schema: "zugfolge-infra-package-finalization-challenge/v1" as const,
      nonce: "d".repeat(64),
      requestedAt: "2026-08-25T08:00:00.000Z",
    };
    vi.spyOn(staging, "beginForOdoo").mockResolvedValue({
      status: "finalized",
      finalizationChallenge: challenge,
      finalizedAt: "2026-08-25T08:00:02.000Z",
      qualification: {
        packageId: "zugfolge-map-deutschland",
        version: "2026.3",
        manifestSha256: "b".repeat(64),
        deliveryReleaseId: "infra-deutschland-2026.3",
        operationalStateHash: "c".repeat(64),
        operationalProvenanceStatus: "missing",
        operationalProvenanceSha256: null,
        operationalExecutionProofSha256: null,
        operationalValidatorSha256: null,
        operationalAuthorityStatus: "missing",
        operationalAuthoritySha256: null,
        operationalRebuildAttestationSha256: null,
        operationalExecutionAuthorityAttestationSha256: null,
        operationalOuterExecutionReceiptSha256: null,
        operationalOuterExecutionCompletionSha256: null,
        operationalAuthoritySourceCommit: null,
        signatureStatus: "verified",
        nativeOperationalValidationStatus: "verified",
        activationBlocker: null,
        activationEligible: true,
      },
    });
    registerInfraPackageUploadRoutes(app, staging, [key]);
    const pathname = `/integrations/odoo/infra-package-imports/${importId}`;
    const body = { manifestBytes: 42, manifestSha256: "b".repeat(64) };
    const response = await app.inject({
      method: "POST",
      url: pathname,
      payload: body,
      headers: signedHeaders("POST", pathname, canonicalInfraBeginBody(body)),
    });
    expect(response.statusCode).toBe(200);
    const value = response.json() as {
      status?: string;
      finalizationReceipt: InfraPackageFinalizationReceipt;
      finalizationReceiptSignature: string;
    };
    expect(value.status).toBe("finalized");
    expect(value.finalizationReceipt).toMatchObject({
      nonce: challenge.nonce,
      importId,
      manifestSha256: "b".repeat(64),
      deliveryReleaseId: "infra-deutschland-2026.3",
      activationEligible: true,
    });
    expect(Object.keys(value.finalizationReceipt).sort()).toEqual([
      "activationBlocker", "activationEligible", "deliveryReleaseId", "finalizedAt", "importId", "keyId",
      "manifestSha256", "nativeOperationalValidationStatus", "nonce", "operationalStateHash", "packageId",
      "packageVersion", "requestedAt", "schema", "signatureAlgorithm", "signatureStatus",
    ]);
    expect(value).not.toHaveProperty("operationalProvenanceStatus");
    expect(value.finalizationReceiptSignature).toBe(infraFinalizationReceiptSignature({ key, receipt: value.finalizationReceipt }));
    await app.close();
  });

  it("meldet ein generisch geschlossenes Receipt als heilbaren Startzustand", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-infra-route-recover-closed-"));
    roots.push(root);
    const app = Fastify({ logger: false });
    const staging = new InfraPackageStaging(root, {
      packageVerifier: async () => { throw new Error("wird beim geschlossenen Begin-Retry nicht aufgerufen"); },
    });
    vi.spyOn(staging, "beginForOdoo").mockResolvedValue({ status: "closed" });
    registerInfraPackageUploadRoutes(app, staging, [key]);
    const pathname = "/integrations/odoo/infra-package-imports/annual-2026-closed";
    const body = { manifestBytes: 42, manifestSha256: "b".repeat(64) };
    const response = await app.inject({
      method: "POST",
      url: pathname,
      payload: body,
      headers: signedHeaders("POST", pathname, canonicalInfraBeginBody(body)),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true, status: "closed" });
    await app.close();
  });

  it("streamt Binärdaten, übernimmt aber kein Client-Dateisystemziel", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-infra-route-stream-"));
    roots.push(root);
    const app = Fastify({ logger: false });
    const staging = new InfraPackageStaging(root, {
      packageVerifier: async () => { throw new Error("wird bei ungültigem Manifest nicht aufgerufen"); },
    });
    registerInfraPackageUploadRoutes(app, staging, [key]);
    const importId = "annual-2026-stream";
    const beginPath = `/integrations/odoo/infra-package-imports/${importId}`;
    const uploaded = Buffer.from("{}");
    const beginBody = { manifestBytes: uploaded.length, manifestSha256: sha256(uploaded) };
    await app.inject({ method: "POST", url: beginPath, payload: beginBody, headers: signedHeaders("POST", beginPath, canonicalInfraBeginBody(beginBody)) });
    const manifestPath = `${beginPath}/manifest`;
    const response = await app.inject({
      method: "PUT",
      url: manifestPath,
      payload: uploaded,
      headers: { "content-type": "application/octet-stream", ...signedHeaders("PUT", manifestPath, uploaded) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ accepted: false, code: "invalid_infra_package" });
    await app.close();
  });

  it("quittiert die positive Game-Finalisierung HMAC-, nonce-, Import-, Release- und Zustands-gebunden", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-infra-route-finalize-"));
    roots.push(root);
    const app = Fastify({ logger: false });
    const staging = new InfraPackageStaging(root, {
      packageVerifier: async () => { throw new Error("wird im gebundenen Route-Test nicht aufgerufen"); },
    });
    const importId = "annual-2026-finalized";
    const pathname = `/integrations/odoo/infra-package-imports/${importId}/finalize`;
    const challenge = {
      schema: "zugfolge-infra-package-finalization-challenge/v1" as const,
      nonce: "a".repeat(64),
      requestedAt: "2026-08-25T08:00:00.000Z",
    };
    const finalizedAt = "2026-08-25T08:00:01.000Z";
    vi.spyOn(staging, "finalizeForOdoo").mockResolvedValue({
      stagePath: root,
      finalizationChallenge: challenge,
      finalizedAt,
      packageId: "zugfolge-map-deutschland",
      version: "2026.3",
      manifestSha256: "b".repeat(64),
      deliveryReleaseId: "infra-deutschland-2026.3",
      operationalStateHash: "c".repeat(64),
      operationalProvenanceStatus: "missing",
      operationalProvenanceSha256: null,
      operationalExecutionProofSha256: null,
      operationalValidatorSha256: null,
      operationalAuthorityStatus: "missing",
      operationalAuthoritySha256: null,
      operationalRebuildAttestationSha256: null,
      operationalExecutionAuthorityAttestationSha256: null,
      operationalOuterExecutionReceiptSha256: null,
      operationalOuterExecutionCompletionSha256: null,
      operationalAuthoritySourceCommit: null,
      signatureStatus: "verified",
      nativeOperationalValidationStatus: "verified",
      activationBlocker: null,
      activationEligible: true,
    });
    registerInfraPackageUploadRoutes(app, staging, [key]);

    const response = await app.inject({
      method: "POST",
      url: pathname,
      payload: challenge,
      headers: signedHeaders("POST", pathname, canonicalInfraFinalizeBody(challenge)),
    });
    expect(response.statusCode).toBe(200);
    const value = response.json() as {
      finalizationReceipt: InfraPackageFinalizationReceipt;
      finalizationReceiptSignature: string;
    };
    expect(value.finalizationReceipt).toMatchObject({
      nonce: challenge.nonce,
      importId,
      manifestSha256: "b".repeat(64),
      deliveryReleaseId: "infra-deutschland-2026.3",
      operationalStateHash: "c".repeat(64),
      signatureStatus: "verified",
      nativeOperationalValidationStatus: "verified",
      activationBlocker: null,
      activationEligible: true,
    });
    expect(Object.keys(value.finalizationReceipt).sort()).toEqual([
      "activationBlocker", "activationEligible", "deliveryReleaseId", "finalizedAt", "importId", "keyId",
      "manifestSha256", "nativeOperationalValidationStatus", "nonce", "operationalStateHash", "packageId",
      "packageVersion", "requestedAt", "schema", "signatureAlgorithm", "signatureStatus",
    ]);
    expect(value).not.toHaveProperty("operationalProvenanceStatus");
    expect(value.finalizationReceiptSignature).toBe(infraFinalizationReceiptSignature({ key, receipt: value.finalizationReceipt }));
    await app.close();
  });
});
