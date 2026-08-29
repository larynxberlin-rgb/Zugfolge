import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildOperationalValidatorWindowsAnchorHelper } from "./build-operational-validator-windows-anchor-helper.mjs";
import {
  materializeOperationalValidatorRebuildEvidence,
  validateOperationalValidatorRebuildSpec,
  WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
} from "./operational-validator-rebuild-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const IMPLEMENTATION_PATH = join(HERE, "operational-validator-rebuild-evidence.mjs");
const HELPER_BUILDER_PATH = join(HERE, "build-operational-validator-windows-anchor-helper.mjs");
const HELPER_PATH = join(HERE, "operational-windows-anchor-helper.dll");
const RUSTUP_COMPONENT_NORMALIZER_PATH = join(HERE, "normalize-operational-validator-rustup-components.windows.ps1");
const PREPARATION_PATH = join(HERE, "prepare-operational-validator-rebuild-inputs.mjs");
const PRODUCTION_SPEC_PATH = join(HERE, "operational-validator-rebuild.annual-2026.5.json");
const OPERATIONAL_CAPTURE_RUNNER_PATH = join(HERE, "run-capture-operational-infrastructure-v2.mjs");
const WORKFLOW_RUNNER_PATH = join(HERE, "run-operational-validator-rebuild-workflow.mjs");
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "operational-validator-rebuild-evidence.yml");
const EXECUTION_AUTHORITY_WORKFLOW_PATH = join(ROOT, ".github", "workflows", "operational-v2-execution-authority.yml");
const POWERSHELL_51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_ONLY = { skip: process.platform !== "win32" };
const ELEVATED_ACCOUNT_TESTS_REQUIRED = process.env.ZUGFOLGE_REQUIRE_ELEVATED_ACCOUNT_TESTS === "1";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

let tarAuditForTest;
let windowsBuildAnchorSafeDiagnosticForTest;
let windowsBuildAnchorCommitAcknowledgementForTest;
let canonicalWorkspaceForTest;

async function loadTarAuditForTest() {
  tarAuditForTest ??= (async () => {
    const source = await readFile(IMPLEMENTATION_PATH, "utf8");
    const instrumented = `${source}\nexport { auditPinnedRegularTar as __auditPinnedRegularTarForTest };\n`;
    const module = await import(`data:text/javascript;base64,${Buffer.from(instrumented, "utf8").toString("base64")}`);
    return module.__auditPinnedRegularTarForTest;
  })();
  return tarAuditForTest;
}

async function loadWindowsBuildAnchorSafeDiagnosticForTest() {
  windowsBuildAnchorSafeDiagnosticForTest ??= (async () => {
    const source = await readFile(IMPLEMENTATION_PATH, "utf8");
    const instrumented = `${source}\nexport { windowsBuildAnchorSafeDiagnostic as __windowsBuildAnchorSafeDiagnosticForTest };\n`;
    const module = await import(`data:text/javascript;base64,${Buffer.from(instrumented, "utf8").toString("base64")}`);
    return module.__windowsBuildAnchorSafeDiagnosticForTest;
  })();
  return windowsBuildAnchorSafeDiagnosticForTest;
}

async function loadWindowsBuildAnchorCommitAcknowledgementForTest() {
  windowsBuildAnchorCommitAcknowledgementForTest ??= (async () => {
    const source = await readFile(IMPLEMENTATION_PATH, "utf8");
    const instrumented = `${source}\nexport { resolveWindowsAnchorCommitAcknowledgement as __resolveWindowsAnchorCommitAcknowledgementForTest };\n`;
    const module = await import(`data:text/javascript;base64,${Buffer.from(instrumented, "utf8").toString("base64")}`);
    return module.__resolveWindowsAnchorCommitAcknowledgementForTest;
  })();
  return windowsBuildAnchorCommitAcknowledgementForTest;
}

async function loadCanonicalWorkspaceForTest() {
  canonicalWorkspaceForTest ??= (async () => {
    const source = await readFile(IMPLEMENTATION_PATH, "utf8");
    const instrumented = `${source}\nexport { assertCanonicalWorkspaceSnapshot as __assertCanonicalWorkspaceSnapshotForTest, assertNoSymlinkPath as __assertNoSymlinkPathForTest, canonicalWorkspacePath as __canonicalWorkspacePathForTest, canonicalWorkspaceSnapshot as __canonicalWorkspaceSnapshotForTest };\n`;
    const module = await import(`data:text/javascript;base64,${Buffer.from(instrumented, "utf8").toString("base64")}`);
    return {
      assertNoSymlinkPath: module.__assertNoSymlinkPathForTest,
      assertSnapshot: module.__assertCanonicalWorkspaceSnapshotForTest,
      mapPath: module.__canonicalWorkspacePathForTest,
      snapshot: module.__canonicalWorkspaceSnapshotForTest,
    };
  })();
  return canonicalWorkspaceForTest;
}

function tarOctalField(value, length) {
  const octal = value.toString(8).padStart(length - 1, "0");
  assert.ok(octal.length < length, `TAR-Oktalfeld ${value} passt nicht in ${length} Bytes.`);
  return Buffer.from(`${octal}\0`, "ascii");
}

function tarHeader({ bytes, file, link = "", type = "0" }) {
  const header = Buffer.alloc(512);
  Buffer.from(file, "utf8").copy(header, 0);
  tarOctalField(type === "5" ? 0o755 : 0o644, 8).copy(header, 100);
  tarOctalField(0, 8).copy(header, 108);
  tarOctalField(0, 8).copy(header, 116);
  tarOctalField(bytes, 12).copy(header, 124);
  tarOctalField(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  Buffer.from(link, "utf8").copy(header, 157);
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
  return header;
}

function tarPaxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  for (;;) {
    const record = `${length} ${payload}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return Buffer.from(record, "utf8");
    length = actual;
  }
}

function tarEntry({ data = Buffer.alloc(0), file, link = "", type = "0" }) {
  const bytes = Buffer.from(data);
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([tarHeader({ bytes: bytes.length, file, link, type }), bytes, padding]);
}

function tarFixture(entries, comment = "a".repeat(40)) {
  const pax = tarPaxRecord("comment", comment);
  const bytes = Buffer.concat([
    tarEntry({ data: pax, file: "pax-global", type: "g" }),
    ...entries.map(tarEntry),
    Buffer.alloc(1024),
  ]);
  const manifest = entries
    .filter(({ type = "0" }) => type === "0")
    .map(({ data = Buffer.alloc(0), file }) => {
      const content = Buffer.from(data);
      return { bytes: content.length, file, sha256: sha256(content) };
    })
    .sort((left, right) => left.file.localeCompare(right.file, "en"));
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    bytes,
    comment,
    manifest,
    tree: {
      fileCount: manifest.length,
      manifestSha256: sha256(canonicalBytes(manifest)),
      totalBytes,
    },
  };
}

function auditFixture(audit, fixture, overrides = {}) {
  return audit(fixture.bytes, {
    archive: { bytes: fixture.bytes.length, sha256: sha256(fixture.bytes) },
    expectedComment: fixture.comment,
    expectedTree: fixture.tree,
    label: "Test-Commit-TAR",
    ...overrides,
  });
}

function clone(value) {
  return structuredClone(value);
}

function execute(file, arguments_, { cwd = ROOT, env = process.env, expectFailure = false, maxBuffer = 16 * 1024 * 1024, stdin } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = execFile(file, arguments_, { cwd, encoding: "buffer", env, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      const result = { error, stderr: Buffer.from(stderr ?? []), stdout: Buffer.from(stdout ?? []) };
      if (expectFailure || !error) resolveResult(result);
      else reject(new Error(`${file} ist fehlgeschlagen: ${result.stderr.toString("utf8")}`, { cause: error }));
    });
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

function skipNonWindowsAccountTest(t) {
  if (process.platform !== "win32") {
    if (ELEVATED_ACCOUNT_TESTS_REQUIRED) assert.fail("Erzwungener Einmalaccount-Test laeuft nicht auf Windows.");
    t.skip("Einmalaccount-Integration benoetigt Windows.");
    return false;
  }
  return true;
}

async function exerciseEphemeralBuildAccount(t, mode) {
  if (!skipNonWindowsAccountTest(t)) return undefined;
  const root = await temporaryDirectory(t, "zugfolge-ephemeral-account-");
  const helper = join(root, "operational-windows-anchor-helper.dll");
  const harness = join(root, "ephemeral-account-integration.ps1");
  await buildOperationalValidatorWindowsAnchorHelper(helper);
  await writeFile(harness, [
    "param([string] $Dll, [ValidateSet('success','failure','start-failure')] [string] $Mode, [ValidateSet('0','1')] [string] $ElevationRequired)",
    "$ErrorActionPreference = 'Stop'",
    "[void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))",
    "$elevated = [ZugfolgeEphemeralAccount]::CurrentProcessHasElevatedAdministratorToken()",
    "if (-not $elevated) {",
    "  if ($ElevationRequired -ceq '1') { throw 'Workflow verlangte einen erhoehten Windows-Token.' }",
    "  [Console]::Out.WriteLine('SKIP_NOT_ELEVATED')",
    "  exit 0",
    "}",
    "function Get-ZugfolgeBuildAccounts { return @(Get-LocalUser | Where-Object { $_.Name -like 'zfrb*' } | ForEach-Object Name) }",
    "$before = @(Get-ZugfolgeBuildAccounts)",
    "if ($before.Count -ne 0) { throw 'Einmalaccount-Test startet nicht auf einem accountsauberen Host.' }",
    "$account = $null",
    "$accountName = $null",
    "$created = $false",
    "$used = $false",
    "$failureObserved = $false",
    "$startFailureObserved = $false",
    "$cancellationExact = $false",
    "$emptyEnvironmentExact = $false",
    "$environmentExact = $false",
    "$outputLimitExact = $false",
    "$timeoutExact = $false",
    "$cwdExact = $false",
    "$stdioExact = $false",
    "$treeExact = $false",
    "try {",
    "  $account = [ZugfolgeEphemeralAccount]::Create()",
    "  $accountName = $account.Username",
    "  $created = $null -ne (Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue)",
    "  if (-not $created) { throw 'NetUserAdd-Erfolg wurde nicht im lokalen Accountbestand sichtbar.' }",
    "  $environment = @{ SystemRoot='C:\\Windows'; WINDIR='C:\\Windows'; ComSpec='C:\\Windows\\System32\\cmd.exe'; HOMEDRIVE='C:'; HOMEPATH='\\Windows\\System32'; PATH='C:\\Windows\\System32;C:\\Windows'; PATHEXT='.COM;.EXE;.BAT;.CMD'; PROMPT='$P$G'; TEMP='C:\\Windows\\Temp'; TMP='C:\\Windows\\Temp' }",
    "  $never = [Func[bool]] { return $false }",
    "  if ($Mode -ceq 'success') {",
    "    $emptyEnvironment = @{}",
    "    $emptyProbe = [ZugfolgeMitigatedProcess]::RunAsStrict('C:\\Windows\\System32\\cmd.exe', [string[]]@('/D','/Q','/C','exit /b 0'), 'C:\\Windows\\System32', $emptyEnvironment, [byte[]]@(), 65536, 15000, $never, $account)",
    "    $emptyEnvironmentExact = $emptyProbe.ExitCode -eq 0 -and $emptyProbe.Stdout.Length -eq 0 -and $emptyProbe.Stderr.Length -eq 0",
    "    if (-not $emptyEnvironmentExact) { throw 'Leerer Unicode-Environment-Block war nicht ausfuehrbar.' }",
    "    $probeEnvironment = @{}",
    "    foreach ($key in $environment.Keys) { $probeEnvironment[$key] = $environment[$key] }",
    "    $probeEnvironment['PROMPT'] = '$P$G'",
    "    $probeEnvironment['ZUGFOLGE_ENV_PROBE'] = 'explicit-v1'",
    "    $probe = [ZugfolgeMitigatedProcess]::RunAsStrict('C:\\Windows\\System32\\cmd.exe', [string[]]@('/D','/Q','/C','set & echo ZUGFOLGE_CWD=%CD%'), 'C:\\Windows\\System32', $probeEnvironment, [byte[]]@(), 65536, 15000, $never, $account)",
    "    if ($probe.ExitCode -ne 0 -or $probe.Stderr.Length -ne 0) { throw 'Environment-Probe scheiterte.' }",
    "    $lines = @([Text.Encoding]::ASCII.GetString($probe.Stdout) -split '\\r\\n' | Where-Object { $_.Length -gt 0 })",
    "    $cwdLines = @($lines | Where-Object { $_.StartsWith('ZUGFOLGE_CWD=', [StringComparison]::Ordinal) })",
    "    $cwdExact = $cwdLines.Count -eq 1 -and $cwdLines[0] -ceq 'ZUGFOLGE_CWD=C:\\Windows\\System32'",
    "    if (-not $cwdExact) { throw 'Kindprozess verwendete nicht das feste System32-Arbeitsverzeichnis.' }",
    "    $actualEnvironment = @{}",
    "    foreach ($line in @($lines | Where-Object { -not $_.StartsWith('ZUGFOLGE_CWD=', [StringComparison]::Ordinal) })) {",
    "      $separator = $line.IndexOf('=')",
    "      if ($separator -le 0) { throw 'Environment-Probe lieferte eine ungueltige Zeile.' }",
    "      $name = $line.Substring(0, $separator).ToUpperInvariant()",
    "      if ($actualEnvironment.ContainsKey($name)) { throw 'Environment-Probe lieferte einen doppelten Namen.' }",
    "      $actualEnvironment[$name] = $line.Substring($separator + 1)",
    "    }",
    "    $expectedEnvironment = @{}",
    "    foreach ($key in $probeEnvironment.Keys) { $expectedEnvironment[([string]$key).ToUpperInvariant()] = [string]$probeEnvironment[$key] }",
    "    $expectedNames = @($expectedEnvironment.Keys | Sort-Object)",
    "    $actualNames = @($actualEnvironment.Keys | Sort-Object)",
    "    $environmentExact = $actualEnvironment.Count -eq $expectedEnvironment.Count -and $null -eq (Compare-Object $actualNames $expectedNames)",
    "    foreach ($name in $expectedNames) { if (-not $actualEnvironment.ContainsKey($name) -or [string]$actualEnvironment[$name] -cne [string]$expectedEnvironment[$name]) { $environmentExact = $false } }",
    "    if (-not $environmentExact) { throw 'Kindprozessumgebung driftete von der vollstaendig expliziten Allowlist.' }",
    "    $longArgument = 'x' * 2048",
    "    $longProbe = [ZugfolgeMitigatedProcess]::RunAsStrict('C:\\Windows\\System32\\cmd.exe', [string[]]@('/D','/Q','/C',('rem ' + $longArgument)), 'C:\\Windows\\System32', $environment, [byte[]]@(), 65536, 15000, $never, $account)",
    "    if ($longProbe.ExitCode -ne 0 -or $longProbe.Stdout.Length -ne 0 -or $longProbe.Stderr.Length -ne 0) { throw 'Einmalaccount-Payload oberhalb der WithLogon-Kommandogrenze scheiterte.' }",
    "    # Keep the byte probe cmdlet-free: first-use module progress is legitimate child stderr, not launcher cross-wiring.",
    "    $ioSource = '$stream=[Console]::OpenStandardInput(); $memory=[IO.MemoryStream]::new(); $buffer=[byte[]]::new(4096); while (($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0) { $memory.Write($buffer,0,$read) }; $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($identity))); [Console]::Out.Write(\".\"); [Console]::Out.Write([Convert]::ToBase64String($memory.ToArray())); [Console]::Error.Write(''ephemeral-stderr'')'",
    "    $ioEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ioSource))",
    "    $stdinBytes = [byte[]](0,1,2,3,10,13,26,31,32,65,90,127,128,200,254,255)",
    "    $result = [ZugfolgeMitigatedProcess]::RunAsStrict('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [string[]]@('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$ioEncoded), 'C:\\Windows\\System32', $environment, $stdinBytes, 65536, 15000, $never, $account)",
    "    if ($result.ExitCode -ne 0) { throw \"Einmalaccount-Kindprozess endete mit $($result.ExitCode).\" }",
    "    $stdoutText = [Text.Encoding]::ASCII.GetString($result.Stdout)",
    "    $separator = $stdoutText.IndexOf([char]46)",
    "    $stdoutShapeExact = $separator -gt 0 -and $separator -eq $stdoutText.LastIndexOf([char]46) -and $separator -lt ($stdoutText.Length - 1)",
    "    if (-not $stdoutShapeExact) { throw \"Kindprozess-stdout hatte nicht die feste zweiteilige Form (bytes=$($result.Stdout.Length)).\" }",
    "    try {",
    "      $identityBase64 = $stdoutText.Substring(0, $separator)",
    "      $stdinBase64 = $stdoutText.Substring($separator + 1)",
    "      $identityBytes = [Convert]::FromBase64String($identityBase64)",
    "      $actualStdin = [Convert]::FromBase64String($stdinBase64)",
    "      if ([Convert]::ToBase64String($identityBytes) -cne $identityBase64 -or [Convert]::ToBase64String($actualStdin) -cne $stdinBase64) { throw 'NON_CANONICAL_BASE64' }",
    "      $identityText = [Text.Encoding]::UTF8.GetString($identityBytes)",
    "    } catch { throw 'Kindprozess-stdout enthielt keine kanonischen Base64-Felder.' }",
    "    $used = $identityText.EndsWith('\\' + $accountName, [StringComparison]::OrdinalIgnoreCase)",
    "    if (-not $used) { throw 'Kindprozess verwendete nicht den erzeugten Einmalaccount.' }",
    "    $stdinExact = [Convert]::ToBase64String($actualStdin) -ceq [Convert]::ToBase64String($stdinBytes)",
    "    $stderrExact = [Text.Encoding]::ASCII.GetString($result.Stderr) -ceq 'ephemeral-stderr'",
    "    $stdioExact = $stdinExact -and $stderrExact",
    "    if (-not $stdioExact) { throw \"Kindprozess band stdin/stdout/stderr nicht getrennt und bytegenau (stdin=$stdinExact; stderr=$stderrExact; stdoutBytes=$($result.Stdout.Length); stderrBytes=$($result.Stderr.Length)).\" }",
    "    $slowSource = 'Start-Sleep -Seconds 30'",
    "    $slowEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($slowSource))",
    "    try {",
    "      $null = [ZugfolgeMitigatedProcess]::RunAsStrict('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [string[]]@('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$slowEncoded), 'C:\\Windows\\System32', $environment, [byte[]]@(), 65536, 5000, $never, $account)",
    "      throw 'ACCOUNT_TIMEOUT_UNEXPECTEDLY_SUCCEEDED'",
    "    } catch {",
    "      $base = $_.Exception.GetBaseException()",
    "      $timeoutMessages = @('Windows-Kindstart ueberschritt vor ResumeThread das gepinnte Zeitlimit.','Windows-Kindprozessbaum ueberschritt das gepinnte Zeitlimit.')",
    "      if (-not ($base -is [TimeoutException]) -or [string]$base.Message -notin $timeoutMessages) { throw }",
    "      $timeoutExact = $true",
    "    }",
    "    $cancelState = [pscustomobject]@{ Checks = 0 }",
    "    $cancelAfterResume = [Func[bool]] { $cancelState.Checks = [int]$cancelState.Checks + 1; return [int]$cancelState.Checks -ge 4 }",
    "    try {",
    "      $null = [ZugfolgeMitigatedProcess]::RunAsStrict('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [string[]]@('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$slowEncoded), 'C:\\Windows\\System32', $environment, [byte[]]@(), 65536, 15000, $cancelAfterResume, $account)",
    "      throw 'ACCOUNT_CANCELLATION_UNEXPECTEDLY_SUCCEEDED'",
    "    } catch {",
    "      $base = $_.Exception.GetBaseException()",
    "      if (-not ($base -is [InvalidOperationException]) -or [string]$base.Message -cne 'Windows-Kindprozessbaum wurde nach monotoner Inputdrift beendet.') { throw }",
    "      $cancellationExact = $true",
    "    }",
    "    $outputSource = \"[Console]::Out.Write(('x' * 4096))\"",
    "    $outputEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($outputSource))",
    "    try {",
    "      $null = [ZugfolgeMitigatedProcess]::RunAsStrict('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [string[]]@('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$outputEncoded), 'C:\\Windows\\System32', $environment, [byte[]]@(), 1024, 15000, $never, $account)",
    "      throw 'ACCOUNT_OUTPUT_LIMIT_UNEXPECTEDLY_SUCCEEDED'",
    "    } catch {",
    "      $base = $_.Exception.GetBaseException()",
    "      if (-not ($base -is [InvalidOperationException]) -or -not ([string]$base.Message).EndsWith('ueberschritt das kombinierte gepinnte Limit.', [StringComparison]::Ordinal)) { throw }",
    "      $outputLimitExact = $true",
    "    }",
    "    # Keep the tree probe cmdlet-free for the same fresh-account reason as the stdio probe above.",
    "    $grandchildSource = '[Threading.Thread]::Sleep(30000)'",
    "    $grandchildEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($grandchildSource))",
    "    $rootSource = '$start=[Diagnostics.ProcessStartInfo]::new(); $start.FileName=''C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe''; $start.Arguments=''-NoLogo -NoProfile -NonInteractive -EncodedCommand '' + $env:ZUGFOLGE_GRANDCHILD_ENCODED; $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $child=[Diagnostics.Process]::Start($start); $child.Refresh(); [Console]::Out.Write($child.Id.ToString([Globalization.CultureInfo]::InvariantCulture)); [Console]::Out.Write(''.''); [Console]::Out.Write($child.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)); $child.Dispose()'",
    "    $rootEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($rootSource))",
    "    $treeEnvironment = @{}",
    "    foreach ($key in $environment.Keys) { $treeEnvironment[$key] = $environment[$key] }",
    "    $treeEnvironment['ZUGFOLGE_GRANDCHILD_ENCODED'] = $grandchildEncoded",
    "    $treeResult = [ZugfolgeMitigatedProcess]::RunAsStrict('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [string[]]@('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$rootEncoded), 'C:\\Windows\\System32', $treeEnvironment, [byte[]]@(), 65536, 15000, $never, $account)",
    "    if ($treeResult.ExitCode -ne 0 -or $treeResult.Stderr.Length -ne 0) { throw \"Job-Nachfahrprobe scheiterte vor ihrem Beleg (exit=$($treeResult.ExitCode); stdoutBytes=$($treeResult.Stdout.Length); stderrBytes=$($treeResult.Stderr.Length)).\" }",
    "    $treeReceipt = [Text.Encoding]::ASCII.GetString($treeResult.Stdout)",
    "    $treeSeparator = $treeReceipt.IndexOf([char]46)",
    "    $treeReceiptShapeExact = $treeSeparator -gt 0 -and $treeSeparator -eq $treeReceipt.LastIndexOf([char]46) -and $treeSeparator -lt ($treeReceipt.Length - 1)",
    "    if (-not $treeReceiptShapeExact) { throw \"Job-Nachfahrprobe lieferte nicht die feste zweiteilige Form (stdoutBytes=$($treeResult.Stdout.Length)).\" }",
    "    [Int64]$treePid = 0",
    "    [Int64]$treeStartFileTimeUtc = 0",
    "    $treePidText = $treeReceipt.Substring(0, $treeSeparator)",
    "    $treeStartText = $treeReceipt.Substring($treeSeparator + 1)",
    "    $treeNumbersExact = [Int64]::TryParse($treePidText, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$treePid) -and [Int64]::TryParse($treeStartText, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$treeStartFileTimeUtc)",
    "    $treeNumbersExact = $treeNumbersExact -and $treePid.ToString([Globalization.CultureInfo]::InvariantCulture) -ceq $treePidText -and $treeStartFileTimeUtc.ToString([Globalization.CultureInfo]::InvariantCulture) -ceq $treeStartText",
    "    if (-not $treeNumbersExact) { throw 'Job-Nachfahrprobe lieferte keine kanonischen Dezimalfelder.' }",
    "    if ($treePid -le 0 -or $treePid -gt [Int32]::MaxValue -or $treeStartFileTimeUtc -le 0) { throw 'Job-Nachfahrprobe lieferte keinen gueltigen PID-/Startzeit-Beleg.' }",
    "    $deadline = [DateTime]::UtcNow.AddSeconds(3)",
    "    $survivor = $null",
    "    do {",
    "      if ($null -ne $survivor) { $survivor.Dispose(); $survivor = $null }",
    "      $candidate = $null",
    "      try {",
    "        $candidate = [Diagnostics.Process]::GetProcessById([int]$treePid)",
    "        $candidate.Refresh()",
    "        if ($candidate.StartTime.ToFileTimeUtc() -eq $treeStartFileTimeUtc) { $survivor = $candidate } else { $candidate.Dispose(); $candidate = $null }",
    "      } catch [ArgumentException] { if ($null -ne $candidate) { $candidate.Dispose() }; $survivor = $null }",
    "      catch [InvalidOperationException] { if ($null -ne $candidate) { $candidate.Dispose() }; $survivor = $null }",
    "      catch { if ($null -ne $candidate) { $candidate.Dispose() }; throw }",
    "      if ($null -ne $survivor) { Start-Sleep -Milliseconds 100 }",
    "    } while ($null -ne $survivor -and [DateTime]::UtcNow -lt $deadline)",
    "    if ($null -ne $survivor) {",
    "      try { $survivor.Kill(); $survivor.WaitForExit(5000) | Out-Null } finally { $survivor.Dispose() }",
    "      throw 'Ein Job-Nachfahrprozess ueberlebte den Root-Exit.'",
    "    }",
    "    $treeExact = $true",
    "  } elseif ($Mode -ceq 'failure') {",
    "    $result = [ZugfolgeMitigatedProcess]::RunAsStrict('C:\\Windows\\System32\\cmd.exe', [string[]]@('/D','/Q','/C','1>&2 echo intentional-account-child-failure & exit /b 23'), 'C:\\Windows\\System32', $environment, [byte[]]@(), 65536, 15000, $never, $account)",
    "    if ($result.ExitCode -ne 23) { throw \"Fehler-Kindprozess endete mit $($result.ExitCode) statt 23.\" }",
    "    throw 'INTENTIONAL_ACCOUNT_FAILURE_AFTER_USE'",
    "  } else {",
    "    $missingExe = 'C:\\Windows\\System32\\zugfolge-missing-' + [Guid]::NewGuid().ToString('N') + '.exe'",
    "    if ([IO.File]::Exists($missingExe)) { throw 'Missing-EXE existiert unerwartet.' }",
    "    $null = [ZugfolgeMitigatedProcess]::RunAsStrict($missingExe, [string[]]@(), 'C:\\Windows\\System32', $environment, [byte[]]@(), 65536, 15000, $never, $account)",
    "    throw 'START_FAILURE_UNEXPECTEDLY_SUCCEEDED'",
    "  }",
    "} catch {",
    "  $message = [string]$_.Exception.GetBaseException().Message",
    "  if ($Mode -ceq 'failure' -and $message -ceq 'INTENTIONAL_ACCOUNT_FAILURE_AFTER_USE') { $failureObserved = $true }",
    "  elseif ($Mode -ceq 'start-failure' -and $message -ceq 'ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_FROM_ANCHOR status=2') { $startFailureObserved = $true }",
    "  else { throw }",
    "} finally {",
    "  if ($null -ne $account) { $account.Dispose() }",
    "}",
    "$afterOwn = if ($null -eq $accountName) { 0 } else { @(Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue).Count }",
    "$afterMatching = @(Get-ZugfolgeBuildAccounts)",
    "if ($afterOwn -ne 0 -or $afterMatching.Count -ne 0) { throw 'Einmalaccount-Cleanup hinterliess einen passenden lokalen Account.' }",
    "$receipt = [ordered]@{ accountsAfter=$afterMatching.Count; accountsBefore=$before.Count; cancellationExact=$cancellationExact; created=$created; cwdExact=$cwdExact; emptyEnvironmentExact=$emptyEnvironmentExact; environmentExact=$environmentExact; failureObserved=$failureObserved; mode=$Mode; outputLimitExact=$outputLimitExact; startFailureObserved=$startFailureObserved; stdioExact=$stdioExact; timeoutExact=$timeoutExact; treeExact=$treeExact; used=$used }",
    "[Console]::Out.WriteLine(($receipt | ConvertTo-Json -Compress))",
    "",
  ].join("\r\n"));
  const executed = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    harness, helper, mode, ELEVATED_ACCOUNT_TESTS_REQUIRED ? "1" : "0",
  ], { cwd: "C:\\Windows\\System32" });
  const line = executed.stdout.toString("utf8").trim().split(/\r?\n/u).at(-1);
  if (line === "SKIP_NOT_ELEVATED") {
    t.skip("Einmalaccount-Integration benoetigt einen erhoehten Windows-Token.");
    return undefined;
  }
  return JSON.parse(line);
}

async function loadProductionSpec() {
  const bytes = await readFile(PRODUCTION_SPEC_PATH);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

async function temporaryDirectory(t, prefix = "zugfolge-rebuild-v3-test-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { force: true, recursive: true }));
  return realpath(root);
}

async function waitForFileBytes(path, timeoutMilliseconds = 5_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    try { return await readFile(path); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error(`Zeitlimit beim Warten auf ${path}.`, { cause: error });
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
}

async function materializationTarSwapFixture(t, workspaceRootInput) {
  const workspaceRoot = workspaceRootInput ?? await temporaryDirectory(t, "zfrbtarswap");
  if (workspaceRootInput) await mkdir(workspaceRoot, { recursive: true });
  const { value: productionSpec } = await loadProductionSpec();
  const spec = clone(productionSpec);
  const sourceData = Buffer.from("held-v1\n", "utf8");
  const foreignSourceData = Buffer.from("evil-v1\n", "utf8");
  const vendorData = Buffer.from("[held__]\n", "utf8");
  const foreignVendorData = Buffer.from("[evil__]\n", "utf8");
  const source = tarFixture([{ data: sourceData, file: "Cargo.lock" }], spec.source.commit);
  const foreignSource = tarFixture([{ data: foreignSourceData, file: "Cargo.lock" }], spec.source.commit);
  const vendor = tarFixture([{ data: vendorData, file: ".cargo/config.toml" }], "cargo-vendor-tree-v1");
  const foreignVendor = tarFixture([{ data: foreignVendorData, file: ".cargo/config.toml" }], "cargo-vendor-tree-v1");
  const workspacePath = (portable) => join(workspaceRoot, ...portable.split("/"));
  const toolchainRoot = join(workspaceRoot, "fixture-toolchain");
  const cargoPath = join(toolchainRoot, "bin", "cargo.exe");
  const rustcPath = join(toolchainRoot, "bin", "rustc.exe");
  const cargoBytes = Buffer.from("fixture-cargo-not-executed\n", "utf8");
  const rustcBytes = Buffer.from("fixture-rustc-not-executed\n", "utf8");
  await mkdir(dirname(cargoPath), { recursive: true });
  await Promise.all([
    writeFile(cargoPath, cargoBytes, { flag: "wx" }),
    writeFile(rustcPath, rustcBytes, { flag: "wx" }),
  ]);
  if (process.platform === "win32") spec.toolchain.root = toolchainRoot;
  spec.toolchain.cargoPath = "bin/cargo.exe";
  spec.toolchain.rustcPath = "bin/rustc.exe";
  const manifest = {
    directories: ["bin"],
    files: [
      { bytes: cargoBytes.length, file: spec.toolchain.cargoPath, sha256: sha256(cargoBytes) },
      { bytes: rustcBytes.length, file: spec.toolchain.rustcPath, sha256: sha256(rustcBytes) },
    ],
    id: "fixture-toolchain-v1",
    schema: "zugfolge-operational-validator-toolchain-manifest/v1",
  };
  const manifestBytes = canonicalBytes(manifest);
  spec.toolchain.manifest = {
    bytes: manifestBytes.length,
    file: spec.toolchain.manifest.file,
    sha256: sha256(manifestBytes),
  };
  spec.source.archive = {
    bytes: source.bytes.length,
    file: spec.source.archive.file,
    format: "tar",
    sha256: sha256(source.bytes),
  };
  spec.source.cargoLock = { ...source.manifest.find(({ file }) => file === "Cargo.lock") };
  spec.source.tree = source.tree;
  spec.source.vendor.archive = {
    bytes: vendor.bytes.length,
    file: spec.source.vendor.archive.file,
    format: "tar",
    sha256: sha256(vendor.bytes),
  };
  spec.source.vendor.cargoConfig = { ...vendor.manifest.find(({ file }) => file === ".cargo/config.toml") };
  spec.source.vendor.tree = vendor.tree;
  const preservedBytes = Buffer.from("fixture-preserved-validator-not-inspected-as-pe-before-build\n", "utf8");
  spec.binaries.preserved = {
    bytes: preservedBytes.length,
    file: spec.binaries.preserved.file,
    sha256: sha256(preservedBytes),
  };
  spec.binaries.rebuilt.expectedBytes = preservedBytes.length;
  const helperBytes = await readFile(HELPER_PATH);
  spec.toolchain.anchor.helperAssembly = {
    bytes: helperBytes.length,
    file: spec.toolchain.anchor.helperAssembly.file,
    sha256: sha256(helperBytes),
  };
  const specBytes = canonicalBytes(spec);
  const specFile = join(workspaceRoot, "fixture-rebuild-spec.json");
  const sourcePath = workspacePath(spec.source.archive.file);
  const vendorPath = workspacePath(spec.source.vendor.archive.file);
  const manifestPath = workspacePath(spec.toolchain.manifest.file);
  const preservedPath = workspacePath(spec.binaries.preserved.file);
  const helperPath = workspacePath(spec.toolchain.anchor.helperAssembly.file);
  const outputPath = workspacePath(spec.receipt.file);
  const foreignSourcePath = join(workspaceRoot, "foreign-source.tar");
  const foreignVendorPath = join(workspaceRoot, "foreign-vendor.tar");
  for (const path of [sourcePath, vendorPath, manifestPath, preservedPath, helperPath, outputPath,
    workspacePath(spec.binaries.rebuilt.file), workspacePath(spec.provenance.file)]) {
    await mkdir(dirname(path), { recursive: true });
  }
  await Promise.all([
    writeFile(specFile, specBytes, { flag: "wx" }),
    writeFile(sourcePath, source.bytes, { flag: "wx" }),
    writeFile(vendorPath, vendor.bytes, { flag: "wx" }),
    writeFile(manifestPath, manifestBytes, { flag: "wx" }),
    writeFile(preservedPath, preservedBytes, { flag: "wx" }),
    copyFile(HELPER_PATH, helperPath),
    writeFile(foreignSourcePath, foreignSource.bytes, { flag: "wx" }),
    writeFile(foreignVendorPath, foreignVendor.bytes, { flag: "wx" }),
  ]);
  const authorityEnvironment = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: spec.authority.event,
    GITHUB_REF: spec.authority.requiredRef,
    GITHUB_REF_PROTECTED: "true",
    GITHUB_REPOSITORY: spec.authority.repository,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "424242",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW_REF: `${spec.authority.repository}/${spec.authority.workflowFile}@${spec.authority.requiredRef}`,
    RUNNER_ARCH: "X64",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Windows",
    ZUGFOLGE_REBUILD_RUNNER_IMAGE: spec.authority.runnerImages[0],
  };
  const previousEnvironment = new Map(Object.keys(authorityEnvironment).map((name) => [name, process.env[name]]));
  Object.assign(process.env, authorityEnvironment);
  t.after(() => {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return {
    foreignSourcePath,
    foreignSourceBytes: foreignSource.bytes,
    foreignVendorPath,
    foreignVendorBytes: foreignVendor.bytes,
    outputPaths: [
      workspacePath(spec.binaries.rebuilt.file),
      workspacePath(spec.provenance.file),
      outputPath,
    ],
    sourcePath,
    sourceBytes: source.bytes,
    sourceData,
    vendorPath,
    vendorBytes: vendor.bytes,
    workspaceRoot,
    specFile,
    materialize: (hooks, callerWorkspaceRoot = workspaceRoot) => {
      const callerPath = (path) => resolve(callerWorkspaceRoot, relative(workspaceRoot, path));
      return materializeOperationalValidatorRebuildEvidence({
        hooks,
        outputPath: callerPath(outputPath),
        producerProofs: spec.producer,
        runnerAnchorHelperProof: spec.toolchain.anchor.helperAssembly,
        spec,
        specBytes,
        specFile: callerPath(specFile),
        workspaceRoot: callerWorkspaceRoot,
      });
    },
  };
}

function isWindowsHeldMutationError(error) {
  return /^(?:EACCES|EBUSY|EPERM)$/u.test(error?.code ?? "");
}

test("Annual-Rebuild-Spec v3 ist kanonisch und vollstaendig gepinnt", async () => {
  const { bytes, value: spec } = await loadProductionSpec();
  assert.ok(bytes.equals(canonicalBytes(spec)));
  assert.equal(validateOperationalValidatorRebuildSpec(spec), spec);
  assert.equal(spec.schema, "zugfolge-operational-validator-rebuild-spec/v3");
  assert.deepEqual(Object.keys(spec.producer).sort(), ["bundle", "entrypoint", "executionPins", "implementation"]);
  assert.deepEqual(spec.authority.attestation.subjects, [
    spec.binaries.rebuilt.file,
    spec.provenance.file,
    spec.receipt.file,
    spec.binaries.preserved.file,
    spec.authority.annualExecutorPlan.directContractFile,
    spec.authority.annualExecutorPlan.planFile,
    `${spec.authority.annualExecutorPlan.planFile}.zugfolge-complete.json`,
    spec.authority.annualExecutorPlan.startEvidenceFile,
    `${spec.authority.annualExecutorPlan.startEvidenceFile}.zugfolge-complete.json`,
  ]);
  assert.equal(spec.authority.artifactAttestation, "github-sigstore-build-provenance-required-v1");
  assert.equal(spec.authority.attestation.verification.denySelfHostedRunners, true);
  assert.equal(spec.toolchain.platform, "win32");
  assert.equal(spec.toolchain.anchor.helperAssembly.file, "tools/region-import/germany/operational-windows-anchor-helper.dll");
  assert.deepEqual(spec.build.command.slice(0, 5), ["cargo", "--config", "$PINNED_CARGO_CONFIG", "build", "--manifest-path"]);
  assert.ok(spec.build.command.includes("--locked"));
  assert.ok(spec.build.command.includes("--offline"));
  assert.deepEqual(spec.build.environmentPolicy.allowedInherited, []);
  assert.equal(spec.build.environmentPolicy.fixed.CARGO_NET_OFFLINE, "true");
  assert.equal(spec.build.environmentPolicy.fixed.CARGO_ENCODED_RUSTFLAGS,
    "--remap-path-prefix=$HELD_VENDOR_ROOT=$ANNUAL_VENDOR_REMAP_PREFIX");
  const [implementation, helper] = await Promise.all([readFile(IMPLEMENTATION_PATH), readFile(HELPER_PATH)]);
  assert.deepEqual(spec.producer.implementation, {
    bytes: implementation.length,
    file: "tools/region-import/germany/operational-validator-rebuild-evidence.mjs",
    sha256: sha256(implementation),
  });
  assert.deepEqual(spec.toolchain.anchor.helperAssembly, {
    bytes: helper.length,
    file: "tools/region-import/germany/operational-windows-anchor-helper.dll",
    sha256: sha256(helper),
  });
});

test("Spec-Validator lehnt Trust-, Dependency-, Plattform- und Producer-Drift fail-closed ab", async (t) => {
  const { value: production } = await loadProductionSpec();
  const cases = [
    ["v2-Schema", (spec) => { spec.schema = "zugfolge-operational-validator-rebuild-spec/v2"; }],
    ["zusaetzlicher Bootstrap-Producer", (spec) => { spec.producer.bootstrap = spec.producer.bundle; }],
    ["fremde Authority", (spec) => { spec.authority.repository = "attacker/Zugfolge"; }],
    ["umgeordnete Attestation-Subjects", (spec) => { spec.authority.attestation.subjects.reverse(); }],
    ["fehlendes offline", (spec) => { spec.build.command = spec.build.command.filter((entry) => entry !== "--offline"); }],
    ["ambienter CARGO_HOME", (spec) => { spec.build.environmentPolicy.allowedInherited = ["CARGO_HOME"]; }],
    ["Linux-Materialisierung", (spec) => { spec.toolchain.platform = "linux"; }],
    ["POSIX-Toolchain-Root", (spec) => { spec.toolchain.root = "/tmp/toolchain"; }],
    ["laufwerksrelativer Toolchain-Root", (spec) => { spec.toolchain.root = String.raw`C:toolchain`; }],
    ["UNC-Toolchain-Root", (spec) => { spec.toolchain.root = String.raw`\\server\share\toolchain`; }],
    ["ignorierter Helper", (spec) => { spec.toolchain.anchor.helperAssembly.file = "var/operational-windows-anchor-helper.dll"; }],
    ["Receipt-Subject-Drift", (spec) => { spec.receipt.file = "var/derived/germany-2026.5/toolchain/other-receipt.json"; }],
    ["freies Rustflag", (spec) => { spec.build.environmentPolicy.fixed.CARGO_ENCODED_RUSTFLAGS = "-Ctarget-cpu=native"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const spec = clone(production);
      mutate(spec);
      assert.throws(() => validateOperationalValidatorRebuildSpec(spec));
    });
  }
});

test("falscher Receipt-Pfad scheitert vor jeder Archiv-, Claim- oder Publikationswirkung", async (t) => {
  const workspaceRoot = await temporaryDirectory(t);
  const { bytes: specBytes, value: spec } = await loadProductionSpec();
  const before = await readdir(workspaceRoot);
  await assert.rejects(materializeOperationalValidatorRebuildEvidence({
    outputPath: join(workspaceRoot, "wrong-receipt.json"),
    producerProofs: spec.producer,
    runnerAnchorHelperProof: spec.toolchain.anchor.helperAssembly,
    spec,
    specBytes,
    specFile: PRODUCTION_SPEC_PATH,
    workspaceRoot,
  }), /outputPath driftet/);
  assert.deepEqual(await readdir(workspaceRoot), before);
});

test("workspaceRoot-Ahnenalias wird kanonisch gebunden, waehrend Root- und Kind-Junctions sowie Alias-Tausch scheitern", async (t) => {
  const container = await temporaryDirectory(t, "zfrbworkspacealias");
  const actualParent = join(container, "actual-parent");
  const foreignParent = join(container, "foreign-parent");
  const workspaceRoot = join(actualParent, "workspace");
  const foreignWorkspace = join(foreignParent, "workspace");
  await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(foreignWorkspace, { recursive: true })]);
  const aliasParent = join(container, "alias-parent");
  const directRootAlias = join(container, "direct-root-alias");
  const descendantTarget = join(container, "descendant-target");
  const descendantAlias = join(workspaceRoot, "descendant-alias");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await Promise.all([mkdir(descendantTarget), symlink(actualParent, aliasParent, linkType), symlink(workspaceRoot, directRootAlias, linkType)]);
  await symlink(descendantTarget, descendantAlias, linkType);
  for (const path of [aliasParent, directRootAlias, descendantAlias]) {
    t.after(async () => {
      try { await unlink(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    });
  }
  const aliasWorkspaceRoot = join(aliasParent, "workspace");
  const workspaceApi = await loadCanonicalWorkspaceForTest();
  const snapshot = await workspaceApi.snapshot(aliasWorkspaceRoot, "workspaceRoot");
  assert.equal(resolve(snapshot.path), resolve(workspaceRoot));
  assert.equal(
    resolve(workspaceApi.mapPath(snapshot, join(aliasWorkspaceRoot, "mapped", "file.json"), "mappedPath")),
    resolve(workspaceRoot, "mapped", "file.json"),
  );
  assert.equal(
    resolve(workspaceApi.mapPath(snapshot, join(workspaceRoot, "canonical", "receipt.json"), "canonicalPath")),
    resolve(workspaceRoot, "canonical", "receipt.json"),
  );
  await workspaceApi.assertSnapshot(snapshot, "workspaceRoot");
  await assert.rejects(workspaceApi.snapshot(directRootAlias, "workspaceRoot"), /darf selbst kein Symlink\/Junction sein/u);
  await assert.rejects(
    workspaceApi.assertNoSymlinkPath(workspaceRoot, join(descendantAlias, "missing.txt"), "Kindpfad", { leafMayBeMissing: true }),
    /Symlink\/Junction/u,
  );

  await unlink(aliasParent);
  await symlink(foreignParent, aliasParent, linkType);
  await assert.rejects(workspaceApi.assertSnapshot(snapshot, "workspaceRoot"), /fremd ersetzt|umgebunden/u);
});

test("workspaceRoot-Ahnenalias erreicht die kanonische Windows-Materialisierungsgrenze ohne Outputs", WINDOWS_ONLY, async (t) => {
  const container = await temporaryDirectory(t, "zfrbworkspaceanchoralias");
  const actualParent = join(container, "actual-parent");
  const workspaceRoot = join(actualParent, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const fixture = await materializationTarSwapFixture(t, workspaceRoot);
  const aliasParent = join(container, "alias-parent");
  await symlink(actualParent, aliasParent, "junction");
  t.after(async () => {
    try { await unlink(aliasParent); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  });
  const aliasWorkspaceRoot = join(aliasParent, "workspace");
  await assert.rejects(fixture.materialize({
    beforeWindowsBuildAnchor: ({ paths }) => {
      for (const path of Object.values(paths)) {
        const value = relative(workspaceRoot, path);
        assert.ok(value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value),
          `Ankerinput blieb nicht unter dem kanonischen workspaceRoot: ${path}`);
      }
      throw new Error("TEST_STOP_AFTER_CANONICAL_WORKSPACE_BINDING");
    },
  }, aliasWorkspaceRoot), /TEST_STOP_AFTER_CANONICAL_WORKSPACE_BINDING/u);
  for (const output of fixture.outputPaths) await assert.rejects(readFile(output), { code: "ENOENT" });
});

test("specBytes muessen aus genau der identity-sicher gelesenen Rebuild-Spec stammen", async (t) => {
  const fixture = await materializationTarSwapFixture(t);
  await writeFile(fixture.specFile, canonicalBytes({ schema: "foreign-rebuild-spec/v1" }));
  await assert.rejects(fixture.materialize({}), /specBytes driftet von der identity-sicher gelesenen Rebuild-Spec/u);
  for (const output of fixture.outputPaths) await assert.rejects(readFile(output), { code: "ENOENT" });
});

test("releasefaehige Materialisierung enthaelt weder externes git/tar/rustup noch Add-Type", async () => {
  const source = await readFile(IMPLEMENTATION_PATH, "utf8");
  assert.doesNotMatch(source, /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'](?:git|tar|rustup)(?:\.exe)?["']/u);
  assert.doesNotMatch(source, /git archive|get-tar-commit-id|\btar\.exe\b|\bAdd-Type\b/u);
  for (const required of [
    "NtCreateFile", "CreateProtectedDirectory", "S-1-3-4", "AssertFrozenDirectoryEntry",
    "ReadDirectoryChangesW-Overflow", "RunAs(", "RunStrict(", "CreateProcessWithLogonW", "PROC_THREAD_ATTRIBUTE_HANDLE_LIST",
    "PROC_THREAD_ATTRIBUTE_PARENT_PROCESS", "DuplicateInheritableToProcess",
    "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE", "pending-external-verification", "runnerAnchorHelperProof",
    "DELETE_EPHEMERAL_ACCOUNT", "Delete-EphemeralAccountBeforeResult", "PUBLICATION_COMPLETE", "PUBLICATION_COMMITTED",
    "TerminateJobObject(post-root descendants)", "PublishHeldCreateNew",
    "MarkRegularFileDeletePending", "ZugfolgeAnnualArtifactPublisher", "PublishPair(",
    "PublishOrRecoverPair(", "VerifyPair(",
  ]) assert.ok(source.includes(required), `Rebuild-v3-Implementierung bindet ${required} nicht.`);
  for (const forbidden of ["link(", "rename(", "unlink(", "rmdir(", "mkdtemp("]) {
    assert.ok(!source.includes(forbidden), `Rebuild-v3-Implementierung enthaelt weiterhin pfadbasierte Wirkung ${forbidden}.`);
  }
  assert.doesNotMatch(source, /\$held\.Add\(\$published\)/u,
    "Publikationshandles duerfen nicht gemeinsam mit falliblen Pre-Commit-Ressourcen geschlossen werden.");
  assert.doesNotMatch(source, /Close-HeldBeforePublicationCommit/u,
    "Ahnen-, Parent- und Inputhandles duerfen nicht vor der Commitentscheidung geschlossen werden.");
  assert.match(source,
    /\$isolationPrincipalSidSha256 = Hash-Text \$account\.Sid\s+\$script:anchorStage = 'DELETE_EPHEMERAL_ACCOUNT'\s+Delete-EphemeralAccountBeforeResult \$account\s+\$account = \$null\s+\$result =[\s\S]*?\$script:anchorStage = 'PUBLISH_OUTPUTS'/u,
    "Der ephemere Account muss verifiziert geloescht sein, bevor RESULT eine finale Publikation ermoeglicht.");
  assert.match(source,
    /\$script:anchorStage = 'COMMIT_PUBLICATION'\s+Commit-Published\s+\$publicationCommitted = \$true[\s\S]*?'PUBLICATION_COMMITTED '/u,
    "Die gehaltenen Publikationsbeweise muessen vor der expliziten Commit-Bestaetigung committed sein.");
  const commitFunction = /function Commit-Published \{(?<body>[\s\S]*?)\n\}/u.exec(source);
  assert.ok(commitFunction?.groups?.body, "Commit-Published wurde nicht eindeutig gefunden.");
  assert.doesNotMatch(commitFunction.groups.body, /publishedStreams\.Clear/u,
    "Committed FileStreams muessen bis zur Prozessgrenze stark gehalten bleiben.");
  assert.match(source,
    /function resolveWindowsAnchorCommitAcknowledgement[\s\S]*?sameCanonicalValue\(acknowledgement, publicationEnvelope\)[\s\S]*?status: "requires-exact-recovery"[\s\S]*?nextLineWithin\("Windows-Build-Anker-Commit-Bestaetigung", WINDOWS_ANCHOR_COMMIT_ACK_TIMEOUT_MS\)[\s\S]*?status: "commit-decision-requires-exact-recovery"[\s\S]*?"committed-anchor-reaped" : "committed-clean-exit"/u,
    "Der Parent muss die exakte Commit-Bestaetigung binden und einen spaeten Anchor-Abschluss eindeutig aufloesen.");
  assert.match(source,
    /await buildAnchor\.completePublication\(\)[\s\S]*?Output-Elternverzeichnis nach Anchor-Abschluss[\s\S]*?Post-Anchor \$\{id\}[\s\S]*?matchesFilesystemIdentity\(snapshot\.identity, publicationProofs\[id\]\.identity\)[\s\S]*?postAnchorVerification/u,
    "Jeder Commit-Ausgang muss nach dem Prozessende erneut gegen Parent, File-ID, Bytes, Hash und Receipt geprueft werden.");
  assert.match(source, /\} finally \{\s+if \(-not \$publicationCommitted\) \{[\s\S]*?Rollback-Published[\s\S]*?\$held\[\$index\]\.Dispose\(\)/u,
    "Nach dem Commit darf der Anchor keinen bewusst falliblen Cleanup mehr ausfuehren.");
});

test("Dateien erhalten die finale DACL atomar und werden nach Schliessen des create-new Handles nur-lesbar gehalten", async () => {
  const source = await readFile(IMPLEMENTATION_PATH, "utf8");
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
    /ReadExecute\(string currentSid, string buildSid\)[\s\S]*\(D;;0x" \+ denied\.ToString\("x8"\) \+ ";;;" \+ currentSid \+ "\)"[\s\S]*\(A;;0x001200a9;;;" \+ currentSid \+ "\)"[\s\S]*\(A;;0x001200a9;;;" \+ buildSid \+ "\)"/u);
  assert.doesNotMatch(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
    /FreezeReadExecute|SetSecurityInfo|GetSecurityDescriptorDacl/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
    /access \| 0x00100080u/u,
    "Negativproben muessen SYNCHRONIZE und FILE_READ_ATTRIBUTES fuer einen eindeutigen unerwarteten Erfolg anfordern.");
  assert.match(source,
    /function Extract-AuditedPlan[\s\S]*CreateProtectedRegularFile\([^\n]*\$securityDescriptor\)[\s\S]*\$output\.Flush\(\$true\)[\s\S]*\$output\.Dispose\(\)[\s\S]*AssertProtectedDacl\([^\n]*\)[\s\S]*Open-HeldRelativeFile[^\n]*nach atomarem DACL-Create/u);
  assert.match(source,
    /function Copy-HeldFile[\s\S]*CreateProtectedRegularFile\([^\n]*\$securityDescriptor\)[\s\S]*\$output\.Flush\(\$true\)[\s\S]*\$output\.Dispose\(\)[\s\S]*AssertProtectedDacl\([^\n]*\)[\s\S]*Open-HeldRelativeFile[^\n]*nach atomarem DACL-Create/u);
  assert.match(source,
    /function Reopen-FrozenDirectoryRelative[\s\S]*\$createHandle\.Dispose\(\)[\s\S]*Open-HeldDirectoryRelative[\s\S]*Identity\(\$reopened\) -cne \$expectedIdentity/u);
  assert.match(source,
    /function Reopen-FrozenHeldTreeDirectories[\s\S]*IsNullOrEmpty[\s\S]*Reopen-FrozenDirectoryRelative/u);
  assert.match(source,
    /function Verify-FrozenHeldTree[\s\S]*Assert-ExactHeldTree[\s\S]*Reopen-FrozenHeldTreeDirectories[\s\S]*AssertFrozenDirectoryEntry[\s\S]*AssertFrozenEntry/u);
});

test("TAR-Audit liefert nur gepinnte regulaere Dateislices als Extraktionsplan", async () => {
  const audit = await loadTarAuditForTest();
  const fixture = tarFixture([
    { data: Buffer.from("lock-v1\n", "utf8"), file: "Cargo.lock" },
    { data: Buffer.from("fn main() {}\n", "utf8"), file: "src/main.rs" },
  ]);
  const result = auditFixture(audit, fixture, { requiredFile: fixture.manifest[0] });
  assert.deepEqual(result.manifest, fixture.manifest);
  assert.deepEqual(result.extractedTree, fixture.tree);
  assert.deepEqual(result.required, fixture.manifest[0]);
  assert.deepEqual(result.files.map(({ bytes, file, sha256: hash }) => ({ bytes, file, sha256: hash })), fixture.manifest);
  for (const entry of result.files) {
    const slice = fixture.bytes.subarray(entry.offset, entry.offset + entry.bytes);
    assert.equal(sha256(slice), entry.sha256);
  }
});

test("TAR-Audit verwirft Bytezahl- und SHA-256-Drift vor jeder Extraktionsplanung", async () => {
  const audit = await loadTarAuditForTest();
  const fixture = tarFixture([{ data: Buffer.from("lock-v1\n", "utf8"), file: "Cargo.lock" }]);
  for (const archive of [
    { bytes: fixture.bytes.length + 1, sha256: sha256(fixture.bytes) },
    { bytes: fixture.bytes.length, sha256: "f".repeat(64) },
  ]) {
    assert.throws(() => auditFixture(audit, fixture, { archive }), /driftet vom Spec-Pin/u);
  }
});

test("TAR-Audit verwirft Traversalpfade vor jeder Extraktionsplanung", async () => {
  const audit = await loadTarAuditForTest();
  for (const file of ["../escape", "src/../../escape", "./Cargo.lock", "src/./main.rs"]) {
    const fixture = tarFixture([{ data: Buffer.from("escape\n", "utf8"), file }]);
    assert.throws(() => auditFixture(audit, fixture), /sicherer relativer POSIX-Dateipfad/u);
  }
});

test("TAR-Audit verwirft absolute POSIX-, Laufwerks- und UNC-Pfade", async () => {
  const audit = await loadTarAuditForTest();
  for (const file of ["/absolute/Cargo.lock", "C:/absolute/Cargo.lock", "\\\\server\\share\\Cargo.lock"]) {
    const fixture = tarFixture([{ data: Buffer.from("escape\n", "utf8"), file }]);
    assert.throws(() => auditFixture(audit, fixture), /sicherer relativer POSIX-Dateipfad/u);
  }
});

test("TAR-Audit verwirft Links, Geraete und unbekannte Typen", async () => {
  const audit = await loadTarAuditForTest();
  const forbidden = [
    { file: "hardlink", link: "Cargo.lock", type: "1" },
    { file: "symlink", link: "Cargo.lock", type: "2" },
    { file: "character-device", type: "3" },
    { file: "block-device", type: "4" },
    { file: "fifo", type: "6" },
    { file: "unknown", type: "7" },
  ];
  for (const entry of forbidden) {
    const fixture = tarFixture([entry]);
    assert.throws(() => auditFixture(audit, fixture), /unerwartetes Linkziel|verbotenen Eintragstyp/u);
  }
});

test("TAR-Audit verwirft Doppelteintraege und Windows-Pfadkollisionen", async () => {
  const audit = await loadTarAuditForTest();
  for (const files of [["Cargo.lock", "Cargo.lock"], ["Cargo.lock", "cargo.LOCK"]]) {
    const fixture = tarFixture(files.map((file, index) => ({ data: Buffer.from(`lock-${index}\n`, "utf8"), file })));
    assert.throws(() => auditFixture(audit, fixture), /doppelten oder kollidierenden Datei- oder Verzeichniseintrag/u);
  }
});

test("gehaltener TAR-Handle verhindert unbemerkten Pfadtausch im Pruef-Extraktionsfenster", async (t) => {
  const audit = await loadTarAuditForTest();
  const root = await temporaryDirectory(t, "zugfolge-rebuild-tar-swap-");
  const archivePath = join(root, "source.tar");
  const displacedPath = join(root, "source-held.tar");
  const original = tarFixture([{ data: Buffer.from("held-lock\n", "utf8"), file: "Cargo.lock" }]);
  const replacement = tarFixture([{ data: Buffer.from("foreign\n", "utf8"), file: "../foreign" }]);
  await writeFile(archivePath, original.bytes);
  const handle = await open(archivePath, "r");
  try {
    const metadata = await handle.stat();
    const heldBytes = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(heldBytes, 0, heldBytes.length, 0);
    assert.equal(bytesRead, heldBytes.length);
    const plan = auditFixture(audit, { ...original, bytes: heldBytes });

    await rename(archivePath, displacedPath);
    await writeFile(archivePath, replacement.bytes);

    for (const entry of plan.files) {
      const slice = Buffer.alloc(entry.bytes);
      const read = await handle.read(slice, 0, slice.length, entry.offset);
      assert.equal(read.bytesRead, slice.length);
      assert.equal(sha256(slice), entry.sha256);
      assert.equal(slice.toString("utf8"), "held-lock\n");
    }
    assert.throws(() => auditFixture(audit, replacement), /sicherer relativer POSIX-Dateipfad/u);
    assert.ok((await readFile(displacedPath)).equals(original.bytes));
    assert.ok((await readFile(archivePath)).equals(replacement.bytes));
  } finally {
    await handle.close();
  }
});

test("echte Materialisierung stoppt am Audit-Hook ohne TAR-Pfadtausch oder Extraktionswirkung",
  WINDOWS_ONLY, async (t) => {
    const fixture = await materializationTarSwapFixture(t);
    let stagingRoot;
    let sourceRenameError;
    let vendorWriteError;
    await assert.rejects(fixture.materialize({
      afterPinnedInputAuditBeforeExtraction: async (value) => {
        stagingRoot = value.stagingRoot;
        try { await rename(fixture.sourcePath, `${fixture.sourcePath}.displaced-after-audit`); }
        catch (error) { sourceRenameError = error; }
        try { await writeFile(fixture.vendorPath, fixture.foreignVendorBytes); }
        catch (error) { vendorWriteError = error; }
        throw new Error("TEST_STOP_AFTER_PINNED_TAR_AUDIT");
      },
    }), /TEST_STOP_AFTER_PINNED_TAR_AUDIT/u);
    assert.ok(isWindowsHeldMutationError(sourceRenameError), `Source-TAR-Rename war nicht gehalten: ${sourceRenameError}`);
    assert.ok(isWindowsHeldMutationError(vendorWriteError), `Vendor-TAR-Write war nicht gehalten: ${vendorWriteError}`);
    assert.ok((await readFile(fixture.sourcePath)).equals(fixture.sourceBytes));
    assert.ok((await readFile(fixture.vendorPath)).equals(fixture.vendorBytes));
    await assert.rejects(readdir(stagingRoot), { code: "ENOENT" });
    for (const output of fixture.outputPaths) await assert.rejects(readFile(output), { code: "ENOENT" });
  });

test("Windows-Anker verweigert Rename/Write exakt vor der Extraktion und extrahiert keine Fremdbytes",
  WINDOWS_ONLY, async (t) => {
    const fixture = await materializationTarSwapFixture(t);
    let audited = false;
    let stagingRoot;
    let sourceWriteError;
    let vendorRenameError;
    let parentRenameError;
    await assert.rejects(fixture.materialize({
      afterPinnedInputAuditBeforeExtraction: ({ stagingRoot: value }) => {
        audited = true;
        stagingRoot = value;
      },
      beforeWindowsAnchoredExtraction: async ({ buildRoot }) => {
        assert.equal(audited, true, "Windows-Extraktionshook lief vor dem vollstaendigen TAR-Audit.");
        assert.equal(resolve(buildRoot), resolve(stagingRoot));
        try { await writeFile(fixture.sourcePath, fixture.foreignSourceBytes); }
        catch (error) { sourceWriteError = error; }
        try { await rename(fixture.vendorPath, `${fixture.vendorPath}.displaced-before-extraction`); }
        catch (error) { vendorRenameError = error; }
        const parent = dirname(fixture.sourcePath);
        try { await rename(parent, `${parent}.displaced-before-extraction`); }
        catch (error) { parentRenameError = error; }
        throw new Error("TEST_STOP_AT_WINDOWS_ANCHORED_EXTRACTION");
      },
    }), /TEST_STOP_AT_WINDOWS_ANCHORED_EXTRACTION/u);
    assert.ok(isWindowsHeldMutationError(sourceWriteError), `Source-TAR-Write war nicht gehalten: ${sourceWriteError}`);
    assert.ok(isWindowsHeldMutationError(vendorRenameError), `Vendor-TAR-Rename war nicht gehalten: ${vendorRenameError}`);
    assert.ok(isWindowsHeldMutationError(parentRenameError), `TAR-Parent-Rename war nicht gehalten: ${parentRenameError}`);
    assert.ok((await readFile(fixture.sourcePath)).equals(fixture.sourceBytes));
    assert.ok((await readFile(fixture.vendorPath)).equals(fixture.vendorBytes));
    await assert.rejects(readdir(stagingRoot), { code: "ENOENT" });
    for (const output of fixture.outputPaths) await assert.rejects(readFile(output), { code: "ENOENT" });
  });

test("USER_INFO_1-Einmalaccount bindet den dokumentierten minimalen normalen Benutzervertrag", async () => {
  const implementation = await readFile(IMPLEMENTATION_PATH, "utf8");
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /private const uint ERROR_INVALID_PARAMETER = 87u;/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /private const uint NERR_USER_NOT_FOUND = 2221u;/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /private const uint USER_PRIV_USER = 1u;/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /private const uint UF_SCRIPT = 0x00000001u;/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /private const uint UF_NORMAL_ACCOUNT = 0x00000200u;/u);
  assert.match(
    WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
    /Privilege = USER_PRIV_USER,[\s\S]*Flags = UF_SCRIPT \| UF_NORMAL_ACCOUNT, ScriptPath = null/u,
  );
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /GetTokenInformation\(identity\.Token, 20/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /new WindowsPrincipal\(identity\)\.IsInRole\(WindowsBuiltInRole\.Administrator\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /uint lookup = NetUserGetInfo\(null, Username, 0, out buffer\);/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /lookup != NERR_USER_NOT_FOUND/u);
  assert.doesNotMatch(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /UF_PASSWD_CANT_CHANGE|UF_DONT_EXPIRE_PASSWD/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /if \(result == ERROR_INVALID_PARAMETER\) diagnostic \+= " parameter="/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /private const uint LOGON_WITHOUT_PROFILE = 0u;/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /private static extern bool CreateProcessWithLogonW\(/u);
  assert.doesNotMatch(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /CreateProcessWithTokenW|CreateProcessAsUserW/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /PROC_THREAD_ATTRIBUTE_PARENT_PROCESS = new IntPtr\(0x00020000\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /int attributeCount = 3;/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /bInheritHandle = 0/u);
  assert.doesNotMatch(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /SetHandleInformation/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /AssertNotInheritable\(childIn, "child-stdin"\);[\s\S]*AssertNotInheritable\(sentinelParent, "sentinel-parent"\);/u);
  assert.match(
    WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
    /remoteChildIn = DuplicateInheritableToProcess\(anchor\.hProcess, childIn, "stdin"\);[\s\S]*remoteChildOut = DuplicateInheritableToProcess\(anchor\.hProcess, childOut, "stdout"\);[\s\S]*remoteChildErr = DuplicateInheritableToProcess\(anchor\.hProcess, childErr, "stderr"\);[\s\S]*remoteSentinel = DuplicateInheritableToProcess\(anchor\.hProcess, sentinelChild, "sentinel"\);/u,
  );
  assert.match(
    WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
    /UpdateProcThreadAttribute\(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,[\s\S]*new IntPtr\(IntPtr\.Size \* 3\)/u,
  );
  assert.match(
    WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
    /Marshal\.WriteIntPtr\(handleList, 0, remoteChildIn\); Marshal\.WriteIntPtr\(handleList, IntPtr\.Size, remoteChildOut\); Marshal\.WriteIntPtr\(handleList, IntPtr\.Size \* 2, remoteChildErr\);/u,
  );
  assert.match(
    WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
    /Marshal\.WriteIntPtr\(parentProcess, anchor\.hProcess\);[\s\S]*UpdateProcThreadAttribute\(attributes, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, parentProcess, new IntPtr\(IntPtr\.Size\)/u,
  );
  assert.match(
    WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
    /CreateProcessWithLogonW\(account\.Username, account\.Domain, account\.Password, LOGON_WITHOUT_PROFILE,[\s\S]*CREATE_SUSPENDED[\s\S]*IntPtr\.Zero, cwd, ref anchorStartup, out anchor\)/u,
  );
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /CreateProcessWBasic\(anchorExecutable, anchorCommand, IntPtr\.Zero, IntPtr\.Zero, false,[\s\S]*env, cwd, ref anchorStartup, out anchor\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /CreateProcessW\(executable, command, IntPtr\.Zero, IntPtr\.Zero, true, flags, env, cwd, ref startup, out process\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_WITH_LOGON status=/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_FROM_ANCHOR status=/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /AssertAllowedHandleInherited\(process\.hProcess, remoteChildIn, childIn, "stdin"\);[\s\S]*AssertAllowedHandleInherited\(process\.hProcess, remoteChildOut, childOut, "stdout"\);[\s\S]*AssertAllowedHandleInherited\(process\.hProcess, remoteChildErr, childErr, "stderr"\);/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /AssertSentinelNotInherited\(process\.hProcess, remoteSentinel, sentinelChild\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /DuplicateHandle\(process, candidate, GetCurrentProcess\(\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /CompareObjectHandles\(sentinel, duplicate\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /status != ERROR_INVALID_HANDLE/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /string expectedSid = account == null \? ProcessSid\(GetCurrentProcess\(\)\) : account\.Sid;/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /AssertProcessSid\(anchor\.hProcess, expectedSid\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /AssertProcessSid\(process\.hProcess, expectedSid\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /AssertMitigationPolicy\(process\.hProcess, imageLoadPolicy\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /AssertProcessInJob\(process\.hProcess, job\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /GetProcessMitigationPolicy\(process, 10/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /GetProcessMitigationPolicy\(process, 8/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
    /created = CreateProcessW\([\s\S]*AssertSentinelNotInherited\(process\.hProcess, remoteSentinel, sentinelChild\);[\s\S]*AssertMitigationPolicy\(process\.hProcess, imageLoadPolicy\);[\s\S]*AssertProcessInJob\(process\.hProcess, job\);[\s\S]*TerminateProcess\(anchor\.hProcess, 98\)[\s\S]*ResumeThread\(process\.hThread\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /List<string> cleanupErrors = new List<string>\(\);[\s\S]*EnsureProcessTerminated\(process\.hProcess, "payload", cleanupErrors\);[\s\S]*EnsureProcessTerminated\(anchor\.hProcess, "anchor", cleanupErrors\);[\s\S]*WaitForJobEmptyStatus\(job, 5000, "cleanup"\)[\s\S]*if \(cleanupErrors\.Count > 0\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /TerminateJobObject\(job, 96\)[\s\S]*CloseRequired\(ref process\.hThread, "payload-thread"\); CloseRequired\(ref process\.hProcess, "payload-process"\);[\s\S]*AssertJobEmpty\(job, 5000, "post-root"\);[\s\S]*processCompleted = true;/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /if \(sorted\.Count == 0\) block\.Append\('\\0'\);[\s\S]*block\.Append\('\\0'\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /long remaining = timeoutMilliseconds - clock\.ElapsedMilliseconds;[\s\S]*WaitForSingleObject\(process\.hProcess, \(uint\)Math\.Min\(25L, remaining\)\)/u);
  assert.match(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, /catch \(Exception error\) \{[\s\S]*primaryError = error;[\s\S]*throw;[\s\S]*throw new AggregateException\("Windows-Kindprozess- und Cleanupfehler traten gemeinsam auf\.", primaryError, cleanupError\)/u);
  assert.match(implementation, /'HOMEDRIVE' = 'C:'/u);
  assert.match(implementation, /'HOMEPATH' = '\\Windows\\System32'/u);
  assert.match(implementation, /'PROMPT' = '\$P\$G'/u);
  assert.match(implementation, /if \(\$diagnostic -match '\^ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=\(PROCESS_WITH_LOGON\|PROCESS_FROM_ANCHOR\) status=/u);
  assert.equal((implementation.match(/windowsBuildAnchorSafeDiagnostic\(stderr\)/gu) ?? []).length, 6,
    "Handshake, Extraktion, Build-Fallback, Ergebnis-, Publikations- und Abschlussfehler muessen dieselbe sichere Diagnose verwenden.");
  assert.doesNotMatch(implementation, /Buffer\.concat\(stderr\)\.toString/u);
  assert.doesNotMatch(implementation, /const details = Buffer\.concat\(stderr\)[\s\S]{0,160}Windows-Build-Anker lieferte kein Ergebnis/u);
  assert.match(implementation, /if \(\$disposeErrors\.Count -gt 0\) \{[\s\S]{0,500}Write-SafeAnchorStageDiagnostic[\s\S]{0,80}exit 125/u);
  assert.equal((implementation.match(/identity-anchor-parent-handle-list-no-local-inherit-no-low-label-prefer-system32-job-empty-v4/gu) ?? []).length, 2);
});

test("extract-Diagnose gibt nur die begrenzte nicht-geheime Anchor-Allowlist frei", async () => {
  const diagnose = await loadWindowsBuildAnchorSafeDiagnosticForTest();
  const safe = "ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_ADD status=87 parameter=0";
  const safeStage = "ZUGFOLGE_SAFE_ANCHOR_STAGE_DIAGNOSTIC stage=FREEZE_SOURCE";
  assert.equal(diagnose([Buffer.from(`password=Zf!never-surface\n${safe}\n`, "utf8")]), safe);
  assert.equal(diagnose([Buffer.from(`password=Zf!never-surface\n${safeStage}\n`, "utf8")]), safeStage);
  const safePreCommitStage = "ZUGFOLGE_SAFE_ANCHOR_STAGE_DIAGNOSTIC stage=DELETE_EPHEMERAL_ACCOUNT";
  assert.equal(diagnose([Buffer.from(`hostile-secret-path=C:\\private\\input\n${safePreCommitStage}\n`, "utf8")]), safePreCommitStage);
  assert.equal(diagnose([Buffer.from(`${safe}\n${safeStage}\n`, "utf8")]), safe,
    "Ein genauer numerischer Account-/Prozessstatus muss den groben Stage-Fallback schlagen.");
  assert.equal(diagnose([Buffer.from(`${"hostile-secret-path=".repeat(40)}\n${safeStage}\n`, "utf8")]), safeStage,
    "Die letzte feste Stage-Zeile muss trotz eines mehr als 512 Bytes langen fremden Fehlers erhalten bleiben.");
  assert.equal(diagnose([Buffer.from(`${safeStage}\n${"hostile-secret-path=".repeat(40)}\n`, "utf8")]), "",
    "Eine aus dem begrenzten Tail verdraengte Stage darf nicht rekonstruiert werden.");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_ADD status=5\n", "utf8")]),
    "ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_ADD status=5");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_ADD status=5 parameter=0\n", "utf8")]), "");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_DELETE_VERIFY status=5\n", "utf8")]),
    "ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=NET_USER_DELETE_VERIFY status=5");
  assert.equal(diagnose([Buffer.from("password=Zf!never-surface\nZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_WITH_LOGON status=1314\n", "utf8")]),
    "ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_WITH_LOGON status=1314");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_FROM_ANCHOR status=2\n", "utf8")]),
    "ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_FROM_ANCHOR status=2");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_WITH_LOGON status=1314 parameter=0\n", "utf8")]), "");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=PROCESS_WITH_LOGON status=1314\n", "utf8")]), "");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=PROCESS_WITH_TOKEN status=1314\n", "utf8")]), "");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=NET_USER_ADD status=87 parameter=0\n", "utf8")]), "");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_PROCESS_DIAGNOSTIC code=NET_USER_DELETE status=5\n", "utf8")]), "");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_ANCHOR_STAGE_DIAGNOSTIC stage=FOREIGN\n", "utf8")]), "");
  assert.equal(diagnose([Buffer.from(`${safeStage} path=C:\\secret\\input\n`, "utf8")]), "");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_ANCHOR_STAGE_DIAGNOSTIC stage=freeze_source\n", "utf8")]), "");
  assert.equal(diagnose([Buffer.from(`${safe} password=Zf!never-surface\n`, "utf8")]), "");
  assert.equal(diagnose([Buffer.from("ZUGFOLGE_SAFE_ANCHOR_DIAGNOSTIC code=FOREIGN status=5\n", "utf8")]), "");
  assert.equal(diagnose([Buffer.from(`password=Zf!never-surface\n${"x".repeat(600)}`, "utf8")]), "");
});

test("Commit-ACK wird exakt gebunden und jeder fehlende oder fremde ACK erst post-anchor aufgeloest", async () => {
  const resolveAcknowledgement = await loadWindowsBuildAnchorCommitAcknowledgementForTest();
  const publication = {
    binary: { bytes: 11, identity: { dev: "1", ino: "2" }, sha256: "a".repeat(64) },
    provenance: { bytes: 12, identity: { dev: "1", ino: "3" }, sha256: "b".repeat(64) },
    receipt: { bytes: 13, identity: { dev: "1", ino: "4" }, sha256: "c".repeat(64) },
  };
  const exactLine = `PUBLICATION_COMMITTED ${Buffer.from(JSON.stringify(publication), "utf8").toString("base64")}`;
  assert.deepEqual(resolveAcknowledgement(exactLine, publication), {
    acknowledgement: publication,
    status: "exact-acknowledgement",
  });
  for (const line of [
    undefined,
    "PUBLICATION_COMMITTED !!!not-base64!!!",
    `PUBLISHED ${Buffer.from(JSON.stringify(publication), "utf8").toString("base64")}`,
    `PUBLICATION_COMMITTED ${Buffer.from(JSON.stringify({ ...publication, receipt: { ...publication.receipt, ino: "foreign" } }), "utf8").toString("base64")}`,
  ]) {
    assert.deepEqual(resolveAcknowledgement(line, publication), {
      acknowledgement: undefined,
      status: "requires-exact-recovery",
    });
  }
});

test("PowerShell 5.1 haelt die sichere Stage auch nach langem finally-Cleanupfehler als letzte Zeile", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zfrbcleanupstage");
  const harness = join(root, "cleanup-stage-anchor.ps1");
  const implementation = await readFile(IMPLEMENTATION_PATH, "utf8");
  const match = /const WINDOWS_BUILD_ANCHOR = String\.raw`(?<script>.*?)`;\r?\nconst EXPECTED_NORMALIZATION_FIELDS/su.exec(implementation);
  assert.ok(match?.groups?.script, "WINDOWS_BUILD_ANCHOR wurde nicht eindeutig gefunden.");
  const instrumented = [
    "class ZugfolgeThrowingDisposable : System.IDisposable {",
    "  [void] Dispose() { throw [InvalidOperationException]::new(('hostile-secret-path=' * 80)) }",
    "}",
    match.groups.script.replace(
      "$anchorStage = 'INITIALIZE'",
      "$anchorStage = 'INITIALIZE'\n$held.Add([ZugfolgeThrowingDisposable]::new())",
    ),
    "",
  ].join("\r\n");
  await writeFile(harness, instrumented);
  const executed = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness,
  ], { cwd: "C:\\Windows\\System32", expectFailure: true, stdin: Buffer.alloc(0) });
  assert.equal(executed.error?.code, 125);
  const stderr = executed.stderr.toString("utf8");
  assert.ok(stderr.length > 512, "Der kontrollierte Cleanupfehler muss den Diagnose-Tail ueberfuellen.");
  assert.match(stderr, /hostile-secret-path=/u);
  const safeStage = "ZUGFOLGE_SAFE_ANCHOR_STAGE_DIAGNOSTIC stage=INITIALIZE";
  assert.equal(stderr.trimEnd().split(/\r?\n/u).at(-1), safeStage);
  const diagnose = await loadWindowsBuildAnchorSafeDiagnosticForTest();
  assert.equal(diagnose([executed.stderr]), safeStage);
});

test("PowerShell 5.1 loescht den Account vor Publikation, rollt Fehler zurueck und schliesst den Commitpfad", WINDOWS_ONLY, async (t) => {
  const container = await temporaryDirectory(t, "zfrbrealprecommitcleanup");
  const authorityParent = join(container, "authority-parent");
  const root = join(authorityParent, "outputs");
  await mkdir(root, { recursive: true });
  const harness = join(container, "real-precommit-cleanup.ps1");
  const payload = Buffer.from("real-precommit-rollback-v1\r\n", "utf8");
  const leaves = ["binary.exe", "provenance.json", "receipt.json"];
  const outputs = leaves.map((leaf) => join(root, leaf));
  const implementation = await readFile(IMPLEMENTATION_PATH, "utf8");
  const anchorMatch = /const WINDOWS_BUILD_ANCHOR = String\.raw`(?<script>.*?)`;\r?\nconst EXPECTED_NORMALIZATION_FIELDS/su.exec(implementation);
  assert.ok(anchorMatch?.groups?.script, "WINDOWS_BUILD_ANCHOR wurde nicht eindeutig gefunden.");
  const mainMarker = "\ntry {\n  $request = Decode-Json ([Console]::In.ReadLine()) 'Anchor-Request'";
  const finalMarker = "\n} catch {\n  Fail $_.Exception.Message\n} finally {";
  const mainIndex = anchorMatch.groups.script.indexOf(mainMarker);
  const finalIndex = anchorMatch.groups.script.indexOf(finalMarker, mainIndex);
  assert.ok(mainIndex > 0 && mainIndex === anchorMatch.groups.script.lastIndexOf(mainMarker), "Anchor-Haupteinstieg ist nicht eindeutig.");
  assert.ok(finalIndex > mainIndex && finalIndex === anchorMatch.groups.script.lastIndexOf(finalMarker), "Anchor-catch/finally ist nicht eindeutig.");
  const prefix = anchorMatch.groups.script.slice(0, mainIndex);
  const suffix = anchorMatch.groups.script.slice(finalIndex);
  const controlledBody = [
    "try {",
    "  [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Helper))",
    "  $rootHandle = Open-HeldPathRoot $Root 'Test-Output-Parent'",
    "  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "  $descriptor = [ZugfolgeProtectedSecurityDescriptor]::ParentWritable($sid); $held.Add($descriptor)",
    "  $bytes = [Convert]::FromBase64String($PayloadBase64)",
    "  if ($bytes.Length -ne $ExpectedBytes) { throw 'Payload-Bytezahl driftet.' }",
    "  $account = [ZugfolgeControlledAccountDisposable]::new($Mode -ceq 'account-failure'); $held.Add($account)",
    "  $script:anchorStage = 'DELETE_EPHEMERAL_ACCOUNT'",
    "  Delete-EphemeralAccountBeforeResult $account",
    "  if (-not $script:ephemeralAccountDeleted) { throw 'Account-Loeschbeweis fehlt.' }",
    "  foreach ($leaf in @('binary.exe', 'provenance.json', 'receipt.json')) {",
    "    $input = [IO.MemoryStream]::new($bytes, $false); $held.Add($input)",
    "    $published = [ZugfolgeRelativeFs]::PublishHeldCreateNew($input, $rootHandle, $leaf, $ExpectedBytes, $ExpectedSha, $descriptor)",
    "    $publishedStreams.Add($published)",
    "  }",
    "  if ($Mode -ceq 'rollback') { throw 'controlled-real-publication-rollback' }",
    "  elseif ($Mode -cne 'success' -and $Mode -cne 'hold' -and $Mode -cne 'hardkill') { throw 'Unbekannter Testmodus.' }",
    "  $script:anchorStage = 'COMMIT_PUBLICATION'",
    "  Commit-Published",
    "  $publicationCommitted = $true",
    "  [GC]::Collect(); [GC]::WaitForPendingFinalizers()",
    "  if ($Mode -ceq 'hold') {",
    "    [Console]::Out.WriteLine('COMMIT_READY'); [Console]::Out.Flush()",
    "    Start-Sleep -Milliseconds 3000",
    "  }",
    "  if ($Mode -ceq 'hardkill') {",
    "    [Console]::Out.WriteLine('COMMIT_DECISION_READY'); [Console]::Out.Flush()",
    "    Start-Sleep -Seconds 30",
    "  }",
  ].join("\n");
  await writeFile(harness, [
    "param([string] $Helper, [string] $Root, [string] $Mode, [string] $PayloadBase64, [Int64] $ExpectedBytes, [string] $ExpectedSha)",
    "class ZugfolgeControlledAccountDisposable : System.IDisposable {",
    "  [int] $Calls",
    "  [bool] $FailOnce",
    "  ZugfolgeControlledAccountDisposable([bool] $failOnce) { $this.Calls = 0; $this.FailOnce = $failOnce }",
    "  [void] Dispose() { $this.Calls += 1; if ($this.FailOnce -and $this.Calls -eq 1) { throw [InvalidOperationException]::new('controlled-account-delete-failure-before-publication') } }",
    "}",
    prefix,
    controlledBody,
    suffix,
    "",
  ].join("\r\n"));
  const commonArguments = [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    harness, HELPER_PATH, root,
  ];
  const accountFailure = await execute(POWERSHELL_51, [
    ...commonArguments, "account-failure", payload.toString("base64"), String(payload.length), sha256(payload),
  ], { cwd: "C:\\Windows\\System32", expectFailure: true, stdin: Buffer.alloc(0) });
  assert.equal(accountFailure.error?.code, 125);
  const stderr = accountFailure.stderr.toString("utf8");
  assert.match(stderr, /controlled-account-delete-failure-before-publication/u);
  assert.equal(stderr.trimEnd().split(/\r?\n/u).at(-1),
    "ZUGFOLGE_SAFE_ANCHOR_STAGE_DIAGNOSTIC stage=DELETE_EPHEMERAL_ACCOUNT");
  for (const output of outputs) await assert.rejects(readFile(output), { code: "ENOENT" });

  const rollback = await execute(POWERSHELL_51, [
    ...commonArguments, "rollback", payload.toString("base64"), String(payload.length), sha256(payload),
  ], { cwd: "C:\\Windows\\System32", expectFailure: true, stdin: Buffer.alloc(0) });
  assert.equal(rollback.error?.code, 125);
  assert.match(rollback.stderr.toString("utf8"), /controlled-real-publication-rollback/u);
  for (const output of outputs) await assert.rejects(readFile(output), { code: "ENOENT" });

  const heldChild = spawn(POWERSHELL_51, [
    ...commonArguments, "hold", payload.toString("base64"), String(payload.length), sha256(payload),
  ], { cwd: "C:\\Windows\\System32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  heldChild.stdin.end();
  const heldStdout = [];
  const heldStderr = [];
  heldChild.stdout.on("data", (chunk) => heldStdout.push(chunk));
  heldChild.stderr.on("data", (chunk) => heldStderr.push(chunk));
  const heldExitPromise = new Promise((resolveExit, rejectExit) => {
    heldChild.once("error", rejectExit);
    heldChild.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("Commit-Handleprobe erreichte COMMIT_READY nicht.")), 10_000);
    heldChild.stdout.on("data", () => {
      if (Buffer.concat(heldStdout).toString("utf8").includes("COMMIT_READY")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    heldChild.once("error", (error) => { clearTimeout(timeout); rejectReady(error); });
    heldChild.once("close", (code) => {
      if (!Buffer.concat(heldStdout).toString("utf8").includes("COMMIT_READY")) {
        clearTimeout(timeout);
        rejectReady(new Error(`Commit-Handleprobe endete vorzeitig mit ${code}: ${Buffer.concat(heldStderr).toString("utf8")}`));
      }
    });
  });
  for (const heldPath of [...outputs, root, authorityParent]) {
    await assert.rejects(rename(heldPath, `${heldPath}.must-stay-held`), (error) => ["EACCES", "EBUSY", "EPERM"].includes(error?.code),
      `${heldPath} durfte waehrend der Commitentscheidung nicht umbenannt werden.`);
  }
  for (const output of outputs) {
    await assert.rejects(open(output, "r+"), (error) => ["EACCES", "EBUSY", "EPERM"].includes(error?.code),
      `${output} durfte waehrend der Commitentscheidung nicht schreibbar geoeffnet werden.`);
  }
  const heldExit = await heldExitPromise;
  assert.deepEqual(heldExit, { code: 0, signal: null }, Buffer.concat(heldStderr).toString("utf8"));
  assert.equal(Buffer.concat(heldStderr).length, 0, Buffer.concat(heldStderr).toString("utf8"));
  for (const output of outputs) {
    assert.deepEqual(await readFile(output), payload);
    const moved = `${output}.handle-close-proof`;
    await rename(output, moved);
    await rename(moved, output);
  }
  const movedRoot = `${root}-handle-close-proof`;
  await rename(root, movedRoot);
  await rename(movedRoot, root);
  const movedAuthorityParent = `${authorityParent}-handle-close-proof`;
  await rename(authorityParent, movedAuthorityParent);
  await rename(movedAuthorityParent, authorityParent);

  const recoveryRoot = join(authorityParent, "recovery-outputs");
  await mkdir(recoveryRoot);
  const recoveryOutputs = leaves.map((leaf) => join(recoveryRoot, leaf));
  const hardKillChild = spawn(POWERSHELL_51, [
    ...commonArguments.slice(0, -1), recoveryRoot,
    "hardkill", payload.toString("base64"), String(payload.length), sha256(payload),
  ], { cwd: "C:\\Windows\\System32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  hardKillChild.stdin.end();
  const hardKillStdout = [];
  const hardKillStderr = [];
  hardKillChild.stdout.on("data", (chunk) => hardKillStdout.push(chunk));
  hardKillChild.stderr.on("data", (chunk) => hardKillStderr.push(chunk));
  const hardKillExitPromise = new Promise((resolveExit, rejectExit) => {
    hardKillChild.once("error", rejectExit);
    hardKillChild.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("Hardkill-Probe erreichte die Commitentscheidung nicht.")), 10_000);
    hardKillChild.stdout.on("data", () => {
      if (Buffer.concat(hardKillStdout).toString("utf8").includes("COMMIT_DECISION_READY")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    hardKillChild.once("error", (error) => { clearTimeout(timeout); rejectReady(error); });
    hardKillChild.once("close", (code) => {
      if (!Buffer.concat(hardKillStdout).toString("utf8").includes("COMMIT_DECISION_READY")) {
        clearTimeout(timeout);
        rejectReady(new Error(`Hardkill-Probe endete vorzeitig mit ${code}: ${Buffer.concat(hardKillStderr).toString("utf8")}`));
      }
    });
  });
  hardKillChild.kill();
  const hardKillExit = await hardKillExitPromise;
  assert.notDeepEqual(hardKillExit, { code: 0, signal: null });
  assert.equal(Buffer.concat(hardKillStderr).length, 0, Buffer.concat(hardKillStderr).toString("utf8"));
  for (const output of recoveryOutputs) assert.deepEqual(await readFile(output), payload);
  const movedRecoveryRoot = `${recoveryRoot}-post-hardkill-proof`;
  await rename(recoveryRoot, movedRecoveryRoot);
  await rename(movedRecoveryRoot, recoveryRoot);
});

test("echtes Windows PowerShell 5.1 parst den Anchor und alle Workflow-Bloecke", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zfrbpsparse");
  const harness = join(root, "parse-production-powershell.ps1");
  await writeFile(harness, [
    "param([string] $Implementation, [string] $Workflow)",
    "$ErrorActionPreference = 'Stop'",
    "$source = [IO.File]::ReadAllText($Implementation)",
    "$anchor = [Text.RegularExpressions.Regex]::Match($source, 'const WINDOWS_BUILD_ANCHOR = String\\.raw`(?<script>.*?)`;\\r?\\nconst EXPECTED_NORMALIZATION_FIELDS', [Text.RegularExpressions.RegexOptions]::Singleline)",
    "if (-not $anchor.Success) { throw 'WINDOWS_BUILD_ANCHOR wurde nicht eindeutig gefunden.' }",
    "$null = [ScriptBlock]::Create($anchor.Groups['script'].Value)",
    "$lines = [IO.File]::ReadAllLines($Workflow)",
    "$count = 0",
    "for ($index = 0; $index -lt $lines.Length; $index++) {",
    "  if ($lines[$index].Trim() -cne 'shell: powershell') { continue }",
    "  $run = $index + 1",
    "  while ($run -lt $lines.Length -and $lines[$run] -cnotmatch '^        run: \\|$') {",
    "    if ($lines[$run] -match '^      - ') { throw 'PowerShell-Workflow-Step besitzt keinen run-Block.' }",
    "    $run++",
    "  }",
    "  if ($run -ge $lines.Length) { throw 'PowerShell-Workflow-Step endet vor seinem run-Block.' }",
    "  $body = [Collections.Generic.List[string]]::new()",
    "  for ($line = $run + 1; $line -lt $lines.Length; $line++) {",
    "    if ($lines[$line].Length -eq 0) { $body.Add(''); continue }",
    "    if (-not $lines[$line].StartsWith('          ')) { break }",
    "    $body.Add($lines[$line].Substring(10))",
    "  }",
    "  if ($body.Count -eq 0) { throw 'PowerShell-Workflow-run-Block ist leer.' }",
    "  $null = [ScriptBlock]::Create([string]::Join(\"`n\", $body))",
    "  $count++",
    "}",
    "[Console]::Out.WriteLine($count)",
    "",
  ].join("\r\n"));
  const parsed = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    harness, IMPLEMENTATION_PATH, WORKFLOW_PATH,
  ], { cwd: "C:\\Windows\\System32" });
  assert.equal(parsed.stdout.toString("utf8").trim(), "9");
});

test("Helper-Builder reproduziert das tracked PE32+-Artefakt bytegenau", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zugfolge-helper-parity-");
  const output = join(root, "operational-windows-anchor-helper.dll");
  const result = await buildOperationalValidatorWindowsAnchorHelper(output);
  const [actual, expected] = await Promise.all([readFile(output), readFile(HELPER_PATH)]);
  assert.ok(actual.equals(expected));
  assert.equal(result.bytes, expected.length);
  assert.equal(result.sha256, sha256(expected));
  assert.equal(result.sourceSha256, sha256(Buffer.from(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, "utf8")));
  const pe = actual.readUInt32LE(0x3c);
  assert.equal(actual.subarray(pe, pe + 4).toString("hex"), "50450000");
  assert.equal(actual.readUInt16LE(pe + 24), 0x20b);
});

test("Helper-Builder kompiliert den kanonischen Einmalaccountvertrag als PE32+", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zugfolge-helper-contract-");
  const output = join(root, "operational-windows-anchor-helper.dll");
  const result = await buildOperationalValidatorWindowsAnchorHelper(output);
  const actual = await readFile(output);
  assert.equal(result.bytes, actual.length);
  assert.equal(result.sha256, sha256(actual));
  assert.equal(result.sourceSha256, sha256(Buffer.from(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, "utf8")));
  const pe = actual.readUInt32LE(0x3c);
  assert.equal(actual.subarray(pe, pe + 4).toString("hex"), "50450000");
  assert.equal(actual.readUInt16LE(pe + 24), 0x20b);
});

test("echtes Windows friert atomar geschuetzte create-new Dateien und Verzeichnisse durch Handle-Schluss ein", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zugfolge-file-freeze-");
  const helper = join(root, "operational-windows-anchor-helper.dll");
  const harness = join(root, "file-freeze.ps1");
  await buildOperationalValidatorWindowsAnchorHelper(helper);
  await writeFile(harness, [
    "param([string] $Helper, [string] $Root)",
    "$ErrorActionPreference = 'Stop'",
    "[void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Helper))",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$buildSid = 'S-1-5-11'",
    "$rootHandle = [ZugfolgeRelativeFs]::OpenPlainDirectory($Root)",
    "$descriptor = [ZugfolgeProtectedSecurityDescriptor]::ReadExecute($sid, $buildSid)",
    "$stream = $null",
    "$readStream = $null",
    "$directoryHandle = $null",
    "$reopenedDirectory = $null",
    "try {",
    "  $fileHandle = [ZugfolgeRelativeFs]::CreateProtectedRegularFile($rootHandle, 'payload.bin', $descriptor)",
    "  $stream = [IO.FileStream]::new($fileHandle, [IO.FileAccess]::ReadWrite, 4096, $false)",
    "  $expected = [Text.Encoding]::UTF8.GetBytes('held-freeze-v1')",
    "  $stream.Write($expected, 0, $expected.Length)",
    "  $stream.Flush($true)",
    "  $stream.Dispose(); $stream = $null",
    "  [ZugfolgeRelativeFs]::AssertProtectedDacl($rootHandle, 'payload.bin', $false)",
    "  $readHandle = [ZugfolgeRelativeFs]::OpenRegularFile($rootHandle, 'payload.bin')",
    "  $readStream = [IO.FileStream]::new($readHandle, [IO.FileAccess]::Read, 4096, $false)",
    "  $actual = [byte[]]::new($expected.Length)",
    "  if ($readStream.Read($actual, 0, $actual.Length) -ne $actual.Length -or $readStream.ReadByte() -ne -1) { throw 'Nur-lesbarer Reopen lieferte falsche Bytezahl.' }",
    "  if ([Convert]::ToBase64String($expected) -cne [Convert]::ToBase64String($actual)) { throw 'Nur-lesbarer Reopen lieferte falsche Bytes.' }",
    "  [ZugfolgeRelativeFs]::AssertFrozenEntry($rootHandle, 'payload.bin', $false)",
    "  $directoryHandle = [ZugfolgeRelativeFs]::CreateProtectedDirectory($rootHandle, 'held-directory', $descriptor)",
    "  $directoryIdentity = [ZugfolgeRelativeFs]::Identity($directoryHandle)",
    "  $directoryHandle.Dispose(); $directoryHandle = $null",
    "  $reopenedDirectory = [ZugfolgeRelativeFs]::OpenDirectory($rootHandle, 'held-directory')",
    "  if ([ZugfolgeRelativeFs]::Identity($reopenedDirectory) -cne $directoryIdentity) { throw 'Nur-lesbarer Verzeichnis-Reopen driftete von seiner Identitaet.' }",
    "  [ZugfolgeRelativeFs]::AssertFrozenDirectoryEntry($rootHandle, 'held-directory')",
    "  [ZugfolgeRelativeFs]::AssertFrozenEntry($rootHandle, 'held-directory', $true)",
    "  [Console]::Out.WriteLine('ATOMIC_TREE_FREEZE_OK')",
    "} finally {",
    "  if ($null -ne $reopenedDirectory) { $reopenedDirectory.Dispose() }",
    "  if ($null -ne $directoryHandle) { $directoryHandle.Dispose() }",
    "  if ($null -ne $readStream) { $readStream.Dispose() }",
    "  if ($null -ne $stream) { $stream.Dispose() }",
    "  $descriptor.Dispose()",
    "  $rootHandle.Dispose()",
    "}",
    "",
  ].join("\r\n"));
  const executed = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    harness, helper, root,
  ], { cwd: "C:\\Windows\\System32" });
  assert.equal(executed.stderr.length, 0, executed.stderr.toString("utf8"));
  assert.equal(executed.stdout.toString("utf8").trim(), "ATOMIC_TREE_FREEZE_OK");
});

test("Helper-Builder verweigert nicht kanonischen Ausgabepfad vor Compilerwirkung", async (t) => {
  const root = await temporaryDirectory(t, "zugfolge-helper-name-");
  await assert.rejects(buildOperationalValidatorWindowsAnchorHelper(join(root, "helper.dll")), /muss operational-windows-anchor-helper\.dll heissen/);
  assert.deepEqual(await readdir(root), []);
});

test("ephemerer Windows-Build-Account wird erstellt, als Kindidentitaet verwendet und nach Erfolg geloescht", async (t) => {
  const result = await exerciseEphemeralBuildAccount(t, "success");
  if (result === undefined) return;
  assert.deepEqual(result, {
    accountsAfter: 0,
    accountsBefore: 0,
    cancellationExact: true,
    created: true,
    cwdExact: true,
    emptyEnvironmentExact: true,
    environmentExact: true,
    failureObserved: false,
    mode: "success",
    outputLimitExact: true,
    startFailureObserved: false,
    stdioExact: true,
    timeoutExact: true,
    treeExact: true,
    used: true,
  });
});

test("ephemerer Windows-Build-Account wird nach einem Kindprozessfehler im finally geloescht", async (t) => {
  const result = await exerciseEphemeralBuildAccount(t, "failure");
  if (result === undefined) return;
  assert.deepEqual(result, {
    accountsAfter: 0,
    accountsBefore: 0,
    cancellationExact: false,
    created: true,
    cwdExact: false,
    emptyEnvironmentExact: false,
    environmentExact: false,
    failureObserved: true,
    mode: "failure",
    outputLimitExact: false,
    startFailureObserved: false,
    stdioExact: false,
    timeoutExact: false,
    treeExact: false,
    used: false,
  });
});

test("ephemerer Windows-Build-Account gibt einen sicheren numerischen Startfehler aus und wird geloescht", async (t) => {
  const result = await exerciseEphemeralBuildAccount(t, "start-failure");
  if (result === undefined) return;
  assert.deepEqual(result, {
    accountsAfter: 0,
    accountsBefore: 0,
    cancellationExact: false,
    created: true,
    cwdExact: false,
    emptyEnvironmentExact: false,
    environmentExact: false,
    failureObserved: false,
    mode: "start-failure",
    outputLimitExact: false,
    startFailureObserved: true,
    stdioExact: false,
    timeoutExact: false,
    treeExact: false,
    used: false,
  });
});

test("PowerShell 5.1: Timeout, Cancellation und Root-Exit beenden den gesamten Jobbaum", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zfrbhelper");
  const grandchild = join(root, "grandchild.ps1");
  const parentExit = join(root, "parent-exit.ps1");
  const harness = join(root, "harness.ps1");
  const timeoutStarted = join(root, "timeout-started.txt");
  const timeoutRelease = join(root, "timeout-release.txt");
  const timeoutMarker = join(root, "timeout-marker.txt");
  const exitStarted = join(root, "exit-started.txt");
  const exitMarker = join(root, "exit-marker.txt");
  const exitRedirectOut = join(root, "exit-child.stdout.txt");
  const exitRedirectErr = join(root, "exit-child.stderr.txt");
  await writeFile(grandchild, [
    "param([string] $Marker)",
    "Start-Sleep -Milliseconds 2500",
    "[IO.File]::WriteAllText($Marker, 'leaked')",
    "",
  ].join("\r\n"));
  await writeFile(parentExit, [
    "param([string] $ChildScript, [string] $Marker, [string] $Started, [string] $RedirectOut, [string] $RedirectErr)",
    "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$quote = [char]34",
    "$start = [Diagnostics.ProcessStartInfo]::new()",
    "$start.FileName = $powershell",
    "$start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + $quote + $ChildScript + $quote + ' ' + $quote + $Marker + $quote",
    "$start.UseShellExecute = $false",
    "$start.CreateNoWindow = $true",
    "$start.RedirectStandardOutput = $true",
    "$start.RedirectStandardError = $true",
    "$child = [Diagnostics.Process]::Start($start)",
    "if ($null -eq $child) { throw 'Cmdlet-freier Root-Exit-Kindstart lieferte keinen Prozess.' }",
    "$child.Dispose()",
    "[IO.File]::WriteAllText($Started, 'started')",
    "exit 0",
    "",
  ].join("\r\n"));
  await writeFile(harness, [
    "param([string] $Dll, [string] $ParentExitScript, [string] $ChildScript, [string] $TimeoutMarker, [string] $TimeoutStarted, [string] $TimeoutRelease, [string] $ExitMarker, [string] $ExitStarted, [string] $ExitRedirectOut, [string] $ExitRedirectErr)",
    "$ErrorActionPreference = 'Stop'",
    "$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))",
    "$methods = @([ZugfolgeMitigatedProcess].GetMethods() | Where-Object { $_.IsPublic -and $_.IsStatic } | ForEach-Object Name | Sort-Object -Unique)",
    "function New-ChildEnvironment {",
    "  return @{ SystemRoot=[string]$env:SystemRoot; WINDIR=[string]$env:SystemRoot; PATH=[string](Join-Path $env:SystemRoot 'System32'); TEMP=[string](Join-Path $env:SystemRoot 'System32'); TMP=[string](Join-Path $env:SystemRoot 'System32') }",
    "}",
    "$environment = New-ChildEnvironment",
    "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$cmd = Join-Path $env:SystemRoot 'System32\\cmd.exe'",
    "$never = [Func[bool]] { return $false }",
    "# Keep the timeout tree probe cmdlet-free: hosted first-use Start-Process latency is not part of the helper contract.",
    "$timeoutGrandchildSource = '$process=[Diagnostics.Process]::GetCurrentProcess(); try { $process.Refresh(); $receipt=$process.Id.ToString([Globalization.CultureInfo]::InvariantCulture) + ''.'' + $process.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture); [IO.File]::WriteAllText($env:ZUGFOLGE_TIMEOUT_STARTED,$receipt); while (-not [IO.File]::Exists($env:ZUGFOLGE_TIMEOUT_RELEASE)) { [Threading.Thread]::Sleep(25) }; [IO.File]::WriteAllText($env:ZUGFOLGE_TIMEOUT_MARKER,''leaked'') } finally { $process.Dispose() }'",
    "$timeoutGrandchildEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($timeoutGrandchildSource))",
    "$timeoutRootSource = '$start=[Diagnostics.ProcessStartInfo]::new(); $start.FileName=''C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe''; $start.Arguments=''-NoLogo -NoProfile -NonInteractive -EncodedCommand '' + $env:ZUGFOLGE_TIMEOUT_GRANDCHILD_ENCODED; $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $child=[Diagnostics.Process]::Start($start); if ($null -eq $child) { throw ''Cmdlet-freier Timeout-Kindstart lieferte keinen Prozess.'' }; $child.WaitForExit(); $child.Dispose(); throw ''TIMEOUT_DESCENDANT_ENDED_UNEXPECTEDLY'''",
    "$timeoutRootEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($timeoutRootSource))",
    "$emptyCurrentIdentity = @{}",
    "$emptyResult = [ZugfolgeMitigatedProcess]::RunStrict($cmd, [string[]]@('/D','/Q','/C','exit /b 0'), (Join-Path $env:SystemRoot 'System32'), $emptyCurrentIdentity, [byte[]]@(), 65536, 5000, $never)",
    "$emptyCurrentIdentityExact = $emptyResult.ExitCode -eq 0 -and $emptyResult.Stdout.Length -eq 0 -and $emptyResult.Stderr.Length -eq 0",
    "# Keep the byte probe cmdlet-free: first-use module progress is legitimate child stderr, not launcher cross-wiring.",
    "$ioSource = '$stream=[Console]::OpenStandardInput(); $memory=[IO.MemoryStream]::new(); $buffer=[byte[]]::new(4096); while (($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0) { $memory.Write($buffer,0,$read) }; $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($identity))); [Console]::Out.Write(\".\"); [Console]::Out.Write([Convert]::ToBase64String($memory.ToArray())); [Console]::Error.Write(''ephemeral-stderr'')'",
    "$ioEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ioSource))",
    "$ioStdin = [byte[]](0,1,2,3,10,13,26,31,32,65,90,127,128,200,254,255)",
    "$ioResult = [ZugfolgeMitigatedProcess]::RunStrict($powershell, [string[]]@('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$ioEncoded), (Join-Path $env:SystemRoot 'System32'), $environment, $ioStdin, 65536, 5000, $never)",
    "$ioStdout = [Text.Encoding]::ASCII.GetString($ioResult.Stdout)",
    "$ioSeparator = $ioStdout.IndexOf([char]46)",
    "$ioShapeExact = $ioSeparator -gt 0 -and $ioSeparator -eq $ioStdout.LastIndexOf([char]46) -and $ioSeparator -lt ($ioStdout.Length - 1)",
    "$stdioCurrentIdentityExact = $false",
    "if ($ioShapeExact) {",
    "  try {",
    "    $ioIdentityBase64 = $ioStdout.Substring(0, $ioSeparator)",
    "    $ioStdinBase64 = $ioStdout.Substring($ioSeparator + 1)",
    "    $ioIdentityBytes = [Convert]::FromBase64String($ioIdentityBase64)",
    "    $ioActualStdin = [Convert]::FromBase64String($ioStdinBase64)",
    "    $ioIdentity = [Text.Encoding]::UTF8.GetString($ioIdentityBytes)",
    "    $ioCanonical = [Convert]::ToBase64String($ioIdentityBytes) -ceq $ioIdentityBase64 -and [Convert]::ToBase64String($ioActualStdin) -ceq $ioStdinBase64",
    "    $stdioCurrentIdentityExact = $ioResult.ExitCode -eq 0 -and $ioCanonical -and $ioIdentity -ceq [Security.Principal.WindowsIdentity]::GetCurrent().Name -and [Convert]::ToBase64String($ioActualStdin) -ceq [Convert]::ToBase64String($ioStdin) -and [Text.Encoding]::ASCII.GetString($ioResult.Stderr) -ceq 'ephemeral-stderr'",
    "  } catch { $stdioCurrentIdentityExact = $false }",
    "}",
    "$timeoutEnvironment = New-ChildEnvironment",
    "$timeoutEnvironment['ZUGFOLGE_TIMEOUT_GRANDCHILD_ENCODED'] = $timeoutGrandchildEncoded",
    "$timeoutEnvironment['ZUGFOLGE_TIMEOUT_MARKER'] = $TimeoutMarker",
    "$timeoutEnvironment['ZUGFOLGE_TIMEOUT_RELEASE'] = $TimeoutRelease",
    "$timeoutEnvironment['ZUGFOLGE_TIMEOUT_STARTED'] = $TimeoutStarted",
    "$timeoutMessage = ''; $timeoutClock = [Diagnostics.Stopwatch]::StartNew()",
    "try { $null = [ZugfolgeMitigatedProcess]::RunStrict($powershell, [string[]]@('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$timeoutRootEncoded), (Join-Path $env:SystemRoot 'System32'), $timeoutEnvironment, [byte[]]@(), 1048576, 10000, $never); $timeoutMessage = 'unexpected-success' } catch { $timeoutMessage = $_.Exception.GetBaseException().Message }",
    "$timeoutClock.Stop()",
    "$timeoutStartedExact = $false; $timeoutDescendantGone = $false; [Int64]$timeoutPid = 0; [Int64]$timeoutStartFileTimeUtc = 0",
    "if ([IO.File]::Exists($TimeoutStarted)) {",
    "  $timeoutReceipt = [IO.File]::ReadAllText($TimeoutStarted)",
    "  $timeoutSeparator = $timeoutReceipt.IndexOf([char]46)",
    "  $timeoutShapeExact = $timeoutSeparator -gt 0 -and $timeoutSeparator -eq $timeoutReceipt.LastIndexOf([char]46) -and $timeoutSeparator -lt ($timeoutReceipt.Length - 1)",
    "  if ($timeoutShapeExact) {",
    "    $timeoutPidText = $timeoutReceipt.Substring(0, $timeoutSeparator)",
    "    $timeoutStartText = $timeoutReceipt.Substring($timeoutSeparator + 1)",
    "    $timeoutStartedExact = [Int64]::TryParse($timeoutPidText, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$timeoutPid) -and [Int64]::TryParse($timeoutStartText, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$timeoutStartFileTimeUtc)",
    "    $timeoutStartedExact = $timeoutStartedExact -and $timeoutPid -gt 0 -and $timeoutPid -le [Int32]::MaxValue -and $timeoutStartFileTimeUtc -gt 0 -and $timeoutPid.ToString([Globalization.CultureInfo]::InvariantCulture) -ceq $timeoutPidText -and $timeoutStartFileTimeUtc.ToString([Globalization.CultureInfo]::InvariantCulture) -ceq $timeoutStartText",
    "  }",
    "}",
    "[IO.File]::WriteAllText($TimeoutRelease, 'release')",
    "if ($timeoutStartedExact) {",
    "  $timeoutDeadline = [DateTime]::UtcNow.AddSeconds(3); $timeoutSurvivor = $null",
    "  do {",
    "    if ($null -ne $timeoutSurvivor) { $timeoutSurvivor.Dispose(); $timeoutSurvivor = $null }",
    "    $timeoutCandidate = $null",
    "    try {",
    "      $timeoutCandidate = [Diagnostics.Process]::GetProcessById([int]$timeoutPid)",
    "      $timeoutCandidate.Refresh()",
    "      if ($timeoutCandidate.StartTime.ToFileTimeUtc() -eq $timeoutStartFileTimeUtc) { $timeoutSurvivor = $timeoutCandidate } else { $timeoutCandidate.Dispose(); $timeoutCandidate = $null }",
    "    } catch [ArgumentException] { if ($null -ne $timeoutCandidate) { $timeoutCandidate.Dispose() }; $timeoutSurvivor = $null }",
    "    catch [InvalidOperationException] { if ($null -ne $timeoutCandidate) { $timeoutCandidate.Dispose() }; $timeoutSurvivor = $null }",
    "    catch { if ($null -ne $timeoutCandidate) { $timeoutCandidate.Dispose() }; throw }",
    "    if ($null -ne $timeoutSurvivor) { [Threading.Thread]::Sleep(100) }",
    "  } while ($null -ne $timeoutSurvivor -and [DateTime]::UtcNow -lt $timeoutDeadline)",
    "  if ($null -ne $timeoutSurvivor) {",
    "    try { $timeoutSurvivor.Kill(); $timeoutSurvivor.WaitForExit(5000) | Out-Null } finally { $timeoutSurvivor.Dispose() }",
    "    throw 'Ein Timeout-Job-Nachfahrprozess ueberlebte den Jobabbruch.'",
    "  }",
    "  $timeoutDescendantGone = $true",
    "}",
    "$environment = New-ChildEnvironment",
    "$cancelClock = [Diagnostics.Stopwatch]::StartNew(); $cancel = [Func[bool]] { return $cancelClock.ElapsedMilliseconds -ge 250 }; $cancelMessage = ''",
    "try { $null = [ZugfolgeMitigatedProcess]::RunStrict($powershell, [string[]]@('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30'), (Join-Path $env:SystemRoot 'System32'), $environment, [byte[]]@(), 1048576, 5000, $cancel); $cancelMessage = 'unexpected-success' } catch { $cancelMessage = $_.Exception.GetBaseException().Message }",
    "$cancelClock.Stop()",
    "$environment = New-ChildEnvironment",
    "$oversizeClock = [Diagnostics.Stopwatch]::StartNew(); $oversizeMessage = ''",
    "try { $null = [ZugfolgeMitigatedProcess]::RunStrict($powershell, [string[]]@('-NoProfile','-NonInteractive','-Command','[Console]::Out.Write((''x'' * 131072))'), (Join-Path $env:SystemRoot 'System32'), $environment, [byte[]]@(), 4096, 5000, $never); $oversizeMessage = 'unexpected-success' } catch { $oversizeMessage = $_.Exception.GetBaseException().Message }",
    "$oversizeClock.Stop()",
    "$environment = New-ChildEnvironment",
    "$exitClock = [Diagnostics.Stopwatch]::StartNew()",
    "$exitResult = [ZugfolgeMitigatedProcess]::RunStrict($powershell, [string[]]@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$ParentExitScript,$ChildScript,$ExitMarker,$ExitStarted,$ExitRedirectOut,$ExitRedirectErr), (Join-Path $env:SystemRoot 'System32'), $environment, [byte[]]@(), 1048576, 15000, $never)",
    "$exitClock.Stop(); Start-Sleep -Milliseconds 3000",
    "$value = @{ cancellationElapsed=$cancelClock.ElapsedMilliseconds; cancellationMessage=$cancelMessage; emptyCurrentIdentityExact=$emptyCurrentIdentityExact; exitCode=$exitResult.ExitCode; exitElapsed=$exitClock.ElapsedMilliseconds; exitMarker=[IO.File]::Exists($ExitMarker); exitStarted=[IO.File]::Exists($ExitStarted); methods=$methods; oversizeElapsed=$oversizeClock.ElapsedMilliseconds; oversizeMessage=$oversizeMessage; stdioCurrentIdentityExact=$stdioCurrentIdentityExact; timeoutDescendantGone=$timeoutDescendantGone; timeoutElapsed=$timeoutClock.ElapsedMilliseconds; timeoutMarker=[IO.File]::Exists($TimeoutMarker); timeoutMessage=$timeoutMessage; timeoutStarted=$timeoutStartedExact }",
    "[Console]::Out.WriteLine(($value | ConvertTo-Json -Compress))",
    "",
  ].join("\r\n"));
  const executed = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    harness, HELPER_PATH, parentExit, grandchild, timeoutMarker, timeoutStarted, timeoutRelease, exitMarker, exitStarted, exitRedirectOut, exitRedirectErr,
  ], { cwd: "C:\\Windows\\System32" });
  const result = JSON.parse(executed.stdout.toString("utf8").trim().split(/\r?\n/u).at(-1));
  assert.deepEqual(result.methods.filter((name) => ["AbortActive", "Run", "RunAs", "RunAsStrict", "RunStrict"].includes(name)),
    ["AbortActive", "Run", "RunAs", "RunAsStrict", "RunStrict"]);
  assert.equal(result.emptyCurrentIdentityExact, true, JSON.stringify(result));
  assert.equal(result.stdioCurrentIdentityExact, true, JSON.stringify(result));
  assert.equal(result.timeoutStarted, true, JSON.stringify(result));
  assert.equal(result.timeoutDescendantGone, true, JSON.stringify(result));
  assert.equal(result.timeoutMarker, false);
  assert.match(result.timeoutMessage, /ueberschritt das gepinnte Zeitlimit/);
  assert.ok(result.timeoutElapsed < 15000);
  assert.match(result.cancellationMessage, /monotoner Inputdrift beendet/);
  assert.ok(result.cancellationElapsed < 5000);
  assert.match(result.oversizeMessage, /ueberschritt das kombinierte gepinnte Limit/);
  assert.ok(result.oversizeElapsed < 5000);
  assert.equal(result.exitStarted, true);
  assert.equal(result.exitMarker, false, "Root-Exit darf auch keinen von stdout/stderr abgekoppelten Job-Enkel ueberleben lassen.");
  assert.equal(result.exitCode, 0);
  assert.ok(result.exitElapsed < 30000, "Root-Exit darf die zusammengesetzte Root-, Pipe- und Job-Cleanup-Huellgrenze nicht erreichen.");
});

test("PowerShell 5.1: gehaltenes Annual-Publikationspaar commitet oder rollt beide Outputs identity-sicher zurueck", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zfrbpublish");
  const stage = join(root, "stage");
  const outputDirectory = join(root, "out");
  const stagedData = join(stage, "annual-plan.json");
  const stagedCompletion = join(stage, "annual-plan.completion.json");
  const tamperedCompletion = join(stage, "annual-plan.tampered-completion.json");
  const marker = join(outputDirectory, "foreign-marker.txt");
  const harness = join(root, "publish-pair.ps1");
  const outputRelativeFile = "out/annual-plan.json";
  const output = join(root, ...outputRelativeFile.split("/"));
  const outputCompletion = `${output}.zugfolge-complete.json`;
  const dataBytes = canonicalBytes({ phase: "annual-plan", trains: 17 });
  const dataProof = { bytes: dataBytes.length, file: outputRelativeFile, sha256: sha256(dataBytes) };
  const completionBytes = canonicalBytes({
    artifact: dataProof,
    schema: "zugfolge-germany-annual-create-new-artifact-completion/v1",
  });
  const tamperedCompletionBytes = canonicalBytes({
    artifact: { ...dataProof, bytes: dataProof.bytes + 1 },
    schema: "zugfolge-germany-annual-create-new-artifact-completion/v1",
  });
  await Promise.all([mkdir(stage), mkdir(outputDirectory)]);
  await Promise.all([
    writeFile(stagedData, dataBytes),
    writeFile(stagedCompletion, completionBytes),
    writeFile(tamperedCompletion, tamperedCompletionBytes),
    writeFile(marker, "foreign-marker\n"),
  ]);
  await writeFile(harness, [
    "param([string] $Dll, [string] $Root, [string] $StagedData, [string] $StagedCompletion, [string] $TamperedCompletion, [string] $OutputRelative, [Int64] $DataBytes, [string] $DataSha, [Int64] $CompletionBytes, [string] $CompletionSha, [Int64] $TamperedBytes, [string] $TamperedSha)",
    "$ErrorActionPreference = 'Stop'",
    "$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))",
    "$output = Join-Path $Root ($OutputRelative -replace '/', '\\')",
    "$completion = \"$output.zugfolge-complete.json\"",
    "$outputParent = Split-Path -Parent $output",
    "$outputParentSwap = \"$outputParent.swap\"",
    "$outputSwap = \"$output.swap\"",
    "function Invoke-Blocked([scriptblock] $Action, [scriptblock] $Restore) {",
    "  try { & $Action; if ($null -ne $Restore) { & $Restore }; return $false } catch { return $true }",
    "}",
    "$pair = [ZugfolgeAnnualArtifactPublisher]::PublishPair($Root, $StagedData, $StagedCompletion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$proof = @{ artifact=@{ bytes=$pair.Artifact.Bytes; file=$pair.Artifact.File; sha256=$pair.Artifact.Sha256; dev=$pair.Artifact.Identity.Dev; ino=$pair.Artifact.Identity.Ino }; completion=@{ bytes=$pair.Completion.Bytes; file=$pair.Completion.File; sha256=$pair.Completion.Sha256; dev=$pair.Completion.Identity.Dev; ino=$pair.Completion.Identity.Ino } }",
    "$writeBlocked = Invoke-Blocked { [IO.File]::WriteAllText($output, 'foreign') } $null",
    "$sourceWriteBlocked = Invoke-Blocked { [IO.File]::WriteAllText($StagedData, 'foreign-source') } $null",
    "$renameBlocked = Invoke-Blocked { Move-Item -LiteralPath $output -Destination $outputSwap -ErrorAction Stop } { Move-Item -LiteralPath $outputSwap -Destination $output -ErrorAction Stop }",
    "$parentRenameBlocked = Invoke-Blocked { Move-Item -LiteralPath $outputParent -Destination $outputParentSwap -ErrorAction Stop } { Move-Item -LiteralPath $outputParentSwap -Destination $outputParent -ErrorAction Stop }",
    "$pair.Rollback(); $pair.Dispose()",
    "$rolledBack = -not [IO.File]::Exists($output) -and -not [IO.File]::Exists($completion)",
    "$tamperedMessage = ''",
    "try { $bad = [ZugfolgeAnnualArtifactPublisher]::PublishPair($Root, $StagedData, $TamperedCompletion, $OutputRelative, $DataBytes, $DataSha, $TamperedBytes, $TamperedSha); try { $bad.Rollback() } finally { $bad.Dispose() }; $tamperedMessage = 'unexpected-success' } catch { $tamperedMessage = $_.Exception.GetBaseException().Message }",
    "$tamperedLeftNothing = -not [IO.File]::Exists($output) -and -not [IO.File]::Exists($completion)",
    "$committed = [ZugfolgeAnnualArtifactPublisher]::PublishPair($Root, $StagedData, $StagedCompletion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$committedProof = @{ artifact=@{ bytes=$committed.Artifact.Bytes; file=$committed.Artifact.File; sha256=$committed.Artifact.Sha256; dev=$committed.Artifact.Identity.Dev; ino=$committed.Artifact.Identity.Ino }; completion=@{ bytes=$committed.Completion.Bytes; file=$committed.Completion.File; sha256=$committed.Completion.Sha256; dev=$committed.Completion.Identity.Dev; ino=$committed.Completion.Identity.Ino } }",
    "$committed.Commit(); $committed.Dispose()",
    "$verified = [ZugfolgeAnnualArtifactPublisher]::VerifyPair($Root, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$verifyProof = @{ artifact=@{ bytes=$verified.Artifact.Bytes; file=$verified.Artifact.File; sha256=$verified.Artifact.Sha256; dev=$verified.Artifact.Identity.Dev; ino=$verified.Artifact.Identity.Ino }; completion=@{ bytes=$verified.Completion.Bytes; file=$verified.Completion.File; sha256=$verified.Completion.Sha256; dev=$verified.Completion.Identity.Dev; ino=$verified.Completion.Identity.Ino } }",
    "$verifyWriteBlocked = Invoke-Blocked { [IO.File]::WriteAllText($output, 'foreign-after-verify') } $null",
    "$verifyRenameBlocked = Invoke-Blocked { Move-Item -LiteralPath $output -Destination $outputSwap -ErrorAction Stop } { Move-Item -LiteralPath $outputSwap -Destination $output -ErrorAction Stop }",
    "$verifyParentRenameBlocked = Invoke-Blocked { Move-Item -LiteralPath $outputParent -Destination $outputParentSwap -ErrorAction Stop } { Move-Item -LiteralPath $outputParentSwap -Destination $outputParent -ErrorAction Stop }",
    "$verified.Complete(); $verified.Dispose()",
    "$wrongVerifyMessage = ''",
    "try { $wrong = [ZugfolgeAnnualArtifactPublisher]::VerifyPair($Root, $OutputRelative, $DataBytes, ('0' * 64), $CompletionBytes, $CompletionSha); try { $wrong.Complete() } finally { $wrong.Dispose() }; $wrongVerifyMessage = 'unexpected-success' } catch { $wrongVerifyMessage = $_.Exception.GetBaseException().Message }",
    "$value = @{ committedBoth=([IO.File]::Exists($output) -and [IO.File]::Exists($completion)); committedProof=$committedProof; marker=[IO.File]::ReadAllText((Join-Path $outputParent 'foreign-marker.txt')); parentRenameBlocked=$parentRenameBlocked; proof=$proof; renameBlocked=$renameBlocked; rolledBack=$rolledBack; sourceWriteBlocked=$sourceWriteBlocked; tamperedLeftNothing=$tamperedLeftNothing; tamperedMessage=$tamperedMessage; verifyParentRenameBlocked=$verifyParentRenameBlocked; verifyProof=$verifyProof; verifyRenameBlocked=$verifyRenameBlocked; verifyWriteBlocked=$verifyWriteBlocked; writeBlocked=$writeBlocked; wrongVerifyMessage=$wrongVerifyMessage }",
    "[Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 8 -Compress))",
    "",
  ].join("\r\n"));
  const executed = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    harness, HELPER_PATH, root, stagedData, stagedCompletion, tamperedCompletion, outputRelativeFile,
    String(dataBytes.length), dataProof.sha256, String(completionBytes.length), sha256(completionBytes),
    String(tamperedCompletionBytes.length), sha256(tamperedCompletionBytes),
  ], { cwd: "C:\\Windows\\System32" });
  const result = JSON.parse(executed.stdout.toString("utf8").trim().split(/\r?\n/u).at(-1));
  assert.equal(result.writeBlocked, true, JSON.stringify(result));
  assert.equal(result.sourceWriteBlocked, true, JSON.stringify(result));
  assert.equal(result.renameBlocked, true, JSON.stringify(result));
  assert.equal(result.parentRenameBlocked, true, JSON.stringify(result));
  assert.equal(result.rolledBack, true, JSON.stringify(result));
  assert.equal(result.tamperedLeftNothing, true, JSON.stringify(result));
  assert.match(result.tamperedMessage, /Annual-Completion ist nicht kanonisch/);
  assert.equal(result.committedBoth, true, JSON.stringify(result));
  assert.equal(result.verifyWriteBlocked, true, JSON.stringify(result));
  assert.equal(result.verifyRenameBlocked, true, JSON.stringify(result));
  assert.equal(result.verifyParentRenameBlocked, true, JSON.stringify(result));
  assert.match(result.wrongVerifyMessage, /Staging-SHA-256 driftet/);
  assert.equal(result.marker, "foreign-marker\n");
  assert.deepEqual(result.proof.artifact, {
    bytes: dataBytes.length,
    dev: result.proof.artifact.dev,
    file: outputRelativeFile,
    ino: result.proof.artifact.ino,
    sha256: dataProof.sha256,
  });
  assert.deepEqual(result.proof.completion, {
    bytes: completionBytes.length,
    dev: result.proof.completion.dev,
    file: `${outputRelativeFile}.zugfolge-complete.json`,
    ino: result.proof.completion.ino,
    sha256: sha256(completionBytes),
  });
  assert.match(result.proof.artifact.dev, /^\d+$/u);
  assert.match(result.proof.artifact.ino, /^\d+$/u);
  assert.match(result.proof.completion.dev, /^\d+$/u);
  assert.match(result.proof.completion.ino, /^\d+$/u);
  assert.deepEqual(result.verifyProof, result.committedProof);
  assert.ok((await readFile(output)).equals(dataBytes));
  assert.ok((await readFile(outputCompletion)).equals(completionBytes));
});

test("PowerShell 5.1: harter Kill zwischen Artifact und Completion ist exakt und fremddatenschonend recoverbar", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zfrbrecovery");
  const stage = join(root, "stage");
  const outputDirectory = join(root, "out");
  const outputRelativeFile = "out/annual-plan.json";
  const output = join(root, ...outputRelativeFile.split("/"));
  const outputCompletion = `${output}.zugfolge-complete.json`;
  const stagedData = join(stage, "annual-plan.json");
  const stagedCompletion = join(stage, "annual-plan.completion.json");
  const gapMarker = join(root, "artifact-created.marker");
  const crashHarness = join(root, "crash-between-pair.ps1");
  const recoverHarness = join(root, "recover-pair.ps1");
  const rejectHarness = join(root, "reject-foreign-pair.ps1");
  const dataBytes = canonicalBytes({ phase: "annual-plan", trains: 23 });
  const dataSha = sha256(dataBytes);
  const completionFor = (file) => canonicalBytes({
    artifact: { bytes: dataBytes.length, file, sha256: dataSha },
    schema: "zugfolge-germany-annual-create-new-artifact-completion/v1",
  });
  const completionBytes = completionFor(outputRelativeFile);
  await Promise.all([mkdir(stage), mkdir(outputDirectory)]);
  await Promise.all([writeFile(stagedData, dataBytes), writeFile(stagedCompletion, completionBytes)]);
  const commonParameters = "[string] $Dll, [string] $Root, [string] $Data, [string] $Completion, [string] $OutputRelative, [Int64] $DataBytes, [string] $DataSha, [Int64] $CompletionBytes, [string] $CompletionSha";
  await writeFile(crashHarness, [
    `param(${commonParameters}, [string] $Marker)`,
    "$ErrorActionPreference = 'Stop'",
    "$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))",
    "$hook = [Action]{ [IO.File]::WriteAllText($Marker, 'artifact-held'); Start-Sleep -Seconds 30 }",
    "$pair = [ZugfolgeAnnualArtifactPublisher]::PublishOrRecoverPairWithTestHook($Root, $Data, $Completion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha, $hook)",
    "try { $pair.Commit() } finally { $pair.Dispose() }",
    "",
  ].join("\r\n"));
  await writeFile(recoverHarness, [
    `param(${commonParameters})`,
    "$ErrorActionPreference = 'Stop'",
    "$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))",
    "function Proof($pair) { return @{ artifact=@{ bytes=$pair.Artifact.Bytes; file=$pair.Artifact.File; sha256=$pair.Artifact.Sha256; dev=$pair.Artifact.Identity.Dev; ino=$pair.Artifact.Identity.Ino }; completion=@{ bytes=$pair.Completion.Bytes; file=$pair.Completion.File; sha256=$pair.Completion.Sha256; dev=$pair.Completion.Identity.Dev; ino=$pair.Completion.Identity.Ino } } }",
    "$pair = [ZugfolgeAnnualArtifactPublisher]::PublishOrRecoverPair($Root, $Data, $Completion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$recovered = Proof $pair; $pair.Commit(); $pair.Dispose()",
    "$verify = [ZugfolgeAnnualArtifactPublisher]::VerifyPair($Root, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$verified = Proof $verify; $verify.Complete(); $verify.Dispose()",
    "$again = [ZugfolgeAnnualArtifactPublisher]::PublishOrRecoverPair($Root, $Data, $Completion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$existing = Proof $again; $again.Commit(); $again.Dispose()",
    "[Console]::Out.WriteLine((@{ existing=$existing; recovered=$recovered; verified=$verified } | ConvertTo-Json -Depth 8 -Compress))",
    "",
  ].join("\r\n"));
  await writeFile(rejectHarness, [
    `param(${commonParameters})`,
    "$ErrorActionPreference = 'Stop'",
    "$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))",
    "$message = ''",
    "try { $pair = [ZugfolgeAnnualArtifactPublisher]::PublishOrRecoverPair($Root, $Data, $Completion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha); try { $pair.Rollback() } finally { $pair.Dispose() }; $message = 'unexpected-success' } catch { $message = $_.Exception.GetBaseException().Message }",
    "[Console]::Out.WriteLine((@{ message=$message } | ConvertTo-Json -Compress))",
    "",
  ].join("\r\n"));
  const baseArguments = [
    HELPER_PATH, root, stagedData, stagedCompletion, outputRelativeFile,
    String(dataBytes.length), dataSha, String(completionBytes.length), sha256(completionBytes),
  ];
  const crashing = spawn(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    crashHarness, ...baseArguments, gapMarker,
  ], { cwd: "C:\\Windows\\System32", stdio: "ignore", windowsHide: true });
  t.after(() => { try { crashing.kill("SIGKILL"); } catch {} });
  const closed = new Promise((resolveClose, rejectClose) => {
    crashing.once("error", rejectClose);
    crashing.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  assert.equal((await waitForFileBytes(gapMarker)).toString("utf8"), "artifact-held");
  assert.ok((await readFile(output)).equals(dataBytes), "Kill-Hook muss hinter dem vollstaendig gehaltenen Artifact liegen.");
  await assert.rejects(readFile(outputCompletion), { code: "ENOENT" });
  assert.equal(crashing.kill("SIGKILL"), true);
  const crashResult = await closed;
  assert.notEqual(crashResult.code, 0);
  assert.ok((await readFile(output)).equals(dataBytes));
  await assert.rejects(readFile(outputCompletion), { code: "ENOENT" });
  const recoveredRun = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    recoverHarness, ...baseArguments,
  ], { cwd: "C:\\Windows\\System32" });
  const recovered = JSON.parse(recoveredRun.stdout.toString("utf8").trim().split(/\r?\n/u).at(-1));
  assert.deepEqual(recovered.recovered, recovered.verified);
  assert.deepEqual(recovered.verified, recovered.existing);
  assert.ok((await readFile(output)).equals(dataBytes));
  assert.ok((await readFile(outputCompletion)).equals(completionBytes));

  const rejectForeign = async ({ relativeFile, artifactBytes, completionBytes: existingCompletionBytes }) => {
    const directory = join(root, ...relativeFile.split("/").slice(0, -1));
    const artifact = join(root, ...relativeFile.split("/"));
    const completion = `${artifact}.zugfolge-complete.json`;
    const staged = join(stage, `${relativeFile.replaceAll("/", "-")}.completion.json`);
    const expectedCompletion = completionFor(relativeFile);
    await mkdir(directory);
    await writeFile(artifact, artifactBytes);
    if (existingCompletionBytes) await writeFile(completion, existingCompletionBytes);
    await writeFile(staged, expectedCompletion);
    const executed = await execute(POWERSHELL_51, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", rejectHarness,
      HELPER_PATH, root, stagedData, staged, relativeFile, String(dataBytes.length), dataSha,
      String(expectedCompletion.length), sha256(expectedCompletion),
    ], { cwd: "C:\\Windows\\System32" });
    const result = JSON.parse(executed.stdout.toString("utf8").trim().split(/\r?\n/u).at(-1));
    assert.notEqual(result.message, "unexpected-success");
    assert.ok((await readFile(artifact)).equals(artifactBytes));
    if (existingCompletionBytes) assert.ok((await readFile(completion)).equals(existingCompletionBytes));
    else await assert.rejects(readFile(completion), { code: "ENOENT" });
  };
  await rejectForeign({ relativeFile: "foreign-artifact/annual-plan.json", artifactBytes: Buffer.from("foreign-artifact\n") });
  await rejectForeign({
    relativeFile: "foreign-completion/annual-plan.json",
    artifactBytes: dataBytes,
    completionBytes: Buffer.from("foreign-completion\n"),
  });
});

test("Preparation-only Generator erzeugt Vendor-TAR und Toolchain-Manifest deterministisch", async (t) => {
  const root = await temporaryDirectory(t, "zugfolge-rebuild-inputs-");
  const vendorRoot = join(root, "vendor-root");
  await mkdir(join(vendorRoot, ".cargo"), { recursive: true });
  await mkdir(join(vendorRoot, "vendor", "crate-1.0.0", "src"), { recursive: true });
  await writeFile(join(vendorRoot, ".cargo", "config.toml"), "[source.crates-io]\nreplace-with = \"vendored-sources\"\n\n[source.vendored-sources]\ndirectory = \"vendor\"\n");
  await writeFile(join(vendorRoot, "vendor", "crate-1.0.0", ".cargo-checksum.json"), "{\"files\":{},\"package\":null}\n");
  await writeFile(join(vendorRoot, "vendor", "crate-1.0.0", "src", "lib.rs"), "pub fn pinned() {}\n");
  const tarA = join(root, "vendor-a.tar");
  const tarB = join(root, "vendor-b.tar");
  const firstTar = await execute(process.execPath, [PREPARATION_PATH, "vendor-tar", vendorRoot, tarA]);
  const secondTar = await execute(process.execPath, [PREPARATION_PATH, "vendor-tar", vendorRoot, tarB]);
  const [tarABytes, tarBBytes] = await Promise.all([readFile(tarA), readFile(tarB)]);
  assert.ok(tarABytes.equals(tarBBytes));
  assert.deepEqual(JSON.parse(firstTar.stdout), { bytes: tarABytes.length, path: tarA, sha256: sha256(tarABytes) });
  assert.deepEqual(JSON.parse(secondTar.stdout), { bytes: tarBBytes.length, path: tarB, sha256: sha256(tarBBytes) });
  assert.equal(tarABytes.subarray(257, 262).toString("ascii"), "ustar");
  assert.match(tarABytes.toString("utf8"), /comment=cargo-vendor-tree-v1/);
  const toolchainRoot = join(root, "toolchain");
  await mkdir(join(toolchainRoot, "bin"), { recursive: true });
  await mkdir(join(toolchainRoot, "lib", "rustlib"), { recursive: true });
  await writeFile(join(toolchainRoot, "bin", "cargo.exe"), "cargo-bytes\n");
  await writeFile(join(toolchainRoot, "bin", "rustc.exe"), "rustc-bytes\n");
  await writeFile(join(toolchainRoot, "lib", "rustlib", "helper.dll"), "helper-bytes\n");
  const manifestA = join(root, "manifest-a.json");
  const manifestB = join(root, "manifest-b.json");
  await execute(process.execPath, [PREPARATION_PATH, "toolchain-manifest", toolchainRoot, "test-toolchain-v1", manifestA]);
  await execute(process.execPath, [PREPARATION_PATH, "toolchain-manifest", toolchainRoot, "test-toolchain-v1", manifestB]);
  const [manifestABytes, manifestBBytes] = await Promise.all([readFile(manifestA), readFile(manifestB)]);
  assert.ok(manifestABytes.equals(manifestBBytes));
  const manifest = JSON.parse(manifestABytes);
  assert.equal(manifest.schema, "zugfolge-operational-validator-toolchain-manifest/v1");
  assert.deepEqual(manifest.directories, ["bin", "lib", "lib/rustlib"]);
  assert.deepEqual(manifest.files.map(({ file }) => file), ["bin/cargo.exe", "bin/rustc.exe", "lib/rustlib/helper.dll"]);
  assert.ok(manifest.files.every(({ bytes, sha256: hash }) => bytes > 0 && /^[a-f0-9]{64}$/u.test(hash)));
});

test("Rustup-Komponentenreihenfolge wird exklusiv auf den bestehenden Complete-Tree-Pin kanonisiert", WINDOWS_ONLY, async (t) => {
  const target = "x86_64-pc-windows-gnu";
  const canonical = [
    `clippy-preview-${target}`,
    `cargo-${target}`,
    `rust-mingw-${target}`,
    `rust-std-${target}`,
    `rustfmt-preview-${target}`,
    `rustc-${target}`,
  ];
  const observedRace = [canonical[1], canonical[0], ...canonical.slice(2)];
  const permutations = [canonical, observedRace, canonical.toReversed()];
  const manifests = [];
  for (const [index, entries] of permutations.entries()) {
    const root = await temporaryDirectory(t, `zugfolge-rustup-components-${index}-`);
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(join(root, "lib", "rustlib"), { recursive: true });
    const cargo = Buffer.from("held-cargo-bytes\n");
    await writeFile(join(root, "bin", "cargo.exe"), cargo);
    await writeFile(join(root, "lib", "rustlib", "components"), `${entries.join("\n")}\n`);
    const normalized = await execute(POWERSHELL_51, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      RUSTUP_COMPONENT_NORMALIZER_PATH, "-ToolchainRoot", root, "-TargetTriple", target,
    ], { cwd: "C:\\Windows\\System32" });
    assert.match(normalized.stdout.toString("utf8"), /RUSTUP_COMPONENTS_CANONICAL bytes=195 sha256=28e3faf57d2d41bda8c213f5a4333a8a0bc56f544eb21de7341cb750077b46b1/u);
    assert.deepEqual(await readFile(join(root, "lib", "rustlib", "components")), Buffer.from(`${canonical.join("\n")}\n`));
    assert.deepEqual(await readFile(join(root, "bin", "cargo.exe")), cargo);
    const manifestPath = join(root, "manifest.json");
    await execute(process.execPath, [PREPARATION_PATH, "toolchain-manifest", root, "test-toolchain-v1", manifestPath]);
    manifests.push(await readFile(manifestPath));
  }
  assert.ok(manifests.every((manifest) => manifest.equals(manifests[0])));
});

test("Rustup-Komponentennormalisierung weist Mengen- und Formatdrift vor dem Schreiben ab", WINDOWS_ONLY, async (t) => {
  const target = "x86_64-pc-windows-gnu";
  const canonical = [
    `clippy-preview-${target}`,
    `cargo-${target}`,
    `rust-mingw-${target}`,
    `rust-std-${target}`,
    `rustfmt-preview-${target}`,
    `rustc-${target}`,
  ];
  const invalid = [
    canonical.slice(1),
    [...canonical, `rust-src-${target}`],
    [...canonical.slice(0, 5), canonical[0]],
    [...canonical.slice(0, 5), "rustc-x86_64-pc-windows-msvc"],
    [...canonical.slice(0, 5), `RUSTC-${target}`],
  ].map((entries) => Buffer.from(`${entries.join("\n")}\n`));
  invalid.push(
    Buffer.from(`${canonical.join("\r\n")}\r\n`),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${canonical.join("\n")}\n`)]),
    Buffer.from(`${canonical.join("\n")}\n\n`),
    Buffer.from(canonical.join("\n")),
  );
  for (const [index, bytes] of invalid.entries()) {
    const root = await temporaryDirectory(t, `zugfolge-rustup-components-invalid-${index}-`);
    await mkdir(join(root, "lib", "rustlib"), { recursive: true });
    const path = join(root, "lib", "rustlib", "components");
    await writeFile(path, bytes);
    const result = await execute(POWERSHELL_51, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      RUSTUP_COMPONENT_NORMALIZER_PATH, "-ToolchainRoot", root, "-TargetTriple", target,
    ], { cwd: "C:\\Windows\\System32", expectFailure: true });
    assert.ok(result.error, `Ungueltige Rustup-Komponentenvariante ${index} wurde akzeptiert.`);
    assert.deepEqual(await readFile(path), bytes, `Ungueltige Rustup-Komponentenvariante ${index} wurde veraendert.`);
  }
});

test("Rustup-Komponentennormalisierung weist Verzeichnis und Hardlink vor jeder Fremdmutation ab", WINDOWS_ONLY, async (t) => {
  const target = "x86_64-pc-windows-gnu";
  const raceBytes = Buffer.from([
    `cargo-${target}`,
    `clippy-preview-${target}`,
    `rust-mingw-${target}`,
    `rust-std-${target}`,
    `rustfmt-preview-${target}`,
    `rustc-${target}`,
    "",
  ].join("\n"));
  const directoryRoot = await temporaryDirectory(t, "zugfolge-rustup-components-directory-");
  await mkdir(join(directoryRoot, "lib", "rustlib", "components"), { recursive: true });
  const directoryResult = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    RUSTUP_COMPONENT_NORMALIZER_PATH, "-ToolchainRoot", directoryRoot, "-TargetTriple", target,
  ], { cwd: "C:\\Windows\\System32", expectFailure: true });
  assert.ok(directoryResult.error);

  const hardlinkRoot = await temporaryDirectory(t, "zugfolge-rustup-components-hardlink-");
  const externalRoot = await temporaryDirectory(t, "zugfolge-rustup-components-external-");
  await mkdir(join(hardlinkRoot, "lib", "rustlib"), { recursive: true });
  const external = join(externalRoot, "external-components");
  const hardlink = join(hardlinkRoot, "lib", "rustlib", "components");
  await writeFile(external, raceBytes);
  await link(external, hardlink);
  const hardlinkResult = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    RUSTUP_COMPONENT_NORMALIZER_PATH, "-ToolchainRoot", hardlinkRoot, "-TargetTriple", target,
  ], { cwd: "C:\\Windows\\System32", expectFailure: true });
  assert.ok(hardlinkResult.error);
  assert.deepEqual(await readFile(external), raceBytes);
  assert.deepEqual(await readFile(hardlink), raceBytes);
});

test("Workflow bindet Spec-Pfade, privaten GitHub-Assettransport und Sigstore-Verifikation", async () => {
  const [workflow, executionAuthorityWorkflow, runner, captureRunner] = await Promise.all([
    readFile(WORKFLOW_PATH, "utf8"),
    readFile(EXECUTION_AUTHORITY_WORKFLOW_PATH, "utf8"),
    readFile(WORKFLOW_RUNNER_PATH, "utf8"),
    readFile(OPERATIONAL_CAPTURE_RUNNER_PATH, "utf8"),
  ]);
  for (const required of [
    "preserved_validator_release_id:", "preserved_validator_asset_id:",
    "Download exact preserved validator from private draft release",
    "api.github.com/repos/larynxberlin-rgb/Zugfolge/releases/assets",
    "contents: write", "persist-credentials: false", "GITHUB_TOKEN: ${{ github.token }}",
    "Authorization: Bearer", "--proto '=https' --proto-redir '=https'",
    "$release.draft -ne $true", "$release.target_commitish -cne $env:GITHUB_SHA",
    "$assets[0].digest -cne $expectedDigest",
    "subject-path: ${{ steps.evidence-paths.outputs.subjects }}",
    "path: ${{ steps.evidence-paths.outputs.artifact_paths }}",
    "path: ${{ steps.evidence-paths.outputs.authority_paths }}",
    "operational-validator-authority-infra-deutschland-2026.5-${{ github.run_id }}-${{ github.run_attempt }}",
    "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "gh attestation verify", "--deny-self-hosted-runners", "--source-digest $env:GITHUB_SHA",
    "GITHUB_REF_PROTECTED -cne 'true'",
    "Exercise complete Windows anchor regression suite",
    "ZUGFOLGE_REQUIRE_ELEVATED_ACCOUNT_TESTS: '1'",
    "node --test tools/region-import/germany/operational-validator-rebuild-evidence.test.mjs",
    "$spec.binaries.preserved.file",
    "$spec.authority.annualExecutorPlan.directContractFile",
    "$spec.authority.annualExecutorPlan.planFile",
    '"$($spec.authority.annualExecutorPlan.planFile).zugfolge-complete.json"',
    "$spec.authority.annualExecutorPlan.startEvidenceFile",
    '"$($spec.authority.annualExecutorPlan.startEvidenceFile).zugfolge-complete.json"',
    "zugfolge-germany-annual-create-new-artifact-completion/v1",
    "Annual-Completion ist nicht bytekanonisch",
    "$rustupHome = Join-Path $preparation 'rustup-home'",
    "$cargoHome = Join-Path $preparation 'cargo-home'",
    "$rustupPath = [IO.Path]::GetFullPath((Get-Command rustup -CommandType Application -ErrorAction Stop).Source)",
    "$env:RUSTUP_HOME = $rustupHome",
    "$env:CARGO_HOME = $cargoHome",
    "& $rustupPath toolchain install $toolchainId --profile minimal --component clippy --component rustfmt",
    "$toolchainsRoot = [IO.Path]::GetFullPath((Join-Path $rustupHome 'toolchains')).TrimEnd([IO.Path]::DirectorySeparatorChar)",
    "$installedToolchain = [IO.Path]::GetFullPath((Join-Path $toolchainsRoot $toolchainId))",
    "[IO.Path]::GetDirectoryName($installedToolchain).TrimEnd([IO.Path]::DirectorySeparatorChar) -cne $toolchainsRoot",
    "normalize-operational-validator-rustup-components.windows.ps1",
    "$subjects",
  ]) assert.ok(workflow.includes(required), `Workflow bindet ${required} nicht.`);
  assert.doesNotMatch(workflow, /--test-name-pattern/u,
    "Der geschuetzte Windows-Gate darf bei Testtitel-Drift keine Regression unbemerkt ueberspringen.");
  assert.doesNotMatch(
    workflow,
    /^\s*(?:rustup|& \$rustupPath) toolchain install \$toolchainId --profile minimal\s*$/gmu,
    "Workflow darf die gepinnte Toolchain nicht ohne Clippy und rustfmt materialisieren.",
  );
  assert.equal(workflow.match(/^\s+GITHUB_TOKEN:/gmu)?.length, 1);
  const downloadStart = workflow.indexOf("- name: Download exact preserved validator from private draft release");
  const materializeStart = workflow.indexOf("- name: Materialize Annual-pinned source, vendor, toolchain and helper inputs");
  const materializeEnd = workflow.indexOf("- name: Run materializer through held System32 PowerShell bundle launcher");
  assert.ok(downloadStart >= 0 && downloadStart < materializeStart && materializeStart < materializeEnd);
  const materialize = workflow.slice(materializeStart, materializeEnd);
  assert.ok(
    materialize.indexOf("$rustupPath = [IO.Path]::GetFullPath((Get-Command rustup") < materialize.indexOf("$env:RUSTUP_HOME = $rustupHome"),
    "Workflow muss den rustup-Programmpfad halten, bevor er die isolierten Homes aktiviert.",
  );
  assert.equal(
    materialize.match(/^\s*& \$rustupPath toolchain install \$toolchainId --profile minimal --component clippy --component rustfmt\s*$/gmu)?.length,
    1,
    "Workflow muss die vollstaendige Toolchain genau einmal in der isolierten Wurzel installieren.",
  );
  assert.doesNotMatch(materialize, /rustup which|Split-Path -Parent \(Split-Path -Parent \$cargoPath\)/u);
  const install = materialize.indexOf("& $rustupPath toolchain install $toolchainId");
  const normalize = materialize.indexOf("normalize-operational-validator-rustup-components.windows.ps1");
  const manifest = materialize.indexOf("prepare-operational-validator-rebuild-inputs.mjs toolchain-manifest");
  assert.ok(install >= 0 && install < normalize && normalize < manifest, "Workflow-Reihenfolge muss install -> components canonicalize -> manifest sein.");
  assert.doesNotMatch(materialize.slice(normalize), /& \$rustupPath|\brustup (?:set|toolchain|which)\b/u);
  assert.match(workflow.slice(downloadStart, materializeStart), /GITHUB_TOKEN:/u);
  assert.doesNotMatch(materialize, /GITHUB_TOKEN:|PRESERVED_VALIDATOR_(?:RELEASE|ASSET)_ID/u);
  assert.doesNotMatch(workflow, /preserved_validator_url/u);
  assert.doesNotMatch(workflow, /zugfolge-infra-release-rebuild-[a-f0-9]{40}-official\.exe/u);
  assert.match(
    runner,
    /bytes\.equals\(serializeGermanyOperationalDirectSystemLaunchContract\(value\)\)/u,
    "Rebuild-Runner muss den gemeinsamen kanonischen Direct-Contract-Serializer verwenden.",
  );
  assert.match(
    runner,
    /\.\/build-operational-infrastructure-v2-direct-system-launch-contract\.mjs/u,
    "Rebuild-Runner importiert den gemeinsamen Direct-Contract-Serializer nicht.",
  );
  assert.doesNotMatch(
    runner,
    /function canonicalBytes/u,
    "Rebuild-Runner darf keinen abweichenden lokalen Contract-Canonicalizer besitzen.",
  );
  assert.match(
    captureRunner,
    /executionPins:\s*\{\s*bytes:\s*executionPinsSource\.proof\.bytes,\s*file:\s*executionPinsSource\.proof\.file,\s*sha256:\s*executionPinsSource\.proof\.sha256,\s*\}/u,
    "Gehaltene Rebuild-Producer-Proofs muessen interne Schema-Metadaten an der externen Spec-Grenze entfernen.",
  );
  assert.doesNotMatch(
    captureRunner,
    /executionPins:\s*executionPinsSource\.proof/u,
    "Der interne schema-gebundene Execution-Pins-Proof darf nicht unveraendert in den exakten Rebuild-Producer-Proof gelangen.",
  );
  for (const required of [
    "operator-approved-hash-binding-not-source-reexecution-v1",
    "environment: operational-release-approval",
    "operational-validator-authority-infra-deutschland-2026[.]5-",
    "Plan-Authority besitzt nicht exakt eine verifizierte Attestation mit der vollstaendigen Subjectmenge",
    "subject-name: var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json",
    "subject-name: var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json.zugfolge-complete.json",
    "[IO.File]::AppendAllText($env:GITHUB_OUTPUT",
  ]) assert.ok(executionAuthorityWorkflow.includes(required), `Execution-Authority-Workflow bindet ${required} nicht.`);
  assert.doesNotMatch(executionAuthorityWorkflow, /Out-File\s+-LiteralPath\s+\$env:GITHUB_OUTPUT/u);
  const workflowLines = executionAuthorityWorkflow.split(/\r?\n/u);
  const runBodies = [];
  for (let index = 0; index < workflowLines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(workflowLines[index]);
    if (match === null) continue;
    const indentation = match[1].length;
    const body = [];
    for (index += 1; index < workflowLines.length; index += 1) {
      const line = workflowLines[index];
      const contentIndentation = /^(\s*)/u.exec(line)[1].length;
      if (line.trim() !== "" && contentIndentation <= indentation) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    runBodies.push(body.join("\n"));
  }
  assert.ok(runBodies.length > 0);
  for (const body of runBodies) {
    assert.doesNotMatch(body, /\$\{\{/u, "GitHub-Ausdruecke duerfen nicht in PowerShell-Quelltext interpoliert werden.");
  }
  for (const variable of [
    "PLAN_AUTHORITY_ARTIFACT_ID",
    "OUTER_RECEIPT_BYTES",
    "OUTER_RECEIPT_SHA256",
    "OUTER_COMPLETION_BYTES",
    "OUTER_COMPLETION_SHA256",
  ]) {
    assert.match(executionAuthorityWorkflow, new RegExp(`\\$env:${variable}`, "u"));
  }
  assert.match(runner, /phase = "materialize-validator-rebuild-v3"/u);
  assert.match(runner, /phase = "materialize-annual-plan-evidence-v1"/u);
  assert.match(runner, /GITHUB_ACTIONS === "true"/u);
  assert.match(runner, /createGermanyOperationalAnchoredRunnerInvocation/u);
  assert.doesNotMatch(runner, /operational-validator-rebuild-evidence-cli/u);
});

test("Node-Syntax aller Rebuild-v3-Produzenten bleibt gueltig", async () => {
  for (const file of [IMPLEMENTATION_PATH, HELPER_BUILDER_PATH, PREPARATION_PATH, WORKFLOW_RUNNER_PATH]) {
    await execute(process.execPath, ["--check", file]);
  }
});
