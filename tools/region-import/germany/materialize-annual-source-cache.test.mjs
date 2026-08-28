import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { materializeAnnualSourceCache } from "./materialize-annual-source-cache.mjs";

const SOURCE_ID = "copernicus-dem-germany";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function aggregateTileHash(tiles) {
  return sha256(tiles.map(({ tileId, sha256: tileSha256 }) => `${tileId}:${tileSha256}\n`).join(""));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-annual-source-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const captureRoot = join(root, "capture");
  const targetRoot = join(root, "cache");
  await mkdir(captureRoot);
  await mkdir(targetRoot);

  const [planJson, catalogJson, rightsJson] = await Promise.all([
    readFile(new URL("./source-capture.annual-2026.5.plan.json", import.meta.url), "utf8"),
    readFile(new URL("./source-catalog.json", import.meta.url), "utf8"),
    readFile(new URL("../../guards/quellenregister.json", import.meta.url), "utf8"),
  ]);
  const plan = JSON.parse(planJson);
  const catalog = JSON.parse(catalogJson);
  const rightsRegistry = JSON.parse(rightsJson);
  const source = plan.sources.find(({ id }) => id === SOURCE_ID);
  const values = [Buffer.from("alpha-dem\n"), Buffer.from("beta-dem\n")];
  const tiles = values.map((bytes, index) => ({
    tileId: `N5${index}_00_E01${index}_00`,
    objectKey: `object-${index}`,
    file: `tile-${index}.tif`,
    bytes: bytes.length,
    sha256: sha256(bytes),
    etag: `etag-${index}`,
    lastModified: "2026-08-26T00:00:00.000Z",
  }));
  const aggregate = aggregateTileHash(tiles);
  const manifest = {
    schema: "zugfolge-copernicus-dem-capture/v1",
    source: {
      sourceId: SOURCE_ID,
      rightsSourceId: "dem-hoehenmodell",
      product: "COP-DEM-GLO-30-DGED",
      release: "2021",
      resolutionArcSeconds: 1,
      rasterKind: "digital-surface-model",
      bucket: "copernicus-dem-30m",
      attribution: "fixture",
    },
    input: { west: 5, south: 47, east: 16, north: 55 },
    tiles,
    aggregateTileSha256: aggregate,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  source.manifestBytes = manifestBytes.length;
  source.manifestSha256 = sha256(manifestBytes);
  source.bytes = values.reduce((sum, bytes) => sum + bytes.length, 0);
  source.sha256 = aggregate;
  const planBytes = Buffer.from(`${JSON.stringify(plan)}\n`);
  const capturePlanSha256 = sha256(planBytes);
  const capture = {
    schema: "zugfolge-source-capture/v2",
    releaseId: plan.releaseId,
    timetableYear: plan.timetableYear,
    capturePlanSha256,
    capturedAt: "2026-08-27T00:00:00.000Z",
    sources: plan.sources.map((entry) => ({
      id: entry.id,
      version: entry.version,
      file: entry.captureFile,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
  };

  const sourceManifest = join(captureRoot, source.manifest);
  const targetManifest = join(targetRoot, source.manifest);
  await mkdir(dirname(sourceManifest), { recursive: true });
  await mkdir(dirname(targetManifest), { recursive: true });
  await writeFile(sourceManifest, manifestBytes);
  await writeFile(targetManifest, manifestBytes);
  const sourceDirectory = join(captureRoot, source.directory);
  await mkdir(sourceDirectory);
  for (const [index, bytes] of values.entries()) await writeFile(join(sourceDirectory, tiles[index].file), bytes);

  return {
    root,
    captureRoot,
    targetRoot,
    plan,
    catalog,
    rightsRegistry,
    capture,
    capturePlanSha256,
    source,
    values,
    tiles,
  };
}

function materialize(value, overrides = {}) {
  return materializeAnnualSourceCache({
    plan: value.plan,
    catalog: value.catalog,
    rightsRegistry: value.rightsRegistry,
    capture: value.capture,
    capturePlanSha256: value.capturePlanSha256,
    captureRoot: value.captureRoot,
    targetRoot: value.targetRoot,
    sourceId: SOURCE_ID,
    ...overrides,
  });
}

test("materialisiert ausschliesslich manifestgebundene DEM-Kacheln atomar create-new", async (t) => {
  const value = await fixture(t);
  const receipt = await materialize(value);
  assert.equal(receipt.schema, "zugfolge-annual-source-cache-materialization/v1");
  assert.equal(receipt.releaseId, "infra-deutschland-2026.5");
  assert.equal(receipt.sourceId, SOURCE_ID);
  assert.equal(receipt.artifactCount, 2);
  assert.equal(receipt.bytes, value.source.bytes);
  assert.equal(receipt.sha256, value.source.sha256);
  for (const [index, tile] of value.tiles.entries()) {
    assert.deepEqual(await readFile(join(value.targetRoot, value.source.directory, tile.file)), value.values[index]);
  }
  await writeFile(join(value.targetRoot, value.source.directory, value.tiles[0].file), "changed\n");
  assert.deepEqual(await readFile(join(value.captureRoot, value.source.directory, value.tiles[0].file)), value.values[0]);
});

test("verweigert eine Hashabweichung vor der ersten Zielveroeffentlichung", async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.captureRoot, value.source.directory, value.tiles[1].file), "tampered!\n");
  await assert.rejects(materialize(value), /Bytezahl|Byte-\/SHA-Bindung/u);
  await assert.rejects(lstat(join(value.targetRoot, value.source.directory)), { code: "ENOENT" });
});

test("verweigert ein bereits existierendes Zielverzeichnis create-new", async (t) => {
  const value = await fixture(t);
  const targetDirectory = join(value.targetRoot, value.source.directory);
  await mkdir(targetDirectory);
  await writeFile(join(targetDirectory, value.tiles[0].file), "keep\n");
  await assert.rejects(materialize(value), /existiert bereits|create-new/u);
  assert.equal(await readFile(join(targetDirectory, value.tiles[0].file), "utf8"), "keep\n");
});

test("verweigert einen Junction- oder Symlink-Reparse-Pfad am Ziel", async (t) => {
  const value = await fixture(t);
  const outside = join(value.root, "outside");
  await mkdir(outside);
  await symlink(outside, join(value.targetRoot, value.source.directory), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(materialize(value), /symbolischen Link|Junction|Reparse/u);
});

test("rollt alle eigenen Ziele bei einem spaeten Publish-Fehler zurueck", async (t) => {
  const value = await fixture(t);
  let calls = 0;
  const publishLink = async (source, target) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("injected publish failure"), { code: "EIO" });
    return link(source, target);
  };
  await assert.rejects(materialize(value, { publishLink }), /injected publish failure/u);
  await assert.rejects(lstat(join(value.targetRoot, value.source.directory)), { code: "ENOENT" });
});

test("verweigert Capture-, Plan- und Cachemanifest-Drift", async (t) => {
  const captureDrift = await fixture(t);
  captureDrift.capture.capturePlanSha256 = "0".repeat(64);
  await assert.rejects(materialize(captureDrift), /Plandatei/u);

  const manifestDrift = await fixture(t);
  await writeFile(join(manifestDrift.targetRoot, manifestDrift.source.manifest), Buffer.alloc(manifestDrift.source.manifestBytes, 0x78));
  await assert.rejects(materialize(manifestDrift), /DEM-Cachemanifest.*Byte-\/SHA-Bindung/u);
  await assert.rejects(lstat(join(manifestDrift.targetRoot, manifestDrift.source.directory)), { code: "ENOENT" });
});
