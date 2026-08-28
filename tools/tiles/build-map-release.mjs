#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { materializeMapRelease } from "./map-release.mjs";

const [specPath, artifactRoot, sourceCatalogPath, capturePath, rightsPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Aufruf: build-map-release.mjs SPEC.json ARTIFACT_ROOT SOURCE_CATALOG.json CAPTURE.json RIGHTS.json OUTPUT.json");
const [spec, catalog, capture, rightsRegistry] = await Promise.all([specPath, sourceCatalogPath, capturePath, rightsPath].map(async (path) => JSON.parse(await readFile(resolve(path), "utf8"))));
const result = await materializeMapRelease(spec, artifactRoot, { catalog, capture, rightsRegistry });
await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({ releaseId: result.release.releaseId, releaseHash: result.releaseHash, artifacts: result.release.artifacts.length })}\n`);
