import assert from "node:assert/strict";
import { test } from "node:test";

import { compileServiceScope } from "./service-scope.mjs";

const specification = {
  schema: "zugfolge-gtfs-service-scope/v1",
  allowedRouteTypes: ["2"],
  includedAgencyIds: ["regional"],
  excludedAgencies: [{ agencyId: "fern", category: "long-distance", reason: "SPFV ist nicht Teil von M14.1." }],
};

test("nur explizit zugelassener Schienenregionalverkehr wird uebernommen", () => {
  const scope = compileServiceScope(specification);
  assert.deepEqual(scope.decide({ agency_id: "regional", route_type: "2" }), {
    included: true,
    category: "spnv",
    reason: "Betreiber und Verkehrsmittel sind im versionierten EBO-SPNV-Scope zugelassen.",
  });
  assert.equal(scope.decide({ agency_id: "regional", route_type: "3" }).category, "non-rail");
  assert.equal(scope.decide({ agency_id: "fern", route_type: "2" }).category, "long-distance");
  assert.equal(scope.decide({ agency_id: "neu", route_type: "2" }).category, "unclassified-agency");
  assert.equal(scope.decide(undefined).category, "missing-route");
});

test("widerspruechliche Betreiberklassifikation wird abgewiesen", () => {
  assert.throws(() => compileServiceScope({
    ...specification,
    excludedAgencies: [{ agencyId: "regional", category: "x", reason: "x" }],
  }), /widerspruechlich/);
});

