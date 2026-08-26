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
    "  map-build-cache-inventory-cli.mjs build-overlay RELEASE_ID PLAN.json AUSGABE.json ARTIFACT_ROOT [ARTIFACT_ROOT...]",
  ].join("\n");
}

const [command, ...args] = process.argv.slice(2);
if (!["build", "build-overlay"].includes(command)) throw new Error(usage());
if ((command === "build" && args.length !== 4) || (command === "build-overlay" && args.length < 4)) throw new Error(usage());
const [releaseId, firstPath, secondPath, ...remaining] = args;
const artifactRoot = command === "build" ? firstPath : undefined;
const artifactRoots = command === "build-overlay" ? remaining.map((root) => resolve(root)) : undefined;
const planPath = command === "build" ? secondPath : firstPath;
const outputPath = command === "build" ? remaining[0] : secondPath;

const plan = await loadMapBuildCacheInventoryPlan(resolve(planPath));
const result = await buildMapBuildCacheInventory({
  releaseId,
  ...(artifactRoot === undefined ? { artifactRoots } : { artifactRoot: resolve(artifactRoot) }),
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
