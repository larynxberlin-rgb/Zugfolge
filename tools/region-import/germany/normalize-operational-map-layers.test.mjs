import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLOSED_LOOP_SPLIT_RULE,
  normalizeClosedTrackFeature,
  normalizeOperationalMapLayers,
} from "./normalize-operational-map-layers.mjs";

function track(id, coordinates, tags = { railway: "rail", service: "spur" }) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties: {
      feature_id: id,
      feature_type: "track",
      from_osm_node_id: 10,
      to_osm_node_id: 10,
      length_mm: 36_262,
      model_state: "unresolved_invalid_track_topology",
      orderable: false,
      osm_tags_json: JSON.stringify(tags),
      osm_way_id: 1,
      quality_class: "C",
      source_id: "osm-pbf-deutschland",
      speed_forward_kmh: 10,
      speed_backward_kmh: 10,
      speed_forward_model: "conservative_default",
      speed_backward_model: "conservative_default",
      gradient_status: "unresolved",
      gradient_class_a_eligible: false,
      unresolved_reason: "insufficient_way_baseline",
      quality_cause: "invalid_track_topology",
    },
  };
}

const loopCoordinates = [[10, 50], [10.0001, 50], [10.0001, 50.0001], [10, 50.0001], [10, 50]];

test("geschlossene Anlagengeometrie wird aus dem operativen Gleisgraphen entfernt", () => {
  const result = normalizeClosedTrackFeature(track(
    "track:osm-way-1-segment-1-n10-n10",
    loopCoordinates,
    { railway: "rail", building: "yes" },
  ));
  assert.equal(result.action, "exclude-context");
  assert.deepEqual(result.features, []);
});

test("echtes geschlossenes EBO-Gleis wird an einem beobachteten Vertex laengentreu geteilt", () => {
  const result = normalizeClosedTrackFeature(track("track:osm-way-1-segment-1-n10-n10", loopCoordinates));
  assert.equal(result.action, "split-loop");
  assert.equal(result.features.length, 2);
  assert.equal(result.features[0].properties.quality_class, "B");
  assert.equal(result.features[1].properties.orderable, true);
  assert.equal(result.features[0].properties.topology_normalization_rule, CLOSED_LOOP_SPLIT_RULE);
  assert.notEqual(result.features[0].properties.to_osm_node_id, 10);
  assert.equal(result.features[0].properties.to_osm_node_id, result.features[1].properties.from_osm_node_id);
  assert.equal(
    result.features[0].properties.length_mm + result.features[1].properties.length_mm,
    36_262,
  );
});

test("Vollnormalisierung aktualisiert Block- und Ressourcengleisbindungen deterministisch", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-map-normalize-"));
  const source = join(root, "source");
  const output = join(root, "output");
  await mkdir(source);
  const id = "track:osm-way-1-segment-1-n10-n10";
  const feature = track(id, loopCoordinates);
  const record = (value) => `\x1e${JSON.stringify(value)}\n`;
  await writeFile(join(source, "tracks.geojsonseq"), record(feature));
  await writeFile(join(source, "platforms.geojsonseq"), record({ type: "Feature", geometry: { type: "Point", coordinates: [10, 50] }, properties: { feature_id: "platform:1", feature_type: "platform" } }));
  await writeFile(join(source, "switches.geojsonseq"), record({ type: "Feature", geometry: { type: "Point", coordinates: [10, 50] }, properties: { feature_id: "switch:1", feature_type: "switch", incident_track_ids_json: JSON.stringify([id]) } }));
  await writeFile(join(source, "signals.geojsonseq"), record({ type: "Feature", geometry: { type: "Point", coordinates: [10, 50] }, properties: { feature_id: "signal:1", feature_type: "signal", incident_track_ids_json: JSON.stringify([id]) } }));
  await writeFile(join(source, "blocks.geojsonseq"), record({ type: "Feature", geometry: { type: "MultiLineString", coordinates: [loopCoordinates] }, properties: { feature_id: "block:1", feature_type: "block", track_ids_json: JSON.stringify([id]), track_count: 1, model_state: "derived_conservative_connected_component", quality_class: "C", orderable: false } }));
  await writeFile(join(source, "conflict-resources.geojsonseq"), record({ type: "Feature", geometry: { type: "MultiLineString", coordinates: [loopCoordinates] }, properties: { feature_id: "conflict_resource:block-1", feature_type: "conflict_resource", model_state: "unresolved_dependency_track_topology", resource_kind: "block", track_ids_json: JSON.stringify([id]), quality_class: "C", orderable: false } }));
  try {
    const report = await normalizeOperationalMapLayers({ sourceDirectory: source, outputDirectory: output });
    assert.deepEqual(report.tracks, { input: 1, output: 2, retained: 0, excludedContext: 0, splitLoops: 1 });
    const firstRun = await Promise.all([
      readFile(join(output, "tracks.geojsonseq"), "utf8"),
      readFile(join(output, "blocks.geojsonseq"), "utf8"),
      readFile(join(output, "conflict-resources.geojsonseq"), "utf8"),
    ]);
    const block = JSON.parse(firstRun[1].replace(/^\x1e/u, "").trim());
    assert.equal(block.properties.quality_class, "B");
    assert.equal(block.properties.model_state, "derived_conservative_connected_component");
    assert.equal(JSON.parse(block.properties.track_ids_json).length, 2);
    assert.equal(block.properties.track_count, 2);
    const resource = JSON.parse(firstRun[2].replace(/^\x1e/u, "").trim());
    assert.equal(resource.properties.model_state, "derived_block_exclusion");

    const untouchedSource = join(root, "untouched-source");
    const untouchedOutput = join(root, "untouched-output");
    await mkdir(untouchedSource);
    const openTrack = {
      ...feature,
      geometry: { type: "LineString", coordinates: loopCoordinates.slice(0, 3) },
      properties: { ...feature.properties, feature_id: "track:osm-way-1-segment-1-n10-n11", to_osm_node_id: 11, length_mm: 18_131, quality_class: "B", orderable: true },
    };
    await writeFile(join(untouchedSource, "tracks.geojsonseq"), record(openTrack));
    for (const name of ["platforms.geojsonseq", "switches.geojsonseq", "blocks.geojsonseq", "conflict-resources.geojsonseq"]) {
      await writeFile(join(untouchedSource, name), record({ type: "Feature", geometry: { type: "Point", coordinates: [10, 50] }, properties: { feature_id: `${name}:1`, feature_type: "fixture" } }));
    }
    const emptySignal = record({ type: "Feature", geometry: { type: "Point", coordinates: [10, 50] }, properties: { feature_id: "signal:empty", feature_type: "signal", incident_track_ids_json: "[]", quality_class: "C", orderable: false } });
    await writeFile(join(untouchedSource, "signals.geojsonseq"), emptySignal);
    await normalizeOperationalMapLayers({ sourceDirectory: untouchedSource, outputDirectory: untouchedOutput });
    assert.equal(await readFile(join(untouchedOutput, "signals.geojsonseq"), "utf8"), emptySignal);

    const secondOutput = join(root, "output-2");
    await normalizeOperationalMapLayers({ sourceDirectory: source, outputDirectory: secondOutput });
    const secondRun = await Promise.all([
      readFile(join(secondOutput, "tracks.geojsonseq"), "utf8"),
      readFile(join(secondOutput, "blocks.geojsonseq"), "utf8"),
      readFile(join(secondOutput, "conflict-resources.geojsonseq"), "utf8"),
    ]);
    assert.deepEqual(secondRun, firstRun);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
