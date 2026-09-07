import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { ART_BRAND_COLORS, ART_DIRECTIONS, CONDUCTOR_APPEARANCE, PASSENGER_APPEARANCES, REQUIRED_STATIC_ASSETS, VEHICLE_VARIANT_ASSETS,
  artSha256, loadArtAtlasForWorld } from "../../packages/conductor-art/dist/index.js";
import { artReviewInputSha256, buildArtManifest, readArtResources } from "./manifest.mjs";
import { parseArtReleaseArguments, parseArtTrustedKeys, releaseArtAtlasFromFiles, signArtAtlas } from "./release.mjs";

function crc(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; } return (value ^ 0xffffffff) >>> 0; }
/** Technische Testpixel; diese Fixture ist ausdrücklich kein realer Bild- oder Freigabenachweis. */
function png(width, height, assets) {
  const rgba = Buffer.alloc(width * height * 4);
  assets.forEach((asset, index) => {
    const color = Buffer.from(ART_BRAND_COLORS[index % ART_BRAND_COLORS.length].slice(1), "hex");
    for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) color.copy(rgba, ((asset.rect.y + y) * width + asset.rect.x + x) * 4);
    color.copy(rgba, ((asset.rect.y + 10) * width + asset.rect.x + index % 16) * 4);
  });
  const chunk = (type, bytes) => {
    const head = Buffer.alloc(8), checksum = Buffer.alloc(4); head.writeUInt32BE(bytes.length); head.write(type, 4);
    checksum.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), bytes]))); return Buffer.concat([head, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
}

function fixture(t) {
  const temporaryRoot = resolve(tmpdir()), directory = mkdtempSync(resolve(temporaryRoot, "zugfolge-art-signing-test-"));
  t.after(() => { assert.ok(directory.startsWith(`${temporaryRoot}${sep}zugfolge-art-signing-test-`)); rmSync(directory, { recursive: true, force: true }); });
  const json = (name, value) => writeFileSync(resolve(directory, name), `${JSON.stringify(value)}\n`, "utf8");
  mkdirSync(resolve(directory, "sources")); mkdirSync(resolve(directory, "evidence"));
  const assets = [], animations = [], files = [];
  const add = (id, category) => {
    const index = assets.length;
    assets.push({ id, category, sourceKey: "synthetic-signing-test", fileId: "synthetic-atlas", rect: { x: index % 16 * 64, y: Math.floor(index / 16) * 64, width: 64, height: 64 },
      worldWidthMm: 2000, worldHeightMm: 2000, pivot: { x: 32, y: 32 } });
  };
  for (const id of REQUIRED_STATIC_ASSETS) add(id, id.split(".")[0]);
  for (const appearanceId of [...PASSENGER_APPEARANCES, CONDUCTOR_APPEARANCE]) for (const direction of ART_DIRECTIONS) for (const state of ["idle", "walk", "sitting"]) {
    const frames = Array.from({ length: state === "walk" ? 4 : 1 }, (_, index) => {
      const assetId = `actor.${appearanceId}.${direction}.${state}.${index}`; add(assetId, "actor"); return { assetId, durationMs: 120 };
    });
    animations.push({ id: `${appearanceId}.${direction}.${state}`, appearanceId, direction, state, role: appearanceId === CONDUCTOR_APPEARANCE ? "conductor" : "passenger", frames });
  }
  const writeAtlas = (id, width, height, rows) => {
    const bytes = png(width, height, rows), path = `${id}.png`; writeFileSync(resolve(directory, path), bytes);
    files.push({ id, path, sha256: artSha256(bytes), widthPx: width, heightPx: height, sourceScale: 1 });
  };
  writeAtlas("synthetic-atlas", 1024, Math.ceil(assets.length / 16) * 64, assets);
  const vehicles = VEHICLE_VARIANT_ASSETS.map((id, index) => ({ id, category: "vehicle", sourceKey: "synthetic-signing-test", fileId: "synthetic-vehicles",
    rect: { x: index * 96, y: 0, width: 96, height: 864 }, worldWidthMm: 3000, worldHeightMm: 27000, pivot: { x: 48, y: 432 } }));
  writeAtlas("synthetic-vehicles", 96 * vehicles.length, 864, vehicles); assets.push(...vehicles);
  const source = Buffer.from("Synthetischer Herkunftsbeleg, keine tatsächliche Bildgenerierung oder Freigabe.");
  writeFileSync(resolve(directory, "sources/synthetic-signing-test.png"), source);
  json("evidence/generation-synthetic-signing-test.json", { schemaVersion: "conductor-art-generation-evidence/v1", tool: "image_gen.imagegen", source: "sources/synthetic-signing-test.png",
    sourceSha256: artSha256(source), prompt: "Synthetische Signing-Fixture; keine realen Grafikassets.", metadata: { softwareAgent: { name: "synthetic-test-model", version: "1" } } });
  json("prepared.json", { schemaVersion: "conductor-art-prepared/v1", palette: ["#00000000", ...ART_BRAND_COLORS], files, assets, animations });
  const evidence = Buffer.from('{"syntheticUnitFixture":true,"notAnArtRelease":true}');
  writeFileSync(resolve(directory, "evidence/synthetic-approval.json"), evidence);
  const approved = { status: "approved", reviewerId: "synthetic-test-reviewer", evidenceId: "synthetic-approval" };
  json("review.json", { schemaVersion: "conductor-art-review/v1", releaseId: "conductor-art-2026.1", status: "approved", inputSha256: artReviewInputSha256(directory),
    releaseReview: approved, assets: Object.fromEntries(assets.map((asset) => [asset.id, { visual: approved, logoAndText: approved, contrast: approved, provenance: approved }])),
    evidence: [{ id: "synthetic-approval", path: "evidence/synthetic-approval.json", sha256: artSha256(evidence), mediaType: "application/json" }] });
  const manifest = buildArtManifest(directory); json("manifest.json", manifest);
  const manifestBytes = readFileSync(resolve(directory, "manifest.json"));
  // Schlüssel entstehen ausschließlich in der temporären, beschrifteten Testfixture.
  const key = generateKeyPairSync("ed25519"), keyId = "synthetic-test-key", worldId = "synthetic-test-world";
  const privateKeyPem = key.privateKey.export({ type: "pkcs8", format: "pem" }), publicKeyPem = key.publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(resolve(directory, "synthetic-private.pem"), privateKeyPem, { mode: 0o600 });
  json("synthetic-trusted.json", { [keyId]: publicKeyPem });
  const expectedPin = { schemaVersion: "art-atlas-world-pin/v1", worldId, releaseId: manifest.releaseId, manifestSha256: artSha256(manifestBytes) }; json("synthetic-pin.json", expectedPin);
  const input = { worldId, keyId, privateKeyPem, expectedPin, manifestBytes, trustedKeys: new Map([[keyId, publicKeyPem]]), resources: readArtResources(manifest, directory) };
  const options = { directory, worldId, keyId, privateKeyPath: resolve(directory, "synthetic-private.pem"), trustedKeysPath: resolve(directory, "synthetic-trusted.json"),
    worldPinPath: resolve(directory, "synthetic-pin.json"), outputPath: resolve(directory, "synthetic-signature.json") };
  return { directory, json, manifest, input, options, key };
}

test("Signiert geprüfte v2-Bytes mit bestehendem Weltpin und unabhängigem Schlüsselring ohne Eingangsänderung", (t) => {
  const { input, options, key } = fixture(t);
  const before = [options.privateKeyPath, options.trustedKeysPath, options.worldPinPath, resolve(options.directory, "manifest.json")].map((path) => [path, readFileSync(path)]);
  const summary = releaseArtAtlasFromFiles(options), signature = JSON.parse(readFileSync(options.outputPath, "utf8"));
  assert.deepEqual(summary, { worldId: input.worldId, releaseId: input.expectedPin.releaseId, manifestSha256: artSha256(input.manifestBytes), keyId: input.keyId });
  assert.ok(verify(null, Buffer.from(signature.signedHash, "utf8"), key.publicKey, Buffer.from(signature.valueBase64, "base64")));
  assert.equal(verify(null, Buffer.from(signature.signedHash, "hex"), key.publicKey, Buffer.from(signature.valueBase64, "base64")), false);
  assert.equal(loadArtAtlasForWorld({ ...input, signature }).asset(input.worldId, "vehicle.regional-double.upper").worldHeightMm, 27000);
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes);
  assert.throws(() => releaseArtAtlasFromFiles(options), /nicht überschrieben/);
});

test("Signierung lehnt falschen Pin, fremden Schlüssel, falsche Algorithmen und offene Freigaben ab", (t) => {
  const { input, manifest } = fixture(t);
  assert.throws(() => signArtAtlas({ ...input, worldId: "another-world" }), /andere.*Welt/);
  assert.throws(() => signArtAtlas({ ...input, expectedPin: { ...input.expectedPin, releaseId: "another-release" } }), /Weltpin passt nicht/);
  assert.throws(() => signArtAtlas({ ...input, expectedPin: { ...input.expectedPin, manifestSha256: "a".repeat(64) } }), /Weltpin passt nicht/);
  assert.throws(() => signArtAtlas({ ...input, trustedKeys: new Map() }), /Schlüsselkennung fehlt/);
  const other = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => signArtAtlas({ ...input, privateKeyPem: other }), /passt nicht.*öffentlichen Schlüssel/);
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => signArtAtlas({ ...input, privateKeyPem: ec }), /muss Ed25519/);
  assert.throws(() => parseArtTrustedKeys({ [input.keyId]: input.privateKeyPem }), /öffentliche PEM/);
  assert.throws(() => signArtAtlas({ ...input, privateKeyPem: "synthetic-secret-marker-invalid" }), /ungültig oder nicht entsperrt/);
  manifest.assets[0].review.visual.status = "pending";
  const pendingBytes = Buffer.from(JSON.stringify(manifest));
  assert.throws(() => signArtAtlas({ ...input, manifestBytes: pendingBytes, expectedPin: { ...input.expectedPin, manifestSha256: artSha256(pendingBytes) } }), /review_not_approved/);
  const corrupt = new Map(input.resources.files); corrupt.set("synthetic-atlas.png", Buffer.from("Fremde Testbytes"));
  assert.throws(() => signArtAtlas({ ...input, resources: { ...input.resources, files: corrupt } }), /image_hash_mismatch/);
});

test("Dateisignierung verlangt aktuellen Review-/Builderstand und legt bei Fehler keine Ausgabe an", (t) => {
  const { options, json, directory } = fixture(t);
  const prepared = JSON.parse(readFileSync(resolve(directory, "prepared.json"), "utf8"));
  prepared.assets[0].pivot.x++; json("prepared.json", prepared);
  assert.throws(() => releaseArtAtlasFromFiles(options), /Builder-\/Revieweingänge sind ungültig/);
  assert.equal(existsSync(options.outputPath), false);
});

test("CLI gibt bei kaputten Builder-/Revieweingängen keine JSON-Inhalte aus und schreibt keine Signatur", (t) => {
  const { options, directory } = fixture(t);
  const marker = "PRIVATE_MARKER42";
  writeFileSync(resolve(directory, "prepared.json"), `${marker} invalid JSON`, "utf8");
  const command = fileURLToPath(new URL("./release.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [command, "--directory", options.directory,
    "--private-key", options.privateKeyPath, "--key-id", options.keyId,
    "--trusted-keys", options.trustedKeysPath, "--world-pin", options.worldPinPath,
    "--world-id", options.worldId, "--output", options.outputPath], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Builder-\/Revieweingänge sind ungültig/);
  assert.equal(result.stderr.includes(marker), false);
  assert.equal(result.stdout.includes(marker), false);
  assert.equal(existsSync(options.outputPath), false);
});

test("CLI nennt erforderliche Eingänge, ohne Schlüsselmaterial auszugeben", () => {
  const command = fileURLToPath(new URL("./release.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [command], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  for (const flag of ["--private-key", "--key-id", "--trusted-keys", "--world-pin", "--world-id", "--output"]) assert.ok(result.stderr.includes(flag));
  assert.throws(() => parseArtReleaseArguments(["--key-id", "first", "--key-id", "second"]), /Aufruf/);
  assert.throws(() => parseArtReleaseArguments(["--unknown", "synthetic-secret-marker-invalid"]), (error) => !error.message.includes("synthetic-secret-marker-invalid"));
});
