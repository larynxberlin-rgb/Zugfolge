import assert from "node:assert/strict";
import test from "node:test";
import { buildIndependentValidationSet } from "./validation-set.mjs";

function fixtures() {
  return {
    operationalNetwork: {
      networkHash: "a".repeat(64),
      network: {
        regionId: "test-region",
        timetableYear: 2026,
        matchingRadiusMm: 2_500_000,
        stations: [{ stationId: "A" }, { stationId: "B" }],
        resources: [{ resourceId: "r1", originStationId: "A", destinationStationId: "B", lengthMm: 1_000, qualityClass: "B", orderable: true }],
        gtfsStationMappings: [{ stopId: "s1", stationId: "A", distanceMm: 10, qualityClass: "B" }],
        segmentQualifications: [{ segmentId: "p1", qualityClass: "B", orderable: true, resourceIds: ["r1"], missingEvidence: [] }],
      },
    },
    pbfReport: {
      eboFilter: { checksum: "b".repeat(64) },
      derivations: {
        blocks: [{ blockId: "b1", lengthMm: 1_000, qualityClass: "B", orderable: true }],
        interlockingRoutes: [{ routeId: "i1", originEdgeId: 1, destinationEdgeId: 2, conflictEdgeIds: [1, 2], qualityClass: "B", orderable: true }],
      },
    },
    gtfsSnapshot: {
      snapshotHash: "c".repeat(64),
      snapshot: { segments: [{ segmentId: "p1", orderable: true }] },
    },
  };
}

test("der technische Holdout ist deterministisch und kalibrierungsfrei", () => {
  const first = buildIndependentValidationSet(fixtures());
  const second = buildIndependentValidationSet(fixtures());
  assert.deepEqual(first, second);
  assert.equal(first.artifact.selection.calibrationDataUsed, false);
  assert.equal(first.artifact.result, "passed");
});

test("Klasse C kann im Holdout niemals bestellbar sein", () => {
  const input = fixtures();
  input.pbfReport.derivations.blocks = Array.from({ length: 100 }, (_, index) => ({
    blockId: `block-${index}`,
    lengthMm: 1_000,
    qualityClass: "C",
    orderable: true,
  }));
  const validation = buildIndependentValidationSet(input);
  assert.equal(validation.artifact.result, "failed");
  assert.match(validation.artifact.failures[0].message, /Klasse C/);
});
