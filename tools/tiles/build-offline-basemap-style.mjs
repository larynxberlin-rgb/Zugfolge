#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildOfflineBasemapStyle, serializeOfflineBasemapStyle } from "./offline-basemap-style.mjs";

const [upstreamPath, outputPath, releaseId, basemapUrl, assetRoot] = process.argv.slice(2);
if (!assetRoot) {
  throw new Error("Aufruf: build-offline-basemap-style.mjs UPSTREAM.json OUTPUT.json RELEASE_ID PMTILES_URL ASSET_ROOT_URL");
}

const upstream = JSON.parse(await readFile(resolve(upstreamPath), "utf8"));
const normalizedAssetRoot = assetRoot.replace(/\/$/, "");
const result = buildOfflineBasemapStyle(upstream, {
  releaseId,
  basemapUrl,
  glyphsUrl: `${normalizedAssetRoot}/fonts/{fontstack}/{range}.pbf`,
  spriteUrl: `${normalizedAssetRoot}/sprites/dark`,
  maxZoom: 15,
  attribution: "© OpenStreetMap-Mitwirkende, ODbL 1.0; Basemap-Aufbereitung Protomaps; weitere Bearbeitung durch Zugfolge",
});
await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), serializeOfflineBasemapStyle(result.style), "utf8");
process.stdout.write(`${JSON.stringify({ output: resolve(outputPath), styleHash: result.styleHash, layers: result.style.layers.length })}\n`);
