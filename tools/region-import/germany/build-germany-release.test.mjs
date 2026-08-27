import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = join(root, "tools/region-import/germany/build-germany-release.mjs");

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-germany-build-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    config: join(directory, "config.json"),
    pbfReport: join(directory, "pbf-report.json"),
    ways: join(directory, "ways.geojsonseq"),
    corpus: join(directory, "out", "corpus.jsonseq"),
    quality: join(directory, "out", "quality.json"),
    evidence: join(directory, "out", "internal-evidence.json"),
  };
  const config = {
    quality: {
      safeAssumptions: {
        unknownMainlineSpeedKmh: 20,
        unknownServiceSpeedKmh: 10,
        unknownGradientAbsPermille: 40,
      },
    },
  };
  const pbfReport = {
    schema: "zugfolge-pbf-release-report/v1",
    derivations: {
      blocks: [{ edgeId: 7, sourceWayId: 42, lengthMm: 1_000, fromNodeId: 1, toNodeId: 2, boundarySignalCount: 0 }],
    },
  };
  const way = {
    type: "Feature",
    id: "way/42",
    geometry: { type: "LineString", coordinates: [[10, 50], [10.01, 50.01]] },
    properties: { railway: "rail" },
  };
  await Promise.all([
    writeFile(paths.config, `${JSON.stringify(config)}\n`, "utf8"),
    writeFile(paths.pbfReport, `${JSON.stringify(pbfReport)}\n`, "utf8"),
    writeFile(paths.ways, `\x1e${JSON.stringify(way)}\n`, "utf8"),
  ]);
  return paths;
}

async function compile(paths) {
  return await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [
      script,
      "compile",
      paths.config,
      paths.pbfReport,
      paths.ways,
      "-",
      paths.corpus,
      paths.quality,
      paths.evidence,
    ], {
      cwd: root,
      env: { ...process.env, ZUGFOLGE_NON_AUTHORITATIVE_CORPUS_BUILD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => accept({ code, stdout, stderr }));
  });
}

test("nichtautoritative Korpusausgaben werden einmalig create-new erzeugt", async (context) => {
  const paths = await fixture(context);
  const result = await compile(paths);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sections, 1);
  assert.match(await readFile(paths.corpus, "utf8"), /de-edge-7/);
  assert.equal(JSON.parse(await readFile(paths.quality, "utf8")).report.schema, "zugfolge-infrastructure-quality-report/v2");
  assert.equal(JSON.parse(await readFile(paths.evidence, "utf8")).schema, "zugfolge-internal-evidence-bindings/v1");
});

test("vorhandene Korpus-, Qualitaets- oder Evidenzausgabe blockiert vor jedem Schreiben", async (context) => {
  for (const key of ["corpus", "quality", "evidence"]) {
    await context.test(key, async (subtest) => {
      const paths = await fixture(subtest);
      await mkdir(dirname(paths[key]), { recursive: true });
      await writeFile(paths[key], "unveraendert\n", "utf8");
      const result = await compile(paths);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Release-Ausgabe existiert bereits/);
      assert.equal(await readFile(paths[key], "utf8"), "unveraendert\n");
      for (const other of ["corpus", "quality", "evidence"].filter((candidate) => candidate !== key)) {
        await assert.rejects(access(paths[other]), { code: "ENOENT" });
      }
    });
  }
});
