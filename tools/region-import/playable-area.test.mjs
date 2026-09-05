import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGtfsTrackGraph } from "./germany/operational-track-graph.mjs";
import { trackInsidePlayableArea, validatePlayableArea } from "./playable-area.mjs";

const area = (polygonE7) => validatePlayableArea({ polygonE7 });
const track = (...points) => points.map(([longitudeE7, latitudeE7]) => ({ longitudeE7, latitudeE7 }));

test("Gleise muessen vollstaendig im Spielgebiet liegen, Randgleise sind erlaubt", () => {
  const polygon = area([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.equal(trackInsidePlayableArea(polygon, track([1, 1], [9, 9])), true);
  assert.equal(trackInsidePlayableArea(polygon, track([0, 0], [10, 0])), true);
  assert.equal(trackInsidePlayableArea(polygon, track([1, 1], [11, 1], [9, 9])), false);
});

test("Innere Endpunkte erlauben keinen Aussenweg durch eine konkave Kartengrenze", () => {
  const polygon = area([[0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10]]);
  assert.equal(trackInsidePlayableArea(polygon, track([2, 8], [8, 8])), false);
  assert.equal(trackInsidePlayableArea(polygon, track([2, 2], [8, 2])), true);
  assert.equal(trackInsidePlayableArea(polygon, track([2, 4], [8, 4])), true);
  // Der Aussenabschnitt liegt nicht in der Mitte der gesamten Kante.
  const narrow = area([[0, 0], [100, 0], [100, 100], [12, 100], [12, 2], [10, 2], [10, 100], [0, 100]]);
  assert.equal(trackInsidePlayableArea(narrow, track([1, 3], [99, 3])), false);
});

test("Vertexdurchgang, Orientierung und ungueltige Spielgebiete", () => {
  const points = [[0, 0], [10, 0], [10, 10], [5, 5], [0, 10]];
  for (const shape of [points, [...points].reverse()]) {
    assert.equal(trackInsidePlayableArea(area(shape), track([2, 5], [8, 5])), true);
    assert.equal(trackInsidePlayableArea(area(shape), track([2, 8], [8, 8])), false);
  }
  assert.throws(() => area([[0, 0], [1, 1], [2, 2]]), /Flaeche/);
  assert.throws(() => area([[0.5, 0], [1, 1], [2, 2]]), /Koordinaten/);
});

test("Produktiver Routengraph entfernt Aussenwege trotz zweier innerer Halte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-playable-track-"));
  try {
    const feature = (id, coordinates) => ({
      type: "Feature", geometry: { type: "LineString", coordinates },
      properties: {
        feature_id: id, feature_type: "track", from_osm_node_id: 1, to_osm_node_id: 2,
        length_mm: 8_000_000, orderable: true, quality_class: "B",
        source_id: "osm-pbf-deutschland", model_state: "observed_osm_topology",
        osm_tags_json: JSON.stringify({ "railway:pzb": "yes" }),
      },
    });
    const tracksPath = join(directory, "tracks.jsonseq");
    const corridorsPath = join(directory, "corridors.jsonseq");
    await writeFile(tracksPath, [
      feature("inner", [[13, 51], [13.1, 51]]),
      feature("outer", [[13, 51], [13.05, 51.5], [13.1, 51]]),
    ].map(JSON.stringify).join("\n") + "\n");
    await writeFile(corridorsPath, JSON.stringify({ type: "Feature", properties: { official_evidence_id: "corridor-1", route_number: 1 }, geometry: { type: "LineString", coordinates: [[13, 51], [13.1, 51]] } }) + "\n");
    const graph = await buildGtfsTrackGraph({
      snapshot: {
        playableArea: { polygonE7: [[129_990_000, 509_990_000], [131_010_000, 509_990_000], [131_010_000, 510_010_000], [129_990_000, 510_010_000]] },
        timetableGeneration: { version: "test-v1" },
        stations: [
          { stopId: "A", longitudeE7: 130_000_000, latitudeE7: 510_000_000 },
          { stopId: "B", longitudeE7: 131_000_000, latitudeE7: 510_000_000 },
        ],
        segments: [{ segmentId: "trip", orderable: true, qualityClass: "B", stops: [{ stopId: "A" }, { stopId: "B" }] }],
      }, tracksPath, corridorsPath,
    });
    assert.deepEqual([...graph.edges.keys()], ["inner"]);
    assert.equal(graph.metrics.outsidePlayableTrackCount, 1);
    assert.ok([...graph.anchors.values()].flat().every((anchor) => anchor.edgeId === "inner"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
