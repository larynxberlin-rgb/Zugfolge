#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { auditGermanyOperationalSourceCompiler } from "./operational-source-compiler.mjs";

const SOURCE_SPEC_SCHEMA = "zugfolge-germany-operational-source-compiler/v1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function writeJsonExclusiveAtomic(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

const [specificationPath, sourceRoot, reportPath, ...extra] = process.argv.slice(2);
if (!specificationPath || !sourceRoot || !reportPath || extra.length > 0) {
  throw new Error("Aufruf: run-operational-source-compiler.mjs SPEC.json SOURCE_ROOT REPORT.json");
}

const specification = JSON.parse(await readFile(resolve(specificationPath), "utf8"));
invariant(isRecord(specification) && specification.schema === SOURCE_SPEC_SCHEMA, "Unbekannter Operational-Source-Compiler-Vertrag.");
const expectedKeys = ["eboStopPositions", "infraReleaseId", "layers", "openStationStations", "schema"];
invariant(
  Object.keys(specification).sort().join("\0") === expectedKeys.join("\0"),
  "Operational-Source-Compiler-Vertrag besitzt unbekannte oder fehlende Felder.",
);

const report = await auditGermanyOperationalSourceCompiler({
  infraReleaseId: specification.infraReleaseId,
  sourceRoot,
  layers: specification.layers,
  eboStopPositions: specification.eboStopPositions,
  openStationStations: specification.openStationStations,
});
try {
  await writeJsonExclusiveAtomic(resolve(reportPath), report);
} catch (error) {
  throw new Error(`Operational-Source-Bericht konnte nicht atomar und kollisionsfrei geschrieben werden: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

process.stdout.write(`${JSON.stringify({
  status: report.status,
  candidateProduced: report.candidateProduced,
  fullGermanyArtifactPossible: report.fullGermanyArtifactPossible,
  unresolvedRequired: report.unresolvedRequired,
  report: resolve(reportPath),
})}\n`);
process.exitCode = report.fullGermanyArtifactPossible ? 0 : 2;
