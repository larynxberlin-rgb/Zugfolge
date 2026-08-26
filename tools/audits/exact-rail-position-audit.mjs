import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const TRAIN_STOP_RAILWAY_VALUES = new Set(["stop"]);
const OPERATIONAL_RAILWAY_VALUES = new Set([
  "buffer_stop",
  "crossing",
  "level_crossing",
  "milestone",
  "railway_crossing",
  "signal",
  "switch",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function increment(record, key, amount = 1) {
  record[key] = (record[key] ?? 0) + amount;
}

function orderedRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right, "en")));
}

function coordinateKey(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [longitude, latitude] = coordinates;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return `${JSON.stringify(longitude)},${JSON.stringify(latitude)}`;
}

function splitExactReferences(value) {
  if (typeof value !== "string") return [];
  return value.split(/[;,]/u).map((entry) => entry.trim()).filter((entry) => entry !== "");
}

function pointReferences(properties) {
  return new Set([
    ...splitExactReferences(properties["railway:track_ref"]),
    ...splitExactReferences(properties.local_ref),
    ...splitExactReferences(properties.ref),
    ...splitExactReferences(properties.platform),
    ...splitExactReferences(properties.platform_code),
    ...splitExactReferences(properties.plate_code),
  ]);
}

function trackReferences(properties) {
  return new Set(splitExactReferences(properties["railway:track_ref"]));
}

function parseSequenceLine(line, lineNumber) {
  const payload = line.startsWith("\u001e") ? line.slice(1) : line;
  invariant(payload.trim() !== "", `Leerer GeoJSON-Sequence-Datensatz in Zeile ${lineNumber}.`);
  let feature;
  try {
    feature = JSON.parse(payload);
  } catch (error) {
    throw new Error(`Ungültiges GeoJSON in Zeile ${lineNumber}: ${error.message}`);
  }
  invariant(feature?.type === "Feature" && feature.geometry && typeof feature.properties === "object", `Zeile ${lineNumber} ist kein vollständiges GeoJSON-Feature.`);
  return feature;
}

async function forEachSequenceFeature(path, callback, withHash = false) {
  const stream = createReadStream(path);
  const hash = withHash ? createHash("sha256") : null;
  if (hash !== null) stream.on("data", (chunk) => hash.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line === "") continue;
    await callback(parseSequenceLine(line, lineNumber), lineNumber);
  }
  return { records: lineNumber, sha256: hash?.digest("hex") };
}

async function fileIdentity(path) {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${path} muss eine nichtleere reguläre Datei sein.`);
  return { bytes: metadata.size };
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function quotedIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function inspectGeoPackage(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const geometryLayers = database.prepare(`
      SELECT table_name, column_name, geometry_type_name, srs_id, z, m
      FROM gpkg_geometry_columns ORDER BY table_name
    `).all();
    const layers = [];
    const exactPointTargets = [];
    for (const geometry of geometryLayers) {
      const table = quotedIdentifier(geometry.table_name);
      const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
      const rows = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
      const hasWgs84 = columns.includes("Geographische Länge (EPSG 4326)") && columns.includes("Geographische Breite (EPSG 4326)");
      let rowsWithWgs84 = 0;
      if (geometry.geometry_type_name === "POINT" && hasWgs84) {
        const longitude = quotedIdentifier("Geographische Länge (EPSG 4326)");
        const latitude = quotedIdentifier("Geographische Breite (EPSG 4326)");
        const records = database.prepare(`SELECT id, ${longitude} AS longitude, ${latitude} AS latitude FROM ${table} ORDER BY id`).iterate();
        for (const record of records) {
          const key = coordinateKey([record.longitude, record.latitude]);
          if (key === null) continue;
          rowsWithWgs84 += 1;
          exactPointTargets.push({
            category: `gpkg:${geometry.table_name}`,
            key,
            references: new Set(),
            sourceId: String(record.id),
            matches: [],
          });
        }
      }
      layers.push({
        name: geometry.table_name,
        geometryType: geometry.geometry_type_name,
        srsId: geometry.srs_id,
        rows,
        rowsWithExplicitWgs84: rowsWithWgs84,
        columns,
      });
    }
    return { layers, exactPointTargets };
  } finally {
    database.close();
  }
}

function addPointTarget(targets, targetByCoordinate, target) {
  const index = targets.length;
  targets.push(target);
  const indexes = targetByCoordinate.get(target.key) ?? [];
  indexes.push(index);
  targetByCoordinate.set(target.key, indexes);
}

function pointCategory(feature) {
  if (feature.geometry.type !== "Point") return null;
  const properties = feature.properties;
  if (properties.public_transport === "stop_position") {
    if (properties.train === "yes" || TRAIN_STOP_RAILWAY_VALUES.has(properties.railway)) return "osm:declared-train-stop-position";
    return "osm:other-stop-position";
  }
  if (properties.public_transport === "platform" || properties.railway === "platform") {
    return properties.train === "yes" || properties.railway === "platform"
      ? "osm:declared-train-platform-point"
      : "osm:other-platform-point";
  }
  if (OPERATIONAL_RAILWAY_VALUES.has(properties.railway)) return `osm:railway:${properties.railway}`;
  return null;
}

function visitTrackVertices(geometry, callback) {
  if (geometry.type === "LineString") {
    for (const coordinate of geometry.coordinates) callback(coordinate);
    return true;
  }
  if (geometry.type === "MultiLineString") {
    for (const line of geometry.coordinates) for (const coordinate of line) callback(coordinate);
    return true;
  }
  return false;
}

function summarizeTargets(targets) {
  const categories = new Map();
  for (const target of targets) {
    const summary = categories.get(target.category) ?? {
      total: 0,
      unmatched: 0,
      exactSingleTrackFeature: 0,
      ambiguousMultipleTrackFeatures: 0,
      matchesOnlyTracksWithStableTrackRef: 0,
      resolvedByOneStableTrackRef: 0,
      exactCoordinateAndReferenceAgreement: 0,
      strictlyBindableByCoordinateOrTrackRef: 0,
    };
    summary.total += 1;
    if (target.matches.length === 0) {
      summary.unmatched += 1;
    } else if (target.matches.length === 1) {
      summary.exactSingleTrackFeature += 1;
    } else {
      summary.ambiguousMultipleTrackFeatures += 1;
    }
    const referenceSets = target.matches.map(({ trackReferences: references }) => references);
    const allHaveTrackReference = referenceSets.length > 0 && referenceSets.every((references) => references.size > 0);
    if (allHaveTrackReference) summary.matchesOnlyTracksWithStableTrackRef += 1;
    const candidateReferences = new Set(referenceSets.flatMap((references) => [...references]));
    const oneStableTrackReference = allHaveTrackReference && candidateReferences.size === 1;
    if (oneStableTrackReference) summary.resolvedByOneStableTrackRef += 1;
    const agreement = [...target.references].some((reference) => candidateReferences.has(reference));
    if (agreement) summary.exactCoordinateAndReferenceAgreement += 1;
    if (target.matches.length === 1 || oneStableTrackReference) summary.strictlyBindableByCoordinateOrTrackRef += 1;
    categories.set(target.category, summary);
  }
  return Object.fromEntries([...categories].sort(([left], [right]) => left.localeCompare(right, "en")));
}

export async function auditExactRailPositions({ geoPackagePath, geoJsonSequencePath, openStationPlatformSequencePath }) {
  invariant(typeof geoPackagePath === "string" && geoPackagePath !== "", "GeoPackage-Pfad fehlt.");
  invariant(typeof geoJsonSequencePath === "string" && geoJsonSequencePath !== "", "GeoJSONSeq-Pfad fehlt.");
  const [geoPackageIdentity, geoJsonIdentity] = await Promise.all([fileIdentity(geoPackagePath), fileIdentity(geoJsonSequencePath)]);
  const geoPackage = inspectGeoPackage(geoPackagePath);
  const targets = [];
  const targetByCoordinate = new Map();
  for (const target of geoPackage.exactPointTargets) addPointTarget(targets, targetByCoordinate, target);

  const counts = {
    totalFeatures: 0,
    featuresWithExplicitOsmId: 0,
    featuresWithRelationMembership: 0,
    railwayRailFeatures: 0,
    railwayRailFeaturesWithTrackRef: 0,
    railwayRailFeaturesWithGenericRef: 0,
    unsupportedRailGeometryFeatures: 0,
    publicTransportStopPositions: 0,
    stopPositionPointFeatures: 0,
    stopPositionNonPointFeatures: 0,
    declaredTrainStopPositions: 0,
    declaredTrainStopPositionsWithReference: 0,
    otherStopPositions: 0,
    platformFeatures: 0,
    platformPointFeatures: 0,
    platformLinearOrAreaFeatures: 0,
    declaredTrainPlatformFeatures: 0,
    declaredTrainPlatformFeaturesWithReference: 0,
    declaredTrainPlatformPointFeatures: 0,
    declaredTrainPlatformLinearOrAreaFeatures: 0,
    otherPlatformFeatures: 0,
  };
  const geometryTypes = {};
  const railwayValues = {};
  const firstPass = await forEachSequenceFeature(geoJsonSequencePath, (feature) => {
    counts.totalFeatures += 1;
    increment(geometryTypes, feature.geometry.type);
    if (feature.id !== undefined || feature.properties["@id"] !== undefined || feature.properties.osm_id !== undefined) counts.featuresWithExplicitOsmId += 1;
    if (feature.properties["@relations"] !== undefined || feature.properties.relations !== undefined) counts.featuresWithRelationMembership += 1;
    if (typeof feature.properties.railway === "string") increment(railwayValues, feature.properties.railway);
    if (feature.properties.railway === "rail") {
      counts.railwayRailFeatures += 1;
      if (trackReferences(feature.properties).size > 0) counts.railwayRailFeaturesWithTrackRef += 1;
      if (splitExactReferences(feature.properties.ref).length > 0) counts.railwayRailFeaturesWithGenericRef += 1;
      if (!["LineString", "MultiLineString"].includes(feature.geometry.type)) counts.unsupportedRailGeometryFeatures += 1;
    }
    if (feature.properties.public_transport === "stop_position") {
      counts.publicTransportStopPositions += 1;
      if (feature.geometry.type === "Point") counts.stopPositionPointFeatures += 1;
      else counts.stopPositionNonPointFeatures += 1;
      if (feature.properties.train === "yes" || TRAIN_STOP_RAILWAY_VALUES.has(feature.properties.railway)) {
        counts.declaredTrainStopPositions += 1;
        if (pointReferences(feature.properties).size > 0) counts.declaredTrainStopPositionsWithReference += 1;
      }
      else counts.otherStopPositions += 1;
    }
    if (feature.properties.public_transport === "platform" || feature.properties.railway === "platform") {
      counts.platformFeatures += 1;
      if (feature.geometry.type === "Point") counts.platformPointFeatures += 1;
      else counts.platformLinearOrAreaFeatures += 1;
      if (feature.properties.train === "yes" || feature.properties.railway === "platform") {
        counts.declaredTrainPlatformFeatures += 1;
        if (pointReferences(feature.properties).size > 0) counts.declaredTrainPlatformFeaturesWithReference += 1;
        if (feature.geometry.type === "Point") counts.declaredTrainPlatformPointFeatures += 1;
        else counts.declaredTrainPlatformLinearOrAreaFeatures += 1;
      } else {
        counts.otherPlatformFeatures += 1;
      }
    }
    const category = pointCategory(feature);
    const key = coordinateKey(feature.geometry.coordinates);
    if (category !== null && key !== null) {
      addPointTarget(targets, targetByCoordinate, {
        category,
        key,
        references: pointReferences(feature.properties),
        sourceId: feature.id ?? feature.properties["@id"] ?? feature.properties.osm_id ?? null,
        matches: [],
      });
    }
  }, true);

  let openStationInput;
  if (openStationPlatformSequencePath !== undefined) {
    invariant(typeof openStationPlatformSequencePath === "string" && openStationPlatformSequencePath !== "", "OpenStation-Bahnsteigpunktpfad ist leer.");
    const identity = await fileIdentity(openStationPlatformSequencePath);
    const scan = await forEachSequenceFeature(openStationPlatformSequencePath, (feature) => {
      invariant(feature.geometry.type === "Point" && feature.properties.feature_type === "platform", "OpenStation-Zusatzlayer enthält kein reines Bahnsteigpunkt-Feature.");
      const key = coordinateKey(feature.geometry.coordinates);
      invariant(key !== null, "OpenStation-Bahnsteigpunkt besitzt keine endliche WGS84-Koordinate.");
      addPointTarget(targets, targetByCoordinate, {
        category: "openstation:platform-point",
        key,
        references: pointReferences(feature.properties),
        sourceId: feature.properties.feature_id ?? null,
        matches: [],
      });
    }, true);
    openStationInput = { bytes: identity.bytes, sha256: scan.sha256 };
  }

  let trackOrdinal = 0;
  await forEachSequenceFeature(geoJsonSequencePath, (feature) => {
    if (feature.properties.railway !== "rail") return;
    trackOrdinal += 1;
    const matchedTargets = new Set();
    const supported = visitTrackVertices(feature.geometry, (coordinate) => {
      const key = coordinateKey(coordinate);
      if (key === null) return;
      for (const index of targetByCoordinate.get(key) ?? []) matchedTargets.add(index);
    });
    if (!supported || matchedTargets.size === 0) return;
    const references = trackReferences(feature.properties);
    const explicitId = feature.id ?? feature.properties["@id"] ?? feature.properties.osm_id ?? null;
    for (const index of matchedTargets) targets[index].matches.push({
      auditTrackOrdinal: trackOrdinal,
      explicitId,
      trackReferences: references,
    });
  });

  return {
    schema: "zugfolge-exact-rail-position-audit/v1",
    policy: {
      coordinateMatch: "JSON-parsed WGS84 longitude and latitude must be exactly equal to a railway=rail LineString vertex",
      acceptedTrackReference: "railway:track_ref only",
      forbidden: ["nearest-neighbor", "point-to-line projection", "distance tolerance", "name-only or unscoped platform-code join"],
    },
    inputs: {
      geoPackage: { bytes: geoPackageIdentity.bytes, sha256: await hashFile(geoPackagePath) },
      geoJsonSequence: { bytes: geoJsonIdentity.bytes, sha256: firstPass.sha256 },
      ...(openStationInput === undefined ? {} : { openStationPlatformSequence: openStationInput }),
    },
    geoPackage: { layers: geoPackage.layers },
    geoJsonSequence: {
      counts,
      geometryTypes: orderedRecord(geometryTypes),
      railwayValues: orderedRecord(railwayValues),
    },
    exactBindings: summarizeTargets(targets),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  const [geoPackagePath, geoJsonSequencePath, openStationPlatformSequencePath, ...extra] = process.argv.slice(2);
  if (!geoPackagePath || !geoJsonSequencePath || extra.length > 0) {
    throw new Error("Aufruf: exact-rail-position-audit.mjs INPUT.gpkg germany-ebo.geojsonseq [openstation-platform-points.geojsonseq]");
  }
  process.stdout.write(`${JSON.stringify(await auditExactRailPositions({ geoPackagePath, geoJsonSequencePath, openStationPlatformSequencePath }), null, 2)}\n`);
}
