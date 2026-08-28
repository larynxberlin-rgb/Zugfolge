$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Required-Environment([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([String]::IsNullOrEmpty($value)) { throw "Fehlende Annual-Launch-Bindung $Name." }
  return $value
}

function Assert-ExactKeys($Value, [string[]]$Expected, [string]$Label) {
  if ($null -eq $Value) { throw "$Label fehlt." }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if ($actual.Count -ne $wanted.Count) { throw "$Label besitzt fremde oder fehlende Felder." }
  for ($index = 0; $index -lt $wanted.Count; $index += 1) {
    if ($actual[$index] -cne $wanted[$index]) { throw "$Label besitzt fremde oder fehlende Felder." }
  }
}

function Hex-Sha256([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
  finally { $sha.Dispose() }
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

function Workspace-Path([string]$Root, [string]$Relative, [string]$Label) {
  if ([String]::IsNullOrEmpty($Relative) -or [IO.Path]::IsPathRooted($Relative) -or
      $Relative.IndexOf([char]0) -ge 0) { throw "$Label ist kein relativer sicherer Pfad." }
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $path = [IO.Path]::GetFullPath([IO.Path]::Combine($rootFull, $Relative))
  if (-not $path.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label verlaesst die Arbeitswurzel."
  }
  return $path
}

$environmentContract = @(
  "ComSpec", "PATH", "PATHEXT", "PSModulePath", "SystemRoot", "TEMP", "TMP", "WINDIR",
  "ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_BYTES",
  "ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_FILE",
  "ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_SCHEMA",
  "ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_SHA256",
  "ZUGFOLGE_OPERATIONAL_EXPECTED_RELEASE_ID",
  "ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_BUILD_COMMIT",
  "ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_BYTES",
  "ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_FILE",
  "ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_SHA256",
  "ZUGFOLGE_OPERATIONAL_LAUNCH_CONTEXT_BASE64",
  "ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_BYTES",
  "ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_PATH",
  "ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_SCHEMA",
  "ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_SHA256",
  "ZUGFOLGE_OPERATIONAL_WORKSPACE_ROOT"
)
$syntheticEnvironment = @(
  "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PSExecutionPolicyPreference", "SYSTEMDRIVE",
  "USERDOMAIN", "USERNAME", "USERPROFILE"
)

$contractHandle = $null
try {
  $actualEnvironment = @([Environment]::GetEnvironmentVariables("Process").Keys | ForEach-Object { [String]$_ } | Sort-Object)
  $allowedEnvironment = @($environmentContract + $syntheticEnvironment | Sort-Object)
  foreach ($name in $environmentContract) {
    if ($actualEnvironment -cnotcontains $name) { throw "Annual-Launch-Prozess besitzt eine fehlende Planvariable." }
  }
  foreach ($name in $actualEnvironment) {
    if ($allowedEnvironment -cnotcontains $name) { throw "Annual-Launch-Prozess besitzt eine fremde Umgebungsvariable." }
  }
  foreach ($name in $syntheticEnvironment) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    if ($null -ne $value -and ([String]$value -match "[\x00-\x1f]")) {
      throw "Annual-Launch-Prozess besitzt eine ungueltige synthetische Windows-Variable."
    }
  }
  $policyPreference = [Environment]::GetEnvironmentVariable("PSExecutionPolicyPreference", "Process")
  if ($null -ne $policyPreference -and $policyPreference -cne "Bypass") {
    throw "Annual-Launch-Prozess besitzt eine fremde PowerShell-Ausfuehrungsrichtlinie."
  }

  $captured = @{}
  foreach ($name in $environmentContract) { $captured[$name] = Required-Environment $name }
  foreach ($name in @([Environment]::GetEnvironmentVariables("Process").Keys)) {
    [Environment]::SetEnvironmentVariable([String]$name, $null, "Process")
  }
  foreach ($entry in ([ordered]@{
    SystemRoot = "C:\Windows"
    WINDIR = "C:\Windows"
    ComSpec = "C:\Windows\System32\cmd.exe"
    PATH = "C:\Windows\System32;C:\Windows"
    PATHEXT = ".COM;.EXE;.BAT;.CMD"
    TEMP = "C:\Windows\System32"
    TMP = "C:\Windows\System32"
  }).GetEnumerator()) {
    [Environment]::SetEnvironmentVariable([String]$entry.Key, [String]$entry.Value, "Process")
  }
  if ($captured.SystemRoot -cne "C:\Windows" -or $captured.WINDIR -cne "C:\Windows" -or
      $captured.ComSpec -cne "C:\Windows\System32\cmd.exe" -or
      $captured.PATH -cne "C:\Windows\System32;C:\Windows" -or
      $captured.PATHEXT -notin @(".COM;.EXE;.BAT;.CMD", ".COM;.EXE;.BAT;.CMD;.CPL") -or
      $captured.PSModulePath -notin @(
        "C:\Windows\System32\WindowsPowerShell\v1.0\Modules",
        "C:\Program Files\WindowsPowerShell\Modules;C:\Windows\System32\WindowsPowerShell\v1.0\Modules"
      ) -or
      $captured.TEMP -cne "C:\Windows\System32" -or $captured.TMP -cne "C:\Windows\System32") {
    throw "Annual-Launch-Prozess besitzt keine feste sichere Windows-Umgebung."
  }

  $contextBase64 = [String]$captured.ZUGFOLGE_OPERATIONAL_LAUNCH_CONTEXT_BASE64
  if ($contextBase64.Length -le 0 -or $contextBase64.Length -gt 1048576 -or
      ($contextBase64.Length % 4) -ne 0 -or $contextBase64 -cnotmatch "^[A-Za-z0-9+/]*={0,2}$") {
    throw "Annual-Launch-Kontext ist kein begrenztes kanonisches Base64."
  }
  $utf8 = New-Object Text.UTF8Encoding($false, $true)
  $contextBytes = [Convert]::FromBase64String($contextBase64)
  if ([Convert]::ToBase64String($contextBytes) -cne $contextBase64) {
    throw "Annual-Launch-Kontext ist nicht kanonisch Base64-kodiert."
  }
  $contextText = $utf8.GetString($contextBytes)
  $context = $contextText | ConvertFrom-Json
  Assert-ExactKeys $context @(
    "schema", "runtimePath", "executionPinsPath", "specificationPath",
    "sourceRoot", "candidatePath", "candidateSidecarPath", "reportPath", "nativeReceiptPath"
  ) "Annual-Launch-Kontext"
  if ($context.schema -cne "zugfolge-operational-v2-direct-system-launch-context/v1") {
    throw "Annual-Launch-Kontext besitzt ein falsches Schema."
  }
  $canonicalContext = [ordered]@{}
  foreach ($name in @($context.PSObject.Properties.Name | Sort-Object)) {
    $canonicalContext[$name] = [String]$context.$name
  }
  if (($canonicalContext | ConvertTo-Json -Compress) -cne $contextText) {
    throw "Annual-Launch-Kontext ist kein eindeutiges kanonisches JSON."
  }
  foreach ($property in $context.PSObject.Properties) {
    $value = [String]$property.Value
    if ([String]::IsNullOrEmpty($value) -or $value -match "[\x00-\x1f]") {
      throw "Annual-Launch-Kontext besitzt einen leeren oder ungueltigen Wert."
    }
  }
  $workspaceInput = [String]$captured.ZUGFOLGE_OPERATIONAL_WORKSPACE_ROOT
  if (-not [IO.Path]::IsPathRooted($workspaceInput) -or $workspaceInput -match "[\x00-\x1f]") {
    throw "Annual-Launch-Arbeitswurzel ist nicht absolut."
  }
  $workspaceRoot = [IO.Path]::GetFullPath($workspaceInput).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ($workspaceRoot -cne $workspaceInput.TrimEnd([IO.Path]::DirectorySeparatorChar)) {
    throw "Annual-Launch-Arbeitswurzel ist nicht kanonisch."
  }
  $contractRelativePath = [String]$captured.ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_PATH
  $contractExpectedBytes = [Int32]::Parse([String]$captured.ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_BYTES, [Globalization.CultureInfo]::InvariantCulture)
  $contractExpectedSha256 = [String]$captured.ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_SHA256
  if ($contractExpectedBytes -le 0 -or $contractExpectedBytes -gt 2097152 -or
      $contractExpectedSha256 -cnotmatch "^[a-f0-9]{64}$") {
    throw "Annual-Launch-Vertragsbeleg ist ungueltig."
  }
  $contractPath = Workspace-Path $workspaceRoot $contractRelativePath "Annual-Launch-Vertrag"
  $contractHandle = [IO.File]::Open($contractPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  if ($contractHandle.Length -ne $contractExpectedBytes) { throw "Gehaltene Annual-Launch-Vertragsdatei besitzt eine falsche Bytezahl." }
  $contractBytes = Read-HeldBytes $contractHandle $contractExpectedBytes "Annual-Launch-Vertrag"
  if ((Hex-Sha256 $contractBytes) -cne $contractExpectedSha256) { throw "Gehaltene Annual-Launch-Vertragsdatei besitzt einen falschen SHA-256." }
  $contract = $utf8.GetString($contractBytes) | ConvertFrom-Json
  Assert-ExactKeys $contract @(
    "schema", "releaseId", "platform", "executionPins", "launcher", "dynamicBindings", "bootstrap", "trustedExecutor"
  ) "Annual-Launch-Vertrag"
  Assert-ExactKeys $contract.executionPins @("file", "bytes", "sha256", "schema") "Annual-Launch-Execution-Pins"
  Assert-ExactKeys $contract.trustedExecutor @("file", "buildCommit", "bytes", "sha256") "Annual-Launch-Trusted-Executor"
  if ($contract.schema -cne $captured.ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_SCHEMA -or
      $contract.releaseId -cne $captured.ZUGFOLGE_OPERATIONAL_EXPECTED_RELEASE_ID -or
      $contract.platform -cne "win32" -or
      $contract.executionPins.file -cne $captured.ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_FILE -or
      [String]$contract.executionPins.bytes -cne $captured.ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_BYTES -or
      $contract.executionPins.sha256 -cne $captured.ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_SHA256 -or
      $contract.executionPins.schema -cne $captured.ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_SCHEMA -or
      $contract.trustedExecutor.file -cne $captured.ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_FILE -or
      $contract.trustedExecutor.buildCommit -cne $captured.ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_BUILD_COMMIT -or
      [String]$contract.trustedExecutor.bytes -cne $captured.ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_BYTES -or
      $contract.trustedExecutor.sha256 -cne $captured.ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_SHA256) {
    throw "Gehaltene Annual-Launch-Vertragsdatei driftet vom semantischen Rust-Planbeleg."
  }
  Assert-ExactKeys $contract.bootstrap @("mode", "sourceEncoding", "sourceBase64", "sourceBytes", "sourceSha256") "Annual-Launch-Inline-Bootstrap"
  $bootstrapBytes = [Convert]::FromBase64String([String]$contract.bootstrap.sourceBase64)
  if ($contract.bootstrap.mode -cne "held-contract-inline-powershell-v1" -or
      $contract.bootstrap.sourceEncoding -cne "utf-8" -or
      [Convert]::ToBase64String($bootstrapBytes) -cne $contract.bootstrap.sourceBase64 -or
      $bootstrapBytes.Length -ne $contract.bootstrap.sourceBytes -or
      (Hex-Sha256 $bootstrapBytes) -cne $contract.bootstrap.sourceSha256) {
    throw "Annual-Launch-Inline-Bootstrap driftet von seinem gehaltenen Vertragsbeleg."
  }
  $annualLaunchProof = [ordered]@{
    contract = [ordered]@{
      bytes = $contractExpectedBytes
      file = $contractRelativePath
      releaseId = [String]$contract.releaseId
      schema = [String]$contract.schema
      sha256 = $contractExpectedSha256
    }
    executionPins = [ordered]@{
      bytes = [Int64]$contract.executionPins.bytes
      file = [String]$contract.executionPins.file
      schema = [String]$contract.executionPins.schema
      sha256 = [String]$contract.executionPins.sha256
    }
    mode = "held-direct-contract-windows-v1"
    trustedExecutor = [ordered]@{
      buildCommit = [String]$contract.trustedExecutor.buildCommit
      bytes = [Int64]$contract.trustedExecutor.bytes
      file = [String]$contract.trustedExecutor.file
      sha256 = [String]$contract.trustedExecutor.sha256
    }
  }
  & ([ScriptBlock]::Create($utf8.GetString($bootstrapBytes))) $contract $context $workspaceRoot $annualLaunchProof
} catch {
  [Console]::Error.Write($_.Exception.ToString())
  exit 90
} finally {
  if ($null -ne $contractHandle) { $contractHandle.Dispose() }
}
