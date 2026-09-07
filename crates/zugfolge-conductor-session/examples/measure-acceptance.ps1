param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateRange(3, 100)][int]$Samples = 15
)
$ErrorActionPreference = 'Stop'
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($outputPath) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$rows = @()
$network = $null
foreach ($configuration in 1..3) {
    # Nur dieser eigene lokale Prüfprozess wird gestartet und beendet.
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $binaryPath
    $start.Arguments = [string]$configuration
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $process.StandardInput.WriteLine('source')
        $source = $process.StandardOutput.ReadLine() | ConvertFrom-Json
        if ($null -eq $source) { throw 'Quellnachweis fehlt.' }
        $phases = [ordered]@{}
        foreach ($phase in @('layout', 'demand', 'projection', 'start', 'restore')) {
            $process.StandardInput.WriteLine($phase)
            $expected = $process.StandardOutput.ReadLine()
            if ($null -eq $expected) { throw 'Aufwärmantwort fehlt.' }
            $times = @()
            for ($sample = 0; $sample -lt $Samples; $sample++) {
                $watch = [Diagnostics.Stopwatch]::StartNew()
                $process.StandardInput.WriteLine($phase)
                $actual = $process.StandardOutput.ReadLine()
                $watch.Stop()
                if ($actual -cne $expected) { throw 'Nichtdeterministische Prüfantwort.' }
                $times += [long][Math]::Ceiling($watch.ElapsedTicks * 1000000.0 / [Diagnostics.Stopwatch]::Frequency)
            }
            $sorted = @($times | Sort-Object)
            $phases[$phase] = [ordered]@{
                medianUs = $sorted[[int][Math]::Floor($Samples / 2)]
                p95Us = $sorted[[int][Math]::Ceiling($Samples * 0.95) - 1]
                maxUs = $sorted[-1]
                samplesUs = $times
                result = ($expected | ConvertFrom-Json)
            }
        }
        if ($configuration -eq 2) {
            $process.StandardInput.WriteLine('network')
            $network = $process.StandardOutput.ReadLine() | ConvertFrom-Json
            if ($null -eq $network) { throw 'Mehrzugnachweis fehlt.' }
        }
        $rows += [ordered]@{ source = $source; phases = $phases }
    } finally {
        if (-not $process.HasExited) {
            $process.StandardInput.WriteLine('quit')
            $process.StandardInput.Close()
            if (-not $process.WaitForExit(10000)) { $process.Kill() }
        }
        $process.Dispose()
    }
}
$report = [ordered]@{
    schemaVersion = 'conductor-core-measurement/v1'
    testOnly = $true
    measuredAtUtc = [DateTime]::UtcNow.ToString('o')
    profile = 'release'
    compilerVersion = (& rustc --version)
    sampleCount = $Samples
    warmupCountPerPhase = 1
    transport = 'local-jsonl-core-and-serialization-without-db-http-rendering'
    os = [Environment]::OSVersion.VersionString
    processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    processorCount = [Environment]::ProcessorCount
    binarySha256 = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    configurations = $rows
}
[IO.File]::WriteAllText((Join-Path $outputPath 'core-measurement-v1.json'), (($report | ConvertTo-Json -Depth 30).Replace("`r`n", "`n") + "`n"), $utf8)
[IO.File]::WriteAllText((Join-Path $outputPath 'network-consequence-v1.json'), (($network | ConvertTo-Json -Depth 100).Replace("`r`n", "`n") + "`n"), $utf8)
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$inputFiles = @('Cargo.toml', 'Cargo.lock',
    'crates/zugfolge-fleet/tests/fixtures/vehicle-catalog-source-v2-interior.json',
    'crates/zugfolge-fleet/tests/fixtures/vehicle-world-seed-v3-interior.json',
    'crates/zugfolge-demand/examples/evaluation.json',
    'assets/conductor-dialogue/v1/release.json',
    'crates/zugfolge-conductor-session/examples/measure-acceptance.ps1')
# Vollständiger lokaler Rust-Abhängigkeitsbaum des Messadapters einschließlich Testproduzenten.
foreach ($crate in @('conductor-session', 'conductor', 'conductor-dialogue', 'demand', 'fleet', 'sim', 'infra', 'conflict', 'runtime', 'determinism')) {
    $relativeCrate = "crates/zugfolge-$crate"
    $inputFiles += "$relativeCrate/Cargo.toml"
    $inputFiles += Get-ChildItem -LiteralPath (Join-Path $repository $relativeCrate) -Filter '*.rs' -Recurse -File |
        ForEach-Object { [IO.Path]::GetRelativePath($repository, $_.FullName).Replace('\', '/') }
}
$entries = @($inputFiles | Sort-Object -Unique | ForEach-Object {
    $content = [IO.File]::ReadAllText((Join-Path $repository $_))
    $sourceHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        $utf8.GetBytes($content.Replace("`r`n", "`n"))))
    [ordered]@{ path = $_; sha256 = $sourceHash.ToLowerInvariant() }
})
$inputManifest = [ordered]@{
    schemaVersion = 'conductor-core-input-manifest/v1'; testOnly = $true
    hashEncoding = 'utf8-lf-without-bom'; files = $entries
}
[IO.File]::WriteAllText((Join-Path $outputPath 'input-manifest-v1.json'), (($inputManifest | ConvertTo-Json -Depth 10).Replace("`r`n", "`n") + "`n"), $utf8)
$rows | ForEach-Object { [pscustomobject]@{ configuration = $_.source.configuration; passengers = $_.source.passengers; layoutP95Us = $_.phases.layout.p95Us; demandP95Us = $_.phases.demand.p95Us; projectionP95Us = $_.phases.projection.p95Us; startP95Us = $_.phases.start.p95Us; restoreP95Us = $_.phases.restore.p95Us } } | Format-Table
