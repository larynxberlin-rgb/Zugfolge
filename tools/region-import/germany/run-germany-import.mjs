#!/usr/bin/env node
// zugfolge:quelle=osm-pbf-deutschland
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildGermanyImportPlan, contained } from "./import-plan.mjs";

const SOURCE_CAPTURE_SCHEMA = "zugfolge-source-capture/v2";
const SOURCE_CAPTURE_KEYS = ["schema", "releaseId", "timetableYear", "capturePlanSha256", "capturedAt", "sources"];
const SOURCE_KEYS = ["id", "version", "file", "bytes", "sha256"];
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE_ID = /^infra-deutschland-(?<year>20\d{2})\.(?<patch>[1-9]\d*)$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  invariant(
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"),
    `${label} besitzt unerwartete oder fehlende Felder.`,
  );
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value !== "" && !isAbsolute(value), `${label} muss ein relativer Pfad sein.`);
  const normalized = value.replaceAll("\\", "/");
  invariant(
    normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../"),
    `${label} verlaesst die Quellwurzel.`,
  );
  return normalized;
}

export function validateGermanyImportCapture(capture) {
  exactKeys(capture, SOURCE_CAPTURE_KEYS, "Source-Capture v2");
  invariant(capture.schema === SOURCE_CAPTURE_SCHEMA, "Deutschlandimport akzeptiert ausschliesslich zugfolge-source-capture/v2.");
  const release = typeof capture.releaseId === "string" ? RELEASE_ID.exec(capture.releaseId) : null;
  invariant(
    release !== null
      && Number.isSafeInteger(capture.timetableYear)
      && capture.timetableYear === Number(release.groups.year),
    "Source-Capture v2 bindet Release-ID und Fahrplanjahr nicht widerspruchsfrei.",
  );
  invariant(SHA256.test(capture.capturePlanSha256), "Source-Capture v2 besitzt keinen gueltigen Capture-Plan-SHA-256.");
  invariant(
    typeof capture.capturedAt === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(capture.capturedAt)
      && Number.isFinite(Date.parse(capture.capturedAt)),
    "Source-Capture v2 besitzt keinen gueltigen UTC-Capture-Zeitpunkt.",
  );
  invariant(Array.isArray(capture.sources) && capture.sources.length > 0, "Source-Capture v2 besitzt keine Quellen.");
  const sourceIds = [];
  for (const source of capture.sources) {
    exactKeys(source, SOURCE_KEYS, `Capturequelle ${source?.id ?? "ohne ID"}`);
    invariant(typeof source.id === "string" && source.id.trim() !== "", "Capturequelle ohne ID.");
    invariant(typeof source.version === "string" && source.version.trim() !== "", `Capturequelle ${source.id} ohne Version.`);
    portablePath(source.file, `Capturequelle ${source.id}.file`);
    invariant(Number.isSafeInteger(source.bytes) && source.bytes > 0, `Capturequelle ${source.id} besitzt keine positive sichere Bytezahl.`);
    invariant(SHA256.test(source.sha256), `Capturequelle ${source.id} besitzt keinen gueltigen SHA-256.`);
    sourceIds.push(source.id);
  }
  const sortedSourceIds = [...sourceIds].sort((left, right) => left.localeCompare(right, "en"));
  invariant(
    JSON.stringify(sourceIds) === JSON.stringify(sortedSourceIds) && new Set(sourceIds).size === sourceIds.length,
    "Source-Capture v2 muss stabil sortierte eindeutige Quellen besitzen.",
  );
  invariant(sourceIds.filter((id) => id === "geofabrik-germany-pbf").length === 1, "Deutschland-PBF fehlt oder ist im Capture nicht eindeutig.");
  return capture;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function requireCreateNewTargets(paths) {
  for (const path of paths) {
    try {
      await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Importausgabe existiert bereits: ${path}.`);
  }
}

function executeImportStep(step) {
  const result = spawnSync(step.command, step.args, { cwd: step.cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Importschritt ${step.id} fehlgeschlagen (${result.status ?? "ohne Status"}).`);
}

export async function runGermanyImport({
  capturePath,
  sourceRootInput,
  outputRootInput,
  osmium,
  cargo,
  executeStep = executeImportStep,
}) {
  for (const [name, value] of Object.entries({ capturePath, sourceRootInput, outputRootInput, osmium, cargo })) {
    invariant(typeof value === "string" && value !== "", `${name} fehlt.`);
  }
  invariant(typeof executeStep === "function", "executeStep fehlt.");

  const capture = validateGermanyImportCapture(JSON.parse(await readFile(resolve(capturePath), "utf8")));
  const source = capture.sources.find(({ id }) => id === "geofabrik-germany-pbf");
  const sourceRoot = await realpath(resolve(sourceRootInput));
  const outputRoot = resolve(outputRootInput);
  const sourcePbf = contained(sourceRoot, source.file);
  const metadata = await lstat(sourcePbf);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), "Deutschland-PBF ist keine regulaere Datei.");
  const actualSourcePbf = await realpath(sourcePbf);
  const sourceRemainder = relative(sourceRoot, actualSourcePbf);
  invariant(
    sourceRemainder !== "" && !sourceRemainder.startsWith("..") && !isAbsolute(sourceRemainder),
    "Deutschland-PBF verlaesst die Quellwurzel ueber einen Link.",
  );
  invariant(metadata.size === source.bytes, "Deutschland-PBF verletzt die gepinnte Bytezahl.");
  const sourceSha256 = await sha256File(actualSourcePbf);
  invariant(sourceSha256 === source.sha256, `Deutschland-PBF verletzt den gepinnten SHA-256: ${sourceSha256}.`);

  await mkdir(outputRoot, { recursive: true });
  const workspace = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const plan = buildGermanyImportPlan({ osmium, cargo, workspace, sourcePbf: actualSourcePbf, outputRoot });
  const importReportPath = resolve(outputRoot, "import-report.json");
  await requireCreateNewTargets([
    plan.outputs.eboPbf,
    plan.outputs.wayFeatures,
    plan.outputs.pbfReport,
    dirname(plan.outputs.semanticReport),
    importReportPath,
  ]);

  for (const step of plan.commands) await executeStep(step);

  const outputs = [];
  for (const [kind, path] of Object.entries(plan.outputs)) {
    const outputMetadata = await lstat(path);
    invariant(outputMetadata.isFile() && !outputMetadata.isSymbolicLink(), `Importausgabe ${kind} ist keine regulaere Datei.`);
    outputs.push({ kind, file: path, bytes: outputMetadata.size, sha256: await sha256File(path) });
  }
  outputs.sort((left, right) => left.kind.localeCompare(right.kind, "en"));
  const report = {
    schema: "zugfolge-germany-import-report/v1",
    source: { id: source.id, version: source.version, bytes: source.bytes, sha256: source.sha256 },
    steps: plan.commands.map(({ id }) => id),
    outputs,
  };
  await writeFile(importReportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { report, sourceSha256, outputs, importReportPath };
}

async function main(args) {
  const [capturePath, sourceRootInput, outputRootInput, osmium, cargo, ...extra] = args;
  if (!capturePath || !sourceRootInput || !outputRootInput || !osmium || !cargo || extra.length > 0) {
    throw new Error("Aufruf: run-germany-import.mjs CAPTURE.json SOURCE_ROOT OUTPUT_ROOT OSMIUM CARGO");
  }
  const result = await runGermanyImport({ capturePath, sourceRootInput, outputRootInput, osmium, cargo });
  process.stdout.write(`${JSON.stringify({ sourceSha256: result.sourceSha256, outputs: result.outputs.length })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
