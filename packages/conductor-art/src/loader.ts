import { createPublicKey, verify } from "node:crypto";
import { ART_DIRECTIONS } from "./catalog.js";
import { ArtAtlasError, invariant } from "./errors.js";
import { parseArtAtlasManifest, parseArtAtlasSignature, parseArtAtlasWorldPin } from "./parse.js";
import type { ArtAtlasAssetV1, ArtAtlasManifestV1, ArtAtlasResources, ArtDirection } from "./types.js";
import { artSha256, inspectArtAtlas } from "./validate.js";

export interface LoadArtAtlasInput {
  worldId: string;
  expectedPin: unknown;
  manifestBytes: Uint8Array;
  signature: unknown;
  trustedKeys: ReadonlyMap<string, string>;
  resources: ArtAtlasResources;
}

/** Zugriff entsteht ausschließlich durch die vollständige Freigabeprüfung. */
export interface LoadedArtAtlas {
  asset(worldId: string, assetId: string): ArtAtlasAssetV1;
  file(worldId: string, fileId: string): Uint8Array;
  passengerFrame(worldId: string, variant: number, direction: ArtDirection, state: "idle" | "walk" | "sitting", elapsedMs: number): ArtAtlasAssetV1;
}

class VerifiedArtAtlas implements LoadedArtAtlas {
  readonly #files: Map<string, Uint8Array>;
  readonly #manifest: ArtAtlasManifestV1;
  readonly #worldId: string;
  constructor(worldId: string, manifest: ArtAtlasManifestV1, resources: ArtAtlasResources) {
    this.#worldId = worldId;
    this.#manifest = structuredClone(manifest);
    this.#files = new Map(manifest.files.map((file) => [file.id, Uint8Array.from(resources.files.get(file.path)!)]));
    Object.freeze(this);
  }

  #assertWorld(worldId: string): void { invariant(worldId === this.#worldId, "atlas_world_mismatch"); }

  asset(worldId: string, assetId: string): ArtAtlasAssetV1 {
    this.#assertWorld(worldId);
    const asset = this.#manifest.assets.find((asset) => asset.id === assetId);
    invariant(asset, "atlas_asset_missing");
    return structuredClone(asset);
  }

  file(worldId: string, fileId: string): Uint8Array {
    this.#assertWorld(worldId);
    const bytes = this.#files.get(fileId);
    invariant(bytes, "atlas_file_missing");
    return bytes.slice();
  }

  passengerFrame(worldId: string, variant: number, direction: ArtDirection, state: "idle" | "walk" | "sitting", elapsedMs: number): ArtAtlasAssetV1 {
    this.#assertWorld(worldId);
    invariant(Number.isSafeInteger(variant) && variant >= 0 && variant <= 255 && Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 && ART_DIRECTIONS.includes(direction), "atlas_animation_input_invalid");
    const appearance = this.#manifest.appearanceVariants.find((entry) => entry.variant === variant)?.appearanceId;
    const animation = this.#manifest.animations.find((entry) => entry.appearanceId === appearance && entry.direction === direction && entry.state === state);
    invariant(animation, "atlas_animation_missing");
    let offset = elapsedMs % animation.frames.reduce((duration, frame) => duration + frame.durationMs, 0);
    for (const frame of animation.frames) {
      if (offset < frame.durationMs) return this.asset(worldId, frame.assetId);
      offset -= frame.durationMs;
    }
    throw new ArtAtlasError("atlas_animation_missing");
  }
}

/** Herkunftsprüfung nach der vorhandenen Alpha-Releasekonvention; kein lokaler Ersatzatlas. */
export function loadArtAtlasForWorld(input: LoadArtAtlasInput): LoadedArtAtlas {
  const suppliedBytes = input.manifestBytes;
  invariant(suppliedBytes instanceof Uint8Array && suppliedBytes.byteLength > 0 && suppliedBytes.byteLength <= 32 * 1024 * 1024, "manifest_size_invalid");
  const manifestBytes = Uint8Array.from(suppliedBytes);
  const pin = parseArtAtlasWorldPin(input.expectedPin), signature = parseArtAtlasSignature(input.signature);
  invariant(pin.worldId === input.worldId, "atlas_world_mismatch");
  const digest = artSha256(manifestBytes);
  invariant(digest === pin.manifestSha256 && signature.signedHash === digest, "atlas_manifest_pin_mismatch");
  const trustedKey = input.trustedKeys.get(signature.keyId);
  invariant(trustedKey !== undefined, "atlas_signing_key_untrusted");
  const signatureBytes = Buffer.from(signature.valueBase64, "base64");
  invariant(signatureBytes.length === 64 && signatureBytes.toString("base64") === signature.valueBase64, "signature_encoding_invalid");
  let valid = false;
  try {
    const key = createPublicKey(trustedKey);
    valid = key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(digest, "utf8"), key, signatureBytes);
  } catch { throw new ArtAtlasError("atlas_signature_invalid"); }
  invariant(valid, "atlas_signature_invalid");
  const manifest = parseArtAtlasManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown);
  const snapshot = (rows: { path: string }[], source: ReadonlyMap<string, Uint8Array>, perFileLimit: number, totalLimit: number): Map<string, Uint8Array> => {
    const result = new Map<string, Uint8Array>();
    let total = 0;
    for (const row of rows) {
      if (result.has(row.path)) continue;
      const content = source.get(row.path);
      if (content === undefined) continue;
      invariant(content instanceof Uint8Array && content.byteLength <= perFileLimit, "atlas_resource_size_invalid");
      total += content.byteLength;
      invariant(total <= totalLimit, "atlas_resource_size_invalid");
      result.set(row.path, Uint8Array.from(content));
    }
    return result;
  };
  // Jeder fremde Getter wird nur einmal gelesen. Prüfung und Nutzung erhalten
  // denselben privaten Snapshot, auch bei veränderlichen Buffer-/Map-Eingängen.
  const resources = {
    files: snapshot(manifest.files, input.resources.files, 64 * 1024 * 1024, 128 * 1024 * 1024),
    evidence: snapshot(manifest.evidence, input.resources.evidence, 16 * 1024 * 1024, 64 * 1024 * 1024),
  };
  const report = inspectArtAtlas(manifestBytes, resources);
  invariant(report.activationEligible, "atlas_activation_blocked");
  invariant(report.releaseId === pin.releaseId, "atlas_release_mismatch");
  return new VerifiedArtAtlas(pin.worldId, manifest, resources);
}
