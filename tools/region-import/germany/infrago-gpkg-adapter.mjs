import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TRACK_TABLE = "M1 Streckennetz";
const OPERATING_PLACE_TABLE = "M1 Betriebsstellen";

const TABLE_SCHEMAS = {
  [TRACK_TABLE]: [
    ["id", "INTEGER", 1],
    ["geom", "MULTICURVE", 0],
    ["Streckennummer", "MEDIUMINT", 0],
    ["Richtung", "TEXT(200)", 0],
    ["km_von_l", "TEXT(20)", 0],
    ["km_bis_l", "TEXT(20)", 0],
    ["km_von_i", "INTEGER", 0],
    ["km_bis_i", "INTEGER", 0],
    ["km_von_km", "REAL", 0],
    ["km_von_m", "REAL", 0],
    ["km_bis_km", "REAL", 0],
    ["km_bis_m", "REAL", 0],
    ["Länge", "REAL", 0],
    ["Streckenkurzname", "TEXT(255)", 0],
    ["Bauzustand", "TEXT(255)", 0],
    ["DB Betrieb", "TEXT(255)", 0],
    ["Elektrifizierung", "TEXT(255)", 0],
    ["Gleisanzahl", "TEXT(255)", 0],
    ["Geschwindigkeit", "TEXT(255)", 0],
    ["Bundesland", "TEXT(200)", 0],
    ["Kreis", "TEXT(200)", 0],
  ],
  [OPERATING_PLACE_TABLE]: [
    ["id", "INTEGER", 1],
    ["geom", "POINT", 0],
    ["Streckennummer", "TEXT(16)", 0],
    ["Richtung", "TEXT(200)", 0],
    ["km_von_l", "TEXT(12)", 0],
    ["km_bis_l", "TEXT(12)", 0],
    ["km_von_i", "REAL", 0],
    ["km_bis_i", "REAL", 0],
    ["km_von_km", "REAL", 0],
    ["km_von_m", "REAL", 0],
    ["km_bis_km", "REAL", 0],
    ["km_bis_m", "REAL", 0],
    ["km_lage_l", "TEXT(12)", 0],
    ["km_lage_i", "REAL", 0],
    ["km_lage_km", "REAL", 0],
    ["km_lage_m", "REAL", 0],
    ["Streckenkurzname", "TEXT(120)", 0],
    ["Art", "TEXT(50)", 0],
    ["Art lang", "TEXT", 0],
    ["Bezeichnung", "TEXT(255)", 0],
    ["Kürzel", "TEXT(10)", 0],
    ["Betriebszustand", "TEXT(50)", 0],
    ["Bundesland", "TEXT(200)", 0],
    ["Kreis", "TEXT(200)", 0],
    ["GK Rechtswert (EPSG 31467)", "REAL", 0],
    ["GK Hochwert (EPSG 31467)", "REAL", 0],
    ["Geographische Länge (EPSG 4326)", "REAL", 0],
    ["Geographische Breite (EPSG 4326)", "REAL", 0],
    ["UTM Rechtswert (EPSG 25832)", "REAL", 0],
    ["UTM Hochwert (EPSG 25832)", "REAL", 0],
  ],
};

const TRACK_DIRECTIONS = new Map([
  ["Gegenrichtungsgleis", "reverse-track"],
  ["Richtungsgleis", "forward-track"],
  ["Streckenachse", "route-axis"],
]);
const OPERATING_PLACE_TYPES = new Set([
  "Abzw", "Anst", "Anst Bk", "Awanst", "Awanst Bk", "Bf", "Bf Abzw", "Bft", "Bft Abzw",
  "Hp", "Hp Abzw", "Hp Anst", "Hp Anst Bk", "Hp Awanst", "Hp Awanst Bk", "Hp Bft", "Hp Bk",
  "Hp Dkst", "Hp Üst", "Museum", "Strw", "Üst",
]);
const OPERATING_STATES = new Map([
  ["in Betrieb", "active"],
  ["a.B.", "out-of-service"],
  ["Planung", "planned"],
  ["ehemals", "former"],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableInteger(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function requiredText(value, field, rowId) {
  invariant(typeof value === "string", `${field} in Quellzeile ${rowId} ist kein Text.`);
  const normalized = value.trim().replace(/\s+/gu, " ");
  invariant(normalized !== "", `${field} in Quellzeile ${rowId} ist leer.`);
  return normalized;
}

function optionalText(value, field, rowId) {
  if (value === null) return null;
  return requiredText(value, field, rowId);
}

function safeInteger(value, field, rowId) {
  invariant(Number.isSafeInteger(value), `${field} in Quellzeile ${rowId} ist keine sichere Ganzzahl.`);
  return value;
}

function finiteNumber(value, field, rowId) {
  invariant(typeof value === "number" && Number.isFinite(value), `${field} in Quellzeile ${rowId} ist keine endliche Zahl.`);
  return value;
}

function scaledInteger(value, factor, field, rowId) {
  const scaled = finiteNumber(value, field, rowId) * factor;
  const rounded = Math.round(scaled);
  invariant(Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) < 0.000_001, `${field} in Quellzeile ${rowId} ist nicht verlustfrei ganzzahlig skalierbar.`);
  return rounded;
}

function routeNumber(value, field, rowId) {
  const parsed = typeof value === "number"
    ? safeInteger(value, field, rowId)
    : Number.parseInt(requiredText(value, field, rowId), 10);
  invariant(Number.isSafeInteger(parsed) && parsed >= 1000 && parsed <= 9999 && String(parsed) === String(value).trim(), `${field} in Quellzeile ${rowId} ist keine vierstellige Streckennummer.`);
  return parsed;
}

function kilometreLabel(value, field, rowId, optional = false) {
  if (optional && value === null) return null;
  const label = requiredText(value, field, rowId);
  invariant(/^-?\d+,\d+ \+ -?\d+$/u.test(label), `${field} in Quellzeile ${rowId} hat ein unbekanntes Kilometrierungsformat: ${label}.`);
  return label;
}

function kilometreMm(kilometres, metres, field, rowId, optional = false) {
  if (optional && kilometres === null && metres === null) return null;
  invariant(kilometres !== null && metres !== null, `${field} in Quellzeile ${rowId} ist nur teilweise befüllt.`);
  return scaledInteger(kilometres, 1_000_000, `${field}_km`, rowId) + scaledInteger(metres, 1_000, `${field}_m`, rowId);
}

function coordinateE7(value, field, rowId, minimum, maximum) {
  const coordinate = finiteNumber(value, field, rowId);
  invariant(coordinate >= minimum && coordinate <= maximum, `${field} in Quellzeile ${rowId} liegt außerhalb von WGS84.`);
  return Math.round(coordinate * 10_000_000);
}

function normalizeSpeed(value, rowId) {
  if (value === null) return { status: "unknown", reason: "missing", sourceValue: null };
  const sourceValue = requiredText(value, "Geschwindigkeit", rowId);
  const match = /^(\d{1,3}) km\/h$/u.exec(sourceValue);
  if (match !== null) {
    const maximumKmh = Number.parseInt(match[1], 10);
    invariant(maximumKmh >= 1 && maximumKmh <= 400, `Geschwindigkeit in Quellzeile ${rowId} liegt außerhalb des unterstützten Wertebereichs.`);
    return { status: "known", maximumKmh, sourceValue };
  }
  if (sourceValue === "SKVerb") return { status: "unknown", reason: "source-code-skverb", sourceValue };
  if (sourceValue === "kein VZG erforderlich") return { status: "unknown", reason: "not-required-by-source", sourceValue };
  throw new Error(`Geschwindigkeit in Quellzeile ${rowId} hat einen unbekannten Wert: ${sourceValue}.`);
}

function normalizeElectrification(value, rowId) {
  const sourceValue = requiredText(value, "Elektrifizierung", rowId);
  const kind = new Map([
    ["Oberleitung", "overhead-line"],
    ["Stromschiene", "conductor-rail"],
    ["nicht elektrifiziert", "none"],
    ["Lücke am Anfang oder Ende der Strecke", "unknown-source-gap"],
    ["Merkmal ist im Streckenabschnitt nicht enthalten", "unknown-not-contained"],
  ]).get(sourceValue);
  invariant(kind !== undefined, `Elektrifizierung in Quellzeile ${rowId} hat einen unbekannten Wert: ${sourceValue}.`);
  return { kind, sourceValue };
}

function normalizeTrackCount(value, rowId) {
  if (value === null) return { status: "unknown", reason: "missing", sourceValue: null };
  const sourceValue = requiredText(value, "Gleisanzahl", rowId);
  if (sourceValue === "eingleisig") return { status: "known", count: 1, sourceValue };
  if (sourceValue === "zweigleisig") return { status: "known", count: 2, sourceValue };
  const reason = new Map([
    ["Lücke am Anfang oder Ende der Strecke", "source-gap"],
    ["Merkmal ist im Streckenabschnitt nicht enthalten", "not-contained"],
  ]).get(sourceValue);
  invariant(reason !== undefined, `Gleisanzahl in Quellzeile ${rowId} hat einen unbekannten Wert: ${sourceValue}.`);
  return { status: "unknown", reason, sourceValue };
}

function normalizeConstruction(value, rowId) {
  if (value === null) return { status: "unknown", reason: "missing", sourceValue: null };
  const sourceValue = requiredText(value, "Bauzustand", rowId);
  const status = new Map([
    ["im Bau", "under-construction"],
    ["Lücke am Anfang oder Ende der Strecke", "unknown-source-gap"],
    ["Lücke im Merkmal", "unknown-source-gap"],
    ["Merkmal ist im Streckenabschnitt nicht enthalten", "not-declared"],
  ]).get(sourceValue);
  invariant(status !== undefined, `Bauzustand in Quellzeile ${rowId} hat einen unbekannten Wert: ${sourceValue}.`);
  return { status, sourceValue };
}

function normalizeDbOperation(value, rowId) {
  const sourceValue = requiredText(value, "DB Betrieb", rowId);
  const status = new Map([
    ["In DB Netz Betrieb", "operated-by-db-infrago"],
    ["Nicht in DB Netz Betrieb", "not-operated-by-db-infrago"],
    ["Merkmal ist im Streckenabschnitt nicht enthalten", "unknown-not-contained"],
  ]).get(sourceValue);
  invariant(status !== undefined, `DB Betrieb in Quellzeile ${rowId} hat einen unbekannten Wert: ${sourceValue}.`);
  return { status, sourceValue };
}

function validateSchema(database) {
  for (const [table, expectedColumns] of Object.entries(TABLE_SCHEMAS)) {
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
    invariant(columns.length > 0, `Pflichttabelle ${table} fehlt.`);
    invariant(columns.length === expectedColumns.length, `Pflichttabelle ${table} hat ${columns.length} statt ${expectedColumns.length} Spalten.`);
    for (let index = 0; index < expectedColumns.length; index += 1) {
      const [name, type, primaryKey] = expectedColumns[index];
      const actual = columns[index];
      invariant(actual.name === name && actual.type.toUpperCase() === type && actual.pk === primaryKey, `Schemaabweichung in ${table}, Spalte ${index + 1}: erwartet ${name} ${type}${primaryKey ? " PRIMARY KEY" : ""}.`);
    }
  }
  const geometryByTable = new Map(database
    .prepare("SELECT table_name, column_name, geometry_type_name, srs_id FROM gpkg_geometry_columns WHERE table_name IN (?, ?)")
    .all(TRACK_TABLE, OPERATING_PLACE_TABLE)
    .map((entry) => [entry.table_name, entry]));
  for (const [table, geometryType] of [[TRACK_TABLE, "MULTICURVE"], [OPERATING_PLACE_TABLE, "POINT"]]) {
    const geometry = geometryByTable.get(table);
    invariant(geometry?.column_name === "geom" && geometry.geometry_type_name === geometryType && geometry.srs_id === 25832, `GeoPackage-Geometrievertrag für ${table} ist nicht EPSG:25832/${geometryType}.`);
  }
}

function trackQuery() {
  return `SELECT
    id,
    Streckennummer AS route_number,
    Richtung AS direction,
    km_von_l AS from_label,
    km_bis_l AS to_label,
    km_von_km AS from_km,
    km_von_m AS from_m,
    km_bis_km AS to_km,
    km_bis_m AS to_m,
    ${quoteIdentifier("Länge")} AS length_km,
    Streckenkurzname AS route_name,
    Bauzustand AS construction,
    ${quoteIdentifier("DB Betrieb")} AS db_operation,
    Elektrifizierung AS electrification,
    Gleisanzahl AS track_count,
    Geschwindigkeit AS speed,
    Bundesland AS federal_state,
    Kreis AS district
  FROM ${quoteIdentifier(TRACK_TABLE)} ORDER BY id`;
}

function normalizeTrack(row) {
  const rowId = safeInteger(row.id, "id", row.id);
  invariant(rowId > 0, `id in Quellzeile ${rowId} ist nicht positiv.`);
  const sourceDirection = requiredText(row.direction, "Richtung", rowId);
  const direction = TRACK_DIRECTIONS.get(sourceDirection);
  invariant(direction !== undefined, `Richtung in Quellzeile ${rowId} hat einen unbekannten Wert: ${sourceDirection}.`);
  const lengthMm = scaledInteger(row.length_km, 1_000_000, "Länge", rowId);
  invariant(lengthMm > 0, `Länge in Quellzeile ${rowId} ist nicht positiv.`);
  return {
    schema: "zugfolge-infrago-track-segment/v1",
    trackSegmentId: `db-infrago:track-segment:${rowId}`,
    sourceRecordId: rowId,
    routeNumber: routeNumber(row.route_number, "Streckennummer", rowId),
    direction: { kind: direction, sourceValue: sourceDirection },
    fromKilometre: {
      label: kilometreLabel(row.from_label, "km_von_l", rowId),
      millimetres: kilometreMm(row.from_km, row.from_m, "km_von", rowId),
    },
    toKilometre: {
      label: kilometreLabel(row.to_label, "km_bis_l", rowId),
      millimetres: kilometreMm(row.to_km, row.to_m, "km_bis", rowId),
    },
    lengthMm,
    routeName: requiredText(row.route_name, "Streckenkurzname", rowId),
    construction: normalizeConstruction(row.construction, rowId),
    dbOperation: normalizeDbOperation(row.db_operation, rowId),
    electrification: normalizeElectrification(row.electrification, rowId),
    trackCount: normalizeTrackCount(row.track_count, rowId),
    speed: normalizeSpeed(row.speed, rowId),
    federalState: optionalText(row.federal_state, "Bundesland", rowId),
    district: optionalText(row.district, "Kreis", rowId),
    geometry: { status: "omitted", reason: "official-layer-is-attribute-and-validation-source" },
  };
}

function operatingPlaceQuery() {
  return `SELECT
    id,
    Streckennummer AS route_number,
    Richtung AS direction,
    km_lage_l AS kilometre_label,
    km_lage_km AS kilometre_km,
    km_lage_m AS kilometre_m,
    Streckenkurzname AS route_name,
    Art AS type_code,
    ${quoteIdentifier("Art lang")} AS type_name,
    Bezeichnung AS name,
    ${quoteIdentifier("Kürzel")} AS rl100,
    Betriebszustand AS operating_state,
    Bundesland AS federal_state,
    Kreis AS district,
    ${quoteIdentifier("Geographische Länge (EPSG 4326)")} AS longitude,
    ${quoteIdentifier("Geographische Breite (EPSG 4326)")} AS latitude
  FROM ${quoteIdentifier(OPERATING_PLACE_TABLE)} ORDER BY id`;
}

function normalizeOperatingPlaceRow(row) {
  const rowId = safeInteger(row.id, "id", row.id);
  invariant(rowId > 0, `id in Quellzeile ${rowId} ist nicht positiv.`);
  const sourceDirection = requiredText(row.direction, "Richtung", rowId);
  invariant(sourceDirection === "Streckenachse", `Betriebsstellen-Richtung in Quellzeile ${rowId} ist nicht Streckenachse: ${sourceDirection}.`);
  const typeCode = requiredText(row.type_code, "Art", rowId);
  invariant(OPERATING_PLACE_TYPES.has(typeCode), `Art in Quellzeile ${rowId} hat einen unbekannten Wert: ${typeCode}.`);
  const sourceOperatingState = requiredText(row.operating_state, "Betriebszustand", rowId);
  const operatingState = OPERATING_STATES.get(sourceOperatingState);
  invariant(operatingState !== undefined, `Betriebszustand in Quellzeile ${rowId} hat einen unbekannten Wert: ${sourceOperatingState}.`);
  const rl100 = requiredText(row.rl100, "Kürzel", rowId);
  invariant(/^[A-Z0-9]+(?: [A-Z0-9]+)*$/u.test(rl100) && rl100.length >= 2 && rl100.length <= 10, `Kürzel in Quellzeile ${rowId} ist kein unterstütztes RL100-Kürzel: ${rl100}.`);
  const millimetres = kilometreMm(row.kilometre_km, row.kilometre_m, "km_lage", rowId, true);
  const label = kilometreLabel(row.kilometre_label, "km_lage_l", rowId, true);
  invariant((millimetres === null) === (label === null), `Kilometrierung in Quellzeile ${rowId} hat Label und Zahlenwert nicht gemeinsam befüllt.`);
  return {
    sourceRecordId: rowId,
    rl100,
    name: requiredText(row.name, "Bezeichnung", rowId),
    type: { code: typeCode, name: requiredText(row.type_name, "Art lang", rowId) },
    operatingState: { kind: operatingState, sourceValue: sourceOperatingState },
    routeNumber: routeNumber(row.route_number, "Streckennummer", rowId),
    direction: { kind: "route-axis", sourceValue: sourceDirection },
    kilometre: millimetres === null
      ? { status: "unknown", reason: "missing-in-source", label: null, millimetres: null }
      : { status: "known", label, millimetres },
    routeName: requiredText(row.route_name, "Streckenkurzname", rowId),
    coordinateE7: {
      longitude: coordinateE7(row.longitude, "Geographische Länge", rowId, -180, 180),
      latitude: coordinateE7(row.latitude, "Geographische Breite", rowId, -90, 90),
    },
    federalState: optionalText(row.federal_state, "Bundesland", rowId),
    district: optionalText(row.district, "Kreis", rowId),
  };
}

function bindingKey(row) {
  return [
    row.routeNumber,
    row.kilometre.status,
    row.kilometre.millimetres ?? "unknown",
    row.coordinateE7.longitude,
    row.coordinateE7.latitude,
    row.type.code,
    row.operatingState.kind,
    row.routeName,
  ].join("|");
}

function compareBinding(left, right) {
  const stateOrder = { active: 0, planned: 1, "out-of-service": 2, former: 3 };
  return stateOrder[left.operatingState.kind] - stateOrder[right.operatingState.kind]
    || (left.kilometre.status === "known" ? 0 : 1) - (right.kilometre.status === "known" ? 0 : 1)
    || left.routeNumber - right.routeNumber
    || compareNullableInteger(left.kilometre.millimetres, right.kilometre.millimetres)
    || left.coordinateE7.longitude - right.coordinateE7.longitude
    || left.coordinateE7.latitude - right.coordinateE7.latitude
    || compareText(left.type.code, right.type.code)
    || compareText(left.routeName, right.routeName);
}

function chooseMostFrequent(counts) {
  return [...counts].sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))[0][0];
}

function deduplicateOperatingPlaces(rows) {
  const groups = new Map();
  for (const row of rows) {
    let group = groups.get(row.rl100);
    if (group === undefined) {
      group = { rows: [], nameCounts: new Map(), bindings: new Map() };
      groups.set(row.rl100, group);
    }
    group.rows.push(row);
    group.nameCounts.set(row.name, (group.nameCounts.get(row.name) ?? 0) + 1);
    const key = bindingKey(row);
    let binding = group.bindings.get(key);
    if (binding === undefined) {
      binding = {
        routeNumber: row.routeNumber,
        direction: row.direction,
        kilometre: row.kilometre,
        routeName: row.routeName,
        coordinateE7: row.coordinateE7,
        type: row.type,
        operatingState: row.operatingState,
        federalState: row.federalState,
        district: row.district,
        sourceRecordIds: [],
      };
      group.bindings.set(key, binding);
    }
    binding.sourceRecordIds.push(row.sourceRecordId);
  }

  return [...groups.entries()].sort(([left], [right]) => compareText(left, right)).map(([rl100, group]) => {
    const bindings = [...group.bindings.values()].sort(compareBinding).map((binding, index) => ({
      bindingId: `db-infrago:rl100:${encodeURIComponent(rl100)}:binding:${index + 1}`,
      ...binding,
      sourceRecordIds: binding.sourceRecordIds.sort((left, right) => left - right),
    }));
    const coordinateCandidates = [...new Map(bindings.map(({ coordinateE7 }) => [
      `${coordinateE7.longitude}|${coordinateE7.latitude}`,
      coordinateE7,
    ])).values()].sort((left, right) => left.longitude - right.longitude || left.latitude - right.latitude);
    const sourceRecordIds = group.rows.map(({ sourceRecordId }) => sourceRecordId).sort((left, right) => left - right);
    const types = [...new Map(group.rows.map(({ type }) => [`${type.code}|${type.name}`, type])).values()]
      .sort((left, right) => compareText(left.code, right.code) || compareText(left.name, right.name));
    const operatingStates = [...new Map(group.rows.map(({ operatingState }) => [operatingState.kind, operatingState])).values()]
      .sort((left, right) => compareText(left.kind, right.kind));
    return {
      schema: "zugfolge-infrago-operating-place/v1",
      operatingPlaceId: `db-infrago:rl100:${encodeURIComponent(rl100)}`,
      rl100,
      name: chooseMostFrequent(group.nameCounts),
      names: [...group.nameCounts.keys()].sort(compareText),
      coordinateE7: bindings[0].coordinateE7,
      coordinateCandidatesE7: coordinateCandidates,
      types,
      operatingStates,
      routeBindings: bindings,
      sourceRecordIds,
    };
  });
}

function countUnknowns(trackSegments, operatingPlaces) {
  return {
    trackSegments: {
      speed: trackSegments.filter(({ speed }) => speed.status === "unknown").length,
      electrification: trackSegments.filter(({ electrification }) => electrification.kind.startsWith("unknown-")).length,
      trackCount: trackSegments.filter(({ trackCount }) => trackCount.status === "unknown").length,
      construction: trackSegments.filter(({ construction }) => construction.status.startsWith("unknown-")).length,
    },
    operatingPlaceBindings: {
      kilometre: operatingPlaces.reduce((count, place) => count + place.routeBindings.filter(({ kilometre }) => kilometre.status === "unknown").length, 0),
    },
  };
}

export function adaptInfraGoGeoPackage(inputPath) {
  invariant(typeof inputPath === "string" && inputPath !== "", "GeoPackage-Pfad fehlt.");
  const database = new DatabaseSync(resolve(inputPath), { readOnly: true });
  try {
    validateSchema(database);
    const trackSegments = database.prepare(trackQuery()).all().map(normalizeTrack);
    const sourceOperatingPlaceRows = database.prepare(operatingPlaceQuery()).all().map(normalizeOperatingPlaceRow);
    invariant(trackSegments.length > 0, `${TRACK_TABLE} ist leer.`);
    invariant(sourceOperatingPlaceRows.length > 0, `${OPERATING_PLACE_TABLE} ist leer.`);
    const operatingPlaces = deduplicateOperatingPlaces(sourceOperatingPlaceRows);
    return {
      trackSegments,
      operatingPlaces,
      sourceCounts: { trackSegments: trackSegments.length, operatingPlaceRows: sourceOperatingPlaceRows.length },
      normalizedCounts: {
        trackSegments: trackSegments.length,
        operatingPlaces: operatingPlaces.length,
        operatingPlaceBindings: operatingPlaces.reduce((count, place) => count + place.routeBindings.length, 0),
      },
      unknownValues: countUnknowns(trackSegments, operatingPlaces),
    };
  } finally {
    database.close();
  }
}

function jsonSequence(values) {
  return values.map((value) => `\x1e${JSON.stringify(value)}\n`).join("");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function writeInfraGoOutputs(inputPath, outputRoot, expectedSourceSha256 = undefined) {
  invariant(typeof outputRoot === "string" && outputRoot !== "", "Ausgabeverzeichnis fehlt.");
  const absoluteInput = resolve(inputPath);
  const sourceSha256 = await sha256File(absoluteInput);
  if (expectedSourceSha256 !== undefined) {
    invariant(/^[a-f0-9]{64}$/u.test(expectedSourceSha256), "Erwarteter GeoPackage-SHA-256 ist ungültig.");
    invariant(sourceSha256 === expectedSourceSha256, `GeoPackage verletzt den gepinnten SHA-256: ${sourceSha256}.`);
  }
  const result = adaptInfraGoGeoPackage(absoluteInput);
  const tracks = jsonSequence(result.trackSegments);
  const operatingPlaces = jsonSequence(result.operatingPlaces);
  const files = {
    trackSegments: "db-infrago-track-segments.jsonseq",
    operatingPlaces: "db-infrago-operating-places.jsonseq",
    report: "db-infrago-adapter-report.json",
  };
  const report = {
    schema: "zugfolge-infrago-gpkg-adapter-report/v1",
    source: {
      sourceId: "db-infrago-infrastructure-open-data",
      sha256: sourceSha256,
      geometryRead: false,
      geometryOutput: false,
      geometryReferenceSystem: "EPSG:25832",
    },
    sourceCounts: result.sourceCounts,
    normalizedCounts: result.normalizedCounts,
    unknownValues: result.unknownValues,
    outputs: [
      { kind: "operating-places", file: files.operatingPlaces, bytes: Buffer.byteLength(operatingPlaces), sha256: sha256Text(operatingPlaces) },
      { kind: "track-segments", file: files.trackSegments, bytes: Buffer.byteLength(tracks), sha256: sha256Text(tracks) },
    ],
  };
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await mkdir(resolve(outputRoot), { recursive: true });
  await Promise.all([
    writeFile(resolve(outputRoot, files.trackSegments), tracks, "utf8"),
    writeFile(resolve(outputRoot, files.operatingPlaces), operatingPlaces, "utf8"),
    writeFile(resolve(outputRoot, files.report), reportText, "utf8"),
  ]);
  return { report, files };
}
