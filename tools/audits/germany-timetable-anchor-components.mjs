import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { projectOperationalResourcesToTracks } from "../tiles/train-map-projection.mjs";
import {
  anchorsForResource,
  buildOperationalTrackGraph,
} from "../region-import/germany/operational-track-graph.mjs";

const [specificationPath, root = "."] = process.argv.slice(2);
if (!specificationPath) throw new Error("Aufruf: germany-timetable-anchor-components.mjs SPECIFICATION.json [ROOT]");
const base = resolve(root);
const specification = JSON.parse(await readFile(resolve(base, specificationPath), "utf8"));
const envelope = JSON.parse(await readFile(resolve(base, specification.operationalNetwork), "utf8"));
const network = envelope.network;
const projection = await projectOperationalResourcesToTracks({
  network,
  tracksPath: resolve(base, specification.tracks),
  corridorsPath: resolve(base, specification.corridors),
});
const graph = await buildOperationalTrackGraph({
  network,
  tracksPath: resolve(base, specification.tracks),
  corridorsPath: resolve(base, specification.corridors),
  strictProjection: projection,
});

const parent = new Map();
function find(value) {
  const previous = parent.get(value);
  if (previous === undefined) {
    parent.set(value, value);
    return value;
  }
  if (previous === value) return value;
  const root = find(previous);
  parent.set(value, root);
  return root;
}
function union(left, right) {
  const a = find(left);
  const b = find(right);
  if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
}
for (const edge of graph.edges.values()) union(edge.fromNodeId, edge.toNodeId);

function anchorComponents(anchor) {
  const edge = graph.edges.get(anchor.edgeId);
  return [...new Set([find(edge.fromNodeId), find(edge.toNodeId)])].sort((left, right) => left - right);
}

const samples = [];
const coincident = [];
for (const resource of [...graph.resources].sort((left, right) => left.resourceId.localeCompare(right.resourceId))) {
  const anchors = anchorsForResource(graph, resource);
  const origins = anchors.origins.map((anchor) => ({
    edgeId: anchor.edgeId,
    offsetMm: anchor.offsetMm,
    rank: anchor.rank,
    distanceMm: anchor.distanceMm,
    provenance: anchor.provenance,
    components: anchorComponents(anchor),
  }));
  const destinations = anchors.destinations.map((anchor) => ({
    edgeId: anchor.edgeId,
    offsetMm: anchor.offsetMm,
    rank: anchor.rank,
    distanceMm: anchor.distanceMm,
    provenance: anchor.provenance,
    components: anchorComponents(anchor),
  }));
  const originComponents = new Set(origins.flatMap((anchor) => anchor.components));
  const sharedComponents = [...new Set(destinations.flatMap((anchor) => anchor.components))]
    .filter((component) => originComponents.has(component));
  const canonicalShared = origins[0].components.some((component) => destinations[0].components.includes(component));
  if (origins[0].edgeId === destinations[0].edgeId && origins[0].offsetMm === destinations[0].offsetMm) {
    coincident.push({ resourceId: resource.resourceId, sharedComponents, origins, destinations });
  }
  if (!canonicalShared) samples.push({ resourceId: resource.resourceId, sharedComponents, origins, destinations });
}

process.stdout.write(`${JSON.stringify({
  retainedTrackCount: graph.edges.size,
  resourceCount: graph.resources.length,
  canonicalDisconnectedCount: samples.length,
  canonicalCoincidentCount: coincident.length,
  coincident,
  samples,
}, null, 2)}\n`);
