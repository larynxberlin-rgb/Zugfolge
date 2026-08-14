#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  signMapDeliveryRelease,
  writeSignedMapDeliveryRelease,
} from "./map-delivery-release.mjs";

const [inputPath, privateKeyPath, keyId, outputPath, ...extra] = process.argv.slice(2);
if (!inputPath || !privateKeyPath || !keyId || !outputPath || extra.length > 0) {
  throw new Error("Aufruf: sign-map-delivery-release.mjs UNSIGNED_RELEASE.json PRIVATE_KEY.pem KEY_ID SIGNED_RELEASE.json");
}
if (resolve(inputPath) === resolve(outputPath)) {
  throw new Error("Unsignierter und signierter Delivery-Release brauchen getrennte unveraenderliche Pfade.");
}

const [releaseBytes, privateKeyPem] = await Promise.all([
  readFile(resolve(inputPath)),
  readFile(resolve(privateKeyPath), "utf8"),
]);
const release = JSON.parse(releaseBytes.toString("utf8"));
const signed = signMapDeliveryRelease(release, privateKeyPem, keyId);
const status = await writeSignedMapDeliveryRelease(signed, resolve(outputPath));
process.stdout.write(`${JSON.stringify({
  status,
  releaseId: signed.releaseId,
  releaseHash: signed.releaseHash,
  keyId,
  outputPath: resolve(outputPath),
})}\n`);
