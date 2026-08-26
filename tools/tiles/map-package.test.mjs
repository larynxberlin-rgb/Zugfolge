import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LIVEMAP_READ_MODEL_APPLICATION_ID, LIVEMAP_READ_MODEL_USER_VERSION, PUBLIC_READ_MODEL_TABLES } from "./livemap-read-model.mjs";
import { buildMapAssetTreeProof } from "./map-asset-notices.mjs";
import {
  TRAIN_MAP_PROJECTION_PUBLIC_SCHEMA_OBJECTS,
  TRAIN_MAP_PROJECTION_PUBLIC_TABLES,
  TRAIN_MAP_PROJECTION_SCHEMA,
  TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID,
  TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION,
} from "./train-map-projection.mjs";

import {
  DEFAULT_MAP_PACKAGE_PART_BYTES,
  BASEMAP_ATTRIBUTION,
  BASEMAP_VECTOR_LAYERS,
  INFRASTRUCTURE_VECTOR_LAYERS,
  expandMapPackagePlan,
  installMapPackage,
  inspectPmtilesFile,
  packMapPackage,
  serializeMapPackageManifest,
  validateMapPackageManifest,
  validateMapPackageSpec,
  verifyMapPackage,
  verifyMapPackageTransport,
} from "./map-package.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("./map-package-cli.mjs", import.meta.url));
const OPERATIONAL_BYTES = Buffer.from('{"id":"infra-deutschland-2026.3"}\n', "utf8");
const OPERATIONAL_SHA256 = createHash("sha256").update(OPERATIONAL_BYTES).digest("hex");
const OPERATIONAL_STATE_HASH = "e".repeat(64);

function fixtureNotice(text) {
  return { text, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}

async function fixtureAssetNotices(root, descriptors = fixtureSpec().auxiliaryFiles) {
  const assetDescriptors = [];
  for (const descriptor of descriptors.filter(({ kind }) => ["glyph", "sprite"].includes(kind))) {
    assetDescriptors.push({ ...descriptor, ...await fileProof(join(root, ...descriptor.sourceFile.split("/"))) });
  }
  const glyphDirectory = assetDescriptors.find(({ kind }) => kind === "glyph").installPath.split("/").slice(0, 2).join("/");
  const spriteDirectory = assetDescriptors.find(({ kind }) => kind === "sprite").installPath.split("/").slice(0, -1).join("/");
  const notoCopyright = "Copyright 2022 The Noto Project Authors (https://github.com/notofonts)";
  const spriteCopyright = "Copyright (c) 2017 Mapzen";
  return {
    schema: "zugfolge-map-asset-notices/v2",
    assets: [
      {
        id: "noto-glyphs", rightsSourceId: "noto-glyphs", kind: "glyph", license: "OFL-1.1", copyright: notoCopyright,
        modifications: "PBF-Glyphen werden unveraendert selbst gehostet.", source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "a".repeat(40), path: "fonts" }, derivedFrom: null,
        notice: { url: `https://raw.githubusercontent.com/protomaps/basemaps-assets/${"a".repeat(40)}/fonts/OFL.txt`, ...fixtureNotice(`${notoCopyright}\nSIL OPEN FONT LICENSE Version 1.1\n`) },
        tree: buildMapAssetTreeProof("glyph", glyphDirectory, assetDescriptors),
      },
      {
        id: "protomaps-sprites", rightsSourceId: "protomaps-sprites", kind: "sprite", license: "MIT", copyright: spriteCopyright,
        modifications: "Dunkle Sprites werden unveraendert selbst gehostet.", source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "a".repeat(40), path: "sprites/v4" }, derivedFrom: { repository: "https://github.com/tangrams/icons", commit: "b".repeat(40), license: "MIT" },
        notice: { url: `https://raw.githubusercontent.com/tangrams/icons/${"b".repeat(40)}/LICENSE.md`, ...fixtureNotice(`The MIT License (MIT)\n${spriteCopyright}\n`) },
        tree: buildMapAssetTreeProof("sprite", spriteDirectory, assetDescriptors),
      },
    ],
  };
}

async function fileProof(path) {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: digest.digest("hex") };
}

function fixtureNativeOperationalVerifier(calls, mutate = (receipt) => receipt) {
  return async (path, expectedReleaseId) => {
    const proof = await fileProof(path);
    calls.push({ path, expectedReleaseId, ...proof });
    return mutate({
      bytes: proof.bytes,
      infraReleaseId: expectedReleaseId,
      schema: "operational-infrastructure-v2",
      sha256: proof.sha256,
      sourceBytes: proof.bytes,
      sourceSha256: proof.sha256,
      stateHash: OPERATIONAL_STATE_HASH,
      validationMode: "native-streaming-redb-v1",
    });
  };
}

function fixtureSpec() {
  return {
    schema: "zugfolge-map-package-spec/v1",
    packageId: "zugfolge-map-test",
    version: "2026.1",
    partBytes: 11,
    runtime: {
      schema: "zugfolge-map-runtime/v1",
      publicBasePath: "/artifacts/maps/zugfolge-map-test",
      basemapStyleUrl: "/artifacts/maps/zugfolge-map-test/style.json",
      infrastructurePmtilesUrl: "/artifacts/maps/zugfolge-map-test/infrastruktur/deutschland.pmtiles",
    },
    artifacts: [
      {
        id: "welt-basiskarte",
        kind: "basemap",
        sourceFile: "input/welt.pmtiles",
        installPath: "basemap/welt.pmtiles",
        expectedVectorLayers: BASEMAP_VECTOR_LAYERS,
      },
      {
        id: "deutschland-infrastruktur",
        kind: "infrastructure",
        sourceFile: "input/deutschland.pmtiles",
        installPath: "infrastruktur/deutschland.pmtiles",
        expectedVectorLayers: INFRASTRUCTURE_VECTOR_LAYERS,
      },
    ],
    auxiliaryFiles: [
      { id: "glyph-inter-0-255", kind: "glyph", visibility: "public", sourceFile: "assets/glyphs/Inter/0-255.pbf", installPath: "assets/glyphs/Inter/0-255.pbf" },
      { id: "quality-manifest", kind: "quality-manifest", visibility: "public", sourceFile: "manifests/quality.json", installPath: "manifests/quality.json" },
      { id: "release-manifest", kind: "release-manifest", visibility: "public", sourceFile: "manifests/release.json", installPath: "manifests/release.json" },
      { id: "source-manifest", kind: "source-manifest", visibility: "public", sourceFile: "manifests/sources.json", installPath: "manifests/sources.json" },
      { id: "sprite-json", kind: "sprite", visibility: "public", sourceFile: "assets/sprites/zugfolge.json", installPath: "sprites/zugfolge.json" },
      { id: "sprite-png", kind: "sprite", visibility: "public", sourceFile: "assets/sprites/zugfolge.png", installPath: "sprites/zugfolge.png" },
      { id: "sprite-json-2x", kind: "sprite", visibility: "public", sourceFile: "assets/sprites/zugfolge@2x.json", installPath: "sprites/zugfolge@2x.json" },
      { id: "sprite-png-2x", kind: "sprite", visibility: "public", sourceFile: "assets/sprites/zugfolge@2x.png", installPath: "sprites/zugfolge@2x.png" },
      { id: "style-dark", kind: "style", visibility: "public", sourceFile: "assets/styles/zugfolge-dark.json", installPath: "style.json" },
      { id: "train-map-projection", kind: "train-map-projection", visibility: "public", sourceFile: "manifests/train-map-projection.sqlite", installPath: "train-map-projection.sqlite" },
      { id: "world-read-model", kind: "read-model", visibility: "public", sourceFile: "manifests/read-model.sqlite", installPath: "read-model.sqlite" },
    ],
  };
}

function operationalV2Spec() {
  const spec = fixtureSpec();
  spec.schema = "zugfolge-map-package-spec/v2";
  spec.version = "2026.3";
  spec.runtime = { ...spec.runtime, schema: "zugfolge-map-runtime/v2" };
  spec.auxiliaryFiles = spec.auxiliaryFiles.filter(({ kind }) => kind !== "train-map-projection");
  spec.auxiliaryFiles.push({
    id: "operational-infrastructure-2026.3",
    kind: "operational-infrastructure-v2",
    visibility: "public",
    sourceFile: "manifests/operational-infrastructure-v2.json",
    installPath: "operational-infrastructure-v2.json",
    infraReleaseId: "infra-deutschland-2026.3",
    stateHash: OPERATIONAL_STATE_HASH,
    expectedBytes: OPERATIONAL_BYTES.length,
    expectedSha256: OPERATIONAL_SHA256,
  });
  return spec;
}

async function operationalDeliveryArtifacts(root, spec) {
  const artifacts = [];
  for (const descriptor of [...spec.artifacts, ...spec.auxiliaryFiles]
    .filter(({ kind }) => !["release-manifest", "source-manifest"].includes(kind))) {
    const proof = await fileProof(join(root, ...descriptor.sourceFile.split("/")));
    artifacts.push({
      id: descriptor.id,
      kind: descriptor.kind,
      installPath: descriptor.installPath,
      ...(descriptor.kind === "operational-infrastructure-v2"
        ? { infraReleaseId: descriptor.infraReleaseId, stateHash: descriptor.stateHash }
        : {}),
      ...proof,
    });
  }
  return artifacts.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

async function writeOperationalDelivery(root, spec) {
  const artifacts = await operationalDeliveryArtifacts(root, spec);
  const sourcesDescriptor = spec.auxiliaryFiles.find(({ kind }) => kind === "source-manifest");
  const qualityDescriptor = spec.auxiliaryFiles.find(({ kind }) => kind === "quality-manifest");
  const operationalDescriptor = spec.auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2");
  const [sources, quality] = await Promise.all([
    fileProof(join(root, ...sourcesDescriptor.sourceFile.split("/"))),
    fileProof(join(root, ...qualityDescriptor.sourceFile.split("/"))),
  ]);
  const release = {
    schema: "zugfolge-map-delivery-release/v2",
    releaseId: operationalDescriptor.infraReleaseId,
    timetableYear: 2026,
    packageId: spec.packageId,
    packageVersion: spec.version,
    scope: { basemap: "fixture", infrastructure: "fixture", playableArea: "fixture" },
    artifacts,
    bindings: {
      packageManifestSchema: "zugfolge-map-package/v2",
      infraReleaseSchema: "zugfolge-infra-release/v2",
      mapReleaseSchema: "zugfolge-map-release/v1",
      sourcesSha256: sources.sha256,
      qualitySha256: quality.sha256,
      infraReleaseHash: "a".repeat(64),
      mapReleaseHash: "b".repeat(64),
    },
    approvalGates: {
      rights: { status: "passed" },
      quality: { status: "passed" },
      signature: { status: "missing", reason: "Testfixture bleibt unsigniert." },
    },
    releaseHash: null,
    signature: null,
  };
  await writeFile(join(root, "manifests", "release.json"), `${JSON.stringify(release)}\n`);
  return release;
}

async function pinOperationalV2Spec(root, spec = operationalV2Spec()) {
  await writeOperationalDelivery(root, spec);
  for (const descriptor of [...spec.artifacts, ...spec.auxiliaryFiles]) {
    const proof = await fileProof(join(root, ...descriptor.sourceFile.split("/")));
    descriptor.expectedBytes = proof.bytes;
    descriptor.expectedSha256 = proof.sha256;
  }
  return spec;
}

const STATIC_MAP_CLAIMS = Object.freeze({
  operationalInfraRelease: false,
  productionActivationEligible: false,
  signatureStatus: "unsigned",
});
const STATIC_MAP_CUTOVER = Object.freeze({
  javascriptOperationalFallback: false,
  legacyTrainMapProjection: false,
  trainPositionEstimates: false,
  waypointFallback: false,
});

const STATIC_QUALITY_FEATURE_TYPES = Object.freeze({
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

function fixtureStaticQuality(releaseId) {
  const layers = Object.entries(STATIC_QUALITY_FEATURE_TYPES).map(([name, featureType], index) => {
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
    infrastructureCorpusId: "infra-deutschland-2026.3-test",
    timetableYear: 2026,
    scopeId: "deutschland-ebo-visible-corpus",
    purpose: "static-map-visible-quality",
    deterministic: true,
    claims: { detailedSourceReportShipped: false, operationalInfraRelease: false, productionActivationEligible: false },
    classification: { A: "complete-evidence", B: "conservative-visible-model", C: "visible-not-operationally-orderable" },
    sourceReport: { content: "detailed-infrastructure-quality-report", binding: "sha256", bytes: 123, sha256: "a".repeat(64), shipped: false },
    summary,
    layers,
  };
}

async function staticMapSpec(root, { legacyQualityV1 = false } = {}) {
  const spec = fixtureSpec();
  spec.schema = "zugfolge-static-map-package-spec/v2";
  spec.packageId = "zugfolge-static-map-test";
  spec.version = "2026.3-unsigned";
  spec.releaseId = "map-deutschland-2026.3-test";
  spec.claims = STATIC_MAP_CLAIMS;
  spec.cutover = STATIC_MAP_CUTOVER;
  spec.runtime = { ...spec.runtime, schema: "zugfolge-map-runtime/v2" };
  spec.auxiliaryFiles = spec.auxiliaryFiles.filter(({ kind }) => kind !== "train-map-projection");
  const assetNotices = await fixtureAssetNotices(root, spec.auxiliaryFiles);
  await Promise.all([
    writeFile(join(root, "manifests", "quality.json"), JSON.stringify(legacyQualityV1
      ? { schema: "zugfolge-static-map-quality/v1", releaseId: spec.releaseId }
      : fixtureStaticQuality(spec.releaseId))),
    writeFile(join(root, "manifests", "sources.json"), JSON.stringify({
      schema: "zugfolge-static-map-sources/v3",
      releaseId: "infra-deutschland-2026.3-test",
      sources: [{ id: "basemap-fixture", approved: true, license: "ODbL-1.0" }],
      assetInventoryPlanSha256: "9".repeat(64),
      assetNotices,
    })),
  ]);

  const descriptors = [...spec.artifacts, ...spec.auxiliaryFiles]
    .filter(({ kind }) => ["basemap", "infrastructure", "style", "read-model", "quality-manifest", "source-manifest"].includes(kind));
  const artifacts = [];
  for (const descriptor of descriptors) {
    const proof = await fileProof(join(root, ...descriptor.sourceFile.split("/")));
    descriptor.expectedBytes = proof.bytes;
    descriptor.expectedSha256 = proof.sha256;
    artifacts.push({
      id: descriptor.id,
      kind: descriptor.kind,
      installPath: descriptor.installPath,
      ...proof,
    });
  }
  artifacts.sort((left, right) => left.id.localeCompare(right.id, "en"));
  await writeFile(join(root, "manifests", "release.json"), `${JSON.stringify({
    schema: "zugfolge-static-map-release/v2",
    releaseId: spec.releaseId,
    status: "unsigned",
    claims: spec.claims,
    cutover: spec.cutover,
    artifacts,
  })}\n`);
  const release = spec.auxiliaryFiles.find(({ kind }) => kind === "release-manifest");
  Object.assign(release, await fileProof(join(root, "manifests", "release.json")));
  release.expectedBytes = release.bytes;
  release.expectedSha256 = release.sha256;
  delete release.bytes;
  delete release.sha256;
  return spec;
}

async function makeFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-map-package-"));
  const input = join(root, "input");
  await mkdir(input);
  await writeMinimalPmtiles(join(input, "welt.pmtiles"), { layerId: "boundaries", metadataLayerIds: BASEMAP_VECTOR_LAYERS });
  await writeMinimalPmtiles(join(input, "deutschland.pmtiles"), { layerId: "tracks", metadataLayerIds: INFRASTRUCTURE_VECTOR_LAYERS });
  await Promise.all([
    mkdir(join(root, "assets", "glyphs", "Inter"), { recursive: true }),
    mkdir(join(root, "assets", "sprites"), { recursive: true }),
    mkdir(join(root, "assets", "styles"), { recursive: true }),
    mkdir(join(root, "manifests"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "assets", "glyphs", "Inter", "0-255.pbf"), Buffer.from("lokale-glyphen-pbf")),
    writeFile(join(root, "assets", "sprites", "zugfolge.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("lokales-sprite")])),
    writeFile(join(root, "assets", "sprites", "zugfolge.json"), JSON.stringify({ signal: { x: 0, y: 0, width: 16, height: 16, pixelRatio: 1 } })),
    writeFile(join(root, "assets", "sprites", "zugfolge@2x.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("lokales-sprite-2x")])),
    writeFile(join(root, "assets", "sprites", "zugfolge@2x.json"), JSON.stringify({ signal: { x: 0, y: 0, width: 32, height: 32, pixelRatio: 2 } })),
    writeFile(join(root, "assets", "styles", "zugfolge-dark.json"), JSON.stringify({ version: 8, name: "Zugfolge dunkel", sources: { basemap: { type: "vector", url: "pmtiles:///artifacts/maps/zugfolge-map-test/basemap/welt.pmtiles", attribution: BASEMAP_ATTRIBUTION } }, sprite: "/artifacts/maps/zugfolge-map-test/sprites/zugfolge", glyphs: "/artifacts/maps/zugfolge-map-test/assets/glyphs/{fontstack}/{range}.pbf", layers: [{ id: "background", type: "background" }, { id: "boundaries", type: "line", source: "basemap", "source-layer": "boundaries" }] })),
    writeFile(join(root, "manifests", "release.json"), JSON.stringify({ schema: "release-public/v1", releaseId: "map-2026.1", validation: { additionalInternalValidationApplied: true, rawValidationMaterialShipped: false } })),
    writeFile(join(root, "manifests", "sources.json"), JSON.stringify({ schema: "sources-public/v1", sources: [{ id: "protomaps-daily-basemap", license: "ODbL-1.0" }] })),
    writeFile(join(root, "manifests", "quality.json"), JSON.stringify({ schema: "quality-public/v1", classes: { A: 1, B: 2, C: 3 } })),
    writeFile(join(root, "manifests", "operational-infrastructure-v2.json"), OPERATIONAL_BYTES),
  ]);
  await writeFile(join(root, "manifests", "sources.json"), JSON.stringify({
    schema: "zugfolge-map-delivery-sources/v2",
    releaseId: "infra-deutschland-2026.3",
    sources: [{ id: "basemap-protomaps", approved: true, license: "ODbL-1.0", attribution: "Protomaps and OpenStreetMap" }],
    assetInventoryPlanSha256: "9".repeat(64),
    assetNotices: await fixtureAssetNotices(root),
  }));
  writeMinimalPublicReadModel(join(root, "manifests", "read-model.sqlite"));
  writeMinimalTrainMapProjection(join(root, "manifests", "train-map-projection.sqlite"));
  await writeOperationalDelivery(root, operationalV2Spec());
  return root;
}

function writeMinimalTrainMapProjection(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA application_id = ${TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID};
      PRAGMA user_version = ${TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION};
      PRAGMA foreign_keys = ON;
      CREATE TABLE display_path_geometries (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        display_path_id TEXT NOT NULL,
        length_mm INTEGER NOT NULL CHECK (length_mm >= 0),
        geometry_json TEXT NOT NULL,
        PRIMARY KEY (world_id, infrastructure_release_id, display_path_id)
      ) WITHOUT ROWID;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE track_geometries (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        length_mm INTEGER NOT NULL CHECK (length_mm > 0),
        geometry_json TEXT NOT NULL,
        PRIMARY KEY (world_id, infrastructure_release_id, track_id)
      ) WITHOUT ROWID;
      CREATE TABLE resource_track_spans (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_start_mm INTEGER NOT NULL CHECK (resource_start_mm >= 0),
        resource_end_mm INTEGER NOT NULL CHECK (resource_end_mm > resource_start_mm),
        track_id TEXT NOT NULL,
        track_start_offset_mm INTEGER NOT NULL CHECK (track_start_offset_mm >= 0),
        track_end_offset_mm INTEGER NOT NULL CHECK (track_end_offset_mm >= 0),
        is_resource_end INTEGER NOT NULL CHECK (is_resource_end IN (0, 1)),
        PRIMARY KEY (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm, track_id),
        FOREIGN KEY (world_id, infrastructure_release_id, track_id)
          REFERENCES track_geometries (world_id, infrastructure_release_id, track_id)
      ) WITHOUT ROWID;
      CREATE INDEX resource_track_lookup ON resource_track_spans
        (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm);
      CREATE TABLE resource_display_spans (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_start_mm INTEGER NOT NULL CHECK (resource_start_mm >= 0),
        resource_end_mm INTEGER NOT NULL CHECK (resource_end_mm > resource_start_mm),
        method TEXT NOT NULL CHECK (method IN ('topological-track', 'route-corridor', 'anchor-hold')),
        display_path_id TEXT NOT NULL,
        display_start_offset_mm INTEGER NOT NULL CHECK (display_start_offset_mm >= 0),
        display_end_offset_mm INTEGER NOT NULL CHECK (display_end_offset_mm >= 0),
        uncertainty_start_mm INTEGER NOT NULL CHECK (uncertainty_start_mm >= 0),
        uncertainty_end_mm INTEGER NOT NULL CHECK (uncertainty_end_mm >= 0),
        is_resource_end INTEGER NOT NULL CHECK (is_resource_end IN (0, 1)),
        PRIMARY KEY (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm, method, display_path_id),
        FOREIGN KEY (world_id, infrastructure_release_id, display_path_id)
          REFERENCES display_path_geometries (world_id, infrastructure_release_id, display_path_id)
      ) WITHOUT ROWID;
      CREATE INDEX resource_display_lookup ON resource_display_spans
        (world_id, infrastructure_release_id, resource_id, resource_start_mm, resource_end_mm);
      CREATE TABLE train_resource_spans (
        world_id TEXT NOT NULL,
        infrastructure_release_id TEXT NOT NULL,
        train_id TEXT NOT NULL,
        position_start_mm INTEGER NOT NULL CHECK (position_start_mm >= 0),
        position_end_mm INTEGER NOT NULL CHECK (position_end_mm > position_start_mm),
        resource_id TEXT NOT NULL,
        is_train_end INTEGER NOT NULL CHECK (is_train_end IN (0, 1)),
        PRIMARY KEY (world_id, infrastructure_release_id, train_id, position_start_mm, resource_id)
      ) WITHOUT ROWID;
      CREATE INDEX train_position_lookup ON train_resource_spans
        (world_id, infrastructure_release_id, train_id, position_start_mm, position_end_mm);
    `);
    const insert = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries({
      schema: TRAIN_MAP_PROJECTION_SCHEMA,
      world_id: "world-test",
      infrastructure_release_id: "infra-test",
      timetable_year: "2026",
      tracks_sha256: "a".repeat(64),
      corridors_sha256: "b".repeat(64),
      operational_network_sha256: "c".repeat(64),
      deployment_sha256: "d".repeat(64),
    })) insert.run(key, value);
    const schemaObjects = database.prepare(`
      SELECT type, name, tbl_name AS "table"
      FROM sqlite_master
      WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all().map(({ type, name, table }) => ({ type, name, table }));
    assert.deepEqual(schemaObjects, TRAIN_MAP_PROJECTION_PUBLIC_SCHEMA_OBJECTS);
    const tableColumns = Object.fromEntries(Object.keys(TRAIN_MAP_PROJECTION_PUBLIC_TABLES).sort().map((table) => [
      table,
      database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
    ]));
    assert.deepEqual(tableColumns, TRAIN_MAP_PROJECTION_PUBLIC_TABLES);
  } finally {
    database.close();
  }
}

function writeMinimalPublicReadModel(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA application_id = ${LIVEMAP_READ_MODEL_APPLICATION_ID}; PRAGMA user_version = ${LIVEMAP_READ_MODEL_USER_VERSION}; PRAGMA foreign_keys = ON;`);
    for (const [table, columns] of Object.entries(PUBLIC_READ_MODEL_TABLES)) {
      database.exec(`CREATE TABLE ${table} (${columns.map((column) => `${column} TEXT NOT NULL`).join(", ")});`);
    }
    const metadata = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries({
      schema: "zugfolge-livemap-read-model-sqlite/v2",
      world_id: "world-test",
      infrastructure_release_id: "infra-test",
      gtfs_service_date: "20260101",
      world_epoch: "2026-01-01T00:00:00.000Z",
      time_zone: "Europe/Berlin",
      service_start_offset_s: "0",
      repeat_every_s: "86400",
    })) metadata.run(key, value);
    database.prepare("INSERT INTO world_config (world_id, infrastructure_release_id, config_json) VALUES (?, ?, ?)")
      .run("world-test", "infra-test", "{}");
  } finally {
    database.close();
  }
}

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

async function writeMinimalPmtiles(path, { layerId, metadataLayerIds, tileDataOffset, metadataAfterTile = false, extraMetadata = {} } = {}) {
  const layerName = Buffer.from(layerId ?? "test", "utf8");
  const vectorLayer = Buffer.concat([
    Buffer.from([0x78, 0x02, 0x0a]),
    varint(layerName.length),
    layerName,
    Buffer.from([0x28, 0x80, 0x20]),
  ]);
  const tileData = Buffer.concat([Buffer.from([0x1a]), varint(vectorLayer.length), vectorLayer]);
  const rootDirectory = Buffer.concat([varint(1), varint(0), varint(1), varint(tileData.length), varint(1)]);
  const metadata = Buffer.from(JSON.stringify({
    name: `fixture-${layerId ?? "test"}`,
    vector_layers: (metadataLayerIds ?? [layerId ?? "test"]).map((id) => ({ id, fields: {}, minzoom: 0, maxzoom: 0 })),
    ...extraMetadata,
  }), "utf8");
  const rootOffset = 127n;
  const rootEnd = rootOffset + BigInt(rootDirectory.length);
  const actualTileOffset = tileDataOffset ?? (metadataAfterTile ? rootEnd : rootEnd + BigInt(metadata.length));
  const metadataOffset = metadataAfterTile ? actualTileOffset + BigInt(tileData.length) : rootEnd;
  const leafOffset = metadataOffset + BigInt(metadata.length);
  assert.ok(tileDataOffset === undefined || actualTileOffset >= leafOffset);

  const header = Buffer.alloc(127);
  Buffer.from("PMTiles", "ascii").copy(header, 0);
  header.writeUInt8(3, 7);
  header.writeBigUInt64LE(rootOffset, 8);
  header.writeBigUInt64LE(BigInt(rootDirectory.length), 16);
  header.writeBigUInt64LE(metadataOffset, 24);
  header.writeBigUInt64LE(BigInt(metadata.length), 32);
  header.writeBigUInt64LE(leafOffset, 40);
  header.writeBigUInt64LE(0n, 48);
  header.writeBigUInt64LE(actualTileOffset, 56);
  header.writeBigUInt64LE(BigInt(tileData.length), 64);
  header.writeBigUInt64LE(1n, 72);
  header.writeBigUInt64LE(1n, 80);
  header.writeBigUInt64LE(1n, 88);
  header.writeUInt8(1, 96);
  header.writeUInt8(1, 97);
  header.writeUInt8(1, 98);
  header.writeUInt8(1, 99);
  header.writeUInt8(0, 100);
  header.writeUInt8(0, 101);
  header.writeInt32LE(0, 102);
  header.writeInt32LE(0, 106);
  header.writeInt32LE(0, 110);
  header.writeInt32LE(0, 114);
  header.writeUInt8(0, 118);
  header.writeInt32LE(0, 119);
  header.writeInt32LE(0, 123);

  const handle = await open(path, "wx");
  try {
    await writeAt(handle, header, 0);
    await writeAt(handle, rootDirectory, Number(rootOffset));
    await writeAt(handle, metadata, Number(metadataOffset));
    const tileEnd = actualTileOffset + BigInt(tileData.length);
    await handle.truncate(Number(tileEnd > leafOffset ? tileEnd : leafOffset));
    await writeAt(handle, tileData, Number(actualTileOffset));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

test("Packen ist deterministisch und teilt jedes Artefakt unterhalb der festen Grenze", async () => {
  const root = await makeFixtureRoot();
  try {
    const first = await packMapPackage(fixtureSpec(), root, join(root, "package-a"));
    const second = await packMapPackage(fixtureSpec(), root, join(root, "package-b"));
    assert.equal(first.manifestSha256, second.manifestSha256);
    assert.equal(
      await readFile(join(root, "package-a", "manifest.json"), "utf8"),
      await readFile(join(root, "package-b", "manifest.json"), "utf8"),
    );
    assert.deepEqual(first.manifest.artifacts.map(({ id }) => id), ["deutschland-infrastruktur", "welt-basiskarte"]);
    assert.ok(first.manifest.artifacts.every((artifact) => artifact.parts.length > 1));
    assert.ok(first.manifest.artifacts.flatMap((artifact) => artifact.parts).every((part) => part.bytes <= 11));
    assert.ok(first.manifest.auxiliaryFiles.every((auxiliary) => auxiliary.parts.length > 1));
    for (const artifact of [...first.manifest.artifacts, ...first.manifest.auxiliaryFiles]) {
      for (const part of artifact.parts) {
        assert.deepEqual(
          await readFile(join(root, "package-a", ...part.path.split("/"))),
          await readFile(join(root, "package-b", ...part.path.split("/"))),
        );
      }
    }
    const verified = await verifyMapPackage(first.packageRoot);
    assert.equal(verified.manifestSha256, first.manifestSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ein bytegenau abgeleitetes Release-Manifest darf vor dem Packen nicht ausgetauscht werden", async () => {
  const root = await makeFixtureRoot();
  try {
    const spec = fixtureSpec();
    const releaseDescriptor = spec.auxiliaryFiles.find(({ kind }) => kind === "release-manifest");
    const releasePath = join(root, ...releaseDescriptor.sourceFile.split("/"));
    const proof = await fileProof(releasePath);
    releaseDescriptor.expectedBytes = proof.bytes;
    releaseDescriptor.expectedSha256 = proof.sha256;
    await writeFile(releasePath, Buffer.concat([await readFile(releasePath), Buffer.from(" ")]));

    await assert.rejects(
      packMapPackage(spec, root, join(root, "package-mutated-release")),
      /release-manifest weicht vom freigegebenen Byte-SHA-Beleg/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Paketierung liest neue Ergebnisse und byte-identische Altbestände aus eindeutigen Overlay-Wurzeln", async () => {
  const root = await makeFixtureRoot();
  try {
    const historicalRoot = join(root, "historical-build");
    await mkdir(historicalRoot);
    await rename(join(root, "assets"), join(historicalRoot, "assets"));

    const packed = await packMapPackage(fixtureSpec(), [root, historicalRoot], join(root, "package-overlay"));
    assert.equal(packed.manifest.artifacts.length, 2);
    assert.ok((await readFile(join(root, "package-overlay", "manifest.json"), "utf8")).includes("zugfolge-map-test"));

    await mkdir(join(historicalRoot, "manifests"));
    await writeFile(join(historicalRoot, "manifests", "quality.json"), JSON.stringify({ schema: "quality-public/v1" }));
    await assert.rejects(
      packMapPackage(fixtureSpec(), [root, historicalRoot], join(root, "package-ambiguous")),
      /mehreren Quellwurzeln.*mehrdeutig/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Installation wird als ganzes Verzeichnis abgeschlossen und danach wiederverwendet", async () => {
  const root = await makeFixtureRoot();
  try {
    const packed = await packMapPackage(fixtureSpec(), root, join(root, "package"));
    const installRoot = join(root, "installed", "2026.1");
    const first = await installMapPackage(packed.packageRoot, installRoot);
    assert.equal(first.status, "installed");
    assert.deepEqual(
      await readFile(join(installRoot, "basemap", "welt.pmtiles")),
      await readFile(join(root, "input", "welt.pmtiles")),
    );
    assert.deepEqual(
      await readFile(join(installRoot, "infrastruktur", "deutschland.pmtiles")),
      await readFile(join(root, "input", "deutschland.pmtiles")),
    );
    assert.deepEqual(
      await readFile(join(installRoot, "style.json")),
      await readFile(join(root, "assets", "styles", "zugfolge-dark.json")),
    );
    assert.deepEqual(
      await readFile(join(installRoot, "manifests", "quality.json")),
      await readFile(join(root, "manifests", "quality.json")),
    );
    const second = await installMapPackage(packed.packageRoot, installRoot);
    assert.equal(second.status, "reused");
    assert.deepEqual((await readdir(join(root, "installed"))).sort(), ["2026.1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("beschädigter Paketteil blockiert die Installation ohne sichtbares Teilziel", async () => {
  const root = await makeFixtureRoot();
  try {
    const packed = await packMapPackage(fixtureSpec(), root, join(root, "package"));
    const firstPart = packed.manifest.artifacts[0].parts.at(-1);
    const corrupt = await readFile(join(packed.packageRoot, ...firstPart.path.split("/")));
    corrupt[corrupt.length - 1] ^= 0xff;
    await writeFile(join(packed.packageRoot, ...firstPart.path.split("/")), corrupt);
    await assert.rejects(verifyMapPackage(packed.packageRoot), /SHA-256/);
    const installRoot = join(root, "installed", "2026.1");
    await assert.rejects(installMapPackage(packed.packageRoot, installRoot), /SHA-256/);
    await assert.rejects(stat(installRoot), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nicht manifestierte Beigaben werden auch bei sonst korrekten Hashes abgelehnt", async () => {
  const root = await makeFixtureRoot();
  try {
    const packed = await packMapPackage(fixtureSpec(), root, join(root, "package"));
    await writeFile(join(packed.packageRoot, "parts", "apn-rohdaten.pdf"), "darf nicht mitreisen");
    await assert.rejects(verifyMapPackage(packed.packageRoot), /unerwartete Datei/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsichere Pfade, Geheimnisfelder und APN-Rohreferenzen werden abgelehnt", () => {
  const escaped = fixtureSpec();
  escaped.artifacts[0].installPath = "../welt.pmtiles";
  assert.throws(() => validateMapPackageSpec(escaped), /relativ|normalisiert|unsicher/);

  const withApn = fixtureSpec();
  withApn.artifacts[0].sourceFile = "input/apn-export.pmtiles";
  assert.throws(() => validateMapPackageSpec(withApn), /APN-Rohdaten/);

  const manifest = {
    schema: "zugfolge-map-package/v1",
    packageId: "zugfolge-map-test",
    version: "2026.1",
    format: "directory-parts",
    partBytes: 11,
    accessToken: "nicht-ausliefern",
    artifacts: [],
  };
  assert.throws(() => validateMapPackageManifest(manifest), /Geheimnisfeld/);
});

test("fehlende Teilgröße wählt das dokumentierte konfigurierbare 100-MiB-Chatprofil", () => {
  const spec = fixtureSpec();
  delete spec.partBytes;
  const normalized = validateMapPackageSpec(spec);
  assert.equal(normalized.partBytes, 100 * 1024 * 1024);
  assert.equal(normalized.partBytes, DEFAULT_MAP_PACKAGE_PART_BYTES);
});

test("genau zwei unterschiedliche PMTiles-Arten und der vollständige öffentliche Dateisatz sind Pflicht", () => {
  const missingMap = fixtureSpec();
  missingMap.artifacts.pop();
  assert.throws(() => validateMapPackageSpec(missingMap), /genau zwei PMTiles/);

  const duplicateMapKind = fixtureSpec();
  duplicateMapKind.artifacts[1].kind = "basemap";
  assert.throws(() => validateMapPackageSpec(duplicateMapKind), /Kartenart basemap ist doppelt/);

  const missingStyle = fixtureSpec();
  missingStyle.auxiliaryFiles = missingStyle.auxiliaryFiles.filter(({ kind }) => kind !== "style");
  assert.throws(() => validateMapPackageSpec(missingStyle), /genau eine style/);

  const missingProjection = fixtureSpec();
  missingProjection.auxiliaryFiles = missingProjection.auxiliaryFiles.filter(({ kind }) => kind !== "train-map-projection");
  assert.throws(() => validateMapPackageSpec(missingProjection), /genau eine eigenständige Zugpositionsprojektion/);
});

test("Paketvertrag v2 transportiert genau eine statische Operational-v2-Bindung ohne Zugpositionsprojektion", async () => {
  const root = await makeFixtureRoot();
  try {
    const unpinned = operationalV2Spec();
    const nativeCalls = [];
    const operationalValidation = {
      validateOperationalInfrastructure: fixtureNativeOperationalVerifier(nativeCalls),
    };
    assert.doesNotThrow(() => validateMapPackageSpec(unpinned));
    await assert.rejects(
      packMapPackage(unpinned, root, join(root, "package-v2-unpinned"), operationalValidation),
      /vollstaendig expandierten und bytegenau gepinnten Paketvertrag/u,
    );
    const spec = await pinOperationalV2Spec(root, operationalV2Spec());
    assert.equal(spec.runtime.schema, "zugfolge-map-runtime/v2");
    await assert.rejects(
      packMapPackage(spec, root, join(root, "package-v2-without-native")),
      /nativen Dateiverifier/,
    );
    const packed = await packMapPackage(spec, root, join(root, "package-v2"), operationalValidation);
    assert.equal(packed.manifest.schema, "zugfolge-map-package/v2");
    assert.equal(packed.manifest.runtime.schema, "zugfolge-map-runtime/v2");
    const legacyRuntimeManifest = structuredClone(packed.manifest);
    legacyRuntimeManifest.runtime = { ...legacyRuntimeManifest.runtime, schema: "zugfolge-map-runtime/v1" };
    assert.throws(() => validateMapPackageManifest(legacyRuntimeManifest), /zugfolge-map-runtime\/v2/);
    const operational = packed.manifest.auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2");
    assert.deepEqual(
      { infraReleaseId: operational.infraReleaseId, bytes: operational.bytes, sha256: operational.sha256, stateHash: operational.stateHash },
      { infraReleaseId: "infra-deutschland-2026.3", bytes: OPERATIONAL_BYTES.length, sha256: OPERATIONAL_SHA256, stateHash: OPERATIONAL_STATE_HASH },
    );
    assert.equal(packed.manifest.auxiliaryFiles.some(({ kind }) => kind === "train-map-projection"), false);
    await verifyMapPackageTransport(packed.packageRoot);
    assert.equal(nativeCalls.length, 1, "Die asynchrone Transportpruefung darf keine zweite native Semantikpruefung starten.");
    await verifyMapPackage(packed.packageRoot, operationalValidation);
    const installed = await installMapPackage(packed.packageRoot, join(root, "installed-v2"), operationalValidation);
    assert.equal(installed.status, "installed");
    assert.deepEqual(await readFile(join(root, "installed-v2", "operational-infrastructure-v2.json")), OPERATIONAL_BYTES);
    const reused = await installMapPackage(packed.packageRoot, join(root, "installed-v2"), operationalValidation);
    assert.equal(reused.status, "reused");
    assert.deepEqual(
      nativeCalls.map(({ expectedReleaseId }) => expectedReleaseId),
      Array(4).fill("infra-deutschland-2026.3"),
      "Pack, Verify, frische Installation und Reuse muessen jeweils nativ pruefen.",
    );

    await assert.rejects(
      verifyMapPackage(packed.packageRoot, {
        validateOperationalInfrastructure: fixtureNativeOperationalVerifier([], (receipt) => ({
          ...receipt,
          sourceSha256: "0".repeat(64),
        })),
      }),
      /Quelldateibytes gebunden/,
    );

    const missing = operationalV2Spec();
    missing.auxiliaryFiles = missing.auxiliaryFiles.filter(({ kind }) => kind !== "operational-infrastructure-v2");
    assert.throws(() => validateMapPackageSpec(missing), /genau eine statische/);
    const duplicate = operationalV2Spec();
    duplicate.auxiliaryFiles.push({ ...duplicate.auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2"), id: "operational-infrastructure-copy" });
    assert.throws(() => validateMapPackageSpec(duplicate), /genau eine statische/);
    const withLegacyProjection = operationalV2Spec();
    withLegacyProjection.auxiliaryFiles.push(fixtureSpec().auxiliaryFiles.find(({ kind }) => kind === "train-map-projection"));
    assert.throws(() => validateMapPackageSpec(withLegacyProjection), /keine weltgebundene Zugpositionsprojektion/);
    const legacyRuntime = operationalV2Spec();
    legacyRuntime.runtime = { ...legacyRuntime.runtime, schema: "zugfolge-map-runtime/v1" };
    assert.throws(() => validateMapPackageSpec(legacyRuntime), /zugfolge-map-runtime\/v2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vollstaendig gepinnter Operational-v2-Plan verwirft jeden Drift nach der Ableitung", async () => {
  const mutations = [
    ["PMTiles", async (root) => {
      const path = join(root, "input", "welt.pmtiles");
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from([0])]));
    }],
    ["ReadModel", async (root) => {
      const path = join(root, "manifests", "read-model.sqlite");
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from([0])]));
    }],
    ["Quality", async (root) => {
      const path = join(root, "manifests", "quality.json");
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("\n")]));
    }],
    ["Style", async (root) => {
      const path = join(root, "assets", "styles", "zugfolge-dark.json");
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("\n")]));
    }],
    ["Sources", async (root) => {
      const path = join(root, "manifests", "sources.json");
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("\n")]));
    }],
  ];
  for (const [label, mutate] of mutations) {
    const root = await makeFixtureRoot();
    try {
      const spec = await pinOperationalV2Spec(root, operationalV2Spec());
      await mutate(root);
      await assert.rejects(
        packMapPackage(spec, root, join(root, `package-v2-drift-${label.toLowerCase()}`), {
          validateOperationalInfrastructure: fixtureNativeOperationalVerifier([]),
        }),
        undefined,
        label,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Verify verwirft einen transportseitig nachgehashten Delivery-v2-Inventartausch", async () => {
  const root = await makeFixtureRoot();
  try {
    const spec = operationalV2Spec();
    spec.partBytes = 1024 * 1024;
    await pinOperationalV2Spec(root, spec);
    const operationalValidation = {
      validateOperationalInfrastructure: fixtureNativeOperationalVerifier([]),
    };
    const packed = await packMapPackage(spec, root, join(root, "package-v2-forged-delivery"), operationalValidation);
    const manifestPath = join(packed.packageRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const releaseEntry = manifest.auxiliaryFiles.find(({ kind }) => kind === "release-manifest");
    assert.equal(releaseEntry.parts.length, 1);
    const releasePartPath = join(packed.packageRoot, ...releaseEntry.parts[0].path.split("/"));
    const release = JSON.parse(await readFile(releasePartPath, "utf8"));
    release.artifacts.find(({ kind }) => kind === "style").sha256 = "c".repeat(64);
    const forgedReleaseBytes = Buffer.from(`${JSON.stringify(release)}\n`, "utf8");
    assert.equal(forgedReleaseBytes.length, releaseEntry.bytes);
    const forgedReleaseSha256 = createHash("sha256").update(forgedReleaseBytes).digest("hex");
    await writeFile(releasePartPath, forgedReleaseBytes);
    releaseEntry.sha256 = forgedReleaseSha256;
    releaseEntry.parts[0].sha256 = forgedReleaseSha256;
    const manifestText = serializeMapPackageManifest(manifest);
    const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
    await Promise.all([
      writeFile(manifestPath, manifestText, "utf8"),
      writeFile(join(packed.packageRoot, "manifest.sha256"), `${manifestSha256}  manifest.json\n`, "ascii"),
    ]);
    await assert.rejects(
      verifyMapPackage(packed.packageRoot, operationalValidation),
      /Delivery-v2-Artefakte weichen vom tatsaechlich gepackten Operational-v2-Inventar ab/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("statischer Kartenrelease wird unsigned, nicht aktivierbar und ohne Operational-v2 oder Legacy-Projektion gepackt, geprueft und frisch installiert", async () => {
  const root = await makeFixtureRoot();
  try {
    const spec = await staticMapSpec(root);
    const normalized = validateMapPackageSpec(spec);
    assert.deepEqual(normalized.claims, STATIC_MAP_CLAIMS);
    assert.equal(normalized.auxiliaryFiles.some(({ kind }) => kind === "operational-infrastructure-v2"), false);
    assert.equal(normalized.auxiliaryFiles.some(({ kind }) => kind === "train-map-projection"), false);

    const packed = await packMapPackage(spec, root, join(root, "static-map-package"));
    assert.equal(packed.manifest.schema, "zugfolge-static-map-package/v2");
    assert.equal(packed.manifest.releaseId, spec.releaseId);
    assert.deepEqual(packed.manifest.claims, STATIC_MAP_CLAIMS);
    assert.deepEqual(packed.manifest.cutover, STATIC_MAP_CUTOVER);
    await verifyMapPackage(packed.packageRoot);
    const installed = await installMapPackage(packed.packageRoot, join(root, "static-map-installed"));
    assert.equal(installed.status, "installed");
    assert.equal((await installMapPackage(packed.packageRoot, join(root, "static-map-installed"))).status, "reused");
    const marker = JSON.parse(await readFile(join(root, "static-map-installed", ".zugfolge-map-package.json"), "utf8"));
    assert.equal(marker.claims.operationalInfraRelease, false);
    assert.equal(marker.claims.productionActivationEligible, false);
    assert.equal(marker.claims.signatureStatus, "unsigned");
    assert.deepEqual(marker.cutover, STATIC_MAP_CUTOVER);
    for (const auxiliary of marker.auxiliaryFiles.filter(({ mediaType }) => mediaType === "application/json")) {
      assert.doesNotMatch(await readFile(join(root, "static-map-installed", ...auxiliary.installPath.split("/")), "utf8"), /"schema"\s*:\s*"zugfolge-[^"]+\/v1"/i);
    }
    assert.doesNotMatch(JSON.stringify(marker), /"schema"\s*:\s*"zugfolge-[^"]+\/v1"/i);
    await assert.rejects(stat(join(root, "static-map-installed", "train-map-projection.sqlite")), /ENOENT/);
    await assert.rejects(stat(join(root, "static-map-installed", "operational-infrastructure-v2.json")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("statischer Kartenrelease lehnt Aktivierungsclaims, fehlende Bytepins und beide betrieblichen Ersatzartefakte fail-closed ab", async () => {
  const root = await makeFixtureRoot();
  try {
    const active = await staticMapSpec(root);
    active.claims = { ...active.claims, productionActivationEligible: true };
    assert.throws(() => validateMapPackageSpec(active), /productionActivationEligible muss false/);

    const operationalClaim = await staticMapSpec(root);
    operationalClaim.claims = { ...operationalClaim.claims, operationalInfraRelease: true };
    assert.throws(() => validateMapPackageSpec(operationalClaim), /operationalInfraRelease muss false/);

    const unpinned = await staticMapSpec(root);
    const style = unpinned.auxiliaryFiles.find(({ kind }) => kind === "style");
    delete style.expectedBytes;
    delete style.expectedSha256;
    assert.throws(() => validateMapPackageSpec(unpinned), /bytegenau gepinnt/);

    const projection = await staticMapSpec(root);
    projection.auxiliaryFiles.push(fixtureSpec().auxiliaryFiles.find(({ kind }) => kind === "train-map-projection"));
    assert.throws(() => validateMapPackageSpec(projection), /keine Legacy-Zugpositionsprojektion/);

    const operational = await staticMapSpec(root);
    operational.auxiliaryFiles.push(operationalV2Spec().auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2"));
    assert.throws(() => validateMapPackageSpec(operational), /kein Operational-v2-Artefakt/);

    const legacyStaticV1 = await staticMapSpec(root);
    legacyStaticV1.schema = "zugfolge-static-map-package-spec/v1";
    assert.throws(() => validateMapPackageSpec(legacyStaticV1), /Unbekanntes Kartenpaket-Schema/);

    const fallback = await staticMapSpec(root);
    fallback.cutover = { ...fallback.cutover, waypointFallback: true };
    assert.throws(() => validateMapPackageSpec(fallback), /vollstaendig abschalten/);

    const runtimeV1 = await staticMapSpec(root);
    runtimeV1.runtime = { ...runtimeV1.runtime, schema: "zugfolge-map-runtime/v1" };
    assert.throws(() => validateMapPackageSpec(runtimeV1), /zugfolge-map-runtime\/v2/);

    const forgedAssetTree = await staticMapSpec(root);
    const sourcesPath = join(root, "manifests", "sources.json");
    const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
    sources.assetNotices.assets[0].tree.sha256 = "0".repeat(64);
    await writeFile(sourcesPath, JSON.stringify(sources));
    const sourcesDescriptor = forgedAssetTree.auxiliaryFiles.find(({ kind }) => kind === "source-manifest");
    const sourcesProof = await fileProof(sourcesPath);
    sourcesDescriptor.expectedBytes = sourcesProof.bytes;
    sourcesDescriptor.expectedSha256 = sourcesProof.sha256;
    await assert.rejects(
      packMapPackage(forgedAssetTree, root, join(root, "static-map-forged-asset-tree")),
      /weicht vom lizenzierten und gepinnten Assetbaum/,
    );

    const legacyQualityV1 = await staticMapSpec(root, { legacyQualityV1: true });
    await assert.rejects(packMapPackage(legacyQualityV1, root, join(root, "static-map-quality-v1")), /kein Zugfolge-v1-Schema/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("statischer Kartenrelease bindet den oeffentlichen Releasevertrag exakt an die gepackten Kernartefakte", async () => {
  const root = await makeFixtureRoot();
  try {
    const spec = await staticMapSpec(root);
    const releasePath = join(root, "manifests", "release.json");
    const release = JSON.parse(await readFile(releasePath, "utf8"));
    release.artifacts.find(({ kind }) => kind === "infrastructure").sha256 = "a".repeat(64);
    await writeFile(releasePath, `${JSON.stringify(release)}\n`);
    const releaseDescriptor = spec.auxiliaryFiles.find(({ kind }) => kind === "release-manifest");
    const newProof = await fileProof(releasePath);
    releaseDescriptor.expectedBytes = newProof.bytes;
    releaseDescriptor.expectedSha256 = newProof.sha256;
    await assert.rejects(
      packMapPackage(spec, root, join(root, "forged-static-map-package")),
      /tatsaechlich gepackten Byte-SHA-Bindungen/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Operational-v2-Dateien oberhalb des JavaScript-Limits werden streamend rekonstruiert und nativ gebunden", async () => {
  const root = await makeFixtureRoot();
  try {
    const prefix = Buffer.from('{"id":"infra-deutschland-2026.3","padding":"', "utf8");
    const suffix = Buffer.from('"}\n', "utf8");
    const largeBytes = Buffer.concat([prefix, Buffer.alloc(33 * 1024 * 1024, 0x78), suffix]);
    const operationalPath = join(root, "manifests", "operational-infrastructure-v2.json");
    await writeFile(operationalPath, largeBytes);
    const spec = operationalV2Spec();
    spec.partBytes = 4 * 1024 * 1024;
    const operational = spec.auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2");
    operational.expectedBytes = largeBytes.length;
    operational.expectedSha256 = createHash("sha256").update(largeBytes).digest("hex");
    await pinOperationalV2Spec(root, spec);
    const nativeCalls = [];
    const operationalValidation = {
      validateOperationalInfrastructure: fixtureNativeOperationalVerifier(nativeCalls),
    };

    const packed = await packMapPackage(spec, root, join(root, "package-v2-large"), operationalValidation);
    const packagedOperational = packed.manifest.auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2");
    assert.ok(packagedOperational.bytes > 32 * 1024 * 1024);
    assert.ok(packagedOperational.parts.length > 1);
    await verifyMapPackage(packed.packageRoot, operationalValidation);
    assert.equal(nativeCalls.length, 2);
    assert.notEqual(nativeCalls[0].path, nativeCalls[1].path, "Verify muss die Paketteile in eine eigene Datei rekonstruieren.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Paketplan v2 leitet Byte- und Zustandshash ausschließlich aus dem typisierten InfraRelease-Inventar ab", async () => {
  const root = await makeFixtureRoot();
  try {
    await writeFile(join(root, "manifests", "release-artifacts.v2.json"), JSON.stringify({
      schema: "zugfolge-infra-release-artifacts/v2",
      artifacts: [{
        id: "operational-infrastructure-2026.3",
        kind: "operational-infrastructure-v2",
        file: "operational-infrastructure-v2.json",
        infraReleaseId: "infra-deutschland-2026.3",
        bytes: OPERATIONAL_BYTES.length,
        sha256: OPERATIONAL_SHA256,
        stateHash: OPERATIONAL_STATE_HASH,
      }],
    }));
    const concrete = operationalV2Spec();
    const plan = {
      schema: "zugfolge-map-package-plan/v2",
      packageId: concrete.packageId,
      version: concrete.version,
      partBytes: concrete.partBytes,
      runtime: concrete.runtime,
      artifacts: concrete.artifacts,
      auxiliaryFiles: concrete.auxiliaryFiles
        .filter(({ kind }) => !["glyph", "sprite", "operational-infrastructure-v2"].includes(kind))
        .concat([{
          id: "operational-infrastructure-2026.3",
          kind: "operational-infrastructure-v2",
          visibility: "public",
          sourceFile: "manifests/operational-infrastructure-v2.json",
          installPath: "operational-infrastructure-v2.json",
          artifactInventory: "manifests/release-artifacts.v2.json",
        }]),
      auxiliaryTrees: [
        { idPrefix: "glyph", kind: "glyph", visibility: "public", sourceDirectory: "assets/glyphs", installDirectory: "assets/glyphs", expectedInventory: { Inter: 1 } },
        { idPrefix: "sprite", kind: "sprite", visibility: "public", sourceDirectory: "assets/sprites", installDirectory: "sprites", expectedInventory: { "zugfolge.json": 1, "zugfolge.png": 1, "zugfolge@2x.json": 1, "zugfolge@2x.png": 1 } },
      ],
    };
    const expanded = await expandMapPackagePlan(plan, root);
    const operational = expanded.auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2");
    assert.equal(expanded.schema, "zugfolge-map-package-spec/v2");
    assert.equal(operational.expectedSha256, OPERATIONAL_SHA256);
    assert.equal(operational.stateHash, OPERATIONAL_STATE_HASH);
    assert.equal(Object.hasOwn(operational, "artifactInventory"), false);

    const forged = JSON.parse(await readFile(join(root, "manifests", "release-artifacts.v2.json"), "utf8"));
    forged.artifacts[0].stateHash = forged.artifacts[0].sha256;
    await writeFile(join(root, "manifests", "release-artifacts.v2.json"), JSON.stringify(forged));
    await assert.rejects(expandMapPackagePlan(plan, root), /vollständige Byte-\/Zustandsbindung/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("APN-Rohdaten und private Felder in öffentlichen Hilfsdateien blockieren das Packen", async () => {
  const root = await makeFixtureRoot();
  try {
    const readModelPath = join(root, "manifests", "read-model.sqlite");
    const privateDatabase = new DatabaseSync(readModelPath);
    try {
      privateDatabase.exec("ALTER TABLE object_details ADD COLUMN account_id TEXT");
    } finally {
      privateDatabase.close();
    }
    await assert.rejects(packMapPackage(fixtureSpec(), root, join(root, "package-private")), /Spaltenvertrag|Allowlist/);
    await rm(readModelPath, { force: true });
    writeMinimalPublicReadModel(readModelPath);
    await writeFile(join(root, "manifests", "sources.json"), JSON.stringify({ schema: "sources-public/v1", source: "interner apn export" }));
    await assert.rejects(packMapPackage(fixtureSpec(), root, join(root, "package-apn")), /APN-Rohreferenz|APN-Rohdaten/);
    await writeFile(join(root, "manifests", "sources.json"), JSON.stringify({ schema: "sources-public/v1", sources: [] }));
    await writeFile(join(root, "manifests", "quality.json"), JSON.stringify({ schema: "quality-public/v1", internalEvidenceLedgerHash: "a".repeat(64) }));
    await assert.rejects(packMapPackage(fixtureSpec(), root, join(root, "package-evidence")), /interne Evidenzkennung/);
    await writeFile(join(root, "manifests", "quality.json"), JSON.stringify({ schema: "quality-public/v1", classes: {} }));
    await writeFile(join(root, "manifests", "sources.json"), JSON.stringify({ schema: "sources-public/v1", sources: [{ name: "Trassenfinder" }] }));
    await assert.rejects(packMapPackage(fixtureSpec(), root, join(root, "package-internal-source")), /internen Validierungsquellennamen/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interne Evidenzkennungen werden auch aus PMTiles-Metadaten ausgeschlossen", async () => {
  const root = await makeFixtureRoot();
  try {
    const infrastructure = join(root, "input", "deutschland.pmtiles");
    await rm(infrastructure);
    await writeMinimalPmtiles(infrastructure, {
      layerId: "tracks",
      metadataLayerIds: INFRASTRUCTURE_VECTOR_LAYERS,
      extraMetadata: { internalEvidenceLedgerHash: "a".repeat(64) },
    });
    await assert.rejects(packMapPackage(fixtureSpec(), root, join(root, "package-internal-pmtiles")), /interne Evidenzkennung/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime-Style enthält nur die selbst gehostete Basemap; Infrastruktur bleibt separat", async () => {
  const root = await makeFixtureRoot();
  try {
    const stylePath = join(root, "assets", "styles", "zugfolge-dark.json");
    const style = JSON.parse(await readFile(stylePath, "utf8"));
    style.sources.infrastructure = { type: "vector", url: "https://tiles.example.invalid/infrastructure.json" };
    await writeFile(stylePath, JSON.stringify(style));
    await assert.rejects(packMapPackage(fixtureSpec(), root, join(root, "package-external")), /genau die Basemapquelle|externe/);

    const incomplete = fixtureSpec();
    incomplete.artifacts.find(({ kind }) => kind === "infrastructure").expectedVectorLayers = ["tracks"];
    assert.throws(() => validateMapPackageSpec(incomplete), /festgelegten infrastructure-Layervertrag/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Verzeichnisplan inventarisiert lokale Glyphen und Sprites deterministisch und explizit", async () => {
  const root = await makeFixtureRoot();
  try {
    const concrete = fixtureSpec();
    const plan = {
      schema: "zugfolge-map-package-plan/v1",
      packageId: concrete.packageId,
      version: concrete.version,
      partBytes: concrete.partBytes,
      runtime: concrete.runtime,
      artifacts: concrete.artifacts,
      auxiliaryFiles: concrete.auxiliaryFiles.filter(({ kind }) => !["glyph", "sprite"].includes(kind)),
      auxiliaryTrees: [
        { idPrefix: "glyph", kind: "glyph", visibility: "public", sourceDirectory: "assets/glyphs", installDirectory: "assets/glyphs", expectedInventory: { Inter: 1 } },
        { idPrefix: "sprite", kind: "sprite", visibility: "public", sourceDirectory: "assets/sprites", installDirectory: "sprites", expectedInventory: { "zugfolge.json": 1, "zugfolge.png": 1, "zugfolge@2x.json": 1, "zugfolge@2x.png": 1 } },
      ],
    };
    const first = await expandMapPackagePlan(plan, root);
    const second = await expandMapPackagePlan(plan, root);
    assert.deepEqual(first, second);
    assert.equal(first.auxiliaryFiles.filter(({ kind }) => kind === "glyph").length, 1);
    assert.equal(first.auxiliaryFiles.filter(({ kind }) => kind === "sprite").length, 4);
    assert.ok(first.auxiliaryFiles.every(({ sourceFile, installPath }) => !sourceFile.includes("\\") && !installPath.includes("\\")));
    plan.auxiliaryTrees[0].expectedInventory.Inter = 2;
    await assert.rejects(expandMapPackagePlan(plan, root), /exakt erwarteten Verzeichnisinventar/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("beide SQLite-Hilfsartefakte werden multipart gestreamt und mit getrennten Schemaverträgen geprüft", async () => {
  const root = await makeFixtureRoot();
  try {
    const readModelPath = join(root, "manifests", "read-model.sqlite");
    const spec = fixtureSpec();
    spec.partBytes = 4096;
    const descriptor = spec.auxiliaryFiles.find(({ kind }) => kind === "read-model");
    descriptor.sourceFile = "manifests/read-model.sqlite";
    descriptor.installPath = "read-model.sqlite";
    const packed = await packMapPackage(spec, root, join(root, "package-sqlite"));
    const packagedReadModel = packed.manifest.auxiliaryFiles.find(({ kind }) => kind === "read-model");
    const packagedProjection = packed.manifest.auxiliaryFiles.find(({ kind }) => kind === "train-map-projection");
    assert.equal(packagedReadModel.mediaType, "application/vnd.sqlite3");
    assert.equal(packagedProjection.mediaType, "application/vnd.sqlite3");
    assert.ok(packagedReadModel.parts.length > 1);
    assert.ok(packagedProjection.parts.length > 1);
    await verifyMapPackage(packed.packageRoot);
    const installed = await installMapPackage(packed.packageRoot, join(root, "installed-sqlite"));
    assert.equal(installed.status, "installed");
    assert.equal((await stat(join(root, "installed-sqlite", "read-model.sqlite"))).size, (await stat(readModelPath)).size);
    assert.equal((await stat(join(root, "installed-sqlite", "train-map-projection.sqlite"))).size, (await stat(join(root, "manifests", "train-map-projection.sqlite"))).size);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nur finale PMTiles-Dateien dürfen gepackt werden", async () => {
  const root = await makeFixtureRoot();
  try {
    await writeFile(join(root, "input", "welt.pmtiles"), "PMTiles aber kein v3-Container");
    await assert.rejects(packMapPackage(fixtureSpec(), root, join(root, "package")), /Header|PMTiles v3/);
    await assert.rejects(stat(join(root, "package")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PMTiles-v3-Magic ohne plausible Headerbereiche wird strukturell abgelehnt", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-map-package-invalid-v3-"));
  const path = join(root, "invalid.pmtiles");
  try {
    const header = Buffer.alloc(127);
    Buffer.from("PMTiles", "ascii").copy(header);
    header.writeUInt8(3, 7);
    await writeFile(path, header);
    await assert.rejects(inspectPmtilesFile(path), /Wurzelverzeichnis|PMTiles enthält keine/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PMTiles-v3-Prüfung verarbeitet BigInt-Dateioffsets oberhalb von 2 GiB ohne Vollscan", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-map-package-sparse-"));
  const path = join(root, "sparse.pmtiles");
  const tileDataOffset = 2n * 1024n * 1024n * 1024n + 4096n;
  try {
    await writeMinimalPmtiles(path, { layerId: "large-offset", tileDataOffset });
    const metadata = await stat(path, { bigint: true });
    assert.ok(metadata.size > 2n * 1024n * 1024n * 1024n);
    const inspected = await inspectPmtilesFile(path, "sparse-test");
    assert.equal(inspected.header.tileDataOffset, tileDataOffset);
    assert.deepEqual(inspected.vectorLayerIds, ["large-offset"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PMTiles-v3-Prüfung akzeptiert normgerecht umgeordnete, überlappungsfreie Bereiche", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-map-package-relocated-"));
  const path = join(root, "relocated.pmtiles");
  try {
    await writeMinimalPmtiles(path, { layerId: "relocated", metadataAfterTile: true });
    const inspected = await inspectPmtilesFile(path, "relocated-test");
    assert.ok(inspected.header.tileDataOffset < inspected.header.jsonMetadataOffset);
    assert.deepEqual(inspected.vectorLayerIds, ["relocated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI verifiziert dasselbe kanonische Paket", async () => {
  const root = await makeFixtureRoot();
  try {
    const packed = await packMapPackage(fixtureSpec(), root, join(root, "package"));
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "verify", packed.packageRoot]);
    const result = JSON.parse(stdout);
    assert.equal(result.action, "verified");
    assert.equal(result.manifestSha256, packed.manifestSha256);
    assert.equal(result.packageId, "zugfolge-map-test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI expandiert einen lokalen Verzeichnisplan ohne Kartenartefakte zu kopieren", async () => {
  const root = await makeFixtureRoot();
  try {
    const concrete = fixtureSpec();
    const plan = {
      schema: "zugfolge-map-package-plan/v1",
      packageId: concrete.packageId,
      version: concrete.version,
      partBytes: concrete.partBytes,
      runtime: concrete.runtime,
      artifacts: concrete.artifacts,
      auxiliaryFiles: concrete.auxiliaryFiles.filter(({ kind }) => !["glyph", "sprite"].includes(kind)),
      auxiliaryTrees: [
        { idPrefix: "glyph", kind: "glyph", visibility: "public", sourceDirectory: "assets/glyphs", installDirectory: "assets/glyphs", expectedInventory: { Inter: 1 } },
        { idPrefix: "sprite", kind: "sprite", visibility: "public", sourceDirectory: "assets/sprites", installDirectory: "sprites", expectedInventory: { "zugfolge.json": 1, "zugfolge.png": 1, "zugfolge@2x.json": 1, "zugfolge@2x.png": 1 } },
      ],
    };
    const planPath = join(root, "plan.json");
    const specPath = join(root, "expanded.json");
    await writeFile(planPath, JSON.stringify(plan));
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "expand", planPath, root, specPath]);
    const output = JSON.parse(stdout);
    const expanded = JSON.parse(await readFile(specPath, "utf8"));
    assert.equal(output.action, "expanded");
    assert.equal(output.auxiliaryFiles, expanded.auxiliaryFiles.length);
    assert.equal(expanded.auxiliaryFiles.filter(({ kind }) => kind === "glyph").length, 1);
    assert.equal(expanded.auxiliaryFiles.filter(({ kind }) => kind === "sprite").length, 4);
    await assert.rejects(stat(join(root, "package")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI expandiert Verzeichnisbäume direkt aus einem unveränderlichen Overlay-Bestand", async () => {
  const root = await makeFixtureRoot();
  try {
    const historicalRoot = join(root, "historical-build");
    await mkdir(historicalRoot);
    await rename(join(root, "assets"), join(historicalRoot, "assets"));
    const concrete = fixtureSpec();
    const plan = {
      schema: "zugfolge-map-package-plan/v1",
      packageId: concrete.packageId,
      version: concrete.version,
      partBytes: concrete.partBytes,
      runtime: concrete.runtime,
      artifacts: concrete.artifacts,
      auxiliaryFiles: concrete.auxiliaryFiles.filter(({ kind }) => !["glyph", "sprite"].includes(kind)),
      auxiliaryTrees: [
        { idPrefix: "glyph", kind: "glyph", visibility: "public", sourceDirectory: "assets/glyphs", installDirectory: "assets/glyphs", expectedInventory: { Inter: 1 } },
        { idPrefix: "sprite", kind: "sprite", visibility: "public", sourceDirectory: "assets/sprites", installDirectory: "sprites", expectedInventory: { "zugfolge.json": 1, "zugfolge.png": 1, "zugfolge@2x.json": 1, "zugfolge@2x.png": 1 } },
      ],
    };
    const planPath = join(root, "plan-overlay.json");
    const specPath = join(root, "expanded-overlay.json");
    await writeFile(planPath, JSON.stringify(plan));
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "expand-overlay", planPath, specPath, root, historicalRoot]);
    const output = JSON.parse(stdout);
    assert.equal(output.action, "expanded");
    assert.equal(output.sourceRoots, 2);
    assert.equal(JSON.parse(await readFile(specPath, "utf8")).auxiliaryFiles.filter(({ kind }) => kind === "glyph").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kanonische Manifestserialisierung enthält weder Quellpfade noch Transport-URLs", async () => {
  const root = await makeFixtureRoot();
  try {
    const packed = await packMapPackage(fixtureSpec(), root, join(root, "package"));
    const serialized = serializeMapPackageManifest(packed.manifest);
    assert.doesNotMatch(serialized, /sourceFile|https?:\/\//);
    assert.equal(JSON.stringify(JSON.parse(serialized)), JSON.stringify(JSON.parse(serializeMapPackageManifest(packed.manifest))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
