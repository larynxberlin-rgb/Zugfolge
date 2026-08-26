import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const notoCopyright = "Copyright 2022 The Noto Project Authors (https://github.com/notofonts)";
const spriteCopyright = "Copyright (c) 2017 Mapzen";
const notice = (text) => ({ text, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") });
const assetNotices = {
  schema: "zugfolge-map-asset-notices/v2",
  assets: [
    {
      id: "noto-glyphs", rightsSourceId: "noto-glyphs", kind: "glyph", license: "OFL-1.1", copyright: notoCopyright,
      modifications: "PBF-Glyphen werden unveraendert selbst gehostet.",
      source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "c".repeat(40), path: "fonts" }, derivedFrom: null,
      notice: { url: `https://raw.githubusercontent.com/protomaps/basemaps-assets/${"c".repeat(40)}/fonts/OFL.txt`, ...notice(`${notoCopyright}\nSIL OPEN FONT LICENSE Version 1.1\n`) },
      tree: { installDirectory: "assets/fonts", files: 1, bytes: 10, sha256: "d".repeat(64) },
    },
    {
      id: "protomaps-sprites", rightsSourceId: "protomaps-sprites", kind: "sprite", license: "MIT", copyright: spriteCopyright,
      modifications: "Dunkle Sprites werden unveraendert selbst gehostet.",
      source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "c".repeat(40), path: "sprites/v4" },
      derivedFrom: { repository: "https://github.com/tangrams/icons", commit: "e".repeat(40), license: "MIT" },
      notice: { url: `https://raw.githubusercontent.com/tangrams/icons/${"e".repeat(40)}/LICENSE.md`, ...notice(`The MIT License (MIT)\n${spriteCopyright}\n`) },
      tree: { installDirectory: "assets/sprites", files: 2, bytes: 20, sha256: "f".repeat(64) },
    },
  ],
};
const assetSources = assetNotices.assets.map((asset) => ({
  id: asset.id,
  kind: asset.kind,
  rightsSourceId: asset.rightsSourceId,
  sourceLicense: asset.license,
  copyright: asset.copyright,
  attribution: `${asset.copyright}; ${asset.license}`,
  modifications: asset.modifications,
  source: asset.source,
  derivedFrom: asset.derivedFrom,
  notice: { url: asset.notice.url, bytes: asset.notice.bytes, sha256: asset.notice.sha256 },
}));
const sourceProof = {
  catalog: {
    schema: "zugfolge-map-source-catalog/v2",
    sources: [
      { id: "planet", rightsSourceId: "osm-planet-basemap", sourceLicense: "ODbL-1.0", attribution: "OSM", modifications: "Dark tiles" },
      { id: "infra", rightsSourceId: "osm-pbf-deutschland", sourceLicense: "ODbL-1.0", attribution: "InfraRelease", modifications: "Semantic tiles" },
    ],
    assetSources,
  },
  capture: {
    schema: "zugfolge-map-source-capture/v2",
    assetInventoryPlanSha256: "9".repeat(64),
    sources: [
      { id: "planet", version: "2026-08-01", bytes: 100, sha256: "a".repeat(64) },
      { id: "infra", version: "2026.1", bytes: 200, sha256: "b".repeat(64) },
    ],
    assetNotices,
  },
  rightsRegistry: {
    version: 1,
    quellen: [
      { id: "osm-planet-basemap", status: "freigegeben", entscheidung: { datum: "2026-08-12", pruefer: "Test" } },
      { id: "osm-pbf-deutschland", status: "freigegeben", entscheidung: { datum: "2026-08-12", pruefer: "Test" } },
      { id: "noto-glyphs", status: "freigegeben", lizenz: "OFL-1.1", entscheidung: { datum: "2026-08-12", pruefer: "Test" } },
      { id: "protomaps-sprites", status: "freigegeben", lizenz: "MIT", entscheidung: { datum: "2026-08-12", pruefer: "Test" } },
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
    assert.deepEqual(result.release.assetNotices, assetNotices);
    assert.equal(JSON.stringify(result.release).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MapRelease-CLI veroeffentlicht versionierte Ausgabe create-new und bewahrt vorhandene Bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-map-release-cli-create-new-"));
  try {
    const artifacts = join(root, "artifacts");
    const output = join(root, "release", "map-release.json");
    await mkdir(artifacts, { recursive: true });
    await Promise.all(spec.artifacts.map(({ file, id }) => writeFile(join(artifacts, file), Buffer.from(`PMTiles${id}`))));
    const inputs = {
      spec: join(root, "spec.json"),
      catalog: join(root, "catalog.json"),
      capture: join(root, "capture.json"),
      rights: join(root, "rights.json"),
    };
    await Promise.all([
      writeFile(inputs.spec, `${JSON.stringify(spec)}\n`, { encoding: "utf8", flag: "wx" }),
      writeFile(inputs.catalog, `${JSON.stringify(sourceProof.catalog)}\n`, { encoding: "utf8", flag: "wx" }),
      writeFile(inputs.capture, `${JSON.stringify(sourceProof.capture)}\n`, { encoding: "utf8", flag: "wx" }),
      writeFile(inputs.rights, `${JSON.stringify(sourceProof.rightsRegistry)}\n`, { encoding: "utf8", flag: "wx" }),
    ]);
    const args = [
      fileURLToPath(new URL("./build-map-release.mjs", import.meta.url)),
      inputs.spec,
      artifacts,
      inputs.catalog,
      inputs.capture,
      inputs.rights,
      output,
    ];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const firstBytes = await readFile(output);
    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(second.status, 0, "zweiter CLI-Lauf muss am create-new Ziel scheitern");
    assert.deepEqual(await readFile(output), firstBytes, "vorhandener MapRelease muss bytegleich bleiben");
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

test("fehlende oder abweichende Asset-Provenienz blockiert MapRelease und Delivery-Lineage", () => {
  const missing = structuredClone(sourceProof);
  delete missing.capture.assetNotices;
  assert.throws(() => validateMapSources(missing.catalog, missing.capture, missing.rightsRegistry), /Asset-Notices/);

  const drift = structuredClone(sourceProof);
  drift.catalog.assetSources[0].notice.sha256 = "0".repeat(64);
  assert.throws(() => validateMapSources(drift.catalog, drift.capture, drift.rightsRegistry), /weicht zwischen Katalog, Capture oder Lizenz-Notice/);
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
