param($Contract, $Context, [string]$WorkspaceRoot, $AnnualLaunchProof)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Assert-ExactKeys($Value, [string[]]$Expected, [string]$Label) {
  if ($null -eq $Value) { throw "$Label fehlt." }
  $actual = if ($Value -is [Collections.IDictionary]) {
    @($Value.Keys | ForEach-Object { [String]$_ } | Sort-Object)
  } else {
    @($Value.PSObject.Properties.Name | Sort-Object)
  }
  $wanted = @($Expected | Sort-Object)
  if ($actual.Count -ne $wanted.Count) { throw "$Label besitzt fremde oder fehlende Felder." }
  for ($index = 0; $index -lt $wanted.Count; $index += 1) {
    if ($actual[$index] -cne $wanted[$index]) { throw "$Label besitzt fremde oder fehlende Felder." }
  }
}

function Hex-Sha256([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Read-HeldBytes([IO.FileStream]$Stream, [Int32]$Length, [string]$Label) {
  $bytes = New-Object byte[] $Length
  $offset = 0
  while ($offset -lt $bytes.Length) {
    $count = $Stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($count -eq 0) { throw "$Label endete vorzeitig." }
    $offset += $count
  }
  if ($Stream.ReadByte() -ne -1) { throw "$Label wuchs waehrend des Lesens." }
  return $bytes
}

function Workspace-Path([string]$Root, [string]$Value, [string]$Label) {
  if ([String]::IsNullOrEmpty($Value) -or $Value.IndexOf([char]0) -ge 0) {
    throw "$Label fehlt oder enthaelt NUL."
  }
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $path = if ([IO.Path]::IsPathRooted($Value)) {
    [IO.Path]::GetFullPath($Value)
  } else {
    [IO.Path]::GetFullPath([IO.Path]::Combine($rootFull, $Value))
  }
  if ($path -cne $rootFull -and
      -not $path.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label verlaesst die Arbeitswurzel."
  }
  return $path
}

function Assert-NoReparseExistingPath([string]$Root, [string]$Path, [string]$Label) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $pathFull = [IO.Path]::GetFullPath($Path)
  $relative = if ($pathFull -ceq $rootFull) { "" } else { $pathFull.Substring($rootFull.Length + 1) }
  $cursor = $rootFull
  if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label besitzt eine Reparse-Arbeitswurzel."
  }
  foreach ($segment in $relative.Split([IO.Path]::DirectorySeparatorChar)) {
    if ([String]::IsNullOrEmpty($segment)) { continue }
    $cursor = [IO.Path]::Combine($cursor, $segment)
    if (-not [IO.File]::Exists($cursor) -and -not [IO.Directory]::Exists($cursor)) { break }
    if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label enthaelt einen Reparse Point."
    }
  }
}

Assert-ExactKeys $Contract @(
  "schema", "releaseId", "platform", "executionPins", "launcher", "dynamicBindings", "bootstrap", "trustedExecutor"
) "Annual-Launch-Vertrag"
if ($Contract.dynamicBindings.Count -ne 1) {
  throw "Annual-Launch-Vertrag besitzt nicht exakt eine kanonische Kontextbindung."
}
$contextBinding = $Contract.dynamicBindings[0]
Assert-ExactKeys $contextBinding @("id", "environment", "encoding", "schema", "properties") "Annual-Launch-Kontextbindung"
$contextProperties = @(
  "candidatePath", "candidateSidecarPath", "executionPinsPath", "nativeReceiptPath", "reportPath",
  "runtimePath", "schema", "sourceRoot", "specificationPath"
)
if ($contextBinding.id -cne "launchContext" -or
    $contextBinding.environment -cne "ZUGFOLGE_OPERATIONAL_LAUNCH_CONTEXT_BASE64" -or
    $contextBinding.encoding -cne "canonical-json-utf8-base64-v1" -or
    $contextBinding.schema -cne "zugfolge-operational-v2-direct-system-launch-context/v1" -or
    $contextBinding.properties.Count -ne $contextProperties.Count) {
  throw "Annual-Launch-Vertrag besitzt eine falsche Kontextbindung."
}
for ($index = 0; $index -lt $contextProperties.Count; $index += 1) {
  if ($contextBinding.properties[$index] -cne $contextProperties[$index]) {
    throw "Annual-Launch-Vertrag besitzt eine umgeordnete oder fremde Kontextbindung."
  }
}
Assert-ExactKeys $Context @(
  "schema", "runtimePath", "executionPinsPath", "specificationPath",
  "sourceRoot", "candidatePath", "candidateSidecarPath", "reportPath", "nativeReceiptPath"
) "Annual-Launch-Kontext"
if ($Context.schema -cne "zugfolge-operational-v2-direct-system-launch-context/v1") {
  throw "Annual-Launch-Kontext besitzt ein falsches Schema."
}
$Bindings = [ordered]@{
  runtimePath = [String]$Context.runtimePath
  executionPinsPath = [String]$Context.executionPinsPath
  specificationPath = [String]$Context.specificationPath
  sourceRoot = [String]$Context.sourceRoot
  candidatePath = [String]$Context.candidatePath
  candidateSidecarPath = [String]$Context.candidateSidecarPath
  reportPath = [String]$Context.reportPath
  nativeReceiptPath = [String]$Context.nativeReceiptPath
}
Assert-ExactKeys $Contract.executionPins @("file", "bytes", "sha256", "schema") "Annual-Launch-Execution-Pins"
Assert-ExactKeys $Contract.launcher @("file", "mode", "sourceBytes", "sourceSha256") "Annual-Launch-Systemlauncher"
Assert-ExactKeys $Contract.trustedExecutor @("file", "buildCommit", "bytes", "sha256") "Annual-Launch-Trusted-Executor"
Assert-ExactKeys $AnnualLaunchProof @("contract", "executionPins", "mode", "trustedExecutor") "Annual-Launch-Proof"
Assert-ExactKeys $AnnualLaunchProof.contract @("bytes", "file", "releaseId", "schema", "sha256") "Annual-Launch-Proof.contract"
Assert-ExactKeys $AnnualLaunchProof.executionPins @("bytes", "file", "schema", "sha256") "Annual-Launch-Proof.executionPins"
Assert-ExactKeys $AnnualLaunchProof.trustedExecutor @("buildCommit", "bytes", "file", "sha256") "Annual-Launch-Proof.trustedExecutor"
if ($AnnualLaunchProof.mode -cne "held-direct-contract-windows-v1" -or
    $AnnualLaunchProof.contract.releaseId -cne $Contract.releaseId -or
    $AnnualLaunchProof.contract.schema -cne $Contract.schema -or
    $AnnualLaunchProof.executionPins.file -cne $Contract.executionPins.file -or
    [Int64]$AnnualLaunchProof.executionPins.bytes -ne [Int64]$Contract.executionPins.bytes -or
    $AnnualLaunchProof.executionPins.sha256 -cne $Contract.executionPins.sha256 -or
    $AnnualLaunchProof.executionPins.schema -cne $Contract.executionPins.schema -or
    $AnnualLaunchProof.trustedExecutor.file -cne $Contract.trustedExecutor.file -or
    $AnnualLaunchProof.trustedExecutor.buildCommit -cne $Contract.trustedExecutor.buildCommit -or
    [Int64]$AnnualLaunchProof.trustedExecutor.bytes -ne [Int64]$Contract.trustedExecutor.bytes -or
    $AnnualLaunchProof.trustedExecutor.sha256 -cne $Contract.trustedExecutor.sha256) {
  throw "Annual-Launch-Proof driftet vom gehaltenen Direct-System-Launch-Vertrag."
}

$pinsHandle = $null
$launcherHandle = $null
try {
  $root = [IO.Path]::GetFullPath($WorkspaceRoot)
  $executionPinsPath = Workspace-Path $root $Bindings.executionPinsPath "Execution-Pins-Pfad"
  $expectedExecutionPinsPath = Workspace-Path $root $Contract.executionPins.file "Vertraglicher Execution-Pins-Pfad"
  if ($executionPinsPath -cne $expectedExecutionPinsPath) {
    throw "Dynamische Execution-Pins-Bindung bezeichnet nicht die vertragliche Annual-Datei."
  }
  Assert-NoReparseExistingPath $root $executionPinsPath "Execution-Pins-Pfad"
  if ($Contract.executionPins.bytes -le 0 -or $Contract.executionPins.bytes -gt 2097152 -or
      $Contract.executionPins.sha256 -cnotmatch "^[a-f0-9]{64}$" -or
      $Contract.executionPins.schema -cne "zugfolge-germany-operational-v2-execution-pins/v1") {
    throw "Annual-Launch-Vertrag besitzt ungueltige Execution-Pins."
  }
  $pinsHandle = [IO.File]::Open(
    $executionPinsPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read)
  if ($pinsHandle.Length -ne $Contract.executionPins.bytes) {
    throw "Gehaltene Execution-Pins besitzen eine falsche Bytezahl."
  }
  $pinsBytes = Read-HeldBytes $pinsHandle ([Int32]$Contract.executionPins.bytes) "Execution-Pins"
  if ((Hex-Sha256 $pinsBytes) -cne $Contract.executionPins.sha256) {
    throw "Gehaltene Execution-Pins besitzen einen falschen SHA-256."
  }
  $utf8 = New-Object Text.UTF8Encoding($false, $true)
  $pins = $utf8.GetString($pinsBytes) | ConvertFrom-Json
  Assert-ExactKeys $pins @("schema", "releaseId", "runner", "validator", "command") "Execution-Pins"
  Assert-ExactKeys $pins.runner @(
    "anchorHelper", "bundle", "entrypoint", "roots", "importClosure", "invocation", "launcher", "runtime"
  ) "Execution-Pins.runner"
  Assert-ExactKeys $pins.runner.anchorHelper @("file", "bytes", "sha256") "Execution-Pins.runner.anchorHelper"
  Assert-ExactKeys $pins.runner.bundle @("file", "bytes", "sha256") "Execution-Pins.runner.bundle"
  Assert-ExactKeys $pins.runner.invocation @("mode", "nodeArguments", "nodeOptions") "Execution-Pins.runner.invocation"
  Assert-ExactKeys $pins.runner.launcher @("mode", "sourceBytes", "sourceSha256") "Execution-Pins.runner.launcher"
  Assert-ExactKeys $pins.runner.runtime @("id", "platform", "bytes", "sha256") "Execution-Pins.runner.runtime"
  Assert-ExactKeys $pins.validator @("file", "buildCommit", "bytes", "sha256", "rebuildSpecification", "rebuildEvidence") "Execution-Pins.validator"
  if ($pins.schema -cne $Contract.executionPins.schema -or
      $pins.releaseId -cne $Contract.releaseId -or
      $pins.runner.invocation.mode -cne "system-launcher-held-bundle-stdin-v1" -or
      $pins.runner.invocation.nodeArguments.Count -ne 2 -or
      $pins.runner.invocation.nodeArguments[0] -cne "--input-type=module" -or
      $pins.runner.invocation.nodeArguments[1] -cne "-" -or
      $null -ne $pins.runner.invocation.nodeOptions -or
      $pins.runner.runtime.id -cne "nodejs-24-operational-runner-v1" -or
      $pins.runner.runtime.platform -cne "win32") {
    throw "Execution-Pins besitzen keinen exakten Windows-V2-Runnervertrag."
  }
  if ($pins.validator.file -cne $Contract.trustedExecutor.file -or
      $pins.validator.buildCommit -cne $Contract.trustedExecutor.buildCommit -or
      [Int64]$pins.validator.bytes -ne [Int64]$Contract.trustedExecutor.bytes -or
      $pins.validator.sha256 -cne $Contract.trustedExecutor.sha256) {
    throw "Execution-Pins und Annual-Launch-Vertrag binden verschiedene Trusted-Executor-Bytes."
  }
  if ($pins.runner.launcher.mode -cne $Contract.launcher.mode -or
      $pins.runner.launcher.sourceBytes -ne $Contract.launcher.sourceBytes -or
      $pins.runner.launcher.sourceSha256 -cne $Contract.launcher.sourceSha256) {
    throw "Execution-Pins und Annual-Launch-Vertrag binden verschiedene Systemlauncher."
  }

  $launcherPath = Workspace-Path $root $Contract.launcher.file "Systemlauncher-Pfad"
  Assert-NoReparseExistingPath $root $launcherPath "Systemlauncher-Pfad"
  if ($Contract.launcher.file -cne "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1" -or
      $Contract.launcher.mode -cne "windows-system-powershell-held-bundle-v1" -or
      $Contract.launcher.sourceBytes -le 0 -or $Contract.launcher.sourceBytes -gt 2097152 -or
      $Contract.launcher.sourceSha256 -cnotmatch "^[a-f0-9]{64}$") {
    throw "Annual-Launch-Vertrag besitzt keinen kanonischen Windows-Systemlauncher."
  }
  $launcherHandle = [IO.File]::Open(
    $launcherPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read)
  if ($launcherHandle.Length -ne $Contract.launcher.sourceBytes) {
    throw "Gehaltene Systemlauncher-Datei besitzt eine falsche Bytezahl."
  }
  $launcherBytes = Read-HeldBytes $launcherHandle ([Int32]$Contract.launcher.sourceBytes) "Systemlauncher"
  if ((Hex-Sha256 $launcherBytes) -cne $Contract.launcher.sourceSha256) {
    throw "Gehaltene Systemlauncher-Datei besitzt einen falschen SHA-256."
  }

  $runtimeInput = [String]$Bindings.runtimePath
  if (-not [IO.Path]::IsPathRooted($runtimeInput) -or $runtimeInput.IndexOf([char]0) -ge 0) {
    throw "Dynamische Runtime-Bindung ist kein absoluter sicherer Pfad."
  }
  $runtimePath = [IO.Path]::GetFullPath($runtimeInput)
  $runnerArguments = @(
    $executionPinsPath,
    (Workspace-Path $root $Bindings.specificationPath "Operational-v2-Spezifikation"),
    (Workspace-Path $root $Bindings.sourceRoot "Operational-v2-Quellwurzel"),
    (Workspace-Path $root $Bindings.candidatePath "Operational-v2-Candidate"),
    (Workspace-Path $root $Bindings.candidateSidecarPath "Operational-v2-Candidate-Sidecar"),
    (Workspace-Path $root $Bindings.reportPath "Operational-v2-Bericht"),
    (Workspace-Path $root $Bindings.nativeReceiptPath "Operational-v2-Native-Receipt")
  )
  $bundlePath = Workspace-Path $root $pins.runner.bundle.file "Operational-v2-Runner-Bundle"
  $anchorHelperPath = Workspace-Path $root $pins.runner.anchorHelper.file "Operational-v2-Windows-Anchor-Helper"
  if ($pins.runner.anchorHelper.file -cne "tools/region-import/germany/operational-windows-anchor-helper.dll" -or
      $pins.runner.anchorHelper.bytes -le 0 -or $pins.runner.anchorHelper.bytes -gt 2097152 -or
      $pins.runner.anchorHelper.sha256 -cnotmatch "^[a-f0-9]{64}$") {
    throw "Execution-Pins besitzen keinen kanonischen Windows-Anchor-Helper."
  }
  $context = [ordered]@{
    SystemRoot = "C:\Windows"
    WINDIR = "C:\Windows"
    ComSpec = "C:\Windows\System32\cmd.exe"
    PATH = "C:\Windows\System32;C:\Windows"
    PATHEXT = ".COM;.EXE;.BAT;.CMD"
    TEMP = "C:\Windows\System32"
    TMP = "C:\Windows\System32"
    ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_PATH = $bundlePath
    ZUGFOLGE_OPERATIONAL_RUNNER_NODE_PATH = $runtimePath
    ZUGFOLGE_OPERATIONAL_RUNNER_NODE_BYTES = [String]$pins.runner.runtime.bytes
    ZUGFOLGE_OPERATIONAL_RUNNER_NODE_SHA256 = [String]$pins.runner.runtime.sha256
    ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT = $root
    ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_BYTES = [String]$pins.runner.bundle.bytes
    ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SHA256 = [String]$pins.runner.bundle.sha256
    ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_PATH = $anchorHelperPath
    ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_BYTES = [String]$pins.runner.anchorHelper.bytes
    ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_SHA256 = [String]$pins.runner.anchorHelper.sha256
    ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_MODE = [String]$Contract.launcher.mode
    ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_BYTES = [String]$Contract.launcher.sourceBytes
    ZUGFOLGE_OPERATIONAL_RUNNER_LAUNCHER_SOURCE_SHA256 = [String]$Contract.launcher.sourceSha256
    ZUGFOLGE_OPERATIONAL_RUNNER_PHASE = "derive-and-capture-v1"
    ZUGFOLGE_OPERATIONAL_RUNNER_CLI_COUNT = "7"
    ZUGFOLGE_OPERATIONAL_RUNNER_ANNUAL_LAUNCH_PROOF_BASE64 = [Convert]::ToBase64String(
      [Text.Encoding]::UTF8.GetBytes(($AnnualLaunchProof | ConvertTo-Json -Compress -Depth 8)))
  }
  for ($index = 0; $index -lt $runnerArguments.Count; $index += 1) {
    $context["ZUGFOLGE_OPERATIONAL_RUNNER_CLI_$index"] = [String]$runnerArguments[$index]
  }
  foreach ($name in @([Environment]::GetEnvironmentVariables("Process").Keys)) {
    [Environment]::SetEnvironmentVariable([String]$name, $null, "Process")
  }
  foreach ($entry in $context.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable([String]$entry.Key, [String]$entry.Value, "Process")
  }
  $launcherSource = $utf8.GetString($launcherBytes)
  & ([ScriptBlock]::Create($launcherSource))
} finally {
  if ($null -ne $launcherHandle) { $launcherHandle.Dispose() }
  if ($null -ne $pinsHandle) { $pinsHandle.Dispose() }
}
