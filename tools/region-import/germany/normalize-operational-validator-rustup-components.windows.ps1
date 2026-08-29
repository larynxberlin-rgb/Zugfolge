param(
  [Parameter(Mandatory = $true)]
  [string] $ToolchainRoot,
  [Parameter(Mandatory = $true)]
  [ValidateSet('x86_64-pc-windows-gnu')]
  [string] $TargetTriple
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-EqualBytes([byte[]] $Left, [byte[]] $Right) {
  if ($Left.Length -ne $Right.Length) { return $false }
  for ($index = 0; $index -lt $Left.Length; $index++) {
    if ($Left[$index] -ne $Right[$index]) { return $false }
  }
  return $true
}

function Get-Sha256([byte[]] $Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}

$root = [IO.Path]::GetFullPath($ToolchainRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not [IO.Path]::IsPathRooted($root)) { throw 'Toolchain-Wurzel ist nicht absolut.' }
$lib = [IO.Path]::GetFullPath([IO.Path]::Combine($root, 'lib'))
$rustlib = [IO.Path]::GetFullPath([IO.Path]::Combine($lib, 'rustlib'))
$componentsPath = [IO.Path]::GetFullPath([IO.Path]::Combine($rustlib, 'components'))
if ([IO.Path]::GetDirectoryName($componentsPath).TrimEnd([IO.Path]::DirectorySeparatorChar) -cne $rustlib) {
  throw 'Rustup-Komponentenpfad verlaesst seine Toolchain-Wurzel.'
}
foreach ($directory in @($root, $lib, $rustlib)) {
  $item = Get-Item -LiteralPath $directory -Force
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "Toolchain-Verzeichnis ist nicht regulaer oder reparsefrei: $directory"
  }
}
$componentsItem = Get-Item -LiteralPath $componentsPath -Force
if ($componentsItem.PSIsContainer -or
    (($componentsItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
    -not [String]::IsNullOrEmpty([string]$componentsItem.LinkType)) {
  throw 'Rustup-Komponentendatei ist nicht regulaer, aliasfrei oder reparsefrei.'
}

$expected = [string[]]@(
  "clippy-preview-$TargetTriple",
  "cargo-$TargetTriple",
  "rust-mingw-$TargetTriple",
  "rust-std-$TargetTriple",
  "rustfmt-preview-$TargetTriple",
  "rustc-$TargetTriple"
)
$encoding = [Text.UTF8Encoding]::new($false, $true)
$canonicalBytes = $encoding.GetBytes(([String]::Join("`n", $expected)) + "`n")
$expectedSha256 = '28e3faf57d2d41bda8c213f5a4333a8a0bc56f544eb21de7341cb750077b46b1'
if ((Get-Sha256 $canonicalBytes) -cne $expectedSha256) { throw 'Interner Rustup-Komponentenpin ist inkonsistent.' }

$handle = [IO.FileStream]::new($componentsPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $heldItem = Get-Item -LiteralPath $componentsPath -Force
  if ($heldItem.PSIsContainer -or
      (($heldItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
      -not [String]::IsNullOrEmpty([string]$heldItem.LinkType)) {
    throw 'Exklusiv geoeffnete Rustup-Komponentendatei ist nicht regulaer, aliasfrei oder reparsefrei.'
  }
  if ($handle.Length -le 0 -or $handle.Length -gt 4096) { throw 'Rustup-Komponentendatei besitzt eine ungueltige Groesse.' }
  $inputBytes = New-Object byte[] ([int]$handle.Length)
  $offset = 0
  while ($offset -lt $inputBytes.Length) {
    $read = $handle.Read($inputBytes, $offset, $inputBytes.Length - $offset)
    if ($read -le 0) { throw 'Rustup-Komponentendatei endete vorzeitig.' }
    $offset += $read
  }
  foreach ($byte in $inputBytes) {
    if ($byte -gt 127) { throw 'Rustup-Komponentendatei ist nicht strikt ASCII.' }
  }
  $text = $encoding.GetString($inputBytes)
  $lines = $text.Split([char[]]@([char]10), [StringSplitOptions]::None)
  if ($lines.Length -ne 7 -or $lines[6] -cne '') {
    throw 'Rustup-Komponentendatei besitzt nicht exakt sechs LF-terminierte Zeilen.'
  }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  for ($index = 0; $index -lt 6; $index++) {
    if (-not $seen.Add($lines[$index])) { throw 'Rustup-Komponentendatei enthaelt ein Duplikat.' }
  }
  if ($seen.Count -ne $expected.Length) { throw 'Rustup-Komponentenmenge besitzt eine ungueltige Groesse.' }
  foreach ($component in $expected) {
    if (-not $seen.Contains($component)) { throw 'Rustup-Komponentenmenge driftet vom Annual-Pin.' }
  }
  if ($inputBytes.Length -ne $canonicalBytes.Length) { throw 'Rustup-Komponentenbytes besitzen trotz gleicher Menge eine ungueltige Laenge.' }

  $handle.Position = 0
  $handle.Write($canonicalBytes, 0, $canonicalBytes.Length)
  $handle.Flush($true)
  $handle.Position = 0
  $readback = New-Object byte[] $canonicalBytes.Length
  $offset = 0
  while ($offset -lt $readback.Length) {
    $read = $handle.Read($readback, $offset, $readback.Length - $offset)
    if ($read -le 0) { throw 'Kanonische Rustup-Komponentendatei endete vorzeitig.' }
    $offset += $read
  }
  if (-not (Test-EqualBytes $readback $canonicalBytes) -or (Get-Sha256 $readback) -cne $expectedSha256) {
    throw 'Rustup-Komponentendatei ist nach exklusivem Schreiben nicht bytekanonisch.'
  }
}
finally {
  $handle.Dispose()
}

[Console]::Out.WriteLine("RUSTUP_COMPONENTS_CANONICAL bytes=$($canonicalBytes.Length) sha256=$expectedSha256")
