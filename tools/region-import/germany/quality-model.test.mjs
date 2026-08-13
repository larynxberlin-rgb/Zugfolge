import assert from "node:assert/strict";
import test from "node:test";

import { QUALITY_DIMENSIONS, buildGermanyInfraCorpus } from "./quality-model.mjs";

const policy = {
  unknownMainlineSpeedKmh: 20,
  unknownServiceSpeedKmh: 10,
  unknownGradientAbsPermille: 40,
};

function report(blocks) {
  return { schema: "zugfolge-pbf-release-report/v1", derivations: { blocks } };
}

function block(edgeId, sourceWayId, lengthMm = 1_000, fromNodeId = edgeId, toNodeId = edgeId + 1) {
  return { edgeId, sourceWayId, lengthMm, fromNodeId, toNodeId, boundarySignalCount: 0 };
}

function feature(id, properties = {}) {
  return { type: "Feature", id: `way/${id}`, geometry: { type: "LineString", coordinates: [[10, 50], [10.01, 50.01]] }, properties: { railway: "rail", ...properties } };
}

test("konservative Regeln schließen fehlende Attribute zu einem spielbaren B-Modell", () => {
  const result = buildGermanyInfraCorpus({ pbfReport: report([block(7, 42)]), wayFeatures: [feature(42)], policy });
  const section = result.corpus.sections[0];
  assert.equal(section.qualityClass, "B");
  assert.equal(section.playable, true);
  assert.deepEqual(section.dimensions.speed.value, { maximumKmh: 20 });
  assert.equal(section.dimensions.speed.state, "assumed");
  assert.deepEqual(section.dimensions.electrification.value, { system: "none" });
  assert.equal(section.dimensions.signalling.value.model, "virtual-fixed-block");
});

test("richtungsbezogene Geschwindigkeit wird konservativ gelesen und kein Freitext erraten", () => {
  const result = buildGermanyInfraCorpus({
    pbfReport: report([block(7, 42), block(8, 43)]),
    wayFeatures: [
      feature(42, { "maxspeed:forward": "160", "maxspeed:backward": "120 km/h", incline: "1.2%" }),
      feature(43, { maxspeed: "signals", incline: "up" }),
    ],
    policy,
  });
  assert.deepEqual(result.corpus.sections[0].dimensions.speed.value, { maximumKmh: 120, directionallyConservative: true });
  assert.deepEqual(result.corpus.sections[0].dimensions.gradient.value, { absolutePermille: 12 });
  assert.equal(result.corpus.sections[1].dimensions.speed.state, "assumed");
  assert.equal(result.corpus.sections[1].dimensions.gradient.state, "assumed");
});

test("OSM-Neigungen mit echtem Promillezeichen werden als Promille und nicht als unbekannt gelesen", () => {
  const result = buildGermanyInfraCorpus({
    pbfReport: report([block(7, 42)]),
    wayFeatures: [feature(42, { incline: "12‰" })],
    policy,
  });
  assert.deepEqual(result.corpus.sections[0].dimensions.gradient.value, { absolutePermille: 12 });
  assert.equal(result.corpus.sections[0].dimensions.gradient.state, "observed");
});

test("ein ungelöster Topologiefehler bleibt sichtbar, aber Klasse C und nicht spielbar", () => {
  const result = buildGermanyInfraCorpus({ pbfReport: report([block(7, 42, 200, 9, 9)]), wayFeatures: [feature(42)], policy });
  const section = result.corpus.sections[0];
  assert.equal(section.qualityClass, "C");
  assert.equal(section.visible, true);
  assert.equal(section.playable, false);
  assert.equal(section.dimensions.topology.state, "missing");
  assert.deepEqual(result.qualityReport.byClassLengthMm, { A: 0, B: 0, C: 200 });
  assert.deepEqual(result.qualityReport.degradationCauses.find(({ cause }) => cause === "topology:missing"), {
    cause: "topology:missing", sectionCount: 1, lengthMm: 200,
  });
});

test("Klasse A erfordert einen akzeptierten Beleg für jede Pflichtdimension", () => {
  const receipt = {
    receiptId: "validation-de-edge-7-v1",
    status: "accepted",
    edgeId: 7,
    classAEligible: true,
    validatedDimensions: QUALITY_DIMENSIONS,
  };
  const result = buildGermanyInfraCorpus({ pbfReport: report([block(7, 42)]), wayFeatures: [feature(42)], validationReceipts: [receipt], policy });
  assert.equal(result.corpus.sections[0].qualityClass, "A");
  assert.deepEqual(result.qualityReport.byClassLengthMm, { A: 1_000, B: 0, C: 0 });
  assert.equal(result.internalEvidenceBindings.bindings[0].receiptIds[0], receipt.receiptId);
  assert.equal(JSON.stringify(result.corpus).includes(receipt.receiptId), false);
});

test("ein interner APN-Beleg verbessert das Modell, kann aber allein kein A erzeugen", () => {
  const receipt = {
    receiptId: "internal-station-plan-edge-7-v1",
    status: "accepted",
    edgeId: 7,
    classAEligible: false,
    validatedDimensions: QUALITY_DIMENSIONS,
  };
  const result = buildGermanyInfraCorpus({ pbfReport: report([block(7, 42)]), wayFeatures: [feature(42)], validationReceipts: [receipt], policy });
  assert.equal(result.corpus.sections[0].qualityClass, "B");
  assert.ok(QUALITY_DIMENSIONS.every((dimension) => result.corpus.sections[0].dimensions[dimension].state === "observed"));
});

test("Sortierung und Hash sind unabhängig von der Eingabereihenfolge", () => {
  const one = buildGermanyInfraCorpus({ pbfReport: report([block(9, 44), block(7, 42)]), wayFeatures: [feature(44), feature(42)], policy });
  const two = buildGermanyInfraCorpus({ pbfReport: report([block(7, 42), block(9, 44)]), wayFeatures: [feature(42), feature(44)], policy });
  assert.equal(one.corpusHash, two.corpusHash);
  assert.deepEqual(one.corpus.sections.map(({ sectionId }) => sectionId), ["de-edge-7", "de-edge-9"]);
});
