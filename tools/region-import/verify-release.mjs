import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyRelease } from "./release-crypto.mjs";

const [manifestPath, sourceRootInput, artifactRootInput, publicKeyPath] = process.argv.slice(2);
if (!manifestPath || !sourceRootInput || !artifactRootInput || !publicKeyPath) {
  throw new Error("Aufruf: node verify-release.mjs MANIFEST SOURCE_ROOT ARTIFACT_ROOT PUBLIC_KEY");
}
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schema !== "zugfolge-infra-release/v1" || manifest.status !== "qualified") throw new Error("InfraRelease ist nicht qualifiziert.");
if (!verifyRelease(manifest, await readFile(publicKeyPath, "utf8"))) throw new Error("InfraRelease-Signatur ist ungueltig.");
if (manifest.quality.classCOrderable !== false || manifest.validation.result !== "passed" || !manifest.releaseApproval.activationAllowed) {
  throw new Error("Release-Gates sind nicht erfuellt.");
}

async function hash(path) {
  const hasher = createHash("sha256");
  for await (const chunk of createReadStream(path)) hasher.update(chunk);
  return hasher.digest("hex");
}
for (const entry of manifest.sources) {
  const root = entry.rightsSourceId === "trassenfinder-infrastruktur-api" ? artifactRootInput : sourceRootInput;
  const path = resolve(root, entry.file);
  if ((await stat(path)).size !== entry.bytes || await hash(path) !== entry.sha256) throw new Error(`Quelle ${entry.id} ist veraendert.`);
}
for (const entry of manifest.artifacts) {
  const path = resolve(artifactRootInput, entry.file);
  if ((await stat(path)).size !== entry.bytes || await hash(path) !== entry.sha256) throw new Error(`Artefakt ${entry.kind} ist veraendert.`);
}
console.log(JSON.stringify({ releaseId: manifest.releaseId, releaseHash: manifest.releaseHash, signatureValid: true, sources: manifest.sources.length, artifacts: manifest.artifacts.length }));

