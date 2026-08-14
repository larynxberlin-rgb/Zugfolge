import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createMapRollbackAttestation,
  materializeMapReleaseBuildEvidence,
  preflightMapReleaseActivation,
  prepareEmptyBuildCacheRestore,
  proveBuildCacheRestore,
  serializeMapReleaseBuildEvidence,
  signMapRollbackAttestation,
  validateMapReleaseBuildEvidence,
  verifyMapReleaseBuildEvidence,
  writeBuildCacheRestoreProof,
  writeMapReleaseBuildEvidence,
} from "./map-release-build-evidence.mjs";
import { alphaHash } from "../../packages/alpha/dist/index.js";
import {
  LIVEMAP_READ_MODEL_APPLICATION_ID,
  LIVEMAP_READ_MODEL_USER_VERSION,
  PUBLIC_READ_MODEL_TABLES,
} from "./livemap-read-model.mjs";
import { serializeDeliveryJson, signMapDeliveryRelease } from "./map-delivery-release.mjs";
import {
  BASEMAP_VECTOR_LAYERS,
  INFRASTRUCTURE_VECTOR_LAYERS,
  serializeMapPackageManifest,
} from "./map-package.mjs";
import {
  TRAIN_MAP_PROJECTION_SCHEMA,
  TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID,
  TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION,
} from "./train-map-projection.mjs";

const RELEASE_ID = "infra-deutschland-2026.2";
const PREVIOUS_RELEASE_ID = "infra-deutschland-2026.1";
const EBO_SIGNAL = "signal:osm-node-42";
const LAYERS = [
  "rail_corridors",
  "operating_points",
  "stations",
  "tracks",
  "platforms",
  "switches",
  "signals",
  "blocks",
  "conflict_resources",
  "rail_context",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function write(root, path, bytes) {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  return absolute;
}

async function proof(root, path) {
  const bytes = await readFile(join(root, ...path.split("/")));
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function createReadModel(path, infrastructureReleaseId = RELEASE_ID) {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA application_id = ${LIVEMAP_READ_MODEL_APPLICATION_ID}; PRAGMA user_version = ${LIVEMAP_READ_MODEL_USER_VERSION}; PRAGMA foreign_keys = ON;`);
    for (const [table, columns] of Object.entries(PUBLIC_READ_MODEL_TABLES)) {
      database.exec(`CREATE TABLE ${table} (${columns.map((column) => `${column} TEXT NOT NULL`).join(", ")});`);
    }
    const metadata = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries({
      schema: "zugfolge-livemap-read-model-sqlite/v2",
      world_id: "00000000-0000-4000-8000-000000000014",
      infrastructure_release_id: infrastructureReleaseId,
      gtfs_service_date: "20260810",
      world_epoch: "2026-08-10T00:00:00.000Z",
      time_zone: "Europe/Berlin",
      service_start_offset_s: "0",
      repeat_every_s: "86400",
    })) metadata.run(key, value);
    database.prepare("INSERT INTO world_config (world_id, infrastructure_release_id, config_json) VALUES (?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000014", infrastructureReleaseId, "{}");
    database.prepare("INSERT INTO object_details VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000014", infrastructureReleaseId, "signal", EBO_SIGNAL, "EBO-Signal", "B", "[]");
  } finally {
    database.close();
  }
}

function createTrainProjection(path, infrastructureReleaseId = RELEASE_ID, deploymentHash = "d".repeat(64)) {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA application_id = ${TRAIN_MAP_PROJECTION_SQLITE_APPLICATION_ID};
      PRAGMA user_version = ${TRAIN_MAP_PROJECTION_SQLITE_USER_VERSION};
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
    const metadata = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries({
      schema: TRAIN_MAP_PROJECTION_SCHEMA,
      world_id: "00000000-0000-4000-8000-000000000014",
      infrastructure_release_id: infrastructureReleaseId,
      timetable_year: "2026",
      tracks_sha256: "a".repeat(64),
      corridors_sha256: "b".repeat(64),
      operational_network_sha256: "c".repeat(64),
      deployment_sha256: deploymentHash,
    })) metadata.run(key, value);
  } finally {
    database.close();
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-build-evidence-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { privateKey: rollbackPrivateKey, publicKey: rollbackPublicKey } = generateKeyPairSync("ed25519");
  const deliveryKeyId = "map-delivery-test-2026";
  const rollbackKeyId = "map-rollback-test-2026";
  const trustedDeliveryKeys = {
    [deliveryKeyId]: publicKey.export({ type: "spki", format: "pem" }),
    [rollbackKeyId]: rollbackPublicKey.export({ type: "spki", format: "pem" }),
  };
  const cached = [
    ["inputs/deutschland-2026-08-12.osm.pbf", "cache/sources/deutschland-2026-08-12.osm.pbf", Buffer.from("pinned external archive")],
    ["inputs/map-source-capture-2026.2.json", "cache/captures/map-source-capture-2026.2.json", Buffer.from('{"schema":"capture/v1"}\n')],
    ["inputs/derived-station-evidence-2026.2.json", "cache/derived/station-evidence-2026.2.json", Buffer.from('{"schema":"derived/v1"}\n')],
    ["tools/bin/osmium-1.19.1", "cache/tools/osmium-1.19.1", Buffer.from("pinned osmium binary")],
  ];
  for (const [file, , bytes] of cached) await write(root, file, bytes);
  await write(root, "tools/region-import/germany/release-2026.2.json", '{"schema":"germany-release/v1"}\n');

  const inventoryFiles = [];
  for (const [file, cacheFile] of cached) inventoryFiles.push({ path: cacheFile, ...(await proof(root, file)) });
  inventoryFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const inventory = { schema: "zugfolge-map-build-cache-inventory/v1", releaseId: RELEASE_ID, files: inventoryFiles };
  await write(root, "cache/build-cache-inventory-2026.2.json", `${JSON.stringify(inventory, null, 2)}\n`);

  const semanticLayers = [];
  for (const layer of LAYERS) {
    const file = `derived/semantic/${layer}.geojsonseq`;
    const featureId = layer === "signals" ? EBO_SIGNAL : `${layer}:fixture-1`;
    await write(root, file, `${JSON.stringify({ type: "Feature", properties: { feature_id: featureId }, geometry: null })}\n`);
    semanticLayers.push({ layer, file });
  }

  await write(root, "outputs/basemap.pmtiles", Buffer.concat([Buffer.from("PMTiles"), Buffer.alloc(256, 3)]));
  await write(root, "outputs/infra-deutschland-2026.2.pmtiles", Buffer.concat([Buffer.from("PMTiles"), Buffer.alloc(256, 1)]));
  const readModelPath = join(root, "outputs", "read-model.sqlite");
  await mkdir(dirname(readModelPath), { recursive: true });
  createReadModel(readModelPath);
  createTrainProjection(join(root, "outputs", "train-map-projection.sqlite"));
  await write(root, "outputs/style.json", `${JSON.stringify({ version: 8, sources: {}, layers: [] })}\n`);
  await write(root, "outputs/quality.json", `${JSON.stringify({
    schema: "zugfolge-final-infrastructure-quality-report/v1",
    releaseId: RELEASE_ID,
    deterministic: true,
    summary: { visibleLayers: 10, visibleFeatures: 10 },
  })}\n`);
  await write(root, "outputs/assets/fonts/fixture.pbf", "pinned glyph bytes");
  await write(root, "outputs/assets/sprites/dark.json", '{"fixture":true}\n');
  await write(root, "outputs/assets/sprites/dark.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]));
  const sources = {
    schema: "zugfolge-map-delivery-sources/v1",
    releaseId: RELEASE_ID,
    sources: [{ id: "fixture", approved: true, license: "ODbL-1.0", attribution: "OpenStreetMap; Protomaps", version: "2026.2" }],
  };
  const sourcesBytes = serializeDeliveryJson(sources);
  await write(root, "outputs/sources.json", sourcesBytes);
  const deliverySources = [
    { id: "welt-basiskarte", kind: "basemap", sourceFile: "outputs/basemap.pmtiles", installPath: "basemap.pmtiles" },
    { id: "deutschland-infrastruktur", kind: "infrastructure", sourceFile: "outputs/infra-deutschland-2026.2.pmtiles", installPath: "infra-deutschland-2026.2.pmtiles" },
    { id: "public-read-model", kind: "read-model", sourceFile: "outputs/read-model.sqlite", installPath: "read-model.sqlite" },
    { id: "train-map-projection", kind: "train-map-projection", sourceFile: "outputs/train-map-projection.sqlite", installPath: "train-map-projection.sqlite" },
    { id: "style-dark", kind: "style", sourceFile: "outputs/style.json", installPath: "style.json" },
    { id: "quality-manifest", kind: "quality-manifest", sourceFile: "outputs/quality.json", installPath: "manifests/quality.json" },
    { id: "glyph-fixture", kind: "glyph", sourceFile: "outputs/assets/fonts/fixture.pbf", installPath: "assets/fonts/fixture.pbf" },
    { id: "sprite-dark-json", kind: "sprite", sourceFile: "outputs/assets/sprites/dark.json", installPath: "assets/sprites/dark.json" },
    { id: "sprite-dark-png", kind: "sprite", sourceFile: "outputs/assets/sprites/dark.png", installPath: "assets/sprites/dark.png" },
  ];
  const deliveryArtifacts = [];
  for (const descriptor of deliverySources) deliveryArtifacts.push({
    id: descriptor.id,
    kind: descriptor.kind,
    installPath: descriptor.installPath,
    ...(await proof(root, descriptor.sourceFile)),
  });
  deliveryArtifacts.sort((left, right) => left.id.localeCompare(right.id, "en"));
  const unsignedDelivery = {
    schema: "zugfolge-map-delivery-release/v1",
    releaseId: RELEASE_ID,
    timetableYear: 2026,
    packageId: "zugfolge-map-deutschland",
    packageVersion: "2026.2",
    scope: {},
    artifacts: deliveryArtifacts,
    bindings: {
      packageManifestSchema: "zugfolge-map-package/v1",
      infraReleaseSchema: "zugfolge-infra-release/v2",
      mapReleaseSchema: "zugfolge-map-release/v1",
      sourcesSha256: sha256(sourcesBytes),
      qualitySha256: (await proof(root, "outputs/quality.json")).sha256,
    },
    approvalGates: {
      rights: { status: "passed" },
      quality: { status: "passed" },
      signature: { status: "missing" },
    },
    signature: null,
  };
  const signedDelivery = signMapDeliveryRelease(unsignedDelivery, privateKey.export({ type: "pkcs8", format: "pem" }), deliveryKeyId);
  await write(root, "outputs/release.json", serializeDeliveryJson(signedDelivery));

  const inputDescriptors = [
    { id: "osm-pbf-deutschland", kind: "source-archive", version: "2026-08-12", file: cached[0][0], cacheFile: cached[0][1] },
    { id: "map-source-capture", kind: "capture-manifest", version: "2026.2", file: cached[1][0], cacheFile: cached[1][1] },
    { id: "germany-release-spec", kind: "specification", version: "2026.2", file: "tools/region-import/germany/release-2026.2.json" },
    { id: "station-derived-input", kind: "derived-input", version: "2026.2", file: cached[2][0], cacheFile: cached[2][1] },
    { id: "build-cache-inventory", kind: "build-cache-inventory", version: "2026.2", file: "cache/build-cache-inventory-2026.2.json" },
  ];
  for (const descriptor of inputDescriptors) Object.assign(descriptor, await proof(root, descriptor.file), {
    expectedBytes: (await proof(root, descriptor.file)).bytes,
    expectedSha256: (await proof(root, descriptor.file)).sha256,
  });
  const toolProof = await proof(root, cached[3][0]);
  const spec = {
    schema: "zugfolge-map-release-build-evidence-spec/v1",
    releaseId: RELEASE_ID,
    previousReleaseId: PREVIOUS_RELEASE_ID,
    commits: { semanticExport: "1".repeat(40), mapBuild: "2".repeat(40) },
    inputs: inputDescriptors,
    tools: [
      {
        id: "osmium-tool",
        kind: "binary",
        version: "1.19.1",
        file: cached[3][0],
        cacheFile: cached[3][1],
        expectedBytes: toolProof.bytes,
        expectedSha256: toolProof.sha256,
      },
      {
        id: "gdal-pmtiles",
        kind: "oci-image",
        version: "3.13.2",
        reference: `ghcr.io/zugfolge/gdal-pmtiles@sha256:${"a".repeat(64)}`,
        digest: `sha256:${"a".repeat(64)}`,
      },
    ],
    outputs: [
      { id: "basemap", kind: "basemap-pmtiles", file: "outputs/basemap.pmtiles", installFile: "basemap.pmtiles" },
      { id: "semantic-pmtiles", kind: "semantic-pmtiles", file: "outputs/infra-deutschland-2026.2.pmtiles", installFile: "infra-deutschland-2026.2.pmtiles" },
      { id: "read-model", kind: "read-model", file: "outputs/read-model.sqlite", installFile: "read-model.sqlite" },
      { id: "train-map-projection", kind: "train-map-projection", file: "outputs/train-map-projection.sqlite", installFile: "train-map-projection.sqlite" },
      { id: "style", kind: "style", file: "outputs/style.json", installFile: "style.json" },
      { id: "delivery", kind: "delivery-manifest", file: "outputs/release.json", installFile: "manifests/release.json" },
      { id: "quality", kind: "quality-report", file: "outputs/quality.json", installFile: "manifests/quality.json" },
    ],
    regressions: {
      semanticLayers,
      forbiddenPublicTokens: ["12472736971", "signal:osm-node-12472736971"],
      requiredEboSignalFeatureIds: [EBO_SIGNAL],
    },
    buildCache: {
      inventoryInputId: "build-cache-inventory",
      objectKey: "map-build-cache/infra-deutschland-2026.2/cache.tar.zst.age",
      backupRequired: true,
      encrypted: true,
      encryptionScheme: "age-x25519",
      restoreVerification: "empty-path-full-inventory",
    },
    deployment: {
      candidateInstallPath: "releases/infra-deutschland-2026.2",
      previousInstallPath: "releases/infra-deutschland-2026.1",
      activationPointer: "active/map-release.env",
      rollbackAttestationPath: "attestations/infra-deutschland-2026.1.rollback.json",
      activationMode: "atomic-config-swap",
      retainPreviousForRollback: true,
    },
  };
  const specFile = "tools/tiles/map-release-build-evidence.annual-2026.2.spec.json";
  const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
  await write(root, specFile, specBytes);
  return {
    root,
    spec,
    specBytes,
    specFile,
    inventory,
    cached,
    deliverySources,
    deliveryKeyId,
    privateKey,
    rollbackPrivateKey,
    rollbackKeyId,
    signedDelivery,
    sources,
    trustedDeliveryKeys,
  };
}

async function materialized(value) {
  return materializeMapReleaseBuildEvidence({
    spec: value.spec,
    specBytes: value.specBytes,
    specFile: value.specFile,
    artifactRoot: value.root,
  });
}

function resignDelivery(value, delivery) {
  const { releaseHash: ignoredHash, signature: ignoredSignature, ...unsigned } = delivery;
  void ignoredHash;
  void ignoredSignature;
  unsigned.approvalGates = { ...unsigned.approvalGates, signature: { status: "missing" } };
  unsigned.signature = null;
  return signMapDeliveryRelease(unsigned, value.privateKey.export({ type: "pkcs8", format: "pem" }), value.deliveryKeyId);
}

function manifestEntry(descriptor, observed) {
  const common = {
    id: descriptor.id,
    kind: descriptor.kind,
    installPath: descriptor.installPath,
    bytes: observed.bytes,
    sha256: observed.sha256,
  };
  if (["basemap", "infrastructure"].includes(descriptor.kind)) {
    return {
      ...common,
      minZoom: descriptor.kind === "basemap" ? 0 : 4,
      maxZoom: descriptor.kind === "basemap" ? 15 : 18,
      vectorLayers: descriptor.kind === "basemap" ? BASEMAP_VECTOR_LAYERS : INFRASTRUCTURE_VECTOR_LAYERS,
      parts: [{ path: `parts/${descriptor.id}.pmtiles.part-00001`, ...observed }],
    };
  }
  const mediaType = descriptor.kind === "glyph"
    ? "application/x-protobuf"
    : descriptor.kind === "sprite" && descriptor.installPath.endsWith(".png")
      ? "image/png"
      : ["read-model", "train-map-projection"].includes(descriptor.kind)
        ? "application/vnd.sqlite3"
        : "application/json";
  return {
    ...common,
    visibility: "public",
    mediaType,
    parts: [{ path: `parts/${descriptor.id}.part-00001`, ...observed }],
  };
}

async function installPackageFixture(value, deploymentRoot, releaseId) {
  const installRoot = join(deploymentRoot, "releases", releaseId);
  const candidate = releaseId === RELEASE_ID;
  const descriptors = value.deliverySources.map((descriptor) => ({
    ...descriptor,
    installPath: descriptor.kind === "infrastructure" ? `${releaseId}.pmtiles` : descriptor.installPath,
  }));
  for (const descriptor of descriptors) {
    const target = join(installRoot, ...descriptor.installPath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    if (!candidate && descriptor.kind === "quality-manifest") {
      await writeFile(target, serializeDeliveryJson({
        schema: "zugfolge-final-infrastructure-quality-report/v1",
        releaseId,
        deterministic: true,
        summary: { visibleLayers: 10, visibleFeatures: 10 },
      }));
    } else {
      await copyFile(join(value.root, ...descriptor.sourceFile.split("/")), target);
    }
  }

  const sourceDescriptor = {
    id: "source-manifest",
    kind: "source-manifest",
    installPath: "manifests/sources.json",
  };
  const releaseDescriptor = {
    id: "release-manifest",
    kind: "release-manifest",
    installPath: "manifests/release.json",
  };
  const sourcesBytes = candidate ? serializeDeliveryJson(value.sources) : serializeDeliveryJson({ ...value.sources, releaseId });
  await write(installRoot, sourceDescriptor.installPath, sourcesBytes);
  if (candidate) {
    await write(installRoot, releaseDescriptor.installPath, serializeDeliveryJson(value.signedDelivery));
  } else {
    const artifacts = [];
    for (const descriptor of descriptors) artifacts.push({
      id: descriptor.id,
      kind: descriptor.kind,
      installPath: descriptor.installPath,
      ...(await proof(installRoot, descriptor.installPath)),
    });
    artifacts.sort((left, right) => left.id.localeCompare(right.id, "en"));
    const unsigned = {
      schema: "zugfolge-map-delivery-release/v1",
      releaseId,
      timetableYear: 2026,
      packageId: "zugfolge-map-deutschland",
      packageVersion: "2026.1",
      scope: {},
      artifacts,
      bindings: {
        packageManifestSchema: "zugfolge-map-package/v1",
        infraReleaseSchema: "zugfolge-infra-release/v2",
        mapReleaseSchema: "zugfolge-map-release/v1",
        sourcesSha256: sha256(sourcesBytes),
        qualitySha256: artifacts.find(({ kind }) => kind === "quality-manifest").sha256,
      },
      approvalGates: {
        rights: { status: "passed" },
        quality: { status: "passed" },
        signature: { status: "missing" },
      },
      signature: null,
    };
    await write(installRoot, releaseDescriptor.installPath, serializeDeliveryJson(unsigned));
  }

  const direct = [];
  for (const descriptor of [...descriptors, sourceDescriptor, releaseDescriptor]) {
    direct.push(manifestEntry(descriptor, await proof(installRoot, descriptor.installPath)));
  }
  const manifest = {
    schema: "zugfolge-map-package/v1",
    packageId: "zugfolge-map-deutschland",
    version: releaseId.endsWith(".2") ? "2026.2" : "2026.1",
    format: "directory-parts",
    partBytes: 100 * 1024 * 1024,
    runtime: {
      schema: "zugfolge-map-runtime/v1",
      publicBasePath: `/artifacts/maps/${releaseId}`,
      basemapStyleUrl: `/artifacts/maps/${releaseId}/style.json`,
      infrastructurePmtilesUrl: `/artifacts/maps/${releaseId}/${releaseId}.pmtiles`,
    },
    artifacts: direct.filter(({ kind }) => ["basemap", "infrastructure"].includes(kind)).sort((left, right) => left.id.localeCompare(right.id, "en")),
    auxiliaryFiles: direct.filter(({ kind }) => !["basemap", "infrastructure"].includes(kind)).sort((left, right) => left.id.localeCompare(right.id, "en")),
  };
  await write(installRoot, ".zugfolge-map-package.json", serializeMapPackageManifest(manifest));
  return { installRoot, manifest };
}

async function writeActivationPointer(value, deploymentRoot, releaseId = PREVIOUS_RELEASE_ID) {
  const installPath = releaseId === PREVIOUS_RELEASE_ID
    ? value.spec.deployment.previousInstallPath
    : value.spec.deployment.candidateInstallPath;
  return write(deploymentRoot, value.spec.deployment.activationPointer, [
    `MAP_RELEASE_ID=${releaseId}`,
    `MAP_RELEASE_HOST_DIR=${installPath}`,
    `MAP_BASEMAP_STYLE_URL=/artifacts/maps/${releaseId}/style.json`,
    `MAP_GERMANY_PMTILES_URL=/artifacts/maps/${releaseId}/${releaseId}.pmtiles`,
    "",
  ].join("\n"));
}

test("bindet vollständige Inputs, Werkzeuge, Commits, Ausgaben und die reale BOStrab-Regression", async () => {
  const value = await fixture();
  try {
    const evidence = await materialized(value);
    assert.equal(evidence.schema, "zugfolge-map-release-build-evidence/v1");
    assert.equal(evidence.releaseId, RELEASE_ID);
    assert.equal(evidence.inputs.length, 5);
    assert.equal(evidence.outputs.length, 7);
    assert.equal(evidence.deliveryInventory.length, 9);
    assert.equal(evidence.regressions.semanticLayers.length, 10);
    assert.equal(evidence.regressions.requiredEboSignalFeatureIds[0], EBO_SIGNAL);
    assert.equal((await verifyMapReleaseBuildEvidence(evidence, value.root)).semanticLayers, 10);
    assert.deepEqual(serializeMapReleaseBuildEvidence(evidence), serializeMapReleaseBuildEvidence(evidence));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("bricht bei latest, unversioniertem Release, fehlendem Digest und Eingabeabweichung fail-closed ab", async () => {
  const value = await fixture();
  try {
    async function materializeMutatedSpec(spec) {
      const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
      await writeFile(join(value.root, ...value.specFile.split("/")), specBytes);
      return materializeMapReleaseBuildEvidence({ spec, specBytes, specFile: value.specFile, artifactRoot: value.root });
    }

    const latest = structuredClone(value.spec);
    latest.tools[1].reference = "ghcr.io/zugfolge/gdal-pmtiles:latest";
    latest.tools[1].digest = `sha256:${"a".repeat(64)}`;
    await assert.rejects(
      materializeMutatedSpec(latest),
      /latest|OCI-Digest/,
    );

    const unversioned = structuredClone(value.spec);
    unversioned.releaseId = "infra-deutschland-unversioned";
    await assert.rejects(
      materializeMutatedSpec(unversioned),
      /Jahres-Patchrelease/,
    );

    const mismatch = structuredClone(value.spec);
    mismatch.inputs[0].expectedSha256 = "f".repeat(64);
    const mismatchBytes = Buffer.from(`${JSON.stringify(mismatch, null, 2)}\n`);
    await writeFile(join(value.root, ...value.specFile.split("/")), mismatchBytes);
    await assert.rejects(
      materializeMapReleaseBuildEvidence({ spec: mismatch, specBytes: mismatchBytes, specFile: value.specFile, artifactRoot: value.root }),
      /gepinnten Byte-SHA-Beleg/,
    );

    for (const field of ["expectedBytes", "expectedSha256"]) {
      const missing = structuredClone(value.spec);
      delete missing.inputs[3][field];
      const missingBytes = Buffer.from(`${JSON.stringify(missing, null, 2)}\n`);
      await writeFile(join(value.root, ...value.specFile.split("/")), missingBytes);
      await assert.rejects(
        materializeMapReleaseBuildEvidence({ spec: missing, specBytes: missingBytes, specFile: value.specFile, artifactRoot: value.root }),
        /verpflichtende erwartete Bytezahl|verpflichtenden erwarteten SHA-256/,
      );
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert fremde oder unvollständige SQLite-Artefakte vor der Evidence-Materialisierung", async () => {
  const cases = [
    {
      label: "ReadModel application_id",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "read-model.sqlite"));
        database.exec("PRAGMA application_id = 0");
        database.close();
      },
      error: /application_id/,
    },
    {
      label: "ReadModel user_version",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "read-model.sqlite"));
        database.exec("PRAGMA user_version = 2");
        database.close();
      },
      error: /Schema-Version|user_version/,
    },
    {
      label: "ReadModel metadata",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "read-model.sqlite"));
        database.prepare("DELETE FROM metadata WHERE key = ?").run("repeat_every_s");
        database.close();
      },
      error: /Schedule-Zeitvertrag/,
    },
    {
      label: "ReadModel tables",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "read-model.sqlite"));
        database.exec("DROP TABLE passenger_information");
        database.close();
      },
      error: /Tabellen.*Allowlist/,
    },
    {
      label: "Train projection release",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "train-map-projection.sqlite"));
        database.prepare("UPDATE metadata SET value = ? WHERE key = ?").run("infra-deutschland-2026.9", "infrastructure_release_id");
        database.close();
      },
      error: /nicht an den Buildrelease gebunden/,
    },
    {
      label: "Train projection schema",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "train-map-projection.sqlite"));
        database.prepare("UPDATE metadata SET value = ? WHERE key = ?").run("zugfolge-train-map-projection/v1", "schema");
        database.close();
      },
      error: /unbekanntes Schema/,
    },
    {
      label: "Train projection row binding",
      mutate(root) {
        const database = new DatabaseSync(join(root, "outputs", "train-map-projection.sqlite"));
        database.prepare(`
          INSERT INTO display_path_geometries
            (world_id, infrastructure_release_id, display_path_id, length_mm, geometry_json)
          VALUES (?, ?, ?, ?, ?)
        `).run("00000000-0000-4000-8000-000000000099", RELEASE_ID, "display-path:foreign", 1, "[]");
        database.close();
      },
      error: /Zeilen außerhalb seiner Welt- oder Releasebindung/,
    },
  ];

  for (const entry of cases) {
    const value = await fixture();
    try {
      entry.mutate(value.root);
      await assert.rejects(materialized(value), entry.error, entry.label);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("verweigert einen Delivery-Vertrag ohne signierte Freigabe bereits beim Evidence-Build", async () => {
  const value = await fixture();
  try {
    const { releaseHash: ignoredHash, signature: ignoredSignature, ...unsigned } = value.signedDelivery;
    void ignoredHash;
    void ignoredSignature;
    unsigned.approvalGates.signature = { status: "missing" };
    unsigned.signature = null;
    await writeFile(join(value.root, "outputs", "release.json"), serializeDeliveryJson(unsigned));
    await assert.rejects(materialized(value), /keine signierte Delivery-Freigabe/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("erkennt den bekannten BOStrab-Knoten in jedem Semantiklayer und im ReadModel", async () => {
  const layerValue = await fixture();
  try {
    await write(layerValue.root, "derived/semantic/blocks.geojsonseq", `${JSON.stringify({
      type: "Feature",
      properties: { feature_id: "block:1", boundary: "signal:osm-node-12472736971" },
      geometry: null,
    })}\n`);
    await assert.rejects(materialized(layerValue), /12472736971.*blocks/);
  } finally {
    await rm(layerValue.root, { recursive: true, force: true });
  }

  const readModelValue = await fixture();
  try {
    const database = new DatabaseSync(join(readModelValue.root, "outputs", "read-model.sqlite"));
    database.prepare("INSERT INTO object_details VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("world", RELEASE_ID, "signal", "signal:osm-node-12472736971", "BOStrab", "B", "[]");
    database.close();
    const releasePath = join(readModelValue.root, "outputs", "release.json");
    const release = JSON.parse(await readFile(releasePath, "utf8"));
    Object.assign(
      release.artifacts.find(({ kind }) => kind === "read-model"),
      await proof(readModelValue.root, "outputs/read-model.sqlite"),
    );
    await writeFile(releasePath, serializeDeliveryJson(resignDelivery(readModelValue, release)));
    await assert.rejects(materialized(readModelValue), /12472736971.*ReadModel/);
  } finally {
    await rm(readModelValue.root, { recursive: true, force: true });
  }
});

test("verweigert Evidence ohne bytegenau inventarisierte Basemap", async () => {
  const value = await fixture();
  try {
    const releasePath = join(value.root, "outputs", "release.json");
    const release = JSON.parse(await readFile(releasePath, "utf8"));
    release.artifacts = release.artifacts.filter(({ kind }) => kind !== "basemap");
    await writeFile(releasePath, serializeDeliveryJson(resignDelivery(value, release)));
    await assert.rejects(materialized(value), /genau eine Basemap|basemap.*fehlt/i);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verweigert ein als .1 etikettiertes v2/v1-Mismatch vor der Runtime-Attestation", async () => {
  const value = await fixture();
  const deploymentRoot = join(value.root, "deployment");
  try {
    await installPackageFixture(value, deploymentRoot, PREVIOUS_RELEASE_ID);
    await assert.rejects(
      createMapRollbackAttestation({
        deploymentRoot,
        previousInstallPath: value.spec.deployment.previousInstallPath,
        previousReleaseId: PREVIOUS_RELEASE_ID,
        runtimeIdentity: {
          sourceCommit: "3".repeat(40),
          imageDigest: `sha256:${"4".repeat(64)}`,
          worldDeploymentPath: join(value.root, "runtime", "alpha-world-deployment.json"),
        },
      }),
      /Rollback-ReadModel ist nicht an das vorherige Kartenrelease/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verifiziert leeren Cache-Restore und verweigert Preflight bei fehlendem Rollback oder Bytesabweichung", async () => {
  const value = await fixture();
  const deploymentRoot = join(value.root, "deployment");
  try {
    const evidence = await materialized(value);
    const restoreRoot = join(value.root, "restored-cache");
    const prepared = await prepareEmptyBuildCacheRestore(restoreRoot);
    for (const [sourceFile, cacheFile] of value.cached) {
      const target = join(restoreRoot, ...cacheFile.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(value.root, ...sourceFile.split("/")), target);
    }
    const restore = await proveBuildCacheRestore(evidence, restoreRoot);
    assert.equal(restore.proof.verifiedFiles, value.inventory.files.length);
    assert.match(restore.proof.artifactBindingSha256, /^[a-f0-9]{64}$/);
    const restoreProofPath = join(value.root, "evidence", "restore-proof.json");
    await writeBuildCacheRestoreProof(restore, restoreProofPath);
    const restoreProofBytes = await readFile(restoreProofPath);
    await write(restoreRoot, "cache/unexpected.bin", "not inventoried");
    await assert.rejects(proveBuildCacheRestore(evidence, restoreRoot), /vollständigen Evidence-Inventar/);
    await rm(join(restoreRoot, "cache", "unexpected.bin"));

    const candidatePackage = await installPackageFixture(value, deploymentRoot, RELEASE_ID);
    const previous = join(deploymentRoot, "releases", PREVIOUS_RELEASE_ID);
    await mkdir(previous, { recursive: true });
    await writeActivationPointer(value, deploymentRoot);
    const preflightArguments = {
      evidence,
      deploymentRoot,
      restoreProofBytes,
      restoreRoot,
      trustedDeliveryKeys: value.trustedDeliveryKeys,
      expectedActiveReleaseId: PREVIOUS_RELEASE_ID,
    };
    await assert.rejects(
      preflightMapReleaseActivation(preflightArguments),
      /Rollbackrelease besitzt keinen \.zugfolge-map-package\.json-Paketmarker/,
    );
    let previousPackage = await installPackageFixture(value, deploymentRoot, PREVIOUS_RELEASE_ID);
    const previousRelease = JSON.parse(await readFile(join(previousPackage.installRoot, "manifests", "release.json"), "utf8"));
    assert.equal(previousRelease.approvalGates.signature.status, "missing");
    assert.equal(previousRelease.signature, null);
    const cli = fileURLToPath(new URL("./map-release-build-evidence-cli.mjs", import.meta.url));
    const rollbackPrivateKeyPath = join(value.root, "keys", "rollback-private.pem");
    await mkdir(dirname(rollbackPrivateKeyPath), { recursive: true });
    await writeFile(rollbackPrivateKeyPath, value.rollbackPrivateKey.export({ type: "pkcs8", format: "pem" }));
    const rollbackAttestationPath = join(deploymentRoot, ...value.spec.deployment.rollbackAttestationPath.split("/"));
    const cliAttestation = spawnSync(process.execPath, [
      cli,
      "attest-rollback",
      deploymentRoot,
      value.spec.deployment.previousInstallPath,
      PREVIOUS_RELEASE_ID,
      rollbackPrivateKeyPath,
      value.rollbackKeyId,
      rollbackAttestationPath,
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(cliAttestation.status, 0, cliAttestation.stderr);
    assert.equal(JSON.parse(cliAttestation.stdout).previousReleaseId, PREVIOUS_RELEASE_ID);
    let rollbackAttestation = {
      path: rollbackAttestationPath,
      signed: JSON.parse(await readFile(rollbackAttestationPath, "utf8")),
    };
    const preflight = await preflightMapReleaseActivation(preflightArguments);
    assert.equal(preflight.activationEligible, true);
    assert.equal(preflight.rollbackEligible, false);
    assert.equal(preflight.rollbackEligibilityReason, "runtime-tuple-unbound-v1");
    assert.equal(preflight.rollbackAttestationSchema, "zugfolge-map-rollback-attestation/v1");
    assert.equal(preflight.deliveryKeyId, value.deliveryKeyId);
    assert.equal(preflight.rollbackAttestationKeyId, value.rollbackKeyId);
    assert.equal(preflight.activationState, "pre-activation");
    assert.equal(preflight.verifiedDeliveryArtifacts, evidence.deliveryInventory.length);
    const evidencePath = join(value.root, "evidence", "deployment-evidence.json");
    const trustedKeysPath = join(value.root, "evidence", "trusted-delivery-keys.json");
    await writeMapReleaseBuildEvidence(evidence, evidencePath);
    await writeFile(trustedKeysPath, `${JSON.stringify(value.trustedDeliveryKeys)}\n`);
    const cliPreflight = spawnSync(process.execPath, [
      cli,
      "preflight",
      evidencePath,
      deploymentRoot,
      restoreProofPath,
      restoreRoot,
      trustedKeysPath,
      PREVIOUS_RELEASE_ID,
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(cliPreflight.status, 0, cliPreflight.stderr);
    assert.equal(JSON.parse(cliPreflight.stdout).activationEligible, true);
    assert.equal(JSON.parse(cliPreflight.stdout).rollbackEligible, false);

    const runtimeIdentity = {
      sourceCommit: "3".repeat(40),
      imageDigest: `sha256:${"4".repeat(64)}`,
      worldDeploymentPath: join(value.root, "runtime", "alpha-world-deployment.json"),
    };
    await assert.rejects(
      createMapRollbackAttestation({
        deploymentRoot,
        previousInstallPath: value.spec.deployment.previousInstallPath,
        previousReleaseId: PREVIOUS_RELEASE_ID,
        runtimeIdentity,
      }),
      /Rollback-ReadModel ist nicht an das vorherige Kartenrelease/u,
    );

    const deployment = {
      schema: "zugfolge-alpha-world-deployment/v1",
      worldId: "00000000-0000-4000-8000-000000000014",
      worldDefinition: { epoch: "2026-08-10T00:00:00.000Z" },
      repeatEveryS: 86400,
    };
    const deploymentHash = alphaHash(deployment.schema, deployment);
    const worldSignature = signEd25519(null, Buffer.from(deploymentHash, "hex"), value.privateKey);
    const signedWorldDeployment = {
      deployment,
      deploymentHash,
      signature: { algorithm: "Ed25519", keyId: value.deliveryKeyId, valueBase64: worldSignature.toString("base64") },
    };
    await write(value.root, "runtime/alpha-world-deployment.json", `${JSON.stringify(signedWorldDeployment, null, 2)}\n`);
    await rm(previousPackage.installRoot, { recursive: true, force: true });
    const previousReadModel = join(value.root, "outputs", "read-model.sqlite");
    const previousProjection = join(value.root, "outputs", "train-map-projection.sqlite");
    await rm(previousReadModel, { force: true });
    await rm(previousProjection, { force: true });
    createReadModel(previousReadModel, PREVIOUS_RELEASE_ID);
    createTrainProjection(previousProjection, PREVIOUS_RELEASE_ID, deploymentHash);
    previousPackage = await installPackageFixture(value, deploymentRoot, PREVIOUS_RELEASE_ID);
    const runtimeUnsigned = await createMapRollbackAttestation({
      deploymentRoot,
      previousInstallPath: value.spec.deployment.previousInstallPath,
      previousReleaseId: PREVIOUS_RELEASE_ID,
      runtimeIdentity,
    });
    const runtimeSigned = signMapRollbackAttestation(
      runtimeUnsigned,
      value.rollbackPrivateKey.export({ type: "pkcs8", format: "pem" }),
      value.rollbackKeyId,
    );
    await writeFile(rollbackAttestationPath, serializeMapReleaseBuildEvidence(runtimeSigned));
    rollbackAttestation = { path: rollbackAttestationPath, signed: runtimeSigned };
    const runtimePreflight = await preflightMapReleaseActivation({ ...preflightArguments, runtimeIdentity });
    assert.equal(runtimePreflight.rollbackEligible, true);
    assert.equal(runtimePreflight.rollbackEligibilityReason, "runtime-tuple-v2-verified");
    assert.equal(runtimePreflight.rollbackAttestationSchema, "zugfolge-map-rollback-attestation/v2");
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        runtimeIdentity: { ...runtimeIdentity, sourceCommit: "5".repeat(40) },
      }),
      /Source-\/Image-\/Welt-\/Map-Runtime-Tuple weicht/u,
    );
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        runtimeIdentity: { ...runtimeIdentity, imageDigest: `sha256:${"6".repeat(64)}` },
      }),
      /Source-\/Image-\/Welt-\/Map-Runtime-Tuple weicht/u,
    );
    const alternateWorldPath = await write(value.root, "runtime/alpha-world-deployment-alternate.json", `${JSON.stringify(signedWorldDeployment)}\n`);
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        runtimeIdentity: { ...runtimeIdentity, worldDeploymentPath: alternateWorldPath },
      }),
      /Source-\/Image-\/Welt-\/Map-Runtime-Tuple weicht/u,
    );

    await assert.rejects(
      preflightMapReleaseActivation({ ...preflightArguments, restoreProofBytes: undefined, restoreProof: restore.proof }),
      /Datei-Artefakt/,
    );
    const forgedProof = structuredClone(restore.proof);
    forgedProof.artifactBindingSha256 = "f".repeat(64);
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        restoreProofBytes: serializeMapReleaseBuildEvidence(forgedProof),
      }),
      /aktuell verifizierten Restore-Artefakt/,
    );

    const restoredSource = join(restoreRoot, ...value.cached[0][1].split("/"));
    await writeFile(restoredSource, "nach Proof manipuliert");
    await assert.rejects(
      preflightMapReleaseActivation(preflightArguments),
      /vollständigen Evidence-Inventar/,
    );
    await copyFile(join(value.root, ...value.cached[0][0].split("/")), restoredSource);

    const markerBytes = await readFile(prepared.markerPath);
    const marker = JSON.parse(markerBytes.toString("utf8"));
    await writeFile(prepared.markerPath, serializeMapReleaseBuildEvidence({ ...marker, acceptedAfterRestore: true }));
    await assert.rejects(proveBuildCacheRestore(evidence, restoreRoot), /Leerpfadmarker besitzt unbekannte Felder/);
    await writeFile(prepared.markerPath, markerBytes);
    await writeFile(prepared.markerPath, serializeMapReleaseBuildEvidence({ schema: "zugfolge-map-build-cache-empty-root/v1", nonce: "00000000-0000-4000-8000-000000000000" }));
    await assert.rejects(
      preflightMapReleaseActivation(preflightArguments),
      /aktuell verifizierten Restore-Artefakt/,
    );
    await writeFile(prepared.markerPath, markerBytes);

    await writeActivationPointer(value, deploymentRoot, RELEASE_ID);
    const activeCandidate = await preflightMapReleaseActivation({
      ...preflightArguments,
      expectedActiveReleaseId: RELEASE_ID,
    });
    assert.equal(activeCandidate.activationState, "active-candidate");
    assert.equal(activeCandidate.activeReleaseId, RELEASE_ID);
    assert.equal(activeCandidate.rollbackEligible, false);
    assert.equal(activeCandidate.rollbackEligibilityReason, "runtime-identity-missing");
    const activeWithForeignRuntime = await preflightMapReleaseActivation({
      ...preflightArguments,
      expectedActiveReleaseId: RELEASE_ID,
      runtimeIdentity: { ...runtimeIdentity, sourceCommit: "5".repeat(40) },
    });
    assert.equal(activeWithForeignRuntime.rollbackEligible, false);
    assert.equal(activeWithForeignRuntime.rollbackEligibilityReason, "runtime-tuple-mismatch");
    await writeActivationPointer(value, deploymentRoot);
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        runtimeIdentity: { ...runtimeIdentity, sourceCommit: "5".repeat(40) },
      }),
      /Source-\/Image-\/Welt-\/Map-Runtime-Tuple weicht/u,
    );
    await writeActivationPointer(value, deploymentRoot, RELEASE_ID);
    await assert.rejects(preflightMapReleaseActivation(preflightArguments), /explizit erwartete Release/);
    await writeActivationPointer(value, deploymentRoot);

    const otherKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    await assert.rejects(
      preflightMapReleaseActivation({
        ...preflightArguments,
        trustedDeliveryKeys: { ...value.trustedDeliveryKeys, [value.deliveryKeyId]: otherKey },
      }),
      /keine gültige vertrauenswürdige Ed25519-Signatur/,
    );
    await assert.rejects(
      preflightMapReleaseActivation({ ...preflightArguments, trustedDeliveryKeys: {} }),
      /nicht vertrauenswürdig/,
    );

    const previousMarkerPath = join(previousPackage.installRoot, ".zugfolge-map-package.json");
    const previousMarkerBytes = await readFile(previousMarkerPath);
    const attacker = generateKeyPairSync("ed25519");
    const { attestationHash: ignoredAttestationHash, signature: ignoredAttestationSignature, ...unsignedAttestation } = rollbackAttestation.signed;
    void ignoredAttestationHash;
    void ignoredAttestationSignature;
    unsignedAttestation.approvalGate = { status: "missing" };
    unsignedAttestation.signature = null;
    const forgedAttestation = signMapRollbackAttestation(
      unsignedAttestation,
      attacker.privateKey.export({ type: "pkcs8", format: "pem" }),
      value.rollbackKeyId,
    );
    const rollbackAttestationBytes = await readFile(rollbackAttestation.path);
    await writeFile(rollbackAttestation.path, serializeMapReleaseBuildEvidence(forgedAttestation));
    await assert.rejects(
      preflightMapReleaseActivation(preflightArguments),
      /Rollback-Attestation besitzt keine gültige vertrauenswürdige Ed25519-Signatur/,
    );
    await writeFile(rollbackAttestation.path, rollbackAttestationBytes);

    const markerMutation = structuredClone(previousPackage.manifest);
    markerMutation.partBytes += 1;
    await writeFile(previousMarkerPath, serializeMapPackageManifest(markerMutation));
    await assert.rejects(preflightMapReleaseActivation(preflightArguments), /Rollback-Attestation weicht vom installierten kanonischen Paketmarker ab/);
    await writeFile(previousMarkerPath, previousMarkerBytes);

    const withoutRollbackKey = { ...value.trustedDeliveryKeys };
    delete withoutRollbackKey[value.rollbackKeyId];
    await assert.rejects(
      preflightMapReleaseActivation({ ...preflightArguments, trustedDeliveryKeys: withoutRollbackKey }),
      /Rollback-Attestation-Signaturschlüssel .* ist nicht vertrauenswürdig/,
    );

    const previousBasemap = join(previousPackage.installRoot, "basemap.pmtiles");
    const previousBasemapBytes = await readFile(previousBasemap);
    await writeFile(previousBasemap, "manipulierter Vorgänger");
    await assert.rejects(
      preflightMapReleaseActivation(preflightArguments),
      /Rollbackrelease-Artefakt welt-basiskarte ist beschädigt/,
    );
    await writeFile(previousBasemap, previousBasemapBytes);

    const unexpected = join(candidatePackage.installRoot, "nicht-inventarisiert.bin");
    await writeFile(unexpected, "nicht erlaubt");
    await assert.rejects(preflightMapReleaseActivation(preflightArguments), /Kandidatenrelease enthält die unerwartete Datei/);
    await rm(unexpected);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("ein mutiertes Evidence-Manifest bleibt auch ohne erneuten Build ungültig", async () => {
  const value = await fixture();
  try {
    const evidence = await materialized(value);
    const mutable = structuredClone(evidence);
    mutable.tools[0].version = "latest";
    assert.throws(() => validateMapReleaseBuildEvidence(mutable), /latest|unversioniert/);

    await writeFile(join(value.root, "outputs", "style.json"), '{"version":8,"changed":true}\n');
    await assert.rejects(verifyMapReleaseBuildEvidence(evidence, value.root), /Ausgabe style weicht/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("schreibt Evidence auch bei zwei parallelen Erzeugern atomar create-new", async () => {
  const value = await fixture();
  try {
    const evidence = await materialized(value);
    const output = join(value.root, "evidence", "parallel.json");
    const attempts = await Promise.allSettled([
      writeMapReleaseBuildEvidence(evidence, output),
      writeMapReleaseBuildEvidence(evidence, output),
    ]);
    assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    assert.match(String(rejected.reason), /create-new|existiert bereits/);
    assert.deepEqual(await readFile(output), serializeMapReleaseBuildEvidence(evidence));
    assert.equal((await readdir(dirname(output))).some((name) => name.includes(".building")), false);
    await assert.rejects(writeMapReleaseBuildEvidence(evidence, output), /create-new|existiert bereits/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("CLI baut und verifiziert dasselbe kanonische Evidence-Manifest und belegt den Leerpfadmarker", async () => {
  const value = await fixture();
  try {
    const cli = fileURLToPath(new URL("./map-release-build-evidence-cli.mjs", import.meta.url));
    const evidencePath = join(value.root, "evidence", "map-release-build-evidence-2026.2.json");
    const build = spawnSync(process.execPath, [cli, "build", join(value.root, ...value.specFile.split("/")), value.root, evidencePath], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(build.status, 0, build.stderr);
    assert.equal(JSON.parse(build.stdout).releaseId, RELEASE_ID);
    const verify = spawnSync(process.execPath, [cli, "verify", evidencePath, value.root], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(JSON.parse(verify.stdout).semanticLayers, 10);
    const prepare = spawnSync(process.execPath, [cli, "prepare-restore", join(value.root, "cli-restore")], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.match(JSON.parse(prepare.stdout).markerSha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
