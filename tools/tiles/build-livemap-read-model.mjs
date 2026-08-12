#!/usr/bin/env node
import { resolve } from "node:path";

import { buildLivemapReadModelFromSpec } from "./livemap-read-model.mjs";

const [specPath, outputPath] = process.argv.slice(2);
if (specPath === undefined || outputPath === undefined) {
  throw new Error("Aufruf: node tools/tiles/build-livemap-read-model.mjs SPEC.json AUSGABE.sqlite");
}

const report = await buildLivemapReadModelFromSpec(resolve(specPath), resolve(outputPath));
process.stdout.write(`${JSON.stringify(report)}\n`);
