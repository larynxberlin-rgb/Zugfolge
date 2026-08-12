#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expandMapPackagePlan } from "./map-package.mjs";
import { buildMapDeliveryRelease, writeMapDeliveryRelease } from "./map-delivery-release.mjs";
import { LIVEMAP_READ_MODEL_REPORT_SCHEMA } from "./livemap-read-model.mjs";
import { TRAIN_MAP_PROJECTION_REPORT_SCHEMA } from "./train-map-projection.mjs";

const [planPath, sourceRootPath, infraReleasePath, mapReleasePath, readModelReportPath, trainProjectionReportPath, outputDirectoryPath, ...extra] = process.argv.slice(2);
if (!planPath || !sourceRootPath || !infraReleasePath || !mapReleasePath || !readModelReportPath || !trainProjectionReportPath || !outputDirectoryPath || extra.length > 0) {
  throw new Error("Aufruf: build-map-delivery-release.mjs PACKAGE_PLAN.json QUELLWURZEL INFRA_RELEASE.json MAP_RELEASE.json READ_MODEL_REPORT.json TRAIN_PROJECTION_REPORT.json AUSGABEVERZEICHNIS");
}

async function json(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

const [plan, infraRelease, mapRelease, readModelReport, trainProjectionReport] = await Promise.all([
  json(planPath), json(infraReleasePath), json(mapReleasePath), json(readModelReportPath), json(trainProjectionReportPath),
]);
const sourceRoot = resolve(sourceRootPath);
const packageSpec = await expandMapPackagePlan(plan, sourceRoot);
const readModel = packageSpec.auxiliaryFiles.find(({ kind }) => kind === "read-model");
const trainProjection = packageSpec.auxiliaryFiles.find(({ kind }) => kind === "train-map-projection");
if (readModel === undefined || readModelReport?.schema !== LIVEMAP_READ_MODEL_REPORT_SCHEMA || !["read-model.sqlite", "read-model-v2.sqlite"].includes(readModelReport?.artifact?.file)) {
  throw new Error("Öffentlicher SQLite-ReadModel-Beleg fehlt.");
}
if (trainProjection === undefined || trainProjectionReport?.schema !== TRAIN_MAP_PROJECTION_REPORT_SCHEMA || trainProjectionReport?.artifact?.file !== "train-map-projection.sqlite") {
  throw new Error("Eigenständiger SQLite-Zugpositionsprojektionsbeleg fehlt.");
}
const result = await buildMapDeliveryRelease({
  releaseId: infraRelease?.release?.releaseId ?? infraRelease?.releaseId,
  timetableYear: infraRelease?.release?.timetableYear ?? infraRelease?.timetableYear,
  packageSpec,
  sourceRoot,
  infraRelease,
  mapRelease,
  auxiliaryArtifactProofs: [
    { id: readModel.id, bytes: readModelReport.artifact.bytes, sha256: readModelReport.artifact.sha256 },
    { id: trainProjection.id, bytes: trainProjectionReport.artifact.bytes, sha256: trainProjectionReport.artifact.sha256 },
  ],
});
const written = await writeMapDeliveryRelease(result, resolve(outputDirectoryPath));
process.stdout.write(`${JSON.stringify({
  releaseId: result.release.releaseId,
  releaseSha256: result.releaseSha256,
  sourcesSha256: result.sourcesSha256,
  artifacts: result.release.artifacts.length,
  sources: result.sources.sources.length,
  ...written,
})}\n`);
