#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  deriveSignedMapPackagePlan,
  writeSignedMapPackagePlan,
} from "./signed-map-package-plan.mjs";
import { assertCreateNewTarget } from "./create-new-output.mjs";

const usage = "Aufruf: signed-map-package-plan-cli.mjs UNSIGNED_PLAN.json QUELLWURZEL TRUSTED_KEYS.json TRUSTED_KEY_SCOPES.json [MAP_BUILD_COMMIT] SIGNED_PLAN.json";
const arguments_ = process.argv.slice(2);
if (![5, 6].includes(arguments_.length)) throw new Error(usage);
const [unsignedPlanPath, sourceRoot, trustedKeysSourceFile, trustedKeyScopesSourceFile] = arguments_;
const input = resolve(unsignedPlanPath);
const unsignedPlan = JSON.parse(await readFile(input, "utf8"));
const currentAnnualDelivery = unsignedPlan?.schema === "zugfolge-map-package-plan/v2"
  && unsignedPlan.version === "2026.5";
if (arguments_.length !== (currentAnnualDelivery ? 6 : 5)) {
  throw new Error(`${usage}; current 2026.5 verlangt einen expliziten MAP_BUILD_COMMIT.`);
}
const mapBuildCommit = currentAnnualDelivery ? arguments_[4] : undefined;
if (currentAnnualDelivery && !/^[a-f0-9]{40}$/u.test(mapBuildCommit)) {
  throw new Error("current 2026.5 verlangt einen expliziten exakten MAP_BUILD_COMMIT.");
}
const outputPath = arguments_.at(-1);
const output = resolve(outputPath);
if (input === output) throw new Error("Unsigned Jahresplan und abgeleiteter Signed-Paketplan brauchen getrennte unveraenderliche Pfade.");
await assertCreateNewTarget(output, "Signed-Paketplan-Ziel");

const derived = await deriveSignedMapPackagePlan(
  unsignedPlan,
  resolve(sourceRoot),
  trustedKeysSourceFile,
  trustedKeyScopesSourceFile,
  { mapBuildCommit },
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
