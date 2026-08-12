import assert from "node:assert/strict";
import test from "node:test";

import { buildOperationalNetwork } from "./operational-network.mjs";

const boundary = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[10, 50], [13, 50], [13, 52], [10, 52], [10, 50]]] },
  }],
};
const masterData = {
  id: 7,
  fahrplanjahr: 2026,
  gueltig_von: "2025-12-14",
  gueltig_bis: "2026-12-12",
  ordnungsrahmen: {
    betriebsstellen: [
      { ds100: "AAA", langname: "A", geo_koordinaten: { breite: 51, laenge: 11 }, elektrifiziert: true, bahnhof: true },
      { ds100: "BBB", langname: "B", geo_koordinaten: { breite: 51, laenge: 12 }, elektrifiziert: true, bahnhof: true },
    ],
    streckensegmente: [
      { von: "AAA", bis: "BBB", streckennummer: 1, von_km: 1, bis_km: 2 },
      { von: "BBB", bis: "AAA", streckennummer: 1, von_km: 2, bis_km: 1 },
    ],
  },
};
const gtfsSnapshot = {
  regionId: "test",
  stations: [
    { stopId: "a", latitudeE7: 510000000, longitudeE7: 110000000 },
    { stopId: "b", latitudeE7: 510000000, longitudeE7: 120000000 },
    { stopId: "outside", latitudeE7: 540000000, longitudeE7: 150000000 },
  ],
  segments: [
    { segmentId: "ok", journeyChainId: "chain-ok", orderable: true, stops: [{ stopId: "a" }, { stopId: "b" }] },
    { segmentId: "missing", journeyChainId: "chain-c", orderable: true, stops: [{ stopId: "a" }, { stopId: "outside" }] },
  ],
  journeyChains: [
    { journeyChainId: "chain-ok", legs: [{ kind: "playable", legId: "ok" }] },
    { journeyChainId: "chain-c", legs: [{ kind: "playable", legId: "missing" }] },
  ],
};

test("qualifiziert nur vollstaendig abgebildete Fahrtketten als bestellbar", () => {
  const result = buildOperationalNetwork({ masterData, gtfsSnapshot, regionBoundary: boundary });
  assert.equal(result.network.metrics.orderableJourneyChainCount, 1);
  assert.deepEqual(result.network.segmentQualifications.map(({ segmentId, qualityClass, orderable }) => ({ segmentId, qualityClass, orderable })), [
    { segmentId: "missing", qualityClass: "C", orderable: false },
    { segmentId: "ok", qualityClass: "B", orderable: true },
  ]);
  assert.equal(result.network.resources[0].lengthMm, 1_000_000);
  assert.match(result.networkHash, /^[a-f0-9]{64}$/);
});

test("liefert bei gleicher Eingabe denselben Hash", () => {
  const first = buildOperationalNetwork({ masterData, gtfsSnapshot, regionBoundary: boundary });
  const second = buildOperationalNetwork({ masterData, gtfsSnapshot, regionBoundary: boundary });
  assert.deepEqual(second, first);
});
