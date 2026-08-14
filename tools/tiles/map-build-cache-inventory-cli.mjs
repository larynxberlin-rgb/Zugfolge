#!/usr/bin/env node
import { resolve } from "node:path";

import {
  buildMapBuildCacheInventory,
  loadMapBuildCacheInventoryPlan,
  writeMapBuildCacheInventory,
} from "./map-build-cache-inventory.mjs";

function usage() {
  return [
    "Aufruf:",
    "  map-build-cache-inventory-cli.mjs build RELEASE_ID ARTIFACT_ROOT PLAN.json AUSGABE.json",
  ].join("\n");
}

const [command, releaseId, artifactRoot, planPath, outputPath, ...extra] = process.argv.slice(2);
if (command !== "build" || !releaseId || !artifactRoot || !planPath || !outputPath || extra.length > 0) throw new Error(usage());

const plan = await loadMapBuildCacheInventoryPlan(resolve(planPath));
const result = await buildMapBuildCacheInventory({
  releaseId,
  artifactRoot: resolve(artifactRoot),
  plan,
});
const written = await writeMapBuildCacheInventory(result, resolve(outputPath));

process.stdout.write(`${JSON.stringify({
  action: "built",
  releaseId: result.inventory.releaseId,
  inventoryPath: written.path,
  inventoryBytes: written.bytes,
  inventorySha256: written.sha256,
  files: written.files,
})}\n`);
