// zugfolge:quelle=gtfs-de-rv
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { InflateRaw } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

import { assertNormalizedScheduleTimeContract } from "../region-import/regional-release-contract.mjs";

export const LIVEMAP_READ_MODEL_APPLICATION_ID = 0x5a554746;
export const LIVEMAP_READ_MODEL_USER_VERSION = 3;
export const LIVEMAP_READ_MODEL_REPORT_SCHEMA = "zugfolge-livemap-read-model-build-report/v1";

const REQUIRED_LAYERS = Object.freeze([
  ["rail_corridors", "rail-corridors.geojsonseq"],
  ["operating_points", "operating-points.geojsonseq"],
  ["stations", "stations.geojsonseq"],
  ["tracks", "tracks.geojsonseq"],
  ["platforms", "platforms.geojsonseq"],
  ["switches", "switches.geojsonseq"],
  ["signals", "signals.geojsonseq"],
  ["blocks", "blocks.geojsonseq"],
  ["conflict_resources", "conflict-resources.geojsonseq"],
  ["rail_context", "rail-context.geojsonseq"],
]);

export const PUBLIC_READ_MODEL_TABLES = Object.freeze({
  metadata: Object.freeze(["key", "value"]),
  world_config: Object.freeze(["world_id", "infrastructure_release_id", "config_json"]),
  object_details: Object.freeze([
    "world_id", "infrastructure_release_id", "kind", "object_id", "name", "quality_class", "facts_json",
  ]),
  station_identifiers: Object.freeze(["world_id", "station_id", "scheme", "value"]),
  station_schedule_calls: Object.freeze([
    "world_id", "station_id", "call_type", "train_id", "scheduled_time_s", "train_number", "category",
    "platform", "origin", "destination",
  ]),
  passenger_information: Object.freeze(["world_id", "train_id", "destination", "following_stops_json", "messages_json"]),
});

const PRIVATE_SCHEMA_NAME = /(account|e-?mail|fixed.?cost|owner|password|personnel|private|secret|token)/i;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value, name) {
  invariant(typeof value === "string" && value.trim().length > 0, `${name} muss eine nichtleere Zeichenkette sein.`);
  return value;
}

function integer(value, name, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER) {
  invariant(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${name} muss eine sichere Ganzzahl sein.`);
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseJsonArray(value) {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function humanBoolean(value) {
  return value === true ? "Ja" : "Nein";
}

function fact(label, value, unit) {
  if (value === undefined || value === null || value === "") return undefined;
  return Object.freeze({ label, value: String(value), ...(unit === undefined ? {} : { unit }) });
}

function compactFacts(values) {
  return Object.freeze(values.filter((value) => value !== undefined));
}

function metres(value) {
  return Number.isSafeInteger(value) ? String(Math.round(value / 1_000)) : undefined;
}

function kilometre(value) {
  if (!Number.isSafeInteger(value)) return undefined;
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 1_000_000)},${String(Math.floor((absolute % 1_000_000) / 1_000)).padStart(3, "0")}`;
}

function tags(properties) {
  if (typeof properties.osm_tags_json !== "string") return {};
  try {
    const parsed = JSON.parse(properties.osm_tags_json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const MODEL_STATE_LABELS = Object.freeze({
  observed_osm_topology_enriched_official_route_segment: "beobachtete Gleisgeometrie mit amtlichen Streckenmerkmalen",
  observed_official_route_segment: "amtlich beschriebener Streckenabschnitt",
  observed_official_operating_place_corroborated_annual_network: "amtliche Betriebsstelle, im Jahresnetz bestaetigt",
  observed_official_operating_place: "amtliche Betriebsstelle",
  observed_osm_non_block_signal: "beobachtetes Signal ohne Blockgrenzfunktion",
  observed_osm_block_signal: "beobachtetes Signal mit Blockgrenzfunktion",
  observed_osm_switch: "beobachtete Weiche mit Gleiszuordnung",
  derived_conservative_signal_bounded_block: "konservativ aus Signalgrenzen abgeleiteter Blockabschnitt",
  derived_block_exclusion: "aus Blockabschnitt abgeleitete Ausschlussressource",
  derived_track_section_exclusion: "aus Streckengleis abgeleitete Ausschlussressource",
  observed_geometry_without_track_assignment: "beobachtete Lage ohne eindeutige Gleiszuordnung",
  unresolved_track_assignment: "Gleiszuordnung nicht eindeutig",
  ambiguous_evidence: "mehrdeutige Stationszuordnung",
  "ambiguous-evidence": "mehrdeutige Stationszuordnung",
  observed_unique_evidence: "eindeutig zugeordnete Station",
  "observed-unique-evidence": "eindeutig zugeordnete Station",
});

function modelStateLabel(value) {
  if (typeof value !== "string" || value.length === 0) return "nicht ausgewiesen";
  return MODEL_STATE_LABELS[value] ?? value.replaceAll("_", " ").replaceAll("-", " ");
}

function directionLabel(value) {
  return ({
    forward: "in Geometrierichtung",
    backward: "gegen Geometrierichtung",
    both: "beide Richtungen",
    "forward-track": "Richtungsgleis",
    "reverse-track": "Gegengleis",
  })[value] ?? value;
}

function electrificationLabel(value) {
  return ({
    "overhead-line": "Oberleitung",
    overhead: "Oberleitung",
    rail: "Stromschiene",
    none: "nicht elektrifiziert",
    no: "nicht elektrifiziert",
    yes: "elektrifiziert",
  })[value] ?? value;
}

function resourceKindLabel(value) {
  return ({ block: "Blockabschnitt", track: "Streckengleis", switch: "Weichenbereich", facility: "Betriebsanlage" })[value] ?? "Konfliktressource";
}

function objectKindForLayer(layer) {
  return ({
    rail_corridors: "track",
    operating_points: "operating-point",
    stations: "station",
    tracks: "track",
    platforms: "platform",
    switches: "switch",
    signals: "signal",
    blocks: "block",
    conflict_resources: "facility",
    rail_context: "rail-context",
  })[layer];
}

function commonFacts(properties) {
  return [
    fact("Datenqualitaet", `Klasse ${properties.quality_class}`),
    fact("Betriebsmodell", modelStateLabel(properties.model_state)),
    fact("Fuer Fahrwege nutzbar", humanBoolean(properties.orderable === true)),
  ];
}

function trackProtection(selectedTags) {
  const systems = [];
  if (["yes", "pzb"].includes(String(selectedTags["railway:pzb"] ?? "").toLowerCase())) systems.push("PZB");
  if (["yes", "lzb"].includes(String(selectedTags["railway:lzb"] ?? "").toLowerCase())) systems.push("LZB");
  if (String(selectedTags["railway:etcs"] ?? "").toLowerCase() === "yes") systems.push("ETCS");
  return systems.join(", ") || undefined;
}

function detailForLayer(layer, properties) {
  const selectedTags = tags(properties);
  const id = nonEmptyString(properties.feature_id, `${layer}.feature_id`);
  const kind = objectKindForLayer(layer);
  invariant(kind !== undefined, `Unbekannte interaktive Ebene '${layer}'.`);
  const base = commonFacts(properties);
  if (layer === "rail_corridors") {
    const route = optionalString(String(properties.route_number ?? ""));
    const routeName = optionalString(properties.route_name);
    return {
      id,
      kind,
      name: routeName === undefined ? `Streckenkorridor ${route ?? "ohne Nummer"}` : `Streckenkorridor ${route ?? ""} ${routeName}`.trim(),
      facts: compactFacts([
        fact("Streckennummer", route),
        fact("Streckenbezeichnung", routeName),
        fact("Richtung", directionLabel(properties.direction)),
        fact("Kilometer von", kilometre(properties.from_km_mm), "km"),
        fact("Kilometer bis", kilometre(properties.to_km_mm), "km"),
        fact("Zulaessige Geschwindigkeit", properties.maximum_speed_kmh, "km/h"),
        fact("Elektrifizierung", electrificationLabel(properties.electrification)),
        fact("Gleiszahl", properties.track_count),
        ...base,
      ]),
    };
  }
  if (layer === "tracks") {
    const route = optionalString(String(properties.official_route_number ?? selectedTags.ref ?? ""));
    const lineName = optionalString(selectedTags.name);
    const gradient = Number.isSafeInteger(properties.minimum_gradient_permille) && Number.isSafeInteger(properties.maximum_gradient_permille)
      ? `${properties.minimum_gradient_permille} bis ${properties.maximum_gradient_permille}`
      : optionalString(properties.gradient_status) === "unresolved" ? "konservative Ersatzannahme" : undefined;
    return {
      id,
      kind,
      name: lineName ?? (route === undefined ? "Streckengleis" : `Streckengleis der Strecke ${route}`),
      facts: compactFacts([
        fact("Streckennummer", route),
        fact("Laenge", metres(properties.length_mm), "m"),
        fact("Geschwindigkeit in Geometrierichtung", properties.speed_forward_kmh, "km/h"),
        fact("Geschwindigkeit gegen Geometrierichtung", properties.speed_backward_kmh, "km/h"),
        fact("Elektrifizierung", electrificationLabel(properties.official_electrification ?? selectedTags.electrified)),
        fact("Gleiszahl im Streckenabschnitt", properties.official_track_count),
        fact("Zugsicherung", trackProtection(selectedTags)),
        fact("Gradientenbereich", gradient, gradient === undefined || gradient === "konservative Ersatzannahme" ? undefined : "‰"),
        fact("Repraesentative Neigung", properties.representative_gradient_permille, "‰"),
        fact("Neigungsunsicherheit", properties.uncertainty_permille, "‰"),
        ...base,
      ]),
    };
  }
  if (layer === "stations") {
    return {
      id,
      kind,
      name: optionalString(properties.name) ?? "Bahnhof",
      facts: compactFacts([
        fact("RL100-Kuerzel", optionalString(properties.rl100)),
        fact("EVA-/UIC-Nummer", optionalString(properties.uic)),
        ...base,
      ]),
    };
  }
  if (layer === "rail_context") {
    const contextKind = optionalString(properties.context_kind) ?? "rail-context";
    const contextNames = {
      crossing: "Bahnübergang",
      milestone: "Kilometertafel",
      stop: "Haltepunkt im Kontextnetz",
      buffer_stop: "Prellbock",
    };
    return {
      id,
      kind,
      name: optionalString(selectedTags.name) ?? contextNames[contextKind] ?? "Bahninfrastruktur im Kontextnetz",
      facts: compactFacts([
        fact("Kontextart", contextNames[contextKind] ?? contextKind),
        fact("Bezeichnung", optionalString(selectedTags.ref) ?? optionalString(selectedTags.local_ref)),
        fact("Kilometerangabe", optionalString(selectedTags["railway:position"])),
        ...base,
      ]),
    };
  }
  if (layer === "operating_points") {
    const typeNames = parseJsonArray(properties.types_json).map((entry) => entry?.name).filter((value) => typeof value === "string");
    const routeNumbers = parseJsonArray(properties.route_numbers_json).filter((value) => Number.isSafeInteger(value));
    return {
      id,
      kind,
      name: optionalString(properties.name) ?? `Betriebsstelle ${properties.rl100 ?? ""}`.trim(),
      facts: compactFacts([
        fact("RL100-Kuerzel", optionalString(properties.rl100)),
        fact("Betriebsstellenart", typeNames.join(", ") || undefined),
        fact("Streckennummern", routeNumbers.join(", ") || undefined),
        fact("Elektrifiziert", properties.tf_electrified === undefined ? undefined : humanBoolean(properties.tf_electrified === true)),
        ...base,
      ]),
    };
  }
  if (layer === "platforms") {
    const designation = optionalString(selectedTags.local_ref ?? selectedTags.ref);
    return {
      id,
      kind,
      name: optionalString(selectedTags.name) ?? (designation === undefined ? "Bahnsteig" : `Bahnsteig ${designation}`),
      facts: compactFacts([
        fact("Bahnsteigbezeichnung", designation),
        fact("Barrierefreier Zugang", selectedTags.wheelchair === "yes" ? "Ja" : selectedTags.wheelchair === "no" ? "Nein" : undefined),
        fact("Taktiles Leitsystem", selectedTags.tactile_paving === "yes" ? "Ja" : selectedTags.tactile_paving === "no" ? "Nein" : undefined),
        ...base,
      ]),
    };
  }
  if (layer === "switches") {
    const reference = optionalString(selectedTags.ref);
    return {
      id,
      kind,
      name: reference === undefined ? "Weiche" : `Weiche ${reference}`,
      facts: compactFacts([
        fact("Weichenbezeichnung", reference),
        fact("Angeschlossene Gleisabschnitte", parseJsonArray(properties.incident_track_ids_json).length),
        fact("Abzweigrichtung", optionalString(selectedTags["railway:turnout_side"])),
        ...base,
      ]),
    };
  }
  if (layer === "signals") {
    const reference = optionalString(selectedTags.ref);
    return {
      id,
      kind,
      name: reference === undefined ? "Signal" : `Signal ${reference}`,
      facts: compactFacts([
        fact("Signalbezeichnung", reference),
        fact("Wirkrichtung", directionLabel(selectedTags["railway:signal:direction"])),
        fact("Blockgrenze", humanBoolean(properties.block_boundary === true)),
        fact("Zugeordnete Gleisabschnitte", parseJsonArray(properties.incident_track_ids_json).length),
        ...base,
      ]),
    };
  }
  if (layer === "blocks") {
    return {
      id,
      kind,
      name: "Blockabschnitt",
      facts: compactFacts([
        fact("Laenge", metres(properties.length_mm), "m"),
        fact("Enthaltene Gleisabschnitte", properties.track_count),
        fact("Begrenzende Signale", properties.boundary_signal_count),
        ...base,
      ]),
    };
  }
  const resourceKind = resourceKindLabel(properties.resource_kind);
  return {
    id,
    kind,
    name: `${resourceKind} als Konfliktressource`,
    facts: compactFacts([
      fact("Ressourcenart", resourceKind),
      fact("Enthaltene Gleisabschnitte", parseJsonArray(properties.track_ids_json).length),
      ...base,
    ]),
  };
}

export function objectDetailFromFeature(layer, feature, worldId, infrastructureReleaseId) {
  invariant(feature !== null && typeof feature === "object" && feature.type === "Feature", `${layer} enthaelt kein GeoJSON-Feature.`);
  const properties = feature.properties;
  invariant(properties !== null && typeof properties === "object" && !Array.isArray(properties), `${layer} besitzt keine Eigenschaften.`);
  const detail = detailForLayer(layer, properties);
  const qualityClass = properties.quality_class;
  invariant(["A", "B", "C"].includes(qualityClass), `${detail.id} besitzt keine Qualitaetsklasse.`);
  return Object.freeze({
    worldId,
    infrastructureReleaseId,
    kind: detail.kind,
    id: detail.id,
    name: detail.name,
    qualityClass,
    facts: detail.facts,
  });
}

async function* csvRows(path) {
  const input = createReadStream(path, { encoding: "utf8", highWaterMark: 1024 * 1024 });
  let field = "";
  let row = [];
  let quoted = false;
  let header;
  for await (const chunk of input) {
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index];
      if (quoted) {
        if (character === '"' && chunk[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') quoted = false;
        else field += character;
      } else if (character === '"') quoted = true;
      else if (character === ",") {
        row.push(field);
        field = "";
      } else if (character === "\n") {
        row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
        field = "";
        if (header === undefined) {
          header = row.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "") : value);
          invariant(header.length > 0 && new Set(header).size === header.length, `${basename(path)} besitzt keinen eindeutigen Header.`);
        } else if (row.some((value) => value !== "")) {
          yield Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""]));
        }
        row = [];
      } else field += character;
    }
  }
  invariant(!quoted, `${basename(path)} besitzt ein nicht geschlossenes CSV-Anfuehrungszeichen.`);
  if (field !== "" || row.length > 0) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    if (header === undefined) header = row.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "") : value);
    else if (row.some((value) => value !== "")) yield Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""]));
  }
  invariant(header !== undefined, `${basename(path)} ist leer.`);
}

function zipEntries(buffer) {
  let end = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  invariant(end >= 0, "GTFS-ZIP besitzt kein Endverzeichnis.");
  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  invariant(count !== 0xffff && centralOffset !== 0xffffffff, "ZIP64 wird fuer den GTFS-Grundbestand nicht akzeptiert.");
  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    invariant(buffer.readUInt32LE(cursor) === 0x02014b50, "GTFS-ZIP besitzt ein beschaedigtes Zentralverzeichnis.");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    invariant(!name.includes("..") && !name.startsWith("/") && !name.includes("\\"), `Unsicherer ZIP-Eintrag '${name}'.`);
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function extractGtfsArchive(archivePath, targetDirectory) {
  const archive = await readFile(archivePath);
  const entries = zipEntries(archive);
  const required = ["agency.txt", "stops.txt", "routes.txt", "calendar.txt", "calendar_dates.txt", "trips.txt", "stop_times.txt"];
  for (const name of required) {
    const entry = entries.get(name);
    invariant(entry !== undefined, `GTFS-ZIP enthaelt '${name}' nicht.`);
    invariant([0, 8].includes(entry.method), `GTFS-ZIP nutzt fuer '${name}' ein nicht unterstuetztes Verfahren.`);
    invariant(archive.readUInt32LE(entry.localOffset) === 0x04034b50, `Lokaler ZIP-Header fuer '${name}' ist beschaedigt.`);
    const localNameLength = archive.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = archive.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + localNameLength + localExtraLength;
    const outputPath = join(targetDirectory, name);
    const source = createReadStream(archivePath, { start, end: start + entry.compressedSize - 1 });
    if (entry.method === 8) await pipeline(source, new InflateRaw(), createWriteStream(outputPath, { flags: "wx" }));
    else await pipeline(source, createWriteStream(outputPath, { flags: "wx" }));
    const extracted = await stat(outputPath);
    invariant(extracted.size === entry.uncompressedSize, `Entpackte Groesse von '${name}' stimmt nicht.`);
  }
}

async function withGtfsDirectory(inputPath, action) {
  if (extname(inputPath).toLowerCase() !== ".zip") return action(inputPath);
  const temporary = await mkdtemp(join(tmpdir(), "zugfolge-gtfs-read-model-"));
  try {
    await extractGtfsArchive(inputPath, temporary);
    return await action(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function normalizeStationName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(bahnhof|bf)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function distanceMillimetres(left, right) {
  const latitudeRadians = ((left.latitudeE7 + right.latitudeE7) / 20_000_000) * Math.PI / 180;
  const dy = (left.latitudeE7 - right.latitudeE7) / 10_000_000 * 111_320;
  const dx = (left.longitudeE7 - right.longitudeE7) / 10_000_000 * 111_320 * Math.cos(latitudeRadians);
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 1_000);
}

function stationGridKey(latitudeE7, longitudeE7) {
  return `${Math.floor(latitudeE7 / 100_000)}:${Math.floor(longitudeE7 / 100_000)}`;
}

function candidateGridKeys(latitudeE7, longitudeE7) {
  const latitude = Math.floor(latitudeE7 / 100_000);
  const longitude = Math.floor(longitudeE7 / 100_000);
  const keys = [];
  for (let y = latitude - 1; y <= latitude + 1; y += 1) for (let x = longitude - 1; x <= longitude + 1; x += 1) keys.push(`${y}:${x}`);
  return keys;
}

export function matchStopToStations(stop, stations, indexes) {
  const identifier = String(stop.stopId);
  const byEva = indexes.byEva.get(identifier) ?? [];
  if (byEva.length === 1) return Object.freeze({ station: byEva[0], method: "exact-identifier", distanceMm: 0 });
  if (!Number.isSafeInteger(stop.latitudeE7) || !Number.isSafeInteger(stop.longitudeE7)) return undefined;
  const name = normalizeStationName(stop.name);
  if (name.length === 0) return undefined;
  const candidates = candidateGridKeys(stop.latitudeE7, stop.longitudeE7)
    .flatMap((key) => indexes.grid.get(key) ?? [])
    .filter((candidate) => candidate.normalizedName === name)
    .map((candidate) => ({ candidate, distanceMm: distanceMillimetres(stop, candidate) }))
    .filter(({ distanceMm }) => distanceMm <= 750_000)
    .sort((left, right) => left.distanceMm - right.distanceMm || left.candidate.stationId.localeCompare(right.candidate.stationId));
  if (candidates.length === 0) return undefined;
  if (candidates[1] !== undefined && candidates[1].distanceMm - candidates[0].distanceMm < 25_000) return undefined;
  return Object.freeze({ station: candidates[0].candidate, method: "name-and-coordinate", distanceMm: candidates[0].distanceMm });
}

function createStationIndexes(stations) {
  const byEva = new Map();
  const grid = new Map();
  for (const station of stations) {
    for (const eva of station.eva) {
      const values = byEva.get(eva) ?? [];
      values.push(station);
      byEva.set(eva, values);
    }
    const key = stationGridKey(station.latitudeE7, station.longitudeE7);
    const values = grid.get(key) ?? [];
    values.push(station);
    grid.set(key, values);
  }
  return { byEva, grid };
}

function parseServiceTime(value) {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(value ?? "");
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes >= 60 || seconds >= 60) return undefined;
  return hours * 3_600 + minutes * 60 + seconds;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function journeyChainId(identity) {
  return `jc-${createHash("sha256").update(canonicalJson(identity)).digest("hex").slice(0, 24)}`;
}

function categoryForRoute(routeShortName) {
  const value = String(routeShortName ?? "").trim().toUpperCase();
  if (value.startsWith("S")) return "S-Bahn";
  if (value.startsWith("RE")) return "Regional-Express";
  if (value.startsWith("RB")) return "Regionalbahn";
  if (value.startsWith("IRE")) return "Interregio-Express";
  return "Regionalverkehr";
}

function activeServiceIds(calendarRows, exceptionRows, serviceDate) {
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][new Date(`${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6, 8)}T12:00:00Z`).getUTCDay()];
  const active = new Set();
  for (const row of calendarRows) if (row.start_date <= serviceDate && row.end_date >= serviceDate && row[weekday] === "1") active.add(row.service_id);
  for (const row of exceptionRows) {
    if (row.date !== serviceDate) continue;
    if (row.exception_type === "1") active.add(row.service_id);
    else if (row.exception_type === "2") active.delete(row.service_id);
  }
  return active;
}

function railwayRouteType(value) {
  const number = Number(value);
  return number === 2 || (Number.isInteger(number) && number >= 100 && number <= 117);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function gtfsSourceHash(path) {
  const source = await stat(path);
  if (source.isFile()) return sha256File(path);
  const hash = createHash("sha256");
  for (const name of (await readdir(path)).filter((value) => value.endsWith(".txt")).sort()) {
    hash.update(name);
    hash.update("\u0000");
    for await (const chunk of createReadStream(join(path, name))) hash.update(chunk);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function createDatabase(path) {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    defensive: true,
    timeout: 0,
  });
  database.exec(`
    PRAGMA page_size = 4096;
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA locking_mode = EXCLUSIVE;
    PRAGMA application_id = ${LIVEMAP_READ_MODEL_APPLICATION_ID};
    PRAGMA user_version = ${LIVEMAP_READ_MODEL_USER_VERSION};
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
    CREATE TABLE world_config (
      world_id TEXT PRIMARY KEY,
      infrastructure_release_id TEXT NOT NULL,
      config_json TEXT NOT NULL CHECK(json_valid(config_json))
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE object_details (
      world_id TEXT NOT NULL,
      infrastructure_release_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('track','station','platform','switch','signal','block','facility','operating-point','rail-context')),
      object_id TEXT NOT NULL,
      name TEXT NOT NULL,
      quality_class TEXT NOT NULL CHECK(quality_class IN ('A','B','C')),
      facts_json TEXT NOT NULL CHECK(json_valid(facts_json) AND json_type(facts_json) = 'array'),
      PRIMARY KEY (world_id, kind, object_id),
      FOREIGN KEY (world_id) REFERENCES world_config(world_id)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX object_details_release_idx ON object_details(world_id, infrastructure_release_id, kind);
    CREATE TABLE station_identifiers (
      world_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      scheme TEXT NOT NULL CHECK(scheme IN ('eva','rl100','schedule-stop')),
      value TEXT NOT NULL,
      PRIMARY KEY (world_id, scheme, value, station_id),
      FOREIGN KEY (world_id) REFERENCES world_config(world_id)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX station_identifiers_station_idx ON station_identifiers(world_id, station_id);
    CREATE TABLE station_schedule_calls (
      world_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      call_type TEXT NOT NULL CHECK(call_type IN ('arrival','departure')),
      train_id TEXT NOT NULL,
      scheduled_time_s INTEGER NOT NULL CHECK(scheduled_time_s >= 0),
      train_number TEXT NOT NULL,
      category TEXT NOT NULL,
      platform TEXT,
      origin TEXT,
      destination TEXT,
      PRIMARY KEY (world_id, station_id, call_type, train_id, scheduled_time_s),
      FOREIGN KEY (world_id) REFERENCES world_config(world_id)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX station_schedule_time_idx ON station_schedule_calls(world_id, station_id, scheduled_time_s, call_type);
    CREATE TABLE passenger_information (
      world_id TEXT NOT NULL,
      train_id TEXT NOT NULL,
      destination TEXT,
      following_stops_json TEXT NOT NULL CHECK(json_valid(following_stops_json) AND json_type(following_stops_json) = 'array'),
      messages_json TEXT NOT NULL CHECK(json_valid(messages_json) AND json_type(messages_json) = 'array'),
      PRIMARY KEY (world_id, train_id),
      FOREIGN KEY (world_id) REFERENCES world_config(world_id)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE gtfs_calls (
      trip_id TEXT NOT NULL,
      stop_sequence INTEGER NOT NULL,
      stop_id TEXT NOT NULL,
      station_id TEXT,
      stop_name TEXT NOT NULL,
      platform TEXT,
      arrival_s INTEGER,
      departure_s INTEGER,
      PRIMARY KEY (trip_id, stop_sequence, stop_id)
    ) STRICT, WITHOUT ROWID;
  `);
  return database;
}

async function readStationsForMatching(inputDirectory) {
  const stations = [];
  for await (const line of lines(join(inputDirectory, "stations.geojsonseq"))) {
    const feature = JSON.parse(line.replace(/^\u001e/, ""));
    const properties = feature.properties;
    const coordinates = feature.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const stationId = properties.feature_id;
    const latitudeE7 = Math.round(Number(coordinates[1]) * 10_000_000);
    const longitudeE7 = Math.round(Number(coordinates[0]) * 10_000_000);
    if (!Number.isSafeInteger(latitudeE7) || !Number.isSafeInteger(longitudeE7)) continue;
    stations.push(Object.freeze({
      stationId,
      name: properties.name,
      normalizedName: normalizeStationName(properties.name),
      latitudeE7,
      longitudeE7,
      eva: [...new Set([properties.uic, ...String(properties.eva_refs ?? "").split(/[;,]/)].filter((value) => typeof value === "string" && value.length > 0))],
      rl100: [...new Set([properties.rl100, ...String(properties.rl100_refs ?? "").split(/[;,]/)].filter((value) => typeof value === "string" && value.length > 0))],
    }));
  }
  stations.sort((left, right) => left.stationId.localeCompare(right.stationId));
  return stations;
}

async function* lines(path) {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1024 * 1024 });
  let remainder = "";
  for await (const chunk of stream) {
    remainder += chunk;
    let newline;
    while ((newline = remainder.indexOf("\n")) >= 0) {
      const line = remainder.slice(0, newline).replace(/\r$/, "");
      remainder = remainder.slice(newline + 1);
      if (line.trim().length > 0) yield line;
    }
  }
  if (remainder.trim().length > 0) yield remainder.replace(/\r$/, "");
}

async function ingestObjects(database, inputDirectory, worldId, infrastructureReleaseId) {
  const insert = database.prepare(`INSERT INTO object_details
    (world_id, infrastructure_release_id, kind, object_id, name, quality_class, facts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const counts = {};
  const countsByKind = {};
  for (const [layer, filename] of REQUIRED_LAYERS) {
    let count = 0;
    let previousId;
    database.exec("BEGIN IMMEDIATE");
    try {
      for await (const line of lines(join(inputDirectory, filename))) {
        const feature = JSON.parse(line.replace(/^\u001e/, ""));
        const detail = objectDetailFromFeature(layer, feature, worldId, infrastructureReleaseId);
        invariant(previousId === undefined || previousId < detail.id, `${filename} ist nicht streng nach stabiler Feature-ID sortiert.`);
        previousId = detail.id;
        insert.run(worldId, infrastructureReleaseId, detail.kind, detail.id, detail.name, detail.qualityClass, JSON.stringify(detail.facts));
        count += 1;
        countsByKind[detail.kind] = (countsByKind[detail.kind] ?? 0) + 1;
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    counts[layer] = count;
  }
  return { counts, countsByKind };
}

async function buildGtfsFoundation(database, directory, spec, stations, scheduleTime) {
  const calendarRows = [];
  const exceptionRows = [];
  for await (const row of csvRows(join(directory, "calendar.txt"))) calendarRows.push(row);
  for await (const row of csvRows(join(directory, "calendar_dates.txt"))) exceptionRows.push(row);
  const activeServices = activeServiceIds(calendarRows, exceptionRows, spec.gtfs.serviceDate);

  const agencies = new Map();
  for await (const row of csvRows(join(directory, "agency.txt"))) agencies.set(row.agency_id, row.agency_name);
  const routes = new Map();
  for await (const row of csvRows(join(directory, "routes.txt"))) if (railwayRouteType(row.route_type)) routes.set(row.route_id, row);

  const archiveHash = await gtfsSourceHash(spec.gtfs.archive);
  const gtfsReleaseId = spec.gtfs.trainIdentity.releaseId.replace("{archiveSha16}", archiveHash.slice(0, 16));
  const trips = new Map();
  for await (const row of csvRows(join(directory, "trips.txt"))) {
    const route = routes.get(row.route_id);
    if (route === undefined || !activeServices.has(row.service_id)) continue;
    const trainId = journeyChainId({
      worldId: spec.worldId,
      regionId: spec.gtfs.trainIdentity.regionId,
      releaseId: gtfsReleaseId,
      sourceTripId: row.trip_id,
    });
    trips.set(row.trip_id, {
      trainId,
      routeShortName: optionalString(route.route_short_name) ?? "Regionalzug",
      category: categoryForRoute(route.route_short_name),
      operator: optionalString(agencies.get(route.agency_id)) ?? "Eisenbahnverkehrsunternehmen",
    });
  }

  const stops = new Map();
  for await (const row of csvRows(join(directory, "stops.txt"))) {
    const latitude = Number(row.stop_lat);
    const longitude = Number(row.stop_lon);
    stops.set(row.stop_id, {
      stopId: row.stop_id,
      parentId: optionalString(row.parent_station),
      name: row.stop_name,
      latitudeE7: Number.isFinite(latitude) ? Math.round(latitude * 10_000_000) : undefined,
      longitudeE7: Number.isFinite(longitude) ? Math.round(longitude * 10_000_000) : undefined,
      platform: optionalString(row.platform_code),
    });
  }
  const stationIndexes = createStationIndexes(stations);
  const stopMatches = new Map();
  const matchCounts = { exactIdentifier: 0, nameAndCoordinate: 0, unmatched: 0 };
  for (const stop of stops.values()) {
    const parent = stop.parentId === undefined ? undefined : stops.get(stop.parentId);
    const representative = parent === undefined ? stop : {
      ...stop,
      name: parent.name,
      latitudeE7: parent.latitudeE7 ?? stop.latitudeE7,
      longitudeE7: parent.longitudeE7 ?? stop.longitudeE7,
    };
    const match = matchStopToStations(representative, stations, stationIndexes);
    if (match === undefined) matchCounts.unmatched += 1;
    else {
      stopMatches.set(stop.stopId, match);
      if (match.method === "exact-identifier") matchCounts.exactIdentifier += 1;
      else matchCounts.nameAndCoordinate += 1;
    }
  }

  const insertIdentifier = database.prepare("INSERT OR IGNORE INTO station_identifiers (world_id, station_id, scheme, value) VALUES (?, ?, ?, ?)");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const station of stations) {
      for (const eva of station.eva) insertIdentifier.run(spec.worldId, station.stationId, "eva", eva);
      for (const rl100 of station.rl100) insertIdentifier.run(spec.worldId, station.stationId, "rl100", rl100);
    }
    for (const [stopId, match] of [...stopMatches].sort(([left], [right]) => left.localeCompare(right))) {
      insertIdentifier.run(spec.worldId, match.station.stationId, "schedule-stop", stopId);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const serviceStartS = scheduleTime.serviceStartOffsetS;
  const insertCall = database.prepare("INSERT INTO gtfs_calls (trip_id, stop_sequence, stop_id, station_id, stop_name, platform, arrival_s, departure_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  let gtfsCallCount = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for await (const row of csvRows(join(directory, "stop_times.txt"))) {
      if (!trips.has(row.trip_id)) continue;
      const stop = stops.get(row.stop_id);
      if (stop === undefined) continue;
      const sequence = Number(row.stop_sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 0) continue;
      const arrival = parseServiceTime(row.arrival_time);
      const departure = parseServiceTime(row.departure_time);
      const match = stopMatches.get(stop.stopId);
      insertCall.run(
        row.trip_id,
        sequence,
        stop.stopId,
        match?.station.stationId ?? null,
        stop.name,
        stop.platform ?? null,
        arrival === undefined ? null : serviceStartS + arrival,
        departure === undefined ? null : serviceStartS + departure,
      );
      gtfsCallCount += 1;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const insertPassenger = database.prepare("INSERT INTO passenger_information (world_id, train_id, destination, following_stops_json, messages_json) VALUES (?, ?, ?, ?, ?)");
  const insertSchedule = database.prepare(`INSERT OR IGNORE INTO station_schedule_calls
    (world_id, station_id, call_type, train_id, scheduled_time_s, train_number, category, platform, origin, destination)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const query = database.prepare("SELECT trip_id, stop_sequence, stop_id, station_id, stop_name, platform, arrival_s, departure_s FROM gtfs_calls ORDER BY trip_id, stop_sequence, stop_id");
  let selectedTrip;
  let selectedCalls = [];
  let passengerPlanCount = 0;
  let scheduleCallCount = 0;
  const flush = () => {
    if (selectedTrip === undefined || selectedCalls.length === 0) return;
    const trip = trips.get(selectedTrip);
    if (trip === undefined) return;
    const origin = selectedCalls[0].stop_name;
    const destination = selectedCalls.at(-1).stop_name;
    const followingStops = selectedCalls.slice(1).map((call) => call.stop_name).filter((name, index, values) => index === 0 || name !== values[index - 1]);
    insertPassenger.run(spec.worldId, trip.trainId, destination, JSON.stringify(followingStops), "[]");
    passengerPlanCount += 1;
    for (const call of selectedCalls) {
      if (call.station_id === null) continue;
      for (const [type, scheduled] of [["arrival", call.arrival_s], ["departure", call.departure_s]]) {
        if (!Number.isSafeInteger(scheduled) || scheduled < 0) continue;
        scheduleCallCount += Number(insertSchedule.run(
          spec.worldId,
          call.station_id,
          type,
          trip.trainId,
          scheduled,
          trip.routeShortName,
          trip.category,
          call.platform,
          origin,
          destination,
        ).changes);
      }
    }
  };
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of query.iterate()) {
      if (selectedTrip !== row.trip_id) {
        flush();
        selectedTrip = row.trip_id;
        selectedCalls = [];
      }
      selectedCalls.push(row);
    }
    flush();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return {
    archiveSha256: archiveHash,
    releaseId: gtfsReleaseId,
    serviceDate: spec.gtfs.serviceDate,
    activeServiceCount: activeServices.size,
    railwayRouteCount: routes.size,
    activeRailTripCount: trips.size,
    sourceStopCount: stops.size,
    matchedStopCount: stopMatches.size,
    matchCounts,
    gtfsCallCount,
    passengerPlanCount,
    scheduleCallCount,
  };
}

function validateSpec(spec) {
  invariant(spec?.schema === "zugfolge-livemap-read-model-build-spec/v1", "Livemap-ReadModel-Spezifikation besitzt ein unbekanntes Schema.");
  nonEmptyString(spec.worldId, "worldId");
  nonEmptyString(spec.infrastructureReleaseId, "infrastructureReleaseId");
  nonEmptyString(spec.worldEpoch, "worldEpoch");
  invariant(!Number.isNaN(Date.parse(spec.worldEpoch)), "worldEpoch ist ungueltig.");
  nonEmptyString(spec.inputDirectory, "inputDirectory");
  nonEmptyString(spec.gtfs?.archive, "gtfs.archive");
  invariant(/^20\d{6}$/.test(spec.gtfs.serviceDate), "gtfs.serviceDate muss YYYYMMDD sein.");
  nonEmptyString(spec.gtfs.timeZone, "gtfs.timeZone");
  nonEmptyString(spec.gtfs.trainIdentity?.regionId, "gtfs.trainIdentity.regionId");
  nonEmptyString(spec.gtfs.trainIdentity?.releaseId, "gtfs.trainIdentity.releaseId");
  invariant(spec.config?.schemaVersion === "zugfolge-livemap-config/v2", "config besitzt kein v2-Schema.");
  nonEmptyString(spec.config.worldName, "config.worldName");
  invariant(spec.config.worldId === spec.worldId && spec.config.infrastructureReleaseId === spec.infrastructureReleaseId, "config verletzt Welt- oder Releasebindung.");
  invariant(spec.config.basemap?.selfHosted === true, "Basiskarte muss selbst gehostet sein.");
  return assertNormalizedScheduleTimeContract({
    worldEpoch: spec.worldEpoch,
    serviceDate: spec.gtfs.serviceDate,
    timeZone: spec.gtfs.timeZone,
    serviceStartOffsetS: spec.serviceStartOffsetS,
    repeatEveryS: spec.repeatEveryS,
  });
}

function readScheduleTimeMetadata(database, world) {
  const rows = database.prepare("SELECT key, value FROM metadata ORDER BY key").all();
  const expectedKeys = [
    "gtfs_service_date",
    "infrastructure_release_id",
    "repeat_every_s",
    "schema",
    "service_start_offset_s",
    "time_zone",
    "world_epoch",
    "world_id",
  ];
  invariant(JSON.stringify(rows.map((row) => row.key)) === JSON.stringify(expectedKeys), "ReadModel besitzt keinen vollstaendigen normalisierten Schedule-Zeitvertrag.");
  const metadata = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  invariant(metadata.schema === "zugfolge-livemap-read-model-sqlite/v2", "ReadModel besitzt ein unbekanntes Metadaten-Schema.");
  invariant(metadata.world_id === world.world_id && metadata.infrastructure_release_id === world.infrastructure_release_id, "ReadModel-Metadaten verletzen die Welt- oder Releasebindung.");
  invariant(/^(0|[1-9][0-9]*)$/.test(metadata.service_start_offset_s), "ReadModel-Servicebeginn ist nicht kanonisch.");
  invariant(/^(0|[1-9][0-9]*)$/.test(metadata.repeat_every_s), "ReadModel-Wiederholungsperiode ist nicht kanonisch.");
  return assertNormalizedScheduleTimeContract({
    worldEpoch: metadata.world_epoch,
    serviceDate: metadata.gtfs_service_date,
    timeZone: metadata.time_zone,
    serviceStartOffsetS: Number(metadata.service_start_offset_s),
    repeatEveryS: Number(metadata.repeat_every_s),
  });
}

export async function inspectPublicReadModel(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, header.length, 0);
    invariant(header.toString("binary") === "SQLite format 3\u0000", "ReadModel besitzt keinen SQLite-3-Header.");
  } finally {
    await handle.close();
  }
  const database = new DatabaseSync(path, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    defensive: true,
  });
  try {
    invariant(database.prepare("PRAGMA application_id").get().application_id === LIVEMAP_READ_MODEL_APPLICATION_ID, "ReadModel besitzt eine fremde application_id.");
    invariant(database.prepare("PRAGMA user_version").get().user_version === LIVEMAP_READ_MODEL_USER_VERSION, "ReadModel besitzt eine unbekannte Schema-Version.");
    const schemaObjects = database.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    invariant(schemaObjects.every((entry) => ["table", "index"].includes(entry.type)), "ReadModel enthaelt nicht erlaubte Views oder Trigger.");
    const tables = schemaObjects.filter((entry) => entry.type === "table").map((entry) => entry.name);
    invariant(JSON.stringify(tables.sort()) === JSON.stringify(Object.keys(PUBLIC_READ_MODEL_TABLES).sort()), "ReadModel-Tabellen entsprechen nicht der oeffentlichen Allowlist.");
    for (const [table, expectedColumns] of Object.entries(PUBLIC_READ_MODEL_TABLES)) {
      invariant(!PRIVATE_SCHEMA_NAME.test(table), `Private Tabellenbezeichnung '${table}' ist unzulaessig.`);
      const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name);
      invariant(JSON.stringify(columns) === JSON.stringify(expectedColumns), `Spaltenvertrag von '${table}' stimmt nicht.`);
      invariant(columns.every((column) => !PRIVATE_SCHEMA_NAME.test(column)), `Private Spaltenbezeichnung in '${table}' ist unzulaessig.`);
    }
    const quickCheck = database.prepare("PRAGMA quick_check(1)").get();
    invariant(quickCheck?.quick_check === "ok", "SQLite quick_check ist fehlgeschlagen.");
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    invariant(violations.length === 0, "ReadModel verletzt Fremdschluesselbindungen.");
    const identifierOrphans = database.prepare(`SELECT count(*) AS count FROM station_identifiers AS identifiers
      LEFT JOIN object_details AS details
      ON details.world_id = identifiers.world_id AND details.kind = 'station' AND details.object_id = identifiers.station_id
      WHERE details.object_id IS NULL`).get().count;
    const scheduleOrphans = database.prepare(`SELECT count(*) AS count FROM station_schedule_calls AS calls
      LEFT JOIN object_details AS details
      ON details.world_id = calls.world_id AND details.kind = 'station' AND details.object_id = calls.station_id
      WHERE details.object_id IS NULL`).get().count;
    invariant(identifierOrphans === 0 && scheduleOrphans === 0, "ReadModel enthaelt Stationsbezuege ohne sichtbares Stationsobjekt.");
    const world = database.prepare("SELECT world_id, infrastructure_release_id FROM world_config").get();
    invariant(world !== undefined, "ReadModel besitzt keine Weltkonfiguration.");
    const scheduleTime = readScheduleTimeMetadata(database, world);
    const objectCount = database.prepare("SELECT count(*) AS count FROM object_details").get().count;
    const scheduleCallCount = database.prepare("SELECT count(*) AS count FROM station_schedule_calls").get().count;
    const passengerPlanCount = database.prepare("SELECT count(*) AS count FROM passenger_information").get().count;
    const scheduledStationCount = database.prepare("SELECT count(DISTINCT station_id) AS count FROM station_schedule_calls").get().count;
    return Object.freeze({
      worldId: world.world_id,
      infrastructureReleaseId: world.infrastructure_release_id,
      scheduleTime,
      objectCount,
      scheduleCallCount,
      passengerPlanCount,
      scheduledStationCount,
      quickCheck: "ok",
      applicationId: LIVEMAP_READ_MODEL_APPLICATION_ID,
      userVersion: LIVEMAP_READ_MODEL_USER_VERSION,
    });
  } finally {
    database.close();
  }
}

export async function buildLivemapReadModel(spec, outputPath) {
  const scheduleTime = validateSpec(spec);
  const resolvedOutput = resolve(outputPath);
  await rm(resolvedOutput, { force: true });
  const database = createDatabase(resolvedOutput);
  let build;
  try {
    const metadata = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    metadata.run("schema", "zugfolge-livemap-read-model-sqlite/v2");
    metadata.run("world_id", spec.worldId);
    metadata.run("infrastructure_release_id", spec.infrastructureReleaseId);
    metadata.run("gtfs_service_date", spec.gtfs.serviceDate);
    metadata.run("world_epoch", scheduleTime.worldEpoch);
    metadata.run("time_zone", scheduleTime.timeZone);
    metadata.run("service_start_offset_s", String(scheduleTime.serviceStartOffsetS));
    metadata.run("repeat_every_s", String(scheduleTime.repeatEveryS));
    database.prepare("INSERT INTO world_config (world_id, infrastructure_release_id, config_json) VALUES (?, ?, ?)")
      .run(spec.worldId, spec.infrastructureReleaseId, JSON.stringify(spec.config));

    const stations = await readStationsForMatching(spec.inputDirectory);
    const objects = await ingestObjects(database, spec.inputDirectory, spec.worldId, spec.infrastructureReleaseId);
    const timetable = await withGtfsDirectory(spec.gtfs.archive, (directory) => buildGtfsFoundation(database, directory, spec, stations, scheduleTime));
    database.exec("DROP TABLE gtfs_calls; VACUUM;");
    build = { objects, timetable };
  } finally {
    database.close();
  }

  const inspection = await inspectPublicReadModel(resolvedOutput);
  const file = await stat(resolvedOutput);
  const artifactSha256 = await sha256File(resolvedOutput);
  const report = Object.freeze({
    schema: LIVEMAP_READ_MODEL_REPORT_SCHEMA,
    artifact: { file: basename(resolvedOutput), bytes: file.size, sha256: artifactSha256 },
    binding: { worldId: spec.worldId, infrastructureReleaseId: spec.infrastructureReleaseId },
    objectLayers: build.objects.counts,
    objectKinds: build.objects.countsByKind,
    timetable: build.timetable,
    inspection,
  });
  await writeFile(`${resolvedOutput}.report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export async function buildLivemapReadModelFromSpec(specPath, outputPath) {
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  const base = dirname(resolve(specPath));
  const normalized = {
    ...spec,
    inputDirectory: resolve(base, spec.inputDirectory),
    gtfs: { ...spec.gtfs, archive: resolve(base, spec.gtfs.archive) },
  };
  return buildLivemapReadModel(normalized, outputPath);
}
