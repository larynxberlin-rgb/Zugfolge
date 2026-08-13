import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InfraPackageStaging,
  InfraPackageStagingError,
  infraUploadSignature,
  verifyInfraUploadSignature,
  type InfraPackageVerifier,
} from "./infra-package-staging.js";

const HASH_A = "a".repeat(64);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonical(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(sorted(value), null, 2)}\n`, "utf8");
}

function compact(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

interface FixturePart {
  readonly id: string;
  readonly path: string;
  readonly bytes: Buffer;
}

function packageFixture(
  rawDataPolicyField: "nonPublicSourceRawDataShipped" | "internalStationPlanRawDataShipped" = "nonPublicSourceRawDataShipped",
): { readonly manifest: Buffer; readonly parts: readonly FixturePart[] } {
  const quality = compact({
    schema: "zugfolge-final-infrastructure-quality-report/v1",
    releaseId: "infra-deutschland-2026.1",
    policy: {
      classAFromSingleSourceOrAutomatedInference: false,
      [rawDataPolicyField]: false,
      classC: "visible but not orderable",
    },
    summary: { visibleLayers: 10, visibleFeatures: 20 },
  });
  const sources = compact({
    schema: "zugfolge-map-delivery-sources/v1",
    releaseId: "infra-deutschland-2026.1",
    sources: [{
      id: "basemap-protomaps",
      approved: true,
      license: "ODbL-1.0",
      attribution: "© OpenStreetMap-Mitwirkende; Basemap-Aufbereitung Protomaps",
    }],
  });
  const baseFiles = [
    { id: "basemap", kind: "basemap", installPath: "basemap.pmtiles", bytes: Buffer.from("basemap") },
    { id: "glyph", kind: "glyph", installPath: "assets/fonts/font.pbf", bytes: Buffer.from("glyph") },
    { id: "infrastructure", kind: "infrastructure", installPath: "infra.pmtiles", bytes: Buffer.from("infra") },
    { id: "quality", kind: "quality-manifest", installPath: "manifests/quality.json", bytes: quality },
    { id: "read-model", kind: "read-model", installPath: "read-model.sqlite", bytes: Buffer.from("read-model") },
    { id: "sprite", kind: "sprite", installPath: "assets/sprites/dark.png", bytes: Buffer.from("sprite") },
    { id: "style", kind: "style", installPath: "style.json", bytes: Buffer.from("{}") },
    { id: "train-projection", kind: "train-map-projection", installPath: "train-map-projection.sqlite", bytes: Buffer.from("train-projection") },
  ];
  const release = compact({
    schema: "zugfolge-map-delivery-release/v1",
    releaseId: "infra-deutschland-2026.1",
    packageId: "zugfolge-map-deutschland",
    packageVersion: "2026.1",
    artifacts: baseFiles.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.length, sha256: sha256(bytes) })).sort((left, right) => left.id.localeCompare(right.id, "en")),
    bindings: {
      packageManifestSchema: "zugfolge-map-package/v1",
      sourcesSha256: sha256(sources),
      qualitySha256: sha256(quality),
    },
    approvalGates: {
      rights: { status: "passed" },
      quality: { status: "passed" },
      signature: { status: "missing" },
    },
    signature: null,
  });
  const allFiles = [
    ...baseFiles,
    { id: "release", kind: "release-manifest", installPath: "manifests/release.json", bytes: release },
    { id: "sources", kind: "source-manifest", installPath: "manifests/sources.json", bytes: sources },
  ];
  const descriptors = allFiles.map(({ id, kind, installPath, bytes }) => ({
    id,
    kind,
    installPath,
    bytes: bytes.length,
    sha256: sha256(bytes),
    parts: [{ path: `parts/${id}.part-00001`, bytes: bytes.length, sha256: sha256(bytes) }],
  }));
  const manifest = canonical({
    schema: "zugfolge-map-package/v1",
    packageId: "zugfolge-map-deutschland",
    version: "2026.1",
    format: "directory-parts",
    partBytes: 100 * 1024 * 1024,
    artifacts: descriptors.filter(({ kind }) => ["basemap", "infrastructure"].includes(kind)),
    auxiliaryFiles: descriptors.filter(({ kind }) => !["basemap", "infrastructure"].includes(kind)),
  });
  return { manifest, parts: allFiles.map(({ id, bytes }) => ({ id, path: `parts/${id}.part-00001`, bytes })) };
}

async function* chunks(bytes: Buffer): AsyncIterable<Buffer> {
  const middle = Math.max(1, Math.floor(bytes.length / 2));
  yield bytes.subarray(0, middle);
  if (middle < bytes.length) yield bytes.subarray(middle);
}

const roots: string[] = [];

async function staging(verifier?: InfraPackageVerifier): Promise<InfraPackageStaging> {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-"));
  roots.push(root);
  return new InfraPackageStaging(root, {
    packageVerifier: verifier ?? (async (packageRoot) => {
      const manifest = await readFile(join(packageRoot, "manifest.json"));
      const value = JSON.parse(manifest.toString("utf8")) as { packageId: string; version: string };
      return { packageId: value.packageId, version: value.version, manifestSha256: sha256(manifest) };
    }),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("InfraPackageStaging", () => {
  it("behandelt parallele Begin-, Manifest-, Part- und Finalize-Wiederholungen idempotent", async () => {
    const fixture = packageFixture();
    const service = await staging();
    const importId = "annual-2026-parallel";
    const manifestProof = { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) };
    const began = await Promise.all([
      service.begin(importId, manifestProof),
      service.begin(importId, manifestProof),
    ]);
    expect(began.map(({ status }) => status).sort()).toEqual(["created", "reused"]);
    const manifests = await Promise.all([
      service.uploadManifest(importId, manifestProof, chunks(fixture.manifest)),
      service.uploadManifest(importId, manifestProof, chunks(fixture.manifest)),
    ]);
    expect(manifests[0].parts).toEqual(manifests[1].parts);
    for (const part of fixture.parts) {
      const accepted = manifests[0].parts.find(({ packagePath }) => packagePath === part.path)!;
      const proof = { bytes: part.bytes.length, sha256: sha256(part.bytes) };
      const uploaded = await Promise.all([
        service.uploadPart(importId, accepted.partId, proof, chunks(part.bytes)),
        service.uploadPart(importId, accepted.partId, proof, chunks(part.bytes)),
      ]);
      expect(uploaded.map(({ status }) => status).sort()).toEqual(["reused", "stored"]);
    }
    const [first, second] = await Promise.all([service.finalize(importId), service.finalize(importId)]);
    expect(second).toEqual(first);
  }, 30_000);

  it("überträgt Teile idempotent, qualifiziert fail-closed und staged atomar", async () => {
    const fixture = packageFixture();
    const service = await staging();
    const importId = "annual-2026-test";
    await expect(service.begin(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) })).resolves.toEqual({ status: "created" });
    const accepted = await service.uploadManifest(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) }, chunks(fixture.manifest));
    expect(accepted.parts).toHaveLength(fixture.parts.length);
    for (const part of fixture.parts) {
      const partId = accepted.parts.find(({ packagePath }) => packagePath === part.path)?.partId;
      expect(partId).toBeDefined();
      const proof = { bytes: part.bytes.length, sha256: sha256(part.bytes) };
      await expect(service.uploadPart(importId, partId!, proof, chunks(part.bytes))).resolves.toEqual({ status: "stored" });
      await expect(service.uploadPart(importId, partId!, proof, chunks(part.bytes))).resolves.toEqual({ status: "reused" });
    }
    const first = await service.finalize(importId);
    expect(first).toMatchObject({ deliveryReleaseId: "infra-deutschland-2026.1", signatureStatus: "missing", activationEligible: false });
    await expect(service.begin(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) })).resolves.toEqual({ status: "reused" });
    await expect(service.begin(importId, { bytes: fixture.manifest.length, sha256: HASH_A })).rejects.toThrow("Abgeschlossene Import-ID gehört zu einem anderen Manifest");
    await expect(service.uploadManifest(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) }, chunks(fixture.manifest)))
      .rejects.toThrow("bereits endgültig abgeschlossen");
    const latePart = accepted.parts[0]!;
    const lateBytes = fixture.parts.find(({ path }) => path === latePart.packagePath)!.bytes;
    await expect(service.uploadPart(importId, latePart.partId, { bytes: lateBytes.length, sha256: sha256(lateBytes) }, chunks(lateBytes)))
      .rejects.toThrow("bereits endgültig abgeschlossen");
    const replays = await Promise.all([service.finalize(importId), service.finalize(importId), service.finalize(importId)]);
    expect(replays).toEqual([first, first, first]);
    const root = roots.at(-1)!;
    await expect(readFile(join(root, ".receiving", importId, "session.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const receipt = JSON.parse(await readFile(join(root, ".receipts", `${importId}.json`), "utf8")) as { uploadStatus: string };
    expect(receipt.uploadStatus).toBe("closed");
  }, 15_000);

  it.each([".receiving", ".receipts", "staged"])("lehnt ein verlinktes Staging-Unterverzeichnis %s ab", async (directory) => {
    const fixture = packageFixture();
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-symlink-root-"));
    const target = await mkdtemp(join(tmpdir(), "zugfolge-game-symlink-target-"));
    roots.push(root, target);
    await symlink(target, join(root, directory), process.platform === "win32" ? "junction" : "dir");
    const service = new InfraPackageStaging(root, {
      packageVerifier: async () => ({ packageId: "unused", version: "unused", manifestSha256: HASH_A }),
    });
    await expect(service.begin("annual-2026-symlink", { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) }))
      .rejects.toThrow("muss ein regulaeres Verzeichnis sein");
  });

  it("verschiebt kein Paket, wenn der vollständige Game-Prüfer scheitert", async () => {
    const fixture = packageFixture();
    const verifier = vi.fn(async () => { throw new Error("PMTiles-Prüfung fehlgeschlagen"); });
    const service = await staging(verifier);
    const importId = "annual-2026-rejected";
    await service.begin(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) });
    const accepted = await service.uploadManifest(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) }, chunks(fixture.manifest));
    for (const part of fixture.parts) {
      const partId = accepted.parts.find(({ packagePath }) => packagePath === part.path)!.partId;
      await service.uploadPart(importId, partId, { bytes: part.bytes.length, sha256: sha256(part.bytes) }, chunks(part.bytes));
    }
    await expect(service.finalize(importId)).rejects.toThrow("PMTiles-Prüfung fehlgeschlagen");
    expect(verifier).toHaveBeenCalledOnce();
  });

  it("verwirft beschädigte Paketteile vor der Ablage", async () => {
    const fixture = packageFixture();
    const service = await staging();
    await service.begin("annual-2026-corrupt", { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) });
    const accepted = await service.uploadManifest("annual-2026-corrupt", { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) }, chunks(fixture.manifest));
    await expect(service.uploadPart("annual-2026-corrupt", accepted.parts[0]!.partId, { bytes: accepted.parts[0]!.bytes, sha256: accepted.parts[0]!.sha256 }, chunks(Buffer.from("falsch"))))
      .rejects.toBeInstanceOf(InfraPackageStagingError);
  });

  it("lehnt die abgelöste Rohdaten-Policybezeichnung ausdrücklich ab", async () => {
    const fixture = packageFixture("internalStationPlanRawDataShipped");
    const service = await staging();
    const importId = "annual-2026-legacy-policy";
    const manifestProof = { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) };
    await service.begin(importId, manifestProof);
    const accepted = await service.uploadManifest(importId, manifestProof, chunks(fixture.manifest));
    for (const part of fixture.parts) {
      const partId = accepted.parts.find(({ packagePath }) => packagePath === part.path)!.partId;
      await service.uploadPart(importId, partId, { bytes: part.bytes.length, sha256: sha256(part.bytes) }, chunks(part.bytes));
    }
    await expect(service.finalize(importId)).rejects.toThrow("Qualitätspolicy verletzt das öffentliche Sicherheitsmodell");
  });
});

describe("Infra-Upload-HMAC", () => {
  it("bindet Methode, Pfad, Bytezahl und SHA-256 und lehnt Wiederholungen außerhalb des Zeitfensters ab", () => {
    const key = { id: "odoo-infra-1", secret: "test-secret-with-enough-entropy" };
    const timestamp = "2026-08-12T12:00:00.000Z";
    const signature = infraUploadSignature({ key, timestamp, method: "PUT", pathname: "/upload/part", contentBytes: 7, contentSha256: HASH_A });
    expect(() => verifyInfraUploadSignature({ keyId: key.id, timestamp, signature, method: "PUT", pathname: "/upload/part", contentBytes: 7, contentSha256: HASH_A, keys: [key], now: new Date(timestamp) })).not.toThrow();
    expect(() => verifyInfraUploadSignature({ keyId: key.id, timestamp, signature, method: "PUT", pathname: "/upload/part", contentBytes: 7, contentSha256: HASH_A, keys: [key], now: new Date("2026-08-12T12:06:00.000Z") })).toThrow(/abgelaufen/);
  });
});
