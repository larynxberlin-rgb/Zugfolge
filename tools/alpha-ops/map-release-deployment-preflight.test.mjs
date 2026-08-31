import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedReleaseForMapPreflight,
  runMapReleaseDeploymentPreflight,
  runtimeIdentityFromEnvironment,
  validateMapPreflightResult,
  validateMapRollbackPreflightResult,
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
    mapActivationEligible: true,
    activationEligible: true,
    rollbackEligible: true,
    mapRollbackEligible: true,
    databaseRollbackEligible: true,
    writersQuiesced: true,
    rollbackWindow: "pre-activation-only",
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

test("attestierter Rollback qualifiziert nur den Vorgänger-Rückweg und niemals den Kandidaten", () => {
  const expected = expectedReleaseForMapPreflight(evidence, "attested-rollback", evidence.previousReleaseId);
  const rollback = {
    ...result(expected, "pre-activation"),
    mapActivationEligible: false,
    activationEligible: false,
  };
  assert.equal(validateMapRollbackPreflightResult(rollback, evidence, expected).rollbackEligible, true);
  assert.throws(
    () => validateMapRollbackPreflightResult({ ...rollback, activationEligible: true }, evidence, expected),
    /keinen Kartenkandidaten/u,
  );
  assert.throws(
    () => expectedReleaseForMapPreflight(evidence, "attested-rollback", evidence.releaseId),
    /attested-rollback-Vertrag/u,
  );
});

test("falscher Pointerzustand und jeder unvollstaendige Full-Stack-Rollback werden in beiden Modi verweigert", () => {
  assert.throws(
    () => validateMapPreflightResult(
      result(evidence.previousReleaseId, "pre-activation"),
      evidence,
      "active-candidate",
      evidence.releaseId,
    ),
    /Pointerzustand/u,
  );
  assert.throws(
    () => validateMapPreflightResult(
      { ...result(evidence.releaseId, "active-candidate"), rollbackEligible: false, mapRollbackEligible: false },
      evidence,
      "active-candidate",
      evidence.releaseId,
    ),
    /keinen freigegebenen Map-\/Runtime-Rollback/u,
  );
  assert.throws(
    () => validateMapPreflightResult(
      { ...result(evidence.releaseId, "active-candidate"), rollbackEligible: false, databaseRollbackEligible: false },
      evidence,
      "active-candidate",
      evidence.releaseId,
    ),
    /keinen freigegebenen Datenbank-Rollback/u,
  );
  assert.throws(
    () => validateMapPreflightResult(
      { ...result(evidence.previousReleaseId, "pre-activation"), rollbackEligible: false, writersQuiesced: false },
      evidence,
      "pre-activation",
      evidence.previousReleaseId,
    ),
    /keinen quieszierten Datenbankbeleg/u,
  );
  assert.throws(
    () => validateMapPreflightResult(
      { ...result(evidence.releaseId, "active-candidate"), rollbackWindow: "active-candidate" },
      evidence,
      "active-candidate",
      evidence.releaseId,
    ),
    /Pre-Activation-Rollbackfenster/u,
  );
  assert.throws(
    () => validateMapPreflightResult(
      { ...result(evidence.releaseId, "active-candidate"), rollbackEligible: false },
      evidence,
      "active-candidate",
      evidence.releaseId,
    ),
    /Full-Stack-Rollbackvertrag/u,
  );
  assert.throws(
    () => expectedReleaseForMapPreflight(evidence, "fallback", evidence.releaseId),
    /pre-activation, active-candidate oder attested-rollback/u,
  );
});

test("Serverwrapper liest nur die festen Artefaktpfade und reicht den expliziten .2-Vertrag weiter", async () => {
  const environment = {
    MAP_RELEASE_PREFLIGHT_EVIDENCE_PATH: "/map-preflight/evidence.json",
    MAP_RELEASE_PREFLIGHT_DEPLOYMENT_ROOT: "/map-deployment",
    MAP_RELEASE_PREFLIGHT_RESTORE_PROOF_PATH: "/map-preflight/restore-proof.json",
    MAP_RELEASE_PREFLIGHT_RESTORE_ROOT: "/map-restore",
    MAP_RELEASE_PREFLIGHT_TRUSTED_KEYS_PATH: "/map-preflight/trusted-delivery-keys.json",
    MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH: "/map-preflight/database-rollback-proof.json",
    MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID: evidence.releaseId,
    RELEASE_TRUSTED_KEY_SCOPES_JSON: JSON.stringify({
      alphaWorldDeployments: ["alpha-world-2026"],
      mapInfraDeliveries: ["map-delivery-2026"],
    }),
    MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT: "a".repeat(40),
    MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH: "/evidence/world.json",
  };
  const proof = Buffer.from("canonical restore proof");
  const databaseProof = Buffer.from("canonical database rollback proof");
  const keys = {
    "alpha-world-2026": "alpha-public-key",
    "map-delivery-2026": "map-public-key",
  };
  const keyBytes = Buffer.from(`${JSON.stringify(keys)}\n`);
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
      return { trustedDeliveryKeys: keys, trustedDeliveryKeysBytes: keyBytes };
    },
    async loadDatabaseRollbackProof(path) {
      assert.equal(path, environment.MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH);
      return databaseProof;
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
    trustedDeliveryKeysBytes: keyBytes,
    trustedAlphaWorldKeys: { "alpha-world-2026": "alpha-public-key" },
    trustedMapInfraKeys: { "map-delivery-2026": "map-public-key" },
    expectedActiveReleaseId: evidence.releaseId,
    runtimeIdentity: {
      sourceCommit: environment.MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT,
      imageDigest: environment.MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST,
      odooImageDigest: environment.PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST,
      worldDeploymentPath: environment.MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH,
      databaseRollbackProofPath: environment.MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH,
    },
    databaseRollbackProofBytes: databaseProof,
  });
  assert.equal(loaded.activeReleaseId, evidence.releaseId);
});

test("Serverwrapper verweigert ein fehlendes Scope-Mapping vor jedem Artefaktzugriff", async () => {
  let artifactReadStarted = false;
  await assert.rejects(runMapReleaseDeploymentPreflight({
    mode: "active-candidate",
    environment: {
      MAP_RELEASE_PREFLIGHT_EVIDENCE_PATH: "/unused/evidence.json",
      MAP_RELEASE_PREFLIGHT_DEPLOYMENT_ROOT: "/unused/deployment",
      MAP_RELEASE_PREFLIGHT_RESTORE_PROOF_PATH: "/unused/restore-proof.json",
      MAP_RELEASE_PREFLIGHT_RESTORE_ROOT: "/unused/restore",
      MAP_RELEASE_PREFLIGHT_TRUSTED_KEYS_PATH: "/unused/trusted-keys.json",
      MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH: "/unused/database-proof.json",
      MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID: evidence.releaseId,
    },
    loadEvidence: async () => {
      artifactReadStarted = true;
      return evidence;
    },
  }), /RELEASE_TRUSTED_KEY_SCOPES_JSON' fehlt/u);
  assert.equal(artifactReadStarted, false);
});

test("Serverwrapper ruft im Rollbackmodus ausschließlich den kandidatenunabhängigen Rückwegprüfer auf", async () => {
  const environment = {
    MAP_RELEASE_PREFLIGHT_EVIDENCE_PATH: "/map-preflight/evidence.json",
    MAP_RELEASE_PREFLIGHT_DEPLOYMENT_ROOT: "/map-deployment",
    MAP_RELEASE_PREFLIGHT_RESTORE_PROOF_PATH: "/map-preflight/restore-proof.json",
    MAP_RELEASE_PREFLIGHT_RESTORE_ROOT: "/map-restore",
    MAP_RELEASE_PREFLIGHT_TRUSTED_KEYS_PATH: "/map-preflight/trusted-delivery-keys.json",
    MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH: "/map-preflight/database-rollback-proof.json",
    MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID: evidence.previousReleaseId,
    RELEASE_TRUSTED_KEY_SCOPES_JSON: JSON.stringify({ alphaWorldDeployments: ["alpha"], mapInfraDeliveries: ["map"] }),
    MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT: "a".repeat(40),
    MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH: "/evidence/world.json",
  };
  let activationCalled = false;
  let rollbackCalled = false;
  const loaded = await runMapReleaseDeploymentPreflight({
    mode: "attested-rollback",
    environment,
    loadEvidence: async () => evidence,
    loadRestoreProof: async () => Buffer.from("restore"),
    loadTrustedKeys: async () => ({
      trustedDeliveryKeys: { alpha: "alpha-key", map: "map-key" },
      trustedDeliveryKeysBytes: Buffer.from("keys"),
    }),
    loadDatabaseRollbackProof: async () => Buffer.from("database"),
    preflight: async () => {
      activationCalled = true;
      return result(evidence.releaseId, "active-candidate");
    },
    rollbackPreflight: async () => {
      rollbackCalled = true;
      return {
        ...result(evidence.previousReleaseId, "pre-activation"),
        mapActivationEligible: false,
        activationEligible: false,
      };
    },
  });
  assert.equal(loaded.rollbackEligible, true);
  assert.equal(activationCalled, false);
  assert.equal(rollbackCalled, true);
});

test("beide Produktionsmodi verlangen die vollständige attestierte Runtime-Identität", () => {
  assert.throws(() => runtimeIdentityFromEnvironment({}, "active-candidate"), /vollstaendige .*Runtime-Identitaet/u);
  assert.throws(() => runtimeIdentityFromEnvironment({}, "pre-activation"), /vollstaendige .*Runtime-Identitaet/u);
  assert.throws(() => runtimeIdentityFromEnvironment({}, "attested-rollback"), /vollstaendige .*Runtime-Identitaet/u);
  assert.throws(() => runtimeIdentityFromEnvironment({
    MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT: "a".repeat(40),
  }, "active-candidate"), /vollstaendige .*Runtime-Identitaet/u);
  assert.throws(() => runtimeIdentityFromEnvironment({
    MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT: "a".repeat(40),
    MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH: "/evidence/world.json",
  }, "active-candidate"), /vollstaendige .*Runtime-Identitaet/u);
  assert.deepEqual(runtimeIdentityFromEnvironment({
    MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT: "a".repeat(40),
    MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH: "/evidence/world.json",
    MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH: "/map-preflight/database-rollback-proof.json",
  }, "pre-activation"), {
    sourceCommit: "a".repeat(40),
    imageDigest: `sha256:${"b".repeat(64)}`,
    odooImageDigest: `sha256:${"c".repeat(64)}`,
    worldDeploymentPath: "/evidence/world.json",
    databaseRollbackProofPath: "/map-preflight/database-rollback-proof.json",
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
