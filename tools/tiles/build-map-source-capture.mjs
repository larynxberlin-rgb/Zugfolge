#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildMapSourceCapture, writeMapSourceCapture } from "./map-source-capture.mjs";

const [stylePath, metadataPath, hybridPath, infrastructurePath, infraReleasePath, outputPath, ...extra] = process.argv.slice(2);
if (!stylePath || !metadataPath || !hybridPath || !infrastructurePath || !infraReleasePath || !outputPath || extra.length > 0) {
  throw new Error("Aufruf: build-map-source-capture.mjs UPSTREAM_STYLE.json HYBRID_METADATA.json HYBRID.pmtiles INFRA.pmtiles INFRA_RELEASE.json CAPTURE.json");
}
async function json(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}
const [upstreamStyle, hybridMetadata, infraRelease] = await Promise.all([json(stylePath), json(metadataPath), json(infraReleasePath)]);
const result = await buildMapSourceCapture({ upstreamStyle, hybridMetadata, hybridPath, infrastructurePath, infraRelease });
const written = await writeMapSourceCapture(result, outputPath);
process.stdout.write(`${JSON.stringify({
  ...written,
  capturedAt: result.capture.capturedAt,
  protomapsVersion: result.protomaps.version,
  sources: result.capture.sources,
})}\n`);
