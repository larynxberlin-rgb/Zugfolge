import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedReleaseForMapPreflight,
  runMapReleaseDeploymentPreflight,
  runtimeIdentityFromEnvironment,
  validateMapPreflightResult,
} from "./map-release-deployment-preflight.mjs";

const evidence = Object.freeze({
  releaseId: "infra-deutschland-2026.2",
  previousReleaseId: "infra-deutschland-2026.1",
});

function result(activeReleaseId, activationState) {
  return {
    releaseId: evidence.releaseId,
    previousReleaseId: evidence.previousReleaseId,
    activeReleaseId,
    activationState,
    activationEligible: true,
    rollbackEligible: true,
  };
}

test("Fresh-Compose verlangt explizit den aktiven .2-Kandidaten", () => {
  const expected = expectedReleaseForMapPreflight(
    evidence,
    "active-candidate",
    "infra-deutschland-2026.2",
  );
  assert.equal(expected, evidence.releaseId);
  assert.equal(
    validateMapPreflightResult(result(expected, "active-candidate"), evidence, "active-candidate", expected).activeReleaseId,
    evidence.releaseId,
  );
  assert.throws(
    () => expectedReleaseForMapPreflight(evidence, "active-candidate", evidence.previousReleaseId),
    /widerspricht dem active-candidate-Vertrag/u,
  );
});

test("manueller Vorlauf akzeptiert ausschliesslich den expliziten .1-Pointer", () => {
  const expected = expectedReleaseForMapPreflight(
    evidence,
    "pre-activation",
    "infra-deutschland-2026.1",
  );
  assert.equal(expected, evidence.previousReleaseId);
  assert.equal(
    validateMapPreflightResult(result(expected, "pre-activation"), evidence, "pre-activation", expected).activeReleaseId,
    evidence.previousReleaseId,
  );
  assert.throws(
    () => expectedReleaseForMapPreflight(evidence, "pre-activation", evidence.releaseId),
    /widerspricht dem pre-activation-Vertrag/u,
  );
});

test("falscher Pointerzustand wird verweigert und aktiver Kandidat meldet fehlendes Rollback ehrlich", () => {
  assert.throws(
    () => validateMapPreflightResult(
      result(evidence.previousReleaseId, "pre-activation"),
      evidence,
      "active-candidate",
      evidence.releaseId,
    ),
    /Pointerzustand/u,
  );
  assert.equal(
    validateMapPreflightResult(
      { ...result(evidence.releaseId, "active-candidate"), rollbackEligible: false, rollbackEligibilityReason: "runtime-tuple-unbound-v1" },
      evidence,
      "active-candidate",
      evidence.releaseId,
    ).rollbackEligible,
    false,
  );
  assert.throws(
    () => validateMapPreflightResult(
      { ...result(evidence.previousReleaseId, "pre-activation"), rollbackEligible: false, rollbackEligibilityReason: "runtime-tuple-unbound-v1" },
      evidence,
      "pre-activation",
      evidence.previousReleaseId,
    ),
    /vollständig gekoppeltes Runtime-Tuple/u,
  );
  assert.throws(
    () => validateMapPreflightResult(
      { ...result(evidence.releaseId, "active-candidate"), rollbackEligible: false },
      evidence,
      "active-candidate",
      evidence.releaseId,
    ),
    /begründet den fehlenden Rollbackstatus/u,
  );
  assert.throws(
    () => expectedReleaseForMapPreflight(evidence, "fallback", evidence.releaseId),
    /pre-activation oder active-candidate/u,
  );
});

test("Serverwrapper liest nur die festen Artefaktpfade und reicht den expliziten .2-Vertrag weiter", async () => {
  const environment = {
    MAP_RELEASE_PREFLIGHT_EVIDENCE_PATH: "/map-preflight/evidence.json",
    MAP_RELEASE_PREFLIGHT_DEPLOYMENT_ROOT: "/map-deployment",
    MAP_RELEASE_PREFLIGHT_RESTORE_PROOF_PATH: "/map-preflight/restore-proof.json",
    MAP_RELEASE_PREFLIGHT_RESTORE_ROOT: "/map-restore",
    MAP_RELEASE_PREFLIGHT_TRUSTED_KEYS_PATH: "/map-preflight/trusted-delivery-keys.json",
    MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID: evidence.releaseId,
  };
  const proof = Buffer.from("canonical restore proof");
  const keys = { "map-delivery-2026": "public-key" };
  let observed;
  const loaded = await runMapReleaseDeploymentPreflight({
    mode: "active-candidate",
    environment,
    async loadEvidence(path) {
      assert.equal(path, environment.MAP_RELEASE_PREFLIGHT_EVIDENCE_PATH);
      return evidence;
    },
    async loadRestoreProof(path) {
      assert.equal(path, environment.MAP_RELEASE_PREFLIGHT_RESTORE_PROOF_PATH);
      return proof;
    },
    async loadTrustedKeys(path) {
      assert.equal(path, environment.MAP_RELEASE_PREFLIGHT_TRUSTED_KEYS_PATH);
      return keys;
    },
    async preflight(argumentsValue) {
      observed = argumentsValue;
      return result(evidence.releaseId, "active-candidate");
    },
  });
  assert.deepEqual(observed, {
    evidence,
    deploymentRoot: environment.MAP_RELEASE_PREFLIGHT_DEPLOYMENT_ROOT,
    restoreProofBytes: proof,
    restoreRoot: environment.MAP_RELEASE_PREFLIGHT_RESTORE_ROOT,
    trustedDeliveryKeys: keys,
    expectedActiveReleaseId: evidence.releaseId,
    runtimeIdentity: undefined,
  });
  assert.equal(loaded.activeReleaseId, evidence.releaseId);
});

test("Rollbackmodus verlangt die vollständige attestierte Runtime-Identität; Kandidat darf sie ehrlich als fehlend melden", () => {
  assert.equal(runtimeIdentityFromEnvironment({}, "active-candidate"), undefined);
  assert.throws(() => runtimeIdentityFromEnvironment({}, "pre-activation"), /vollstaendige Source-\/Image-\/Welt/u);
  assert.throws(() => runtimeIdentityFromEnvironment({
    MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT: "a".repeat(40),
  }, "active-candidate"), /vollstaendige Source-\/Image-\/Welt/u);
  assert.deepEqual(runtimeIdentityFromEnvironment({
    MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT: "a".repeat(40),
    MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH: "/evidence/world.json",
  }, "pre-activation"), {
    sourceCommit: "a".repeat(40),
    imageDigest: `sha256:${"b".repeat(64)}`,
    worldDeploymentPath: "/evidence/world.json",
  });
});

test("Serverwrapper bricht vor jedem Dateizugriff ab, wenn ein Pflichtpfad fehlt", async () => {
  let loaded = false;
  await assert.rejects(
    runMapReleaseDeploymentPreflight({
      mode: "active-candidate",
      environment: {},
      async loadEvidence() {
        loaded = true;
        return evidence;
      },
    }),
    /MAP_RELEASE_PREFLIGHT_EVIDENCE_PATH/u,
  );
  assert.equal(loaded, false);
});
