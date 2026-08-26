import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [specPath] = process.argv.slice(2);
if (!specPath) throw new Error("Aufruf: node germany-timetable-route-graph-audit.mjs SPEC");

const spec = JSON.parse(await readFile(specPath, "utf8"));
const network = JSON.parse(await readFile(spec.operationalNetwork, "utf8")).network;
const resources = network.resources.filter((value) => value.orderable === true && value.qualityClass !== "C");
const routeNumbers = new Set(resources.map((value) => value.routeNumber));
const stationIdsByRoute = new Map();
for (const resource of resources) {
  const ids = stationIdsByRoute.get(resource.routeNumber) ?? new Set();
  ids.add(resource.originStationId);
  ids.add(resource.destinationStationId);
  stationIdsByRoute.set(resource.routeNumber, ids);
}
const stations = new Map(network.stations.map((value) => [value.stationId, value]));
const edgesByRoute = new Map();
const nodesByRoute = new Map();
const nearest = new Map();
let relevant = 0;

function squaredDistance(station, coordinate) {
  const longitude = Math.round(coordinate[0] * 10_000_000) - station.longitudeE7;
  const latitude = Math.round(coordinate[1] * 10_000_000) - station.latitudeE7;
  return longitude * longitude + latitude * latitude;
}

const lines = createInterface({ input: createReadStream(spec.tracks), crlfDelay: Infinity });
for await (let line of lines) {
  if (line.charCodeAt(0) === 0x1e) line = line.slice(1);
  const feature = JSON.parse(line);
  const properties = feature.properties;
  const routeNumber = properties.official_route_number;
  if (!routeNumbers.has(routeNumber) || properties.orderable !== true) continue;
  relevant += 1;
  const edges = edgesByRoute.get(routeNumber) ?? [];
  edges.push({ id: properties.feature_id, from: properties.from_osm_node_id, to: properties.to_osm_node_id });
  edgesByRoute.set(routeNumber, edges);
  const nodes = nodesByRoute.get(routeNumber) ?? new Map();
  for (const node of [properties.from_osm_node_id, properties.to_osm_node_id]) {
    const values = nodes.get(node) ?? [];
    values.push(properties.feature_id);
    nodes.set(node, values);
  }
  nodesByRoute.set(routeNumber, nodes);
  for (const stationId of stationIdsByRoute.get(routeNumber) ?? []) {
    const station = stations.get(stationId);
    if (!Number.isSafeInteger(station?.latitudeE7) || !Number.isSafeInteger(station?.longitudeE7)) continue;
    const coordinates = feature.geometry?.coordinates;
    if (!Array.isArray(coordinates)) continue;
    let distance = Infinity;
    for (const coordinate of coordinates) distance = Math.min(distance, squaredDistance(station, coordinate));
    const key = `${routeNumber}|${stationId}`;
    const current = nearest.get(key);
    if (current === undefined || distance < current.distance || (distance === current.distance && properties.feature_id < current.edgeId)) {
      nearest.set(key, { edgeId: properties.feature_id, distance });
    }
  }
}

const componentByRouteNode = new Map();
for (const [routeNumber, nodes] of nodesByRoute) {
  let component = 0;
  const seen = new Set();
  for (const start of [...nodes.keys()].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    component += 1;
    const pending = [start];
    seen.add(start);
    while (pending.length > 0) {
      const node = pending.pop();
      componentByRouteNode.set(`${routeNumber}|${node}`, component);
      for (const edgeId of nodes.get(node) ?? []) {
        const edge = edgesByRoute.get(routeNumber).find((candidate) => candidate.id === edgeId);
        const other = edge.from === node ? edge.to : edge.from;
        if (!seen.has(other)) {
          seen.add(other);
          pending.push(other);
        }
      }
    }
  }
}

const globalNodes = new Map();
for (const edges of edgesByRoute.values()) for (const edge of edges) {
  for (const node of [edge.from, edge.to]) {
    const values = globalNodes.get(node) ?? [];
    values.push(edge);
    globalNodes.set(node, values);
  }
}
const globalComponentByNode = new Map();
let globalComponent = 0;
for (const start of [...globalNodes.keys()].sort((a, b) => a - b)) {
  if (globalComponentByNode.has(start)) continue;
  globalComponent += 1;
  const pending = [start];
  globalComponentByNode.set(start, globalComponent);
  while (pending.length > 0) {
    const node = pending.pop();
    for (const edge of globalNodes.get(node) ?? []) {
      const other = edge.from === node ? edge.to : edge.from;
      if (!globalComponentByNode.has(other)) {
        globalComponentByNode.set(other, globalComponent);
        pending.push(other);
      }
    }
  }
}

const maximumE7 = Math.ceil(2_500 / 0.07);
const failures = { noOrigin: 0, noDestination: 0, tooFarOrigin: 0, tooFarDestination: 0, disconnected: 0 };
const globalFailures = { noOrigin: 0, noDestination: 0, tooFarOrigin: 0, tooFarDestination: 0, disconnected: 0 };
const samples = [];
for (const resource of resources) {
  const origin = nearest.get(`${resource.routeNumber}|${resource.originStationId}`);
  const destination = nearest.get(`${resource.routeNumber}|${resource.destinationStationId}`);
  let reason = null;
  if (!origin) reason = "noOrigin";
  else if (!destination) reason = "noDestination";
  else if (origin.distance > maximumE7 * maximumE7) reason = "tooFarOrigin";
  else if (destination.distance > maximumE7 * maximumE7) reason = "tooFarDestination";
  else {
    const originEdge = edgesByRoute.get(resource.routeNumber).find((value) => value.id === origin.edgeId);
    const destinationEdge = edgesByRoute.get(resource.routeNumber).find((value) => value.id === destination.edgeId);
    const originComponents = new Set([originEdge.from, originEdge.to].map((node) => componentByRouteNode.get(`${resource.routeNumber}|${node}`)));
    const destinationComponents = new Set([destinationEdge.from, destinationEdge.to].map((node) => componentByRouteNode.get(`${resource.routeNumber}|${node}`)));
    if (![...originComponents].some((value) => destinationComponents.has(value))) reason = "disconnected";
  }
  if (reason) {
    failures[reason] += 1;
    if (samples.length < 30) samples.push({ resourceId: resource.resourceId, reason, origin, destination });
  }
  let globalReason = null;
  if (!origin) globalReason = "noOrigin";
  else if (!destination) globalReason = "noDestination";
  else if (origin.distance > maximumE7 * maximumE7) globalReason = "tooFarOrigin";
  else if (destination.distance > maximumE7 * maximumE7) globalReason = "tooFarDestination";
  else {
    const originEdge = edgesByRoute.get(resource.routeNumber).find((value) => value.id === origin.edgeId);
    const destinationEdge = edgesByRoute.get(resource.routeNumber).find((value) => value.id === destination.edgeId);
    const originComponents = new Set([originEdge.from, originEdge.to].map((node) => globalComponentByNode.get(node)));
    const destinationComponents = new Set([destinationEdge.from, destinationEdge.to].map((node) => globalComponentByNode.get(node)));
    if (![...originComponents].some((value) => destinationComponents.has(value))) globalReason = "disconnected";
  }
  if (globalReason) globalFailures[globalReason] += 1;
}

console.log(JSON.stringify({
  relevantTrackCount: relevant,
  routeCount: edgesByRoute.size,
  resourceCount: resources.length,
  nearestCount: nearest.size,
  failures,
  globalFailures,
  samples,
}, null, 2));
