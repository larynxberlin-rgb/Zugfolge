import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  buildMapAssetTreeProof,
  sameMapAssetTreeProof,
  validateMapAssetNotices,
} from "./map-asset-notices.mjs";
import { assertCreateNewTarget, publishFileCreateNew } from "./create-new-output.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const PROTOMAPS_DAILY_URL = /^https:\/\/build-tiles\.protomaps\.dev\/(20\d{6})\.json$/;
const MAP_SOURCE_CAPTURE_SCHEMA = "zugfolge-map-source-capture/v2";
const CACHE_INVENTORY_PLAN_SCHEMA = "zugfolge-map-build-cache-inventory-plan/v1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

export function serializeMapSourceCapture(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value), null, 2)}\n`, "utf8");
}

async function fileProof(path, label, minimumBytes = 127) {
  const resolved = resolve(path);
  const metadata = await lstat(resolved);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > minimumBytes, `${label} ist keine reguläre finale Datei.`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(resolved)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  invariant(bytes === metadata.size, `${label} änderte sich während der Hashbildung.`);
  return { bytes, sha256: hash.digest("hex") };
}

function portableRelativePath(value, label) {
  invariant(typeof value === "string" && value !== "" && !value.includes("\\") && !value.includes("\0"), `${label} ist kein portabler relativer Pfad.`);
  invariant(!isAbsolute(value) && !value.startsWith("/") && !/^[a-z]:/i.test(value), `${label} muss relativ sein.`);
  invariant(value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), `${label} enthaelt ein unsicheres Segment.`);
  return value;
}

async function containedRegularFile(rootInput, portable, label) {
  const root = await realpath(resolve(rootInput));
  const requested = resolve(root, ...portableRelativePath(portable, label).split("/"));
  const requestedRemainder = relative(root, requested);
  invariant(requestedRemainder !== "" && requestedRemainder !== ".." && !requestedRemainder.startsWith(`..${sep}`) && !isAbsolute(requestedRemainder), `${label} verlaesst die Artefaktwurzel.`);
  const path = await realpath(requested);
  const remainder = relative(root, path);
  invariant(remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder), `${label} verlaesst die reale Artefaktwurzel.`);
  const metadata = await lstat(requested);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} muss eine regulaere Datei sein.`);
  return path;
}

export async function validateCapturedMapAssetTrees(assetNoticesInput, cacheInventoryPlan, artifactRoot) {
  const assetNotices = validateMapAssetNotices(assetNoticesInput);
  invariant(cacheInventoryPlan?.schema === CACHE_INVENTORY_PLAN_SCHEMA && Array.isArray(cacheInventoryPlan.files), "Unbekannter Karten-Build-Cacheplan fuer die Asseterfassung.");
  const cachePaths = new Set();
  const sourcePaths = new Set();
  for (const [index, entry] of cacheInventoryPlan.files.entries()) {
    portableRelativePath(entry?.cacheFile, `Cacheplan.files[${index}].cacheFile`);
    portableRelativePath(entry?.sourceFile, `Cacheplan.files[${index}].sourceFile`);
    invariant(!cachePaths.has(entry.cacheFile.toLowerCase()), `Cacheplan enthaelt den Asset-/Cachepfad ${entry.cacheFile} doppelt.`);
    invariant(!sourcePaths.has(entry.sourceFile.toLowerCase()), `Cacheplan enthaelt den Quellpfad ${entry.sourceFile} doppelt.`);
    cachePaths.add(entry.cacheFile.toLowerCase());
    sourcePaths.add(entry.sourceFile.toLowerCase());
  }

  let files = 0;
  for (const asset of assetNotices.assets) {
    const cachePrefix = `sources/basemap/${asset.tree.installDirectory}/`;
    const descriptors = [];
    for (const entry of cacheInventoryPlan.files.filter(({ cacheFile }) => cacheFile.startsWith(cachePrefix))) {
      const suffix = entry.cacheFile.slice(cachePrefix.length);
      portableRelativePath(suffix, `${asset.id}.cacheFile`);
      const sourcePath = await containedRegularFile(artifactRoot, entry.sourceFile, `${asset.id}.sourceFile`);
      const proof = await fileProof(sourcePath, `${asset.id}:${suffix}`, 0);
      descriptors.push({
        id: `${asset.id}-${descriptors.length + 1}`,
        kind: asset.kind,
        installPath: `${asset.tree.installDirectory}/${suffix}`,
        bytes: proof.bytes,
        sha256: proof.sha256,
      });
    }
    const observed = buildMapAssetTreeProof(asset.kind, asset.tree.installDirectory, descriptors);
    invariant(sameMapAssetTreeProof(observed, asset.tree), `${asset.id} weicht im Cache-Inventar oder in den realen Quelldateien vom freigegebenen Assetbaum ab.`);
    files += observed.files;
  }
  const cacheInventoryPlanSha256 = createHash("sha256")
    .update(JSON.stringify(sortedValue(cacheInventoryPlan)), "utf8")
    .digest("hex");
  return { assetNotices, files, cacheInventoryPlanSha256 };
}

function readInfraRelease(value) {
  const release = value?.release ?? value;
  invariant(release?.schema === "zugfolge-infra-release/v2", "InfraRelease hat kein öffentliches v2-Schema.");
  invariant(typeof release.releaseId === "string" && release.releaseId !== "", "InfraRelease besitzt keine releaseId.");
  invariant(Number.isSafeInteger(release.timetableYear) && release.timetableYear >= 2026, "InfraRelease besitzt kein Fahrplanjahr.");
  invariant(Array.isArray(release.artifacts) && release.artifacts.length > 0, "InfraRelease besitzt kein öffentliches Artefaktinventar.");
  return release;
}

export function deriveProtomapsDailyVersion(style, metadata) {
  invariant(style?.version === 8 && style.sources !== null && typeof style.sources === "object", "Protomaps-Upstreamstil hat ein unbekanntes Schema.");
  const sourceUrls = Object.values(style.sources).map((source) => source?.url).filter((url) => typeof url === "string");
  invariant(sourceUrls.length === 1, "Protomaps-Upstreamstil muss genau eine gepinnte Quelle besitzen.");
  const match = PROTOMAPS_DAILY_URL.exec(sourceUrls[0]);
  invariant(match !== null, "Protomaps-Quelle ist kein gepinnter HTTPS-Tagesbuild.");
  const day = match[1];
  const replicationTime = metadata?.["planetiler:osm:osmosisreplicationtime"];
  const replicationSequence = metadata?.["planetiler:osm:osmosisreplicationseq"];
  const basemapVersion = metadata?.version;
  invariant(typeof replicationTime === "string" && !Number.isNaN(Date.parse(replicationTime)), "PMTiles-Metadaten besitzen keine OSM-Replikationszeit.");
  invariant(replicationTime.slice(0, 10).replaceAll("-", "") === day, "Protomaps-Tagesbuild und PMTiles-Replikationszeit widersprechen sich.");
  invariant(typeof replicationSequence === "string" && /^\d+$/.test(replicationSequence), "PMTiles-Metadaten besitzen keine OSM-Replikationssequenz.");
  invariant(typeof basemapVersion === "string" && /^\d+\.\d+\.\d+$/.test(basemapVersion), "PMTiles-Metadaten besitzen keine Basemap-Schemaversion.");
  return {
    day,
    version: `${day}+osm-${replicationSequence}+basemap-${basemapVersion}`,
    capturedAt: replicationTime,
    sourceUrl: sourceUrls[0],
  };
}

export async function buildMapSourceCapture({
  upstreamStyle,
  hybridMetadata,
  hybridPath,
  infrastructurePath,
  infraRelease: infraInput,
  assetNotices: assetNoticesInput,
  cacheInventoryPlan,
  artifactRoot,
}) {
  const version = deriveProtomapsDailyVersion(upstreamStyle, hybridMetadata);
  const infraRelease = readInfraRelease(infraInput);
  invariant(cacheInventoryPlan?.releaseId === infraRelease.releaseId, "Karten-Build-Cacheplan und InfraRelease nennen verschiedene Release-IDs.");
  const capturedAssets = await validateCapturedMapAssetTrees(assetNoticesInput, cacheInventoryPlan, artifactRoot);
  const [basemap, infrastructure] = await Promise.all([
    fileProof(hybridPath, "Finale Hybrid-Basemap"),
    fileProof(infrastructurePath, "Finale Infrastruktur-PMTiles"),
  ]);
  const infrastructureArtifact = infraRelease.artifacts.find((artifact) => artifact.id === "infra-deutschland-2026.1" || artifact.kind === "infrastructure" || artifact.file === "infra-deutschland-2026.1.pmtiles");
  invariant(infrastructureArtifact !== undefined, "InfraRelease inventarisiert die finale Infrastruktur-PMTiles nicht.");
  invariant(infrastructureArtifact.bytes === infrastructure.bytes && infrastructureArtifact.sha256 === infrastructure.sha256, "InfraRelease und finale Infrastrukturdatei weichen bytegenau ab.");
  const capture = {
    schema: MAP_SOURCE_CAPTURE_SCHEMA,
    capturedAt: version.capturedAt,
    sources: [
      {
        id: "infrarelease-deutschland",
        version: infraRelease.releaseId,
        bytes: infrastructure.bytes,
        sha256: infrastructure.sha256,
      },
      {
        id: "protomaps-daily-basemap",
        version: version.version,
        bytes: basemap.bytes,
        sha256: basemap.sha256,
      },
    ],
    assetNotices: capturedAssets.assetNotices,
    assetInventoryPlanSha256: capturedAssets.cacheInventoryPlanSha256,
  };
  invariant(capture.sources.every(({ sha256 }) => SHA256.test(sha256)), "Karten-Capture besitzt einen ungültigen SHA-256.");
  return { capture, captureBytes: serializeMapSourceCapture(capture), protomaps: version, assetFiles: capturedAssets.files };
}

export async function writeMapSourceCapture(result, outputPath) {
  const path = resolve(outputPath);
  await assertCreateNewTarget(path, "Karten-Source-Capture-Ziel");
  await mkdir(dirname(path), { recursive: true });
  const temporaryRoot = await mkdtemp(join(dirname(path), `.${basename(path)}.writing-`));
  const temporaryPath = join(temporaryRoot, basename(path));
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(result.captureBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publishFileCreateNew(temporaryPath, path, "Karten-Source-Capture-Ziel");
    return { path, status: "written" };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
