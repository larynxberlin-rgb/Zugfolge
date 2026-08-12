import assert from "node:assert/strict";
import test from "node:test";

import { chooseOfficialMatch, enrichTrackFeature } from "./infrago-spatial-crosswalk.mjs";

function segment(id, overrides = {}) {
  return {
    trackSegmentId: `db-infrago:track-segment:${id}`,
    routeNumber: 1234,
    direction: { kind: "route-axis", sourceValue: "Streckenachse" },
    fromKilometre: { label: "1,0 + 0", millimetres: 1_000_000 },
    toKilometre: { label: "1,1 + 0", millimetres: 1_100_000 },
    routeName: "Fixture",
    speed: { status: "known", maximumKmh: 120 },
    electrification: { kind: "overhead-line" },
    trackCount: { status: "known", count: 1 },
    construction: { status: "not-declared" },
    dbOperation: { status: "operated-by-db-infrago" },
    ...overrides,
  };
}

function candidate(id, coordinates, overrides = {}) {
  const projected = coordinates.map(([longitude, latitude]) => {
    const radius = 6_378_137;
    const lat = latitude * Math.PI / 180;
    return [radius * longitude * Math.PI / 180, radius * Math.log(Math.tan(Math.PI / 4 + lat / 2))];
  });
  return {
    segment: segment(id, overrides),
    lines: [projected],
    bbox: {
      minX: Math.min(...projected.map(([x]) => x)),
      minY: Math.min(...projected.map(([, y]) => y)),
      maxX: Math.max(...projected.map(([x]) => x)),
      maxY: Math.max(...projected.map(([, y]) => y)),
    },
  };
}

function feature(ref = "1234", latitudeOffset = 0) {
  return {
    type: "Feature",
    properties: {
      feature_id: "track:fixture",
      quality_class: "B",
      osm_tags_json: JSON.stringify({ railway: "rail", ref }),
      length_mm: 100_000,
      speed_forward_kmh: 20,
      speed_backward_kmh: 160,
      speed_forward_model: "conservative_default",
      speed_backward_model: "observed_osm_common",
      model_state: "observed_osm_topology_with_conservative_defaults",
    },
    geometry: { type: "LineString", coordinates: [[10, 50 + latitudeOffset], [10.001, 50 + latitudeOffset]] },
  };
}

test("verknüpft nur gemeinsame VzG-Nummer, räumliche Lage und Richtung", () => {
  const official = new Map([[1234, [candidate(1, [[10, 50], [10.001, 50]])]]]);
  const match = chooseOfficialMatch(feature(), official);
  assert.equal(match.status, "matched");
  assert.equal(match.segment.trackSegmentId, "db-infrago:track-segment:1");
  assert.ok(match.maximumDistanceMm < 10);
  assert.equal(chooseOfficialMatch(feature("9999"), official).reason, "route-not-in-official-source");
  assert.equal(chooseOfficialMatch(feature("1234", 0.01), official).reason, "route-geometry-too-far-or-crossing");
});

test("wendet bei widersprüchlicher paralleler Evidenz keinen Beleg an", () => {
  const values = [
    candidate(1, [[10, 50], [10.001, 50]], { speed: { status: "known", maximumKmh: 120 } }),
    candidate(2, [[10, 50.000005], [10.001, 50.000005]], { speed: { status: "known", maximumKmh: 80 } }),
  ];
  const match = chooseOfficialMatch(feature(), new Map([[1234, values]]));
  assert.equal(match.status, "unmatched");
  assert.equal(match.reason, "ambiguous-parallel-official-evidence");
});

test("ignoriert degenerierte amtliche Teilsegmente ohne abzustürzen", () => {
  const degenerate = candidate(1, [[10, 50], [10, 50]]);
  const match = chooseOfficialMatch(feature(), new Map([[1234, [degenerate]]]));
  assert.equal(match.status, "unmatched");
  assert.equal(match.reason, "route-geometry-too-far-or-crossing");
});

test("ersetzt nur Defaults und begrenzt beobachtete Konflikte konservativ", () => {
  const selected = {
    status: "matched",
    segment: segment(1),
    meanDistanceMm: 0,
    maximumDistanceMm: 0,
    directionCosineMillionths: 1_000_000,
  };
  const enriched = enrichTrackFeature(feature(), selected);
  assert.equal(enriched.properties.speed_forward_kmh, 120);
  assert.equal(enriched.properties.speed_forward_model, "observed_official_section");
  assert.equal(enriched.properties.speed_backward_kmh, 120);
  assert.equal(enriched.properties.speed_backward_model, "conservative_min_osm_and_official");
  assert.equal(enriched.properties.official_evidence_id, "db-infrago:track-segment:1");
  assert.equal(enriched.properties.quality_class, "B");
});
