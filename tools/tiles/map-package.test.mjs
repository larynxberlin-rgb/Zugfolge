import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LIVEMAP_READ_MODEL_APPLICATION_ID, LIVEMAP_READ_MODEL_USER_VERSION, PUBLIC_READ_MODEL_TABLES } from "./livemap-read-model.mjs";
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
} from "./map-package.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("./map-package-cli.mjs", import.meta.url));

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
  ]);
  writeMinimalPublicReadModel(join(root, "manifests", "read-model.sqlite"));
  writeMinimalTrainMapProjection(join(root, "manifests", "train-map-projection.sqlite"));
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

async function writeMinimalPmtiles(path, { layerId, metadataLayerIds, tileDataOffset, metadataAfterTile = false } = {}) {
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
