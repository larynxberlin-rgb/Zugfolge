import assert from "node:assert/strict";
import test from "node:test";

import { adaptTrassenfinderNetwork } from "./trassenfinder-network-adapter.mjs";

const fixture = {
  id: 7,
  anzeigename: "Jahresfahrplan 2026",
  fahrplanjahr: 2026,
  gueltig_von: "2025-12-14",
  gueltig_bis: "2026-12-12",
  ordnungsrahmen: {
    betriebsstellen: [
      { ds100: "LA", langname: "A", geo_koordinaten: { breite: 51, laenge: 12 }, betriebsstellentypen: ["bahnhof"], elektrifiziert: true, bahnhof: true },
      { ds100: "LB", langname: "B", geo_koordinaten: { breite: 51.1, laenge: 12.1 }, betriebsstellentypen: ["abzweig"], elektrifiziert: false, bahnhof: false },
    ],
    mutter_betriebsstellen: [{ ds100: "LA", langname: "A", geo_koordinaten: { breite: 51, laenge: 12 }, tochterbetriebsstellen: ["LA", "LB"] }],
    streckensegmente: [{ von: "LA", bis: "LB", streckennummer: 6363, von_km: 1.2, bis_km: 2.5 }],
  },
};

test("normalisiert deutschlandweite Betriebsstellen- und Streckenfolge deterministisch", () => {
  const result = adaptTrassenfinderNetwork(fixture);
  assert.equal(result.operatingPoints.length, 2);
  assert.equal(result.routeSegments.length, 1);
  assert.equal(result.routeSegments[0].lengthMm, 1_300_000);
  assert.equal(result.routeSegments[0].orderable, false);
  assert.equal(result.policy.routeSegmentsProveMicroscopicTopology, false);
  assert.deepEqual(result.motherOperatingPoints[0].childRl100, ["LA", "LB"]);
});

test("lehnt unbekannte Endpunkte und andere Fahrplanjahre ab", () => {
  assert.throws(() => adaptTrassenfinderNetwork({ ...fixture, fahrplanjahr: 2027 }), /2026/);
  assert.throws(() => adaptTrassenfinderNetwork({
    ...fixture,
    ordnungsrahmen: { ...fixture.ordnungsrahmen, streckensegmente: [{ ...fixture.ordnungsrahmen.streckensegmente[0], bis: "XX" }] },
  }), /unbekannte Betriebsstelle/);
});

test("bewahrt Nullkilometer-Verbindungen als nicht bestellbare Topologieverbinder", () => {
  const result = adaptTrassenfinderNetwork({
    ...fixture,
    ordnungsrahmen: { ...fixture.ordnungsrahmen, streckensegmente: [{ ...fixture.ordnungsrahmen.streckensegmente[0], bis_km: 1.2 }] },
  });
  assert.equal(result.routeSegments[0].lengthMm, 0);
  assert.equal(result.routeSegments[0].segmentKind, "topology-connector");
  assert.equal(result.routeSegments[0].orderable, false);
});
