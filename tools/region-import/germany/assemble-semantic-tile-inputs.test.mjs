import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assembleSemanticTileInputs } from "./assemble-semantic-tile-inputs.mjs";

const LAYERS = Object.freeze([
  ["rail_corridors", "rail-corridors.geojsonseq"],
  ["operating_points", "operating-points.geojsonseq"],
  ["stations", "stations.geojsonseq"],
  ["tracks", "tracks.geojsonseq"],
  ["platforms", "platforms.geojsonseq"],
  ["switches", "switches.geojsonseq"],
  ["signals", "signals.geojsonseq"],
  ["blocks", "blocks.geojsonseq"],
  ["conflict_resources", "conflict-resources.geojsonseq"],
  ["rail_context", "rail-context.geojsonseq"],
]);

function sequence(id) {
  return `\x1e${JSON.stringify({
    type: "Feature",
    properties: { feature_id: id },
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
  })}\n`;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-semantic-assembly-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = join(root, "sources");
  await mkdir(sources);
  for (const [name, file] of LAYERS) await writeFile(join(sources, file), sequence(`${name}:1`), "utf8");
  const outputDirectory = join(root, "assembled");
  return {
    root,
    sources,
    outputDirectory,
    configuration: {
      schema: "zugfolge-semantic-tile-assembly/v1",
      allowedSourceRoots: [sources],
      outputDirectory,
      railCorridors: join(sources, "rail-corridors.geojsonseq"),
      operatingPoints: join(sources, "operating-points.geojsonseq"),
      stations: join(sources, "stations.geojsonseq"),
      finalMapLayers: {
        tracks: join(sources, "tracks.geojsonseq"),
        platforms: join(sources, "platforms.geojsonseq"),
        switches: join(sources, "switches.geojsonseq"),
        signals: join(sources, "signals.geojsonseq"),
        blocks: join(sources, "blocks.geojsonseq"),
        conflictResources: join(sources, "conflict-resources.geojsonseq"),
      },
      railContext: join(sources, "rail-context.geojsonseq"),
    },
  };
}

async function pathExists(path) {
  return Boolean(await lstat(path).catch(() => null));
}

test("assembliert alle zehn semantischen Layer atomar mit Manifest", async (t) => {
  const setup = await fixture(t);
  const result = await assembleSemanticTileInputs(setup.configuration);

  assert.deepEqual(result, { outputDirectory: setup.outputDirectory, layers: 10 });
  assert.equal(await pathExists(`${setup.outputDirectory}.building`), false);
  for (const [name, file] of LAYERS) {
    assert.equal(await readFile(join(setup.outputDirectory, file), "utf8"), sequence(`${name}:1`));
  }
  assert.deepEqual(JSON.parse(await readFile(join(setup.outputDirectory, "inputs.json"), "utf8")), {
    schema: "zugfolge-semantic-tile-inputs/v1",
    layers: LAYERS.map(([name, file]) => ({ name, file, stableFeatureIdProperty: "feature_id" })),
  });
});

test("weist ein vorhandenes Ziel ab und laesst es unveraendert", async (t) => {
  const setup = await fixture(t);
  await mkdir(setup.outputDirectory);
  const sentinel = join(setup.outputDirectory, "do-not-touch.txt");
  await writeFile(sentinel, "bestehend\n", "utf8");

  await assert.rejects(assembleSemanticTileInputs(setup.configuration), /Ziel .* existiert bereits/u);
  assert.equal(await readFile(sentinel, "utf8"), "bestehend\n");
  assert.equal(await pathExists(`${setup.outputDirectory}.building`), false);
});

test("weist einen parallelen Building-Pfad ab und veraendert ihn nicht", async (t) => {
  const setup = await fixture(t);
  const staging = `${setup.outputDirectory}.building`;
  await mkdir(staging);
  const sentinel = join(staging, "parallel.txt");
  await writeFile(sentinel, "anderer Build\n", "utf8");

  await assert.rejects(assembleSemanticTileInputs(setup.configuration), /Paralleler Tile-Assembly-Build/u);
  assert.equal(await readFile(sentinel, "utf8"), "anderer Build\n");
  assert.equal(await pathExists(setup.outputDirectory), false);
});

test("weist eine Symlink-Quelle fail-closed ab", async (t) => {
  const setup = await fixture(t);
  const target = setup.configuration.railCorridors;
  const link = join(setup.sources, "rail-corridors-link.geojsonseq");
  try {
    await symlink(target, link, "file");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOSYS", "UNKNOWN"].includes(error?.code)) {
      t.skip(`Symlinks werden auf dieser Plattform nicht zugelassen (${error.code}).`);
      return;
    }
    throw error;
  }
  setup.configuration.railCorridors = link;

  await assert.rejects(assembleSemanticTileInputs(setup.configuration), /Symlink/u);
  assert.equal(await pathExists(setup.outputDirectory), false);
  assert.equal(await pathExists(`${setup.outputDirectory}.building`), false);
});

test("weist Quellen ausserhalb der zugelassenen Wurzeln ab", async (t) => {
  const setup = await fixture(t);
  const outside = join(setup.root, "outside.geojsonseq");
  await writeFile(outside, sequence("rail_corridors:outside"), "utf8");
  setup.configuration.railCorridors = outside;

  await assert.rejects(assembleSemanticTileInputs(setup.configuration), /ausserhalb der zugelassenen Quellwurzeln/u);
  assert.equal(await pathExists(setup.outputDirectory), false);
  assert.equal(await pathExists(`${setup.outputDirectory}.building`), false);
});

test("weist eine leere Sequenz ab und publiziert kein Teilziel", async (t) => {
  const setup = await fixture(t);
  await writeFile(setup.configuration.finalMapLayers.signals, "", "utf8");

  await assert.rejects(assembleSemanticTileInputs(setup.configuration), /nichtleere Datei/u);
  assert.equal(await pathExists(setup.outputDirectory), false);
  assert.equal(await pathExists(`${setup.outputDirectory}.building`), false);
});

test("weist syntaktisch ungueltige Sequenzen ab und publiziert kein Teilziel", async (t) => {
  const setup = await fixture(t);
  await writeFile(setup.configuration.finalMapLayers.blocks, "{kein-json}\n", "utf8");

  await assert.rejects(assembleSemanticTileInputs(setup.configuration), /keine gueltige GeoJSON-Sequenz/u);
  assert.equal(await pathExists(setup.outputDirectory), false);
  assert.equal(await pathExists(`${setup.outputDirectory}.building`), false);
});
