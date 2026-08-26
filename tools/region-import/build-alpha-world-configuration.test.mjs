import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { alphaCanonicalJson } from "../../packages/alpha/dist/index.js";
import { deriveAlphaWorldBuildConfiguration } from "./build-alpha-world-configuration.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function wrapper() {
  const release = {
    schema: "zugfolge-infra-release/v2",
    releaseId: "infra-deutschland-2026.3",
    artifacts: [{
      id: "operational-infrastructure-deutschland-2026.3",
      kind: "operational-infrastructure-v2",
      infraReleaseId: "infra-deutschland-2026.3",
      file: "operational-infrastructure-v2.json",
      bytes: 1_234,
      sha256: SHA_A,
      stateHash: SHA_B,
    }],
    quality: {
      operationalClosure: {
        operationalQualityEligible: true,
        unresolvedRequired: 0,
        timetableRouteEvidence: {
          routesBytes: 84,
          routesSha256: SHA_A,
          routeSetSha256: SHA_A,
          routeRecordCount: 4,
          completeRouteCount: 4,
        },
      },
    },
  };
  return { release, releaseHash: createHash("sha256").update(alphaCanonicalJson(release)).digest("hex") };
}

function identity() {
  return {
    schemaVersion: "zugfolge-alpha-world-identity/v1",
    worldId: "0db56535-a466-44a8-a991-38a8a1f7566c",
    regionId: "mitteldeutschland-b",
    regionVariant: "B",
    operatorId: "public",
    seed: "2026082501",
    fleetReleaseId: "fleet-alpha-mitteldeutschland-b-2026.3",
    planningAuthority: { accountId: "9158446f-70be-46ce-bbfa-7b4cf56215ff", displayName: "Aufgabentraeger" },
  };
}

test("Jahreskonfiguration wird ausschliesslich aus Identitaet und signierter v2-Evidenz abgeleitet", () => {
  const result = deriveAlphaWorldBuildConfiguration(identity(), wrapper());
  assert.equal(result.schemaVersion, "zugfolge-alpha-world-build-configuration/v2");
  assert.deepEqual(result.operationalInfrastructure, { file: "operational-infrastructure-v2.json", bytes: 1_234, sha256: SHA_A, stateHash: SHA_B });
  assert.deepEqual(result.timetableRoutes, { file: "timetable-routes-v2.jsonseq", bytes: 84, sha256: SHA_A });
  assert.equal(result.worldId, identity().worldId);
});

test("offene Operational-Qualitaet und auseinanderlaufende Routenhashes blockieren die Konfiguration", () => {
  const blocked = wrapper();
  blocked.release.quality.operationalClosure.unresolvedRequired = 1;
  blocked.releaseHash = createHash("sha256").update(alphaCanonicalJson(blocked.release)).digest("hex");
  assert.throws(() => deriveAlphaWorldBuildConfiguration(identity(), blocked), /keine geschlossene/u);
  const foreign = wrapper();
  foreign.release.quality.operationalClosure.timetableRouteEvidence.routeSetSha256 = "c".repeat(64);
  foreign.releaseHash = createHash("sha256").update(alphaCanonicalJson(foreign.release)).digest("hex");
  assert.throws(() => deriveAlphaWorldBuildConfiguration(identity(), foreign), /keine geschlossene/u);
});
