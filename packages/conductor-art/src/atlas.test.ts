import { generateKeyPairSync, sign } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ART_BRAND_COLORS, ART_DIRECTIONS, CONDUCTOR_APPEARANCE, PASSENGER_APPEARANCES, REQUIRED_STATIC_ASSETS } from "./catalog.js";
import { loadArtAtlasForWorld } from "./loader.js";
import { parseArtAtlasManifest } from "./parse.js";
import { decodeArtPng } from "./png.js";
import type { ArtAtlasAssetV1, ArtAtlasManifestV1, ArtAtlasResources, ArtReviewV1 } from "./types.js";
import { artSha256, inspectArtAtlas, validateArtRgba } from "./validate.js";

function crc(input: Uint8Array): number { let result = 0xffffffff; for (const byte of input) { result ^= byte; for (let i = 0; i < 8; i++) result = result & 1 ? (result >>> 1) ^ 0xedb88320 : result >>> 1; } return (result ^ 0xffffffff) >>> 0; }

/** Ausschließlich technische Testpixel, keine Grafikassets oder Abnahmebelege. */
function png(width: number, height: number, rgba: Uint8Array, filter = 0): Buffer {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const header = Buffer.alloc(8); header.writeUInt32BE(data.byteLength); header.write(type, 4);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([header, data, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines[y * (width * 4 + 1)] = filter;
    for (let x = 0; x < width * 4; x++) {
      const at = y * width * 4 + x;
      const left = x >= 4 ? rgba[at - 4]! : 0, up = y > 0 ? rgba[at - width * 4]! : 0, diagonal = y > 0 && x >= 4 ? rgba[at - width * 4 - 4]! : 0;
      const predicted = left + up - diagonal;
      const distances = [Math.abs(predicted - left), Math.abs(predicted - up), Math.abs(predicted - diagonal)];
      const paeth = distances[0]! <= distances[1]! && distances[0]! <= distances[2]! ? left : distances[1]! <= distances[2]! ? up : diagonal;
      const value = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth;
      scanlines[y * (width * 4 + 1) + x + 1] = (rgba[at]! - value) & 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
}

function fixture(): { manifest: ArtAtlasManifestV1; resources: ArtAtlasResources } {
  const evidence = Buffer.from('{"syntheticUnitFixture":true,"notAnArtRelease":true}');
  const approved: ArtReviewV1 = { status: "approved", reviewerId: "synthetic-test-reviewer", evidenceId: "synthetic-evidence" };
  const assets: ArtAtlasAssetV1[] = [];
  const manifest: ArtAtlasManifestV1 = {
    schemaVersion: "art-atlas-manifest/v1", releaseId: "synthetic-unit-fixture", status: "approved", catalogVersion: "conductor-art-catalog/v1", pixelsPerMetre: 32,
    rendering: { projection: "orthogonal_top_down", zoomSteps: [1, 2, 3, 4], sampling: "nearest_neighbor" }, palette: { id: "synthetic-test-palette", colors: [...ART_BRAND_COLORS, "#00000000"] },
    files: [], references: [], evidence: [{ id: "synthetic-evidence", path: "test-evidence.json", sha256: artSha256(evidence), mediaType: "application/json" }],
    assets, animations: [], appearanceVariants: Array.from({ length: 256 }, (_, variant) => ({ variant, appearanceId: PASSENGER_APPEARANCES[variant % 4]! })), accessoryBindings: [], releaseReview: approved,
  };
  const add = (id: string, category: ArtAtlasAssetV1["category"]): void => {
    const index = assets.length;
    assets.push({ id, category, fileId: "synthetic-atlas", rect: { x: index % 16 * 64, y: Math.floor(index / 16) * 64, width: 64, height: 64 }, worldWidthMm: 2000, worldHeightMm: 2000, pivot: { x: 32, y: 32 },
      generation: { prompt: "Synthetische Validator-Testpixel; kein ausgelieferter Bildkorpus.", referenceIds: [], model: { provider: "synthetic-test", name: "test-fixture", revision: "1", verification: "provider_declared", evidenceId: "synthetic-evidence" }, evidenceId: "synthetic-evidence" },
      review: { visual: approved, logoAndText: approved, contrast: approved, provenance: approved } });
  };
  for (const id of REQUIRED_STATIC_ASSETS) add(id, id.split(".")[0] as ArtAtlasAssetV1["category"]);
  for (const appearanceId of [...PASSENGER_APPEARANCES, CONDUCTOR_APPEARANCE]) for (const direction of ART_DIRECTIONS) for (const state of ["idle", "walk", "sitting"] as const) {
    const frames = Array.from({ length: state === "walk" ? 4 : 1 }, (_, index) => {
      const assetId = `actor.${appearanceId}.${direction}.${state}.${index}`; add(assetId, "actor"); return { assetId, durationMs: 120 };
    });
    manifest.animations.push({ id: `${appearanceId}.${direction}.${state}`, appearanceId, direction, state, role: appearanceId === CONDUCTOR_APPEARANCE ? "conductor" : "passenger", frames });
  }
  for (const spaceNeeds of ["wheelchair", "bicycle", "stroller"] as const) for (const direction of ART_DIRECTIONS) manifest.accessoryBindings.push({ spaceNeeds, direction, assetId: `accessory.${spaceNeeds}.${direction}`, appearanceIds: [...PASSENGER_APPEARANCES] });
  const width = 1024, height = Math.ceil(assets.length / 16) * 64;
  const rgba = new Uint8Array(width * height * 4);
  assets.forEach((asset, index) => {
    const color = ART_BRAND_COLORS[index % ART_BRAND_COLORS.length]!;
    const values = [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16), 255];
    for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) rgba.set(values, ((asset.rect.y + y) * width + asset.rect.x + x) * 4);
    rgba.set(values, ((asset.rect.y + 10) * width + asset.rect.x + index % 16) * 4);
  });
  const file = png(width, height, rgba);
  manifest.files.push({ id: "synthetic-atlas", path: "test-atlas.png", sha256: artSha256(file), widthPx: width, heightPx: height, sourceScale: 1 });
  return { manifest, resources: { files: new Map([["test-atlas.png", file]]), evidence: new Map([["test-evidence.json", evidence]]) } };
}

const bytes = (manifest: ArtAtlasManifestV1): Uint8Array => Buffer.from(JSON.stringify(manifest));
const codes = (manifest: ArtAtlasManifestV1, resources: ArtAtlasResources): string[] => inspectArtAtlas(bytes(manifest), resources).issues.map((issue) => issue.code);

describe("Atlas-PNG-Prüfung ohne Bildveränderung", () => {
  it("dekodiert alle fünf Filter exakt und lehnt beschädigte oder übergroße PNGs ab", () => {
    const rgba = Uint8Array.from({ length: 8 * 4 * 4 }, (_, index) => index * 37 % 256);
    for (let filter = 0; filter <= 4; filter++) {
      const input = png(8, 4, rgba, filter), before = Buffer.from(input);
      expect(decodeArtPng(input)).toEqual({ width: 8, height: 4, rgba });
      expect(input).toEqual(before);
      const corrupt = Buffer.from(input); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
      expect(() => decodeArtPng(corrupt)).toThrow("png_crc_mismatch");
      expect(() => decodeArtPng(Buffer.concat([input, Buffer.from([0])]))).toThrow("png_end_invalid");
    }
    expect(() => decodeArtPng(png(8193, 1, new Uint8Array(8193 * 4)))).toThrow("png_dimensions_invalid");
    for (const [offset, value] of [[12, 0xc9], [14, 0x64]]) {
      const invalidType = png(1, 1, new Uint8Array(4));
      invalidType[offset!] = value!;
      invalidType.writeUInt32BE(crc(invalidType.subarray(12, 29)), 29);
      expect(() => decodeArtPng(invalidType)).toThrow("png_chunk_type_invalid");
    }
  });

  it("erzwingt RGBA-Palette, binäre Transparenz und verlustfreie ganzzahlige Quellskalierung", () => {
    const image = { width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4) };
    for (let offset = 0; offset < image.rgba.length; offset += 4) image.rgba.set([16, 20, 25, 255], offset);
    const file = { id: "file", path: "file.png", sha256: "a".repeat(64), widthPx: 4, heightPx: 4, sourceScale: 2 as const };
    expect(validateArtRgba(image, file, ART_BRAND_COLORS)).toEqual([]);
    image.rgba[0] = 17; image.rgba[3] = 127;
    expect(validateArtRgba(image, file, ART_BRAND_COLORS)).toEqual(["image_alpha_not_binary", "image_palette_mismatch", "image_raster_mismatch"]);
    expect(validateArtRgba(image, { ...file, widthPx: 3 }, ART_BRAND_COLORS)).toEqual(["image_dimensions_mismatch"]);
  });
});

describe("Vollständiger versionierter Grafikvertrag", () => {
  it("prüft alle 172 technischen Testausschnitte und erzeugt deterministische Berichte", () => {
    const { manifest, resources } = fixture();
    const first = inspectArtAtlas(bytes(manifest), resources);
    expect(first.issues).toEqual([]); expect(first.activationEligible).toBe(true);
    expect(first.statistics.assets).toBe(172); expect(first.statistics.animations).toBe(60);
    expect(inspectArtAtlas(bytes(manifest), resources)).toEqual(first);
    manifest.assets.reverse(); manifest.animations.reverse(); manifest.accessoryBindings.reverse(); manifest.appearanceVariants.reverse();
    const reversed = inspectArtAtlas(bytes(manifest), resources);
    expect(reversed.issues).toEqual(first.issues); expect(reversed.statistics).toEqual(first.statistics);
    expect(reversed.manifestSha256).not.toBe(first.manifestSha256);
  });

  it("blockiert unbekannte Felder, Pfadausbruch, Bruchzahlen und unbekannte Modellrevisionen", () => {
    const { manifest, resources } = fixture();
    expect(() => parseArtAtlasManifest({ ...manifest, externalGenerator: true })).toThrow("schema_fields_invalid");
    manifest.files[0]!.path = "../escape.png"; expect(() => parseArtAtlasManifest(manifest)).toThrow("schema_path_invalid");
    manifest.files[0]!.path = "test-atlas.png"; manifest.assets[0]!.rect.x = 0.5; expect(() => parseArtAtlasManifest(manifest)).toThrow("schema_integer_invalid");
    manifest.assets[0]!.rect.x = 0;
    manifest.assets[0]!.generation.model = { provider: "unreported", name: null, revision: null, verification: "provider_undisclosed", evidenceId: null };
    expect(codes(manifest, resources)).toContain("model_version_unverified");
    manifest.assets[0]!.generation.model = { provider: "unreported", name: "unknown", revision: "latest", verification: "provider_declared", evidenceId: "synthetic-evidence" };
    expect(codes(manifest, resources)).toContain("model_version_unverified");
    manifest.status = "candidate"; expect(codes(manifest, resources)).toContain("release_not_approved");
  });

  it("blockiert fehlende Korpusteile, falsche Geometrie, Duplikate und unvollständige Animationen", () => {
    const mutations: [string, (manifest: ArtAtlasManifestV1) => void][] = [
      ["catalog_asset_missing", (manifest) => { manifest.assets.shift(); }],
      ["asset_rect_outside_image", (manifest) => { manifest.assets[0]!.rect.x = 8192; }],
      ["asset_world_scale_mismatch", (manifest) => { manifest.assets[0]!.worldWidthMm += 1; }],
      ["asset_pivot_outside_rect", (manifest) => { manifest.assets[0]!.pivot.x = 64; }],
      ["asset_rect_overlap", (manifest) => { manifest.assets[1]!.rect = { ...manifest.assets[0]!.rect }; }],
      ["duplicate_identifier", (manifest) => { manifest.assets[1]!.id = manifest.assets[0]!.id; }],
      ["animation_missing", (manifest) => { manifest.animations.shift(); }],
      ["animation_frame_count_invalid", (manifest) => { manifest.animations.find((animation) => animation.state === "walk")!.frames.pop(); }],
      ["animation_frames_not_distinct", (manifest) => { const walk = manifest.animations.find((animation) => animation.state === "walk")!; walk.frames[1] = { ...walk.frames[0]! }; }],
      ["appearance_variants_incomplete", (manifest) => { manifest.appearanceVariants.pop(); }],
      ["accessory_binding_incomplete", (manifest) => { manifest.accessoryBindings[0]!.appearanceIds.pop(); }],
      ["brand_palette_incomplete", (manifest) => { manifest.palette.colors.shift(); }],
    ];
    const { manifest: original, resources } = fixture();
    for (const [code, mutation] of mutations) { const manifest = structuredClone(original); mutation(manifest); expect(codes(manifest, resources), code).toContain(code); }
  });

  it("prüft reale Bild- und Belegbytes sowie sämtliche Freigaben statt bloßer Labels", () => {
    const { manifest, resources } = fixture();
    const missing = { ...resources, files: new Map<string, Uint8Array>() };
    expect(codes(manifest, missing)).toContain("image_missing");
    expect(codes(manifest, { ...resources, files: new Map([["test-atlas.png", Buffer.from("fremde Bytes")]]) })).toContain("image_hash_mismatch");
    expect(codes(manifest, { ...resources, evidence: new Map([["test-evidence.json", Buffer.from("anderer Beleg")]]) })).toContain("evidence_hash_mismatch");
    manifest.assets[0]!.review.logoAndText = { status: "pending", reviewerId: null, evidenceId: null };
    expect(codes(manifest, resources)).toContain("review_not_approved");
    manifest.assets[0]!.review.logoAndText = { status: "rejected", reviewerId: "reviewer", evidenceId: "synthetic-evidence" };
    expect(codes(manifest, resources)).toContain("review_rejected");
    manifest.assets[0]!.review.logoAndText = { status: "approved", reviewerId: "reviewer", evidenceId: null };
    expect(codes(manifest, resources)).toContain("review_evidence_invalid");
    manifest.references.push({ id: "foreign-reference", description: "Ungeprüfte Referenz", source: "https://example.invalid/test", sha256: "a".repeat(64), rightsStatus: "unverified", evidenceId: null });
    expect(codes(manifest, resources)).toContain("reference_rights_unverified");
  });
});

describe("Geprüfter Weltpin ohne Laufzeitfallback", () => {
  const key = generateKeyPairSync("ed25519");
  function signed(manifest: ArtAtlasManifestV1, resources: ArtAtlasResources) {
    const manifestBytes = bytes(manifest), digest = artSha256(manifestBytes);
    return { worldId: "world-a", expectedPin: { schemaVersion: "art-atlas-world-pin/v1", worldId: "world-a", releaseId: manifest.releaseId, manifestSha256: digest }, manifestBytes,
      signature: { algorithm: "ed25519", keyId: "test-key", signedHash: digest, valueBase64: sign(null, Buffer.from(digest, "utf8"), key.privateKey).toString("base64") }, trustedKeys: new Map([["test-key", key.publicKey.export({ type: "spki", format: "pem" }).toString()]]), resources };
  }

  it("lädt ausschließlich signierte freigegebene Bytes und hält Replay sowie Welttrennung ein", () => {
    const { manifest, resources } = fixture();
    const input = signed(manifest, resources), loaded = loadArtAtlasForWorld(input);
    const first = loaded.passengerFrame("world-a", 0, "south", "walk", 0);
    expect(loaded.passengerFrame("world-a", 0, "south", "walk", 480)).toEqual(first);
    expect(loaded.passengerFrame("world-a", 0, "south", "walk", 120).id).not.toBe(first.id);
    expect(loadArtAtlasForWorld(input).passengerFrame("world-a", 0, "south", "walk", 0)).toEqual(first);
    expect(() => loaded.asset("world-b", first.id)).toThrow("atlas_world_mismatch");
    expect(Reflect.set(loaded, "worldId", "world-b")).toBe(false);
    expect(Reflect.set(loaded, "assertWorld", () => undefined)).toBe(false);
    expect(() => loaded.asset("world-b", first.id)).toThrow("atlas_world_mismatch");
    expect(loaded.asset("world-a", first.id)).toEqual(first);
    expect(() => loaded.asset("world-a", "missing")).toThrow("atlas_asset_missing");
    expect(() => loaded.passengerFrame("world-a", 256, "north", "idle", 0)).toThrow("atlas_animation_input_invalid");
    const original = loaded.file("world-a", "synthetic-atlas"); original[0] = 0;
    expect(loaded.file("world-a", "synthetic-atlas")[0]).toBe(137);
    resources.files.get("test-atlas.png")![0] = 0;
    expect(loaded.file("world-a", "synthetic-atlas")[0]).toBe(137);
    expect(() => loadArtAtlasForWorld(input)).toThrow("atlas_activation_blocked");
  });

  it("lehnt falsche Welt, Release, Pin, Signatur und unbekannten Signaturschlüssel ab", () => {
    const { manifest, resources } = fixture(), input = signed(manifest, resources);
    expect(() => loadArtAtlasForWorld({ ...input, worldId: "world-b" })).toThrow("atlas_world_mismatch");
    expect(() => loadArtAtlasForWorld({ ...input, expectedPin: { ...input.expectedPin, releaseId: "other" } })).toThrow("atlas_release_mismatch");
    expect(() => loadArtAtlasForWorld({ ...input, expectedPin: { ...input.expectedPin, manifestSha256: "a".repeat(64) } })).toThrow("atlas_manifest_pin_mismatch");
    expect(() => loadArtAtlasForWorld({ ...input, trustedKeys: new Map() })).toThrow("atlas_signing_key_untrusted");
    expect(() => loadArtAtlasForWorld({ ...input, signature: { ...input.signature, valueBase64: Buffer.alloc(64).toString("base64") } })).toThrow("atlas_signature_invalid");
    manifest.status = "candidate";
    expect(() => loadArtAtlasForWorld(signed(manifest, resources))).toThrow("atlas_activation_blocked");
  });

  it("prüft und verwendet denselben Snapshot bei wechselnden Map-Gettern", () => {
    const { manifest, resources } = fixture();
    class ChangingFiles extends Map<string, Uint8Array> {
      reads = 0;
      override get(path: string): Uint8Array | undefined {
        this.reads++;
        return this.reads === 1 ? super.get(path) : Buffer.from("nach der Prüfung ausgetauscht");
      }
    }
    const files = new ChangingFiles(resources.files);
    const input = signed(manifest, { ...resources, files });
    const get = files.get.bind(files);
    files.get = (path: string) => { input.worldId = "world-b"; return get(path); };
    const loaded = loadArtAtlasForWorld(input);
    expect(files.reads).toBe(1);
    expect(artSha256(loaded.file("world-a", "synthetic-atlas"))).toBe(manifest.files[0]!.sha256);
    expect(() => loaded.file("world-b", "synthetic-atlas")).toThrow("atlas_world_mismatch");
  });
});
