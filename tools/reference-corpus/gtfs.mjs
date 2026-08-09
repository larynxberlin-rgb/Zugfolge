// zugfolge:quelle=gtfs-de-rv
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  activeGtfsServiceIds,
  gtfsLocalMidnightEpochSeconds,
  gtfsServiceSeconds,
  parseGtfsCsv,
} from "@zugfolge/gtfs";

import { canonicalJson, sha256 } from "./reference-corpus.mjs";

export const GTFS_CAPTURE_SCHEMA = "zugfolge-gtfs-capture/v1";
const REQUIRED_FILES = ["agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt"];
const OPTIONAL_FILES = ["calendar.txt", "calendar_dates.txt", "feed_info.txt", "frequencies.txt"];
const execFileAsync = promisify(execFile);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value, name) {
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
}

export const parseCsv = parseGtfsCsv;

function stationStopIds(stops, exactNames) {
  const parents = new Set(stops.filter((stop) => exactNames.includes(stop.stop_name)).map((stop) => stop.stop_id));
  const result = new Set(parents);
  for (const stop of stops) if (parents.has(stop.parent_station)) result.add(stop.stop_id);
  return result;
}

function routeMatches(route, comparison) {
  return (
    (!comparison.routeIds || comparison.routeIds.includes(route.route_id)) &&
    (!comparison.routeShortNames || comparison.routeShortNames.includes(route.route_short_name))
  );
}

function formatServiceDate(serviceDate) {
  return `${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6, 8)}`;
}

/**
 * Bildet GTFS-Sollfahrten auf eine explizit geprüfte Zugcharakteristik ab.
 * Weder route_type noch route_short_name erraten Fahrzeugwerte.
 */
export function normalizeGtfsTables(tables, config) {
  invariant(Array.isArray(config.serviceDates) && config.serviceDates.length > 0, "serviceDates fehlt.");
  invariant(Array.isArray(config.comparisons) && config.comparisons.length > 0, "comparisons fehlt.");
  const routes = new Map(tables.routes.map((route) => [route.route_id, route]));
  const trips = new Map(tables.trips.map((trip) => [trip.trip_id, trip]));
  const stopNames = new Map(tables.stops.map((stop) => [stop.stop_id, stop.stop_name]));
  const timesByTrip = new Map();
  for (const stopTime of tables.stopTimes) {
    const values = timesByTrip.get(stopTime.trip_id) ?? [];
    values.push(stopTime);
    timesByTrip.set(stopTime.trip_id, values);
  }
  for (const values of timesByTrip.values()) values.sort((left, right) => Number(left.stop_sequence) - Number(right.stop_sequence));

  const observations = [];
  for (const comparison of config.comparisons) {
    nonEmpty(comparison.characteristicsId, "comparisons[].characteristicsId");
    const fromIds = stationStopIds(tables.stops, comparison.fromStopNames);
    const toIds = stationStopIds(tables.stops, comparison.toStopNames);
    invariant(fromIds.size > 0, `${comparison.routeId}: Startstation wurde im GTFS-Feed nicht gefunden.`);
    invariant(toIds.size > 0, `${comparison.routeId}: Zielstation wurde im GTFS-Feed nicht gefunden.`);
    for (const serviceDate of config.serviceDates) {
      const active = activeGtfsServiceIds(tables, serviceDate);
      const midnight = gtfsLocalMidnightEpochSeconds(serviceDate, config.timeZone);
      for (const [tripId, trip] of trips) {
        if (!active.has(trip.service_id)) continue;
        const route = routes.get(trip.route_id);
        if (!route || !routeMatches(route, comparison)) continue;
        const stopTimes = timesByTrip.get(tripId) ?? [];
        const fromIndex = stopTimes.findIndex((time) => fromIds.has(time.stop_id));
        if (fromIndex < 0) continue;
        const relativeToIndex = stopTimes.slice(fromIndex + 1).findIndex((time) => toIds.has(time.stop_id));
        if (relativeToIndex < 0) continue;
        const toIndex = fromIndex + 1 + relativeToIndex;
        const origin = stopTimes[fromIndex];
        const destination = stopTimes[toIndex];
        if (!origin.departure_time || !destination.arrival_time) continue;
        const stopPattern = stopTimes
          .slice(fromIndex, toIndex + 1)
          .map((time) => stopNames.get(time.stop_id) ?? time.stop_id)
          .join("|");
        if (comparison.stopPattern && stopPattern !== comparison.stopPattern) continue;
        const departure = midnight + gtfsServiceSeconds(origin.departure_time);
        const arrival = midnight + gtfsServiceSeconds(destination.arrival_time);
        if (arrival <= departure) continue;
        observations.push({
          sourceId: "gtfs-de-rv",
          tripId: `${tripId}:${serviceDate}`,
          serviceDate: formatServiceDate(serviceDate),
          routeId: comparison.routeId,
          fromEva: [...fromIds].sort().join("+"),
          toEva: [...toIds].sort().join("+"),
          direction: trip.trip_headsign || comparison.direction,
          stopPattern,
          characteristicsId: comparison.characteristicsId,
          trainCategory: route.route_short_name || route.route_long_name,
          trainNumber: trip.trip_short_name || route.route_short_name || tripId,
          plannedDepartureEpochSeconds: departure,
          plannedArrivalEpochSeconds: arrival,
        });
      }
    }
  }
  const unique = new Map(observations.map((observation) => [observation.tripId + observation.routeId, observation]));
  return [...unique.values()].sort((left, right) =>
    left.routeId.localeCompare(right.routeId) ||
    left.plannedDepartureEpochSeconds - right.plannedDepartureEpochSeconds ||
    left.tripId.localeCompare(right.tripId),
  );
}

async function listZipEntries(zipPath) {
  const result = await execFileAsync("unzip", ["-Z1", zipPath], { maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

export async function captureGtfsFeed(config, options) {
  invariant(config.schema === GTFS_CAPTURE_SCHEMA, `config.schema muss '${GTFS_CAPTURE_SCHEMA}' sein.`);
  nonEmpty(config.feedUrl, "feedUrl");
  const response = await options.fetchImpl(config.feedUrl, { headers: { Accept: "application/zip" } });
  invariant(response.ok, `GTFS-Download antwortet mit ${response.status}.`);
  const payload = Buffer.from(await response.arrayBuffer());
  invariant(payload.length > 0, "GTFS-ZIP ist leer.");
  await mkdir(options.outputDirectory, { recursive: true });
  const zipPath = path.join(options.outputDirectory, "feed.zip");
  await writeFile(zipPath, payload);
  const entries = await (options.listEntries ?? listZipEntries)(zipPath);
  invariant(entries.every((entry) => !path.isAbsolute(entry) && !entry.split(/[\\/]/).includes("..")), "GTFS-ZIP enthält einen unsicheren Pfad.");
  for (const required of REQUIRED_FILES) invariant(entries.includes(required), `GTFS-ZIP enthält '${required}' nicht.`);
  await (options.extract ?? (async (file, directory) => {
    await execFileAsync("unzip", ["-oq", file, "-d", directory]);
  }))(zipPath, options.outputDirectory);
  const files = [];
  for (const file of [...REQUIRED_FILES, ...OPTIONAL_FILES].filter((candidate) => entries.includes(candidate))) {
    const content = await readFile(path.join(options.outputDirectory, file));
    files.push({ path: file, sha256: sha256(content), bytes: content.length });
  }
  const manifest = {
    schema: GTFS_CAPTURE_SCHEMA,
    capturedAt: options.capturedAt ?? config.source.retrievedAt ?? new Date().toISOString(),
    feedUrl: config.feedUrl,
    archiveSha256: sha256(payload),
    archiveBytes: payload.length,
    configSha256: sha256(canonicalJson(config)),
    source: config.source,
    files,
  };
  return { manifest, manifestSha256: sha256(canonicalJson(manifest)) };
}

async function readTable(rootDirectory, manifest, file, optional = false) {
  const record = manifest.files.find((candidate) => candidate.path === file);
  if (!record && optional) return [];
  invariant(record, `Capture-Manifest enthält '${file}' nicht.`);
  const content = await readFile(path.join(rootDirectory, file), "utf8");
  invariant(sha256(content) === record.sha256, `GTFS-Dateihash stimmt nicht: ${file}`);
  return parseCsv(content);
}

export async function loadCapturedGtfsTables(config, manifest, rootDirectory) {
  invariant(manifest.schema === GTFS_CAPTURE_SCHEMA, "Unbekanntes GTFS-Capture-Manifest.");
  invariant(manifest.configSha256 === sha256(canonicalJson(config)), "GTFS-Capture und Konfiguration gehören nicht zusammen.");
  const tables = {
    agency: await readTable(rootDirectory, manifest, "agency.txt"),
    stops: await readTable(rootDirectory, manifest, "stops.txt"),
    routes: await readTable(rootDirectory, manifest, "routes.txt"),
    trips: await readTable(rootDirectory, manifest, "trips.txt"),
    stopTimes: await readTable(rootDirectory, manifest, "stop_times.txt"),
    calendar: await readTable(rootDirectory, manifest, "calendar.txt", true),
    calendarDates: await readTable(rootDirectory, manifest, "calendar_dates.txt", true),
    frequencies: await readTable(rootDirectory, manifest, "frequencies.txt", true),
  };
  invariant(tables.calendar.length > 0 || tables.calendarDates.length > 0, "GTFS-Feed enthält weder calendar.txt noch calendar_dates.txt.");
  return tables;
}

export async function normalizeCapturedGtfs(config, manifest, rootDirectory) {
  return normalizeGtfsTables(await loadCapturedGtfsTables(config, manifest, rootDirectory), config);
}
