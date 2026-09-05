/** Baut ausschließlich Metadaten aus vorhandenen Bild-/Belegbytes; keine Bildänderung. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ART_DIRECTIONS, PASSENGER_APPEARANCES, artSha256, parseArtAtlasManifest } from "../../packages/conductor-art/dist/index.js";

export const RELEASE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/conductor-art/v1");
const RELEASE_ID = "conductor-art-2026.1";
const REFERENCE_KEYS = {
  seated: ["passenger-red", "passenger-teal", "passenger-amber", "passenger-slate", "conductor"],
  "interior-topdown": ["train"],
  "accessories-north-south": ["accessories"],
};
const PENDING = { status: "pending", reviewerId: null, evidenceId: null };

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function check(condition, message) { if (!condition) throw new Error(message); }
function relativePath(value) {
  check(typeof value === "string" && !value.includes("\\") && !value.includes(":") && value.split("/").every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) && part !== "." && part !== ".."), "Ungültiger relativer Belegpfad.");
  return value;
}

/** Jede Freigabe stammt aus review.json; fehlende Sichtungen bleiben ausstehend. */
export function buildArtManifest(directory = RELEASE_DIRECTORY) {
  const preparedPath = resolve(directory, "prepared.json"), prepared = readJson(preparedPath);
  check(prepared.schemaVersion === "conductor-art-prepared/v1", "Unbekannter Aufbereitungseingang.");
  const reviewPath = resolve(directory, "review.json");
  const review = existsSync(reviewPath) ? readJson(reviewPath) : null;
  if (review) check(review.schemaVersion === "conductor-art-review/v1" && review.releaseId === RELEASE_ID, "Review passt nicht zum Atlasrelease.");
  const evidence = [{ id: "technical-preparation", path: "prepared.json", sha256: artSha256(readFileSync(preparedPath)), mediaType: "application/json" }];
  const generations = new Map();
  const sourceKeys = new Set(prepared.assets.map((asset) => asset.sourceKey));
  for (const key of [...sourceKeys]) for (const reference of REFERENCE_KEYS[key] ?? []) sourceKeys.add(reference);
  for (const key of [...sourceKeys].sort()) {
    check(/^[a-z0-9-]+$/.test(key), "Ungültige Generierungskennung.");
    const generationPath = `evidence/generation-${key}.json`, generation = readJson(resolve(directory, generationPath));
    check(generation.schemaVersion === "conductor-art-generation-evidence/v1" && generation.tool === "image_gen.imagegen", "Unbekannter Generierungsbeleg.");
    const source = relativePath(generation.source), sourceBytes = readFileSync(resolve(directory, source));
    check(artSha256(sourceBytes) === generation.sourceSha256, "Originalbild stimmt nicht mit seinem Generierungsbeleg überein.");
    check(typeof generation.prompt === "string" && generation.prompt.length > 0, "Tatsächlicher Generierungsprompt fehlt.");
    generations.set(key, generation);
    evidence.push({ id: `generation-${key}`, path: generationPath, sha256: artSha256(readFileSync(resolve(directory, generationPath))), mediaType: "application/json" });
    evidence.push({ id: `source-${key}`, path: source, sha256: generation.sourceSha256, mediaType: "image/png" });
  }
  if (review) {
    evidence.push({ id: "atlas-review-record", path: "review.json", sha256: artSha256(readFileSync(reviewPath)), mediaType: "application/json" });
    for (const item of review.evidence ?? []) {
      const path = relativePath(item.path);
      check(artSha256(readFileSync(resolve(directory, path))) === item.sha256, "Prüfbeleg wurde verändert.");
      evidence.push(item);
    }
    const assetIds = new Set(prepared.assets.map((asset) => asset.id));
    for (const id of Object.keys(review.assets ?? {})) check(assetIds.has(id), "Review benennt ein unbekanntes Asset.");
  }
  const references = [...new Set([...sourceKeys].flatMap((key) => REFERENCE_KEYS[key] ?? []))].sort().map((key) => {
    const generation = generations.get(key), approval = review?.referenceRights?.[key];
    return { id: `reference-${key}`, description: `Tatsächlich verwendete eigene Generierung ${key}.`, source: generation.source, sha256: generation.sourceSha256,
      rightsStatus: approval?.status ?? "unverified", evidenceId: approval?.evidenceId ?? `generation-${key}` };
  });
  const assets = prepared.assets.map((asset) => {
    const generation = generations.get(asset.sourceKey), model = generation.metadata?.softwareAgent;
    const declared = typeof model?.name === "string" && model.name.length > 0 && typeof model?.version === "string" && model.version.length > 0;
    return { id: asset.id, fileId: asset.fileId, rect: asset.rect, worldWidthMm: asset.worldWidthMm, worldHeightMm: asset.worldHeightMm, pivot: asset.pivot, category: asset.category,
      generation: { prompt: generation.prompt, referenceIds: (REFERENCE_KEYS[asset.sourceKey] ?? []).map((key) => `reference-${key}`),
        model: { provider: "openai", name: declared ? model.name : null, revision: declared ? model.version : null, verification: declared ? "provider_declared" : "provider_undisclosed", evidenceId: `generation-${asset.sourceKey}` }, evidenceId: `generation-${asset.sourceKey}` },
      review: review?.assets?.[asset.id] ?? { visual: PENDING, logoAndText: PENDING, contrast: PENDING, provenance: PENDING } };
  });
  return parseArtAtlasManifest({ schemaVersion: "art-atlas-manifest/v1", releaseId: RELEASE_ID, status: review?.status ?? "candidate", catalogVersion: "conductor-art-catalog/v1", pixelsPerMetre: 32,
    rendering: { projection: "orthogonal_top_down", zoomSteps: [1, 2, 3, 4], sampling: "nearest_neighbor" }, palette: { id: "zugfolge-graphite-art-v1", colors: prepared.palette },
    files: prepared.files, references, evidence, assets, animations: prepared.animations,
    appearanceVariants: Array.from({ length: 256 }, (_, variant) => ({ variant, appearanceId: PASSENGER_APPEARANCES[variant % 4] })),
    accessoryBindings: ["wheelchair", "bicycle", "stroller"].flatMap((spaceNeeds) => ART_DIRECTIONS.map((direction) => ({ spaceNeeds, direction, assetId: `accessory.${spaceNeeds}.${direction}`, appearanceIds: [...PASSENGER_APPEARANCES] }))),
    releaseReview: review?.releaseReview ?? PENDING });
}

export function readArtResources(manifest, directory = RELEASE_DIRECTORY) {
  const read = (rows) => new Map(rows.map((row) => [row.path, readFileSync(resolve(directory, relativePath(row.path)))]));
  return { files: read(manifest.files), evidence: read(manifest.evidence) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = buildArtManifest();
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(resolve(RELEASE_DIRECTORY, "manifest.json"), output, "utf8");
  console.log(JSON.stringify({ releaseId: manifest.releaseId, status: manifest.status, assets: manifest.assets.length, animations: manifest.animations.length, manifestSha256: artSha256(Buffer.from(output)) }));
}
