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

const SPEC_SCHEMAS = new Set([
  "zugfolge-map-release-build-evidence-spec/v2",
  "zugfolge-map-release-build-evidence-spec/v3",
]);
const RECEIPT_SCHEMA = "zugfolge-cross-release-reuse-materialization/v1";
const REUSE_MODE = "byte-identical-cross-release";
const RELEASE_ID = /^(?<family>[a-z0-9][a-z0-9._-]*-)(?<year>20\d{2})\.(?<patch>[1-9]\d*)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MUTABLE_TOKEN = /(?:^|[./_:@-])(latest|unversioned|main|master|head)(?:$|[./_:@-])/iu;

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
  invariant(parts.every((part) => part !== "" && part !== "." && part !== ".."), `${label} enthält einen unsicheren Pfadabschnitt.`);
  invariant(!MUTABLE_TOKEN.test(value), `${label} darf weder latest noch unversioniert sein.`);
  return value;
}

function release(value, label) {
  const match = typeof value === "string" ? RELEASE_ID.exec(value) : null;
  invariant(match !== null, `${label} ist kein unveränderlicher Jahres-Patchrelease.`);
  return match;
}

function lexicalPath(root, file, label) {
  const path = resolve(root, portablePath(file, label));
  const remainder = relative(root, path);
  invariant(
    remainder !== ""
      && remainder !== ".."
      && !remainder.startsWith(`..${sep}`)
      && !isAbsolute(remainder),
    `${label} verlässt die Artefaktwurzel.`,
  );
  return path;
}

async function rootPath(artifactRoot) {
  const requested = resolve(artifactRoot);
  const metadata = await lstat(requested);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Artefaktwurzel ist kein reguläres Verzeichnis.");
  return realpath(requested);
}

async function containedExistingFile(root, file, label) {
  const path = lexicalPath(root, file, label);
  const parts = relative(root, path).split(sep);
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    const metadata = await lstat(cursor);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link oder Junction enthalten.`);
    if (index < parts.length - 1) invariant(metadata.isDirectory(), `${label} besitzt einen ungültigen Zwischenpfad.`);
    else invariant(metadata.isFile(), `${label} ist keine reguläre Datei.`);
  }
  const actual = await realpath(path);
  invariant(actual === path, `${label} besitzt keine kanonische Pfadidentität.`);
  return path;
}

async function assertTargetAbsent(root, file, label) {
  const path = lexicalPath(root, file, label);
  const parts = relative(root, path).split(sep);
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    let metadata;
    try {
      metadata = await lstat(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") return path;
      throw error;
    }
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link oder Junction enthalten.`);
    if (index < parts.length - 1) invariant(metadata.isDirectory(), `${label} besitzt einen ungültigen Zwischenpfad.`);
    else throw new Error(`${label} existiert bereits; create-new verweigert jede Überschreibung.`);
  }
  return path;
}

function canonicalTarget(sourceFile, sourceReleaseId, targetReleaseId, label) {
  const source = release(sourceReleaseId, `${label}.sourceReleaseId`);
  const target = release(targetReleaseId, `${label}.targetReleaseId`);
  invariant(
    source.groups.family === target.groups.family
      && source.groups.year === target.groups.year
      && Number(source.groups.patch) < Number(target.groups.patch),
    `${label} bindet keine ältere Quelle derselben Jahresfamilie.`,
  );
  const sourceCorpus = `germany-${source.groups.year}.${source.groups.patch}`;
  const targetCorpus = `germany-${target.groups.year}.${target.groups.patch}`;
  invariant(sourceFile.includes(sourceCorpus), `${label}.sourceFile ist nicht an den Quellrelease gebunden.`);
  const targetFile = sourceFile.replace(sourceCorpus, targetCorpus);
  invariant(targetFile !== sourceFile && !targetFile.includes(sourceCorpus), `${label}.sourceFile lässt sich nicht eindeutig auf den Zielrelease abbilden.`);
  return targetFile;
}

export function crossReleaseReusePlan(spec) {
  invariant(SPEC_SCHEMAS.has(spec?.schema), "Cross-Release-Wiederverwendung verlangt Build-Evidence-Spezifikation v2 oder v3.");
  const target = release(spec.releaseId, "releaseId");
  invariant(Array.isArray(spec.inputs), "Build-Evidence-Spezifikation besitzt keine Eingaben.");
  const artifacts = [];
  for (const [inputIndex, input] of spec.inputs.entries()) {
    if (input?.reuse === undefined) continue;
    invariant(input.kind === "specification", `Eingabe[${inputIndex}] darf Wiederverwendung nur für eine Spezifikation deklarieren.`);
    const label = `Eingabe[${inputIndex}].reuse`;
    exactKeys(input.reuse, ["mode", "sourceReleaseId", "targetReleaseId", "artifacts"], label);
    invariant(input.reuse.mode === REUSE_MODE, `${label}.mode ist nicht freigegeben.`);
    invariant(input.reuse.sourceReleaseId === input.version, `${label} driftet von der Spezifikationsversion.`);
    invariant(input.reuse.targetReleaseId === spec.releaseId, `${label} driftet vom Buildrelease.`);
    const source = release(input.reuse.sourceReleaseId, `${label}.sourceReleaseId`);
    invariant(
      source.groups.family === target.groups.family
        && source.groups.year === target.groups.year
        && Number(source.groups.patch) < Number(target.groups.patch),
      `${label} bindet keine ältere Quelle derselben Jahresfamilie.`,
    );
    invariant(Array.isArray(input.reuse.artifacts) && input.reuse.artifacts.length > 0, `${label} besitzt kein Artefaktinventar.`);
    const inputArtifacts = input.reuse.artifacts.map((artifact, artifactIndex) => {
      const artifactLabel = `${label}.artifacts[${artifactIndex}]`;
      exactKeys(artifact, ["sourceFile", "targetFile", "bytes", "sha256"], artifactLabel);
      const sourceFile = portablePath(artifact.sourceFile, `${artifactLabel}.sourceFile`);
      const targetFile = portablePath(artifact.targetFile, `${artifactLabel}.targetFile`);
      invariant(targetFile === canonicalTarget(sourceFile, input.reuse.sourceReleaseId, input.reuse.targetReleaseId, artifactLabel), `${artifactLabel}.targetFile ist nicht kanonisch.`);
      invariant(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0, `${artifactLabel}.bytes ist ungültig.`);
      invariant(SHA256.test(artifact.sha256), `${artifactLabel}.sha256 ist ungültig.`);
      return Object.freeze({ sourceFile, targetFile, bytes: artifact.bytes, sha256: artifact.sha256 });
    });
    invariant(
      JSON.stringify(inputArtifacts.map(({ sourceFile }) => sourceFile))
        === JSON.stringify(inputArtifacts.map(({ sourceFile }) => sourceFile).sort()),
      `${label}.artifacts ist nicht kanonisch sortiert.`,
    );
    artifacts.push(...inputArtifacts);
  }
  invariant(artifacts.length > 0, "Build-Evidence-Spezifikation deklariert keine Cross-Release-Wiederverwendung.");
  invariant(new Set(artifacts.map(({ sourceFile }) => sourceFile)).size === artifacts.length, "Cross-Release-Plan besitzt doppelte Quelldateien.");
  invariant(new Set(artifacts.map(({ targetFile }) => targetFile)).size === artifacts.length, "Cross-Release-Plan besitzt doppelte Zieldateien.");
  return Object.freeze({
    schema: RECEIPT_SCHEMA,
    releaseId: spec.releaseId,
    artifacts: Object.freeze(artifacts),
  });
}

async function stageArtifact(root, stagingRoot, artifact, index) {
  const label = `Wiederverwendungsartefakt[${index}]`;
  const source = await containedExistingFile(root, artifact.sourceFile, `${label}.sourceFile`);
  const stagingFile = resolve(stagingRoot, `${String(index).padStart(4, "0")}.artifact`);
  const digest = createHash("sha256");
  let bytes = 0;
  let sourceHandle;
  let stagingHandle;
  let completed = false;
  try {
    sourceHandle = await open(source, "r");
    stagingHandle = await open(stagingFile, "wx", 0o600);
    const before = await sourceHandle.stat({ bigint: true });
    invariant(before.isFile() && before.size === BigInt(artifact.bytes), `${label}.sourceFile weicht von der gepinnten Bytezahl ab.`);
    for await (const chunk of createReadStream(source, { fd: sourceHandle.fd, autoClose: false })) {
      digest.update(chunk);
      bytes += chunk.length;
      await stagingHandle.write(chunk);
    }
    await stagingHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    invariant(
      sameStableFileState(before, after) && BigInt(bytes) === after.size,
      `${label}.sourceFile änderte sich während der Materialisierung.`,
    );
    const currentSource = await lstat(source, { bigint: true });
    invariant(
      currentSource.isFile() && sameStableFileState(after, currentSource),
      `${label}.sourceFile verweist nicht mehr auf die geöffnete unveränderliche Quelle.`,
    );
    invariant(bytes === artifact.bytes && digest.digest("hex") === artifact.sha256, `${label}.sourceFile weicht vom gepinnten Byte-SHA-Beleg ab.`);
    const staged = await stagingHandle.stat({ bigint: true });
    invariant(staged.size === BigInt(artifact.bytes), `${label}.Stagingdatei ist unvollständig.`);
    completed = true;
    return { artifact, stagingFile, stagedIdentity: { dev: staged.dev, ino: staged.ino, size: staged.size } };
  } finally {
    await sourceHandle?.close();
    await stagingHandle?.close();
    if (!completed) await rm(stagingFile, { force: true });
  }
}

async function ensureTargetParent(root, targetFile, createdDirectories) {
  const target = lexicalPath(root, targetFile, "targetFile");
  const parts = relative(root, dirname(target)).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    try {
      await mkdir(cursor, { mode: 0o700 });
      createdDirectories.push(cursor);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const metadata = await lstat(cursor);
    invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Zielpfad enthält einen symbolischen Link, eine Junction oder eine Nicht-Verzeichnis-Komponente.");
    const actual = await realpath(cursor);
    const remainder = relative(root, actual);
    invariant(remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder), "Zielpfad verlässt die Artefaktwurzel.");
  }
  return target;
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

async function verifyPublishedArtifact(root, entry, index) {
  const label = `Wiederverwendungsartefakt[${index}].targetFile`;
  const target = await containedExistingFile(root, entry.artifact.targetFile, label);
  const handle = await open(target, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(
      before.isFile()
        && sameFilesystemIdentity(before, entry.stagedIdentity)
        && before.size === BigInt(entry.artifact.bytes),
      `${label} besitzt nicht mehr die atomar veröffentlichte Dateidentität.`,
    );
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(target, { fd: handle.fd, autoClose: false })) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    const after = await handle.stat({ bigint: true });
    invariant(sameStableFileState(before, after), `${label} änderte sich während der Abschlussprüfung.`);
    const currentTarget = await lstat(target, { bigint: true });
    invariant(
      currentTarget.isFile() && sameStableFileState(after, currentTarget),
      `${label} verweist nicht mehr auf die abschließend geprüfte Datei.`,
    );
    invariant(
      bytes === entry.artifact.bytes && digest.digest("hex") === entry.artifact.sha256,
      `${label} weicht nach der atomaren Veröffentlichung vom gepinnten Byte-SHA-Beleg ab.`,
    );
  } finally {
    await handle.close();
  }
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

async function removeEmptyCreatedDirectories(createdDirectories) {
  for (const directory of [...createdDirectories].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
    }
  }
}

export async function materializeCrossReleaseReuse({
  spec,
  artifactRoot,
  publishLink = link,
}) {
  const plan = crossReleaseReusePlan(spec);
  invariant(typeof publishLink === "function", "publishLink fehlt.");
  const root = await rootPath(artifactRoot);
  for (const [index, artifact] of plan.artifacts.entries()) {
    await assertTargetAbsent(root, artifact.targetFile, `Wiederverwendungsartefakt[${index}].targetFile`);
  }

  const stagingRoot = resolve(root, `.cross-release-reuse-${process.pid}-${randomUUID()}`);
  await mkdir(stagingRoot, { mode: 0o700 });
  const staged = [];
  const createdTargets = [];
  const createdDirectories = [];
  try {
    for (const [index, artifact] of plan.artifacts.entries()) {
      staged.push(await stageArtifact(root, stagingRoot, artifact, index));
    }
    for (const entry of staged) {
      const target = await ensureTargetParent(root, entry.artifact.targetFile, createdDirectories);
      await publishLink(entry.stagingFile, target);
      createdTargets.push({ path: target, identity: entry.stagedIdentity });
      const targetIdentity = await lstat(target, { bigint: true });
      invariant(
        sameFilesystemIdentity(targetIdentity, entry.stagedIdentity)
          && targetIdentity.size === BigInt(entry.artifact.bytes),
        "Atomare Veröffentlichung besitzt nicht die geprüfte Dateidentität.",
      );
    }
    for (const [index, entry] of staged.entries()) await verifyPublishedArtifact(root, entry, index);
    return Object.freeze({
      schema: RECEIPT_SCHEMA,
      releaseId: plan.releaseId,
      artifactCount: plan.artifacts.length,
      artifacts: Object.freeze(plan.artifacts.map((artifact) => Object.freeze({ ...artifact }))),
    });
  } catch (error) {
    await rollbackCreatedTargets(createdTargets);
    await removeEmptyCreatedDirectories(createdDirectories);
    throw error;
  } finally {
    for (const entry of staged) await rm(entry.stagingFile, { force: true });
    await rmdir(stagingRoot);
  }
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const [specPath, artifactRoot, ...extra] = process.argv.slice(2);
  if (!specPath || !artifactRoot || extra.length > 0) {
    throw new Error("Aufruf: materialize-cross-release-reuse.mjs BUILD-EVIDENCE-SPEC.json ARTIFACT_ROOT");
  }
  readFile(resolve(specPath), "utf8")
    .then(JSON.parse)
    .then((spec) => materializeCrossReleaseReuse({ spec, artifactRoot }))
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
