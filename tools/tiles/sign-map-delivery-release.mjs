#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  signMapDeliveryRelease,
  writeSignedMapDeliveryRelease,
} from "./map-delivery-release.mjs";
import {
  deriveSignedReleaseSourceFile,
  preflightUnsignedMapDeliveryRelease,
} from "./signed-map-package-plan.mjs";

const usage = "Aufruf: sign-map-delivery-release.mjs UNSIGNED_PLAN.json QUELLWURZEL PRIVATE_KEY.pem KEY_ID [MAP_BUILD_COMMIT] SIGNED_RELEASE.json";
const arguments_ = process.argv.slice(2);
if (![5, 6].includes(arguments_.length)) throw new Error(usage);
const [planPath, sourceRoot, privateKeyPath, keyId] = arguments_;
const unsignedPlan = JSON.parse(await readFile(resolve(planPath), "utf8"));
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
const resolvedSourceRoot = resolve(sourceRoot);
const preflight = await preflightUnsignedMapDeliveryRelease(unsignedPlan, resolvedSourceRoot, { mapBuildCommit });
const expectedOutputPath = resolve(
  resolvedSourceRoot,
  ...deriveSignedReleaseSourceFile(preflight.releaseSourceFile).split("/"),
);
if (resolve(outputPath) !== expectedOutputPath) {
  throw new Error(`Signierter Delivery-v2-Release muss create-new am festen Paketpfad ${expectedOutputPath} entstehen.`);
}

// Der private Schluessel wird absichtlich erst nach dem vollstaendigen Current-Inventory-Preflight gelesen.
const privateKeyPem = await readFile(resolve(privateKeyPath), "utf8");
const signed = signMapDeliveryRelease(preflight.release, privateKeyPem, keyId);
const status = await writeSignedMapDeliveryRelease(signed, expectedOutputPath);
process.stdout.write(`${JSON.stringify({
  status,
  releaseId: signed.releaseId,
  releaseHash: signed.releaseHash,
  keyId,
  unsignedReleaseSha256: preflight.releaseSha256,
  outputPath: expectedOutputPath,
})}\n`);
