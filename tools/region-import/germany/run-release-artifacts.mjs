#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildReleaseArtifactInventory, readReleaseArtifactSpec } from "./release-artifacts.mjs";

const [specPath, sourceRootPath, outputPath, ...extra] = process.argv.slice(2);
if (!specPath || !sourceRootPath || !outputPath || extra.length > 0) {
  throw new Error("Aufruf: run-release-artifacts.mjs SPEC.json QUELLWURZEL OUTPUT.json");
}
const result = await buildReleaseArtifactInventory(await readReleaseArtifactSpec(resolve(specPath)), resolve(sourceRootPath));
await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ artifacts: result.artifacts.length, output: resolve(outputPath) })}\n`);
