import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

export const COPERNICUS_DEM_PRODUCT = "COP-DEM-GLO-30-DGED";
export const COPERNICUS_DEM_RELEASE = "2021";
export const COPERNICUS_DEM_BUCKET = "copernicus-dem-30m";
export const COPERNICUS_DEM_BASE_URL = `https://${COPERNICUS_DEM_BUCKET}.s3.amazonaws.com`;
export const COPERNICUS_DEM_ATTRIBUTION = "produced using Copernicus WorldDEM-30 \u00a9 DLR e.V. 2010-2014 and \u00a9 Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved";

const SHA256 = /^[a-f0-9]{64}$/u;
const TILE_ID = /^[NS]\d{2}_[EW]\d{3}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function coordinate(value, name, minimum, maximum) {
  invariant(typeof value === "number" && Number.isFinite(value), `${name} ist keine endliche Zahl.`);
  invariant(value >= minimum && value <= maximum, `${name} liegt au\u00dferhalb von WGS84: ${value}.`);
  return value;
}

function component(prefixPositive, prefixNegative, degrees, width) {
  const prefix = degrees >= 0 ? prefixPositive : prefixNegative;
  return `${prefix}${String(Math.abs(degrees)).padStart(width, "0")}`;
}

export function tileIdForCoordinate(longitude, latitude) {
  const lon = coordinate(longitude, "L\u00e4ngengrad", -180, 180);
  const lat = coordinate(latitude, "Breitengrad", -90, 90);
  invariant(lon < 180 && lat > -90 && lat < 90, "Koordinaten auf der WGS84-Au\u00dfengrenze besitzen keine DEM-Kachel.");
  // GLO-30 is a point raster. Integer latitude grid posts belong to the
  // southern geocell, while integer longitude grid posts belong to the
  // eastern geocell.
  const south = Number.isInteger(lat) ? Math.floor(lat) - 1 : Math.floor(lat);
  const west = Math.floor(lon);
  return `${component("N", "S", south, 2)}_${component("E", "W", west, 3)}`;
}

export function tileObject(tileId) {
  invariant(TILE_ID.test(tileId), `Ung\u00fcltige Copernicus-Kachelkennung: ${tileId}.`);
  const [latitude, longitude] = tileId.split("_");
  const directory = `Copernicus_DSM_COG_10_${latitude}_00_${longitude}_00_DEM`;
  return {
    directory,
    file: `${directory}.tif`,
    objectKey: `${directory}/${directory}.tif`,
    url: `${COPERNICUS_DEM_BASE_URL}/${directory}/${directory}.tif`,
  };
}

function crossedTileIds(left, right) {
  const [leftLongitude, leftLatitude] = left;
  const [rightLongitude, rightLatitude] = right;
  const parameters = [0, 1];
  for (const [start, end] of [[leftLongitude, rightLongitude], [leftLatitude, rightLatitude]]) {
    if (start === end) continue;
    const minimum = Math.min(start, end);
    const maximum = Math.max(start, end);
    for (let boundary = Math.floor(minimum) + 1; boundary < maximum; boundary += 1) {
      parameters.push((boundary - start) / (end - start));
    }
  }
  parameters.sort((a, b) => a - b);
  const unique = parameters.filter((value, index) => index === 0 || Math.abs(value - parameters[index - 1]) > Number.EPSILON);
  const result = new Set([
    tileIdForCoordinate(leftLongitude, leftLatitude),
    tileIdForCoordinate(rightLongitude, rightLatitude),
  ]);
  for (let index = 1; index < unique.length; index += 1) {
    const parameter = (unique[index - 1] + unique[index]) / 2;
    result.add(tileIdForCoordinate(
      leftLongitude + (rightLongitude - leftLongitude) * parameter,
      leftLatitude + (rightLatitude - leftLatitude) * parameter,
    ));
  }
  return result;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function updateBounds(bounds, longitude, latitude) {
  bounds.west = Math.min(bounds.west, longitude);
  bounds.south = Math.min(bounds.south, latitude);
  bounds.east = Math.max(bounds.east, longitude);
  bounds.north = Math.max(bounds.north, latitude);
}

export async function inspectTrackTiles(tracksPath) {
  const absoluteTracks = resolve(tracksPath);
  const tiles = new Set();
  const bounds = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
  let featureCount = 0;
  let coordinateCount = 0;
  const input = createInterface({ input: createReadStream(absoluteTracks, "utf8"), crlfDelay: Infinity });
  for await (const line of input) {
    if (line.trim() === "") continue;
    const feature = JSON.parse(line);
    invariant(feature?.type === "Feature" && feature.geometry?.type === "LineString", `Gleiszeile ${featureCount + 1} ist kein LineString-Feature.`);
    invariant(typeof feature.properties?.feature_id === "string" && feature.properties.feature_id !== "", `Gleiszeile ${featureCount + 1} besitzt keine feature_id.`);
    invariant(Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.length >= 2, `Gleis ${feature.properties.feature_id} besitzt zu wenige Koordinaten.`);
    featureCount += 1;
    const coordinates = feature.geometry.coordinates;
    for (const pair of coordinates) {
      invariant(Array.isArray(pair) && pair.length >= 2, `Gleis ${feature.properties.feature_id} enth\u00e4lt eine ung\u00fcltige Koordinate.`);
      const longitude = coordinate(pair[0], "L\u00e4ngengrad", -180, 180);
      const latitude = coordinate(pair[1], "Breitengrad", -90, 90);
      tiles.add(tileIdForCoordinate(longitude, latitude));
      updateBounds(bounds, longitude, latitude);
      coordinateCount += 1;
    }
    for (let index = 1; index < coordinates.length; index += 1) {
      for (const tileId of crossedTileIds(coordinates[index - 1], coordinates[index])) tiles.add(tileId);
    }
  }
  invariant(featureCount > 0, "Die semantische Gleisdatei ist leer.");
  const source = await stat(absoluteTracks);
  return {
    tracksPath: absoluteTracks,
    tracksBytes: source.size,
    tracksSha256: await sha256File(absoluteTracks),
    featureCount,
    coordinateCount,
    bounds,
    tileIds: [...tiles].sort(compareText),
  };
}

function tiffMagic(header) {
  return header.length >= 4 && (
    (header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2a && header[3] === 0x00)
    || (header[0] === 0x4d && header[1] === 0x4d && header[2] === 0x00 && header[3] === 0x2a)
    || (header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2b && header[3] === 0x00)
    || (header[0] === 0x4d && header[1] === 0x4d && header[2] === 0x00 && header[3] === 0x2b)
  );
}

async function validateTileFile(path, expected = null) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    invariant(bytesRead === 4 && tiffMagic(header), `${basename(path)} ist keine TIFF-/BigTIFF-Datei.`);
  } finally {
    await handle.close();
  }
  const details = await stat(path);
  invariant(details.isFile() && details.size >= 1024, `${basename(path)} ist leer oder unvollst\u00e4ndig.`);
  const sha256 = await sha256File(path);
  if (expected !== null) {
    invariant(details.size === expected.bytes, `${basename(path)} hat ${details.size} statt ${expected.bytes} Bytes.`);
    invariant(sha256 === expected.sha256, `${basename(path)} verletzt den gepinnten SHA-256.`);
  }
  return { bytes: details.size, sha256 };
}

async function downloadTile(tileId, cacheRoot, fetchImpl) {
  const object = tileObject(tileId);
  const finalPath = resolve(cacheRoot, object.file);
  const partialPath = `${finalPath}.partial`;
  await mkdir(dirname(finalPath), { recursive: true });
  try {
    const cached = await validateTileFile(finalPath);
    return {
      tileId,
      objectKey: object.objectKey,
      file: object.file,
      ...cached,
      etag: null,
      lastModified: null,
      resumedFromValidatedCache: true,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await unlink(partialPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(object.url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
      invariant(response.status === 200, `HTTP ${response.status} f\u00fcr ${tileId}.`);
      invariant(response.headers.get("content-type")?.toLowerCase().includes("tiff"), `${tileId} besitzt keinen TIFF-Inhaltstyp.`);
      const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      invariant(Number.isSafeInteger(contentLength) && contentLength >= 1024, `${tileId} besitzt keine plausible Content-Length.`);
      invariant(response.body !== null, `${tileId} besitzt keinen Antwortk\u00f6rper.`);
      const file = await open(partialPath, "wx");
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          await file.write(buffer);
          hash.update(buffer);
          bytes += buffer.length;
        }
        await file.sync();
      } finally {
        await file.close();
      }
      invariant(bytes === contentLength, `${tileId} wurde nur mit ${bytes} von ${contentLength} Bytes geladen.`);
      const sha256 = hash.digest("hex");
      await validateTileFile(partialPath, { bytes, sha256 });
      await rename(partialPath, finalPath);
      return {
        tileId,
        objectKey: object.objectKey,
        file: object.file,
        bytes,
        sha256,
        etag: response.headers.get("etag")?.replaceAll('"', "") ?? null,
        lastModified: response.headers.get("last-modified") ?? null,
      };
    } catch (error) {
      lastError = error;
      try {
        await unlink(partialPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
      if (attempt < 3) await new Promise((accept) => setTimeout(accept, attempt * 1_000));
    }
  }
  throw new Error(`Copernicus-Kachel ${tileId} konnte nicht gepinnt werden: ${lastError?.message ?? lastError}`);
}

async function mapConcurrent(values, concurrency, operation) {
  invariant(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 4, "DEM-Download-Parallelit\u00e4t muss zwischen 1 und 4 liegen.");
  const result = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

function aggregateTileHash(tiles) {
  return createHash("sha256").update(tiles.map(({ tileId, sha256 }) => `${tileId}:${sha256}\n`).join("")).digest("hex");
}

export async function verifyDemCapture({ tracksPath, cacheRoot, manifestPath }) {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  invariant(manifest?.schema === "zugfolge-copernicus-dem-capture/v1", "Unbekanntes Copernicus-Capture-Manifest.");
  invariant(manifest.source?.rightsSourceId === "dem-hoehenmodell", "DEM-Capture besitzt keine freigegebene Rechtekennung.");
  invariant(manifest.source?.product === COPERNICUS_DEM_PRODUCT && manifest.source?.release === COPERNICUS_DEM_RELEASE, "DEM-Capture ist nicht auf COP-DEM GLO-30 Release 2021 gepinnt.");
  invariant(manifest.source?.bucket === COPERNICUS_DEM_BUCKET, "DEM-Capture stammt nicht aus dem gepinnten \u00f6ffentlichen Bucket.");
  invariant(manifest.source?.attribution === COPERNICUS_DEM_ATTRIBUTION, "DEM-Capture besitzt nicht den verbindlichen Attributionstext.");
  invariant(Array.isArray(manifest.tiles) && manifest.tiles.length > 0, "DEM-Capture enth\u00e4lt keine Kacheln.");
  const inspected = await inspectTrackTiles(tracksPath);
  invariant(inspected.tracksSha256 === manifest.input.tracksSha256, "DEM-Capture geh\u00f6rt zu einer anderen Gleisdatei.");
  invariant(JSON.stringify(inspected.tileIds) === JSON.stringify(manifest.input.requiredTileIds), "DEM-Capture deckt die tats\u00e4chlich ben\u00f6tigten Kacheln nicht exakt ab.");
  const capturedTileIds = manifest.tiles.map(({ tileId }) => tileId);
  invariant(JSON.stringify(capturedTileIds) === JSON.stringify(inspected.tileIds), "DEM-Capture bindet nicht exakt jede ben\u00f6tigte Kachel einmal und in stabiler Reihenfolge.");
  const tiles = [];
  for (const entry of manifest.tiles) {
    invariant(TILE_ID.test(entry.tileId) && SHA256.test(entry.sha256), "DEM-Capture enth\u00e4lt eine ung\u00fcltige Kachelbindung.");
    invariant(entry.file === tileObject(entry.tileId).file, `DEM-Capture manipuliert den Dateinamen von ${entry.tileId}.`);
    invariant(entry.objectKey === tileObject(entry.tileId).objectKey, `DEM-Capture manipuliert den Objektpfad von ${entry.tileId}.`);
    const verified = await validateTileFile(resolve(cacheRoot, entry.file), entry);
    tiles.push({ ...entry, ...verified });
  }
  invariant(aggregateTileHash(tiles) === manifest.aggregateTileSha256, "Aggregierter DEM-Kachelsatzhash stimmt nicht.");
  return { manifest, inspected, tiles };
}

export async function captureDemTiles({ tracksPath, cacheRoot, manifestPath, concurrency = 2, fetchImpl = fetch }) {
  const absoluteManifest = resolve(manifestPath);
  try {
    await stat(absoluteManifest);
    return verifyDemCapture({ tracksPath, cacheRoot, manifestPath: absoluteManifest });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const inspected = await inspectTrackTiles(tracksPath);
  const tiles = await mapConcurrent(inspected.tileIds, concurrency, (tileId) => downloadTile(tileId, resolve(cacheRoot), fetchImpl));
  tiles.sort((left, right) => compareText(left.tileId, right.tileId));
  const manifest = {
    schema: "zugfolge-copernicus-dem-capture/v1",
    source: {
      sourceId: "copernicus-dem-germany",
      rightsSourceId: "dem-hoehenmodell",
      product: COPERNICUS_DEM_PRODUCT,
      release: COPERNICUS_DEM_RELEASE,
      resolutionArcSeconds: 1,
      rasterKind: "digital-surface-model",
      bucket: COPERNICUS_DEM_BUCKET,
      attribution: COPERNICUS_DEM_ATTRIBUTION,
    },
    input: {
      tracksSha256: inspected.tracksSha256,
      tracksBytes: inspected.tracksBytes,
      featureCount: inspected.featureCount,
      coordinateCount: inspected.coordinateCount,
      bounds: inspected.bounds,
      requiredTileIds: inspected.tileIds,
    },
    aggregateTileSha256: aggregateTileHash(tiles),
    tiles,
  };
  await mkdir(dirname(absoluteManifest), { recursive: true });
  await writeFile(absoluteManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { manifest, inspected, tiles };
}
