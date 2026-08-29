
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
