import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const SHA256 = /^[a-f0-9]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function finalizeGermanySourceCapture({ baseCapture, demCapture, internalEvidenceLedgerPath }) {
  invariant(baseCapture?.schema === "zugfolge-source-capture/v1", "Deutschland-Basiscapture hat ein unbekanntes Schema.");
  invariant(Array.isArray(baseCapture.sources), "Deutschland-Basiscapture besitzt keine Quellenliste.");
  invariant(demCapture?.schema === "zugfolge-copernicus-dem-capture/v1", "DEM-Capture hat ein unbekanntes Schema.");
  invariant(demCapture.source?.sourceId === "copernicus-dem-germany" && demCapture.source?.release === "2021", "DEM-Capture ist nicht an den freigegebenen GLO-30-Jahresstand gebunden.");
  invariant(Array.isArray(demCapture.tiles) && demCapture.tiles.length > 0, "DEM-Capture besitzt keine Kacheln.");
  const tileBytes = demCapture.tiles.reduce((sum, tile) => {
    invariant(Number.isSafeInteger(tile?.bytes) && tile.bytes > 0 && SHA256.test(tile?.sha256), "DEM-Kachel ohne Byte-/SHA-256-Beleg.");
    return sum + tile.bytes;
  }, 0);
  invariant(Number.isSafeInteger(tileBytes) && tileBytes > 0 && SHA256.test(demCapture.aggregateTileSha256), "DEM-Capture besitzt keinen aggregierten Kachelsatzbeleg.");

  const internalEvidence = await sha256File(internalEvidenceLedgerPath);
  invariant(internalEvidence.bytes > 0, "Internes Evidenzledger ist leer.");
  const sources = baseCapture.sources.filter(({ id }) => id !== "copernicus-dem-germany");
  sources.push({
    id: "copernicus-dem-germany",
    version: `${demCapture.source.product}-${demCapture.source.release}`,
    file: "annual-2026/copernicus-dem-glo30-2021",
    bytes: tileBytes,
    sha256: demCapture.aggregateTileSha256,
  });
  sources.sort((left, right) => left.id.localeCompare(right.id, "en"));
  invariant(new Set(sources.map(({ id }) => id)).size === sources.length, "Finales Capture besitzt doppelte Quellen.");
  return {
    schema: "zugfolge-source-capture/v1",
    capturedAt: baseCapture.capturedAt,
    internalEvidenceLedgerSha256: internalEvidence.sha256,
    sources,
  };
}
