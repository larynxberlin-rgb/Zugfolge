import assert from "node:assert/strict";
import test from "node:test";

import { classifyMapFeature } from "./map-layers.mjs";

const line = { type: "Feature", geometry: { type: "LineString", coordinates: [[11, 51], [12, 51]] } };

test("uebernimmt ausschliesslich regelspurige EBO-Linien in den Netzlayer", () => {
  assert.equal(classifyMapFeature({ ...line, properties: { railway: "rail", gauge: "1435", maxspeed: "160", electrified: "contact_line", usage: "main" } }).layer, "rail");
  assert.equal(classifyMapFeature({ ...line, properties: { railway: "tram", gauge: "1435" } }).layer, "context");
  assert.equal(classifyMapFeature({ ...line, properties: { railway: "rail", gauge: "1000" } }).layer, "context");
  assert.equal(classifyMapFeature({ ...line, properties: { railway: "rail", electrified: "rail" } }).layer, "context");
});

test("markiert unvollstaendige EBO-Geometrie sichtbar, aber nicht bestellbar", () => {
  const result = classifyMapFeature({ ...line, properties: { railway: "rail" } });
  assert.equal(result.feature.properties.qualityClass, "C");
  assert.equal(result.feature.properties.orderable, false);
});
