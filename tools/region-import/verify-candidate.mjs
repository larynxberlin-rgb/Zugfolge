import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [manifestPath, sourceRootInput, artifactRootInput] = process.argv.slice(2);
if (!manifestPath || !sourceRootInput || !artifactRootInput) {
  throw new Error("usage: node verify-candidate.mjs MANIFEST_JSON SOURCE_ROOT EXTERNAL_ARTIFACT_ROOT");
}

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(sourceRootInput);
const artifactRoot = resolve(artifactRootInput);
const manifestBytes = await readFile(resolve(manifestPath));
const manifest = JSON.parse(manifestBytes.toString("utf8"));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256(path) {
  const hasher = createHash("sha256");
  for await (const chunk of createReadStream(path)) hasher.update(chunk);
  return hasher.digest("hex");
}

function contained(root, relativePath) {
  invariant(typeof relativePath === "string" && relativePath !== "" && !isAbsolute(relativePath), `Ungueltiger relativer Pfad: ${relativePath}`);
  const path = resolve(root, relativePath);
  invariant(relative(root, path) !== "" && !relative(root, path).startsWith(".."), `Pfad verlaesst die Artefaktwurzel: ${relativePath}`);
  return path;
}

async function verifyFile(path, expectedSha256, expectedBytes, label) {
  const metadata = await stat(path);
  invariant(metadata.isFile(), `${label} ist keine Datei.`);
  if (expectedBytes !== undefined) invariant(metadata.size === expectedBytes, `${label}: Bytezahl ${metadata.size} != ${expectedBytes}.`);
  const actualHash = await sha256(path);
  invariant(actualHash === expectedSha256, `${label}: SHA-256 ${actualHash} != ${expectedSha256}.`);
}

invariant(manifest.schema === "zugfolge-infra-release-candidate/v1", "Unbekanntes Kandidatenschema.");
invariant(manifest.regionId === "mitteldeutschland-b" && manifest.regionVariant === "B", "Kandidat gehoert nicht zur freigegebenen Variante B.");
invariant(manifest.releaseApproval?.activationAllowed === false, "Technischer Kandidat darf vor externer Freigabe nicht aktivierbar sein.");
invariant(manifest.releaseApproval?.signature === null, "Unsignierter technischer Kandidat muss die fehlende Signatur explizit tragen.");
invariant(manifest.artifacts?.qualityReport?.classCOrderable === false, "Qualitaetsklasse C darf nicht bestellbar sein.");

for (const source of manifest.sources ?? []) {
  invariant(source.rightsSourceId === "osm-pbf-mitteldeutschland-b" || source.rightsSourceId === "gtfs-de-rv", `Unbekannte Rechtequelle ${source.rightsSourceId}.`);
  await verifyFile(contained(sourceRoot, source.sourceFile), source.sha256, source.bytes, `Quelle ${source.id}`);
}

for (const [pathKey, hashKey] of [["geoJson", "geoJsonSha256"], ["poly", "polySha256"]]) {
  const path = contained(workspace, manifest.boundary[pathKey]);
  await verifyFile(path, manifest.boundary[hashKey], undefined, `Grenze ${pathKey}`);
}

for (const [pathKey, hashKey] of [["importScript", "importScriptSha256"], ["gtfsScript", "gtfsScriptSha256"], ["qualityScript", "qualityScriptSha256"]]) {
  const path = contained(workspace, manifest.pipeline[pathKey]);
  await verifyFile(path, manifest.pipeline[hashKey], undefined, `Pipeline ${pathKey}`);
}

for (const artifact of Object.values(manifest.artifacts ?? {})) {
  if (artifact.externalArtifactId === undefined) continue;
  const prefix = "zugfolge-alpha-evidence/";
  invariant(artifact.externalArtifactId.startsWith(prefix), `Unbekannter externer Artefaktraum ${artifact.externalArtifactId}.`);
  const relativeId = artifact.externalArtifactId.slice(prefix.length);
  await verifyFile(contained(artifactRoot, relativeId), artifact.fileSha256 ?? artifact.sha256, artifact.bytes, `Artefakt ${relativeId}`);
}

const candidateSha256 = createHash("sha256").update(manifestBytes).digest("hex");
process.stdout.write(`${JSON.stringify({
  releaseId: manifest.releaseId,
  candidateSha256,
  sources: manifest.sources.length,
  externalArtifacts: Object.values(manifest.artifacts).filter((artifact) => artifact.externalArtifactId !== undefined).length,
  activationAllowed: false,
  blockingIssue: manifest.releaseApproval.blockingIssue,
})}\n`);
