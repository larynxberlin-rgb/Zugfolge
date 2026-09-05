import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { canonicalPlanningJson } from "../../packages/gtfs/dist/index.js";
import { buildGtfsTrackGraph, GTFS_SIMULATED_ROUTE_KEY } from "./germany/operational-track-graph.mjs";
import { createDeterministicTrackRouter } from "./germany/deterministic-track-router.mjs";

async function fingerprint(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { file: basename(path), bytes, sha256: hash.digest("hex") };
}

/**
 * Der reale Binnen-Trackgraph wird vor dem endgültigen Snapshot ausgewertet.
 * Nicht erreichbare Nachbarhalte trennen Linien; fehlende Gleisanker entfernen
 * den betreffenden Halt einschließlich seiner beiden Übergänge.
 */
export async function refineGameTimetableTrips({ trips, preliminarySnapshot, networkBindingPath }) {
  const binding = JSON.parse(await readFile(networkBindingPath, "utf8"));
  if (binding?.schemaVersion !== "zugfolge-game-timetable-network-binding/v1"
    || Object.keys(binding).sort().join() !== ["schemaVersion", "tracksPath", "corridorsPath", "terminalCatalogPath", "permittedProtectionModes"].sort().join()
    || typeof binding.tracksPath !== "string" || binding.tracksPath.trim() === ""
    || typeof binding.corridorsPath !== "string" || binding.corridorsPath.trim() === ""
    || typeof binding.terminalCatalogPath !== "string" || binding.terminalCatalogPath.trim() === ""
    || !Array.isArray(binding.permittedProtectionModes) || binding.permittedProtectionModes.length === 0) {
    throw new Error("Netzbindung braucht Schema, Gleise, amtliche Korridore und freigegebene Zugsicherungssysteme.");
  }
  const tracksPath = resolve(dirname(networkBindingPath), binding.tracksPath);
  const corridorsPath = resolve(dirname(networkBindingPath), binding.corridorsPath);
  const terminalCatalogPath = resolve(dirname(networkBindingPath), binding.terminalCatalogPath);
  const terminalCatalog = JSON.parse(await readFile(terminalCatalogPath, "utf8"));
  if (terminalCatalog?.schemaVersion !== "zugfolge-game-timetable-terminals/v1" || typeof terminalCatalog.sourceId !== "string" || terminalCatalog.sourceId.trim() === "" || !Array.isArray(terminalCatalog.terminals)) throw new Error("Netzbindung besitzt keinen versionierten Betriebspunktkatalog fuer Linienenden.");
  const terminals = new Map();
  for (const terminal of terminalCatalog.terminals) {
    if (typeof terminal?.stopId !== "string" || terminal.stopId.trim() === "" || terminals.has(terminal.stopId)
      || !["station", "halt", "unknown"].includes(terminal.kind) || typeof terminal.canTurn !== "boolean"
      || typeof terminal.evidenceId !== "string" || terminal.evidenceId.trim() === "") throw new Error("Betriebspunktkatalog enthaelt einen unvollstaendigen oder doppelten Endpunktbeleg.");
    terminals.set(terminal.stopId, { kind: terminal.kind, canTurn: terminal.canTurn, evidenceId: terminal.evidenceId });
  }
  const graph = await buildGtfsTrackGraph({ snapshot: preliminarySnapshot, tracksPath, corridorsPath, permittedProtectionModes: binding.permittedProtectionModes, allowUnmappedStops: true });
  const router = graph.edges.size === 0 ? null : createDeterministicTrackRouter(new Map([...graph.edges].map(([id, edge]) => [id, {
    edgeId: id, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId, lengthMm: edge.lengthMm, routeNumber: edge.routeNumber,
  }])), { allowedDirectionsByEdge: new Map([...graph.edges].map(([id, edge]) => [id, edge.allowedDirections])) });
  const unmappedStops = new Set();
  const disconnectedPairs = new Set();
  const resultsByPattern = new Map();
  const connections = new Map();
  const anchor = ({ edgeId, offsetMm }) => ({ edgeId, offsetMm });
  const keyOf = (anchors) => canonicalPlanningJson(anchors.map(anchor).sort((a, b) => a.edgeId.localeCompare(b.edgeId) || a.offsetMm - b.offsetMm));
  const reachableDestinations = (origins, destinations) => {
    if (router === null || origins.length === 0 || destinations.length === 0) return [];
    const key = `${keyOf(origins)}:${keyOf(destinations)}`;
    if (connections.has(key)) return connections.get(key);
    const reachable = destinations.filter((destination) => {
      const different = origins.filter((origin) => origin.edgeId !== destination.edgeId || origin.offsetMm !== destination.offsetMm);
      if (different.length === 0) return false;
      const route = router.route({ origins: different.map(anchor), destinations: [anchor(destination)], targetRouteNumber: GTFS_SIMULATED_ROUTE_KEY });
      return route !== null && route.legs.length > 0;
    });
    connections.set(key, reachable);
    return reachable;
  };
  const refinedTrips = trips.map((trip) => {
    const key = canonicalPlanningJson(trip.stops.map((stop) => [stop.stopId, stop.inRegion, stop.pathToNextInRegion ?? null]));
    let flags = resultsByPattern.get(key);
    if (flags === undefined) {
      flags = trip.stops.map((stop) => {
        const mapped = (graph.anchors.get(stop.stopId)?.length ?? 0) > 0;
        if (stop.inRegion && !mapped) unmappedStops.add(stop.stopId);
        return { inRegion: stop.inRegion && mapped, pathToNextInRegion: stop.pathToNextInRegion };
      });
      let reachable = null;
      for (let index = 0; index < trip.stops.length - 1; index += 1) {
        if (!flags[index].inRegion || !flags[index + 1].inRegion || flags[index].pathToNextInRegion === false) {
          reachable = null;
          continue;
        }
        const current = trip.stops[index];
        const next = trip.stops[index + 1];
        reachable ??= graph.anchors.get(current.stopId) ?? [];
        const destinations = reachableDestinations(reachable, graph.anchors.get(next.stopId) ?? []);
        if (destinations.length === 0) {
          flags[index].pathToNextInRegion = false;
          disconnectedPairs.add(`${current.stopId}->${next.stopId}`);
          reachable = null;
        } else reachable = destinations;
      }
      resultsByPattern.set(key, flags);
    }
    return { ...trip, stops: trip.stops.map((stop, index) => ({ ...stop, ...flags[index], terminalEligibility: terminals.get(stop.stopId) ?? terminals.get(stop.nodeId) ?? { kind: "unknown", canTurn: false, evidenceId: "" } })) };
  });
  const [tracks, corridors, terminalCatalogFingerprint] = await Promise.all([fingerprint(tracksPath), fingerprint(corridorsPath), fingerprint(terminalCatalogPath)]);
  return {
    trips: refinedTrips,
    networkReference: {
      schemaVersion: "zugfolge-game-timetable-network-reference/v1",
      rule: "directed-contiguous-playable-track-sections/v1",
      tracks, corridors,
      terminalCatalog: { ...terminalCatalogFingerprint, sourceId: terminalCatalog.sourceId },
      permittedProtectionModes: [...binding.permittedProtectionModes].sort(),
    },
    metrics: { infrastructureUnmappedStopCount: unmappedStops.size, infrastructureDisconnectedPairCount: disconnectedPairs.size },
  };
}
