#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildSemanticTilePlan, validateSemanticTileFiles } from "./semantic-tiles.mjs";

const [specPath, inputRoot, outputPath, tippecanoe = "tippecanoe", pmtiles = "pmtiles"] = process.argv.slice(2);
if (!outputPath) throw new Error("Aufruf: build-semantic-pmtiles.mjs INPUTS.json INPUT_ROOT OUTPUT.pmtiles [TIPPECANOE] [PMTILES]");
const specification = JSON.parse(await readFile(resolve(specPath), "utf8"));
const featureCounts = await validateSemanticTileFiles(specification, inputRoot);
await mkdir(dirname(resolve(outputPath)), { recursive: true });
const plan = buildSemanticTilePlan({ specification, inputRoot, outputPath, tippecanoe, pmtiles });
try {
  for (const step of plan.commands) {
    const result = spawnSync(step.command, step.args, { stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Tile-Schritt ${step.id} fehlgeschlagen (${result.status ?? "ohne Status"}).`);
  }
} finally {
  await rm(plan.temporaryMbtiles, { force: true });
}
process.stdout.write(`${JSON.stringify({ output: plan.output, layers: specification.layers.length, featureCounts })}\n`);
