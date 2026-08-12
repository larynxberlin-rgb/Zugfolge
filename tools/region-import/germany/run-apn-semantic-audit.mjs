#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditCapturedStationPlans } from "./apn-semantic-audit.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function usage() {
  return [
    "Aufruf:",
    "  run-apn-semantic-audit.mjs --evidence-root ABSOLUT --operating-points FILE --signals FILE --switches FILE --platforms FILE --python EXE [Optionen]",
    "",
    "Optionen:",
    "  --rl100 CODE           Wiederholbarer RL100-Filter",
    "  --max-records N        Deterministisch nach RL100 begrenzen",
    "  --batch-size N         Höchstens N neue Dokumente je Lauf",
    "  --retry-failed         Persistierte Parserfehler erneut versuchen",
    "  --radius-m N           Vergleichsradius, Standard 1500 m",
    "  --timeout-ms N         Extraktions-Timeout je Dokument, Standard 180000 ms",
  ].join("\n");
}

function parseArguments(values) {
  const repeating = new Set(["rl100"]);
  const flags = new Set(["retry-failed"]);
  const allowed = new Set([
    "evidence-root", "operating-points", "signals", "switches", "platforms", "python",
    "rl100", "max-records", "batch-size", "retry-failed", "radius-m", "timeout-ms",
  ]);
  const options = { rl100: [] };
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`Unerwartetes Argument ${token}.\n${usage()}`);
    const name = token.slice(2);
    if (!allowed.has(name)) throw new Error(`Unbekannte Option ${token}.\n${usage()}`);
    if (flags.has(name)) {
      if (options[name] === true) throw new Error(`Option ${token} wurde doppelt angegeben.`);
      options[name] = true;
      continue;
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Wert für ${token} fehlt.`);
    if (repeating.has(name)) options[name].push(value);
    else if (options[name] !== undefined) throw new Error(`Option ${token} wurde doppelt angegeben.`);
    else options[name] = value;
    index += 1;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value === "") throw new Error(`--${name} fehlt.\n${usage()}`);
  return value;
}

function integer(options, name, fallback) {
  const value = options[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new Error(`--${name} erwartet eine positive Ganzzahl.`);
  return Number.parseInt(value, 10);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await auditCapturedStationPlans({
    evidenceRoot: required(options, "evidence-root"),
    repositoryRoot: REPOSITORY_ROOT,
    operatingPointsPath: required(options, "operating-points"),
    semanticLayerPaths: {
      signals: required(options, "signals"),
      switches: required(options, "switches"),
      platforms: required(options, "platforms"),
    },
    pythonExecutable: required(options, "python"),
    radiusMetres: integer(options, "radius-m", 1_500),
    maximumRecords: integer(options, "max-records", Number.MAX_SAFE_INTEGER),
    batchSize: integer(options, "batch-size", Number.MAX_SAFE_INTEGER),
    rl100Filter: options.rl100,
    retryFailed: options["retry-failed"] === true,
    extractionTimeoutMs: integer(options, "timeout-ms", 180_000),
  });
  process.stdout.write(`${JSON.stringify({ outputPath: result.outputPath, summary: result.summary, runStatistics: result.runStatistics })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
