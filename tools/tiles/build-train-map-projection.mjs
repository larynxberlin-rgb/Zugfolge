#!/usr/bin/env node

import { resolve } from "node:path";

import { buildTrainMapProjection, loadTrainMapProjectionSpec } from "./train-map-projection.mjs";

const specPath = process.argv[2];
if (specPath === undefined || process.argv.length !== 3) {
  throw new Error("Aufruf: node tools/tiles/build-train-map-projection.mjs <build-spec.json>");
}

const report = await buildTrainMapProjection(await loadTrainMapProjectionSpec(resolve(specPath)));
process.stdout.write(`${JSON.stringify(report)}\n`);
