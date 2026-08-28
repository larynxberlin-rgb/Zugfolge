#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { materializeStaticMapRelease } from "./static-map-release.mjs";

const [command, specPath, sourceRoot, outputRoot] = process.argv.slice(2);
if (command !== "materialize" || specPath === undefined || sourceRoot === undefined || outputRoot === undefined) {
  throw new Error("Aufruf: static-map-release-cli.mjs materialize SPEC.json QUELLWURZEL AUSGABEVERZEICHNIS");
}

const spec = JSON.parse(await readFile(resolve(specPath), "utf8"));
const result = await materializeStaticMapRelease(spec, resolve(sourceRoot), resolve(outputRoot));
process.stdout.write(`${JSON.stringify({
  action: result.status,
  outputRoot: result.outputRoot,
  releaseId: result.release.releaseId,
  packagePlan: "package-plan.json",
  releaseManifest: "release.json",
  claims: result.release.claims,
  cutover: result.release.cutover,
})}\n`);
