export const OFF_TARGET_ROUTE_COST_MULTIPLIER = 8;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, name) {
  invariant(isRecord(value), `${name} muss ein Objekt sein.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${name} besitzt unbekannte oder fehlende Felder.`);
}

function nonEmptyString(value, name) {
  invariant(typeof value === "string" && value.trim() === value && value !== "", `${name} muss eine nichtleere, randfreie Zeichenkette sein.`);
  return value;
}

function safeInteger(value, name) {
  invariant(Number.isSafeInteger(value), `${name} muss eine sichere Ganzzahl sein.`);
  return value;
}

function nodeKey(value, name) {
  if (typeof value === "string") return `s:${nonEmptyString(value, name)}`;
  if (typeof value === "number") return `n:${safeInteger(value, name)}`;
  throw new Error(`${name} muss eine nichtleere Zeichenkette oder sichere Ganzzahl sein.`);
}

function routeNumberKey(value, name, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value === "string") return nonEmptyString(value, name);
  if (typeof value === "number") return String(safeInteger(value, name));
  throw new Error(`${name} muss eine nichtleere Zeichenkette oder sichere Ganzzahl sein.`);
}

function lexical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function checkedAdd(left, right, name) {
  const sum = left + right;
  invariant(Number.isSafeInteger(sum), `${name} ueberschreitet sichere Ganzzahlen.`);
  return sum;
}

function normalizeEdges(edges) {
  invariant(edges !== null && edges !== undefined && typeof edges[Symbol.iterator] === "function", "edges muss eine Map oder ein Iterable sein.");
  const records = [];
  if (edges instanceof Map) {
    for (const [mapKey, value] of edges) {
      exactKeys(value, ["edgeId", "fromNodeId", "toNodeId", "lengthMm", "routeNumber"], `Kante ${String(mapKey)}`);
      invariant(mapKey === value.edgeId, `Map-Key und edgeId der Kante ${String(mapKey)} stimmen nicht ueberein.`);
      records.push(value);
    }
  } else {
    for (const value of edges) records.push(value);
  }
  invariant(records.length > 0, "Der Gleisgraph darf nicht leer sein.");
  const normalized = records.map((value, index) => {
    exactKeys(value, ["edgeId", "fromNodeId", "toNodeId", "lengthMm", "routeNumber"], `edges[${index}]`);
    const edgeId = nonEmptyString(value.edgeId, `edges[${index}].edgeId`);
    const lengthMm = safeInteger(value.lengthMm, `Kante ${edgeId}.lengthMm`);
    invariant(lengthMm > 0, `Kante ${edgeId}.lengthMm muss positiv sein.`);
    return Object.freeze({
      edgeId,
      fromNodeId: value.fromNodeId,
      toNodeId: value.toNodeId,
      fromNodeKey: nodeKey(value.fromNodeId, `Kante ${edgeId}.fromNodeId`),
      toNodeKey: nodeKey(value.toNodeId, `Kante ${edgeId}.toNodeId`),
      lengthMm,
      routeNumber: value.routeNumber,
      routeNumberKey: routeNumberKey(value.routeNumber, `Kante ${edgeId}.routeNumber`, { nullable: true }),
    });
  });
  normalized.sort((left, right) => lexical(left.edgeId, right.edgeId));
  for (let index = 1; index < normalized.length; index += 1) {
    invariant(normalized[index - 1].edgeId !== normalized[index].edgeId, `Doppelte edgeId ${normalized[index].edgeId}.`);
  }
  return normalized;
}

function makeLeg(edge, edgeEntryMm, edgeExitMm) {
  if (edgeEntryMm === edgeExitMm) return null;
  return Object.freeze({
    edgeId: edge.edgeId,
    direction: edgeExitMm > edgeEntryMm ? "along" : "against",
    edgeEntryMm,
    edgeExitMm,
  });
}

function legToken(leg) {
  return leg === null ? "" : `${leg.edgeId}\u0000${leg.direction}\u0000${String(leg.edgeEntryMm).padStart(16, "0")}\u0000${String(leg.edgeExitMm).padStart(16, "0")}`;
}

function segmentCost(edge, lengthMm, targetRouteNumberKey) {
  const matchesTarget = edge.routeNumberKey === targetRouteNumberKey;
  const weightedCostMm = matchesTarget ? lengthMm : checkedAdd(lengthMm, lengthMm * (OFF_TARGET_ROUTE_COST_MULTIPLIER - 1), "Gewichtete Routenkosten");
  invariant(Number.isSafeInteger(weightedCostMm), "Gewichtete Routenkosten ueberschreiten sichere Ganzzahlen.");
  return {
    weightedCostMm,
    offTargetRouteLengthMm: matchesTarget ? 0 : lengthMm,
    totalLengthMm: lengthMm,
  };
}

function addCost(left, right) {
  return {
    weightedCostMm: checkedAdd(left.weightedCostMm, right.weightedCostMm, "Gewichtete Routenkosten"),
    offTargetRouteLengthMm: checkedAdd(left.offTargetRouteLengthMm, right.offTargetRouteLengthMm, "Streckenfremde Laenge"),
    totalLengthMm: checkedAdd(left.totalLengthMm, right.totalLengthMm, "Laufweglaenge"),
  };
}

function normalizeAnchors(anchors, name, edgeById) {
  invariant(Array.isArray(anchors) && anchors.length > 0, `${name} muss ein nichtleeres Array sein.`);
  const normalized = anchors.map((anchor, index) => {
    exactKeys(anchor, ["edgeId", "offsetMm"], `${name}[${index}]`);
    const edgeId = nonEmptyString(anchor.edgeId, `${name}[${index}].edgeId`);
    const edge = edgeById.get(edgeId);
    invariant(edge !== undefined, `${name}[${index}] verweist auf unbekannte Kante ${edgeId}.`);
    const offsetMm = safeInteger(anchor.offsetMm, `${name}[${index}].offsetMm`);
    invariant(offsetMm >= 0 && offsetMm <= edge.lengthMm, `${name}[${index}] liegt ausserhalb der Kante ${edgeId}.`);
    return Object.freeze({ edgeId, offsetMm, edge, key: `${edgeId}\u0000${String(offsetMm).padStart(16, "0")}` });
  });
  normalized.sort((left, right) => lexical(left.key, right.key));
  return normalized.filter((anchor, index) => index === 0 || anchor.key !== normalized[index - 1].key);
}

class MinHeap {
  #values = [];

  constructor(compare) {
    this.compare = compare;
  }

  get size() {
    return this.#values.length;
  }

  peek() {
    return this.#values[0];
  }

  push(value) {
    const values = this.#values;
    values.push(value);
    let index = values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(values[parent], value) <= 0) break;
      values[index] = values[parent];
      index = parent;
    }
    values[index] = value;
  }

  pop() {
    const values = this.#values;
    invariant(values.length > 0, "Leere Prioritaetswarteschlange.");
    const first = values[0];
    const last = values.pop();
    if (values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= values.length) break;
      const right = left + 1;
      let child = right < values.length && this.compare(values[right], values[left]) < 0 ? right : left;
      if (this.compare(last, values[child]) <= 0) break;
      values[index] = values[child];
      index = child;
    }
    values[index] = last;
    return first;
  }
}

function mergeLegs(legs) {
  const merged = [];
  for (const leg of legs) {
    if (leg === null) continue;
    const previous = merged.at(-1);
    if (previous !== undefined
      && previous.edgeId === leg.edgeId
      && previous.direction === leg.direction
      && previous.edgeExitMm === leg.edgeEntryMm) {
      merged[merged.length - 1] = { ...previous, edgeExitMm: leg.edgeExitMm };
    } else {
      merged.push({ ...leg });
    }
  }
  return merged.map((leg) => Object.freeze(leg));
}

function reconstructLegs(state, suffixLeg) {
  const reversed = [];
  let current = state;
  while (current.previous !== null) {
    reversed.push(current.previous.leg);
    current = current.previous.state;
  }
  reversed.reverse();
  return mergeLegs([current.startLeg, ...reversed, suffixLeg]);
}

function compareCost(left, right) {
  if (left.weightedCostMm !== right.weightedCostMm) return left.weightedCostMm - right.weightedCostMm;
  if (left.offTargetRouteLengthMm !== right.offTargetRouteLengthMm) return left.offTargetRouteLengthMm - right.offTargetRouteLengthMm;
  if (left.totalLengthMm !== right.totalLengthMm) return left.totalLengthMm - right.totalLengthMm;
  return 0;
}

function compareState(left, right) {
  const costOrder = compareCost(left, right);
  if (costOrder !== 0) return costOrder;
  for (const [leftValue, rightValue] of [
    [left.origin.key, right.origin.key],
    [left.startToken, right.startToken],
    [left.predecessorToken, right.predecessorToken],
    [left.nodeKey, right.nodeKey],
  ]) {
    const order = lexical(leftValue, rightValue);
    if (order !== 0) return order;
  }
  return 0;
}

function compareCandidate(left, right) {
  const costOrder = compareCost(left, right);
  if (costOrder !== 0) return costOrder;
  for (const [leftValue, rightValue] of [
    [left.origin.key, right.origin.key],
    [left.destination.key, right.destination.key],
    [left.terminalKey, right.terminalKey],
  ]) {
    const order = lexical(leftValue, rightValue);
    if (order !== 0) return order;
  }
  return 0;
}

function publicAnchor(anchor) {
  return Object.freeze({ edgeId: anchor.edgeId, offsetMm: anchor.offsetMm });
}

function publicResult(candidate, targetRouteNumber) {
  return Object.freeze({
    origin: publicAnchor(candidate.origin),
    destination: publicAnchor(candidate.destination),
    targetRouteNumber,
    legs: Object.freeze(candidate.legs),
    totalLengthMm: candidate.totalLengthMm,
    offTargetRouteLengthMm: candidate.offTargetRouteLengthMm,
    weightedCostMm: candidate.weightedCostMm,
  });
}

/**
 * Baut den validierten Endpunktgraph genau einmal. Jede route()-Abfrage nutzt
 * anschließend nur neue Dijkstra-Zustände; die Adjazenz wird nicht neu erzeugt.
 * Kosten sind konservativ lexikographisch geordnet: zuerst der mit einem
 * Fremdstreckenaufschlag gewichtete Laufweg, danach Fremd- und Gesamtlänge.
 */
export function createDeterministicTrackRouter(edges) {
  const normalizedEdges = normalizeEdges(edges);
  const edgeById = new Map(normalizedEdges.map((edge) => [edge.edgeId, edge]));
  const adjacency = new Map();
  const addTransition = (node, transition) => {
    const existing = adjacency.get(node);
    if (existing === undefined) adjacency.set(node, [transition]);
    else existing.push(transition);
  };
  for (const edge of normalizedEdges) {
    addTransition(edge.fromNodeKey, Object.freeze({
      edge,
      toNodeKey: edge.toNodeKey,
      leg: makeLeg(edge, 0, edge.lengthMm),
      token: `${edge.edgeId}\u0000along\u0000${edge.toNodeKey}`,
    }));
    addTransition(edge.toNodeKey, Object.freeze({
      edge,
      toNodeKey: edge.fromNodeKey,
      leg: makeLeg(edge, edge.lengthMm, 0),
      token: `${edge.edgeId}\u0000against\u0000${edge.fromNodeKey}`,
    }));
  }
  for (const transitions of adjacency.values()) transitions.sort((left, right) => lexical(left.token, right.token));

  const route = ({ origins, destinations, targetRouteNumber }) => {
    const targetKey = routeNumberKey(targetRouteNumber, "targetRouteNumber");
    const normalizedOrigins = normalizeAnchors(origins, "origins", edgeById);
    const normalizedDestinations = normalizeAnchors(destinations, "destinations", edgeById);
    const bestByNode = new Map();
    const finalized = new Set();
    const heap = new MinHeap(compareState);
    let bestCandidate = null;

    const considerCandidate = (candidate) => {
      if (bestCandidate === null || compareCandidate(candidate, bestCandidate) < 0) bestCandidate = candidate;
    };

    for (const origin of normalizedOrigins) {
      for (const destination of normalizedDestinations) {
        if (origin.edgeId !== destination.edgeId) continue;
        const leg = makeLeg(origin.edge, origin.offsetMm, destination.offsetMm);
        const lengthMm = Math.abs(destination.offsetMm - origin.offsetMm);
        const cost = segmentCost(origin.edge, lengthMm, targetKey);
        considerCandidate({ ...cost, origin, destination, terminalKey: `direct\u0000${legToken(leg)}`, legs: mergeLegs([leg]) });
      }
    }

    const seed = (origin, nodeKeyValue, leg) => {
      const lengthMm = leg === null ? 0 : Math.abs(leg.edgeExitMm - leg.edgeEntryMm);
      const cost = segmentCost(origin.edge, lengthMm, targetKey);
      const state = {
        ...cost,
        nodeKey: nodeKeyValue,
        origin,
        startLeg: leg,
        startToken: legToken(leg),
        predecessorToken: "",
        previous: null,
      };
      const current = bestByNode.get(nodeKeyValue);
      if (current === undefined || compareState(state, current) < 0) {
        bestByNode.set(nodeKeyValue, state);
        heap.push(state);
      }
    };
    for (const origin of normalizedOrigins) {
      seed(origin, origin.edge.fromNodeKey, makeLeg(origin.edge, origin.offsetMm, 0));
      seed(origin, origin.edge.toNodeKey, makeLeg(origin.edge, origin.offsetMm, origin.edge.lengthMm));
    }

    const destinationByNode = new Map();
    const addDestination = (destination, nodeKeyValue, leg) => {
      const lengthMm = leg === null ? 0 : Math.abs(leg.edgeExitMm - leg.edgeEntryMm);
      const suffix = { destination, leg, cost: segmentCost(destination.edge, lengthMm, targetKey), token: legToken(leg) };
      const existing = destinationByNode.get(nodeKeyValue);
      if (existing === undefined) destinationByNode.set(nodeKeyValue, [suffix]);
      else existing.push(suffix);
    };
    for (const destination of normalizedDestinations) {
      addDestination(destination, destination.edge.fromNodeKey, makeLeg(destination.edge, 0, destination.offsetMm));
      addDestination(destination, destination.edge.toNodeKey, makeLeg(destination.edge, destination.edge.lengthMm, destination.offsetMm));
    }
    for (const suffixes of destinationByNode.values()) suffixes.sort((left, right) => lexical(`${left.destination.key}\u0000${left.token}`, `${right.destination.key}\u0000${right.token}`));

    while (heap.size > 0) {
      if (bestCandidate !== null && compareCost(heap.peek(), bestCandidate) > 0) break;
      const state = heap.pop();
      if (bestByNode.get(state.nodeKey) !== state || finalized.has(state.nodeKey)) continue;
      finalized.add(state.nodeKey);

      for (const suffix of destinationByNode.get(state.nodeKey) ?? []) {
        const cost = addCost(state, suffix.cost);
        considerCandidate({
          ...cost,
          origin: state.origin,
          destination: suffix.destination,
          terminalKey: `${state.nodeKey}\u0000${suffix.token}`,
          legs: reconstructLegs(state, suffix.leg),
        });
      }

      for (const transition of adjacency.get(state.nodeKey) ?? []) {
        if (finalized.has(transition.toNodeKey)) continue;
        const transitionCost = segmentCost(transition.edge, transition.edge.lengthMm, targetKey);
        const cost = addCost(state, transitionCost);
        const next = {
          ...cost,
          nodeKey: transition.toNodeKey,
          origin: state.origin,
          startLeg: state.startLeg,
          startToken: state.startToken,
          predecessorToken: `${state.nodeKey}\u0000${transition.token}`,
          previous: { state, leg: transition.leg },
        };
        const current = bestByNode.get(next.nodeKey);
        if (current === undefined || compareState(next, current) < 0) {
          bestByNode.set(next.nodeKey, next);
          heap.push(next);
        }
      }
    }

    return bestCandidate === null ? null : publicResult(bestCandidate, targetRouteNumber);
  };

  return Object.freeze({ route });
}

export function routeBetweenTrackAnchors({ edges, origins, destinations, targetRouteNumber }) {
  return createDeterministicTrackRouter(edges).route({ origins, destinations, targetRouteNumber });
}
