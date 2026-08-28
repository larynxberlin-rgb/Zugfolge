import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SCHEMA,
  GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX,
} from "./annual-create-new-artifact.mjs";
import { verifyGermanyOperationalInfrastructureV2PublicationReceipt } from "./operational-infrastructure-v2-publication.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const MUTABLE_TOKEN = /(^|[\\/_.-])(latest|current|unversioned)(?=$|[\\/_.-])/i;
const MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES = 64 * 1024 * 1024;
const CURRENT_ANNUAL_V3_RELEASE_ID = "infra-deutschland-2026.5";
const CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_PREDICATE = "https://slsa.dev/provenance/v1";
const CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_PREDICATE =
  "https://zugfolge.de/attestations/operational-v2-execution-authority/v1";
const CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_SCHEMA =
  "zugfolge-operational-v2-execution-authority/v1";
const CURRENT_ANNUAL_V3_OPERATIONAL_AUTHORITY_SCHEMA =
  "zugfolge-map-build-operational-authority/v1";
const CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_WORKFLOW =
  "larynxberlin-rgb/Zugfolge/.github/workflows/operational-v2-execution-authority.yml";
const CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_WORKFLOW =
  "larynxberlin-rgb/Zugfolge/.github/workflows/operational-validator-rebuild-evidence.yml";
const CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_BUNDLE =
  "var/derived/germany-2026.5/toolchain/zugfolge-operational-v2-execution-authority.sigstore.json";
const CURRENT_ANNUAL_V3_REBUILD_AUTHORITY_BUNDLE =
  "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json";
const CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER = Object.freeze({
  bytes: 40_998_712,
  cacheFile: "derived/infra-deutschland-2026.5/toolchain/gh-2.94.0-windows-amd64.exe",
  file: "var/derived/germany-2026.5/toolchain/gh-2.94.0-windows-amd64.exe",
  sha256: "91ed1eff1819a96b34bc2ca3adc01822c807ae1bb883c01ad9fdf335bf242b38",
  version: "2.94.0-windows-amd64",
});
const CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT = Object.freeze({
  bytes: 34_634,
  cacheFile: "derived/infra-deutschland-2026.5/toolchain/github-attestation-trusted-root.jsonl",
  file: "var/derived/germany-2026.5/toolchain/github-attestation-trusted-root.jsonl",
  sha256: "65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c",
});
const GH_ATTESTATION_MAX_TRUSTED_ROOT_BYTES = 16 * 1024 * 1024;
const GH_ATTESTATION_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GH_ATTESTATION_TIMEOUT_MILLISECONDS = 120_000;
const GH_ATTESTATION_LAUNCHER_MAX_OUTPUT_BYTES = Math.ceil(GH_ATTESTATION_MAX_OUTPUT_BYTES * 8 / 3) + 1024 * 1024;
const WINDOWS_TRUSTED_SYSTEM_ROOT = String.raw`C:\Windows`;
const WINDOWS_TRUSTED_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_ATTESTATION_ANCHOR_HELPER = Object.freeze({
  bytes: 46_080,
  path: join(dirname(fileURLToPath(import.meta.url)), "operational-windows-anchor-helper.dll"),
  sha256: "1e18d3048d9a778d05a7bd1532d4f84233aa2cb5d13d46ca4583e90811e7165f",
});
const CURRENT_BUILD_EVIDENCE_SPEC_FILE =
  "tools/tiles/map-release-build-evidence.annual-2026.5.spec.json";
const CURRENT_AUTHORITY_INPUTS = Object.freeze([
  ["operational-outer-execution-receipt", "var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json"],
  ["operational-outer-execution-receipt-completion", `var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`],
  ["operational-annual-plan", "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json"],
  ["operational-annual-plan-completion", `var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`],
  ["operational-annual-executor-start-evidence", "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json"],
  ["operational-annual-executor-start-evidence-completion", `var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`],
  ["operational-validator-rebuild-attestation", CURRENT_ANNUAL_V3_REBUILD_AUTHORITY_BUNDLE],
  ["operational-execution-authority-attestation", CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_BUNDLE],
  ["operational-attestation-verifier", CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.file],
  ["operational-attestation-trusted-root", CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.file],
]);
const CURRENT_SUPPORT_INPUTS = Object.freeze([
  ["germany-release-spec", "specification", "tools/region-import/germany/release.annual-2026.5.config.json"],
  ["germany-source-catalog", "repo-contract", "tools/region-import/germany/source-catalog.json"],
  ["rights-registry", "repo-contract", "tools/guards/quellenregister.json"],
]);

// The verifier and every path it consumes are opened handle-relatively from a
// held volume-root ancestry.  FILE_SHARE_READ deliberately denies write,
// delete and rename while CreateProcess and the complete child process tree
// are live.  This closes both direct file ABA and parent-directory swap ABA;
// a before/after pathname hash alone cannot do that.
const WINDOWS_HELD_GITHUB_CLI_LAUNCHER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$held = [Collections.Generic.List[IDisposable]]::new()
function Fail([string]$message) {
  [Console]::Error.Write($message)
  exit 91
}
function Hex([byte[]]$value) {
  return [BitConverter]::ToString($value).Replace('-', '').ToLowerInvariant()
}
function Decode-Request() {
  $encoded = [Environment]::GetEnvironmentVariable('ZUGFOLGE_GH_ANCHOR_REQUEST_BASE64', 'Process')
  if ([String]::IsNullOrEmpty($encoded) -or $encoded.Length -gt 4194304 -or
      ($encoded.Length % 4) -ne 0 -or $encoded -cnotmatch '^[A-Za-z0-9+/]*={0,2}$') {
    Fail 'Gehaltene GitHub-CLI-Anfrage ist kein begrenztes kanonisches Base64.'
  }
  try {
    $bytes = [Convert]::FromBase64String($encoded)
    if ([Convert]::ToBase64String($bytes) -cne $encoded) { Fail 'Gehaltene GitHub-CLI-Anfrage ist nicht kanonisch.' }
    return [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  } catch { Fail "Gehaltene GitHub-CLI-Anfrage ist ungueltig: $($_.Exception.Message)" }
}
function Assert-Proof([object]$entry, [string]$label) {
  if ($null -eq $entry -or [String]::IsNullOrEmpty([string]$entry.path) -or
      [Int64]$entry.bytes -le 0 -or [string]$entry.sha256 -cnotmatch '^[a-f0-9]{64}$') {
    Fail "$label besitzt keinen gueltigen Pfad-/Byte-/SHA-Pin."
  }
}
function Open-HelperBytes([object]$entry) {
  Assert-Proof $entry 'Windows-Anchor-Helper'
  $stream = [IO.FileStream]::new([string]$entry.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -ne [Int64]$entry.bytes) { Fail 'Windows-Anchor-Helper besitzt eine falsche Bytezahl.' }
    $bytes = New-Object byte[] ([Int32]$entry.bytes)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -eq 0) { Fail 'Windows-Anchor-Helper endete vorzeitig.' }
      $offset += $count
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = Hex ($sha.ComputeHash($bytes)) } finally { $sha.Dispose() }
    if ($actual -cne [string]$entry.sha256) { Fail 'Windows-Anchor-Helper besitzt einen falschen SHA-256.' }
    $held.Add($stream)
    return ,$bytes
  } catch {
    $stream.Dispose()
    throw
  }
}
function Open-HeldDirectory([string]$path, [string]$label) {
  try { $handle = [ZugfolgeRelativeFs]::OpenPlainDirectory($path) }
  catch { Fail "$label konnte nicht exklusiv gehalten werden: $($_.Exception.Message)" }
  $held.Add($handle)
  return $handle
}
function Open-HeldDirectoryRelative([Microsoft.Win32.SafeHandles.SafeFileHandle]$parent, [string]$leaf, [string]$label) {
  try { $handle = [ZugfolgeRelativeFs]::OpenDirectory($parent, $leaf) }
  catch { Fail "$label konnte nicht NT-relativ und reparsefrei geoeffnet werden: $($_.Exception.Message)" }
  $held.Add($handle)
  return $handle
}
function Open-HeldPathParent([string]$path, [string]$label) {
  $full = [IO.Path]::GetFullPath($path)
  if (-not [IO.Path]::IsPathRooted($full)) { Fail "$label ist nicht absolut." }
  $parentPath = [IO.Path]::GetDirectoryName($full)
  $volume = [IO.Path]::GetPathRoot($parentPath)
  $current = Open-HeldDirectory $volume "$label-Volume-Root"
  $remaining = $parentPath.Substring($volume.Length).Trim([IO.Path]::DirectorySeparatorChar)
  if (-not [String]::IsNullOrEmpty($remaining)) {
    foreach ($segment in $remaining.Split([IO.Path]::DirectorySeparatorChar)) {
      $current = Open-HeldDirectoryRelative $current $segment "$label-Ahne $segment"
    }
  }
  return [ordered]@{ parent = $current; leaf = [IO.Path]::GetFileName($full) }
}
function Open-HeldPathFile([object]$entry, [string]$label) {
  Assert-Proof $entry $label
  $location = Open-HeldPathParent ([string]$entry.path) $label
  try { $fileHandle = [ZugfolgeRelativeFs]::OpenRegularFile($location.parent, $location.leaf) }
  catch { Fail "$label konnte nicht NT-relativ und reparsefrei geoeffnet werden: $($_.Exception.Message)" }
  $stream = [IO.FileStream]::new($fileHandle, [IO.FileAccess]::Read, 1048576, $false)
  try {
    if ($stream.Length -ne [Int64]$entry.bytes) { Fail "$label besitzt eine falsche Bytezahl." }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = Hex ($sha.ComputeHash($stream)) } finally { $sha.Dispose() }
    if ($actual -cne [string]$entry.sha256) { Fail "$label besitzt einen falschen SHA-256." }
    $stream.Position = 0
    $held.Add($stream)
    return [ordered]@{ bytes = [Int64]$entry.bytes; file = [string]$entry.file; sha256 = $actual }
  } catch {
    $stream.Dispose()
    throw
  }
}
try {
  $request = Decode-Request
  $helperBytes = Open-HelperBytes $request.helper
  $assembly = [Reflection.Assembly]::Load($helperBytes)
  if (-not [String]::IsNullOrEmpty($assembly.Location) -or
      $null -eq $assembly.GetType('ZugfolgeMitigatedProcess', $false, $false) -or
      $null -eq $assembly.GetType('ZugfolgeRelativeFs', $false, $false)) {
    Fail 'Windows-Anchor-Helper wurde nicht ausschliesslich aus gehaltenen Bytes geladen.'
  }
  $anchorProof = Open-HeldPathFile $request.executable 'Private Attestierungsverifier-Kopie'
  $inputProofs = [Collections.Generic.List[object]]::new()
  foreach ($input in @($request.inputs)) {
    if ($inputProofs.Count -ge 8) { Fail 'GitHub-CLI-Launcher erhielt zu viele gehaltene Eingaben.' }
    $inputProofs.Add((Open-HeldPathFile $input "GitHub-CLI-Eingabe[$($inputProofs.Count)]"))
  }
  $allowedEnvironment = @(
    'ComSpec', 'GH_CONFIG_DIR', 'GH_NO_UPDATE_NOTIFIER', 'GH_PROMPT_DISABLED', 'NO_COLOR',
    'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR'
  )
  $actualEnvironment = @($request.environment.PSObject.Properties.Name)
  [Array]::Sort($allowedEnvironment, [StringComparer]::Ordinal)
  [Array]::Sort($actualEnvironment, [StringComparer]::Ordinal)
  if (($allowedEnvironment -join [Environment]::NewLine) -cne ($actualEnvironment -join [Environment]::NewLine)) {
    Fail 'GitHub-CLI-Launcher besitzt keine exakt begrenzte Prozessumgebung.'
  }
  $childEnvironment = @{}
  foreach ($name in $actualEnvironment) { $childEnvironment[$name] = [string]$request.environment.$name }
  $arguments = [string[]]@($request.arguments)
  if ($arguments.Count -le 0 -or $arguments.Count -gt 32) { Fail 'GitHub-CLI-Launcher besitzt eine ungueltige Argumentzahl.' }
  $maximumBytes = [Int32]$request.maximumBytes
  $timeoutMilliseconds = [Int32]$request.timeoutMilliseconds
  if ($maximumBytes -le 0 -or $maximumBytes -gt 16777216 -or
      $timeoutMilliseconds -le 0 -or $timeoutMilliseconds -gt 600000) {
    Fail 'GitHub-CLI-Launcher besitzt ungueltige Prozessgrenzen.'
  }
  $child = [ZugfolgeMitigatedProcess]::RunStrict(
    [string]$request.executable.path,
    $arguments,
    [string]$request.cwd,
    $childEnvironment,
    [byte[]]@(),
    $maximumBytes,
    $timeoutMilliseconds,
    $null)
  $envelope = [ordered]@{
    anchorBytes = [Int64]$anchorProof.bytes
    anchorSha256 = [string]$anchorProof.sha256
    inputProofs = $inputProofs.ToArray()
    status = [Int32]$child.ExitCode
    signal = $null
    stdoutBase64 = [Convert]::ToBase64String($child.Stdout)
    stderrBase64 = [Convert]::ToBase64String($child.Stderr)
  }
  [Console]::Out.Write(($envelope | ConvertTo-Json -Compress -Depth 20))
} catch {
  [Console]::Error.Write($_.Exception.ToString())
  exit 91
} finally {
  for ($index = $held.Count - 1; $index -ge 0; $index -= 1) {
    try { $held[$index].Dispose() } catch {}
  }
}
`;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function serializeMapReleaseBuildEvidence(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value), null, 2)}\n`, "utf8");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalValueSha256(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(sortedValue(value)), "utf8"));
}

function exactObjectKeys(value, keys, label) {
  invariant(isRecord(value), `${label} fehlt.`);
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `${label} besitzt unerwartete oder fehlende Felder.`,
  );
  return value;
}

function validateCommit(value, label) {
  invariant(typeof value === "string" && COMMIT.test(value), `${label} muss ein exakter Git-Commit sein.`);
  return value;
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value.length > 0 && !isAbsolute(value), `${label} muss ein relativer Pfad sein.`);
  invariant(!value.includes("\\") && !value.includes("\0"), `${label} ist nicht portabel.`);
  const parts = value.split("/");
  invariant(parts.every((part) => part !== "" && part !== "." && part !== ".."), `${label} enthält einen unsicheren Pfadabschnitt.`);
  invariant(!MUTABLE_TOKEN.test(value), `${label} darf weder latest noch unversioniert enthalten.`);
  return value;
}

async function containedRealPath(root, relativePath, label) {
  const portable = portablePath(relativePath, label);
  const requestedRoot = resolve(root);
  const rootMetadata = await lstat(requestedRoot);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), `${label}: Wurzel ist kein reguläres Verzeichnis.`);
  const absoluteRoot = await realpath(requestedRoot);
  let path = absoluteRoot;
  const parts = portable.split("/");
  for (const [index, part] of parts.entries()) {
    path = resolve(path, part);
    const metadata = await lstat(path);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link enthalten.`);
    if (index < parts.length - 1) invariant(metadata.isDirectory(), `${label} besitzt einen nicht auflösbaren Zwischenpfad.`);
  }
  const actual = await realpath(path);
  const remainder = relative(absoluteRoot, actual);
  invariant(remainder !== "" && !remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder), `${label} verlässt die Wurzel.`);
  return actual;
}

async function absoluteFileProof(path, label) {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${label} ist keine reguläre, nichtleere Datei.`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  invariant(bytes === metadata.size, `${label} änderte sich während der Hashbildung.`);
  return { bytes, sha256: hash.digest("hex") };
}

async function fileProof(root, descriptor, label) {
  const path = await containedRealPath(root, descriptor.file, `${label}.file`);
  const proof = await absoluteFileProof(path, label);
  if (descriptor.expectedBytes !== undefined || descriptor.expectedSha256 !== undefined) {
    invariant(Number.isSafeInteger(descriptor.expectedBytes) && descriptor.expectedBytes > 0, `${label} besitzt keine erwartete Bytezahl.`);
    invariant(SHA256.test(descriptor.expectedSha256), `${label} besitzt keinen erwarteten SHA-256.`);
    invariant(proof.bytes === descriptor.expectedBytes && proof.sha256 === descriptor.expectedSha256, `${label} weicht vom gepinnten Byte-SHA-Beleg ab.`);
  }
  return proof;
}

function currentAnnualInput(inputs, id, label = id) {
  const matches = inputs.filter((input) => input?.id === id);
  invariant(matches.length === 1 && matches[0].kind === "derived-input",
    `${label} fehlt als eindeutige typisierte abgeleitete Build-Evidence-Eingabe.`);
  return matches[0];
}

function materializedFileProof(value, label) {
  exactObjectKeys(value, ["bytes", "file", "sha256"], label);
  portablePath(value.file, `${label}.file`);
  invariant(Number.isSafeInteger(value.bytes) && value.bytes > 0 && SHA256.test(value.sha256),
    `${label} besitzt keinen Byte-SHA-Beleg.`);
  return value;
}

function inputFileProof(input) {
  return { bytes: input.bytes, file: input.file, sha256: input.sha256 };
}

function sameCanonicalValue(left, right) {
  return JSON.stringify(sortedValue(left)) === JSON.stringify(sortedValue(right));
}

async function readCanonicalJsonInput(root, input, label) {
  invariant(Number.isSafeInteger(input?.bytes) && input.bytes > 0
    && input.bytes <= MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES && SHA256.test(input.sha256),
  `${label} besitzt keinen begrenzten Byte-SHA-Beleg.`);
  const bytes = await readFile(await containedRealPath(root, input.file, label));
  invariant(bytes.length === input.bytes && sha256Bytes(bytes) === input.sha256,
    `${label} driftet von seiner Build-Evidence-Eingabe.`);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`${label} ist kein gueltiges JSON-Artefakt.`, { cause: error }); }
  invariant(bytes.equals(serializeMapReleaseBuildEvidence(value)), `${label} ist nicht kanonisch serialisiert.`);
  return value;
}

async function validateAnnualCompletionInput(root, completionInput, artifactProof, label) {
  invariant(completionInput.file === `${artifactProof.file}${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`,
    `${label} besitzt nicht den create-new-Completion-Pfad des Artefakts.`);
  const completion = await readCanonicalJsonInput(root, completionInput, label);
  exactObjectKeys(completion, ["artifact", "schema"], label);
  invariant(completion.schema === GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SCHEMA,
    `${label} besitzt ein unbekanntes Completion-Schema.`);
  materializedFileProof(completion.artifact, `${label}.artifact`);
  invariant(sameCanonicalValue(completion.artifact, artifactProof),
    `${label} bindet nicht den erwarteten Artefaktbeleg.`);
  return inputFileProof(completionInput);
}

function expectedCurrentAnnualOperationalBindings(releaseConfig) {
  const deriver = releaseConfig?.pipeline?.operationalDeriver;
  const recovery = deriver?.recoveryPublisher;
  invariant(isRecord(deriver) && isRecord(recovery),
    "Deutschland-Jahresrelease besitzt keinen Operational-v2-RecoveryPublisher-Vertrag.");
  const value = {
    candidatePath: deriver.candidate,
    candidateSidecarPath: deriver.candidateMovementRouteTemplates,
    executionPinsPath: deriver.executionPins,
    nativeReceiptPath: recovery.nativeReceipt,
    outerExecutionReceiptPath: recovery.outerExecutionReceipt,
    publicationReceiptPath: recovery.publicationReceipt,
    publishedOutputPath: deriver.output,
    reportPath: deriver.report,
    schema: "zugfolge-operational-v2-annual-plan-bindings/v1",
    sourceRoot: deriver.sourceRoot,
    specificationPath: deriver.specification,
  };
  for (const [key, path] of Object.entries(value)) {
    if (key === "schema") continue;
    if (key === "sourceRoot" && path === ".") continue;
    portablePath(path, `Deutschland-Jahresrelease.operationalBindings.${key}`);
  }
  invariant(value.sourceRoot === ".", "Deutschland-Jahresrelease muss die kanonische Arbeitswurzel als sourceRoot binden.");
  return value;
}

function validateCurrentAnnualPlanBindings(plan, expectedBindings, releaseId) {
  exactObjectKeys(plan, ["releaseId", "schema", "stages"], "Attestierter Annual-Plan");
  invariant(plan.schema === "zugfolge-annual-infra-plan/v1" && plan.releaseId === releaseId
    && Array.isArray(plan.stages), "Attestierter Annual-Plan bindet nicht den aktuellen Jahresrelease.");
  const stages = plan.stages.filter((stage) => stage?.id === "operational-v2-derivation");
  invariant(stages.length === 1, "Attestierter Annual-Plan besitzt keine eindeutige Operational-v2-Ableitungsphase.");
  exactObjectKeys(stages[0].operationalBindings, Object.keys(expectedBindings),
    "Attestierter Annual-Plan.operationalBindings");
  invariant(sameCanonicalValue(stages[0].operationalBindings, expectedBindings),
    "Attestierter Annual-Plan driftet von den Operational-v2-I/O-Bindungen der Release-Konfiguration.");
  return stages[0].operationalBindings;
}

async function validateCurrentAnnualOuterBindings({
  root,
  inputs,
  releaseConfig,
  rebuildSpec,
  outerExecution,
  releaseId,
}) {
  invariant(isRecord(outerExecution?.receipt) && isRecord(outerExecution?.proof),
    "Build-Evidence-v3 muss den vollstaendig verifizierten Outer-Execution-Beleg des Publication-Verifiers konsumieren.");
  const outer = outerExecution.receipt;
  const outerInput = currentAnnualInput(inputs, "operational-outer-execution-receipt", "Operational-v2-Outer-Execution-Receipt");
  const outerProof = inputFileProof(outerInput);
  invariant(sameCanonicalValue(outerExecution.proof, outerProof),
    "Publication-Verifier.outerExecution driftet von der typisierten Outer-Execution-Eingabe.");
  const outerCompletionInput = currentAnnualInput(inputs, "operational-outer-execution-receipt-completion",
    "Operational-v2-Outer-Execution-Completion");
  const outerCompletionProof = await validateAnnualCompletionInput(root, outerCompletionInput, outerProof,
    "Operational-v2-Outer-Execution-Completion");

  const planInput = currentAnnualInput(inputs, "operational-annual-plan", "Operational-v2-Annual-Plan");
  const planProof = inputFileProof(planInput);
  const planCompletionInput = currentAnnualInput(inputs, "operational-annual-plan-completion",
    "Operational-v2-Annual-Plan-Completion");
  const planCompletionProof = await validateAnnualCompletionInput(root, planCompletionInput, planProof,
    "Operational-v2-Annual-Plan-Completion");
  const startInput = currentAnnualInput(inputs, "operational-annual-executor-start-evidence",
    "Operational-v2-Annual-Executor-Startbeleg");
  const startProof = inputFileProof(startInput);
  const startCompletionInput = currentAnnualInput(inputs, "operational-annual-executor-start-evidence-completion",
    "Operational-v2-Annual-Executor-Startbeleg-Completion");
  const startCompletionProof = await validateAnnualCompletionInput(root, startCompletionInput, startProof,
    "Operational-v2-Annual-Executor-Startbeleg-Completion");

  invariant(sameCanonicalValue(outer.attestedPlan, planProof)
    && sameCanonicalValue(outer.attestedPlanStartEvidence, startProof)
    && sameCanonicalValue(outer.inputs?.[4], planProof)
    && sameCanonicalValue(outer.inputs?.[5], startProof),
  "Outer-Execution-Receipt bindet Annual-Plan oder Executor-Startbeleg nicht bytegenau.");
  invariant(planInput.file === rebuildSpec?.authority?.annualExecutorPlan?.planFile
    && startInput.file === rebuildSpec?.authority?.annualExecutorPlan?.startEvidenceFile,
  "Validator-Rebuild-Spezifikation bindet andere Phase-1-Plan-/Startbelegpfade.");

  const plan = await readCanonicalJsonInput(root, planInput, "Operational-v2-Annual-Plan");
  const expectedBindings = expectedCurrentAnnualOperationalBindings(releaseConfig);
  const operationalBindings = validateCurrentAnnualPlanBindings(plan, expectedBindings, releaseId);
  const contextProof = outer.inputs?.[3];
  materializedFileProof(contextProof, "Outer-Execution-Receipt.inputs[3]");
  const context = await readCanonicalJsonInput(root, contextProof, "Operational-v2-Annual-Launch-Kontext");
  exactObjectKeys(context, [
    "candidatePath", "candidateSidecarPath", "executionPinsPath", "nativeReceiptPath", "reportPath",
    "runtimePath", "schema", "sourceRoot", "specificationPath",
  ], "Operational-v2-Annual-Launch-Kontext");
  invariant(context.schema === "zugfolge-operational-v2-direct-system-launch-context/v1"
    && sameCanonicalValue({
      candidatePath: context.candidatePath,
      candidateSidecarPath: context.candidateSidecarPath,
      executionPinsPath: context.executionPinsPath,
      nativeReceiptPath: context.nativeReceiptPath,
      reportPath: context.reportPath,
      sourceRoot: context.sourceRoot,
      specificationPath: context.specificationPath,
    }, {
      candidatePath: operationalBindings.candidatePath,
      candidateSidecarPath: operationalBindings.candidateSidecarPath,
      executionPinsPath: operationalBindings.executionPinsPath,
      nativeReceiptPath: operationalBindings.nativeReceiptPath,
      reportPath: operationalBindings.reportPath,
      sourceRoot: operationalBindings.sourceRoot,
      specificationPath: operationalBindings.specificationPath,
    }), "Annual-Launch-Kontext driftet von den attestierten Operational-v2-I/O-Bindungen.");
  const releaseConfigInput = inputs.find(({ id }) => id === "germany-release-spec");
  const sourceCatalogInput = inputs.find(({ id }) => id === "germany-source-catalog");
  const rightsInput = inputs.find(({ id }) => id === "rights-registry");
  invariant(sameCanonicalValue(outer.inputs?.[0], inputFileProof(releaseConfigInput))
    && sameCanonicalValue(outer.inputs?.[1], inputFileProof(sourceCatalogInput))
    && sameCanonicalValue(outer.inputs?.[2], inputFileProof(rightsInput)),
  "Outer-Execution-Receipt bindet andere Release-Konfiguration, Quellen oder Rechte als Build-Evidence.");
  invariant(outer.executionPins?.file === operationalBindings.executionPinsPath
    && outer.outputs?.candidate?.file === operationalBindings.candidatePath
    && outer.outputs?.movementRouteTemplates?.file === operationalBindings.candidateSidecarPath
    && outer.outputs?.report?.file === operationalBindings.reportPath
    && outer.outputs?.nativeReceipt?.file === operationalBindings.nativeReceiptPath
    && outerInput.file === operationalBindings.outerExecutionReceiptPath,
  "Outer-Execution-Receipt driftet von den attestierten Operational-v2-I/O-Ausgabepfaden.");
  return {
    operationalBindings: structuredClone(operationalBindings),
    outer: outerProof,
    outerCompletion: outerCompletionProof,
    plan: planProof,
    planCompletion: planCompletionProof,
    startEvidence: startProof,
    startEvidenceCompletion: startCompletionProof,
  };
}

function validateGhVerificationResult(result, {
  predicateType,
  subject,
  expectedSubjectName,
  expectedPredicate,
  label,
}) {
  invariant(Array.isArray(result) && result.length > 0, `${label} lieferte kein GitHub-Attestierungsresultat.`);
  const matches = result.filter((entry) => {
    const statement = entry?.verificationResult?.statement;
    if (statement?.predicateType !== predicateType) return false;
    if (!Array.isArray(statement.subject) || statement.subject.length !== 1) return false;
    const [attestedSubject] = statement.subject;
    if (!sameCanonicalValue(attestedSubject, {
      digest: { sha256: subject.sha256 },
      name: expectedSubjectName,
    })) return false;
    return expectedPredicate === undefined || sameCanonicalValue(statement.predicate, expectedPredicate);
  });
  invariant(matches.length > 0,
    `${label} bindet weder das exakte einzelne Subject ${expectedSubjectName} noch das erwartete Predicate.`);
  return matches.map(({ verificationResult }) => verificationResult.statement);
}

function sameHeldFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

async function assertHeldFilePath(path, heldMetadata, label) {
  const metadata = await lstat(path, { bigint: true });
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && sameHeldFileIdentity(metadata, heldMetadata),
    `${label} wurde nach dem Oeffnen durch einen anderen Dateiverweis ersetzt.`);
}

async function readHeldPinnedBytes(handle, expectedProof, label) {
  const before = await handle.stat({ bigint: true });
  invariant(before.isFile() && before.size === BigInt(expectedProof.bytes),
    `${label} besitzt nicht die gepinnte Bytezahl.`);
  const bytes = Buffer.allocUnsafe(expectedProof.bytes);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    invariant(result.bytesRead > 0, `${label} endete vor der gepinnten Bytezahl.`);
    offset += result.bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  const trailing = await handle.read(overflow, 0, 1, bytes.length);
  invariant(trailing.bytesRead === 0, `${label} besitzt Bytes hinter der gepinnten Bytezahl.`);
  const after = await handle.stat({ bigint: true });
  invariant(sameHeldFileIdentity(before, after), `${label} driftete waehrend des gehaltenen Lesens.`);
  invariant(sha256Bytes(bytes) === expectedProof.sha256, `${label} weicht vom gepinnten SHA-256 ab.`);
  return { bytes, metadata: after };
}

function runBoundedProcess({
  executable,
  argumentsList,
  environment,
  cwd,
  spawnProcess,
  maximumOutputBytes,
  timeoutMilliseconds,
  label,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnProcess(executable, argumentsList, {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timeout;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      callback();
    };
    const append = (chunks, chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        child.kill();
        finish(() => rejectPromise(new Error(`${label} ueberschritt das Ausgabelimit.`)));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.on("error", (error) => finish(() => rejectPromise(
      new Error(`${label} konnte nicht gestartet werden.`, { cause: error }),
    )));
    child.on("close", (code, signal) => finish(() => {
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0 || signal !== null) {
        rejectPromise(new Error(`${label} scheiterte (code=${code}, signal=${signal ?? "none"}): ${stderrText}`));
        return;
      }
      try { resolvePromise(JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
      catch (error) { rejectPromise(new Error(`${label} lieferte kein gueltiges JSON.`, { cause: error })); }
    }));
    timeout = setTimeout(() => {
      child.kill();
      finish(() => rejectPromise(new Error(`${label} ueberschritt das Zeitlimit.`)));
    }, timeoutMilliseconds);
    timeout.unref?.();
  });
}

function canonicalBase64Bytes(value, label) {
  invariant(typeof value === "string"
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value),
  `${label} ist kein kanonisches Base64.`);
  const bytes = Buffer.from(value, "base64");
  invariant(bytes.toString("base64") === value, `${label} ist kein kanonisches Base64.`);
  return bytes;
}

async function runWindowsHeldGithubCli({
  executable,
  executableProof,
  argumentsList,
  inputFiles,
  environment,
  cwd,
  spawnProcess = spawn,
}) {
  invariant(process.platform === "win32",
    "GitHub-Attestierungsverifikation besitzt nur fuer Windows einen bytekausalen gh.exe-Launcher.");
  invariant(isAbsolute(executable) && isAbsolute(cwd),
    "Gehaltene GitHub-CLI-Ausfuehrung benoetigt absolute Pfade.");
  materializedFileProof(executableProof, "Gehaltene GitHub-CLI-Ausfuehrung.executableProof");
  invariant(Array.isArray(inputFiles) && inputFiles.length > 0 && inputFiles.length <= 8,
    "Gehaltene GitHub-CLI-Ausfuehrung besitzt keine begrenzte Inputmenge.");
  const expectedInputs = inputFiles.map((input, index) => {
    invariant(isAbsolute(input.path), `Gehaltene GitHub-CLI-Ausfuehrung.inputs[${index}] ist nicht absolut.`);
    const proof = materializedFileProof(
      { bytes: input.bytes, file: input.file, sha256: input.sha256 },
      `Gehaltene GitHub-CLI-Ausfuehrung.inputs[${index}]`,
    );
    return { bytes: proof.bytes, file: proof.file, sha256: proof.sha256 };
  });
  const helperProof = await absoluteFileProof(WINDOWS_ATTESTATION_ANCHOR_HELPER.path,
    "GitHub-Attestierungs-Windows-Anchor-Helper");
  invariant(helperProof.bytes === WINDOWS_ATTESTATION_ANCHOR_HELPER.bytes
    && helperProof.sha256 === WINDOWS_ATTESTATION_ANCHOR_HELPER.sha256,
  "GitHub-Attestierungs-Windows-Anchor-Helper driftet vom festen Byte-Pin.");
  const launcherPath = await realpath(WINDOWS_TRUSTED_POWERSHELL);
  invariant(launcherPath.toLowerCase() === WINDOWS_TRUSTED_POWERSHELL.toLowerCase(),
    "GitHub-Attestierungslauncher liegt nicht am festen System32-PowerShell-Pfad.");
  const launcherBefore = await absoluteFileProof(launcherPath, "GitHub-Attestierungs-System32-PowerShell");
  const request = {
    arguments: argumentsList,
    cwd,
    environment,
    executable: { path: executable, ...executableProof },
    helper: { path: WINDOWS_ATTESTATION_ANCHOR_HELPER.path, ...helperProof },
    inputs: inputFiles.map(({ path, bytes, file, sha256 }) => ({ path, bytes, file, sha256 })),
    maximumBytes: GH_ATTESTATION_MAX_OUTPUT_BYTES,
    timeoutMilliseconds: GH_ATTESTATION_TIMEOUT_MILLISECONDS,
  };
  const encodedCommand = Buffer.from(WINDOWS_HELD_GITHUB_CLI_LAUNCHER, "utf16le").toString("base64");
  const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const envelope = await runBoundedProcess({
    executable: launcherPath,
    argumentsList: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", encodedCommand,
    ],
    cwd: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32`,
    environment: {
      SystemRoot: WINDOWS_TRUSTED_SYSTEM_ROOT,
      WINDIR: WINDOWS_TRUSTED_SYSTEM_ROOT,
      ComSpec: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32\\cmd.exe`,
      PATH: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32;${WINDOWS_TRUSTED_SYSTEM_ROOT}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: dirname(executable),
      TMP: dirname(executable),
      ZUGFOLGE_GH_ANCHOR_REQUEST_BASE64: encodedRequest,
    },
    spawnProcess,
    maximumOutputBytes: GH_ATTESTATION_LAUNCHER_MAX_OUTPUT_BYTES,
    timeoutMilliseconds: GH_ATTESTATION_TIMEOUT_MILLISECONDS + 10_000,
    label: "Gehaltene GitHub-Attestierungslauncher-Ausfuehrung",
  });
  const launcherAfter = await absoluteFileProof(launcherPath,
    "GitHub-Attestierungs-System32-PowerShell-Nachpruefung");
  invariant(sameCanonicalValue(launcherBefore, launcherAfter),
    "GitHub-Attestierungs-System32-PowerShell driftete waehrend der Ausfuehrung.");
  exactObjectKeys(envelope,
    ["anchorBytes", "anchorSha256", "inputProofs", "signal", "status", "stderrBase64", "stdoutBase64"],
    "Gehaltene GitHub-CLI-Ausfuehrung.envelope");
  invariant(envelope.anchorBytes === executableProof.bytes && envelope.anchorSha256 === executableProof.sha256,
    "GitHub-CLI-Launcher startete nicht die gehaltenen Verifierbytes.");
  invariant(sameCanonicalValue(envelope.inputProofs, expectedInputs),
    "GitHub-CLI-Launcher hielt nicht exakt die erwarteten Subject-/Bundle-/Trust-Root-Bytes.");
  invariant(Number.isInteger(envelope.status) && envelope.signal === null,
    "GitHub-CLI-Launcher lieferte keinen eindeutigen Prozessabschluss.");
  const stdout = canonicalBase64Bytes(envelope.stdoutBase64, "GitHub-CLI-stdout");
  const stderr = canonicalBase64Bytes(envelope.stderrBase64, "GitHub-CLI-stderr");
  invariant(envelope.status === 0,
    `GitHub-Attestierungsverifikation scheiterte mit Exit ${envelope.status}: ${stderr.toString("utf8").slice(0, 2048)}`);
  try { return JSON.parse(stdout.toString("utf8")); }
  catch (error) {
    throw new Error("GitHub-Attestierungsverifikation lieferte kein gueltiges JSON.", { cause: error });
  }
}

async function writePrivatePinnedCopy(path, sourceBytes, expectedProof, label, mode) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(sourceBytes);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    invariant(metadata.isFile() && metadata.size === BigInt(expectedProof.bytes),
      `${label} besitzt nicht die gepinnte Bytezahl.`);
    await assertHeldFilePath(path, metadata, label);
  } finally {
    await handle.close();
  }
  const proof = await absoluteFileProof(path, label);
  invariant(proof.bytes === expectedProof.bytes && proof.sha256 === expectedProof.sha256,
    `${label} driftet von der gehaltenen Quelle.`);
}

export async function verifyGithubAttestationSubject({
  subjectPath,
  subjectProof,
  bundlePath,
  bundleProof,
  verifierPath,
  verifierProof,
  trustedRootPath,
  trustedRootProof,
  repository,
  signerWorkflow,
  sourceRef,
  sourceDigest,
  predicateType,
  denySelfHostedRunners,
  heldProcessRunner = runWindowsHeldGithubCli,
}) {
  invariant(denySelfHostedRunners === true,
    "GitHub-Attestierungsverifikation muss Self-hosted Runner explizit verweigern.");
  invariant(isAbsolute(subjectPath) && isAbsolute(bundlePath)
    && isAbsolute(verifierPath) && isAbsolute(trustedRootPath),
    "GitHub-Attestierungsverifikation benoetigt ausschliesslich absolute gehaltene Dateipfade.");
  materializedFileProof(verifierProof, "GitHub-Attestierungsverifier");
  materializedFileProof(trustedRootProof, "GitHub-Attestierungs-Trust-Root");
  materializedFileProof(subjectProof, "GitHub-Attestierungs-Subject");
  materializedFileProof(bundleProof, "GitHub-Attestierungsbundle");
  invariant(trustedRootProof.bytes <= GH_ATTESTATION_MAX_TRUSTED_ROOT_BYTES,
    "GitHub-Attestierungs-Trust-Root ueberschreitet das gehaltene Bytelimit.");
  invariant(typeof heldProcessRunner === "function", "GitHub-Attestierungsverifikation besitzt keinen gehaltenen Prozessstarter.");
  let sourceHandle;
  let trustedRootHandle;
  let privateDirectory;
  try {
    const sourceMetadata = await lstat(verifierPath, { bigint: true });
    const trustedRootMetadata = await lstat(trustedRootPath, { bigint: true });
    invariant(sourceMetadata.isFile() && !sourceMetadata.isSymbolicLink(),
      "GitHub-Attestierungsverifier ist keine regulaere, direkt referenzierte Datei.");
    invariant(trustedRootMetadata.isFile() && !trustedRootMetadata.isSymbolicLink(),
      "GitHub-Attestierungs-Trust-Root ist keine regulaere, direkt referenzierte Datei.");
    sourceHandle = await open(verifierPath, "r");
    trustedRootHandle = await open(trustedRootPath, "r");
    const source = await readHeldPinnedBytes(sourceHandle, verifierProof, "GitHub-Attestierungsverifier");
    const trustedRoot = await readHeldPinnedBytes(
      trustedRootHandle,
      trustedRootProof,
      "GitHub-Attestierungs-Trust-Root",
    );
    invariant(sameHeldFileIdentity(sourceMetadata, source.metadata),
      "GitHub-Attestierungsverifier wurde vor der gehaltenen Verifikation ersetzt.");
    invariant(sameHeldFileIdentity(trustedRootMetadata, trustedRoot.metadata),
      "GitHub-Attestierungs-Trust-Root wurde vor der gehaltenen Verifikation ersetzt.");
    await assertHeldFilePath(verifierPath, source.metadata, "GitHub-Attestierungsverifier");
    await assertHeldFilePath(trustedRootPath, trustedRoot.metadata, "GitHub-Attestierungs-Trust-Root");
    privateDirectory = await mkdtemp(join(tmpdir(), "zugfolge-gh-attestation-"));
    const isolatedVerifierPath = join(privateDirectory, "gh.exe");
    const isolatedTrustedRootPath = join(privateDirectory, "trusted-root.jsonl");
    const configDirectory = join(privateDirectory, "config");
    await mkdir(configDirectory, { mode: 0o700 });
    await writePrivatePinnedCopy(isolatedVerifierPath, source.bytes, verifierProof, "Private Verifierkopie", 0o500);
    await writePrivatePinnedCopy(isolatedTrustedRootPath, trustedRoot.bytes, trustedRootProof,
      "Private Trust-Root-Kopie", 0o400);
    const argumentsList = [
      "attestation", "verify", resolve(subjectPath),
      "--repo", repository,
      "--bundle", resolve(bundlePath),
      "--custom-trusted-root", isolatedTrustedRootPath,
      "--hostname", "github.com",
      "--predicate-type", predicateType,
      "--signer-workflow", signerWorkflow,
      "--source-ref", sourceRef,
      "--source-digest", sourceDigest,
      "--deny-self-hosted-runners",
      "--format", "json",
    ];
    let result;
    let processError;
    try {
      result = await heldProcessRunner({
        executable: isolatedVerifierPath,
        executableProof: verifierProof,
        argumentsList,
        cwd: privateDirectory,
        environment: {
          SystemRoot: WINDOWS_TRUSTED_SYSTEM_ROOT,
          WINDIR: WINDOWS_TRUSTED_SYSTEM_ROOT,
          ComSpec: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32\\cmd.exe`,
          PATH: `${WINDOWS_TRUSTED_SYSTEM_ROOT}\\System32;${WINDOWS_TRUSTED_SYSTEM_ROOT}`,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          GH_CONFIG_DIR: configDirectory,
          GH_NO_UPDATE_NOTIFIER: "1",
          GH_PROMPT_DISABLED: "1",
          NO_COLOR: "1",
          TEMP: privateDirectory,
          TMP: privateDirectory,
        },
        inputFiles: [
          { path: resolve(subjectPath), ...subjectProof },
          { path: resolve(bundlePath), ...bundleProof },
          { path: isolatedTrustedRootPath, ...trustedRootProof },
        ],
      });
    } catch (error) {
      processError = error;
    }
    const isolatedAfter = await absoluteFileProof(isolatedVerifierPath, "Private Verifierkopie-Nachpruefung");
    invariant(isolatedAfter.bytes === verifierProof.bytes && isolatedAfter.sha256 === verifierProof.sha256,
      "Private Verifierkopie driftete waehrend der Attestierungsverifikation.");
    const isolatedTrustedRootAfter = await absoluteFileProof(isolatedTrustedRootPath,
      "Private Trust-Root-Kopie-Nachpruefung");
    invariant(isolatedTrustedRootAfter.bytes === trustedRootProof.bytes
      && isolatedTrustedRootAfter.sha256 === trustedRootProof.sha256,
    "Private Trust-Root-Kopie driftete waehrend der Attestierungsverifikation.");
    const [subjectAfter, bundleAfter] = await Promise.all([
      absoluteFileProof(subjectPath, "GitHub-Attestierungs-Subject-Nachpruefung"),
      absoluteFileProof(bundlePath, "GitHub-Attestierungsbundle-Nachpruefung"),
    ]);
    invariant(subjectAfter.bytes === subjectProof.bytes && subjectAfter.sha256 === subjectProof.sha256,
      "GitHub-Attestierungs-Subject driftete waehrend der gehaltenen Verifikation.");
    invariant(bundleAfter.bytes === bundleProof.bytes && bundleAfter.sha256 === bundleProof.sha256,
      "GitHub-Attestierungsbundle driftete waehrend der gehaltenen Verifikation.");
    const sourceAfter = await readHeldPinnedBytes(sourceHandle, verifierProof,
      "GitHub-Attestierungsverifier-Nachpruefung");
    invariant(sameHeldFileIdentity(source.metadata, sourceAfter.metadata),
      "GitHub-Attestierungsverifier driftete waehrend der Attestierungsverifikation.");
    await assertHeldFilePath(verifierPath, sourceAfter.metadata, "GitHub-Attestierungsverifier-Nachpruefung");
    const trustedRootAfter = await readHeldPinnedBytes(trustedRootHandle, trustedRootProof,
      "GitHub-Attestierungs-Trust-Root-Nachpruefung");
    invariant(sameHeldFileIdentity(trustedRoot.metadata, trustedRootAfter.metadata),
      "GitHub-Attestierungs-Trust-Root driftete waehrend der Attestierungsverifikation.");
    await assertHeldFilePath(trustedRootPath, trustedRootAfter.metadata,
      "GitHub-Attestierungs-Trust-Root-Nachpruefung");
    if (processError !== undefined) throw processError;
    return result;
  } finally {
    await trustedRootHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
    if (privateDirectory !== undefined) await rm(privateDirectory, { recursive: true, force: true });
  }
}

function operationalAttestationVerifierBinding(input, { requireOfficialPin }) {
  invariant(input?.id === "operational-attestation-verifier"
    && input.kind === "derived-input"
    && input.version === CURRENT_ANNUAL_V3_RELEASE_ID
    && input.file === CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.file,
  "Operational-Attestierungsverifier fehlt als releasegebundene typisierte Eingabe.");
  const proof = inputFileProof(input);
  materializedFileProof(proof, "Operational-Attestierungsverifier");
  if (requireOfficialPin) {
    invariant(proof.bytes === CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.bytes
      && proof.sha256 === CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.sha256,
    "Operational-Attestierungsverifier weicht von GitHub CLI 2.94.0 fuer Windows AMD64 ab.");
  }
  return {
    binding: {
      bytes: input.bytes,
      file: input.file,
      id: input.id,
      kind: input.kind,
      sha256: input.sha256,
      version: input.version,
    },
    proof,
  };
}

function operationalAttestationTrustedRootBinding(input, { requireOfficialPin }) {
  invariant(input?.id === "operational-attestation-trusted-root"
    && input.kind === "derived-input"
    && input.version === CURRENT_ANNUAL_V3_RELEASE_ID
    && input.file === CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.file,
  "Operational-Attestierungs-Trust-Root fehlt als releasegebundene typisierte Eingabe.");
  const proof = inputFileProof(input);
  materializedFileProof(proof, "Operational-Attestierungs-Trust-Root");
  invariant(proof.bytes <= GH_ATTESTATION_MAX_TRUSTED_ROOT_BYTES,
    "Operational-Attestierungs-Trust-Root ueberschreitet das gehaltene Bytelimit.");
  if (requireOfficialPin) {
    invariant(proof.bytes === CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.bytes
      && proof.sha256 === CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.sha256,
    "Operational-Attestierungs-Trust-Root weicht vom gepinnten GitHub-Trust-Root ab.");
  }
  return {
    binding: {
      bytes: input.bytes,
      file: input.file,
      id: input.id,
      kind: input.kind,
      sha256: input.sha256,
      version: input.version,
    },
    proof,
  };
}

async function proveAttestedSubjects({
  root,
  subjectFiles,
  bundleInput,
  verifierInput,
  trustedRootInput,
  predicateType,
  repository,
  signerWorkflow,
  sourceRef,
  sourceDigest,
  subjectNameMode,
  expectedPredicate,
  capturePredicate = false,
  attestationVerifier,
  label,
}) {
  invariant(["basename", "portable-path"].includes(subjectNameMode), `${label} besitzt keinen Subject-Namensvertrag.`);
  const expectedBundleProof = inputFileProof(bundleInput);
  const expectedVerifierProof = inputFileProof(verifierInput);
  const expectedTrustedRootProof = inputFileProof(trustedRootInput);
  const bundlePath = await containedRealPath(root, bundleInput.file, `${label}.bundle`);
  const verifierPath = await containedRealPath(root, verifierInput.file, `${label}.verifier`);
  const trustedRootPath = await containedRealPath(root, trustedRootInput.file, `${label}.trustedRoot`);
  const bundleBefore = { file: bundleInput.file, ...(await fileProof(root, { file: bundleInput.file }, `${label}.bundle`)) };
  invariant(sameCanonicalValue(bundleBefore, expectedBundleProof), `${label}.bundle driftet vor der Verifikation.`);
  const verifierBefore = { file: verifierInput.file, ...(await fileProof(root, { file: verifierInput.file }, `${label}.verifier`)) };
  invariant(sameCanonicalValue(verifierBefore, expectedVerifierProof), `${label}.verifier driftet vor der Verifikation.`);
  const trustedRootBefore = {
    file: trustedRootInput.file,
    ...(await fileProof(root, { file: trustedRootInput.file }, `${label}.trustedRoot`)),
  };
  invariant(sameCanonicalValue(trustedRootBefore, expectedTrustedRootProof),
    `${label}.trustedRoot driftet vor der Verifikation.`);
  const subjects = [];
  let verifiedPredicate;
  for (const [index, file] of subjectFiles.entries()) {
    const normalized = portablePath(file, `${label}.subjects[${index}]`);
    const proof = { file: normalized, ...(await fileProof(root, { file: normalized }, `${label}.subjects[${index}]`)) };
    const subjectPath = await containedRealPath(root, normalized, `${label}.subjects[${index}]`);
    const expectedSubjectName = subjectNameMode === "basename" ? basename(normalized) : normalized;
    const result = await attestationVerifier({
      subjectPath,
      subjectProof: proof,
      bundlePath,
      bundleProof: expectedBundleProof,
      verifierPath,
      verifierProof: expectedVerifierProof,
      trustedRootPath,
      trustedRootProof: expectedTrustedRootProof,
      repository,
      signerWorkflow,
      sourceRef,
      sourceDigest,
      predicateType,
      denySelfHostedRunners: true,
      expectedSubjectName,
    });
    const statements = validateGhVerificationResult(result, {
      predicateType,
      subject: proof,
      expectedSubjectName,
      expectedPredicate,
      label,
    });
    if (capturePredicate) {
      const predicates = statements.map(({ predicate }) => predicate);
      invariant(predicates.every((predicate) => sameCanonicalValue(predicate, predicates[0])),
        `${label} lieferte mehrdeutige verifizierte Predicates.`);
      if (verifiedPredicate === undefined) verifiedPredicate = structuredClone(predicates[0]);
      else invariant(sameCanonicalValue(verifiedPredicate, predicates[0]),
        `${label} bindet seine Subjects an verschiedene Predicates.`);
    }
    const [subjectAfter, bundleAfter, verifierAfter, trustedRootAfter] = await Promise.all([
      fileProof(root, { file: normalized }, `${label}.subjects[${index}]-Nachpruefung`),
      fileProof(root, { file: bundleInput.file }, `${label}.bundle-Nachpruefung`),
      fileProof(root, { file: verifierInput.file }, `${label}.verifier-Nachpruefung`),
      fileProof(root, { file: trustedRootInput.file }, `${label}.trustedRoot-Nachpruefung`),
    ]);
    invariant(subjectAfter.bytes === proof.bytes && subjectAfter.sha256 === proof.sha256,
      `${label}.subjects[${index}] driftete waehrend der Attestierungsverifikation.`);
    invariant(bundleAfter.bytes === expectedBundleProof.bytes && bundleAfter.sha256 === expectedBundleProof.sha256,
      `${label}.bundle driftete waehrend der Attestierungsverifikation.`);
    invariant(verifierAfter.bytes === expectedVerifierProof.bytes && verifierAfter.sha256 === expectedVerifierProof.sha256,
      `${label}.verifier driftete waehrend der Attestierungsverifikation.`);
    invariant(trustedRootAfter.bytes === expectedTrustedRootProof.bytes
      && trustedRootAfter.sha256 === expectedTrustedRootProof.sha256,
    `${label}.trustedRoot driftete waehrend der Attestierungsverifikation.`);
    subjects.push(proof);
  }
  invariant(new Set(subjects.map(({ file }) => file)).size === subjects.length,
    `${label} besitzt doppelte Subject-Pfade.`);
  return {
    subjects: subjects.sort((left, right) => left.file.localeCompare(right.file, "en")),
    ...(capturePredicate ? { predicate: verifiedPredicate } : {}),
  };
}

function authorityBlock({ bundle, predicateType, repository, signerWorkflow, sourceRef, sourceDigest, subjects }) {
  return {
    bundle,
    denySelfHostedRunners: true,
    predicateType,
    repository,
    signerWorkflow,
    sourceDigest,
    sourceRef,
    subjects,
  };
}

function validateExecutionAuthorityPredicate(value, { releaseId, mapBuildCommit, causal, rebuildBundle }) {
  exactObjectKeys(value, [
    "executionJob", "origin", "outerExecutionCompletion", "outerExecutionReceipt", "planAuthority",
    "protectedEnvironment", "releaseId", "requiredPhases", "schema", "source", "verificationScope",
  ], "Operational-v2-Execution-Authority-Predicate");
  invariant(value.schema === CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_SCHEMA
    && value.releaseId === releaseId
    && value.origin === "local-held-runner"
    && value.verificationScope === "operator-approved-hash-binding-not-source-reexecution-v1"
    && value.protectedEnvironment === "operational-release-approval",
  "Operational-v2-Execution-Authority-Predicate besitzt keinen exakten geschuetzten Authority-Kontext.");
  exactObjectKeys(value.source, ["commit", "ref", "repository"],
    "Operational-v2-Execution-Authority-Predicate.source");
  invariant(value.source.repository === "larynxberlin-rgb/Zugfolge"
    && value.source.commit === mapBuildCommit
    && value.source.ref === "refs/heads/main",
  "Operational-v2-Execution-Authority-Predicate bindet nicht denselben geschuetzten main-Commit.");
  invariant(sameCanonicalValue(value.requiredPhases, [
    "materialize-annual-plan-evidence-v1",
    "execute-annual-operational-v2-v1",
    "derive-and-capture-v1",
  ]), "Operational-v2-Execution-Authority-Predicate bindet nicht die drei erforderlichen Phasen.");
  exactObjectKeys(value.executionJob, ["mode", "timeoutMilliseconds"],
    "Operational-v2-Execution-Authority-Predicate.executionJob");
  invariant(value.executionJob.mode === "windows-kill-on-job-close-root-exit-bounded-io-v1"
    && value.executionJob.timeoutMilliseconds === 21_600_000,
  "Operational-v2-Execution-Authority-Predicate besitzt nicht den exakten sechsstuendigen Prozessbaumvertrag.");
  exactObjectKeys(value.planAuthority, [
    "artifact", "bundle", "plan", "planCompletion", "startEvidence", "startEvidenceCompletion",
  ], "Operational-v2-Execution-Authority-Predicate.planAuthority");
  exactObjectKeys(value.planAuthority.artifact, ["digest", "id", "workflowRunId"],
    "Operational-v2-Execution-Authority-Predicate.planAuthority.artifact");
  invariant(Number.isSafeInteger(value.planAuthority.artifact.id) && value.planAuthority.artifact.id > 0
    && Number.isSafeInteger(value.planAuthority.artifact.workflowRunId) && value.planAuthority.artifact.workflowRunId > 0
    && /^sha256:[a-f0-9]{64}$/u.test(value.planAuthority.artifact.digest),
  "Operational-v2-Execution-Authority-Predicate.planAuthority.artifact besitzt keine eindeutigen GitHub-Artefaktmetadaten.");
  for (const [key, expected] of [
    ["bundle", rebuildBundle],
    ["plan", causal.plan],
    ["planCompletion", causal.planCompletion],
    ["startEvidence", causal.startEvidence],
    ["startEvidenceCompletion", causal.startEvidenceCompletion],
    ["outerExecutionReceipt", causal.outer],
    ["outerExecutionCompletion", causal.outerCompletion],
  ]) {
    const actual = ["outerExecutionReceipt", "outerExecutionCompletion"].includes(key)
      ? value[key]
      : value.planAuthority[key];
    materializedFileProof(actual, `Operational-v2-Execution-Authority-Predicate.${key}`);
    invariant(sameCanonicalValue(actual, expected),
      `Operational-v2-Execution-Authority-Predicate.${key} driftet vom lokalen Kausalbeleg.`);
  }
  return value;
}

export async function materializeCurrentAnnualOperationalAuthority({
  artifactRoot,
  inputs,
  releaseConfig,
  rebuildSpec,
  outerExecution,
  releaseId,
  mapBuildCommit,
  attestationVerifier = verifyGithubAttestationSubject,
}) {
  invariant(releaseId === CURRENT_ANNUAL_V3_RELEASE_ID, "Operational-Authority ist ausschliesslich fuer den aktuellen .5-Jahresrelease definiert.");
  validateCommit(mapBuildCommit, "Operational-Authority.sourceDigest");
  invariant(typeof attestationVerifier === "function", "Operational-Authority benoetigt einen Attestierungsverifier.");
  const root = resolve(artifactRoot);
  const verifierInput = currentAnnualInput(inputs, "operational-attestation-verifier",
    "Operational-Attestierungsverifier");
  const verifier = operationalAttestationVerifierBinding(verifierInput, {
    requireOfficialPin: attestationVerifier === verifyGithubAttestationSubject,
  });
  const trustedRootInput = currentAnnualInput(inputs, "operational-attestation-trusted-root",
    "Operational-Attestierungs-Trust-Root");
  const trustedRoot = operationalAttestationTrustedRootBinding(trustedRootInput, {
    requireOfficialPin: attestationVerifier === verifyGithubAttestationSubject,
  });
  const causal = await validateCurrentAnnualOuterBindings({ root, inputs, releaseConfig, rebuildSpec, outerExecution, releaseId });
  const repository = rebuildSpec?.authority?.repository;
  const sourceRef = rebuildSpec?.authority?.requiredRef;
  invariant(repository === "larynxberlin-rgb/Zugfolge" && sourceRef === "refs/heads/main",
    "Validator-Rebuild-Spezifikation bindet nicht protected main des kanonischen Repositorys.");
  const rebuildAttestation = rebuildSpec?.authority?.attestation;
  invariant(rebuildAttestation?.predicateType === CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_PREDICATE
    && rebuildAttestation.verification?.command === "gh attestation verify"
    && rebuildAttestation.verification.denySelfHostedRunners === true
    && rebuildAttestation.verification.signerWorkflow === CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_WORKFLOW,
  "Validator-Rebuild-Spezifikation besitzt keine exakte GitHub-Sigstore-Authority.");
  const rebuildBundleInput = currentAnnualInput(inputs, "operational-validator-rebuild-attestation",
    "Operational-Validator-Rebuild-Attestation");
  invariant(rebuildBundleInput.file === rebuildAttestation.bundleFile,
    "Operational-Validator-Rebuild-Attestation driftet von der Rebuild-Spezifikation.");
  const rebuildVerification = await proveAttestedSubjects({
    root,
    subjectFiles: rebuildAttestation.subjects,
    bundleInput: rebuildBundleInput,
    verifierInput,
    trustedRootInput,
    predicateType: rebuildAttestation.predicateType,
    repository,
    signerWorkflow: rebuildAttestation.verification.signerWorkflow,
    sourceRef,
    sourceDigest: mapBuildCommit,
    subjectNameMode: "basename",
    attestationVerifier,
    label: "Operational-Validator-Rebuild-Attestation",
  });
  for (const required of [causal.plan, causal.planCompletion, causal.startEvidence, causal.startEvidenceCompletion]) {
    invariant(rebuildVerification.subjects.some((subject) => sameCanonicalValue(subject, required)),
      `Operational-Validator-Rebuild-Attestation bindet Phase-1-Subject ${required.file} nicht bytegenau.`);
  }

  const executionBundleInput = currentAnnualInput(inputs, "operational-execution-authority-attestation",
    "Operational-v2-Execution-Authority-Attestation");
  invariant(executionBundleInput.file === CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_BUNDLE,
    "Operational-v2-Execution-Authority-Attestation besitzt nicht den kanonischen Bundlepfad.");
  const executionVerification = await proveAttestedSubjects({
    root,
    subjectFiles: [causal.outer.file, causal.outerCompletion.file],
    bundleInput: executionBundleInput,
    verifierInput,
    trustedRootInput,
    predicateType: CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_PREDICATE,
    repository,
    signerWorkflow: CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_WORKFLOW,
    sourceRef,
    sourceDigest: mapBuildCommit,
    subjectNameMode: "portable-path",
    capturePredicate: true,
    attestationVerifier,
    label: "Operational-v2-Execution-Authority-Attestation",
  });
  const predicate = validateExecutionAuthorityPredicate(executionVerification.predicate, {
    releaseId,
    mapBuildCommit,
    causal,
    rebuildBundle: inputFileProof(rebuildBundleInput),
  });
  return {
    execution: {
      ...authorityBlock({
        bundle: inputFileProof(executionBundleInput),
        predicateType: CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_PREDICATE,
        repository,
        signerWorkflow: CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_WORKFLOW,
        sourceRef,
        sourceDigest: mapBuildCommit,
        subjects: executionVerification.subjects,
      }),
      predicate,
      predicateSha256: canonicalValueSha256(predicate),
    },
    rebuild: authorityBlock({
      bundle: inputFileProof(rebuildBundleInput),
      predicateType: CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_PREDICATE,
      repository,
      signerWorkflow: CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_WORKFLOW,
      sourceRef,
      sourceDigest: mapBuildCommit,
      subjects: rebuildVerification.subjects,
    }),
    schema: CURRENT_ANNUAL_V3_OPERATIONAL_AUTHORITY_SCHEMA,
    trustedRoot: trustedRoot.binding,
    verifier: verifier.binding,
  };
}

function validateAuthorityBlock(value, expected, label) {
  exactObjectKeys(value, [
    "bundle", "denySelfHostedRunners", "predicateType", "repository", "signerWorkflow",
    "sourceDigest", "sourceRef", "subjects",
  ], label);
  materializedFileProof(value.bundle, `${label}.bundle`);
  invariant(value.denySelfHostedRunners === true
    && value.predicateType === expected.predicateType
    && value.repository === "larynxberlin-rgb/Zugfolge"
    && value.signerWorkflow === expected.signerWorkflow
    && value.sourceDigest === expected.sourceDigest
    && value.sourceRef === "refs/heads/main", `${label} driftet von der geschuetzten GitHub-Sigstore-Authority.`);
  invariant(Array.isArray(value.subjects) && value.subjects.length > 0, `${label} besitzt keine Subjects.`);
  for (const [index, subject] of value.subjects.entries()) materializedFileProof(subject, `${label}.subjects[${index}]`);
  invariant(new Set(value.subjects.map(({ file }) => file)).size === value.subjects.length
    && JSON.stringify(value.subjects.map(({ file }) => file))
      === JSON.stringify(value.subjects.map(({ file }) => file).sort((left, right) => left.localeCompare(right, "en"))),
  `${label}.subjects sind nicht eindeutig und kanonisch sortiert.`);
  return value;
}

export function validateCurrentAnnualOperationalAuthority(authority, inputs, mapBuildCommit) {
  exactObjectKeys(authority, ["execution", "rebuild", "schema", "trustedRoot", "verifier"],
    "Operational-v2-Build-Authority");
  invariant(authority.schema === CURRENT_ANNUAL_V3_OPERATIONAL_AUTHORITY_SCHEMA,
    "Operational-v2-Build-Authority besitzt ein unbekanntes Schema.");
  validateCommit(mapBuildCommit, "Operational-v2-Build-Authority.sourceDigest");
  const rebuild = validateAuthorityBlock(authority.rebuild, {
    predicateType: CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_PREDICATE,
    signerWorkflow: CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_WORKFLOW,
    sourceDigest: mapBuildCommit,
  }, "Operational-v2-Build-Authority.rebuild");
  exactObjectKeys(authority.execution, [
    "bundle", "denySelfHostedRunners", "predicate", "predicateSha256", "predicateType", "repository",
    "signerWorkflow", "sourceDigest", "sourceRef", "subjects",
  ], "Operational-v2-Build-Authority.execution");
  const execution = validateAuthorityBlock(Object.fromEntries(Object.entries(authority.execution)
    .filter(([key]) => !["predicate", "predicateSha256"].includes(key))), {
    predicateType: CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_PREDICATE,
    signerWorkflow: CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_WORKFLOW,
    sourceDigest: mapBuildCommit,
  }, "Operational-v2-Build-Authority.execution");
  const rebuildBundle = currentAnnualInput(inputs, "operational-validator-rebuild-attestation");
  const executionBundle = currentAnnualInput(inputs, "operational-execution-authority-attestation");
  const verifier = operationalAttestationVerifierBinding(
    currentAnnualInput(inputs, "operational-attestation-verifier"),
    { requireOfficialPin: false },
  );
  const trustedRoot = operationalAttestationTrustedRootBinding(
    currentAnnualInput(inputs, "operational-attestation-trusted-root"),
    { requireOfficialPin: false },
  );
  exactObjectKeys(authority.verifier, ["bytes", "file", "id", "kind", "sha256", "version"],
    "Operational-v2-Build-Authority.verifier");
  exactObjectKeys(authority.trustedRoot, ["bytes", "file", "id", "kind", "sha256", "version"],
    "Operational-v2-Build-Authority.trustedRoot");
  invariant(sameCanonicalValue(rebuild.bundle, inputFileProof(rebuildBundle))
    && sameCanonicalValue(execution.bundle, inputFileProof(executionBundle))
    && sameCanonicalValue(authority.verifier, verifier.binding)
    && sameCanonicalValue(authority.trustedRoot, trustedRoot.binding),
  "Operational-v2-Build-Authority bindet andere Attestierungsbundles, Verifierbytes oder Trust-Root-Bytes als Build-Evidence.");
  const predicate = authority.execution.predicate;
  const causal = {
    plan: inputFileProof(currentAnnualInput(inputs, "operational-annual-plan")),
    planCompletion: inputFileProof(currentAnnualInput(inputs, "operational-annual-plan-completion")),
    startEvidence: inputFileProof(currentAnnualInput(inputs, "operational-annual-executor-start-evidence")),
    startEvidenceCompletion: inputFileProof(currentAnnualInput(inputs, "operational-annual-executor-start-evidence-completion")),
    outer: inputFileProof(currentAnnualInput(inputs, "operational-outer-execution-receipt")),
    outerCompletion: inputFileProof(currentAnnualInput(inputs, "operational-outer-execution-receipt-completion")),
  };
  validateExecutionAuthorityPredicate(predicate, {
    releaseId: CURRENT_ANNUAL_V3_RELEASE_ID,
    mapBuildCommit,
    causal,
    rebuildBundle: inputFileProof(rebuildBundle),
  });
  invariant(authority.execution.predicateSha256 === canonicalValueSha256(predicate),
  "Operational-v2-Execution-Authority besitzt keine gueltige kanonische Predicate-Bindung.");
  invariant(sameCanonicalValue(execution.subjects, [predicate.outerExecutionReceipt, predicate.outerExecutionCompletion]
    .sort((left, right) => left.file.localeCompare(right.file, "en"))),
  "Operational-v2-Execution-Authority besitzt nicht exakt Outer-Receipt und Completion als Subjects.");
  for (const proof of [predicate.planAuthority.plan, predicate.planAuthority.planCompletion,
    predicate.planAuthority.startEvidence, predicate.planAuthority.startEvidenceCompletion]) {
    invariant(rebuild.subjects.some((subject) => sameCanonicalValue(subject, proof)),
      `Operational-v2-Rebuild-Authority bindet Phase-1-Subject ${proof.file} nicht.`);
  }
  return authority;
}

async function localSubjectProofs(root, files, label) {
  const proofs = [];
  for (const [index, file] of files.entries()) {
    const normalized = portablePath(file, `${label}[${index}]`);
    proofs.push({ file: normalized, ...(await fileProof(root, { file: normalized }, `${label}[${index}]`)) });
  }
  return proofs.sort((left, right) => left.file.localeCompare(right.file, "en"));
}

export async function verifyCurrentAnnualOperationalAuthorityLocal({
  artifactRoot,
  inputs,
  releaseConfig,
  rebuildSpec,
  outerExecution,
  releaseId,
  mapBuildCommit,
  authority,
  attestationVerifier = verifyGithubAttestationSubject,
}) {
  validateCurrentAnnualOperationalAuthority(authority, inputs, mapBuildCommit);
  invariant(typeof attestationVerifier === "function", "Operational-Authority-Nachpruefung benoetigt einen Attestierungsverifier.");
  const root = resolve(artifactRoot);
  const verifierInput = currentAnnualInput(inputs, "operational-attestation-verifier",
    "Operational-Attestierungsverifier");
  operationalAttestationVerifierBinding(verifierInput, {
    requireOfficialPin: attestationVerifier === verifyGithubAttestationSubject,
  });
  const trustedRootInput = currentAnnualInput(inputs, "operational-attestation-trusted-root",
    "Operational-Attestierungs-Trust-Root");
  operationalAttestationTrustedRootBinding(trustedRootInput, {
    requireOfficialPin: attestationVerifier === verifyGithubAttestationSubject,
  });
  const causal = await validateCurrentAnnualOuterBindings({ root, inputs, releaseConfig, rebuildSpec, outerExecution, releaseId });
  validateExecutionAuthorityPredicate(authority.execution.predicate, {
    releaseId,
    mapBuildCommit,
    causal,
    rebuildBundle: authority.rebuild.bundle,
  });
  invariant(authority.execution.predicateSha256 === canonicalValueSha256(authority.execution.predicate),
    "Operational-v2-Execution-Authority-Predicate driftet von den aktuellen lokalen Kausalbelegen.");
  const localRebuildSubjects = await localSubjectProofs(root, rebuildSpec.authority.attestation.subjects,
    "Operational-v2-Rebuild-Authority-Subject");
  invariant(sameCanonicalValue(authority.rebuild.subjects, localRebuildSubjects),
    "Operational-v2-Rebuild-Authority-Subjects driften von den aktuellen lokalen Artefakten.");
  const localExecutionSubjects = await localSubjectProofs(root, [causal.outer.file, causal.outerCompletion.file],
    "Operational-v2-Execution-Authority-Subject");
  invariant(sameCanonicalValue(authority.execution.subjects, localExecutionSubjects),
    "Operational-v2-Execution-Authority-Subjects driften von Outer-Receipt/Completion.");
  invariant(authority.rebuild.bundle.file === rebuildSpec.authority.attestation.bundleFile
    && authority.execution.bundle.file === CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_BUNDLE,
  "Operational-v2-Build-Authority bindet fremde Attestierungsbundlepfade.");
  const repository = rebuildSpec?.authority?.repository;
  const sourceRef = rebuildSpec?.authority?.requiredRef;
  const rebuildAttestation = rebuildSpec?.authority?.attestation;
  invariant(repository === authority.rebuild.repository
    && sourceRef === authority.rebuild.sourceRef
    && rebuildAttestation?.predicateType === CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_PREDICATE
    && rebuildAttestation.verification?.command === "gh attestation verify"
    && rebuildAttestation.verification.denySelfHostedRunners === true
    && rebuildAttestation.verification.signerWorkflow === CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_WORKFLOW,
  "Operational-v2-Rebuild-Authority driftet vom geschuetzten Rebuild-Vertrag.");
  const rebuildVerification = await proveAttestedSubjects({
    root,
    subjectFiles: rebuildAttestation.subjects,
    bundleInput: currentAnnualInput(inputs, "operational-validator-rebuild-attestation"),
    verifierInput,
    trustedRootInput,
    predicateType: CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_PREDICATE,
    repository,
    signerWorkflow: CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_WORKFLOW,
    sourceRef,
    sourceDigest: mapBuildCommit,
    subjectNameMode: "basename",
    attestationVerifier,
    label: "Operational-v2-Rebuild-Authority-Nachpruefung",
  });
  invariant(sameCanonicalValue(rebuildVerification.subjects, authority.rebuild.subjects),
    "Erneute Sigstore-Verifikation bindet andere Rebuild-Subjects als die gespeicherte Authority.");
  const executionVerification = await proveAttestedSubjects({
    root,
    subjectFiles: [causal.outer.file, causal.outerCompletion.file],
    bundleInput: currentAnnualInput(inputs, "operational-execution-authority-attestation"),
    verifierInput,
    trustedRootInput,
    predicateType: CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_PREDICATE,
    repository,
    signerWorkflow: CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_WORKFLOW,
    sourceRef,
    sourceDigest: mapBuildCommit,
    subjectNameMode: "portable-path",
    capturePredicate: true,
    attestationVerifier,
    label: "Operational-v2-Execution-Authority-Nachpruefung",
  });
  invariant(sameCanonicalValue(executionVerification.subjects, authority.execution.subjects)
    && sameCanonicalValue(executionVerification.predicate, authority.execution.predicate),
  "Erneute Sigstore-Verifikation bindet andere Execution-Subjects oder ein anderes Predicate als die gespeicherte Authority.");
  validateExecutionAuthorityPredicate(executionVerification.predicate, {
    releaseId,
    mapBuildCommit,
    causal,
    rebuildBundle: authority.rebuild.bundle,
  });
  return authority;
}



export function operationalBuildAuthoritySha256(authority) {
  validateOperationalBuildAuthority(authority);
  return canonicalValueSha256(authority);
}

export function validateOperationalBuildAuthority(authority) {
  exactObjectKeys(authority, ["execution", "rebuild", "schema", "trustedRoot", "verifier"],
    "Operational-v2-Build-Authority");
  invariant(authority.schema === CURRENT_ANNUAL_V3_OPERATIONAL_AUTHORITY_SCHEMA,
    "Operational-v2-Build-Authority besitzt ein unbekanntes Schema.");
  const mapBuildCommit = validateCommit(authority?.execution?.predicate?.source?.commit,
    "Operational-v2-Build-Authority.sourceDigest");
  const rebuild = validateAuthorityBlock(authority.rebuild, {
    predicateType: CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_PREDICATE,
    signerWorkflow: CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_WORKFLOW,
    sourceDigest: mapBuildCommit,
  }, "Operational-v2-Build-Authority.rebuild");
  exactObjectKeys(authority.execution, [
    "bundle", "denySelfHostedRunners", "predicate", "predicateSha256", "predicateType", "repository",
    "signerWorkflow", "sourceDigest", "sourceRef", "subjects",
  ], "Operational-v2-Build-Authority.execution");
  const execution = validateAuthorityBlock(Object.fromEntries(Object.entries(authority.execution)
    .filter(([key]) => !["predicate", "predicateSha256"].includes(key))), {
    predicateType: CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_PREDICATE,
    signerWorkflow: CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_WORKFLOW,
    sourceDigest: mapBuildCommit,
  }, "Operational-v2-Build-Authority.execution");
  const verifier = exactObjectKeys(authority.verifier,
    ["bytes", "file", "id", "kind", "sha256", "version"], "Operational-v2-Build-Authority.verifier");
  invariant(verifier.id === "operational-attestation-verifier"
    && verifier.kind === "derived-input"
    && verifier.version === CURRENT_ANNUAL_V3_RELEASE_ID
    && verifier.file === CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.file
    && verifier.bytes === CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.bytes
    && verifier.sha256 === CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.sha256,
  "Operational-v2-Build-Authority bindet nicht den bytegenau gepinnten GitHub-Attestierungsverifier.");
  const trustedRoot = exactObjectKeys(authority.trustedRoot,
    ["bytes", "file", "id", "kind", "sha256", "version"], "Operational-v2-Build-Authority.trustedRoot");
  invariant(trustedRoot.id === "operational-attestation-trusted-root"
    && trustedRoot.kind === "derived-input"
    && trustedRoot.version === CURRENT_ANNUAL_V3_RELEASE_ID
    && trustedRoot.file === CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.file
    && trustedRoot.bytes === CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.bytes
    && trustedRoot.sha256 === CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.sha256,
  "Operational-v2-Build-Authority bindet nicht den bytegenau gepinnten GitHub-Attestierungs-Trust-Root.");
  invariant(rebuild.bundle.file === CURRENT_ANNUAL_V3_REBUILD_AUTHORITY_BUNDLE
    && execution.bundle.file === CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_BUNDLE,
  "Operational-v2-Build-Authority bindet fremde Attestierungsbundlepfade.");
  const predicate = authority.execution.predicate;
  const causal = {
    plan: predicate?.planAuthority?.plan,
    planCompletion: predicate?.planAuthority?.planCompletion,
    startEvidence: predicate?.planAuthority?.startEvidence,
    startEvidenceCompletion: predicate?.planAuthority?.startEvidenceCompletion,
    outer: predicate?.outerExecutionReceipt,
    outerCompletion: predicate?.outerExecutionCompletion,
  };
  validateExecutionAuthorityPredicate(predicate, {
    releaseId: CURRENT_ANNUAL_V3_RELEASE_ID,
    mapBuildCommit,
    causal,
    rebuildBundle: rebuild.bundle,
  });
  invariant(authority.execution.predicateSha256 === canonicalValueSha256(predicate),
    "Operational-v2-Execution-Authority besitzt keine gueltige kanonische Predicate-Bindung.");
  invariant(sameCanonicalValue(execution.subjects, [predicate.outerExecutionReceipt, predicate.outerExecutionCompletion]
    .sort((left, right) => left.file.localeCompare(right.file, "en"))),
  "Operational-v2-Execution-Authority besitzt nicht exakt Outer-Receipt und Completion als Subjects.");
  for (const proof of [predicate.planAuthority.plan, predicate.planAuthority.planCompletion,
    predicate.planAuthority.startEvidence, predicate.planAuthority.startEvidenceCompletion]) {
    invariant(rebuild.subjects.some((subject) => sameCanonicalValue(subject, proof)),
      `Operational-v2-Rebuild-Authority bindet Phase-1-Subject ${proof.file} nicht.`);
  }
  return authority;
}

function exactSpecInput(spec, id, kind, file, { pinned }) {
  const matches = spec.inputs.filter((input) => input?.id === id);
  invariant(matches.length === 1, `Build-Evidence-Spezifikation muss ${id} exakt einmal binden.`);
  const [descriptor] = matches;
  invariant(descriptor.kind === kind && descriptor.version === CURRENT_ANNUAL_V3_RELEASE_ID
    && descriptor.file === file, `Build-Evidence-Spezifikation bindet ${id} nicht exakt.`);
  if (pinned) {
    invariant(Number.isSafeInteger(descriptor.expectedBytes) && descriptor.expectedBytes > 0
      && SHA256.test(descriptor.expectedSha256), `Build-Evidence-Spezifikation pinnt ${id} nicht bytegenau.`);
  }
  return descriptor;
}

async function materializeSpecInput(root, descriptor, label) {
  const proof = await fileProof(root, descriptor, label);
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    version: descriptor.version,
    file: descriptor.file,
    ...(descriptor.cacheFile === undefined ? {} : { cacheFile: descriptor.cacheFile }),
    ...proof,
  };
}

async function readJsonDescriptor(root, descriptor, label, maximumBytes = MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES) {
  const path = await containedRealPath(root, descriptor.file, label);
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0 && metadata.size <= maximumBytes,
    `${label} ist keine begrenzte regulaere JSON-Datei.`);
  const bytes = await readFile(path);
  invariant(bytes.length === metadata.size, `${label} driftete waehrend des Lesens.`);
  if (descriptor.expectedBytes !== undefined || descriptor.expectedSha256 !== undefined) {
    invariant(bytes.length === descriptor.expectedBytes && sha256Bytes(bytes) === descriptor.expectedSha256,
      `${label} driftet vom Build-Evidence-Pin.`);
  }
  try {
    return { bytes, path, proof: { file: descriptor.file, bytes: bytes.length, sha256: sha256Bytes(bytes) }, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON.`, { cause: error });
  }
}

export async function materializeOperationalBuildAuthorityFromBuildEvidenceSpec({
  sourceRoot,
  buildEvidenceSpecFile = CURRENT_BUILD_EVIDENCE_SPEC_FILE,
  mapBuildCommit,
  attestationVerifier = verifyGithubAttestationSubject,
  verifyPublicationReceipt = verifyGermanyOperationalInfrastructureV2PublicationReceipt,
}) {
  invariant(buildEvidenceSpecFile === CURRENT_BUILD_EVIDENCE_SPEC_FILE,
    "Operational-Build-Authority darf nur aus der exakten aktuellen .5-Build-Evidence-Spezifikation entstehen.");
  const root = resolve(sourceRoot);
  const specDescriptor = { file: buildEvidenceSpecFile };
  const loadedSpec = await readJsonDescriptor(root, specDescriptor, "Build-Evidence-Spezifikation");
  const spec = loadedSpec.value;
  invariant(spec?.schema === "zugfolge-map-release-build-evidence-spec/v3"
    && spec.releaseId === CURRENT_ANNUAL_V3_RELEASE_ID
    && Array.isArray(spec.inputs), "Operational-Build-Authority benoetigt den aktuellen Build-Evidence-v3-Vertrag.");
  validateCommit(mapBuildCommit, "Operational-Build-Authority.mapBuildCommit");
  invariant(spec.commits === undefined,
    "Build-Evidence-Spezifikation darf keinen vorab erfundenen Commit tragen.");

  const inputs = [];
  for (const [id, file] of CURRENT_AUTHORITY_INPUTS) {
    const descriptor = exactSpecInput(spec, id, "derived-input", file, { pinned: true });
    inputs.push(await materializeSpecInput(root, descriptor, `Operational-Authority-Eingabe ${id}`));
  }
  for (const [id, kind, file] of CURRENT_SUPPORT_INPUTS) {
    const descriptor = exactSpecInput(spec, id, kind, file, { pinned: false });
    inputs.push(await materializeSpecInput(root, descriptor, `Operational-Authority-Stuetzbeleg ${id}`));
  }

  const releaseConfigDescriptor = exactSpecInput(spec, "germany-release-spec", "specification",
    "tools/region-import/germany/release.annual-2026.5.config.json", { pinned: false });
  const releaseConfig = (await readJsonDescriptor(root, releaseConfigDescriptor,
    "Deutschland-Jahresrelease-Konfiguration")).value;
  const rebuildSpecDescriptor = exactSpecInput(spec, "operational-validator-rebuild-spec", "repo-contract",
    "tools/region-import/germany/operational-validator-rebuild.annual-2026.5.json", { pinned: false });
  const rebuildSpec = (await readJsonDescriptor(root, rebuildSpecDescriptor,
    "Operational-Validator-Rebuild-Spezifikation")).value;
  const publicationDescriptor = exactSpecInput(spec, "operational-publication-receipt", "derived-input",
    "var/derived/germany-2026.5/operational-infrastructure-v2.publication-receipt.json", { pinned: true });
  const publicationInput = await materializeSpecInput(root, publicationDescriptor,
    "Operational-v2-Publication-Receipt");
  const verifiedPublication = await verifyPublicationReceipt({
    workspaceRoot: root,
    publicationReceiptPath: await containedRealPath(root, publicationDescriptor.file,
      "Operational-v2-Publication-Receipt"),
    publicationReceiptBytes: (await readJsonDescriptor(root, publicationDescriptor,
      "Operational-v2-Publication-Receipt")).bytes,
    expectedReleaseId: CURRENT_ANNUAL_V3_RELEASE_ID,
  });
  invariant(verifiedPublication?.proof?.bytes === publicationInput.bytes
    && verifiedPublication.proof.sha256 === publicationInput.sha256
    && isRecord(verifiedPublication.outerExecution),
  "Operational-v2-Publication-Receipt liefert keinen bytegleichen Outer-Execution-Beleg.");

  const authority = await materializeCurrentAnnualOperationalAuthority({
    artifactRoot: root,
    inputs,
    releaseConfig,
    rebuildSpec,
    outerExecution: verifiedPublication.outerExecution,
    releaseId: CURRENT_ANNUAL_V3_RELEASE_ID,
    mapBuildCommit,
    attestationVerifier,
  });
  await verifyCurrentAnnualOperationalAuthorityLocal({
    artifactRoot: root,
    inputs,
    releaseConfig,
    rebuildSpec,
    outerExecution: verifiedPublication.outerExecution,
    releaseId: CURRENT_ANNUAL_V3_RELEASE_ID,
    mapBuildCommit,
    authority,
    attestationVerifier,
  });
  validateOperationalBuildAuthority(authority);
  return structuredClone(authority);
}
