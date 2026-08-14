import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { normalize as normalizePosix } from "node:path/posix";

export const MAP_BUILD_CACHE_INVENTORY_PLAN_SCHEMA = "zugfolge-map-build-cache-inventory-plan/v1";
export const MAP_BUILD_CACHE_INVENTORY_SCHEMA = "zugfolge-map-build-cache-inventory/v1";

const MAX_PLAN_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_ID = /^(?<family>[a-z0-9][a-z0-9._-]*-)(?<year>20\d{2})\.(?<patch>[1-9]\d*)$/;
const MUTABLE_TOKEN = /(?:^|[./_:@-])(latest|unversioned|main|master|head)(?:$|[./_:@-])/i;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactObject(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  invariant(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} besitzt unerwartete oder fehlende Felder.`);
  return value;
}

function validateReleaseId(value, label = "releaseId") {
  invariant(typeof value === "string" && RELEASE_ID.test(value), `${label} muss ein unveränderlicher Jahres-Patchrelease sein.`);
  invariant(!MUTABLE_TOKEN.test(value), `${label} darf weder latest noch unversioniert sein.`);
  return value;
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} fehlt.`);
  invariant(!value.includes("\\") && !value.includes("\0"), `${label} ist nicht portabel.`);
  invariant(!isAbsolute(value) && !value.startsWith("/") && !/^[a-z]:/i.test(value), `${label} muss relativ sein.`);
  invariant(!value.includes("://") && normalizePosix(value) === value, `${label} ist nicht normalisiert.`);
  invariant(value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), `${label} enthält einen unsicheren Pfadabschnitt.`);
  return value;
}

function cachePath(value, label) {
  const path = portablePath(value, label);
  invariant(!MUTABLE_TOKEN.test(path), `${label} darf weder latest noch unversioniert enthalten.`);
  invariant(!path.startsWith(".zugfolge-"), `${label} verwendet einen reservierten Cachepfad.`);
  return path;
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameMetadata(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function resolveArtifactRoot(value) {
  invariant(typeof value === "string" && value.length > 0, "artifactRoot fehlt.");
  const requested = resolve(value);
  const metadata = await lstat(requested);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "artifactRoot muss ein reguläres Verzeichnis ohne symbolischen Link sein.");
  return realpath(requested);
}

async function resolveContainedRegularFile(root, sourceFile, label) {
  let current = root;
  const parts = sourceFile.split("/");
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const metadata = await lstat(current);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link enthalten.`);
    if (index < parts.length - 1) invariant(metadata.isDirectory(), `${label} besitzt einen nicht auflösbaren Zwischenpfad.`);
  }
  const actual = await realpath(current);
  const remainder = relative(root, actual);
  invariant(remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder), `${label} verlässt artifactRoot.`);
  const metadata = await lstat(actual, { bigint: true });
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} muss eine reguläre Datei sein.`);
  invariant(metadata.size > 0n, `${label} darf nicht leer sein.`);
  invariant(metadata.size <= BigInt(Number.MAX_SAFE_INTEGER), `${label} ist für das Inventar zu groß.`);
  return { path: actual, metadata };
}

async function streamedFileProof(root, sourceFile, label) {
  const resolved = await resolveContainedRegularFile(root, sourceFile, label);
  const handle = await open(resolved.path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && sameMetadata(resolved.metadata, before), `${label} änderte sich vor der Hashbildung.`);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
      hash.update(chunk);
      bytes += chunk.length;
      invariant(Number.isSafeInteger(bytes), `${label} ist für das Inventar zu groß.`);
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(resolved.path, { bigint: true });
    invariant(pathAfter.isFile() && !pathAfter.isSymbolicLink(), `${label} ist nach der Hashbildung keine reguläre Datei mehr.`);
    invariant(sameMetadata(before, after) && sameMetadata(after, pathAfter) && BigInt(bytes) === after.size, `${label} änderte sich während der Hashbildung.`);
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export function validateMapBuildCacheInventoryPlan(value, releaseId) {
  validateReleaseId(releaseId);
  exactObject(value, ["schema", "releaseId", "files"], "Buildcache-Inventarplan");
  invariant(value.schema === MAP_BUILD_CACHE_INVENTORY_PLAN_SCHEMA, "Buildcache-Inventarplan hat ein unbekanntes Schema.");
  invariant(value.releaseId === releaseId, "Buildcache-Inventarplan gehört zu einem anderen Release.");
  invariant(Array.isArray(value.files) && value.files.length > 0, "Buildcache-Inventarplan ist leer.");

  const sourcePaths = new Set();
  const cachePaths = new Set();
  const files = value.files.map((entry, index) => {
    exactObject(entry, ["sourceFile", "cacheFile"], `files[${index}]`);
    const sourceFile = portablePath(entry.sourceFile, `files[${index}].sourceFile`);
    const cacheFile = cachePath(entry.cacheFile, `files[${index}].cacheFile`);
    const sourceKey = sourceFile.toLowerCase();
    const cacheKey = cacheFile.toLowerCase();
    invariant(!sourcePaths.has(sourceKey), `Quellpfad ${sourceFile} ist doppelt oder kollidiert bei Groß-/Kleinschreibung.`);
    invariant(!cachePaths.has(cacheKey), `Cachepfad ${cacheFile} ist doppelt oder kollidiert bei Groß-/Kleinschreibung.`);
    sourcePaths.add(sourceKey);
    cachePaths.add(cacheKey);
    return { sourceFile, cacheFile };
  });
  return files.sort((left, right) => comparePaths(left.cacheFile, right.cacheFile));
}

export function validateMapBuildCacheInventory(value) {
  exactObject(value, ["schema", "releaseId", "files"], "Buildcache-Inventar");
  invariant(value.schema === MAP_BUILD_CACHE_INVENTORY_SCHEMA, "Buildcache-Inventar hat ein unbekanntes Schema.");
  validateReleaseId(value.releaseId);
  invariant(Array.isArray(value.files) && value.files.length > 0, "Buildcache-Inventar ist leer.");
  const paths = new Set();
  let previousPath = "";
  for (const [index, entry] of value.files.entries()) {
    exactObject(entry, ["path", "bytes", "sha256"], `files[${index}]`);
    const path = cachePath(entry.path, `files[${index}].path`);
    invariant(!paths.has(path.toLowerCase()), `Cachepfad ${path} ist doppelt oder kollidiert bei Groß-/Kleinschreibung.`);
    invariant(index === 0 || comparePaths(previousPath, path) < 0, "Buildcache-Inventar muss nach Cachepfad sortiert sein.");
    invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > 0, `${path} besitzt keine gültige Bytezahl.`);
    invariant(typeof entry.sha256 === "string" && SHA256.test(entry.sha256), `${path} besitzt keinen gültigen SHA-256.`);
    paths.add(path.toLowerCase());
    previousPath = path;
  }
  return value;
}

export function serializeMapBuildCacheInventory(value) {
  validateMapBuildCacheInventory(value);
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function loadMapBuildCacheInventoryPlan(planPath) {
  const path = resolve(planPath);
  const pathBefore = await lstat(path, { bigint: true });
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink(), "Buildcache-Inventarplan muss eine reguläre Datei ohne symbolischen Link sein.");
  const handle = await open(path, "r");
  let bytes;
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && sameMetadata(pathBefore, before), "Buildcache-Inventarplan änderte sich vor dem Lesen.");
    invariant(before.size > 0n && before.size <= BigInt(MAX_PLAN_BYTES), "Buildcache-Inventarplan ist leer oder zu groß.");
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    invariant(pathAfter.isFile() && !pathAfter.isSymbolicLink(), "Buildcache-Inventarplan ist nach dem Lesen keine reguläre Datei mehr.");
    invariant(sameMetadata(before, after) && sameMetadata(after, pathAfter) && BigInt(bytes.length) === after.size, "Buildcache-Inventarplan änderte sich beim Lesen.");
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Buildcache-Inventarplan ist kein gültiges UTF-8-JSON.");
  }
}

export async function buildMapBuildCacheInventory({ releaseId, artifactRoot, plan }) {
  const mappings = validateMapBuildCacheInventoryPlan(plan, releaseId);
  const root = await resolveArtifactRoot(artifactRoot);
  const files = [];
  for (const [index, mapping] of mappings.entries()) {
    const proof = await streamedFileProof(root, mapping.sourceFile, `files[${index}].sourceFile`);
    files.push({ path: mapping.cacheFile, bytes: proof.bytes, sha256: proof.sha256 });
  }
  const inventory = { schema: MAP_BUILD_CACHE_INVENTORY_SCHEMA, releaseId, files };
  const inventoryBytes = serializeMapBuildCacheInventory(inventory);
  return {
    inventory,
    inventoryBytes,
    inventorySha256: createHash("sha256").update(inventoryBytes).digest("hex"),
  };
}

async function writeNewAtomic(outputPath, bytes) {
  const requested = resolve(outputPath);
  const requestedParent = dirname(requested);
  await mkdir(requestedParent, { recursive: true });
  const parentMetadata = await lstat(requestedParent);
  invariant(parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink(), "Ausgabeverzeichnis muss ein reguläres Verzeichnis ohne symbolischen Link sein.");
  const parent = await realpath(requestedParent);
  const output = resolve(parent, basename(requested));
  const remainder = relative(parent, output);
  invariant(remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder), "Ausgabepfad verlässt sein Verzeichnis.");
  const temporary = resolve(parent, `.${basename(output)}.${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, output);
    return output;
  } finally {
    if (temporaryExists) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!(error !== null && typeof error === "object" && error.code === "ENOENT")) throw error;
      }
    }
  }
}

export async function writeMapBuildCacheInventory(result, outputPath) {
  invariant(result !== null && typeof result === "object" && Buffer.isBuffer(result.inventoryBytes), "Buildergebnis besitzt keine Inventarbytes.");
  const expectedBytes = serializeMapBuildCacheInventory(result.inventory);
  invariant(expectedBytes.equals(result.inventoryBytes), "Buildergebnis und Inventarbytes widersprechen sich.");
  const path = await writeNewAtomic(outputPath, result.inventoryBytes);
  return {
    path,
    bytes: result.inventoryBytes.length,
    sha256: createHash("sha256").update(result.inventoryBytes).digest("hex"),
    files: result.inventory.files.length,
  };
}
