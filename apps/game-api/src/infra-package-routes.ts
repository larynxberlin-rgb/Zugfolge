import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  INFRA_PACKAGE_PART_BYTES,
  InfraPackageStaging,
  InfraPackageStagingError,
  verifyInfraUploadSignature,
  type InfraUploadSigningKey,
} from "./infra-package-staging.js";

const SHA256 = /^[a-f0-9]{64}$/;
const EMPTY_SHA256 = createHash("sha256").digest("hex");

interface UploadHeaders {
  readonly "x-zugfolge-infra-key-id": string;
  readonly "x-zugfolge-infra-timestamp": string;
  readonly "x-zugfolge-infra-signature": string;
  readonly "x-zugfolge-infra-content-bytes": string;
  readonly "x-zugfolge-infra-content-sha256": string;
}

function header(request: FastifyRequest, name: keyof UploadHeaders): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value === "") throw new InfraPackageStagingError(`Upload-Header ${name} fehlt.`, "invalid_upload_auth");
  return value;
}

function signedMetadata(request: FastifyRequest, keys: readonly InfraUploadSigningKey[]): { readonly bytes: number; readonly sha256: string } {
  const bytes = Number(header(request, "x-zugfolge-infra-content-bytes"));
  const contentSha256 = header(request, "x-zugfolge-infra-content-sha256");
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !SHA256.test(contentSha256)) throw new InfraPackageStagingError("Upload-Metadaten sind ungültig.", "invalid_upload_auth");
  try {
    verifyInfraUploadSignature({
      keyId: header(request, "x-zugfolge-infra-key-id"),
      timestamp: header(request, "x-zugfolge-infra-timestamp"),
      signature: header(request, "x-zugfolge-infra-signature"),
      method: request.method,
      pathname: request.url.split("?", 1)[0] ?? request.url,
      contentBytes: bytes,
      contentSha256,
      keys,
    });
  } catch (error) {
    throw new InfraPackageStagingError(error instanceof Error ? error.message : "Infra-Upload-Signatur ist ungültig.", "invalid_upload_auth");
  }
  return { bytes, sha256: contentSha256 };
}

export function canonicalInfraBeginBody(value: { readonly manifestBytes: number; readonly manifestSha256: string }): Buffer {
  return Buffer.from(JSON.stringify({ manifestBytes: value.manifestBytes, manifestSha256: value.manifestSha256 }), "utf8");
}

function verifyControlBody(request: FastifyRequest, keys: readonly InfraUploadSigningKey[], body: Buffer): void {
  const signed = signedMetadata(request, keys);
  const observedSha256 = createHash("sha256").update(body).digest("hex");
  if (signed.bytes !== body.length || signed.sha256 !== observedSha256) throw new InfraPackageStagingError("Signierter Steuerkörper stimmt nicht mit dem Request überein.", "invalid_upload_auth");
}

async function replyInfra<T>(reply: FastifyReply, operation: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof InfraPackageStagingError) {
      const status = error.code === "invalid_upload_auth" ? 401 : 400;
      return reply.code(status).send({ accepted: false, code: error.code, message: error.message });
    }
    throw error;
  }
}

function rawBody(request: FastifyRequest): AsyncIterable<Buffer | string> {
  const body = request.body;
  if (body === null || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    throw new InfraPackageStagingError("Binärer Uploadkörper fehlt.");
  }
  return body as AsyncIterable<Buffer | string>;
}

export function registerInfraPackageUploadRoutes(
  app: FastifyInstance,
  staging: InfraPackageStaging,
  keys: readonly InfraUploadSigningKey[],
): void {
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", { bodyLimit: INFRA_PACKAGE_PART_BYTES + 1 }, (_request, payload, done) => done(null, payload));
  }

  app.post<{ Params: { importId: string }; Body: { manifestBytes?: unknown; manifestSha256?: unknown } }>(
    "/integrations/odoo/infra-package-imports/:importId",
    async (request, reply) => replyInfra(reply, async () => {
      const manifestBytes = request.body?.manifestBytes;
      const manifestSha256 = request.body?.manifestSha256;
      if (!Number.isSafeInteger(manifestBytes) || (manifestBytes as number) <= 0 || typeof manifestSha256 !== "string" || !SHA256.test(manifestSha256)) {
        throw new InfraPackageStagingError("Manifest-Metadaten sind ungültig.");
      }
      const body = canonicalInfraBeginBody({ manifestBytes: manifestBytes as number, manifestSha256 });
      verifyControlBody(request, keys, body);
      const result = await staging.begin(request.params.importId, { bytes: manifestBytes as number, sha256: manifestSha256 });
      return reply.code(result.status === "created" ? 201 : 200).send({ accepted: true, ...result });
    }),
  );

  app.put<{ Params: { importId: string } }>(
    "/integrations/odoo/infra-package-imports/:importId/manifest",
    async (request, reply) => replyInfra(reply, async () => {
      const proof = signedMetadata(request, keys);
      const expected = await staging.expectedManifest(request.params.importId);
      if (proof.bytes !== expected.bytes || proof.sha256 !== expected.sha256) throw new InfraPackageStagingError("Signierter Manifestbeleg stimmt nicht mit der Uploadsitzung überein.", "invalid_upload_auth");
      const result = await staging.uploadManifest(request.params.importId, proof, rawBody(request));
      return reply.send({ accepted: true, status: result.status, parts: result.parts });
    }),
  );

  app.put<{ Params: { importId: string; partId: string } }>(
    "/integrations/odoo/infra-package-imports/:importId/parts/:partId",
    async (request, reply) => replyInfra(reply, async () => {
      const proof = signedMetadata(request, keys);
      const expected = await staging.expectedPart(request.params.importId, request.params.partId);
      if (proof.bytes !== expected.bytes || proof.sha256 !== expected.sha256) throw new InfraPackageStagingError("Signierter Paketteilbeleg stimmt nicht mit dem serverseitigen Inventar überein.", "invalid_upload_auth");
      const result = await staging.uploadPart(request.params.importId, request.params.partId, proof, rawBody(request));
      return reply.send({ accepted: true, ...result });
    }),
  );

  app.post<{ Params: { importId: string } }>(
    "/integrations/odoo/infra-package-imports/:importId/finalize",
    async (request, reply) => replyInfra(reply, async () => {
      verifyControlBody(request, keys, Buffer.alloc(0));
      const result = await staging.finalize(request.params.importId);
      return reply.send({
        accepted: true,
        packageId: result.packageId,
        packageVersion: result.version,
        manifestSha256: result.manifestSha256,
        deliveryReleaseId: result.deliveryReleaseId,
        signatureStatus: result.signatureStatus,
        activationEligible: result.activationEligible,
      });
    }),
  );
}

export const INFRA_EMPTY_BODY_SHA256 = EMPTY_SHA256;
