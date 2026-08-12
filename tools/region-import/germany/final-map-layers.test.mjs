import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildFinalMapLayers } from "./final-map-layers.mjs";

function feature(id, type, properties = {}, geometry = { type: "Point", coordinates: [10, 50] }) {
  return { type: "Feature", geometry, properties: { feature_id: id, feature_type: type, quality_class: "B", model_state: "observed", orderable: true, ...properties } };
}

async function sequence(path, values, recordSeparator = true) {
  await writeFile(path, values.map((value) => `${recordSeparator ? "\x1e" : ""}${JSON.stringify(value)}\n`).join(""));
}

test("stuft ungültige Gleise samt abhängiger Betriebsobjekte ab und vereinigt Bahnsteige", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-final-layers-"));
  const bad = feature("track:bad", "track", { from_osm_node_id: 1, to_osm_node_id: 1 }, { type: "LineString", coordinates: [[10, 50], [10.1, 50.1]] });
  const good = feature("track:good", "track", { from_osm_node_id: 1, to_osm_node_id: 2 }, { type: "LineString", coordinates: [[10, 50], [10.2, 50.2]] });
  await sequence(join(root, "tracks.jsonseq"), [bad, good]);
  const dependentLayers = {};
  for (const [name, field] of Object.entries({ signals: "incident_track_ids_json", switches: "incident_track_ids_json", blocks: "track_ids_json", "conflict-resources": "incident_track_ids_json" })) {
    const path = join(root, `${name}.jsonseq`);
    await sequence(path, [feature(`${name.replaceAll("-", "_")}:1`, name, { [field]: JSON.stringify(["track:bad"]) })], false);
    dependentLayers[name] = path;
  }
  await sequence(join(root, "platform-a.jsonseq"), [feature("platform:a", "platform", { quality_class: "C", orderable: false })], false);
  await sequence(join(root, "platform-b.jsonseq"), [feature("platform:b", "platform", { quality_class: "C", orderable: undefined })]);
  const result = await buildFinalMapLayers({
    tracks: join(root, "tracks.jsonseq"),
    platforms: [join(root, "platform-a.jsonseq"), join(root, "platform-b.jsonseq")],
    dependentLayers,
    outputDirectory: join(root, "output"),
  });
  assert.deepEqual(result.report.tracks.correctedTrackIds, ["track:bad"]);
  assert.equal(result.report.platforms.features, 2);
  assert.ok(Object.values(result.report.dependentLayers).every(({ corrected }) => corrected === 1));
  const tracks = (await readFile(join(root, "output", "tracks.geojsonseq"), "utf8")).trim().split("\n").map((line) => JSON.parse(line.replace(/^\x1e/u, "")));
  assert.equal(tracks[0].properties.quality_class, "C");
  assert.equal(tracks[0].properties.orderable, false);
  assert.equal(tracks[1].properties.quality_class, "B");
  const platforms = (await readFile(join(root, "output", "platforms.geojsonseq"), "utf8")).trim().split("\n").map((line) => JSON.parse(line.replace(/^\x1e/u, "")));
  assert.equal(platforms[1].properties.orderable, false);
});

test("doppelte Bahnsteig-ID stoppt atomar", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-final-layers-duplicate-"));
  const track = feature("track:good", "track", { from_osm_node_id: 1, to_osm_node_id: 2 }, { type: "LineString", coordinates: [[10, 50], [10.2, 50.2]] });
  await sequence(join(root, "tracks.jsonseq"), [track]);
  const dependentLayers = {};
  for (const [name, field] of Object.entries({ signals: "incident_track_ids_json", switches: "incident_track_ids_json", blocks: "track_ids_json", "conflict-resources": "incident_track_ids_json" })) {
    const path = join(root, `${name}.jsonseq`);
    await sequence(path, [feature(`${name.replaceAll("-", "_")}:1`, name, { [field]: "[]" })]);
    dependentLayers[name] = path;
  }
  const duplicate = feature("platform:same", "platform", { quality_class: "C", orderable: false });
  await sequence(join(root, "platform-a.jsonseq"), [duplicate]);
  await sequence(join(root, "platform-b.jsonseq"), [duplicate]);
  await assert.rejects(() => buildFinalMapLayers({
    tracks: join(root, "tracks.jsonseq"), platforms: [join(root, "platform-a.jsonseq"), join(root, "platform-b.jsonseq")], dependentLayers, outputDirectory: join(root, "output"),
  }), /Doppelte/);
});
