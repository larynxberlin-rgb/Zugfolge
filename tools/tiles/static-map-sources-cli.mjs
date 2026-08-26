#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadMapAssetNotices } from "./map-asset-notices.mjs";
import { buildStaticMapSources, writeStaticMapSources } from "./static-map-sources.mjs";

const [command, specPath, infrastructureCatalogPath, infrastructureCapturePath, mapCatalogPath, mapCapturePath, rightsPath, assetNoticeContractPath, repositoryRoot, outputPath] = process.argv.slice(2);
if (command !== "materialize" || [specPath, infrastructureCatalogPath, infrastructureCapturePath, mapCatalogPath, mapCapturePath, rightsPath, assetNoticeContractPath, repositoryRoot, outputPath].some((value) => value === undefined)) {
  throw new Error("Aufruf: static-map-sources-cli.mjs materialize SPEC.json DEUTSCHLAND-KATALOG.json DEUTSCHLAND-CAPTURE.json KARTEN-KATALOG.json KARTEN-CAPTURE.json RECHTEREGISTER.json ASSET-NOTICES.json REPOSITORYWURZEL AUSGABE.json");
}

const [spec, infrastructureCatalog, infrastructureCapture, mapCatalog, mapCapture, rightsRegistry, assetNoticeContract] = await Promise.all([
  specPath,
  infrastructureCatalogPath,
  infrastructureCapturePath,
  mapCatalogPath,
  mapCapturePath,
  rightsPath,
  assetNoticeContractPath,
].map((path) => readFile(resolve(path), "utf8").then(JSON.parse)));
const assetNotices = await loadMapAssetNotices(assetNoticeContract, resolve(repositoryRoot));
const sources = buildStaticMapSources({ spec, infrastructureCatalog, infrastructureCapture, mapCatalog, mapCapture, rightsRegistry, assetNotices });
const written = await writeStaticMapSources(sources, resolve(outputPath));
process.stdout.write(`${JSON.stringify({ action: written.status, outputPath: written.outputPath, bytes: written.bytes, releaseId: sources.releaseId, schema: sources.schema, sources: sources.sources.length })}\n`);
