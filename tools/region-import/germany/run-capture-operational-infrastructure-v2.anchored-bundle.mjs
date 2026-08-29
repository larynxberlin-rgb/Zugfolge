#!/usr/bin/env node

// tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs
import { createHash as createHash8 } from "node:crypto";
import { readFile as readFile6, realpath as realpath7 } from "node:fs/promises";
import { isAbsolute as isAbsolute6, relative as relative6, resolve as resolve8, sep as sep6 } from "node:path";

// tools/region-import/germany/annual-create-new-artifact.mjs
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
var GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SCHEMA = "zugfolge-germany-annual-create-new-artifact-completion/v1";
var GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX = ".zugfolge-complete.json";
var SHA256 = /^[a-f0-9]{64}$/u;
var MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
var WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
var WINDOWS_ANNUAL_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$assemblyBytes = [Convert]::FromBase64String([string]$request.helperBase64)
$null = [Reflection.Assembly]::Load($assemblyBytes)
function Proof($value) {
  [ordered]@{
    file = [string]$value.File
    bytes = [Int64]$value.Bytes
    sha256 = [string]$value.Sha256
    identity = [ordered]@{ dev = [string]$value.Identity.Dev; ino = [string]$value.Identity.Ino }
  }
}
if ($request.mode -ceq 'publish') {
  $pair = $null
  try {
    $pair = [ZugfolgeAnnualArtifactPublisher]::PublishOrRecoverPair(
      [string]$request.workspaceRoot,
      [string]$request.stagedDataPath,
      [string]$request.stagedCompletionPath,
      [string]$request.outputRelativeFile,
      [Int64]$request.expectedDataBytes,
      [string]$request.expectedDataSha256,
      [Int64]$request.expectedCompletionBytes,
      [string]$request.expectedCompletionSha256)
    $result = [ordered]@{ artifact = Proof $pair.Artifact; completion = Proof $pair.Completion }
    $pair.Commit()
    $pair = $null
    [Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 8))
  } finally {
    if ($null -ne $pair) { $pair.Dispose() }
  }
} elseif ($request.mode -ceq 'verify') {
  $pair = $null
  try {
    $pair = [ZugfolgeAnnualArtifactPublisher]::VerifyPair(
      [string]$request.workspaceRoot,
      [string]$request.outputRelativeFile,
      [Int64]$request.expectedDataBytes,
      [string]$request.expectedDataSha256,
      [Int64]$request.expectedCompletionBytes,
      [string]$request.expectedCompletionSha256)
    $result = [ordered]@{ artifact = Proof $pair.Artifact; completion = Proof $pair.Completion }
    $pair.Complete()
    $pair = $null
    [Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 8))
  } finally {
    if ($null -ne $pair) { $pair.Dispose() }
  }
} else {
  throw 'Unbekannter Annual-Helper-Modus.'
}
`;
function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
function comparable(pathInput) {
  const value = resolve(pathInput);
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}
function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}
`, "utf8");
}
function portable(root2, pathInput, label) {
  const value = relative(root2, resolve(pathInput));
  invariant(
    value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value),
    `${label} verlaesst die Arbeitswurzel.`
  );
  return value.split(sep).join("/");
}
async function assertCanonicalExistingPath(root2, pathInput, label) {
  const path = resolve(pathInput);
  const rootReal = await realpath(root2);
  const relativePath = portable(root2, path, label);
  const segments = relativePath.split("/");
  let current = root2;
  for (const segment of segments) {
    current = resolve(current, segment);
    const metadata = await lstat(current, { bigint: true });
    invariant(!metadata.isSymbolicLink(), `${label} verwendet einen symbolischen Link oder Junction-Ahnen.`);
  }
  invariant(
    comparable(await realpath(path)) === comparable(resolve(rootReal, ...segments)),
    `${label} verwendet einen symbolischen Link oder Junction-Ahnen.`
  );
  return path;
}
async function readHeldProof(pathInput, label) {
  const path = resolve(pathInput);
  const pathBefore = await lstat(path, { bigint: true });
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.size > 0n && pathBefore.size <= BigInt(MAX_ARTIFACT_BYTES), `${label} ist keine begrenzte regulaere Datei.`);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(sameIdentity(pathBefore, before), `${label} driftete vor dem gehaltenen Lesen.`);
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    invariant(
      pathAfter.isFile() && !pathAfter.isSymbolicLink() && sameIdentity(before, after) && sameIdentity(after, pathAfter) && BigInt(bytes.length) === after.size,
      `${label} driftete waehrend des gehaltenen Lesens.`
    );
    return { bytes, proof: { bytes: bytes.length, sha256: sha256(bytes) }, identity: after };
  } finally {
    await handle.close();
  }
}
function validateFileProof(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.file === "string" && value.file.length > 0 && Number.isSafeInteger(value.bytes) && value.bytes > 0 && typeof value.sha256 === "string" && SHA256.test(value.sha256), `${label} ist kein vollstaendiger Dateibeleg.`);
  return value;
}
async function heldAnchorHelperBytes(root2, anchorHelperProof) {
  const expected = validateFileProof(anchorHelperProof, "Annual-Windows-Anchor-Helper");
  const helperPath = resolve(root2, ...expected.file.split("/"));
  await assertCanonicalExistingPath(root2, helperPath, "Annual-Windows-Anchor-Helper");
  const source = await readHeldProof(helperPath, "Annual-Windows-Anchor-Helper");
  invariant(
    source.proof.bytes === expected.bytes && source.proof.sha256 === expected.sha256,
    "Annual-Windows-Anchor-Helper driftet von seinem gehaltenen Byte-Pin."
  );
  return source.bytes;
}
function validateHelperResult(value, expectedArtifact, expectedCompletion) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Annual-Windows-Anchor-Helper lieferte keinen Ergebnisbeleg."
  );
  for (const [label, proof, expected] of [
    ["artifact", value.artifact, expectedArtifact],
    ["completion", value.completion, expectedCompletion]
  ]) {
    invariant(
      proof !== null && typeof proof === "object" && !Array.isArray(proof) && proof.file === expected.file && proof.bytes === expected.bytes && proof.sha256 === expected.sha256 && proof.identity !== null && typeof proof.identity === "object" && typeof proof.identity.dev === "string" && proof.identity.dev.length > 0 && typeof proof.identity.ino === "string" && proof.identity.ino.length > 0,
      `Annual-Windows-Anchor-Helper.${label} driftet vom erwarteten Dateibeleg.`
    );
  }
  return value;
}
async function invokeWindowsAnnualHelper(request, { anchorHelperProof, invokeAnchorHelper } = {}) {
  if (typeof invokeAnchorHelper === "function") return invokeAnchorHelper(request);
  invariant(process.platform === "win32", "Annual-create-new-Releasepfad verlangt den Windows-Anchor-Helper.");
  const helperBytes = await heldAnchorHelperBytes(resolve(request.workspaceRoot), anchorHelperProof);
  const encodedCommand = Buffer.from(WINDOWS_ANNUAL_HELPER_SCRIPT, "utf16le").toString("base64");
  const envelope = Buffer.from(JSON.stringify({
    ...request,
    helperBase64: helperBytes.toString("base64")
  }), "utf8");
  const result = spawnSync(WINDOWS_POWERSHELL, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand
  ], {
    cwd: "C:\\Windows\\System32",
    encoding: "buffer",
    env: {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      SystemDrive: "C:",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Windows\\System32",
      TMP: "C:\\Windows\\System32",
      WINDIR: "C:\\Windows"
    },
    input: envelope,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  invariant(result.error === void 0, `Annual-Windows-Anchor-Helper konnte nicht gestartet werden: ${result.error?.message ?? "unbekannter Fehler"}.`);
  const stderrText = result.stderr.toString("utf8");
  const benignStartupProgress = stderrText.startsWith("#< CLIXML") && stderrText.includes('S="progress"') && !/S="(?:Error|warning|verbose|debug)"/iu.test(stderrText);
  invariant(
    result.status === 0 && result.signal === null && (stderrText.length === 0 || benignStartupProgress),
    `Annual-Windows-Anchor-Helper scheiterte fail-closed (Exit ${result.status ?? "ohne"}).`
  );
  let value;
  try {
    value = JSON.parse(result.stdout.toString("utf8"));
  } catch (error) {
    throw new Error("Annual-Windows-Anchor-Helper lieferte kein einzelnes JSON-Ergebnis.", { cause: error });
  }
  return value;
}
async function writeStaged(path, bytes, label) {
  const handle = await open(path, "wx", 384);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const held = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(path, { bigint: true });
    invariant(held.isFile() && !pathMetadata.isSymbolicLink() && sameIdentity(held, pathMetadata) && held.size === BigInt(bytes.length), `${label} wurde nicht vollstaendig im Staging materialisiert.`);
  } finally {
    await handle.close();
  }
}
function completionValue(file, proof) {
  return {
    artifact: { file, ...proof },
    schema: GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SCHEMA
  };
}
function validateCompletion(value, expected, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["artifact", "schema"]),
    `${label} besitzt fremde oder fehlende Felder.`
  );
  invariant(
    value.schema === GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SCHEMA,
    `${label} besitzt ein unbekanntes Schema.`
  );
  invariant(
    value.artifact !== null && typeof value.artifact === "object" && !Array.isArray(value.artifact) && JSON.stringify(Object.keys(value.artifact).sort()) === JSON.stringify(["bytes", "file", "sha256"]) && value.artifact.file === expected.file && value.artifact.bytes === expected.bytes && value.artifact.sha256 === expected.sha256 && SHA256.test(value.artifact.sha256),
    `${label} bindet nicht das erwartete Artefakt.`
  );
  return value;
}
async function ensureCreateNewLink(stagedPath, outputPath, expected, label) {
  try {
    await link(stagedPath, outputPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readHeldProof(outputPath, `${label}-Recovery-Ziel`);
    invariant(
      existing.proof.bytes === expected.bytes && existing.proof.sha256 === expected.sha256,
      `${label} existiert bereits mit fremden Bytes; Recovery ersetzt oder loescht es nicht.`
    );
  }
}
async function verifyGermanyAnnualCreateNewArtifact({
  workspaceRoot: workspaceRoot2,
  outputPath,
  expectedProof,
  anchorHelperProof,
  invokeAnchorHelper,
  hooks = {}
}) {
  const root2 = resolve(workspaceRoot2);
  const output = await assertCanonicalExistingPath(root2, outputPath, "Annual-create-new-Artefakt");
  const file = portable(root2, output, "Annual-create-new-Artefakt");
  const completionPath = `${output}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`;
  try {
    await assertCanonicalExistingPath(root2, completionPath, "Annual-create-new-Completion-Beleg");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Annual-create-new-Artefakt ist unvollstaendig: Completion-Beleg fehlt.", { cause: error });
    }
    throw error;
  }
  const completionSource = await readHeldProof(completionPath, "Annual-create-new-Completion-Beleg");
  let completion;
  try {
    completion = JSON.parse(completionSource.bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Annual-create-new-Completion-Beleg ist kein gueltiges JSON.", { cause: error });
  }
  const expected = expectedProof ?? completion?.artifact;
  validateFileProof(expected, "Erwarteter Annual-create-new-Artefaktbeleg");
  invariant(expected.file === file, "Annual-create-new-Artefaktbeleg bindet einen anderen Pfad.");
  validateCompletion(completion, expected, "Annual-create-new-Completion-Beleg");
  invariant(
    completionSource.bytes.equals(canonicalBytes(completion)),
    "Annual-create-new-Completion-Beleg ist nicht kanonisch serialisiert."
  );
  const expectedCompletion = {
    bytes: completionSource.proof.bytes,
    file: `${file}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
    sha256: completionSource.proof.sha256
  };
  if (process.platform === "win32" || typeof invokeAnchorHelper === "function") {
    if (typeof hooks.beforeAnchorVerify === "function") {
      await hooks.beforeAnchorVerify({ output, completionPath });
    }
    const helperResult = await invokeWindowsAnnualHelper({
      expectedCompletionBytes: expectedCompletion.bytes,
      expectedCompletionSha256: expectedCompletion.sha256,
      expectedDataBytes: expected.bytes,
      expectedDataSha256: expected.sha256,
      mode: "verify",
      outputRelativeFile: file,
      workspaceRoot: root2
    }, { anchorHelperProof, invokeAnchorHelper });
    validateHelperResult(helperResult, expected, expectedCompletion);
  } else {
    const artifact = await readHeldProof(output, "Annual-create-new-Artefakt");
    invariant(
      expected.bytes === artifact.proof.bytes && expected.sha256 === artifact.proof.sha256,
      "Annual-create-new-Artefakt driftet von seinem erwarteten Bytebeleg."
    );
    const completionAfter = await readHeldProof(completionPath, "Annual-create-new-Completion-Beleg nach Artefaktpruefung");
    invariant(
      completionAfter.proof.bytes === expectedCompletion.bytes && completionAfter.proof.sha256 === expectedCompletion.sha256,
      "Annual-create-new-Completion-Beleg driftete waehrend der Paarpruefung."
    );
  }
  return { path: output, proof: expected, completion: { path: completionPath, ...completionSource.proof } };
}
async function materializeGermanyAnnualCreateNewArtifact({
  workspaceRoot: workspaceRoot2,
  outputPath,
  bytes,
  label = "Annual-create-new-Artefakt",
  anchorHelperProof,
  invokeAnchorHelper,
  hooks = {}
}) {
  invariant(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_ARTIFACT_BYTES,
    `${label} besitzt keine begrenzten Ausgabebytes.`
  );
  const root2 = resolve(workspaceRoot2);
  const output = resolve(outputPath);
  const parent = await assertCanonicalExistingPath(root2, dirname(output), `${label}-Elternverzeichnis`);
  const file = portable(root2, output, label);
  const proof = { bytes: bytes.length, file, sha256: sha256(bytes) };
  const completionPath = `${output}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`;
  let artifactExists = false;
  let completionExists = false;
  try {
    await lstat(output);
    artifactExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await lstat(completionPath);
    completionExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (artifactExists) {
    try {
      await assertCanonicalExistingPath(root2, output, `${label}-Recovery-Artefakt`);
      const existing = await readHeldProof(output, `${label}-Recovery-Artefakt`);
      invariant(
        existing.proof.bytes === proof.bytes && existing.proof.sha256 === proof.sha256,
        `${label} existiert bereits mit fremden Bytes; Recovery ersetzt oder loescht es nicht.`
      );
    } catch (error) {
      throw new Error(`${label} existiert bereits mit fremden Bytes oder ungueltiger Pfadidentitaet; Recovery ersetzt oder loescht es nicht.`, { cause: error });
    }
  }
  if (artifactExists && completionExists) {
    try {
      return (await verifyGermanyAnnualCreateNewArtifact({
        workspaceRoot: root2,
        outputPath: output,
        expectedProof: proof,
        anchorHelperProof,
        invokeAnchorHelper
      })).proof;
    } catch (error) {
      throw new Error(`${label} existiert bereits unvollstaendig oder mit fremden Bytes; Recovery ersetzt oder loescht es nicht.`, { cause: error });
    }
  }
  if (!artifactExists && completionExists) {
    throw new Error(`${label}-Completion-Beleg existiert ohne sein Artefakt; Recovery ersetzt oder loescht ihn nicht.`);
  }
  const stagingRoot = join(parent, ".zugfolge-annual-create-new-staging");
  try {
    await mkdir(stagingRoot, { recursive: false, mode: 448 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertCanonicalExistingPath(root2, stagingRoot, `${label}-Stagingwurzel`);
  const attempt = await mkdtemp(join(stagingRoot, "attempt-"));
  await assertCanonicalExistingPath(root2, attempt, `${label}-Stagingversuch`);
  const stagedArtifact = join(attempt, basename(output));
  const stagedCompletion = join(attempt, `${basename(output)}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`);
  const completion = completionValue(file, proof);
  const completionBytes = canonicalBytes(completion);
  await writeStaged(stagedArtifact, bytes, `${label}-Staging`);
  await writeStaged(stagedCompletion, completionBytes, `${label}-Completion-Staging`);
  if (typeof hooks.afterStaging === "function") await hooks.afterStaging({ stagedArtifact, stagedCompletion, output });
  const completionProof = {
    bytes: completionBytes.length,
    file: `${file}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
    sha256: sha256(completionBytes)
  };
  if (process.platform === "win32" || typeof invokeAnchorHelper === "function") {
    const helperResult = await invokeWindowsAnnualHelper({
      expectedCompletionBytes: completionProof.bytes,
      expectedCompletionSha256: completionProof.sha256,
      expectedDataBytes: proof.bytes,
      expectedDataSha256: proof.sha256,
      mode: "publish",
      outputRelativeFile: file,
      stagedCompletionPath: stagedCompletion,
      stagedDataPath: stagedArtifact,
      workspaceRoot: root2
    }, { anchorHelperProof, invokeAnchorHelper });
    validateHelperResult(helperResult, proof, completionProof);
  } else {
    await ensureCreateNewLink(stagedArtifact, output, proof, label);
    await ensureCreateNewLink(stagedCompletion, completionPath, completionProof, `${label}-Completion-Beleg`);
  }
  if (typeof hooks.afterArtifactPublish === "function") await hooks.afterArtifactPublish({ stagedArtifact, output });
  if (typeof hooks.afterCompletionPublish === "function") await hooks.afterCompletionPublish({ completionPath, output });
  return (await verifyGermanyAnnualCreateNewArtifact({
    workspaceRoot: root2,
    outputPath: output,
    expectedProof: proof,
    anchorHelperProof,
    invokeAnchorHelper
  })).proof;
}

// tools/region-import/germany/operational-infrastructure-v2-publication.mjs
import { createHash as createHash7, randomUUID as randomUUID3 } from "node:crypto";
import {
  lstat as lstat7,
  link as link5,
  mkdir as mkdir5,
  mkdtemp as mkdtemp5,
  open as open7,
  readdir as readdir5,
  realpath as realpath6,
  rename as rename3,
  rmdir as rmdir4,
  unlink as unlink4
} from "node:fs/promises";
import { basename as basename6, dirname as dirname7, isAbsolute as isAbsolute5, join as join5, relative as relative5, resolve as resolve7, sep as sep5 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// tools/tiles/create-new-output.mjs
import { link as link2, lstat as lstat2, mkdir as mkdir2, mkdtemp as mkdtemp2, open as open2, readFile as readFile2, readdir, realpath as realpath2, rename, rmdir, unlink } from "node:fs/promises";
import { basename as basename2, dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
function isMissing(error) {
  return error !== null && typeof error === "object" && error.code === "ENOENT";
}
function sameIdentity2(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function existingTargetError(pathInput, label = "Ausgabeziel") {
  const path = resolve2(pathInput);
  const error = new Error(`${label} existiert bereits und darf im create-new-Jahreslauf weder ersetzt noch wiederverwendet werden: ${path}`);
  error.code = "EEXIST";
  error.path = path;
  return error;
}
async function assertCreateNewTarget(pathInput, label = "Ausgabeziel") {
  const path = resolve2(pathInput);
  try {
    await lstat2(path);
  } catch (error) {
    if (isMissing(error)) return path;
    throw error;
  }
  throw existingTargetError(path, label);
}
async function assertCreateNewTargets(targets) {
  const normalized = targets.map(({ path, label }) => ({ path: resolve2(path), label }));
  for (const target of normalized) await assertCreateNewTarget(target.path, target.label);
  return normalized;
}
async function removePublishedLink(entry) {
  let staged;
  let published;
  try {
    [staged, published] = await Promise.all([
      lstat2(entry.stagedPath, { bigint: true }),
      lstat2(entry.outputPath, { bigint: true })
    ]);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!sameIdentity2(staged, published)) return;
  const quarantineRoot = await mkdtemp2(join2(dirname2(entry.outputPath), ".zugfolge-create-new-rollback-"));
  const quarantined = join2(quarantineRoot, basename2(entry.outputPath));
  try {
    await rename(entry.outputPath, quarantined);
    const moved = await lstat2(quarantined, { bigint: true });
    if (!sameIdentity2(staged, moved)) {
      try {
        await link2(quarantined, entry.outputPath);
        await unlink(quarantined);
        await rmdir(quarantineRoot);
      } catch (restoreError) {
        throw new AggregateError(
          [restoreError],
          `${entry.label} wurde waehrend des owned-only Rollbacks fremd ersetzt und bleibt im Quarantaeneverzeichnis erhalten.`
        );
      }
      return;
    }
    await unlink(quarantined);
    await rmdir(quarantineRoot);
  } catch (error) {
    try {
      await rmdir(quarantineRoot);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOTEMPTY") {
        throw new AggregateError([error, cleanupError], "Create-new-Rollback-Quarantaene konnte nicht bereinigt werden.");
      }
    }
    throw error;
  }
}
async function rollbackFilesCreateNew(entriesInput) {
  const entries = entriesInput.map(({ stagedPath, outputPath, label = "Ausgabeziel" }) => ({
    stagedPath: resolve2(stagedPath),
    outputPath: resolve2(outputPath),
    label
  }));
  const rollbackErrors = [];
  for (const entry of entries.reverse()) {
    try {
      await removePublishedLink(entry);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) throw new AggregateError(rollbackErrors, "Create-new-Rollback ist fehlgeschlagen.");
}
async function publishFilesCreateNew(entriesInput) {
  const entries = entriesInput.map(({ stagedPath, outputPath, label = "Ausgabeziel" }) => ({
    stagedPath: resolve2(stagedPath),
    outputPath: resolve2(outputPath),
    label
  }));
  const published = [];
  try {
    for (const entry of entries) {
      try {
        await link2(entry.stagedPath, entry.outputPath);
      } catch (error) {
        if (error !== null && typeof error === "object" && error.code === "EEXIST") {
          throw existingTargetError(entry.outputPath, entry.label);
        }
        throw error;
      }
      published.push(entry);
    }
  } catch (error) {
    try {
      await rollbackFilesCreateNew(published);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Create-new-Publikation und Rollback sind fehlgeschlagen.");
    }
    throw error;
  }
  return entries.map(({ outputPath }) => outputPath);
}

// tools/region-import/materialize-operational-infrastructure-v2.mjs
import { createHash as createHash3, randomUUID } from "node:crypto";
import { spawnSync as spawnSync2 } from "node:child_process";
import { link as link3, lstat as lstat3, mkdir as mkdir3, open as open3, readFile as readFile3, realpath as realpath3, rename as rename2, rmdir as rmdir2, unlink as unlink2 } from "node:fs/promises";
import { basename as basename3, dirname as dirname3, relative as relative2, resolve as resolve3, sep as sep2 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// tools/region-import/operational-infrastructure-binding.mjs
import { createHash as createHash2 } from "node:crypto";
var OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA = "operational-infrastructure-v2";
var OPERATIONAL_INFRASTRUCTURE_KEYS = Object.freeze([
  "blockResources",
  "directedEdges",
  "edgeGeometries",
  "id",
  "interlockingRoutes",
  "platformIntervals",
  "regionBoundaries",
  "routeVersions",
  "rzueLayoutId",
  "signals",
  "switches"
]);
var INTERLOCKING_RESOURCE_FIELDS = Object.freeze([
  Object.freeze(["pathResources", "Fahrweg"]),
  Object.freeze(["overlapResources", "Durchrutschweg"]),
  Object.freeze(["flankResources", "Flankenschutz"])
]);
var OPERATIONAL_INFRASTRUCTURE_BINDING_KEYS = Object.freeze([
  "bytes",
  "file",
  "infraReleaseId",
  "schemaVersion",
  "sha256",
  "stateHash"
]);
function operationalCanonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify({ $bigint: value.toString() });
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Operational-v2-Zustand enthaelt keine sichere Ganzzahl.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(operationalCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${operationalCanonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Operational-v2-Zustand enthaelt einen nicht kanonisierbaren Wert.");
}
function operationalHash(schema, value) {
  return createHash2("sha256").update(operationalCanonicalJson({ schema, value }), "utf8").digest("hex");
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invariant2(condition, message) {
  if (!condition) throw new Error(message);
}
function exactKeys(value, expected, name) {
  const actual = Object.keys(value).sort();
  invariant2(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${name} besitzt fehlende, unbekannte oder weltbezogene Felder.`
  );
}
function assertOperationalInfrastructureV2(infrastructure) {
  invariant2(isRecord(infrastructure), "Operative v2-Infrastruktur ist kein Objekt.");
  exactKeys(infrastructure, OPERATIONAL_INFRASTRUCTURE_KEYS, "Operative v2-Infrastruktur");
  invariant2(typeof infrastructure.id === "string" && infrastructure.id !== "", "Operative v2-Infrastruktur besitzt keine Release-ID.");
  invariant2(isRecord(infrastructure.directedEdges) && Object.keys(infrastructure.directedEdges).length > 0, "Operative v2-Infrastruktur besitzt keine gerichteten Kanten.");
  invariant2(isRecord(infrastructure.edgeGeometries) && Object.keys(infrastructure.edgeGeometries).length > 0, "Operative v2-Infrastruktur besitzt keine Kantengeometrien.");
  invariant2(isRecord(infrastructure.routeVersions) && Object.keys(infrastructure.routeVersions).length > 0, "Operative v2-Infrastruktur besitzt keine Laufwegversionen.");
  invariant2(isRecord(infrastructure.interlockingRoutes) && Object.keys(infrastructure.interlockingRoutes).length > 0, "Operative v2-Infrastruktur besitzt keine Fahrstrassenvorlagen.");
  invariant2(isRecord(infrastructure.platformIntervals), "Operative v2-Infrastruktur besitzt keinen Bahnsteigvertrag.");
  invariant2(typeof infrastructure.rzueLayoutId === "string" && infrastructure.rzueLayoutId !== "", "Operative v2-Infrastruktur besitzt keine RZUE-Layoutbindung.");
  for (const key of ["signals", "switches", "blockResources", "regionBoundaries"]) {
    invariant2(Array.isArray(infrastructure[key]), `Operative v2-Infrastruktur verletzt ${key}.`);
  }
  invariant2(infrastructure.signals.length > 0 && infrastructure.blockResources.length > 0, "Operative v2-Infrastruktur besitzt keine Signale oder Konfliktressourcen.");
  const blockResources = /* @__PURE__ */ new Set();
  for (const resource of infrastructure.blockResources) {
    invariant2(
      typeof resource === "string" && resource !== "",
      "Operative v2-Infrastruktur besitzt eine ungueltige Konfliktressource."
    );
    blockResources.add(resource);
  }
  for (const [templateId, candidate] of Object.entries(infrastructure.interlockingRoutes)) {
    invariant2(isRecord(candidate), `Fahrstrassenvorlage '${templateId}' ist kein Objekt.`);
    for (const [field, label] of INTERLOCKING_RESOURCE_FIELDS) {
      const resources = candidate[field];
      invariant2(
        Array.isArray(resources) && resources.length > 0,
        `Fahrstrassenvorlage '${templateId}' besitzt keinen nichtleeren ${label}.`
      );
      for (const resource of resources) {
        invariant2(
          typeof resource === "string" && resource !== "" && blockResources.has(resource),
          `Fahrstrassenvorlage '${templateId}' verweist im ${label} auf keine vorhandene blockResources-Ressource.`
        );
      }
    }
  }
}
function operationalInfrastructureV2StateHash(infrastructure) {
  assertOperationalInfrastructureV2(infrastructure);
  return operationalHash(OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA, infrastructure);
}
function canonicalOperationalInfrastructureV2Json(infrastructure) {
  assertOperationalInfrastructureV2(infrastructure);
  return operationalCanonicalJson(infrastructure);
}

// tools/region-import/materialize-operational-infrastructure-v2.mjs
var REPOSITORY_ROOT = resolve3(dirname3(fileURLToPath(import.meta.url)), "../..");
var MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES = 64 * 1024 * 1024;
var SHA2562 = /^[a-f0-9]{64}$/u;
var NATIVE_EXECUTABLE_ENV = "ZUGFOLGE_INFRA_RELEASE_VALIDATOR_PATH";
var NATIVE_RECEIPT_KEYS = Object.freeze([
  "bytes",
  "infraReleaseId",
  "schema",
  "sha256",
  "sourceBytes",
  "sourceSha256",
  "stateHash",
  "validationMode"
]);
var NATIVE_SEMANTIC_VALIDATION_KEYS = Object.freeze([
  "algorithm",
  "interlockingRecordsDeserialized",
  "routeRecordsDeserialized",
  "routeTemplateCartesianReads",
  "trainLegProfileReads"
]);
function invariant3(condition, message) {
  if (!condition) throw new Error(message);
}
function sameIdentity3(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameStableMetadata(left, right) {
  return sameIdentity3(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function normalizedPath(path) {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}
async function inspectRegularFile(path, label, { retainHandle = false } = {}) {
  const pathBefore = await lstat3(path, { bigint: true });
  invariant3(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.size > 0n, `${label} ist keine nichtleere reguläre Datei.`);
  const handle = await open3(path, "r");
  const digest = createHash3("sha256");
  let bytes = 0;
  let retained = false;
  try {
    const before = await handle.stat({ bigint: true });
    invariant3(before.isFile() && sameStableMetadata(pathBefore, before), `${label} wurde vor der Hashbildung ausgetauscht.`);
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat3(path, { bigint: true })
    ]);
    invariant3(
      pathAfter.isFile() && !pathAfter.isSymbolicLink() && sameStableMetadata(before, after) && sameStableMetadata(after, pathAfter) && BigInt(bytes) === after.size,
      `${label} änderte sich während der Hashbildung.`
    );
    const result = {
      identity: Object.freeze({ dev: after.dev, ino: after.ino }),
      metadata: Object.freeze({
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        mtimeNs: after.mtimeNs,
        ctimeNs: after.ctimeNs
      }),
      proof: { bytes, sha256: digest.digest("hex") }
    };
    if (retainHandle) {
      result.handle = handle;
      retained = true;
    }
    return result;
  } finally {
    if (!retained) await handle.close();
  }
}
async function fileProof(path, label) {
  return (await inspectRegularFile(path, label)).proof;
}
async function pinParentDirectory(path) {
  const requested = resolve3(path);
  const real = await realpath3(requested);
  invariant3(normalizedPath(requested) === normalizedPath(real), "Operational-v2-Ausgabeverzeichnis darf kein Dateisystemalias sein.");
  const identity = await lstat3(real, { bigint: true });
  invariant3(identity.isDirectory() && !identity.isSymbolicLink(), "Operational-v2-Ausgabeverzeichnis ist kein regulaeres Verzeichnis.");
  return Object.freeze({ requested, real, identity: Object.freeze({ dev: identity.dev, ino: identity.ino }) });
}
async function assertPinnedParent(parent) {
  const [real, metadata] = await Promise.all([
    realpath3(parent.requested),
    lstat3(parent.real, { bigint: true })
  ]);
  invariant3(
    normalizedPath(real) === normalizedPath(parent.real) && metadata.isDirectory() && !metadata.isSymbolicLink() && sameIdentity3(metadata, parent.identity),
    "Operational-v2-Ausgabeverzeichnis wurde ausgetauscht."
  );
}
async function restoreMismatchedQuarantinedFile({ originalPath, quarantinedPath, quarantinePath, label }) {
  try {
    await lstat3(originalPath, { bigint: true });
    throw new Error(`${label}-Originalpfad wurde waehrend der Wiederherstellung erneut belegt.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rename2(quarantinedPath, originalPath);
  try {
    await rmdir2(quarantinePath);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error;
  }
}
async function removeOwnedFileByQuarantine(parent, path, identity, label, hooks = {}) {
  await assertPinnedParent(parent);
  const current = await lstat3(path, { bigint: true });
  invariant3(current.isFile() && !current.isSymbolicLink() && sameIdentity3(current, identity), `${label} wurde vor der Bereinigung fremd ersetzt; die fremde Datei bleibt unangetastet.`);
  const quarantine = resolve3(parent.real, `.${basename3(path)}.${process.pid}.${randomUUID()}.owned-cleanup`);
  invariant3(relative2(parent.real, quarantine) !== "" && !relative2(parent.real, quarantine).startsWith(`..${sep2}`), `${label}-Quarantaene verliess das gepinnte Elternverzeichnis.`);
  await mkdir3(quarantine, { mode: 448 });
  const quarantineIdentity = await lstat3(quarantine, { bigint: true });
  const quarantined = resolve3(quarantine, "owned");
  try {
    await assertPinnedParent(parent);
    await hooks.beforeOwnedFileQuarantineRename?.({ label, originalPath: path, quarantinedPath: quarantined });
    await rename2(path, quarantined);
    await hooks.afterOwnedFileQuarantine?.({ label, originalPath: path, quarantinedPath: quarantined });
    const moved = await lstat3(quarantined, { bigint: true });
    if (!moved.isFile() || moved.isSymbolicLink() || !sameIdentity3(moved, identity)) {
      await restoreMismatchedQuarantinedFile({ originalPath: path, quarantinedPath: quarantined, quarantinePath: quarantine, label });
      throw new Error(`${label}-Quarantaene enthielt eine fremde Ersatzdatei; sie wurde am Originalpfad wiederhergestellt.`);
    }
    await hooks.beforeOwnedFileUnlink?.({ label, originalPath: path, quarantinedPath: quarantined });
    const final = await lstat3(quarantined, { bigint: true });
    if (!final.isFile() || final.isSymbolicLink() || !sameIdentity3(final, identity)) {
      await restoreMismatchedQuarantinedFile({ originalPath: path, quarantinedPath: quarantined, quarantinePath: quarantine, label });
      throw new Error(`${label} wurde in der Quarantaene fremd ersetzt; die fremde Datei wurde am Originalpfad wiederhergestellt.`);
    }
    await hooks.afterOwnedFileFinalIdentityCheck?.({ label, originalPath: path, quarantinedPath: quarantined });
    const immediatelyBeforeUnlink = await lstat3(quarantined, { bigint: true });
    if (!immediatelyBeforeUnlink.isFile() || immediatelyBeforeUnlink.isSymbolicLink() || !sameIdentity3(immediatelyBeforeUnlink, identity)) {
      await restoreMismatchedQuarantinedFile({ originalPath: path, quarantinedPath: quarantined, quarantinePath: quarantine, label });
      throw new Error(`${label} wurde unmittelbar vor dem Unlink fremd ersetzt; die fremde Datei wurde am Originalpfad wiederhergestellt.`);
    }
    await unlink2(quarantined);
    const directoryNow = await lstat3(quarantine, { bigint: true });
    invariant3(directoryNow.isDirectory() && sameIdentity3(directoryNow, quarantineIdentity), `${label}-Quarantaeneverzeichnis wurde ausgetauscht.`);
    await rmdir2(quarantine);
    await assertPinnedParent(parent);
  } catch (error) {
    throw new Error(`${label} konnte nicht identitaetsgebunden bereinigt werden: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
function validateOperationalInfrastructureV2NativeReceipt(receipt, expectedReleaseId) {
  const expectedKeys = receipt !== null && typeof receipt === "object" && !Array.isArray(receipt) && Object.hasOwn(receipt, "semanticValidation") ? [...NATIVE_RECEIPT_KEYS, "semanticValidation"].sort() : NATIVE_RECEIPT_KEYS;
  invariant3(
    receipt !== null && typeof receipt === "object" && !Array.isArray(receipt) && Object.keys(receipt).sort().join("\0") === expectedKeys.join("\0"),
    "Native Operational-v2-Validierung lieferte keinen vollständigen Bindungsbeleg."
  );
  invariant3(
    receipt.schema === OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA && receipt.infraReleaseId === expectedReleaseId && receipt.validationMode === "native-streaming-redb-v1",
    "Native Operational-v2-Validierung lieferte keine gültige Schema-, Release- und Modusbindung."
  );
  invariant3(
    Number.isSafeInteger(receipt.sourceBytes) && receipt.sourceBytes > 0 && SHA2562.test(receipt.sourceSha256),
    "Native Operational-v2-Validierung lieferte keinen gültigen Quellbyte-Beleg."
  );
  invariant3(
    Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && SHA2562.test(receipt.sha256) && SHA2562.test(receipt.stateHash) && receipt.sha256 !== receipt.stateHash,
    "Native Operational-v2-Validierung lieferte keinen getrennten Ausgabe- und Zustandshash-Beleg."
  );
  if (receipt.semanticValidation !== void 0) {
    invariant3(
      receipt.semanticValidation !== null && typeof receipt.semanticValidation === "object" && !Array.isArray(receipt.semanticValidation) && Object.keys(receipt.semanticValidation).sort().join("\0") === NATIVE_SEMANTIC_VALIDATION_KEYS.join("\0") && receipt.semanticValidation.algorithm === "route-template-summary-linear-v2" && Number.isSafeInteger(receipt.semanticValidation.routeRecordsDeserialized) && receipt.semanticValidation.routeRecordsDeserialized > 0 && Number.isSafeInteger(receipt.semanticValidation.interlockingRecordsDeserialized) && receipt.semanticValidation.interlockingRecordsDeserialized > 0 && Number.isSafeInteger(receipt.semanticValidation.trainLegProfileReads) && receipt.semanticValidation.trainLegProfileReads >= 0 && receipt.semanticValidation.routeTemplateCartesianReads === 0,
      "Native Operational-v2-Validierung lieferte keinen gueltigen linearen Semantikbeleg."
    );
  }
  return receipt;
}
function validateOperationalInfrastructureV2Native(candidatePath, expectedReleaseId, outputPath, { validatorExecutablePath } = {}) {
  const explicitExecutable = validatorExecutablePath === void 0 ? void 0 : resolve3(validatorExecutablePath);
  const configuredExecutable = explicitExecutable ?? (process.env[NATIVE_EXECUTABLE_ENV]?.trim() || void 0);
  const command = configuredExecutable ?? process.env.CARGO ?? "cargo";
  const arguments_ = configuredExecutable === void 0 ? [
    "run",
    "--quiet",
    "--locked",
    "-p",
    "zugfolge-infra",
    "--bin",
    "zugfolge-infra-release",
    "--",
    "validate-operational-infrastructure-v2",
    candidatePath,
    expectedReleaseId
  ] : ["validate-operational-infrastructure-v2", candidatePath, expectedReleaseId];
  if (outputPath !== void 0) arguments_.push(outputPath);
  const result = spawnSync2(command, arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(`Native Operational-v2-Validierung fehlgeschlagen:
${result.stderr}
${result.stdout}`);
  }
  const line = result.stdout.trim().split(/\r?\n/u).at(-1);
  let receipt;
  try {
    receipt = JSON.parse(line);
  } catch {
    throw new Error("Native Operational-v2-Validierung lieferte kein JSON-Receipt.");
  }
  return validateOperationalInfrastructureV2NativeReceipt(receipt, expectedReleaseId);
}
async function materializeOperationalInfrastructureV2({
  candidatePath,
  expectedReleaseId,
  outputPath,
  validatorExecutablePath,
  validateNative = validateOperationalInfrastructureV2Native,
  anchorOutput,
  hooks = {}
}) {
  invariant3(typeof expectedReleaseId === "string" && expectedReleaseId !== "", "Erwartete InfraRelease-ID fehlt.");
  invariant3(anchorOutput === void 0 || typeof anchorOutput === "function", "Operational-v2-Ownership-Anker muss eine Funktion sein.");
  const candidate = resolve3(candidatePath);
  const output = resolve3(outputPath);
  invariant3(candidate !== output, "Candidate und materialisiertes Operational-v2-Artefakt müssen getrennte Dateien sein.");
  invariant3(basename3(output) === "operational-infrastructure-v2.json", "Operational-v2-Ausgabe besitzt keinen kanonischen Dateinamen.");
  await mkdir3(dirname3(output), { recursive: true });
  const parent = await pinParentDirectory(dirname3(output));
  invariant3(normalizedPath(dirname3(output)) === normalizedPath(parent.real), "Operational-v2-Ausgabe muss direkt im gepinnten Elternverzeichnis liegen.");
  const temporaryOutput = resolve3(parent.real, `.${basename3(output)}.${process.pid}.${randomUUID()}.native-building`);
  let temporaryIdentity;
  let temporaryHandle;
  let outputIdentity;
  let result;
  let operationError;
  try {
    const sourceBefore = await fileProof(candidate, "Operational-v2-Candidate");
    const nativeReceipt = validateOperationalInfrastructureV2NativeReceipt(
      await validateNative(candidate, expectedReleaseId, temporaryOutput, { validatorExecutablePath }),
      expectedReleaseId
    );
    const sourceAfter = await fileProof(candidate, "Operational-v2-Candidate");
    invariant3(
      sourceBefore.bytes === sourceAfter.bytes && sourceBefore.sha256 === sourceAfter.sha256,
      "Operational-v2-Candidate änderte sich während der nativen Validierung."
    );
    invariant3(
      nativeReceipt.sourceBytes === sourceAfter.bytes && nativeReceipt.sourceSha256 === sourceAfter.sha256,
      "Native Operational-v2-Validierung ist nicht an die geprüften Candidate-Bytes gebunden."
    );
    const inspectedOutput = await inspectRegularFile(temporaryOutput, "Native Operational-v2-Ausgabe", { retainHandle: true });
    temporaryIdentity = inspectedOutput.identity;
    temporaryHandle = inspectedOutput.handle;
    const outputProof = inspectedOutput.proof;
    invariant3(
      nativeReceipt.bytes === outputProof.bytes && nativeReceipt.sha256 === outputProof.sha256,
      "Native Operational-v2-Validierung ist nicht an die materialisierten Ausgabe-Bytes gebunden."
    );
    if (sourceAfter.bytes <= MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES) {
      const inputBytes = await readFile3(candidate);
      invariant3(
        inputBytes.length === sourceAfter.bytes && createHash3("sha256").update(inputBytes).digest("hex") === sourceAfter.sha256,
        "Operational-v2-Candidate änderte sich vor dem JavaScript-Gegenvergleich."
      );
      let infrastructure;
      try {
        infrastructure = JSON.parse(inputBytes);
      } catch (error) {
        throw new Error(`Operational-v2-Candidate ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      invariant3(infrastructure.id === expectedReleaseId, "Operational-v2-Candidate verletzt die InfraRelease-ID-Bindung.");
      const stateHash = operationalInfrastructureV2StateHash(infrastructure);
      invariant3(nativeReceipt.stateHash === stateHash, "JavaScript- und native Rust-Kanonisierung laufen auseinander.");
      const expectedOutput = Buffer.from(`${canonicalOperationalInfrastructureV2Json(infrastructure)}
`, "utf8");
      const actualOutput = await readFile3(temporaryOutput);
      invariant3(actualOutput.equals(expectedOutput), "JavaScript- und native Rust-Materialisierung laufen auseinander.");
    }
    await assertPinnedParent(parent);
    await hooks.beforeOutputLink?.({ output, temporaryOutput });
    const [heldBeforeLink, pathBeforeLink] = await Promise.all([
      temporaryHandle.stat({ bigint: true }),
      lstat3(temporaryOutput, { bigint: true })
    ]);
    invariant3(
      heldBeforeLink.isFile() && pathBeforeLink.isFile() && !pathBeforeLink.isSymbolicLink() && sameIdentity3(heldBeforeLink, temporaryIdentity) && sameStableMetadata(inspectedOutput.metadata, heldBeforeLink) && sameStableMetadata(heldBeforeLink, pathBeforeLink),
      "Native Operational-v2-Ausgabe wurde vor dem handlegebundenen create-new-Link ausgetauscht oder verändert."
    );
    try {
      await link3(temporaryOutput, output);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error("Operational-v2-Ausgabe existiert bereits; create-new verweigert jede Überschreibung.");
      throw error;
    }
    const [heldAfterLink, temporaryAfterLink, linkedOutput] = await Promise.all([
      temporaryHandle.stat({ bigint: true }),
      lstat3(temporaryOutput, { bigint: true }),
      lstat3(output, { bigint: true })
    ]);
    invariant3(
      heldAfterLink.isFile() && temporaryAfterLink.isFile() && !temporaryAfterLink.isSymbolicLink() && linkedOutput.isFile() && !linkedOutput.isSymbolicLink() && sameIdentity3(heldAfterLink, temporaryIdentity) && sameStableMetadata(heldAfterLink, temporaryAfterLink) && sameStableMetadata(heldAfterLink, linkedOutput),
      "Operational-v2-Ausgabe wurde beim handlegebundenen create-new-Link ausgetauscht oder verändert."
    );
    outputIdentity = Object.freeze({ dev: heldAfterLink.dev, ino: heldAfterLink.ino });
    if (anchorOutput !== void 0) {
      const [heldBeforeAnchor, temporaryBeforeAnchor, pathBeforeAnchor] = await Promise.all([
        temporaryHandle.stat({ bigint: true }),
        lstat3(temporaryOutput, { bigint: true }),
        lstat3(output, { bigint: true })
      ]);
      invariant3(
        heldBeforeAnchor.isFile() && temporaryBeforeAnchor.isFile() && !temporaryBeforeAnchor.isSymbolicLink() && pathBeforeAnchor.isFile() && !pathBeforeAnchor.isSymbolicLink() && sameIdentity3(heldBeforeAnchor, outputIdentity) && sameStableMetadata(heldBeforeAnchor, temporaryBeforeAnchor) && sameStableMetadata(heldBeforeAnchor, pathBeforeAnchor),
        "Operational-v2-Ausgabe driftete vor der handlegebundenen Ownership-Verankerung."
      );
      await anchorOutput({ outputPath: output, handle: temporaryHandle, identity: outputIdentity });
      const [heldAfterAnchor, temporaryAfterAnchor, pathAfterAnchor] = await Promise.all([
        temporaryHandle.stat({ bigint: true }),
        lstat3(temporaryOutput, { bigint: true }),
        lstat3(output, { bigint: true })
      ]);
      invariant3(
        heldAfterAnchor.isFile() && temporaryAfterAnchor.isFile() && !temporaryAfterAnchor.isSymbolicLink() && pathAfterAnchor.isFile() && !pathAfterAnchor.isSymbolicLink() && sameIdentity3(heldAfterAnchor, outputIdentity) && sameStableMetadata(heldAfterAnchor, temporaryAfterAnchor) && sameStableMetadata(heldAfterAnchor, pathAfterAnchor),
        "Operational-v2-Ausgabe driftete waehrend der handlegebundenen Ownership-Verankerung."
      );
    }
    await hooks.beforeTemporaryCleanup?.({ output, temporaryOutput });
    result = validatorExecutablePath === void 0 ? { ...nativeReceipt, output } : { ...nativeReceipt, output, validatorExecutablePath: resolve3(validatorExecutablePath) };
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors = [];
  if (temporaryIdentity !== void 0) {
    try {
      await removeOwnedFileByQuarantine(parent, temporaryOutput, temporaryIdentity, "Native Operational-v2-Temporausgabe", hooks);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError === void 0 && cleanupErrors.length === 0) {
    try {
      await assertPinnedParent(parent);
      const finalOutput = await inspectRegularFile(output, "Finale Operational-v2-Ausgabe");
      invariant3(sameIdentity3(finalOutput.identity, outputIdentity), "Finale Operational-v2-Ausgabe wurde nach der Bereinigung ausgetauscht.");
      invariant3(finalOutput.proof.bytes === result.bytes && finalOutput.proof.sha256 === result.sha256, "Finale Operational-v2-Ausgabe driftet vom nativen Receipt.");
    } catch (error) {
      operationError = error;
    }
  }
  if (operationError !== void 0 || cleanupErrors.length > 0) {
    if (outputIdentity !== void 0) {
      try {
        await removeOwnedFileByQuarantine(parent, output, outputIdentity, "Publizierte Operational-v2-Ausgabe", hooks);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (temporaryHandle !== void 0) {
    try {
      await temporaryHandle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    temporaryHandle = void 0;
  }
  if (operationError !== void 0 || cleanupErrors.length > 0) {
    const causes = operationError === void 0 ? cleanupErrors : [operationError, ...cleanupErrors];
    if (causes.length === 1) throw causes[0];
    throw new AggregateError(causes, "Operational-v2-Materialisierung oder identitaetsgebundene Bereinigung ist fehlgeschlagen.");
  }
  return result;
}
var invokedPath = process.argv[1] === void 0 ? null : pathToFileURL(resolve3(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const [candidatePath, expectedReleaseId, outputPath, ...extra] = process.argv.slice(2);
  if (!candidatePath || !expectedReleaseId || !outputPath || extra.length > 0) {
    throw new Error("Aufruf: materialize-operational-infrastructure-v2.mjs CANDIDATE.json EXPECTED_RELEASE_ID OUTPUT/operational-infrastructure-v2.json");
  }
  materializeOperationalInfrastructureV2({ candidatePath, expectedReleaseId, outputPath }).then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}
`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  });
}

// tools/region-import/germany/operational-infrastructure-v2.mjs
import { createHash as createHash4 } from "node:crypto";
import { spawnSync as spawnSync3 } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat as lstat4, mkdir as mkdir4, mkdtemp as mkdtemp3, open as open4, readFile as readFile4, readdir as readdir2, rm, rmdir as rmdir3, unlink as unlink3 } from "node:fs/promises";
import { basename as basename4, dirname as dirname4, isAbsolute as isAbsolute2, join as join3, resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var GERMANY_OPERATIONAL_DERIVATION_SCHEMA = "zugfolge-germany-operational-infrastructure-readiness/v2";
var GERMANY_OPERATIONAL_DERIVATION_REPORT_SCHEMA = "zugfolge-germany-operational-infrastructure-readiness-report/v1";
var GERMANY_OPERATIONAL_DERIVATION_MODE = "readiness-only";
var GERMANY_OPERATIONAL_CONSERVATIVE_SCHEMA = "zugfolge-germany-operational-infrastructure-derivation/v2";
var GERMANY_OPERATIONAL_CONSERVATIVE_MODE = "deterministic-conservative-v1";
var GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID = "synthetic-operational-b/v2";
var GERMANY_OPERATIONAL_NATIVE_REPORT_SCHEMA = "germany-operational-v2-derivation-report-v1";
var GERMANY_OPERATIONAL_NATIVE_RECEIPT_SCHEMA = "germany-operational-v2-derivation-receipt-v1";
var GERMANY_OPERATIONAL_COMPLETE_ROUTE_COVERAGE = "complete-pinned-timetable-routes";
var GERMANY_OPERATIONAL_NATIVE_EXECUTABLE_ENV = "ZUGFOLGE_INFRA_RELEASE_VALIDATOR_PATH";
var GERMANY_OPERATIONAL_CANDIDATE_TRIPLET_CLAIM_SCHEMA = "zugfolge-germany-operational-candidate-triplet-claim/v2";
var LEGACY_DERIVATION_SCHEMA = "zugfolge-germany-operational-infrastructure-derivation/v1";
var REPOSITORY_ROOT2 = resolve4(dirname4(fileURLToPath2(import.meta.url)), "../../..");
var CANDIDATE_TRIPLET_CLAIM_FILE = ".operational-infrastructure-v2.candidate-triplet.claim.json";
var CANDIDATE_TRIPLET_STAGED_CLAIM_FILE = "candidate-triplet.claim.json";
var MAX_CANDIDATE_TRIPLET_CLAIM_BYTES = 1024 * 1024;
var SHA2563 = /^[a-f0-9]{64}$/u;
var MAP_LAYER_NAMES = Object.freeze(["tracks", "platforms", "switches", "signals", "blocks", "conflictResources"]);
var CONSERVATIVE_LAYER_NAMES = Object.freeze([...MAP_LAYER_NAMES, "timetableRoutes", "transferDemands"]);
var CONSERVATIVE_POLICY_KEYS = Object.freeze([
  "id",
  "qualityClass",
  "sourceId",
  "derivationRule",
  "unknownMainlineSpeedKmh",
  "unknownServiceSpeedKmh",
  "unknownGradientAbsPermille",
  "minimumPlatformLengthMm",
  "maximumPlatformSnapDistanceMm",
  "minimumOverlapMm",
  "minimumBerthEndClearanceMm",
  "maximumStablingPathEdges",
  "maximumStablingPathLengthMm",
  "simulatedOperationalBerthFallback",
  "maximumDirectDwellMs",
  "terminalFormationLengthsMm",
  "defaultProtectionSystem",
  "regionBoundaryId",
  "rzueLayoutId"
]);
var GERMANY_OPERATIONAL_REQUIRED_INPUTS = Object.freeze([
  Object.freeze({
    name: "stationHeads",
    blockerCode: "station-head-connectivity-required",
    artifact: "StationHead-Eingabe fuer die bestehende Rust-Fahrstrassenableitung",
    requiredFields: Object.freeze(["stationHeadId", "nodeId", "incomingTrackId", "switchId", "pointTrackId", "normalTrackId", "reverseTrackId", "activeEntryBoundaryId", "activeEntryBoundaryDirection", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze([
      "Nur Spitze-Stamm- und Spitze-Zweig-Uebergaenge sind zulaessig; Zweig-Zweig und reine Knotennachbarschaft blockieren.",
      "Fehlende oder deaktivierte Eingangssignale bleiben ein Blocker, solange kein bereits autorisierter typisierter Vertrag fuer virtuelle Fahrberechtigungsgrenzen existiert.",
      "Weichenlagen stammen aus StationHead und lauten ausschliesslich normal oder reverse."
    ])
  }),
  Object.freeze({
    name: "rustInterlockingRoutes",
    blockerCode: "rust-route-and-interlocking-input-required",
    artifact: "Vom Rust-Vertrag abgeleitete RouteVersionen und InterlockingRouteTemplates",
    requiredFields: Object.freeze(["derivationPolicyVersion", "stationHeadHash", "routeVersions[].id", "routeVersions[].templateId", "routeVersions[].predecessorId", "routeVersions[].transitionRouteMm", "routeVersions[].legs", "interlockingRoutes[].id", "interlockingRoutes[].routeTemplateId", "interlockingRoutes[].signalId", "interlockingRoutes[].pathResources", "interlockingRoutes[].overlapResources", "interlockingRoutes[].flankResources", "interlockingRoutes[].switchPositions", "interlockingRoutes[].authorityStartRouteMm", "interlockingRoutes[].authorityEndRouteMm", "interlockingRoutes[].releaseAfterTailRouteMm", "terminalProtectionBindings[].routeId", "terminalProtectionBindings[].endpointResourceId"]),
    constraints: Object.freeze([
      "Fahrweg, Durchrutschweg und Flankenschutz muessen jeweils fachlich belegte Rollen besitzen; Pfadaliasse und Ersatzressourcen blockieren.",
      "Terminale Fahrwege benoetigen einen belegten Endpunktschutz und duerfen keinen Gleisabschnitt als Ersatzflanke wiederverwenden.",
      "Fahrberechtigungs- und Aufloesegrenzen muessen einen positiven Zug ueber eine Folgefahrberechtigung bis zur lockfreien Beendigung fuehren koennen."
    ])
  }),
  Object.freeze({
    name: "platformIntervals",
    blockerCode: "operational-platform-intervals-required",
    artifact: "Operative Bahnsteigintervalle statt Karten- oder Evidenzpunkte",
    requiredFields: Object.freeze(["platformId", "trackId", "fromMm", "toMm", "direction", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Klasse-C-Kartenpunkte und Geometrien ohne exakte gerichtete Gleisbindung blockieren."])
  }),
  Object.freeze({
    name: "trainProtectionProfiles",
    blockerCode: "canonical-train-protection-profile-required",
    artifact: "Kantengebundene kanonische Zugsicherungsprofile",
    requiredFields: Object.freeze(["trackId", "availableProtectionSystems", "simultaneouslyRequiredProtectionSystems", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Zulaessig sind ausschliesslich pzb, lzb, etcs-level1 und etcs-level2.", "etcs und restricted-unknown sind keine fahrzeugseitig erfuellbaren Betriebskennungen und blockieren."])
  }),
  Object.freeze({
    name: "resourceBindings",
    blockerCode: "exact-resource-bindings-required",
    artifact: "Vollstaendig referentiell geschlossene Konfliktressourcenbindungen",
    requiredFields: Object.freeze(["resourceId", "resourceKind", "targetId", "exactTrackIds", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Jede Zielbindung muss existieren, bijektiv und mengengleich sein; Orphans und Supersets blockieren."])
  }),
  Object.freeze({
    name: "regionBoundaries",
    blockerCode: "operational-region-boundaries-required",
    artifact: "Geometrisch und betrieblich belegte Regionsgrenzen",
    requiredFields: Object.freeze(["boundaryId", "geometryE7", "safeHandoverTrackIds", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Eine freie Kennung ohne Grenzgeometrie und sichere Uebergabepunkte blockiert."])
  }),
  Object.freeze({
    name: "rzueLayout",
    blockerCode: "static-rzue-layout-required",
    artifact: "Statisches RZUE-Layout mit Inhalt, Hash und Herkunft",
    requiredFields: Object.freeze(["layoutId", "nodes", "edges", "contentSha256", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Eine freie Layoutkennung ohne referenziertes statisches Layout blockiert."])
  }),
  Object.freeze({
    name: "edgeGeometriesMm",
    blockerCode: "upstream-mm-edge-geometry-required",
    artifact: "Upstream berechnete E7-Geometrie mit derselben ganzzahligen Millimeterbasis wie die Kantenlaenge",
    requiredFields: Object.freeze(["edgeId", "lengthMm", "points[].edgeOffsetMm", "points[].latitudeE7", "points[].longitudeE7", "points[].bearingMilliDegrees", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Der Operational-Ableiter darf Zwischenoffsets weder aus Gradkoordinaten neu gewichten noch schaetzen."])
  })
]);
function invariant4(condition, message) {
  if (!condition) throw new Error(message);
}
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys2(value, expected, name) {
  invariant4(isRecord2(value), `${name} muss ein Objekt sein.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant4(JSON.stringify(actual) === JSON.stringify(wanted), `${name} besitzt unbekannte oder fehlende Felder.`);
}
function nonEmptyString(value, name) {
  invariant4(typeof value === "string" && value.trim() === value && value !== "", `${name} muss eine nichtleere, randfreie Zeichenkette sein.`);
  return value;
}
function positiveSafeInteger(value, name) {
  invariant4(Number.isSafeInteger(value) && value > 0, `${name} muss eine positive sichere Ganzzahl sein.`);
  return value;
}
function nonNegativeSafeInteger(value, name) {
  invariant4(Number.isSafeInteger(value) && value >= 0, `${name} muss eine nichtnegative sichere Ganzzahl sein.`);
  return value;
}
function relativeArtifactPath(value, name) {
  const portable3 = typeof value === "string" ? value.replaceAll("\\", "/") : "";
  const portableAbsolute = /^[A-Za-z]:\//u.test(portable3) || portable3.startsWith("//");
  const portableScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(portable3);
  invariant4(typeof value === "string" && value !== "" && !isAbsolute2(value) && !portableAbsolute && !portableScheme, `${name} muss ein relativer Artefaktpfad sein.`);
  const segments = portable3.split("/");
  invariant4(!segments.includes("") && !segments.includes(".") && !segments.includes(".."), `${name} muss ein normalisierter Pfad innerhalb der Artefaktwurzel sein.`);
  return value;
}
function canonicalValue2(value) {
  if (Array.isArray(value)) return value.map(canonicalValue2);
  if (!isRecord2(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue2(value[key])]));
}
function canonicalHash(value) {
  return createHash4("sha256").update(JSON.stringify(canonicalValue2(value))).digest("hex");
}
function movementResourceSetSha256(resourceIds) {
  const hash = createHash4("sha256");
  for (const resourceId of resourceIds) hash.update(`${resourceId}
`, "utf8");
  return hash.digest("hex");
}
function validateMapLayerDeclarations(layers, { timetableRoutes = false } = {}) {
  exactKeys2(layers, timetableRoutes ? CONSERVATIVE_LAYER_NAMES : MAP_LAYER_NAMES, "Operational-v2-Layer");
  for (const name of MAP_LAYER_NAMES) relativeArtifactPath(layers[name], `layers.${name}`);
  if (timetableRoutes) {
    invariant4(layers.timetableRoutes === null || typeof layers.timetableRoutes === "string", "layers.timetableRoutes muss null oder ein relativer Artefaktpfad sein.");
    if (layers.timetableRoutes !== null) relativeArtifactPath(layers.timetableRoutes, "layers.timetableRoutes");
    invariant4(layers.transferDemands === null || isRecord2(layers.transferDemands), "layers.transferDemands muss null oder ein gepinnter Eingabevertrag sein.");
    if (layers.transferDemands !== null) {
      exactKeys2(layers.transferDemands, ["path", "expectedBytes", "expectedSha256"], "layers.transferDemands");
      relativeArtifactPath(layers.transferDemands.path, "layers.transferDemands.path");
      positiveSafeInteger(layers.transferDemands.expectedBytes, "layers.transferDemands.expectedBytes");
      invariant4(SHA2563.test(layers.transferDemands.expectedSha256), "layers.transferDemands.expectedSha256 ist kein SHA-256.");
      invariant4(layers.timetableRoutes !== null, "layers.transferDemands verlangt timetableRoutes.");
    }
  }
}
function validateReadinessSpecification(specification) {
  exactKeys2(specification, ["schema", "mode", "infraReleaseId", "layers", "operationalInputs"], "Operational-v2-Readiness-Spezifikation");
  invariant4(specification.schema === GERMANY_OPERATIONAL_DERIVATION_SCHEMA, "Unbekanntes Operational-v2-Readiness-Schema.");
  invariant4(specification.mode === GERMANY_OPERATIONAL_DERIVATION_MODE, `Operational-v2-Spezifikation muss ${GERMANY_OPERATIONAL_DERIVATION_MODE} sein.`);
  nonEmptyString(specification.infraReleaseId, "Operational-v2-Readiness.infraReleaseId");
  validateMapLayerDeclarations(specification.layers);
  exactKeys2(specification.operationalInputs, GERMANY_OPERATIONAL_REQUIRED_INPUTS.map(({ name }) => name), "Explizite Operational-v2-Eingaben");
  for (const { name } of GERMANY_OPERATIONAL_REQUIRED_INPUTS) {
    const declaration = specification.operationalInputs[name];
    invariant4(declaration === null || typeof declaration === "string", `operationalInputs.${name} muss null oder ein relativer Artefaktpfad sein.`);
    if (declaration !== null) relativeArtifactPath(declaration, `operationalInputs.${name}`);
  }
}
function validateConservativePolicy(policy) {
  exactKeys2(policy, CONSERVATIVE_POLICY_KEYS, "Konservative Operational-v2-Policy");
  invariant4(policy.id === GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID, `policy.id muss ${GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID} sein.`);
  invariant4(policy.qualityClass === "B", "policy.qualityClass muss B sein.");
  nonEmptyString(policy.sourceId, "policy.sourceId");
  invariant4(policy.derivationRule === GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID, `policy.derivationRule muss ${GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID} sein.`);
  positiveSafeInteger(policy.unknownMainlineSpeedKmh, "policy.unknownMainlineSpeedKmh");
  positiveSafeInteger(policy.unknownServiceSpeedKmh, "policy.unknownServiceSpeedKmh");
  invariant4(policy.unknownServiceSpeedKmh <= policy.unknownMainlineSpeedKmh, "Die unbekannte Servicegeschwindigkeit darf die unbekannte Hauptgleisgeschwindigkeit nicht uebersteigen.");
  nonNegativeSafeInteger(policy.unknownGradientAbsPermille, "policy.unknownGradientAbsPermille");
  invariant4(policy.unknownGradientAbsPermille <= 200, "policy.unknownGradientAbsPermille ist nicht begrenzt.");
  positiveSafeInteger(policy.minimumPlatformLengthMm, "policy.minimumPlatformLengthMm");
  positiveSafeInteger(policy.maximumPlatformSnapDistanceMm, "policy.maximumPlatformSnapDistanceMm");
  positiveSafeInteger(policy.minimumOverlapMm, "policy.minimumOverlapMm");
  positiveSafeInteger(policy.minimumBerthEndClearanceMm, "policy.minimumBerthEndClearanceMm");
  positiveSafeInteger(policy.maximumStablingPathEdges, "policy.maximumStablingPathEdges");
  invariant4(policy.maximumStablingPathEdges <= 64, "policy.maximumStablingPathEdges ist nicht konservativ begrenzt.");
  positiveSafeInteger(policy.maximumStablingPathLengthMm, "policy.maximumStablingPathLengthMm");
  invariant4(policy.maximumStablingPathLengthMm <= 1e7, "policy.maximumStablingPathLengthMm ist nicht konservativ begrenzt.");
  invariant4(policy.simulatedOperationalBerthFallback === "real-osm-service-yard-then-spur-then-unclassified-rail/v1", "policy.simulatedOperationalBerthFallback verletzt den versionierten Realgeometrie-Vertrag.");
  positiveSafeInteger(policy.maximumDirectDwellMs, "policy.maximumDirectDwellMs");
  invariant4(policy.maximumDirectDwellMs === 12e5, "policy.maximumDirectDwellMs muss die versionierte 20-Minuten-B-Regel binden.");
  invariant4(Array.isArray(policy.terminalFormationLengthsMm) && policy.terminalFormationLengthsMm.length > 0, "policy.terminalFormationLengthsMm fehlt.");
  for (const [index, lengthMm] of policy.terminalFormationLengthsMm.entries()) {
    positiveSafeInteger(lengthMm, `policy.terminalFormationLengthsMm[${index}]`);
    if (index > 0) invariant4(policy.terminalFormationLengthsMm[index - 1] < lengthMm, "policy.terminalFormationLengthsMm muss streng aufsteigend und eindeutig sein.");
  }
  invariant4(["pzb", "lzb", "etcs-level1", "etcs-level2"].includes(policy.defaultProtectionSystem), "policy.defaultProtectionSystem ist nicht kanonisch.");
  nonEmptyString(policy.regionBoundaryId, "policy.regionBoundaryId");
  nonEmptyString(policy.rzueLayoutId, "policy.rzueLayoutId");
}
function validateGermanyOperationalInfrastructureV2Specification(specification) {
  invariant4(isRecord2(specification), "Operational-v2-Spezifikation muss ein Objekt sein.");
  if (specification.schema === GERMANY_OPERATIONAL_CONSERVATIVE_SCHEMA || specification.mode === GERMANY_OPERATIONAL_CONSERVATIVE_MODE) {
    exactKeys2(specification, ["schema", "mode", "infraReleaseId", "layers", "policy"], "Konservative Operational-v2-Spezifikation");
    invariant4(specification.schema === GERMANY_OPERATIONAL_CONSERVATIVE_SCHEMA, "Unbekanntes konservatives Operational-v2-Schema.");
    invariant4(specification.mode === GERMANY_OPERATIONAL_CONSERVATIVE_MODE, `Konservative Operational-v2-Spezifikation muss ${GERMANY_OPERATIONAL_CONSERVATIVE_MODE} sein.`);
    nonEmptyString(specification.infraReleaseId, "Konservative Operational-v2-Spezifikation.infraReleaseId");
    validateMapLayerDeclarations(specification.layers, { timetableRoutes: true });
    validateConservativePolicy(specification.policy);
    return "conservative";
  }
  if (specification.schema === LEGACY_DERIVATION_SCHEMA) return "legacy";
  validateReadinessSpecification(specification);
  return "readiness";
}
function legacyInputDeclarations() {
  return Object.fromEntries(GERMANY_OPERATIONAL_REQUIRED_INPUTS.map(({ name }) => [name, null]));
}
function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}
function assessGermanyOperationalInfrastructureV2Readiness(specification) {
  invariant4(isRecord2(specification), "Operational-v2-Spezifikation muss ein Objekt sein.");
  const legacy = specification.schema === LEGACY_DERIVATION_SCHEMA;
  if (legacy) {
    nonEmptyString(specification.infraReleaseId, "Legacy-Operational-v2-Spezifikation.infraReleaseId");
    validateMapLayerDeclarations(specification.layers);
  } else {
    validateReadinessSpecification(specification);
  }
  const operationalInputs = legacy ? legacyInputDeclarations() : specification.operationalInputs;
  const blockers = [{
    code: "six-layer-map-contract-not-operational",
    input: "layers",
    message: "Tracks, Plattformkartenpunkte, Weichen, Signale, Bloecke und Konfliktressourcen sind Karten-/Evidenzlayer und duerfen keinen OperationalInfraRelease-Candidate erzeugen."
  }];
  if (legacy) blockers.push({ code: "legacy-six-layer-derivation-schema-forbidden", input: "schema", message: `${LEGACY_DERIVATION_SCHEMA} ist wegen erfundener Fahrstrassen- und Schutzwahrheit gesperrt.` });
  for (const requirement of GERMANY_OPERATIONAL_REQUIRED_INPUTS) {
    if (operationalInputs[requirement.name] === null) blockers.push({ code: requirement.blockerCode, input: `operationalInputs.${requirement.name}`, message: `${requirement.artifact} fehlt.` });
  }
  blockers.push({ code: "explicit-rust-operational-compiler-not-implemented", input: "operationalInputs", message: "Auch vollstaendig deklarierte Fachartefakte bleiben blockiert, bis ein echter Compiler sie gegen StationHead und den nativen Operational-v2-Laufzeitvertrag materialisiert und dynamisch nachweist." });
  blockers.sort((left, right) => left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
  const report = {
    schema: GERMANY_OPERATIONAL_DERIVATION_REPORT_SCHEMA,
    status: "blocked",
    infraReleaseId: specification.infraReleaseId,
    candidateProduced: false,
    specificationProof: { canonicalization: "sorted-json-object-keys/v1", sha256: canonicalHash(specification) },
    legacyMapLayers: sortedObject(specification.layers),
    operationalInputs: sortedObject(operationalInputs),
    requiredInputs: GERMANY_OPERATIONAL_REQUIRED_INPUTS.map(({ name, artifact, requiredFields, constraints }) => ({ name, artifact, requiredFields, constraints })),
    blockers,
    unresolvedRequired: blockers.length
  };
  invariant4(report.unresolvedRequired > 0, "Operational-v2-Readiness darf ohne implementierten Fachcompiler niemals freigegeben sein.");
  return report;
}
var OperationalInfrastructureDerivationBlockedError = class extends Error {
  constructor(report) {
    super(`Operational-v2-Ableitung blockiert (${report.unresolvedRequired} Pflichtbefunde): ${report.blockers.map(({ code }) => code).join(", ")}`);
    this.name = "OperationalInfrastructureDerivationBlockedError";
    this.report = report;
  }
};
var OperationalInfrastructureDerivationIncompleteError = class extends Error {
  constructor(result) {
    super(`Operational-v2-Ableitung bleibt mit ${result.nativeReport.unresolvedRequired} Pflichtbefund(en) nicht aktivierbar.`);
    this.name = "OperationalInfrastructureDerivationIncompleteError";
    this.result = result;
  }
};
async function fileProof2(path, label) {
  const before = await lstat4(path, { bigint: true });
  invariant4(before.isFile() && !before.isSymbolicLink() && before.size > 0n, `${label} ist keine nichtleere regulaere Datei.`);
  invariant4(before.size <= BigInt(Number.MAX_SAFE_INTEGER), `${label} ist fuer einen sicheren Bytebeleg zu gross.`);
  const digest = createHash4("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  const after = await lstat4(path, { bigint: true });
  invariant4(sameFileIdentity(before, after) && after.size === before.size && BigInt(bytes) === before.size, `${label} aenderte sich waehrend der Hashbildung.`);
  return { bytes, sha256: digest.digest("hex") };
}
function parseLastJsonLine(stdout, label) {
  const line = stdout.trim().split(/\r?\n/u).at(-1);
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${label} lieferte kein JSON-Receipt.`);
  }
}
function spawnGermanyOperationalInfrastructureV2Compiler(specificationPath, sourceRoot, candidatePath, reportPath, { executable, argumentPrefix = [], cwd = REPOSITORY_ROOT2 } = {}) {
  const configuredExecutable = (executable ?? process.env[GERMANY_OPERATIONAL_NATIVE_EXECUTABLE_ENV]?.trim()) || void 0;
  const command = configuredExecutable ?? process.env.CARGO ?? "cargo";
  const arguments_ = configuredExecutable === void 0 ? ["run", "--quiet", "--locked", "-p", "zugfolge-infra", "--bin", "zugfolge-infra-release", "--", "derive-germany-operational-v2", specificationPath, sourceRoot, candidatePath, reportPath] : [...argumentPrefix, "derive-germany-operational-v2", specificationPath, sourceRoot, candidatePath, reportPath];
  const result = spawnSync3(command, arguments_, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  if (result.error !== void 0) throw new Error(`Nativer Deutschland-Operational-v2-Compiler konnte nicht gestartet werden: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`Native Deutschland-Operational-v2-Ableitung fehlgeschlagen:
${result.stderr}
${result.stdout}`);
  return parseLastJsonLine(result.stdout, "Native Deutschland-Operational-v2-Ableitung");
}
function validateProof(value, name, { stateHash = false } = {}) {
  exactKeys2(value, stateHash ? ["bytes", "sha256", "stateHash"] : ["bytes", "sha256"], name);
  positiveSafeInteger(value.bytes, `${name}.bytes`);
  invariant4(SHA2563.test(value.sha256), `${name}.sha256 ist kein SHA-256.`);
  if (stateHash) invariant4(SHA2563.test(value.stateHash), `${name}.stateHash ist kein SHA-256.`);
  return value;
}
function validateMovementRouteTemplatesProof(value, name, expectedOperationalStateHash, expectedTransferSetSha256, expectedFile = "operational-infrastructure-v2.movement-route-templates-v2.json") {
  exactKeys2(value, ["file", "bytes", "sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256", "berthAssignmentCounts", "crossBerthTemplateCount"], name);
  invariant4(value.file === expectedFile, `${name}.file bindet nicht den erwarteten Movement-Route-Sidecar-Dateinamen.`);
  positiveSafeInteger(value.bytes, `${name}.bytes`);
  for (const field of ["sha256", "stateHash", "operationalStateHash"]) invariant4(SHA2563.test(value[field]), `${name}.${field} ist kein SHA-256.`);
  invariant4(value.operationalStateHash === expectedOperationalStateHash, `${name} driftet vom Operational-State-Hash.`);
  invariant4(value.timetableTransferSetSha256 === expectedTransferSetSha256, `${name} driftet vom timetableTransferSetSha256.`);
  exactKeys2(value.berthAssignmentCounts, ["observedOsmServiceSiding", "simulatedOperationalOsmServiceYard", "simulatedOperationalOsmServiceSpur", "simulatedOperationalOsmUnclassifiedRail"], `${name}.berthAssignmentCounts`);
  for (const [field, count] of Object.entries(value.berthAssignmentCounts)) nonNegativeSafeInteger(count, `${name}.berthAssignmentCounts.${field}`);
  nonNegativeSafeInteger(value.crossBerthTemplateCount, `${name}.crossBerthTemplateCount`);
  return value;
}
function validateGermanyOperationalInfrastructureV2NativeReceipt(receipt, expectedReleaseId, { expectedMovementRouteTemplatesFile = "operational-infrastructure-v2.movement-route-templates-v2.json" } = {}) {
  exactKeys2(receipt, ["schema", "infraReleaseId", "candidate", "movementRouteTemplates", "report", "candidateProduced", "activationEligible", "unresolvedRequired"], "Native Deutschland-Operational-v2-Receipt");
  invariant4(receipt.schema === GERMANY_OPERATIONAL_NATIVE_RECEIPT_SCHEMA, "Native Deutschland-Operational-v2-Ableitung lieferte ein unbekanntes Receipt-Schema.");
  invariant4(receipt.infraReleaseId === expectedReleaseId, "Native Deutschland-Operational-v2-Ableitung verletzte die InfraRelease-ID-Bindung.");
  invariant4(receipt.candidateProduced === true, "Native Deutschland-Operational-v2-Ableitung belegte keinen erzeugten Candidate.");
  nonNegativeSafeInteger(receipt.unresolvedRequired, "Native Deutschland-Operational-v2-Receipt.unresolvedRequired");
  invariant4(typeof receipt.activationEligible === "boolean" && receipt.activationEligible === (receipt.unresolvedRequired === 0), "Native Deutschland-Operational-v2-Receipt besitzt eine widerspruechliche Aktivierungsentscheidung.");
  validateProof(receipt.candidate, "Native Candidate-Bindung", { stateHash: true });
  validateMovementRouteTemplatesProof(
    receipt.movementRouteTemplates,
    "Native Movement-Route-Templates-Bindung",
    receipt.candidate.stateHash,
    receipt.movementRouteTemplates.timetableTransferSetSha256,
    expectedMovementRouteTemplatesFile
  );
  validateProof(receipt.report, "Native Bericht-Bindung");
  return receipt;
}
function validateGermanyOperationalInfrastructureV2NativeReport(report, specification, { expectedMovementRouteTemplatesFile = "operational-infrastructure-v2.movement-route-templates-v2.json" } = {}) {
  exactKeys2(report, [
    "schema",
    "mode",
    "infraReleaseId",
    "policy",
    "inputs",
    "candidate",
    "timetableRouteEvidence",
    "counts",
    "scope",
    "routeCoverage",
    "activationEligible",
    "unresolvedRequired",
    "unresolvedRequiredDimensions",
    "realInterlockingFactsClaimed",
    "realGeometry",
    "simulatedOperationalAssignment",
    "candidateProduced"
  ], "Nativer Deutschland-Operational-v2-Bericht");
  invariant4(report.schema === GERMANY_OPERATIONAL_NATIVE_REPORT_SCHEMA, "Nativer Deutschland-Operational-v2-Bericht besitzt ein unbekanntes Schema.");
  invariant4(report.mode === GERMANY_OPERATIONAL_CONSERVATIVE_MODE, "Nativer Deutschland-Operational-v2-Bericht besitzt nicht den konservativen Modus.");
  invariant4(report.infraReleaseId === specification.infraReleaseId, "Nativer Deutschland-Operational-v2-Bericht verletzte die InfraRelease-ID-Bindung.");
  invariant4(report.candidateProduced === true, "Nativer Deutschland-Operational-v2-Bericht belegte keinen erzeugten Candidate.");
  nonNegativeSafeInteger(report.unresolvedRequired, "Nativer Bericht.unresolvedRequired");
  invariant4(Array.isArray(report.unresolvedRequiredDimensions) && report.unresolvedRequiredDimensions.every((entry) => typeof entry === "string" && entry !== ""), "Nativer Bericht besitzt keine typisierten ungeloesten Pflichtdimensionen.");
  invariant4(report.unresolvedRequired === report.unresolvedRequiredDimensions.length, "Nativer Bericht-Zaehler und Pflichtdimensionen laufen auseinander.");
  invariant4(typeof report.activationEligible === "boolean" && report.activationEligible === (report.unresolvedRequired === 0), "Nativer Bericht besitzt eine widerspruechliche Aktivierungsentscheidung.");
  invariant4(
    report.routeCoverage === (report.activationEligible ? GERMANY_OPERATIONAL_COMPLETE_ROUTE_COVERAGE : "local-directed-track-templates"),
    "Nativer Bericht besitzt eine widerspruechliche Fahrwegabdeckung."
  );
  invariant4(report.realInterlockingFactsClaimed === false, "Der simulierte Klasse-B-Bericht darf keine realen Stellwerksfakten behaupten.");
  exactKeys2(report.policy, ["id", "sha256", "spec"], "Nativer Bericht.policy");
  invariant4(report.policy.id === specification.policy.id, "Nativer Deutschland-Operational-v2-Bericht ist nicht an die Policy-ID gebunden.");
  invariant4(report.policy.sha256 === canonicalHash(specification.policy), "Nativer Deutschland-Operational-v2-Bericht ist nicht an die Policy-Bytesemantik gebunden.");
  invariant4(JSON.stringify(canonicalValue2(report.policy.spec)) === JSON.stringify(canonicalValue2(specification.policy)), "Nativer Deutschland-Operational-v2-Bericht wiederholt eine abweichende Policy.");
  exactKeys2(report.inputs, ["spec", "tracks", "platforms", "switches", "signals", "blocks", "conflictResources", "timetableRoutes", "transferDemands"], "Nativer Bericht.inputs");
  for (const [name, evidence] of Object.entries(report.inputs)) {
    if ((name === "timetableRoutes" || name === "transferDemands") && evidence === null) {
      invariant4(specification.layers[name] === null, `Nativer Bericht unterschlaegt deklarierte ${name}.`);
      continue;
    }
    exactKeys2(evidence, ["path", "bytes", "sha256", "records"], `Nativer Bericht.inputs.${name}`);
    nonEmptyString(evidence.path, `Nativer Bericht.inputs.${name}.path`);
    positiveSafeInteger(evidence.bytes, `Nativer Bericht.inputs.${name}.bytes`);
    invariant4(SHA2563.test(evidence.sha256), `Nativer Bericht.inputs.${name}.sha256 ist kein SHA-256.`);
    nonNegativeSafeInteger(evidence.records, `Nativer Bericht.inputs.${name}.records`);
  }
  exactKeys2(report.candidate, ["bytes", "sha256", "stateHash", "validationMode", "movementRouteTemplates"], "Nativer Bericht.candidate");
  positiveSafeInteger(report.candidate.bytes, "Nativer Bericht.candidate.bytes");
  invariant4(SHA2563.test(report.candidate.sha256) && SHA2563.test(report.candidate.stateHash), "Nativer Bericht besitzt keine vollstaendige Candidate-Hashbindung.");
  invariant4(report.candidate.validationMode === "native-streaming-redb-v1", "Nativer Bericht besitzt keinen nativen Streaming-Validierungsbeleg.");
  const transferSetSha256 = report.timetableRouteEvidence === null ? null : report.timetableRouteEvidence.transferSetSha256;
  validateMovementRouteTemplatesProof(
    report.candidate.movementRouteTemplates,
    "Nativer Bericht.candidate.movementRouteTemplates",
    report.candidate.stateHash,
    transferSetSha256,
    expectedMovementRouteTemplatesFile
  );
  invariant4(isRecord2(report.counts), "Nativer Deutschland-Operational-v2-Bericht besitzt keinen Zaehlerbeleg.");
  exactKeys2(report.counts, ["source", "candidate", "provenance"], "Nativer Bericht.counts");
  exactKeys2(report.counts.source, ["tracks", "orderableTracks", "platforms", "switches", "signals", "blocks", "conflictResources", "timetableRoutes", "timetableLegs", "transferDemands", "transferLots", "turnaroundDemands", "turnaroundPairs"], "Nativer Bericht.counts.source");
  exactKeys2(report.counts.candidate, ["directedEdges", "edgeGeometries", "routeVersions", "interlockingRoutes", "signals", "switches", "blockResources", "platformIntervals", "regionBoundaries", "directTemplates", "stablingTemplates", "transferTemplates"], "Nativer Bericht.counts.candidate");
  exactKeys2(report.counts.provenance, ["observedForwardSpeeds", "observedBackwardSpeeds", "simulatedSpeeds", "observedProtectionAssignments", "simulatedProtectionAssignments", "matchedPlatformIntervals", "excludedPlatformEvidence", "syntheticBoundarySignals", "turnaroundRouteVersions", "turnaroundInterlockingRoutes", "transferRouteVersions", "transferInterlockingRoutes", "observedStablingTemplates", "simulatedOperationalStablingTemplates", "berthAssignmentCounts", "crossBerthTemplates"], "Nativer Bericht.counts.provenance");
  exactKeys2(report.counts.provenance.berthAssignmentCounts, ["observedOsmServiceSiding", "simulatedOperationalOsmServiceYard", "simulatedOperationalOsmServiceSpur", "simulatedOperationalOsmUnclassifiedRail"], "Nativer Bericht.counts.provenance.berthAssignmentCounts");
  for (const group of [report.counts.source, report.counts.candidate]) for (const [name, count] of Object.entries(group)) nonNegativeSafeInteger(count, `Nativer Bericht.counts.${name}`);
  for (const [name, count] of Object.entries(report.counts.provenance)) {
    if (name !== "berthAssignmentCounts") nonNegativeSafeInteger(count, `Nativer Bericht.counts.provenance.${name}`);
  }
  for (const [name, count] of Object.entries(report.counts.provenance.berthAssignmentCounts)) nonNegativeSafeInteger(count, `Nativer Bericht.counts.provenance.berthAssignmentCounts.${name}`);
  const berthAssignmentTotal = Object.values(report.counts.provenance.berthAssignmentCounts).reduce((sum, count) => sum + count, 0);
  invariant4(
    JSON.stringify(canonicalValue2(report.counts.provenance.berthAssignmentCounts)) === JSON.stringify(canonicalValue2(report.candidate.movementRouteTemplates.berthAssignmentCounts)) && report.counts.provenance.crossBerthTemplates === report.candidate.movementRouteTemplates.crossBerthTemplateCount && report.counts.provenance.observedStablingTemplates + report.counts.provenance.simulatedOperationalStablingTemplates === report.counts.candidate.stablingTemplates && berthAssignmentTotal === report.counts.candidate.stablingTemplates + report.counts.provenance.crossBerthTemplates,
    "Nativer Bericht zaehlt Berth-Provenienz in Report und Movement-Beleg verschieden."
  );
  if (report.timetableRouteEvidence === null) {
    invariant4(specification.layers.transferDemands === null, "Nativer Bericht unterschlaegt transferDemands-Evidence.");
  } else {
    exactKeys2(report.timetableRouteEvidence, ["timetableRoutes", "transferDemands", "dailyPlanSha256", "transferSetSha256", "circulationCount", "plannedTransitionCount", "transferDemandCount", "transferLotCount", "turnaroundDemandCount", "turnaroundPairCount", "movementRouteTemplates"], "Nativer Bericht.timetableRouteEvidence");
    for (const field of ["dailyPlanSha256", "transferSetSha256"]) invariant4(SHA2563.test(report.timetableRouteEvidence[field]), `Nativer Bericht.timetableRouteEvidence.${field} ist kein SHA-256.`);
    for (const field of ["circulationCount", "plannedTransitionCount"]) positiveSafeInteger(report.timetableRouteEvidence[field], `Nativer Bericht.timetableRouteEvidence.${field}`);
    for (const field of ["transferDemandCount", "transferLotCount", "turnaroundDemandCount", "turnaroundPairCount"]) nonNegativeSafeInteger(report.timetableRouteEvidence[field], `Nativer Bericht.timetableRouteEvidence.${field}`);
    invariant4(
      report.timetableRouteEvidence.transferDemandCount + report.timetableRouteEvidence.turnaroundDemandCount === report.timetableRouteEvidence.plannedTransitionCount && report.timetableRouteEvidence.turnaroundPairCount <= report.timetableRouteEvidence.turnaroundDemandCount,
      "Nativer Bericht partitioniert die geplanten physischen Fortsetzungen nicht vollstaendig."
    );
    invariant4(JSON.stringify(canonicalValue2(report.timetableRouteEvidence.timetableRoutes)) === JSON.stringify(canonicalValue2(report.inputs.timetableRoutes)), "timetableRouteEvidence driftet vom timetableRoutes-Input.");
    invariant4(JSON.stringify(canonicalValue2(report.timetableRouteEvidence.transferDemands)) === JSON.stringify(canonicalValue2(report.inputs.transferDemands)), "timetableRouteEvidence driftet vom transferDemands-Input.");
    invariant4(report.timetableRouteEvidence.transferDemands.path === specification.layers.transferDemands.path && report.timetableRouteEvidence.transferDemands.bytes === specification.layers.transferDemands.expectedBytes && report.timetableRouteEvidence.transferDemands.sha256 === specification.layers.transferDemands.expectedSha256, "timetableRouteEvidence driftet vom gepinnten transferDemands-Vertrag.");
    invariant4(JSON.stringify(canonicalValue2(report.timetableRouteEvidence.movementRouteTemplates)) === JSON.stringify(canonicalValue2(report.candidate.movementRouteTemplates)), "timetableRouteEvidence besitzt eine abweichende Movement-Sidecar-Bindung.");
  }
  exactKeys2(report.scope, ["routeModel", "interlockingModel", "platformModel", "capacityBias", "minimumOverlapMmPolicy", "turnaroundModel", "minimumBerthEndClearanceMmPolicy", "maximumStablingPathEdgesPolicy", "maximumStablingPathLengthMmPolicy", "simulatedOperationalBerthFallbackPolicy", "maximumDirectDwellMsPolicy", "terminalFormationLengthsMm", "movementRouteTemplateModel"], "Nativer Bericht.scope");
  invariant4(report.scope.routeModel === report.routeCoverage, "Nativer Deutschland-Operational-v2-Bericht besitzt zwei verschiedene Fahrwegmodelle.");
  invariant4(report.scope.minimumOverlapMmPolicy === specification.policy.minimumOverlapMm, "Nativer Bericht besitzt eine abweichende Durchrutschweg-Policy.");
  invariant4(report.scope.minimumBerthEndClearanceMmPolicy === specification.policy.minimumBerthEndClearanceMm && report.scope.maximumStablingPathEdgesPolicy === specification.policy.maximumStablingPathEdges && report.scope.maximumStablingPathLengthMmPolicy === specification.policy.maximumStablingPathLengthMm && report.scope.simulatedOperationalBerthFallbackPolicy === specification.policy.simulatedOperationalBerthFallback && report.scope.maximumDirectDwellMsPolicy === specification.policy.maximumDirectDwellMs, "Nativer Bericht besitzt eine abweichende Turnaround-Policy.");
  invariant4(JSON.stringify(report.scope.terminalFormationLengthsMm) === JSON.stringify(specification.policy.terminalFormationLengthsMm), "Nativer Bericht besitzt abweichende Formationslaengen.");
  invariant4(report.realGeometry === true && report.simulatedOperationalAssignment === true, "Nativer Bericht besitzt keine ehrliche Realgeometrie-/Synthetic-B-Klassifikation.");
  return report;
}
function sortedUniqueStrings(values, name, { allowEmpty = false } = {}) {
  invariant4(Array.isArray(values) && (allowEmpty || values.length > 0), `${name} muss ein ${allowEmpty ? "" : "nichtleeres "}Array sein.`);
  for (const [index, value] of values.entries()) nonEmptyString(value, `${name}[${index}]`);
  invariant4(values.every((value, index) => index === 0 || Buffer.from(values[index - 1]).compare(Buffer.from(value)) < 0), `${name} muss UTF-8-sortiert und eindeutig sein.`);
}
function validateProtectionRuns(runs, routeLegCount, name) {
  invariant4(Array.isArray(runs) && runs.length > 0, `${name} muss nichtleer sein.`);
  let previous = -1;
  for (const [index, run] of runs.entries()) {
    exactKeys2(run, ["throughRouteLegIndex", "availableProtectionSystems", "simultaneouslyRequiredProtectionSystems"], `${name}[${index}]`);
    nonNegativeSafeInteger(run.throughRouteLegIndex, `${name}[${index}].throughRouteLegIndex`);
    invariant4(run.throughRouteLegIndex > previous && run.throughRouteLegIndex < routeLegCount, `${name} besitzt keine streng fortschreitende Lauflaengenbindung.`);
    sortedUniqueStrings(run.availableProtectionSystems, `${name}[${index}].availableProtectionSystems`);
    sortedUniqueStrings(run.simultaneouslyRequiredProtectionSystems, `${name}[${index}].simultaneouslyRequiredProtectionSystems`, { allowEmpty: true });
    previous = run.throughRouteLegIndex;
  }
  invariant4(previous === routeLegCount - 1, `${name} deckt nicht alle Laufweg-Legs.`);
}
function validateDispatch(dispatch, name) {
  exactKeys2(dispatch, ["routeVersionId", "predecessorBaseRouteVersionId", "continuity", "dispatchInterlockingRouteId", "headRouteMm", "minimumRuntimeMs", "resourceIds", "routeLegCount", "protectionContractRuns"], name);
  nonEmptyString(dispatch.routeVersionId, `${name}.routeVersionId`);
  nonEmptyString(dispatch.predecessorBaseRouteVersionId, `${name}.predecessorBaseRouteVersionId`);
  invariant4(["same-direction", "reverse-direction"].includes(dispatch.continuity), `${name}.continuity ist keine signierte physische Fortsetzungsrichtung.`);
  nonEmptyString(dispatch.dispatchInterlockingRouteId, `${name}.dispatchInterlockingRouteId`);
  positiveSafeInteger(dispatch.headRouteMm, `${name}.headRouteMm`);
  positiveSafeInteger(dispatch.minimumRuntimeMs, `${name}.minimumRuntimeMs`);
  positiveSafeInteger(dispatch.routeLegCount, `${name}.routeLegCount`);
  sortedUniqueStrings(dispatch.resourceIds, `${name}.resourceIds`);
  validateProtectionRuns(dispatch.protectionContractRuns, dispatch.routeLegCount, `${name}.protectionContractRuns`);
}
function validateTerminalInterval(interval, name) {
  exactKeys2(interval, ["edgeId", "fromMm", "toMm"], name);
  nonEmptyString(interval.edgeId, `${name}.edgeId`);
  nonNegativeSafeInteger(interval.fromMm, `${name}.fromMm`);
  positiveSafeInteger(interval.toMm, `${name}.toMm`);
  invariant4(interval.fromMm < interval.toMm, `${name} ist leer oder invertiert.`);
}
function validateTerminalIntervals(intervals, formationLengthMm, name, expectedTerminalEdgeId) {
  invariant4(Array.isArray(intervals) && intervals.length > 0, `${name} muss eine nichtleere Intervallfolge sein.`);
  let lengthMm = 0;
  const keys = /* @__PURE__ */ new Set();
  for (const [index, interval] of intervals.entries()) {
    validateTerminalInterval(interval, `${name}[${index}]`);
    lengthMm += interval.toMm - interval.fromMm;
    invariant4(Number.isSafeInteger(lengthMm), `${name} laeuft in der Laenge ueber.`);
    const key = `${interval.edgeId}\0${interval.fromMm}\0${interval.toMm}`;
    invariant4(!keys.has(key), `${name} enthaelt ein doppeltes Intervall.`);
    keys.add(key);
  }
  invariant4(lengthMm === formationLengthMm, `${name} bildet die Formation nicht exakt ab.`);
  if (expectedTerminalEdgeId !== void 0) {
    invariant4(intervals.at(-1).edgeId === expectedTerminalEdgeId, `${name} endet nicht auf der gebundenen Terminalkante.`);
  }
}
function validateBerthAssignment(value, name) {
  exactKeys2(value, ["kind", "subtype", "geometryProvenance", "operationalAssignmentProvenance"], name);
  invariant4(value.geometryProvenance === "real-osm-rail", `${name} bindet keine reale OSM-Gleisgeometrie.`);
  const observed = value.kind === "observed" && value.subtype === "osm-service-siding" && value.operationalAssignmentProvenance === "observed-osm-service";
  const simulated = value.kind === "simulated-operational" && ["osm-service-yard", "osm-service-spur", "osm-unclassified-rail"].includes(value.subtype) && value.operationalAssignmentProvenance === "synthetic-operational-b-policy";
  invariant4(observed || simulated, `${name} widerspricht der beobachteten bzw. simulierten Betriebszuordnung.`);
  return value;
}
function validateBerth(value, formationLengthMm, name) {
  exactKeys2(value, ["edgeId", "edgeLengthMm", "fromMm", "toMm", "leftClearanceMm", "rightClearanceMm"], name);
  nonEmptyString(value.edgeId, `${name}.edgeId`);
  for (const field of ["edgeLengthMm", "fromMm", "toMm", "leftClearanceMm", "rightClearanceMm"]) nonNegativeSafeInteger(value[field], `${name}.${field}`);
  invariant4(value.toMm - value.fromMm === formationLengthMm, `${name} bildet die Formation nicht exakt ab.`);
  invariant4(value.fromMm === value.leftClearanceMm, `${name} besitzt eine widerspruechliche linke Freilaenge.`);
  invariant4(Number.isSafeInteger(value.toMm + value.rightClearanceMm) && value.toMm + value.rightClearanceMm === value.edgeLengthMm, `${name} bindet die rechte Freilaenge nicht an das reale Kantenende.`);
  return value;
}
function validateBerthTransferProvenance(value, template, specification, name) {
  exactKeys2(value, ["geometryProvenance", "routingRule", "locationId", "physicalStopId", "maximumPathEdgesPerSide", "maximumPathLengthMmPerSide"], name);
  invariant4(
    value.geometryProvenance === "real-osm-rail" && value.routingRule === "real-osm-rail-bidirectional-bounded-v1" && value.locationId === template.locationId && value.physicalStopId === template.physicalStopId && value.maximumPathEdgesPerSide === specification.policy.maximumStablingPathEdges && value.maximumPathLengthMmPerSide === specification.policy.maximumStablingPathLengthMm,
    `${name} verletzt den realen, ortsidentischen und policybegrenzten Cross-Berth-Vertrag.`
  );
  return value;
}
function validateMovementRouteTemplatesSidecar(sidecar, specification, proof) {
  exactKeys2(sidecar, ["schema", "infraReleaseId", "operationalStateHash", "timetableTransferSetSha256", "directTemplates", "templates", "transferTemplates", "metrics", "stateHash"], "Movement-Route-Templates-v2");
  invariant4(sidecar.schema === "movement-route-templates-v2" && sidecar.infraReleaseId === specification.infraReleaseId, "Movement-Sidecar verletzt Schema-/Release-Bindung.");
  invariant4(sidecar.operationalStateHash === proof.operationalStateHash && sidecar.stateHash === proof.stateHash, "Movement-Sidecar verletzt die Receipt-Zustandsbindung.");
  invariant4(sidecar.timetableTransferSetSha256 === proof.timetableTransferSetSha256, "Movement-Sidecar driftet vom Transfer-Set-Hash.");
  invariant4(sidecar.timetableTransferSetSha256 === null || SHA2563.test(sidecar.timetableTransferSetSha256), "Movement-Sidecar besitzt keinen gueltigen Transfer-Set-Hash.");
  exactKeys2(sidecar.metrics, ["directTemplateCount", "stablingTemplateCount", "transferTemplateCount", "transferDemandCount", "turnaroundDemandCount", "plannedTransitionCount", "turnaroundPairCount", "observedStablingTemplateCount", "simulatedOperationalStablingTemplateCount", "berthAssignmentCounts", "crossBerthTemplateCount"], "Movement-Sidecar.metrics");
  for (const [name, count] of Object.entries(sidecar.metrics)) {
    if (name !== "berthAssignmentCounts") nonNegativeSafeInteger(count, `Movement-Sidecar.metrics.${name}`);
  }
  exactKeys2(sidecar.metrics.berthAssignmentCounts, ["observedOsmServiceSiding", "simulatedOperationalOsmServiceYard", "simulatedOperationalOsmServiceSpur", "simulatedOperationalOsmUnclassifiedRail"], "Movement-Sidecar.metrics.berthAssignmentCounts");
  for (const [name, count] of Object.entries(sidecar.metrics.berthAssignmentCounts)) nonNegativeSafeInteger(count, `Movement-Sidecar.metrics.berthAssignmentCounts.${name}`);
  invariant4(Array.isArray(sidecar.directTemplates) && Array.isArray(sidecar.templates) && Array.isArray(sidecar.transferTemplates), "Movement-Sidecar besitzt keine drei Template-Mengen.");
  invariant4(sidecar.metrics.directTemplateCount === sidecar.directTemplates.length && sidecar.metrics.stablingTemplateCount === sidecar.templates.length && sidecar.metrics.transferTemplateCount === sidecar.transferTemplates.length, "Movement-Sidecar-Metriken laufen von den Template-Mengen weg.");
  const ids = /* @__PURE__ */ new Set();
  for (const [index, template] of sidecar.directTemplates.entries()) {
    const name = `Movement-Sidecar.directTemplates[${index}]`;
    exactKeys2(template, ["id", "demandId", "inboundRouteVersionId", "outboundRouteVersionId", "locationId", "physicalStopId", "earliestDepartureS", "latestArrivalS", "availableWindowS", "dailyBoundary", "formationLengthMm", "terminalIntervals", "movementKind", "continuity", "maximumDwellMs", "resourceIds", "resourceSetSha256", "through", "outbound"], name);
    for (const field of ["id", "demandId", "inboundRouteVersionId", "outboundRouteVersionId", "locationId", "physicalStopId"]) nonEmptyString(template[field], `${name}.${field}`);
    invariant4(!ids.has(template.id), `Doppelte Movement-Template-ID ${template.id}.`);
    ids.add(template.id);
    for (const field of ["earliestDepartureS", "latestArrivalS"]) nonNegativeSafeInteger(template[field], `${name}.${field}`);
    positiveSafeInteger(template.availableWindowS, `${name}.availableWindowS`);
    invariant4(template.latestArrivalS - template.earliestDepartureS === template.availableWindowS && typeof template.dailyBoundary === "boolean", `${name} besitzt kein exaktes Turnaround-Zeitfenster.`);
    positiveSafeInteger(template.formationLengthMm, `${name}.formationLengthMm`);
    invariant4(template.movementKind === "train" && ["same-direction", "reverse-direction"].includes(template.continuity), `${name} besitzt keine direkte physische Kontinuitaet.`);
    invariant4(template.maximumDwellMs === specification.policy.maximumDirectDwellMs, `${name} driftet von maximumDirectDwellMs.`);
    validateTerminalIntervals(template.terminalIntervals, template.formationLengthMm, `${name}.terminalIntervals`);
    sortedUniqueStrings(template.resourceIds, `${name}.resourceIds`);
    invariant4(template.resourceSetSha256 === movementResourceSetSha256(template.resourceIds), `${name}.resourceSetSha256 bindet nicht seine Ressourcen.`);
    validateDispatch(template.outbound, `${name}.outbound`);
    if (template.continuity === "reverse-direction") {
      invariant4(template.through === null, `${name}.through muss fuer die physische Richtungswende null sein.`);
      invariant4(template.outbound.continuity === "reverse-direction", `${name}.outbound widerspricht der physischen Richtungswende.`);
      invariant4(template.outbound.predecessorBaseRouteVersionId === template.inboundRouteVersionId, `${name}.outbound bindet nicht die Ankunftsbasisroute.`);
    } else {
      validateDispatch(template.through, `${name}.through`);
      invariant4(template.through.continuity === "same-direction" && template.outbound.continuity === "same-direction", `${name} besitzt keine lueckenlose Same-Direction-Through-Kette.`);
      invariant4(template.through.predecessorBaseRouteVersionId === template.inboundRouteVersionId, `${name}.through bindet nicht die Ankunftsbasisroute.`);
      invariant4(template.outbound.predecessorBaseRouteVersionId === template.through.routeVersionId, `${name}.outbound bindet nicht die Through-Route.`);
    }
  }
  const berthAssignmentCounts = { observedOsmServiceSiding: 0, simulatedOperationalOsmServiceYard: 0, simulatedOperationalOsmServiceSpur: 0, simulatedOperationalOsmUnclassifiedRail: 0 };
  let observedStablingTemplateCount = 0;
  let simulatedOperationalStablingTemplateCount = 0;
  let crossBerthTemplateCount = 0;
  const countAssignment = (assignment) => {
    const key = assignment.subtype === "osm-service-siding" ? "observedOsmServiceSiding" : assignment.subtype === "osm-service-yard" ? "simulatedOperationalOsmServiceYard" : assignment.subtype === "osm-service-spur" ? "simulatedOperationalOsmServiceSpur" : "simulatedOperationalOsmUnclassifiedRail";
    berthAssignmentCounts[key] += 1;
  };
  for (const [index, template] of sidecar.templates.entries()) {
    const name = `Movement-Sidecar.templates[${index}]`;
    exactKeys2(template, ["id", "demandId", "inboundRouteVersionId", "outboundRouteVersionId", "locationId", "physicalStopId", "earliestDepartureS", "latestArrivalS", "availableWindowS", "dailyBoundary", "terminalEdgeId", "terminalNodeId", "inboundDirection", "outboundDirection", "formationLengthMm", "candidateRank", "stablingPathLengthMm", "terminalIntervals", "stablingKind", "arrivalBerthAssignment", "departureBerthAssignment", "shuntIn", "arrivalBerth", "berthTransfer", "berthTransferProvenance", "departureBerth", "shuntOut", "outbound"], name);
    for (const field of ["id", "demandId", "inboundRouteVersionId", "outboundRouteVersionId", "locationId", "physicalStopId", "terminalEdgeId"]) nonEmptyString(template[field], `${name}.${field}`);
    invariant4(!ids.has(template.id), `Doppelte Movement-Template-ID ${template.id}.`);
    ids.add(template.id);
    for (const field of ["earliestDepartureS", "latestArrivalS"]) nonNegativeSafeInteger(template[field], `${name}.${field}`);
    positiveSafeInteger(template.availableWindowS, `${name}.availableWindowS`);
    invariant4(template.latestArrivalS - template.earliestDepartureS === template.availableWindowS, `${name} besitzt kein exaktes Turnaround-Zeitfenster.`);
    invariant4(typeof template.dailyBoundary === "boolean", `${name}.dailyBoundary ist nicht boolesch.`);
    invariant4(Number.isSafeInteger(template.terminalNodeId), `${name}.terminalNodeId ist keine sichere Ganzzahl.`);
    invariant4(["along", "against"].includes(template.inboundDirection) && ["along", "against"].includes(template.outboundDirection), `${name} besitzt ungueltige Richtungen.`);
    positiveSafeInteger(template.formationLengthMm, `${name}.formationLengthMm`);
    nonNegativeSafeInteger(template.candidateRank, `${name}.candidateRank`);
    positiveSafeInteger(template.stablingPathLengthMm, `${name}.stablingPathLengthMm`);
    validateTerminalIntervals(template.terminalIntervals, template.formationLengthMm, `${name}.terminalIntervals`, template.terminalEdgeId);
    validateBerthAssignment(template.arrivalBerthAssignment, `${name}.arrivalBerthAssignment`);
    validateBerthAssignment(template.departureBerthAssignment, `${name}.departureBerthAssignment`);
    if (template.arrivalBerthAssignment.kind === "observed" && template.departureBerthAssignment.kind === "observed") observedStablingTemplateCount += 1;
    else simulatedOperationalStablingTemplateCount += 1;
    validateBerth(template.arrivalBerth, template.formationLengthMm, `${name}.arrivalBerth`);
    validateBerth(template.departureBerth, template.formationLengthMm, `${name}.departureBerth`);
    for (const field of ["shuntIn", "shuntOut", "outbound"]) validateDispatch(template[field], `${name}.${field}`);
    invariant4(template.shuntIn.continuity === "same-direction" && template.outbound.continuity === "same-direction", `${name} widerspricht der physischen Rangier-Fortsetzungsmatrix.`);
    invariant4(template.shuntIn.predecessorBaseRouteVersionId === template.inboundRouteVersionId, `${name}.shuntIn bindet nicht die Ankunftsbasisroute.`);
    countAssignment(template.arrivalBerthAssignment);
    if (template.stablingKind === "shared-berth") {
      invariant4(template.berthTransfer === null && template.berthTransferProvenance === null, `${name} erfindet fuer einen Shared-Berth einen internen Transfer.`);
      invariant4(JSON.stringify(canonicalValue2(template.arrivalBerth)) === JSON.stringify(canonicalValue2(template.departureBerth)) && JSON.stringify(canonicalValue2(template.arrivalBerthAssignment)) === JSON.stringify(canonicalValue2(template.departureBerthAssignment)), `${name} besitzt keinen identischen Shared-Berth.`);
      invariant4(["same-direction", "reverse-direction"].includes(template.shuntOut.continuity), `${name}.shuntOut besitzt keine physische Shared-Berth-Continuity.`);
      invariant4(template.shuntOut.predecessorBaseRouteVersionId === template.shuntIn.routeVersionId, `${name}.shuntOut bindet nicht shuntIn.`);
    } else {
      invariant4(template.stablingKind === "cross-berth-transfer", `${name}.stablingKind ist unbekannt.`);
      validateDispatch(template.berthTransfer, `${name}.berthTransfer`);
      validateBerthTransferProvenance(template.berthTransferProvenance, template, specification, `${name}.berthTransferProvenance`);
      invariant4(JSON.stringify(canonicalValue2(template.arrivalBerth)) !== JSON.stringify(canonicalValue2(template.departureBerth)), `${name} besitzt keinen getrennten Ankunfts-/Abfahrts-Berth.`);
      invariant4(template.berthTransfer.continuity === "reverse-direction" && template.shuntOut.continuity === "reverse-direction", `${name} besitzt keine explizite Cross-Berth-Richtungswechselkette.`);
      invariant4(template.berthTransfer.predecessorBaseRouteVersionId === template.shuntIn.routeVersionId && template.shuntOut.predecessorBaseRouteVersionId === template.berthTransfer.routeVersionId, `${name} besitzt eine unterbrochene Cross-Berth-Vorgaengerkette.`);
      countAssignment(template.departureBerthAssignment);
      crossBerthTemplateCount += 1;
    }
    invariant4(template.outbound.predecessorBaseRouteVersionId === template.shuntOut.routeVersionId, `${name}.outbound bindet nicht shuntOut.`);
  }
  invariant4(
    JSON.stringify(canonicalValue2(sidecar.metrics.berthAssignmentCounts)) === JSON.stringify(canonicalValue2(berthAssignmentCounts)) && JSON.stringify(canonicalValue2(proof.berthAssignmentCounts)) === JSON.stringify(canonicalValue2(berthAssignmentCounts)) && sidecar.metrics.observedStablingTemplateCount === observedStablingTemplateCount && sidecar.metrics.simulatedOperationalStablingTemplateCount === simulatedOperationalStablingTemplateCount && sidecar.metrics.crossBerthTemplateCount === crossBerthTemplateCount && proof.crossBerthTemplateCount === crossBerthTemplateCount && observedStablingTemplateCount + simulatedOperationalStablingTemplateCount === sidecar.templates.length,
    "Movement-Sidecar zaehlt Berth-Provenienz oder Cross-Berth-Templates widerspruechlich."
  );
  invariant4(sidecar.metrics.transferDemandCount + sidecar.metrics.turnaroundDemandCount === sidecar.metrics.plannedTransitionCount && sidecar.metrics.turnaroundPairCount <= sidecar.metrics.turnaroundDemandCount, "Movement-Sidecar partitioniert die geplanten physischen Fortsetzungen nicht vollstaendig.");
  invariant4(
    sidecar.metrics.directTemplateCount === sidecar.metrics.turnaroundPairCount * specification.policy.terminalFormationLengthsMm.length && sidecar.metrics.transferTemplateCount === sidecar.metrics.transferDemandCount * specification.policy.terminalFormationLengthsMm.length,
    "Movement-Sidecar bildet Direct-/Transferanforderungen nicht je Formationslaenge vollstaendig ab."
  );
  for (const [index, template] of sidecar.transferTemplates.entries()) {
    const name = `Movement-Sidecar.transferTemplates[${index}]`;
    exactKeys2(template, ["id", "demandId", "formationLengthMm", "sourcePassengerRouteVersionId", "targetPassengerRouteVersionId", "sourceLocationId", "targetLocationId", "earliestDepartureS", "latestArrivalS", "availableWindowS", "dailyBoundary", "movementKind", "transfer", "targetOutbound", "resourceIds", "resourceSetSha256"], name);
    for (const field of ["id", "demandId", "sourcePassengerRouteVersionId", "targetPassengerRouteVersionId", "sourceLocationId", "targetLocationId"]) nonEmptyString(template[field], `${name}.${field}`);
    invariant4(!ids.has(template.id), `Doppelte Movement-Template-ID ${template.id}.`);
    ids.add(template.id);
    positiveSafeInteger(template.formationLengthMm, `${name}.formationLengthMm`);
    for (const field of ["earliestDepartureS", "latestArrivalS", "availableWindowS"]) positiveSafeInteger(template[field], `${name}.${field}`);
    invariant4(template.latestArrivalS - template.earliestDepartureS === template.availableWindowS && typeof template.dailyBoundary === "boolean" && ["train", "shunting"].includes(template.movementKind), `${name} besitzt ein ungueltiges Zeitfenster oder movementKind.`);
    validateDispatch(template.transfer, `${name}.transfer`);
    validateDispatch(template.targetOutbound, `${name}.targetOutbound`);
    invariant4(template.transfer.continuity === "same-direction" && template.targetOutbound.continuity === "same-direction", `${name} widerspricht der physischen Transfer-Fortsetzungsmatrix.`);
    invariant4(template.transfer.predecessorBaseRouteVersionId === template.sourcePassengerRouteVersionId && template.targetOutbound.predecessorBaseRouteVersionId === template.transfer.routeVersionId, `${name} besitzt eine unterbrochene Transfer-Vorgaengerkette.`);
    sortedUniqueStrings(template.resourceIds, `${name}.resourceIds`);
    invariant4(template.transfer.resourceIds.every((resourceId) => template.resourceIds.includes(resourceId)), `${name} bindet nicht alle Ressourcen seiner ersten Transfer-Fahrstrasse.`);
    invariant4(template.resourceSetSha256 === movementResourceSetSha256(template.resourceIds), `${name}.resourceSetSha256 bindet nicht seine Ressourcen.`);
  }
  const { stateHash: ignoredStateHash, ...stateValue } = sidecar;
  void ignoredStateHash;
  invariant4(canonicalHash({ schema: "movement-route-templates-v2", value: stateValue }) === sidecar.stateHash, "Movement-Sidecar.stateHash ist nicht kanonisch reproduzierbar.");
  return sidecar;
}
async function assertTargetMissing(path, label) {
  try {
    await lstat4(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} existiert bereits; create-new verweigert jede Ueberschreibung.`);
}
async function publishTogether(bindings) {
  try {
    await publishFilesCreateNew(bindings.map(({ staged, final }) => ({ stagedPath: staged, outputPath: final, label: "Operational-v2-Artefakt" })));
  } catch (error) {
    throw new Error(`Operational-v2-Artefakte konnten nicht kollisionsfrei gemeinsam veroeffentlicht werden: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function candidateTripletIdentity(metadata, { size = false } = {}) {
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    ...size ? { size: metadata.size.toString() } : {}
  };
}
function validateCandidateTripletIdentity(value, name, { size = false } = {}) {
  exactKeys2(value, size ? ["dev", "ino", "size"] : ["dev", "ino"], name);
  for (const field of size ? ["dev", "ino", "size"] : ["dev", "ino"]) {
    invariant4(typeof value[field] === "string" && /^\d+$/u.test(value[field]), `${name}.${field} ist keine dezimale Dateisystemidentitaet.`);
  }
  return value;
}
function candidateTripletIdentityMatches(metadata, identity) {
  return metadata.dev.toString() === identity.dev && metadata.ino.toString() === identity.ino && (!Object.hasOwn(identity, "size") || metadata.size.toString() === identity.size);
}
async function maybeCandidateTripletMetadata(path) {
  try {
    return await lstat4(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
function serializeCandidateTripletClaim(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue2(value))}
`, "utf8");
}
function candidateTripletClaimPath(candidate) {
  return join3(dirname4(candidate), CANDIDATE_TRIPLET_CLAIM_FILE);
}
function candidateTripletFileLayout({ candidate, movementRouteTemplates, report, stagingRoot }) {
  const nativeDirectory = join3(stagingRoot, "native");
  return {
    candidate: { finalPath: candidate, stagedPath: join3(nativeDirectory, basename4(candidate)) },
    movementRouteTemplates: { finalPath: movementRouteTemplates, stagedPath: join3(nativeDirectory, basename4(movementRouteTemplates)) },
    report: { finalPath: report, stagedPath: join3(stagingRoot, "report.json") }
  };
}
async function candidateTripletParentSnapshots(files) {
  const paths = [...new Set(Object.values(files).map(({ finalPath }) => dirname4(finalPath)))].sort((left, right) => left.localeCompare(right, "en"));
  return Promise.all(paths.map(async (path) => {
    const metadata = await lstat4(path, { bigint: true });
    invariant4(metadata.isDirectory() && !metadata.isSymbolicLink(), `Candidate-Triplet-Elternpfad ist kein regulaeres Verzeichnis: ${path}`);
    return { path, identity: candidateTripletIdentity(metadata) };
  }));
}
async function assertCandidateTripletParents(parents) {
  for (const parent of parents) {
    const metadata = await lstat4(parent.path, { bigint: true });
    invariant4(metadata.isDirectory() && !metadata.isSymbolicLink() && candidateTripletIdentityMatches(metadata, parent.identity), `Candidate-Triplet-Elternverzeichnis wurde ausgetauscht: ${parent.path}`);
  }
}
function validateCandidateTripletClaim(value, { claimMetadata, claimPath, candidate, movementRouteTemplates, report, specification, specificationPath }) {
  exactKeys2(value, ["claim", "files", "infraReleaseId", "nativeReceipt", "operationalProvenance", "parents", "schema", "specification", "staging"], "Candidate-Triplet-Claim");
  invariant4(value.schema === GERMANY_OPERATIONAL_CANDIDATE_TRIPLET_CLAIM_SCHEMA, "Candidate-Triplet-Claim besitzt ein unbekanntes Schema.");
  invariant4(value.infraReleaseId === specification.infraReleaseId, "Candidate-Triplet-Claim bindet eine falsche InfraRelease-ID.");
  exactKeys2(value.specification, ["path", "sha256"], "Candidate-Triplet-Claim.specification");
  invariant4(value.specification.path === resolve4(specificationPath) && value.specification.sha256 === canonicalHash(specification), "Candidate-Triplet-Claim driftet von der angeforderten Spezifikation.");
  exactKeys2(value.claim, ["identity", "path", "stagedPath"], "Candidate-Triplet-Claim.claim");
  validateCandidateTripletIdentity(value.claim.identity, "Candidate-Triplet-Claim.claim.identity");
  invariant4(value.claim.path === claimPath && candidateTripletIdentityMatches(claimMetadata, value.claim.identity), "Candidate-Triplet-Claim bindet nicht seine sichtbare Dateisystemidentitaet.");
  exactKeys2(value.staging, ["identity", "nativeDirectory", "nativeIdentity", "root"], "Candidate-Triplet-Claim.staging");
  validateCandidateTripletIdentity(value.staging.identity, "Candidate-Triplet-Claim.staging.identity");
  validateCandidateTripletIdentity(value.staging.nativeIdentity, "Candidate-Triplet-Claim.staging.nativeIdentity");
  invariant4(dirname4(value.staging.root) === dirname4(candidate) && basename4(value.staging.root).startsWith(".operational-v2-derive-"), "Candidate-Triplet-Claim bindet keinen privaten Ableitungsbaum.");
  invariant4(value.staging.nativeDirectory === join3(value.staging.root, "native") && value.claim.stagedPath === join3(value.staging.root, CANDIDATE_TRIPLET_STAGED_CLAIM_FILE), "Candidate-Triplet-Claim bindet falsche Staging-Pfade.");
  const expectedFiles = candidateTripletFileLayout({ candidate, movementRouteTemplates, report, stagingRoot: value.staging.root });
  exactKeys2(value.files, ["candidate", "movementRouteTemplates", "report"], "Candidate-Triplet-Claim.files");
  for (const id of ["candidate", "movementRouteTemplates", "report"]) {
    const entry = value.files[id];
    exactKeys2(entry, ["finalPath", "identity", "proof", "stagedPath"], `Candidate-Triplet-Claim.files.${id}`);
    invariant4(entry.finalPath === expectedFiles[id].finalPath && entry.stagedPath === expectedFiles[id].stagedPath, `Candidate-Triplet-Claim.files.${id} bindet falsche Pfade.`);
    validateCandidateTripletIdentity(entry.identity, `Candidate-Triplet-Claim.files.${id}.identity`, { size: true });
    validateProof(entry.proof, `Candidate-Triplet-Claim.files.${id}.proof`);
    invariant4(entry.identity.size === String(entry.proof.bytes), `Candidate-Triplet-Claim.files.${id} bindet verschiedene Bytezahlen.`);
  }
  invariant4(Array.isArray(value.parents), "Candidate-Triplet-Claim.parents muss eine Liste sein.");
  const expectedParents = [...new Set(Object.values(expectedFiles).map(({ finalPath }) => dirname4(finalPath)))].sort((left, right) => left.localeCompare(right, "en"));
  invariant4(value.parents.length === expectedParents.length, "Candidate-Triplet-Claim bindet nicht alle Ziel-Elternverzeichnisse.");
  for (const [index, parent] of value.parents.entries()) {
    exactKeys2(parent, ["identity", "path"], `Candidate-Triplet-Claim.parents[${index}]`);
    validateCandidateTripletIdentity(parent.identity, `Candidate-Triplet-Claim.parents[${index}].identity`);
    invariant4(parent.path === expectedParents[index], "Candidate-Triplet-Claim bindet ein falsches Ziel-Elternverzeichnis.");
  }
  validateGermanyOperationalInfrastructureV2NativeReceipt(value.nativeReceipt, specification.infraReleaseId, { expectedMovementRouteTemplatesFile: basename4(movementRouteTemplates) });
  invariant4(value.operationalProvenance === null || isRecord2(value.operationalProvenance), "Candidate-Triplet-Claim besitzt keine typisierte optionale Operational-Provenienz.");
  return value;
}
async function readCandidateTripletClaim(arguments_) {
  const before = await lstat4(arguments_.claimPath, { bigint: true });
  invariant4(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= BigInt(MAX_CANDIDATE_TRIPLET_CLAIM_BYTES), "Candidate-Triplet-Claim ist keine kleine regulaere Datei.");
  const bytes = await readFile4(arguments_.claimPath);
  const after = await lstat4(arguments_.claimPath, { bigint: true });
  invariant4(sameFileIdentity(before, after) && after.size === before.size && BigInt(bytes.length) === before.size, "Candidate-Triplet-Claim driftete waehrend des Lesens.");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Candidate-Triplet-Claim ist kein gueltiges JSON.");
  }
  validateCandidateTripletClaim(value, { ...arguments_, claimMetadata: after });
  invariant4(bytes.equals(serializeCandidateTripletClaim(value)), "Candidate-Triplet-Claim ist nicht kanonisch serialisiert.");
  return value;
}
async function createCandidateTripletClaim({ candidate, claimPath, hooks, movementRouteTemplates, nativeReceipt, operationalProvenance, publicationState, report, specification, specificationPath, stagingRoot }) {
  const files = candidateTripletFileLayout({ candidate, movementRouteTemplates, report, stagingRoot });
  for (const id of ["candidate", "movementRouteTemplates", "report"]) {
    const metadata = await lstat4(files[id].stagedPath, { bigint: true });
    invariant4(metadata.isFile() && !metadata.isSymbolicLink(), `Candidate-Triplet-Staging ${id} ist keine regulaere Datei.`);
    files[id] = { ...files[id], identity: candidateTripletIdentity(metadata, { size: true }), proof: await fileProof2(files[id].stagedPath, `Candidate-Triplet-Staging ${id}`) };
  }
  const stagingMetadata = await lstat4(stagingRoot, { bigint: true });
  const nativeDirectory = join3(stagingRoot, "native");
  const nativeMetadata = await lstat4(nativeDirectory, { bigint: true });
  invariant4(stagingMetadata.isDirectory() && !stagingMetadata.isSymbolicLink() && nativeMetadata.isDirectory() && !nativeMetadata.isSymbolicLink(), "Candidate-Triplet-Staging besitzt keine regulaeren Verzeichnisse.");
  const parents = await candidateTripletParentSnapshots(files);
  const stagedClaimPath = join3(stagingRoot, CANDIDATE_TRIPLET_STAGED_CLAIM_FILE);
  const handle = await open4(stagedClaimPath, "wx", 384);
  let claim;
  try {
    const metadata = await handle.stat({ bigint: true });
    claim = {
      schema: GERMANY_OPERATIONAL_CANDIDATE_TRIPLET_CLAIM_SCHEMA,
      infraReleaseId: specification.infraReleaseId,
      specification: { path: resolve4(specificationPath), sha256: canonicalHash(specification) },
      claim: { path: claimPath, stagedPath: stagedClaimPath, identity: candidateTripletIdentity(metadata) },
      staging: { root: stagingRoot, identity: candidateTripletIdentity(stagingMetadata), nativeDirectory, nativeIdentity: candidateTripletIdentity(nativeMetadata) },
      parents,
      files,
      nativeReceipt,
      operationalProvenance
    };
    const bytes = serializeCandidateTripletClaim(claim);
    invariant4(bytes.length <= MAX_CANDIDATE_TRIPLET_CLAIM_BYTES, "Candidate-Triplet-Claim ist unerwartet gross.");
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertCandidateTripletParents(parents);
  await publishFilesCreateNew([{ stagedPath: stagedClaimPath, outputPath: claimPath, label: "Candidate-Triplet-Claim" }]);
  publicationState.claimActive = true;
  await assertCandidateTripletParents(parents);
  await hooks.afterCandidateTripletClaim?.({ claim, claimPath });
  return claim;
}
async function ensureCandidateTripletOutputs({ claim, hooks, recovery }) {
  await assertCandidateTripletParents(claim.parents);
  let index = 0;
  for (const id of ["candidate", "movementRouteTemplates", "report"]) {
    index += 1;
    const entry = claim.files[id];
    const existing = await maybeCandidateTripletMetadata(entry.finalPath);
    if (existing !== null) {
      invariant4(existing.isFile() && !existing.isSymbolicLink() && candidateTripletIdentityMatches(existing, entry.identity), `Candidate-Triplet-Ziel ${id} wurde fremd ersetzt; die fremde Identitaet bleibt unangetastet.`);
      const proof = await fileProof2(entry.finalPath, `Candidate-Triplet-Ziel ${id}`);
      invariant4(proof.bytes === entry.proof.bytes && proof.sha256 === entry.proof.sha256, `Candidate-Triplet-Ziel ${id} driftet vom Claim.`);
      continue;
    }
    const staged = await lstat4(entry.stagedPath, { bigint: true });
    invariant4(staged.isFile() && !staged.isSymbolicLink() && candidateTripletIdentityMatches(staged, entry.identity), `Candidate-Triplet-Staging ${id} fehlt oder wurde fremd ersetzt.`);
    const stagedProof = await fileProof2(entry.stagedPath, `Candidate-Triplet-Staging ${id}`);
    invariant4(stagedProof.bytes === entry.proof.bytes && stagedProof.sha256 === entry.proof.sha256, `Candidate-Triplet-Staging ${id} driftet vom Claim.`);
    await assertCandidateTripletParents(claim.parents);
    await publishFilesCreateNew([{ stagedPath: entry.stagedPath, outputPath: entry.finalPath, label: `Candidate-Triplet-${id}` }]);
    const published = await lstat4(entry.finalPath, { bigint: true });
    invariant4(candidateTripletIdentityMatches(published, entry.identity), `Candidate-Triplet-Ziel ${id} driftete unmittelbar nach create-new.`);
    await assertCandidateTripletParents(claim.parents);
    await hooks.afterCandidateTripletLink?.({ claim, id, index, outputPath: entry.finalPath, recovery });
  }
}
async function validatePublishedCandidateTriplet({ claim, movementRouteTemplates, specification }) {
  const candidateProof = await fileProof2(claim.files.candidate.finalPath, "Publizierter Candidate-Triplet-Candidate");
  const movementProof = await fileProof2(claim.files.movementRouteTemplates.finalPath, "Publiziertes Candidate-Triplet-Movement-Sidecar");
  const reportProof = await fileProof2(claim.files.report.finalPath, "Publizierter Candidate-Triplet-Bericht");
  const nativeReceipt = validateGermanyOperationalInfrastructureV2NativeReceipt(claim.nativeReceipt, specification.infraReleaseId, { expectedMovementRouteTemplatesFile: basename4(movementRouteTemplates) });
  invariant4(candidateProof.bytes === nativeReceipt.candidate.bytes && candidateProof.sha256 === nativeReceipt.candidate.sha256, "Publizierter Candidate driftet vom Candidate-Triplet-Claim.");
  invariant4(movementProof.bytes === nativeReceipt.movementRouteTemplates.bytes && movementProof.sha256 === nativeReceipt.movementRouteTemplates.sha256, "Publiziertes Movement-Sidecar driftet vom Candidate-Triplet-Claim.");
  invariant4(reportProof.bytes === nativeReceipt.report.bytes && reportProof.sha256 === nativeReceipt.report.sha256, "Publizierter Bericht driftet vom Candidate-Triplet-Claim.");
  const movementValue = validateMovementRouteTemplatesSidecar(JSON.parse(await readFile4(claim.files.movementRouteTemplates.finalPath, "utf8")), specification, nativeReceipt.movementRouteTemplates);
  const nativeReport = validateGermanyOperationalInfrastructureV2NativeReport(JSON.parse(await readFile4(claim.files.report.finalPath, "utf8")), specification, { expectedMovementRouteTemplatesFile: basename4(movementRouteTemplates) });
  invariant4(nativeReceipt.activationEligible === nativeReport.activationEligible && nativeReceipt.unresolvedRequired === nativeReport.unresolvedRequired, "Candidate-Triplet-Receipt und Berichtsgates laufen auseinander.");
  invariant4(nativeReport.candidate.bytes === nativeReceipt.candidate.bytes && nativeReport.candidate.sha256 === nativeReceipt.candidate.sha256 && nativeReport.candidate.stateHash === nativeReceipt.candidate.stateHash, "Candidate-Triplet-Receipt und Berichtskandidaten laufen auseinander.");
  invariant4(JSON.stringify(canonicalValue2(nativeReport.candidate.movementRouteTemplates)) === JSON.stringify(canonicalValue2(nativeReceipt.movementRouteTemplates)) && movementValue.operationalStateHash === nativeReceipt.candidate.stateHash, "Candidate-Triplet-Receipt, Bericht und Movement-Sidecar laufen auseinander.");
  return { nativeReceipt, nativeReport };
}
async function removeOwnedCandidateTripletFile(path, identity, label) {
  const metadata = await maybeCandidateTripletMetadata(path);
  if (metadata === null) return;
  invariant4(metadata.isFile() && !metadata.isSymbolicLink() && candidateTripletIdentityMatches(metadata, identity), `${label} wurde fremd ersetzt und bleibt unangetastet.`);
  await unlink3(path);
}
async function cleanupCandidateTripletStaging(claim) {
  const rootMetadata = await maybeCandidateTripletMetadata(claim.staging.root);
  if (rootMetadata === null) return;
  invariant4(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink() && candidateTripletIdentityMatches(rootMetadata, claim.staging.identity), "Candidate-Triplet-Stagingwurzel wurde fremd ersetzt und bleibt unangetastet.");
  for (const id of ["report", "movementRouteTemplates", "candidate"]) {
    await removeOwnedCandidateTripletFile(claim.files[id].stagedPath, claim.files[id].identity, `Candidate-Triplet-Staging ${id}`);
  }
  await removeOwnedCandidateTripletFile(claim.claim.stagedPath, claim.claim.identity, "Gestageter Candidate-Triplet-Claim");
  const nativeMetadata = await maybeCandidateTripletMetadata(claim.staging.nativeDirectory);
  if (nativeMetadata !== null) {
    invariant4(nativeMetadata.isDirectory() && !nativeMetadata.isSymbolicLink() && candidateTripletIdentityMatches(nativeMetadata, claim.staging.nativeIdentity), "Candidate-Triplet-Native-Staging wurde fremd ersetzt und bleibt unangetastet.");
    invariant4((await readdir2(claim.staging.nativeDirectory)).length === 0, "Candidate-Triplet-Native-Staging enthaelt fremde Eintraege und bleibt unangetastet.");
    await rmdir3(claim.staging.nativeDirectory);
  }
  const finalRootMetadata = await lstat4(claim.staging.root, { bigint: true });
  invariant4(candidateTripletIdentityMatches(finalRootMetadata, claim.staging.identity) && (await readdir2(claim.staging.root)).length === 0, "Candidate-Triplet-Stagingwurzel driftete oder enthaelt fremde Eintraege.");
  await rmdir3(claim.staging.root);
}
async function removeCandidateTripletClaim(claim) {
  const metadata = await lstat4(claim.claim.path, { bigint: true });
  invariant4(metadata.isFile() && !metadata.isSymbolicLink() && candidateTripletIdentityMatches(metadata, claim.claim.identity), "Sichtbarer Candidate-Triplet-Claim wurde fremd ersetzt und bleibt unangetastet.");
  await unlink3(claim.claim.path);
}
function candidateTripletResult(nativeReceipt, nativeReport, { candidate, movementRouteTemplates, report }) {
  return {
    ...nativeReceipt,
    reportStatus: { unresolvedRequired: nativeReport.unresolvedRequired, activationEligible: nativeReport.activationEligible, realInterlockingFactsClaimed: nativeReport.realInterlockingFactsClaimed },
    materialized: null,
    movementRouteTemplates: { ...nativeReceipt.movementRouteTemplates },
    paths: { candidate, movementRouteTemplates, report, output: null }
  };
}
async function finalizeCandidateTripletClaim({ claim, hooks, movementRouteTemplates, recovery, specification }) {
  await ensureCandidateTripletOutputs({ claim, hooks, recovery });
  const validated = await validatePublishedCandidateTriplet({ claim, movementRouteTemplates, specification });
  await hooks.beforeCandidateTripletCleanup?.({ claim, recovery });
  await cleanupCandidateTripletStaging(claim);
  await assertCandidateTripletParents(claim.parents);
  await hooks.beforeCandidateTripletClaimRemoval?.({ claim, recovery });
  await assertCandidateTripletParents(claim.parents);
  await removeCandidateTripletClaim(claim);
  await assertCandidateTripletParents(claim.parents);
  return validated;
}
async function recoverCandidateTriplet({ candidate, claimPath, hooks, movementRouteTemplates, report, specification, specificationPath }) {
  const claim = await readCandidateTripletClaim({ claimPath, candidate, movementRouteTemplates, report, specification, specificationPath });
  const { nativeReceipt, nativeReport } = await finalizeCandidateTripletClaim({ claim, hooks, movementRouteTemplates, recovery: true, specification });
  const result = candidateTripletResult(nativeReceipt, nativeReport, { candidate, movementRouteTemplates, report });
  if (!nativeReport.activationEligible) throw new OperationalInfrastructureDerivationIncompleteError({ nativeReceipt, nativeReport, paths: result.paths });
  return result;
}
async function publishCandidateTriplet({ candidate, claimPath, hooks, movementRouteTemplates, nativeReceipt, operationalProvenance, publicationState, report, specification, specificationPath, stagingRoot }) {
  const claim = await createCandidateTripletClaim({ candidate, claimPath, hooks, movementRouteTemplates, nativeReceipt, operationalProvenance, publicationState, report, specification, specificationPath, stagingRoot });
  const validated = await finalizeCandidateTripletClaim({ claim, hooks, movementRouteTemplates, recovery: false, specification });
  publicationState.stagingRemoved = true;
  publicationState.claimActive = false;
  return validated;
}
async function runGermanyOperationalInfrastructureV2({
  specification,
  specificationPath,
  sourceRoot,
  candidatePath,
  reportPath,
  outputPath,
  movementRouteTemplatesPath,
  deriveNative = spawnGermanyOperationalInfrastructureV2Compiler,
  materialize = materializeOperationalInfrastructureV2,
  candidateTripletProvenance = async () => null,
  hooks = {}
}) {
  const kind = validateGermanyOperationalInfrastructureV2Specification(specification);
  if (kind !== "conservative") throw new OperationalInfrastructureDerivationBlockedError(assessGermanyOperationalInfrastructureV2Readiness(specification));
  nonEmptyString(specificationPath, "specificationPath");
  nonEmptyString(sourceRoot, "sourceRoot");
  nonEmptyString(candidatePath, "candidatePath");
  nonEmptyString(reportPath, "reportPath");
  if (outputPath !== void 0) nonEmptyString(outputPath, "outputPath");
  if (movementRouteTemplatesPath !== void 0) nonEmptyString(movementRouteTemplatesPath, "movementRouteTemplatesPath");
  const candidate = resolve4(candidatePath);
  const report = resolve4(reportPath);
  const output = outputPath === void 0 ? void 0 : resolve4(outputPath);
  const candidateTripletMode = output === void 0;
  if (candidateTripletMode) {
    invariant4(basename4(candidate) === "operational-infrastructure-v2.candidate.json", "Candidate-Triplet-Candidate besitzt keinen kanonischen Dateinamen.");
  }
  const expectedMovementRouteTemplatesBasename = output === void 0 ? "operational-infrastructure-v2.candidate.movement-route-templates-v2.json" : "operational-infrastructure-v2.movement-route-templates-v2.json";
  const movementRouteTemplates = resolve4(movementRouteTemplatesPath ?? join3(dirname4(output ?? candidate), expectedMovementRouteTemplatesBasename));
  invariant4(basename4(movementRouteTemplates) === expectedMovementRouteTemplatesBasename, "Movement-Route-Sidecar besitzt keinen kanonischen Candidate-/Ausgabedateinamen.");
  invariant4((/* @__PURE__ */ new Set([candidate, report, movementRouteTemplates, ...output === void 0 ? [] : [output]])).size === (output === void 0 ? 3 : 4), "Candidate, Ableitungsbericht, Movement-Sidecar und materialisiertes Operational-v2-Artefakt muessen getrennte Dateien sein.");
  invariant4(candidate !== report, "Operational-v2-Candidate und Ableitungsbericht muessen getrennte Dateien sein.");
  if (output !== void 0) invariant4(basename4(output) === "operational-infrastructure-v2.json", "Operational-v2-Ausgabe besitzt keinen kanonischen Dateinamen.");
  const directories = [dirname4(candidate), dirname4(report), dirname4(movementRouteTemplates), ...output === void 0 ? [] : [dirname4(output)]];
  for (const directory of new Set(directories)) await mkdir4(directory, { recursive: true });
  const tripletClaimPath = candidateTripletMode ? candidateTripletClaimPath(candidate) : void 0;
  if (candidateTripletMode && await maybeCandidateTripletMetadata(tripletClaimPath) !== null) {
    return recoverCandidateTriplet({ candidate, claimPath: tripletClaimPath, hooks, movementRouteTemplates, report, specification, specificationPath });
  }
  await assertTargetMissing(candidate, "Operational-v2-Candidate");
  await assertTargetMissing(report, "Operational-v2-Ableitungsbericht");
  await assertTargetMissing(movementRouteTemplates, "Operational-v2-Movement-Route-Sidecar");
  if (output !== void 0) await assertTargetMissing(output, "Operational-v2-Ausgabe");
  if (candidateTripletMode) await assertTargetMissing(tripletClaimPath, "Candidate-Triplet-Claim");
  const stagingRoot = await mkdtemp3(join3(dirname4(candidate), ".operational-v2-derive-"));
  const stagingRootIdentity = candidateTripletIdentity(await lstat4(stagingRoot, { bigint: true }));
  const nativeStaging = join3(stagingRoot, "native");
  await mkdir4(nativeStaging, { recursive: true });
  const stagedCandidate = join3(nativeStaging, candidateTripletMode ? basename4(candidate) : "operational-infrastructure-v2.json");
  const stagedMovementRouteTemplates = join3(nativeStaging, candidateTripletMode ? basename4(movementRouteTemplates) : "operational-infrastructure-v2.movement-route-templates-v2.json");
  const stagedReport = join3(stagingRoot, "report.json");
  const stagedOutput = join3(stagingRoot, "materialized", "operational-infrastructure-v2.json");
  const candidateTripletPublication = { claimActive: false, stagingRemoved: false };
  try {
    const nativeReceipt = validateGermanyOperationalInfrastructureV2NativeReceipt(
      await deriveNative(resolve4(specificationPath), resolve4(sourceRoot), stagedCandidate, stagedReport),
      specification.infraReleaseId,
      { expectedMovementRouteTemplatesFile: basename4(stagedMovementRouteTemplates) }
    );
    const [candidateProof, movementRouteTemplatesProof, reportProof] = await Promise.all([
      fileProof2(stagedCandidate, "Nativer Operational-v2-Candidate"),
      fileProof2(stagedMovementRouteTemplates, "Natives Operational-v2-Movement-Route-Sidecar"),
      fileProof2(stagedReport, "Nativer Operational-v2-Ableitungsbericht")
    ]);
    invariant4(candidateProof.bytes === nativeReceipt.candidate.bytes && candidateProof.sha256 === nativeReceipt.candidate.sha256, "Native Candidate-Bindung stimmt nicht mit den erzeugten Bytes ueberein.");
    invariant4(reportProof.bytes === nativeReceipt.report.bytes && reportProof.sha256 === nativeReceipt.report.sha256, "Native Bericht-Bindung stimmt nicht mit den erzeugten Bytes ueberein.");
    invariant4(movementRouteTemplatesProof.bytes === nativeReceipt.movementRouteTemplates.bytes && movementRouteTemplatesProof.sha256 === nativeReceipt.movementRouteTemplates.sha256, "Native Movement-Sidecar-Bindung stimmt nicht mit den erzeugten Bytes ueberein.");
    const movementRouteTemplatesValue = validateMovementRouteTemplatesSidecar(
      JSON.parse(await readFile4(stagedMovementRouteTemplates, "utf8")),
      specification,
      nativeReceipt.movementRouteTemplates
    );
    const nativeReport = validateGermanyOperationalInfrastructureV2NativeReport(
      JSON.parse(await readFile4(stagedReport, "utf8")),
      specification,
      { expectedMovementRouteTemplatesFile: basename4(stagedMovementRouteTemplates) }
    );
    invariant4(
      nativeReceipt.activationEligible === nativeReport.activationEligible && nativeReceipt.unresolvedRequired === nativeReport.unresolvedRequired,
      "Native Receipt- und Berichtsgates laufen auseinander."
    );
    invariant4(
      nativeReport.candidate.bytes === nativeReceipt.candidate.bytes && nativeReport.candidate.sha256 === nativeReceipt.candidate.sha256 && nativeReport.candidate.stateHash === nativeReceipt.candidate.stateHash,
      "Native Receipt- und Berichtskandidaten laufen auseinander."
    );
    invariant4(
      JSON.stringify(canonicalValue2(nativeReport.candidate.movementRouteTemplates)) === JSON.stringify(canonicalValue2(nativeReceipt.movementRouteTemplates)) && movementRouteTemplatesValue.operationalStateHash === nativeReceipt.candidate.stateHash,
      "Native Receipt-, Bericht- und Movement-Sidecar-Bindungen laufen auseinander."
    );
    const operationalProvenance = candidateTripletMode ? await candidateTripletProvenance({ nativeReceipt, nativeReport }) : null;
    invariant4(operationalProvenance === null || isRecord2(operationalProvenance), "Candidate-Triplet-Provenienz muss null oder ein Objekt sein.");
    if (!nativeReport.activationEligible) {
      if (candidateTripletMode) {
        const validated = await publishCandidateTriplet({
          candidate,
          claimPath: tripletClaimPath,
          hooks,
          movementRouteTemplates,
          nativeReceipt,
          operationalProvenance,
          publicationState: candidateTripletPublication,
          report,
          specification,
          specificationPath,
          stagingRoot
        });
        throw new OperationalInfrastructureDerivationIncompleteError({
          nativeReceipt: validated.nativeReceipt,
          nativeReport: validated.nativeReport,
          paths: { candidate, movementRouteTemplates, report, output: null }
        });
      }
      await publishTogether([{ staged: stagedCandidate, final: candidate }, { staged: stagedMovementRouteTemplates, final: movementRouteTemplates }, { staged: stagedReport, final: report }]);
      throw new OperationalInfrastructureDerivationIncompleteError({ nativeReceipt, nativeReport, paths: { candidate, movementRouteTemplates, report, output: null } });
    }
    if (output === void 0) {
      const validated = await publishCandidateTriplet({
        candidate,
        claimPath: tripletClaimPath,
        hooks,
        movementRouteTemplates,
        nativeReceipt,
        operationalProvenance,
        publicationState: candidateTripletPublication,
        report,
        specification,
        specificationPath,
        stagingRoot
      });
      return candidateTripletResult(validated.nativeReceipt, validated.nativeReport, { candidate, movementRouteTemplates, report });
    }
    const materialization = await materialize({ candidatePath: stagedCandidate, expectedReleaseId: specification.infraReleaseId, outputPath: stagedOutput });
    invariant4(materialization.sourceBytes === candidateProof.bytes && materialization.sourceSha256 === candidateProof.sha256, "Materialisierung ist nicht an den abgeleiteten Candidate gebunden.");
    invariant4(materialization.stateHash === nativeReceipt.candidate.stateHash, "Ableitung und Materialisierung besitzen verschiedene Zustandshashes.");
    const outputProof = await fileProof2(stagedOutput, "Materialisiertes Operational-v2-Artefakt");
    invariant4(outputProof.bytes === materialization.bytes && outputProof.sha256 === materialization.sha256, "Materialisierungs-Receipt stimmt nicht mit den Ausgabe-Bytes ueberein.");
    await publishTogether([{ staged: stagedCandidate, final: candidate }, { staged: stagedMovementRouteTemplates, final: movementRouteTemplates }, { staged: stagedReport, final: report }, { staged: stagedOutput, final: output }]);
    return {
      ...nativeReceipt,
      reportStatus: { unresolvedRequired: nativeReport.unresolvedRequired, activationEligible: nativeReport.activationEligible, realInterlockingFactsClaimed: nativeReport.realInterlockingFactsClaimed },
      materialized: { bytes: outputProof.bytes, sha256: outputProof.sha256, stateHash: materialization.stateHash },
      movementRouteTemplates: { ...nativeReceipt.movementRouteTemplates },
      paths: { candidate, movementRouteTemplates, report, output }
    };
  } finally {
    if (!candidateTripletPublication.claimActive && !candidateTripletPublication.stagingRemoved) {
      const currentStaging = await maybeCandidateTripletMetadata(stagingRoot);
      if (currentStaging !== null) {
        invariant4(currentStaging.isDirectory() && !currentStaging.isSymbolicLink() && candidateTripletIdentityMatches(currentStaging, stagingRootIdentity), "Operational-v2-Stagingwurzel wurde fremd ersetzt und bleibt unangetastet.");
        await rm(stagingRoot, { recursive: true, force: true });
      }
    }
  }
}

// tools/region-import/germany/operational-infrastructure-v2-execution-pins.mjs
import { createHash as createHash5 } from "node:crypto";
import { spawnSync as spawnSync4 } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { link as link4, lstat as lstat5, mkdtemp as mkdtemp4, open as open5, readdir as readdir3, realpath as realpath4 } from "node:fs/promises";
import { basename as basename5, dirname as dirname5, isAbsolute as isAbsolute3, join as join4, relative as relative3, resolve as resolve5, sep as sep3 } from "node:path";
var GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA = "zugfolge-germany-operational-v2-execution-pins/v1";
var GERMANY_OPERATIONAL_EXECUTION_PROOF_SCHEMA = "zugfolge-germany-operational-v2-execution-proof/v1";
var GERMANY_OPERATIONAL_PROVENANCE_SCHEMA = "zugfolge-germany-operational-v2-provenance/v1";
var GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND = "integrated-runner-v1";
var GERMANY_OPERATIONAL_FORENSIC_PRODUCER_KIND = "forensic-stdin-v1";
var GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE = "held-direct-contract-windows-v1";
var GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA = "zugfolge-operational-v2-direct-system-launch-contract/v1";
var GERMANY_OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT = "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs";
var GERMANY_OPERATIONAL_EXECUTION_RUNNER_BUNDLE = "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs";
var GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE = "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1";
var GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE = "tools/region-import/germany/operational-windows-anchor-helper.dll";
var GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE = "tools/region-import/germany/operational-infrastructure-v2-system-launcher.linux.py";
var GERMANY_OPERATIONAL_RUNNER_INVOCATION_MODE = "system-launcher-held-bundle-stdin-v1";
var GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE = "windows-system-powershell-held-bundle-v1";
var GERMANY_OPERATIONAL_LINUX_LAUNCHER_MODE = "linux-system-python-held-bundle-v1";
var GERMANY_OPERATIONAL_RUNNER_PHASES = Object.freeze({
  "derive-and-capture-v1": 7,
  "execute-annual-operational-v2-v1": 8,
  "materialize-annual-plan-evidence-v1": 6,
  "materialize-validator-rebuild-v3": 3
});
var GERMANY_OPERATIONAL_REBUILD_AUTHORITY_ENVIRONMENT_KEYS = Object.freeze([
  "GITHUB_ACTIONS",
  "GITHUB_EVENT_NAME",
  "GITHUB_REF",
  "GITHUB_REF_PROTECTED",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_REF",
  "RUNNER_ARCH",
  "RUNNER_ENVIRONMENT",
  "RUNNER_OS",
  "ZUGFOLGE_REBUILD_RUNNER_IMAGE"
]);
var GERMANY_OPERATIONAL_ANNUAL_PLAN_TIMEOUT_MILLISECONDS = 12e4;
var GERMANY_OPERATIONAL_ANNUAL_RUN_TIMEOUT_MILLISECONDS = 216e5;
var GERMANY_OPERATIONAL_EXECUTION_RUNNER_ROOT_FILES = Object.freeze([
  "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs",
  "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
  GERMANY_OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT
]);
var SHA2564 = /^[a-f0-9]{64}$/u;
var GIT_COMMIT = /^[a-f0-9]{40}$/u;
var SAFE_COMMAND = /^[a-z0-9][a-z0-9-]*$/u;
var MAX_PINS_BYTES = 1024 * 1024;
var WINDOWS_TRUSTED_SYSTEM_ROOT = String.raw`C:\Windows`;
var WINDOWS_TRUSTED_CMD = String.raw`C:\Windows\System32\cmd.exe`;
var WINDOWS_TRUSTED_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
var COMMAND_ARGUMENTS = Object.freeze([
  "derive-germany-operational-v2",
  "{specification}",
  "{sourceRoot}",
  "{candidate}",
  "{report}"
]);
var WINDOWS_MITIGATED_PROCESS_CSHARP_SOURCE = String.raw`
public sealed class ZugfolgeMitigatedProcessResult
{
    public int ExitCode { get; private set; }
    public byte[] Stdout { get; private set; }
    public byte[] Stderr { get; private set; }

    internal ZugfolgeMitigatedProcessResult(int exitCode, byte[] stdout, byte[] stderr)
    {
        ExitCode = exitCode;
        Stdout = stdout;
        Stderr = stderr;
    }
}

public static class ZugfolgeMitigatedProcess
{
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_FAILED = 0xffffffff;
    private static readonly System.IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new System.IntPtr(0x00020002);
    private static readonly System.IntPtr PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY = new System.IntPtr(0x00020007);
    private const ulong IMAGE_LOAD_POLICY =
        (1UL << 44) | // BLOCK_NON_MICROSOFT_BINARIES_ALWAYS_ON
        (1UL << 52) | // IMAGE_LOAD_NO_REMOTE_ALWAYS_ON
        (1UL << 56) | // IMAGE_LOAD_NO_LOW_LABEL_ALWAYS_ON
        (1UL << 60);  // IMAGE_LOAD_PREFER_SYSTEM32_ALWAYS_ON

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public System.IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public System.IntPtr lpReserved2;
        public System.IntPtr hStdInput;
        public System.IntPtr hStdOutput;
        public System.IntPtr hStdError;
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public System.IntPtr lpAttributeList;
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public System.IntPtr hProcess;
        public System.IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool CreatePipe(out System.IntPtr hReadPipe, out System.IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(System.IntPtr hObject, uint dwMask, uint dwFlags);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(System.IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref System.IntPtr lpSize);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(System.IntPtr lpAttributeList, uint dwFlags, System.IntPtr attribute, System.IntPtr lpValue, System.IntPtr cbSize, System.IntPtr lpPreviousValue, System.IntPtr lpReturnSize);

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(System.IntPtr lpAttributeList);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        System.Text.StringBuilder lpCommandLine,
        System.IntPtr lpProcessAttributes,
        System.IntPtr lpThreadAttributes,
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] bool bInheritHandles,
        uint dwCreationFlags,
        System.IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(System.IntPtr hHandle, uint dwMilliseconds);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(System.IntPtr hProcess, out uint lpExitCode);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool TerminateProcess(System.IntPtr hProcess, uint uExitCode);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool CloseHandle(System.IntPtr hObject);

    private static System.ComponentModel.Win32Exception Win32(string action)
    {
        return new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error(), action);
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length == 0) return "\"\"";
        bool quoted = false;
        foreach (char character in value)
        {
            if (System.Char.IsWhiteSpace(character) || character == '\"') { quoted = true; break; }
        }
        if (!quoted) return value;
        System.Text.StringBuilder output = new System.Text.StringBuilder();
        output.Append('\"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes += 1; continue; }
            if (character == '\"')
            {
                output.Append('\\', backslashes * 2 + 1);
                output.Append('\"');
                backslashes = 0;
                continue;
            }
            output.Append('\\', backslashes);
            backslashes = 0;
            output.Append(character);
        }
        output.Append('\\', backslashes * 2);
        output.Append('\"');
        return output.ToString();
    }

    private static System.IntPtr EnvironmentBlock(System.Collections.IDictionary environment)
    {
        System.Collections.Generic.SortedDictionary<string, string> sorted =
            new System.Collections.Generic.SortedDictionary<string, string>(System.StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry entry in environment)
        {
            string key = entry.Key as string;
            string value = entry.Value as string;
            if (System.String.IsNullOrEmpty(key) || key.IndexOf('=') >= 0 || key.IndexOf('\0') >= 0 || value == null || value.IndexOf('\0') >= 0)
                throw new System.InvalidOperationException("Windows-Kindumgebung enthaelt einen ungueltigen Eintrag.");
            sorted.Add(key, value);
        }
        System.Text.StringBuilder block = new System.Text.StringBuilder();
        foreach (System.Collections.Generic.KeyValuePair<string, string> entry in sorted)
        {
            block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        }
        block.Append('\0');
        return System.Runtime.InteropServices.Marshal.StringToHGlobalUni(block.ToString());
    }

    private static void CreateRedirectPipe(bool parentReads, out System.IntPtr childHandle, out System.IntPtr parentHandle)
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = System.Runtime.InteropServices.Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = 1;
        System.IntPtr read;
        System.IntPtr write;
        if (!CreatePipe(out read, out write, ref attributes, 0)) throw Win32("CreatePipe");
        childHandle = parentReads ? write : read;
        parentHandle = parentReads ? read : write;
        if (!SetHandleInformation(parentHandle, HANDLE_FLAG_INHERIT, 0))
        {
            int error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
            CloseHandle(read);
            CloseHandle(write);
            childHandle = System.IntPtr.Zero;
            parentHandle = System.IntPtr.Zero;
            throw new System.ComponentModel.Win32Exception(error, "SetHandleInformation");
        }
    }

    private static byte[] ReadBounded(System.IO.Stream stream, int maximumBytes, System.IntPtr processHandle, string label)
    {
        using (System.IO.MemoryStream output = new System.IO.MemoryStream())
        {
            byte[] buffer = new byte[8192];
            while (true)
            {
                int read = stream.Read(buffer, 0, buffer.Length);
                if (read == 0) break;
                if (output.Length + read > maximumBytes)
                {
                    TerminateProcess(processHandle, 93);
                    throw new System.InvalidOperationException(label + " ueberschritt das gepinnte Limit.");
                }
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }
    }

    public static ZugfolgeMitigatedProcessResult Run(
        string executable,
        string[] arguments,
        string workingDirectory,
        System.Collections.IDictionary environment,
        byte[] standardInput,
        int maximumBytes)
    {
        if (!System.IO.Path.IsPathRooted(executable)) throw new System.InvalidOperationException("Windows-Kindpfad ist nicht absolut.");
        if (maximumBytes <= 0) throw new System.InvalidOperationException("Windows-Kindausgabelimit ist ungueltig.");
        if (arguments == null) arguments = new string[0];
        if (standardInput == null) standardInput = new byte[0];

        System.IntPtr childStdin = System.IntPtr.Zero;
        System.IntPtr parentStdin = System.IntPtr.Zero;
        System.IntPtr childStdout = System.IntPtr.Zero;
        System.IntPtr parentStdout = System.IntPtr.Zero;
        System.IntPtr childStderr = System.IntPtr.Zero;
        System.IntPtr parentStderr = System.IntPtr.Zero;
        System.IntPtr attributeList = System.IntPtr.Zero;
        System.IntPtr inheritedHandleList = System.IntPtr.Zero;
        System.IntPtr mitigation = System.IntPtr.Zero;
        System.IntPtr environmentBlock = System.IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool attributesInitialized = false;
        try
        {
            CreateRedirectPipe(false, out childStdin, out parentStdin);
            CreateRedirectPipe(true, out childStdout, out parentStdout);
            CreateRedirectPipe(true, out childStderr, out parentStderr);

            System.IntPtr attributeBytes = System.IntPtr.Zero;
            InitializeProcThreadAttributeList(System.IntPtr.Zero, 2, 0, ref attributeBytes);
            if (attributeBytes == System.IntPtr.Zero) throw Win32("InitializeProcThreadAttributeList(size)");
            attributeList = System.Runtime.InteropServices.Marshal.AllocHGlobal(attributeBytes);
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeBytes)) throw Win32("InitializeProcThreadAttributeList");
            attributesInitialized = true;
            inheritedHandleList = System.Runtime.InteropServices.Marshal.AllocHGlobal(System.IntPtr.Size * 3);
            System.Runtime.InteropServices.Marshal.WriteIntPtr(inheritedHandleList, 0 * System.IntPtr.Size, childStdin);
            System.Runtime.InteropServices.Marshal.WriteIntPtr(inheritedHandleList, 1 * System.IntPtr.Size, childStdout);
            System.Runtime.InteropServices.Marshal.WriteIntPtr(inheritedHandleList, 2 * System.IntPtr.Size, childStderr);
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inheritedHandleList, new System.IntPtr(System.IntPtr.Size * 3), System.IntPtr.Zero, System.IntPtr.Zero))
                throw Win32("UpdateProcThreadAttribute(HANDLE_LIST)");
            mitigation = System.Runtime.InteropServices.Marshal.AllocHGlobal(8);
            System.Runtime.InteropServices.Marshal.WriteInt64(mitigation, unchecked((long)IMAGE_LOAD_POLICY));
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, mitigation, new System.IntPtr(8), System.IntPtr.Zero, System.IntPtr.Zero))
                throw Win32("UpdateProcThreadAttribute(MITIGATION_POLICY)");

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = System.Runtime.InteropServices.Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = childStdin;
            startup.StartupInfo.hStdOutput = childStdout;
            startup.StartupInfo.hStdError = childStderr;
            startup.lpAttributeList = attributeList;

            System.Text.StringBuilder commandLine = new System.Text.StringBuilder(QuoteArgument(executable));
            foreach (string argument in arguments)
            {
                if (argument == null || argument.IndexOf('\0') >= 0) throw new System.InvalidOperationException("Windows-Kindargument ist ungueltig.");
                commandLine.Append(' ').Append(QuoteArgument(argument));
            }
            environmentBlock = EnvironmentBlock(environment);
            uint creationFlags = CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
            if (!CreateProcessW(executable, commandLine, System.IntPtr.Zero, System.IntPtr.Zero, true, creationFlags, environmentBlock, workingDirectory, ref startup, out process))
                throw Win32("CreateProcessW(mitigated)");

            CloseHandle(childStdin); childStdin = System.IntPtr.Zero;
            CloseHandle(childStdout); childStdout = System.IntPtr.Zero;
            CloseHandle(childStderr); childStderr = System.IntPtr.Zero;

            using (System.IO.FileStream input = new System.IO.FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(parentStdin, true), System.IO.FileAccess.Write, 4096, false))
            using (System.IO.FileStream output = new System.IO.FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(parentStdout, true), System.IO.FileAccess.Read, 4096, false))
            using (System.IO.FileStream error = new System.IO.FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(parentStderr, true), System.IO.FileAccess.Read, 4096, false))
            {
                parentStdin = System.IntPtr.Zero;
                parentStdout = System.IntPtr.Zero;
                parentStderr = System.IntPtr.Zero;
                System.Threading.Tasks.Task inputTask = System.Threading.Tasks.Task.Factory.StartNew(delegate {
                    if (standardInput.Length > 0) input.Write(standardInput, 0, standardInput.Length);
                    input.Close();
                }, System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
                System.Threading.Tasks.Task<byte[]> stdoutTask = System.Threading.Tasks.Task.Factory.StartNew(
                    delegate { return ReadBounded(output, maximumBytes, process.hProcess, "stdout"); },
                    System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
                System.Threading.Tasks.Task<byte[]> stderrTask = System.Threading.Tasks.Task.Factory.StartNew(
                    delegate { return ReadBounded(error, maximumBytes, process.hProcess, "stderr"); },
                    System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
                uint wait = WaitForSingleObject(process.hProcess, INFINITE);
                if (wait == WAIT_FAILED) throw Win32("WaitForSingleObject");
                System.Threading.Tasks.Task.WaitAll(inputTask, stdoutTask, stderrTask);
                uint exitCode;
                if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw Win32("GetExitCodeProcess");
                return new ZugfolgeMitigatedProcessResult(unchecked((int)exitCode), stdoutTask.Result, stderrTask.Result);
            }
        }
        finally
        {
            if (process.hThread != System.IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != System.IntPtr.Zero) CloseHandle(process.hProcess);
            if (childStdin != System.IntPtr.Zero) CloseHandle(childStdin);
            if (parentStdin != System.IntPtr.Zero) CloseHandle(parentStdin);
            if (childStdout != System.IntPtr.Zero) CloseHandle(childStdout);
            if (parentStdout != System.IntPtr.Zero) CloseHandle(parentStdout);
            if (childStderr != System.IntPtr.Zero) CloseHandle(childStderr);
            if (parentStderr != System.IntPtr.Zero) CloseHandle(parentStderr);
            if (environmentBlock != System.IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(environmentBlock);
            if (mitigation != System.IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(mitigation);
            if (inheritedHandleList != System.IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(inheritedHandleList);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributeList);
            if (attributeList != System.IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(attributeList);
        }
    }
}
`;
var MODULE_PARSER_CHILD_SOURCE = String.raw`
const { readFileSync } = require("node:fs");
const acorn = require("internal/deps/acorn/acorn/dist/acorn");
const tree = acorn.parse(readFileSync(0, "utf8"), {
  allowHashBang: true,
  ecmaVersion: "latest",
  sourceType: "module",
});
const staticSpecifiers = [];
const unsupportedLoaders = new Set();
const visited = new Set();
const nodes = [];
const propertyName = (node) => {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
};
const walk = (node) => {
  if (node === null || typeof node !== "object" || visited.has(node)) return;
  visited.add(node);
  nodes.push(node);
  if (node.type === "Identifier") {
    if (node.name === "require") unsupportedLoaders.add("commonjs-require");
    if (node.name === "createRequire") unsupportedLoaders.add("commonjs-create-require");
    if (node.name === "eval") unsupportedLoaders.add("runtime-eval");
    if (node.name === "Function") unsupportedLoaders.add("runtime-function-constructor");
    if (node.name === "getBuiltinModule") unsupportedLoaders.add("dynamic-builtin-module");
  }
  if (["ImportDeclaration", "ExportAllDeclaration", "ExportNamedDeclaration"].includes(node.type)
    && typeof node.source?.value === "string") staticSpecifiers.push(node.source.value);
  if (node.type === "ImportExpression") unsupportedLoaders.add("dynamic-import");
  if (node.type === "ImportDeclaration" && node.source?.value === "node:module") {
    unsupportedLoaders.add("node-module-loader-api");
    for (const specifier of node.specifiers) {
      if (specifier.type !== "ImportSpecifier" || propertyName(specifier.imported) === "createRequire") {
        unsupportedLoaders.add("commonjs-create-require");
      }
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
    } else {
      walk(value);
    }
  }
};
walk(tree);
for (const node of nodes) {
  if (node.type !== "CallExpression" && node.type !== "NewExpression") continue;
  const direct = propertyName(node.callee);
  const member = node.callee?.type === "MemberExpression" ? propertyName(node.callee.property) : null;
  if (direct === "require" || member === "require") unsupportedLoaders.add("commonjs-require");
  if (direct === "createRequire" || member === "createRequire") unsupportedLoaders.add("commonjs-create-require");
  if (direct === "eval" || member === "eval") unsupportedLoaders.add("runtime-eval");
  if (direct === "Function" || member === "Function") unsupportedLoaders.add("runtime-function-constructor");
  if (direct === "getBuiltinModule" || member === "getBuiltinModule") unsupportedLoaders.add("dynamic-builtin-module");
}
process.stdout.write(JSON.stringify({
  staticSpecifiers,
  unsupportedLoaders: [...unsupportedLoaders].sort(),
}) + "\n");
`;
var WINDOWS_HELD_BUNDLE_LAUNCH_POWERSHELL_SOURCE = String.raw`
$ErrorActionPreference = "Stop"
function Load-ZugfolgeMitigatedProcess([string]$EnvironmentPrefix) {
  if ($null -ne ("ZugfolgeMitigatedProcess" -as [type])) { throw "Windows-Anchor-Helper wurde vor der gehaltenen Bytepruefung vorgeladen." }
  $path = [Environment]::GetEnvironmentVariable($EnvironmentPrefix + "PATH", "Process")
  $bytesText = [Environment]::GetEnvironmentVariable($EnvironmentPrefix + "BYTES", "Process")
  $expectedSha256 = [Environment]::GetEnvironmentVariable($EnvironmentPrefix + "SHA256", "Process")
  if ([String]::IsNullOrEmpty($path) -or [String]::IsNullOrEmpty($bytesText) -or
      $expectedSha256 -cnotmatch "^[a-f0-9]{64}$") { throw "Windows-Anchor-Helper-Pin fehlt." }
  $expectedBytes = [Int32]::Parse($bytesText, [Globalization.CultureInfo]::InvariantCulture)
  if ($expectedBytes -le 0 -or $expectedBytes -gt 2097152) { throw "Windows-Anchor-Helper-Bytezahl ist ungueltig." }
  $handle = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($handle.Length -ne $expectedBytes) { throw "Gehaltene Windows-Anchor-Helper-Assembly besitzt eine falsche Bytezahl." }
    $bytes = New-Object byte[] $expectedBytes
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $handle.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -eq 0) { throw "Gehaltene Windows-Anchor-Helper-Assembly endete vorzeitig." }
      $offset += $count
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actualSha256 = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($actualSha256 -cne $expectedSha256) { throw "Gehaltene Windows-Anchor-Helper-Assembly besitzt einen falschen SHA-256." }
    $assembly = [Reflection.Assembly]::Load($bytes)
    if (-not [String]::IsNullOrEmpty($assembly.Location) -or
        $null -eq $assembly.GetType("ZugfolgeMitigatedProcess", $false, $false)) {
      throw "Windows-Anchor-Helper wurde nicht ausschliesslich aus den gehaltenen Bytes geladen."
    }
  } finally {
    $handle.Dispose()
  }
}
if ([Environment]::GetEnvironmentVariable("ZUGFOLGE_OPERATIONAL_LAUNCHER_PURPOSE") -eq "validator") {
  $prefix = "ZUGFOLGE_OPERATIONAL_ANCHOR_"
  function AnchorRequired([string]$name) {
    $value = [Environment]::GetEnvironmentVariable($prefix + $name)
    if ([String]::IsNullOrEmpty($value)) { throw "Fehlender Validator-Launcher-Wert $name." }
    return $value
  }
  function AnchorHex([byte[]]$value) {
    return ([BitConverter]::ToString($value)).Replace("-", "").ToLowerInvariant()
  }
  $heldValidator = $null
  $heldInputs = New-Object 'System.Collections.Generic.List[System.IO.FileStream]'
  $inputProofs = New-Object 'System.Collections.Generic.List[object]'
  try {
    Load-ZugfolgeMitigatedProcess "ZUGFOLGE_OPERATIONAL_ANCHOR_HELPER_"
    $executable = AnchorRequired "PATH"
    $workingDirectory = AnchorRequired "CWD"
    $expectedBytes = [Int64]::Parse((AnchorRequired "BYTES"), [Globalization.CultureInfo]::InvariantCulture)
    $expectedSha256 = AnchorRequired "SHA256"
    $maximumBytes = [Int32]::Parse((AnchorRequired "MAX_BYTES"), [Globalization.CultureInfo]::InvariantCulture)
    $timeoutMilliseconds = [Int32]::Parse((AnchorRequired "TIMEOUT_MILLISECONDS"), [Globalization.CultureInfo]::InvariantCulture)
    if ($timeoutMilliseconds -le 0 -or $timeoutMilliseconds -gt 21600000) { throw "Validator-Launcher besitzt keinen begrenzten Timeout." }
    $argumentCount = [Int32]::Parse((AnchorRequired "ARG_COUNT"), [Globalization.CultureInfo]::InvariantCulture)
    $inputCountText = [Environment]::GetEnvironmentVariable($prefix + "INPUT_COUNT")
    $inputCount = if ([String]::IsNullOrEmpty($inputCountText)) { 0 } else { [Int32]::Parse($inputCountText, [Globalization.CultureInfo]::InvariantCulture) }
    if ($inputCount -lt 0 -or $inputCount -gt 16) { throw "Validator-Launcher besitzt eine ungueltige Inputzahl." }
    $heldValidator = [IO.File]::Open($executable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($heldValidator.Length -ne $expectedBytes) { throw "Exklusiv gehaltener Validator besitzt eine falsche Bytezahl." }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $heldSha256 = AnchorHex ($sha.ComputeHash($heldValidator)) } finally { $sha.Dispose() }
    if ($heldSha256 -ne $expectedSha256) { throw "Exklusiv gehaltener Validator besitzt einen falschen SHA-256." }
    $arguments = New-Object string[] $argumentCount
    for ($index = 0; $index -lt $argumentCount; $index += 1) { $arguments[$index] = AnchorRequired "ARG_$index" }
    for ($index = 0; $index -lt $inputCount; $index += 1) {
      $inputFile = AnchorRequired "INPUT_$($index)_FILE"
      $inputPath = AnchorRequired "INPUT_$($index)_PATH"
      $inputBytes = [Int64]::Parse((AnchorRequired "INPUT_$($index)_BYTES"), [Globalization.CultureInfo]::InvariantCulture)
      $inputSha256 = AnchorRequired "INPUT_$($index)_SHA256"
      if ($inputBytes -le 0 -or $inputBytes -gt 16777216 -or $inputSha256 -cnotmatch "^[a-f0-9]{64}$") { throw "Validator-Launcher-Inputpin ist ungueltig." }
      $inputHandle = [IO.File]::Open($inputPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      if ($inputHandle.Length -ne $inputBytes) { $inputHandle.Dispose(); throw "Gehaltene Validator-Inputdatei besitzt eine falsche Bytezahl." }
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $actualInputSha256 = AnchorHex ($sha.ComputeHash($inputHandle)) } finally { $sha.Dispose() }
      if ($actualInputSha256 -cne $inputSha256) { $inputHandle.Dispose(); throw "Gehaltene Validator-Inputdatei besitzt einen falschen SHA-256." }
      $inputHandle.Position = 0
      $heldInputs.Add($inputHandle)
      $inputProofs.Add([ordered]@{ bytes = $inputBytes; file = $inputFile; sha256 = $actualInputSha256 })
    }
    $childEnvironment = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
      $name = [String]$entry.Key
      if (-not $name.StartsWith("ZUGFOLGE_OPERATIONAL_ANCHOR_", [StringComparison]::Ordinal) -and -not $name.StartsWith("ZUGFOLGE_OPERATIONAL_LAUNCHER_", [StringComparison]::Ordinal)) {
        $childEnvironment[$name] = [String]$entry.Value
      }
    }
    $child = [ZugfolgeMitigatedProcess]::RunStrict(
      $executable,
      $arguments,
      $workingDirectory,
      $childEnvironment,
      [byte[]]@(),
      $maximumBytes,
      $timeoutMilliseconds,
      $null)
    for ($index = 0; $index -lt $heldInputs.Count; $index += 1) {
      $inputHandle = $heldInputs[$index]
      $expectedInput = $inputProofs[$index]
      if ($inputHandle.Length -ne $expectedInput.bytes) { throw "Gehaltene Validator-Inputdatei driftete waehrend des Kindprozesses." }
      $inputHandle.Position = 0
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $afterInputSha256 = AnchorHex ($sha.ComputeHash($inputHandle)) } finally { $sha.Dispose() }
      if ($afterInputSha256 -cne $expectedInput.sha256) { throw "Gehaltene Validator-Inputdatei driftete waehrend des Kindprozesses." }
    }
    $envelope = [ordered]@{
      anchorBytes = $expectedBytes
      anchorSha256 = $heldSha256
      inputProofs = $inputProofs.ToArray()
      status = $child.ExitCode
      signal = $null
      stdoutBase64 = [Convert]::ToBase64String($child.Stdout)
      stderrBase64 = [Convert]::ToBase64String($child.Stderr)
    }
    [Console]::Out.Write(($envelope | ConvertTo-Json -Compress))
  } catch {
    [Console]::Error.Write($_.Exception.ToString())
    exit 91
  } finally {
    foreach ($inputHandle in $heldInputs) { $inputHandle.Dispose() }
    if ($null -ne $heldValidator) { $heldValidator.Dispose() }
  }
  exit 0
}
$prefix = "ZUGFOLGE_OPERATIONAL_RUNNER_"
function Required([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($prefix + $name)
  if ([String]::IsNullOrEmpty($value)) { throw "Fehlender Bundle-Launcher-Wert $name." }
  return $value
}
function Hex([byte[]]$value) {
  return ([BitConverter]::ToString($value)).Replace("-", "").ToLowerInvariant()
}
$heldBundle = $null
$heldNode = $null
$tempAnchor = $null
$privateTemp = $null
$child = $null
try {
  $bundlePath = Required "BUNDLE_PATH"
  $nodePath = Required "NODE_PATH"
  $workspaceRoot = Required "WORKSPACE_ROOT"
  $expectedBytes = [Int64]::Parse((Required "BUNDLE_BYTES"), [Globalization.CultureInfo]::InvariantCulture)
  $expectedSha256 = Required "BUNDLE_SHA256"
  $expectedNodeBytes = [Int64]::Parse((Required "NODE_BYTES"), [Globalization.CultureInfo]::InvariantCulture)
  $expectedNodeSha256 = Required "NODE_SHA256"
  $launcherMode = Required "LAUNCHER_MODE"
  $launcherSourceBytes = Required "LAUNCHER_SOURCE_BYTES"
  $launcherSourceSha256 = Required "LAUNCHER_SOURCE_SHA256"
  $annualLaunchProofBase64 = Required "ANNUAL_LAUNCH_PROOF_BASE64"
  $runnerPhase = Required "PHASE"
  if ($annualLaunchProofBase64.Length -le 0 -or $annualLaunchProofBase64.Length -gt 1048576 -or
      ($annualLaunchProofBase64.Length % 4) -ne 0 -or $annualLaunchProofBase64 -cnotmatch "^[A-Za-z0-9+/]*={0,2}$") {
    throw "Annual-Launch-Proof ist kein begrenztes kanonisches Base64."
  }
  $cliCount = [Int32]::Parse((Required "CLI_COUNT"), [Globalization.CultureInfo]::InvariantCulture)
  if (($runnerPhase -cne "derive-and-capture-v1" -or $cliCount -ne 7) -and
      ($runnerPhase -cne "execute-annual-operational-v2-v1" -or $cliCount -ne 8) -and
      ($runnerPhase -cne "materialize-annual-plan-evidence-v1" -or $cliCount -ne 6) -and
      ($runnerPhase -cne "materialize-validator-rebuild-v3" -or $cliCount -ne 3)) {
    throw "Operational-v2-Systemlauncher besitzt eine ungueltige interne Phase oder Argumentzahl."
  }
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
  $administratorsSid = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  $directorySecurity = New-Object Security.AccessControl.DirectorySecurity
  $directorySecurity.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $null = $directorySecurity.AddAccessRule($rule)
  }
  $privateTemp = [IO.Path]::Combine("C:\Windows\Temp", "zugfolge-operational-runner.retained-owned-cleanup-" + [Guid]::NewGuid().ToString("N"))
  if ([IO.Directory]::Exists($privateTemp)) { throw "Privates Launcher-Tempverzeichnis kollidiert." }
  $null = [IO.Directory]::CreateDirectory($privateTemp, $directorySecurity)
  if (([IO.File]::GetAttributes($privateTemp) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Privates Launcher-Tempverzeichnis ist ein Reparse Point." }
  $tempAnchorPath = [IO.Path]::Combine($privateTemp, "owner.anchor")
  $tempAnchorToken = [Guid]::NewGuid().ToString("N")
  $tempAnchorBytes = [Text.Encoding]::UTF8.GetBytes($tempAnchorToken)
  $tempAnchor = New-Object IO.FileStream($tempAnchorPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $tempAnchor.Write($tempAnchorBytes, 0, $tempAnchorBytes.Length)
  $tempAnchor.Flush($true)
  [Environment]::SetEnvironmentVariable("TEMP", $privateTemp, "Process")
  [Environment]::SetEnvironmentVariable("TMP", $privateTemp, "Process")
  Load-ZugfolgeMitigatedProcess "ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_"
  $heldBundle = [IO.File]::Open($bundlePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $heldNode = [IO.File]::Open($nodePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  if ($expectedBytes -le 0 -or $expectedBytes -gt 16777216 -or $heldBundle.Length -ne $expectedBytes) { throw "Gehaltenes Runner-Bundle besitzt eine falsche Bytezahl." }
  $bundle = New-Object byte[] ([Int32]$expectedBytes)
  $offset = 0
  while ($offset -lt $bundle.Length) {
    $count = $heldBundle.Read($bundle, $offset, $bundle.Length - $offset)
    if ($count -eq 0) { throw "Gehaltenes Runner-Bundle endete vorzeitig." }
    $offset += $count
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $actualSha256 = Hex ($sha.ComputeHash($bundle)) } finally { $sha.Dispose() }
  if ($actualSha256 -ne $expectedSha256) { throw "Gehaltenes Runner-Bundle besitzt einen falschen SHA-256." }
  if ($expectedNodeBytes -le 0 -or $heldNode.Length -ne $expectedNodeBytes) { throw "Gehaltene Node-Runtime besitzt eine falsche Bytezahl." }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $actualNodeSha256 = Hex ($sha.ComputeHash($heldNode)) } finally { $sha.Dispose() }
  if ($actualNodeSha256 -ne $expectedNodeSha256) { throw "Gehaltene Node-Runtime besitzt einen falschen SHA-256." }

  $versionEnvironment = @{
    SystemRoot = "C:\Windows"
    WINDIR = "C:\Windows"
    PATH = "C:\Windows\System32;C:\Windows"
    TEMP = $privateTemp
    TMP = $privateTemp
  }
  $versionChild = [ZugfolgeMitigatedProcess]::RunStrict(
    $nodePath,
    [string[]]@("--version"),
    $workspaceRoot,
    $versionEnvironment,
    [byte[]]@(),
    65536,
    15000,
    $null)
  $versionOutput = [Text.Encoding]::UTF8.GetString($versionChild.Stdout)
  $versionError = [Text.Encoding]::UTF8.GetString($versionChild.Stderr)
  if ($versionChild.ExitCode -ne 0 -or $versionOutput -notmatch '^v24\.[0-9]+\.[0-9]+(?:-|\s*$)') {
    throw "Gehaltene Node-Runtime ist nicht Node 24: $versionOutput $versionError"
  }

  $childEnvironment = @{
    SystemRoot = "C:\Windows"
    WINDIR = "C:\Windows"
    ComSpec = "C:\Windows\System32\cmd.exe"
    PATH = "C:\Windows\System32;C:\Windows"
    PATHEXT = ".COM;.EXE;.BAT;.CMD"
    TEMP = $privateTemp
    TMP = $privateTemp
    ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE = $launcherMode
    ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_BYTES = $launcherSourceBytes
    ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_SHA256 = $launcherSourceSha256
    ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_BYTES = [String]$expectedBytes
    ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SHA256 = $actualSha256
    ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SOURCE_PATH = $bundlePath
    ZUGFOLGE_OPERATIONAL_RUNNER_NODE_BYTES = [String]$expectedNodeBytes
    ZUGFOLGE_OPERATIONAL_RUNNER_NODE_SHA256 = $actualNodeSha256
    ZUGFOLGE_OPERATIONAL_RUNNER_NODE_PATH = $nodePath
    ZUGFOLGE_OPERATIONAL_RUNNER_NODE_REEXEC_PATH = $nodePath
    ZUGFOLGE_OPERATIONAL_RUNNER_RUNTIME_SOURCE_PATH = $nodePath
    ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_PATH = (Required "ANCHOR_HELPER_PATH")
    ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_BYTES = (Required "ANCHOR_HELPER_BYTES")
    ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_SHA256 = (Required "ANCHOR_HELPER_SHA256")
    ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT = $workspaceRoot
    ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT = [String]$cliCount
    ZUGFOLGE_OPERATIONAL_RUNNER_ANNUAL_LAUNCH_PROOF_BASE64 = $annualLaunchProofBase64
    ZUGFOLGE_OPERATIONAL_RUNNER_PHASE = $runnerPhase
  }
  if ($runnerPhase -ceq "materialize-validator-rebuild-v3") {
    foreach ($name in @(
      "GITHUB_ACTIONS",
      "GITHUB_EVENT_NAME",
      "GITHUB_REF",
      "GITHUB_REF_PROTECTED",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
      "GITHUB_SHA",
      "GITHUB_WORKFLOW_REF",
      "RUNNER_ARCH",
      "RUNNER_ENVIRONMENT",
      "RUNNER_OS",
      "ZUGFOLGE_REBUILD_RUNNER_IMAGE"
    )) {
      $childEnvironment[$name] = Required ("AUTHORITY_" + $name)
    }
  }
  for ($index = 0; $index -lt $cliCount; $index += 1) {
    $childEnvironment["ZUGFOLGE_OPERATIONAL_RUNNER_CLI_$index"] = Required "CLI_$index"
  }
  $child = [ZugfolgeMitigatedProcess]::RunStrict(
    $nodePath,
    [string[]]@("--input-type=module", "-"),
    $workspaceRoot,
    $childEnvironment,
    $bundle,
    1048576,
    43200000,
    $null)
  $childExitCode = $child.ExitCode
  if (([IO.File]::GetAttributes($privateTemp) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Privates Launcher-Tempverzeichnis driftete zu einem Reparse Point." }
  $tempAnchor.Position = 0
  $verifiedTempAnchor = New-Object byte[] $tempAnchorBytes.Length
  if ($tempAnchor.Read($verifiedTempAnchor, 0, $verifiedTempAnchor.Length) -ne $verifiedTempAnchor.Length -or (Hex $verifiedTempAnchor) -ne (Hex $tempAnchorBytes)) {
    throw "Privater Launcher-Tempanker driftete."
  }
  $retainedTempEntries = [IO.Directory]::GetFileSystemEntries($privateTemp)
  if ($retainedTempEntries.Count -ne 1 -or $retainedTempEntries[0] -ne $tempAnchorPath) {
    throw "Privates Launcher-Tempverzeichnis enthaelt fremde Dateien und bleibt erhalten."
  }
  $envelope = [ordered]@{
    anchorBytes = $expectedBytes
    anchorSha256 = $actualSha256
    status = $childExitCode
    signal = $null
    stdoutBase64 = [Convert]::ToBase64String($child.Stdout)
    stderrBase64 = [Convert]::ToBase64String($child.Stderr)
  }
  [Console]::Out.Write(($envelope | ConvertTo-Json -Compress))
  if ($childExitCode -ne 0) { exit 94 }
} catch {
  [Console]::Error.Write($_.Exception.ToString())
  exit 92
} finally {
  if ($null -ne $tempAnchor) { $tempAnchor.Dispose() }
  if ($null -ne $heldNode) { $heldNode.Dispose() }
  if ($null -ne $heldBundle) { $heldBundle.Dispose() }
}
`;
var LINUX_HELD_BUNDLE_LAUNCHER_SOURCE = String.raw`
import base64
import fcntl
import hashlib
import json
import os
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import traceback

temp_anchor_fd = None
private_temp = None
child = None
RUNNER_TIMEOUT_SECONDS = 21600
try:
    node_path, node_bytes_text, node_sha256, bundle_path, expected_bytes_text, expected_sha256, launcher_mode, launcher_source_bytes, launcher_source_sha256, workspace_root, *arguments = sys.argv[1:]
    expected_bytes = int(expected_bytes_text)
    expected_node_bytes = int(node_bytes_text)
    private_temp = tempfile.mkdtemp(prefix="zugfolge-operational-runner.retained-owned-cleanup-", dir="/tmp")
    os.chmod(private_temp, 0o700)
    private_temp_before = os.lstat(private_temp)
    if not stat.S_ISDIR(private_temp_before.st_mode) or stat.S_ISLNK(private_temp_before.st_mode):
        raise RuntimeError("Privates Launcher-Tempverzeichnis ist kein eigener regulaerer Verzeichnisroot.")
    temp_anchor_path = os.path.join(private_temp, "owner.anchor")
    temp_anchor_token = os.urandom(32)
    temp_anchor_fd = os.open(temp_anchor_path, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    os.write(temp_anchor_fd, temp_anchor_token)
    os.fsync(temp_anchor_fd)
    temp_anchor_identity = os.fstat(temp_anchor_fd)
    descriptor = os.open(bundle_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    node_descriptor = os.open(node_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size != expected_bytes or expected_bytes <= 0 or expected_bytes > 16777216:
            raise RuntimeError("Gehaltenes Runner-Bundle besitzt eine falsche Bytezahl.")
        chunks = []
        remaining = expected_bytes
        while remaining:
            chunk = os.read(descriptor, min(1048576, remaining))
            if not chunk:
                raise RuntimeError("Gehaltenes Runner-Bundle endete vorzeitig.")
            chunks.append(chunk)
            remaining -= len(chunk)
        bundle = b"".join(chunks)
        actual_sha256 = hashlib.sha256(bundle).hexdigest()
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size) or actual_sha256 != expected_sha256:
            raise RuntimeError("Gehaltenes Runner-Bundle driftete oder besitzt einen falschen SHA-256.")
        node_before = os.fstat(node_descriptor)
        if not stat.S_ISREG(node_before.st_mode) or node_before.st_size != expected_node_bytes or expected_node_bytes <= 0:
            raise RuntimeError("Gehaltene Node-Runtime besitzt eine falsche Bytezahl.")
        node_hash = hashlib.sha256()
        node_chunks = []
        while True:
            chunk = os.read(node_descriptor, 1048576)
            if not chunk:
                break
            node_chunks.append(chunk)
            node_hash.update(chunk)
        node_after = os.fstat(node_descriptor)
        if (node_before.st_dev, node_before.st_ino, node_before.st_size) != (node_after.st_dev, node_after.st_ino, node_after.st_size) or node_hash.hexdigest() != node_sha256:
            raise RuntimeError("Gehaltene Node-Runtime driftete oder besitzt einen falschen SHA-256.")
        node_bytes = b"".join(node_chunks)
        runtime_fd = os.memfd_create("zugfolge-operational-node", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        position = 0
        while position < len(node_bytes):
            position += os.write(runtime_fd, node_bytes[position:])
        os.fchmod(runtime_fd, 0o500)
        runtime_seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(runtime_fd, fcntl.F_ADD_SEALS, runtime_seals)
        if fcntl.fcntl(runtime_fd, fcntl.F_GET_SEALS) != runtime_seals:
            raise RuntimeError("Node-Runtime-memfd wurde nicht vollstaendig versiegelt.")
        executable_node = "/proc/self/fd/" + str(runtime_fd)
        reexec_node = "/proc/" + str(os.getpid()) + "/fd/" + str(runtime_fd)
        probe = subprocess.run(
            [executable_node, "--version"],
            executable=executable_node,
            cwd=workspace_root,
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "TMPDIR": private_temp},
            pass_fds=(runtime_fd,),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )
        version = probe.stdout.decode("ascii", "strict").strip()
        version_parts = version.removeprefix("v").split(".")
        if probe.returncode != 0 or len(version_parts) != 3 or version_parts[0] != "24" or not all(part.split("-", 1)[0].isdigit() for part in version_parts):
            raise RuntimeError("Gehaltene Node-Runtime ist nicht Node 24.")
        environment = {
            "PATH": "/usr/bin:/bin",
            "LANG": "C",
            "LC_ALL": "C",
            "TMPDIR": private_temp,
            "ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE": launcher_mode,
            "ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_BYTES": launcher_source_bytes,
            "ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_SHA256": launcher_source_sha256,
            "ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_BYTES": str(expected_bytes),
            "ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SHA256": actual_sha256,
            "ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SOURCE_PATH": bundle_path,
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_BYTES": str(expected_node_bytes),
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_SHA256": node_sha256,
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_PATH": executable_node,
            "ZUGFOLGE_OPERATIONAL_RUNNER_NODE_REEXEC_PATH": reexec_node,
            "ZUGFOLGE_OPERATIONAL_RUNNER_RUNTIME_SOURCE_PATH": node_path,
            "ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT": workspace_root,
            "ZUGFOLGE_OPERATIONAL_RUNNER_PHASE": "derive-and-capture-v1",
            "ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT": str(len(arguments)),
        }
        for index, argument in enumerate(arguments):
            environment["ZUGFOLGE_OPERATIONAL_RUNNER_CLI_" + str(index)] = argument
        child = subprocess.Popen(
            [executable_node, "--input-type=module", "-"],
            executable=executable_node,
            cwd=workspace_root,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(runtime_fd,),
            start_new_session=True,
        )
        streams = {child.stdout: bytearray(), child.stderr: bytearray()}
        selector = selectors.DefaultSelector()
        selector.register(child.stdin, selectors.EVENT_WRITE)
        selector.register(child.stdout, selectors.EVENT_READ)
        selector.register(child.stderr, selectors.EVENT_READ)
        written = 0
        deadline = time.monotonic() + RUNNER_TIMEOUT_SECONDS
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                raise RuntimeError("Bundle-Node-Prozess ueberschritt das gepinnte Zeitlimit.")
            for key, mask in selector.select(min(1.0, remaining)):
                stream = key.fileobj
                if stream is child.stdin:
                    try:
                        count = os.write(stream.fileno(), bundle[written:written + 65536])
                        written += count
                    except BrokenPipeError:
                        written = len(bundle)
                    if written == len(bundle):
                        selector.unregister(stream)
                        stream.close()
                    continue
                chunk = os.read(stream.fileno(), 8192)
                if not chunk:
                    selector.unregister(stream)
                    continue
                target = streams[stream]
                if len(target) + len(chunk) > 1048576:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    raise RuntimeError("Bundle-Node-Prozess ueberschritt das stdout/stderr-Limit.")
                target.extend(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise RuntimeError("Bundle-Node-Prozess ueberschritt das gepinnte Zeitlimit.")
        try:
            returncode = child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise RuntimeError("Bundle-Node-Prozess ueberschritt das gepinnte Zeitlimit.")
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        private_temp_after = os.lstat(private_temp)
        anchor_path_after = os.stat(temp_anchor_path, follow_symlinks=False)
        anchor_handle_after = os.fstat(temp_anchor_fd)
        if ((private_temp_before.st_dev, private_temp_before.st_ino) != (private_temp_after.st_dev, private_temp_after.st_ino)
                or not stat.S_ISDIR(private_temp_after.st_mode) or stat.S_ISLNK(private_temp_after.st_mode)
                or (temp_anchor_identity.st_dev, temp_anchor_identity.st_ino, temp_anchor_identity.st_size) != (anchor_path_after.st_dev, anchor_path_after.st_ino, anchor_path_after.st_size)
                or (temp_anchor_identity.st_dev, temp_anchor_identity.st_ino, temp_anchor_identity.st_size) != (anchor_handle_after.st_dev, anchor_handle_after.st_ino, anchor_handle_after.st_size)):
            raise RuntimeError("Privater Launcher-Temp-Root oder Ownership-Anker driftete und bleibt erhalten.")
        os.lseek(temp_anchor_fd, 0, os.SEEK_SET)
        if os.read(temp_anchor_fd, len(temp_anchor_token) + 1) != temp_anchor_token:
            raise RuntimeError("Privater Launcher-Tempanker driftete und bleibt erhalten.")
        if os.listdir(private_temp) != ["owner.anchor"]:
            raise RuntimeError("Privates Launcher-Tempverzeichnis enthaelt fremde Dateien und bleibt erhalten.")
        envelope = {
            "anchorBytes": expected_bytes,
            "anchorSha256": actual_sha256,
            "status": returncode if returncode >= 0 else None,
            "signal": -returncode if returncode < 0 else None,
            "stdoutBase64": base64.b64encode(bytes(streams[child.stdout])).decode("ascii"),
            "stderrBase64": base64.b64encode(bytes(streams[child.stderr])).decode("ascii"),
        }
        sys.stdout.write(json.dumps(envelope, separators=(",", ":"), sort_keys=True))
        os.close(runtime_fd)
        if returncode != 0:
            sys.exit(94 if returncode >= 0 else 128 - returncode)
    finally:
        os.close(node_descriptor)
        os.close(descriptor)
except Exception:
    if child is not None and child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        except Exception:
            pass
    traceback.print_exc(file=sys.stderr)
    sys.exit(93)
finally:
    if temp_anchor_fd is not None:
        os.close(temp_anchor_fd)
`;
var LINUX_SEALED_MEMFD_LAUNCHER_SOURCE = String.raw`
import base64
import fcntl
import hashlib
import json
import os
import selectors
import signal
import subprocess
import sys
import time
import traceback

VALIDATOR_TIMEOUT_SECONDS = 21600
child = None
outer_session_bound = False
try:
    header = sys.stdin.buffer.readline()
    request = json.loads(header.decode("utf-8"))
    binary = sys.stdin.buffer.read()
    expected_bytes = request["bytes"]
    expected_sha256 = request["sha256"]
    maximum_bytes = request["maximumBytes"]
    arguments = request["arguments"]
    outer_session_bound = request["outerSessionBound"]
    if len(binary) != expected_bytes or hashlib.sha256(binary).hexdigest() != expected_sha256:
        raise RuntimeError("Memfd-Launcher erhielt andere Validatorbytes als gepinnt.")
    if not isinstance(arguments, list) or not all(isinstance(value, str) for value in arguments) or not isinstance(outer_session_bound, bool):
        raise RuntimeError("Memfd-Launcher erhielt ungueltige Argumente.")
    fd = os.memfd_create("zugfolge-operational-validator", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        position = 0
        while position < len(binary):
            position += os.write(fd, binary[position:])
        os.fchmod(fd, 0o500)
        seal_mask = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seal_mask)
        if fcntl.fcntl(fd, fcntl.F_GET_SEALS) != seal_mask:
            raise RuntimeError("Memfd-Launcher konnte die Validatorbytes nicht vollstaendig versiegeln.")
        executable = "/proc/self/fd/" + str(fd)
        child = subprocess.Popen(
            [executable, *arguments],
            executable=executable,
            cwd=request["cwd"],
            env={key: value for key, value in os.environ.items() if not key.startswith("ZUGFOLGE_OPERATIONAL_MEMFD_")},
            pass_fds=(fd,),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # In the eligible outer runner, remain in its one owned session.
            # Standalone diagnostics own a separate child session instead.
            start_new_session=not outer_session_bound,
        )
        streams = {child.stdout: bytearray(), child.stderr: bytearray()}
        selector = selectors.DefaultSelector()
        for stream in streams:
            selector.register(stream, selectors.EVENT_READ)
        deadline = time.monotonic() + VALIDATOR_TIMEOUT_SECONDS
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                os.killpg(os.getpgrp() if outer_session_bound else child.pid, signal.SIGKILL)
                if not outer_session_bound:
                    child.wait()
                raise RuntimeError("Memfd-Validator ueberschritt das gepinnte Zeitlimit.")
            for key, _ in selector.select(min(1.0, remaining)):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                target = streams[key.fileobj]
                if len(target) + len(chunk) > maximum_bytes:
                    os.killpg(os.getpgrp() if outer_session_bound else child.pid, signal.SIGKILL)
                    if not outer_session_bound:
                        child.wait()
                    raise RuntimeError("Memfd-Validator ueberschritt das gepinnte stdout/stderr-Limit.")
                target.extend(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            os.killpg(os.getpgrp() if outer_session_bound else child.pid, signal.SIGKILL)
            if not outer_session_bound:
                child.wait()
            raise RuntimeError("Memfd-Validator ueberschritt das gepinnte Zeitlimit.")
        try:
            returncode = child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgrp() if outer_session_bound else child.pid, signal.SIGKILL)
            if not outer_session_bound:
                child.wait()
            raise RuntimeError("Memfd-Validator ueberschritt das gepinnte Zeitlimit.")
        envelope = {
            "anchorBytes": expected_bytes,
            "anchorSha256": expected_sha256,
            "sealMask": seal_mask,
            "status": returncode if returncode >= 0 else None,
            "signal": -returncode if returncode < 0 else None,
            "stdoutBase64": base64.b64encode(bytes(streams[child.stdout])).decode("ascii"),
            "stderrBase64": base64.b64encode(bytes(streams[child.stderr])).decode("ascii"),
        }
        sys.stdout.write(json.dumps(envelope, separators=(",", ":"), sort_keys=True))
    finally:
        os.close(fd)
except Exception:
    if child is not None:
        try:
            os.killpg(os.getpgrp() if outer_session_bound else child.pid, signal.SIGKILL)
            if not outer_session_bound:
                child.wait()
        except Exception:
            pass
    traceback.print_exc(file=sys.stderr)
    sys.exit(92)
`;
function germanyOperationalSystemLauncherSourceProof(platform) {
  const source = germanyOperationalSystemLauncherSource(platform);
  const bytes = Buffer.from(source, "utf8");
  return {
    mode: platform === "win32" ? GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE : GERMANY_OPERATIONAL_LINUX_LAUNCHER_MODE,
    sourceBytes: bytes.length,
    sourceSha256: createHash5("sha256").update(bytes).digest("hex")
  };
}
function germanyOperationalSystemLauncherSource(platform) {
  const source = platform === "win32" ? WINDOWS_HELD_BUNDLE_LAUNCH_POWERSHELL_SOURCE : platform === "linux" ? LINUX_HELD_BUNDLE_LAUNCHER_SOURCE : null;
  invariant5(source !== null, `Operational-v2 besitzt fuer ${platform} keinen Systemlauncher.`);
  return source;
}
function invariant5(condition, message) {
  if (!condition) throw new Error(message);
}
function isRecord3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys3(value, expected, label) {
  invariant5(isRecord3(value), `${label} muss ein Objekt sein.`);
  invariant5(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} besitzt fremde oder fehlende Felder.`
  );
  return value;
}
function positiveInteger(value, label) {
  invariant5(Number.isSafeInteger(value) && value > 0, `${label} muss eine positive sichere Ganzzahl sein.`);
  return value;
}
function sha2562(value, label) {
  invariant5(typeof value === "string" && SHA2564.test(value), `${label} ist kein SHA-256.`);
  return value;
}
function gitCommit(value, label) {
  invariant5(typeof value === "string" && GIT_COMMIT.test(value), `${label} ist kein Git-Commit.`);
  return value;
}
function portablePath(value, label) {
  invariant5(typeof value === "string" && value.length > 0 && value.length <= 512, `${label} fehlt oder ist zu lang.`);
  invariant5(!isAbsolute3(value) && !value.includes("\\") && !value.includes("\0"), `${label} muss ein portabler relativer Pfad sein.`);
  const segments = value.split("/");
  invariant5(segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."), `${label} enthaelt unsichere Segmente.`);
  return value;
}
function stringList(value, label, { portable: portable3 = false } = {}) {
  invariant5(Array.isArray(value), `${label} muss eine Liste sein.`);
  return value.map((entry, index) => {
    invariant5(typeof entry === "string" && entry.length > 0 && entry.length <= 1024 && !entry.includes("\0"), `${label}[${index}] ist ungueltig.`);
    return portable3 ? portablePath(entry, `${label}[${index}]`) : entry;
  });
}
function canonicalValue3(value) {
  if (Array.isArray(value)) return value.map(canonicalValue3);
  if (!isRecord3(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue3(value[key])]));
}
function canonicalBytes2(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue3(value))}
`, "utf8");
}
function germanyOperationalStructuredValueSha256(value) {
  return createHash5("sha256").update(canonicalBytes2(value)).digest("hex");
}
function fileProof3(value, label, { schema = false } = {}) {
  exactKeys3(value, schema ? ["file", "bytes", "sha256", "schema"] : ["file", "bytes", "sha256"], label);
  portablePath(value.file, `${label}.file`);
  positiveInteger(value.bytes, `${label}.bytes`);
  sha2562(value.sha256, `${label}.sha256`);
  if (schema) invariant5(typeof value.schema === "string" && value.schema.length > 0, `${label}.schema fehlt.`);
  return value;
}
function runtimeProof(value, label) {
  exactKeys3(value, ["id", "platform", "bytes", "sha256"], label);
  invariant5(value.id === "nodejs-24-operational-runner-v1", `${label}.id ist unbekannt.`);
  invariant5(value.platform === "win32" || value.platform === "linux", `${label}.platform ist nicht unterstuetzt.`);
  positiveInteger(value.bytes, `${label}.bytes`);
  sha2562(value.sha256, `${label}.sha256`);
  return value;
}
function launcherProof(value, label, platform) {
  exactKeys3(value, ["mode", "sourceBytes", "sourceSha256"], label);
  invariant5(value.mode === GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE || value.mode === GERMANY_OPERATIONAL_LINUX_LAUNCHER_MODE, `${label}.mode ist unbekannt.`);
  positiveInteger(value.sourceBytes, `${label}.sourceBytes`);
  sha2562(value.sourceSha256, `${label}.sourceSha256`);
  if (platform !== void 0) {
    invariant5(
      sameCanonical(value, germanyOperationalSystemLauncherSourceProof(platform)),
      `${label} bindet nicht exakt den kanonischen ${platform}-Systemlauncher.`
    );
  }
  return value;
}
function sameCanonical(left, right) {
  return JSON.stringify(canonicalValue3(left)) === JSON.stringify(canonicalValue3(right));
}
function canonicalJsonBase64(value, label, maximumBytes = 1024 * 1024) {
  invariant5(typeof value === "string" && value.length > 0 && value.length <= Math.ceil(maximumBytes * 4 / 3) + 4 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value), `${label} ist kein begrenztes Base64.`);
  const bytes = Buffer.from(value, "base64");
  invariant5(
    bytes.length > 0 && bytes.length <= maximumBytes && bytes.toString("base64") === value,
    `${label} ist nicht kanonisch Base64-kodiert.`
  );
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges UTF-8.`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON.`, { cause: error });
  }
  invariant5(JSON.stringify(canonicalValue3(parsed)) === text, `${label} ist kein kanonisches JSON.`);
  return parsed;
}
function validateAnnualLaunchProof(value, label = "Operational-v2-Annual-Launch-Proof") {
  exactKeys3(value, ["contract", "executionPins", "mode", "trustedExecutor"], label);
  invariant5(value.mode === GERMANY_OPERATIONAL_ANNUAL_LAUNCH_MODE, `${label}.mode ist unbekannt.`);
  exactKeys3(value.contract, ["bytes", "file", "releaseId", "schema", "sha256"], `${label}.contract`);
  portablePath(value.contract.file, `${label}.contract.file`);
  positiveInteger(value.contract.bytes, `${label}.contract.bytes`);
  sha2562(value.contract.sha256, `${label}.contract.sha256`);
  invariant5(
    value.contract.schema === GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA,
    `${label}.contract.schema ist unbekannt.`
  );
  invariant5(
    typeof value.contract.releaseId === "string" && value.contract.releaseId.length > 0,
    `${label}.contract.releaseId fehlt.`
  );
  exactKeys3(value.executionPins, ["bytes", "file", "schema", "sha256"], `${label}.executionPins`);
  fileProof3(value.executionPins, `${label}.executionPins`, { schema: true });
  invariant5(
    value.executionPins.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
    `${label}.executionPins.schema ist unbekannt.`
  );
  exactKeys3(value.trustedExecutor, ["buildCommit", "bytes", "file", "sha256"], `${label}.trustedExecutor`);
  portablePath(value.trustedExecutor.file, `${label}.trustedExecutor.file`);
  positiveInteger(value.trustedExecutor.bytes, `${label}.trustedExecutor.bytes`);
  sha2562(value.trustedExecutor.sha256, `${label}.trustedExecutor.sha256`);
  gitCommit(value.trustedExecutor.buildCommit, `${label}.trustedExecutor.buildCommit`);
  return value;
}
function validateSortedUniqueFileProofs(value, label) {
  invariant5(Array.isArray(value) && value.length > 0, `${label} muss eine nichtleere Liste sein.`);
  const proofs = value.map((entry, index) => fileProof3(entry, `${label}[${index}]`));
  const paths = proofs.map(({ file }) => file);
  invariant5(new Set(paths).size === paths.length, `${label} enthaelt doppelte Pfade.`);
  invariant5(paths.every((entry, index) => index === 0 || paths[index - 1].localeCompare(entry, "en") < 0), `${label} muss stabil sortiert sein.`);
  return proofs;
}
function validateRunnerInvocation(value, label) {
  exactKeys3(value, ["mode", "nodeArguments", "nodeOptions"], label);
  invariant5(value.mode === GERMANY_OPERATIONAL_RUNNER_INVOCATION_MODE, `${label}.mode ist unbekannt.`);
  const nodeArguments = stringList(value.nodeArguments, `${label}.nodeArguments`);
  invariant5(sameCanonical(nodeArguments, ["--input-type=module", "-"]), `${label}.nodeArguments startet nicht exakt ein ESM-stdin-Bundle.`);
  invariant5(value.nodeOptions === null, `${label}.nodeOptions muss fuer v1 null sein.`);
  return value;
}
function synchronousRuntimeByteProof(path, label) {
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    invariant5(
      before.isFile() && before.size > 0n && before.size <= BigInt(256 * 1024 * 1024),
      `${label} ist keine begrenzte regulaere Datei.`
    );
    const digest = createHash5("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, bytes);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    invariant5(
      sameNodeIdentity(before, after) && BigInt(bytes) === after.size,
      `${label} driftete waehrend der Selbstpruefung.`
    );
    return { bytes, sha256: digest.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}
function currentRuntimeByteProof() {
  return synchronousRuntimeByteProof(
    process.platform === "linux" ? "/proc/self/exe" : process.execPath,
    "Operational-v2-Runner-Node-Runtime"
  );
}
function operationalNodeReexecPath() {
  if (process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE === void 0) return process.execPath;
  const path = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_REEXEC_PATH;
  invariant5(typeof path === "string" && path.length > 0, "Operational-v2-Systemlauncher besitzt keinen gehaltenen Node-Reexec-Anker.");
  return path;
}
function currentRunnerInvocation(pins) {
  invariant5(
    /^24\.[0-9]+\.[0-9]+(?:-|$)/u.test(process.versions.node),
    "Operational-v2-Runner-Runtime ist nicht die vertraglich festgelegte Node-24-Hauptversion."
  );
  const nodeOptions = process.env.NODE_OPTIONS;
  invariant5(nodeOptions === void 0 || nodeOptions.trim() === "", "Operational-v2-Runner darf NODE_OPTIONS nicht verwenden.");
  invariant5(sameCanonical(process.execArgv, ["--input-type=module"]), "Operational-v2-Runner muss als bereinigtes Node-ESM-stdin-Bundle ohne Loader oder Preloads starten.");
  invariant5(process.argv[1] === "-", "Operational-v2-Runner muss seine exakt gehaltenen Bundle-Bytes ueber stdin ausfuehren.");
  invariant5(process.argv.length === 2, "Operational-v2-Runner darf keine ungepinnten Node-Argumente besitzen.");
  invariant5(
    process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE === pins.runner.launcher.mode && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_BYTES === String(pins.runner.launcher.sourceBytes) && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_SHA256 === pins.runner.launcher.sourceSha256,
    "Operational-v2-Runner besitzt nicht den gepinnten systemgeschuetzten OS-Startanker."
  );
  const phase2 = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_PHASE;
  invariant5(
    typeof phase2 === "string" && Object.hasOwn(GERMANY_OPERATIONAL_RUNNER_PHASES, phase2) && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT === String(GERMANY_OPERATIONAL_RUNNER_PHASES[phase2]),
    "Operational-v2-Runner besitzt keine bekannte intern gebundene Phase und Argumentzahl."
  );
  invariant5(
    process.env.ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_BYTES === String(pins.runner.bundle.bytes) && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SHA256 === pins.runner.bundle.sha256,
    "Operational-v2-Runner-Startanker bindet andere Bundle-Bytes als die Execution-Pins."
  );
  invariant5(
    process.platform === pins.runner.runtime.platform && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_BYTES === String(pins.runner.runtime.bytes) && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_SHA256 === pins.runner.runtime.sha256,
    "Operational-v2-Runner-Startanker bindet andere Node-Runtime-Bytes als die Execution-Pins."
  );
  if (process.platform === "win32") {
    invariant5(
      process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_BYTES === String(pins.runner.anchorHelper.bytes) && process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_SHA256 === pins.runner.anchorHelper.sha256 && typeof process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_PATH === "string",
      "Operational-v2-Runner-Startanker bindet nicht die gepinnte Helper-Assembly."
    );
  }
  const actualRuntime = currentRuntimeByteProof();
  invariant5(
    actualRuntime.bytes === pins.runner.runtime.bytes && actualRuntime.sha256 === pins.runner.runtime.sha256,
    "Operational-v2-Runner laeuft nicht aus den gehaltenen gepinnten Node-Runtime-Bytes."
  );
  const heldNodePath = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_PATH;
  invariant5(
    typeof heldNodePath === "string" && heldNodePath.length > 0 && (process.platform !== "win32" || heldNodePath.toLocaleLowerCase("en-US") === process.execPath.toLocaleLowerCase("en-US")),
    "Operational-v2-Runner-Prozess stammt nicht vom gehaltenen Node-Runtime-Pfad des Systemlaunchers."
  );
  const reexecNodePath = operationalNodeReexecPath();
  invariant5(
    process.platform === "win32" ? reexecNodePath.toLocaleLowerCase("en-US") === process.execPath.toLocaleLowerCase("en-US") : /^\/proc\/[1-9][0-9]*\/fd\/[0-9]+$/u.test(reexecNodePath),
    "Operational-v2-Runner besitzt keinen plattformgebundenen gehaltenen Node-Reexec-Anker."
  );
  const reexecRuntime = synchronousRuntimeByteProof(reexecNodePath, "Operational-v2-Runner-Node-Reexec-Anker");
  invariant5(
    reexecRuntime.bytes === pins.runner.runtime.bytes && reexecRuntime.sha256 === pins.runner.runtime.sha256,
    "Operational-v2-Runner-Node-Reexec-Anker bindet nicht die gepinnten Runtime-Bytes."
  );
  return validateRunnerInvocation({
    mode: GERMANY_OPERATIONAL_RUNNER_INVOCATION_MODE,
    nodeArguments: ["--input-type=module", "-"],
    nodeOptions: null
  }, "Operational-v2-Runner-Aufruf");
}
function validateGermanyOperationalExecutionPins(value, expectedReleaseId) {
  exactKeys3(value, ["schema", "releaseId", "runner", "validator", "command"], "Operational-v2-Execution-Pins");
  invariant5(value.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA, "Operational-v2-Execution-Pins besitzt ein unbekanntes Schema.");
  invariant5(typeof value.releaseId === "string" && value.releaseId.length > 0, "Operational-v2-Execution-Pins besitzt keine Release-ID.");
  if (expectedReleaseId !== void 0) invariant5(value.releaseId === expectedReleaseId, "Operational-v2-Execution-Pins bindet eine falsche Release-ID.");
  exactKeys3(value.runner, ["anchorHelper", "bundle", "entrypoint", "roots", "importClosure", "invocation", "launcher", "runtime"], "Operational-v2-Execution-Pins.runner");
  const bundle = fileProof3(value.runner.bundle, "Operational-v2-Execution-Pins.runner.bundle");
  invariant5(bundle.file === GERMANY_OPERATIONAL_EXECUTION_RUNNER_BUNDLE, "Operational-v2-Execution-Pins bindet nicht das kanonische gehaltene Runner-Bundle.");
  const entrypoint = fileProof3(value.runner.entrypoint, "Operational-v2-Execution-Pins.runner.entrypoint");
  const roots = validateSortedUniqueFileProofs(value.runner.roots, "Operational-v2-Execution-Pins.runner.roots");
  const importClosure = validateSortedUniqueFileProofs(value.runner.importClosure, "Operational-v2-Execution-Pins.runner.importClosure");
  validateRunnerInvocation(value.runner.invocation, "Operational-v2-Execution-Pins.runner.invocation");
  runtimeProof(value.runner.runtime, "Operational-v2-Execution-Pins.runner.runtime");
  launcherProof(value.runner.launcher, "Operational-v2-Execution-Pins.runner.launcher", value.runner.runtime.platform);
  if (value.runner.runtime.platform === "win32") {
    fileProof3(value.runner.anchorHelper, "Operational-v2-Execution-Pins.runner.anchorHelper");
    invariant5(
      value.runner.anchorHelper.file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
      "Operational-v2-Execution-Pins bindet nicht die kanonische Windows-Anchor-Helper-Assembly."
    );
  } else {
    invariant5(value.runner.anchorHelper === null, "Linux-Execution-Pins duerfen keine Windows-Anchor-Helper-Assembly binden.");
  }
  invariant5(
    entrypoint.file === GERMANY_OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT,
    "Operational-v2-Execution-Pins bindet nicht den festgelegten integrierten Runner-Entrypoint."
  );
  invariant5(
    sameCanonical(roots.map(({ file }) => file), GERMANY_OPERATIONAL_EXECUTION_RUNNER_ROOT_FILES),
    "Operational-v2-Execution-Pins bindet nicht exakt Runner, Capture und Publisher als Closure-Wurzeln."
  );
  const launcherSourceFile = value.runner.runtime.platform === "win32" ? GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE : GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE;
  const launcherSource = importClosure.find(({ file }) => file === launcherSourceFile);
  invariant5(
    launcherSource !== void 0 && launcherSource.bytes === value.runner.launcher.sourceBytes && launcherSource.sha256 === value.runner.launcher.sourceSha256,
    "Operational-v2-Execution-Pins binden Launcher-Beleg und gehaltene Launcher-Datenfile nicht bytegleich."
  );
  if (value.runner.runtime.platform === "win32") {
    const anchorHelper = importClosure.find(({ file }) => file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE);
    invariant5(
      anchorHelper !== void 0 && sameCanonical(anchorHelper, value.runner.anchorHelper),
      "Operational-v2-Execution-Pins binden die Helper-Assembly nicht exakt einmal bytegleich in der Importclosure."
    );
  }
  const rootEntrypoint = roots.find(({ file }) => file === entrypoint.file);
  const closureEntrypoint = importClosure.find(({ file }) => file === entrypoint.file);
  invariant5(rootEntrypoint !== void 0 && sameCanonical(rootEntrypoint, entrypoint), "Operational-v2-Execution-Pins-Entrypoint fehlt bytegleich in den Closure-Wurzeln.");
  invariant5(closureEntrypoint !== void 0 && sameCanonical(closureEntrypoint, entrypoint), "Operational-v2-Execution-Pins-Entrypoint fehlt bytegleich in der Importclosure.");
  invariant5(roots.every((root2) => importClosure.some((entry) => sameCanonical(entry, root2))), "Operational-v2-Execution-Pins-Closure enthaelt nicht alle Wurzeln bytegleich.");
  exactKeys3(value.validator, ["file", "buildCommit", "bytes", "sha256", "rebuildSpecification", "rebuildEvidence"], "Operational-v2-Execution-Pins.validator");
  portablePath(value.validator.file, "Operational-v2-Execution-Pins.validator.file");
  gitCommit(value.validator.buildCommit, "Operational-v2-Execution-Pins.validator.buildCommit");
  positiveInteger(value.validator.bytes, "Operational-v2-Execution-Pins.validator.bytes");
  sha2562(value.validator.sha256, "Operational-v2-Execution-Pins.validator.sha256");
  portablePath(value.validator.rebuildSpecification, "Operational-v2-Execution-Pins.validator.rebuildSpecification");
  portablePath(value.validator.rebuildEvidence, "Operational-v2-Execution-Pins.validator.rebuildEvidence");
  exactKeys3(value.command, ["name", "argumentPrefix", "argumentFiles", "arguments", "stdoutMaxBytes"], "Operational-v2-Execution-Pins.command");
  invariant5(typeof value.command.name === "string" && SAFE_COMMAND.test(value.command.name) && value.command.name === "derive-germany-operational-v2", "Operational-v2-Execution-Pins bindet einen falschen Native-Befehl.");
  const argumentPrefix = stringList(value.command.argumentPrefix, "Operational-v2-Execution-Pins.command.argumentPrefix");
  invariant5(Array.isArray(value.command.argumentFiles), "Operational-v2-Execution-Pins.command.argumentFiles muss eine Liste sein.");
  invariant5(
    argumentPrefix.length === 0 && value.command.argumentFiles.length === 0,
    "Operational-v2-Execution-Pins-v1 erlaubt keinen Argumentpraefix und keine Argumentdateien."
  );
  invariant5(sameCanonical(value.command.arguments, COMMAND_ARGUMENTS), "Operational-v2-Execution-Pins bindet eine falsche Argumentvorlage.");
  positiveInteger(value.command.stdoutMaxBytes, "Operational-v2-Execution-Pins.command.stdoutMaxBytes");
  invariant5(value.command.stdoutMaxBytes <= 1024 * 1024, "Operational-v2-Execution-Pins erlaubt zu viel stdout.");
  return value;
}
function serializeGermanyOperationalExecutionPins(value, expectedReleaseId) {
  validateGermanyOperationalExecutionPins(value, expectedReleaseId);
  return canonicalBytes2(value);
}
function validateExecutionProof(value, label, nativeReceipt) {
  invariant5(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  const allowedKeys = /* @__PURE__ */ new Set([
    "annualLaunch",
    "schema",
    "executionPinsSha256",
    "runner",
    "validator",
    "rebuild",
    "invocation",
    "stdout",
    "exit"
  ]);
  invariant5(Object.keys(value).every((key) => allowedKeys.has(key)), `${label} besitzt fremde Felder.`);
  for (const required of ["schema", "executionPinsSha256", "runner", "validator", "rebuild", "invocation", "stdout", "exit"]) {
    invariant5(Object.hasOwn(value, required), `${label}.${required} fehlt.`);
  }
  invariant5(value.schema === GERMANY_OPERATIONAL_EXECUTION_PROOF_SCHEMA, `${label}.schema ist unbekannt.`);
  sha2562(value.executionPinsSha256, `${label}.executionPinsSha256`);
  exactKeys3(value.runner, ["anchorHelper", "bundle", "entrypoint", "importClosure", "invocation", "launcher", "runtime"], `${label}.runner`);
  fileProof3(value.runner.bundle, `${label}.runner.bundle`);
  fileProof3(value.runner.entrypoint, `${label}.runner.entrypoint`);
  validateRunnerInvocation(value.runner.invocation, `${label}.runner.invocation`);
  runtimeProof(value.runner.runtime, `${label}.runner.runtime`);
  launcherProof(value.runner.launcher, `${label}.runner.launcher`, value.runner.runtime.platform);
  if (value.runner.runtime.platform === "win32") {
    fileProof3(value.runner.anchorHelper, `${label}.runner.anchorHelper`);
    invariant5(
      value.runner.anchorHelper.file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
      `${label}.runner.anchorHelper bindet nicht die kanonische Helper-Assembly.`
    );
  } else {
    invariant5(value.runner.anchorHelper === null, `${label}.runner.anchorHelper ist fuer Linux unzulaessig.`);
  }
  invariant5(Array.isArray(value.runner.importClosure) && value.runner.importClosure.length > 0, `${label}.runner.importClosure fehlt.`);
  let previous = "";
  for (const [index, proof] of value.runner.importClosure.entries()) {
    fileProof3(proof, `${label}.runner.importClosure[${index}]`);
    invariant5(proof.file.localeCompare(previous, "en") > 0, `${label}.runner.importClosure muss eindeutig sortiert sein.`);
    previous = proof.file;
  }
  invariant5(value.runner.importClosure.some(({ file }) => file === value.runner.entrypoint.file), `${label}.runner.entrypoint fehlt in der Importclosure.`);
  if (value.runner.runtime.platform === "win32") {
    invariant5(Object.hasOwn(value, "annualLaunch"), `${label}.annualLaunch fehlt fuer den Windows-Jahreslauf.`);
    validateAnnualLaunchProof(value.annualLaunch, `${label}.annualLaunch`);
  } else {
    invariant5(!Object.hasOwn(value, "annualLaunch"), `${label}.annualLaunch ist fuer einen Nicht-Windows-Lauf unzulaessig.`);
  }
  exactKeys3(value.validator, ["buildCommit", "preserved", "executed"], `${label}.validator`);
  gitCommit(value.validator.buildCommit, `${label}.validator.buildCommit`);
  fileProof3(value.validator.preserved, `${label}.validator.preserved`);
  exactKeys3(value.validator.executed, ["mode", "bytes", "sha256"], `${label}.validator.executed`);
  invariant5(["linux-sealed-memfd-launch-v1", "windows-exclusive-handle-launch-v1"].includes(value.validator.executed.mode), `${label}.validator.executed.mode ist unbekannt.`);
  positiveInteger(value.validator.executed.bytes, `${label}.validator.executed.bytes`);
  sha2562(value.validator.executed.sha256, `${label}.validator.executed.sha256`);
  invariant5(value.validator.executed.bytes === value.validator.preserved.bytes && value.validator.executed.sha256 === value.validator.preserved.sha256, `${label} bindet andere ausgefuehrte als preserved Validator-Bytes.`);
  exactKeys3(value.rebuild, ["specification", "evidence", "sourceCommit"], `${label}.rebuild`);
  fileProof3(value.rebuild.specification, `${label}.rebuild.specification`);
  fileProof3(value.rebuild.evidence, `${label}.rebuild.evidence`, { schema: true });
  gitCommit(value.rebuild.sourceCommit, `${label}.rebuild.sourceCommit`);
  invariant5(value.rebuild.sourceCommit === value.validator.buildCommit, `${label} bindet Rebuild und Validator an verschiedene Commits.`);
  exactKeys3(value.invocation, ["command", "argumentPrefix", "argumentFiles", "arguments"], `${label}.invocation`);
  invariant5(value.invocation.command === "derive-germany-operational-v2", `${label}.invocation.command ist falsch.`);
  stringList(value.invocation.argumentPrefix, `${label}.invocation.argumentPrefix`);
  invariant5(Array.isArray(value.invocation.argumentFiles), `${label}.invocation.argumentFiles muss eine Liste sein.`);
  for (const [index, proof] of value.invocation.argumentFiles.entries()) fileProof3(proof, `${label}.invocation.argumentFiles[${index}]`);
  const arguments_ = stringList(value.invocation.arguments, `${label}.invocation.arguments`);
  invariant5(arguments_.length === COMMAND_ARGUMENTS.length && arguments_[0] === value.invocation.command, `${label}.invocation.arguments ist unvollstaendig.`);
  for (let index = 1; index < arguments_.length; index += 1) portablePath(arguments_[index], `${label}.invocation.arguments[${index}]`);
  exactKeys3(value.stdout, ["bytes", "sha256", "recordCount", "structuredReceiptSha256"], `${label}.stdout`);
  positiveInteger(value.stdout.bytes, `${label}.stdout.bytes`);
  sha2562(value.stdout.sha256, `${label}.stdout.sha256`);
  invariant5(value.stdout.recordCount === 1, `${label}.stdout muss genau einen strukturierten Datensatz enthalten.`);
  sha2562(value.stdout.structuredReceiptSha256, `${label}.stdout.structuredReceiptSha256`);
  if (nativeReceipt !== void 0) {
    invariant5(value.stdout.structuredReceiptSha256 === germanyOperationalStructuredValueSha256(nativeReceipt), `${label}.stdout bindet ein anderes strukturiertes Native-Receipt.`);
  }
  exactKeys3(value.exit, ["code", "signal"], `${label}.exit`);
  invariant5(value.exit.code === 0 && value.exit.signal === null, `${label}.exit ist kein erfolgreicher signal-freier Prozessabschluss.`);
  return value;
}
function validateGermanyOperationalExecutionProofAgainstPins(executionProof, executionPins, { nativeReceipt } = {}) {
  const pins = validateGermanyOperationalExecutionPins(executionPins);
  const proof = validateExecutionProof(executionProof, "Operational-v2-Execution-Proof gegen Pins", nativeReceipt);
  const expectedExecutionPinsBytes = serializeGermanyOperationalExecutionPins(pins);
  const expectedExecutionPinsSha256 = createHash5("sha256").update(expectedExecutionPinsBytes).digest("hex");
  invariant5(
    proof.executionPinsSha256 === expectedExecutionPinsSha256,
    "Operational-v2-Execution-Proof bindet nicht den kanonischen SHA-256 der uebergebenen Execution-Pins."
  );
  invariant5(
    sameCanonical(proof.runner.entrypoint, pins.runner.entrypoint),
    "Operational-v2-Execution-Proof bindet andere Runner-Entrypoint-Bytes als die Execution-Pins."
  );
  invariant5(
    sameCanonical(proof.runner.importClosure, pins.runner.importClosure),
    "Operational-v2-Execution-Proof bindet andere Importclosure-Bytes als die Execution-Pins."
  );
  invariant5(
    sameCanonical(proof.runner.bundle, pins.runner.bundle),
    "Operational-v2-Execution-Proof bindet andere gehaltene Bundle-Bytes als die Execution-Pins."
  );
  invariant5(
    sameCanonical(proof.runner.invocation, pins.runner.invocation),
    "Operational-v2-Execution-Proof bindet einen anderen Node-Runner-Aufruf als die Execution-Pins."
  );
  invariant5(
    sameCanonical(proof.runner.runtime, pins.runner.runtime),
    "Operational-v2-Execution-Proof bindet eine andere Node-Runtime als die Execution-Pins."
  );
  invariant5(
    sameCanonical(proof.runner.launcher, pins.runner.launcher),
    "Operational-v2-Execution-Proof bindet einen anderen Systemlauncher als die Execution-Pins."
  );
  invariant5(
    sameCanonical(proof.runner.anchorHelper, pins.runner.anchorHelper),
    "Operational-v2-Execution-Proof bindet eine andere Windows-Anchor-Helper-Assembly als die Execution-Pins."
  );
  invariant5(
    proof.validator.buildCommit === pins.validator.buildCommit && sameCanonical(proof.validator.preserved, {
      file: pins.validator.file,
      bytes: pins.validator.bytes,
      sha256: pins.validator.sha256
    }),
    "Operational-v2-Execution-Proof bindet andere Validatorbytes oder einen anderen Commit als die Execution-Pins."
  );
  invariant5(
    proof.rebuild.specification.file === pins.validator.rebuildSpecification && proof.rebuild.evidence.file === pins.validator.rebuildEvidence && proof.rebuild.sourceCommit === pins.validator.buildCommit,
    "Operational-v2-Execution-Proof bindet andere Rebuild-Pfade oder einen anderen Commit als die Execution-Pins."
  );
  if (pins.runner.runtime.platform === "win32") {
    invariant5(
      proof.annualLaunch.executionPins.bytes === expectedExecutionPinsBytes.length && proof.annualLaunch.executionPins.sha256 === expectedExecutionPinsSha256 && proof.annualLaunch.executionPins.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
      "Operational-v2-Execution-Proof-Annual-Launch bindet nicht dieselben Execution-Pins."
    );
    invariant5(sameCanonical(proof.annualLaunch.trustedExecutor, {
      file: pins.validator.file,
      buildCommit: pins.validator.buildCommit,
      bytes: pins.validator.bytes,
      sha256: pins.validator.sha256
    }), "Operational-v2-Execution-Proof-Annual-Launch bindet nicht denselben Trusted-Executor.");
  }
  invariant5(
    proof.invocation.command === pins.command.name && sameCanonical(proof.invocation.argumentPrefix, pins.command.argumentPrefix) && sameCanonical(proof.invocation.argumentFiles, pins.command.argumentFiles),
    "Operational-v2-Execution-Proof bindet andere Native-Argumente als die Execution-Pins."
  );
  return proof;
}
function validateGermanyOperationalProvenance(value, { nativeReceipt } = {}) {
  exactKeys3(value, ["schema", "producerKind", "releaseEvidenceEligible", "productionActivationEligible", "executionPins", "executionProof"], "Operational-v2-Provenienz");
  invariant5(value.schema === GERMANY_OPERATIONAL_PROVENANCE_SCHEMA, "Operational-v2-Provenienz besitzt ein unbekanntes Schema.");
  fileProof3(value.executionPins, "Operational-v2-Provenienz.executionPins", { schema: true });
  invariant5(value.executionPins.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA, "Operational-v2-Provenienz bindet ein falsches Execution-Pins-Schema.");
  if (value.producerKind === GERMANY_OPERATIONAL_FORENSIC_PRODUCER_KIND) {
    invariant5(value.releaseEvidenceEligible === false && value.productionActivationEligible === false && value.executionProof === null, "Forensische Operational-v2-Provenienz darf weder Evidence noch Aktivierung freigeben.");
    return value;
  }
  invariant5(value.producerKind === GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND, "Operational-v2-Provenienz besitzt eine unbekannte Producer-Art.");
  invariant5(value.releaseEvidenceEligible === true && value.productionActivationEligible === true, "Integrierte Operational-v2-Provenienz muss beide Eignungsgates explizit schliessen.");
  validateExecutionProof(value.executionProof, "Operational-v2-Provenienz.executionProof", nativeReceipt);
  invariant5(value.executionProof.executionPinsSha256 === value.executionPins.sha256, "Operational-v2-Provenienz bindet Execution-Pins und Execution-Proof verschieden.");
  return value;
}
function sameIdentity4(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}
function sameNodeIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
async function readPinnedRegularFile(path, label, maxBytes = MAX_PINS_BYTES) {
  const handle = await open5(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant5(before.isFile() && before.size > 0n && before.size <= BigInt(maxBytes), `${label} ist keine kleine regulaere Datei.`);
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat5(path, { bigint: true })]);
    invariant5(pathAfter.isFile() && !pathAfter.isSymbolicLink() && sameIdentity4(before, after) && sameIdentity4(after, pathAfter) && BigInt(bytes.length) === after.size, `${label} wurde waehrend des Lesens ersetzt oder veraendert.`);
    return { bytes, proof: { bytes: bytes.length, sha256: createHash5("sha256").update(bytes).digest("hex") } };
  } finally {
    await handle.close();
  }
}
function resolvePortable(root2, file, label) {
  portablePath(file, label);
  const path = resolve5(root2, ...file.split("/"));
  const rel = relative3(root2, path);
  invariant5(rel !== "" && rel !== ".." && !rel.startsWith(`..${sep3}`) && !isAbsolute3(rel), `${label} verlaesst die Arbeitswurzel.`);
  return path;
}
function comparableResolvedPath(path) {
  const value = resolve5(path);
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}
async function assertCanonicalRepositoryPath(root2, path, label) {
  const [realRoot, actual] = await Promise.all([realpath4(root2), realpath4(path)]);
  const expected = resolve5(realRoot, relative3(root2, path));
  invariant5(
    comparableResolvedPath(actual) === comparableResolvedPath(expected),
    `${label} verwendet einen symbolischen Link oder Junction-Ahnen.`
  );
}
function parseStaticModuleSpecifiers(bytes, label) {
  const environment = process.platform === "win32" ? {
    SystemRoot: WINDOWS_TRUSTED_SYSTEM_ROOT,
    WINDIR: WINDOWS_TRUSTED_SYSTEM_ROOT,
    ComSpec: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32\\cmd.exe`,
    PATH: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32;${WINDOWS_TRUSTED_SYSTEM_ROOT}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD"
  } : { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const result = spawnSync4(operationalNodeReexecPath(), ["--expose-internals", "-e", MODULE_PARSER_CHILD_SOURCE], {
    encoding: "utf8",
    env: environment,
    input: bytes,
    maxBuffer: MAX_PINS_BYTES,
    shell: false,
    windowsHide: true
  });
  invariant5(result.error === void 0, `${label} konnte nicht mit dem Node-Modulparser gelesen werden: ${result.error?.message ?? "unbekannter Fehler"}`);
  invariant5(result.signal === null && result.status === 0, `${label} ist kein gueltiges statisches ESM-Modul.`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} lieferte keinen strukturierten Modulparser-Beleg.`, { cause: error });
  }
  exactKeys3(parsed, ["staticSpecifiers", "unsupportedLoaders"], `${label} Modulparser-Beleg`);
  const staticSpecifiers = stringList(parsed.staticSpecifiers, `${label} statische Modulbezeichner`);
  const unsupportedLoaders = stringList(parsed.unsupportedLoaders, `${label} nicht gepinnte Loader`);
  invariant5(unsupportedLoaders.length === 0, `${label} enthaelt nicht gepinnte Loader: ${unsupportedLoaders.join(", ")}.`);
  return staticSpecifiers;
}
function portableRelative(root2, path, label) {
  const rel = relative3(root2, resolve5(path));
  invariant5(rel !== "" && rel !== ".." && !rel.startsWith(`..${sep3}`) && !isAbsolute3(rel), `${label} verlaesst die Arbeitswurzel.`);
  return portablePath(rel.split(sep3).join("/"), label);
}
function portableWorkspaceRootOrRelative(root2, path, label) {
  const rel = relative3(root2, resolve5(path));
  if (rel === "") return ".";
  return portableRelative(root2, path, label);
}
async function loadGermanyOperationalExecutionPins({ workspaceRoot: workspaceRoot2, executionPinsPath, expectedReleaseId }) {
  const root2 = resolve5(workspaceRoot2);
  const path = resolve5(executionPinsPath);
  const file = portableRelative(root2, path, "Operational-v2-Execution-Pins-Pfad");
  await assertCanonicalRepositoryPath(root2, path, "Operational-v2-Execution-Pins");
  const source = await readPinnedRegularFile(path, "Operational-v2-Execution-Pins");
  await assertCanonicalRepositoryPath(root2, path, "Operational-v2-Execution-Pins nach dem Lesen");
  let value;
  try {
    value = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Operational-v2-Execution-Pins ist kein gueltiges JSON.", { cause: error });
  }
  validateGermanyOperationalExecutionPins(value, expectedReleaseId);
  invariant5(
    source.bytes.equals(serializeGermanyOperationalExecutionPins(value, expectedReleaseId)),
    "Operational-v2-Execution-Pins besitzt nicht die kanonische Byteform."
  );
  return { value, proof: { file, ...source.proof, schema: value.schema } };
}
async function proveGermanyOperationalAnnualLaunchFromEnvironment({
  workspaceRoot: workspaceRoot2,
  executionPinsSource,
  encodedProof = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANNUAL_LAUNCH_PROOF_BASE64
}) {
  const root2 = resolve5(workspaceRoot2);
  const pins = validateGermanyOperationalExecutionPins(executionPinsSource.value);
  invariant5(process.platform === "win32", "Operational-v2-Annual-Launch-Proof ist nur fuer den Windows-Jahreslauf definiert.");
  const proof = validateAnnualLaunchProof(
    canonicalJsonBase64(encodedProof, "Operational-v2-Annual-Launch-Proof-Transport")
  );
  invariant5(
    proof.contract.releaseId === pins.releaseId,
    "Operational-v2-Annual-Launch-Proof bindet eine falsche Release-ID."
  );
  invariant5(
    sameCanonical(proof.executionPins, executionPinsSource.proof),
    "Operational-v2-Annual-Launch-Proof bindet andere Execution-Pins als der Runner."
  );
  invariant5(sameCanonical(proof.trustedExecutor, {
    file: pins.validator.file,
    buildCommit: pins.validator.buildCommit,
    bytes: pins.validator.bytes,
    sha256: pins.validator.sha256
  }), "Operational-v2-Annual-Launch-Proof bindet andere Trusted-Executor-Bytes als die Execution-Pins.");
  const contractPath = resolvePortable(root2, proof.contract.file, "Operational-v2-Annual-Launch-Vertrag");
  await assertCanonicalRepositoryPath(root2, contractPath, "Operational-v2-Annual-Launch-Vertrag");
  const source = await readPinnedRegularFile(contractPath, "Operational-v2-Annual-Launch-Vertrag", 2 * 1024 * 1024);
  invariant5(
    source.proof.bytes === proof.contract.bytes && source.proof.sha256 === proof.contract.sha256,
    "Operational-v2-Annual-Launch-Vertrag driftet vom gehaltenen Startbeleg."
  );
  let contract;
  try {
    contract = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Operational-v2-Annual-Launch-Vertrag ist kein gueltiges JSON.", { cause: error });
  }
  invariant5(
    canonicalBytes2(contract).equals(source.bytes),
    "Operational-v2-Annual-Launch-Vertrag ist nicht kanonisch serialisiert."
  );
  exactKeys3(
    contract,
    ["bootstrap", "dynamicBindings", "executionPins", "launcher", "platform", "releaseId", "schema", "trustedExecutor"],
    "Operational-v2-Annual-Launch-Vertrag"
  );
  invariant5(
    contract.schema === proof.contract.schema && contract.releaseId === proof.contract.releaseId && contract.platform === "win32",
    "Operational-v2-Annual-Launch-Vertrag besitzt eine falsche Identitaet."
  );
  invariant5(
    sameCanonical(contract.executionPins, proof.executionPins),
    "Operational-v2-Annual-Launch-Vertrag bindet andere Execution-Pins als sein Startbeleg."
  );
  invariant5(
    sameCanonical(contract.trustedExecutor, proof.trustedExecutor),
    "Operational-v2-Annual-Launch-Vertrag bindet andere Trusted-Executor-Bytes als sein Startbeleg."
  );
  await assertCanonicalRepositoryPath(root2, contractPath, "Operational-v2-Annual-Launch-Vertrag nach dem Lesen");
  return proof;
}
async function repositoryImportClosure(root2, roots) {
  const visited = /* @__PURE__ */ new Map();
  const pending = roots.map((file) => portablePath(file, "Operational-v2-Importclosure-Wurzel"));
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    const path = resolvePortable(root2, file, `Operational-v2-Importclosure ${file}`);
    await assertCanonicalRepositoryPath(root2, path, `Operational-v2-Importclosure ${file}`);
    const source = await readPinnedRegularFile(path, `Operational-v2-Importclosure ${file}`);
    await assertCanonicalRepositoryPath(root2, path, `Operational-v2-Importclosure ${file} nach dem Lesen`);
    visited.set(file, { file, ...source.proof });
    if (file === GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE || file === GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE || file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE) continue;
    for (const specifier of parseStaticModuleSpecifiers(source.bytes, `Operational-v2-Importclosure ${file}`)) {
      if (specifier.startsWith("node:")) continue;
      invariant5(specifier.startsWith("./") || specifier.startsWith("../"), `Operational-v2-Importclosure ${file} enthaelt den nicht gepinnten Modulbezeichner ${specifier}.`);
      const importedPath = resolve5(dirname5(path), specifier);
      pending.push(portableRelative(root2, importedPath, `Operational-v2-Import aus ${file}`));
    }
  }
  return [...visited.values()].sort((left, right) => left.file.localeCompare(right.file, "en"));
}
async function proveGermanyOperationalExecutionContext({ workspaceRoot: workspaceRoot2, executionPins, verifyCurrentInvocation = true }) {
  const root2 = resolve5(workspaceRoot2);
  const pins = validateGermanyOperationalExecutionPins(executionPins);
  const invocation = verifyCurrentInvocation ? currentRunnerInvocation(pins) : pins.runner.invocation;
  if (verifyCurrentInvocation) invariant5(sameCanonical(invocation, pins.runner.invocation), "Operational-v2-Runner-Aufruf driftet von den Execution-Pins.");
  const launcherSourceFile = pins.runner.runtime.platform === "win32" ? GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE : GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE;
  const importClosure = await repositoryImportClosure(root2, [
    ...pins.runner.roots.map(({ file }) => file),
    launcherSourceFile,
    ...pins.runner.anchorHelper === null ? [] : [pins.runner.anchorHelper.file]
  ]);
  invariant5(sameCanonical(importClosure, pins.runner.importClosure), "Operational-v2-Runner-/Capture-/Publisher-Importclosure driftet von ihren unveraenderlichen Byte-Pins.");
  const entrypoint = importClosure.find(({ file }) => file === pins.runner.entrypoint.file);
  invariant5(entrypoint !== void 0, "Operational-v2-Runner-Entrypoint fehlt im Ausfuehrungsbeleg.");
  invariant5(sameCanonical(entrypoint, pins.runner.entrypoint), "Operational-v2-Runner-Entrypoint driftet von seinem unveraenderlichen Byte-Pin.");
  const bundlePath = resolvePortable(root2, pins.runner.bundle.file, "Operational-v2-gehaltenes Runner-Bundle");
  await assertCanonicalRepositoryPath(root2, bundlePath, "Operational-v2-gehaltenes Runner-Bundle");
  const bundleSource = await readPinnedRegularFile(bundlePath, "Operational-v2-gehaltenes Runner-Bundle", 16 * 1024 * 1024);
  const bundle = { file: pins.runner.bundle.file, ...bundleSource.proof };
  invariant5(sameCanonical(bundle, pins.runner.bundle), "Operational-v2-gehaltenes Runner-Bundle driftet von seinem unveraenderlichen Byte-Pin.");
  return {
    anchorHelper: pins.runner.anchorHelper === null ? null : { ...pins.runner.anchorHelper },
    bundle,
    entrypoint,
    importClosure,
    invocation,
    launcher: { ...pins.runner.launcher },
    runtime: { ...pins.runner.runtime }
  };
}
function powershellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
function windowsHeldValidatorLauncherBootstrap({ environment, launcherPath, launcher }) {
  const context = Buffer.from(JSON.stringify(environment), "utf8").toString("base64");
  return {
    context,
    source: `$ErrorActionPreference='Stop';$f=$null;try{$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ZUGFOLGE_OPERATIONAL_BOOTSTRAP_CONTEXT_BASE64))|ConvertFrom-Json;if($c.ZUGFOLGE_OPERATIONAL_LAUNCHER_PURPOSE -ne 'validator' -or $c.ZUGFOLGE_OPERATIONAL_ANCHOR_SHA256 -ne '${environment.ZUGFOLGE_OPERATIONAL_ANCHOR_SHA256}' -or $c.ZUGFOLGE_OPERATIONAL_LAUNCHER_SOURCE_SHA256 -ne '${launcher.sourceSha256}'){throw'Validator-Annual-Pins drifteten'};foreach($p in $c.PSObject.Properties){[Environment]::SetEnvironmentVariable($p.Name,[String]$p.Value,'Process')};[Environment]::SetEnvironmentVariable('ZUGFOLGE_OPERATIONAL_BOOTSTRAP_CONTEXT_BASE64',$null,'Process');$f=[IO.File]::Open(${powershellSingleQuoted(launcherPath)},'Open','Read','Read');if($f.Length -ne ${launcher.sourceBytes}){throw'Validator-Launcher-Bytes'};$b=New-Object byte[] ${launcher.sourceBytes};$o=0;while($o -lt $b.Length){$n=$f.Read($b,$o,$b.Length-$o);if($n -eq 0){throw'Validator-Launcher-EOF'};$o+=$n};$s=[Security.Cryptography.SHA256]::Create();try{$h=([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()};if($h -ne '${launcher.sourceSha256}'){throw'Validator-Launcher-SHA'};&([ScriptBlock]::Create((New-Object Text.UTF8Encoding($false,$true)).GetString($b)))}catch{[Console]::Error.Write($_.Exception.ToString());exit 90}finally{if($null -ne $f){$f.Dispose()}}`
  };
}
async function proofFromHandle(handle, label) {
  const before = await handle.stat({ bigint: true });
  invariant5(before.isFile() && before.size > 0n, `${label} ist keine regulaere Datei.`);
  const digest = createHash5("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  while (true) {
    const result = await handle.read(buffer, 0, buffer.length, bytes);
    if (result.bytesRead === 0) break;
    digest.update(buffer.subarray(0, result.bytesRead));
    bytes += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  invariant5(sameIdentity4(before, after) && BigInt(bytes) === after.size, `${label} driftete waehrend der Hashbildung.`);
  return { identity: after, proof: { bytes, sha256: digest.digest("hex") } };
}
async function copyHeldFile(sourceHandle, destinationHandle, label) {
  const digest = createHash5("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const result = await sourceHandle.read(buffer, 0, buffer.length, position);
    if (result.bytesRead === 0) break;
    let written = 0;
    while (written < result.bytesRead) {
      const writeResult = await destinationHandle.write(buffer, written, result.bytesRead - written, position + written);
      invariant5(writeResult.bytesWritten > 0, `${label} konnte nicht vollstaendig geschrieben werden.`);
      written += writeResult.bytesWritten;
    }
    digest.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  await destinationHandle.chmod(448);
  await destinationHandle.sync();
  return { bytes: position, sha256: digest.digest("hex") };
}
function parseSingleStructuredStdout(stdout, maximumBytes) {
  invariant5(Buffer.isBuffer(stdout) && stdout.length > 0 && stdout.length <= maximumBytes, "Native Operational-v2-Ableitung lieferte kein begrenztes stdout-Receipt.");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch (error) {
    throw new Error("Native Operational-v2-Ableitung lieferte kein gueltiges UTF-8 auf stdout.", { cause: error });
  }
  const body = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : null;
  invariant5(body !== null && body.length > 0 && body.trim() === body && !/[\r\n]/u.test(body), "Native Operational-v2-Ableitung muss exakt einen kompakten JSON-stdout-Datensatz liefern.");
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error("Native Operational-v2-Ableitung lieferte keinen einzelnen strukturierten JSON-stdout-Datensatz.", { cause: error });
  }
  invariant5(isRecord3(value), "Native Operational-v2-Ableitung lieferte kein JSON-Objekt.");
  return {
    value,
    proof: {
      bytes: stdout.length,
      sha256: createHash5("sha256").update(stdout).digest("hex"),
      recordCount: 1,
      structuredReceiptSha256: germanyOperationalStructuredValueSha256(value)
    }
  };
}
function canonicalBase64Bytes(value, label) {
  invariant5(typeof value === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value), `${label} ist kein kanonisches Base64.`);
  const bytes = Buffer.from(value, "base64");
  invariant5(bytes.toString("base64") === value, `${label} ist kein kanonisches Base64.`);
  return bytes;
}
async function windowsPowerShellPath() {
  const actual = await realpath4(WINDOWS_TRUSTED_POWERSHELL);
  invariant5(
    comparableResolvedPath(actual) === comparableResolvedPath(WINDOWS_TRUSTED_POWERSHELL),
    "Windows-Validator-Launcher liegt nicht am fest gebundenen, systemgeschuetzten PowerShell-Pfad."
  );
  return WINDOWS_TRUSTED_POWERSHELL;
}
async function executeWindowsExclusiveHandleValidator({
  executionPath,
  expected,
  anchorHelperPath,
  anchorHelper,
  inputFiles = [],
  arguments: arguments_,
  cwd,
  maximumBytes,
  timeoutMilliseconds = GERMANY_OPERATIONAL_ANNUAL_RUN_TIMEOUT_MILLISECONDS
}) {
  const launcherPath = await windowsPowerShellPath();
  const launcherBefore = await readPinnedRegularFile(launcherPath, "Windows-System32-PowerShell-Launcher", 16 * 1024 * 1024);
  const launcherSourcePath = resolvePortable(cwd, GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE, "Windows-Validator-Systemlauncher-Datenfile");
  await assertCanonicalRepositoryPath(cwd, launcherSourcePath, "Windows-Validator-Systemlauncher-Datenfile");
  const launcherSourceProof = germanyOperationalSystemLauncherSourceProof("win32");
  const launcherSourceBefore = await readPinnedRegularFile(launcherSourcePath, "Windows-Validator-Systemlauncher-Datenfile", 1024 * 1024);
  invariant5(
    launcherSourceBefore.proof.bytes === launcherSourceProof.sourceBytes && launcherSourceBefore.proof.sha256 === launcherSourceProof.sourceSha256,
    "Windows-Validator-Systemlauncher-Datenfile driftet von der kanonischen Quelle."
  );
  const environment = {
    SystemRoot: WINDOWS_TRUSTED_SYSTEM_ROOT,
    WINDIR: WINDOWS_TRUSTED_SYSTEM_ROOT,
    ComSpec: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32\\cmd.exe`,
    PATH: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32;${WINDOWS_TRUSTED_SYSTEM_ROOT}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: dirname5(executionPath),
    TMP: dirname5(executionPath)
  };
  Object.assign(environment, {
    ZUGFOLGE_OPERATIONAL_ANCHOR_PATH: executionPath,
    ZUGFOLGE_OPERATIONAL_ANCHOR_CWD: cwd,
    ZUGFOLGE_OPERATIONAL_ANCHOR_BYTES: String(expected.bytes),
    ZUGFOLGE_OPERATIONAL_ANCHOR_SHA256: expected.sha256,
    ZUGFOLGE_OPERATIONAL_ANCHOR_MAX_BYTES: String(maximumBytes),
    ZUGFOLGE_OPERATIONAL_ANCHOR_TIMEOUT_MILLISECONDS: String(timeoutMilliseconds),
    ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_COUNT: String(arguments_.length),
    ZUGFOLGE_OPERATIONAL_ANCHOR_INPUT_COUNT: String(inputFiles.length),
    ZUGFOLGE_OPERATIONAL_ANCHOR_HELPER_PATH: anchorHelperPath,
    ZUGFOLGE_OPERATIONAL_ANCHOR_HELPER_BYTES: String(anchorHelper.bytes),
    ZUGFOLGE_OPERATIONAL_ANCHOR_HELPER_SHA256: anchorHelper.sha256,
    ZUGFOLGE_OPERATIONAL_LAUNCHER_PURPOSE: "validator",
    ZUGFOLGE_OPERATIONAL_LAUNCHER_SOURCE_BYTES: String(launcherSourceProof.sourceBytes),
    ZUGFOLGE_OPERATIONAL_LAUNCHER_SOURCE_SHA256: launcherSourceProof.sourceSha256
  });
  for (const [index, argument] of arguments_.entries()) environment[`ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_${index}`] = argument;
  invariant5(inputFiles.length <= 16, "Windows-Validator-Launcher erhielt zu viele gehaltene Inputdateien.");
  const expectedInputProofs = [];
  for (const [index, input] of inputFiles.entries()) {
    const inputProof = { bytes: input.bytes, file: input.file, sha256: input.sha256 };
    fileProof3(inputProof, `Windows-Validator-Launcher-Input[${index}]`);
    invariant5(isAbsolute3(input.path), `Windows-Validator-Launcher-Input[${index}] besitzt keinen absoluten Pfad.`);
    expectedInputProofs.push(inputProof);
    environment[`ZUGFOLGE_OPERATIONAL_ANCHOR_INPUT_${index}_FILE`] = input.file;
    environment[`ZUGFOLGE_OPERATIONAL_ANCHOR_INPUT_${index}_PATH`] = input.path;
    environment[`ZUGFOLGE_OPERATIONAL_ANCHOR_INPUT_${index}_BYTES`] = String(input.bytes);
    environment[`ZUGFOLGE_OPERATIONAL_ANCHOR_INPUT_${index}_SHA256`] = input.sha256;
  }
  const bootstrap = windowsHeldValidatorLauncherBootstrap({
    environment,
    launcherPath: launcherSourcePath,
    launcher: launcherSourceProof
  });
  const encodedCommand = Buffer.from(bootstrap.source, "utf16le").toString("base64");
  const envelopeMaximum = Math.ceil(maximumBytes * 8 / 3) + 1024 * 1024;
  const result = spawnSync4(launcherPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand
  ], {
    cwd,
    encoding: "utf8",
    env: {
      SystemRoot: WINDOWS_TRUSTED_SYSTEM_ROOT,
      WINDIR: WINDOWS_TRUSTED_SYSTEM_ROOT,
      ComSpec: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32\\cmd.exe`,
      PATH: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32;${WINDOWS_TRUSTED_SYSTEM_ROOT}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: dirname5(executionPath),
      TMP: dirname5(executionPath),
      ZUGFOLGE_OPERATIONAL_BOOTSTRAP_CONTEXT_BASE64: bootstrap.context
    },
    maxBuffer: envelopeMaximum,
    shell: false,
    windowsHide: true
  });
  const [launcherAfter, launcherSourceAfter] = await Promise.all([
    readPinnedRegularFile(launcherPath, "Windows-System32-PowerShell-Launcher nach Ausfuehrung", 16 * 1024 * 1024),
    readPinnedRegularFile(launcherSourcePath, "Windows-Validator-Systemlauncher-Datenfile nach Ausfuehrung", 1024 * 1024)
  ]);
  invariant5(sameCanonical(launcherBefore.proof, launcherAfter.proof), "Windows-System32-PowerShell-Launcher driftete waehrend der Ausfuehrung.");
  invariant5(sameCanonical(launcherSourceBefore.proof, launcherSourceAfter.proof), "Windows-Validator-Systemlauncher-Datenfile driftete waehrend der Ausfuehrung.");
  if (result.error !== void 0) throw new Error(`Exklusiver Windows-Validator-Launcher konnte nicht gestartet werden: ${result.error.message}`, { cause: result.error });
  invariant5(result.signal === null && result.status === 0, `Exklusiver Windows-Validator-Launcher scheiterte mit Exit ${result.status}: ${String(result.stderr).slice(0, 2048)}`);
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Exklusiver Windows-Validator-Launcher lieferte keinen strukturierten Ankerbeleg.", { cause: error });
  }
  exactKeys3(envelope, ["anchorBytes", "anchorSha256", "inputProofs", "status", "signal", "stdoutBase64", "stderrBase64"], "Windows-Validator-Launcher-Beleg");
  invariant5(
    envelope.anchorBytes === expected.bytes && envelope.anchorSha256 === expected.sha256,
    "Windows-Validator-Launcher hielt andere Bytes als den geprueften Validator."
  );
  invariant5(
    sameCanonical(envelope.inputProofs, expectedInputProofs),
    "Windows-Validator-Launcher hielt andere Inputbytes als der Supervisorvertrag."
  );
  invariant5(Number.isInteger(envelope.status) && envelope.signal === null, "Windows-Validator-Launcher lieferte keinen eindeutigen Prozessabschluss.");
  return {
    status: envelope.status,
    signal: null,
    inputProofs: envelope.inputProofs,
    stdout: canonicalBase64Bytes(envelope.stdoutBase64, "Windows-Validator-stdout"),
    stderr: canonicalBase64Bytes(envelope.stderrBase64, "Windows-Validator-stderr")
  };
}
async function bytesFromHandle(handle, expected, label) {
  const before = await handle.stat({ bigint: true });
  invariant5(before.isFile() && before.size === BigInt(expected.bytes), `${label} besitzt eine falsche Bytezahl.`);
  const chunks = [];
  const digest = createHash5("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < expected.bytes) {
    const result = await handle.read(buffer, 0, Math.min(buffer.length, expected.bytes - position), position);
    invariant5(result.bytesRead > 0, `${label} endete vor der gepinnten Bytezahl.`);
    const chunk = Buffer.from(buffer.subarray(0, result.bytesRead));
    chunks.push(chunk);
    digest.update(chunk);
    position += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  invariant5(
    sameIdentity4(before, after) && position === expected.bytes && digest.digest("hex") === expected.sha256,
    `${label} driftete von den gepinnten Bytes.`
  );
  return Buffer.concat(chunks, position);
}
async function executeLinuxSealedMemfdValidator({
  binary,
  expected,
  arguments: arguments_,
  cwd,
  maximumBytes
}) {
  const configuredPath = "/usr/bin/python3";
  const launcherPath = await realpath4(configuredPath);
  invariant5(launcherPath.startsWith("/usr/bin/python3"), "Linux-memfd-Launcher ist nicht das festgelegte /usr/bin/python3.");
  const launcherBefore = await readPinnedRegularFile(launcherPath, "Linux-System-Python-memfd-Launcher", 32 * 1024 * 1024);
  const request = Buffer.from(`${JSON.stringify({
    bytes: expected.bytes,
    sha256: expected.sha256,
    maximumBytes,
    arguments: arguments_,
    cwd,
    outerSessionBound: process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE === GERMANY_OPERATIONAL_LINUX_LAUNCHER_MODE
  })}
`, "utf8");
  const envelopeMaximum = Math.ceil(maximumBytes * 8 / 3) + 1024 * 1024;
  const result = spawnSync4(launcherPath, ["-I", "-S", "-c", LINUX_SEALED_MEMFD_LAUNCHER_SOURCE], {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    input: Buffer.concat([request, binary]),
    maxBuffer: envelopeMaximum,
    shell: false
  });
  const launcherAfter = await readPinnedRegularFile(launcherPath, "Linux-System-Python-memfd-Launcher nach Ausfuehrung", 32 * 1024 * 1024);
  invariant5(sameCanonical(launcherBefore.proof, launcherAfter.proof), "Linux-System-Python-memfd-Launcher driftete waehrend der Ausfuehrung.");
  if (result.error !== void 0) throw new Error(`Versiegelter Linux-memfd-Validator-Launcher konnte nicht gestartet werden: ${result.error.message}`, { cause: result.error });
  invariant5(result.signal === null && result.status === 0, `Versiegelter Linux-memfd-Validator-Launcher scheiterte mit Exit ${result.status}: ${String(result.stderr).slice(0, 2048)}`);
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Versiegelter Linux-memfd-Validator-Launcher lieferte keinen strukturierten Ankerbeleg.", { cause: error });
  }
  exactKeys3(envelope, ["anchorBytes", "anchorSha256", "sealMask", "status", "signal", "stdoutBase64", "stderrBase64"], "Linux-memfd-Validator-Launcher-Beleg");
  invariant5(
    envelope.anchorBytes === expected.bytes && envelope.anchorSha256 === expected.sha256 && envelope.sealMask === 15,
    "Linux-memfd-Validator-Launcher versiegelte andere oder unvollstaendige Bytes."
  );
  invariant5(
    Number.isInteger(envelope.status) && envelope.signal === null || envelope.status === null && Number.isInteger(envelope.signal) && envelope.signal > 0,
    "Linux-memfd-Validator-Launcher lieferte keinen eindeutigen Prozessabschluss."
  );
  return {
    status: envelope.status,
    signal: envelope.signal === null ? null : `SIG${envelope.signal}`,
    stdout: canonicalBase64Bytes(envelope.stdoutBase64, "Linux-memfd-Validator-stdout"),
    stderr: canonicalBase64Bytes(envelope.stderrBase64, "Linux-memfd-Validator-stderr")
  };
}
function decodeGermanyOperationalNestedAnnualRun(stdout, runnerProof) {
  invariant5(
    Buffer.isBuffer(stdout) && stdout.length > 0 && stdout.length <= 2 * 1024 * 1024,
    "Annual-v2-Rust-Executor lieferte keinen begrenzten verschachtelten Launcherbeleg."
  );
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
  } catch (error) {
    throw new Error("Annual-v2-Rust-Executor lieferte keinen einzelnen verschachtelten Launcherbeleg.", { cause: error });
  }
  exactKeys3(
    envelope,
    ["anchorBytes", "anchorSha256", "status", "signal", "stdoutBase64", "stderrBase64"],
    "Annual-v2-verschachtelter Systemlauncher-Beleg"
  );
  invariant5(
    envelope.anchorBytes === runnerProof.bundle.bytes && envelope.anchorSha256 === runnerProof.bundle.sha256,
    "Annual-v2-verschachtelter Systemlauncher startete andere Bundle-Bytes."
  );
  invariant5(
    envelope.status === 0 && envelope.signal === null,
    "Annual-v2-verschachtelter Systemlauncher besitzt keinen erfolgreichen eindeutigen Abschluss."
  );
  const nestedStderr = canonicalBase64Bytes(envelope.stderrBase64, "Annual-v2-verschachtelter Systemlauncher-stderr");
  invariant5(nestedStderr.length === 0, "Annual-v2-verschachtelter Systemlauncher erzeugte unerwartete stderr-Bytes.");
  const nestedStdout = canonicalBase64Bytes(envelope.stdoutBase64, "Annual-v2-verschachtelter Systemlauncher-stdout");
  const captured = parseSingleStructuredStdout(nestedStdout, 1024 * 1024);
  exactKeys3(
    captured.value,
    ["activationEligible", "candidateProduced", "nativeReceipt", "status", "unresolvedRequired"],
    "Annual-v2-kausaler Capture-Abschluss"
  );
  invariant5(
    captured.value.status === "captured" && captured.value.candidateProduced === true && captured.value.activationEligible === true && captured.value.unresolvedRequired === 0,
    "Annual-v2-kausaler Capture-Abschluss ist nicht aktivierungsfaehig."
  );
  exactKeys3(captured.value.nativeReceipt, ["bytes", "file", "sha256"], "Annual-v2-kausaler Native-Receipt-Beleg");
  positiveInteger(captured.value.nativeReceipt.bytes, "Annual-v2-kausaler Native-Receipt-Beleg.bytes");
  sha2562(captured.value.nativeReceipt.sha256, "Annual-v2-kausaler Native-Receipt-Beleg.sha256");
  portablePath(captured.value.nativeReceipt.file, "Annual-v2-kausaler Native-Receipt-Beleg.file");
  return {
    capture: captured.value,
    launcher: {
      anchorBytes: envelope.anchorBytes,
      anchorSha256: envelope.anchorSha256,
      status: envelope.status,
      signal: envelope.signal,
      stdout: captured.proof
    }
  };
}
async function withGermanyOperationalHeldOutputFiles({ workspaceRoot: workspaceRoot2, files, callback }) {
  invariant5(process.platform === "win32", "Annual-v2-Outputbindung ist ausschliesslich fuer Windows definiert.");
  invariant5(
    Array.isArray(files) && files.length > 0 && files.length <= 4 && typeof callback === "function",
    "Annual-v2-Outputbindung benoetigt eine begrenzte nichtleere Dateimenge."
  );
  const root2 = resolve5(workspaceRoot2);
  const prepared = [];
  const seen = /* @__PURE__ */ new Set();
  let callbackResult;
  try {
    for (const [index, entry] of files.entries()) {
      invariant5(isRecord3(entry), `Annual-v2-Output[${index}] ist kein Objekt.`);
      exactKeys3(entry, ["captureBytes", "label", "path", "proof"], `Annual-v2-Output[${index}]`);
      invariant5(
        typeof entry.label === "string" && entry.label.length > 0,
        `Annual-v2-Output[${index}].label fehlt.`
      );
      invariant5(
        typeof entry.path === "string" && isAbsolute3(entry.path),
        `Annual-v2-Output[${index}].path ist nicht absolut.`
      );
      invariant5(typeof entry.captureBytes === "boolean", `Annual-v2-Output[${index}].captureBytes ist ungueltig.`);
      fileProof3(entry.proof, `Annual-v2-Output[${index}].proof`);
      const path = resolve5(entry.path);
      const file = portableRelative(root2, path, `Annual-v2-Output[${index}]`);
      invariant5(file === entry.proof.file, `Annual-v2-Output[${index}] bindet einen anderen Pfad als sein Native-Receipt.`);
      invariant5(!seen.has(comparableResolvedPath(path)), "Annual-v2-Outputbindung enthaelt doppelte Pfade.");
      seen.add(comparableResolvedPath(path));
      await assertCanonicalRepositoryPath(root2, path, `Annual-v2-Output[${index}]`);
      const pathBefore = await lstat5(path, { bigint: true });
      invariant5(pathBefore.isFile() && !pathBefore.isSymbolicLink(), `Annual-v2-Output[${index}] ist keine regulaere Datei.`);
      const handle = await open5(path, "r");
      prepared.push({ ...entry, file, handle, identity: pathBefore });
      const held = await handle.stat({ bigint: true });
      invariant5(sameIdentity4(pathBefore, held), `Annual-v2-Output[${index}] driftete vor der gehaltenen Pruefung.`);
    }
    const proofs = {};
    const capturedBytes = {};
    for (const entry of prepared) {
      const actual = await proofFromHandle(entry.handle, entry.label);
      invariant5(
        actual.proof.bytes === entry.proof.bytes && actual.proof.sha256 === entry.proof.sha256,
        `${entry.label} driftet vom kausalen Native-Receipt.`
      );
      proofs[entry.label] = { file: entry.file, ...actual.proof };
      if (entry.captureBytes) {
        invariant5(entry.proof.bytes <= 16 * 1024 * 1024, `${entry.label} ist fuer gehaltene Inhaltsbindung zu gross.`);
        capturedBytes[entry.label] = await bytesFromHandle(entry.handle, entry.proof, entry.label);
      }
    }
    callbackResult = await callback({ proofs, capturedBytes });
    for (const entry of prepared) {
      const after = await proofFromHandle(entry.handle, `${entry.label} nach Outer-Receipt-Materialisierung`);
      const pathAfter = await lstat5(entry.path, { bigint: true });
      invariant5(
        sameIdentity4(entry.identity, after.identity) && sameIdentity4(after.identity, pathAfter) && after.proof.bytes === entry.proof.bytes && after.proof.sha256 === entry.proof.sha256,
        `${entry.label} driftete waehrend der Outer-Receipt-Materialisierung.`
      );
    }
    return callbackResult;
  } finally {
    await Promise.allSettled(prepared.map(({ handle }) => handle.close()));
  }
}
async function executeGermanyOperationalPinnedAnnualExecutor({
  workspaceRoot: workspaceRoot2,
  executionPinsSource,
  runnerProof,
  runnerPhase = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_PHASE,
  inputPaths,
  rustArgumentPaths,
  annualLaunchProofBase64
}) {
  invariant5(process.platform === "win32", "Annual-v2-Executor-Supervision ist ausschliesslich fuer Windows definiert.");
  const phaseContract = runnerPhase === "materialize-annual-plan-evidence-v1" ? {
    command: "plan",
    inputCount: 3,
    rustArgumentCount: 3,
    timeoutMilliseconds: GERMANY_OPERATIONAL_ANNUAL_PLAN_TIMEOUT_MILLISECONDS
  } : runnerPhase === "execute-annual-operational-v2-v1" ? {
    command: "run-annual-operational-v2",
    inputCount: 6,
    rustArgumentCount: 4,
    timeoutMilliseconds: GERMANY_OPERATIONAL_ANNUAL_RUN_TIMEOUT_MILLISECONDS
  } : null;
  invariant5(phaseContract !== null, "Annual-v2-Executor-Supervision besitzt keine gebundene Runnerphase.");
  invariant5(
    Array.isArray(inputPaths) && inputPaths.length === phaseContract.inputCount && Array.isArray(rustArgumentPaths) && rustArgumentPaths.length === phaseContract.rustArgumentCount,
    "Annual-v2-Executor-Supervision besitzt eine falsche Input- oder Rust-Argumentzahl."
  );
  const root2 = resolve5(workspaceRoot2);
  const pins = validateGermanyOperationalExecutionPins(executionPinsSource.value);
  const runnerBefore = await proveGermanyOperationalExecutionContext({
    workspaceRoot: root2,
    executionPins: pins
  });
  invariant5(
    sameCanonical(runnerProof, runnerBefore),
    "Annual-v2-Executor-Supervision driftete von der gehaltenen Runner-Closure."
  );
  const annualLaunch = await proveGermanyOperationalAnnualLaunchFromEnvironment({
    workspaceRoot: root2,
    executionPinsSource,
    encodedProof: annualLaunchProofBase64 ?? process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANNUAL_LAUNCH_PROOF_BASE64
  });
  const heldInputs = [];
  for (const [index, inputPath] of inputPaths.entries()) {
    const path = resolve5(inputPath);
    await assertCanonicalRepositoryPath(root2, path, `Annual-v2-Supervisor-Input[${index}]`);
    const source = await readPinnedRegularFile(path, `Annual-v2-Supervisor-Input[${index}]`, 16 * 1024 * 1024);
    heldInputs.push({
      file: portableRelative(root2, path, `Annual-v2-Supervisor-Input[${index}]`),
      path,
      ...source.proof
    });
  }
  const rustArguments = rustArgumentPaths.map((path, index) => {
    const absolute = resolve5(path);
    invariant5(
      comparableResolvedPath(absolute) === comparableResolvedPath(heldInputs[index].path),
      `Annual-v2-Rust-Argument[${index}] bindet nicht den entsprechenden gehaltenen Input.`
    );
    return absolute;
  });
  const executorPath = resolvePortable(root2, pins.validator.file, "Annual-v2-gepinnter Rust-Executor");
  await assertCanonicalRepositoryPath(root2, executorPath, "Annual-v2-gepinnter Rust-Executor");
  const executor = await readPinnedRegularFile(executorPath, "Annual-v2-gepinnter Rust-Executor", 64 * 1024 * 1024);
  invariant5(
    executor.proof.bytes === pins.validator.bytes && executor.proof.sha256 === pins.validator.sha256,
    "Annual-v2-Rust-Executor driftet von den Execution-Pins."
  );
  const anchorHelperPath = resolvePortable(root2, pins.runner.anchorHelper.file, "Annual-v2-Windows-Anchor-Helper");
  const result = await executeWindowsExclusiveHandleValidator({
    executionPath: executorPath,
    expected: executor.proof,
    anchorHelperPath,
    anchorHelper: pins.runner.anchorHelper,
    inputFiles: heldInputs,
    arguments: [phaseContract.command, ...rustArguments],
    cwd: root2,
    maximumBytes: pins.command.stdoutMaxBytes,
    timeoutMilliseconds: phaseContract.timeoutMilliseconds
  });
  invariant5(
    result.signal === null && result.status === 0,
    `Gehaltene Annual-v2-Rust-Executor-Phase scheiterte mit Exit ${result.status}: ${result.stderr.toString("utf8").slice(0, 2048)}`
  );
  const runnerAfter = await proveGermanyOperationalExecutionContext({
    workspaceRoot: root2,
    executionPins: pins
  });
  invariant5(
    sameCanonical(runnerBefore, runnerAfter),
    "Annual-v2-Runner-/Importclosure driftete waehrend der Executor-Phase."
  );
  return {
    annualLaunch,
    executionPins: { ...executionPinsSource.proof },
    inputs: result.inputProofs,
    invocation: {
      arguments: [phaseContract.command, ...rustArguments.map((path) => portableRelative(root2, path, "Annual-v2-Rust-Argument"))],
      command: phaseContract.command,
      phase: runnerPhase
    },
    job: {
      mode: "windows-kill-on-job-close-root-exit-bounded-io-v1",
      timeoutMilliseconds: phaseContract.timeoutMilliseconds
    },
    runner: runnerAfter,
    trustedExecutor: {
      buildCommit: pins.validator.buildCommit,
      bytes: pins.validator.bytes,
      file: pins.validator.file,
      sha256: pins.validator.sha256
    },
    exit: { code: result.status, signal: result.signal },
    stdout: result.stdout,
    stderr: result.stderr
  };
}
async function executeGermanyOperationalPinnedValidator({
  workspaceRoot: workspaceRoot2,
  executionPinsSource,
  runnerProof,
  validatorRebuild,
  specificationPath,
  sourceRoot,
  candidatePath,
  reportPath,
  annualLaunchProofBase64,
  runnerPhase = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_PHASE,
  hooks = {}
}) {
  const root2 = resolve5(workspaceRoot2);
  const pins = validateGermanyOperationalExecutionPins(executionPinsSource.value);
  const runnerBefore = await proveGermanyOperationalExecutionContext({ workspaceRoot: root2, executionPins: pins, verifyCurrentInvocation: false });
  invariant5(sameCanonical(runnerProof, runnerBefore), "Operational-v2-Runner-/Importclosure driftete vor der Validator-Ausfuehrung.");
  const annualLaunch = process.platform === "win32" ? await proveGermanyOperationalAnnualLaunchFromEnvironment({
    workspaceRoot: root2,
    executionPinsSource,
    encodedProof: annualLaunchProofBase64 ?? process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANNUAL_LAUNCH_PROOF_BASE64
  }) : void 0;
  invariant5(
    runnerPhase === "derive-and-capture-v1",
    "Operational-v2-Native-Validator darf nur in der gebundenen Derive-and-Capture-Phase starten."
  );
  const preservedPath = resolvePortable(root2, pins.validator.file, "Operational-v2-preserved-Validator");
  const prefixFiles = new Set(pins.command.argumentFiles.map(({ file }) => file));
  const argumentPrefix = pins.command.argumentPrefix.map((argument) => prefixFiles.has(argument) ? resolvePortable(root2, argument, "Operational-v2-Native-Argumentdatei") : argument);
  const argumentFiles = [];
  for (const expected of pins.command.argumentFiles) {
    const source = await readPinnedRegularFile(resolvePortable(root2, expected.file, `Operational-v2-Argumentdatei ${expected.file}`), `Operational-v2-Argumentdatei ${expected.file}`);
    const actual = { file: expected.file, ...source.proof };
    invariant5(sameCanonical(actual, expected), `Operational-v2-Argumentdatei ${expected.file} driftet von ihrem unveraenderlichen Byte-Pin.`);
    argumentFiles.push(actual);
  }
  const portableArguments = [
    pins.command.name,
    portableRelative(root2, specificationPath, "Operational-v2-Aufrufsspezifikation"),
    portableWorkspaceRootOrRelative(root2, sourceRoot, "Operational-v2-Aufrufsquellwurzel"),
    portableRelative(root2, candidatePath, "Operational-v2-Aufrufscandidate"),
    portableRelative(root2, reportPath, "Operational-v2-Aufrufsbericht")
  ];
  const nativeArguments = [pins.command.name, resolve5(specificationPath), resolve5(sourceRoot), resolve5(candidatePath), resolve5(reportPath)];
  const executionDirectory = await mkdtemp4(join4(dirname5(resolve5(candidatePath)), ".operational-v2-exec-retained-owned-cleanup-"));
  const executionDirectoryIdentity = await lstat5(executionDirectory, { bigint: true });
  invariant5(executionDirectoryIdentity.isDirectory() && !executionDirectoryIdentity.isSymbolicLink(), "Operational-v2-Ausfuehrungsverzeichnis ist kein eigenes regulaeres Verzeichnis.");
  const executionPath = join4(executionDirectory, process.platform === "win32" ? "validator.exe" : "validator");
  const executionAnchorPath = join4(executionDirectory, ".validator.ownership-anchor");
  let preservedHandle;
  let executionHandle;
  let executionAnchorHandle;
  let executionCreated = false;
  let executionAnchorCreated = false;
  let failure;
  try {
    preservedHandle = await open5(preservedPath, "r");
    const preservedBefore = await proofFromHandle(preservedHandle, "Operational-v2-preserved-Validator vor Ausfuehrung");
    const preservedPathBefore = await lstat5(preservedPath, { bigint: true });
    invariant5(preservedPathBefore.isFile() && !preservedPathBefore.isSymbolicLink() && sameIdentity4(preservedBefore.identity, preservedPathBefore), "Operational-v2-preserved-Validatorpfad bindet nicht den gehaltenen Handle.");
    invariant5(preservedBefore.proof.bytes === pins.validator.bytes && preservedBefore.proof.sha256 === pins.validator.sha256, "Operational-v2-preserved-Validator driftet von Execution-Pins.");
    executionHandle = await open5(executionPath, "wx+", 448);
    executionCreated = true;
    const copied = await copyHeldFile(preservedHandle, executionHandle, "Operational-v2-Ausfuehrungskopie");
    invariant5(copied.bytes === pins.validator.bytes && copied.sha256 === pins.validator.sha256, "Operational-v2-Ausfuehrungskopie driftet vom preserved Validator.");
    const executionBefore = await proofFromHandle(executionHandle, "Operational-v2-Ausfuehrungskopie vor Start");
    const executionPathBefore = await lstat5(executionPath, { bigint: true });
    invariant5(executionPathBefore.isFile() && !executionPathBefore.isSymbolicLink() && sameIdentity4(executionBefore.identity, executionPathBefore), "Operational-v2-Ausfuehrungspfad bindet nicht den gehaltenen Copy-Handle.");
    await link4(executionPath, executionAnchorPath);
    executionAnchorCreated = true;
    executionAnchorHandle = await open5(executionAnchorPath, "r");
    const [anchorHandleBefore, anchorPathBefore] = await Promise.all([
      executionAnchorHandle.stat({ bigint: true }),
      lstat5(executionAnchorPath, { bigint: true })
    ]);
    invariant5(
      anchorPathBefore.isFile() && !anchorPathBefore.isSymbolicLink() && sameIdentity4(executionBefore.identity, anchorHandleBefore) && sameIdentity4(anchorHandleBefore, anchorPathBefore),
      "Operational-v2-Ausfuehrungskopie besitzt keinen gehaltenen Ownership-Anker."
    );
    await executionHandle.close();
    executionHandle = void 0;
    executionHandle = await open5(executionPath, "r");
    const [reopenedHandle, reopenedPath] = await Promise.all([
      executionHandle.stat({ bigint: true }),
      lstat5(executionPath, { bigint: true })
    ]);
    invariant5(
      reopenedPath.isFile() && !reopenedPath.isSymbolicLink() && sameIdentity4(executionBefore.identity, reopenedHandle) && sameIdentity4(anchorHandleBefore, reopenedHandle) && sameIdentity4(reopenedHandle, reopenedPath),
      "Operational-v2-Ausfuehrungspfad driftete beim Wechsel auf gehaltene Lesehandles."
    );
    await hooks.beforeValidatorSpawn?.({ executionPath, executionAnchorPath });
    const launchArguments = [...argumentPrefix, ...nativeArguments];
    let executionMode;
    let result;
    if (process.platform === "win32") {
      executionMode = "windows-exclusive-handle-launch-v1";
      const anchorHelperPath = resolvePortable(root2, pins.runner.anchorHelper.file, "Operational-v2-Windows-Anchor-Helper");
      result = await executeWindowsExclusiveHandleValidator({
        executionPath,
        expected: executionBefore.proof,
        anchorHelperPath,
        anchorHelper: pins.runner.anchorHelper,
        arguments: launchArguments,
        cwd: root2,
        maximumBytes: pins.command.stdoutMaxBytes
      });
    } else if (process.platform === "linux") {
      executionMode = "linux-sealed-memfd-launch-v1";
      const binary = await bytesFromHandle(executionHandle, executionBefore.proof, "Operational-v2-Ausfuehrungskopie fuer versiegelten Linux-memfd-Start");
      result = await executeLinuxSealedMemfdValidator({
        binary,
        expected: executionBefore.proof,
        arguments: launchArguments,
        cwd: root2,
        maximumBytes: pins.command.stdoutMaxBytes
      });
    } else {
      throw new Error(`Operational-v2 besitzt fuer ${process.platform} keinen kausal bytegebundenen Validator-Launcher.`);
    }
    invariant5(result.signal === null, `Nativer Operational-v2-Validator wurde durch Signal ${result.signal} abgebrochen.`);
    invariant5(result.status === 0, `Nativer Operational-v2-Validator endete mit Exit ${result.status}.`);
    const structured = parseSingleStructuredStdout(result.stdout, pins.command.stdoutMaxBytes);
    const [preservedAfter, preservedPathAfter, executionAfter, anchorHandleAfter, executionPathAfter, anchorPathAfter, runnerAfter, argumentFilesAfter, executionPinsAfter] = await Promise.all([
      proofFromHandle(preservedHandle, "Operational-v2-preserved-Validator nach Ausfuehrung"),
      lstat5(preservedPath, { bigint: true }),
      proofFromHandle(executionHandle, "Operational-v2-Ausfuehrungskopie nach Ausfuehrung"),
      executionAnchorHandle.stat({ bigint: true }),
      lstat5(executionPath, { bigint: true }),
      lstat5(executionAnchorPath, { bigint: true }),
      proveGermanyOperationalExecutionContext({ workspaceRoot: root2, executionPins: pins, verifyCurrentInvocation: false }),
      Promise.all(pins.command.argumentFiles.map(async (expected) => {
        const source = await readPinnedRegularFile(resolvePortable(root2, expected.file, `Operational-v2-Argumentdatei ${expected.file} nach Ausfuehrung`), `Operational-v2-Argumentdatei ${expected.file} nach Ausfuehrung`);
        const actual = { file: expected.file, ...source.proof };
        invariant5(sameCanonical(actual, expected), `Operational-v2-Argumentdatei ${expected.file} driftet nach Ausfuehrung von ihrem unveraenderlichen Byte-Pin.`);
        return actual;
      })),
      readPinnedRegularFile(
        resolvePortable(root2, executionPinsSource.proof.file, "Operational-v2-Execution-Pins nach Ausfuehrung"),
        "Operational-v2-Execution-Pins nach Ausfuehrung"
      )
    ]);
    invariant5(
      preservedPathAfter.isFile() && !preservedPathAfter.isSymbolicLink() && sameCanonical(preservedBefore.proof, preservedAfter.proof) && sameIdentity4(preservedBefore.identity, preservedAfter.identity) && sameIdentity4(preservedAfter.identity, preservedPathAfter),
      "Operational-v2-preserved-Validator driftete waehrend der Ausfuehrung."
    );
    invariant5(sameCanonical(executionBefore.proof, executionAfter.proof) && sameIdentity4(executionBefore.identity, executionAfter.identity), "Operational-v2-Ausfuehrungskopie driftete waehrend der Ausfuehrung.");
    invariant5(
      executionPathAfter.isFile() && !executionPathAfter.isSymbolicLink() && anchorPathAfter.isFile() && !anchorPathAfter.isSymbolicLink() && sameIdentity4(executionBefore.identity, anchorHandleAfter) && sameIdentity4(anchorHandleAfter, executionPathAfter) && sameIdentity4(executionPathAfter, anchorPathAfter),
      "Operational-v2-Ausfuehrungspfad oder Ownership-Anker driftete waehrend der Ausfuehrung."
    );
    invariant5(sameCanonical(runnerProof, runnerAfter), "Operational-v2-Runner-/Importclosure driftete waehrend der Validator-Ausfuehrung.");
    invariant5(sameCanonical(argumentFiles, argumentFilesAfter), "Operational-v2-Argumentdateien drifteten waehrend der Validator-Ausfuehrung.");
    invariant5(sameCanonical(executionPinsSource.proof, {
      file: executionPinsSource.proof.file,
      ...executionPinsAfter.proof,
      schema: executionPinsSource.proof.schema
    }), "Operational-v2-Execution-Pins drifteten waehrend der Validator-Ausfuehrung.");
    const proof = {
      schema: GERMANY_OPERATIONAL_EXECUTION_PROOF_SCHEMA,
      executionPinsSha256: executionPinsSource.proof.sha256,
      ...annualLaunch === void 0 ? {} : { annualLaunch },
      runner: runnerProof,
      validator: {
        buildCommit: pins.validator.buildCommit,
        preserved: { file: pins.validator.file, ...preservedBefore.proof },
        executed: { mode: executionMode, ...executionBefore.proof }
      },
      rebuild: {
        specification: { ...validatorRebuild.specification },
        evidence: { ...validatorRebuild.evidence },
        sourceCommit: validatorRebuild.sourceCommit
      },
      invocation: {
        command: pins.command.name,
        argumentPrefix: [...pins.command.argumentPrefix],
        argumentFiles,
        arguments: portableArguments
      },
      stdout: structured.proof,
      exit: { code: 0, signal: null }
    };
    validateGermanyOperationalExecutionProofAgainstPins(proof, pins, { nativeReceipt: structured.value });
    return { nativeReceipt: structured.value, executionProof: proof };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    const knownEntries = /* @__PURE__ */ new Set([basename5(executionPath), basename5(executionAnchorPath)]);
    if (executionHandle !== void 0) await executionHandle.close().catch((error) => cleanupErrors.push(error));
    if (executionAnchorHandle !== void 0) await executionAnchorHandle.close().catch((error) => cleanupErrors.push(error));
    if (preservedHandle !== void 0) await preservedHandle.close().catch((error) => cleanupErrors.push(error));
    await hooks.beforeExecutionDirectoryRetentionCheck?.({ executionDirectory }).catch((error) => cleanupErrors.push(error));
    let rootOwned = await lstat5(executionDirectory, { bigint: true }).then((current) => current.isDirectory() && !current.isSymbolicLink() && sameNodeIdentity(current, executionDirectoryIdentity)).catch((error) => {
      cleanupErrors.push(error);
      return false;
    });
    if (!rootOwned) {
      cleanupErrors.push(new Error("Operational-v2-Ausfuehrungsverzeichnis wurde vor der retained-owned-Cleanup-Pruefung fremd ersetzt; kein Pfad wurde veraendert."));
    }
    const retainedEntries = rootOwned ? await readdir3(executionDirectory).catch((error) => {
      cleanupErrors.push(error);
      rootOwned = false;
      return null;
    }) : null;
    if (retainedEntries !== null && retainedEntries.some((entry) => !knownEntries.has(entry))) {
      cleanupErrors.push(new Error("Operational-v2-Ausfuehrungsverzeichnis enthaelt fremde Dateien und bleibt am unveraenderten Pfad vollstaendig erhalten."));
    }
    if (cleanupErrors.length > 0) {
      if (failure !== void 0) throw new AggregateError([failure, ...cleanupErrors], "Operational-v2-Ausfuehrung und owned-only Cleanup sind fehlgeschlagen.");
      throw new AggregateError(cleanupErrors, "Operational-v2-Ausfuehrungs-Cleanup ist fehlgeschlagen.");
    }
  }
}
function integratedGermanyOperationalProvenance({ executionPinsProof, executionProof, nativeReceipt }) {
  const value = {
    schema: GERMANY_OPERATIONAL_PROVENANCE_SCHEMA,
    producerKind: GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND,
    releaseEvidenceEligible: true,
    productionActivationEligible: true,
    executionPins: { ...executionPinsProof },
    executionProof
  };
  return validateGermanyOperationalProvenance(value, { nativeReceipt });
}

// tools/region-import/germany/operational-infrastructure-v2-outer-execution-receipt.mjs
var MAX_SMALL_BYTES = 64 * 1024 * 1024;

// tools/region-import/germany/operational-validator-rebuild-evidence.mjs
import { createHash as createHash6, randomUUID as randomUUID2 } from "node:crypto";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  lstat as lstat6,
  open as open6,
  readFile as readFile5,
  readdir as readdir4,
  realpath as realpath5
} from "node:fs/promises";
import { dirname as dirname6, isAbsolute as isAbsolute4, relative as relative4, resolve as resolve6, sep as sep4, win32 } from "node:path";
var SPEC_SCHEMA = "zugfolge-operational-validator-rebuild-spec/v3";
var EVIDENCE_SCHEMA = "zugfolge-operational-validator-rebuild-evidence/v3";
var PROVENANCE_SCHEMA = "zugfolge-operational-validator-rebuild-provenance/v2";
var TOOLCHAIN_MANIFEST_SCHEMA = "zugfolge-operational-validator-toolchain-manifest/v1";
var PRODUCER_BUNDLE = "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs";
var PRODUCER_ENTRYPOINT = "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs";
var PRODUCER_EXECUTION_PINS = "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json";
var PRODUCER_IMPLEMENTATION = "tools/region-import/germany/operational-validator-rebuild-evidence.mjs";
var WINDOWS_ANCHOR_HELPER = "tools/region-import/germany/operational-windows-anchor-helper.dll";
var ANNUAL_DIRECT_CONTRACT = "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json";
var ANNUAL_PLAN_FILE = "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json";
var ANNUAL_EXECUTOR_START_EVIDENCE = "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json";
var ANNUAL_CREATE_NEW_COMPLETION_SUFFIX = ".zugfolge-complete.json";
var ANNUAL_PLAN_ARGUMENTS = Object.freeze([
  "plan",
  "tools/region-import/germany/release.annual-2026.5.config.json",
  "tools/region-import/germany/source-catalog.json",
  "tools/guards/quellenregister.json"
]);
var PRODUCER_IDS = Object.freeze(["bundle", "entrypoint", "executionPins", "implementation"]);
var MAX_BINARY_BYTES = 8 * 1024 * 1024;
var MAX_JSON_BYTES = 4 * 1024 * 1024;
var MAX_PROVENANCE_BYTES = 4 * 1024 * 1024;
var MAX_SPEC_BYTES = 1024 * 1024;
var MAX_PRODUCER_BYTES = 2 * 1024 * 1024;
var MAX_TOOL_BYTES = 512 * 1024 * 1024;
var MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
var MAX_VENDOR_ARCHIVE_BYTES = 1024 * 1024 * 1024;
var MAX_TOOLCHAIN_MANIFEST_BYTES = 4 * 1024 * 1024;
var MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
var MAX_SOURCE_TREE_ENTRIES = 1e5;
var MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
var MAX_WINDOWS_ANCHOR_DIAGNOSTIC_BYTES = 512;
var SHA2565 = /^[a-f0-9]{64}$/;
var GIT_COMMIT2 = /^[a-f0-9]{40}$/;
var PORTABLE_FILE = /^(?![A-Za-z]:)(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
var WINDOWS_RESERVED_SEGMENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
var RELEASE_ID = /^infra-deutschland-20\d{2}\.[1-9]\d*$/;
var VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
var TARGET = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+$/;
var EXPECTED_BUILD_COMMAND = Object.freeze([
  "cargo",
  "--config",
  "$PINNED_CARGO_CONFIG",
  "build",
  "--manifest-path",
  "$PINNED_CARGO_MANIFEST",
  "--locked",
  "--offline",
  "--release",
  "-p",
  "zugfolge-infra",
  "--bin",
  "zugfolge-infra-release"
]);
var WINDOWS_BUILD_ANCHOR_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public sealed class ZugfolgeNtCreateException : InvalidOperationException {
  public int Status { get; private set; }
  internal ZugfolgeNtCreateException(int status)
    : base("NtCreateFile ist fehlgeschlagen: 0x" + status.ToString("x8")) { Status = status; }
}
public sealed class ZugfolgeEphemeralAccount : IDisposable {
  private const uint ERROR_INVALID_PARAMETER = 87u;
  private const uint NERR_USER_NOT_FOUND = 2221u;
  private const uint USER_PRIV_USER = 1u;
  private const uint UF_SCRIPT = 0x00000001u;
  private const uint UF_NORMAL_ACCOUNT = 0x00000200u;
  [StructLayout(LayoutKind.Sequential)]
  private struct TOKEN_ELEVATION { public uint TokenIsElevated; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct USER_INFO_1 {
    [MarshalAs(UnmanagedType.LPWStr)] public string Name;
    [MarshalAs(UnmanagedType.LPWStr)] public string Password;
    public uint PasswordAge;
    public uint Privilege;
    [MarshalAs(UnmanagedType.LPWStr)] public string HomeDirectory;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public uint Flags;
    [MarshalAs(UnmanagedType.LPWStr)] public string ScriptPath;
  }
  [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetTokenInformation(IntPtr token, int informationClass,
    out TOKEN_ELEVATION information, uint informationBytes, out uint returnedBytes);
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = false)]
  private static extern uint NetUserAdd(string server, uint level, ref USER_INFO_1 user, out uint parameterError);
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = false)]
  private static extern uint NetUserDel(string server, string user);
  [DllImport("netapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = false)]
  private static extern uint NetUserGetInfo(string server, string user, uint level, out IntPtr buffer);
  [DllImport("netapi32.dll", ExactSpelling = true, SetLastError = false)]
  private static extern uint NetApiBufferFree(IntPtr buffer);
  public string Username { get; private set; }
  public string Domain { get; private set; }
  public string Password { get; private set; }
  public string Sid { get; private set; }
  private bool active;
  private ZugfolgeEphemeralAccount() {}
  public static bool CurrentProcessHasElevatedAdministratorToken() {
    using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
      TOKEN_ELEVATION elevation;
      uint returnedBytes;
      if (!GetTokenInformation(identity.Token, 20, out elevation,
          (uint)Marshal.SizeOf(typeof(TOKEN_ELEVATION)), out returnedBytes)
          || returnedBytes != (uint)Marshal.SizeOf(typeof(TOKEN_ELEVATION))) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation(TokenElevation)");
      }
      return elevation.TokenIsElevated != 0
        && new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }
  }
  public static ZugfolgeEphemeralAccount Create() {
    ZugfolgeEphemeralAccount account = new ZugfolgeEphemeralAccount();
    account.Username = "zfrb" + Guid.NewGuid().ToString("N").Substring(0, 12);
    account.Domain = Environment.MachineName;
    byte[] random = new byte[32]; using (RandomNumberGenerator generator = RandomNumberGenerator.Create()) generator.GetBytes(random);
    account.Password = "Zf!1" + Convert.ToBase64String(random).Replace("/", "x").Replace("+", "y");
    // NetUserAdd level 1 requires USER_PRIV_USER and UF_SCRIPT.  Bind exactly
    // one documented account type; the one-shot lifetime makes persistent
    // password-control flags unnecessary and avoids their additional access
    // requirements.
    USER_INFO_1 user = new USER_INFO_1 {
      Name = account.Username, Password = account.Password, PasswordAge = 0, Privilege = USER_PRIV_USER,
      HomeDirectory = null, Comment = null, Flags = UF_SCRIPT | UF_NORMAL_ACCOUNT, ScriptPath = null,
    };
    uint parameterError; uint result = NetUserAdd(null, 1, ref user, out parameterError);
    if (result != 0) {
      string diagnostic = "ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_ADD status="
        + result.ToString(System.Globalization.CultureInfo.InvariantCulture);
      if (result == ERROR_INVALID_PARAMETER) diagnostic += " parameter="
        + parameterError.ToString(System.Globalization.CultureInfo.InvariantCulture);
      throw new InvalidOperationException(diagnostic);
    }
    account.active = true;
    try {
      account.Sid = ((SecurityIdentifier)new NTAccount(account.Domain, account.Username).Translate(typeof(SecurityIdentifier))).Value;
      return account;
    } catch { account.Dispose(); throw; }
  }
  public void Dispose() {
    if (!active) return;
    uint result = NetUserDel(null, Username);
    if (result != 0 && result != NERR_USER_NOT_FOUND) throw new InvalidOperationException(
      "ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_DELETE status="
      + result.ToString(System.Globalization.CultureInfo.InvariantCulture));
    IntPtr buffer = IntPtr.Zero;
    uint lookup = NetUserGetInfo(null, Username, 0, out buffer);
    try {
      if (lookup != NERR_USER_NOT_FOUND) throw new InvalidOperationException(
        "ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_DELETE_VERIFY status="
        + lookup.ToString(System.Globalization.CultureInfo.InvariantCulture));
    } finally {
      if (buffer != IntPtr.Zero) NetApiBufferFree(buffer);
    }
    active = false; Password = null;
  }
}
public sealed class ZugfolgeProtectedSecurityDescriptor : IDisposable {
  internal IntPtr Pointer { get; private set; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
    string securityDescriptor, uint revision, out IntPtr descriptor, out uint descriptorBytes);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);
  private ZugfolgeProtectedSecurityDescriptor(string sddl) {
    uint bytes;
    IntPtr descriptor;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out bytes)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "ConvertStringSecurityDescriptorToSecurityDescriptor");
    }
    Pointer = descriptor;
  }
  public static ZugfolgeProtectedSecurityDescriptor ReadExecute(string currentSid, string buildSid) {
    if (String.IsNullOrEmpty(currentSid) || String.IsNullOrEmpty(buildSid)) throw new ArgumentException("Current/Build SID fehlt.");
    const uint denied = 0x000d0156u;
    string sddl = "D:P(D;;0x" + denied.ToString("x8") + ";;;" + currentSid + ")"
      + "(D;;0x" + denied.ToString("x8") + ";;;S-1-3-4)"
      + "(A;;0x001200a9;;;" + currentSid + ")"
      + "(A;;0x001200a9;;;" + buildSid + ")"
      + "(A;;FA;;;SY)(A;;FA;;;BA)";
    return new ZugfolgeProtectedSecurityDescriptor(sddl);
  }
  public static ZugfolgeProtectedSecurityDescriptor IsolatedWritable(string currentSid, string buildSid) {
    if (String.IsNullOrEmpty(currentSid) || String.IsNullOrEmpty(buildSid)) throw new ArgumentException("Current/Build SID fehlt.");
    const uint denied = 0x000d0156u;
    string sddl = "D:P(D;OICI;0x" + denied.ToString("x8") + ";;;" + currentSid + ")"
      // OWNER_RIGHTS is intentionally root-only.  The Anchor creates the root,
      // so this removes the creator-owner WRITE_DAC escape from the runner
      // account.  Build-account-owned descendants must not inherit this deny,
      // otherwise Cargo could not update files it creates itself.
      + "(D;;0x" + denied.ToString("x8") + ";;;S-1-3-4)"
      + "(A;OICI;0x001200a9;;;" + currentSid + ")"
      + "(A;OICI;FA;;;" + buildSid + ")"
      + "(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
    return new ZugfolgeProtectedSecurityDescriptor(sddl);
  }
  public static ZugfolgeProtectedSecurityDescriptor ParentWritable(string currentSid) {
    if (String.IsNullOrEmpty(currentSid)) throw new ArgumentException("Current SID fehlt.");
    return new ZugfolgeProtectedSecurityDescriptor("D:P(A;OICI;FA;;;" + currentSid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
  }
  public void Dispose() {
    IntPtr pointer = Pointer; Pointer = IntPtr.Zero;
    if (pointer != IntPtr.Zero) LocalFree(pointer);
  }
}
public sealed class ZugfolgeHeldPublication : IDisposable {
  private readonly object gate = new object();
  private FileStream stream;
  private int state;
  public long Bytes { get; private set; }
  public string Sha256 { get; private set; }
  public string Identity { get; private set; }
  internal ZugfolgeHeldPublication(FileStream value, long bytes, string sha256, string identity) {
    stream = value; Bytes = bytes; Sha256 = sha256; Identity = identity; state = 0;
  }
  public void Commit() {
    lock (gate) {
      if (state == 1 || state == 3) return;
      if (state != 0) throw new InvalidOperationException("Publikation wurde bereits zurueckgerollt.");
      state = 1;
    }
  }
  public void Rollback() {
    lock (gate) {
      if (state == 2) return;
      if (state == 1) throw new InvalidOperationException("Committed Publikation darf nicht zurueckgerollt werden.");
      Exception dispositionError = null;
      try { ZugfolgeRelativeFs.MarkRegularFileDeletePending(stream.SafeFileHandle); }
      catch (Exception error) { dispositionError = error; }
      Exception closeError = null;
      try { stream.Dispose(); } catch (Exception error) { closeError = error; }
      state = 2;
      if (dispositionError != null && closeError != null) throw new AggregateException("Handle-relativer Publikationsrollback und Close sind fehlgeschlagen.", dispositionError, closeError);
      if (dispositionError != null) throw dispositionError;
      if (closeError != null) throw closeError;
    }
  }
  public void Dispose() {
    lock (gate) {
      if (state == 1) { stream.Dispose(); state = 3; return; }
      if (state != 0) return;
    }
    Rollback();
  }
}
public static class ZugfolgeRelativeFs {
  [StructLayout(LayoutKind.Sequential)]
  private struct UNICODE_STRING {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct OBJECT_ATTRIBUTES {
    public int Length;
    public IntPtr RootDirectory;
    public IntPtr ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor;
    public IntPtr SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IO_STATUS_BLOCK {
    public IntPtr Status;
    public UIntPtr Information;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(
    string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle handle, int informationClass, out FILE_ATTRIBUTE_TAG_INFO info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(
    SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(
    out SafeFileHandle handle, uint access, ref OBJECT_ATTRIBUTES attributes,
    out IO_STATUS_BLOCK status, IntPtr allocationSize, uint fileAttributes,
    uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryDirectoryFile(
    SafeFileHandle handle, IntPtr eventHandle, IntPtr apcRoutine, IntPtr apcContext,
    out IO_STATUS_BLOCK status, IntPtr information, uint length, int informationClass,
    [MarshalAs(UnmanagedType.U1)] bool returnSingleEntry, IntPtr fileName,
    [MarshalAs(UnmanagedType.U1)] bool restartScan);
  [DllImport("ntdll.dll")]
  private static extern int NtSetInformationFile(
    SafeFileHandle handle, out IO_STATUS_BLOCK status, IntPtr information, uint length, int informationClass);
  public static SafeFileHandle OpenPlainDirectory(string path) {
    SafeFileHandle handle = CreateFile(path, 0x001200a1, 0x1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    FILE_ATTRIBUTE_TAG_INFO info;
    if (!GetFileInformationByHandleEx(handle, 9, out info, (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO)))) {
      int code = Marshal.GetLastWin32Error(); handle.Dispose(); throw new System.ComponentModel.Win32Exception(code);
    }
    if ((info.FileAttributes & 0x10) == 0 || (info.FileAttributes & 0x400) != 0) {
      handle.Dispose(); throw new InvalidOperationException("Directory-Handle ist kein reparsefreies Verzeichnis.");
    }
    return handle;
  }

  private static void RequirePlainType(SafeFileHandle handle, bool directory) {
    FILE_ATTRIBUTE_TAG_INFO info;
    if (!GetFileInformationByHandleEx(handle, 9, out info, (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO)))) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    bool actualDirectory = (info.FileAttributes & 0x10) != 0;
    if (actualDirectory != directory || (info.FileAttributes & 0x400) != 0) {
      throw new InvalidOperationException("Handle besitzt falschen Typ oder ist ein Reparse-Point.");
    }
  }

  private static SafeFileHandle Relative(SafeFileHandle parent, string leaf, bool directory, bool create, uint accessOverride, ZugfolgeProtectedSecurityDescriptor securityDescriptor) {
    if (parent == null || parent.IsInvalid || String.IsNullOrEmpty(leaf) || leaf == "." || leaf == ".." || leaf.IndexOfAny(new [] {'\\', '/'}) >= 0) {
      throw new ArgumentException("Ungueltiger relativer NT-Dateiname.");
    }
    IntPtr text = Marshal.StringToHGlobalUni(leaf);
    IntPtr unicodePointer = IntPtr.Zero;
    try {
      UNICODE_STRING unicode = new UNICODE_STRING {
        Length = checked((ushort)(leaf.Length * 2)),
        MaximumLength = checked((ushort)(leaf.Length * 2)),
        Buffer = text,
      };
      unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      Marshal.StructureToPtr(unicode, unicodePointer, false);
      OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES {
        Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
        RootDirectory = parent.DangerousGetHandle(),
        ObjectName = unicodePointer,
        Attributes = 0x40,
        SecurityDescriptor = create && securityDescriptor != null ? securityDescriptor.Pointer : IntPtr.Zero,
        SecurityQualityOfService = IntPtr.Zero,
      };
      IO_STATUS_BLOCK status;
      uint access = accessOverride != 0 ? accessOverride : (directory ? 0x001200a1u : (create ? 0x00160183u : 0x00120081u));
      uint options = (directory ? 0x1u : 0x40u) | 0x20u | 0x00200000u;
      SafeFileHandle result;
      int ntstatus = NtCreateFile(out result, access, ref attributes, out status, IntPtr.Zero, 0x80, 0x1, create ? 0x2u : 0x1u, options, IntPtr.Zero, 0);
      if (ntstatus < 0 || result == null || result.IsInvalid) {
        if (result != null) result.Dispose();
        throw new ZugfolgeNtCreateException(ntstatus);
      }
      RequirePlainType(result, directory);
      return result;
    } finally {
      if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
      Marshal.FreeHGlobal(text);
    }
  }

  public static SafeFileHandle CreateDirectory(SafeFileHandle parent, string leaf) {
    return Relative(parent, leaf, true, true, 0, null);
  }
  public static SafeFileHandle CreateProtectedDirectory(SafeFileHandle parent, string leaf, ZugfolgeProtectedSecurityDescriptor securityDescriptor) {
    if (securityDescriptor == null || securityDescriptor.Pointer == IntPtr.Zero) throw new ArgumentException("Protected Security Descriptor fehlt.");
    return Relative(parent, leaf, true, true, 0x001f01ffu, securityDescriptor);
  }
  public static SafeFileHandle CreateRegularFile(SafeFileHandle parent, string leaf) {
    return Relative(parent, leaf, false, true, 0, null);
  }
  public static SafeFileHandle CreateProtectedRegularFile(SafeFileHandle parent, string leaf, ZugfolgeProtectedSecurityDescriptor securityDescriptor) {
    if (securityDescriptor == null || securityDescriptor.Pointer == IntPtr.Zero) throw new ArgumentException("Protected Security Descriptor fehlt.");
    return Relative(parent, leaf, false, true, 0x001f01ffu, securityDescriptor);
  }
  public static SafeFileHandle OpenDirectory(SafeFileHandle parent, string leaf) {
    return Relative(parent, leaf, true, false, 0, null);
  }
  public static SafeFileHandle OpenRegularFile(SafeFileHandle parent, string leaf) {
    return Relative(parent, leaf, false, false, 0, null);
  }
  public static void MarkRegularFileDeletePending(SafeFileHandle handle) {
    if (handle == null || handle.IsInvalid) throw new ArgumentException("Delete-Handle ist ungueltig.");
    RequirePlainType(handle, false);
    IntPtr disposition = Marshal.AllocHGlobal(1);
    try {
      Marshal.WriteByte(disposition, 1);
      IO_STATUS_BLOCK status;
      int ntstatus = NtSetInformationFile(handle, out status, disposition, 1, 13);
      if (ntstatus < 0) throw new InvalidOperationException("NtSetInformationFile(FileDispositionInformation) ist fehlgeschlagen: 0x" + ntstatus.ToString("x8"));
    } finally { Marshal.FreeHGlobal(disposition); }
  }
  public static ZugfolgeHeldPublication PublishHeldCreateNew(Stream source, SafeFileHandle targetParent, string leaf,
      long expectedBytes, string expectedSha256, ZugfolgeProtectedSecurityDescriptor finalDescriptor) {
    if (source == null || !source.CanRead || !source.CanSeek || targetParent == null || targetParent.IsInvalid
        || expectedBytes <= 0 || expectedSha256 == null || expectedSha256.Length != 64
        || finalDescriptor == null || finalDescriptor.Pointer == IntPtr.Zero) {
      throw new ArgumentException("Held-Publication-Vertrag ist ungueltig.");
    }
    foreach (char character in expectedSha256) {
      if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) {
        throw new ArgumentException("Held-Publication-SHA-256 ist ungueltig.");
      }
    }
    source.Position = 0;
    SafeFileHandle fileHandle = CreateProtectedRegularFile(targetParent, leaf, finalDescriptor);
    FileStream output = new FileStream(fileHandle, FileAccess.ReadWrite, 1048576, false);
    SHA256 hash = SHA256.Create();
    try {
      byte[] buffer = new byte[1048576];
      long remaining = expectedBytes;
      while (remaining > 0) {
        int count = (int)Math.Min((long)buffer.Length, remaining);
        int read = source.Read(buffer, 0, count);
        if (read <= 0) throw new InvalidOperationException("Held-Publication-Quelle endet vor der erwarteten Bytezahl.");
        output.Write(buffer, 0, read);
        hash.TransformBlock(buffer, 0, read, null, 0);
        remaining -= read;
      }
      if (source.ReadByte() != -1) throw new InvalidOperationException("Held-Publication-Quelle besitzt Restdaten.");
      hash.TransformFinalBlock(new byte[0], 0, 0);
      string actual = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
      if (output.Length != expectedBytes || actual != expectedSha256) throw new InvalidOperationException("Held-Publication driftet von Bytezahl/SHA-256.");
      output.Flush(true);
      string identity = Identity(output.SafeFileHandle);
      source.Position = 0;
      return new ZugfolgeHeldPublication(output, expectedBytes, actual, identity);
    } catch (Exception primary) {
      Exception rollback = null;
      try { MarkRegularFileDeletePending(output.SafeFileHandle); } catch (Exception error) { rollback = error; }
      try { output.Dispose(); } catch (Exception error) { rollback = rollback == null ? error : new AggregateException(rollback, error); }
      if (rollback != null) throw new AggregateException("Held-Publication und handle-relativer Rollback sind fehlgeschlagen.", primary, rollback);
      throw;
    } finally {
      source.Position = 0;
      hash.Dispose();
    }
  }
  private static void RequireAccessDenied(int status, string operation) {
    if (status == unchecked((int)0xc0000022)) return;
    if (status >= 0) throw new InvalidOperationException(operation + " war trotz geschuetzter DACL moeglich.");
    throw new InvalidOperationException(operation + " scheiterte nicht mit STATUS_ACCESS_DENIED, sondern 0x" + status.ToString("x8") + ".");
  }
  private static void RequireBlocked(int status, string operation) {
    // Held read handles intentionally share only reads. A forbidden fresh open
    // is therefore validly blocked either by the protected DACL or, for data or
    // delete access, by the already-held no-write/no-delete share contract.
    if (status == unchecked((int)0xc0000022) || status == unchecked((int)0xc0000043)) return;
    if (status >= 0) throw new InvalidOperationException(operation + " war trotz geschuetzter DACL/Share-Bindung moeglich.");
    throw new InvalidOperationException(operation + " scheiterte nicht mit STATUS_ACCESS_DENIED/STATUS_SHARING_VIOLATION, sondern 0x" + status.ToString("x8") + ".");
  }
  private static int ProbeRelative(SafeFileHandle parent, string leaf, bool directory, bool create, uint access) {
    SafeFileHandle result = null;
    try {
      // Relative uses FILE_SYNCHRONOUS_IO_NONALERT, whose NT contract requires
      // SYNCHRONIZE in DesiredAccess. Without it a probe only proves
      // STATUS_INVALID_PARAMETER instead of the intended DACL denial.
      // FILE_READ_ATTRIBUTES lets an unexpectedly successful mutation open
      // reach RequirePlainType and be reported as success, not as a misleading
      // metadata-read failure.
      result = Relative(parent, leaf, directory, create, access | 0x00100080u, null);
      return 0;
    } catch (InvalidOperationException error) {
      const string marker = "0x";
      int index = error.Message.LastIndexOf(marker, StringComparison.Ordinal);
      int status;
      if (index >= 0 && Int32.TryParse(error.Message.Substring(index + marker.Length), System.Globalization.NumberStyles.HexNumber, null, out status)) return status;
      throw;
    } finally { if (result != null) result.Dispose(); }
  }
  public static void AssertFrozenDirectoryEntry(SafeFileHandle parent, string leaf) {
    using (SafeFileHandle directory = Relative(parent, leaf, true, false, 0x00120081u, null)) {
      RequireAccessDenied(ProbeRelative(directory, ".zugfolge-freeze-file-probe", false, true, 0x00160183u), "CreateFile in Inputverzeichnis");
      RequireAccessDenied(ProbeRelative(directory, ".zugfolge-freeze-directory-probe", true, true, 0x00160081u), "CreateDirectory in Inputverzeichnis");
    }
  }
  public static void AssertProtectedDacl(SafeFileHandle parent, string leaf, bool directory) {
    RequireAccessDenied(ProbeRelative(parent, leaf, directory, false, 0x00040000u), "WRITE_DAC-Reopen fuer frisch geschuetzten Inputeintrag " + leaf);
  }
  public static void AssertFrozenEntry(SafeFileHandle parent, string leaf, bool directory) {
    // WRITE_DAC does not conflict with the held read-only share mode, so this
    // first probe must prove the protected DACL itself with ACCESS_DENIED.
    AssertProtectedDacl(parent, leaf, directory);
    RequireBlocked(ProbeRelative(parent, leaf, directory, false, 0x00010000u), "DELETE-/Rename-Reopen fuer Inputeintrag " + leaf);
    RequireBlocked(ProbeRelative(parent, leaf, directory, false, 0x00000002u), "WRITE_DATA-/ADD_FILE-Reopen fuer Inputeintrag " + leaf);
    RequireBlocked(ProbeRelative(parent, leaf, directory, false, 0x00000004u), "APPEND_DATA-/ADD_SUBDIRECTORY-Reopen fuer Inputeintrag " + leaf);
  }
  public static string[] EnumerateNames(SafeFileHandle directory) {
    List<string> names = new List<string>();
    IntPtr buffer = Marshal.AllocHGlobal(65536);
    try {
      bool restart = true;
      while (true) {
        IO_STATUS_BLOCK status;
        int result = NtQueryDirectoryFile(directory, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out status, buffer, 65536, 12, false, IntPtr.Zero, restart);
        restart = false;
        if (result == unchecked((int)0x80000006)) break;
        if (result < 0) throw new InvalidOperationException("NtQueryDirectoryFile ist fehlgeschlagen: 0x" + result.ToString("x8"));
        int offset = 0;
        while (true) {
          int next = Marshal.ReadInt32(buffer, offset);
          int nameBytes = Marshal.ReadInt32(buffer, offset + 8);
          string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 12), nameBytes / 2);
          if (name != "." && name != "..") names.Add(name);
          if (next == 0) break;
          offset += next;
        }
      }
    } finally { Marshal.FreeHGlobal(buffer); }
    names.Sort(StringComparer.Ordinal);
    return names.ToArray();
  }
  public static string Identity(SafeFileHandle handle) {
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(handle, out info)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    ulong fileIndex = ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow;
    return info.VolumeSerialNumber.ToString() + ":" + fileIndex.ToString();
  }
  private static string Quote(string value) {
    StringBuilder result = new StringBuilder(); result.Append('"');
    int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(character);
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  public static string QuoteArguments(string[] arguments) {
    StringBuilder result = new StringBuilder();
    for (int index = 0; index < arguments.Length; index++) {
      if (index > 0) result.Append(' ');
      result.Append(Quote(arguments[index]));
    }
    return result.ToString();
  }
}

public sealed class ZugfolgeFileIdentityProof {
  public string Dev { get; private set; }
  public string Ino { get; private set; }
  internal ZugfolgeFileIdentityProof(string value) {
    string[] parts = value.Split(':');
    if (parts.Length != 2) throw new InvalidOperationException("File-ID ist ungueltig.");
    Dev = parts[0]; Ino = parts[1];
  }
}
public sealed class ZugfolgePublicationProof {
  public long Bytes { get; private set; }
  public string File { get; private set; }
  public ZugfolgeFileIdentityProof Identity { get; private set; }
  public string Sha256 { get; private set; }
  internal ZugfolgePublicationProof(string file, ZugfolgeHeldPublication publication) {
    File = file; Bytes = publication.Bytes; Sha256 = publication.Sha256;
    Identity = new ZugfolgeFileIdentityProof(publication.Identity);
  }
  internal ZugfolgePublicationProof(string file, long bytes, string sha256, string identity) {
    File = file; Bytes = bytes; Sha256 = sha256;
    Identity = new ZugfolgeFileIdentityProof(identity);
  }
}
public sealed class ZugfolgeAnnualArtifactPublicationPair : IDisposable {
  private readonly object gate = new object();
  private readonly ZugfolgeHeldPublication artifactPublication;
  private readonly ZugfolgeHeldPublication completionPublication;
  private readonly List<IDisposable> held;
  private int state;
  public ZugfolgePublicationProof Artifact { get; private set; }
  public ZugfolgePublicationProof Completion { get; private set; }
  internal ZugfolgeAnnualArtifactPublicationPair(string artifactFile, ZugfolgeHeldPublication artifact,
      string completionFile, ZugfolgeHeldPublication completion, List<IDisposable> resources) {
    artifactPublication = artifact; completionPublication = completion; held = resources; state = 0;
    Artifact = new ZugfolgePublicationProof(artifactFile, artifact);
    Completion = new ZugfolgePublicationProof(completionFile, completion);
  }
  internal ZugfolgeAnnualArtifactPublicationPair(ZugfolgePublicationProof artifactProof,
      ZugfolgeHeldPublication artifact, ZugfolgePublicationProof completionProof,
      ZugfolgeHeldPublication completion, List<IDisposable> resources) {
    Artifact = artifactProof; Completion = completionProof;
    artifactPublication = artifact; completionPublication = completion; held = resources; state = 0;
  }
  private Exception CloseHeld() {
    List<Exception> errors = new List<Exception>();
    for (int index = held.Count - 1; index >= 0; index--) {
      try { held[index].Dispose(); } catch (Exception error) { errors.Add(error); }
    }
    held.Clear();
    return errors.Count == 0 ? null : new AggregateException("Annual-Publisher konnte gehaltene Inputs/Parents nicht schliessen.", errors);
  }
  public void Commit() {
    lock (gate) {
      if (state == 1) return;
      if (state != 0) throw new InvalidOperationException("Annual-Publikationspaar wurde bereits zurueckgerollt.");
      if (artifactPublication != null) artifactPublication.Commit();
      if (completionPublication != null) completionPublication.Commit();
      Exception outputClose = null;
      try {
        if (completionPublication != null) completionPublication.Dispose();
        if (artifactPublication != null) artifactPublication.Dispose();
      }
      catch (Exception error) { outputClose = error; }
      Exception heldClose = CloseHeld();
      state = 1;
      if (outputClose != null && heldClose != null) throw new AggregateException("Annual-Publikationspaar-Commit konnte Handles nicht schliessen.", outputClose, heldClose);
      if (outputClose != null) throw outputClose;
      if (heldClose != null) throw heldClose;
    }
  }
  public void Rollback() {
    lock (gate) {
      if (state == 2) return;
      if (state == 1) throw new InvalidOperationException("Committed Annual-Publikationspaar darf nicht zurueckgerollt werden.");
      List<Exception> errors = new List<Exception>();
      if (completionPublication != null) try { completionPublication.Rollback(); } catch (Exception error) { errors.Add(error); }
      if (artifactPublication != null) try { artifactPublication.Rollback(); } catch (Exception error) { errors.Add(error); }
      Exception heldClose = CloseHeld(); if (heldClose != null) errors.Add(heldClose);
      state = 2;
      if (errors.Count > 0) throw new AggregateException("Annual-Publikationspaar-Rollback ist fehlgeschlagen.", errors);
    }
  }
  public void Dispose() {
    lock (gate) { if (state != 0) return; }
    Rollback();
  }
}
public sealed class ZugfolgeAnnualArtifactVerificationPair : IDisposable {
  private readonly object gate = new object();
  private readonly Action finalRecheck;
  private readonly List<IDisposable> held;
  private int state;
  public ZugfolgePublicationProof Artifact { get; private set; }
  public ZugfolgePublicationProof Completion { get; private set; }
  internal ZugfolgeAnnualArtifactVerificationPair(ZugfolgePublicationProof artifact,
      ZugfolgePublicationProof completion, Action recheck, List<IDisposable> resources) {
    Artifact = artifact; Completion = completion; finalRecheck = recheck; held = resources; state = 0;
  }
  private Exception CloseHeld() {
    List<Exception> errors = new List<Exception>();
    for (int index = held.Count - 1; index >= 0; index--) {
      try { held[index].Dispose(); } catch (Exception error) { errors.Add(error); }
    }
    held.Clear();
    return errors.Count == 0 ? null : new AggregateException("Annual-Verifier konnte gehaltene Outputs/Parents nicht schliessen.", errors);
  }
  public void Complete() {
    lock (gate) {
      if (state == 1) return;
      if (state != 0) throw new InvalidOperationException("Annual-Verifikationspaar besitzt einen ungueltigen Zustand.");
      Exception verificationError = null;
      try { finalRecheck(); } catch (Exception error) { verificationError = error; }
      Exception closeError = CloseHeld();
      state = 1;
      if (verificationError != null && closeError != null) throw new AggregateException("Annual-Verifikationspaar-Finalcheck und Handle-Close sind fehlgeschlagen.", verificationError, closeError);
      if (verificationError != null) throw verificationError;
      if (closeError != null) throw closeError;
    }
  }
  public void Dispose() { Complete(); }
}
public static class ZugfolgeAnnualArtifactPublisher {
  private const string COMPLETION_SCHEMA = "zugfolge-germany-annual-create-new-artifact-completion/v1";
  private const string COMPLETION_SUFFIX = ".zugfolge-complete.json";
  private static string FullDirectory(string value) {
    return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
  }
  private static SafeFileHandle OpenWorkspaceRoot(string workspaceRoot, List<IDisposable> held) {
    string full = FullDirectory(workspaceRoot);
    string volume = Path.GetPathRoot(full);
    SafeFileHandle current = ZugfolgeRelativeFs.OpenPlainDirectory(volume); held.Add(current);
    string remaining = full.Substring(volume.Length).Trim(Path.DirectorySeparatorChar);
    if (remaining.Length > 0) {
      foreach (string segment in remaining.Split(Path.DirectorySeparatorChar)) {
        current = ZugfolgeRelativeFs.OpenDirectory(current, segment); held.Add(current);
      }
    }
    return current;
  }
  private static string[] PortableSegments(string relativeFile) {
    if (String.IsNullOrEmpty(relativeFile) || Path.IsPathRooted(relativeFile) || relativeFile.IndexOf('\\') >= 0) {
      throw new ArgumentException("Annual-Publisher-Dateipfad ist nicht portabel relativ.");
    }
    string[] segments = relativeFile.Split('/');
    foreach (string segment in segments) {
      bool charactersValid = segment.Length > 0 && segment.Length <= 128;
      foreach (char character in segment) {
        charactersValid = charactersValid && ((character >= 'A' && character <= 'Z')
          || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')
          || character == '.' || character == '_' || character == '@' || character == '+' || character == '-');
      }
      string baseName = segment.Split('.')[0];
      bool reserved = baseName.Equals("CON", StringComparison.OrdinalIgnoreCase)
        || baseName.Equals("PRN", StringComparison.OrdinalIgnoreCase)
        || baseName.Equals("AUX", StringComparison.OrdinalIgnoreCase)
        || baseName.Equals("NUL", StringComparison.OrdinalIgnoreCase)
        || (baseName.Length == 4 && (baseName.StartsWith("COM", StringComparison.OrdinalIgnoreCase)
          || baseName.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) && baseName[3] >= '1' && baseName[3] <= '9');
      if (!charactersValid || segment == "." || segment == ".." || segment.EndsWith(".") || reserved) {
        throw new ArgumentException("Annual-Publisher-Dateipfad besitzt ein ungueltiges Segment.");
      }
    }
    return segments;
  }
  private static SafeFileHandle OpenRelativeParent(SafeFileHandle workspace, string[] segments, List<IDisposable> held) {
    SafeFileHandle current = workspace;
    for (int index = 0; index < segments.Length - 1; index++) {
      current = ZugfolgeRelativeFs.OpenDirectory(current, segments[index]); held.Add(current);
    }
    return current;
  }
  private static FileStream OpenHeldWorkspaceFile(string workspaceRoot, SafeFileHandle workspace, string path,
      List<IDisposable> held) {
    string fullRoot = FullDirectory(workspaceRoot);
    string full = Path.GetFullPath(path);
    string prefix = fullRoot + Path.DirectorySeparatorChar;
    if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Annual-Publisher-Stagingdatei verlaesst workspaceRoot.");
    string relative = full.Substring(prefix.Length).Replace(Path.DirectorySeparatorChar, '/');
    string[] segments = PortableSegments(relative);
    SafeFileHandle parent = OpenRelativeParent(workspace, segments, held);
    SafeFileHandle file = ZugfolgeRelativeFs.OpenRegularFile(parent, segments[segments.Length - 1]);
    FileStream stream = new FileStream(file, FileAccess.Read, 1048576, false); held.Add(stream);
    return stream;
  }
  private static byte[] ReadAndVerify(FileStream stream, long expectedBytes, string expectedSha256, bool retainBytes) {
    if (expectedBytes <= 0 || expectedSha256 == null || expectedSha256.Length != 64 || stream.Length != expectedBytes) {
      throw new InvalidOperationException("Annual-Publisher-Stagingproof ist ungueltig.");
    }
    stream.Position = 0;
    SHA256 hash = SHA256.Create();
    MemoryStream copy = retainBytes ? new MemoryStream() : null;
    try {
      byte[] buffer = new byte[1048576]; long remaining = expectedBytes;
      while (remaining > 0) {
        int count = (int)Math.Min((long)buffer.Length, remaining);
        int read = stream.Read(buffer, 0, count);
        if (read <= 0) throw new InvalidOperationException("Annual-Publisher-Stagingdatei endet vorzeitig.");
        hash.TransformBlock(buffer, 0, read, null, 0); if (copy != null) copy.Write(buffer, 0, read); remaining -= read;
      }
      if (stream.ReadByte() != -1) throw new InvalidOperationException("Annual-Publisher-Stagingdatei besitzt Restdaten.");
      hash.TransformFinalBlock(new byte[0], 0, 0);
      string actual = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
      if (actual != expectedSha256) throw new InvalidOperationException("Annual-Publisher-Staging-SHA-256 driftet.");
      return copy == null ? null : copy.ToArray();
    } finally { stream.Position = 0; hash.Dispose(); if (copy != null) copy.Dispose(); }
  }
  private static string JsonString(string value) {
    StringBuilder result = new StringBuilder(); result.Append('"');
    foreach (char character in value) {
      if (character == '"' || character == '\\') result.Append('\\').Append(character);
      else if (character == '\b') result.Append("\\b"); else if (character == '\f') result.Append("\\f");
      else if (character == '\n') result.Append("\\n"); else if (character == '\r') result.Append("\\r");
      else if (character == '\t') result.Append("\\t");
      else if (character < 0x20) result.Append("\\u").Append(((int)character).ToString("x4"));
      else result.Append(character);
    }
    return result.Append('"').ToString();
  }
  private static byte[] CanonicalCompletion(string artifactFile, long bytes, string sha256) {
    string json = "{\n  \"artifact\": {\n    \"bytes\": " + bytes.ToString(System.Globalization.CultureInfo.InvariantCulture)
      + ",\n    \"file\": " + JsonString(artifactFile) + ",\n    \"sha256\": \"" + sha256
      + "\"\n  },\n  \"schema\": \"" + COMPLETION_SCHEMA + "\"\n}\n";
    return Encoding.UTF8.GetBytes(json);
  }
  private static void RequireCanonicalCompletion(byte[] actual, string artifactFile, long bytes, string sha256) {
    byte[] expected = CanonicalCompletion(artifactFile, bytes, sha256);
    if (actual.Length != expected.Length) throw new InvalidOperationException("Annual-Completion ist nicht kanonisch.");
    for (int index = 0; index < actual.Length; index++) if (actual[index] != expected[index]) throw new InvalidOperationException("Annual-Completion ist nicht kanonisch.");
  }
  private const int STATUS_OBJECT_NAME_COLLISION = unchecked((int)0xc0000035);
  private static FileStream OpenHeldOutput(SafeFileHandle parent, string leaf, List<IDisposable> held) {
    SafeFileHandle handle = ZugfolgeRelativeFs.OpenRegularFile(parent, leaf);
    FileStream stream = new FileStream(handle, FileAccess.Read, 1048576, false); held.Add(stream);
    return stream;
  }
  private static ZugfolgeAnnualArtifactPublicationPair PublishPairInternal(string workspaceRoot, string stagedDataPath,
      string stagedCompletionPath, string outputRelativeFile, long expectedDataBytes, string expectedDataSha256,
      long expectedCompletionBytes, string expectedCompletionSha256, bool recoverExactExisting, Action afterArtifact) {
    List<IDisposable> held = new List<IDisposable>();
    ZugfolgeHeldPublication artifact = null; ZugfolgeHeldPublication completion = null;
    try {
      string[] artifactSegments = PortableSegments(outputRelativeFile);
      string completionFile = outputRelativeFile + COMPLETION_SUFFIX;
      string[] completionSegments = PortableSegments(completionFile);
      SafeFileHandle workspace = OpenWorkspaceRoot(workspaceRoot, held);
      FileStream dataSource = OpenHeldWorkspaceFile(workspaceRoot, workspace, stagedDataPath, held);
      FileStream completionSource = OpenHeldWorkspaceFile(workspaceRoot, workspace, stagedCompletionPath, held);
      ReadAndVerify(dataSource, expectedDataBytes, expectedDataSha256, false);
      byte[] actualCompletion = ReadAndVerify(completionSource, expectedCompletionBytes, expectedCompletionSha256, true);
      RequireCanonicalCompletion(actualCompletion, outputRelativeFile, expectedDataBytes, expectedDataSha256);
      SafeFileHandle artifactParent = OpenRelativeParent(workspace, artifactSegments, held);
      SafeFileHandle completionParent = OpenRelativeParent(workspace, completionSegments, held);
      string currentSid = WindowsIdentity.GetCurrent().User.Value;
      ZugfolgeProtectedSecurityDescriptor descriptor = ZugfolgeProtectedSecurityDescriptor.ParentWritable(currentSid); held.Add(descriptor);
      ZugfolgePublicationProof artifactProof;
      try {
        artifact = ZugfolgeRelativeFs.PublishHeldCreateNew(dataSource, artifactParent, artifactSegments[artifactSegments.Length - 1], expectedDataBytes, expectedDataSha256, descriptor);
        artifactProof = new ZugfolgePublicationProof(outputRelativeFile, artifact);
      } catch (ZugfolgeNtCreateException error) {
        if (!recoverExactExisting || error.Status != STATUS_OBJECT_NAME_COLLISION) throw;
        FileStream existing = OpenHeldOutput(artifactParent, artifactSegments[artifactSegments.Length - 1], held);
        ReadAndVerify(existing, expectedDataBytes, expectedDataSha256, false);
        artifactProof = new ZugfolgePublicationProof(outputRelativeFile, expectedDataBytes, expectedDataSha256,
          ZugfolgeRelativeFs.Identity(existing.SafeFileHandle));
      }
      if (afterArtifact != null) afterArtifact();
      ZugfolgePublicationProof completionProof;
      try {
        completion = ZugfolgeRelativeFs.PublishHeldCreateNew(completionSource, completionParent, completionSegments[completionSegments.Length - 1], expectedCompletionBytes, expectedCompletionSha256, descriptor);
        completionProof = new ZugfolgePublicationProof(completionFile, completion);
      } catch (ZugfolgeNtCreateException error) {
        if (!recoverExactExisting || error.Status != STATUS_OBJECT_NAME_COLLISION) throw;
        FileStream existing = OpenHeldOutput(completionParent, completionSegments[completionSegments.Length - 1], held);
        byte[] existingBytes = ReadAndVerify(existing, expectedCompletionBytes, expectedCompletionSha256, true);
        RequireCanonicalCompletion(existingBytes, outputRelativeFile, expectedDataBytes, expectedDataSha256);
        completionProof = new ZugfolgePublicationProof(completionFile, expectedCompletionBytes, expectedCompletionSha256,
          ZugfolgeRelativeFs.Identity(existing.SafeFileHandle));
      }
      return new ZugfolgeAnnualArtifactPublicationPair(artifactProof, artifact, completionProof, completion, held);
    } catch (Exception primary) {
      List<Exception> errors = new List<Exception>(); errors.Add(primary);
      if (completion != null) try { completion.Rollback(); } catch (Exception error) { errors.Add(error); }
      if (artifact != null) try { artifact.Rollback(); } catch (Exception error) { errors.Add(error); }
      for (int index = held.Count - 1; index >= 0; index--) try { held[index].Dispose(); } catch (Exception error) { errors.Add(error); }
      if (errors.Count == 1) throw;
      throw new AggregateException("Annual-PublishPair/Recovery und handle-relativer Rollback sind fehlgeschlagen.", errors);
    }
  }
  public static ZugfolgeAnnualArtifactPublicationPair PublishPair(string workspaceRoot, string stagedDataPath,
      string stagedCompletionPath, string outputRelativeFile, long expectedDataBytes, string expectedDataSha256,
      long expectedCompletionBytes, string expectedCompletionSha256) {
    return PublishPairInternal(workspaceRoot, stagedDataPath, stagedCompletionPath, outputRelativeFile,
      expectedDataBytes, expectedDataSha256, expectedCompletionBytes, expectedCompletionSha256, false, null);
  }
  public static ZugfolgeAnnualArtifactPublicationPair PublishOrRecoverPair(string workspaceRoot, string stagedDataPath,
      string stagedCompletionPath, string outputRelativeFile, long expectedDataBytes, string expectedDataSha256,
      long expectedCompletionBytes, string expectedCompletionSha256) {
    return PublishPairInternal(workspaceRoot, stagedDataPath, stagedCompletionPath, outputRelativeFile,
      expectedDataBytes, expectedDataSha256, expectedCompletionBytes, expectedCompletionSha256, true, null);
  }
  public static ZugfolgeAnnualArtifactPublicationPair PublishOrRecoverPairWithTestHook(string workspaceRoot,
      string stagedDataPath, string stagedCompletionPath, string outputRelativeFile, long expectedDataBytes,
      string expectedDataSha256, long expectedCompletionBytes, string expectedCompletionSha256, Action afterArtifact) {
    if (afterArtifact == null) throw new ArgumentException("Annual-Publisher-Testhook fehlt.");
    return PublishPairInternal(workspaceRoot, stagedDataPath, stagedCompletionPath, outputRelativeFile,
      expectedDataBytes, expectedDataSha256, expectedCompletionBytes, expectedCompletionSha256, true, afterArtifact);
  }
  public static ZugfolgeAnnualArtifactVerificationPair VerifyPair(string workspaceRoot, string outputRelativeFile,
      long expectedDataBytes, string expectedDataSha256, long expectedCompletionBytes, string expectedCompletionSha256) {
    List<IDisposable> held = new List<IDisposable>();
    try {
      string[] artifactSegments = PortableSegments(outputRelativeFile);
      string completionFile = outputRelativeFile + COMPLETION_SUFFIX;
      PortableSegments(completionFile);
      SafeFileHandle workspace = OpenWorkspaceRoot(workspaceRoot, held);
      string fullRoot = FullDirectory(workspaceRoot);
      FileStream artifact = OpenHeldWorkspaceFile(workspaceRoot, workspace,
        Path.Combine(fullRoot, outputRelativeFile.Replace('/', Path.DirectorySeparatorChar)), held);
      FileStream completion = OpenHeldWorkspaceFile(workspaceRoot, workspace,
        Path.Combine(fullRoot, completionFile.Replace('/', Path.DirectorySeparatorChar)), held);
      ReadAndVerify(artifact, expectedDataBytes, expectedDataSha256, false);
      byte[] completionBytes = ReadAndVerify(completion, expectedCompletionBytes, expectedCompletionSha256, true);
      RequireCanonicalCompletion(completionBytes, outputRelativeFile, expectedDataBytes, expectedDataSha256);
      ZugfolgePublicationProof artifactProof = new ZugfolgePublicationProof(outputRelativeFile, expectedDataBytes,
        expectedDataSha256, ZugfolgeRelativeFs.Identity(artifact.SafeFileHandle));
      ZugfolgePublicationProof completionProof = new ZugfolgePublicationProof(completionFile, expectedCompletionBytes,
        expectedCompletionSha256, ZugfolgeRelativeFs.Identity(completion.SafeFileHandle));
      Action recheck = delegate {
        ReadAndVerify(artifact, expectedDataBytes, expectedDataSha256, false);
        byte[] finalCompletion = ReadAndVerify(completion, expectedCompletionBytes, expectedCompletionSha256, true);
        RequireCanonicalCompletion(finalCompletion, outputRelativeFile, expectedDataBytes, expectedDataSha256);
      };
      return new ZugfolgeAnnualArtifactVerificationPair(artifactProof, completionProof, recheck, held);
    } catch (Exception primary) {
      List<Exception> errors = new List<Exception>(); errors.Add(primary);
      for (int index = held.Count - 1; index >= 0; index--) try { held[index].Dispose(); } catch (Exception error) { errors.Add(error); }
      if (errors.Count == 1) throw;
      throw new AggregateException("Annual-VerifyPair und Handle-Close sind fehlgeschlagen.", errors);
    }
  }
}

public sealed class ZugfolgeMitigatedProcessResult {
  public int ExitCode { get; private set; }
  public byte[] Stdout { get; private set; }
  public byte[] Stderr { get; private set; }
  internal ZugfolgeMitigatedProcessResult(int exitCode, byte[] stdout, byte[] stderr) {
    ExitCode = exitCode; Stdout = stdout; Stderr = stderr;
  }
}

public static class ZugfolgeMitigatedProcess {
  private const uint STARTF_USESTDHANDLES = 0x00000100;
  private const uint CREATE_SUSPENDED = 0x00000004;
  private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  private const uint CREATE_NO_WINDOW = 0x08000000;
  private const int ERROR_INVALID_HANDLE = 6;
  private const uint HANDLE_FLAG_INHERIT = 0x00000001;
  private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
  private const uint TOKEN_QUERY = 0x00000008;
  private const uint LOGON_WITHOUT_PROFILE = 0u;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const uint WAIT_OBJECT_0 = 0;
  private const uint WAIT_TIMEOUT = 258;
  private const uint WAIT_FAILED = 0xffffffff;
  private static readonly IntPtr PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY = new IntPtr(0x00020007);
  private static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
  private static readonly IntPtr PROC_THREAD_ATTRIBUTE_PARENT_PROCESS = new IntPtr(0x00020000);
  private const ulong BUILD_IMAGE_LOAD_POLICY =
    (1UL << 52) | (1UL << 56) | (1UL << 60);
  private const ulong STRICT_IMAGE_LOAD_POLICY =
    (1UL << 44) | BUILD_IMAGE_LOAD_POLICY;
  private static readonly object ActiveLock = new object();
  private static IntPtr ActiveJob = IntPtr.Zero;

  [StructLayout(LayoutKind.Sequential)]
  private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public uint dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
  }
  private sealed class OutputCounter { public long Value; }

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle,
    IntPtr targetProcess, out IntPtr targetHandle, uint desiredAccess,
    [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint options);
  [DllImport("kernelbase.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CompareObjectHandles(IntPtr first, IntPtr second);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetProcessMitigationPolicy(IntPtr process, int policy,
    out uint flags, IntPtr bytes);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr valueBytes, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  private static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateProcessWBasic(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateProcessWithLogonW(string username, string domain, string password, uint logonFlags,
    string application, StringBuilder commandLine, uint flags, IntPtr environment, string cwd,
    ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint bytes);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool QueryInformationJobObject(IntPtr job, int informationClass,
    out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint bytes, out uint returnedBytes);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CloseHandle(IntPtr handle);

  private static System.ComponentModel.Win32Exception Win32(string action) {
    return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), action);
  }
  private static string Quote(string value) {
    if (value.Length == 0) return "\"\"";
    bool needsQuotes = false;
    foreach (char character in value) if (Char.IsWhiteSpace(character) || character == '\"') { needsQuotes = true; break; }
    if (!needsQuotes) return value;
    StringBuilder result = new StringBuilder(); result.Append('\"'); int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '\"') { result.Append('\\', slashes * 2 + 1); result.Append('\"'); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(character);
    }
    result.Append('\\', slashes * 2); result.Append('\"'); return result.ToString();
  }
  private static SortedDictionary<string, string> NormalizedEnvironment(System.Collections.IDictionary environment) {
    if (environment == null) throw new ArgumentNullException("environment");
    SortedDictionary<string, string> sorted = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (System.Collections.DictionaryEntry entry in environment) {
      string key = entry.Key as string; string value = entry.Value as string;
      if (String.IsNullOrEmpty(key) || key.IndexOf('=') >= 0 || value == null || value.IndexOf('\0') >= 0)
        throw new InvalidOperationException("Windows-Kindumgebung enthaelt einen ungueltigen Eintrag.");
      sorted.Add(key, value);
    }
    return sorted;
  }
  private static IntPtr EnvironmentBlock(System.Collections.IDictionary environment) {
    SortedDictionary<string, string> sorted = NormalizedEnvironment(environment);
    StringBuilder block = new StringBuilder();
    foreach (KeyValuePair<string, string> entry in sorted) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
    if (sorted.Count == 0) block.Append('\0');
    block.Append('\0'); return Marshal.StringToHGlobalUni(block.ToString());
  }
  private static void Pipe(bool parentReads, out IntPtr child, out IntPtr parent) {
    SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = 0 };
    IntPtr read; IntPtr write;
    if (!CreatePipe(out read, out write, ref attributes, 0)) throw Win32("CreatePipe");
    child = parentReads ? write : read; parent = parentReads ? read : write;
  }
  private static IntPtr DuplicateInheritableToProcess(IntPtr process, IntPtr source, string label) {
    IntPtr remote;
    if (!DuplicateHandle(GetCurrentProcess(), source, process, out remote, 0, true, DUPLICATE_SAME_ACCESS))
      throw Win32("DuplicateHandle(anchor " + label + ")");
    return remote;
  }
  private static void AssertNotInheritable(IntPtr handle, string label) {
    uint flags;
    if (!GetHandleInformation(handle, out flags)) throw Win32("GetHandleInformation(" + label + ")");
    if ((flags & HANDLE_FLAG_INHERIT) != 0)
      throw new InvalidOperationException("Lokaler Windows-Handle ist unerwartet vererbbar: " + label);
  }
  private static void AssertAllowedHandleInherited(IntPtr process, IntPtr candidate, IntPtr expected, string label) {
    IntPtr duplicate;
    if (!DuplicateHandle(process, candidate, GetCurrentProcess(), out duplicate, 0, false, DUPLICATE_SAME_ACCESS))
      throw Win32("DuplicateHandle(inherited " + label + ")");
    try {
      if (!CompareObjectHandles(expected, duplicate))
        throw new InvalidOperationException("Windows-Kindprozess erbte nicht den freigegebenen " + label + "-Handle.");
    } finally { CloseRequired(ref duplicate, "inherited-" + label + "-verification"); }
  }
  private static void AssertSentinelNotInherited(IntPtr process, IntPtr candidate, IntPtr sentinel) {
    IntPtr duplicate;
    if (DuplicateHandle(process, candidate, GetCurrentProcess(), out duplicate, 0, false, DUPLICATE_SAME_ACCESS)) {
      bool inheritedSentinel = CompareObjectHandles(sentinel, duplicate);
      CloseRequired(ref duplicate, "sentinel-verification");
      if (inheritedSentinel) throw new InvalidOperationException("Windows-Kindprozess erbte einen nicht freigegebenen Sentinel-Handle.");
      return;
    }
    int status = Marshal.GetLastWin32Error();
    if (status != ERROR_INVALID_HANDLE)
      throw new System.ComponentModel.Win32Exception(status, "DuplicateHandle(non-inherited sentinel)");
  }
  private static string ProcessSid(IntPtr process) {
    IntPtr token = IntPtr.Zero;
    if (!OpenProcessToken(process, TOKEN_QUERY, out token)) throw Win32("OpenProcessToken(process identity)");
    try {
      using (WindowsIdentity identity = new WindowsIdentity(token)) {
        if (identity.User == null) throw new InvalidOperationException("Windows-Prozess besitzt keine pruefbare SID.");
        return identity.User.Value;
      }
    } finally { CloseRequired(ref token, "process-token"); }
  }
  private static void AssertProcessSid(IntPtr process, string expectedSid) {
    if (!String.Equals(ProcessSid(process), expectedSid, StringComparison.Ordinal))
      throw new InvalidOperationException("Windows-Prozess verwendet nicht die erwartete Identitaet.");
  }
  private static void AssertProcessInJob(IntPtr process, IntPtr job) {
    bool inJob;
    if (!IsProcessInJob(process, job, out inJob)) throw Win32("IsProcessInJob(anchor job)");
    if (!inJob) throw new InvalidOperationException("Windows-Kindprozess erbte den gehaltenen Anker-Job nicht.");
  }
  private static void RecordCleanupStatus(List<string> errors, string action, int status) {
    errors.Add(action + " status=" + unchecked((uint)status).ToString(System.Globalization.CultureInfo.InvariantCulture));
  }
  private static void CloseRequired(ref IntPtr handle, string label) {
    if (handle == IntPtr.Zero) return;
    IntPtr closing = handle;
    if (!CloseHandle(closing)) throw Win32("CloseHandle(" + label + ")");
    handle = IntPtr.Zero;
  }
  private static void CloseTracked(ref IntPtr handle, string label, List<string> errors) {
    if (handle == IntPtr.Zero) return;
    IntPtr closing = handle; handle = IntPtr.Zero;
    if (!CloseHandle(closing)) RecordCleanupStatus(errors, "CloseHandle(" + label + ")", Marshal.GetLastWin32Error());
  }
  private static void EnsureProcessTerminated(IntPtr process, string label, List<string> errors) {
    if (process == IntPtr.Zero) return;
    uint before = WaitForSingleObject(process, 0);
    if (before == WAIT_OBJECT_0) return;
    if (before == WAIT_FAILED) RecordCleanupStatus(errors, "WaitForSingleObject(" + label + ",pre)", Marshal.GetLastWin32Error());
    bool terminated = TerminateProcess(process, 95);
    int terminateStatus = terminated ? 0 : Marshal.GetLastWin32Error();
    uint wait = WaitForSingleObject(process, 5000);
    if (wait == WAIT_OBJECT_0) return;
    if (!terminated) RecordCleanupStatus(errors, "TerminateProcess(" + label + ")", terminateStatus);
    if (wait == WAIT_FAILED) RecordCleanupStatus(errors, "WaitForSingleObject(" + label + ",cleanup)", Marshal.GetLastWin32Error());
    else errors.Add("WaitForSingleObject(" + label + ",cleanup) result=" + wait.ToString(System.Globalization.CultureInfo.InvariantCulture));
  }
  private static string WaitForJobEmptyStatus(IntPtr job, int timeoutMilliseconds, string label) {
    System.Diagnostics.Stopwatch wait = System.Diagnostics.Stopwatch.StartNew();
    while (true) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
      uint returnedBytes;
      if (!QueryInformationJobObject(job, 1, out accounting,
          (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), out returnedBytes))
        return "QueryInformationJobObject(" + label + ") status="
          + unchecked((uint)Marshal.GetLastWin32Error()).ToString(System.Globalization.CultureInfo.InvariantCulture);
      if (returnedBytes != (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)))
        return "QueryInformationJobObject(" + label + ") bytes="
          + returnedBytes.ToString(System.Globalization.CultureInfo.InvariantCulture);
      if (accounting.ActiveProcesses == 0) return null;
      long remaining = timeoutMilliseconds - wait.ElapsedMilliseconds;
      if (remaining <= 0) return "QueryInformationJobObject(" + label + ") active="
        + accounting.ActiveProcesses.ToString(System.Globalization.CultureInfo.InvariantCulture);
      System.Threading.Thread.Sleep((int)Math.Min(10L, remaining));
    }
  }
  private static void AssertJobEmpty(IntPtr job, int timeoutMilliseconds, string label) {
    string failure = WaitForJobEmptyStatus(job, timeoutMilliseconds, label);
    if (failure != null) throw new InvalidOperationException("Windows-Job wurde nicht vollstaendig leer: " + failure);
  }
  private static void AssertMitigationPolicy(IntPtr process, ulong requested) {
    uint imageLoad;
    if (!GetProcessMitigationPolicy(process, 10, out imageLoad, new IntPtr(4)))
      throw Win32("GetProcessMitigationPolicy(ProcessImageLoadPolicy)");
    if ((imageLoad & 0x00000007u) != 0x00000007u)
      throw new InvalidOperationException("Windows-Kindprozess besitzt nicht die geforderte Image-Load-Mitigation.");
    if ((requested & (1UL << 44)) != 0) {
      uint signature;
      if (!GetProcessMitigationPolicy(process, 8, out signature, new IntPtr(4)))
        throw Win32("GetProcessMitigationPolicy(ProcessSignaturePolicy)");
      if ((signature & 0x00000001u) == 0)
        throw new InvalidOperationException("Windows-Kindprozess besitzt nicht die geforderte Microsoft-Signatur-Mitigation.");
    }
  }
  private static byte[] ReadBounded(Stream stream, int maximumBytes, IntPtr job, string label, OutputCounter total) {
    using (MemoryStream output = new MemoryStream()) {
      byte[] buffer = new byte[8192];
      while (true) {
        int read = stream.Read(buffer, 0, buffer.Length); if (read == 0) break;
        long combined = System.Threading.Interlocked.Add(ref total.Value, read);
        if (combined > maximumBytes) { TerminateJobObject(job, 93); throw new InvalidOperationException(label + " ueberschritt das kombinierte gepinnte Limit."); }
        output.Write(buffer, 0, read);
      }
      return output.ToArray();
    }
  }
  public static void AbortActive() {
    lock (ActiveLock) { if (ActiveJob != IntPtr.Zero) TerminateJobObject(ActiveJob, 94); }
  }
  public static ZugfolgeMitigatedProcessResult Run(string executable, string[] arguments, string cwd,
      System.Collections.IDictionary environment, byte[] stdin, int maximumBytes, int timeoutMilliseconds, Func<bool> cancelled) {
    return RunInternal(executable, arguments, cwd, environment, stdin, maximumBytes, timeoutMilliseconds, cancelled, null, BUILD_IMAGE_LOAD_POLICY);
  }
  public static ZugfolgeMitigatedProcessResult RunAs(string executable, string[] arguments, string cwd,
      System.Collections.IDictionary environment, byte[] stdin, int maximumBytes, int timeoutMilliseconds, Func<bool> cancelled, ZugfolgeEphemeralAccount account) {
    if (account == null) throw new ArgumentNullException("account");
    return RunInternal(executable, arguments, cwd, environment, stdin, maximumBytes, timeoutMilliseconds, cancelled, account, BUILD_IMAGE_LOAD_POLICY);
  }
  public static ZugfolgeMitigatedProcessResult RunStrict(string executable, string[] arguments, string cwd,
      System.Collections.IDictionary environment, byte[] stdin, int maximumBytes, int timeoutMilliseconds, Func<bool> cancelled) {
    return RunInternal(executable, arguments, cwd, environment, stdin, maximumBytes, timeoutMilliseconds, cancelled, null, STRICT_IMAGE_LOAD_POLICY);
  }
  public static ZugfolgeMitigatedProcessResult RunAsStrict(string executable, string[] arguments, string cwd,
      System.Collections.IDictionary environment, byte[] stdin, int maximumBytes, int timeoutMilliseconds, Func<bool> cancelled, ZugfolgeEphemeralAccount account) {
    if (account == null) throw new ArgumentNullException("account");
    return RunInternal(executable, arguments, cwd, environment, stdin, maximumBytes, timeoutMilliseconds, cancelled, account, STRICT_IMAGE_LOAD_POLICY);
  }
  private static ZugfolgeMitigatedProcessResult RunInternal(string executable, string[] arguments, string cwd,
      System.Collections.IDictionary environment, byte[] stdin, int maximumBytes, int timeoutMilliseconds, Func<bool> cancelled, ZugfolgeEphemeralAccount account,
      ulong imageLoadPolicy) {
    if (!Path.IsPathRooted(executable) || maximumBytes <= 0 || timeoutMilliseconds <= 0) throw new InvalidOperationException("Windows-Kindvertrag ist ungueltig.");
    if (arguments == null) arguments = new string[0]; if (stdin == null) stdin = new byte[0];
    System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    if (cancelled != null && cancelled()) throw new InvalidOperationException("Windows-Kindstart wurde vor CreateProcess monoton abgebrochen.");
    IntPtr childIn = IntPtr.Zero, parentIn = IntPtr.Zero, childOut = IntPtr.Zero, parentOut = IntPtr.Zero, childErr = IntPtr.Zero, parentErr = IntPtr.Zero;
    IntPtr sentinelChild = IntPtr.Zero, sentinelParent = IntPtr.Zero;
    IntPtr remoteChildIn = IntPtr.Zero, remoteChildOut = IntPtr.Zero, remoteChildErr = IntPtr.Zero, remoteSentinel = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, mitigation = IntPtr.Zero, handleList = IntPtr.Zero, parentProcess = IntPtr.Zero, env = IntPtr.Zero, job = IntPtr.Zero;
    bool attributesInitialized = false, processCreated = false, processCompleted = false;
    bool anchorCreated = false, anchorTerminated = false;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    PROCESS_INFORMATION anchor = new PROCESS_INFORMATION();
    Exception primaryError = null;
    try {
      Pipe(false, out childIn, out parentIn); Pipe(true, out childOut, out parentOut); Pipe(true, out childErr, out parentErr);
      Pipe(false, out sentinelChild, out sentinelParent);
      AssertNotInheritable(childIn, "child-stdin"); AssertNotInheritable(parentIn, "parent-stdin");
      AssertNotInheritable(childOut, "child-stdout"); AssertNotInheritable(parentOut, "parent-stdout");
      AssertNotInheritable(childErr, "child-stderr"); AssertNotInheritable(parentErr, "parent-stderr");
      AssertNotInheritable(sentinelChild, "sentinel-child"); AssertNotInheritable(sentinelParent, "sentinel-parent");
      StringBuilder command = new StringBuilder(Quote(executable));
      foreach (string argument in arguments) { if (argument == null || argument.IndexOf('\0') >= 0) throw new InvalidOperationException("Windows-Kindargument ist ungueltig."); command.Append(' ').Append(Quote(argument)); }
      env = EnvironmentBlock(environment);
      uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
      job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw Win32("CreateJobObject(anchor)");
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION anchorLimit = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      anchorLimit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (!SetInformationJobObject(job, 9, ref anchorLimit, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
        throw Win32("SetInformationJobObject(anchor)");
      string anchorExecutable = "C:\\Windows\\System32\\cmd.exe";
      StringBuilder anchorCommand = new StringBuilder(Quote(anchorExecutable) + " /D /Q /C exit 0");
      STARTUPINFO anchorStartup = new STARTUPINFO(); anchorStartup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      string expectedSid = account == null ? ProcessSid(GetCurrentProcess()) : account.Sid;
      bool anchored;
      if (account == null) {
        anchored = CreateProcessWBasic(anchorExecutable, anchorCommand, IntPtr.Zero, IntPtr.Zero, false,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env, cwd, ref anchorStartup, out anchor);
        if (!anchored) throw Win32("CreateProcessW(current identity anchor)");
      } else {
        // The identity anchor is never resumed. Let Windows construct its account
        // environment; the payload still receives the explicit env block below.
        anchored = CreateProcessWithLogonW(account.Username, account.Domain, account.Password, LOGON_WITHOUT_PROFILE,
          anchorExecutable, anchorCommand, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
          IntPtr.Zero, cwd, ref anchorStartup, out anchor);
        if (!anchored) {
          uint status = unchecked((uint)Marshal.GetLastWin32Error());
          throw new InvalidOperationException("ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_WITH_LOGON status="
            + status.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
      }
      anchorCreated = true;
      AssertProcessSid(anchor.hProcess, expectedSid);
      if (!AssignProcessToJobObject(job, anchor.hProcess)) throw Win32("AssignProcessToJobObject(anchor)");
      lock (ActiveLock) { ActiveJob = job; }
      if (cancelled != null && cancelled()) throw new InvalidOperationException("Windows-Kindstart wurde vor Anker-Duplizierung monoton abgebrochen.");
      remoteChildIn = DuplicateInheritableToProcess(anchor.hProcess, childIn, "stdin");
      remoteChildOut = DuplicateInheritableToProcess(anchor.hProcess, childOut, "stdout");
      remoteChildErr = DuplicateInheritableToProcess(anchor.hProcess, childErr, "stderr");
      remoteSentinel = DuplicateInheritableToProcess(anchor.hProcess, sentinelChild, "sentinel");
      if (remoteChildIn == remoteChildOut || remoteChildIn == remoteChildErr || remoteChildIn == remoteSentinel
          || remoteChildOut == remoteChildErr || remoteChildOut == remoteSentinel || remoteChildErr == remoteSentinel)
        throw new InvalidOperationException("Windows-Anker erzeugte keine eindeutigen Remote-Handles.");
      int attributeCount = 3;
      IntPtr attributeBytes = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref attributeBytes);
      if (attributeBytes == IntPtr.Zero) throw Win32("InitializeProcThreadAttributeList(size)");
      attributes = Marshal.AllocHGlobal(attributeBytes);
      if (!InitializeProcThreadAttributeList(attributes, attributeCount, 0, ref attributeBytes)) throw Win32("InitializeProcThreadAttributeList");
      attributesInitialized = true; mitigation = Marshal.AllocHGlobal(8); Marshal.WriteInt64(mitigation, unchecked((long)imageLoadPolicy));
      if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, mitigation, new IntPtr(8), IntPtr.Zero, IntPtr.Zero))
        throw Win32("UpdateProcThreadAttribute(MITIGATION_POLICY)");
      handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handleList, 0, remoteChildIn); Marshal.WriteIntPtr(handleList, IntPtr.Size, remoteChildOut); Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, remoteChildErr);
      if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
        throw Win32("UpdateProcThreadAttribute(HANDLE_LIST)");
      parentProcess = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(parentProcess, anchor.hProcess);
      if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, parentProcess, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
        throw Win32("UpdateProcThreadAttribute(PARENT_PROCESS)");
      STARTUPINFOEX startup = new STARTUPINFOEX(); startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = remoteChildIn; startup.StartupInfo.hStdOutput = remoteChildOut; startup.StartupInfo.hStdError = remoteChildErr; startup.lpAttributeList = attributes;
      bool created = CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, flags, env, cwd, ref startup, out process);
      if (!created) {
        if (account == null) throw Win32("CreateProcessW(mitigated)");
        uint status = unchecked((uint)Marshal.GetLastWin32Error());
        throw new InvalidOperationException("ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_FROM_ANCHOR status="
          + status.ToString(System.Globalization.CultureInfo.InvariantCulture));
      }
      processCreated = true;
      AssertAllowedHandleInherited(process.hProcess, remoteChildIn, childIn, "stdin");
      AssertAllowedHandleInherited(process.hProcess, remoteChildOut, childOut, "stdout");
      AssertAllowedHandleInherited(process.hProcess, remoteChildErr, childErr, "stderr");
      AssertSentinelNotInherited(process.hProcess, remoteSentinel, sentinelChild);
      AssertProcessSid(process.hProcess, expectedSid);
      AssertMitigationPolicy(process.hProcess, imageLoadPolicy);
      AssertProcessInJob(process.hProcess, job);
      CloseRequired(ref sentinelChild, "sentinel-child");
      CloseRequired(ref sentinelParent, "sentinel-parent");
      if (!TerminateProcess(anchor.hProcess, 98)) throw Win32("TerminateProcess(suspended identity anchor)");
      uint anchorWait = WaitForSingleObject(anchor.hProcess, 5000);
      if (anchorWait == WAIT_FAILED) throw Win32("WaitForSingleObject(suspended identity anchor)");
      if (anchorWait != WAIT_OBJECT_0)
        throw new TimeoutException("Suspendierter Windows-Identitaetsanker endete nicht rechtzeitig.");
      anchorTerminated = true;
      CloseRequired(ref anchor.hThread, "anchor-thread"); CloseRequired(ref anchor.hProcess, "anchor-process");
      if (cancelled != null && cancelled()) throw new InvalidOperationException("Windows-Kindstart wurde vor ResumeThread monoton abgebrochen.");
      if (clock.ElapsedMilliseconds > timeoutMilliseconds) throw new TimeoutException("Windows-Kindstart ueberschritt vor ResumeThread das gepinnte Zeitlimit.");
      if (ResumeThread(process.hThread) == 0xffffffff) throw Win32("ResumeThread");
      CloseRequired(ref childIn, "child-stdin"); CloseRequired(ref childOut, "child-stdout"); CloseRequired(ref childErr, "child-stderr");
      using (FileStream input = new FileStream(new SafeFileHandle(parentIn, true), FileAccess.Write, 4096, false))
      using (FileStream output = new FileStream(new SafeFileHandle(parentOut, true), FileAccess.Read, 4096, false))
      using (FileStream error = new FileStream(new SafeFileHandle(parentErr, true), FileAccess.Read, 4096, false)) {
        parentIn = IntPtr.Zero; parentOut = IntPtr.Zero; parentErr = IntPtr.Zero; OutputCounter total = new OutputCounter();
        System.Threading.Tasks.Task inputTask = System.Threading.Tasks.Task.Factory.StartNew(delegate { if (stdin.Length > 0) input.Write(stdin, 0, stdin.Length); input.Close(); },
          System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
        System.Threading.Tasks.Task<byte[]> stdoutTask = System.Threading.Tasks.Task.Factory.StartNew(delegate { return ReadBounded(output, maximumBytes, job, "stdout", total); },
          System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
        System.Threading.Tasks.Task<byte[]> stderrTask = System.Threading.Tasks.Task.Factory.StartNew(delegate { return ReadBounded(error, maximumBytes, job, "stderr", total); },
          System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
        while (true) {
          long remaining = timeoutMilliseconds - clock.ElapsedMilliseconds;
          if (remaining <= 0) { TerminateJobObject(job, 92); throw new TimeoutException("Windows-Kindprozessbaum ueberschritt das gepinnte Zeitlimit."); }
          uint wait = WaitForSingleObject(process.hProcess, (uint)Math.Min(25L, remaining));
          if (wait == WAIT_OBJECT_0) {
            if (clock.ElapsedMilliseconds > timeoutMilliseconds) { TerminateJobObject(job, 92); throw new TimeoutException("Windows-Kindprozessbaum ueberschritt das gepinnte Zeitlimit."); }
            break;
          }
          if (wait == WAIT_FAILED) throw Win32("WaitForSingleObject");
          if (wait != WAIT_TIMEOUT) throw new InvalidOperationException("Windows-Kindwait lieferte einen unbekannten Zustand.");
          if (cancelled != null && cancelled()) { TerminateJobObject(job, 94); throw new InvalidOperationException("Windows-Kindprozessbaum wurde nach monotoner Inputdrift beendet."); }
        }
        uint exitCode; if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw Win32("GetExitCodeProcess");
        // The root process may exit while a descendant still holds inherited
        // stdout/stderr pipe handles.  Close the causal process-tree boundary
        // before joining readers so no descendant can keep WaitAll alive or
        // perform a delayed post-root effect.
        if (!TerminateJobObject(job, 96)) throw Win32("TerminateJobObject(post-root descendants)");
        if (!System.Threading.Tasks.Task.WaitAll(new System.Threading.Tasks.Task[] { inputTask, stdoutTask, stderrTask }, 5000)) {
          TerminateJobObject(job, 97);
          throw new TimeoutException("Windows-Kindprozess-Pipes schlossen nach dem kausalen Job-Tree-Abbruch nicht rechtzeitig.");
        }
        CloseRequired(ref process.hThread, "payload-thread"); CloseRequired(ref process.hProcess, "payload-process");
        AssertJobEmpty(job, 5000, "post-root");
        processCompleted = true;
        return new ZugfolgeMitigatedProcessResult(unchecked((int)exitCode), stdoutTask.Result, stderrTask.Result);
      }
    } catch (Exception error) {
      primaryError = error;
      throw;
    } finally {
      List<string> cleanupErrors = new List<string>();
      if (!processCompleted && job != IntPtr.Zero && !TerminateJobObject(job, 95))
        RecordCleanupStatus(cleanupErrors, "TerminateJobObject(cleanup)", Marshal.GetLastWin32Error());
      if (processCreated && !processCompleted) EnsureProcessTerminated(process.hProcess, "payload", cleanupErrors);
      if (anchorCreated && !anchorTerminated) EnsureProcessTerminated(anchor.hProcess, "anchor", cleanupErrors);
      CloseTracked(ref process.hThread, "payload-thread", cleanupErrors); CloseTracked(ref process.hProcess, "payload-process", cleanupErrors);
      CloseTracked(ref anchor.hThread, "anchor-thread", cleanupErrors); CloseTracked(ref anchor.hProcess, "anchor-process", cleanupErrors);
      if (!processCompleted && job != IntPtr.Zero) {
        string jobFailure = WaitForJobEmptyStatus(job, 5000, "cleanup");
        if (jobFailure != null) cleanupErrors.Add(jobFailure);
      }
      lock (ActiveLock) { if (ActiveJob == job) ActiveJob = IntPtr.Zero; }
      CloseTracked(ref childIn, "child-stdin", cleanupErrors); CloseTracked(ref parentIn, "parent-stdin", cleanupErrors);
      CloseTracked(ref childOut, "child-stdout", cleanupErrors); CloseTracked(ref parentOut, "parent-stdout", cleanupErrors);
      CloseTracked(ref childErr, "child-stderr", cleanupErrors); CloseTracked(ref parentErr, "parent-stderr", cleanupErrors);
      CloseTracked(ref sentinelChild, "sentinel-child", cleanupErrors); CloseTracked(ref sentinelParent, "sentinel-parent", cleanupErrors);
      if (attributesInitialized) DeleteProcThreadAttributeList(attributes); if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (parentProcess != IntPtr.Zero) Marshal.FreeHGlobal(parentProcess); if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList); if (mitigation != IntPtr.Zero) Marshal.FreeHGlobal(mitigation);
      CloseTracked(ref job, "job", cleanupErrors); if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
      if (cleanupErrors.Count > 0) {
        Exception cleanupError = new InvalidOperationException("Windows-Kindcleanup war nicht vollstaendig: " + String.Join(" | ", cleanupErrors.ToArray()));
        if (primaryError == null) throw cleanupError;
        throw new AggregateException("Windows-Kindprozess- und Cleanupfehler traten gemeinsam auf.", primaryError, cleanupError);
      }
    }
  }
}

public sealed class ZugfolgeIntegrityMonitor : IDisposable {
  private readonly FileSystemWatcher watcher;
  private readonly FileSystemWatcher metadataWatcher;
  private readonly string label;
  private int invalidated;
  private string detail = "";
  public bool Invalidated { get { return System.Threading.Volatile.Read(ref invalidated) != 0; } }
  public string Detail { get { return detail; } }
  public string Label { get { return label; } }
  public ZugfolgeIntegrityMonitor(string path, string label) {
    this.label = label;
    watcher = new FileSystemWatcher(path);
    watcher.IncludeSubdirectories = true;
    watcher.InternalBufferSize = 65536;
    watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.Security;
    watcher.Changed += Changed;
    watcher.Created += Changed;
    watcher.Deleted += Changed;
    watcher.Renamed += Renamed;
    watcher.Error += Error;
    watcher.EnableRaisingEvents = true;
    metadataWatcher = new FileSystemWatcher(path);
    metadataWatcher.IncludeSubdirectories = true;
    metadataWatcher.InternalBufferSize = 65536;
    metadataWatcher.NotifyFilter = NotifyFilters.Size | NotifyFilters.LastWrite;
    metadataWatcher.Changed += MetadataChanged;
    metadataWatcher.Error += Error;
    metadataWatcher.EnableRaisingEvents = true;
  }
  private void Record(string value) {
    if (System.Threading.Interlocked.Exchange(ref invalidated, 1) == 0) detail = value;
    ZugfolgeMitigatedProcess.AbortActive();
  }
  private void Changed(object sender, FileSystemEventArgs value) { Record(value.ChangeType + ":" + value.FullPath); }
  private void MetadataChanged(object sender, FileSystemEventArgs value) {
    try {
      if ((File.GetAttributes(value.FullPath) & FileAttributes.Directory) != 0) return;
    } catch { }
    Record("FileMetadata:" + value.FullPath);
  }
  private void Renamed(object sender, RenamedEventArgs value) { Record("Renamed:" + value.OldFullPath + "->" + value.FullPath); }
  private void Error(object sender, ErrorEventArgs value) { Record("ReadDirectoryChangesW-Overflow:" + value.GetException().Message); }
  public void Dispose() { metadataWatcher.Dispose(); watcher.Dispose(); }
}
`;
var WINDOWS_BUILD_ANCHOR = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$held = [System.Collections.Generic.List[System.IDisposable]]::new()
$publishedStreams = [System.Collections.Generic.List[object]]::new()
$publicationCommitted = $false
$anchorStage = 'INITIALIZE'
function Write-SafeAnchorStageDiagnostic {
  [Console]::Error.WriteLine('ZUGFOLGE_SAFE_ANCHOR_STAGE_DIAGNOSTIC stage=' + $script:anchorStage)
}
function Fail([string]$message) {
  [Console]::Error.WriteLine($message)
  # Keep the fixed allowlisted line last: the parent intentionally retains only
  # a bounded stderr tail and must never surface arbitrary paths or secrets.
  Write-SafeAnchorStageDiagnostic
  exit 125
}
function Decode-Json([string]$line, [string]$label) {
  if ([string]::IsNullOrWhiteSpace($line)) { Fail "$label fehlt." }
  try {
    $bytes = [Convert]::FromBase64String($line)
    return [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  } catch { Fail "$label ist ungueltig: $($_.Exception.Message)" }
}
function Open-Held([string]$path, [Int64]$expectedBytes, [string]$expectedSha, [string]$label) {
  $stream = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -ne $expectedBytes) { Fail "$label besitzt die falsche Bytezahl." }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
    if ($actual -cne $expectedSha) { Fail "$label besitzt den falschen SHA-256." }
    $stream.Position = 0
    $held.Add($stream)
    return $stream
  } catch {
    $stream.Dispose()
    throw
  }
}
function Open-BuiltOutput([string]$path, [Int64]$expectedBytes, [string]$label) {
  $stream = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -ne $expectedBytes) { Fail "$label besitzt die falsche Bytezahl." }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
    $stream.Position = 0
    $identity = [ZugfolgeRelativeFs]::Identity($stream.SafeFileHandle).Split(':')
    if ($identity.Length -ne 2) { Fail "$label besitzt keine gueltige gehaltene Identitaet." }
    $held.Add($stream)
    return [ordered]@{
      proof = [ordered]@{
        bytes = [Int64]$stream.Length
        identity = [ordered]@{ dev = [string]$identity[0]; ino = [string]$identity[1] }
        sha256 = $actual
      }
      stream = $stream
    }
  } catch {
    $stream.Dispose()
    throw
  }
}
function Read-Held([IO.FileStream]$stream) {
  $stream.Position = 0
  $memory = [IO.MemoryStream]::new()
  try { $stream.CopyTo($memory); return ,$memory.ToArray() } finally { $memory.Dispose(); $stream.Position = 0 }
}
function Hash-Text([string]$value) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
function Open-HeldDirectory([string]$path, [string]$label) {
  try { $handle = [ZugfolgeRelativeFs]::OpenPlainDirectory($path) } catch { Fail "$label konnte nicht exklusiv gehalten werden: $($_.Exception.Message)" }
  $held.Add($handle)
  return $handle
}
function New-HeldDirectoryRelative([Microsoft.Win32.SafeHandles.SafeFileHandle]$parent, [string]$leaf, [string]$label, [object]$securityDescriptor = $null) {
  try {
    $handle = if ($null -eq $securityDescriptor) { [ZugfolgeRelativeFs]::CreateDirectory($parent, $leaf) } else { [ZugfolgeRelativeFs]::CreateProtectedDirectory($parent, $leaf, $securityDescriptor) }
  } catch { Fail "$label konnte nicht NT-relativ create-new erzeugt werden: $($_.Exception.Message)" }
  $held.Add($handle)
  return $handle
}
function Open-HeldDirectoryRelative([Microsoft.Win32.SafeHandles.SafeFileHandle]$parent, [string]$leaf, [string]$label) {
  try { $handle = [ZugfolgeRelativeFs]::OpenDirectory($parent, $leaf) } catch { Fail "$label konnte nicht NT-relativ und reparsefrei geoeffnet werden: $($_.Exception.Message)" }
  $held.Add($handle)
  return $handle
}
function Open-HeldPathRoot([string]$path, [string]$label) {
  $full = [IO.Path]::GetFullPath($path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $volume = [IO.Path]::GetPathRoot($full)
  $current = Open-HeldDirectory $volume "$label-Volume-Root"
  $remaining = $full.Substring($volume.Length).Trim([IO.Path]::DirectorySeparatorChar)
  if (-not [string]::IsNullOrEmpty($remaining)) {
    foreach ($segment in $remaining.Split([IO.Path]::DirectorySeparatorChar)) {
      $current = Open-HeldDirectoryRelative $current $segment "$label-Ahne $segment"
    }
  }
  return $current
}
function Open-HeldRelativeFile([Microsoft.Win32.SafeHandles.SafeFileHandle]$parent, [string]$leaf, [Int64]$expectedBytes, [string]$expectedSha, [string]$label) {
  try { $fileHandle = [ZugfolgeRelativeFs]::OpenRegularFile($parent, $leaf) } catch { Fail "$label konnte nicht NT-relativ und reparsefrei geoeffnet werden: $($_.Exception.Message)" }
  $stream = [IO.FileStream]::new($fileHandle, [IO.FileAccess]::Read, 1048576, $false)
  try {
    if ($stream.Length -ne $expectedBytes) { Fail "$label besitzt die falsche Bytezahl." }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
    if ($actual -cne $expectedSha) { Fail "$label besitzt den falschen SHA-256." }
    $stream.Position = 0
    $held.Add($stream)
    return $stream
  } catch {
    $stream.Dispose()
    throw
  }
}
function Add-ExpectedChild([hashtable]$expectedChildren, [string]$parent, [string]$leaf) {
  if (-not $expectedChildren.ContainsKey($parent)) { $expectedChildren[$parent] = [Collections.Generic.List[string]]::new() }
  $expectedChildren[$parent].Add($leaf)
}
function Assert-ExactHeldTree([hashtable]$directories, [hashtable]$expectedChildren, [string]$label) {
  foreach ($directory in $directories.Keys) {
    if (-not $expectedChildren.ContainsKey($directory)) { Fail "$label besitzt kein Kindermanifest fuer '$directory'." }
    $actual = @([ZugfolgeRelativeFs]::EnumerateNames($directories[$directory]))
    $expected = @($expectedChildren[$directory])
    [Array]::Sort($expected, [StringComparer]::Ordinal)
    if ($actual.Count -ne $expected.Count) { Fail "$label-Verzeichnis '$directory' driftet von der exakten Kindermenge." }
    for ($index = 0; $index -lt $actual.Count; $index++) {
      if ($actual[$index] -cne $expected[$index]) { Fail "$label-Verzeichnis '$directory' driftet von der exakten Kindermenge." }
    }
  }
}
function New-IntegrityWatcher([string]$path, [string]$label) {
  $monitor = [ZugfolgeIntegrityMonitor]::new($path, $label)
  $held.Add($monitor)
  return $monitor
}
function Assert-MonitorsClean([object[]]$monitors, [string]$label) {
  foreach ($monitor in $monitors) {
    if ($monitor.Invalidated) { Fail "$($label): $($monitor.Label) driftete monoton erkannt ($($monitor.Detail))." }
  }
}
function Extract-AuditedPlan([IO.FileStream]$archive, [object]$plan, [hashtable]$directories, [hashtable]$files, [hashtable]$expectedChildren, [object]$securityDescriptor, [string]$label) {
  foreach ($directory in $plan.directories) {
    $segments = ([string]$directory).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    if (-not $directories.ContainsKey($parentName) -or $directories.ContainsKey([string]$directory)) { Fail "$label-Verzeichnisplan ist nicht streng parentgebunden/create-new." }
    $directories[[string]$directory] = New-HeldDirectoryRelative $directories[$parentName] $leaf "$label-Verzeichnis $directory" $securityDescriptor
    Add-ExpectedChild $expectedChildren $parentName $leaf
    $expectedChildren[[string]$directory] = [Collections.Generic.List[string]]::new()
  }
  foreach ($entry in $plan.files) {
    $segments = ([string]$entry.file).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    if (-not $directories.ContainsKey($parentName)) { Fail "$label-Dateiplan besitzt keinen gehaltenen Parent." }
    Add-ExpectedChild $expectedChildren $parentName $leaf
    $archive.Position = [Int64]$entry.offset
    $remaining = [Int64]$entry.bytes
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $fileHandle = [ZugfolgeRelativeFs]::CreateProtectedRegularFile($directories[$parentName], $leaf, $securityDescriptor) } catch { Fail "$label-Datei $($entry.file) konnte nicht NT-relativ create-new erzeugt werden: $($_.Exception.Message)" }
    $output = [IO.FileStream]::new($fileHandle, [IO.FileAccess]::ReadWrite, 1048576, $false)
    try {
      $buffer = [byte[]]::new(1048576)
      while ($remaining -gt 0) {
        $count = [Math]::Min([Int64]$buffer.Length, $remaining)
        $read = $archive.Read($buffer, 0, [int]$count)
        if ($read -le 0) { Fail "$label-Datei $($entry.file) endet vor dem auditierten Slice." }
        $output.Write($buffer, 0, $read)
        [void]$hash.TransformBlock($buffer, 0, $read, $null, 0)
        $remaining -= $read
      }
      [void]$hash.TransformFinalBlock([byte[]]::new(0), 0, 0)
      $actual = [BitConverter]::ToString($hash.Hash).Replace('-', '').ToLowerInvariant()
      if ($output.Length -ne [Int64]$entry.bytes -or $actual -cne [string]$entry.sha256) { Fail "$label-Datei $($entry.file) driftet vom auditierten Slice." }
      $output.Flush($true)
      # NtCreateFile installed the final protected DACL atomically. Closing the
      # only write-capable create handle is the irreversible freeze boundary.
      $output.Dispose()
      $output = $null
      [ZugfolgeRelativeFs]::AssertProtectedDacl($directories[$parentName], $leaf, $false)
      $files[[string]$entry.file] = Open-HeldRelativeFile $directories[$parentName] $leaf $entry.bytes $entry.sha256 "$label-Datei $($entry.file) nach atomarem DACL-Create"
    } finally {
      $hash.Dispose()
      if ($null -ne $output) { $output.Dispose() }
    }
  }
}
function Copy-HeldFile([IO.FileStream]$input, [Microsoft.Win32.SafeHandles.SafeFileHandle]$parent, [string]$leaf, [Int64]$expectedBytes, [string]$expectedSha, [object]$securityDescriptor, [string]$label) {
  $input.Position = 0
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $fileHandle = [ZugfolgeRelativeFs]::CreateProtectedRegularFile($parent, $leaf, $securityDescriptor) } catch { Fail "$label konnte nicht NT-relativ create-new erzeugt werden: $($_.Exception.Message)" }
  $output = [IO.FileStream]::new($fileHandle, [IO.FileAccess]::ReadWrite, 1048576, $false)
  try {
    $buffer = [byte[]]::new(1048576)
    [Int64]$remaining = $expectedBytes
    while ($remaining -gt 0) {
      $count = [Math]::Min([Int64]$buffer.Length, $remaining)
      $read = $input.Read($buffer, 0, [int]$count)
      if ($read -le 0) { Fail "$label endet vor der gehaltenen Bytezahl." }
      $output.Write($buffer, 0, $read)
      [void]$hash.TransformBlock($buffer, 0, $read, $null, 0)
      $remaining -= $read
    }
    if ($input.ReadByte() -ne -1) { Fail "$label besitzt hinter der gehaltenen Bytezahl Restdaten." }
    [void]$hash.TransformFinalBlock([byte[]]::new(0), 0, 0)
    $actual = [BitConverter]::ToString($hash.Hash).Replace('-', '').ToLowerInvariant()
    if ($output.Length -ne $expectedBytes -or $actual -cne $expectedSha) { Fail "$label driftet waehrend der privaten Toolchain-Kopie." }
    $output.Flush($true)
    # See Extract-AuditedPlan: the final descriptor is part of create-new, not a
    # later path- or handle-based ACL mutation.
    $output.Dispose()
    $output = $null
    [ZugfolgeRelativeFs]::AssertProtectedDacl($parent, $leaf, $false)
    return Open-HeldRelativeFile $parent $leaf $expectedBytes $expectedSha "$label nach atomarem DACL-Create"
  } finally {
    $input.Position = 0
    $hash.Dispose()
    if ($null -ne $output) { $output.Dispose() }
  }
}
function Publish-HeldFile([IO.Stream]$input, [object]$request, [string]$label) {
  $propertyNames = @($request.PSObject.Properties.Name | Sort-Object)
  if (($propertyNames -join ',') -cne 'bytes,file,sha256') { Fail "$label besitzt unerwartete Publikationsfelder." }
  $full = [IO.Path]::GetFullPath([string]$request.file)
  $parentPath = [IO.Path]::GetDirectoryName($full).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $parentKey = $parentPath.ToUpperInvariant()
  $leaf = [IO.Path]::GetFileName($full)
  if ([string]::IsNullOrEmpty($leaf) -or -not $anchoredParentHandles.ContainsKey($parentKey) -or
      [IO.Path]::GetFullPath([IO.Path]::Combine($parentPath, $leaf)) -cne $full) {
    Fail "$label verlaesst die gehaltene Output-Parent-Menge."
  }
  $expectedBytes = [Int64]$request.bytes
  $expectedSha = [string]$request.sha256
  if ($expectedBytes -le 0 -or $expectedSha -cnotmatch '^[a-f0-9]{64}$') { Fail "$label besitzt keine gueltige Byte-/SHA-Bindung." }
  try { $published = [ZugfolgeRelativeFs]::PublishHeldCreateNew($input, $anchoredParentHandles[$parentKey], $leaf, $expectedBytes, $expectedSha, $parentWritableDescriptor) }
  catch { Fail "$label konnte nicht handle-relativ create-new publiziert werden: $($_.Exception.Message)" }
  $held.Add($published)
  $publishedStreams.Add($published)
  $identity = ([string]$published.Identity).Split(':')
  if ($identity.Length -ne 2) { Fail "$label besitzt keine gueltige gehaltene Identitaet." }
  return [ordered]@{
    bytes = [Int64]$published.Bytes
    identity = [ordered]@{ dev = [string]$identity[0]; ino = [string]$identity[1] }
    sha256 = [string]$published.Sha256
  }
}
function Rollback-Published {
  $errors = [Collections.Generic.List[string]]::new()
  for ($index = $publishedStreams.Count - 1; $index -ge 0; $index--) {
    try { $publishedStreams[$index].Rollback() } catch { $errors.Add($_.Exception.Message) }
  }
  $publishedStreams.Clear()
  if ($errors.Count -gt 0) { throw [InvalidOperationException]::new('Handle-relativer Publikationsrollback scheiterte: ' + [string]::Join(' | ', $errors)) }
}
function Commit-Published {
  foreach ($publication in $publishedStreams) { $publication.Commit() }
  $publishedStreams.Clear()
}
function Reopen-FrozenDirectoryRelative([Microsoft.Win32.SafeHandles.SafeFileHandle]$parent, [Microsoft.Win32.SafeHandles.SafeFileHandle]$createHandle, [string]$leaf, [string]$label) {
  $expectedIdentity = [ZugfolgeRelativeFs]::Identity($createHandle)
  # The protected DACL was installed atomically. Release the create-time full
  # access grant before keeping a read-only, non-inheritable identity handle.
  $createHandle.Dispose()
  $reopened = Open-HeldDirectoryRelative $parent $leaf "$label nach atomarem DACL-Create"
  if ([ZugfolgeRelativeFs]::Identity($reopened) -cne $expectedIdentity) { Fail "$label driftete beim nur-lesbaren Reopen von seiner gehaltenen Identitaet." }
  return $reopened
}
function Reopen-FrozenHeldTreeDirectories([hashtable]$directories, [Microsoft.Win32.SafeHandles.SafeFileHandle]$rootParent, [string]$rootLeaf, [string]$label) {
  $ordered = @($directories.Keys | Sort-Object @{ Expression = { if ([string]::IsNullOrEmpty([string]$_)) { 0 } else { ([string]$_).Split('/').Length } } }, @{ Expression = { [string]$_ } })
  foreach ($directory in $ordered) {
    if ($directory -eq '') {
      $directories[$directory] = Reopen-FrozenDirectoryRelative $rootParent $directories[$directory] $rootLeaf "$label-Wurzel"
    } else {
      $segments = ([string]$directory).Split('/')
      $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
      $leaf = $segments[$segments.Length - 1]
      $directories[$directory] = Reopen-FrozenDirectoryRelative $directories[$parentName] $directories[$directory] $leaf "$label-Verzeichnis $directory"
    }
  }
}
function Verify-FrozenHeldTree([hashtable]$directories, [hashtable]$files, [hashtable]$expectedChildren, [Microsoft.Win32.SafeHandles.SafeFileHandle]$rootParent, [string]$rootLeaf, [string]$label) {
  # Every entry received its final protected descriptor atomically at NT create.
  # First prove the complete tree, then discard every create-time full-access
  # directory handle parent-first and bind read-only handles to the same IDs.
  Assert-ExactHeldTree $directories $expectedChildren "$label vor nur-lesbarem Reopen"
  Reopen-FrozenHeldTreeDirectories $directories $rootParent $rootLeaf $label
  Assert-ExactHeldTree $directories $expectedChildren "$label nach nur-lesbarem Reopen"
  foreach ($directory in @($directories.Keys | Sort-Object)) {
    if ($directory -eq '') {
      [ZugfolgeRelativeFs]::AssertFrozenDirectoryEntry($rootParent, $rootLeaf)
      [ZugfolgeRelativeFs]::AssertFrozenEntry($rootParent, $rootLeaf, $true)
    } else {
      $segments = ([string]$directory).Split('/')
      $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
      [ZugfolgeRelativeFs]::AssertFrozenDirectoryEntry($directories[$parentName], $segments[$segments.Length - 1])
      [ZugfolgeRelativeFs]::AssertFrozenEntry($directories[$parentName], $segments[$segments.Length - 1], $true)
    }
  }
  foreach ($file in @($files.Keys | Sort-Object)) {
    $segments = ([string]$file).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    [ZugfolgeRelativeFs]::AssertFrozenEntry($directories[$parentName], $segments[$segments.Length - 1], $false)
  }
}
function Invoke-Bound([string]$file, [string[]]$arguments, [string]$cwd, [hashtable]$environment, [object[]]$monitors, [int]$maximumBytes, [int]$timeoutMilliseconds, [object]$account) {
  $cancelled = [Func[bool]]{
    foreach ($monitor in $monitors) { if ($monitor.Invalidated) { return $true } }
    return $false
  }
  try {
    $process = [ZugfolgeMitigatedProcess]::RunAs($file, $arguments, $cwd, $environment, [byte[]]@(), $maximumBytes, $timeoutMilliseconds, $cancelled, $account)
    return [ordered]@{
      code = $process.ExitCode
      stderr = [Convert]::ToBase64String($process.Stderr)
      stdout = [Convert]::ToBase64String($process.Stdout)
    }
  } catch {
    $diagnostic = [string]$_.Exception.GetBaseException().Message
    if ($diagnostic -match '^ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=(PROCESS_WITH_LOGON|PROCESS_FROM_ANCHOR) status=[1-9][0-9]{0,9}$') {
      [Console]::Error.WriteLine($diagnostic)
      exit 125
    }
    Fail "Gebundener mitigierter Prozess schlug fail-closed fehl."
  }
}
try {
  $request = Decode-Json ([Console]::In.ReadLine()) 'Anchor-Request'
  $helper = Open-Held $request.helper.path $request.helper.bytes $request.helper.sha256 'Gepinnte Anchor-Helper-Assembly'
  $helperBytes = Read-Held $helper
  try { [void][Reflection.Assembly]::Load($helperBytes) } catch { Fail "Gepinnte Anchor-Helper-Assembly konnte nicht aus den gehaltenen Bytes geladen werden: $($_.Exception.Message)" }
  $anchoredParentHandles = @{}
  $anchoredParentProofs = [Collections.Generic.List[object]]::new()
  foreach ($entry in @($request.anchoredParents)) {
    $parentPath = [IO.Path]::GetFullPath([string]$entry.path).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $parentKey = $parentPath.ToUpperInvariant()
    if ($anchoredParentHandles.ContainsKey($parentKey)) { Fail "Output-Elternverzeichnis ist doppelt: $parentPath" }
    $parentHandle = Open-HeldPathRoot $parentPath 'Output-Parent'
    $actualIdentity = [ZugfolgeRelativeFs]::Identity($parentHandle)
    $expectedIdentity = ([string]$entry.identity.dev) + ':' + ([string]$entry.identity.ino)
    if ($actualIdentity -cne $expectedIdentity) { Fail "Output-Elternverzeichnis driftet vor dem Anchor-Handschlag: $parentPath" }
    $anchoredParentHandles[$parentKey] = $parentHandle
    $anchoredParentProofs.Add([ordered]@{
      identity = [ordered]@{ dev = [string]$entry.identity.dev; ino = [string]$entry.identity.ino }
      path = $parentPath
    })
  }
  $buildParentPath = [IO.Path]::GetFullPath([string]$request.buildParent.path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $buildParentKey = $buildParentPath.ToUpperInvariant()
  if (-not $anchoredParentHandles.ContainsKey($buildParentKey)) { Fail 'Buildroot-Parent fehlt in der gehaltenen Output-Parent-Menge.' }
  $expectedBuildParentIdentity = ([string]$request.buildParent.identity.dev) + ':' + ([string]$request.buildParent.identity.ino)
  if ([ZugfolgeRelativeFs]::Identity($anchoredParentHandles[$buildParentKey]) -cne $expectedBuildParentIdentity) { Fail 'Buildroot-Parent driftet vom expliziten Request.' }
  $buildRootLeaf = [string]$request.buildRootLeaf
  $buildRoot = [IO.Path]::GetFullPath([IO.Path]::Combine($buildParentPath, $buildRootLeaf))
  if ([IO.Path]::GetDirectoryName($buildRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) -cne $buildParentPath) { Fail 'Buildroot-Leaf verlaesst seinen gehaltenen Parent.' }
  $source = Open-Held $request.source.path $request.source.bytes $request.source.sha256 'Source-TAR'
  $vendor = Open-Held $request.vendor.path $request.vendor.bytes $request.vendor.sha256 'Vendor-TAR'
  $manifestStream = Open-Held $request.manifest.path $request.manifest.bytes $request.manifest.sha256 'Toolchain-Manifest'
  $manifestBytes = Read-Held $manifestStream
  $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
  if ($manifest.schema -cne 'zugfolge-operational-validator-toolchain-manifest/v1') { Fail 'Toolchain-Manifest besitzt ein unbekanntes Schema.' }
  $root = [IO.Path]::GetFullPath([string]$request.toolchainRoot)
  $toolchainRootHandle = Open-HeldPathRoot $root 'Toolchain'
  $toolchainDirectories = @{ '' = $toolchainRootHandle }
  $toolchainFiles = @{}
  $expectedChildren = @{}
  $expectedChildren[''] = [Collections.Generic.List[string]]::new()
  foreach ($directory in $manifest.directories) {
    $segments = ([string]$directory).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    if (-not $toolchainDirectories.ContainsKey($parentName) -or $toolchainDirectories.ContainsKey([string]$directory)) { Fail 'Toolchain-Verzeichnismanifest ist nicht streng parentgebunden.' }
    $toolchainDirectories[[string]$directory] = Open-HeldDirectoryRelative $toolchainDirectories[$parentName] $leaf "Toolchain-Verzeichnis $directory"
    if (-not $expectedChildren.ContainsKey($parentName)) { $expectedChildren[$parentName] = [Collections.Generic.List[string]]::new() }
    $expectedChildren[$parentName].Add($leaf)
    $expectedChildren[[string]$directory] = [Collections.Generic.List[string]]::new()
  }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $manifest.files) {
    $segments = ([string]$entry.file).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    if (-not $toolchainDirectories.ContainsKey($parentName) -or -not $seen.Add([string]$entry.file)) { Fail 'Toolchain-Dateimanifest besitzt einen ungueltigen oder kollidierenden Pfad.' }
    $toolchainFiles[[string]$entry.file] = Open-HeldRelativeFile $toolchainDirectories[$parentName] $leaf $entry.bytes $entry.sha256 "Toolchain-Datei $($entry.file)"
    $expectedChildren[$parentName].Add($leaf)
  }
  Assert-ExactHeldTree $toolchainDirectories $expectedChildren 'Toolchain'
  if (-not $seen.Contains([string]$request.cargoPath) -or -not $seen.Contains([string]$request.rustcPath)) { Fail 'Toolchain-Manifest bindet cargo/rustc nicht.' }
  $readyJson = ([ordered]@{ anchoredParents = @($anchoredParentProofs); buildRoot = $buildRoot } | ConvertTo-Json -Depth 8 -Compress)
  [Console]::Out.WriteLine('ANCHOR_READY ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($readyJson)))
  [Console]::Out.Flush()
  $script:anchorStage = 'RECEIVE_EXTRACTION_PLAN'
  $extract = Decode-Json ([Console]::In.ReadLine()) 'Extraktionsplan'
  # The privileged local principal is unnecessary while the parent/input/toolchain
  # handles are being established and audited.  Create it only once an extraction
  # request has been received; aborting before extraction therefore needs no admin
  # side effect while all original input bytes remain exclusively held.
  $script:anchorStage = 'CREATE_EPHEMERAL_ACCOUNT'
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $account = [ZugfolgeEphemeralAccount]::Create()
  $held.Add($account)
  $readExecuteDescriptor = [ZugfolgeProtectedSecurityDescriptor]::ReadExecute($currentSid, $account.Sid)
  $isolatedWritableDescriptor = [ZugfolgeProtectedSecurityDescriptor]::IsolatedWritable($currentSid, $account.Sid)
  $parentWritableDescriptor = [ZugfolgeProtectedSecurityDescriptor]::ParentWritable($currentSid)
  $held.Add($readExecuteDescriptor)
  $held.Add($isolatedWritableDescriptor)
  $held.Add($parentWritableDescriptor)
  $script:anchorStage = 'CREATE_PRIVATE_ROOT'
  $buildRootHandle = New-HeldDirectoryRelative $anchoredParentHandles[$buildParentKey] $buildRootLeaf 'Privater Buildroot' $readExecuteDescriptor
  if ([ZugfolgeRelativeFs]::EnumerateNames($buildRootHandle).Length -ne 0) { Fail 'Create-new Buildroot ist nicht leer.' }
  $buildRootIdentityParts = [ZugfolgeRelativeFs]::Identity($buildRootHandle).Split(':')
  if ($buildRootIdentityParts.Length -ne 2) { Fail 'Create-new Buildroot besitzt keine gueltige gehaltene Identitaet.' }
  $buildDirectories = @{ '' = $buildRootHandle }
  $sourceHandle = New-HeldDirectoryRelative $buildDirectories[''] 'source' 'Private Source-Wurzel' $readExecuteDescriptor
  $sourceDirectories = @{ '' = $sourceHandle }
  $sourceFiles = @{}
  $sourceExpectedChildren = @{ '' = [Collections.Generic.List[string]]::new() }
  $script:anchorStage = 'EXTRACT_SOURCE'
  Extract-AuditedPlan $source $extract.source $sourceDirectories $sourceFiles $sourceExpectedChildren $readExecuteDescriptor 'Source'
  $script:anchorStage = 'EXTRACT_VENDOR'
  Extract-AuditedPlan $vendor $extract.vendor $sourceDirectories $sourceFiles $sourceExpectedChildren $readExecuteDescriptor 'Vendor'
  $script:anchorStage = 'COPY_TOOLCHAIN_DIRECTORIES'
  $privateToolchainHandle = New-HeldDirectoryRelative $buildDirectories[''] 'toolchain' 'Private Toolchain-Wurzel' $readExecuteDescriptor
  $privateToolchainDirectories = @{ '' = $privateToolchainHandle }
  $privateToolchainFiles = @{}
  $privateToolchainExpectedChildren = @{ '' = [Collections.Generic.List[string]]::new() }
  foreach ($directory in $manifest.directories) {
    $segments = ([string]$directory).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    $privateToolchainDirectories[[string]$directory] = New-HeldDirectoryRelative $privateToolchainDirectories[$parentName] $leaf "Private Toolchain-Verzeichnis $directory" $readExecuteDescriptor
    Add-ExpectedChild $privateToolchainExpectedChildren $parentName $leaf
    $privateToolchainExpectedChildren[[string]$directory] = [Collections.Generic.List[string]]::new()
  }
  $script:anchorStage = 'COPY_TOOLCHAIN_FILES'
  foreach ($entry in $manifest.files) {
    $segments = ([string]$entry.file).Split('/')
    $parentName = if ($segments.Length -eq 1) { '' } else { [string]::Join('/', $segments[0..($segments.Length - 2)]) }
    $leaf = $segments[$segments.Length - 1]
    Add-ExpectedChild $privateToolchainExpectedChildren $parentName $leaf
    $privateToolchainFiles[[string]$entry.file] = Copy-HeldFile $toolchainFiles[[string]$entry.file] $privateToolchainDirectories[$parentName] $leaf $entry.bytes $entry.sha256 $readExecuteDescriptor "Private Toolchain-Datei $($entry.file)"
  }
  $script:anchorStage = 'CREATE_WRITABLE_ROOTS'
  $targetHandle = New-HeldDirectoryRelative $buildDirectories[''] 'target' 'Privates Cargo-Target' $isolatedWritableDescriptor
  $cargoHomeHandle = New-HeldDirectoryRelative $buildDirectories[''] 'cargo-home' 'Privates Cargo-Home' $isolatedWritableDescriptor
  $tempHandle = New-HeldDirectoryRelative $buildDirectories[''] 'temp' 'Privates Temp' $isolatedWritableDescriptor
  $publicationHandle = New-HeldDirectoryRelative $buildDirectories[''] 'publication' 'Privates Publikations-Staging' $parentWritableDescriptor
  $sourcePath = [IO.Path]::Combine($buildRoot, 'source')
  $vendorPath = [IO.Path]::Combine($sourcePath, 'vendor')
  $privateToolchainPath = [IO.Path]::Combine($buildRoot, 'toolchain')
  $cargoPath = [IO.Path]::GetFullPath([IO.Path]::Combine($privateToolchainPath, ([string]$request.cargoPath).Replace('/', [IO.Path]::DirectorySeparatorChar)))
  $rustcPath = [IO.Path]::GetFullPath([IO.Path]::Combine($privateToolchainPath, ([string]$request.rustcPath).Replace('/', [IO.Path]::DirectorySeparatorChar)))
  $script:anchorStage = 'FREEZE_SOURCE'
  Verify-FrozenHeldTree $sourceDirectories $sourceFiles $sourceExpectedChildren $buildRootHandle 'source' 'Source-und-Vendor'
  $script:anchorStage = 'FREEZE_TOOLCHAIN'
  Verify-FrozenHeldTree $privateToolchainDirectories $privateToolchainFiles $privateToolchainExpectedChildren $buildRootHandle 'toolchain' 'Private Toolchain'
  $script:anchorStage = 'VERIFY_WRITABLE_ROOTS'
  $targetHandle = Reopen-FrozenDirectoryRelative $buildRootHandle $targetHandle 'target' 'Privates Cargo-Target'
  $cargoHomeHandle = Reopen-FrozenDirectoryRelative $buildRootHandle $cargoHomeHandle 'cargo-home' 'Privates Cargo-Home'
  $tempHandle = Reopen-FrozenDirectoryRelative $buildRootHandle $tempHandle 'temp' 'Privates Temp'
  foreach ($entry in @('target', 'cargo-home', 'temp')) {
    [ZugfolgeRelativeFs]::AssertFrozenDirectoryEntry($buildRootHandle, $entry)
    [ZugfolgeRelativeFs]::AssertFrozenEntry($buildRootHandle, $entry, $true)
  }
  $script:anchorStage = 'FREEZE_BUILD_ROOT'
  $buildRootHandle = Reopen-FrozenDirectoryRelative $anchoredParentHandles[$buildParentKey] $buildRootHandle $buildRootLeaf 'Privater Buildroot'
  $buildDirectories[''] = $buildRootHandle
  [ZugfolgeRelativeFs]::AssertFrozenDirectoryEntry($anchoredParentHandles[$buildParentKey], $buildRootLeaf)
  [ZugfolgeRelativeFs]::AssertFrozenEntry($anchoredParentHandles[$buildParentKey], $buildRootLeaf, $true)
  $script:anchorStage = 'START_INTEGRITY_MONITORS'
  $monitors = @(
    (New-IntegrityWatcher $sourcePath 'Sourcebaum'),
    (New-IntegrityWatcher $vendorPath 'Vendorbaum'),
    (New-IntegrityWatcher $privateToolchainPath 'Privater Toolchainbaum')
  )
  $script:anchorStage = 'VERIFY_HELD_TREES'
  Assert-ExactHeldTree $sourceDirectories $sourceExpectedChildren 'Source-und-Vendor'
  Assert-ExactHeldTree $toolchainDirectories $expectedChildren 'Gepinnter Toolchain-Input'
  Assert-ExactHeldTree $privateToolchainDirectories $privateToolchainExpectedChildren 'Private Toolchain'
  Assert-MonitorsClean $monitors 'Vor Build'
  $script:anchorStage = 'REPORT_EXTRACTED'
  $extractedJson = ([ordered]@{
    buildRootIdentity = [ordered]@{ dev = [string]$buildRootIdentityParts[0]; ino = [string]$buildRootIdentityParts[1] }
  } | ConvertTo-Json -Depth 4 -Compress)
  [Console]::Out.WriteLine('EXTRACTED ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($extractedJson)))
  [Console]::Out.Flush()
  $script:anchorStage = 'RECEIVE_BUILD_PLAN'
  $run = Decode-Json ([Console]::In.ReadLine()) 'Build-Request'
  if ($run.command[0] -cne 'cargo') { Fail 'Build-Request besitzt keinen Cargo-Befehl.' }
  $expectedSource = [IO.Path]::GetFullPath($sourcePath)
  $expectedCargoHome = [IO.Path]::GetFullPath([IO.Path]::Combine($buildRoot, 'cargo-home'))
  $expectedTarget = [IO.Path]::GetFullPath([IO.Path]::Combine($buildRoot, 'target'))
  $expectedTemp = [IO.Path]::GetFullPath([IO.Path]::Combine($buildRoot, 'temp'))
  $expectedConfig = [IO.Path]::GetFullPath([IO.Path]::Combine($expectedSource, '.cargo', 'config.toml'))
  $expectedManifest = [IO.Path]::GetFullPath([IO.Path]::Combine($expectedSource, 'Cargo.toml'))
  if ([IO.Path]::GetFullPath([string]$run.sourceDirectory) -cne $expectedSource -or
      [IO.Path]::GetFullPath([string]$run.cargoHome) -cne $expectedCargoHome -or
      [IO.Path]::GetFullPath([string]$run.targetDirectory) -cne $expectedTarget -or
      [IO.Path]::GetFullPath([string]$run.tempDirectory) -cne $expectedTemp -or
      [IO.Path]::GetFullPath([string]$run.cargoConfig) -cne $expectedConfig -or
      [IO.Path]::GetFullPath([string]$run.cargoManifest) -cne $expectedManifest) {
    Fail 'Build-Request driftet von den NT-relativ erzeugten privaten Pfaden.'
  }
  $buildArguments = [Collections.Generic.List[string]]::new()
  foreach ($argument in @($run.command | Select-Object -Skip 1)) {
    if ([string]$argument -ceq '$PINNED_CARGO_CONFIG') { $buildArguments.Add($expectedConfig) }
    elseif ([string]$argument -ceq '$PINNED_CARGO_MANIFEST') { $buildArguments.Add($expectedManifest) }
    else { $buildArguments.Add([string]$argument) }
  }
  $environment = @{
    'CARGO_BUILD_JOBS' = '1'
    'CARGO_ENCODED_RUSTFLAGS' = '--remap-path-prefix=' + $vendorPath + '=' + [string]$request.vendorRemapPrefix
    'CARGO_HOME' = [string]$run.cargoHome
    'CARGO_INCREMENTAL' = '0'
    'CARGO_NET_OFFLINE' = 'true'
    'CARGO_TARGET_DIR' = [string]$run.targetDirectory
    'CARGO_TERM_COLOR' = 'never'
    'COMSPEC' = 'C:\Windows\System32\cmd.exe'
    'HOMEDRIVE' = 'C:'
    'HOMEPATH' = '\Windows\System32'
    'PATH' = "$($privateToolchainPath)\bin;$($privateToolchainPath)\lib\rustlib\x86_64-pc-windows-gnu\bin;$($privateToolchainPath)\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained;C:\Windows\System32;C:\Windows"
    'PATHEXT' = '.COM;.EXE;.BAT;.CMD'
    'PROMPT' = '$P$G'
    'RUSTC' = $rustcPath
    'SYSTEMROOT' = 'C:\Windows'
    'TEMP' = [string]$run.tempDirectory
    'TMP' = [string]$run.tempDirectory
    'WINDIR' = 'C:\Windows'
  }
  $trustedCwd = 'C:\Windows\System32'
  $script:anchorStage = 'RUN_BUILD'
  Assert-MonitorsClean $monitors 'Vor Cargo-Probe'
  $cargoProbe = Invoke-Bound $cargoPath @('-vV') $trustedCwd $environment $monitors ([int]$request.processLimits.maxOutputBytes) ([int]$request.processLimits.timeoutMilliseconds) $account
  Assert-MonitorsClean $monitors 'Nach Cargo-Probe'
  $rustcProbe = Invoke-Bound $rustcPath @('-vV') $trustedCwd $environment $monitors ([int]$request.processLimits.maxOutputBytes) ([int]$request.processLimits.timeoutMilliseconds) $account
  Assert-MonitorsClean $monitors 'Nach rustc-Probe'
  $build = Invoke-Bound $cargoPath @($buildArguments) $trustedCwd $environment $monitors ([int]$request.processLimits.maxOutputBytes) ([int]$request.processLimits.timeoutMilliseconds) $account
  Assert-MonitorsClean $monitors 'Nach Cargo-Build'
  $outputProof = $null
  $builtOutput = $null
  if ($cargoProbe.code -eq 0 -and $rustcProbe.code -eq 0 -and $build.code -eq 0) {
    $builtPath = [IO.Path]::GetFullPath([IO.Path]::Combine($expectedTarget, ([string]$run.targetOutputFile).Replace('/', [IO.Path]::DirectorySeparatorChar)))
    if (-not $builtPath.StartsWith($expectedTarget + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Fail 'Build-Output verlaesst das private Cargo-Target.' }
    $builtOutput = Open-BuiltOutput $builtPath ([Int64]$run.expectedOutputBytes) 'Tatsaechlich gebauter Operational-Validator'
    $outputProof = $builtOutput.proof
  }
  $result = [ordered]@{
    build = $build
    cargo = $cargoProbe
    isolation = [ordered]@{ mode = 'ephemeral-local-build-account-v1'; principalSidSha256 = Hash-Text $account.Sid }
    output = $outputProof
    rustc = $rustcProbe
  }
  $json = $result | ConvertTo-Json -Depth 20 -Compress
  [Console]::Out.WriteLine('RESULT ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
  [Console]::Out.Flush()
  if ($cargoProbe.code -ne 0 -or $rustcProbe.code -ne 0 -or $build.code -ne 0) { exit $(if ($build.code -ne 0) { $build.code } else { 124 }) }
  $script:anchorStage = 'RECEIVE_PUBLICATION_PLAN'
  $publicationLine = [Console]::In.ReadLine()
  if ($publicationLine -ceq 'ABORT') { exit 124 }
  if ([string]::IsNullOrEmpty($publicationLine) -or -not $publicationLine.StartsWith('PUBLISH ')) { Fail 'Windows-Build-Anker erhielt keinen handle-relativen Publikationsauftrag.' }
  $publication = Decode-Json $publicationLine.Substring(8) 'Publikationsauftrag'
  $publicationNames = @($publication.PSObject.Properties.Name | Sort-Object)
  if (($publicationNames -join ',') -cne 'binary,provenance,receipt') { Fail 'Publikationsauftrag besitzt unerwartete Ausgaben.' }
  foreach ($id in @('provenance', 'receipt')) {
    $names = @($publication.$id.PSObject.Properties.Name | Sort-Object)
    if (($names -join ',') -cne 'base64,bytes,file,sha256') { Fail "Publikationsauftrag.$id besitzt unerwartete Felder." }
  }
  if ([Int64]$publication.binary.bytes -ne [Int64]$outputProof.bytes -or [string]$publication.binary.sha256 -cne [string]$outputProof.sha256) {
    Fail 'Publikationsauftrag bindet nicht den gehaltenen Cargo-Output.'
  }
  try {
    $provenanceBytes = [Convert]::FromBase64String([string]$publication.provenance.base64)
    $receiptBytes = [Convert]::FromBase64String([string]$publication.receipt.base64)
  } catch { Fail "Publikationsauftrag enthaelt ungueltige Base64-Bytes: $($_.Exception.Message)" }
  $provenanceInput = [IO.MemoryStream]::new($provenanceBytes, $false)
  $receiptInput = [IO.MemoryStream]::new($receiptBytes, $false)
  $script:anchorStage = 'PUBLISH_OUTPUTS'
  try {
    $published = [ordered]@{
      provenance = Publish-HeldFile $provenanceInput ([pscustomobject]@{ bytes = [Int64]$publication.provenance.bytes; file = [string]$publication.provenance.file; sha256 = [string]$publication.provenance.sha256 }) 'Build-Provenienz'
      binary = Publish-HeldFile $builtOutput.stream $publication.binary 'Operational-Validator-Rebuild'
      receipt = Publish-HeldFile $receiptInput ([pscustomobject]@{ bytes = [Int64]$publication.receipt.bytes; file = [string]$publication.receipt.file; sha256 = [string]$publication.receipt.sha256 }) 'Rebuild-Receipt'
    }
  } finally {
    $receiptInput.Dispose()
    $provenanceInput.Dispose()
  }
  $publishedJson = $published | ConvertTo-Json -Depth 12 -Compress
  [Console]::Out.WriteLine('PUBLISHED ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($publishedJson)))
  [Console]::Out.Flush()
  $script:anchorStage = 'RECEIVE_PUBLICATION_COMPLETE'
  $completion = [Console]::In.ReadLine()
  if ($completion -ceq 'ABORT') { Rollback-Published; exit 124 }
  if ($completion -cne 'PUBLICATION_COMPLETE') { Fail 'Windows-Build-Anker erhielt keinen erfolgreichen Publikationsabschluss.' }
  $script:anchorStage = 'COMMIT_PUBLICATION'
  Commit-Published
  $publicationCommitted = $true
} catch {
  Fail $_.Exception.Message
} finally {
  $disposeErrors = [Collections.Generic.List[string]]::new()
  if (-not $publicationCommitted -and $publishedStreams.Count -gt 0) {
    try { Rollback-Published } catch { $disposeErrors.Add($_.Exception.Message) }
  }
  for ($index = $held.Count - 1; $index -ge 0; $index--) {
    try { $held[$index].Dispose() } catch { $disposeErrors.Add($_.Exception.Message) }
  }
  if ($disposeErrors.Count -gt 0) {
    [Console]::Error.WriteLine('Windows-Build-Anker konnte gehaltene Ressourcen oder den ephemeren Build-Account nicht vollstaendig freigeben: ' + [string]::Join(' | ', $disposeErrors))
    # A failing finally block runs after Fail/exit. Repeat the fixed marker after
    # every arbitrary cleanup message so it remains inside the bounded tail.
    Write-SafeAnchorStageDiagnostic
    exit 125
  }
}
`;
var EXPECTED_NORMALIZATION_FIELDS = Object.freeze([
  Object.freeze({ name: "coff-time-date-stamp", offset: 136, bytes: 4 }),
  Object.freeze({ name: "optional-header-checksum", offset: 216, bytes: 4 })
]);
var EXPECTED_SECTIONS = Object.freeze([
  Object.freeze({ name: ".text", rawData: "non-empty" }),
  Object.freeze({ name: ".data", rawData: "non-empty" }),
  Object.freeze({ name: ".rdata", rawData: "non-empty" }),
  Object.freeze({ name: ".pdata", rawData: "non-empty" }),
  Object.freeze({ name: ".xdata", rawData: "non-empty" }),
  Object.freeze({ name: ".bss", rawData: "empty" }),
  Object.freeze({ name: ".idata", rawData: "non-empty" }),
  Object.freeze({ name: ".CRT", rawData: "non-empty" }),
  Object.freeze({ name: ".tls", rawData: "non-empty" }),
  Object.freeze({ name: ".reloc", rawData: "non-empty" })
]);
var ALLOWED_INHERITED_ENVIRONMENT = Object.freeze([]);
var CLEARED_BUILD_ENVIRONMENT = Object.freeze([
  "AR",
  "CARGO_BUILD_RUSTC",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_TARGET",
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_PROFILE_RELEASE_CODEGEN_UNITS",
  "CARGO_PROFILE_RELEASE_DEBUG",
  "CARGO_PROFILE_RELEASE_LTO",
  "CARGO_PROFILE_RELEASE_OPT_LEVEL",
  "CARGO_PROFILE_RELEASE_PANIC",
  "CARGO_TARGET_DIR",
  "CC",
  "CFLAGS",
  "CXX",
  "CXXFLAGS",
  "LDFLAGS",
  "RUSTC",
  "RUSTC_BOOTSTRAP",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTDOCFLAGS",
  "RUSTFLAGS",
  "RUSTUP_TOOLCHAIN",
  "SOURCE_DATE_EPOCH"
]);
var FIXED_BUILD_ENVIRONMENT = Object.freeze({
  CARGO_BUILD_JOBS: "1",
  CARGO_ENCODED_RUSTFLAGS: "--remap-path-prefix=$HELD_VENDOR_ROOT=$ANNUAL_VENDOR_REMAP_PREFIX",
  CARGO_INCREMENTAL: "0",
  CARGO_NET_OFFLINE: "true",
  CARGO_TERM_COLOR: "never"
});
var WINDOWS_TOOLCHAIN_ANCHOR_MODE = "windows-powershell-held-helper-private-dacl-mitigated-v3";
var WINDOWS_TOOLCHAIN_PLATFORM = "win32";
var WORKFLOW_AUTHORITY = Object.freeze({
  annualExecutorPlan: Object.freeze({
    arguments: ANNUAL_PLAN_ARGUMENTS,
    directContractFile: ANNUAL_DIRECT_CONTRACT,
    maxOutputBytes: 4 * 1024 * 1024,
    mode: "held-helper-independent-supervisor-plan-only-v1",
    planFile: ANNUAL_PLAN_FILE,
    startEvidenceFile: ANNUAL_EXECUTOR_START_EVIDENCE,
    startEvidenceSchema: "zugfolge-operational-validator-annual-executor-start-evidence/v1",
    timeoutMilliseconds: 12e4
  }),
  artifactAttestation: "github-sigstore-build-provenance-required-v1",
  attestation: Object.freeze({
    bundleFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json",
    predicateType: "https://slsa.dev/provenance/v1",
    verification: Object.freeze({
      command: "gh attestation verify",
      denySelfHostedRunners: true,
      signerWorkflow: "larynxberlin-rgb/Zugfolge/.github/workflows/operational-validator-rebuild-evidence.yml"
    })
  }),
  environment: "github-hosted-fresh-windows-vm-v1",
  event: "workflow_dispatch",
  repository: "larynxberlin-rgb/Zugfolge",
  requiredRef: "refs/heads/main",
  runnerImages: Object.freeze(["windows-2025", "windows-2022"]),
  workflowFile: ".github/workflows/operational-validator-rebuild-evidence.yml"
});
var WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\\(?:[^<>:"|?*\x00-\x1f\\/]+\\)*[^<>:"|?*\x00-\x1f\\/]+$/u;
function invariant6(condition, message) {
  if (!condition) throw new Error(message);
}
function exactKeys4(value, keys, label) {
  invariant6(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  invariant6(Object.keys(value).sort().join(",") === [...keys].sort().join(","), `${label} besitzt unerwartete oder fehlende Felder.`);
  return value;
}
function canonicalValue4(value) {
  if (Array.isArray(value)) return value.map(canonicalValue4);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue4(value[key])]));
}
function canonicalBytes3(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue4(value), null, 2)}
`, "utf8");
}
function sameCanonicalValue(left, right) {
  return canonicalBytes3(left).equals(canonicalBytes3(right));
}
function sha2563(bytes) {
  return createHash6("sha256").update(bytes).digest("hex");
}
function validatePortableFile(value, label) {
  invariant6(typeof value === "string" && PORTABLE_FILE.test(value), `${label} muss ein sicherer relativer POSIX-Dateipfad sein.`);
  for (const segment of value.split("/")) {
    invariant6(!segment.endsWith(".") && !WINDOWS_RESERVED_SEGMENT.test(segment), `${label} muss auch unter Windows ein eindeutiger regulaerer Dateipfad sein.`);
  }
  return value;
}
function portableFileSystemKey(value, label) {
  validatePortableFile(value, label);
  return value.split("/").map((segment) => segment.toLowerCase()).join("/");
}
function validateSha256(value, label) {
  invariant6(typeof value === "string" && SHA2565.test(value), `${label} muss ein kleingeschriebener SHA-256 sein.`);
  return value;
}
function validatePositiveBytes(value, label, maximum = MAX_BINARY_BYTES) {
  invariant6(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${label} muss eine positive Bytezahl bis ${maximum} sein.`);
  return value;
}
function validateProof2(value, label, maximum = MAX_BINARY_BYTES, { file = false } = {}) {
  exactKeys4(value, file ? ["bytes", "file", "sha256"] : ["bytes", "sha256"], label);
  if (file) validatePortableFile(value.file, `${label}.file`);
  validatePositiveBytes(value.bytes, `${label}.bytes`, maximum);
  validateSha256(value.sha256, `${label}.sha256`);
  return value;
}
function validateStringArray(value, expected, label) {
  invariant6(Array.isArray(value) && value.length === expected.length, `${label} besitzt die falsche Laenge.`);
  invariant6(value.every((entry, index) => entry === expected[index]), `${label} driftet vom festgelegten Wert.`);
  return value;
}
function validateRustcIdentity(value, label = "toolchain.rustc") {
  exactKeys4(value, ["commitHash", "host", "llvmVersion", "release"], label);
  invariant6(typeof value.release === "string" && VERSION.test(value.release), `${label}.release ist ungueltig.`);
  invariant6(typeof value.commitHash === "string" && GIT_COMMIT2.test(value.commitHash), `${label}.commitHash ist ungueltig.`);
  invariant6(typeof value.host === "string" && TARGET.test(value.host), `${label}.host ist ungueltig.`);
  invariant6(typeof value.llvmVersion === "string" && VERSION.test(value.llvmVersion), `${label}.llvmVersion ist ungueltig.`);
  return value;
}
function validateCargoIdentity(value, label = "toolchain.cargo") {
  exactKeys4(value, ["commitHash", "host", "release"], label);
  invariant6(typeof value.release === "string" && VERSION.test(value.release), `${label}.release ist ungueltig.`);
  invariant6(typeof value.commitHash === "string" && GIT_COMMIT2.test(value.commitHash), `${label}.commitHash ist ungueltig.`);
  invariant6(typeof value.host === "string" && TARGET.test(value.host), `${label}.host ist ungueltig.`);
  return value;
}
function validateTreeProof(value, label, maximumEntries = MAX_SOURCE_TREE_ENTRIES) {
  exactKeys4(value, ["fileCount", "manifestSha256", "totalBytes"], label);
  invariant6(Number.isSafeInteger(value.fileCount) && value.fileCount > 0 && value.fileCount <= maximumEntries, `${label}.fileCount ist ungueltig.`);
  invariant6(Number.isSafeInteger(value.totalBytes) && value.totalBytes > 0, `${label}.totalBytes ist ungueltig.`);
  validateSha256(value.manifestSha256, `${label}.manifestSha256`);
  return value;
}
function validateArchiveProof(value, label, maximumBytes) {
  exactKeys4(value, ["bytes", "file", "format", "sha256"], label);
  invariant6(value.format === "tar", `${label}.format muss tar sein.`);
  validatePortableFile(value.file, `${label}.file`);
  validatePositiveBytes(value.bytes, `${label}.bytes`, maximumBytes);
  validateSha256(value.sha256, `${label}.sha256`);
  return value;
}
function validateToolchainSpec(value) {
  exactKeys4(value, ["anchor", "cargo", "cargoPath", "manifest", "platform", "root", "rustc", "rustcPath"], "toolchain");
  exactKeys4(value.anchor, ["helperAssembly", "mode"], "toolchain.anchor");
  invariant6(value.anchor.mode === WINDOWS_TOOLCHAIN_ANCHOR_MODE, "toolchain.anchor.mode ist ungueltig.");
  validateProof2(value.anchor.helperAssembly, "toolchain.anchor.helperAssembly", MAX_PRODUCER_BYTES, { file: true });
  invariant6(value.anchor.helperAssembly.file === WINDOWS_ANCHOR_HELPER, "toolchain.anchor.helperAssembly.file muss das tracked, deterministisch reproduzierbare Helper-Artefakt binden.");
  invariant6(value.platform === WINDOWS_TOOLCHAIN_PLATFORM, "Operational-Validator-Rebuild materialisiert PE32+ ausschliesslich auf win32.");
  invariant6(typeof value.root === "string" && win32.isAbsolute(value.root) && /^[A-Za-z]:[\\/]/u.test(value.root), "toolchain.root muss ein expliziter absoluter Windows-Pfad sein.");
  validatePortableFile(value.cargoPath, "toolchain.cargoPath");
  validatePortableFile(value.rustcPath, "toolchain.rustcPath");
  invariant6(value.cargoPath.toLowerCase().endsWith("/cargo.exe") && value.rustcPath.toLowerCase().endsWith("/rustc.exe"), "toolchain cargo/rustc muessen echte relative EXE-Pfade sein.");
  validateProof2(value.manifest, "toolchain.manifest", MAX_TOOLCHAIN_MANIFEST_BYTES, { file: true });
  validateCargoIdentity(value.cargo);
  validateRustcIdentity(value.rustc);
  return value;
}
function validateOperationalValidatorRebuildSpec(spec) {
  exactKeys4(spec, ["authority", "binaries", "build", "pe", "producer", "provenance", "receipt", "releaseId", "schema", "source", "toolchain"], "Operational-Validator-Rebuild-Spec");
  invariant6(spec.schema === SPEC_SCHEMA, "Operational-Validator-Rebuild-Spec besitzt ein unbekanntes Schema.");
  invariant6(typeof spec.releaseId === "string" && RELEASE_ID.test(spec.releaseId), "Operational-Validator-Rebuild-Spec.releaseId ist ungueltig.");
  const expectedAuthority = {
    ...WORKFLOW_AUTHORITY,
    attestation: {
      ...WORKFLOW_AUTHORITY.attestation,
      subjects: [
        spec?.binaries?.rebuilt?.file,
        spec?.provenance?.file,
        spec?.receipt?.file,
        spec?.binaries?.preserved?.file,
        WORKFLOW_AUTHORITY.annualExecutorPlan.directContractFile,
        WORKFLOW_AUTHORITY.annualExecutorPlan.planFile,
        `${WORKFLOW_AUTHORITY.annualExecutorPlan.planFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
        WORKFLOW_AUTHORITY.annualExecutorPlan.startEvidenceFile,
        `${WORKFLOW_AUTHORITY.annualExecutorPlan.startEvidenceFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`
      ]
    }
  };
  invariant6(sameCanonicalValue(spec.authority, expectedAuthority), "Operational-Validator-Rebuild-Spec.authority driftet vom GitHub-Actions-Trust-Root oder von den Spec-gebundenen Subjects.");
  exactKeys4(spec.source, ["archive", "cargoLock", "commit", "tree", "vendor"], "source");
  validateArchiveProof(spec.source.archive, "source.archive", MAX_ARCHIVE_BYTES);
  invariant6(typeof spec.source.commit === "string" && GIT_COMMIT2.test(spec.source.commit), "source.commit ist ungueltig.");
  validateProof2(spec.source.cargoLock, "source.cargoLock", MAX_SPEC_BYTES, { file: true });
  validateTreeProof(spec.source.tree, "source.tree");
  exactKeys4(spec.source.vendor, ["archive", "cargoConfig", "remapPrefix", "tree"], "source.vendor");
  validateArchiveProof(spec.source.vendor.archive, "source.vendor.archive", MAX_VENDOR_ARCHIVE_BYTES);
  validateProof2(spec.source.vendor.cargoConfig, "source.vendor.cargoConfig", MAX_SPEC_BYTES, { file: true });
  invariant6(spec.source.vendor.cargoConfig.file === ".cargo/config.toml", "source.vendor.cargoConfig muss die gepinnte .cargo/config.toml binden.");
  invariant6(typeof spec.source.vendor.remapPrefix === "string" && WINDOWS_ABSOLUTE_PATH.test(spec.source.vendor.remapPrefix), "source.vendor.remapPrefix muss den exakten absoluten Annual-Quellpraefix binden.");
  validateTreeProof(spec.source.vendor.tree, "source.vendor.tree");
  exactKeys4(spec.build, ["command", "environmentPolicy", "processLimits", "profile", "targetOutputFile"], "build");
  validateStringArray(spec.build.command, EXPECTED_BUILD_COMMAND, "build.command");
  invariant6(spec.build.profile === "release", "build.profile muss release sein.");
  invariant6(spec.build.targetOutputFile === "release/zugfolge-infra-release.exe", "build.targetOutputFile driftet vom externen Cargo-Release-Output.");
  exactKeys4(spec.build.environmentPolicy, ["allowedInherited", "cleared", "fixed", "targetDirectory"], "build.environmentPolicy");
  validateStringArray(spec.build.environmentPolicy.allowedInherited, ALLOWED_INHERITED_ENVIRONMENT, "build.environmentPolicy.allowedInherited");
  validateStringArray(spec.build.environmentPolicy.cleared, CLEARED_BUILD_ENVIRONMENT, "build.environmentPolicy.cleared");
  invariant6(sameCanonicalValue(spec.build.environmentPolicy.fixed, FIXED_BUILD_ENVIRONMENT), "build.environmentPolicy.fixed driftet vom Offline-Buildvertrag.");
  invariant6(spec.build.environmentPolicy.targetDirectory === "external-empty-create-new", "build.environmentPolicy.targetDirectory ist ungueltig.");
  exactKeys4(spec.build.processLimits, ["maxOutputBytes", "timeoutMilliseconds"], "build.processLimits");
  invariant6(spec.build.processLimits.maxOutputBytes === MAX_PROCESS_OUTPUT_BYTES, `build.processLimits.maxOutputBytes muss ${MAX_PROCESS_OUTPUT_BYTES} sein.`);
  invariant6(Number.isSafeInteger(spec.build.processLimits.timeoutMilliseconds) && spec.build.processLimits.timeoutMilliseconds >= 100 && spec.build.processLimits.timeoutMilliseconds <= 9e5, "build.processLimits.timeoutMilliseconds ist ungueltig.");
  validateToolchainSpec(spec.toolchain);
  exactKeys4(spec.binaries, ["preserved", "rebuilt"], "binaries");
  validateProof2(spec.binaries.preserved, "binaries.preserved", MAX_BINARY_BYTES, { file: true });
  exactKeys4(spec.binaries.rebuilt, ["expectedBytes", "file"], "binaries.rebuilt");
  validatePortableFile(spec.binaries.rebuilt.file, "binaries.rebuilt.file");
  validatePositiveBytes(spec.binaries.rebuilt.expectedBytes, "binaries.rebuilt.expectedBytes");
  invariant6(spec.binaries.preserved.bytes === spec.binaries.rebuilt.expectedBytes, "Preserved und official rebuild muessen dieselbe Bytezahl besitzen.");
  invariant6(spec.binaries.preserved.file !== spec.binaries.rebuilt.file, "Preserved und official rebuild muessen getrennte Pfade besitzen.");
  exactKeys4(spec.pe, ["allowedNormalizationFields", "format", "machine", "maxBinaryBytes", "normalizedSha256", "sections"], "pe");
  invariant6(spec.pe.format === "PE32+" && spec.pe.machine === 34404, "pe muss AMD64 PE32+ sein.");
  invariant6(spec.pe.maxBinaryBytes === MAX_BINARY_BYTES, `pe.maxBinaryBytes muss ${MAX_BINARY_BYTES} sein.`);
  validateSha256(spec.pe.normalizedSha256, "pe.normalizedSha256");
  invariant6(sameCanonicalValue(spec.pe.allowedNormalizationFields, EXPECTED_NORMALIZATION_FIELDS), "pe.allowedNormalizationFields muss exakt die PE-Felder bei 136/216 umfassen.");
  invariant6(sameCanonicalValue(spec.pe.sections, EXPECTED_SECTIONS), "pe.sections muss die zehn festgelegten Sections enthalten.");
  exactKeys4(spec.producer, PRODUCER_IDS, "producer");
  for (const [id, file] of [["bundle", PRODUCER_BUNDLE], ["entrypoint", PRODUCER_ENTRYPOINT], ["executionPins", PRODUCER_EXECUTION_PINS], ["implementation", PRODUCER_IMPLEMENTATION]]) {
    validateProof2(spec.producer[id], `producer.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant6(spec.producer[id].file === file, `producer.${id}.file driftet.`);
  }
  exactKeys4(spec.provenance, ["file"], "provenance");
  validatePortableFile(spec.provenance.file, "provenance.file");
  exactKeys4(spec.receipt, ["file"], "receipt");
  validatePortableFile(spec.receipt.file, "receipt.file");
  invariant6(sameCanonicalValue(spec.authority.attestation.subjects, [
    spec.binaries.rebuilt.file,
    spec.provenance.file,
    spec.receipt.file,
    spec.binaries.preserved.file,
    spec.authority.annualExecutorPlan.directContractFile,
    spec.authority.annualExecutorPlan.planFile,
    `${spec.authority.annualExecutorPlan.planFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
    spec.authority.annualExecutorPlan.startEvidenceFile,
    `${spec.authority.annualExecutorPlan.startEvidenceFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`
  ]), "authority.attestation.subjects muss exakt Rebuild, preserved Executor, Direct-Contract, Annual-Plan/Completion und Startbeleg/Completion binden.");
  const files = [
    spec.binaries.preserved.file,
    spec.binaries.rebuilt.file,
    spec.source.archive.file,
    spec.source.vendor.archive.file,
    spec.toolchain.anchor.helperAssembly.file,
    spec.toolchain.manifest.file,
    spec.provenance.file,
    spec.receipt.file,
    spec.authority.attestation.bundleFile,
    spec.authority.annualExecutorPlan.directContractFile,
    spec.authority.annualExecutorPlan.planFile,
    `${spec.authority.annualExecutorPlan.planFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
    spec.authority.annualExecutorPlan.startEvidenceFile,
    `${spec.authority.annualExecutorPlan.startEvidenceFile}${ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`
  ];
  invariant6(new Set(files.map((file) => portableFileSystemKey(file, `Spec-Dateipfad ${file}`))).size === files.length, "Binary-, Input-, Manifest- und Provenienzpfade muessen getrennt sein.");
  return spec;
}
function workflowAuthorityReceipt(spec) {
  const env = process.env;
  invariant6(env.GITHUB_ACTIONS === "true", "Releasefaehiger Rebuild-Evidence-v3 darf nur in GitHub Actions materialisiert werden.");
  invariant6(env.GITHUB_REPOSITORY === spec.authority.repository, "GitHub-Actions-Repository driftet vom Annual-Trust-Root.");
  invariant6(env.GITHUB_EVENT_NAME === spec.authority.event, "GitHub-Actions-Event ist fuer den Release-Rebuild nicht autorisiert.");
  invariant6(env.GITHUB_REF === spec.authority.requiredRef && env.GITHUB_REF_PROTECTED === "true", "Release-Rebuild muss auf dem geschuetzten Annual-Ref laufen.");
  invariant6(env.RUNNER_ENVIRONMENT === "github-hosted" && env.RUNNER_OS === "Windows" && env.RUNNER_ARCH === "X64", "Release-Rebuild benoetigt eine frische GitHub-hosted Windows-x64-VM.");
  invariant6(spec.authority.runnerImages.includes(env.ZUGFOLGE_REBUILD_RUNNER_IMAGE), "GitHub-Runner-Image driftet vom Annual-Vertrag.");
  invariant6(typeof env.GITHUB_SHA === "string" && GIT_COMMIT2.test(env.GITHUB_SHA), "GitHub-Actions-Commit ist nicht vollstaendig gebunden.");
  invariant6(typeof env.GITHUB_RUN_ID === "string" && /^[1-9]\d*$/u.test(env.GITHUB_RUN_ID), "GitHub-Actions-Run-ID ist ungueltig.");
  invariant6(typeof env.GITHUB_RUN_ATTEMPT === "string" && /^[1-9]\d*$/u.test(env.GITHUB_RUN_ATTEMPT), "GitHub-Actions-Run-Attempt ist ungueltig.");
  const expectedWorkflowPrefix = `${spec.authority.repository}/${spec.authority.workflowFile}@`;
  invariant6(typeof env.GITHUB_WORKFLOW_REF === "string" && env.GITHUB_WORKFLOW_REF.startsWith(expectedWorkflowPrefix), "GitHub-Actions-Workflow-Ref driftet vom Annual-Vertrag.");
  return {
    artifactAttestation: spec.authority.artifactAttestation,
    attestation: spec.authority.attestation,
    attestationState: "pending-external-verification",
    artifactName: `operational-validator-rebuild-${spec.releaseId}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    commit: env.GITHUB_SHA,
    environment: spec.authority.environment,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    repository: env.GITHUB_REPOSITORY,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    runId: env.GITHUB_RUN_ID,
    runnerImage: env.ZUGFOLGE_REBUILD_RUNNER_IMAGE,
    workflowRef: env.GITHUB_WORKFLOW_REF
  };
}
function validateWorkflowAuthorityReceipt(value, spec, label) {
  exactKeys4(value, ["artifactAttestation", "artifactName", "attestation", "attestationState", "commit", "environment", "event", "ref", "repository", "runAttempt", "runId", "runnerImage", "workflowRef"], label);
  invariant6(value.artifactAttestation === spec.authority.artifactAttestation && value.environment === spec.authority.environment, `${label} besitzt den falschen Attestation-/Umgebungsvertrag.`);
  invariant6(value.attestationState === "pending-external-verification" && sameCanonicalValue(value.attestation, spec.authority.attestation), `${label} behauptet keine ehrliche externe Attestierungsgrenze.`);
  invariant6(value.repository === spec.authority.repository && value.event === spec.authority.event && value.ref === spec.authority.requiredRef, `${label} bindet falsches Repository, Event oder Ref.`);
  invariant6(typeof value.commit === "string" && GIT_COMMIT2.test(value.commit), `${label}.commit ist ungueltig.`);
  invariant6(typeof value.runId === "string" && /^[1-9]\d*$/u.test(value.runId) && Number.isSafeInteger(value.runAttempt) && value.runAttempt > 0, `${label} bindet keinen gueltigen Workflow-Lauf.`);
  invariant6(spec.authority.runnerImages.includes(value.runnerImage), `${label}.runnerImage ist ungueltig.`);
  invariant6(value.workflowRef.startsWith(`${spec.authority.repository}/${spec.authority.workflowFile}@`), `${label}.workflowRef ist ungueltig.`);
  invariant6(value.artifactName === `operational-validator-rebuild-${spec.releaseId}-${value.runId}-${value.runAttempt}`, `${label}.artifactName driftet vom gebundenen Lauf.`);
  return value;
}
function pathKey(path) {
  const value = resolve6(path).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
}
function sameIdentity5(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function unchangedIdentity(left, right) {
  return sameIdentity5(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function filesystemIdentity(metadata) {
  return { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
}
function validateFilesystemIdentity(value, label) {
  exactKeys4(value, ["dev", "ino"], label);
  invariant6(typeof value.dev === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value.dev), `${label}.dev ist ungueltig.`);
  invariant6(typeof value.ino === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value.ino), `${label}.ino ist ungueltig.`);
  return value;
}
function matchesFilesystemIdentity(metadata, value) {
  return metadata.dev.toString() === value.dev && metadata.ino.toString() === value.ino;
}
function isContained(rootInput, targetInput, { allowRoot = false } = {}) {
  const value = relative4(resolve6(rootInput), resolve6(targetInput));
  return allowRoot && value === "" || value !== "" && value !== ".." && !value.startsWith(`..${sep4}`) && !isAbsolute4(value);
}
async function regularDirectorySnapshot(pathInput, label) {
  const path = resolve6(pathInput);
  const metadata = await lstat6(path, { bigint: true });
  invariant6(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} muss ein regulaeres Verzeichnis ohne Symlink/Junction sein.`);
  invariant6(pathKey(await realpath5(path)) === pathKey(path), `${label} enthaelt einen Symlink-/Junction-Pfad.`);
  return { path, metadata };
}
async function assertDirectoryIdentity(path, expected, label) {
  const actual = await lstat6(path, { bigint: true });
  invariant6(actual.isDirectory() && !actual.isSymbolicLink() && sameIdentity5(actual, expected), `${label} wurde fremd ersetzt.`);
}
async function assertNoSymlinkPath(rootInput, targetInput, label, { leafMayBeMissing = false } = {}) {
  const root2 = resolve6(rootInput);
  const target = resolve6(targetInput);
  invariant6(isContained(root2, target, { allowRoot: true }), `${label} verlaesst seine Wurzel.`);
  const parts = relative4(root2, target).split(sep4).filter(Boolean);
  let cursor = root2;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = resolve6(cursor, parts[index]);
    let metadata;
    try {
      metadata = await lstat6(cursor, { bigint: true });
    } catch (error) {
      if (leafMayBeMissing && index === parts.length - 1 && error?.code === "ENOENT") return;
      throw error;
    }
    invariant6(!metadata.isSymbolicLink(), `${label} enthaelt einen Symlink/Junction: ${cursor}`);
    if (index < parts.length - 1) invariant6(metadata.isDirectory(), `${label} besitzt einen ungueltigen Elternpfad.`);
  }
}
function resolveWorkspaceFile(workspaceRoot2, portableFile, label) {
  validatePortableFile(portableFile, label);
  const value = resolve6(workspaceRoot2, ...portableFile.split("/"));
  invariant6(isContained(workspaceRoot2, value), `${label} verlaesst workspaceRoot.`);
  return value;
}
async function regularFileSnapshot(root2, pathInput, label, maximumBytes, { allowEmpty = false, retainHandle = false } = {}) {
  const path = resolve6(pathInput);
  await assertNoSymlinkPath(root2, path, label);
  const pathBefore = await lstat6(path, { bigint: true });
  invariant6(pathBefore.isFile() && !pathBefore.isSymbolicLink(), `${label} muss eine regulaere Datei sein.`);
  invariant6((allowEmpty ? pathBefore.size >= 0n : pathBefore.size > 0n) && pathBefore.size <= BigInt(maximumBytes), `${label} ist leer oder ueberschreitet ${maximumBytes} Bytes.`);
  const handle = await open6(path, "r");
  let retained = false;
  try {
    const before = await handle.stat({ bigint: true });
    invariant6(before.isFile() && sameIdentity5(pathBefore, before), `${label} wurde vor dem Lesen ersetzt.`);
    const bytes = Buffer.alloc(Number(before.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    invariant6(bytesRead === bytes.length, `${label} wurde nicht vollstaendig gelesen.`);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat6(path, { bigint: true });
    invariant6(unchangedIdentity(before, after) && unchangedIdentity(after, pathAfter), `${label} wurde waehrend des Lesens veraendert.`);
    const result = { bytes, identity: after, path, proof: { bytes: bytes.length, sha256: sha2563(bytes) } };
    if (retainHandle) {
      result.handle = handle;
      retained = true;
    }
    return result;
  } finally {
    if (!retained) await handle.close();
  }
}
function proofMatches(actual, expected, label) {
  invariant6(
    actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
    `${label} driftet von seiner Byte-/SHA-256-Bindung (actual ${actual.bytes}/${actual.sha256}, expected ${expected.bytes}/${expected.sha256}).`
  );
}
async function assertCreateNewTarget2(pathInput, label) {
  const path = resolve6(pathInput);
  try {
    await lstat6(path);
  } catch (error2) {
    if (error2?.code === "ENOENT") return path;
    throw error2;
  }
  const error = new Error(`${label} existiert bereits und darf nicht ersetzt werden: ${path}`);
  error.code = "EEXIST";
  throw error;
}
function encodedOutput(bytes) {
  return { base64: bytes.toString("base64"), bytes: bytes.length, sha256: sha2563(bytes) };
}
function validateEncodedOutput(value, label) {
  exactKeys4(value, ["base64", "bytes", "sha256"], label);
  invariant6(typeof value.base64 === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value.base64), `${label}.base64 ist ungueltig.`);
  invariant6(Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= MAX_PROCESS_OUTPUT_BYTES, `${label}.bytes ist ungueltig.`);
  validateSha256(value.sha256, `${label}.sha256`);
  const bytes = Buffer.from(value.base64, "base64");
  invariant6(bytes.length === value.bytes && sha2563(bytes) === value.sha256, `${label} besitzt keine konsistente Bindung.`);
}
function parseKeyedVerboseVersion(stdout, label) {
  const lines = stdout.toString("utf8").replace(/\r\n/g, "\n").trim().split("\n");
  invariant6(lines.length >= 2, `${label} -vV ist unvollstaendig.`);
  const values = /* @__PURE__ */ new Map();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return { firstLine: lines[0], values };
}
function validateToolchainManifest(value, spec) {
  exactKeys4(value, ["directories", "files", "id", "schema"], "Toolchain-Manifest");
  invariant6(value.schema === TOOLCHAIN_MANIFEST_SCHEMA && typeof value.id === "string" && value.id.length > 0, "Toolchain-Manifest besitzt falsches Schema oder ID.");
  invariant6(Array.isArray(value.directories) && value.directories.length > 0 && value.directories.length <= 1e4, "Toolchain-Manifest.directories ist ungueltig.");
  invariant6(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 1e4, "Toolchain-Manifest.files ist ungueltig.");
  const seen = /* @__PURE__ */ new Set();
  let previous = "";
  for (const directory of value.directories) {
    validatePortableFile(directory, `Toolchain-Manifest-Verzeichnis ${directory}`);
    const key = portableFileSystemKey(directory, `Toolchain-Manifest-Verzeichnis ${directory}`);
    invariant6(!seen.has(key), `Toolchain-Manifest besitzt einen kollidierenden Verzeichnispfad: ${directory}`);
    invariant6(previous === "" || previous.localeCompare(directory, "en") < 0, "Toolchain-Manifest.directories muss streng kanonisch sortiert sein.");
    const segments = directory.split("/");
    if (segments.length > 1) invariant6(seen.has(portableFileSystemKey(segments.slice(0, -1).join("/"), "Toolchain-Manifest-Verzeichnis-Parent")), `Toolchain-Manifest-Verzeichnis ${directory} besitzt keinen manifestierten Parent.`);
    seen.add(key);
    previous = directory;
  }
  const directoryKeys = new Set(seen);
  previous = "";
  let totalBytes = 0;
  for (const entry of value.files) {
    validateProof2(entry, "Toolchain-Manifest.files[]", MAX_TOOL_BYTES, { file: true });
    const key = portableFileSystemKey(entry.file, `Toolchain-Datei ${entry.file}`);
    invariant6(!seen.has(key), `Toolchain-Manifest besitzt einen kollidierenden Pfad: ${entry.file}`);
    invariant6(previous === "" || previous.localeCompare(entry.file, "en") < 0, "Toolchain-Manifest.files muss streng kanonisch sortiert sein.");
    seen.add(key);
    const segments = entry.file.split("/");
    if (segments.length > 1) invariant6(directoryKeys.has(portableFileSystemKey(segments.slice(0, -1).join("/"), "Toolchain-Datei-Parent")), `Toolchain-Datei ${entry.file} besitzt keinen manifestierten Parent.`);
    previous = entry.file;
    totalBytes += entry.bytes;
    invariant6(Number.isSafeInteger(totalBytes), "Toolchain-Manifest-Gesamtgroesse ist ungueltig.");
  }
  invariant6(seen.has(portableFileSystemKey(spec.toolchain.cargoPath, "toolchain.cargoPath")), "Toolchain-Manifest enthaelt cargo nicht.");
  invariant6(seen.has(portableFileSystemKey(spec.toolchain.rustcPath, "toolchain.rustcPath")), "Toolchain-Manifest enthaelt rustc nicht.");
  return { directoryCount: value.directories.length, fileCount: value.files.length, id: value.id, manifestSha256: sha2563(canonicalBytes3({ directories: value.directories, files: value.files })), totalBytes };
}
function decodeAnchorProcessResult(value, label) {
  exactKeys4(value, ["code", "stderr", "stdout"], label);
  invariant6(Number.isSafeInteger(value.code), `${label}.code ist ungueltig.`);
  invariant6(typeof value.stderr === "string" && typeof value.stdout === "string", `${label} besitzt ungueltige Ausgaben.`);
  const stderr = Buffer.from(value.stderr, "base64");
  const stdout = Buffer.from(value.stdout, "base64");
  invariant6(stderr.length + stdout.length <= MAX_PROCESS_OUTPUT_BYTES, `${label}-Ausgabe ist unerwartet gross.`);
  return { code: value.code, stderr, stdout };
}
function windowsBuildAnchorRequestLine(value) {
  return `${Buffer.from(JSON.stringify(value), "utf8").toString("base64")}
`;
}
function windowsBuildAnchorSafeDiagnostic(chunks) {
  const bytes = Buffer.concat(chunks);
  const tail = bytes.subarray(Math.max(0, bytes.length - MAX_WINDOWS_ANCHOR_DIAGNOSTIC_BYTES)).toString("utf8");
  const lines = tail.split(/\r?\n/u);
  let stageDiagnostic = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^ZUGFOLGE_SAFE_ANCHOR_STAGE_DIAGNOSTIC stage=(?:INITIALIZE|RECEIVE_EXTRACTION_PLAN|CREATE_EPHEMERAL_ACCOUNT|CREATE_PRIVATE_ROOT|EXTRACT_SOURCE|EXTRACT_VENDOR|COPY_TOOLCHAIN_DIRECTORIES|COPY_TOOLCHAIN_FILES|CREATE_WRITABLE_ROOTS|FREEZE_SOURCE|FREEZE_TOOLCHAIN|VERIFY_WRITABLE_ROOTS|FREEZE_BUILD_ROOT|START_INTEGRITY_MONITORS|VERIFY_HELD_TREES|REPORT_EXTRACTED|RECEIVE_BUILD_PLAN|RUN_BUILD|RECEIVE_PUBLICATION_PLAN|PUBLISH_OUTPUTS|RECEIVE_PUBLICATION_COMPLETE|COMMIT_PUBLICATION)$/u.test(line)) {
      stageDiagnostic ||= line;
      continue;
    }
    const match = /^(?:ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=(NET_USER_ADD|NET_USER_DELETE|NET_USER_DELETE_VERIFY) status=([1-9][0-9]{0,9})(?: parameter=(0|[1-9][0-9]{0,9}))?|ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=(PROCESS_WITH_LOGON|PROCESS_FROM_ANCHOR) status=([1-9][0-9]{0,9}))$/u.exec(line);
    if (match === null) continue;
    const code = match[1] ?? match[4];
    const status = Number(match[2] ?? match[5]);
    const parameter = match[3] === void 0 ? void 0 : Number(match[3]);
    if (status > 0 && status <= 4294967295 && (parameter === void 0 || parameter <= 4294967295) && (code === "NET_USER_ADD" && status === 87 === (parameter !== void 0) || (code === "NET_USER_DELETE" || code === "NET_USER_DELETE_VERIFY" || code === "PROCESS_WITH_LOGON" || code === "PROCESS_FROM_ANCHOR") && parameter === void 0)) return line;
  }
  return stageDiagnostic;
}
async function startWindowsBuildAnchor({ anchoredParents, buildParent, buildRootLeaf, hooks, spec, workspaceRoot: workspaceRoot2 }) {
  invariant6(process.platform === "win32", "Operational-Validator-Rebuild-Materialisierung ist fuer PE32+ ausschliesslich auf win32 zulaessig.");
  invariant6(Array.isArray(anchoredParents) && anchoredParents.length > 0, "Windows-Build-Anker benoetigt mindestens einen Output-Parent.");
  invariant6(typeof buildRootLeaf === "string" && /^\.operational-validator-rebuild-v3-[a-f0-9-]{36}$/u.test(buildRootLeaf), "Windows-Build-Anker erhielt keinen gueltigen create-new Buildroot-Leaf.");
  const parentRequests = anchoredParents.map((parent) => ({ identity: filesystemIdentity(parent.metadata), path: resolve6(parent.path) })).sort((left, right) => pathKey(left.path).localeCompare(pathKey(right.path)));
  invariant6(new Set(parentRequests.map(({ path }) => pathKey(path))).size === parentRequests.length, "Windows-Build-Anker erhielt doppelte Output-Parents.");
  const buildParentRequest = { identity: filesystemIdentity(buildParent.metadata), path: resolve6(buildParent.path) };
  invariant6(parentRequests.some((entry) => pathKey(entry.path) === pathKey(buildParentRequest.path) && sameCanonicalValue(entry.identity, buildParentRequest.identity)), "Buildroot-Parent fehlt in der verankerten Parentmenge.");
  const buildRoot = resolve6(buildParent.path, buildRootLeaf);
  invariant6(dirname6(buildRoot) === resolve6(buildParent.path), "Create-new Buildroot-Leaf verlaesst seinen Parent.");
  const paths = {
    helper: resolveWorkspaceFile(workspaceRoot2, spec.toolchain.anchor.helperAssembly.file, "toolchain.anchor.helperAssembly.file"),
    manifest: resolveWorkspaceFile(workspaceRoot2, spec.toolchain.manifest.file, "toolchain.manifest.file"),
    source: resolveWorkspaceFile(workspaceRoot2, spec.source.archive.file, "source.archive.file"),
    vendor: resolveWorkspaceFile(workspaceRoot2, spec.source.vendor.archive.file, "source.vendor.archive.file")
  };
  for (const [id, path] of Object.entries(paths)) await assertNoSymlinkPath(workspaceRoot2, path, `${id}-Input`);
  if (hooks.beforeWindowsBuildAnchor) await hooks.beforeWindowsBuildAnchor({ paths: { ...paths }, toolchainRoot: spec.toolchain.root });
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const compressedAnchor = gzipSync(Buffer.from(WINDOWS_BUILD_ANCHOR, "utf8"), { level: 9 });
  const bootstrap = `$s=[Console]::OpenStandardInput();$h=[byte[]]::new(4);$o=0;while($o-lt 4){$n=$s.Read($h,$o,4-$o);if($n-le 0){throw 'Anchor-Laengenheader fehlt.'};$o+=$n};$l=[BitConverter]::ToInt32($h,0);if($l-le 0-or$l-gt 4194304){throw 'Anchor-Laenge ist ungueltig.'};$b=[byte[]]::new($l);$o=0;while($o-lt$l){$n=$s.Read($b,$o,$l-$o);if($n-le 0){throw 'Anchor-Payload endet vorzeitig.'};$o+=$n};$m=[IO.MemoryStream]::new($b);$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);try{& ([ScriptBlock]::Create($r.ReadToEnd()))}finally{$r.Dispose();$g.Dispose();$m.Dispose()}`;
  const encodedCommand = Buffer.from(bootstrap, "utf16le").toString("base64");
  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand], {
    env: {
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Windows\\System32;C:\\Windows",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Windows\\System32",
      TMP: "C:\\Windows\\System32",
      WINDIR: "C:\\Windows"
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const stderr = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_PROCESS_OUTPUT_BYTES) stderr.push(chunk);
    else child.kill();
  });
  const lines = [];
  const waiters = [];
  let pending = "";
  let closed;
  let protocolError;
  let stdoutBytes = 0;
  const closePromise = new Promise((resolveClose, rejectClose) => {
    child.once("error", (error) => {
      protocolError ??= error;
      while (waiters.length > 0) waiters.shift().reject(protocolError);
      rejectClose(error);
    });
    child.once("close", (code, signal) => {
      closed = { code, signal };
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (protocolError) waiter.reject(protocolError);
        else waiter.resolve(void 0);
      }
      resolveClose(closed);
    });
  });
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
      protocolError ??= new Error("Windows-Build-Anker-Ausgabe ist unerwartet gross.");
      child.kill();
      return;
    }
    pending += chunk.toString("utf8");
    for (; ; ) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      pending = pending.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
    }
  });
  const nextLine = () => {
    if (protocolError) return Promise.reject(protocolError);
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(void 0);
    return new Promise((resolveLine, rejectLine) => waiters.push({ reject: rejectLine, resolve: resolveLine }));
  };
  const nextLineBounded = async (label) => {
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`${label} ueberschritt das Anchor-Zeitlimit.`);
        protocolError ??= error;
        child.kill();
        reject(error);
      }, spec.build.processLimits.timeoutMilliseconds);
    });
    try {
      return await Promise.race([nextLine(), timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
  };
  child.stdin.on("error", () => {
  });
  try {
    const anchorHeader = Buffer.alloc(4);
    anchorHeader.writeUInt32LE(compressedAnchor.length, 0);
    child.stdin.write(anchorHeader);
    child.stdin.write(compressedAnchor);
    child.stdin.write(windowsBuildAnchorRequestLine({
      anchoredParents: parentRequests,
      buildParent: buildParentRequest,
      buildRootLeaf,
      cargoPath: spec.toolchain.cargoPath,
      helper: { path: paths.helper, bytes: spec.toolchain.anchor.helperAssembly.bytes, sha256: spec.toolchain.anchor.helperAssembly.sha256 },
      manifest: { path: paths.manifest, bytes: spec.toolchain.manifest.bytes, sha256: spec.toolchain.manifest.sha256 },
      processLimits: spec.build.processLimits,
      rustcPath: spec.toolchain.rustcPath,
      source: { path: paths.source, bytes: spec.source.archive.bytes, sha256: spec.source.archive.sha256 },
      toolchainRoot: spec.toolchain.root,
      vendor: { path: paths.vendor, bytes: spec.source.vendor.archive.bytes, sha256: spec.source.vendor.archive.sha256 },
      vendorRemapPrefix: spec.source.vendor.remapPrefix
    }));
    const ready = await nextLineBounded("Windows-Build-Anker-Handshake");
    if (typeof ready !== "string" || !ready.startsWith("ANCHOR_READY ")) {
      child.stdin.end();
      const end = await closePromise;
      const diagnostic = windowsBuildAnchorSafeDiagnostic(stderr);
      throw new Error(`Windows-Build-Anker band Inputs/Toolchain nicht fail-closed (${end.code ?? end.signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    const readyEnvelope = parseJson(Buffer.from(ready.slice("ANCHOR_READY ".length), "base64"), "Windows-Build-Anker-Ready");
    exactKeys4(readyEnvelope, ["anchoredParents", "buildRoot"], "Windows-Build-Anker-Ready");
    invariant6(resolve6(readyEnvelope.buildRoot) === buildRoot, "Windows-Build-Anker meldete einen falschen create-new Buildroot-Pfad.");
    invariant6(Array.isArray(readyEnvelope.anchoredParents) && readyEnvelope.anchoredParents.length === parentRequests.length, "Windows-Build-Anker meldete eine falsche Output-Parent-Menge.");
    for (let index = 0; index < parentRequests.length; index += 1) {
      const actual = readyEnvelope.anchoredParents[index];
      exactKeys4(actual, ["identity", "path"], `Windows-Build-Anker-Ready.anchoredParents[${index}]`);
      validateFilesystemIdentity(actual.identity, `Windows-Build-Anker-Ready.anchoredParents[${index}].identity`);
      invariant6(pathKey(actual.path) === pathKey(parentRequests[index].path) && sameCanonicalValue(actual.identity, parentRequests[index].identity), "Windows-Build-Anker band nicht exakt die angeforderte Output-Parent-Menge.");
    }
    if (hooks.afterWindowsBuildAnchorReady) await hooks.afterWindowsBuildAnchorReady({ anchoredParents: parentRequests, buildRoot, paths: { ...paths }, toolchainRoot: spec.toolchain.root });
    const [helperSource, source, vendor, manifestSource] = await Promise.all([
      regularFileSnapshot(workspaceRoot2, paths.helper, "Exklusiv gehaltene Anchor-Helper-Assembly", MAX_PRODUCER_BYTES),
      regularFileSnapshot(workspaceRoot2, paths.source, "Exklusiv gehaltenes Source-TAR", MAX_ARCHIVE_BYTES),
      regularFileSnapshot(workspaceRoot2, paths.vendor, "Exklusiv gehaltenes Vendor-TAR", MAX_VENDOR_ARCHIVE_BYTES),
      regularFileSnapshot(workspaceRoot2, paths.manifest, "Exklusiv gehaltenes Toolchain-Manifest", MAX_TOOLCHAIN_MANIFEST_BYTES)
    ]);
    proofMatches(helperSource.proof, spec.toolchain.anchor.helperAssembly, "Exklusiv gehaltene Anchor-Helper-Assembly");
    proofMatches(source.proof, spec.source.archive, "Exklusiv gehaltenes Source-TAR");
    proofMatches(vendor.proof, spec.source.vendor.archive, "Exklusiv gehaltenes Vendor-TAR");
    proofMatches(manifestSource.proof, spec.toolchain.manifest, "Exklusiv gehaltenes Toolchain-Manifest");
    const manifest = parseJson(manifestSource.bytes, "Toolchain-Manifest");
    invariant6(manifestSource.bytes.equals(canonicalBytes3(manifest)), "Toolchain-Manifest ist nicht kanonisch.");
    const manifestInventory = validateToolchainManifest(manifest, spec);
    let finished = false;
    let extracted = false;
    let publication = false;
    let buildRootIdentity;
    const closeAnchorBounded = async (label) => {
      let timeout;
      let timedOut = false;
      const timeoutPromise = new Promise((resolveTimeout) => {
        timeout = setTimeout(() => {
          timedOut = true;
          child.kill();
          resolveTimeout(void 0);
        }, 5e3);
      });
      const end = await Promise.race([closePromise, timeoutPromise]);
      clearTimeout(timeout);
      if (timedOut) {
        const killed = await closePromise;
        throw new Error(`${label} schloss den Windows-Build-Anker nicht innerhalb von 5000 ms (${killed.code ?? killed.signal ?? "unknown"}).`);
      }
      return end;
    };
    return {
      buildRoot,
      get buildRootIdentity() {
        return buildRootIdentity;
      },
      inputs: { helper: helperSource, manifest: { ...spec.toolchain.manifest, ...manifestInventory }, source, vendor },
      async abort() {
        if (finished) return;
        finished = true;
        let hookError;
        if (publication && hooks.beforeWindowsAnchoredPublicationRollback) {
          try {
            await hooks.beforeWindowsAnchoredPublicationRollback();
          } catch (error) {
            hookError = error;
          }
        }
        child.stdin.write("ABORT\n");
        child.stdin.end();
        let closeError;
        try {
          await closeAnchorBounded("Windows-Build-Anker-Abbruch");
        } catch (error) {
          closeError = error;
        }
        if (hookError && closeError) throw new AggregateError([hookError, closeError], "Publikations-Rollback-Hook und Anchor-Abbruch sind fehlgeschlagen.");
        if (hookError) throw hookError;
        if (closeError) throw closeError;
      },
      async extract({ sourceAudit, vendorAudit }) {
        invariant6(!finished && !extracted, "Windows-Build-Anker erhielt einen doppelten Extraktionsplan.");
        const plan = (audit) => ({
          directories: audit.directories,
          files: audit.files.map((entry) => ({ bytes: entry.bytes, file: entry.file, offset: entry.offset, sha256: entry.sha256 }))
        });
        if (hooks.beforeWindowsAnchoredExtraction) await hooks.beforeWindowsAnchoredExtraction({ buildRoot: resolve6(buildRoot) });
        child.stdin.write(windowsBuildAnchorRequestLine({ source: plan(sourceAudit), vendor: plan(vendorAudit) }));
        const line = await nextLineBounded("Windows-Build-Anker-Extraktion");
        if (typeof line !== "string" || !line.startsWith("EXTRACTED ")) {
          child.stdin.end();
          const end = await closeAnchorBounded("Windows-Build-Anker-Extraktionsfehler");
          finished = true;
          const diagnostic = windowsBuildAnchorSafeDiagnostic(stderr);
          throw new Error(`Windows-Build-Anker bestaetigte die interne Slice-Extraktion nicht (${end.code ?? end.signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}.`);
        }
        const envelope = parseJson(Buffer.from(line.slice("EXTRACTED ".length), "base64"), "Windows-Build-Anker-Extraktion");
        exactKeys4(envelope, ["buildRootIdentity"], "Windows-Build-Anker-Extraktion");
        validateFilesystemIdentity(envelope.buildRootIdentity, "Windows-Build-Anker-Extraktion.buildRootIdentity");
        buildRootIdentity = envelope.buildRootIdentity;
        extracted = true;
        return { buildRoot, buildRootIdentity };
      },
      async run({ cargoHome, sourceDirectory, targetDirectory, tempDirectory }) {
        invariant6(!finished && extracted, "Windows-Build-Anker wurde bereits abgeschlossen oder hat nicht extrahiert.");
        if (hooks.beforeWindowsAnchoredBuild) await hooks.beforeWindowsAnchoredBuild({ cargoHome, sourceDirectory, targetDirectory, tempDirectory });
        child.stdin.write(windowsBuildAnchorRequestLine({
          cargoConfig: resolve6(sourceDirectory, ...spec.source.vendor.cargoConfig.file.split("/")),
          cargoHome,
          cargoManifest: resolve6(sourceDirectory, "Cargo.toml"),
          command: spec.build.command,
          expectedOutputBytes: spec.binaries.rebuilt.expectedBytes,
          sourceDirectory,
          targetOutputFile: spec.build.targetOutputFile,
          targetDirectory,
          tempDirectory
        }));
        const line = await nextLineBounded("Windows-Build-Anker-Build");
        if (typeof line !== "string" || !line.startsWith("RESULT ")) {
          child.stdin.end();
          const end = await closePromise;
          finished = true;
          const diagnostic = windowsBuildAnchorSafeDiagnostic(stderr);
          throw new Error(`Windows-Build-Anker lieferte kein Ergebnis (${end.code ?? end.signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}.`);
        }
        const envelope = parseJson(Buffer.from(line.slice("RESULT ".length), "base64"), "Windows-Build-Anker-Ergebnis");
        exactKeys4(envelope, ["build", "cargo", "isolation", "output", "rustc"], "Windows-Build-Anker-Ergebnis");
        exactKeys4(envelope.isolation, ["mode", "principalSidSha256"], "Windows-Build-Anker.isolation");
        invariant6(envelope.isolation.mode === "ephemeral-local-build-account-v1", "Windows-Build-Anker verwendete keine getrennte Build-Identitaet.");
        validateSha256(envelope.isolation.principalSidSha256, "Windows-Build-Anker.isolation.principalSidSha256");
        const result = {
          build: decodeAnchorProcessResult(envelope.build, "Windows-Build-Anker.build"),
          cargo: decodeAnchorProcessResult(envelope.cargo, "Windows-Build-Anker.cargo"),
          isolation: envelope.isolation,
          output: null,
          rustc: decodeAnchorProcessResult(envelope.rustc, "Windows-Build-Anker.rustc")
        };
        if (result.build.code !== 0 || result.cargo.code !== 0 || result.rustc.code !== 0) {
          child.stdin.end();
          const end = await closePromise;
          finished = true;
          const tail = result.build.stderr.toString("utf8").slice(-4096).trim() || windowsBuildAnchorSafeDiagnostic(stderr);
          const error = new Error(`Exklusiv verankerter Windows-Rebuild endete mit ${result.build.code}${tail ? `: ${tail}` : ""}`);
          error.result = result;
          throw error;
        }
        exactKeys4(envelope.output, ["bytes", "identity", "sha256"], "Windows-Build-Anker.output");
        invariant6(envelope.output.bytes === spec.binaries.rebuilt.expectedBytes, "Windows-Build-Anker.output.bytes driftet.");
        validateSha256(envelope.output.sha256, "Windows-Build-Anker.output.sha256");
        validateFilesystemIdentity(envelope.output.identity, "Windows-Build-Anker.output.identity");
        result.output = envelope.output;
        return result;
      },
      async publish({ binary, provenance, receipt }) {
        invariant6(!finished && extracted && !publication, "Windows-Build-Anker kann die Outputs nicht publizieren.");
        for (const [id, value] of Object.entries({ binary, provenance, receipt })) {
          exactKeys4(value, id === "binary" ? ["bytes", "path", "sha256"] : ["bytes", "bytesValue", "path", "sha256"], `Windows-Build-Anker-Publikation.${id}`);
          invariant6(Number.isSafeInteger(value.bytes) && value.bytes > 0, `Windows-Build-Anker-Publikation.${id}.bytes ist ungueltig.`);
          validateSha256(value.sha256, `Windows-Build-Anker-Publikation.${id}.sha256`);
          invariant6(isAbsolute4(value.path), `Windows-Build-Anker-Publikation.${id}.path ist nicht absolut.`);
          if (id !== "binary") {
            invariant6(
              Buffer.isBuffer(value.bytesValue) && value.bytesValue.length === value.bytes && sha2563(value.bytesValue) === value.sha256,
              `Windows-Build-Anker-Publikation.${id} driftet von seinen gehaltenen Bytes.`
            );
          }
        }
        const request = {
          binary: { bytes: binary.bytes, file: resolve6(binary.path), sha256: binary.sha256 },
          provenance: { base64: provenance.bytesValue.toString("base64"), bytes: provenance.bytes, file: resolve6(provenance.path), sha256: provenance.sha256 },
          receipt: { base64: receipt.bytesValue.toString("base64"), bytes: receipt.bytes, file: resolve6(receipt.path), sha256: receipt.sha256 }
        };
        if (hooks.beforeWindowsAnchoredPublication) await hooks.beforeWindowsAnchoredPublication({ request });
        child.stdin.write(`PUBLISH ${Buffer.from(JSON.stringify(request), "utf8").toString("base64")}
`);
        const line = await nextLineBounded("Windows-Build-Anker-Publikation");
        if (typeof line !== "string" || !line.startsWith("PUBLISHED ")) {
          child.stdin.end();
          const end = await closeAnchorBounded("Windows-Build-Anker-Publikationsfehler");
          finished = true;
          const diagnostic = windowsBuildAnchorSafeDiagnostic(stderr);
          throw new Error(`Windows-Build-Anker bestaetigte die handle-relative Publikation nicht (${end.code ?? end.signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}.`);
        }
        const envelope = parseJson(Buffer.from(line.slice("PUBLISHED ".length), "base64"), "Windows-Build-Anker-Publikation");
        exactKeys4(envelope, ["binary", "provenance", "receipt"], "Windows-Build-Anker-Publikation");
        for (const [id, expected] of Object.entries({ binary, provenance, receipt })) {
          exactKeys4(envelope[id], ["bytes", "identity", "sha256"], `Windows-Build-Anker-Publikation.${id}`);
          validateFilesystemIdentity(envelope[id].identity, `Windows-Build-Anker-Publikation.${id}.identity`);
          proofMatches(envelope[id], expected, `Windows-Build-Anker-Publikation.${id}`);
        }
        publication = true;
        if (hooks.afterWindowsAnchoredPublication) await hooks.afterWindowsAnchoredPublication({ publication: envelope });
        return envelope;
      },
      async completePublication() {
        invariant6(!finished && extracted && publication, "Windows-Build-Anker kann die Publikation nicht mehr abschliessen.");
        child.stdin.write("PUBLICATION_COMPLETE\n");
        child.stdin.end();
        const end = await closeAnchorBounded("Windows-Build-Anker-Publikationsabschluss");
        finished = true;
        const diagnostic = windowsBuildAnchorSafeDiagnostic(stderr);
        invariant6(!end.signal && end.code === 0, `Windows-Build-Anker konnte gehaltene Inputs/Outputs nicht sauber abschliessen (${end.code ?? end.signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}.`);
      }
    };
  } catch (error) {
    child.stdin.end();
    child.kill();
    let closeError;
    try {
      await closePromise;
    } catch (failure) {
      closeError = failure;
    }
    if (closeError && closeError !== error) throw new AggregateError([error, closeError], "Windows-Build-Anker-Handshake und Child-Close sind fehlgeschlagen.");
    throw error;
  }
}
function toolchainReceiptFromAnchor(result, spec, manifest, runnerAnchorHelper) {
  const rustcVerbose = parseKeyedVerboseVersion(result.rustc.stdout, "rustc");
  const cargoVerbose = parseKeyedVerboseVersion(result.cargo.stdout, "cargo");
  const rustcIdentity = { commitHash: rustcVerbose.values.get("commit-hash"), host: rustcVerbose.values.get("host"), llvmVersion: rustcVerbose.values.get("LLVM version"), release: rustcVerbose.values.get("release") };
  const cargoIdentity = { commitHash: cargoVerbose.values.get("commit-hash"), host: cargoVerbose.values.get("host"), release: cargoVerbose.values.get("release") };
  invariant6(rustcVerbose.firstLine.startsWith(`rustc ${rustcIdentity.release} (${String(rustcIdentity.commitHash).slice(0, 9)} `), "rustc -vV besitzt eine inkonsistente Kopfzeile.");
  invariant6(cargoVerbose.firstLine.startsWith(`cargo ${cargoIdentity.release} (${String(cargoIdentity.commitHash).slice(0, 9)} `), "cargo -vV besitzt eine inkonsistente Kopfzeile.");
  invariant6(sameCanonicalValue(rustcIdentity, spec.toolchain.rustc), "rustc-Toolchain driftet von der Rebuild-Spec.");
  invariant6(sameCanonicalValue(cargoIdentity, spec.toolchain.cargo), "cargo-Toolchain driftet von der Rebuild-Spec.");
  return {
    anchor: {
      buildPrincipal: result.isolation,
      helperAssembly: spec.toolchain.anchor.helperAssembly,
      inputIsolation: "private-create-new-owner-rights-protected-dacl-read-execute-v1",
      mode: spec.toolchain.anchor.mode,
      mutationMonitoring: "read-directory-changes-monotonic-subtree-v1",
      processTreeMitigation: "identity-anchor-parent-handle-list-no-local-inherit-no-low-label-prefer-system32-job-empty-v4",
      runnerAnchorHelper
    },
    cargo: { command: ["cargo", "-vV"], identity: cargoIdentity, output: encodedOutput(result.cargo.stdout), relativePath: spec.toolchain.cargoPath },
    manifest,
    platform: spec.toolchain.platform,
    rootPathSha256: sha2563(Buffer.from(pathKey(spec.toolchain.root), "utf8")),
    rustc: { command: ["rustc", "-vV"], identity: rustcIdentity, output: encodedOutput(result.rustc.stdout), relativePath: spec.toolchain.rustcPath }
  };
}
function readUInt16(buffer, offset, label) {
  invariant6(Number.isSafeInteger(offset) && offset >= 0 && offset + 2 <= buffer.length, `${label} liegt ausserhalb der PE-Datei.`);
  return buffer.readUInt16LE(offset);
}
function readUInt32(buffer, offset, label) {
  invariant6(Number.isSafeInteger(offset) && offset >= 0 && offset + 4 <= buffer.length, `${label} liegt ausserhalb der PE-Datei.`);
  return buffer.readUInt32LE(offset);
}
function parseSectionName(buffer, offset) {
  const raw = buffer.subarray(offset, offset + 8);
  const zero = raw.indexOf(0);
  const name = (zero === -1 ? raw : raw.subarray(0, zero)).toString("ascii");
  invariant6(name.length > 0 && /^[.A-Za-z0-9_$]+$/.test(name), "PE enthaelt einen ungueltigen Section-Namen.");
  return name;
}
function inspectPe(buffer, label, expectedMachine) {
  invariant6(buffer.length >= 512 && buffer.subarray(0, 2).equals(Buffer.from("MZ", "ascii")), `${label} ist kein MZ/PE-Binary.`);
  const peOffset = readUInt32(buffer, 60, `${label}.peOffset`);
  invariant6(peOffset >= 64 && peOffset + 24 <= buffer.length && buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from([80, 69, 0, 0])), `${label} besitzt keinen gueltigen PE-Header.`);
  const coffOffset = peOffset + 4;
  const machine = readUInt16(buffer, coffOffset, `${label}.machine`);
  const numberOfSections = readUInt16(buffer, coffOffset + 2, `${label}.numberOfSections`);
  const timeDateStampOffset = coffOffset + 4;
  const sizeOfOptionalHeader = readUInt16(buffer, coffOffset + 16, `${label}.sizeOfOptionalHeader`);
  const optionalHeaderOffset = coffOffset + 20;
  const optionalHeaderMagic = readUInt16(buffer, optionalHeaderOffset, `${label}.optionalHeaderMagic`);
  const checkSumOffset = optionalHeaderOffset + 64;
  invariant6(machine === expectedMachine && optionalHeaderMagic === 523 && sizeOfOptionalHeader >= 68, `${label} ist nicht das erwartete AMD64 PE32+.`);
  invariant6(numberOfSections > 0 && numberOfSections <= 96, `${label} besitzt eine unplausible Section-Anzahl.`);
  const sectionTableOffset = optionalHeaderOffset + sizeOfOptionalHeader;
  invariant6(sectionTableOffset + numberOfSections * 40 <= buffer.length, `${label}.Section-Tabelle liegt ausserhalb der Datei.`);
  const sections = [];
  for (let index = 0; index < numberOfSections; index += 1) {
    const offset = sectionTableOffset + index * 40;
    const name = parseSectionName(buffer, offset);
    const virtualSize = readUInt32(buffer, offset + 8, `${label}.${name}.virtualSize`);
    const virtualAddress = readUInt32(buffer, offset + 12, `${label}.${name}.virtualAddress`);
    const rawDataBytes = readUInt32(buffer, offset + 16, `${label}.${name}.rawDataBytes`);
    const rawDataPointer = readUInt32(buffer, offset + 20, `${label}.${name}.rawDataPointer`);
    invariant6(rawDataBytes === 0 || rawDataPointer > 0 && rawDataPointer + rawDataBytes <= buffer.length, `${label}.${name} besitzt einen ungueltigen Raw-Bereich.`);
    const raw = rawDataBytes === 0 ? Buffer.alloc(0) : buffer.subarray(rawDataPointer, rawDataPointer + rawDataBytes);
    sections.push({ index, name, rawDataBytes, rawDataPointer, rawSha256: sha2563(raw), virtualAddress, virtualSize });
  }
  invariant6(new Set(sections.map(({ name }) => name)).size === sections.length, `${label} besitzt doppelte Section-Namen.`);
  return {
    header: {
      coffTimeDateStamp: { offset: timeDateStampOffset, value: readUInt32(buffer, timeDateStampOffset, `${label}.coffTimeDateStamp`) },
      dosSignature: "MZ",
      machine,
      numberOfSections,
      optionalHeaderCheckSum: { offset: checkSumOffset, value: readUInt32(buffer, checkSumOffset, `${label}.optionalHeaderCheckSum`) },
      optionalHeaderMagic,
      peOffset,
      peSignature: "PE\\0\\0",
      sectionTableOffset,
      sizeOfOptionalHeader
    },
    sections
  };
}
function inspectPePair(preservedBytes, rebuiltBytes, spec) {
  invariant6(preservedBytes.length === rebuiltBytes.length, "Preserved und official rebuilt Validator besitzen verschiedene Dateilaengen.");
  const preserved = inspectPe(preservedBytes, "Preserved Validator", spec.pe.machine);
  const rebuilt = inspectPe(rebuiltBytes, "Official Rebuilt Validator", spec.pe.machine);
  invariant6(preserved.header.coffTimeDateStamp.offset === 136 && rebuilt.header.coffTimeDateStamp.offset === 136, "COFF TimeDateStamp liegt nicht bei Offset 136.");
  invariant6(preserved.header.optionalHeaderCheckSum.offset === 216 && rebuilt.header.optionalHeaderCheckSum.offset === 216, "OptionalHeader CheckSum liegt nicht bei Offset 216.");
  invariant6(preserved.sections.length === EXPECTED_SECTIONS.length && rebuilt.sections.length === EXPECTED_SECTIONS.length, "PE besitzt nicht exakt zehn erwartete Sections.");
  const sections = preserved.sections.map((left, index) => {
    const right = rebuilt.sections[index];
    const expected = EXPECTED_SECTIONS[index];
    invariant6(left.name === expected.name && right.name === expected.name, `PE-Section ${index} driftet in Name oder Reihenfolge.`);
    invariant6(left.rawDataBytes === right.rawDataBytes && left.virtualSize === right.virtualSize, `PE-Section ${left.name} driftet in Groesse.`);
    invariant6(left.rawSha256 === right.rawSha256, `PE-Section ${left.name} besitzt verschiedene Raw-SHA-256.`);
    invariant6(expected.rawData === "empty" ? left.rawDataBytes === 0 : left.rawDataBytes > 0, `PE-Section ${left.name} verletzt ihren Raw-Datenvertrag.`);
    return { index, name: left.name, preservedRawSha256: left.rawSha256, rawDataBytes: left.rawDataBytes, rawDataPointer: left.rawDataPointer, rebuiltRawSha256: right.rawSha256, virtualAddress: left.virtualAddress, virtualSize: left.virtualSize };
  });
  const allowed = new Set(EXPECTED_NORMALIZATION_FIELDS.flatMap((field) => Array.from({ length: field.bytes }, (_, index) => field.offset + index)));
  const differingOffsets = [];
  for (let offset = 0; offset < preservedBytes.length; offset += 1) {
    if (preservedBytes[offset] === rebuiltBytes[offset]) continue;
    invariant6(allowed.has(offset), `Validator-Binaries unterscheiden sich am nicht erlaubten Offset ${offset}.`);
    differingOffsets.push(offset);
  }
  const normalizedPreserved = Buffer.from(preservedBytes);
  const normalizedRebuilt = Buffer.from(rebuiltBytes);
  for (const field of EXPECTED_NORMALIZATION_FIELDS) {
    normalizedPreserved.fill(0, field.offset, field.offset + field.bytes);
    normalizedRebuilt.fill(0, field.offset, field.offset + field.bytes);
  }
  invariant6(normalizedPreserved.equals(normalizedRebuilt), "Validator-Binaries sind ausserhalb der PE-Normalisierungsfelder nicht bytegleich.");
  const preservedNormalizedSha256 = sha2563(normalizedPreserved);
  const rebuiltNormalizedSha256 = sha2563(normalizedRebuilt);
  invariant6(preservedNormalizedSha256 === spec.pe.normalizedSha256 && rebuiltNormalizedSha256 === spec.pe.normalizedSha256, "Normalisierter Validator-SHA-256 driftet von der Spec.");
  return { allowedNormalizationFields: EXPECTED_NORMALIZATION_FIELDS, differingOffsets, headers: { preserved: preserved.header, rebuilt: rebuilt.header }, normalized: { expectedSha256: spec.pe.normalizedSha256, preservedSha256: preservedNormalizedSha256, rebuiltSha256: rebuiltNormalizedSha256 }, sections };
}
function tarText(bytes, offset, length) {
  const field = bytes.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return (zero < 0 ? field : field.subarray(0, zero)).toString("utf8");
}
function tarOctal(bytes, offset, length, label) {
  const text = tarText(bytes, offset, length).replace(/^\s+|\s+$/g, "");
  invariant6(/^[0-7]+$/.test(text), `${label} ist kein kanonisches Oktalfeld.`);
  const value = Number.parseInt(text, 8);
  invariant6(Number.isSafeInteger(value) && value >= 0, `${label} ist ausserhalb des sicheren Zahlenbereichs.`);
  return value;
}
function parsePaxRecords(bytes, label) {
  const records = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    invariant6(space > offset, `${label} besitzt einen ungueltigen Record-Laengenprefix.`);
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    invariant6(/^[1-9][0-9]*$/.test(lengthText), `${label} besitzt eine ungueltige Record-Laenge.`);
    const length = Number(lengthText);
    invariant6(Number.isSafeInteger(length) && length > space - offset + 3 && offset + length <= bytes.length, `${label} Record liegt ausserhalb des PAX-Headers.`);
    const record = bytes.subarray(space + 1, offset + length);
    invariant6(record.at(-1) === 10, `${label} Record endet nicht mit LF.`);
    const payload = record.subarray(0, -1).toString("utf8");
    const equals = payload.indexOf("=");
    invariant6(equals > 0, `${label} Record besitzt kein Schluessel/Wert-Paar.`);
    const key = payload.slice(0, equals);
    invariant6(!Object.hasOwn(records, key), `${label} besitzt einen doppelten PAX-Schluessel ${key}.`);
    records[key] = payload.slice(equals + 1);
    offset += length;
  }
  invariant6(offset === bytes.length, `${label} besitzt nach dem letzten Record Restbytes.`);
  return records;
}
function auditPinnedRegularTar(bytes, { archive, expectedComment, expectedTree, label, requiredFile }) {
  invariant6(bytes.length === archive.bytes && sha2563(bytes) === archive.sha256, `${label} driftet vom Spec-Pin.`);
  invariant6(bytes.length % 512 === 0, `${label} besitzt keine vollstaendige 512-Byte-Blockstruktur.`);
  const manifest = [];
  const files = [];
  const directories = /* @__PURE__ */ new Set();
  const explicitPaths = /* @__PURE__ */ new Map();
  const observedPathSpellings = /* @__PURE__ */ new Map();
  const pathsWithDescendants = /* @__PURE__ */ new Set();
  let globalPaxComment;
  let sawGlobalPax = false;
  let localPax;
  let offset = 0;
  let headerCount = 0;
  let sawEnd = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      invariant6(bytes.length - offset >= 1024, `${label} besitzt weniger als zwei Endmarker-Bloecke.`);
      invariant6(bytes.subarray(offset).every((byte) => byte === 0), `${label} besitzt Nicht-Null-Restdaten hinter dem Endmarker.`);
      break;
    }
    headerCount += 1;
    invariant6(headerCount <= MAX_SOURCE_TREE_ENTRIES, `${label} besitzt zu viele Header-Eintraege.`);
    invariant6(tarText(header, 257, 6) === "ustar" && tarText(header, 263, 2) === "00", `${label} besitzt keinen kanonischen ustar-Header.`);
    const storedChecksum = tarOctal(header, 148, 8, "TAR.checksum");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    invariant6(checksum === storedChecksum, `${label} besitzt einen ungueltigen Header-Checksum.`);
    const headerSize = tarOctal(header, 124, 12, "TAR.size");
    const type = String.fromCharCode(header[156] || 48);
    const dataOffset = offset + 512;
    invariant6(dataOffset + headerSize <= bytes.length, `${label}-Eintrag liegt ausserhalb des Archivs.`);
    const data = bytes.subarray(dataOffset, dataOffset + headerSize);
    const paddedEnd = dataOffset + Math.ceil(headerSize / 512) * 512;
    invariant6(paddedEnd <= bytes.length, `${label}-Eintrag besitzt keinen vollstaendigen Padding-Block.`);
    invariant6(bytes.subarray(dataOffset + headerSize, paddedEnd).every((byte) => byte === 0), `${label}-Eintrag besitzt Nicht-Null-Padding.`);
    if (type === "g") {
      invariant6(!sawGlobalPax && offset === 0 && localPax === void 0, `${label} besitzt einen doppelten oder falsch positionierten globalen PAX-Header.`);
      const records = parsePaxRecords(data, "Globaler PAX-Header");
      exactKeys4(records, ["comment"], "Globaler PAX-Header");
      globalPaxComment = records.comment;
      sawGlobalPax = true;
    } else if (type === "x") {
      invariant6(localPax === void 0, `${label} besitzt verschachtelte lokale PAX-Header.`);
      localPax = parsePaxRecords(data, "Lokaler PAX-Header");
      exactKeys4(localPax, ["path"], "Lokaler PAX-Header");
    } else {
      const prefix = tarText(header, 345, 155);
      const headerName = tarText(header, 0, 100);
      const file = localPax?.path ?? (prefix ? `${prefix}/${headerName}` : headerName);
      localPax = void 0;
      invariant6(typeof file === "string" && file.length > 0, `${label} besitzt einen leeren Pfad.`);
      const directoryMarker = file.endsWith("/");
      const normalizedFile = directoryMarker ? file.slice(0, -1) : file;
      const normalizedKey = portableFileSystemKey(normalizedFile, `${label}-Pfad ${file}`);
      invariant6(tarText(header, 157, 100) === "", `${label} ${file} besitzt ein unerwartetes Linkziel.`);
      invariant6(type === "0" || type === "5", `${label} besitzt einen verbotenen Eintragstyp ${type} fuer ${file}.`);
      invariant6(type === "5" ? directoryMarker && data.length === 0 : !directoryMarker, `${label} ${file} besitzt keinen kanonischen Datei-/Verzeichnispfad.`);
      invariant6(!explicitPaths.has(normalizedKey), `${label} besitzt einen unter Windows doppelten oder kollidierenden Datei- oder Verzeichniseintrag: ${normalizedFile}`);
      invariant6(!observedPathSpellings.has(normalizedKey) || observedPathSpellings.get(normalizedKey) === normalizedFile, `${label} verwendet fuer denselben Windows-Pfad verschiedene Schreibweisen: ${normalizedFile}`);
      observedPathSpellings.set(normalizedKey, normalizedFile);
      const segments = normalizedFile.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const ancestor = segments.slice(0, index).join("/");
        const ancestorKey = portableFileSystemKey(ancestor, `${label}-Vorfahre ${ancestor}`);
        invariant6(!observedPathSpellings.has(ancestorKey) || observedPathSpellings.get(ancestorKey) === ancestor, `${label} verwendet fuer denselben Windows-Vorfahren verschiedene Schreibweisen: ${ancestor}`);
        observedPathSpellings.set(ancestorKey, ancestor);
        invariant6(explicitPaths.get(ancestorKey) !== "file", `${label} besitzt einen Pfad unter der regulaeren Datei ${ancestor}.`);
        pathsWithDescendants.add(ancestorKey);
        directories.add(ancestor);
      }
      if (type === "0") invariant6(!pathsWithDescendants.has(normalizedKey), `${label}-Datei ${normalizedFile} kollidiert mit bereits vorhandenen Nachfahren.`);
      explicitPaths.set(normalizedKey, type === "0" ? "file" : "directory");
      if (type === "0") {
        invariant6(data.length <= MAX_SOURCE_FILE_BYTES, `${label}-Datei ${normalizedFile} ueberschreitet ${MAX_SOURCE_FILE_BYTES} Bytes.`);
        manifest.push({ bytes: data.length, file: normalizedFile, sha256: sha2563(data) });
        files.push({ bytes: data.length, file: normalizedFile, offset: dataOffset, sha256: sha2563(data) });
        invariant6(manifest.length <= MAX_SOURCE_TREE_ENTRIES, `${label} besitzt zu viele regulaere Dateien.`);
      } else directories.add(normalizedFile);
    }
    offset = paddedEnd;
  }
  invariant6(sawEnd && manifest.length > 0 && localPax === void 0, `${label} besitzt keinen vollstaendigen Endmarker oder Dateibaum.`);
  invariant6(globalPaxComment === expectedComment, `${label}-PAX-Kommentar bindet nicht den Spec-Pin.`);
  manifest.sort((left, right) => left.file.localeCompare(right.file, "en"));
  files.sort((left, right) => left.file.localeCompare(right.file, "en"));
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0);
  const extractedTree = { fileCount: manifest.length, manifestSha256: sha2563(canonicalBytes3(manifest)), totalBytes };
  invariant6(sameCanonicalValue(extractedTree, expectedTree), `${label}-Tree driftet vom vollstaendigen Spec-Manifest.`);
  let required;
  if (requiredFile) {
    required = manifest.find(({ file }) => file === requiredFile.file);
    invariant6(required !== void 0, `${label} enthaelt ${requiredFile.file} nicht.`);
    proofMatches({ bytes: required.bytes, sha256: required.sha256 }, requiredFile, `${label} ${requiredFile.file}`);
  }
  return {
    directories: [...directories].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right, "en")),
    extractedTree,
    files,
    manifest,
    required
  };
}
function auditPinnedSourceArchive(bytes, spec) {
  const audit = auditPinnedRegularTar(bytes, {
    archive: spec.source.archive,
    expectedComment: spec.source.commit,
    expectedTree: spec.source.tree,
    label: "Commit-TAR",
    requiredFile: spec.source.cargoLock
  });
  return { ...audit, cargoLock: { file: audit.required.file, bytes: audit.required.bytes, sha256: audit.required.sha256 } };
}
function auditPinnedVendorArchive(bytes, spec) {
  return auditPinnedRegularTar(bytes, {
    archive: spec.source.vendor.archive,
    expectedComment: "cargo-vendor-tree-v1",
    expectedTree: spec.source.vendor.tree,
    label: "Cargo-Vendor-TAR",
    requiredFile: spec.source.vendor.cargoConfig
  });
}
async function validateProducerProofs({ producerProofs, spec, workspaceRoot: _workspaceRoot }) {
  exactKeys4(producerProofs, PRODUCER_IDS, "producerProofs");
  const result = {};
  for (const id of PRODUCER_IDS) {
    validateProof2(producerProofs[id], `producerProofs.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant6(sameCanonicalValue(producerProofs[id], spec.producer[id]), `producerProofs.${id} driftet vom externen Spec-Pin.`);
    result[id] = { ...producerProofs[id] };
  }
  return result;
}
async function validateSpecInputs({ spec, specBytes, specFile, workspaceRoot: workspaceRoot2 }) {
  validateOperationalValidatorRebuildSpec(spec);
  const supplied = Buffer.from(specBytes);
  invariant6(supplied.length > 0 && supplied.length <= MAX_SPEC_BYTES && supplied.equals(canonicalBytes3(spec)), "specBytes ist nicht die kanonische Rebuild-Spec.");
  const path = resolve6(specFile);
  invariant6(isContained(workspaceRoot2, path), "specFile verlaesst workspaceRoot.");
  return { bytes: supplied.length, file: relative4(workspaceRoot2, path).split(sep4).join("/"), path, sha256: sha2563(supplied) };
}
function sourceArchiveEvidence({ sourceAudit, sourceProof, spec, vendorAudit, vendorProof }) {
  return {
    archive: { embeddedCommit: spec.source.commit, file: spec.source.archive.file, format: spec.source.archive.format, ...sourceProof },
    cargoLock: { ...sourceAudit.cargoLock },
    extractedTree: sourceAudit.extractedTree,
    materialization: {
      commit: spec.source.commit,
      mode: "pinned-preexisting-archive",
      treeManifestSha256: sourceAudit.extractedTree.manifestSha256
    },
    vendor: {
      archive: { file: spec.source.vendor.archive.file, format: spec.source.vendor.archive.format, ...vendorProof },
      cargoConfig: { ...spec.source.vendor.cargoConfig },
      extractedTree: vendorAudit.extractedTree,
      materialization: {
        mode: "pinned-preexisting-cargo-vendor-archive",
        treeManifestSha256: vendorAudit.extractedTree.manifestSha256
      },
      remapPrefix: spec.source.vendor.remapPrefix
    }
  };
}
async function pathExists(path) {
  try {
    await lstat6(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
async function cleanupOwnedBuildRoot(parent, stagingRoot, stagingIdentity, hooks = {}) {
  await assertDirectoryIdentity(parent.path, parent.metadata, "Build-Elternverzeichnis vor konservativer Retention");
  const current = await lstat6(stagingRoot, { bigint: true });
  invariant6(current.isDirectory() && !current.isSymbolicLink() && sameIdentity5(current, stagingIdentity), "Privater Buildbaum driftete; Retention laesst alle Pfade unangetastet.");
  if (hooks.beforeBuildRootRetention) await hooks.beforeBuildRootRetention({ stagingRoot });
  const final = await lstat6(stagingRoot, { bigint: true });
  invariant6(unchangedIdentity(current, final), "Privater Buildbaum driftete waehrend der konservativen Retention; alle Pfade bleiben unangetastet.");
  await assertDirectoryIdentity(parent.path, parent.metadata, "Build-Elternverzeichnis nach konservativer Retention");
  return { mode: "private-build-root-retained-v1", path: stagingRoot };
}
function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON.`, { cause: error });
  }
}
function validateToolchainReceipt(toolchain, spec) {
  exactKeys4(toolchain, ["anchor", "cargo", "manifest", "platform", "rootPathSha256", "rustc"], "Receipt.toolchain");
  exactKeys4(toolchain.anchor, ["buildPrincipal", "helperAssembly", "inputIsolation", "mode", "mutationMonitoring", "processTreeMitigation", "runnerAnchorHelper"], "Receipt.toolchain.anchor");
  exactKeys4(toolchain.anchor.buildPrincipal, ["mode", "principalSidSha256"], "Receipt.toolchain.anchor.buildPrincipal");
  invariant6(toolchain.anchor.buildPrincipal.mode === "ephemeral-local-build-account-v1", "Receipt.toolchain.anchor.buildPrincipal.mode driftet.");
  validateSha256(toolchain.anchor.buildPrincipal.principalSidSha256, "Receipt.toolchain.anchor.buildPrincipal.principalSidSha256");
  invariant6(sameCanonicalValue(toolchain.anchor.helperAssembly, spec.toolchain.anchor.helperAssembly), "Receipt.toolchain.anchor.helperAssembly driftet.");
  validateProof2(toolchain.anchor.runnerAnchorHelper, "Receipt.toolchain.anchor.runnerAnchorHelper", MAX_PRODUCER_BYTES, { file: true });
  invariant6(sameCanonicalValue(toolchain.anchor.runnerAnchorHelper, spec.toolchain.anchor.helperAssembly), "Receipt.toolchain.anchor.runnerAnchorHelper driftet von derselben Annual-gepinnten Helper-Assembly.");
  invariant6(toolchain.anchor.inputIsolation === "private-create-new-owner-rights-protected-dacl-read-execute-v1", "Receipt.toolchain.anchor.inputIsolation driftet.");
  invariant6(toolchain.anchor.mode === spec.toolchain.anchor.mode, "Receipt.toolchain.anchor.mode driftet.");
  invariant6(toolchain.anchor.mutationMonitoring === "read-directory-changes-monotonic-subtree-v1", "Receipt.toolchain.anchor.mutationMonitoring driftet.");
  invariant6(toolchain.anchor.processTreeMitigation === "identity-anchor-parent-handle-list-no-local-inherit-no-low-label-prefer-system32-job-empty-v4", "Receipt.toolchain.anchor.processTreeMitigation driftet.");
  invariant6(toolchain.platform === spec.toolchain.platform, "Receipt.toolchain.platform driftet.");
  validateSha256(toolchain.rootPathSha256, "Receipt.toolchain.rootPathSha256");
  invariant6(toolchain.rootPathSha256 === sha2563(Buffer.from(pathKey(spec.toolchain.root), "utf8")), "Receipt.toolchain.rootPathSha256 driftet.");
  exactKeys4(toolchain.manifest, ["bytes", "directoryCount", "file", "fileCount", "id", "manifestSha256", "sha256", "totalBytes"], "Receipt.toolchain.manifest");
  validateProof2({ bytes: toolchain.manifest.bytes, file: toolchain.manifest.file, sha256: toolchain.manifest.sha256 }, "Receipt.toolchain.manifest.fileProof", MAX_TOOLCHAIN_MANIFEST_BYTES, { file: true });
  invariant6(sameCanonicalValue({ bytes: toolchain.manifest.bytes, file: toolchain.manifest.file, sha256: toolchain.manifest.sha256 }, spec.toolchain.manifest), "Receipt.toolchain.manifest driftet vom Spec-Pin.");
  invariant6(Number.isSafeInteger(toolchain.manifest.directoryCount) && toolchain.manifest.directoryCount > 0, "Receipt.toolchain.manifest.directoryCount ist ungueltig.");
  invariant6(Number.isSafeInteger(toolchain.manifest.fileCount) && toolchain.manifest.fileCount > 0, "Receipt.toolchain.manifest.fileCount ist ungueltig.");
  invariant6(Number.isSafeInteger(toolchain.manifest.totalBytes) && toolchain.manifest.totalBytes > 0, "Receipt.toolchain.manifest.totalBytes ist ungueltig.");
  invariant6(typeof toolchain.manifest.id === "string" && toolchain.manifest.id.length > 0, "Receipt.toolchain.manifest.id ist ungueltig.");
  validateSha256(toolchain.manifest.manifestSha256, "Receipt.toolchain.manifest.manifestSha256");
  exactKeys4(toolchain.cargo, ["command", "identity", "output", "relativePath"], "Receipt.toolchain.cargo");
  validateStringArray(toolchain.cargo.command, ["cargo", "-vV"], "Receipt.toolchain.cargo.command");
  invariant6(toolchain.cargo.relativePath === spec.toolchain.cargoPath, "Receipt.toolchain.cargo.relativePath driftet.");
  validateCargoIdentity(toolchain.cargo.identity, "Receipt.toolchain.cargo.identity");
  invariant6(sameCanonicalValue(toolchain.cargo.identity, spec.toolchain.cargo), "Receipt bindet die falsche Cargo-Toolchain.");
  validateEncodedOutput(toolchain.cargo.output, "Receipt.toolchain.cargo.output");
  exactKeys4(toolchain.rustc, ["command", "identity", "output", "relativePath"], "Receipt.toolchain.rustc");
  validateStringArray(toolchain.rustc.command, ["rustc", "-vV"], "Receipt.toolchain.rustc.command");
  invariant6(toolchain.rustc.relativePath === spec.toolchain.rustcPath, "Receipt.toolchain.rustc.relativePath driftet.");
  validateRustcIdentity(toolchain.rustc.identity, "Receipt.toolchain.rustc.identity");
  invariant6(sameCanonicalValue(toolchain.rustc.identity, spec.toolchain.rustc), "Receipt bindet die falsche Rustc-Toolchain.");
  validateEncodedOutput(toolchain.rustc.output, "Receipt.toolchain.rustc.output");
}
function validateEnvironmentReceipt(value, spec) {
  exactKeys4(value, ["allowedInherited", "cargoConfiguration", "cleared", "fixed", "targetDirectory"], "Receipt.build.environment");
  invariant6(Array.isArray(value.allowedInherited) && value.allowedInherited.length === spec.build.environmentPolicy.allowedInherited.length, "Receipt.build.environment.allowedInherited muss alle erlaubten Namen binden.");
  for (const [index, entry] of value.allowedInherited.entries()) {
    invariant6(entry?.name === spec.build.environmentPolicy.allowedInherited[index], "Receipt bindet Umgebungsvariablen nicht in der festgelegten Reihenfolge.");
    if (entry.present === false) {
      exactKeys4(entry, ["name", "present"], "Receipt.build.environment.allowedInherited[]");
      continue;
    }
    exactKeys4(entry, ["bytes", "name", "present", "sha256"], "Receipt.build.environment.allowedInherited[]");
    invariant6(entry.present === true, `Receipt.build.environment.${entry.name}.present ist ungueltig.`);
    validatePositiveBytes(entry.bytes, `Receipt.build.environment.${entry.name}.bytes`, 64 * 1024);
    validateSha256(entry.sha256, `Receipt.build.environment.${entry.name}.sha256`);
  }
  invariant6(value.allowedInherited.length === 0, "Receipt.build.environment darf keine Umgebung erben.");
  exactKeys4(value.cargoConfiguration, ["cargoHomeMode", "configDiscovery", "registryPolicy", "sourceReplacement", "vendorPathRemap"], "Receipt.build.environment.cargoConfiguration");
  invariant6(value.cargoConfiguration.cargoHomeMode === "private-empty-create-new-v1", "Receipt.build.environment.cargoConfiguration.cargoHomeMode ist ungueltig.");
  invariant6(value.cargoConfiguration.configDiscovery === "trusted-system32-cwd-explicit-pinned-config-v1", "Receipt.build.environment.cargoConfiguration.configDiscovery ist ungueltig.");
  invariant6(value.cargoConfiguration.registryPolicy === "no-ambient-registry-index-src-or-git-v1", "Receipt.build.environment.cargoConfiguration.registryPolicy ist ungueltig.");
  invariant6(value.cargoConfiguration.sourceReplacement === "pinned-vendor-tree-only-v1", "Receipt.build.environment.cargoConfiguration.sourceReplacement ist ungueltig.");
  exactKeys4(value.cargoConfiguration.vendorPathRemap, ["from", "to"], "Receipt.build.environment.cargoConfiguration.vendorPathRemap");
  invariant6(value.cargoConfiguration.vendorPathRemap.from === "$HELD_SOURCE/vendor" && value.cargoConfiguration.vendorPathRemap.to === spec.source.vendor.remapPrefix, "Receipt.build.environment.cargoConfiguration.vendorPathRemap driftet.");
  validateStringArray(value.cleared, spec.build.environmentPolicy.cleared, "Receipt.build.environment.cleared");
  invariant6(sameCanonicalValue(value.fixed, spec.build.environmentPolicy.fixed), "Receipt.build.environment.fixed driftet.");
  invariant6(value.targetDirectory === spec.build.environmentPolicy.targetDirectory, "Receipt.build.environment.targetDirectory driftet.");
}
function validateSourceReceipt(value, spec) {
  exactKeys4(value, ["archive", "cargoLock", "extractedTree", "materialization", "vendor"], "Receipt.source");
  exactKeys4(value.archive, ["bytes", "embeddedCommit", "file", "format", "sha256"], "Receipt.source.archive");
  validatePositiveBytes(value.archive.bytes, "Receipt.source.archive.bytes", MAX_ARCHIVE_BYTES);
  validateSha256(value.archive.sha256, "Receipt.source.archive.sha256");
  invariant6(value.archive.file === spec.source.archive.file && value.archive.format === spec.source.archive.format && value.archive.embeddedCommit === spec.source.commit, "Receipt.source.archive bindet falsches Format, Datei oder Commit.");
  proofMatches({ bytes: value.archive.bytes, sha256: value.archive.sha256 }, spec.source.archive, "Receipt.source.archive-Spec-Pin");
  validateProof2(value.cargoLock, "Receipt.source.cargoLock", MAX_SPEC_BYTES, { file: true });
  invariant6(sameCanonicalValue(value.cargoLock, spec.source.cargoLock), "Receipt.source.cargoLock driftet.");
  validateTreeProof(value.extractedTree, "Receipt.source.extractedTree");
  invariant6(sameCanonicalValue(value.extractedTree, spec.source.tree), "Receipt.source.extractedTree driftet vom Spec-Pin.");
  exactKeys4(value.materialization, ["commit", "mode", "treeManifestSha256"], "Receipt.source.materialization");
  invariant6(value.materialization.commit === spec.source.commit && value.materialization.mode === "pinned-preexisting-archive", "Receipt.source.materialization ist ungueltig.");
  invariant6(value.materialization.treeManifestSha256 === spec.source.tree.manifestSha256, "Receipt.source.materialization bindet den falschen Tree.");
  exactKeys4(value.vendor, ["archive", "cargoConfig", "extractedTree", "materialization", "remapPrefix"], "Receipt.source.vendor");
  exactKeys4(value.vendor.archive, ["bytes", "file", "format", "sha256"], "Receipt.source.vendor.archive");
  invariant6(value.vendor.archive.file === spec.source.vendor.archive.file && value.vendor.archive.format === "tar", "Receipt.source.vendor.archive driftet.");
  proofMatches(value.vendor.archive, spec.source.vendor.archive, "Receipt.source.vendor.archive");
  invariant6(sameCanonicalValue(value.vendor.cargoConfig, spec.source.vendor.cargoConfig), "Receipt.source.vendor.cargoConfig driftet.");
  validateTreeProof(value.vendor.extractedTree, "Receipt.source.vendor.extractedTree");
  invariant6(sameCanonicalValue(value.vendor.extractedTree, spec.source.vendor.tree), "Receipt.source.vendor.extractedTree driftet.");
  exactKeys4(value.vendor.materialization, ["mode", "treeManifestSha256"], "Receipt.source.vendor.materialization");
  invariant6(value.vendor.materialization.mode === "pinned-preexisting-cargo-vendor-archive" && value.vendor.materialization.treeManifestSha256 === spec.source.vendor.tree.manifestSha256, "Receipt.source.vendor.materialization ist ungueltig.");
  invariant6(value.vendor.remapPrefix === spec.source.vendor.remapPrefix, "Receipt.source.vendor.remapPrefix driftet vom Annual-Pin.");
}
function buildProvenanceChain(value) {
  const sourceSha256 = sha2563(canonicalBytes3({
    authority: value.authority,
    producer: value.producer,
    releaseId: value.releaseId,
    source: value.source,
    specification: value.specification
  }));
  const buildSha256 = sha2563(canonicalBytes3({ previousSha256: sourceSha256, build: value.build, toolchain: value.toolchain }));
  const outputSha256 = sha2563(canonicalBytes3({ previousSha256: buildSha256, binaries: value.binaries, pe: value.pe }));
  return { algorithm: "sha256-canonical-json-chain/v1", buildSha256, outputSha256, sourceSha256 };
}
function createBuildProvenance({ authority, binaries, build, pe, producer, releaseId, source, specification, toolchain }) {
  const value = { authority, binaries, build, pe, producer, releaseId, schema: PROVENANCE_SCHEMA, source, specification, toolchain };
  return { ...value, chain: buildProvenanceChain(value) };
}
function validateBuildProvenance(value, spec) {
  exactKeys4(value, ["authority", "binaries", "build", "chain", "pe", "producer", "releaseId", "schema", "source", "specification", "toolchain"], "Build-Provenienz");
  invariant6(value.schema === PROVENANCE_SCHEMA && value.releaseId === spec.releaseId, "Build-Provenienz besitzt falsches Schema oder Release-ID.");
  exactKeys4(value.chain, ["algorithm", "buildSha256", "outputSha256", "sourceSha256"], "Build-Provenienz.chain");
  for (const name of ["buildSha256", "outputSha256", "sourceSha256"]) validateSha256(value.chain[name], `Build-Provenienz.chain.${name}`);
  invariant6(sameCanonicalValue(value.chain, buildProvenanceChain(value)), "Build-Provenienz besitzt eine ungueltige Hash-Kette.");
  validateWorkflowAuthorityReceipt(value.authority, spec, "Build-Provenienz.authority");
  validateProof2(value.specification, "Build-Provenienz.specification", MAX_SPEC_BYTES, { file: true });
  validateSourceReceipt(value.source, spec);
  validateToolchainReceipt(value.toolchain, spec);
  exactKeys4(value.build, ["command", "environment", "exitCode", "logs", "output", "processLimits", "profile", "targetDirectory"], "Build-Provenienz.build");
  validateStringArray(value.build.command, spec.build.command, "Build-Provenienz.build.command");
  invariant6(value.build.profile === spec.build.profile && value.build.exitCode === 0, "Build-Provenienz.build besitzt falsches Profil oder Exitcode.");
  invariant6(sameCanonicalValue(value.build.processLimits, spec.build.processLimits), "Build-Provenienz.build.processLimits driftet.");
  validateEnvironmentReceipt(value.build.environment, spec);
  exactKeys4(value.build.logs, ["stderr", "stdout"], "Build-Provenienz.build.logs");
  validateEncodedOutput(value.build.logs.stderr, "Build-Provenienz.build.logs.stderr");
  validateEncodedOutput(value.build.logs.stdout, "Build-Provenienz.build.logs.stdout");
  validateProof2(value.build.output, "Build-Provenienz.build.output", MAX_BINARY_BYTES, { file: true });
  exactKeys4(value.build.targetDirectory, ["initiallyEmpty", "mode"], "Build-Provenienz.build.targetDirectory");
  exactKeys4(value.binaries, ["preserved", "rebuilt"], "Build-Provenienz.binaries");
  validateProof2(value.binaries.preserved, "Build-Provenienz.binaries.preserved", MAX_BINARY_BYTES, { file: true });
  validateProof2(value.binaries.rebuilt, "Build-Provenienz.binaries.rebuilt", MAX_BINARY_BYTES, { file: true });
  exactKeys4(value.producer, PRODUCER_IDS, "Build-Provenienz.producer");
  for (const id of PRODUCER_IDS) {
    validateProof2(value.producer[id], `Build-Provenienz.producer.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant6(sameCanonicalValue(value.producer[id], spec.producer[id]), `Build-Provenienz.producer.${id} driftet vom Spec-Pin.`);
  }
  invariant6(value.build.output.file === spec.binaries.rebuilt.file, "Build-Provenienz.build.output bindet den falschen Binary-Pfad.");
  invariant6(sameCanonicalValue(value.binaries.preserved, { ...spec.binaries.preserved }), "Build-Provenienz bindet das falsche Preserved-Binary.");
  invariant6(value.binaries.rebuilt.file === spec.binaries.rebuilt.file && value.binaries.rebuilt.bytes === spec.binaries.rebuilt.expectedBytes, "Build-Provenienz bindet das falsche Rebuild-Binary.");
  return value;
}
function validateReceiptEnvelope(receipt, spec) {
  exactKeys4(receipt, ["authority", "binaries", "build", "pe", "producer", "provenance", "releaseId", "schema", "source", "specification", "toolchain"], "Operational-Validator-Rebuild-Receipt");
  invariant6(receipt.schema === EVIDENCE_SCHEMA && receipt.releaseId === spec.releaseId, "Receipt besitzt falsches Schema oder Release-ID.");
  validateProof2(receipt.specification, "Receipt.specification", MAX_SPEC_BYTES, { file: true });
  validateWorkflowAuthorityReceipt(receipt.authority, spec, "Receipt.authority");
  validateSourceReceipt(receipt.source, spec);
  exactKeys4(receipt.build, ["command", "environment", "exitCode", "logs", "output", "processLimits", "profile", "targetDirectory"], "Receipt.build");
  validateStringArray(receipt.build.command, spec.build.command, "Receipt.build.command");
  invariant6(receipt.build.profile === spec.build.profile && receipt.build.exitCode === 0, "Receipt.build besitzt falsches Profil oder Exitcode.");
  invariant6(sameCanonicalValue(receipt.build.processLimits, spec.build.processLimits), "Receipt.build.processLimits driftet.");
  validateEnvironmentReceipt(receipt.build.environment, spec);
  exactKeys4(receipt.build.logs, ["stderr", "stdout"], "Receipt.build.logs");
  validateEncodedOutput(receipt.build.logs.stdout, "Receipt.build.logs.stdout");
  validateEncodedOutput(receipt.build.logs.stderr, "Receipt.build.logs.stderr");
  validateProof2(receipt.build.output, "Receipt.build.output", MAX_BINARY_BYTES, { file: true });
  invariant6(receipt.build.output.file === spec.binaries.rebuilt.file, "Receipt.build.output bindet den falschen Pfad.");
  exactKeys4(receipt.build.targetDirectory, ["initiallyEmpty", "mode"], "Receipt.build.targetDirectory");
  invariant6(receipt.build.targetDirectory.initiallyEmpty === true && receipt.build.targetDirectory.mode === "external-empty-create-new", "Receipt.build.targetDirectory ist ungueltig.");
  validateToolchainReceipt(receipt.toolchain, spec);
  exactKeys4(receipt.binaries, ["preserved", "rebuilt"], "Receipt.binaries");
  validateProof2(receipt.binaries.preserved, "Receipt.binaries.preserved", MAX_BINARY_BYTES, { file: true });
  validateProof2(receipt.binaries.rebuilt, "Receipt.binaries.rebuilt", MAX_BINARY_BYTES, { file: true });
  invariant6(receipt.binaries.preserved.file === spec.binaries.preserved.file && receipt.binaries.rebuilt.file === spec.binaries.rebuilt.file, "Receipt.binaries bindet falsche Pfade.");
  invariant6(receipt.binaries.rebuilt.bytes === spec.binaries.rebuilt.expectedBytes, "Receipt.binaries.rebuilt besitzt die falsche Bytezahl.");
  exactKeys4(receipt.producer, PRODUCER_IDS, "Receipt.producer");
  for (const id of PRODUCER_IDS) {
    validateProof2(receipt.producer[id], `Receipt.producer.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant6(sameCanonicalValue(receipt.producer[id], spec.producer[id]), `Receipt.producer.${id} driftet vom Spec-Pin.`);
  }
  validateProof2(receipt.provenance, "Receipt.provenance", MAX_PROVENANCE_BYTES, { file: true });
  invariant6(receipt.provenance.file === spec.provenance.file, "Receipt.provenance bindet den falschen Pfad.");
  return receipt;
}
async function materializeOperationalValidatorRebuildEvidence({ spec, specBytes, specFile, workspaceRoot: workspaceRoot2, sourceRoot: _sourceRoot, outputPath, producerProofs, runnerAnchorHelperProof, recoveryOnly = false, hooks = {} }) {
  validateOperationalValidatorRebuildSpec(spec);
  const workspace = await regularDirectorySnapshot(workspaceRoot2, "workspaceRoot");
  const receiptOutput = resolve6(outputPath);
  invariant6(isContained(workspace.path, receiptOutput), "outputPath verlaesst workspaceRoot.");
  invariant6(
    pathKey(receiptOutput) === pathKey(resolveWorkspaceFile(workspace.path, spec.receipt.file, "receipt.file")),
    "outputPath driftet vom Annual-gepinnten Receiptpfad."
  );
  const outputs = {
    archive: resolveWorkspaceFile(workspace.path, spec.source.archive.file, "source.archive.file"),
    binary: resolveWorkspaceFile(workspace.path, spec.binaries.rebuilt.file, "binaries.rebuilt.file"),
    provenance: resolveWorkspaceFile(workspace.path, spec.provenance.file, "provenance.file"),
    receipt: receiptOutput
  };
  for (const [id, path] of Object.entries(outputs)) {
    await assertNoSymlinkPath(workspace.path, path, id, { leafMayBeMissing: true });
  }
  const specification = await validateSpecInputs({ spec, specBytes, specFile, workspaceRoot: workspace.path });
  const producer = await validateProducerProofs({ producerProofs, spec, workspaceRoot: workspace.path });
  validateProof2(runnerAnchorHelperProof, "runnerAnchorHelperProof", MAX_PRODUCER_BYTES, { file: true });
  invariant6(
    sameCanonicalValue(runnerAnchorHelperProof, spec.toolchain.anchor.helperAssembly),
    "Gehaltene Runner-Anchor-Helper-Assembly driftet von der Rebuild-v3-Spec."
  );
  const authority = workflowAuthorityReceipt(spec);
  invariant6(!recoveryOnly, "Rebuild-Evidence-v3 besitzt bewusst keine pfadbasierte Recovery; private Buildbaeume werden konservativ behalten.");
  for (const id of ["binary", "provenance", "receipt"]) await assertCreateNewTarget2(outputs[id], `Operational-Validator-Rebuild-${id}`);
  const preservedPath = resolveWorkspaceFile(workspace.path, spec.binaries.preserved.file, "binaries.preserved.file");
  const preserved = await regularFileSnapshot(workspace.path, preservedPath, "Preserved Validator", spec.pe.maxBinaryBytes);
  proofMatches(preserved.proof, spec.binaries.preserved, "Preserved Validator");
  const parentSnapshots = /* @__PURE__ */ new Map();
  for (const path of [outputs.binary, outputs.provenance, outputs.receipt]) {
    const parentPath = dirname6(path);
    if (!parentSnapshots.has(pathKey(parentPath))) parentSnapshots.set(pathKey(parentPath), await regularDirectorySnapshot(parentPath, "Rebuild-Output-Elternverzeichnis"));
  }
  const binaryParent = parentSnapshots.get(pathKey(dirname6(outputs.binary)));
  const buildRootLeaf = `.operational-validator-rebuild-v3-${randomUUID2()}`;
  const stagingRoot = resolve6(binaryParent.path, buildRootLeaf);
  await assertCreateNewTarget2(stagingRoot, "Privater Rebuild-Baum");
  let staging;
  let publicationProofs;
  let primaryError;
  let result;
  let buildAnchor;
  try {
    buildAnchor = await startWindowsBuildAnchor({
      anchoredParents: [...parentSnapshots.values()],
      buildParent: binaryParent,
      buildRootLeaf,
      hooks,
      spec,
      workspaceRoot: workspace.path
    });
    const sourceAudit = auditPinnedSourceArchive(buildAnchor.inputs.source.bytes, spec);
    const vendorAudit = auditPinnedVendorArchive(buildAnchor.inputs.vendor.bytes, spec);
    if (hooks.afterPinnedInputAuditBeforeExtraction) await hooks.afterPinnedInputAuditBeforeExtraction({ stagingRoot });
    const extraction = await buildAnchor.extract({ sourceAudit, vendorAudit });
    staging = await regularDirectorySnapshot(stagingRoot, "Create-new Windows-Buildroot");
    invariant6(matchesFilesystemIdentity(staging.metadata, extraction.buildRootIdentity), "Create-new Windows-Buildroot driftet von der im Anchor gehaltenen Identitaet.");
    if (hooks.afterStagingCreated) await hooks.afterStagingCreated({ stagingRoot });
    const sourceDirectory = resolve6(stagingRoot, "source");
    const targetDirectory = resolve6(stagingRoot, "target");
    const cargoHome = resolve6(stagingRoot, "cargo-home");
    const tempDirectory = resolve6(stagingRoot, "temp");
    const source = sourceArchiveEvidence({
      sourceAudit,
      sourceProof: buildAnchor.inputs.source.proof,
      spec,
      vendorAudit,
      vendorProof: buildAnchor.inputs.vendor.proof
    });
    const archive = buildAnchor.inputs.source;
    invariant6((await readdir4(targetDirectory)).length === 0, "Externer Cargo-Target-Pfad wurde vor dem Build beschrieben.");
    if (hooks.beforeBuild) await hooks.beforeBuild({ command: spec.build.command, sourceDirectory, targetDirectory });
    const anchorResult = await buildAnchor.run({ cargoHome, sourceDirectory, targetDirectory, tempDirectory });
    const buildResult = anchorResult.build;
    if (hooks.afterBuild) await hooks.afterBuild({ buildResult, sourceDirectory, targetDirectory });
    const cargoLockAfterBuild = await regularFileSnapshot(sourceDirectory, resolveWorkspaceFile(sourceDirectory, spec.source.cargoLock.file, "source.cargoLock.file"), "Archiviertes Cargo.lock nach Build", MAX_SPEC_BYTES);
    proofMatches(cargoLockAfterBuild.proof, spec.source.cargoLock, "Archiviertes Cargo.lock nach Build");
    const cargoConfigAfterBuild = await regularFileSnapshot(sourceDirectory, resolveWorkspaceFile(sourceDirectory, spec.source.vendor.cargoConfig.file, "source.vendor.cargoConfig.file"), "Gepinnte Cargo-Vendor-Konfiguration nach Build", MAX_SPEC_BYTES);
    proofMatches(cargoConfigAfterBuild.proof, spec.source.vendor.cargoConfig, "Gepinnte Cargo-Vendor-Konfiguration nach Build");
    const built = await regularFileSnapshot(targetDirectory, resolveWorkspaceFile(targetDirectory, spec.build.targetOutputFile, "build.targetOutputFile"), "Tatsaechlich gebauter Operational-Validator", spec.pe.maxBinaryBytes);
    proofMatches(built.proof, { bytes: anchorResult.output.bytes, sha256: anchorResult.output.sha256 }, "Im Anchor gehaltener Operational-Validator");
    invariant6(matchesFilesystemIdentity(built.identity, anchorResult.output.identity), "Tatsaechlich gebauter Operational-Validator driftet von der im Anchor gehaltenen Identitaet.");
    invariant6(built.proof.bytes === spec.binaries.rebuilt.expectedBytes, "Tatsaechlich gebauter Operational-Validator besitzt die falsche Bytezahl.");
    const pe = inspectPePair(preserved.bytes, built.bytes, spec);
    const toolchain = toolchainReceiptFromAnchor(anchorResult, spec, buildAnchor.inputs.manifest, { ...runnerAnchorHelperProof });
    const environmentReceipt = {
      allowedInherited: [],
      cargoConfiguration: {
        cargoHomeMode: "private-empty-create-new-v1",
        configDiscovery: "trusted-system32-cwd-explicit-pinned-config-v1",
        registryPolicy: "no-ambient-registry-index-src-or-git-v1",
        sourceReplacement: "pinned-vendor-tree-only-v1",
        vendorPathRemap: { from: "$HELD_SOURCE/vendor", to: spec.source.vendor.remapPrefix }
      },
      cleared: spec.build.environmentPolicy.cleared,
      fixed: { ...spec.build.environmentPolicy.fixed },
      targetDirectory: spec.build.environmentPolicy.targetDirectory
    };
    const binaries = { preserved: { file: spec.binaries.preserved.file, ...preserved.proof }, rebuilt: { file: spec.binaries.rebuilt.file, ...built.proof } };
    const build = {
      command: spec.build.command,
      environment: environmentReceipt,
      exitCode: buildResult.code,
      logs: { stderr: encodedOutput(buildResult.stderr), stdout: encodedOutput(buildResult.stdout) },
      output: { file: spec.binaries.rebuilt.file, ...built.proof },
      processLimits: spec.build.processLimits,
      profile: spec.build.profile,
      targetDirectory: { initiallyEmpty: true, mode: spec.build.environmentPolicy.targetDirectory }
    };
    const specificationProof = { bytes: specification.bytes, file: specification.file, sha256: specification.sha256 };
    const provenanceValue = createBuildProvenance({ authority, binaries, build, pe, producer, releaseId: spec.releaseId, source, specification: specificationProof, toolchain });
    const provenanceBytes = canonicalBytes3(provenanceValue);
    invariant6(provenanceBytes.length <= MAX_PROVENANCE_BYTES, "Build-Provenienz ist unerwartet gross.");
    const provenanceProof = { bytes: provenanceBytes.length, sha256: sha2563(provenanceBytes) };
    const receipt = { ...provenanceValue, provenance: { file: spec.provenance.file, ...provenanceProof }, schema: EVIDENCE_SCHEMA };
    delete receipt.chain;
    const receiptBytes = canonicalBytes3(receipt);
    invariant6(receiptBytes.length <= MAX_JSON_BYTES, "Operational-Validator-Rebuild-Receipt ist unerwartet gross.");
    const receiptProof = { bytes: receiptBytes.length, sha256: sha2563(receiptBytes) };
    publicationProofs = await buildAnchor.publish({
      binary: { path: outputs.binary, ...built.proof },
      provenance: { bytesValue: provenanceBytes, path: outputs.provenance, ...provenanceProof },
      receipt: { bytesValue: receiptBytes, path: outputs.receipt, ...receiptProof }
    });
    const publishedSnapshots = {};
    for (const [id, maximum] of Object.entries({ binary: MAX_BINARY_BYTES, provenance: MAX_PROVENANCE_BYTES, receipt: MAX_JSON_BYTES })) {
      const parent = parentSnapshots.get(pathKey(dirname6(outputs[id])));
      await assertDirectoryIdentity(parent.path, parent.metadata, `Output-Elternverzeichnis nach handle-relativer ${id}-Publikation`);
      publishedSnapshots[id] = await regularFileSnapshot(workspace.path, outputs[id], `Handle-relativ publiziertes ${id}`, maximum);
      proofMatches(publishedSnapshots[id].proof, publicationProofs[id], `Handle-relativ publiziertes ${id}`);
      invariant6(matchesFilesystemIdentity(publishedSnapshots[id].identity, publicationProofs[id].identity), `Handle-relativ publiziertes ${id} driftet von der gehaltenen File-ID.`);
      if (id === "binary" && hooks.afterBuiltOutputLink) await hooks.afterBuiltOutputLink({ binaryOutput: outputs.binary, builtPath: built.path });
      if (id === "receipt" && hooks.afterReceiptLink) await hooks.afterReceiptLink({ binaryOutput: outputs.binary, receiptOutput });
      if (hooks.afterPublicationLink) await hooks.afterPublicationLink({ id, output: outputs[id], stagedPath: null });
    }
    const verification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
    invariant6(verification.receipt.binaries.rebuilt.sha256 === built.proof.sha256, "Publiziertes Receipt bindet nicht den Build.");
    result = {
      archive: { path: outputs.archive, ...archive.proof },
      binary: { path: outputs.binary, ...built.proof },
      path: receiptOutput,
      proof: verification.proof,
      provenance: { path: outputs.provenance, ...provenanceProof },
      receipt: verification.receipt
    };
  } catch (error) {
    primaryError = error;
  }
  let cleanupError;
  if (staging) {
    try {
      await cleanupOwnedBuildRoot(binaryParent, stagingRoot, staging.metadata, hooks);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (!primaryError && !cleanupError) {
    try {
      if (hooks.afterBuildRootCleanupBeforeFinalAudit) await hooks.afterBuildRootCleanupBeforeFinalAudit({ outputs: { ...outputs } });
      for (const parent of parentSnapshots.values()) await assertDirectoryIdentity(parent.path, parent.metadata, "Output-Elternverzeichnis unmittelbar nach Cleanup");
      for (const [id, maximum] of Object.entries({ binary: MAX_BINARY_BYTES, provenance: MAX_PROVENANCE_BYTES, receipt: MAX_JSON_BYTES })) {
        const snapshot = await regularFileSnapshot(workspace.path, outputs[id], `Post-Retention ${id}`, maximum);
        proofMatches(snapshot.proof, publicationProofs[id], `Post-Retention ${id}`);
        invariant6(matchesFilesystemIdentity(snapshot.identity, publicationProofs[id].identity), `Post-Retention ${id} driftet von der im Anchor gehaltenen File-ID.`);
      }
      const verification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
      result.proof = verification.proof;
      result.receipt = verification.receipt;
    } catch (error) {
      primaryError = error;
    }
  }
  if (primaryError || cleanupError) {
    let anchorAbortError;
    if (buildAnchor) {
      try {
        await buildAnchor.abort();
      } catch (error) {
        anchorAbortError = error;
      }
    }
    let rollbackAuditError;
    try {
      for (const id of ["binary", "provenance", "receipt"]) {
        invariant6(!await pathExists(outputs[id]), `Handle-relativer Fehler-Rollback hinterliess ${id} am finalen Pfad.`);
      }
    } catch (error) {
      rollbackAuditError = error;
    }
    const errors = [primaryError, cleanupError, anchorAbortError, rollbackAuditError].filter(Boolean);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Rebuild, konservative Retention oder handle-relativer Publikationsrollback ist fehlgeschlagen; der private Baum bleibt fuer forensische Recovery erhalten.");
  }
  try {
    const finalVerification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
    result.proof = finalVerification.proof;
    result.receipt = finalVerification.receipt;
    await buildAnchor.completePublication();
  } catch (error) {
    let abortError;
    try {
      await buildAnchor.abort();
    } catch (failure) {
      abortError = failure;
    }
    if (abortError) throw new AggregateError([error, abortError], "Rebuild-Abschluss und Anchor-Abort sind fehlgeschlagen.");
    throw error;
  }
  return result;
}
async function verifyOperationalValidatorRebuildEvidence({ spec, receiptPath, workspaceRoot: workspaceRoot2 }) {
  validateOperationalValidatorRebuildSpec(spec);
  const workspace = await regularDirectorySnapshot(workspaceRoot2, "workspaceRoot");
  const receiptFile = resolve6(receiptPath);
  invariant6(isContained(workspace.path, receiptFile), "receiptPath verlaesst workspaceRoot.");
  invariant6(
    pathKey(receiptFile) === pathKey(resolveWorkspaceFile(workspace.path, spec.receipt.file, "receipt.file")),
    "receiptPath driftet vom Annual-gepinnten Receiptpfad."
  );
  const source = await regularFileSnapshot(workspace.path, receiptFile, "Operational-Validator-Rebuild-Receipt", MAX_JSON_BYTES);
  const receipt = validateReceiptEnvelope(parseJson(source.bytes, "Operational-Validator-Rebuild-Receipt"), spec);
  invariant6(source.bytes.equals(canonicalBytes3(receipt)), "Operational-Validator-Rebuild-Receipt ist nicht kanonisch serialisiert.");
  const specificationPath = resolveWorkspaceFile(workspace.path, receipt.specification.file, "Receipt.specification.file");
  const specification = await regularFileSnapshot(workspace.path, specificationPath, "Rebuild-Spec", MAX_SPEC_BYTES);
  proofMatches(specification.proof, receipt.specification, "Rebuild-Spec");
  invariant6(specification.bytes.equals(canonicalBytes3(spec)), "Aktuelle Rebuild-Spec ist nicht kanonisch oder driftet.");
  const preservedPath = resolveWorkspaceFile(workspace.path, spec.binaries.preserved.file, "binaries.preserved.file");
  const rebuiltPath = resolveWorkspaceFile(workspace.path, spec.binaries.rebuilt.file, "binaries.rebuilt.file");
  const archivePath = resolveWorkspaceFile(workspace.path, spec.source.archive.file, "source.archive.file");
  const vendorPath = resolveWorkspaceFile(workspace.path, spec.source.vendor.archive.file, "source.vendor.archive.file");
  const toolchainManifestPath = resolveWorkspaceFile(workspace.path, spec.toolchain.manifest.file, "toolchain.manifest.file");
  const provenancePath = resolveWorkspaceFile(workspace.path, spec.provenance.file, "provenance.file");
  const [preserved, rebuilt, archive, vendor, toolchainManifestSource, provenanceSource] = await Promise.all([
    regularFileSnapshot(workspace.path, preservedPath, "Preserved Validator", spec.pe.maxBinaryBytes),
    regularFileSnapshot(workspace.path, rebuiltPath, "Official Rebuilt Validator", spec.pe.maxBinaryBytes),
    regularFileSnapshot(workspace.path, archivePath, "Persistiertes Commit-Archiv", MAX_ARCHIVE_BYTES),
    regularFileSnapshot(workspace.path, vendorPath, "Persistiertes Cargo-Vendor-TAR", MAX_VENDOR_ARCHIVE_BYTES),
    regularFileSnapshot(workspace.path, toolchainManifestPath, "Persistiertes Toolchain-Manifest", MAX_TOOLCHAIN_MANIFEST_BYTES),
    regularFileSnapshot(workspace.path, provenancePath, "Persistierte Build-Provenienz", MAX_PROVENANCE_BYTES)
  ]);
  proofMatches(preserved.proof, spec.binaries.preserved, "Preserved Validator");
  proofMatches(preserved.proof, receipt.binaries.preserved, "Receipt-Preserved-Validator");
  proofMatches(rebuilt.proof, receipt.binaries.rebuilt, "Receipt-Official-Rebuilt-Validator");
  proofMatches(rebuilt.proof, receipt.build.output, "Receipt-Build-Output");
  invariant6(rebuilt.proof.bytes === spec.binaries.rebuilt.expectedBytes, "Official Rebuilt Validator besitzt die falsche Bytezahl.");
  proofMatches(archive.proof, spec.source.archive, "Persistiertes Commit-Archiv");
  proofMatches(archive.proof, { bytes: receipt.source.archive.bytes, sha256: receipt.source.archive.sha256 }, "Receipt-Commit-Archiv");
  const archiveAudit = auditPinnedSourceArchive(archive.bytes, spec);
  invariant6(sameCanonicalValue(archiveAudit.cargoLock, receipt.source.cargoLock), "Receipt-Cargo.lock driftet vom nativ auditierten Commit-TAR.");
  invariant6(sameCanonicalValue(archiveAudit.extractedTree, receipt.source.extractedTree), "Receipt-Source-Tree driftet vom nativ auditierten Commit-TAR.");
  proofMatches(vendor.proof, spec.source.vendor.archive, "Persistiertes Cargo-Vendor-TAR");
  const vendorAudit = auditPinnedVendorArchive(vendor.bytes, spec);
  invariant6(sameCanonicalValue(vendorAudit.extractedTree, receipt.source.vendor.extractedTree), "Receipt-Vendor-Tree driftet vom nativ auditierten Vendor-TAR.");
  proofMatches(toolchainManifestSource.proof, spec.toolchain.manifest, "Persistiertes Toolchain-Manifest");
  const toolchainManifest = parseJson(toolchainManifestSource.bytes, "Toolchain-Manifest");
  invariant6(toolchainManifestSource.bytes.equals(canonicalBytes3(toolchainManifest)), "Toolchain-Manifest ist nicht kanonisch serialisiert.");
  const toolchainInventory = validateToolchainManifest(toolchainManifest, spec);
  invariant6(sameCanonicalValue({ ...spec.toolchain.manifest, ...toolchainInventory }, receipt.toolchain.manifest), "Receipt-Toolchain-Manifestinventar driftet.");
  proofMatches(provenanceSource.proof, receipt.provenance, "Receipt-Build-Provenienz");
  invariant6(provenanceSource.bytes.equals(canonicalBytes3(parseJson(provenanceSource.bytes, "Build-Provenienz"))), "Build-Provenienz ist nicht kanonisch serialisiert.");
  const provenance = validateBuildProvenance(parseJson(provenanceSource.bytes, "Build-Provenienz"), spec);
  for (const field of ["authority", "binaries", "build", "pe", "producer", "source", "specification", "toolchain"]) {
    invariant6(sameCanonicalValue(provenance[field], receipt[field]), `Receipt.${field} driftet von der content-addressed Build-Provenienz.`);
  }
  const pe = inspectPePair(preserved.bytes, rebuilt.bytes, spec);
  invariant6(sameCanonicalValue(pe, receipt.pe), "Receipt-PE-Evidenz driftet von den aktuellen Binaries.");
  for (const id of PRODUCER_IDS) {
    const path = resolveWorkspaceFile(workspace.path, spec.producer[id].file, `producer.${id}.file`);
    const producer = await regularFileSnapshot(workspace.path, path, `Producer ${id}`, MAX_PRODUCER_BYTES);
    proofMatches(producer.proof, receipt.producer[id], `Receipt-Producer ${id}`);
  }
  return { proof: source.proof, receipt };
}

// tools/region-import/germany/operational-infrastructure-v2-publication.mjs
var GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_SCHEMA = "zugfolge-germany-operational-v2-native-receipt-capture/v2";
var GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_CLAIM_SCHEMA = "zugfolge-germany-operational-v2-native-receipt-capture-claim/v1";
var GERMANY_OPERATIONAL_PUBLICATION_ENTRYPOINT = "tools/region-import/germany/publish-operational-infrastructure-v2.mjs";
var GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_ENTRYPOINT = "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs";
var GERMANY_OPERATIONAL_INTEGRATED_RUNNER_ENTRYPOINT = "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs";
var GERMANY_OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE_SCHEMA = "zugfolge-operational-validator-rebuild-evidence/v2";
var GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES = Object.freeze({
  wrapper: GERMANY_OPERATIONAL_PUBLICATION_ENTRYPOINT,
  implementation: "tools/region-import/germany/operational-infrastructure-v2-publication.mjs",
  operationalDeriver: "tools/region-import/germany/operational-infrastructure-v2.mjs",
  materializer: "tools/region-import/materialize-operational-infrastructure-v2.mjs",
  createNewOutput: "tools/tiles/create-new-output.mjs",
  operationalBinding: "tools/region-import/operational-infrastructure-binding.mjs",
  validatorRebuildBootstrap: "tools/region-import/germany/operational-validator-rebuild-bootstrap.mjs",
  validatorRebuildVerifier: "tools/region-import/germany/operational-validator-rebuild-evidence.mjs",
  executionPinsImplementation: "tools/region-import/germany/operational-infrastructure-v2-execution-pins.mjs",
  annualCreateNewArtifact: "tools/region-import/germany/annual-create-new-artifact.mjs",
  outerExecutionReceiptVerifier: "tools/region-import/germany/operational-infrastructure-v2-outer-execution-receipt.mjs"
});
var REPOSITORY_ROOT3 = resolve7(dirname7(fileURLToPath3(import.meta.url)), "../../..");
var SHA2566 = /^[a-f0-9]{64}$/u;
var DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
var MAX_SMALL_JSON_BYTES = 64 * 1024 * 1024;
var CAPTURE_STAGING_PREFIX = ".operational-v2-native-receipt-";
var OWNED_CLEANUP_PREFIX = ".operational-v2-owned-cleanup-";
var CLAIM_FILE = ".operational-infrastructure-v2.publication-claim.json";
var CAPTURE_CLAIM_FILE = ".operational-infrastructure-v2.native-receipt-capture-claim.json";
var OPERATIONAL_FILE = "operational-infrastructure-v2.json";
var SIDECAR_FILE = "operational-infrastructure-v2.movement-route-templates-v2.json";
var PUBLICATION_RECEIPT_FILE = "operational-infrastructure-v2.publication-receipt.json";
var NATIVE_RECEIPT_FILE = "operational-infrastructure-v2.native-receipt.json";
var OWNERSHIP_ANCHOR_SUFFIX = ".ownership-anchor";
var OPERATIONAL_RUNNER_BUILD_CONTEXT = "anchored-stdin-bundle-v1";
var PUBLICATION_STAGED_SOURCE_FILES = Object.freeze([
  SIDECAR_FILE,
  OPERATIONAL_FILE,
  PUBLICATION_RECEIPT_FILE,
  CLAIM_FILE
]);
function ownershipAnchorFile(file) {
  return `.${file}${OWNERSHIP_ANCHOR_SUFFIX}`;
}
var PUBLICATION_STAGING_FILES = Object.freeze([
  ...PUBLICATION_STAGED_SOURCE_FILES,
  ...PUBLICATION_STAGED_SOURCE_FILES.map(ownershipAnchorFile)
]);
function invariant7(condition, message) {
  if (!condition) throw new Error(message);
}
function isRecord4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys5(value, keys, label) {
  invariant7(isRecord4(value), `${label} muss ein Objekt sein.`);
  invariant7(Object.keys(value).sort().join(",") === [...keys].sort().join(","), `${label} besitzt unerwartete oder fehlende Felder.`);
}
function nonEmptyString2(value, label) {
  invariant7(typeof value === "string" && value.length > 0, `${label} muss eine nichtleere Zeichenkette sein.`);
  return value;
}
function positiveInteger2(value, label) {
  invariant7(Number.isSafeInteger(value) && value > 0, `${label} muss eine positive sichere Ganzzahl sein.`);
  return value;
}
function sha2564(value, label) {
  invariant7(typeof value === "string" && SHA2566.test(value), `${label} muss ein SHA-256 sein.`);
  return value;
}
function sha256OrNull(value, label) {
  invariant7(value === null || typeof value === "string" && SHA2566.test(value), `${label} muss null oder ein SHA-256 sein.`);
  return value;
}
function canonicalValue5(value) {
  if (Array.isArray(value)) return value.map(canonicalValue5);
  if (!isRecord4(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue5(value[key])]));
}
function serializeGermanyOperationalPublicationJson(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue5(value), null, 2)}
`, "utf8");
}
function parseJson2(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON.`, { cause: error });
  }
}
function sameIdentity6(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameStableMetadata2(left, right) {
  return sameIdentity6(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function sameIdentitySizeMtime(left, right) {
  return sameIdentity6(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;
}
function samePersistentFileMetadata(left, right) {
  return sameIdentitySizeMtime(left, right) && left.birthtimeNs === right.birthtimeNs && left.mode === right.mode;
}
function identityValue(metadata) {
  return { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
}
function identityMatches(metadata, value) {
  return isRecord4(value) && typeof value.dev === "string" && typeof value.ino === "string" && DECIMAL.test(value.dev) && DECIMAL.test(value.ino) && metadata.dev.toString() === value.dev && metadata.ino.toString() === value.ino;
}
function matchesExpectedIdentity(metadata, expected) {
  return typeof expected?.dev === "bigint" && typeof expected?.ino === "bigint" ? sameIdentity6(metadata, expected) : identityMatches(metadata, expected);
}
function errorDetail(error) {
  return error instanceof Error ? error.message : String(error);
}
function normalizedPathForComparison(path) {
  const normalized = resolve7(path).replaceAll("/", "\\").replace(/\\+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function isMissing2(error) {
  return error !== null && typeof error === "object" && error.code === "ENOENT";
}
async function maybeMetadata(path) {
  try {
    return await lstat7(path, { bigint: true });
  } catch (error) {
    if (isMissing2(error)) return null;
    throw error;
  }
}
async function regularFileProof(pathInput, label) {
  const path = resolve7(pathInput);
  const pathBefore = await lstat7(path, { bigint: true });
  invariant7(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.size > 0n, `${label} ist keine nichtleere regulaere Datei.`);
  invariant7(pathBefore.size <= BigInt(Number.MAX_SAFE_INTEGER), `${label} ist fuer einen sicheren Bytebeleg zu gross.`);
  const handle = await open7(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant7(before.isFile() && sameStableMetadata2(pathBefore, before), `${label} aenderte sich vor der Hashbildung.`);
    const digest = createHash7("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
      digest.update(chunk);
      bytes += chunk.length;
      invariant7(Number.isSafeInteger(bytes), `${label} ist fuer einen sicheren Bytebeleg zu gross.`);
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat7(path, { bigint: true });
    invariant7(pathAfter.isFile() && !pathAfter.isSymbolicLink(), `${label} ist nach der Hashbildung keine regulaere Datei mehr.`);
    invariant7(
      sameStableMetadata2(before, after) && sameStableMetadata2(after, pathAfter) && BigInt(bytes) === after.size,
      `${label} aenderte sich waehrend der Hashbildung.`
    );
    return { bytes, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}
async function smallJsonSource(pathInput, label) {
  const path = resolve7(pathInput);
  const pathBefore = await lstat7(path, { bigint: true });
  invariant7(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.size > 0n, `${label} ist keine nichtleere regulaere Datei.`);
  invariant7(pathBefore.size <= BigInt(MAX_SMALL_JSON_BYTES), `${label} ueberschreitet das Limit fuer typisierte JSON-Metadaten.`);
  const handle = await open7(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant7(before.isFile() && sameStableMetadata2(pathBefore, before), `${label} aenderte sich vor dem Lesen.`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat7(path, { bigint: true });
    invariant7(pathAfter.isFile() && !pathAfter.isSymbolicLink(), `${label} ist nach dem Lesen keine regulaere Datei mehr.`);
    invariant7(
      sameStableMetadata2(before, after) && sameStableMetadata2(after, pathAfter) && BigInt(bytes.length) === after.size,
      `${label} aenderte sich waehrend des Lesens.`
    );
    return { bytes, value: parseJson2(bytes, label), proof: { bytes: bytes.length, sha256: createHash7("sha256").update(bytes).digest("hex") } };
  } finally {
    await handle.close();
  }
}
function validatePortableRelativePath(value, label) {
  nonEmptyString2(value, label);
  invariant7(!isAbsolute5(value) && !value.includes("\\") && !value.split("/").includes("..") && value !== ".", `${label} muss ein sicherer Workspace-relativer POSIX-Pfad sein.`);
  return value;
}
function portableRelativePath(workspaceRoot2, pathInput, label) {
  const root2 = resolve7(workspaceRoot2);
  const path = resolve7(pathInput);
  const result = relative5(root2, path);
  invariant7(result !== "" && result !== ".." && !result.startsWith(`..${sep5}`) && !isAbsolute5(result), `${label} muss innerhalb des Workspace liegen.`);
  return result.replaceAll("\\", "/");
}
function resolvePortablePath(workspaceRoot2, value, label) {
  validatePortableRelativePath(value, label);
  const root2 = resolve7(workspaceRoot2);
  const path = resolve7(root2, ...value.split("/"));
  invariant7(path !== root2 && !relative5(root2, path).startsWith(`..${sep5}`), `${label} verlaesst den Workspace.`);
  return path;
}
function validateProof3(value, label) {
  exactKeys5(value, ["bytes", "sha256"], label);
  positiveInteger2(value.bytes, `${label}.bytes`);
  sha2564(value.sha256, `${label}.sha256`);
  return value;
}
function validateFileProof2(value, label) {
  exactKeys5(value, ["file", "bytes", "sha256"], label);
  validatePortableRelativePath(value.file, `${label}.file`);
  positiveInteger2(value.bytes, `${label}.bytes`);
  sha2564(value.sha256, `${label}.sha256`);
  return value;
}
function validateValidatorRebuildBinding(value, label) {
  exactKeys5(value, ["evidence", "normalizedPeSha256", "preserved", "rebuilt", "sourceCommit", "specification"], label);
  validateFileProof2(value.specification, `${label}.specification`);
  exactKeys5(value.evidence, ["bytes", "file", "schema", "sha256"], `${label}.evidence`);
  validateFileProof2(
    { file: value.evidence.file, bytes: value.evidence.bytes, sha256: value.evidence.sha256 },
    `${label}.evidence`
  );
  invariant7(
    value.evidence.schema === GERMANY_OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE_SCHEMA,
    `${label}.evidence besitzt ein unbekanntes Schema.`
  );
  validateFileProof2(value.preserved, `${label}.preserved`);
  validateFileProof2(value.rebuilt, `${label}.rebuilt`);
  invariant7(typeof value.sourceCommit === "string" && /^[a-f0-9]{40}$/u.test(value.sourceCommit), `${label}.sourceCommit muss ein voller Git-Commit sein.`);
  sha2564(value.normalizedPeSha256, `${label}.normalizedPeSha256`);
  return value;
}
function validateStateFileProof(value, label) {
  exactKeys5(value, ["file", "bytes", "sha256", "stateHash"], label);
  validatePortableRelativePath(value.file, `${label}.file`);
  positiveInteger2(value.bytes, `${label}.bytes`);
  sha2564(value.sha256, `${label}.sha256`);
  sha2564(value.stateHash, `${label}.stateHash`);
  return value;
}
function validateMovementFileProof(value, label) {
  exactKeys5(value, ["file", "bytes", "sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256"], label);
  validatePortableRelativePath(value.file, `${label}.file`);
  positiveInteger2(value.bytes, `${label}.bytes`);
  for (const field of ["sha256", "stateHash", "operationalStateHash"]) sha2564(value[field], `${label}.${field}`);
  sha256OrNull(value.timetableTransferSetSha256, `${label}.timetableTransferSetSha256`);
  return value;
}
function proofMatches2(actual, expected, label) {
  invariant7(actual.bytes === expected.bytes && actual.sha256 === expected.sha256, `${label} driftet von seiner Receipt-Bindung.`);
}
function sameCanonicalValue2(left, right) {
  return JSON.stringify(canonicalValue5(left)) === JSON.stringify(canonicalValue5(right));
}
function nativeCandidateSidecarName(candidatePath) {
  const file = basename6(candidatePath);
  invariant7(file.endsWith(".json"), "Nativer Operational-v2-Candidate muss auf .json enden.");
  return `${file.slice(0, -5)}.movement-route-templates-v2.json`;
}
async function pinParentDirectory2(pathInput, { create = false } = {}) {
  const requested = resolve7(pathInput);
  if (create) await mkdir5(requested, { recursive: true });
  const before = await lstat7(requested, { bigint: true });
  invariant7(before.isDirectory() && !before.isSymbolicLink(), "Operational-v2-Publikationselternpfad muss ein regulaeres Verzeichnis sein.");
  const real = await realpath6(requested);
  invariant7(normalizedPathForComparison(real) === normalizedPathForComparison(requested), "Operational-v2-Publikationselternpfad darf weder Symlink noch Junction enthalten.");
  const after = await lstat7(real, { bigint: true });
  invariant7(sameIdentity6(before, after), "Operational-v2-Publikationselternpfad aenderte sich waehrend der Pin-Pruefung.");
  return { requested, real, identity: after };
}
async function assertPinnedParent2(parent) {
  const currentReal = await realpath6(parent.requested);
  invariant7(normalizedPathForComparison(currentReal) === normalizedPathForComparison(parent.real), "Operational-v2-Publikationselternpfad wurde ausgetauscht.");
  const current = await lstat7(parent.real, { bigint: true });
  invariant7(current.isDirectory() && !current.isSymbolicLink() && sameIdentity6(current, parent.identity), "Operational-v2-Publikationselternpfad verlor seine gepinnte Identitaet.");
}
async function proofFromBoundPublication(binding) {
  const before = await binding.handle.stat({ bigint: true });
  const pathBefore = await lstat7(binding.path, { bigint: true });
  invariant7(
    before.isFile() && pathBefore.isFile() && !pathBefore.isSymbolicLink() && sameIdentitySizeMtime(before, binding.identity) && sameIdentitySizeMtime(pathBefore, binding.identity) && sameStableMetadata2(before, pathBefore),
    `${binding.label} wurde nach dem create-new Link fremd ersetzt oder veraendert.`
  );
  const digest = createHash7("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < Number(before.size)) {
    const length = Math.min(buffer.length, Number(before.size) - position);
    const { bytesRead } = await binding.handle.read(buffer, 0, length, position);
    invariant7(bytesRead === length, `${binding.label} konnte ueber den gehaltenen Handle nicht vollstaendig gelesen werden.`);
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await binding.handle.stat({ bigint: true });
  const pathAfter = await lstat7(binding.path, { bigint: true });
  invariant7(
    sameStableMetadata2(before, after) && sameStableMetadata2(after, pathAfter),
    `${binding.label} driftete waehrend der gehaltenen Zielpruefung.`
  );
  return { bytes: position, sha256: digest.digest("hex") };
}
async function closeBoundPublications(bindings) {
  const errors = [];
  for (const binding of [...bindings].reverse()) {
    try {
      await binding.handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  bindings.length = 0;
  if (errors.length > 0) throw new AggregateError(errors, "Create-new-Zielhandles konnten nicht vollstaendig geschlossen werden.");
}
async function publishBoundFileCreateNew({
  sourcePath,
  outputPath,
  expectedIdentity,
  expectedProof,
  label,
  parent,
  registerOwned,
  afterLinkBeforeAudit
}) {
  const source = resolve7(sourcePath);
  const output = resolve7(outputPath);
  const sourceBefore = await lstat7(source, { bigint: true });
  invariant7(sourceBefore.isFile() && !sourceBefore.isSymbolicLink() && sameIdentity6(sourceBefore, expectedIdentity), `${label}-Quelle driftete vor dem create-new Link.`);
  await assertPinnedParent2(parent);
  try {
    await link5(source, output);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`${label} existiert bereits: ${output}`, { cause: error });
    throw error;
  }
  registerOwned({ outputPath: output, identity: expectedIdentity, label });
  if (afterLinkBeforeAudit !== void 0) await afterLinkBeforeAudit({ source, output, parent });
  await assertPinnedParent2(parent);
  const handle = await open7(output, "r");
  try {
    const [sourceAfter, outputAfter, held] = await Promise.all([
      lstat7(source, { bigint: true }),
      lstat7(output, { bigint: true }),
      handle.stat({ bigint: true })
    ]);
    invariant7(
      sourceAfter.isFile() && outputAfter.isFile() && held.isFile() && !sourceAfter.isSymbolicLink() && !outputAfter.isSymbolicLink() && sameIdentity6(sourceAfter, expectedIdentity) && sameIdentitySizeMtime(sourceBefore, sourceAfter) && sameStableMetadata2(sourceAfter, outputAfter) && sameStableMetadata2(outputAfter, held),
      `${label} wurde nicht als quell- und zielgebundener create-new Hardlink publiziert.`
    );
    await assertPinnedParent2(parent);
    const binding = { handle, identity: held, label, path: output, expectedProof };
    if (expectedProof !== void 0) proofMatches2(await proofFromBoundPublication(binding), expectedProof, label);
    return binding;
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], `${label}-Bindung und Handle-Close sind fehlgeschlagen.`);
    }
    throw error;
  }
}
async function loadAndVerifyValidatorRebuild({
  workspaceRoot: workspaceRoot2,
  validatorRebuildSpecificationPath,
  validatorRebuildEvidencePath,
  expectedReleaseId,
  expectedValidator,
  verifyValidatorRebuildEvidence = verifyOperationalValidatorRebuildEvidence
}) {
  const specificationSource = await smallJsonSource(
    validatorRebuildSpecificationPath,
    "Operational-Validator-Rebuild-Spezifikation"
  );
  const verified = await verifyValidatorRebuildEvidence({
    spec: specificationSource.value,
    receiptPath: resolve7(validatorRebuildEvidencePath),
    workspaceRoot: resolve7(workspaceRoot2)
  });
  invariant7(
    isRecord4(verified) && isRecord4(verified.receipt) && isRecord4(verified.proof),
    "Operational-Validator-Rebuild-Verifier lieferte keinen typisierten Beleg."
  );
  const receipt = verified.receipt;
  invariant7(
    receipt.schema === GERMANY_OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE_SCHEMA,
    "Operational-Validator-Rebuild-Receipt besitzt ein unbekanntes Schema."
  );
  invariant7(
    receipt.releaseId === expectedReleaseId,
    "Operational-Validator-Rebuild-Receipt bindet nicht die erwartete InfraRelease-ID."
  );
  invariant7(
    isRecord4(receipt.binaries?.preserved) && isRecord4(receipt.binaries?.rebuilt),
    "Operational-Validator-Rebuild-Receipt besitzt kein vollstaendiges Binary-Paar."
  );
  invariant7(
    isRecord4(receipt.source?.git) && typeof receipt.source.git.commit === "string",
    "Operational-Validator-Rebuild-Receipt besitzt keinen geprueften Quellcommit."
  );
  invariant7(
    isRecord4(receipt.pe?.normalized) && typeof receipt.pe.normalized.expectedSha256 === "string",
    "Operational-Validator-Rebuild-Receipt besitzt keinen normalisierten PE-Beleg."
  );
  const evidenceProof = await regularFileProof(
    validatorRebuildEvidencePath,
    "Operational-Validator-Rebuild-Receipt"
  );
  proofMatches2(evidenceProof, verified.proof, "Operational-Validator-Rebuild-Receipt");
  proofMatches2(specificationSource.proof, receipt.specification, "Operational-Validator-Rebuild-Spezifikation");
  const binding = validateValidatorRebuildBinding({
    specification: {
      file: portableRelativePath(workspaceRoot2, validatorRebuildSpecificationPath, "Operational-Validator-Rebuild-Spezifikation"),
      ...specificationSource.proof
    },
    evidence: {
      file: portableRelativePath(workspaceRoot2, validatorRebuildEvidencePath, "Operational-Validator-Rebuild-Receipt"),
      ...evidenceProof,
      schema: receipt.schema
    },
    preserved: { ...receipt.binaries.preserved },
    rebuilt: { ...receipt.binaries.rebuilt },
    sourceCommit: receipt.source.git.commit,
    normalizedPeSha256: receipt.pe.normalized.expectedSha256
  }, "Operational-Validator-Rebuild-Bindung");
  invariant7(
    binding.specification.file === receipt.specification.file,
    "Operational-Validator-Rebuild-Receipt bindet einen anderen Spezifikationspfad."
  );
  if (expectedValidator !== void 0) {
    invariant7(
      sameCanonicalValue2(binding.preserved, expectedValidator),
      "Operational-Validator-Rebuild-Receipt bindet nicht das effektiv ausgefuehrte preserved Validator-Binary."
    );
  }
  return { binding, receipt, proof: evidenceProof, specificationSource };
}
function validateCaptureReceipt(value, expectedReleaseId) {
  exactKeys5(value, ["schema", "infraReleaseId", "operationalProvenance", "nativeReceipt", "specification", "sources", "producer", "validatorRebuild"], "Native-Receipt-Capture");
  invariant7(value.schema === GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_SCHEMA, "Native-Receipt-Capture besitzt ein unbekanntes Schema.");
  invariant7(value.infraReleaseId === expectedReleaseId, "Native-Receipt-Capture bindet nicht die erwartete InfraRelease-ID.");
  validateFileProof2(value.specification, "Native-Receipt-Capture.specification");
  exactKeys5(value.sources, ["candidate", "movementRouteTemplates", "report"], "Native-Receipt-Capture.sources");
  validateStateFileProof(value.sources.candidate, "Native-Receipt-Capture.sources.candidate");
  validateMovementFileProof(value.sources.movementRouteTemplates, "Native-Receipt-Capture.sources.movementRouteTemplates");
  validateFileProof2(value.sources.report, "Native-Receipt-Capture.sources.report");
  exactKeys5(value.producer, ["command", "executable", "captureEntrypoint", "executionInventory"], "Native-Receipt-Capture.producer");
  invariant7(value.producer.command === "derive-germany-operational-v2", "Native-Receipt-Capture besitzt einen falschen nativen Befehl.");
  validateFileProof2(value.producer.executable, "Native-Receipt-Capture.producer.executable");
  validateFileProof2(value.producer.captureEntrypoint, "Native-Receipt-Capture.producer.captureEntrypoint");
  validateExecutionInventory(value.producer.executionInventory, "Native-Receipt-Capture.producer.executionInventory");
  invariant7(
    sameCanonicalValue2(value.producer.executable, value.producer.executionInventory.validatorExecutable),
    "Native-Receipt-Capture bindet Ausfuehrungsinventar und Validator-Binary verschieden."
  );
  validateValidatorRebuildBinding(value.validatorRebuild, "Native-Receipt-Capture.validatorRebuild");
  invariant7(
    sameCanonicalValue2(value.validatorRebuild.preserved, value.producer.executable),
    "Native-Receipt-Capture bindet Rebuild-Preserved und effektiv ausgefuehrtes Validator-Binary verschieden."
  );
  const expectedSidecarFile = basename6(value.sources.movementRouteTemplates.file);
  const nativeReceipt = validateGermanyOperationalInfrastructureV2NativeReceipt(value.nativeReceipt, expectedReleaseId, {
    expectedMovementRouteTemplatesFile: expectedSidecarFile
  });
  const operationalProvenance = validateGermanyOperationalProvenance(value.operationalProvenance, { nativeReceipt });
  if (operationalProvenance.producerKind === GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND) {
    invariant7(
      sameCanonicalValue2(operationalProvenance.executionProof.validator.preserved, value.producer.executable),
      "Native-Receipt-Capture bindet Execution-Proof und Validator-Binary verschieden."
    );
    invariant7(sameCanonicalValue2(operationalProvenance.executionProof.rebuild, {
      specification: value.validatorRebuild.specification,
      evidence: value.validatorRebuild.evidence,
      sourceCommit: value.validatorRebuild.sourceCommit
    }), "Native-Receipt-Capture bindet Execution-Proof und Validator-Rebuild verschieden.");
    invariant7(
      sameCanonicalValue2(operationalProvenance.executionProof.runner.entrypoint, value.producer.captureEntrypoint),
      "Native-Receipt-Capture bindet integrierten Runner und Capture-Entrypoint verschieden."
    );
  }
  invariant7(
    nativeReceipt.candidate.bytes === value.sources.candidate.bytes && nativeReceipt.candidate.sha256 === value.sources.candidate.sha256 && nativeReceipt.candidate.stateHash === value.sources.candidate.stateHash,
    "Native-Receipt-Capture bindet Candidate und natives Receipt verschieden."
  );
  invariant7(
    nativeReceipt.report.bytes === value.sources.report.bytes && nativeReceipt.report.sha256 === value.sources.report.sha256,
    "Native-Receipt-Capture bindet Bericht und natives Receipt verschieden."
  );
  invariant7(
    nativeReceipt.movementRouteTemplates.bytes === value.sources.movementRouteTemplates.bytes && nativeReceipt.movementRouteTemplates.sha256 === value.sources.movementRouteTemplates.sha256 && nativeReceipt.movementRouteTemplates.stateHash === value.sources.movementRouteTemplates.stateHash && nativeReceipt.movementRouteTemplates.operationalStateHash === value.sources.movementRouteTemplates.operationalStateHash && nativeReceipt.movementRouteTemplates.timetableTransferSetSha256 === value.sources.movementRouteTemplates.timetableTransferSetSha256,
    "Native-Receipt-Capture bindet Movement-Sidecar und natives Receipt verschieden."
  );
  return value;
}
function validateGermanyOperationalInfrastructureV2NativeReceiptCapture(value, expectedReleaseId) {
  return validateCaptureReceipt(value, expectedReleaseId);
}
function validateNativeTripletBindings({ specification, specificationProof, capture, report, candidateProof, movementProof, reportProof }) {
  invariant7(
    report.inputs.spec.bytes === specificationProof.bytes && report.inputs.spec.sha256 === specificationProof.sha256,
    "Nativer Bericht bindet nicht die verwendeten Spezifikationsbytes."
  );
  proofMatches2(candidateProof, capture.sources.candidate, "Operational-v2-Candidate");
  proofMatches2(movementProof, capture.sources.movementRouteTemplates, "Operational-v2-Candidate-Sidecar");
  proofMatches2(reportProof, capture.sources.report, "Operational-v2-Ableitungsbericht");
  invariant7(
    report.candidate.bytes === capture.sources.candidate.bytes && report.candidate.sha256 === capture.sources.candidate.sha256 && report.candidate.stateHash === capture.sources.candidate.stateHash,
    "Nativer Bericht und Capture besitzen verschiedene Candidate-Bindungen."
  );
  invariant7(
    sameCanonicalValue2(report.candidate.movementRouteTemplates, capture.nativeReceipt.movementRouteTemplates),
    "Nativer Bericht und Capture besitzen verschiedene Movement-Sidecar-Bindungen."
  );
  invariant7(
    report.activationEligible === capture.nativeReceipt.activationEligible && report.unresolvedRequired === capture.nativeReceipt.unresolvedRequired,
    "Nativer Bericht und Capture besitzen verschiedene Aktivierungsgates."
  );
  invariant7(
    capture.sources.movementRouteTemplates.operationalStateHash === capture.sources.candidate.stateHash,
    "Native Candidate- und Sidecar-Zustandsbindung laufen auseinander."
  );
  invariant7(specification.infraReleaseId === capture.infraReleaseId, "Spezifikation und Native-Receipt-Capture besitzen verschiedene Release-IDs.");
}
async function writeNewFile(path, bytes) {
  const handle = await open7(path, "wx", 384);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function captureScriptProof(workspaceRoot2, entrypointPath, expectedEntrypoint) {
  const file = portableRelativePath(workspaceRoot2, entrypointPath, "Receipt-Capture-Entrypoint");
  invariant7(file === expectedEntrypoint, `Receipt-Capture-Entrypoint muss ${expectedEntrypoint} sein.`);
  return { file, ...await regularFileProof(entrypointPath, "Receipt-Capture-Entrypoint") };
}
async function publisherExecutionInventoryProof(workspaceRoot2, validatorExecutable) {
  const entries = await Promise.all(Object.entries(GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES).map(async ([id, file]) => [
    id,
    { file, ...await regularFileProof(resolvePortablePath(workspaceRoot2, file, `Operational-v2-Ausfuehrungsinventar.${id}`), `Operational-v2-Ausfuehrungsinventar.${id}`) }
  ]));
  return {
    ...Object.fromEntries(entries),
    validatorExecutable: {
      ...validatorExecutable,
      ...await regularFileProof(
        resolvePortablePath(workspaceRoot2, validatorExecutable.file, "Operational-v2-Validator-Binary"),
        "Operational-v2-Validator-Binary"
      )
    }
  };
}
function executionInventoryMatches(actual, expected, label) {
  for (const id of [...Object.keys(GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES), "validatorExecutable"]) {
    invariant7(actual[id].file === expected[id].file, `${label}.${id} bindet einen anderen Pfad.`);
    proofMatches2(actual[id], expected[id], `${label}.${id}`);
  }
}
function validateExecutionInventory(value, label) {
  exactKeys5(value, [...Object.keys(GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES), "validatorExecutable"], label);
  for (const [id, file] of Object.entries(GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES)) {
    const proof = validateFileProof2(value[id], `${label}.${id}`);
    invariant7(proof.file === file, `${label}.${id} bindet nicht den festgelegten Implementierungspfad.`);
  }
  validateFileProof2(value.validatorExecutable, `${label}.validatorExecutable`);
  return value;
}
function captureClaimPath(parent) {
  return join5(parent, CAPTURE_CLAIM_FILE);
}
function validateCaptureClaim(value) {
  exactKeys5(value, ["schema", "parent", "claim", "staging", "target", "receipt"], "Native-Receipt-Capture-Claim");
  invariant7(value.schema === GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_CLAIM_SCHEMA, "Native-Receipt-Capture-Claim besitzt ein unbekanntes Schema.");
  for (const [label, identity] of [["parent", value.parent], ["claim", value.claim], ["staging.identity", value.staging?.identity], ["receipt.identity", value.receipt?.identity]]) {
    exactKeys5(identity, ["dev", "ino"], `Native-Receipt-Capture-Claim.${label}`);
    invariant7(DECIMAL.test(identity.dev) && DECIMAL.test(identity.ino), `Native-Receipt-Capture-Claim.${label} besitzt keine Dateisystemidentitaet.`);
  }
  exactKeys5(value.staging, ["directory", "identity", "files"], "Native-Receipt-Capture-Claim.staging");
  invariant7(
    typeof value.staging.directory === "string" && value.staging.directory.startsWith(CAPTURE_STAGING_PREFIX) && basename6(value.staging.directory) === value.staging.directory,
    "Native-Receipt-Capture-Claim bindet kein sicheres Staging-Verzeichnis."
  );
  exactKeys5(value.staging.files, [NATIVE_RECEIPT_FILE, CAPTURE_CLAIM_FILE], "Native-Receipt-Capture-Claim.staging.files");
  for (const [name, identity] of Object.entries(value.staging.files)) {
    exactKeys5(identity, ["dev", "ino"], `Native-Receipt-Capture-Claim.staging.files.${name}`);
    invariant7(DECIMAL.test(identity.dev) && DECIMAL.test(identity.ino), `Native-Receipt-Capture-Claim.staging.files.${name} besitzt keine Dateisystemidentitaet.`);
  }
  invariant7(value.target === NATIVE_RECEIPT_FILE, "Native-Receipt-Capture-Claim bindet keinen kanonischen Zielnamen.");
  exactKeys5(value.receipt, ["bytes", "sha256", "identity"], "Native-Receipt-Capture-Claim.receipt");
  validateProof3({ bytes: value.receipt.bytes, sha256: value.receipt.sha256 }, "Native-Receipt-Capture-Claim.receipt");
  return value;
}
async function acquireCaptureClaim(parent, staging, stagingIdentity, stagedReceipt, receiptIdentity, receiptProof, hooks, registerStagedClaim) {
  const stagedClaim = join5(staging, CAPTURE_CLAIM_FILE);
  const finalClaim = captureClaimPath(parent.real);
  let handle;
  let binding;
  let owned;
  let claimIdentity;
  try {
    handle = await open7(stagedClaim, "wx", 384);
    claimIdentity = await handle.stat({ bigint: true });
    registerStagedClaim(claimIdentity);
    const value = validateCaptureClaim({
      schema: GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_CLAIM_SCHEMA,
      parent: identityValue(parent.identity),
      claim: identityValue(claimIdentity),
      staging: {
        directory: basename6(staging),
        identity: identityValue(stagingIdentity),
        files: {
          [NATIVE_RECEIPT_FILE]: identityValue(receiptIdentity),
          [CAPTURE_CLAIM_FILE]: identityValue(claimIdentity)
        }
      },
      target: NATIVE_RECEIPT_FILE,
      receipt: { ...receiptProof, identity: identityValue(receiptIdentity) }
    });
    const bytes = serializeGermanyOperationalPublicationJson(value);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = void 0;
    binding = await publishBoundFileCreateNew({
      sourcePath: stagedClaim,
      outputPath: finalClaim,
      expectedIdentity: claimIdentity,
      expectedProof: { bytes: bytes.length, sha256: createHash7("sha256").update(bytes).digest("hex") },
      label: "Native-Receipt-Capture-Claim",
      parent,
      registerOwned: (entry) => {
        owned = entry;
      },
      afterLinkBeforeAudit: hooks?.afterNativeReceiptClaimLinkBeforeAudit
    });
    return { path: finalClaim, identity: claimIdentity, value, binding, stagedClaimIdentity: claimIdentity };
  } catch (error) {
    if (handle !== void 0) await handle.close().catch(() => void 0);
    const cleanupErrors = [];
    if (binding !== void 0) await binding.handle.close().catch((closeError) => cleanupErrors.push(closeError));
    if (owned !== void 0) {
      await removeOwnedPathByQuarantine(parent, finalClaim, owned.identity, { kind: "file", label: "Native-Receipt-Capture-Claim", hooks }).catch((rollbackError) => cleanupErrors.push(rollbackError));
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "Native-Receipt-Capture-Claim und owned-only Recovery sind fehlgeschlagen.");
    throw error;
  }
}
async function readCaptureClaim(parent) {
  const path = captureClaimPath(parent.real);
  const metadata = await maybeMetadata(path);
  if (metadata === null) return null;
  invariant7(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0n && metadata.size <= BigInt(MAX_SMALL_JSON_BYTES), "Native-Receipt-Capture-Claim ist keine gueltige regulaere Datei.");
  const source = await smallJsonSource(path, "Native-Receipt-Capture-Claim");
  const value = validateCaptureClaim(source.value);
  invariant7(source.bytes.equals(serializeGermanyOperationalPublicationJson(value)), "Native-Receipt-Capture-Claim ist nicht kanonisch serialisiert.");
  invariant7(identityMatches(metadata, value.claim) && identityMatches(parent.identity, value.parent), "Native-Receipt-Capture-Claim bindet Claim oder Elternverzeichnis falsch.");
  return { path, identity: metadata, value };
}
async function recoverCaptureClaimIfPresent({ parent, output, expectedProof, expectedReceipt, hooks = {} }) {
  const claim = await readCaptureClaim(parent);
  const outputMetadata = await maybeMetadata(output);
  const orphanStaging = (await readdir5(parent.real)).filter((name) => name.startsWith(CAPTURE_STAGING_PREFIX));
  if (claim === null) {
    invariant7(orphanStaging.length === 0, "Native-Receipt-Capture besitzt verwaistes Staging ohne recoverbaren Claim.");
    if (outputMetadata === null) return null;
    proofMatches2(await regularFileProof(output, "Bereits vollstaendiger Native-Receipt-Capture"), expectedProof, "Bereits vollstaendiger Native-Receipt-Capture");
    const source = await smallJsonSource(output, "Bereits vollstaendiger Native-Receipt-Capture");
    invariant7(source.bytes.equals(serializeGermanyOperationalPublicationJson(expectedReceipt)), "Bestehender Native-Receipt-Capture driftet vom erwarteten kanonischen Receipt.");
    await assertPinnedParent2(parent);
    return { path: output, receipt: expectedReceipt, ...expectedProof, recovery: "already-complete" };
  }
  invariant7(orphanStaging.length <= 1 && (orphanStaging.length === 0 || orphanStaging[0] === claim.value.staging.directory), "Native-Receipt-Capture-Claim besitzt zusaetzliches fremdes Staging.");
  invariant7(claim.value.target === basename6(output), "Native-Receipt-Capture-Claim bindet ein anderes Ziel.");
  proofMatches2(claim.value.receipt, expectedProof, "Native-Receipt-Capture-Claim-Receipt");
  const staging = join5(parent.real, claim.value.staging.directory);
  const stagingMetadata = await maybeMetadata(staging);
  if (stagingMetadata !== null) {
    invariant7(stagingMetadata.isDirectory() && !stagingMetadata.isSymbolicLink() && identityMatches(stagingMetadata, claim.value.staging.identity), "Native-Receipt-Capture-Recovery-Staging wurde fremd ersetzt.");
  }
  if (outputMetadata !== null) {
    invariant7(outputMetadata.isFile() && !outputMetadata.isSymbolicLink() && identityMatches(outputMetadata, claim.value.receipt.identity), "Native-Receipt-Capture-Ziel wurde nach Crash fremd ersetzt.");
    proofMatches2(await regularFileProof(output, "Recoverter Native-Receipt-Capture"), expectedProof, "Recoverter Native-Receipt-Capture");
  }
  if (stagingMetadata !== null) {
    await removeOwnedPathByQuarantine(parent, staging, stagingMetadata, {
      kind: "directory",
      label: "Native-Receipt-Capture-Recovery-Staging",
      hooks,
      expectedFiles: {
        [NATIVE_RECEIPT_FILE]: claim.value.staging.files[NATIVE_RECEIPT_FILE],
        [CAPTURE_CLAIM_FILE]: claim.value.staging.files[CAPTURE_CLAIM_FILE]
      }
    });
  }
  await removeOwnedPathByQuarantine(parent, claim.path, claim.identity, { kind: "file", label: "Native-Receipt-Capture-Claim", hooks });
  invariant7(await maybeMetadata(claim.path) === null, "Native-Receipt-Capture-Claim blieb nach Recovery sichtbar.");
  await assertPinnedParent2(parent);
  if (outputMetadata === null) return null;
  proofMatches2(await regularFileProof(output, "Native-Receipt-Capture nach Recovery-Cleanup"), expectedProof, "Native-Receipt-Capture nach Recovery-Cleanup");
  return { path: output, receipt: expectedReceipt, ...expectedProof, recovery: "completed" };
}
async function captureGermanyOperationalInfrastructureV2NativeReceiptCore({
  nativeReceipt,
  operationalProvenance,
  executionPinsSource,
  specificationPath,
  candidatePath,
  candidateMovementRouteTemplatesPath,
  reportPath,
  nativeExecutablePath,
  validatorRebuildSpecificationPath,
  validatorRebuildEvidencePath,
  outputPath,
  workspaceRoot: workspaceRoot2 = REPOSITORY_ROOT3,
  captureEntrypointPath = resolve7(REPOSITORY_ROOT3, GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_ENTRYPOINT),
  expectedCaptureEntrypoint = GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_ENTRYPOINT,
  verifyValidatorRebuildEvidence = verifyOperationalValidatorRebuildEvidence,
  hooks = {}
}) {
  const root2 = resolve7(workspaceRoot2);
  const [executableProof, captureEntrypoint] = await Promise.all([
    regularFileProof(nativeExecutablePath, "Nativer Operational-v2-Compiler vor Validator-Ausfuehrung"),
    captureScriptProof(root2, captureEntrypointPath, expectedCaptureEntrypoint)
  ]);
  const executableBinding = {
    file: portableRelativePath(root2, nativeExecutablePath, "Nativer Operational-v2-Compiler"),
    ...executableProof
  };
  const executionInventoryBefore = await publisherExecutionInventoryProof(root2, executableBinding);
  proofMatches2(executionInventoryBefore.validatorExecutable, executableBinding, "Nativer Operational-v2-Compiler vor Capture-Validierung");
  const specification = await smallJsonSource(specificationPath, "Operational-v2-Spezifikation");
  const kind = validateGermanyOperationalInfrastructureV2Specification(specification.value);
  if (kind !== "conservative") throw new OperationalInfrastructureDerivationBlockedError(assessGermanyOperationalInfrastructureV2Readiness(specification.value));
  const executionPins = executionPinsSource?.value;
  invariant7(
    executionPins?.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA && executionPins.releaseId === specification.value.infraReleaseId,
    "Native-Receipt-Capture besitzt keine passenden versionierten Execution-Pins."
  );
  invariant7(
    sameCanonicalValue2(operationalProvenance?.executionPins, executionPinsSource.proof),
    "Native-Receipt-Capture-Provenienz bindet andere Execution-Pins-Bytes."
  );
  const expectedSidecarFile = nativeCandidateSidecarName(candidatePath);
  invariant7(
    basename6(candidateMovementRouteTemplatesPath) === expectedSidecarFile && resolve7(candidateMovementRouteTemplatesPath) === join5(dirname7(resolve7(candidatePath)), expectedSidecarFile),
    "Candidate-Sidecar besitzt nicht den vom Candidate abgeleiteten Geschwisterpfad."
  );
  const validatedNativeReceipt = validateGermanyOperationalInfrastructureV2NativeReceipt(nativeReceipt, specification.value.infraReleaseId, {
    expectedMovementRouteTemplatesFile: expectedSidecarFile
  });
  const [candidateProof, movementProof, reportSource] = await Promise.all([
    regularFileProof(candidatePath, "Nativer Operational-v2-Candidate"),
    regularFileProof(candidateMovementRouteTemplatesPath, "Natives Candidate-Movement-Sidecar"),
    smallJsonSource(reportPath, "Nativer Operational-v2-Ableitungsbericht")
  ]);
  const report = validateGermanyOperationalInfrastructureV2NativeReport(reportSource.value, specification.value, {
    expectedMovementRouteTemplatesFile: expectedSidecarFile
  });
  const validatorRebuild = await loadAndVerifyValidatorRebuild({
    workspaceRoot: root2,
    validatorRebuildSpecificationPath,
    validatorRebuildEvidencePath,
    expectedReleaseId: specification.value.infraReleaseId,
    expectedValidator: executableBinding,
    verifyValidatorRebuildEvidence
  });
  invariant7(
    executionPins.validator.file === executableBinding.file && executionPins.validator.bytes === executableBinding.bytes && executionPins.validator.sha256 === executableBinding.sha256 && executionPins.validator.buildCommit === validatorRebuild.binding.sourceCommit && executionPins.validator.rebuildSpecification === validatorRebuild.binding.specification.file && executionPins.validator.rebuildEvidence === validatorRebuild.binding.evidence.file,
    "Native-Receipt-Capture driftet von Validator-, Rebuild- oder Commit-Pins."
  );
  const capture = validateCaptureReceipt({
    schema: GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_SCHEMA,
    infraReleaseId: specification.value.infraReleaseId,
    operationalProvenance,
    nativeReceipt: validatedNativeReceipt,
    specification: { file: portableRelativePath(root2, specificationPath, "Operational-v2-Spezifikation"), ...specification.proof },
    sources: {
      candidate: { file: portableRelativePath(root2, candidatePath, "Operational-v2-Candidate"), ...candidateProof, stateHash: validatedNativeReceipt.candidate.stateHash },
      movementRouteTemplates: {
        file: portableRelativePath(root2, candidateMovementRouteTemplatesPath, "Candidate-Movement-Sidecar"),
        ...movementProof,
        stateHash: validatedNativeReceipt.movementRouteTemplates.stateHash,
        operationalStateHash: validatedNativeReceipt.movementRouteTemplates.operationalStateHash,
        timetableTransferSetSha256: validatedNativeReceipt.movementRouteTemplates.timetableTransferSetSha256
      },
      report: { file: portableRelativePath(root2, reportPath, "Operational-v2-Ableitungsbericht"), ...reportSource.proof }
    },
    producer: {
      command: "derive-germany-operational-v2",
      executable: executableBinding,
      captureEntrypoint,
      executionInventory: executionInventoryBefore
    },
    validatorRebuild: validatorRebuild.binding
  }, specification.value.infraReleaseId);
  validateNativeTripletBindings({
    specification: specification.value,
    specificationProof: specification.proof,
    capture,
    report,
    candidateProof,
    movementProof,
    reportProof: reportSource.proof
  });
  executionInventoryMatches(
    await publisherExecutionInventoryProof(root2, executableBinding),
    executionInventoryBefore,
    "Native-Receipt-Capture-Ausfuehrungsinventar nach Validierung"
  );
  const output = resolve7(outputPath);
  invariant7(basename6(output) === NATIVE_RECEIPT_FILE, `Native-Receipt-Capture muss ${NATIVE_RECEIPT_FILE} heissen.`);
  const parent = await pinParentDirectory2(dirname7(output), { create: true });
  invariant7(dirname7(output) === parent.real, "Native-Receipt-Ziel muss direkt im gepinnten Elternverzeichnis liegen.");
  const bytes = serializeGermanyOperationalPublicationJson(capture);
  const expectedProof = { bytes: bytes.length, sha256: createHash7("sha256").update(bytes).digest("hex") };
  const recovered = await recoverCaptureClaimIfPresent({ parent, output, expectedProof, expectedReceipt: capture, hooks });
  if (recovered !== null) return recovered;
  await assertCreateNewTargets([{ path: output, label: "Native-Receipt-Capture" }]);
  const staging = await mkdtemp5(join5(parent.real, CAPTURE_STAGING_PREFIX));
  const stagingIdentity = await lstat7(staging, { bigint: true });
  const staged = join5(staging, basename6(output));
  let stagedIdentity;
  let stagedClaimIdentity;
  let claim;
  const publishedEntries = [];
  const publishedBindings = [];
  let result;
  let primaryError;
  try {
    await writeNewFile(staged, bytes);
    stagedIdentity = await lstat7(staged, { bigint: true });
    claim = await acquireCaptureClaim(parent, staging, stagingIdentity, staged, stagedIdentity, expectedProof, hooks, (identity) => {
      stagedClaimIdentity = identity;
    });
    const binding = await publishBoundFileCreateNew({
      sourcePath: staged,
      outputPath: output,
      expectedIdentity: stagedIdentity,
      expectedProof,
      label: "Native-Receipt-Capture",
      parent,
      registerOwned: (entry) => publishedEntries.push(entry),
      afterLinkBeforeAudit: hooks?.afterNativeReceiptSourceLinkBeforeAudit
    });
    publishedBindings.push(binding);
    await runHook(hooks, "afterNativeReceiptLink", { parent, output, staging, staged });
    proofMatches2(await proofFromBoundPublication(binding), expectedProof, "Publizierter Native-Receipt-Capture");
    result = { path: output, receipt: capture, ...expectedProof };
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  if (primaryError !== void 0 && publishedBindings.length > 0) {
    try {
      await closeBoundPublications(publishedBindings);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError !== void 0 && publishedEntries.length > 0) {
    try {
      await rollbackOwnedPublishedEntries(parent, publishedEntries, hooks);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await removeOwnedPathByQuarantine(parent, staging, stagingIdentity, {
      kind: "directory",
      label: "Native-Receipt-Capture-Staging",
      hooks,
      expectedFiles: stagedIdentity === void 0 ? {} : {
        [basename6(output)]: stagedIdentity,
        ...stagedClaimIdentity === void 0 ? {} : { [CAPTURE_CLAIM_FILE]: stagedClaimIdentity }
      }
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (claim !== void 0 && cleanupErrors.length === 0) {
    try {
      if (claim.binding !== void 0) {
        await claim.binding.handle.close();
        claim.binding = void 0;
      }
      await removeOwnedPathByQuarantine(parent, claim.path, claim.identity, { kind: "file", label: "Native-Receipt-Capture-Claim", hooks });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (claim?.binding !== void 0) {
    try {
      await claim.binding.handle.close();
      claim.binding = void 0;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError === void 0 && cleanupErrors.length > 0 && publishedBindings.length > 0) {
    try {
      await closeBoundPublications(publishedBindings);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError === void 0 && cleanupErrors.length > 0 && publishedEntries.length > 0) {
    try {
      await rollbackOwnedPublishedEntries(parent, publishedEntries, hooks);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError !== void 0) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        `Native-Receipt-Capture scheiterte: ${errorDetail(primaryError)}; owned-only Rollback/Cleanup meldete zusaetzlich: ${cleanupErrors.map(errorDetail).join(" | ")}`
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    throw new AggregateError(cleanupErrors, "Native-Receipt-Capture-Cleanup und owned-only Rollback sind fehlgeschlagen.");
  }
  let finalAuditError;
  try {
    await runHook(hooks, "afterNativeReceiptCleanupBeforeFinalAudit", { parent, output });
    await assertPinnedParent2(parent);
    for (const binding of publishedBindings) {
      proofMatches2(await proofFromBoundPublication(binding), expectedProof, "Native-Receipt-Capture nach Cleanup");
    }
    invariant7(await maybeMetadata(captureClaimPath(parent.real)) === null, "Native-Receipt-Capture-Claim blieb nach Success sichtbar.");
    proofMatches2(await regularFileProof(output, "Native-Receipt-Capture unmittelbar vor Success"), expectedProof, "Native-Receipt-Capture unmittelbar vor Success");
    await assertPinnedParent2(parent);
  } catch (error) {
    finalAuditError = error;
  }
  let finalCloseError;
  try {
    await closeBoundPublications(publishedBindings);
  } catch (error) {
    finalCloseError = error;
  }
  if (finalAuditError && finalCloseError) {
    throw new AggregateError([finalAuditError, finalCloseError], "Finaler Native-Receipt-Capture-Audit und Handle-Close sind fehlgeschlagen.");
  }
  if (finalAuditError) throw finalAuditError;
  if (finalCloseError) throw finalCloseError;
  return result;
}
async function runAndCaptureGermanyOperationalInfrastructureV2({
  executionPinsPath,
  specificationPath,
  sourceRoot,
  candidatePath,
  candidateMovementRouteTemplatesPath,
  reportPath,
  outputPath,
  workspaceRoot: workspaceRoot2 = REPOSITORY_ROOT3,
  runnerEntrypointPath = resolve7(REPOSITORY_ROOT3, GERMANY_OPERATIONAL_INTEGRATED_RUNNER_ENTRYPOINT),
  verifyValidatorRebuildEvidence = verifyOperationalValidatorRebuildEvidence,
  hooks = {}
}) {
  invariant7(
    OPERATIONAL_RUNNER_BUILD_CONTEXT === "anchored-stdin-bundle-v1",
    "Release-faehiger Operational-v2-Run-and-Capture darf nur aus dem kausal gehaltenen ESM-Bundle laufen."
  );
  const root2 = resolve7(workspaceRoot2);
  const specificationSource = await smallJsonSource(specificationPath, "Operational-v2-Spezifikation fuer integrierten Runner");
  const kind = validateGermanyOperationalInfrastructureV2Specification(specificationSource.value);
  if (kind !== "conservative") throw new OperationalInfrastructureDerivationBlockedError(assessGermanyOperationalInfrastructureV2Readiness(specificationSource.value));
  const executionPinsSource = await loadGermanyOperationalExecutionPins({
    workspaceRoot: root2,
    executionPinsPath,
    expectedReleaseId: specificationSource.value.infraReleaseId
  });
  const pins = executionPinsSource.value;
  const runnerEntrypoint = portableRelativePath(root2, runnerEntrypointPath, "Operational-v2-integrierter Runner-Entrypoint");
  invariant7(
    runnerEntrypoint === GERMANY_OPERATIONAL_INTEGRATED_RUNNER_ENTRYPOINT && pins.runner.entrypoint.file === runnerEntrypoint,
    "Operational-v2-Execution-Pins bindet nicht den festgelegten integrierten Runner."
  );
  const runnerProof = await proveGermanyOperationalExecutionContext({ workspaceRoot: root2, executionPins: pins });
  const nativeExecutablePath = resolvePortablePath(root2, pins.validator.file, "Operational-v2-Execution-Pins.validator.file");
  const validatorRebuildSpecificationPath = resolvePortablePath(root2, pins.validator.rebuildSpecification, "Operational-v2-Execution-Pins.validator.rebuildSpecification");
  const validatorRebuildEvidencePath = resolvePortablePath(root2, pins.validator.rebuildEvidence, "Operational-v2-Execution-Pins.validator.rebuildEvidence");
  const executableProof = await regularFileProof(nativeExecutablePath, "Operational-v2-preserved-Validator vor integriertem Runner");
  const executableBinding = { file: pins.validator.file, ...executableProof };
  invariant7(
    executableBinding.bytes === pins.validator.bytes && executableBinding.sha256 === pins.validator.sha256,
    "Operational-v2-preserved-Validator driftet von Execution-Pins."
  );
  const validatorRebuild = await loadAndVerifyValidatorRebuild({
    workspaceRoot: root2,
    validatorRebuildSpecificationPath,
    validatorRebuildEvidencePath,
    expectedReleaseId: specificationSource.value.infraReleaseId,
    expectedValidator: executableBinding,
    verifyValidatorRebuildEvidence
  });
  invariant7(
    validatorRebuild.binding.sourceCommit === pins.validator.buildCommit,
    "Operational-v2-Execution-Pins und Validator-Rebuild binden verschiedene Build-Commits."
  );
  let execution;
  let captureResult;
  const externalBeforeCleanup = hooks.beforeCandidateTripletCleanup;
  const runnerHooks = {
    ...hooks,
    beforeCandidateTripletCleanup: async ({ claim, recovery }) => {
      const provenance = validateGermanyOperationalProvenance(claim.operationalProvenance, { nativeReceipt: claim.nativeReceipt });
      invariant7(
        provenance.producerKind === GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND && provenance.releaseEvidenceEligible === true && provenance.productionActivationEligible === true,
        "Candidate-Triplet-Recovery besitzt keine releasefaehige integrierte Provenienz."
      );
      invariant7(
        sameCanonicalValue2(provenance.executionPins, executionPinsSource.proof),
        "Candidate-Triplet-Recovery bindet andere Execution-Pins."
      );
      validateGermanyOperationalExecutionProofAgainstPins(
        provenance.executionProof,
        pins,
        { nativeReceipt: claim.nativeReceipt }
      );
      const currentRunnerProof = await proveGermanyOperationalExecutionContext({ workspaceRoot: root2, executionPins: pins });
      invariant7(
        sameCanonicalValue2(provenance.executionProof.runner, currentRunnerProof),
        "Candidate-Triplet-Recovery-Importclosure driftet vom aktuellen gepinnten Runner."
      );
      captureResult = await captureGermanyOperationalInfrastructureV2NativeReceiptCore({
        nativeReceipt: claim.nativeReceipt,
        operationalProvenance: provenance,
        executionPinsSource,
        specificationPath,
        candidatePath,
        candidateMovementRouteTemplatesPath,
        reportPath,
        nativeExecutablePath,
        validatorRebuildSpecificationPath,
        validatorRebuildEvidencePath,
        outputPath,
        workspaceRoot: root2,
        captureEntrypointPath: runnerEntrypointPath,
        expectedCaptureEntrypoint: GERMANY_OPERATIONAL_INTEGRATED_RUNNER_ENTRYPOINT,
        verifyValidatorRebuildEvidence,
        hooks: hooks.capture ?? {}
      });
      await externalBeforeCleanup?.({ claim, recovery, captureResult });
    }
  };
  const result = await runGermanyOperationalInfrastructureV2({
    specification: specificationSource.value,
    specificationPath,
    sourceRoot,
    candidatePath,
    movementRouteTemplatesPath: candidateMovementRouteTemplatesPath,
    reportPath,
    deriveNative: async (stagedSpecificationPath, stagedSourceRoot, stagedCandidatePath, stagedReportPath) => {
      execution = await executeGermanyOperationalPinnedValidator({
        workspaceRoot: root2,
        executionPinsSource,
        runnerProof,
        validatorRebuild: validatorRebuild.binding,
        specificationPath: stagedSpecificationPath,
        sourceRoot: stagedSourceRoot,
        candidatePath: stagedCandidatePath,
        reportPath: stagedReportPath
      });
      return execution.nativeReceipt;
    },
    candidateTripletProvenance: async ({ nativeReceipt, nativeReport }) => {
      invariant7(execution !== void 0, "Integrierter Operational-v2-Runner besitzt keinen unmittelbaren Native-Prozessbeleg.");
      invariant7(
        nativeReport.activationEligible === true && nativeReport.unresolvedRequired === 0,
        "Integrierter Operational-v2-Runner erzeugt fuer einen offenen Candidate kein releasefaehiges Receipt."
      );
      return integratedGermanyOperationalProvenance({
        executionPinsProof: executionPinsSource.proof,
        executionProof: execution.executionProof,
        nativeReceipt
      });
    },
    hooks: runnerHooks
  });
  invariant7(captureResult !== void 0, "Integrierter Operational-v2-Runner beendete sich ohne atomaren Native-Receipt-Capture.");
  return { result, capture: captureResult };
}
async function restoreMismatchedQuarantine({ original, quarantined, quarantineRoot, kind, label }) {
  try {
    invariant7(await maybeMetadata(original) === null, `${label} wurde waehrend der Quarantaene erneut fremd belegt.`);
    if (kind === "file") {
      await link5(quarantined, original);
      await unlink4(quarantined);
    } else {
      await rename3(quarantined, original);
    }
    await rmdir4(quarantineRoot);
  } catch (restoreError) {
    throw new AggregateError(
      [restoreError],
      `${label} wurde vor der owned-only Loeschung fremd ersetzt; die fremde Identitaet wurde nicht geloescht.`
    );
  }
}
async function restoreMismatchedDirectoryEntry({ original, quarantined, entryQuarantine, label }) {
  try {
    invariant7(await maybeMetadata(original) === null, `${label} wurde nach der Quarantaene erneut fremd belegt.`);
    await rename3(quarantined, original);
    await rmdir4(entryQuarantine);
  } catch (restoreError) {
    throw new AggregateError(
      [restoreError],
      `${label} wurde im Directory-Cleanup fremd ersetzt; die fremde Identitaet bleibt in der Quarantaene erhalten.`
    );
  }
}
async function removeOwnedPathByQuarantine(parent, pathInput, expectedIdentity, { kind, label, expectedFiles = {}, hooks = {} }) {
  await assertPinnedParent2(parent);
  const original = resolve7(pathInput);
  invariant7(dirname7(original) === parent.real, `${label} liegt nicht direkt im gepinnten Elternverzeichnis.`);
  const current = await maybeMetadata(original);
  invariant7(current !== null, `${label} fehlt vor der owned-only Loeschung.`);
  invariant7(
    (kind === "file" ? current.isFile() : current.isDirectory()) && !current.isSymbolicLink() && matchesExpectedIdentity(current, expectedIdentity),
    `${label} wurde vor der owned-only Loeschung fremd ersetzt.`
  );
  await runHook(hooks, "beforeOwnedPathQuarantineRename", {
    label,
    kind,
    original,
    expectedIdentity,
    observedIdentity: current
  });
  const quarantineRoot = await mkdtemp5(join5(parent.real, OWNED_CLEANUP_PREFIX));
  const quarantined = join5(quarantineRoot, basename6(original));
  await rename3(original, quarantined);
  const moved = await lstat7(quarantined, { bigint: true });
  if (!matchesExpectedIdentity(moved, expectedIdentity)) {
    await restoreMismatchedQuarantine({ original, quarantined, quarantineRoot, kind, label });
    throw new Error(`${label} wurde waehrend der owned-only Loeschung fremd ersetzt.`);
  }
  if (kind === "file") {
    invariant7(moved.isFile() && !moved.isSymbolicLink(), `${label} ist in der Quarantaene keine regulaere Datei.`);
    await unlink4(quarantined);
  } else {
    invariant7(moved.isDirectory() && !moved.isSymbolicLink(), `${label} ist in der Quarantaene kein regulaeres Verzeichnis.`);
    invariant7(isRecord4(expectedFiles), `${label} besitzt keine erwarteten Stagingdatei-Identitaeten.`);
    const entries = (await readdir5(quarantined, { withFileTypes: true })).sort((left, right) => {
      const leftIsAnchor = left.name.endsWith(OWNERSHIP_ANCHOR_SUFFIX);
      const rightIsAnchor = right.name.endsWith(OWNERSHIP_ANCHOR_SUFFIX);
      if (leftIsAnchor !== rightIsAnchor) return leftIsAnchor ? 1 : -1;
      return left.name.localeCompare(right.name);
    });
    invariant7(entries.length === Object.keys(expectedFiles).length, `${label} besitzt fehlende oder unerwartete Stagingdateien; Quarantaene bleibt fail-closed erhalten.`);
    const entryQuarantine = join5(quarantineRoot, ".owned-entries");
    await mkdir5(entryQuarantine, { recursive: false, mode: 448 });
    const heldEntries = [];
    let entryError;
    try {
      for (const entry of entries) {
        invariant7(Object.hasOwn(expectedFiles, entry.name), `${label} enthaelt den unerwarteten Eintrag ${entry.name}; Quarantaene bleibt fail-closed erhalten.`);
        const entryPath = join5(quarantined, entry.name);
        const handle = await open7(entryPath, "r");
        heldEntries.push({ entry, entryPath, handle });
        const [metadata, held] = await Promise.all([
          lstat7(entryPath, { bigint: true }),
          handle.stat({ bigint: true })
        ]);
        invariant7(
          metadata.isFile() && held.isFile() && !metadata.isSymbolicLink() && matchesExpectedIdentity(held, expectedFiles[entry.name]) && sameStableMetadata2(metadata, held),
          `${label}.${entry.name} wurde vor der owned-only Loeschung fremd ersetzt; Quarantaene bleibt fail-closed erhalten.`
        );
        heldEntries[heldEntries.length - 1].metadata = held;
      }
      for (const heldEntry of heldEntries) {
        const { entry, entryPath, handle, metadata } = heldEntry;
        await runHook(hooks, "beforeOwnedDirectoryEntryQuarantineRename", {
          label,
          entryName: entry.name,
          entryPath,
          expectedIdentity: expectedFiles[entry.name],
          observedIdentity: metadata
        });
        const [pathBefore, heldBefore] = await Promise.all([
          lstat7(entryPath, { bigint: true }),
          handle.stat({ bigint: true })
        ]);
        invariant7(
          pathBefore.isFile() && heldBefore.isFile() && !pathBefore.isSymbolicLink() && sameStableMetadata2(pathBefore, heldBefore) && samePersistentFileMetadata(metadata, heldBefore),
          `${label}.${entry.name} wurde vor seiner Quarantaene fremd ersetzt oder veraendert; Quarantaene bleibt fail-closed erhalten.`
        );
        const quarantinedEntry = join5(entryQuarantine, entry.name);
        await rename3(entryPath, quarantinedEntry);
        const [movedEntry, heldAfter] = await Promise.all([
          lstat7(quarantinedEntry, { bigint: true }),
          handle.stat({ bigint: true })
        ]);
        if (!movedEntry.isFile() || !heldAfter.isFile() || movedEntry.isSymbolicLink() || !sameStableMetadata2(movedEntry, heldAfter) || !samePersistentFileMetadata(heldBefore, heldAfter)) {
          await restoreMismatchedDirectoryEntry({ original: entryPath, quarantined: quarantinedEntry, entryQuarantine, label: `${label}.${entry.name}` });
          throw new Error(`${label}.${entry.name} wurde waehrend der owned-only Loeschung fremd ersetzt.`);
        }
        await unlink4(quarantinedEntry);
      }
    } catch (error) {
      entryError = error;
    }
    const closeErrors = [];
    for (const { handle } of heldEntries.reverse()) {
      try {
        await handle.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (entryError !== void 0 && closeErrors.length > 0) {
      throw new AggregateError([entryError, ...closeErrors], `${label}-Cleanup und das Schliessen der Ownership-Handles sind fehlgeschlagen.`);
    }
    if (entryError !== void 0) throw entryError;
    if (closeErrors.length > 0) throw new AggregateError(closeErrors, `${label}-Ownership-Handles konnten nicht vollstaendig geschlossen werden.`);
    await rmdir4(entryQuarantine);
    invariant7((await readdir5(quarantined)).length === 0, `${label} erhielt waehrend des Cleanup fremde Eintraege; Quarantaene bleibt fail-closed erhalten.`);
    await rmdir4(quarantined);
  }
  await rmdir4(quarantineRoot);
  await assertPinnedParent2(parent);
}
async function rollbackOwnedPublishedEntries(parent, entries, hooks = {}) {
  const rollbackErrors = [];
  for (const entry of [...entries].reverse()) {
    try {
      await removeOwnedPathByQuarantine(parent, entry.outputPath, entry.identity, {
        kind: "file",
        label: entry.label,
        hooks
      });
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(rollbackErrors, "Operational-v2-owned-only-Rollback ist fehlgeschlagen.");
  }
}
async function runHook(hooks, name, context) {
  if (hooks?.[name] !== void 0) await hooks[name](context);
}

// tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs
var OPERATIONAL_RUNNER_BUILD_CONTEXT2 = "anchored-stdin-bundle-v1";
if (OPERATIONAL_RUNNER_BUILD_CONTEXT2 !== "anchored-stdin-bundle-v1") {
  throw new Error(
    "Der direkte .mjs-Aufruf ist nur Quellcode und darf keine releasefaehigen Operational-v2-Artefakte erzeugen. Verwende die dokumentierte, direkt vom Systemlauncher gehaltene Bundle-Invocation."
  );
}
var workspaceRoot = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT;
if (!workspaceRoot) throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt keine Arbeitswurzelbindung.");
var root = resolve8(workspaceRoot);
var phase = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_PHASE ?? "derive-and-capture-v1";
function canonicalValue6(value) {
  if (Array.isArray(value)) return value.map(canonicalValue6);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue6(value[key])]));
}
function canonicalBytes4(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue6(value), null, 2)}
`, "utf8");
}
function sha2565(bytes) {
  return createHash8("sha256").update(bytes).digest("hex");
}
function portable2(pathInput, label) {
  const value = relative6(root, resolve8(pathInput));
  if (value === "" || value === ".." || value.startsWith(`..${sep6}`)) throw new Error(`${label} verlaesst die gehaltene Arbeitswurzel.`);
  return value.split(sep6).join("/");
}
function exactKeys6(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} besitzt fremde oder fehlende Felder.`);
  }
  return value;
}
function sameCanonical2(left, right) {
  return JSON.stringify(canonicalValue6(left)) === JSON.stringify(canonicalValue6(right));
}
function comparablePath(pathInput) {
  const value = resolve8(pathInput);
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}
function parseJsonBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges UTF-8.`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON.`, { cause: error });
  }
}
function byteProof(bytes, pathInput, label) {
  return { bytes: bytes.length, file: portable2(pathInput, label), sha256: sha2565(bytes) };
}
function assertProof(actual, expected, label) {
  if (!sameCanonical2(actual, expected)) throw new Error(`${label} driftet von seinem gehaltenen Bytebeleg.`);
}
async function writeCreateNew(pathInput, bytes, label, runnerProof) {
  return materializeGermanyAnnualCreateNewArtifact({
    workspaceRoot: root,
    outputPath: pathInput,
    bytes,
    label,
    anchorHelperProof: runnerProof.anchorHelper
  });
}
if (phase === "materialize-annual-plan-evidence-v1") {
  const runnerArguments = Array.from({ length: 6 }, (_, index) => process.env[`ZUGFOLGE_OPERATIONAL_RUNNER_CLI_${index}`]);
  if (process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT !== "6" || runnerArguments.some((value) => !value)) {
    throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt keine vollstaendige sechsstellige Annual-Plan-Bindung.");
  }
  const [executionPinsPath, annualConfigPath, sourceCatalogPath, rightsRegisterPath, annualPlanOutputPath, startEvidenceOutputPath] = runnerArguments.map((value) => resolve8(value));
  const executionPinsSource = await loadGermanyOperationalExecutionPins({ workspaceRoot: root, executionPinsPath });
  const runnerProof = await proveGermanyOperationalExecutionContext({ workspaceRoot: root, executionPins: executionPinsSource.value });
  const execution = await executeGermanyOperationalPinnedAnnualExecutor({
    workspaceRoot: root,
    executionPinsSource,
    runnerProof,
    runnerPhase: phase,
    inputPaths: [annualConfigPath, sourceCatalogPath, rightsRegisterPath],
    rustArgumentPaths: [annualConfigPath, sourceCatalogPath, rightsRegisterPath]
  });
  if (execution.stderr.length !== 0) throw new Error("Gehaltene Annual-Plan-Phase erzeugte unerwartete stderr-Bytes.");
  let plan;
  try {
    plan = JSON.parse(execution.stdout.toString("utf8"));
  } catch (error) {
    throw new Error("Gehaltene Annual-Plan-Phase lieferte keinen einzelnen JSON-Plan.", { cause: error });
  }
  if (plan?.schema !== "zugfolge-annual-infra-plan/v1" || !Array.isArray(plan.stages)) {
    throw new Error("Gehaltene Annual-Plan-Phase lieferte keinen Annual-Plan-v1.");
  }
  const operationalStage = plan.stages.find((stage) => stage?.id === "operational-v2-derivation");
  const trustedExecutor = operationalStage?.directSystemLaunch?.trustedExecutor;
  if (operationalStage?.executionMode !== "held-contract-direct-system-launch-v1" || trustedExecutor?.file !== execution.trustedExecutor.file || trustedExecutor?.buildCommit !== execution.trustedExecutor.buildCommit || trustedExecutor?.bytes !== execution.trustedExecutor.bytes || trustedExecutor?.sha256 !== execution.trustedExecutor.sha256) {
    throw new Error("Gehaltene Annual-Plan-Phase bindet nicht denselben Direct-Contract und Trusted Executor.");
  }
  const planProof = await writeCreateNew(annualPlanOutputPath, canonicalBytes4(plan), "Annual-Plan-Output", runnerProof);
  const startEvidence = {
    annualLaunch: execution.annualLaunch,
    directContract: execution.annualLaunch.contract,
    executionPins: execution.executionPins,
    exit: execution.exit,
    inputs: execution.inputs,
    invocation: execution.invocation,
    job: execution.job,
    plan: planProof,
    releaseId: executionPinsSource.value.releaseId,
    runner: execution.runner,
    schema: "zugfolge-operational-validator-annual-executor-start-evidence/v1",
    trustedExecutor: execution.trustedExecutor
  };
  if (startEvidence.job.timeoutMilliseconds !== GERMANY_OPERATIONAL_ANNUAL_PLAN_TIMEOUT_MILLISECONDS) {
    throw new Error("Annual-Executor-Startbeleg bindet keinen exakten zweiminuetigen Plan-Supervisor.");
  }
  const startEvidenceProof = await writeCreateNew(startEvidenceOutputPath, canonicalBytes4(startEvidence), "Annual-Executor-Start-Evidence", runnerProof);
  process.stdout.write(`${JSON.stringify({
    status: "annual-plan-materialized",
    plan: planProof,
    startEvidence: startEvidenceProof
  })}
`);
} else if (phase === "execute-annual-operational-v2-v1") {
  let launchPath = function(name) {
    const value = launchContext[name];
    if (name === "sourceRoot" && value === ".") return root;
    if (isAbsolute6(value) || value.includes("\\") || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`Annual-Launch-Kontext.${name} ist kein sicherer portabler Pfad.`);
    }
    const path = resolve8(root, ...value.split("/"));
    if (portable2(path, `Annual-Launch-Kontext.${name}`) !== value) {
      throw new Error(`Annual-Launch-Kontext.${name} ist nicht kanonisch.`);
    }
    return path;
  };
  const runnerArguments = Array.from({ length: 8 }, (_, index) => process.env[`ZUGFOLGE_OPERATIONAL_RUNNER_CLI_${index}`]);
  if (process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT !== "8" || runnerArguments.some((value) => !value)) {
    throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt keine vollstaendige achtstellige Annual-Ausfuehrungsbindung.");
  }
  const [executionPinsPath, annualConfigPath, sourceCatalogPath, rightsRegisterPath, launchContextPath, annualPlanPath, planStartEvidencePath, outerReceiptOutputPath] = runnerArguments.map((value) => resolve8(value));
  const executionPinsSource = await loadGermanyOperationalExecutionPins({ workspaceRoot: root, executionPinsPath });
  const runnerProof = await proveGermanyOperationalExecutionContext({ workspaceRoot: root, executionPins: executionPinsSource.value });
  const [completedPlan, completedStartEvidence] = await Promise.all([
    verifyGermanyAnnualCreateNewArtifact({ workspaceRoot: root, outputPath: annualPlanPath, anchorHelperProof: runnerProof.anchorHelper }),
    verifyGermanyAnnualCreateNewArtifact({ workspaceRoot: root, outputPath: planStartEvidencePath, anchorHelperProof: runnerProof.anchorHelper })
  ]);
  const [contextBytes, planBytes, planStartEvidenceBytes] = await Promise.all([
    readFile6(launchContextPath),
    readFile6(annualPlanPath),
    readFile6(planStartEvidencePath)
  ]);
  const launchContext = parseJsonBytes(contextBytes, "Annual-Launch-Kontext");
  const annualPlan = parseJsonBytes(planBytes, "Attestierter Annual-Plan");
  const planStartEvidence = parseJsonBytes(planStartEvidenceBytes, "Attestierter Annual-Executor-Startbeleg");
  if (annualPlan?.schema !== "zugfolge-annual-infra-plan/v1" || planStartEvidence?.schema !== "zugfolge-operational-validator-annual-executor-start-evidence/v1") {
    throw new Error("Annual-Ausfuehrung besitzt keinen attestierbaren Plan-/Startbeleg-v1.");
  }
  if (!planBytes.equals(canonicalBytes4(annualPlan)) || !planStartEvidenceBytes.equals(canonicalBytes4(planStartEvidence))) {
    throw new Error("Annual-Plan oder Startbeleg ist nicht kanonisch serialisiert.");
  }
  exactKeys6(launchContext, [
    "candidatePath",
    "candidateSidecarPath",
    "executionPinsPath",
    "nativeReceiptPath",
    "reportPath",
    "runtimePath",
    "schema",
    "sourceRoot",
    "specificationPath"
  ], "Annual-Launch-Kontext");
  if (launchContext.schema !== "zugfolge-operational-v2-direct-system-launch-context/v1") {
    throw new Error("Annual-Launch-Kontext besitzt ein unbekanntes Schema.");
  }
  for (const [name, value] of Object.entries(launchContext)) {
    if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f]/u.test(value)) {
      throw new Error(`Annual-Launch-Kontext.${name} ist kein sicherer Textwert.`);
    }
  }
  const operationalStage = annualPlan.stages.find((stage) => stage?.id === "operational-v2-derivation");
  const operationalBindings = exactKeys6(operationalStage?.operationalBindings, [
    "candidatePath",
    "candidateSidecarPath",
    "executionPinsPath",
    "nativeReceiptPath",
    "outerExecutionReceiptPath",
    "publicationReceiptPath",
    "publishedOutputPath",
    "reportPath",
    "schema",
    "sourceRoot",
    "specificationPath"
  ], "Attestierter Annual-Plan.operationalBindings");
  if (operationalBindings.schema !== "zugfolge-operational-v2-annual-plan-bindings/v1") {
    throw new Error("Attestierter Annual-Plan besitzt kein bekanntes Operational-v2-I/O-Bindungsschema.");
  }
  const expectedOperationalBindings = {
    candidatePath: launchContext.candidatePath,
    candidateSidecarPath: launchContext.candidateSidecarPath,
    executionPinsPath: launchContext.executionPinsPath,
    nativeReceiptPath: launchContext.nativeReceiptPath,
    outerExecutionReceiptPath: portable2(outerReceiptOutputPath, "Annual-Outer-Execution-Receipt"),
    publicationReceiptPath: operationalBindings.publicationReceiptPath,
    publishedOutputPath: operationalBindings.publishedOutputPath,
    reportPath: launchContext.reportPath,
    schema: "zugfolge-operational-v2-annual-plan-bindings/v1",
    sourceRoot: launchContext.sourceRoot,
    specificationPath: launchContext.specificationPath
  };
  if (!sameCanonical2(operationalBindings, expectedOperationalBindings)) {
    throw new Error("Annual-Launch-Kontext und Outer-Receipt-Ziel driften von den Operational-v2-I/O-Bindungen des attestierten Plans.");
  }
  for (const name of ["publishedOutputPath", "publicationReceiptPath"]) {
    const value = operationalBindings[name];
    if (typeof value !== "string" || isAbsolute6(value) || value.includes("\\") || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`Attestierter Annual-Plan.operationalBindings.${name} ist kein sicherer portabler Pfad.`);
    }
  }
  const expectedPlanProof = byteProof(planBytes, annualPlanPath, "Attestierter Annual-Plan");
  const expectedStartEvidenceProof = byteProof(planStartEvidenceBytes, planStartEvidencePath, "Attestierter Plan-Startbeleg");
  assertProof(completedPlan.proof, expectedPlanProof, "Abgeschlossener attestierter Annual-Plan");
  assertProof(completedStartEvidence.proof, expectedStartEvidenceProof, "Abgeschlossener attestierter Plan-Startbeleg");
  const execution = await executeGermanyOperationalPinnedAnnualExecutor({
    workspaceRoot: root,
    executionPinsSource,
    runnerProof,
    runnerPhase: phase,
    inputPaths: [annualConfigPath, sourceCatalogPath, rightsRegisterPath, launchContextPath, annualPlanPath, planStartEvidencePath],
    rustArgumentPaths: [annualConfigPath, sourceCatalogPath, rightsRegisterPath, launchContextPath]
  });
  if (execution.stderr.length !== 0) throw new Error("Gehaltene Annual-Ausfuehrung erzeugte unerwartete stderr-Bytes.");
  const heldContextProof = byteProof(contextBytes, launchContextPath, "Annual-Launch-Kontext");
  assertProof(execution.inputs[3], heldContextProof, "Annual-Launch-Kontext");
  assertProof(execution.inputs[4], expectedPlanProof, "Attestierter Annual-Plan");
  assertProof(execution.inputs[5], expectedStartEvidenceProof, "Attestierter Plan-Startbeleg");
  exactKeys6(planStartEvidence, [
    "annualLaunch",
    "directContract",
    "executionPins",
    "exit",
    "inputs",
    "invocation",
    "job",
    "plan",
    "releaseId",
    "runner",
    "schema",
    "trustedExecutor"
  ], "Attestierter Annual-Executor-Startbeleg");
  exactKeys6(planStartEvidence.exit, ["code", "signal"], "Attestierter Annual-Executor-Startbeleg.exit");
  exactKeys6(planStartEvidence.job, ["mode", "timeoutMilliseconds"], "Attestierter Annual-Executor-Startbeleg.job");
  exactKeys6(planStartEvidence.invocation, ["arguments", "command", "phase"], "Attestierter Annual-Executor-Startbeleg.invocation");
  const expectedPlanInvocation = {
    arguments: ["plan", ...[annualConfigPath, sourceCatalogPath, rightsRegisterPath].map((path) => portable2(path, "Annual-Plan-Argument"))],
    command: "plan",
    phase: "materialize-annual-plan-evidence-v1"
  };
  if (planStartEvidence.releaseId !== executionPinsSource.value.releaseId || planStartEvidence.exit.code !== 0 || planStartEvidence.exit.signal !== null || planStartEvidence.job.mode !== "windows-kill-on-job-close-root-exit-bounded-io-v1" || planStartEvidence.job.timeoutMilliseconds !== GERMANY_OPERATIONAL_ANNUAL_PLAN_TIMEOUT_MILLISECONDS || !sameCanonical2(planStartEvidence.plan, expectedPlanProof) || !sameCanonical2(planStartEvidence.executionPins, execution.executionPins) || !sameCanonical2(planStartEvidence.annualLaunch, execution.annualLaunch) || !sameCanonical2(planStartEvidence.directContract, execution.annualLaunch.contract) || !sameCanonical2(planStartEvidence.trustedExecutor, execution.trustedExecutor) || !sameCanonical2(planStartEvidence.runner, execution.runner) || !sameCanonical2(planStartEvidence.inputs, execution.inputs.slice(0, 3)) || !sameCanonical2(planStartEvidence.invocation, expectedPlanInvocation)) {
    throw new Error("Annual-Ausfuehrung driftet vom exakten attestierten Plan-/Executor-Startbeleg.");
  }
  if (!sameCanonical2(execution.job, {
    mode: "windows-kill-on-job-close-root-exit-bounded-io-v1",
    timeoutMilliseconds: GERMANY_OPERATIONAL_ANNUAL_RUN_TIMEOUT_MILLISECONDS
  })) {
    throw new Error("Annual-Ausfuehrung besitzt keinen exakten sechsstuendigen Grosslauf-Supervisor.");
  }
  if (comparablePath(launchPath("executionPinsPath")) !== comparablePath(executionPinsPath)) {
    throw new Error("Annual-Launch-Kontext bindet andere Execution-Pins.");
  }
  if (comparablePath(launchPath("specificationPath")) !== comparablePath(resolve8(root, ...operationalBindings.specificationPath.split("/"))) || comparablePath(launchPath("sourceRoot")) !== comparablePath(root)) {
    throw new Error("Annual-Launch-Kontext bindet nicht die geplante Spezifikation und kanonische Arbeitswurzel.");
  }
  const runtimePath = await realpath7(launchContext.runtimePath);
  if (comparablePath(runtimePath) !== comparablePath(await realpath7(process.execPath))) {
    throw new Error("Annual-Launch-Kontext bindet nicht die gehaltene Node-Runtime.");
  }
  const candidatePath = launchPath("candidatePath");
  const candidateSidecarPath = launchPath("candidateSidecarPath");
  const reportPath = launchPath("reportPath");
  const nativeReceiptPath = launchPath("nativeReceiptPath");
  const nested = decodeGermanyOperationalNestedAnnualRun(execution.stdout, execution.runner);
  if (nested.capture.nativeReceipt.file !== portable2(nativeReceiptPath, "Annual-Native-Receipt")) {
    throw new Error("Kausaler Annual-Capture-Abschluss bindet einen anderen Native-Receipt-Pfad.");
  }
  const nativeReceiptProof = {
    bytes: nested.capture.nativeReceipt.bytes,
    file: nested.capture.nativeReceipt.file,
    sha256: nested.capture.nativeReceipt.sha256
  };
  const nativeReceipt = await withGermanyOperationalHeldOutputFiles({
    workspaceRoot: root,
    files: [{
      captureBytes: true,
      label: "nativeReceipt",
      path: nativeReceiptPath,
      proof: nativeReceiptProof
    }],
    callback: async ({ capturedBytes }) => {
      const bytes = capturedBytes.nativeReceipt;
      const value = validateGermanyOperationalInfrastructureV2NativeReceiptCapture(
        parseJsonBytes(bytes, "Kausal gehaltenes Native-Receipt"),
        executionPinsSource.value.releaseId
      );
      if (!bytes.equals(serializeGermanyOperationalPublicationJson(value))) {
        throw new Error("Kausal gehaltenes Native-Receipt ist nicht kanonisch serialisiert.");
      }
      return value;
    }
  });
  const sourceProof = (value) => ({ bytes: value.bytes, file: value.file, sha256: value.sha256 });
  if (nativeReceipt.operationalProvenance.producerKind !== GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND || nativeReceipt.operationalProvenance.releaseEvidenceEligible !== true || nativeReceipt.operationalProvenance.productionActivationEligible !== true || !sameCanonical2(nativeReceipt.operationalProvenance.executionProof?.annualLaunch, execution.annualLaunch)) {
    throw new Error("Kausal gehaltenes Native-Receipt bindet nicht denselben integrierten Annual-Launch-Vertrag wie der Outer-Lauf.");
  }
  if (nativeReceipt.sources.candidate.file !== portable2(candidatePath, "Annual-Candidate") || nativeReceipt.sources.movementRouteTemplates.file !== portable2(candidateSidecarPath, "Annual-Candidate-Sidecar") || nativeReceipt.sources.report.file !== portable2(reportPath, "Annual-Report")) {
    throw new Error("Kausal gehaltenes Native-Receipt bindet andere Candidate-Triplet-Pfade als der Launch-Kontext.");
  }
  const outerReceiptBytes = await withGermanyOperationalHeldOutputFiles({
    workspaceRoot: root,
    files: [
      { captureBytes: false, label: "candidate", path: candidatePath, proof: sourceProof(nativeReceipt.sources.candidate) },
      { captureBytes: false, label: "movementRouteTemplates", path: candidateSidecarPath, proof: sourceProof(nativeReceipt.sources.movementRouteTemplates) },
      { captureBytes: false, label: "report", path: reportPath, proof: sourceProof(nativeReceipt.sources.report) },
      { captureBytes: true, label: "nativeReceipt", path: nativeReceiptPath, proof: nativeReceiptProof }
    ],
    callback: async ({ capturedBytes }) => {
      if (sha2565(capturedBytes.nativeReceipt) !== nativeReceiptProof.sha256) {
        throw new Error("Native-Receipt driftete vor der Outer-Receipt-Materialisierung.");
      }
      const outerReceipt = {
        annualLaunch: execution.annualLaunch,
        attestedPlan: expectedPlanProof,
        attestedPlanStartEvidence: expectedStartEvidenceProof,
        executionPins: execution.executionPins,
        exit: execution.exit,
        inputs: execution.inputs,
        invocation: execution.invocation,
        job: execution.job,
        nestedLaunch: { ...nested.launcher, capture: nested.capture },
        outputs: {
          candidate: nativeReceipt.sources.candidate,
          movementRouteTemplates: nativeReceipt.sources.movementRouteTemplates,
          nativeReceipt: nativeReceiptProof,
          report: nativeReceipt.sources.report
        },
        releaseId: executionPinsSource.value.releaseId,
        runner: execution.runner,
        schema: "zugfolge-operational-v2-outer-execution-receipt/v1",
        trustedExecutor: execution.trustedExecutor
      };
      return canonicalBytes4(outerReceipt);
    }
  });
  const outerReceiptProof = await writeCreateNew(
    outerReceiptOutputPath,
    outerReceiptBytes,
    "Annual-Outer-Execution-Receipt",
    runnerProof
  );
  process.stdout.write(`${JSON.stringify({ status: "annual-operational-v2-executed", outerReceipt: outerReceiptProof })}
`);
} else if (phase === "materialize-validator-rebuild-v3") {
  const runnerArguments = Array.from({ length: 3 }, (_, index) => process.env[`ZUGFOLGE_OPERATIONAL_RUNNER_CLI_${index}`]);
  if (process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT !== "3" || runnerArguments.some((value) => !value)) {
    throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt keine vollstaendige dreistellige Rebuild-v3-Bindung.");
  }
  const [executionPinsPath, rebuildSpecificationPath, receiptOutputPath] = runnerArguments.map((value) => resolve8(value));
  const executionPinsSource = await loadGermanyOperationalExecutionPins({
    workspaceRoot: root,
    executionPinsPath
  });
  const runnerProof = await proveGermanyOperationalExecutionContext({
    workspaceRoot: root,
    executionPins: executionPinsSource.value
  });
  await proveGermanyOperationalAnnualLaunchFromEnvironment({ workspaceRoot: root, executionPinsSource });
  const expectedSpecificationPath = resolve8(root, ...executionPinsSource.value.validator.rebuildSpecification.split("/"));
  const expectedReceiptPath = resolve8(root, ...executionPinsSource.value.validator.rebuildEvidence.split("/"));
  if (rebuildSpecificationPath !== expectedSpecificationPath || receiptOutputPath !== expectedReceiptPath) {
    throw new Error("Gehaltene Rebuild-v3-Phase driftet von den Execution-Pins-Ausgabepfaden.");
  }
  const specBytes = await readFile6(rebuildSpecificationPath);
  let spec;
  try {
    spec = JSON.parse(specBytes.toString("utf8"));
  } catch (error) {
    throw new Error("Gehaltene Rebuild-v3-Spezifikation ist kein gueltiges JSON.", { cause: error });
  }
  validateOperationalValidatorRebuildSpec(spec);
  const implementation = runnerProof.importClosure.find(({ file }) => file === "tools/region-import/germany/operational-validator-rebuild-evidence.mjs");
  if (implementation === void 0) throw new Error("Rebuild-v3-Implementation fehlt in der gehaltenen Runner-Closure.");
  const producerProofs = {
    bundle: runnerProof.bundle,
    entrypoint: runnerProof.entrypoint,
    executionPins: {
      bytes: executionPinsSource.proof.bytes,
      file: executionPinsSource.proof.file,
      sha256: executionPinsSource.proof.sha256
    },
    implementation
  };
  const result = await materializeOperationalValidatorRebuildEvidence({
    outputPath: receiptOutputPath,
    producerProofs,
    runnerAnchorHelperProof: runnerProof.anchorHelper,
    spec,
    specBytes,
    specFile: rebuildSpecificationPath,
    workspaceRoot: root
  });
  process.stdout.write(`${JSON.stringify({
    status: "validator-rebuild-materialized",
    binary: result.binary,
    path: result.path,
    provenance: result.provenance,
    ...result.proof
  })}
`);
} else if (phase === "derive-and-capture-v1") {
  const runnerArguments = Array.from({ length: 7 }, (_, index) => process.env[`ZUGFOLGE_OPERATIONAL_RUNNER_CLI_${index}`]);
  if (process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT !== "7" || runnerArguments.some((value) => !value)) {
    throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt keine vollstaendige siebenstellige CLI-Bindung.");
  }
  const [executionPinsPath, specificationPath, sourceRoot, candidatePath, candidateMovementRouteTemplatesPath, reportPath, outputPath] = runnerArguments;
  const result = await runAndCaptureGermanyOperationalInfrastructureV2({
    executionPinsPath: resolve8(executionPinsPath),
    specificationPath: resolve8(specificationPath),
    sourceRoot: resolve8(sourceRoot),
    candidatePath: resolve8(candidatePath),
    candidateMovementRouteTemplatesPath: resolve8(candidateMovementRouteTemplatesPath),
    reportPath: resolve8(reportPath),
    outputPath: resolve8(outputPath),
    workspaceRoot: root,
    runnerEntrypointPath: resolve8(root, ...GERMANY_OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT.split("/"))
  });
  process.stdout.write(`${JSON.stringify({
    status: "captured",
    candidateProduced: result.result.candidateProduced,
    activationEligible: result.result.activationEligible,
    unresolvedRequired: result.result.unresolvedRequired,
    nativeReceipt: {
      file: portable2(result.capture.path, "Operational-v2-Native-Receipt-Capture"),
      bytes: result.capture.bytes,
      sha256: result.capture.sha256
    }
  })}
`);
} else {
  throw new Error("Gehaltenes Operational-v2-Runner-Bundle besitzt eine unbekannte interne Phase.");
}
