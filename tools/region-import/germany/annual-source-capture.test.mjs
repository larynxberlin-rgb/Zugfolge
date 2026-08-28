import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildAnnualSourceCapture } from "./annual-source-capture.mjs";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./run-annual-source-capture.mjs", import.meta.url));
const sourceIds = [
  "copernicus-dem-germany",
  "db-infrago-infrastructure-open-data",
  "geofabrik-germany-pbf",
  "gtfs-de-regional-rail",
  "openstation-enrichment",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(releaseId = "infra-deutschland-2026.3") {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-annual-capture-"));
  const sourceRoot = join(root, "sources");
  await mkdir(join(sourceRoot, "dem"), { recursive: true });
  const entries = new Map();
  for (const [id, file, text] of [
    ["db-infrago-infrastructure-open-data", "infrago.gpkg", "infrago"],
    ["geofabrik-germany-pbf", "germany.osm.pbf", "osm"],
    ["gtfs-de-regional-rail", "gtfs.zip", "gtfs"],
    ["openstation-enrichment", "openstation.xml", "openstation"],
  ]) {
    await writeFile(join(sourceRoot, file), text);
    entries.set(id, { id, kind: "file", version: "2026-test", input: file, captureFile: file, bytes: Buffer.byteLength(text), sha256: sha256(text) });
  }
  const tiles = [
    { tileId: "N50_E010", file: "one.tif", value: "one" },
    { tileId: "N51_E010", file: "two.tif", value: "two" },
  ].map(({ value, ...tile }) => ({ ...tile, bytes: Buffer.byteLength(value), sha256: sha256(value), value }));
  for (const tile of tiles) await writeFile(join(sourceRoot, "dem", tile.file), tile.value);
  const aggregate = sha256(tiles.map(({ tileId, sha256: tileHash }) => `${tileId}:${tileHash}\n`).join(""));
  const manifest = {
    schema: "zugfolge-copernicus-dem-capture/v1",
    source: { sourceId: "copernicus-dem-germany" },
    aggregateTileSha256: aggregate,
    tiles: tiles.map(({ value, ...tile }) => tile),
  };
  const manifestText = `${JSON.stringify(manifest)}\n`;
  await writeFile(join(sourceRoot, "dem-capture.json"), manifestText);
  entries.set("copernicus-dem-germany", {
    id: "copernicus-dem-germany",
    kind: "dem-tile-set",
    version: "COP-DEM-GLO-30-DGED-2021",
    manifest: "dem-capture.json",
    directory: "dem",
    captureFile: "dem",
    manifestBytes: Buffer.byteLength(manifestText),
    manifestSha256: sha256(manifestText),
    bytes: tiles.reduce((sum, { bytes }) => sum + bytes, 0),
    sha256: aggregate,
  });
  const plan = {
    schema: "zugfolge-germany-source-capture-plan/v1",
    releaseId,
    timetableYear: 2026,
    notBefore: "2026-08-24T00:00:00.000Z",
    forbiddenSourceIds: ["annual-infrastructure-master", "internal-station-plan-evidence", "station-enrichment"],
    sources: sourceIds.map((id) => entries.get(id)),
  };
  const rightsId = (id) => `rights-${id}`;
  const catalog = {
    schema: "zugfolge-germany-source-catalog/v1",
    sources: [
      ...sourceIds.map((id) => ({ id, rightsSourceId: rightsId(id), role: "release-input", shipAttribution: true })),
      { id: "annual-infrastructure-master", rightsSourceId: "trassenfinder-infrastruktur-api", role: "internal-validation", shipAttribution: false },
      { id: "internal-station-plan-evidence", rightsSourceId: "apn", role: "internal-validation", shipAttribution: false },
      { id: "station-enrichment", rightsSourceId: "stada", role: "optional-release-input", shipAttribution: true },
    ],
  };
  const rightsRegistry = {
    version: 1,
    quellen: [
      ...sourceIds.map((id) => ({ id: rightsId(id), status: "freigegeben", entscheidung: { datum: "2026-08-24", pruefer: "Test" } })),
      { id: "trassenfinder-infrastruktur-api", status: "entwicklung", entscheidung: { datum: "2026-08-24", pruefer: "Test" } },
      { id: "apn", status: "entwicklung", entscheidung: { datum: "2026-08-24", pruefer: "Test" } },
      { id: "stada", status: "freigegeben", entscheidung: { datum: "2026-08-24", pruefer: "Test" } },
    ],
  };
  return { root, sourceRoot, plan, catalog, rightsRegistry };
}

test("bindet create-new exakt die fuenf freigegebenen 2026.3-Pflichtquellen", async () => {
  const value = await fixture();
  const capture = await buildAnnualSourceCapture({
    ...value,
    capturedAt: "2026-08-24T12:00:00.000Z",
    capturePlanSha256: "a".repeat(64),
  });
  assert.equal(capture.schema, "zugfolge-source-capture/v2");
  assert.deepEqual(capture.sources.map(({ id }) => id), sourceIds);
  assert.doesNotMatch(JSON.stringify(capture), /annual-infrastructure-master|trassenfinder/iu);
});

test("akzeptiert den naechsten ganzzahligen Deutschland-2026-Jahrespatch und lehnt dreiteilige IDs ab", async () => {
  const nextPatch = await fixture("infra-deutschland-2026.4");
  const capture = await buildAnnualSourceCapture({
    ...nextPatch,
    capturedAt: "2026-08-24T12:00:00.000Z",
    capturePlanSha256: "a".repeat(64),
  });
  assert.equal(capture.releaseId, "infra-deutschland-2026.4");

  const invalid = await fixture("infra-deutschland-2026.3.1");
  await assert.rejects(
    buildAnnualSourceCapture({ ...invalid, capturedAt: "2026-08-24T12:00:00.000Z", capturePlanSha256: "a".repeat(64) }),
    /kein gueltiger Deutschland-2026-Jahrespatch/u,
  );
});

test("blockiert alte Zeitpunkte, Hashabweichungen und einen Master als Releaseinput", async () => {
  const old = await fixture();
  await assert.rejects(buildAnnualSourceCapture({ ...old, capturedAt: "2026-08-23T23:59:59.000Z", capturePlanSha256: "a".repeat(64) }), /nicht frisch/u);

  const tampered = await fixture();
  await writeFile(join(tampered.sourceRoot, "gtfs.zip"), "changed");
  await assert.rejects(buildAnnualSourceCapture({ ...tampered, capturedAt: "2026-08-24T12:00:00.000Z", capturePlanSha256: "a".repeat(64) }), /gtfs-de-regional-rail verletzt/u);

  const master = await fixture();
  master.catalog.sources.find(({ id }) => id === "annual-infrastructure-master").role = "release-input";
  await assert.rejects(buildAnnualSourceCapture({ ...master, capturedAt: "2026-08-24T12:00:00.000Z", capturePlanSha256: "a".repeat(64) }), /nicht exakt dieselben fuenf/u);
});

test("CLI schreibt nie ueber ein vorhandenes Capture", async () => {
  const value = await fixture();
  const planPath = join(value.root, "plan.json");
  const catalogPath = join(value.root, "catalog.json");
  const rightsPath = join(value.root, "rights.json");
  const output = join(value.root, "out", "source-capture.2026.3.json");
  await Promise.all([
    writeFile(planPath, JSON.stringify(value.plan)),
    writeFile(catalogPath, JSON.stringify(value.catalog)),
    writeFile(rightsPath, JSON.stringify(value.rightsRegistry)),
  ]);
  const args = [cli, planPath, catalogPath, rightsPath, value.sourceRoot, "2026-08-24T12:00:00.000Z", output];
  const first = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
  assert.equal(first.sources, 5);
  assert.equal(JSON.parse(await readFile(output, "utf8")).schema, "zugfolge-source-capture/v2");
  await assert.rejects(execFileAsync(process.execPath, args), /EEXIST|exist/iu);
});
