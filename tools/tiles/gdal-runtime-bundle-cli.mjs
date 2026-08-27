#!/usr/bin/env node
import { resolve } from "node:path";

import {
  createGdalRuntimeBundleManifest,
  loadAndVerifyGdalRuntimeBundle,
  verifyGdalRuntimeBundle,
  writeGdalRuntimeBundle,
} from "./gdal-runtime-bundle.mjs";

const [command, firstPath, secondPath, ...extra] = process.argv.slice(2);
if (extra.length > 0 || !["create", "verify"].includes(command) || firstPath === undefined || secondPath === undefined) {
  throw new Error([
    "Aufruf:",
    "  gdal-runtime-bundle-cli.mjs create ARTEFAKTWURZEL MANIFEST.json",
    "  gdal-runtime-bundle-cli.mjs verify MANIFEST.json ARTEFAKTWURZEL",
  ].join("\n"));
}

if (command === "create") {
  const manifest = await createGdalRuntimeBundleManifest({ artifactRoot: resolve(firstPath) });
  const verified = await verifyGdalRuntimeBundle({ manifest, artifactRoot: resolve(firstPath) });
  const written = await writeGdalRuntimeBundle(manifest, resolve(secondPath));
  process.stdout.write(`${JSON.stringify({ action: "created", ...written, probes: verified.probes })}\n`);
} else {
  const checked = await loadAndVerifyGdalRuntimeBundle(resolve(firstPath), resolve(secondPath));
  process.stdout.write(`${JSON.stringify({ action: "verified", path: checked.path, sha256: checked.sha256, ...checked.verification, invocation: undefined })}\n`);
}
