import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildOperationalTrackGraph } from "./operational-track-graph.mjs";

function networkWithOneResource() {
  return {
    segmentQualifications: [{
      segmentId: "segment-1",
      orderable: true,
      qualityClass: "B",
      resourceIds: ["resource-1"],
    }],
    resources: [{
      resourceId: "resource-1",
      routeNumber: 7,
      originStationId: "A",
      destinationStationId: "B",
      fromMm: 0,
      toMm: 1_000,
      lengthMm: 1_000,
    }],
    stations: [
      { stationId: "A", longitudeE7: 10_000_000, latitudeE7: 10_000_000 },
      { stationId: "B", longitudeE7: 10_100_000, latitudeE7: 10_000_000 },
    ],
  };
}

function corridorFeature() {
  return {
    type: "Feature",
    properties: {
      route_number: 7,
      from_km_mm: 0,
      to_km_mm: 100_000,
      official_evidence_id: "corridor-7",
    },
    geometry: {
      type: "LineString",
      coordinates: [[0, 0], [0.1, 0]],
    },
  };
}

function midpointTrackFeature() {
  return {
    type: "Feature",
    properties: {
      feature_id: "midpoint-track",
      from_osm_node_id: 1,
      to_osm_node_id: 2,
      length_mm: 1_000,
      orderable: true,
      quality_class: "B",
      osm_tags_json: "{}",
    },
    geometry: {
      type: "LineString",
      coordinates: [[0.049, 0], [0.051, 0]],
    },
  };
}

async function withTinyGraphFiles(run, { tracks = [midpointTrackFeature()] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-operational-track-graph-"));
  const tracksPath = join(directory, "tracks.jsonseq");
  const corridorsPath = join(directory, "corridors.jsonseq");
  await writeFile(tracksPath, `${tracks.map((track) => JSON.stringify(track)).join("\n")}\n`, "utf8");
  await writeFile(corridorsPath, `${JSON.stringify(corridorFeature())}\n`, "utf8");
  try {
    await run({ tracksPath, corridorsPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("rasterisiert lange amtliche Korridore und behaelt reale Gleise an Zwischenzellen", async () => {
  await withTinyGraphFiles(async ({ tracksPath, corridorsPath }) => {
    const graph = await buildOperationalTrackGraph({
      network: networkWithOneResource(),
      tracksPath,
      corridorsPath,
      strictProjection: {
        spans: [{
          resourceId: "resource-1",
          resourceStartMm: 0,
          resourceEndMm: 1_000,
          trackId: "midpoint-track",
          trackStartOffsetMm: 0,
          trackEndOffsetMm: 1_000,
        }],
      },
    });

    assert.equal(graph.edges.has("midpoint-track"), true);
    assert.deepEqual(graph.metrics.retainedByRoute, {
      official: 0,
      osmRef: 0,
      stationConnector: 0,
      corridorConnector: 1,
    });
  });
});

test("weist einen Graphen ohne reale Anker fuer alle benoetigten Betriebsstellen fail-closed zurueck", async () => {
  await withTinyGraphFiles(async ({ tracksPath, corridorsPath }) => {
    await assert.rejects(buildOperationalTrackGraph({
      network: networkWithOneResource(),
      tracksPath,
      corridorsPath,
      strictProjection: { spans: [] },
    }), /besitzt keinen realen Gleisanker/u);
  });
});

test("weist widerspruechliche Streckenkilometer derselben Betriebsstelle fail-closed zurueck", async () => {
  const network = networkWithOneResource();
  network.segmentQualifications[0].resourceIds.push("resource-2");
  network.resources.push({
    resourceId: "resource-2",
    routeNumber: 7,
    originStationId: "A",
    destinationStationId: "C",
    fromMm: 100,
    toMm: 2_000,
    lengthMm: 1_900,
  });
  network.stations.push({ stationId: "C", longitudeE7: 10_200_000, latitudeE7: 10_000_000 });

  await assert.rejects(buildOperationalTrackGraph({
    network,
    tracksPath: "wird-vor-der-validierung-nicht-gelesen",
    corridorsPath: "wird-vor-der-validierung-nicht-gelesen",
    strictProjection: { spans: [] },
  }), /besitzt widerspruechliche Streckenkilometer/u);
});

test("weist doppelte IDs im orderbaren realen Gleisgraphen fail-closed zurueck", async () => {
  const duplicate = midpointTrackFeature();
  duplicate.properties.from_osm_node_id = 10;
  duplicate.properties.to_osm_node_id = 11;
  await withTinyGraphFiles(async ({ tracksPath, corridorsPath }) => {
    await assert.rejects(buildOperationalTrackGraph({
      network: networkWithOneResource(),
      tracksPath,
      corridorsPath,
      strictProjection: { spans: [] },
    }), /Gleiskante midpoint-track ist doppelt/u);
  }, { tracks: [midpointTrackFeature(), duplicate] });
});
