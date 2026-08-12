import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contained(root, path) {
  invariant(typeof path === "string" && path !== "" && !isAbsolute(path), `Ungültiger PMTiles-Pfad ${path}.`);
  const absolute = resolve(root, path);
  const remainder = relative(root, absolute);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `PMTiles-Pfad verlässt die Artefaktwurzel: ${path}.`);
  return absolute;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertPmtiles(path, id) {
  const handle = await open(path, "r");
  try {
    const magic = Buffer.alloc(7);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    invariant(bytesRead === 7 && magic.toString("ascii") === "PMTiles", `${id} ist kein PMTiles-Artefakt.`);
  } finally {
    await handle.close();
  }
}

export function validateMapReleaseSpec(spec) {
  invariant(spec?.schema === "zugfolge-map-release-spec/v1", "Unbekanntes Karten-Releaseschema.");
  invariant(spec.selfHosted === true, "Basemap und Infrastruktur müssen selbst gehostet werden.");
  invariant(Array.isArray(spec.runtimeExternalSources) && spec.runtimeExternalSources.length === 0, "Laufzeit darf keine externen Kartenquellen enthalten.");
  invariant(Array.isArray(spec.artifacts) && spec.artifacts.length === 2, "Kartenrelease braucht genau Basemap und Infrastruktur-PMTiles.");
  const kinds = new Set();
  for (const artifact of spec.artifacts) {
    invariant(["basemap", "infrastructure"].includes(artifact.kind), `Unbekannte Kartenart ${artifact.kind}.`);
    invariant(!kinds.has(artifact.kind), `Kartenart ${artifact.kind} ist doppelt.`);
    kinds.add(artifact.kind);
    invariant(typeof artifact.id === "string" && artifact.id !== "", "Kartenartefakt ohne ID.");
    invariant(typeof artifact.file === "string" && artifact.file.endsWith(".pmtiles"), `${artifact.id} ohne PMTiles-Datei.`);
    invariant(typeof artifact.serveAt === "string" && artifact.serveAt.startsWith("/maps/releases/") && artifact.serveAt.endsWith(".pmtiles"), `${artifact.id} ohne immutable Self-Hosting-Pfad.`);
    invariant(!artifact.serveAt.includes("latest"), `${artifact.id} verwendet einen veränderlichen latest-Pfad.`);
    invariant(Number.isInteger(artifact.minZoom) && Number.isInteger(artifact.maxZoom) && artifact.minZoom >= 0 && artifact.maxZoom >= artifact.minZoom, `${artifact.id} mit ungültigem Zoombereich.`);
    invariant(Array.isArray(artifact.layers) && artifact.layers.length > 0, `${artifact.id} ohne Layer.`);
    invariant(typeof artifact.attribution === "string" && artifact.attribution !== "", `${artifact.id} ohne Attribution.`);
    invariant(artifact.httpRangeRequired === true, `${artifact.id} muss HTTP-Range verlangen.`);
    if (artifact.kind === "basemap") invariant(artifact.coverage === "world", "Basemap muss die Welt abdecken.");
    if (artifact.kind === "infrastructure") {
      invariant(artifact.coverage === "germany-ebo", "Infrastruktur-PMTiles muss Deutschland EBO abdecken.");
      invariant(artifact.stableFeatureIds === true, "Anklickbare Infrastruktur braucht stabile Feature-IDs.");
    }
  }
  return spec;
}

export function validateMapSources(catalog, capture, rightsRegistry) {
  invariant(catalog?.schema === "zugfolge-map-source-catalog/v1" && Array.isArray(catalog.sources) && catalog.sources.length > 0, "Unbekannter Karten-Quellkatalog.");
  invariant(capture?.schema === "zugfolge-map-source-capture/v1" && Array.isArray(capture.sources), "Unbekanntes Karten-Capture.");
  invariant(Number.isSafeInteger(rightsRegistry?.version) && Array.isArray(rightsRegistry.quellen), "Unbekanntes Rechte-Register.");
  const rightsById = new Map(rightsRegistry.quellen.map((source) => [source.id, source]));
  const capturesById = new Map(capture.sources.map((source) => [source.id, source]));
  invariant(capturesById.size === capture.sources.length, "Karten-Capture enthält doppelte Quellen.");
  const publicSources = [];
  for (const source of catalog.sources) {
    const rights = rightsById.get(source.rightsSourceId);
    invariant(rights?.status === "freigegeben" && rights.entscheidung?.datum && rights.entscheidung?.pruefer, `Kartenquelle ${source.rightsSourceId} ist nicht freigegeben.`);
    const captured = capturesById.get(source.id);
    invariant(captured !== undefined, `Kartenquelle ${source.id} fehlt im Capture.`);
    invariant(typeof captured.version === "string" && captured.version !== "", `Kartenquelle ${source.id} ohne Version.`);
    invariant(Number.isSafeInteger(captured.bytes) && captured.bytes > 0 && SHA256.test(captured.sha256), `Kartenquelle ${source.id} ohne Bytezahl oder SHA-256.`);
    invariant(typeof source.attribution === "string" && source.attribution !== "", `Kartenquelle ${source.id} ohne Attribution.`);
    publicSources.push({
      id: source.id,
      rightsSourceId: source.rightsSourceId,
      sourceLicense: source.sourceLicense,
      version: captured.version,
      bytes: captured.bytes,
      sha256: captured.sha256,
      attribution: source.attribution,
      modifications: source.modifications,
    });
  }
  invariant(publicSources.length === capture.sources.length, "Karten-Capture enthält eine nicht katalogisierte Quelle.");
  return publicSources.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

export async function materializeMapRelease(spec, artifactRoot, sourceProof) {
  validateMapReleaseSpec(spec);
  const sources = validateMapSources(sourceProof?.catalog, sourceProof?.capture, sourceProof?.rightsRegistry);
  const root = resolve(artifactRoot);
  const artifacts = [];
  for (const descriptor of [...spec.artifacts].sort((left, right) => left.kind.localeCompare(right.kind, "en"))) {
    const { file, ...publicDescriptor } = descriptor;
    const path = contained(root, file);
    const metadata = await stat(path);
    invariant(metadata.isFile() && metadata.size > 7, `${descriptor.id} fehlt oder ist leer.`);
    await assertPmtiles(path, descriptor.id);
    artifacts.push({ ...publicDescriptor, bytes: metadata.size, sha256: await sha256File(path) });
  }
  const release = {
    schema: "zugfolge-map-release/v1",
    releaseId: spec.releaseId,
    selfHosted: true,
    cachePolicy: "public,max-age=31536000,immutable",
    rangeRequestsRequired: true,
    runtimeExternalSources: [],
    sources,
    artifacts,
  };
  return { release, releaseHash: createHash("sha256").update(canonical(release)).digest("hex") };
}

export function verifyRangeResponse({ status, contentRange, acceptRanges, bodyBytes, requestedStart, requestedEnd, totalBytes }) {
  invariant(status === 206, `Range-Antwort muss 206 sein, erhalten: ${status}.`);
  invariant(String(acceptRanges).toLowerCase() === "bytes", "Server kündigt keine Byte-Ranges an.");
  invariant(contentRange === `bytes ${requestedStart}-${requestedEnd}/${totalBytes}`, `Unerwarteter Content-Range: ${contentRange}.`);
  invariant(bodyBytes === requestedEnd - requestedStart + 1, `Range-Antwort enthält ${bodyBytes} statt ${requestedEnd - requestedStart + 1} Bytes.`);
  return true;
}

export function validateMaterializedMapRelease(value) {
  invariant(value?.release?.schema === "zugfolge-map-release/v1", "Unbekanntes materialisiertes Kartenrelease.");
  invariant(SHA256.test(value.releaseHash), "Kartenrelease ohne SHA-256.");
  for (const artifact of value.release.artifacts ?? []) {
    invariant(SHA256.test(artifact.sha256), `${artifact.id} ohne SHA-256.`);
    invariant(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 7, `${artifact.id} ohne Bytezahl.`);
  }
  return value;
}
