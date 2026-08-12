import { readFile, writeFile } from "node:fs/promises";
import { signRelease } from "./release-crypto.mjs";

const [manifestPath, privateKeyPath, keyId, outputPath = manifestPath] = process.argv.slice(2);
if (!manifestPath || !privateKeyPath || !keyId) throw new Error("Aufruf: node sign-release.mjs MANIFEST PRIVATE_KEY KEY_ID [OUTPUT]");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const signed = signRelease(manifest, await readFile(privateKeyPath, "utf8"), keyId);
await writeFile(outputPath, `${JSON.stringify(signed, null, 2)}\n`);
console.log(JSON.stringify({ releaseId: signed.releaseId, releaseHash: signed.releaseHash, keyId: signed.signature.keyId }));

