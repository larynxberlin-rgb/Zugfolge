import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runGermanyImport, validateGermanyImportCapture } from "./run-germany-import.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function source(id, file, bytes = 1, hash = "b".repeat(64)) {
  return { id, version: "2026-test", file, bytes, sha256: hash };
}

function capture(pbfBytes) {
  return {
    schema: "zugfolge-source-capture/v2",
    releaseId: "infra-deutschland-2026.5",
    timetableYear: 2026,
    capturePlanSha256: "a".repeat(64),
    capturedAt: "2026-12-13T00:00:00.000Z",
    sources: [
      source("copernicus-dem-germany", "annual-2026.5/dem-capture.json"),
      source("db-infrago-infrastructure-open-data", "annual-2026.5/infrago.gpkg"),
      source("geofabrik-germany-pbf", "annual-2026.5/germany.osm.pbf", pbfBytes.length, sha256(pbfBytes)),
      source("gtfs-de-regional-rail", "annual-2026.5/gtfs.zip"),
      source("openstation-enrichment", "annual-2026.5/openstation.xml"),
    ],
  };
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-germany-import-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "sources");
  const outputRoot = join(root, "derived");
  const pbfBytes = Buffer.from("pinned germany pbf\n");
  const pbfPath = join(sourceRoot, "annual-2026.5", "germany.osm.pbf");
  await mkdir(dirname(pbfPath), { recursive: true });
  await writeFile(pbfPath, pbfBytes);
  const capturePath = join(root, "capture.json");
  const captureValue = capture(pbfBytes);
  await writeFile(capturePath, `${JSON.stringify(captureValue, null, 2)}\n`, "utf8");
  return { root, sourceRoot, outputRoot, capturePath, captureValue };
}

function outputArgument(step) {
  const index = step.args.indexOf("-o");
  assert.notEqual(index, -1);
  return step.args[index + 1];
}

function materializer(calls) {
  return async (step) => {
    calls.push(step.id);
    if (step.id === "ebo-filter") {
      await writeFile(outputArgument(step), "filtered pbf\n", { flag: "wx" });
    } else if (step.id === "geojson-sequence") {
      await writeFile(outputArgument(step), "{\"type\":\"Feature\"}\n", { flag: "wx" });
    } else if (step.id === "topology-report") {
      await writeFile(step.args.at(-1), "{\"schema\":\"zugfolge-pbf-release-report/v1\"}\n", { flag: "wx" });
    } else if (step.id === "semantic-export") {
      const directory = step.args.at(-1);
      await mkdir(directory);
      await writeFile(join(directory, "semantic-export-report.json"), "{\"schema\":\"fixture\"}\n", { flag: "wx" });
    } else {
      assert.fail(`Unerwarteter Importschritt ${step.id}.`);
    }
  };
}

test("Deutschlandimport akzeptiert den streng gepinnten Jahres-Capture v2", async (context) => {
  const value = await fixture(context);
  const calls = [];
  const result = await runGermanyImport({
    capturePath: value.capturePath,
    sourceRootInput: value.sourceRoot,
    outputRootInput: value.outputRoot,
    osmium: "osmium",
    cargo: "cargo",
    executeStep: materializer(calls),
  });
  assert.deepEqual(calls, ["ebo-filter", "geojson-sequence", "topology-report", "semantic-export"]);
  assert.equal(result.sourceSha256, value.captureValue.sources[2].sha256);
  assert.equal(result.outputs.length, 4);
  const report = JSON.parse(await readFile(result.importReportPath, "utf8"));
  assert.equal(report.schema, "zugfolge-germany-import-report/v1");
  assert.equal(report.source.id, "geofabrik-germany-pbf");
  assert.deepEqual(report.steps, calls);
});

test("Deutschlandimport weist v1, unbekannte Felder und widerspruechliche v2-Bindungen ab", () => {
  const pbfBytes = Buffer.from("pbf");
  const valid = capture(pbfBytes);
  assert.equal(validateGermanyImportCapture(valid), valid);
  assert.throws(
    () => validateGermanyImportCapture({ ...valid, schema: "zugfolge-source-capture/v1" }),
    /ausschliesslich zugfolge-source-capture\/v2/,
  );
  assert.throws(() => validateGermanyImportCapture({ ...valid, unknown: true }), /unerwartete oder fehlende Felder/);
  assert.throws(
    () => validateGermanyImportCapture({ ...valid, timetableYear: 2027 }),
    /Release-ID und Fahrplanjahr/,
  );
  const sourcesWithUnknown = valid.sources.map((entry, index) => index === 2 ? { ...entry, unknown: true } : entry);
  assert.throws(
    () => validateGermanyImportCapture({ ...valid, sources: sourcesWithUnknown }),
    /unerwartete oder fehlende Felder/,
  );
});

test("Deutschlandimport startet keinen Prozess bei verletzter PBF-Pinnung", async (context) => {
  const value = await fixture(context);
  value.captureValue.sources[2].bytes += 1;
  await writeFile(value.capturePath, `${JSON.stringify(value.captureValue, null, 2)}\n`, "utf8");
  let calls = 0;
  await assert.rejects(
    runGermanyImport({
      capturePath: value.capturePath,
      sourceRootInput: value.sourceRoot,
      outputRootInput: value.outputRoot,
      osmium: "osmium",
      cargo: "cargo",
      executeStep: () => { calls += 1; },
    }),
    /gepinnte Bytezahl/,
  );
  assert.equal(calls, 0);
  await assert.rejects(access(value.outputRoot), { code: "ENOENT" });
});

test("jede Importausgabe ist create-new und vorhandene Ziele bleiben unveraendert", async (context) => {
  const targets = [
    { relative: "germany-ebo.osm.pbf", directory: false },
    { relative: "germany-ebo.geojsonseq", directory: false },
    { relative: "pbf-release-report.json", directory: false },
    { relative: "semantic", directory: true },
    { relative: "import-report.json", directory: false },
  ];
  for (const target of targets) {
    await context.test(target.relative, async (subtest) => {
      const value = await fixture(subtest);
      const targetPath = join(value.outputRoot, target.relative);
      const sentinelPath = target.directory ? join(targetPath, "sentinel.txt") : targetPath;
      await mkdir(dirname(sentinelPath), { recursive: true });
      await writeFile(sentinelPath, "unveraendert\n", "utf8");
      let calls = 0;
      await assert.rejects(
        runGermanyImport({
          capturePath: value.capturePath,
          sourceRootInput: value.sourceRoot,
          outputRootInput: value.outputRoot,
          osmium: "osmium",
          cargo: "cargo",
          executeStep: () => { calls += 1; },
        }),
        /Importausgabe existiert bereits/,
      );
      assert.equal(calls, 0);
      assert.equal(await readFile(sentinelPath, "utf8"), "unveraendert\n");
    });
  }
});
