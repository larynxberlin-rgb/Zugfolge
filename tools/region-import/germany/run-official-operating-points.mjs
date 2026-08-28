#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { writeOfficialOperatingPoints } from "./official-operating-points.mjs";

const [specificationPath, repositoryRoot = ".", ...extra] = process.argv.slice(2);
if (!specificationPath || extra.length > 0) {
  throw new Error("Aufruf: run-official-operating-points.mjs SPECIFICATION.json [REPOSITORY_ROOT]");
}
const specification = JSON.parse(await readFile(resolve(specificationPath), "utf8"));
const result = await writeOfficialOperatingPoints({ specification, repositoryRoot: resolve(repositoryRoot) });
process.stdout.write(`${JSON.stringify({
  outputDirectory: result.outputDirectory,
  features: result.report.features,
  sourceId: result.report.sourceId,
  bytes: result.report.artifact.bytes,
  sha256: result.report.artifact.sha256,
})}\n`);
