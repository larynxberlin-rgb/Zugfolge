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

const [planPath, sourceRoot, privateKeyPath, keyId, outputPath, ...extra] = process.argv.slice(2);
if (!planPath || !sourceRoot || !privateKeyPath || !keyId || !outputPath || extra.length > 0) {
  throw new Error("Aufruf: sign-map-delivery-release.mjs UNSIGNED_PLAN.json QUELLWURZEL PRIVATE_KEY.pem KEY_ID SIGNED_RELEASE.json");
}

const unsignedPlan = JSON.parse(await readFile(resolve(planPath), "utf8"));
const resolvedSourceRoot = resolve(sourceRoot);
const preflight = await preflightUnsignedMapDeliveryRelease(unsignedPlan, resolvedSourceRoot);
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
