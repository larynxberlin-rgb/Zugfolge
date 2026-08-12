import assert from "node:assert/strict";
import test from "node:test";

import { buildGdalSemanticTilePlan, GDAL_SEMANTIC_LAYER_CONFIGURATION } from "./gdal-semantic-pmtiles.mjs";
import { REQUIRED_INFRA_LAYERS } from "./semantic-tiles.mjs";

function specification() {
  return {
    schema: "zugfolge-semantic-tile-inputs/v1",
    layers: REQUIRED_INFRA_LAYERS.map((name) => ({ name, file: `${name}.geojsonseq`, stableFeatureIdProperty: "feature_id" })),
  };
}

test("baut jeden semantischen Layer in eine gemeinsame Zwischenquelle", () => {
  const plan = buildGdalSemanticTilePlan({
    specification: specification(),
    inputRoot: "input",
    outputPath: "output/infrastructure.pmtiles",
    ogr2ogr: "ogr2ogr",
    temporaryRoot: "output/building",
  });
  assert.equal(plan.imports.length, REQUIRED_INFRA_LAYERS.length);
  assert.deepEqual(Object.keys(plan.configuration).sort(), [...REQUIRED_INFRA_LAYERS].sort());
  assert.ok(plan.imports[0].args.includes("-overwrite"));
  assert.ok(plan.imports.slice(1).every(({ args }) => args.includes("-update") && !args.includes("-append")));
  assert.ok(plan.imports.every(({ args }) => args.includes("GEOMETRY")));
  assert.ok(plan.imports.every(({ args }) => args.includes("GeoJSONSeq")));
  assert.equal(plan.imports[0].environment.GDAL_DATA, undefined);
  assert.ok(plan.tileBuild.args.includes("MAXZOOM=18"));
  assert.equal(plan.tileBuild.environment.GDAL_NUM_THREADS, "ALL_CPUS");
});

test("trägt nur interaktive Kurzfelder und keine Rohquellen in Tiles", () => {
  for (const [name, policy] of Object.entries(GDAL_SEMANTIC_LAYER_CONFIGURATION)) {
    assert.ok(policy.fields.includes("feature_id"), `${name} ohne feature_id`);
    assert.ok(policy.fields.includes("feature_type"), `${name} ohne feature_type`);
    assert.ok(policy.fields.includes("quality_class"), `${name} ohne quality_class`);
    assert.equal(policy.fields.includes("osm_tags_json"), false, `${name} enthält OSM-Rohtags`);
    assert.equal(policy.fields.some((field) => /apn|document|pdf|ocr|sha256/iu.test(field)), false, `${name} enthält interne Evidenzfelder`);
  }
});

test("kodiert die abgestufte Zoomtiefe", () => {
  assert.equal(GDAL_SEMANTIC_LAYER_CONFIGURATION.rail_corridors.minzoom, 4);
  assert.equal(GDAL_SEMANTIC_LAYER_CONFIGURATION.tracks.minzoom, 8);
  assert.equal(GDAL_SEMANTIC_LAYER_CONFIGURATION.signals.minzoom, 13);
  assert.equal(GDAL_SEMANTIC_LAYER_CONFIGURATION.signals.maxzoom, 18);
});
