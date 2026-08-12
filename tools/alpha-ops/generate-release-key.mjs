import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";

const [privatePath, publicPath] = process.argv.slice(2);
if (!privatePath || !publicPath) throw new Error("Aufruf: node generate-release-key.mjs PRIVATE.pem PUBLIC.pem");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
await writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644, flag: "wx" });
console.log(JSON.stringify({ algorithm: "Ed25519", privatePath, publicPath }));
