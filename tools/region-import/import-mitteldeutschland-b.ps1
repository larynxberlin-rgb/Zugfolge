# zugfolge:quelle=osm-pbf-mitteldeutschland-b
param(
  [Parameter(Mandatory = $true)][string]$Osmium,
  [string]$SourceDirectory = "data/infra/mitteldeutschland-b/2026-08/sources",
  [string]$OutputDirectory = "data/infra/mitteldeutschland-b/2026-08/derived"
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$source = (Resolve-Path (Join-Path $workspace $SourceDirectory)).Path
$boundary = (Resolve-Path (Join-Path $PSScriptRoot "mitteldeutschland-b.geojson")).Path
$output = Join-Path $workspace $OutputDirectory
New-Item -ItemType Directory -Force -Path $output | Out-Null

$expectedMd5 = [ordered]@{
  "sachsen-latest.osm.pbf" = "58beffe884515cfdfd06ecc54743cecb"
  "sachsen-anhalt-latest.osm.pbf" = "fbd617536742eb9c9128265e3e2276fe"
  "thueringen-latest.osm.pbf" = "533bc356dfa79df75ac3eb84c855cc1f"
}
foreach ($entry in $expectedMd5.GetEnumerator()) {
  $path = Join-Path $source $entry.Key
  if (-not (Test-Path -LiteralPath $path)) { throw "Quell-Extract fehlt: $path" }
  $actual = (Get-FileHash -Algorithm MD5 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($actual -ne $entry.Value) { throw "MD5-Pruefung fuer $($entry.Key) fehlgeschlagen: $actual" }
}

$merged = Join-Path $output "three-states.osm.pbf"
$clipped = Join-Path $output "mitteldeutschland-b-clipped.osm.pbf"
$rail = Join-Path $output "mitteldeutschland-b-ebo.osm.pbf"

& $Osmium merge --overwrite -o $merged @($expectedMd5.Keys | ForEach-Object { Join-Path $source $_ })
if ($LASTEXITCODE -ne 0) { throw "osmium merge fehlgeschlagen ($LASTEXITCODE)." }
& $Osmium extract --overwrite --strategy smart -p $boundary -o $clipped $merged
if ($LASTEXITCODE -ne 0) { throw "osmium extract fehlgeschlagen ($LASTEXITCODE)." }
& $Osmium tags-filter --overwrite -o $rail $clipped `
  "w/railway=rail" `
  "n/railway=station,halt,stop,signal,switch,buffer_stop,railway_crossing" `
  "n/public_transport=station,stop_position" `
  "r/route=train" `
  "r/type=route,route_master" `
  "r/public_transport=stop_area,stop_area_group"
if ($LASTEXITCODE -ne 0) { throw "osmium tags-filter fehlgeschlagen ($LASTEXITCODE)." }

$artifacts = @($merged, $clipped, $rail) | ForEach-Object {
  $item = Get-Item -LiteralPath $_
  [ordered]@{
    name = $item.Name
    bytes = $item.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash.ToLowerInvariant()
  }
}
[ordered]@{
  schema = "zugfolge-region-import-report/v1"
  regionId = "mitteldeutschland-b"
  boundarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $boundary).Hash.ToLowerInvariant()
  sourceMd5 = $expectedMd5
  osmiumVersion = (& $Osmium --version | Select-Object -First 1)
  artifacts = $artifacts
} | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $output "import-report.json")

Get-Content -Raw (Join-Path $output "import-report.json")
