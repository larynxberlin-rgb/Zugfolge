#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ANNUAL_SOURCE_CAPTURE_SCHEMA,
  validateAnnualSourceCapturePlan,
} from "./annual-source-capture.mjs";

const RECEIPT_SCHEMA = "zugfolge-annual-source-cache-materialization/v1";
const DEM_MANIFEST_SCHEMA = "zugfolge-copernicus-dem-capture/v1";
const SHA256 = /^[a-f0-9]{64}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt.`);
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `${label} besitzt fremde oder fehlende Felder.`,
  );
  return value;
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value.length > 0 && !isAbsolute(value), `${label} muss ein relativer Pfad sein.`);
  invariant(!value.includes("\\") && !value.includes("\0"), `${label} ist nicht portabel.`);
  const parts = value.split("/");
  invariant(parts.every((part) => part !== "" && part !== "." && part !== ".."), `${label} enthaelt einen unsicheren Pfadabschnitt.`);
  return value;
}

function lexicalPath(root, file, label) {
  const path = resolve(root, portablePath(file, label));
  const remainder = relative(root, path);
  invariant(
    remainder !== ""
      && remainder !== ".."
      && !remainder.startsWith(`..${sep}`)
      && !isAbsolute(remainder),
    `${label} verlaesst die Wurzel.`,
  );
  return path;
}

async function regularRoot(requestedRoot, label) {
  const requested = resolve(requestedRoot);
  const metadata = await lstat(requested);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} ist kein regulaeres symlinkfreies Verzeichnis.`);
  return realpath(requested);
}

async function containedExistingPath(root, file, label, expectedKind) {
  const path = lexicalPath(root, file, label);
  const parts = relative(root, path).split(sep);
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    const metadata = await lstat(cursor);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link, Junction oder Reparse-Pfad enthalten.`);
    if (index < parts.length - 1) {
      invariant(metadata.isDirectory(), `${label} besitzt einen ungueltigen Zwischenpfad.`);
    } else if (expectedKind === "file") {
      invariant(metadata.isFile(), `${label} ist keine regulaere Datei.`);
    } else {
      invariant(metadata.isDirectory(), `${label} ist kein regulaeres Verzeichnis.`);
    }
  }
  const actual = await realpath(path);
  invariant(actual === path, `${label} besitzt keine kanonische Pfadidentitaet.`);
  return path;
}

async function containedExistingFile(root, file, label) {
  return containedExistingPath(root, file, label, "file");
}

async function containedExistingDirectory(root, file, label) {
  return containedExistingPath(root, file, label, "directory");
}

async function assertTargetDirectoryAbsent(root, directory) {
  const label = "Zielverzeichnis";
  const path = lexicalPath(root, directory, label);
  const parts = relative(root, path).split(sep);
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    let metadata;
    try {
      metadata = await lstat(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") {
        invariant(index === parts.length - 1, `${label} besitzt einen fehlenden Zwischenpfad.`);
        return path;
      }
      throw error;
    }
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link, Junction oder Reparse-Pfad enthalten.`);
    invariant(metadata.isDirectory(), `${label} besitzt einen ungueltigen Zwischenpfad.`);
    if (index === parts.length - 1) throw new Error(`${label} existiert bereits; create-new verweigert jede Uebernahme.`);
  }
  throw new Error(`${label} existiert bereits; create-new verweigert jede Uebernahme.`);
}

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileState(left, right) {
  return sameFilesystemIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function verifyStableFile(path, expected, label) {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && before.size === BigInt(expected.bytes), `${label} weicht von der gepinnten Bytezahl ab.`);
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(path, { fd: handle.fd, autoClose: false })) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    const after = await handle.stat({ bigint: true });
    invariant(sameStableFileState(before, after), `${label} aenderte sich waehrend der Pruefung.`);
    const current = await lstat(path, { bigint: true });
    invariant(current.isFile() && sameStableFileState(after, current), `${label} verweist nicht mehr auf die gepruefte Datei.`);
    invariant(bytes === expected.bytes && digest.digest("hex") === expected.sha256, `${label} verletzt die gepinnte Byte-/SHA-Bindung.`);
    return { dev: after.dev, ino: after.ino, size: after.size };
  } finally {
    await handle.close();
  }
}

function validateCapture(plan, capture, capturePlanSha256) {
  exactKeys(capture, ["schema", "releaseId", "timetableYear", "capturePlanSha256", "capturedAt", "sources"], "Source-Capture");
  invariant(capture.schema === ANNUAL_SOURCE_CAPTURE_SCHEMA, "Source-Capture besitzt kein v2-Schema.");
  invariant(capture.releaseId === plan.releaseId && capture.timetableYear === plan.timetableYear, "Source-Capture driftet vom Jahresplan.");
  invariant(SHA256.test(capturePlanSha256) && capture.capturePlanSha256 === capturePlanSha256, "Source-Capture bindet nicht die uebergebene Plandatei.");
  const capturedAt = Date.parse(capture.capturedAt);
  invariant(Number.isFinite(capturedAt) && capture.capturedAt.endsWith("Z") && capturedAt >= Date.parse(plan.notBefore), "Source-Capture besitzt keinen frischen UTC-Zeitpunkt.");
  invariant(Array.isArray(capture.sources) && capture.sources.length === plan.sources.length, "Source-Capture besitzt nicht exakt die Quellen des Jahresplans.");
  for (const [index, source] of plan.sources.entries()) {
    const captured = capture.sources[index];
    exactKeys(captured, ["id", "version", "file", "bytes", "sha256"], `Source-Capture.sources[${index}]`);
    invariant(
      captured.id === source.id
        && captured.version === source.version
        && captured.file === source.captureFile
        && captured.bytes === source.bytes
        && captured.sha256 === source.sha256,
      `Source-Capture.sources[${index}] driftet vom Jahresplan.`,
    );
  }
}

function aggregateTileHash(tiles) {
  return createHash("sha256").update(tiles.map(({ tileId, sha256 }) => `${tileId}:${sha256}\n`).join("")).digest("hex");
}

function validateDemManifest(manifest, source) {
  exactKeys(manifest, ["schema", "source", "input", "tiles", "aggregateTileSha256"], "DEM-Manifest");
  invariant(manifest.schema === DEM_MANIFEST_SCHEMA && manifest.source?.sourceId === source.id, "DEM-Manifest bindet eine fremde Quelle.");
  invariant(Array.isArray(manifest.tiles) && manifest.tiles.length > 0, "DEM-Manifest besitzt keine Kacheln.");
  const artifacts = manifest.tiles.map((tile, index) => {
    const label = `DEM-Manifest.tiles[${index}]`;
    exactKeys(tile, ["tileId", "objectKey", "file", "bytes", "sha256", "etag", "lastModified"], label);
    invariant(typeof tile.tileId === "string" && tile.tileId.length > 0, `${label}.tileId fehlt.`);
    invariant(typeof tile.file === "string" && tile.file.length > 0 && !tile.file.includes("/") && !tile.file.includes("\\") && tile.file !== "." && tile.file !== "..", `${label}.file ist kein sicherer Dateiname.`);
    invariant(Number.isSafeInteger(tile.bytes) && tile.bytes > 0 && SHA256.test(tile.sha256), `${label} besitzt keine Byte-/SHA-Bindung.`);
    return Object.freeze({ tileId: tile.tileId, file: tile.file, bytes: tile.bytes, sha256: tile.sha256 });
  });
  invariant(new Set(artifacts.map(({ tileId }) => tileId)).size === artifacts.length, "DEM-Manifest besitzt doppelte Kachel-IDs.");
  invariant(new Set(artifacts.map(({ file }) => file)).size === artifacts.length, "DEM-Manifest besitzt doppelte Dateien.");
  invariant(
    JSON.stringify(artifacts.map(({ tileId }) => tileId)) === JSON.stringify(artifacts.map(({ tileId }) => tileId).sort()),
    "DEM-Manifest ist nicht kanonisch nach Kachel-ID sortiert.",
  );
  const bytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  invariant(Number.isSafeInteger(bytes) && bytes === source.bytes, "DEM-Manifest verletzt die gepinnte Gesamtbytezahl.");
  invariant(manifest.aggregateTileSha256 === source.sha256 && aggregateTileHash(artifacts) === source.sha256, "DEM-Manifest verletzt die aggregierte SHA-Bindung.");
  return Object.freeze(artifacts);
}

async function stageArtifact(sourceRoot, sourceDirectory, stagingRoot, artifact, index) {
  const label = `DEM-Kachel ${artifact.tileId}`;
  const sourceFile = await containedExistingFile(sourceRoot, `${sourceDirectory}/${artifact.file}`, label);
  const stagingFile = resolve(stagingRoot, `${String(index).padStart(4, "0")}.artifact`);
  const digest = createHash("sha256");
  let bytes = 0;
  let sourceHandle;
  let stagingHandle;
  let completed = false;
  try {
    sourceHandle = await open(sourceFile, "r");
    stagingHandle = await open(stagingFile, "wx", 0o600);
    const before = await sourceHandle.stat({ bigint: true });
    invariant(before.isFile() && before.size === BigInt(artifact.bytes), `${label} weicht von der gepinnten Bytezahl ab.`);
    for await (const chunk of createReadStream(sourceFile, { fd: sourceHandle.fd, autoClose: false })) {
      digest.update(chunk);
      bytes += chunk.length;
      await stagingHandle.write(chunk);
    }
    await stagingHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    invariant(sameStableFileState(before, after) && BigInt(bytes) === after.size, `${label} aenderte sich waehrend der Materialisierung.`);
    const currentSource = await lstat(sourceFile, { bigint: true });
    invariant(currentSource.isFile() && sameStableFileState(after, currentSource), `${label} verweist nicht mehr auf die geoeffnete Quelle.`);
    invariant(bytes === artifact.bytes && digest.digest("hex") === artifact.sha256, `${label} verletzt die gepinnte Byte-/SHA-Bindung.`);
    const staged = await stagingHandle.stat({ bigint: true });
    invariant(staged.size === BigInt(artifact.bytes), `${label} wurde unvollstaendig gestaged.`);
    completed = true;
    return { artifact, stagingFile, stagedIdentity: { dev: staged.dev, ino: staged.ino, size: staged.size } };
  } finally {
    await sourceHandle?.close();
    await stagingHandle?.close();
    if (!completed) await rm(stagingFile, { force: true });
  }
}

async function verifyPublishedArtifact(targetRoot, targetDirectory, entry) {
  const label = `Materialisierte DEM-Kachel ${entry.artifact.tileId}`;
  const target = await containedExistingFile(targetRoot, `${targetDirectory}/${entry.artifact.file}`, label);
  const identity = await verifyStableFile(target, entry.artifact, label);
  invariant(sameFilesystemIdentity(identity, entry.stagedIdentity), `${label} besitzt nicht die atomar veroeffentlichte Dateidentitaet.`);
}

async function rollbackCreatedTargets(createdTargets) {
  for (const entry of [...createdTargets].reverse()) {
    try {
      const current = await lstat(entry.path, { bigint: true });
      if (sameFilesystemIdentity(current, entry.identity)) await rm(entry.path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function materializeAnnualSourceCache({
  plan: planInput,
  catalog,
  rightsRegistry,
  capture,
  capturePlanSha256,
  captureRoot,
  targetRoot,
  sourceId,
  publishLink = link,
}) {
  const plan = validateAnnualSourceCapturePlan(planInput, catalog, rightsRegistry);
  validateCapture(plan, capture, capturePlanSha256);
  invariant(typeof publishLink === "function", "publishLink fehlt.");
  const source = plan.sources.find(({ id }) => id === sourceId);
  invariant(source !== undefined, "Ausgewaehlte Quelle fehlt im Jahresplan.");
  invariant(source.kind === "dem-tile-set", "Source-Cache-Materialisierung akzeptiert ausschliesslich einen manifestgebundenen DEM-Kachelsatz.");

  const sourceRootPath = await regularRoot(captureRoot, "Capture-Wurzel");
  const targetRootPath = await regularRoot(targetRoot, "Cache-Wurzel");
  const sourceManifest = await containedExistingFile(sourceRootPath, source.manifest, "DEM-Quellmanifest");
  const targetManifest = await containedExistingFile(targetRootPath, source.manifest, "DEM-Cachemanifest");
  const manifestProof = { bytes: source.manifestBytes, sha256: source.manifestSha256 };
  await verifyStableFile(sourceManifest, manifestProof, "DEM-Quellmanifest");
  await verifyStableFile(targetManifest, manifestProof, "DEM-Cachemanifest");
  const manifest = JSON.parse(await readFile(sourceManifest, "utf8"));
  await verifyStableFile(sourceManifest, manifestProof, "DEM-Quellmanifest");
  const artifacts = validateDemManifest(manifest, source);

  const sourceDirectory = await containedExistingDirectory(sourceRootPath, source.directory, "DEM-Quellverzeichnis");
  invariant(sourceDirectory === lexicalPath(sourceRootPath, source.directory, "DEM-Quellverzeichnis"), "DEM-Quellverzeichnis besitzt keine kanonische Pfadidentitaet.");
  const targetParent = dirname(source.directory).replaceAll("\\", "/");
  await containedExistingDirectory(targetRootPath, targetParent, "DEM-Zielelternverzeichnis");
  const targetDirectory = await assertTargetDirectoryAbsent(targetRootPath, source.directory);

  const stagingRoot = resolve(targetRootPath, `.annual-source-cache-${process.pid}-${randomUUID()}`);
  await mkdir(stagingRoot, { mode: 0o700 });
  const staged = [];
  const createdTargets = [];
  let createdTargetDirectory = null;
  try {
    for (const [index, artifact] of artifacts.entries()) {
      staged.push(await stageArtifact(sourceRootPath, source.directory, stagingRoot, artifact, index));
    }
    await mkdir(targetDirectory, { mode: 0o700 });
    const targetDirectoryIdentity = await lstat(targetDirectory, { bigint: true });
    invariant(targetDirectoryIdentity.isDirectory() && !targetDirectoryIdentity.isSymbolicLink(), "DEM-Zielverzeichnis ist nach create-new kein regulaeres Verzeichnis.");
    createdTargetDirectory = { path: targetDirectory, identity: targetDirectoryIdentity };
    for (const entry of staged) {
      const currentDirectory = await lstat(targetDirectory, { bigint: true });
      invariant(
        currentDirectory.isDirectory()
          && !currentDirectory.isSymbolicLink()
          && sameFilesystemIdentity(currentDirectory, targetDirectoryIdentity),
        "DEM-Zielverzeichnis wurde waehrend der atomaren Veroeffentlichung ausgetauscht.",
      );
      const target = resolve(targetDirectory, entry.artifact.file);
      await publishLink(entry.stagingFile, target);
      createdTargets.push({ path: target, identity: entry.stagedIdentity });
      const targetIdentity = await lstat(target, { bigint: true });
      invariant(
        targetIdentity.isFile()
          && !targetIdentity.isSymbolicLink()
          && sameFilesystemIdentity(targetIdentity, entry.stagedIdentity)
          && targetIdentity.size === BigInt(entry.artifact.bytes),
        "Atomare DEM-Veroeffentlichung besitzt nicht die gepruefte Dateidentitaet.",
      );
    }
    for (const entry of staged) await verifyPublishedArtifact(targetRootPath, source.directory, entry);
    await verifyStableFile(sourceManifest, manifestProof, "DEM-Quellmanifest");
    await verifyStableFile(targetManifest, manifestProof, "DEM-Cachemanifest");
    return Object.freeze({
      schema: RECEIPT_SCHEMA,
      releaseId: plan.releaseId,
      sourceId: source.id,
      capturePlanSha256,
      manifest: Object.freeze({ file: source.manifest, ...manifestProof }),
      artifactCount: artifacts.length,
      bytes: source.bytes,
      sha256: source.sha256,
      artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze({
        file: `${source.directory}/${artifact.file}`,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      }))),
    });
  } catch (error) {
    await rollbackCreatedTargets(createdTargets);
    if (createdTargetDirectory !== null) {
      try {
        const current = await lstat(createdTargetDirectory.path, { bigint: true });
        if (sameFilesystemIdentity(current, createdTargetDirectory.identity)) await rmdir(createdTargetDirectory.path);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  } finally {
    for (const entry of staged) await rm(entry.stagingFile, { force: true });
    await rmdir(stagingRoot);
  }
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const [planPath, catalogPath, rightsPath, capturePath, captureRoot, targetRoot, sourceId, ...extra] = process.argv.slice(2);
  if (!planPath || !catalogPath || !rightsPath || !capturePath || !captureRoot || !targetRoot || !sourceId || extra.length > 0) {
    throw new Error("Aufruf: materialize-annual-source-cache.mjs PLAN.json SOURCE_CATALOG.json RIGHTS.json SOURCE_CAPTURE.json CAPTURE_ROOT CACHE_ROOT SOURCE_ID");
  }
  Promise.all([
    readFile(resolve(planPath)),
    readFile(resolve(catalogPath), "utf8"),
    readFile(resolve(rightsPath), "utf8"),
    readFile(resolve(capturePath), "utf8"),
  ])
    .then(([planBytes, catalogJson, rightsJson, captureJson]) => materializeAnnualSourceCache({
      plan: JSON.parse(planBytes.toString("utf8")),
      catalog: JSON.parse(catalogJson),
      rightsRegistry: JSON.parse(rightsJson),
      capture: JSON.parse(captureJson),
      capturePlanSha256: createHash("sha256").update(planBytes).digest("hex"),
      captureRoot,
      targetRoot,
      sourceId,
    }))
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
