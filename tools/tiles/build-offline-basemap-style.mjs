#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { materializeOfflineBasemapStyle } from "./offline-basemap-style.mjs";

const arguments_ = process.argv.slice(2);
const [upstreamPath, outputPath, releaseId, basemapUrl, assetRoot] = arguments_;
if (arguments_.length !== 5 || arguments_.some((argument) => argument.length === 0)) {
  throw new Error("Aufruf: build-offline-basemap-style.mjs UPSTREAM.json OUTPUT.json RELEASE_ID PMTILES_URL ASSET_ROOT_URL");
}

const upstream = JSON.parse(await readFile(resolve(upstreamPath), "utf8"));
const normalizedAssetRoot = assetRoot.replace(/\/$/, "");
const result = await materializeOfflineBasemapStyle(upstream, {
  releaseId,
  basemapUrl,
  glyphsUrl: `${normalizedAssetRoot}/fonts/{fontstack}/{range}.pbf`,
  spriteUrl: `${normalizedAssetRoot}/sprites/dark`,
  maxZoom: 15,
  attribution: "© OpenStreetMap-Mitwirkende, ODbL 1.0; Basemap-Aufbereitung Protomaps; weitere Bearbeitung durch Zugfolge",
}, outputPath);
process.stdout.write(`${JSON.stringify(result)}\n`);
