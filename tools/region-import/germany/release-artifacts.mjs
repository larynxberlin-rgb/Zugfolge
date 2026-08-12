import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function contained(root, sourceFile, label) {
  invariant(typeof sourceFile === "string" && sourceFile !== "" && !isAbsolute(sourceFile), `${label} muss ein relativer Pfad sein.`);
  const path = resolve(root, sourceFile);
  const remainder = relative(resolve(root), path);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `${label} verlässt die Quellwurzel.`);
  return path;
}

async function fileProof(path) {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${path} ist kein reguläres Releaseartefakt.`);
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  invariant(bytes === metadata.size, `${path} änderte sich während der Hashbildung.`);
  return { bytes, sha256: digest.digest("hex") };
}

export async function buildReleaseArtifactInventory(spec, sourceRoot) {
  invariant(spec?.schema === "zugfolge-infra-release-artifact-spec/v1", "Unbekanntes Releaseartefakt-Schema.");
  invariant(Array.isArray(spec.artifacts) && spec.artifacts.length > 0, "Releaseartefakt-Spezifikation ist leer.");
  const ids = new Set();
  const publicFiles = new Set();
  const artifacts = [];
  for (const descriptor of [...spec.artifacts].sort((left, right) => left.id.localeCompare(right.id, "en"))) {
    invariant(typeof descriptor?.id === "string" && SAFE_ID.test(descriptor.id) && !ids.has(descriptor.id), "Releaseartefakt-ID ist ungültig oder doppelt.");
    invariant(typeof descriptor.kind === "string" && descriptor.kind !== "", `Releaseartefakt ${descriptor.id} besitzt keine Art.`);
    invariant(typeof descriptor.file === "string" && descriptor.file !== "" && !descriptor.file.includes("/") && !descriptor.file.includes("\\") && !publicFiles.has(descriptor.file), `Releaseartefakt ${descriptor.id} besitzt keinen eindeutigen öffentlichen Dateinamen.`);
    ids.add(descriptor.id);
    publicFiles.add(descriptor.file);
    artifacts.push({
      id: descriptor.id,
      kind: descriptor.kind,
      file: descriptor.file,
      ...await fileProof(contained(sourceRoot, descriptor.sourceFile, `${descriptor.id}.sourceFile`)),
    });
  }
  return { schema: "zugfolge-infra-release-artifacts/v1", artifacts };
}

export async function readReleaseArtifactSpec(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
