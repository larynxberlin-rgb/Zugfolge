import { generateKeyPairSync, sign } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadArtAtlasFromDirectory } from "./index.js";
import type { LoadArtAtlasDirectoryInput } from "./directory.js";
import { parseArtAtlasManifest } from "./parse.js";
import { artSha256 } from "./validate.js";

const source = fileURLToPath(new URL("../../../assets/conductor-art/v1/", import.meta.url));
const manifestBytes = await readFile(resolve(source, "manifest.json"));
const manifest = parseArtAtlasManifest(JSON.parse(manifestBytes.toString("utf8")));
const manifestHash = artSha256(manifestBytes);
// Ausschließlich ein temporärer Testschlüssel und eine unabhängige Testwelt.
// Der Pin entsteht aus dem unveränderten Quellenkorpus, nie aus dem zu prüfenden Verzeichnis.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trust = {
  worldId: "directory-loader-test-world",
  expectedPin: { schemaVersion: "art-atlas-world-pin/v1", worldId: "directory-loader-test-world", releaseId: manifest.releaseId, manifestSha256: manifestHash },
  signature: { algorithm: "ed25519", keyId: "temporary-test-key", signedHash: manifestHash, valueBase64: sign(null, Buffer.from(manifestHash, "utf8"), privateKey).toString("base64") },
  trustedKeys: new Map([["temporary-test-key", publicKey.export({ format: "pem", type: "spki" }).toString()]]),
};
let temporary: string;
let sequence = 0;

beforeAll(async () => { temporary = await mkdtemp(resolve(tmpdir(), "zugfolge-art-directory-test-")); });
afterAll(async () => {
  const inside = relative(resolve(tmpdir()), temporary);
  if (inside.startsWith("zugfolge-art-directory-test-") && !inside.includes(sep)) await rm(temporary, { recursive: true, force: true });
});

async function fixture(): Promise<LoadArtAtlasDirectoryInput> {
  const directory = resolve(temporary, String(sequence++));
  for (const path of new Set(["manifest.json", ...manifest.files.map((file) => file.path), ...manifest.evidence.map((item) => item.path)])) {
    const target = resolve(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(source, path), target);
  }
  return { directory, ...trust };
}

describe("Produktiver Verzeichnisloader mit echten freigegebenen Korpusbytes", () => {
  it("prüft den vollständigen Korpus und liefert ausschließlich weltgebundene private Bytes", async () => {
    const input = await fixture();
    const atlas = await loadArtAtlasFromDirectory(input);
    const expected = manifest.assets.find((asset) => asset.id === "vehicle.regional-double.upper")!;
    expect(atlas.asset(trust.worldId, expected.id)).toEqual(expected);
    const file = manifest.files.find((file) => file.id === expected.fileId)!;
    const bytes = atlas.file(trust.worldId, file.id);
    expect(artSha256(bytes)).toBe(file.sha256);
    bytes.fill(0);
    expect(artSha256(atlas.file(trust.worldId, file.id))).toBe(file.sha256);
    expect(() => atlas.asset("another-world", expected.id)).toThrow("atlas_world_mismatch");
  });

  it.each(["png", "evidence", "manifest"])("lehnt veränderte %s-Bytes ab", async (kind) => {
    const input = await fixture();
    const path = kind === "png" ? manifest.files[0]!.path : kind === "evidence" ? manifest.evidence[0]!.path : "manifest.json";
    const target = resolve(input.directory, path), bytes = await readFile(target);
    await writeFile(target, Buffer.concat([bytes, Buffer.from(" ")]));
    await expect(loadArtAtlasFromDirectory(input)).rejects.toThrow(kind === "manifest" ? "atlas_manifest_pin_mismatch" : "atlas_activation_blocked");
  });

  it("lehnt fehlende Ressourcen ohne Dateipfad oder Dateiinhalte in der Fehlermeldung ab", async () => {
    const input = await fixture();
    await rm(resolve(input.directory, manifest.files[0]!.path));
    await expect(loadArtAtlasFromDirectory(input)).rejects.toMatchObject({ name: "ArtAtlasError", message: "Grafikatlas abgelehnt: atlas_directory_resource_missing" });
  });

  it("lehnt übergroße Ressourcen vor dem Einlesen ab", async () => {
    const input = await fixture();
    await truncate(resolve(input.directory, manifest.files[0]!.path), 64 * 1024 * 1024 + 1);
    await expect(loadArtAtlasFromDirectory(input)).rejects.toThrow("atlas_resource_size_invalid");
  });

  it.each(["../outside.png", "https://example.invalid/atlas.png", "atlases/../outside.png"])("lehnt den fremden Ressourcenpfad %s ab", async (path) => {
    const input = await fixture(), altered = structuredClone(manifest);
    altered.files[0]!.path = path;
    await writeFile(resolve(input.directory, "manifest.json"), JSON.stringify(altered));
    await expect(loadArtAtlasFromDirectory(input)).rejects.toThrow("schema_path_invalid");
  });

  it("lehnt symbolische Ressourcenverzeichnisse und verlinkte Releasewurzeln ab", async () => {
    const input = await fixture();
    const original = resolve(input.directory, "atlases"), moved = resolve(temporary, "linked-atlases");
    await rename(original, moved);
    await symlink(moved, original, process.platform === "win32" ? "junction" : "dir");
    await expect(loadArtAtlasFromDirectory(input)).rejects.toThrow("atlas_directory_path_invalid");
    const linkedRoot = resolve(temporary, "linked-release");
    await symlink(input.directory, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(loadArtAtlasFromDirectory({ ...input, directory: linkedRoot })).rejects.toThrow("atlas_directory_path_invalid");
  });

  it("lehnt Verzeichnisse als PNG sowie fremde Weltpins ab", async () => {
    const input = await fixture(), target = resolve(input.directory, manifest.files[0]!.path);
    await rm(target); await mkdir(target);
    await expect(loadArtAtlasFromDirectory(input)).rejects.toThrow("atlas_directory_file_invalid");
    await expect(loadArtAtlasFromDirectory({ ...input, worldId: "another-world" })).rejects.toThrow("atlas_world_mismatch");
  });

  it("übernimmt kein beigelegtes Vertrauen oder Signaturfeld statt ausdrücklicher Servereingaben", async () => {
    const input = await fixture();
    await writeFile(resolve(input.directory, "trusted-keys.json"), JSON.stringify(Object.fromEntries(trust.trustedKeys)));
    await writeFile(resolve(input.directory, "signature.json"), JSON.stringify(trust.signature));
    await expect(loadArtAtlasFromDirectory({ ...input, trustedKeys: new Map() })).rejects.toThrow("atlas_signing_key_untrusted");
    await expect(loadArtAtlasFromDirectory({ ...input, signature: null })).rejects.toThrow("schema_object_invalid");
  });
});
