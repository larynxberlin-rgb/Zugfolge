import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";

const TOPOLOGY_FILTERS = [
  "n/public_transport=stop_position,platform",
  "n/railway=stop,platform,platform_edge",
  "w/public_transport=platform",
  "w/railway=platform,platform_edge",
  "r/public_transport=stop_area,stop_area_group,platform",
  "r/railway=platform,platform_edge",
];
const RAIL_FILTERS = ["w/railway=rail"];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function increment(record, key, amount = 1) {
  record[key] = (record[key] ?? 0) + amount;
}

function typedId(type, id) {
  return `${type}${id}`;
}

function parseTypedId(value, label) {
  const match = /^([nwr])(\d+)$/u.exec(value);
  invariant(match !== null, `${label} besitzt keine OSM-Typkennung: ${value}.`);
  return { type: match[1], id: match[2], key: value };
}

function field(line, prefix) {
  const token = line.split(" ").find((entry) => entry.startsWith(prefix));
  return token === undefined ? "" : token.slice(prefix.length);
}

function parseTags(line) {
  const encoded = field(line, "T");
  const tags = {};
  if (encoded === "") return tags;
  for (const entry of encoded.split(",")) {
    const separator = entry.indexOf("=");
    invariant(separator > 0, `Ungültiges OPL-Tag: ${entry}.`);
    tags[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return tags;
}

function parseNodeRefs(line) {
  const encoded = field(line, "N");
  if (encoded === "") return [];
  return encoded.split(",").map((entry) => {
    const { type, id } = parseTypedId(entry, "Way-Node");
    invariant(type === "n", `Way referenziert Nicht-Node ${entry}.`);
    return id;
  });
}

function parseMembers(line) {
  const encoded = field(line, "M");
  if (encoded === "") return [];
  return encoded.split(",").map((entry) => {
    const separator = entry.indexOf("@");
    invariant(separator > 0, `Ungültiges OPL-Relationsmitglied: ${entry}.`);
    return { ...parseTypedId(entry.slice(0, separator), "Relationsmitglied"), role: entry.slice(separator + 1) };
  });
}

export function parseOplRecord(line) {
  invariant(typeof line === "string" && line !== "", "Leere OPL-Zeile.");
  const firstToken = line.split(" ", 1)[0];
  const identity = parseTypedId(firstToken, "OPL-Datensatz");
  return {
    ...identity,
    tags: parseTags(line),
    ...(identity.type === "w" ? { nodeIds: parseNodeRefs(line) } : {}),
    ...(identity.type === "r" ? { members: parseMembers(line) } : {}),
  };
}

function isTrainStop(tags) {
  return tags.public_transport === "stop_position" && (tags.train === "yes" || tags.railway === "stop");
}

function isStop(tags) {
  return tags.public_transport === "stop_position" || tags.railway === "stop";
}

function isPlatform(tags) {
  return tags.public_transport === "platform" || tags.railway === "platform" || tags.railway === "platform_edge";
}

function createState() {
  return {
    nodes: new Map(),
    ways: new Map(),
    relations: new Map(),
    stopNodes: new Map(),
    platforms: new Map(),
    stopAreas: [],
    relevantNodeIds: new Set(),
    railMemberships: new Map(),
    counts: {
      topologyRecords: { nodes: 0, ways: 0, relations: 0 },
      stopNodes: 0,
      trainStopNodes: 0,
      platformNodes: 0,
      platformWays: 0,
      platformRelations: 0,
      stopAreaRelations: 0,
      stopAreaGroupRelations: 0,
      railWays: 0,
      railWayNodeReferences: 0,
    },
  };
}

function consumeTopologyRecord(state, record) {
  if (record.type === "n") {
    state.counts.topologyRecords.nodes += 1;
    state.nodes.set(record.id, record);
    if (isStop(record.tags)) {
      state.stopNodes.set(record.id, record);
      state.relevantNodeIds.add(record.id);
    }
    if (isPlatform(record.tags)) state.platforms.set(record.key, { ...record, geometryNodeIds: [record.id] });
    return;
  }
  if (record.type === "w") {
    state.counts.topologyRecords.ways += 1;
    state.ways.set(record.id, record);
    if (isPlatform(record.tags)) {
      state.platforms.set(record.key, { ...record, geometryNodeIds: record.nodeIds });
      for (const nodeId of record.nodeIds) state.relevantNodeIds.add(nodeId);
    }
    return;
  }
  state.counts.topologyRecords.relations += 1;
  state.relations.set(record.id, record);
}

function finishTopology(state) {
  for (const relation of state.relations.values()) {
    if (isPlatform(relation.tags)) {
      const geometryNodeIds = [];
      let missingMemberWays = 0;
      for (const member of relation.members) {
        if (member.type === "n") geometryNodeIds.push(member.id);
        if (member.type === "w") {
          const way = state.ways.get(member.id);
          if (way === undefined) missingMemberWays += 1;
          else geometryNodeIds.push(...way.nodeIds);
        }
      }
      state.platforms.set(relation.key, { ...relation, geometryNodeIds, missingMemberWays });
      for (const nodeId of geometryNodeIds) state.relevantNodeIds.add(nodeId);
    }
    if (relation.tags.public_transport === "stop_area") state.stopAreas.push(relation);
  }
  state.counts.stopNodes = state.stopNodes.size;
  state.counts.trainStopNodes = [...state.stopNodes.values()].filter(({ tags }) => isTrainStop(tags)).length;
  const platformCountField = { n: "platformNodes", w: "platformWays", r: "platformRelations" };
  for (const platform of state.platforms.values()) increment(state.counts, platformCountField[platform.type]);
  state.counts.stopAreaRelations = state.stopAreas.length;
  state.counts.stopAreaGroupRelations = [...state.relations.values()].filter(({ tags }) => tags.public_transport === "stop_area_group").length;
}

function consumeRailRecord(state, record) {
  invariant(record.type === "w" && record.tags.railway === "rail", `Rail-Pass enthält Nicht-Rail-Way ${record.key}.`);
  state.counts.railWays += 1;
  state.counts.railWayNodeReferences += record.nodeIds.length;
  for (const [index, nodeId] of record.nodeIds.entries()) {
    if (!state.relevantNodeIds.has(nodeId)) continue;
    const matches = state.railMemberships.get(nodeId) ?? [];
    matches.push({ wayId: record.id, nodeIndex: index });
    state.railMemberships.set(nodeId, matches);
  }
}

function classifyStopAreaMembers(state, relation) {
  const stopIds = new Set();
  const platformIds = new Set();
  const unknownMembers = [];
  for (const member of relation.members) {
    const stop = member.type === "n" ? state.stopNodes.get(member.id) : undefined;
    const platform = state.platforms.get(member.key);
    if (member.role.startsWith("stop") || stop !== undefined) {
      if (stop !== undefined && isTrainStop(stop.tags)) stopIds.add(stop.id);
      continue;
    }
    if (member.role.startsWith("platform") || platform !== undefined) {
      if (platform !== undefined) platformIds.add(platform.key);
      continue;
    }
    unknownMembers.push(member.key);
  }
  return { stopIds, platformIds, unknownMembers };
}

function summarize(state) {
  const stopAreaComposition = {
    noTrainStop: 0,
    oneTrainStop: 0,
    multipleTrainStops: 0,
    noPlatform: 0,
    onePlatform: 0,
    multiplePlatforms: 0,
    exactlyOnePlatformAndOneTrainStop: 0,
    withUnknownMembers: 0,
  };
  const platformToStops = new Map();
  const platformRelations = new Map();
  const explicitOneToOnePairs = new Map();
  for (const relation of state.stopAreas) {
    const classified = classifyStopAreaMembers(state, relation);
    increment(stopAreaComposition, classified.stopIds.size === 0 ? "noTrainStop" : classified.stopIds.size === 1 ? "oneTrainStop" : "multipleTrainStops");
    increment(stopAreaComposition, classified.platformIds.size === 0 ? "noPlatform" : classified.platformIds.size === 1 ? "onePlatform" : "multiplePlatforms");
    if (classified.platformIds.size === 1 && classified.stopIds.size === 1) {
      stopAreaComposition.exactlyOnePlatformAndOneTrainStop += 1;
      const [platformId] = classified.platformIds;
      const [stopId] = classified.stopIds;
      const pairs = explicitOneToOnePairs.get(platformId) ?? new Set();
      pairs.add(stopId);
      explicitOneToOnePairs.set(platformId, pairs);
    }
    if (classified.unknownMembers.length > 0) stopAreaComposition.withUnknownMembers += 1;
    for (const platformId of classified.platformIds) {
      const stops = platformToStops.get(platformId) ?? new Set();
      for (const stopId of classified.stopIds) stops.add(stopId);
      platformToStops.set(platformId, stops);
      const relationIds = platformRelations.get(platformId) ?? new Set();
      relationIds.add(relation.id);
      platformRelations.set(platformId, relationIds);
    }
  }

  const chains = {
    platformElementsTotal: state.platforms.size,
    platformMembersOfStopArea: platformToStops.size,
    platformWithoutTrainStop: 0,
    platformWithOneTrainStop: 0,
    platformWithMultipleTrainStops: 0,
    platformInMultipleStopAreas: 0,
    platformWithExplicitOneToOneStopAreaPair: 0,
    stopWithoutRailWay: 0,
    stopOnOneRailWay: 0,
    stopOnMultipleRailWays: 0,
    strictPlatformStopRailWayChain: 0,
    strictChainPlatformPoint: 0,
    strictChainPlatformWay: 0,
    strictChainPlatformRelation: 0,
    strictChainWithNoSharedPlatformTrackNode: 0,
    strictChainWithOneSharedPlatformTrackNode: 0,
    strictChainWithTwoOrMoreSharedPlatformTrackNodes: 0,
    strictChainWithExactlyTwoDistinctEndpointNodes: 0,
    strictChainWithRelationGeometryMissingMembers: 0,
  };
  const uniqueStops = new Set([...platformToStops.values()].flatMap((stops) => [...stops]));
  for (const stopId of uniqueStops) {
    const matches = state.railMemberships.get(stopId) ?? [];
    increment(chains, matches.length === 0 ? "stopWithoutRailWay" : matches.length === 1 ? "stopOnOneRailWay" : "stopOnMultipleRailWays");
  }
  for (const [platformId, stops] of platformToStops) {
    const relationIds = platformRelations.get(platformId);
    if (relationIds.size > 1) chains.platformInMultipleStopAreas += 1;
    if (stops.size === 0) {
      chains.platformWithoutTrainStop += 1;
      continue;
    }
    if (stops.size > 1) {
      chains.platformWithMultipleTrainStops += 1;
      continue;
    }
    chains.platformWithOneTrainStop += 1;
    const explicitStops = explicitOneToOnePairs.get(platformId) ?? new Set();
    if (relationIds.size !== 1 || explicitStops.size !== 1) continue;
    chains.platformWithExplicitOneToOneStopAreaPair += 1;
    const [stopId] = explicitStops;
    const railMatches = state.railMemberships.get(stopId) ?? [];
    if (railMatches.length !== 1) continue;
    chains.strictPlatformStopRailWayChain += 1;
    const platform = state.platforms.get(platformId);
    increment(chains, { n: "strictChainPlatformPoint", w: "strictChainPlatformWay", r: "strictChainPlatformRelation" }[platform.type]);
    if (platform.type === "r" && platform.missingMemberWays > 0) chains.strictChainWithRelationGeometryMissingMembers += 1;
    const railWayId = railMatches[0].wayId;
    const sharedNodes = new Map();
    for (const nodeId of new Set(platform.geometryNodeIds)) {
      const match = (state.railMemberships.get(nodeId) ?? []).find(({ wayId }) => wayId === railWayId);
      if (match !== undefined) sharedNodes.set(nodeId, match.nodeIndex);
    }
    if (sharedNodes.size === 0) chains.strictChainWithNoSharedPlatformTrackNode += 1;
    else if (sharedNodes.size === 1) chains.strictChainWithOneSharedPlatformTrackNode += 1;
    else {
      chains.strictChainWithTwoOrMoreSharedPlatformTrackNodes += 1;
      if (sharedNodes.size === 2 && new Set(sharedNodes.values()).size === 2) chains.strictChainWithExactlyTwoDistinctEndpointNodes += 1;
    }
  }
  return { stopAreaComposition, chains };
}

export async function auditOplPasses({ topologyLines, railLines }) {
  const state = createState();
  for await (const line of topologyLines) if (line !== "") consumeTopologyRecord(state, parseOplRecord(line));
  finishTopology(state);
  for await (const line of railLines) if (line !== "") consumeRailRecord(state, parseOplRecord(line));
  return {
    schema: "zugfolge-osm-stop-area-topology-audit/v1",
    policy: {
      platformStopBinding: "explicit shared stop_area relation membership only",
      stopTrackBinding: "stop node ID must occur in railway=rail way node list",
      intervalEndpoints: "at least two platform geometry node IDs must occur in the uniquely bound railway=rail way",
      forbidden: ["distance", "projection", "nearest-neighbor", "name join", "unscoped code join"],
    },
    inventory: state.counts,
    ...summarize(state),
  };
}

async function runOsmiumPass({ pbfPath, filters, onLine, hash }) {
  const child = spawn("wsl.exe", ["osmium", "tags-filter", "-R", "-F", "pbf", "-f", "opl", "-", ...filters], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const input = createReadStream(pbfPath);
  if (hash !== undefined) input.on("data", (chunk) => hash.update(chunk));
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });
  const inputPromise = pipeline(input, child.stdin);
  const outputPromise = (async () => {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) await onLine(line);
  })();
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`osmium-Pass fehlgeschlagen (code=${code}, signal=${signal ?? "none"}): ${stderr.trim()}`));
    });
  });
  await Promise.all([inputPromise, outputPromise, exitPromise]);
}

export async function auditPbfWithWslOsmium(pbfPath) {
  invariant(typeof pbfPath === "string" && pbfPath !== "", "PBF-Pfad fehlt.");
  const metadata = await lstat(pbfPath);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, "PBF muss eine nichtleere reguläre Datei ohne Symlink sein.");
  const state = createState();
  const hash = createHash("sha256");
  await runOsmiumPass({
    pbfPath,
    filters: TOPOLOGY_FILTERS,
    hash,
    onLine(line) {
      if (line !== "") consumeTopologyRecord(state, parseOplRecord(line));
    },
  });
  finishTopology(state);
  await runOsmiumPass({
    pbfPath,
    filters: RAIL_FILTERS,
    onLine(line) {
      if (line !== "") consumeRailRecord(state, parseOplRecord(line));
    },
  });
  return {
    schema: "zugfolge-osm-stop-area-topology-audit/v1",
    policy: {
      platformStopBinding: "explicit shared stop_area relation membership only",
      stopTrackBinding: "stop node ID must occur in railway=rail way node list",
      intervalEndpoints: "at least two platform geometry node IDs must occur in the uniquely bound railway=rail way",
      forbidden: ["distance", "projection", "nearest-neighbor", "name join", "unscoped code join"],
    },
    input: { bytes: metadata.size, sha256: hash.digest("hex"), reader: "WSL osmium tags-filter -R -> OPL stream" },
    inventory: state.counts,
    ...summarize(state),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  const [pbfPath, ...extra] = process.argv.slice(2);
  if (!pbfPath || extra.length > 0) throw new Error("Aufruf: osm-stop-area-topology-audit.mjs germany-ebo.osm.pbf");
  process.stdout.write(`${JSON.stringify(await auditPbfWithWslOsmium(pbfPath), null, 2)}\n`);
}
