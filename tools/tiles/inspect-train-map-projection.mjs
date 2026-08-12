#!/usr/bin/env node

import { resolve } from "node:path";

import { inspectTrainMapProjection } from "./train-map-projection.mjs";

const path = process.argv[2];
if (path === undefined || process.argv.length !== 3) {
  throw new Error("Aufruf: node tools/tiles/inspect-train-map-projection.mjs <projection.sqlite>");
}

process.stdout.write(`${JSON.stringify(await inspectTrainMapProjection(resolve(path)), null, 2)}\n`);
