import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  STATIC_MAP_SOURCES_MATERIALIZATION_SCHEMA,
  buildStaticMapSources,
  serializeStaticMapSources,
  writeStaticMapSources,
} from "./static-map-sources.mjs";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./static-map-sources-cli.mjs", import.meta.url));
const PROTOMAPS_COMMIT = "a".repeat(40);
const TANGRAMS_COMMIT = "b".repeat(40);

function notice(text) {
  return { bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), text };
}

function fixtureAssetNotices() {
  const notoCopyright = "Copyright 2022 The Noto Project Authors (https://github.com/notofonts)";
  const spriteCopyright = "Copyright (c) 2017 Mapzen";
  return {
    schema: "zugfolge-map-asset-notices/v2",
    assets: [
      {
        id: "noto-glyphs",
        rightsSourceId: "noto-glyphs",
        kind: "glyph",
        license: "OFL-1.1",
        copyright: notoCopyright,
        modifications: "PBF-Glyphen werden unveraendert selbst gehostet.",
        source: { repository: "https://github.com/protomaps/basemaps-assets", commit: PROTOMAPS_COMMIT, path: "fonts" },
        derivedFrom: null,
        notice: { url: `https://raw.githubusercontent.com/protomaps/basemaps-assets/${PROTOMAPS_COMMIT}/fonts/OFL.txt`, ...notice(`${notoCopyright}\nSIL OPEN FONT LICENSE Version 1.1\n`) },
        tree: { installDirectory: "assets/fonts", files: 1, bytes: 10, sha256: "c".repeat(64) },
      },
      {
        id: "protomaps-sprites",
        rightsSourceId: "protomaps-sprites",
        kind: "sprite",
        license: "MIT",
        copyright: spriteCopyright,
        modifications: "Dunkle Sprites werden unveraendert selbst gehostet.",
        source: { repository: "https://github.com/protomaps/basemaps-assets", commit: PROTOMAPS_COMMIT, path: "sprites/v4" },
        derivedFrom: { repository: "https://github.com/tangrams/icons", commit: TANGRAMS_COMMIT, license: "MIT" },
        notice: { url: `https://raw.githubusercontent.com/tangrams/icons/${TANGRAMS_COMMIT}/LICENSE.md`, ...notice(`The MIT License (MIT)\n${spriteCopyright}\n`) },
        tree: { installDirectory: "assets/sprites", files: 4, bytes: 40, sha256: "d".repeat(64) },
      },
    ],
  };
}

function fixture() {
  const source = (id, rightsSourceId, role, overrides = {}) => ({
    id,
    rightsSourceId,
    role,
    sourceLicense: "CC-BY-4.0",
    shipAttribution: true,
    attribution: `Attribution ${id}`,
    modifications: `Bearbeitung ${id}`,
    ...overrides,
  });
  const capture = (id, version, fill) => ({ id, version, bytes: 100 + fill, sha256: String(fill).repeat(64) });
  const approved = (id) => ({ id, status: "freigegeben", entscheidung: { datum: "2026-08-12", pruefer: "Sebastian Barowski" } });
  const assetNotices = fixtureAssetNotices();
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
  return {
    spec: {
      schema: STATIC_MAP_SOURCES_MATERIALIZATION_SCHEMA,
      releaseId: "infra-deutschland-2026.3",
      infrastructure: { forbiddenSourceIds: ["annual-infrastructure-master", "internal-station-plan-evidence", "station-enrichment"] },
      basemap: { includedSourceIds: ["protomaps-daily-basemap"], excludedCapturedSourceIds: ["infrarelease-deutschland"] },
    },
    infrastructureCatalog: {
      schema: "zugfolge-germany-source-catalog/v1",
      sources: [
        source("geofabrik-germany-pbf", "osm-pbf-deutschland", "release-input", { sourceLicense: "ODbL-1.0" }),
        source("openstation-enrichment", "openstation", "release-input", { sourceLicense: "CC0-1.0" }),
        source("annual-infrastructure-master", "trassenfinder-infrastruktur-api", "internal-validation", { shipAttribution: false }),
        source("station-enrichment", "stada", "internal-validation", { shipAttribution: false }),
        source("internal-station-plan-evidence", "apn-validierung", "internal-validation", { shipAttribution: false }),
      ],
    },
    infrastructureCapture: {
      schema: "zugfolge-source-capture/v2",
      releaseId: "infra-deutschland-2026.3",
      timetableYear: 2026,
      capturePlanSha256: "e".repeat(64),
      capturedAt: "2026-08-12T13:05:00.000Z",
      internalEvidenceLedgerSha256: "f".repeat(64),
      sources: [capture("geofabrik-germany-pbf", "germany-260811", 1), capture("openstation-enrichment", "1.2.4", 2)],
    },
    mapCatalog: {
      schema: "zugfolge-map-source-catalog/v2",
      sources: [
        source("protomaps-daily-basemap", "protomaps-daily-basemap", undefined, { sourceLicense: "ODbL-1.0 Produced Work" }),
        source("infrarelease-deutschland", "osm-pbf-deutschland", undefined, { sourceLicense: "ODbL-1.0" }),
      ],
      assetSources,
    },
    mapCapture: {
      schema: "zugfolge-map-source-capture/v2",
      assetInventoryPlanSha256: "9".repeat(64),
      sources: [capture("infrarelease-deutschland", "infra-deutschland-2026.2", 3), capture("protomaps-daily-basemap", "20260812+basemap", 4)],
      assetNotices: structuredClone(assetNotices),
    },
    rightsRegistry: {
      version: 1,
      quellen: [
        approved("osm-pbf-deutschland"),
        approved("openstation"),
        approved("protomaps-daily-basemap"),
        approved("stada"),
        { ...approved("noto-glyphs"), lizenz: "OFL-1.1" },
        { ...approved("protomaps-sprites"), lizenz: "MIT" },
        { id: "trassenfinder-infrastruktur-api", status: "entwicklung", entscheidung: { datum: "2026-08-12", pruefer: "Sebastian Barowski" } },
        { id: "apn-validierung", status: "entwicklung", entscheidung: { datum: "2026-08-12", pruefer: "Sebastian Barowski" } },
      ],
    },
    assetNotices,
  };
}

test("Sources-v3 wird deterministisch nur aus wirklich erfassten freigegebenen Quellen und Asset-Notices erzeugt", async () => {
  const value = fixture();
  const result = buildStaticMapSources(value);
  assert.equal(result.schema, "zugfolge-static-map-sources/v3");
  assert.equal(result.releaseId, value.spec.releaseId);
  assert.deepEqual(result.sources.map(({ id }) => id), [
    "basemap-protomaps-daily-basemap",
    "infrastructure-geofabrik-germany-pbf",
    "infrastructure-openstation-enrichment",
  ]);
  assert.ok(result.sources.every(({ approved, capture }) => approved === true && Number.isSafeInteger(capture.bytes) && /^[a-f0-9]{64}$/.test(capture.sha256)));
  assert.deepEqual(result.assetNotices.assets.map(({ id }) => id), ["noto-glyphs", "protomaps-sprites"]);
  const serialized = serializeStaticMapSources(result).toString("utf8");
  assert.doesNotMatch(serialized, /stada|\bstation-enrichment\b|internal-station-plan|\bapn\b|trassenfinder|internalEvidenceLedger/i);

  const root = await mkdtemp(join(tmpdir(), "zugfolge-static-map-sources-"));
  try {
    const path = join(root, "sources.json");
    assert.equal((await writeStaticMapSources(result, path)).status, "materialized");
    await assert.rejects(
      writeStaticMapSources(result, path),
      (error) => error?.code === "EEXIST" && /weder ersetzt noch wiederverwendet/u.test(error.message),
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), JSON.parse(serialized));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("StaDa, interne Evidenz, fehlende Rechte sowie alte Quellen- und Notice-Schemata scheitern fail-closed", () => {
  const stada = fixture();
  stada.infrastructureCapture.sources.push({ id: "station-enrichment", version: "never-used", bytes: 1, sha256: "a".repeat(64) });
  assert.throws(() => buildStaticMapSources(stada), /nie verwendete Quelle station-enrichment|explizit verboten/);

  const internal = fixture();
  internal.infrastructureCapture.sources.push({ id: "internal-station-plan-evidence", version: "internal", bytes: 1, sha256: "a".repeat(64) });
  assert.throws(() => buildStaticMapSources(internal), /nie verwendete Quelle internal-station-plan-evidence|explizit verboten/);

  const master = fixture();
  master.infrastructureCapture.sources.push({ id: "annual-infrastructure-master", version: "historical", bytes: 1, sha256: "a".repeat(64) });
  assert.throws(() => buildStaticMapSources(master), /nie verwendete Quelle annual-infrastructure-master|explizit verboten/);

  const rights = fixture();
  rights.rightsRegistry.quellen.find(({ id }) => id === "openstation").status = "entwicklung";
  assert.throws(() => buildStaticMapSources(rights), /keine vollstaendige Rechtefreigabe/);

  const v1 = fixture();
  v1.spec.schema = "zugfolge-static-map-sources-materialization/v2";
  assert.throws(() => buildStaticMapSources(v1), /nur v3 mit gebundenen Asset-Notices/);

  const assetRights = fixture();
  assetRights.rightsRegistry.quellen.find(({ id }) => id === "noto-glyphs").status = "entwicklung";
  assert.throws(() => buildStaticMapSources(assetRights), /keine eigenstaendige, passende Rechtefreigabe/);

  const missingNotice = fixture();
  delete missingNotice.assetNotices.assets[0].notice.text;
  assert.throws(() => buildStaticMapSources(missingNotice), /unerwartete oder fehlende Felder/);

  const staleCaptureNotice = fixture();
  staleCaptureNotice.mapCapture.assetNotices.assets[0].tree.sha256 = "0".repeat(64);
  assert.throws(() => buildStaticMapSources(staleCaptureNotice), /Capture und Materialisierungsvertrag weichen ab/);
});

test("CLI schreibt Sources-v3 mit denselben Asset-Notices aus Katalog, Capture und Notice-Vertrag", async () => {
  const value = fixture();
  const root = await mkdtemp(join(tmpdir(), "zugfolge-static-map-sources-cli-"));
  try {
    const names = ["spec", "infrastructureCatalog", "infrastructureCapture", "mapCatalog", "mapCapture", "rightsRegistry"];
    const paths = [];
    for (const name of names) {
      const path = join(root, `${name}.json`);
      await writeFile(path, JSON.stringify(value[name]));
      paths.push(path);
    }
    const noticesRoot = join(root, "notice-root");
    await mkdir(join(noticesRoot, "notices"), { recursive: true });
    const contract = {
      schema: "zugfolge-map-asset-notice-contract/v1",
      assets: [],
    };
    for (const asset of value.assetNotices.assets) {
      const noticeFile = `notices/${asset.id}.txt`;
      await writeFile(join(noticesRoot, ...noticeFile.split("/")), asset.notice.text);
      const { text: _text, ...noticeProof } = asset.notice;
      contract.assets.push({ ...asset, notice: { file: noticeFile, ...noticeProof } });
    }
    const contractPath = join(root, "asset-notices.json");
    await writeFile(contractPath, JSON.stringify(contract));
    const output = join(root, "sources.json");
    const result = JSON.parse((await execFileAsync(process.execPath, [cli, "materialize", ...paths, contractPath, noticesRoot, output])).stdout);
    assert.equal(result.action, "materialized");
    assert.equal(result.schema, "zugfolge-static-map-sources/v3");
    assert.equal(result.sources, 3);
    assert.doesNotMatch(await readFile(output, "utf8"), /stada|\bstation-enrichment\b|internal-station-plan|\bapn\b|trassenfinder/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
