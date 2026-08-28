import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SCHEMA =
  "zugfolge-germany-annual-create-new-artifact-completion/v1";
export const GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX = ".zugfolge-complete.json";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const WINDOWS_ANNUAL_HELPER_SCRIPT = String.raw`
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
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function portable(root, pathInput, label) {
  const value = relative(root, resolve(pathInput));
  invariant(value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value),
    `${label} verlaesst die Arbeitswurzel.`);
  return value.split(sep).join("/");
}

async function assertCanonicalExistingPath(root, pathInput, label) {
  const path = resolve(pathInput);
  const rootReal = await realpath(root);
  const relativePath = portable(root, path, label);
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    const metadata = await lstat(current, { bigint: true });
    invariant(!metadata.isSymbolicLink(), `${label} verwendet einen symbolischen Link oder Junction-Ahnen.`);
  }
  invariant(comparable(await realpath(path)) === comparable(resolve(rootReal, ...segments)),
    `${label} verwendet einen symbolischen Link oder Junction-Ahnen.`);
  return path;
}

async function readHeldProof(pathInput, label) {
  const path = resolve(pathInput);
  const pathBefore = await lstat(path, { bigint: true });
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.size > 0n
    && pathBefore.size <= BigInt(MAX_ARTIFACT_BYTES), `${label} ist keine begrenzte regulaere Datei.`);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(sameIdentity(pathBefore, before), `${label} driftete vor dem gehaltenen Lesen.`);
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    invariant(pathAfter.isFile() && !pathAfter.isSymbolicLink() && sameIdentity(before, after)
      && sameIdentity(after, pathAfter) && BigInt(bytes.length) === after.size,
    `${label} driftete waehrend des gehaltenen Lesens.`);
    return { bytes, proof: { bytes: bytes.length, sha256: sha256(bytes) }, identity: after };
  } finally {
    await handle.close();
  }
}

function validateFileProof(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof value.file === "string" && value.file.length > 0
    && Number.isSafeInteger(value.bytes) && value.bytes > 0
    && typeof value.sha256 === "string" && SHA256.test(value.sha256), `${label} ist kein vollstaendiger Dateibeleg.`);
  return value;
}

async function heldAnchorHelperBytes(root, anchorHelperProof) {
  const expected = validateFileProof(anchorHelperProof, "Annual-Windows-Anchor-Helper");
  const helperPath = resolve(root, ...expected.file.split("/"));
  await assertCanonicalExistingPath(root, helperPath, "Annual-Windows-Anchor-Helper");
  const source = await readHeldProof(helperPath, "Annual-Windows-Anchor-Helper");
  invariant(source.proof.bytes === expected.bytes && source.proof.sha256 === expected.sha256,
    "Annual-Windows-Anchor-Helper driftet von seinem gehaltenen Byte-Pin.");
  return source.bytes;
}

function validateHelperResult(value, expectedArtifact, expectedCompletion) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value),
    "Annual-Windows-Anchor-Helper lieferte keinen Ergebnisbeleg.");
  for (const [label, proof, expected] of [
    ["artifact", value.artifact, expectedArtifact],
    ["completion", value.completion, expectedCompletion],
  ]) {
    invariant(proof !== null && typeof proof === "object" && !Array.isArray(proof)
      && proof.file === expected.file && proof.bytes === expected.bytes && proof.sha256 === expected.sha256
      && proof.identity !== null && typeof proof.identity === "object"
      && typeof proof.identity.dev === "string" && proof.identity.dev.length > 0
      && typeof proof.identity.ino === "string" && proof.identity.ino.length > 0,
    `Annual-Windows-Anchor-Helper.${label} driftet vom erwarteten Dateibeleg.`);
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
    helperBase64: helperBytes.toString("base64"),
  }), "utf8");
  const result = spawnSync(WINDOWS_POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand,
  ], {
    cwd: "C:\\Windows\\System32",
    encoding: "buffer",
    env: {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      SystemDrive: "C:",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Windows\\System32",
      TMP: "C:\\Windows\\System32",
      WINDIR: "C:\\Windows",
    },
    input: envelope,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  invariant(result.error === undefined, `Annual-Windows-Anchor-Helper konnte nicht gestartet werden: ${result.error?.message ?? "unbekannter Fehler"}.`);
  const stderrText = result.stderr.toString("utf8");
  const benignStartupProgress = stderrText.startsWith("#< CLIXML")
    && stderrText.includes('S="progress"')
    && !/S="(?:Error|warning|verbose|debug)"/iu.test(stderrText);
  invariant(result.status === 0 && result.signal === null && (stderrText.length === 0 || benignStartupProgress),
    `Annual-Windows-Anchor-Helper scheiterte fail-closed (Exit ${result.status ?? "ohne"}).`);
  let value;
  try { value = JSON.parse(result.stdout.toString("utf8")); }
  catch (error) { throw new Error("Annual-Windows-Anchor-Helper lieferte kein einzelnes JSON-Ergebnis.", { cause: error }); }
  return value;
}

async function writeStaged(path, bytes, label) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const held = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(path, { bigint: true });
    invariant(held.isFile() && !pathMetadata.isSymbolicLink() && sameIdentity(held, pathMetadata)
      && held.size === BigInt(bytes.length), `${label} wurde nicht vollstaendig im Staging materialisiert.`);
  } finally {
    await handle.close();
  }
}

function completionValue(file, proof) {
  return {
    artifact: { file, ...proof },
    schema: GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SCHEMA,
  };
}

function validateCompletion(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["artifact", "schema"]),
  `${label} besitzt fremde oder fehlende Felder.`);
  invariant(value.schema === GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SCHEMA,
    `${label} besitzt ein unbekanntes Schema.`);
  invariant(value.artifact !== null && typeof value.artifact === "object" && !Array.isArray(value.artifact)
    && JSON.stringify(Object.keys(value.artifact).sort()) === JSON.stringify(["bytes", "file", "sha256"])
    && value.artifact.file === expected.file && value.artifact.bytes === expected.bytes
    && value.artifact.sha256 === expected.sha256 && SHA256.test(value.artifact.sha256),
  `${label} bindet nicht das erwartete Artefakt.`);
  return value;
}

async function ensureCreateNewLink(stagedPath, outputPath, expected, label) {
  try {
    await link(stagedPath, outputPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readHeldProof(outputPath, `${label}-Recovery-Ziel`);
    invariant(existing.proof.bytes === expected.bytes && existing.proof.sha256 === expected.sha256,
      `${label} existiert bereits mit fremden Bytes; Recovery ersetzt oder loescht es nicht.`);
  }
}

export async function verifyGermanyAnnualCreateNewArtifact({
  workspaceRoot,
  outputPath,
  expectedProof,
  anchorHelperProof,
  invokeAnchorHelper,
  hooks = {},
}) {
  const root = resolve(workspaceRoot);
  const output = await assertCanonicalExistingPath(root, outputPath, "Annual-create-new-Artefakt");
  const file = portable(root, output, "Annual-create-new-Artefakt");
  const completionPath = `${output}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`;
  try {
    await assertCanonicalExistingPath(root, completionPath, "Annual-create-new-Completion-Beleg");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Annual-create-new-Artefakt ist unvollstaendig: Completion-Beleg fehlt.", { cause: error });
    }
    throw error;
  }
  const completionSource = await readHeldProof(completionPath, "Annual-create-new-Completion-Beleg");
  let completion;
  try { completion = JSON.parse(completionSource.bytes.toString("utf8")); }
  catch (error) { throw new Error("Annual-create-new-Completion-Beleg ist kein gueltiges JSON.", { cause: error }); }
  const expected = expectedProof ?? completion?.artifact;
  validateFileProof(expected, "Erwarteter Annual-create-new-Artefaktbeleg");
  invariant(expected.file === file, "Annual-create-new-Artefaktbeleg bindet einen anderen Pfad.");
  validateCompletion(completion, expected, "Annual-create-new-Completion-Beleg");
  invariant(completionSource.bytes.equals(canonicalBytes(completion)),
    "Annual-create-new-Completion-Beleg ist nicht kanonisch serialisiert.");
  const expectedCompletion = {
    bytes: completionSource.proof.bytes,
    file: `${file}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
    sha256: completionSource.proof.sha256,
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
      workspaceRoot: root,
    }, { anchorHelperProof, invokeAnchorHelper });
    validateHelperResult(helperResult, expected, expectedCompletion);
  } else {
    const artifact = await readHeldProof(output, "Annual-create-new-Artefakt");
    invariant(expected.bytes === artifact.proof.bytes && expected.sha256 === artifact.proof.sha256,
      "Annual-create-new-Artefakt driftet von seinem erwarteten Bytebeleg.");
    const completionAfter = await readHeldProof(completionPath, "Annual-create-new-Completion-Beleg nach Artefaktpruefung");
    invariant(completionAfter.proof.bytes === expectedCompletion.bytes
      && completionAfter.proof.sha256 === expectedCompletion.sha256,
    "Annual-create-new-Completion-Beleg driftete waehrend der Paarpruefung.");
  }
  return { path: output, proof: expected, completion: { path: completionPath, ...completionSource.proof } };
}

export async function materializeGermanyAnnualCreateNewArtifact({
  workspaceRoot,
  outputPath,
  bytes,
  label = "Annual-create-new-Artefakt",
  anchorHelperProof,
  invokeAnchorHelper,
  hooks = {},
}) {
  invariant(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_ARTIFACT_BYTES,
    `${label} besitzt keine begrenzten Ausgabebytes.`);
  const root = resolve(workspaceRoot);
  const output = resolve(outputPath);
  const parent = await assertCanonicalExistingPath(root, dirname(output), `${label}-Elternverzeichnis`);
  const file = portable(root, output, label);
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
      await assertCanonicalExistingPath(root, output, `${label}-Recovery-Artefakt`);
      const existing = await readHeldProof(output, `${label}-Recovery-Artefakt`);
      invariant(existing.proof.bytes === proof.bytes && existing.proof.sha256 === proof.sha256,
        `${label} existiert bereits mit fremden Bytes; Recovery ersetzt oder loescht es nicht.`);
    } catch (error) {
      throw new Error(`${label} existiert bereits mit fremden Bytes oder ungueltiger Pfadidentitaet; Recovery ersetzt oder loescht es nicht.`, { cause: error });
    }
  }
  if (artifactExists && completionExists) {
    try {
      return (await verifyGermanyAnnualCreateNewArtifact({
        workspaceRoot: root,
        outputPath: output,
        expectedProof: proof,
        anchorHelperProof,
        invokeAnchorHelper,
      })).proof;
    } catch (error) {
      throw new Error(`${label} existiert bereits unvollstaendig oder mit fremden Bytes; Recovery ersetzt oder loescht es nicht.`, { cause: error });
    }
  }
  if (!artifactExists && completionExists) {
    throw new Error(`${label}-Completion-Beleg existiert ohne sein Artefakt; Recovery ersetzt oder loescht ihn nicht.`);
  }
  const stagingRoot = join(parent, ".zugfolge-annual-create-new-staging");
  try { await mkdir(stagingRoot, { recursive: false, mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  await assertCanonicalExistingPath(root, stagingRoot, `${label}-Stagingwurzel`);
  const attempt = await mkdtemp(join(stagingRoot, "attempt-"));
  await assertCanonicalExistingPath(root, attempt, `${label}-Stagingversuch`);
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
    sha256: sha256(completionBytes),
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
      workspaceRoot: root,
    }, { anchorHelperProof, invokeAnchorHelper });
    validateHelperResult(helperResult, proof, completionProof);
  } else {
    await ensureCreateNewLink(stagedArtifact, output, proof, label);
    await ensureCreateNewLink(stagedCompletion, completionPath, completionProof, `${label}-Completion-Beleg`);
  }
  if (typeof hooks.afterArtifactPublish === "function") await hooks.afterArtifactPublish({ stagedArtifact, output });
  if (typeof hooks.afterCompletionPublish === "function") await hooks.afterCompletionPublish({ completionPath, output });
  return (await verifyGermanyAnnualCreateNewArtifact({
    workspaceRoot: root,
    outputPath: output,
    expectedProof: proof,
    anchorHelperProof,
    invokeAnchorHelper,
  })).proof;
}
