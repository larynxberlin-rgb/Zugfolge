import { createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { alphaHash } from "../../packages/alpha/dist/index.js";
import { decodeEconomyValue } from "../../packages/economy/dist/index.js";

const [inputPath, privateKeyPath, keyId, outputPath = inputPath] = process.argv.slice(2);
if (!inputPath || !privateKeyPath || !keyId) throw new Error("Aufruf: node sign-alpha-deployment.mjs INPUT PRIVATE_KEY KEY_ID [OUTPUT]");
const envelope = JSON.parse(await readFile(inputPath, "utf8"));
const deployment = decodeEconomyValue(envelope.deployment);
if (deployment?.schema !== "zugfolge-alpha-world-deployment/v2") {
  throw new Error("Nur der harte Betriebsengine-v2-Weltvertrag darf signiert werden.");
}
const deploymentHash = alphaHash(deployment.schema, deployment);
const signature = sign(null, Buffer.from(deploymentHash, "hex"), createPrivateKey(await readFile(privateKeyPath, "utf8")));
await writeFile(outputPath, `${JSON.stringify({
  deployment: envelope.deployment,
  deploymentHash,
  signature: { algorithm: "Ed25519", keyId, valueBase64: signature.toString("base64") },
}, null, 2)}\n`);
console.log(JSON.stringify({ worldId: deployment.worldId, deploymentHash, keyId }));
