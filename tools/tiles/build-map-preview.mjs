#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildMapPreviewBundle, writeMapPreviewBundle } from "./map-preview.mjs";

const [specPath, planPath, sourceRoot, outputRoot, ...extra] = process.argv.slice(2);
if (!specPath || !planPath || !sourceRoot || !outputRoot || extra.length > 0) {
  throw new Error("Aufruf: build-map-preview.mjs PREVIEW_SPEC.json PREVIEW_PLAN.json ERHALTENER_2026.2_QUELLROOT PREVIEW_AUSGABEROOT");
}

async function json(path, label) {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`${label} konnte nicht als JSON gelesen werden: ${error.message}`);
  }
}

const [spec, packagePlan] = await Promise.all([
  json(specPath, "Preview-Spezifikation"),
  json(planPath, "Preview-Kartenpaketplan"),
]);
const bundle = await buildMapPreviewBundle({ spec, packagePlan, sourceRoot: resolve(sourceRoot) });
const written = await writeMapPreviewBundle(bundle, resolve(outputRoot));

process.stdout.write(`${JSON.stringify({
  action: written.status,
  previewId: bundle.spec.previewId,
  activationEligible: false,
  packagePlanSchema: written.plan.schema,
  packageId: written.plan.packageId,
  version: written.plan.version,
  outputRoot: written.root,
  generatedFiles: bundle.files.size,
  expandedAuxiliaryFiles: written.expanded.auxiliaryFiles.length,
})}\n`);
