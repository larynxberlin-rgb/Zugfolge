import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeterministicTrackRouter,
  OFF_TARGET_ROUTE_COST_MULTIPLIER,
  routeBetweenTrackAnchors,
} from "./deterministic-track-router.mjs";

function edge(edgeId, fromNodeId, toNodeId, lengthMm, routeNumber) {
  return { edgeId, fromNodeId, toNodeId, lengthMm, routeNumber };
}

test("beachtet Richtungsfreigaben auf direkten, ersten, mittleren und letzten Teilkanten", () => {
  const graph = [edge("a", 1, 2, 1000, "r"), edge("b", 2, 3, 1000, "r"), edge("c", 3, 4, 1000, "r")];
  const options = { allowedDirectionsByEdge: new Map(graph.map((track) => [track.edgeId, ["along"]])) };
  const router = createDeterministicTrackRouter(graph, options);
  assert.notEqual(router.route({ origins: [{ edgeId: "a", offsetMm: 500 }], destinations: [{ edgeId: "c", offsetMm: 500 }], targetRouteNumber: "r" }), null);
  assert.equal(router.route({ origins: [{ edgeId: "c", offsetMm: 500 }], destinations: [{ edgeId: "a", offsetMm: 500 }], targetRouteNumber: "r" }), null);
  assert.equal(router.route({ origins: [{ edgeId: "b", offsetMm: 900 }], destinations: [{ edgeId: "b", offsetMm: 100 }], targetRouteNumber: "r" }), null);
  const middleClosed = createDeterministicTrackRouter(graph, { allowedDirectionsByEdge: new Map([["b", []]]) });
  assert.equal(middleClosed.route({ origins: [{ edgeId: "a", offsetMm: 500 }], destinations: [{ edgeId: "c", offsetMm: 500 }], targetRouteNumber: "r" }), null);
});

test("findet einen lueckenlosen Mehrkantenpfad und darf eine reale Fremdstrecke benutzen", () => {
  const edges = new Map([
    ["a", edge("a", 1, 2, 1_000, "100")],
    ["b", edge("b", 2, 3, 2_000, null)],
    ["c", edge("c", 3, 4, 3_000, "100")],
  ]);
  const result = createDeterministicTrackRouter(edges).route({
    origins: [{ edgeId: "a", offsetMm: 0 }],
    destinations: [{ edgeId: "c", offsetMm: 3_000 }],
    targetRouteNumber: "100",
  });
  assert.deepEqual(result.legs, [
    { edgeId: "a", direction: "along", edgeEntryMm: 0, edgeExitMm: 1_000 },
    { edgeId: "b", direction: "along", edgeEntryMm: 0, edgeExitMm: 2_000 },
    { edgeId: "c", direction: "along", edgeEntryMm: 0, edgeExitMm: 3_000 },
  ]);
  assert.equal(result.totalLengthMm, 6_000);
  assert.equal(result.offTargetRouteLengthMm, 2_000);
  assert.equal(result.weightedCostMm, 1_000 + 2_000 * OFF_TARGET_ROUTE_COST_MULTIPLIER + 3_000);
});

test("bevorzugt die Ziel-Streckennummer ohne kuerzere reale Alternativen hart auszuschliessen", () => {
  const edges = [
    edge("origin", 0, 1, 100, "100"),
    edge("target-a", 1, 2, 1_000, "100"),
    edge("target-b", 2, 4, 1_000, "100"),
    edge("foreign-a", 1, 3, 300, "200"),
    edge("foreign-b", 3, 4, 300, "200"),
    edge("destination", 4, 5, 100, "100"),
  ];
  const result = routeBetweenTrackAnchors({
    edges,
    origins: [{ edgeId: "origin", offsetMm: 100 }],
    destinations: [{ edgeId: "destination", offsetMm: 0 }],
    targetRouteNumber: "100",
  });
  assert.deepEqual(result.legs.map(({ edgeId }) => edgeId), ["target-a", "target-b"]);
  assert.equal(result.totalLengthMm, 2_000);
  assert.equal(result.offTargetRouteLengthMm, 0);
});

test("vermeidet unplausible Zielstrecken-Umwege trotz etwas laengerem Connector", () => {
  const edges = [
    edge("origin", 0, 1, 100, "100"),
    edge("short-connector", 1, 2, 100, null),
    edge("long-target-tail", 2, 4, 5_000, "100"),
    edge("long-connector", 1, 3, 200, null),
    edge("short-target-tail", 3, 4, 100, "100"),
    edge("destination", 4, 5, 100, "100"),
  ];
  const result = routeBetweenTrackAnchors({
    edges,
    origins: [{ edgeId: "origin", offsetMm: 100 }],
    destinations: [{ edgeId: "destination", offsetMm: 0 }],
    targetRouteNumber: "100",
  });
  assert.deepEqual(result.legs.map(({ edgeId }) => edgeId), ["long-connector", "short-target-tail"]);
  assert.equal(result.offTargetRouteLengthMm, 200);
  assert.equal(result.totalLengthMm, 300);
});

test("erhaelt Teilkantenoffsets und waehlt aus mehreren Ankern den besten", () => {
  const router = createDeterministicTrackRouter([
    edge("a", "n1", "n2", 1_000, 10),
    edge("b", "n2", "n3", 1_500, 10),
    edge("c", "n3", "n4", 800, 10),
  ]);
  const result = router.route({
    origins: [{ edgeId: "a", offsetMm: 100 }, { edgeId: "a", offsetMm: 700 }],
    destinations: [{ edgeId: "c", offsetMm: 600 }, { edgeId: "c", offsetMm: 200 }],
    targetRouteNumber: "10",
  });
  assert.deepEqual(result.origin, { edgeId: "a", offsetMm: 700 });
  assert.deepEqual(result.destination, { edgeId: "c", offsetMm: 200 });
  assert.deepEqual(result.legs, [
    { edgeId: "a", direction: "along", edgeEntryMm: 700, edgeExitMm: 1_000 },
    { edgeId: "b", direction: "along", edgeEntryMm: 0, edgeExitMm: 1_500 },
    { edgeId: "c", direction: "along", edgeEntryMm: 0, edgeExitMm: 200 },
  ]);
  assert.equal(result.totalLengthMm, 2_000);
});

test("liefert bei getrennten Komponenten null", () => {
  const router = createDeterministicTrackRouter([
    edge("left", 1, 2, 1_000, "1"),
    edge("right", 3, 4, 1_000, "1"),
  ]);
  assert.equal(router.route({
    origins: [{ edgeId: "left", offsetMm: 500 }],
    destinations: [{ edgeId: "right", offsetMm: 500 }],
    targetRouteNumber: "1",
  }), null);
});

test("Map-, Kanten- und Ankerreihenfolge aendern den kanonischen Gleichstand nicht", () => {
  const records = [
    edge("origin", 0, 1, 100, "7"),
    edge("branch-a-1", 1, 2, 500, "7"),
    edge("branch-a-2", 2, 4, 500, "7"),
    edge("branch-b-1", 1, 3, 500, "7"),
    edge("branch-b-2", 3, 4, 500, "7"),
    edge("destination-a", 4, 5, 100, "7"),
    edge("destination-b", 4, 6, 100, "7"),
  ];
  const request = {
    origins: [{ edgeId: "origin", offsetMm: 100 }, { edgeId: "origin", offsetMm: 100 }],
    destinations: [{ edgeId: "destination-b", offsetMm: 0 }, { edgeId: "destination-a", offsetMm: 0 }],
    targetRouteNumber: "7",
  };
  const first = createDeterministicTrackRouter(new Map(records.map((record) => [record.edgeId, record]))).route(request);
  const second = createDeterministicTrackRouter(new Map([...records].reverse().map((record) => [record.edgeId, record]))).route({
    ...request,
    origins: [...request.origins].reverse(),
    destinations: [...request.destinations].reverse(),
  });
  assert.deepEqual(second, first);
  assert.deepEqual(first.destination, { edgeId: "destination-a", offsetMm: 0 });
  assert.deepEqual(first.legs.map(({ edgeId }) => edgeId), ["branch-a-1", "branch-a-2"]);
});

test("weist unbekannte Anker, ungueltige Offsets und doppelte Kanten strikt zurueck", () => {
  const router = createDeterministicTrackRouter([edge("a", 1, 2, 1_000, "1")]);
  assert.throws(() => router.route({ origins: [{ edgeId: "missing", offsetMm: 0 }], destinations: [{ edgeId: "a", offsetMm: 0 }], targetRouteNumber: "1" }), /unbekannte Kante/u);
  assert.throws(() => router.route({ origins: [{ edgeId: "a", offsetMm: 1_001 }], destinations: [{ edgeId: "a", offsetMm: 0 }], targetRouteNumber: "1" }), /ausserhalb/u);
  assert.throws(() => createDeterministicTrackRouter([
    edge("a", 1, 2, 1_000, "1"),
    edge("a", 2, 3, 1_000, "1"),
  ]), /Doppelte edgeId/u);
  assert.throws(() => router.route({ origins: [{ edgeId: "a", offsetMm: 0 }], destinations: [{ edgeId: "a", offsetMm: 1_000 }], targetRouteNumber: null }), /targetRouteNumber/u);
});
