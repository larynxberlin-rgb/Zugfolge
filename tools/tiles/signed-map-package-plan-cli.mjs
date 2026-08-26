#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  deriveSignedMapPackagePlan,
  writeSignedMapPackagePlan,
} from "./signed-map-package-plan.mjs";

const [unsignedPlanPath, sourceRoot, trustedKeysSourceFile, trustedKeyScopesSourceFile, outputPath, ...extra] = process.argv.slice(2);
if (!unsignedPlanPath || !sourceRoot || !trustedKeysSourceFile || !trustedKeyScopesSourceFile || !outputPath || extra.length > 0) {
  throw new Error("Aufruf: signed-map-package-plan-cli.mjs UNSIGNED_PLAN.json QUELLWURZEL TRUSTED_KEYS.json TRUSTED_KEY_SCOPES.json SIGNED_PLAN.json");
}
const input = resolve(unsignedPlanPath);
const output = resolve(outputPath);
if (input === output) throw new Error("Unsigned Jahresplan und abgeleiteter Signed-Paketplan brauchen getrennte unveraenderliche Pfade.");

const unsignedPlan = JSON.parse(await readFile(input, "utf8"));
const derived = await deriveSignedMapPackagePlan(
  unsignedPlan,
  resolve(sourceRoot),
  trustedKeysSourceFile,
  trustedKeyScopesSourceFile,
);
const written = await writeSignedMapPackagePlan(derived.plan, output);
process.stdout.write(`${JSON.stringify({
  action: written.status,
  outputPath: written.outputPath,
  planBytes: written.bytes,
  planSha256: written.sha256,
  releaseId: derived.releaseId,
  keyId: derived.keyId,
  trustedKeysSourceFile: derived.trustedKeysSourceFile,
  trustedKeyScopesSourceFile: derived.trustedKeyScopesSourceFile,
  signedReleaseSourceFile: derived.signedReleaseSourceFile,
  signedReleaseBytes: derived.signedReleaseBytes,
  signedReleaseSha256: derived.signedReleaseSha256,
  runtimeSchema: derived.plan.runtime.schema,
})}\n`);
