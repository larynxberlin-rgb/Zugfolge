import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materializeMapRelease, validateMapReleaseSpec, validateMapSources, verifyRangeResponse } from "./map-release.mjs";

const spec = {
  schema: "zugfolge-map-release-spec/v1",
  releaseId: "map-test-1",
  selfHosted: true,
  runtimeExternalSources: [],
  artifacts: [
    {
      kind: "basemap", id: "base-1", file: "base.pmtiles", serveAt: "/maps/releases/test/base.pmtiles",
      coverage: "world", minZoom: 0, maxZoom: 14, layers: ["land"], attribution: "OSM", httpRangeRequired: true,
    },
    {
      kind: "infrastructure", id: "infra-1", file: "infra.pmtiles", serveAt: "/maps/releases/test/infra.pmtiles",
      coverage: "germany-ebo", minZoom: 4, maxZoom: 18, layers: ["tracks"], attribution: "InfraRelease", httpRangeRequired: true,
      stableFeatureIds: true,
    },
  ],
};
const sourceProof = {
  catalog: {
    schema: "zugfolge-map-source-catalog/v1",
    sources: [
      { id: "planet", rightsSourceId: "osm-planet-basemap", sourceLicense: "ODbL-1.0", attribution: "OSM", modifications: "Dark tiles" },
      { id: "infra", rightsSourceId: "osm-pbf-deutschland", sourceLicense: "ODbL-1.0", attribution: "InfraRelease", modifications: "Semantic tiles" },
    ],
  },
  capture: {
    schema: "zugfolge-map-source-capture/v1",
    sources: [
      { id: "planet", version: "2026-08-01", bytes: 100, sha256: "a".repeat(64) },
      { id: "infra", version: "2026.1", bytes: 200, sha256: "b".repeat(64) },
    ],
  },
  rightsRegistry: {
    version: 1,
    quellen: [
      { id: "osm-planet-basemap", status: "freigegeben", entscheidung: { datum: "2026-08-12", pruefer: "Test" } },
      { id: "osm-pbf-deutschland", status: "freigegeben", entscheidung: { datum: "2026-08-12", pruefer: "Test" } },
    ],
  },
};

test("Basemap und Semantiknetz sind getrennte selbst gehostete immutable Artefakte", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-map-release-"));
  try {
    await Promise.all(spec.artifacts.map(({ file, id }) => writeFile(join(root, file), Buffer.from(`PMTiles${id}`))));
    const result = await materializeMapRelease(spec, root, sourceProof);
    assert.equal(result.release.selfHosted, true);
    assert.deepEqual(result.release.runtimeExternalSources, []);
    assert.deepEqual(result.release.artifacts.map(({ kind }) => kind), ["basemap", "infrastructure"]);
    assert.ok(result.release.artifacts.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)));
    assert.ok(result.release.artifacts.every((artifact) => !Object.hasOwn(artifact, "file")));
    assert.equal(JSON.stringify(result.release).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Jahresvertrag 2026 materialisiert direkt aus den finalen Repo-Artefakten ohne Kopie", async () => {
  const annual = JSON.parse(await readFile(new URL("./map-release.annual-2026.spec.json", import.meta.url), "utf8"));
  validateMapReleaseSpec(annual);
  assert.equal(annual.releaseId, "infra-deutschland-2026.1");
  assert.deepEqual(annual.artifacts.map(({ file }) => file), [
    "var/source-cache/annual-2026/welt-mit-deutschland-detail.pmtiles",
    "var/derived/germany-2026/map-release/infra-deutschland-2026.1.pmtiles",
  ]);
});

test("unregistrierte Planetquelle blockiert den selbst gehosteten Kartenrelease", () => {
  const broken = structuredClone(sourceProof);
  broken.rightsRegistry.quellen = broken.rightsRegistry.quellen.slice(1);
  assert.throws(() => validateMapSources(broken.catalog, broken.capture, broken.rightsRegistry), /osm-planet-basemap/);
});

test("veränderliche latest-URL und fehlende stabile Infrastruktur-ID werden abgelehnt", () => {
  const broken = structuredClone(spec);
  broken.artifacts[1].serveAt = "/maps/releases/latest/infra.pmtiles";
  broken.artifacts[1].stableFeatureIds = false;
  assert.throws(() => validateMapReleaseSpec(broken), /latest/);
});

test("HTTP-Range-Vertrag prüft Status, Header und exakte Bytezahl", () => {
  assert.equal(verifyRangeResponse({
    status: 206, contentRange: "bytes 0-511/4096", acceptRanges: "bytes", bodyBytes: 512,
    requestedStart: 0, requestedEnd: 511, totalBytes: 4096,
  }), true);
  assert.throws(() => verifyRangeResponse({
    status: 200, contentRange: "", acceptRanges: "none", bodyBytes: 4096,
    requestedStart: 0, requestedEnd: 511, totalBytes: 4096,
  }), /206/);
});
