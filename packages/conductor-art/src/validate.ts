import { createHash } from "node:crypto";
import { ART_BRAND_COLORS, ART_DIRECTIONS, CONDUCTOR_APPEARANCE, PASSENGER_APPEARANCES, VEHICLE_VARIANTS, VEHICLE_VARIANT_ASSETS, requiredStaticAssets } from "./catalog.js";
import { ArtAtlasError, invariant } from "./errors.js";
import { parseArtAtlasManifest } from "./parse.js";
import { decodeArtPng } from "./png.js";
import type { ArtAtlasAssetV1, ArtAtlasFileV1, ArtAtlasIssueV1, ArtAtlasManifestV1, ArtAtlasReportV1, ArtAtlasResources, ArtReviewV1, DecodedArtImage } from "./types.js";

export function artSha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function pixel(image: DecodedArtImage, x: number, y: number): number {
  const at = (y * image.width + x) * 4;
  return ((image.rgba[at]! << 24) | (image.rgba[at + 1]! << 16) | (image.rgba[at + 2]! << 8) | image.rgba[at + 3]!) >>> 0;
}

/** Eigenständiges RGBA-Gate für dekodierte Originalbytes; verändert kein Pixel. */
export function validateArtRgba(image: DecodedArtImage, file: ArtAtlasFileV1, colors: readonly string[]): string[] {
  const issues = new Set<string>();
  if (image.width !== file.widthPx || image.height !== file.heightPx || image.rgba.byteLength !== image.width * image.height * 4) return ["image_dimensions_mismatch"];
  if (image.width % file.sourceScale !== 0 || image.height % file.sourceScale !== 0) issues.add("image_raster_mismatch");
  const palette = new Set(colors.map((color) => Number.parseInt(color.slice(1), 16)));
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const rgba = pixel(image, x, y), alpha = rgba & 255;
    if (alpha !== 0 && alpha !== 255) issues.add("image_alpha_not_binary");
    if (alpha !== 0 && !palette.has(rgba)) issues.add("image_palette_mismatch");
    if (file.sourceScale !== 1 && rgba !== pixel(image, x - x % file.sourceScale, y - y % file.sourceScale)) issues.add("image_raster_mismatch");
  }
  return [...issues].sort();
}

function overlaps(a: ArtAtlasAssetV1, b: ArtAtlasAssetV1): boolean {
  return a.rect.x < b.rect.x + b.rect.width && b.rect.x < a.rect.x + a.rect.width && a.rect.y < b.rect.y + b.rect.height && b.rect.y < a.rect.y + a.rect.height;
}

function inspectParsed(manifest: ArtAtlasManifestV1, bytes: Uint8Array, resources: ArtAtlasResources): ArtAtlasReportV1 {
  const issues: ArtAtlasIssueV1[] = [];
  const add = (code: string, path: string): void => { issues.push({ code, path }); };
  const unique = (values: readonly string[], path: string): void => { if (new Set(values).size !== values.length) add("duplicate_identifier", path); };
  unique(manifest.files.map((file) => file.id), "files"); unique(manifest.assets.map((asset) => asset.id), "assets");
  unique(manifest.references.map((ref) => ref.id), "references"); unique(manifest.evidence.map((evidence) => evidence.id), "evidence");
  unique(manifest.animations.map((animation) => animation.id), "animations");
  unique([...manifest.files, ...manifest.evidence].map((file) => file.path), "resourcePaths");
  unique(manifest.palette.colors, "palette.colors");
  unique(manifest.rendering.zoomSteps.map(String), "rendering.zoomSteps");
  if (!manifest.rendering.zoomSteps.includes(1)) add("native_zoom_missing", "rendering.zoomSteps");
  if (!ART_BRAND_COLORS.every((color) => manifest.palette.colors.includes(color))) add("brand_palette_incomplete", "palette.colors");
  if (manifest.status !== "approved") add("release_not_approved", "status");
  const evidence = new Map(manifest.evidence.map((item) => [item.id, item]));
  const verifiedEvidence = new Set<string>();
  for (const item of manifest.evidence) {
    const content = resources.evidence.get(item.path);
    if (!content || content.byteLength === 0 || content.byteLength > 16 * 1024 * 1024) add("evidence_missing", `evidence.${item.id}`);
    else if (artSha256(content) !== item.sha256) add("evidence_hash_mismatch", `evidence.${item.id}`);
    else verifiedEvidence.add(item.id);
  }
  const hasEvidence = (id: string | null): boolean => id !== null && evidence.has(id) && verifiedEvidence.has(id);
  const checkReview = (review: ArtReviewV1, path: string): void => {
    if (review.status === "rejected") add("review_rejected", path);
    else if (review.status === "pending") add("review_not_approved", path);
    else if (review.reviewerId === null || !hasEvidence(review.evidenceId)) add("review_evidence_invalid", path);
  };
  checkReview(manifest.releaseReview, "releaseReview");
  const references = new Map(manifest.references.map((ref) => [ref.id, ref]));
  for (const reference of manifest.references) {
    if (reference.rightsStatus === "rejected") add("reference_rights_rejected", `references.${reference.id}`);
    else if (reference.rightsStatus === "unverified") add("reference_rights_unverified", `references.${reference.id}`);
    else if (!hasEvidence(reference.evidenceId)) add("reference_rights_evidence_invalid", `references.${reference.id}`);
  }
  const files = new Map(manifest.files.map((file) => [file.id, file]));
  const images = new Map<string, DecodedArtImage>();
  let decodedPixels = 0;
  for (const file of manifest.files) {
    const content = resources.files.get(file.path);
    if (!file.path.endsWith(".png")) add("image_format_invalid", `files.${file.id}`);
    if (!content) { add("image_missing", `files.${file.id}`); continue; }
    if (artSha256(content) !== file.sha256) { add("image_hash_mismatch", `files.${file.id}`); continue; }
    if (decodedPixels + file.widthPx * file.heightPx > 33_554_432) { add("atlas_pixel_limit", `files.${file.id}`); continue; }
    try {
      const image = decodeArtPng(content);
      decodedPixels += image.width * image.height;
      if (decodedPixels > 33_554_432) { add("atlas_pixel_limit", `files.${file.id}`); continue; }
      images.set(file.id, image);
      for (const code of validateArtRgba(image, file, manifest.palette.colors)) add(code, `files.${file.id}`);
    } catch (error) { add(error instanceof ArtAtlasError ? error.code : "image_decode_failed", `files.${file.id}`); }
  }
  const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const frameHashes = new Map<string, string>();
  const fileAssets = new Map<string, ArtAtlasAssetV1[]>();
  for (const asset of manifest.assets) {
    const path = `assets.${asset.id}`, file = files.get(asset.fileId);
    for (const [gate, review] of Object.entries(asset.review)) checkReview(review, `${path}.review.${gate}`);
    const generation = asset.generation, model = generation.model;
    if (!hasEvidence(generation.evidenceId)) add("generation_evidence_missing", `${path}.generation`);
    const disclosed = (value: string | null): boolean => value !== null && !/^(unknown|undisclosed|unavailable|unspecified|provider[-_]undisclosed|n\/a|none|latest|default)$/i.test(value.trim());
    if (model.verification !== "provider_declared" || !disclosed(model.name) || !disclosed(model.revision) || !hasEvidence(model.evidenceId)) add("model_version_unverified", `${path}.generation.model`);
    unique(generation.referenceIds, `${path}.generation.referenceIds`);
    for (const ref of generation.referenceIds) if (!references.has(ref)) add("generation_reference_unknown", `${path}.generation.referenceIds`);
    if (!file) { add("asset_file_unknown", path); continue; }
    const scale = file.sourceScale;
    const rect = asset.rect;
    if (rect.x + rect.width > file.widthPx || rect.y + rect.height > file.heightPx) { add("asset_rect_outside_image", path); continue; }
    if ([rect.x, rect.y, rect.width, rect.height, asset.pivot.x, asset.pivot.y].some((value) => value % scale !== 0)) add("asset_raster_mismatch", path);
    if (rect.width * 1000 !== asset.worldWidthMm * 32 * scale || rect.height * 1000 !== asset.worldHeightMm * 32 * scale) add("asset_world_scale_mismatch", path);
    if (asset.pivot.x >= rect.width || asset.pivot.y >= rect.height) add("asset_pivot_outside_rect", path);
    const previous = fileAssets.get(asset.fileId) ?? [];
    if (previous.some((other) => overlaps(asset, other))) { add("asset_rect_overlap", path); continue; }
    previous.push(asset); fileAssets.set(asset.fileId, previous);
    const image = images.get(asset.fileId);
    if (image && rect.x + rect.width <= image.width && rect.y + rect.height <= image.height) {
      let nontransparent = false;
      const digest = createHash("sha256");
      const logicalRow = new Uint8Array(Math.ceil(rect.width / scale) * 4);
      for (let y = rect.y; y < rect.y + rect.height; y += scale) {
        let logicalOffset = 0;
        for (let x = rect.x; x < rect.x + rect.width; x += scale) {
          const at = (y * image.width + x) * 4;
          logicalRow.set(image.rgba.subarray(at, at + 4), logicalOffset);
          logicalOffset += 4;
          if (image.rgba[at + 3] !== 0) nontransparent = true;
        }
        digest.update(logicalRow);
      }
      if (!nontransparent) add("asset_empty", path);
      frameHashes.set(asset.id, digest.digest("hex"));
    }
  }
  for (const required of requiredStaticAssets(manifest.catalogVersion)) {
    const asset = assets.get(required);
    if (!asset || asset.category !== required.split(".")[0]) add("catalog_asset_missing", `catalog.${required}`);
  }
  if (manifest.catalogVersion === "conductor-art-catalog/v2") {
    for (const asset of manifest.assets) {
      if (asset.id.startsWith("vehicle.") && asset.id.split(".").length > 2 && !VEHICLE_VARIANT_ASSETS.includes(asset.id)) add("vehicle_variant_part_unknown", `assets.${asset.id}`);
    }
    for (const variant of VEHICLE_VARIANTS) {
      const pivots = new Set<string>();
      for (const part of variant.parts) {
        const asset = assets.get(`vehicle.${variant.id}.${part}`), file = asset && files.get(asset.fileId);
        if (!asset || !file) continue;
        if (asset.rect.width !== 96 * file.sourceScale || asset.rect.height !== 864 * file.sourceScale || asset.worldWidthMm !== 3000 || asset.worldHeightMm !== 27000) add("vehicle_frame_dimensions_invalid", `assets.${asset.id}`);
        pivots.add(`${asset.pivot.x / file.sourceScale}.${asset.pivot.y / file.sourceScale}`);
      }
      if (pivots.size > 1) add("vehicle_variant_geometry_mismatch", `vehicles.${variant.id}`);
    }
  }
  const appearances = [...PASSENGER_APPEARANCES, CONDUCTOR_APPEARANCE];
  const animationKeys = manifest.animations.map((animation) => `${animation.appearanceId}.${animation.direction}.${animation.state}`);
  unique(animationKeys, "animations.coverage");
  const actorAssetIds: string[] = [];
  for (const appearance of appearances) for (const direction of ART_DIRECTIONS) for (const state of ["idle", "walk", "sitting"] as const) {
    const key = `${appearance}.${direction}.${state}`;
    const animation = manifest.animations.find((animation) => `${animation.appearanceId}.${animation.direction}.${animation.state}` === key);
    if (!animation) { add("animation_missing", `animations.${key}`); continue; }
    if (animation.role !== (appearance === CONDUCTOR_APPEARANCE ? "conductor" : "passenger")) add("animation_role_mismatch", `animations.${key}`);
    if (animation.frames.length !== (state === "walk" ? 4 : 1)) add("animation_frame_count_invalid", `animations.${key}`);
    const signatures = new Set<string>(), hashes = new Set<string>();
    for (const frame of animation.frames) {
      const asset = assets.get(frame.assetId), file = asset && files.get(asset.fileId);
      actorAssetIds.push(frame.assetId);
      if (!asset || asset.category !== "actor" || !file) { add("animation_asset_unknown", `animations.${key}`); continue; }
      if (asset.rect.width !== 64 * file.sourceScale || asset.rect.height !== 64 * file.sourceScale) add("actor_frame_dimensions_invalid", `animations.${key}`);
      signatures.add(`${asset.worldWidthMm}.${asset.worldHeightMm}.${asset.pivot.x / file.sourceScale}.${asset.pivot.y / file.sourceScale}`);
      if (frameHashes.has(asset.id)) hashes.add(frameHashes.get(asset.id)!);
    }
    if (signatures.size !== 1) add("animation_geometry_mismatch", `animations.${key}`);
    if (state === "walk" && hashes.size !== 4) add("animation_frames_not_distinct", `animations.${key}`);
  }
  unique(actorAssetIds, "animations.actorAssetIds");
  for (const animation of manifest.animations) if (!appearances.includes(animation.appearanceId)) add("animation_appearance_unknown", `animations.${animation.id}`);
  const variants = new Map(manifest.appearanceVariants.map((variant) => [variant.variant, variant.appearanceId]));
  if (variants.size !== 256 || manifest.appearanceVariants.length !== 256 || [...variants.values()].some((appearance) => !(PASSENGER_APPEARANCES as readonly string[]).includes(appearance))) add("appearance_variants_incomplete", "appearanceVariants");
  if (!PASSENGER_APPEARANCES.every((appearance) => [...variants.values()].includes(appearance))) add("passenger_appearance_unused", "appearanceVariants");
  unique(manifest.accessoryBindings.map((binding) => `${binding.spaceNeeds}.${binding.direction}`), "accessoryBindings");
  for (const needs of ["wheelchair", "bicycle", "stroller"] as const) for (const direction of ART_DIRECTIONS) {
    const binding = manifest.accessoryBindings.find((binding) => binding.spaceNeeds === needs && binding.direction === direction);
    if (!binding || binding.assetId !== `accessory.${needs}.${direction}` || binding.appearanceIds.length !== 4 || new Set(binding.appearanceIds).size !== 4 || !PASSENGER_APPEARANCES.every((appearance) => binding.appearanceIds.includes(appearance))) add("accessory_binding_incomplete", `accessoryBindings.${needs}.${direction}`);
  }
  const sorted = [...new Map(issues.map((issue) => [`${issue.code}\0${issue.path}`, issue])).values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  return { schemaVersion: "art-atlas-report/v1", releaseId: manifest.releaseId, manifestSha256: artSha256(bytes), activationEligible: sorted.length === 0, issues: sorted,
    statistics: { files: manifest.files.length, assets: manifest.assets.length, animations: manifest.animations.length, decodedPixels } };
}

/** Prüft reale Manifest-/Bild-/Belegbytes. Kandidaten werden vollständig berichtet, niemals aktiviert. */
export function inspectArtAtlas(manifestBytes: Uint8Array, resources: ArtAtlasResources): ArtAtlasReportV1 {
  invariant(manifestBytes.byteLength > 0 && manifestBytes.byteLength <= 32 * 1024 * 1024, "manifest_size_invalid");
  let input: unknown;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown; }
  catch { throw new ArtAtlasError("manifest_json_invalid"); }
  return inspectParsed(parseArtAtlasManifest(input), manifestBytes, resources);
}
