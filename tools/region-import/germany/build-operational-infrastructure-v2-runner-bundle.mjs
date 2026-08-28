#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../../..");
const ENTRYPOINT = join(HERE, "run-capture-operational-infrastructure-v2.mjs");
const OUTPUT = join(HERE, "run-capture-operational-infrastructure-v2.anchored-bundle.mjs");
const SOURCE_CONTEXT = "source-noneligible-v1";
const ANCHORED_CONTEXT = "anchored-stdin-bundle-v1";
const ESBUILD_VERSION = "0.28.1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadPinnedEsbuild() {
  const pnpmStore = join(REPOSITORY_ROOT, "node_modules", ".pnpm");
  const candidates = (await readdir(pnpmStore, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name === `esbuild@${ESBUILD_VERSION}`)
    .map((entry) => join(pnpmStore, entry.name, "node_modules", "esbuild"));
  invariant(candidates.length === 1, `Bundle-Build erwartet exakt esbuild ${ESBUILD_VERSION} aus dem gepinnten pnpm-Lock.`);
  const packageValue = JSON.parse(await readFile(join(candidates[0], "package.json"), "utf8"));
  invariant(packageValue.version === ESBUILD_VERSION, `Bundle-Build fand nicht esbuild ${ESBUILD_VERSION}.`);
  return import(pathToFileURL(join(candidates[0], "lib", "main.js")).href);
}

function anchoredOutput(source, expectedContextMarkers) {
  const markerCount = source.split(SOURCE_CONTEXT).length - 1;
  invariant(markerCount === expectedContextMarkers, `Runner-Bundle enthaelt ${markerCount} statt exakt ${expectedContextMarkers} Build-Kontextmarker.`);
  const output = source.replaceAll(SOURCE_CONTEXT, ANCHORED_CONTEXT).replaceAll("\r\n", "\n");
  invariant(!output.includes(SOURCE_CONTEXT), "Runner-Bundle enthaelt noch den nicht releasefaehigen Quellkontext.");
  return output.endsWith("\n") ? output : `${output}\n`;
}

function assertSelfContainedBundle(metafile) {
  const outputs = Object.values(metafile.outputs);
  invariant(outputs.length === 1, "Runner-Build muss exakt ein selbstenthaltenes Bundle erzeugen.");
  for (const imported of outputs[0].imports) {
    invariant(imported.external === true && imported.kind === "import-statement" && imported.path.startsWith("node:"),
      `Runner-Bundle enthaelt eine nicht erlaubte Laufzeitkante ${imported.kind}:${imported.path}.`);
  }
}

export async function buildGermanyOperationalAnchoredBundleFromEntrypoint({
  entrypoint,
  expectedContextMarkers,
}) {
  const { build } = await loadPinnedEsbuild();
  const result = await build({
    absWorkingDir: REPOSITORY_ROOT,
    bundle: true,
    charset: "utf8",
    entryPoints: [resolve(entrypoint)],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    minify: false,
    platform: "node",
    sourcemap: false,
    target: "node24",
    treeShaking: true,
    write: false,
  });
  invariant(result.outputFiles.length === 1, "Runner-Build erzeugte nicht exakt eine Ausgabedatei.");
  assertSelfContainedBundle(result.metafile);
  return Buffer.from(anchoredOutput(result.outputFiles[0].text, expectedContextMarkers), "utf8");
}

export async function buildGermanyOperationalAnchoredRunnerBundle() {
  return buildGermanyOperationalAnchoredBundleFromEntrypoint({
    entrypoint: ENTRYPOINT,
    expectedContextMarkers: 2,
  });
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  const bytes = await buildGermanyOperationalAnchoredRunnerBundle();
  await writeFile(OUTPUT, bytes);
  process.stdout.write(`${OUTPUT}\n`);
}
