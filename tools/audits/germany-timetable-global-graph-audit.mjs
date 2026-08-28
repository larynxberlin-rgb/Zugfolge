import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [specPath] = process.argv.slice(2);
if (!specPath) throw new Error("Aufruf: node germany-timetable-global-graph-audit.mjs SPEC");

const spec = JSON.parse(await readFile(specPath, "utf8"));
const network = JSON.parse(await readFile(spec.operationalNetwork, "utf8")).network;
const resources = network.resources.filter((value) => value.orderable === true && value.qualityClass !== "C");
const endpointStationIds = new Set(resources.flatMap((value) => [value.originStationId, value.destinationStationId]));
const stations = network.stations.filter((value) => endpointStationIds.has(value.stationId));
const byId = new Map(stations.map((value) => [value.stationId, value]));
const minimumLatitudeE7 = Math.min(...stations.map((value) => value.latitudeE7)) - 500_000;
const maximumLatitudeE7 = Math.max(...stations.map((value) => value.latitudeE7)) + 500_000;
const minimumLongitudeE7 = Math.min(...stations.map((value) => value.longitudeE7)) - 800_000;
const maximumLongitudeE7 = Math.max(...stations.map((value) => value.longitudeE7)) + 800_000;
const gridSizeE7 = 100_000;
const stationGrid = new Map();
for (const station of stations) {
  const key = `${Math.floor(station.longitudeE7 / gridSizeE7)}|${Math.floor(station.latitudeE7 / gridSizeE7)}`;
  const values = stationGrid.get(key) ?? [];
  values.push(station);
  stationGrid.set(key, values);
}

const nodeIndex = new Map();
const parent = [];
const rank = [];
function indexFor(node) {
  let index = nodeIndex.get(node);
  if (index !== undefined) return index;
  index = parent.length;
  nodeIndex.set(node, index);
  parent.push(index);
  rank.push(0);
  return index;
}
function find(index) {
  let root = index;
  while (parent[root] !== root) root = parent[root];
  while (parent[index] !== index) {
    const next = parent[index];
    parent[index] = root;
    index = next;
  }
  return root;
}
function union(left, right) {
  let a = find(left);
  let b = find(right);
  if (a === b) return;
  if (rank[a] < rank[b]) [a, b] = [b, a];
  parent[b] = a;
  if (rank[a] === rank[b]) rank[a] += 1;
}

function coordinateE7(coordinate) {
  return { longitudeE7: Math.round(coordinate[0] * 10_000_000), latitudeE7: Math.round(coordinate[1] * 10_000_000) };
}
function squaredDistance(station, coordinate) {
  const longitude = coordinate.longitudeE7 - station.longitudeE7;
  const latitude = coordinate.latitudeE7 - station.latitudeE7;
  return longitude * longitude + latitude * latitude;
}
function candidateStations(coordinates) {
  const result = new Map();
  for (const coordinate of coordinates) {
    const x = Math.floor(coordinate.longitudeE7 / gridSizeE7);
    const y = Math.floor(coordinate.latitudeE7 / gridSizeE7);
    for (let dx = -5; dx <= 5; dx += 1) for (let dy = -5; dy <= 5; dy += 1) {
      for (const station of stationGrid.get(`${x + dx}|${y + dy}`) ?? []) result.set(station.stationId, station);
    }
  }
  return result.values();
}

const nearest = new Map();
let retainedTrackCount = 0;
let retainedLengthMm = 0;
const lines = createInterface({ input: createReadStream(spec.tracks), crlfDelay: Infinity });
for await (let line of lines) {
  if (line.charCodeAt(0) === 0x1e) line = line.slice(1);
  const feature = JSON.parse(line);
  const properties = feature.properties;
  if (properties.orderable !== true) continue;
  const coordinates = feature.geometry?.coordinates?.map(coordinateE7);
  if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
  const minimumLongitude = Math.min(...coordinates.map((value) => value.longitudeE7));
  const maximumLongitude = Math.max(...coordinates.map((value) => value.longitudeE7));
  const minimumLatitude = Math.min(...coordinates.map((value) => value.latitudeE7));
  const maximumLatitude = Math.max(...coordinates.map((value) => value.latitudeE7));
  if (maximumLongitude < minimumLongitudeE7 || minimumLongitude > maximumLongitudeE7 || maximumLatitude < minimumLatitudeE7 || minimumLatitude > maximumLatitudeE7) continue;
  retainedTrackCount += 1;
  retainedLengthMm += properties.length_mm;
  const fromIndex = indexFor(properties.from_osm_node_id);
  const toIndex = indexFor(properties.to_osm_node_id);
  union(fromIndex, toIndex);
  for (const station of candidateStations(coordinates)) {
    let distance = Infinity;
    for (const coordinate of coordinates) distance = Math.min(distance, squaredDistance(station, coordinate));
    const current = nearest.get(station.stationId);
    if (current === undefined || distance < current.distance || (distance === current.distance && properties.feature_id < current.edgeId)) {
      nearest.set(station.stationId, {
        edgeId: properties.feature_id,
        from: properties.from_osm_node_id,
        to: properties.to_osm_node_id,
        distance,
      });
    }
  }
}

const maximumE7 = Math.ceil(2_500 / 0.07);
const failures = { noOrigin: 0, noDestination: 0, tooFarOrigin: 0, tooFarDestination: 0, disconnected: 0 };
const samples = [];
for (const resource of resources) {
  const origin = nearest.get(resource.originStationId);
  const destination = nearest.get(resource.destinationStationId);
  let reason = null;
  if (!origin) reason = "noOrigin";
  else if (!destination) reason = "noDestination";
  else if (origin.distance > maximumE7 * maximumE7) reason = "tooFarOrigin";
  else if (destination.distance > maximumE7 * maximumE7) reason = "tooFarDestination";
  else {
    const originComponents = new Set([origin.from, origin.to].map((node) => find(nodeIndex.get(node))));
    const destinationComponents = new Set([destination.from, destination.to].map((node) => find(nodeIndex.get(node))));
    if (![...originComponents].some((value) => destinationComponents.has(value))) reason = "disconnected";
  }
  if (reason) {
    failures[reason] += 1;
    if (samples.length < 30) samples.push({ resourceId: resource.resourceId, reason, origin, destination });
  }
}

console.log(JSON.stringify({
  stationCount: stations.length,
  resourceCount: resources.length,
  retainedTrackCount,
  retainedLengthMm,
  retainedNodeCount: nodeIndex.size,
  nearestCount: nearest.size,
  failures,
  samples,
}, null, 2));
