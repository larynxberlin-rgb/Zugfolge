import assert from "node:assert/strict";
import test from "node:test";

import { mergeOperatingPointFeatures } from "./operating-point-merge.mjs";

const official = [{
  type: "Feature",
  properties: { feature_id: "operating-point:rl100:LA", feature_type: "operating-point", rl100: "LA", name: "A", model_state: "official", official_coordinate_candidates_json: JSON.stringify([{ longitude: 120000000, latitude: 510000000 }, { longitude: 120500000, latitude: 510500000 }]) },
  geometry: { type: "Point", coordinates: [12, 51] },
}];
const tf = [
  { schema: "zugfolge-trassenfinder-operating-point/v1", operatingPointId: "tf:LA", rl100: "LA", name: "A", coordinateE7: { longitude: 120000010, latitude: 510000010 }, electrified: true, station: true, primaryLocationCode: "DE1" },
  { schema: "zugfolge-trassenfinder-operating-point/v1", operatingPointId: "tf:LB", rl100: "LB", name: "B", coordinateE7: { longitude: 121000000, latitude: 511000000 }, electrified: false, station: false, primaryLocationCode: null },
  { schema: "zugfolge-trassenfinder-operating-point/v1", operatingPointId: "tf:LC", rl100: "LC", name: "C", coordinateE7: null, electrified: false, station: false, primaryLocationCode: null },
];

test("bevorzugt amtliche Geometrie, ergänzt Jahresbeleg und nimmt TF-Lücken auf", () => {
  const result = mergeOperatingPointFeatures(official, tf);
  assert.equal(result.features.length, 2);
  assert.deepEqual(result.features[0].geometry.coordinates, [12, 51]);
  assert.equal(result.features[0].properties.tf_primary_location_code, "DE1");
  assert.equal(result.features[0].properties.official_coordinate_candidate_count, 2);
  assert.equal(result.features[1].properties.rl100, "LB");
  assert.equal(result.report.tfOnlyWithoutCoordinate, 1);
  assert.equal(result.report.coordinateConflictsOver250m, 0);
});
