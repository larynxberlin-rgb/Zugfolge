import { ART_DIRECTIONS } from "./catalog.js";
import { invariant } from "./errors.js";
import type { ArtAtlasManifestV1, ArtAtlasSignatureV1, ArtAtlasWorldPinV1, ArtReviewV1 } from "./types.js";

function object(value: unknown, fields: string[]): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "schema_object_invalid");
  const row = value as Record<string, unknown>;
  invariant(Object.keys(row).length === fields.length && fields.every((field) => Object.hasOwn(row, field)), "schema_fields_invalid");
  return row;
}
function text(value: unknown, max = 128): string {
  invariant(typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), "schema_text_invalid");
  return value;
}
function id(value: unknown): string {
  const result = text(value);
  invariant(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(result), "schema_id_invalid");
  return result;
}
function hash(value: unknown): string {
  const result = text(value);
  invariant(/^[0-9a-f]{64}$/.test(result), "schema_hash_invalid");
  return result;
}
function path(value: unknown): string {
  const result = text(value, 512);
  invariant(!result.startsWith("/") && !result.includes("\\") && !result.includes(":") && result.split("/").every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) && part !== "." && part !== ".."), "schema_path_invalid");
  return result;
}
function integer(value: unknown, min = 0, max = 1_000_000): number {
  invariant(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max, "schema_integer_invalid");
  return value;
}
function oneOf<const T extends string>(value: unknown, choices: readonly T[]): T {
  invariant(typeof value === "string" && (choices as readonly string[]).includes(value), "schema_enum_invalid");
  return value as T;
}
function list<T>(value: unknown, parse: (item: unknown) => T, max: number): T[] {
  invariant(Array.isArray(value) && value.length <= max, "schema_array_invalid");
  return value.map(parse);
}
function nullable<T>(value: unknown, parse: (item: unknown) => T): T | null { return value === null ? null : parse(value); }
function review(value: unknown): ArtReviewV1 {
  const row = object(value, ["status", "reviewerId", "evidenceId"]);
  return { status: oneOf(row["status"], ["pending", "approved", "rejected"]), reviewerId: nullable(row["reviewerId"], id), evidenceId: nullable(row["evidenceId"], id) };
}

/** Ein einziges striktes Transportschema; unbekannte Felder werden nicht still verworfen. */
export function parseArtAtlasManifest(value: unknown): ArtAtlasManifestV1 {
  const row = object(value, ["schemaVersion", "releaseId", "status", "catalogVersion", "pixelsPerMetre", "rendering", "palette", "files", "references", "evidence", "assets", "animations", "appearanceVariants", "accessoryBindings", "releaseReview"]);
  const rendering = object(row["rendering"], ["projection", "zoomSteps", "sampling"]);
  const palette = object(row["palette"], ["id", "colors"]);
  return {
    schemaVersion: oneOf(row["schemaVersion"], ["art-atlas-manifest/v1"]), releaseId: id(row["releaseId"]),
    status: oneOf(row["status"], ["candidate", "approved", "rejected"]), catalogVersion: oneOf(row["catalogVersion"], ["conductor-art-catalog/v1"]),
    pixelsPerMetre: integer(row["pixelsPerMetre"], 32, 32) as 32,
    rendering: { projection: oneOf(rendering["projection"], ["orthogonal_top_down"]), zoomSteps: list(rendering["zoomSteps"], (zoom) => integer(zoom, 1, 8), 8), sampling: oneOf(rendering["sampling"], ["nearest_neighbor"]) },
    palette: { id: id(palette["id"]), colors: list(palette["colors"], (color) => { const value = text(color); invariant(/^#[0-9a-f]{6}(00|ff)$/.test(value), "schema_palette_invalid"); return value; }, 64) },
    files: list(row["files"], (item) => { const file = object(item, ["id", "path", "sha256", "widthPx", "heightPx", "sourceScale"]); return {
      id: id(file["id"]), path: path(file["path"]), sha256: hash(file["sha256"]), widthPx: integer(file["widthPx"], 1, 8192), heightPx: integer(file["heightPx"], 1, 8192), sourceScale: integer(file["sourceScale"], 1, 4) as 1 | 2 | 3 | 4,
    }; }, 64),
    references: list(row["references"], (item) => { const ref = object(item, ["id", "description", "source", "sha256", "rightsStatus", "evidenceId"]); return {
      id: id(ref["id"]), description: text(ref["description"], 4000), source: text(ref["source"], 2000), sha256: hash(ref["sha256"]), rightsStatus: oneOf(ref["rightsStatus"], ["approved", "unverified", "rejected"]), evidenceId: nullable(ref["evidenceId"], id),
    }; }, 256),
    evidence: list(row["evidence"], (item) => { const evidence = object(item, ["id", "path", "sha256", "mediaType"]); return {
      id: id(evidence["id"]), path: path(evidence["path"]), sha256: hash(evidence["sha256"]), mediaType: oneOf(evidence["mediaType"], ["application/json", "text/plain", "text/markdown", "image/png"]),
    }; }, 1024),
    assets: list(row["assets"], (item) => {
      const asset = object(item, ["id", "fileId", "rect", "worldWidthMm", "worldHeightMm", "pivot", "category", "generation", "review"]);
      const rect = object(asset["rect"], ["x", "y", "width", "height"]), pivot = object(asset["pivot"], ["x", "y"]);
      const generation = object(asset["generation"], ["prompt", "referenceIds", "model", "evidenceId"]);
      const model = object(generation["model"], ["provider", "name", "revision", "verification", "evidenceId"]);
      const reviews = object(asset["review"], ["visual", "logoAndText", "contrast", "provenance"]);
      return {
        id: id(asset["id"]), fileId: id(asset["fileId"]), rect: { x: integer(rect["x"]), y: integer(rect["y"]), width: integer(rect["width"], 1), height: integer(rect["height"], 1) },
        worldWidthMm: integer(asset["worldWidthMm"], 1), worldHeightMm: integer(asset["worldHeightMm"], 1), pivot: { x: integer(pivot["x"]), y: integer(pivot["y"]) },
        category: oneOf(asset["category"], ["actor", "interior", "vehicle", "station", "environment", "signal", "accessory"]),
        generation: { prompt: text(generation["prompt"], 64_000), referenceIds: list(generation["referenceIds"], id, 256),
          model: { provider: text(model["provider"]), name: nullable(model["name"], (value) => text(value)), revision: nullable(model["revision"], (value) => text(value)), verification: oneOf(model["verification"], ["provider_declared", "provider_undisclosed"]), evidenceId: nullable(model["evidenceId"], id) }, evidenceId: nullable(generation["evidenceId"], id) },
        review: { visual: review(reviews["visual"]), logoAndText: review(reviews["logoAndText"]), contrast: review(reviews["contrast"]), provenance: review(reviews["provenance"]) },
      };
    }, 8192),
    animations: list(row["animations"], (item) => { const animation = object(item, ["id", "role", "appearanceId", "direction", "state", "frames"]); return {
      id: id(animation["id"]), role: oneOf(animation["role"], ["passenger", "conductor"]), appearanceId: id(animation["appearanceId"]), direction: oneOf(animation["direction"], ART_DIRECTIONS), state: oneOf(animation["state"], ["idle", "walk", "sitting"]),
      frames: list(animation["frames"], (item) => { const frame = object(item, ["assetId", "durationMs"]); return { assetId: id(frame["assetId"]), durationMs: integer(frame["durationMs"], 1, 10_000) }; }, 32),
    }; }, 1024),
    appearanceVariants: list(row["appearanceVariants"], (item) => { const variant = object(item, ["variant", "appearanceId"]); return { variant: integer(variant["variant"], 0, 255), appearanceId: id(variant["appearanceId"]) }; }, 256),
    accessoryBindings: list(row["accessoryBindings"], (item) => { const binding = object(item, ["spaceNeeds", "direction", "assetId", "appearanceIds"]); return {
      spaceNeeds: oneOf(binding["spaceNeeds"], ["wheelchair", "bicycle", "stroller"]), direction: oneOf(binding["direction"], ART_DIRECTIONS), assetId: id(binding["assetId"]), appearanceIds: list(binding["appearanceIds"], id, 256),
    }; }, 64),
    releaseReview: review(row["releaseReview"]),
  };
}

export function parseArtAtlasWorldPin(value: unknown): ArtAtlasWorldPinV1 {
  const row = object(value, ["schemaVersion", "worldId", "releaseId", "manifestSha256"]);
  return { schemaVersion: oneOf(row["schemaVersion"], ["art-atlas-world-pin/v1"]), worldId: id(row["worldId"]), releaseId: id(row["releaseId"]), manifestSha256: hash(row["manifestSha256"]) };
}

export function parseArtAtlasSignature(value: unknown): ArtAtlasSignatureV1 {
  const row = object(value, ["algorithm", "keyId", "signedHash", "valueBase64"]);
  const valueBase64 = text(row["valueBase64"]);
  invariant(/^[A-Za-z0-9+/]{86}==$/.test(valueBase64), "signature_encoding_invalid");
  return { algorithm: oneOf(row["algorithm"], ["ed25519"]), keyId: id(row["keyId"]), signedHash: hash(row["signedHash"]), valueBase64 };
}
