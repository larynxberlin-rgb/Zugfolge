import assert from "node:assert/strict";
import test from "node:test";

import { REQUIRED_INFRA_LAYERS, buildSemanticTilePlan, validateSemanticFeatureSequence, validateSemanticTileInputs } from "./semantic-tiles.mjs";

const specification = {
  schema: "zugfolge-semantic-tile-inputs/v1",
  layers: REQUIRED_INFRA_LAYERS.map((name) => ({ name, file: `${name}.geojsonseq`, stableFeatureIdProperty: "feature_id" })),
};

test("semantischer Deutschland-Build enthält alle anklickbaren Fachlayer ohne Feature-Dropping", () => {
  const plan = buildSemanticTilePlan({ specification, inputRoot: "data/layers", outputPath: "data/map/infra.pmtiles" });
  const args = plan.commands[0].args;
  assert.ok(args.includes("--maximum-zoom=18"));
  assert.ok(args.includes("--no-feature-limit"));
  assert.ok(args.includes("--no-tile-size-limit"));
  for (const layer of REQUIRED_INFRA_LAYERS) assert.ok(args.some((argument) => argument.includes(`--named-layer=${layer}:`)));
});

test("fehlender Signal-Layer blockiert den Build", () => {
  const broken = { ...specification, layers: specification.layers.filter(({ name }) => name !== "signals") };
  assert.throws(() => validateSemanticTileInputs(broken), /signals/);
});

test("Bahnhöfe sind ein eigener anklickbarer Pflichtlayer", () => {
  assert.ok(REQUIRED_INFRA_LAYERS.includes("stations"));
  const broken = { ...specification, layers: specification.layers.filter(({ name }) => name !== "stations") };
  assert.throws(() => validateSemanticTileInputs(broken), /stations/);
});

test("jedes anklickbare Feature braucht stabile sortierte ID und Qualitätszustand", () => {
  const feature = (id) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [10, 50] },
    properties: { feature_id: id, feature_type: "signal", quality_class: "B", model_state: "derived" },
  });
  assert.doesNotThrow(() => validateSemanticFeatureSequence("signals", [feature("signal:1"), feature("signal:2")]));
  assert.throws(() => validateSemanticFeatureSequence("signals", [feature("signal:2"), feature("signal:1")]), /sortiert/);
  assert.throws(() => validateSemanticFeatureSequence("signals", [feature("wrong:1")]), /Präfix/);
});
