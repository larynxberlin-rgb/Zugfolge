import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const PROTOMAPS_DAILY_URL = /^https:\/\/build-tiles\.protomaps\.dev\/(20\d{6})\.json$/;

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

async function fileProof(path, label) {
  const resolved = resolve(path);
  const metadata = await lstat(resolved);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 127, `${label} ist keine reguläre finale Datei.`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(resolved)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  invariant(bytes === metadata.size, `${label} änderte sich während der Hashbildung.`);
  return { bytes, sha256: hash.digest("hex") };
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

export async function buildMapSourceCapture({ upstreamStyle, hybridMetadata, hybridPath, infrastructurePath, infraRelease: infraInput }) {
  const version = deriveProtomapsDailyVersion(upstreamStyle, hybridMetadata);
  const infraRelease = readInfraRelease(infraInput);
  const [basemap, infrastructure] = await Promise.all([
    fileProof(hybridPath, "Finale Hybrid-Basemap"),
    fileProof(infrastructurePath, "Finale Infrastruktur-PMTiles"),
  ]);
  const infrastructureArtifact = infraRelease.artifacts.find((artifact) => artifact.id === "infra-deutschland-2026.1" || artifact.kind === "infrastructure" || artifact.file === "infra-deutschland-2026.1.pmtiles");
  invariant(infrastructureArtifact !== undefined, "InfraRelease inventarisiert die finale Infrastruktur-PMTiles nicht.");
  invariant(infrastructureArtifact.bytes === infrastructure.bytes && infrastructureArtifact.sha256 === infrastructure.sha256, "InfraRelease und finale Infrastrukturdatei weichen bytegenau ab.");
  const capture = {
    schema: "zugfolge-map-source-capture/v1",
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
  };
  invariant(capture.sources.every(({ sha256 }) => SHA256.test(sha256)), "Karten-Capture besitzt einen ungültigen SHA-256.");
  return { capture, captureBytes: serializeMapSourceCapture(capture), protomaps: version };
}

export async function writeMapSourceCapture(result, outputPath) {
  const path = resolve(outputPath);
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = await readFile(path);
    invariant(existing.equals(result.captureBytes), "Bestehendes Karten-Capture weicht vom reproduzierten Ergebnis ab.");
    return { path, status: "reused" };
  } catch (error) {
    if (!(error !== null && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(result.captureBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path, status: "written" };
}
