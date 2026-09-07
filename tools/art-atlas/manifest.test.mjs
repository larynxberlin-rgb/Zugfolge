import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { test } from "node:test";
import { VEHICLE_VARIANTS, artSha256, inspectArtAtlas } from "../../packages/conductor-art/dist/index.js";
import { checkArtRelease } from "./check.mjs";
import { artReviewInputSha256, buildArtManifest, readArtResources } from "./manifest.mjs";

/** Metadaten-Regression; die Testbytes sind ausdrücklich kein freigegebener Grafikkorpus. */
function fixture(t) {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(resolve(temporaryRoot, "zugfolge-art-review-test-"));
  t.after(() => {
    assert.ok(directory.startsWith(`${temporaryRoot}${sep}zugfolge-art-review-test-`));
    rmSync(directory, { recursive: true, force: true });
  });
  const json = (path, value) => writeFileSync(resolve(directory, path), `${JSON.stringify(value)}\n`, "utf8");
  mkdirSync(resolve(directory, "sources")); mkdirSync(resolve(directory, "evidence"));
  const generations = {};
  for (const key of ["interior-topdown", "train"]) {
    const bytes = Buffer.from(`Synthetische Metadaten-Testquelle ${key}; keine Bilddatei.`);
    writeFileSync(resolve(directory, `sources/${key}.png`), bytes);
    generations[key] = { schemaVersion: "conductor-art-generation-evidence/v1", tool: "image_gen.imagegen",
      source: `sources/${key}.png`, sourceSha256: artSha256(bytes), prompt: "Synthetischer Regressionseingang, kein ausgeliefertes Asset.",
      metadata: { softwareAgent: { name: "synthetic-test-model", version: "1" } } };
    json(`evidence/generation-${key}.json`, generations[key]);
  }
  const prepared = { schemaVersion: "conductor-art-prepared/v1", palette: ["#101419ff"], files: [], animations: [],
    assets: [{ id: "interior.floor", fileId: "synthetic-atlas", rect: { x: 0, y: 0, width: 64, height: 64 },
      worldWidthMm: 2000, worldHeightMm: 2000, pivot: { x: 32, y: 32 }, category: "interior", sourceKey: "interior-topdown" }] };
  json("prepared.json", prepared);
  const pending = { status: "pending", reviewerId: null, evidenceId: null };
  const approved = { status: "approved", reviewerId: "synthetic-test-reviewer", evidenceId: "generation-interior-topdown" };
  const review = { schemaVersion: "conductor-art-review/v1", releaseId: "conductor-art-2026.1", status: "candidate", inputSha256: null,
    assets: { "interior.floor": { visual: pending, logoAndText: pending, contrast: pending, provenance: pending } },
    releaseReview: pending, referenceRights: { train: { status: "unverified", evidenceId: null } } };
  json("review.json", review);
  return { directory, json, prepared, review, approved, generations };
}

test("Sichtungen binden Inhalt, Bildhash, Zuordnung und Herkunft; Reviewtext ändert den Prüfeingang nicht", (t) => {
  const { directory, json, prepared, review, approved, generations } = fixture(t);
  const inputSha256 = artReviewInputSha256(directory);
  review.assets["interior.floor"].visual = approved;
  json("review.json", review);
  assert.throws(() => buildArtManifest(directory), /inputSha256/);
  review.inputSha256 = inputSha256; json("review.json", review);
  assert.equal(buildArtManifest(directory).assets[0].review.visual.status, "approved");
  assert.equal(artReviewInputSha256(directory), inputSha256);

  for (const mutate of [
    (value) => { value.assets[0].pivot.x = 1; },
    (value) => { value.assets[0].rect.x = 64; },
    (value) => { value.files.push({ id: "synthetic-atlas", path: "synthetic.png", sha256: "a".repeat(64), widthPx: 64, heightPx: 64, sourceScale: 1 }); },
    (value) => { value.animations.push({ id: "synthetic-animation", role: "passenger", appearanceId: "passenger-01", direction: "south", state: "idle", frames: [{ assetId: "interior.floor", durationMs: 100 }] }); },
  ]) {
    const changed = structuredClone(prepared); mutate(changed); json("prepared.json", changed);
    assert.notEqual(artReviewInputSha256(directory), inputSha256);
    assert.throws(() => buildArtManifest(directory), /Erneute Sichtung erforderlich/);
  }
  json("prepared.json", prepared);
  generations["interior-topdown"].prompt = "Anderer tatsächlicher Generierungsprompt.";
  json("evidence/generation-interior-topdown.json", generations["interior-topdown"]);
  assert.throws(() => buildArtManifest(directory), /inputSha256/);
});

test("Referenzfreigabe ohne Rechtebeleg erhält keinen automatischen Generierungsbeleg", (t) => {
  const { directory, json, review } = fixture(t);
  review.inputSha256 = artReviewInputSha256(directory);
  review.referenceRights.train.status = "approved";
  json("review.json", review);
  const manifest = buildArtManifest(directory);
  assert.equal(manifest.references[0].evidenceId, null);
  const report = inspectArtAtlas(Buffer.from(JSON.stringify(manifest)), readArtResources(manifest, directory));
  assert.ok(report.issues.some((issue) => issue.code === "reference_rights_evidence_invalid"));
});

test("Kandidatenscan duldet ausstehende Sichtungen, aber keine technische Lücke oder veraltetes Manifest", (t) => {
  const { directory, json, prepared } = fixture(t);
  json("manifest.json", buildArtManifest(directory));
  const { blocking } = checkArtRelease({ allowPending: true, directory });
  assert.ok(blocking.some((issue) => issue.code === "catalog_asset_missing"));
  assert.ok(blocking.every((issue) => !["review_not_approved", "release_not_approved", "reference_rights_unverified"].includes(issue.code)));
  const oldBytes = readFileSync(resolve(directory, "manifest.json"));
  prepared.assets[0].pivot.x = 1; json("prepared.json", prepared);
  assert.throws(() => checkArtRelease({ allowPending: true, directory }), /Committed Manifest passt nicht/);
  assert.deepEqual(readFileSync(resolve(directory, "manifest.json")), oldBytes);
});

test("Der v2-Builder bindet direkte und bearbeitete Wagenquellen an ihre tatsächliche Referenzkette", (t) => {
  const { directory, json, prepared, generations } = fixture(t);
  const writeSource = (key) => {
    const source = `sources/${key}.png`;
    const sourceBytes = Buffer.from(`Synthetische Metadaten-Testquelle ${key}; keine Bilddatei.`);
    writeFileSync(resolve(directory, source), sourceBytes);
    json(`evidence/generation-${key}.json`, { ...generations.train, source, sourceSha256: artSha256(sourceBytes) });
  };
  writeSource("vehicle-regional-double-initial");
  for (const variant of VEHICLE_VARIANTS) {
    const key = `vehicle-${variant.id}`; writeSource(key);
    for (const part of variant.parts) prepared.assets.push({ ...prepared.assets[0], id: `vehicle.${variant.id}.${part}`, category: "vehicle", sourceKey: key });
  }
  json("prepared.json", prepared);
  const manifest = buildArtManifest(directory);
  assert.equal(manifest.catalogVersion, "conductor-art-catalog/v2");
  const vehicles = manifest.assets.filter((asset) => asset.category === "vehicle");
  assert.equal(vehicles.length, 14);
  for (const asset of vehicles) assert.deepEqual(asset.generation.referenceIds, [asset.id.startsWith("vehicle.regional-double.") ? "reference-vehicle-regional-double-initial" : "reference-train"]);
  assert.equal(manifest.references.filter((reference) => reference.id === "reference-train").length, 1);
  assert.ok(manifest.references.some((reference) => reference.id === "reference-vehicle-regional-double-initial"));
  // Die zweite Stufe muss auch ohne eine weitere direkte Zugreferenz enthalten sein.
  prepared.assets = prepared.assets.filter((asset) => asset.sourceKey === "vehicle-regional-double");
  json("prepared.json", prepared);
  json("review.json", { schemaVersion: "conductor-art-review/v1", releaseId: "conductor-art-2026.1", status: "candidate" });
  const nested = buildArtManifest(directory);
  assert.ok(nested.evidence.some((item) => item.id === "generation-train"));
  assert.ok(nested.references.some((reference) => reference.id === "reference-train"));
});
