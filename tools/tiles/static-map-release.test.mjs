import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  LIVEMAP_READ_MODEL_APPLICATION_ID,
  LIVEMAP_READ_MODEL_USER_VERSION,
  PUBLIC_READ_MODEL_TABLES,
} from "./livemap-read-model.mjs";
import { buildMapAssetTreeProof } from "./map-asset-notices.mjs";
import {
  BASEMAP_ATTRIBUTION,
  BASEMAP_VECTOR_LAYERS,
  INFRASTRUCTURE_VECTOR_LAYERS,
  expandMapPackagePlan,
  installMapPackage,
  packMapPackage,
  verifyMapPackage,
} from "./map-package.mjs";
import {
  STATIC_MAP_RELEASE_MATERIALIZATION_SCHEMA,
  materializeStaticMapRelease,
} from "./static-map-release.mjs";

const QUALITY_FEATURE_TYPES = Object.freeze({
  rail_corridors: "rail-corridor",
  operating_points: "operating-point",
  stations: "station",
  tracks: "track",
  platforms: "platform",
  switches: "switch",
  signals: "signal",
  blocks: "block",
  conflict_resources: "conflict_resource",
  rail_context: "rail_context",
});

function fixtureStaticMapQuality(releaseId, corpusId, sourceSha256 = "a".repeat(64)) {
  const layers = Object.entries(QUALITY_FEATURE_TYPES).map(([name, featureType], index) => {
    const features = index + 1;
    const qualityClassFeatureCount = name === "platforms" ? { A: 0, B: 0, C: features } : { A: 0, B: features, C: 0 };
    return {
      name,
      featureType,
      features,
      qualityClassFeatureCount,
      ...(name === "tracks" ? { totalLengthMm: 1000, qualityClassLengthMm: { A: 0, B: 1000, C: 0 } } : {}),
    };
  });
  const summary = layers.reduce((value, layer) => ({
    visibleLayers: value.visibleLayers + 1,
    visibleFeatures: value.visibleFeatures + layer.features,
    qualityClassFeatureCount: {
      A: value.qualityClassFeatureCount.A + layer.qualityClassFeatureCount.A,
      B: value.qualityClassFeatureCount.B + layer.qualityClassFeatureCount.B,
      C: value.qualityClassFeatureCount.C + layer.qualityClassFeatureCount.C,
    },
  }), { visibleLayers: 0, visibleFeatures: 0, qualityClassFeatureCount: { A: 0, B: 0, C: 0 } });
  return {
    schema: "zugfolge-static-map-quality/v2",
    releaseId,
    infrastructureCorpusId: corpusId,
    timetableYear: 2026,
    scopeId: "deutschland-ebo-visible-corpus",
    purpose: "static-map-visible-quality",
    deterministic: true,
    claims: { detailedSourceReportShipped: false, operationalInfraRelease: false, productionActivationEligible: false },
    classification: { A: "complete-evidence", B: "conservative-visible-model", C: "visible-not-operationally-orderable" },
    sourceReport: { content: "detailed-infrastructure-quality-report", binding: "sha256", bytes: 123, sha256: sourceSha256, shipped: false },
    summary,
    layers,
  };
}

const execFileAsync = promisify(execFile);
const mapPackageCli = fileURLToPath(new URL("./map-package-cli.mjs", import.meta.url));
const staticMapReleaseCli = fileURLToPath(new URL("./static-map-release-cli.mjs", import.meta.url));

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

async function writeAt(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    assert.ok(bytesWritten > 0);
    offset += bytesWritten;
  }
}

async function writeMinimalPmtiles(path, layerIds) {
  const layerName = Buffer.from(layerIds[0], "utf8");
  const vectorLayer = Buffer.concat([Buffer.from([0x78, 0x02, 0x0a]), varint(layerName.length), layerName, Buffer.from([0x28, 0x80, 0x20])]);
  const tileData = Buffer.concat([Buffer.from([0x1a]), varint(vectorLayer.length), vectorLayer]);
  const rootDirectory = Buffer.concat([varint(1), varint(0), varint(1), varint(tileData.length), varint(1)]);
  const metadata = Buffer.from(JSON.stringify({ vector_layers: layerIds.map((id) => ({ id, fields: {}, minzoom: 0, maxzoom: 0 })) }), "utf8");
  const rootOffset = 127;
  const metadataOffset = rootOffset + rootDirectory.length;
  const leafOffset = metadataOffset + metadata.length;
  const tileOffset = leafOffset;
  const header = Buffer.alloc(127);
  Buffer.from("PMTiles", "ascii").copy(header);
  header.writeUInt8(3, 7);
  header.writeBigUInt64LE(BigInt(rootOffset), 8);
  header.writeBigUInt64LE(BigInt(rootDirectory.length), 16);
  header.writeBigUInt64LE(BigInt(metadataOffset), 24);
  header.writeBigUInt64LE(BigInt(metadata.length), 32);
  header.writeBigUInt64LE(BigInt(leafOffset), 40);
  header.writeBigUInt64LE(0n, 48);
  header.writeBigUInt64LE(BigInt(tileOffset), 56);
  header.writeBigUInt64LE(BigInt(tileData.length), 64);
  header.writeBigUInt64LE(1n, 72);
  header.writeBigUInt64LE(1n, 80);
  header.writeBigUInt64LE(1n, 88);
  header.writeUInt8(1, 96);
  header.writeUInt8(1, 97);
  header.writeUInt8(1, 98);
  header.writeUInt8(1, 99);
  const handle = await open(path, "wx");
  try {
    await writeAt(handle, header, 0);
    await writeAt(handle, rootDirectory, rootOffset);
    await writeAt(handle, metadata, metadataOffset);
    await writeAt(handle, tileData, tileOffset);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function writeReadModel(path, corpusId) {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA application_id = ${LIVEMAP_READ_MODEL_APPLICATION_ID}; PRAGMA user_version = ${LIVEMAP_READ_MODEL_USER_VERSION}; PRAGMA foreign_keys = ON;`);
    for (const [table, columns] of Object.entries(PUBLIC_READ_MODEL_TABLES)) {
      database.exec(`CREATE TABLE ${table} (${columns.map((column) => `${column} TEXT NOT NULL`).join(", ")});`);
    }
    const metadata = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries({
      schema: "zugfolge-livemap-read-model-sqlite/v2",
      world_id: "world-static-map-test",
      infrastructure_release_id: corpusId,
      gtfs_service_date: "20260101",
      world_epoch: "2026-01-01T00:00:00.000Z",
      time_zone: "Europe/Berlin",
      service_start_offset_s: "0",
      repeat_every_s: "86400",
    })) metadata.run(key, value);
    database.prepare("INSERT INTO world_config (world_id, infrastructure_release_id, config_json) VALUES (?, ?, ?)")
      .run("world-static-map-test", corpusId, "{}");
  } finally {
    database.close();
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-static-map-release-"));
  const corpusId = "infra-deutschland-2026.3-fixture";
  const releaseId = "map-deutschland-2026.3-v2-fixture";
  await Promise.all([
    mkdir(join(root, "input")),
    mkdir(join(root, "public")),
    mkdir(join(root, "assets", "glyphs", "Inter"), { recursive: true }),
    mkdir(join(root, "assets", "sprites"), { recursive: true }),
  ]);
  await writeMinimalPmtiles(join(root, "input", "basemap.pmtiles"), BASEMAP_VECTOR_LAYERS);
  await writeMinimalPmtiles(join(root, "input", "infrastructure.pmtiles"), INFRASTRUCTURE_VECTOR_LAYERS);
  writeReadModel(join(root, "public", "read-model.sqlite"), corpusId);
  const basemapBytes = await readFile(join(root, "input", "basemap.pmtiles"));
  const basemapCapture = { bytes: basemapBytes.length, sha256: createHash("sha256").update(basemapBytes).digest("hex") };
  const glyph = Buffer.from("glyph");
  const sprites = {
    "dark.json": Buffer.from("{}"),
    "dark@2x.json": Buffer.from("{}"),
    "dark.png": Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png")]),
    "dark@2x.png": Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png2")]),
  };
  const descriptor = (kind, installPath, bytes) => ({ kind, installPath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const assetDescriptors = [
    descriptor("glyph", "assets/glyphs/Inter/0-255.pbf", glyph),
    ...Object.entries(sprites).map(([name, bytes]) => descriptor("sprite", `assets/sprites/${name}`, bytes)),
  ];
  const notoCopyright = "Copyright 2022 The Noto Project Authors (https://github.com/notofonts)";
  const spriteCopyright = "Copyright (c) 2017 Mapzen";
  const notice = (text) => ({ text, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") });
  const assetNotices = {
    schema: "zugfolge-map-asset-notices/v2",
    assets: [
      {
        id: "noto-glyphs", rightsSourceId: "noto-glyphs", kind: "glyph", license: "OFL-1.1", copyright: notoCopyright,
        modifications: "PBF-Glyphen werden unveraendert selbst gehostet.", source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "a".repeat(40), path: "fonts" }, derivedFrom: null,
        notice: { url: `https://raw.githubusercontent.com/protomaps/basemaps-assets/${"a".repeat(40)}/fonts/OFL.txt`, ...notice(`${notoCopyright}\nSIL OPEN FONT LICENSE Version 1.1\n`) },
        tree: buildMapAssetTreeProof("glyph", "assets/glyphs", assetDescriptors),
      },
      {
        id: "protomaps-sprites", rightsSourceId: "protomaps-sprites", kind: "sprite", license: "MIT", copyright: spriteCopyright,
        modifications: "Dunkle Sprites werden unveraendert selbst gehostet.", source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "a".repeat(40), path: "sprites/v4" }, derivedFrom: { repository: "https://github.com/tangrams/icons", commit: "b".repeat(40), license: "MIT" },
        notice: { url: `https://raw.githubusercontent.com/tangrams/icons/${"b".repeat(40)}/LICENSE.md`, ...notice(`The MIT License (MIT)\n${spriteCopyright}\n`) },
        tree: buildMapAssetTreeProof("sprite", "assets/sprites", assetDescriptors),
      },
    ],
  };
  await Promise.all([
    writeFile(join(root, "public", "quality.json"), JSON.stringify(fixtureStaticMapQuality(releaseId, corpusId))),
    writeFile(join(root, "public", "static-map-sources-v2.json"), JSON.stringify({ schema: "zugfolge-static-map-sources/v3", releaseId: corpusId, sources: [{ id: "basemap-fixture", scope: "basemap", approved: true, license: "ODbL-1.0", attribution: "Fixture", capture: basemapCapture }, { id: "infrastructure-fixture", scope: "infrastructure", approved: true, license: "CC0-1.0", attribution: "Fixture", capture: { bytes: 1, sha256: "a".repeat(64) } }], assetInventoryPlanSha256: "9".repeat(64), assetNotices })),
    writeFile(join(root, "assets", "glyphs", "Inter", "0-255.pbf"), glyph),
    ...Object.entries(sprites).map(([name, bytes]) => writeFile(join(root, "assets", "sprites", name), bytes)),
  ]);
  const publicBasePath = "/artifacts/static-maps/map-deutschland-2026.3-fixture";
  await writeFile(join(root, "public", "style.json"), JSON.stringify({
    version: 8,
    sources: { basemap: { type: "vector", url: `pmtiles://${publicBasePath}/basemap.pmtiles`, attribution: BASEMAP_ATTRIBUTION } },
    glyphs: `${publicBasePath}/assets/glyphs/{fontstack}/{range}.pbf`,
    sprite: `${publicBasePath}/assets/sprites/dark`,
    layers: [{ id: "background", type: "background" }, { id: "boundaries", type: "line", source: "basemap", "source-layer": "boundaries" }],
  }));
  const spec = {
    schema: STATIC_MAP_RELEASE_MATERIALIZATION_SCHEMA,
    releaseId,
    corpusId,
    packageId: "zugfolge-static-map-deutschland-fixture",
    version: "2026.3-v2-unsigned-fixture",
    partBytes: 1024,
    claims: { operationalInfraRelease: false, productionActivationEligible: false, signatureStatus: "unsigned" },
    cutover: { legacyTrainMapProjection: false, waypointFallback: false, trainPositionEstimates: false, javascriptOperationalFallback: false },
    runtime: {
      schema: "zugfolge-map-runtime/v2",
      publicBasePath,
      basemapStyleUrl: `${publicBasePath}/style.json`,
      infrastructurePmtilesUrl: `${publicBasePath}/infrastructure.pmtiles`,
    },
    artifacts: [
      { id: "basemap", kind: "basemap", sourceFile: "input/basemap.pmtiles", installPath: "basemap.pmtiles", expectedVectorLayers: BASEMAP_VECTOR_LAYERS },
      { id: "infrastructure", kind: "infrastructure", sourceFile: "input/infrastructure.pmtiles", installPath: "infrastructure.pmtiles", expectedVectorLayers: INFRASTRUCTURE_VECTOR_LAYERS },
    ],
    auxiliaryFiles: [
      { id: "quality", kind: "quality-manifest", visibility: "public", sourceFile: "public/quality.json", installPath: "manifests/quality.json" },
      { id: "read-model", kind: "read-model", visibility: "public", sourceFile: "public/read-model.sqlite", installPath: "read-model.sqlite" },
      { id: "sources", kind: "source-manifest", visibility: "public", sourceFile: "public/static-map-sources-v2.json", installPath: "manifests/sources.json" },
      { id: "style", kind: "style", visibility: "public", sourceFile: "public/style.json", installPath: "style.json" },
    ],
    auxiliaryTrees: [
      { idPrefix: "glyph", kind: "glyph", visibility: "public", sourceDirectory: "assets/glyphs", installDirectory: "assets/glyphs", expectedInventory: { Inter: 1 } },
      { idPrefix: "sprite", kind: "sprite", visibility: "public", sourceDirectory: "assets/sprites", installDirectory: "assets/sprites", expectedInventory: { "dark.json": 1, "dark.png": 1, "dark@2x.json": 1, "dark@2x.png": 1 } },
    ],
  };
  return { root, spec };
}

test("Materialisierung pinnt reale Kernbytes und liefert einen voll pruef- und frisch installierbaren statischen Kartenrelease", async () => {
  const value = await fixture();
  try {
    const output = join(value.root, "materialized");
    const first = await materializeStaticMapRelease(value.spec, value.root, output);
    assert.equal(first.status, "materialized");
    assert.equal(first.plan.schema, "zugfolge-static-map-package-plan/v2");
    assert.deepEqual(first.plan.claims, value.spec.claims);
    assert.equal(first.plan.auxiliaryFiles.some(({ kind }) => kind === "operational-infrastructure-v2"), false);
    assert.equal(first.plan.auxiliaryFiles.some(({ kind }) => kind === "train-map-projection"), false);
    assert.ok([...first.plan.artifacts, ...first.plan.auxiliaryFiles].every(({ expectedBytes, expectedSha256 }) => Number.isSafeInteger(expectedBytes) && /^[a-f0-9]{64}$/.test(expectedSha256)));
    assert.equal((await materializeStaticMapRelease(value.spec, value.root, output)).status, "reused");

    const plan = JSON.parse(await readFile(join(output, "package-plan.json"), "utf8"));
    const expanded = await expandMapPackagePlan(plan, value.root);
    const packed = await packMapPackage(expanded, value.root, join(value.root, "package"));
    await verifyMapPackage(packed.packageRoot);
    const cliVerified = JSON.parse((await execFileAsync(process.execPath, [mapPackageCli, "verify", packed.packageRoot])).stdout);
    assert.equal(cliVerified.schema, "zugfolge-static-map-package/v2");
    assert.deepEqual(cliVerified.claims, value.spec.claims);
    const installed = await installMapPackage(packed.packageRoot, join(value.root, "installed"));
    assert.equal(installed.status, "installed");
    const marker = JSON.parse(await readFile(join(value.root, "installed", ".zugfolge-map-package.json"), "utf8"));
    assert.equal(marker.schema, "zugfolge-static-map-package/v2");
    assert.deepEqual(marker.claims, value.spec.claims);
    assert.deepEqual(marker.cutover, value.spec.cutover);
    await assert.rejects(stat(join(value.root, "installed", "operational-infrastructure-v2.json")), /ENOENT/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Materialisierung lehnt interne Evidenz und eine veraenderte Wiederverwendung fail-closed ab", async () => {
  const internal = await fixture();
  try {
    const sourcesPath = join(internal.root, "public", "static-map-sources-v2.json");
    const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
    await writeFile(sourcesPath, JSON.stringify({
      ...sources,
      releaseId: internal.spec.corpusId,
      sources: sources.sources.map((source, index) => index === 0 ? { ...source, internalEvidenceLedgerHash: "a".repeat(64) } : source),
    }));
    await assert.rejects(materializeStaticMapRelease(internal.spec, internal.root, join(internal.root, "materialized")), /interne Evidenzkennung/);
  } finally {
    await rm(internal.root, { recursive: true, force: true });
  }

  const changed = await fixture();
  try {
    const output = join(changed.root, "materialized");
    await materializeStaticMapRelease(changed.spec, changed.root, output);
    await writeFile(join(changed.root, "public", "quality.json"), JSON.stringify(fixtureStaticMapQuality(changed.spec.releaseId, changed.spec.corpusId, "b".repeat(64))));
    await assert.rejects(materializeStaticMapRelease(changed.spec, changed.root, output), /weicht von den realen Eingaben ab/);
  } finally {
    await rm(changed.root, { recursive: true, force: true });
  }
});

test("Materialisierung lehnt einen geaenderten Glyph- oder Spritebaum trotz unveraendertem Sources-v3 ab", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.root, "assets", "glyphs", "Inter", "0-255.pbf"), "manipulated-glyph");
    await assert.rejects(
      materializeStaticMapRelease(value.spec, value.root, join(value.root, "materialized")),
      /weicht vom lizenzierten und gepinnten Assetbaum/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("CLI materialisiert denselben typisierten unsigned Kartenrelease ohne vorab eingetragene Hashes", async () => {
  const value = await fixture();
  try {
    const specPath = join(value.root, "materialization.json");
    const output = join(value.root, "materialized-cli");
    await writeFile(specPath, JSON.stringify(value.spec));
    const result = JSON.parse((await execFileAsync(process.execPath, [
      staticMapReleaseCli,
      "materialize",
      specPath,
      value.root,
      output,
    ])).stdout);
    assert.equal(result.action, "materialized");
    assert.equal(result.releaseId, value.spec.releaseId);
    assert.deepEqual(result.claims, value.spec.claims);
    assert.equal(JSON.parse(await readFile(join(output, "package-plan.json"), "utf8")).schema, "zugfolge-static-map-package-plan/v2");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("statische v1-Materialisierung und v1-Releasekennzeichnung werden als Legacy-Vertrag abgelehnt", async () => {
  const value = await fixture();
  try {
    const legacyMaterialization = { ...value.spec, schema: "zugfolge-static-map-release-materialization/v1" };
    await assert.rejects(materializeStaticMapRelease(legacyMaterialization, value.root, join(value.root, "legacy-v1")), /Unbekannte statische Kartenrelease-Materialisierung/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
