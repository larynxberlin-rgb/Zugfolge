import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { sha256Bytes } from "./release-crypto.mjs";

const [sourceRootInput, artifactRootInput, outputPathInput] = process.argv.slice(2);
if (!sourceRootInput || !artifactRootInput || !outputPathInput) {
  throw new Error("Aufruf: node build-infra-release.mjs SOURCE_ROOT ARTIFACT_ROOT OUTPUT.json");
}
const sourceRoot = resolve(sourceRootInput);
const artifactRoot = resolve(artifactRootInput);
const outputPath = resolve(outputPathInput);

async function fileHash(path) {
  const hasher = (await import("node:crypto")).createHash("sha256");
  for await (const chunk of createReadStream(path)) hasher.update(chunk);
  return hasher.digest("hex");
}

async function descriptor(root, file, extra = {}) {
  const path = resolve(root, file);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${path} ist keine Datei.`);
  return { file, bytes: metadata.size, sha256: await fileHash(path), ...extra };
}

async function pipeline(path) {
  const contents = await readFile(resolve(path));
  return { path: path.replaceAll("\\", "/"), sha256: sha256Bytes(contents) };
}

const [gtfs, operational, pbf, validation] = await Promise.all([
  readFile(resolve(artifactRoot, "gtfs-region-20260812-v2.json"), "utf8").then(JSON.parse),
  readFile(resolve(artifactRoot, "operational-network.json"), "utf8").then(JSON.parse),
  readFile(resolve(artifactRoot, "pbf-release-report.json"), "utf8").then(JSON.parse),
  readFile(resolve(artifactRoot, "independent-validation-set.json"), "utf8").then(JSON.parse),
]);
if (validation.artifact.result !== "passed" || validation.artifact.selection.calibrationDataUsed !== false) {
  throw new Error("Der unabhaengige technische Validierungssatz ist nicht bestanden.");
}
if (operational.network.metrics.qualityCSegmentCount < 1
  || operational.network.segmentQualifications.some((segment) => segment.qualityClass === "C" && segment.orderable)) {
  throw new Error("Klasse C ist nicht sichtbar oder faelschlich bestellbar.");
}

const sources = await Promise.all([
  descriptor(sourceRoot, "sachsen-latest.osm.pbf", { id: "geofabrik-sachsen-2026-08-10", rightsSourceId: "osm-pbf-mitteldeutschland-b", url: "https://download.geofabrik.de/europe/germany/sachsen-latest.osm.pbf", sourceLicense: "ODbL-1.0", attribution: "OpenStreetMap contributors; Geofabrik GmbH" }),
  descriptor(sourceRoot, "sachsen-anhalt-latest.osm.pbf", { id: "geofabrik-sachsen-anhalt-2026-08-10", rightsSourceId: "osm-pbf-mitteldeutschland-b", url: "https://download.geofabrik.de/europe/germany/sachsen-anhalt-latest.osm.pbf", sourceLicense: "ODbL-1.0", attribution: "OpenStreetMap contributors; Geofabrik GmbH" }),
  descriptor(sourceRoot, "thueringen-latest.osm.pbf", { id: "geofabrik-thueringen-2026-08-10", rightsSourceId: "osm-pbf-mitteldeutschland-b", url: "https://download.geofabrik.de/europe/germany/thueringen-latest.osm.pbf", sourceLicense: "ODbL-1.0", attribution: "OpenStreetMap contributors; Geofabrik GmbH" }),
  descriptor(sourceRoot, "gtfs-rv-free-2026-08-10.zip", { id: "gtfs-de-rv-free-2026-08-10", rightsSourceId: "gtfs-de-rv", url: "https://download.gtfs.de/germany/rv_free/latest.zip", sourceLicense: "CC-BY-4.0", attribution: "DELFI e.V.; GTFS.DE" }),
  descriptor(artifactRoot, "trassenfinder-infrastruktur-2026.json", { id: "trassenfinder-infrastruktur-7-2026", rightsSourceId: "trassenfinder-infrastruktur-api", url: "https://openapi.trassenfinder.de/api/v10/infrastrukturen/7", sourceLicense: "Keine veroeffentlichten Nutzungsbedingungen", attribution: "DB InfraGO" }),
]);
const artifacts = await Promise.all([
  descriptor(artifactRoot, "mitteldeutschland-b-ebo.osm.pbf", { kind: "ebo-pbf-extract" }),
  descriptor(artifactRoot, "gtfs-region-20260812-v2.json", { kind: "gtfs-planning-snapshot", stateHash: gtfs.snapshotHash }),
  descriptor(artifactRoot, "operational-network.json", { kind: "operational-network", stateHash: operational.networkHash }),
  descriptor(artifactRoot, "pbf-release-report.json", { kind: "blocks-routes-quality", blocksHash: pbf.derivations.blocksHash, interlockingRoutesHash: pbf.derivations.interlockingRoutesHash }),
  descriptor(artifactRoot, "independent-validation-set.json", { kind: "independent-technical-validation", stateHash: validation.validationHash }),
  descriptor(artifactRoot, "mitteldeutschland-b.pmtiles", { kind: "livemap-pmtiles" }),
]);
const pipelineFiles = [
  "tools/region-import/import-mitteldeutschland-b.sh",
  "tools/region-import/import-mitteldeutschland-b.ps1",
  "tools/region-import/build-gtfs-region.mjs",
  "tools/region-import/service-scope.mjs",
  "tools/region-import/build-operational-network.mjs",
  "tools/region-import/operational-network.mjs",
  "tools/region-import/map-layers.mjs",
  "tools/region-import/build-map-layers.mjs",
  "tools/region-import/validation-set.mjs",
  "tools/region-import/build-validation-set.mjs",
  "tools/region-import/build-infra-release.mjs",
  "tools/region-import/release-crypto.mjs",
  "tools/region-import/sign-release.mjs",
  "tools/region-import/verify-release.mjs",
  "crates/zugfolge-infra/examples/pbf_release_report.rs",
];

const manifest = {
  schema: "zugfolge-infra-release/v1",
  releaseId: "infra-mitteldeutschland-b-2026.1",
  status: "qualified",
  regionId: "mitteldeutschland-b",
  regionVariant: "B",
  timetableYear: 2026,
  validFrom: operational.network.validFrom,
  validUntil: operational.network.validUntil,
  decisions: [
    { id: "E22", adr: "docs/adr/0022-jaehrliche-infrastrukturaktualisierung.md" },
    { id: "E24", adr: "docs/adr/0024-erweiterter-alpha-schnitt.md", issue: "https://github.com/larynxberlin-rgb/Zugfolge/issues/201" },
    { id: "E25", adr: "docs/adr/0025-gebietsueberschreitende-fahrtketten.md" },
  ],
  boundary: {
    ...(await descriptor(".", "tools/region-import/mitteldeutschland-b.geojson")),
    polygonFile: "tools/region-import/mitteldeutschland-b.poly",
    polygonSha256: await fileHash(resolve("tools/region-import/mitteldeutschland-b.poly")),
  },
  sources,
  pipeline: {
    scripts: await Promise.all(pipelineFiles.map(pipeline)),
    tools: [
      { name: "osmium-tool", version: "1.16.0" },
      { name: "tippecanoe", version: "2.79.0", commit: "68ab8dcc229f95b8b25877697d5e8d66783af503" },
      { name: "go-pmtiles", version: "1.31.2", commit: "a3e4951ea6a0477b784c27c1dcbfd9c130878c5a", linuxX8664Sha256: "3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f" },
    ],
  },
  artifacts,
  quality: {
    sections: pbf.quality.classes,
    operationalSegments: {
      B: operational.network.metrics.qualityBSegmentCount,
      C: operational.network.metrics.qualityCSegmentCount,
    },
    classCVisible: true,
    classCOrderable: false,
    orderableJourneyChains: operational.network.metrics.orderableJourneyChainCount,
    conflictResources: operational.network.metrics.conflictResourceCount,
    blocks: pbf.topology.conservativeConflictResources,
    interlockingRoutes: pbf.derivations.interlockingRoutes.length,
  },
  rights: {
    registry: "tools/guards/quellenregister.json",
    approvedSourceIds: [...new Set(sources.map((source) => source.rightsSourceId))].sort(),
    stationSource: "trassenfinder-infrastruktur-api",
    elevation: {
      included: false,
      rightsApproved: true,
      reason: "Kein versionierter Copernicus-DEM-Snapshot im Release; deshalb keine Hoehenwerte geraten oder importiert.",
      operationalEffect: "Abschnitte ohne unabhaengigen Neigungsnachweis bleiben hoechstens Klasse B; Klasse A wird nicht behauptet.",
    },
    attributionReport: "docs/mitteldeutschland-alpha.md",
  },
  validation: {
    issue: "https://github.com/larynxberlin-rgb/Zugfolge/issues/48",
    independentFromCalibration: true,
    result: validation.artifact.result,
    checkCount: validation.artifact.metrics.checkCount,
    failedCount: validation.artifact.metrics.failedCount,
    validationHash: validation.validationHash,
  },
  releaseApproval: {
    releaseResponsible: "Sebastian Barowski",
    responsibilityGrantedBy: "user-approval-2026-08-12",
    activationAllowed: true,
    activationAuthority: "game-system-only",
  },
};
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ releaseId: manifest.releaseId, sources: sources.length, artifacts: artifacts.length, output: basename(outputPath) }));
