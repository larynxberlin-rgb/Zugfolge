#!/usr/bin/env node
// zugfolge:quelle=osm-pbf-deutschland
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildGermanyImportPlan, contained } from "./import-plan.mjs";

const [capturePath, sourceRootInput, outputRootInput, osmium, cargo] = process.argv.slice(2);
if (!cargo) throw new Error("Aufruf: run-germany-import.mjs CAPTURE.json SOURCE_ROOT OUTPUT_ROOT OSMIUM CARGO");

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const capture = JSON.parse(await readFile(resolve(capturePath), "utf8"));
if (capture.schema !== "zugfolge-source-capture/v1") throw new Error("Unbekanntes Capture-Schema.");
const source = capture.sources?.find(({ id }) => id === "geofabrik-germany-pbf");
if (source === undefined) throw new Error("Deutschland-PBF fehlt im Capture.");
const sourceRoot = resolve(sourceRootInput);
const outputRoot = resolve(outputRootInput);
const sourcePbf = contained(sourceRoot, source.file);
const metadata = await stat(sourcePbf);
if (!metadata.isFile() || metadata.size !== source.bytes) throw new Error("Deutschland-PBF verletzt die gepinnte Bytezahl.");
const sourceSha256 = await sha256File(sourcePbf);
if (sourceSha256 !== source.sha256) throw new Error(`Deutschland-PBF verletzt den gepinnten SHA-256: ${sourceSha256}.`);

await mkdir(outputRoot, { recursive: true });
const workspace = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const plan = buildGermanyImportPlan({ osmium, cargo, workspace, sourcePbf, outputRoot });
for (const step of plan.commands) {
  const result = spawnSync(step.command, step.args, { cwd: step.cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Importschritt ${step.id} fehlgeschlagen (${result.status ?? "ohne Status"}).`);
}

const outputs = [];
for (const [kind, path] of Object.entries(plan.outputs)) {
  const outputMetadata = await stat(path);
  outputs.push({ kind, file: path, bytes: outputMetadata.size, sha256: await sha256File(path) });
}
outputs.sort((left, right) => left.kind.localeCompare(right.kind, "en"));
const report = {
  schema: "zugfolge-germany-import-report/v1",
  source: { id: source.id, version: source.version, bytes: source.bytes, sha256: source.sha256 },
  steps: plan.commands.map(({ id }) => id),
  outputs,
};
await writeFile(resolve(outputRoot, "import-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ sourceSha256, outputs: outputs.length })}\n`);
