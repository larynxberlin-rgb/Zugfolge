#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadMapAssetNotices } from "./map-asset-notices.mjs";
import { buildMapSourceCapture, writeMapSourceCapture } from "./map-source-capture.mjs";

const [
  stylePath,
  metadataPath,
  hybridPath,
  infrastructurePath,
  infraReleasePath,
  assetNoticeContractPath,
  repositoryRoot,
  cacheInventoryPlanPath,
  artifactRoot,
  outputPath,
  ...extra
] = process.argv.slice(2);
if ([stylePath, metadataPath, hybridPath, infrastructurePath, infraReleasePath, assetNoticeContractPath, repositoryRoot, cacheInventoryPlanPath, artifactRoot, outputPath].some((value) => value === undefined) || extra.length > 0) {
  throw new Error("Aufruf: build-map-source-capture.mjs UPSTREAM_STYLE.json HYBRID_METADATA.json HYBRID.pmtiles INFRA.pmtiles INFRA_RELEASE.json ASSET_NOTICES.json REPOSITORYWURZEL CACHE_INVENTORY_PLAN.json ARTEFAKTWURZEL CAPTURE.json");
}
async function json(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}
const [upstreamStyle, hybridMetadata, infraRelease, assetNoticeContract, cacheInventoryPlan] = await Promise.all([
  json(stylePath),
  json(metadataPath),
  json(infraReleasePath),
  json(assetNoticeContractPath),
  json(cacheInventoryPlanPath),
]);
const assetNotices = await loadMapAssetNotices(assetNoticeContract, resolve(repositoryRoot));
const result = await buildMapSourceCapture({
  upstreamStyle,
  hybridMetadata,
  hybridPath,
  infrastructurePath,
  infraRelease,
  assetNotices,
  cacheInventoryPlan,
  artifactRoot,
});
const written = await writeMapSourceCapture(result, outputPath);
process.stdout.write(`${JSON.stringify({
  ...written,
  capturedAt: result.capture.capturedAt,
  protomapsVersion: result.protomaps.version,
  sources: result.capture.sources,
  assetFiles: result.assetFiles,
  assetNoticesSchema: result.capture.assetNotices.schema,
})}\n`);
