import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mergeTrackEnrichment } from "./merge-track-enrichment.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-dem-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function feature(id, properties = {}) {
  return { type: "Feature", geometry: { type: "LineString", coordinates: [[10, 50], [10.1, 50.1]] }, properties: { feature_id: id, ...properties } };
}

test("bindet DEM-Fakten byteweise nach feature_id an den Tracklayer", async (t) => {
  const root = await fixture(t);
  const tracks = join(root, "tracks.jsonseq");
  const enrichments = join(root, "dem.jsonseq");
  const output = join(root, "merged.jsonseq");
  await writeFile(tracks, `${JSON.stringify(feature("track:1", { quality_class: "B" }))}\n`);
  await writeFile(enrichments, `${JSON.stringify(feature("track:1", {
    schema: "zugfolge-copernicus-dem-track-enrichment/v1",
    gradient_status: "derived_with_uncertainty", gradient_dimension_state: "derived",
    source_id: "copernicus-dem-germany", source_product: "COP-DEM-GLO-30-DGED", source_release: "2021",
    confidence: "derived", surface_model: true, class_a_eligible: false, quality_class_cap: "B",
    vertical_accuracy_assumption_mm: 4000, representative_gradient_permille: 8, minimum_gradient_permille: -12,
    maximum_gradient_permille: 28, uncertainty_permille: 20,
  }))}\n`);
  const result = await mergeTrackEnrichment({ tracksPath: tracks, enrichmentPath: enrichments, outputPath: output });
  assert.deepEqual({ featureCount: result.featureCount, derivedCount: result.derivedCount, unresolvedCount: result.unresolvedCount }, { featureCount: 1, derivedCount: 1, unresolvedCount: 0 });
  const merged = JSON.parse((await readFile(output, "utf8")).replace(/^\x1e/u, ""));
  assert.equal(merged.properties.quality_class, "B");
  assert.equal(merged.properties.gradient_source_id, "copernicus-dem-germany");
  assert.equal(merged.properties.maximum_gradient_permille, 28);
  assert.equal(merged.properties.gradient_class_a_eligible, false);
  const report = JSON.parse(await readFile(`${output}.report.json`, "utf8"));
  assert.equal(report.output.bytes, Buffer.byteLength(await readFile(output, "utf8")));
  assert.match(report.output.sha256, /^[a-f0-9]{64}$/u);
  assert.match(report.inputs.tracks.sha256, /^[a-f0-9]{64}$/u);
  assert.match(report.inputs.copernicusDem.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(report.contract.existingPropertiesPreserved, true);
});

test("abweichende Reihenfolge oder Geometrie stoppt statt falsch zu binden", async (t) => {
  const root = await fixture(t);
  const tracks = join(root, "tracks.jsonseq");
  const enrichments = join(root, "dem.jsonseq");
  await writeFile(tracks, `${JSON.stringify(feature("track:1"))}\n`);
  await writeFile(enrichments, `${JSON.stringify(feature("track:2", { schema: "zugfolge-copernicus-dem-track-enrichment/v1" }))}\n`);
  await assert.rejects(() => mergeTrackEnrichment({ tracksPath: tracks, enrichmentPath: enrichments, outputPath: join(root, "merged.jsonseq") }), /passt nicht/);
});

test("vorhandene Trackeigenschaften werden nie still \u00fcberschrieben", async (t) => {
  const root = await fixture(t);
  const tracks = join(root, "tracks.jsonseq");
  const enrichments = join(root, "dem.jsonseq");
  await writeFile(tracks, `${JSON.stringify(feature("track:1", { gradient_status: "existing" }))}\n`);
  await writeFile(enrichments, `${JSON.stringify(feature("track:1", {
    schema: "zugfolge-copernicus-dem-track-enrichment/v1",
    gradient_status: "unresolved", gradient_dimension_state: "missing", unresolved_reason: "endpoint_nodata",
    source_id: "copernicus-dem-germany", source_product: "COP-DEM-GLO-30-DGED", source_release: "2021",
    confidence: "derived", surface_model: true, class_a_eligible: false, quality_class_cap: "B",
    vertical_accuracy_assumption_mm: 4000,
  }))}\n`);
  await assert.rejects(() => mergeTrackEnrichment({ tracksPath: tracks, enrichmentPath: enrichments, outputPath: join(root, "merged.jsonseq") }), /vorhandene Eigenschaft gradient_status/);
});
