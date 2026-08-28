#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  preflightMapReleaseActivation,
  serializeMapReleaseBuildEvidence,
  validateMapReleaseBuildEvidence,
} from "../tiles/map-release-build-evidence.mjs";
import { parseTrustedReleaseKeyScopes } from "../../apps/game-api/dist/trusted-release-keys.js";

export const MAP_RELEASE_PREFLIGHT_MODES = Object.freeze([
  "pre-activation",
  "active-candidate",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  invariant(typeof value === "string" && value.trim() !== "", `Umgebungsvariable '${name}' fehlt.`);
  return value;
}

export function runtimeIdentityFromEnvironment(environment, mode) {
  const names = [
    "MAP_RELEASE_PREFLIGHT_RUNTIME_SOURCE_COMMIT",
    "MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST",
    "PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST",
    "MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH",
    "MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH",
  ];
  const values = names.map((name) => environment[name]);
  const configured = values.filter((value) => typeof value === "string" && value.trim() !== "");
  invariant(configured.length === names.length, `Modus '${mode}' braucht die vollstaendige Source-/Game-Image-/Odoo-Image-/Welt-/Datenbank-Runtime-Identitaet.`);
  return {
    sourceCommit: values[0],
    imageDigest: values[1],
    odooImageDigest: values[2],
    worldDeploymentPath: values[3],
    databaseRollbackProofPath: values[4],
  };
}

export function expectedReleaseForMapPreflight(evidence, mode, configuredReleaseId) {
  invariant(MAP_RELEASE_PREFLIGHT_MODES.includes(mode), "Map-Preflight-Modus muss pre-activation oder active-candidate sein.");
  const contractReleaseId = mode === "active-candidate"
    ? evidence?.releaseId
    : evidence?.previousReleaseId;
  invariant(
    typeof contractReleaseId === "string" && configuredReleaseId === contractReleaseId,
    `Explizit erwartetes Kartenrelease '${configuredReleaseId}' widerspricht dem ${mode}-Vertrag '${contractReleaseId ?? "fehlend"}'.`,
  );
  return contractReleaseId;
}

export function validateMapPreflightResult(result, evidence, mode, expectedActiveReleaseId) {
  const expectedState = mode === "active-candidate" ? "active-candidate" : "pre-activation";
  invariant(result?.mapActivationEligible === true, "Map-Preflight hat den Kartenkandidaten nicht qualifiziert.");
  invariant(result?.activationEligible === true, "Map-Preflight hat den Kandidaten nicht zur Aktivierung freigegeben.");
  invariant(result.mapRollbackEligible === true, `Modus '${mode}' besitzt keinen freigegebenen Map-/Runtime-Rollback.`);
  invariant(result.databaseRollbackEligible === true, `Modus '${mode}' besitzt keinen freigegebenen Datenbank-Rollback.`);
  invariant(result.writersQuiesced === true, `Modus '${mode}' besitzt keinen quieszierten Datenbankbeleg.`);
  invariant(result.rollbackWindow === "pre-activation-only", `Modus '${mode}' besitzt kein ausschliessliches Pre-Activation-Rollbackfenster.`);
  invariant(
    result.rollbackEligible === true
      && result.rollbackEligible === (result.mapRollbackEligible && result.databaseRollbackEligible && result.writersQuiesced),
    `Modus '${mode}' besitzt keinen vollstaendig gekoppelten Full-Stack-Rollbackvertrag.`,
  );
  invariant(result.activationState === expectedState, `Map-Preflight meldet nicht den erwarteten Pointerzustand '${expectedState}'.`);
  invariant(result.activeReleaseId === expectedActiveReleaseId, "Map-Preflight meldet ein anderes aktives Release.");
  invariant(result.releaseId === evidence.releaseId && result.previousReleaseId === evidence.previousReleaseId, "Map-Preflight meldet ein anderes Releasepaar.");
  return result;
}

async function readCanonicalEvidence(path) {
  const bytes = await readFile(resolve(path));
  let evidence;
  try {
    evidence = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Map-Build-Evidence ist kein gueltiges JSON-Artefakt.");
  }
  validateMapReleaseBuildEvidence(evidence);
  invariant(bytes.equals(serializeMapReleaseBuildEvidence(evidence)), "Map-Build-Evidence ist nicht kanonisch serialisiert.");
  return evidence;
}

async function readTrustedKeys(path) {
  const bytes = await readFile(resolve(path));
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Map-Delivery-Keyring ist kein gueltiges JSON-Artefakt.");
  }
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "Map-Delivery-Keyring ist kein Schluesselobjekt.");
  return Object.freeze({ trustedDeliveryKeys: value, trustedDeliveryKeysBytes: bytes });
}

export async function runMapReleaseDeploymentPreflight({
  mode,
  environment = process.env,
  preflight = preflightMapReleaseActivation,
  loadEvidence = readCanonicalEvidence,
  loadRestoreProof = (path) => readFile(resolve(path)),
  loadDatabaseRollbackProof = (path) => readFile(resolve(path)),
  loadTrustedKeys = readTrustedKeys,
} = {}) {
  const evidencePath = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_EVIDENCE_PATH");
  const deploymentRoot = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_DEPLOYMENT_ROOT");
  const restoreProofPath = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_RESTORE_PROOF_PATH");
  const restoreRoot = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_RESTORE_ROOT");
  const trustedKeysPath = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_TRUSTED_KEYS_PATH");
  const databaseRollbackProofPath = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH");
  const configuredReleaseId = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID");
  const trustedKeyScopesJson = requiredEnvironment(environment, "RELEASE_TRUSTED_KEY_SCOPES_JSON");

  const [evidence, restoreProofBytes, trustedKeyring, databaseRollbackProofBytes] = await Promise.all([
    loadEvidence(evidencePath),
    loadRestoreProof(restoreProofPath),
    loadTrustedKeys(trustedKeysPath),
    loadDatabaseRollbackProof(databaseRollbackProofPath),
  ]);
  const expectedActiveReleaseId = expectedReleaseForMapPreflight(evidence, mode, configuredReleaseId);
  const runtimeIdentity = runtimeIdentityFromEnvironment(environment, mode);
  const trustedReleaseKeyScopes = parseTrustedReleaseKeyScopes(
    trustedKeyScopesJson,
    trustedKeyring.trustedDeliveryKeys,
  );
  const result = await preflight({
    evidence,
    deploymentRoot,
    restoreProofBytes,
    restoreRoot,
    trustedDeliveryKeys: trustedKeyring.trustedDeliveryKeys,
    trustedDeliveryKeysBytes: trustedKeyring.trustedDeliveryKeysBytes,
    trustedAlphaWorldKeys: trustedReleaseKeyScopes.alphaWorldDeployments,
    trustedMapInfraKeys: trustedReleaseKeyScopes.mapInfraDeliveries,
    expectedActiveReleaseId,
    runtimeIdentity,
    databaseRollbackProofBytes,
  });
  return validateMapPreflightResult(result, evidence, mode, expectedActiveReleaseId);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || !MAP_RELEASE_PREFLIGHT_MODES.includes(mode)) {
    throw new Error("Aufruf: map-release-deployment-preflight.mjs pre-activation|active-candidate");
  }
  const result = await runMapReleaseDeploymentPreflight({ mode });
  process.stdout.write(`${JSON.stringify({
    action: "map-release-deployment-preflight",
    mode,
    releaseId: result.releaseId,
    previousReleaseId: result.previousReleaseId,
    activeReleaseId: result.activeReleaseId,
    activationState: result.activationState,
    mapActivationEligible: result.mapActivationEligible,
    activationEligible: result.activationEligible,
    rollbackEligible: result.rollbackEligible,
    rollbackEligibilityReason: result.rollbackEligibilityReason,
    mapRollbackEligible: result.mapRollbackEligible,
    databaseRollbackEligible: result.databaseRollbackEligible,
    writersQuiesced: result.writersQuiesced,
    rollbackWindow: result.rollbackWindow,
    databaseRollbackProofHash: result.databaseRollbackProofHash,
    databaseBackupManifestSha256: result.databaseBackupManifestSha256,
    databaseRestoreProofSha256: result.databaseRestoreProofSha256,
    evidenceSha256: result.evidenceSha256,
    deliveryKeyId: result.deliveryKeyId,
    rollbackAttestationSchema: result.rollbackAttestationSchema,
    rollbackAttestationKeyId: result.rollbackAttestationKeyId,
  })}\n`);
}
