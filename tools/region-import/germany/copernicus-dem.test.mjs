import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COPERNICUS_DEM_ATTRIBUTION,
  captureDemTiles,
  inspectTrackTiles,
  tileIdForCoordinate,
  tileObject,
  verifyDemCapture,
} from "./copernicus-dem.mjs";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-dem-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function track(id, coordinates, lengthMm = 300_000) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties: { feature_id: id, osm_way_id: 7, length_mm: lengthMm },
  };
}

async function writeTracks(path, features) {
  await writeFile(path, `${features.map((feature) => JSON.stringify(feature)).join("\n")}\n`, "utf8");
}

function fakeTiff(seed) {
  const result = Buffer.alloc(2_048, seed);
  result.set([0x49, 0x49, 0x2a, 0x00], 0);
  return result;
}

test("ordnet WGS84-Koordinaten deterministisch Copernicus-Geozellen zu", () => {
  assert.equal(tileIdForCoordinate(10.5, 50.2), "N50_E010");
  assert.equal(tileIdForCoordinate(10.5, 50), "N49_E010");
  assert.equal(tileIdForCoordinate(-0.1, -0.1), "S01_W001");
  assert.equal(tileObject("N50_E010").objectKey, "Copernicus_DSM_COG_10_N50_00_E010_00_DEM/Copernicus_DSM_COG_10_N50_00_E010_00_DEM.tif");
  assert.throws(() => tileIdForCoordinate(180, 50), /Au\u00dfengrenze/);
});

test("ermittelt nur die von der semantischen Gleisdatei ber\u00fchrten Kacheln", async (t) => {
  const root = await workspace(t);
  const tracks = join(root, "tracks.geojsonseq");
  await writeTracks(tracks, [
    track("track:1", [[10.9, 50.2], [11.1, 50.3]]),
    track("track:2", [[11.2, 50.4], [11.3, 51.01]]),
  ]);
  const inspected = await inspectTrackTiles(tracks);
  assert.deepEqual(inspected.tileIds, ["N50_E010", "N50_E011", "N51_E011"]);
  assert.equal(inspected.featureCount, 2);
  assert.equal(inspected.coordinateCount, 4);
});

test("erfasst bei diagonalen Segmenten jede tats\u00e4chlich durchschnittene Geozelle", async (t) => {
  const root = await workspace(t);
  const tracks = join(root, "tracks.geojsonseq");
  await writeTracks(tracks, [track("track:1", [[10.9, 50.2], [11.3, 49.8]])]);
  const inspected = await inspectTrackTiles(tracks);
  assert.deepEqual(inspected.tileIds, ["N49_E011", "N50_E010", "N50_E011"]);
});

test("pinnt jede COG-Datei und verifiziert Wiederholung vollst\u00e4ndig offline", async (t) => {
  const root = await workspace(t);
  const tracks = join(root, "tracks.geojsonseq");
  const cache = join(root, "cache");
  const manifestPath = join(root, "capture.json");
  await writeTracks(tracks, [track("track:1", [[10.9, 50.2], [11.1, 50.3]])]);
  let requestCount = 0;
  const fetchImpl = async (url) => {
    requestCount += 1;
    const seed = url.includes("E010") ? 10 : 11;
    const body = fakeTiff(seed);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "image/tiff",
        "content-length": String(body.length),
        etag: `\"etag-${seed}\"`,
        "last-modified": "Mon, 09 May 2022 14:29:06 GMT",
      },
    });
  };
  const first = await captureDemTiles({ tracksPath: tracks, cacheRoot: cache, manifestPath, fetchImpl });
  assert.equal(requestCount, 2);
  assert.equal(first.manifest.source.attribution, COPERNICUS_DEM_ATTRIBUTION);
  assert.equal(first.manifest.tiles.every(({ sha256 }) => /^[a-f0-9]{64}$/u.test(sha256)), true);

  const repeated = await captureDemTiles({
    tracksPath: tracks,
    cacheRoot: cache,
    manifestPath,
    fetchImpl: async () => { throw new Error("Netzwerk darf beim Replay nicht verwendet werden"); },
  });
  assert.equal(repeated.tiles.length, 2);
  assert.equal(requestCount, 2);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), first.manifest);
});

test("falscher Kachelhash und ge\u00e4nderte Gleisgeometrie stoppen fail-closed", async (t) => {
  const root = await workspace(t);
  const tracks = join(root, "tracks.geojsonseq");
  const cache = join(root, "cache");
  const manifestPath = join(root, "capture.json");
  await writeTracks(tracks, [track("track:1", [[10.1, 50.2], [10.2, 50.3]])]);
  await captureDemTiles({
    tracksPath: tracks,
    cacheRoot: cache,
    manifestPath,
    fetchImpl: async () => {
      const body = fakeTiff(4);
      return new Response(body, { status: 200, headers: { "content-type": "image/tiff", "content-length": String(body.length) } });
    },
  });
  const file = join(cache, tileObject("N50_E010").file);
  const damaged = fakeTiff(9);
  await writeFile(file, damaged);
  await assert.rejects(() => verifyDemCapture({ tracksPath: tracks, cacheRoot: cache, manifestPath }), /SHA-256/);

  await writeFile(file, fakeTiff(4));
  await writeTracks(tracks, [track("track:1", [[10.1, 50.2], [11.2, 50.3]])]);
  await assert.rejects(() => verifyDemCapture({ tracksPath: tracks, cacheRoot: cache, manifestPath }), /anderen Gleisdatei/);
});

test("abgebrochener Capture verwendet nur vollst\u00e4ndig validierte Cachekacheln wieder", async (t) => {
  const root = await workspace(t);
  const tracks = join(root, "tracks.geojsonseq");
  const cache = join(root, "cache");
  const manifestPath = join(root, "capture.json");
  await writeTracks(tracks, [track("track:1", [[10.1, 50.2], [10.2, 50.3]])]);
  await import("node:fs/promises").then(({ mkdir, writeFile: write }) => Promise.all([
    mkdir(cache, { recursive: true }),
    mkdir(cache, { recursive: true }).then(() => write(join(cache, tileObject("N50_E010").file), fakeTiff(8))),
  ]));
  const result = await captureDemTiles({
    tracksPath: tracks,
    cacheRoot: cache,
    manifestPath,
    fetchImpl: async () => { throw new Error("Validierter Cache darf keinen Netzabruf ausl\u00f6sen"); },
  });
  assert.equal(result.tiles[0].resumedFromValidatedCache, true);
});
