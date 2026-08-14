#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  preflightMapReleaseActivation,
  serializeMapReleaseBuildEvidence,
  validateMapReleaseBuildEvidence,
} from "../tiles/map-release-build-evidence.mjs";

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
    "MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH",
  ];
  const values = names.map((name) => environment[name]);
  const configured = values.filter((value) => typeof value === "string" && value.trim() !== "");
  if (configured.length === 0 && mode === "active-candidate") return undefined;
  invariant(configured.length === names.length, `Modus '${mode}' braucht die vollstaendige Source-/Image-/Welt-Runtime-Identitaet.`);
  return {
    sourceCommit: values[0],
    imageDigest: values[1],
    worldDeploymentPath: values[2],
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
  invariant(result?.activationEligible === true, "Map-Preflight hat den Kandidaten nicht zur Aktivierung freigegeben.");
  invariant(typeof result.rollbackEligible === "boolean", "Map-Preflight meldet keinen ehrlichen Rollbackstatus.");
  if (result.rollbackEligible === false) {
    invariant(typeof result.rollbackEligibilityReason === "string" && result.rollbackEligibilityReason.length > 0, "Map-Preflight begründet den fehlenden Rollbackstatus nicht.");
  }
  if (mode === "pre-activation") {
    invariant(result.rollbackEligible === true, "Expliziter Rollbackstart hat kein vollständig gekoppeltes Runtime-Tuple freigegeben.");
  }
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
  let value;
  try {
    value = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch {
    throw new Error("Map-Delivery-Keyring ist kein gueltiges JSON-Artefakt.");
  }
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "Map-Delivery-Keyring ist kein Schluesselobjekt.");
  return value;
}

export async function runMapReleaseDeploymentPreflight({
  mode,
  environment = process.env,
  preflight = preflightMapReleaseActivation,
  loadEvidence = readCanonicalEvidence,
  loadRestoreProof = (path) => readFile(resolve(path)),
  loadTrustedKeys = readTrustedKeys,
} = {}) {
  const evidencePath = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_EVIDENCE_PATH");
  const deploymentRoot = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_DEPLOYMENT_ROOT");
  const restoreProofPath = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_RESTORE_PROOF_PATH");
  const restoreRoot = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_RESTORE_ROOT");
  const trustedKeysPath = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_TRUSTED_KEYS_PATH");
  const configuredReleaseId = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID");

  const [evidence, restoreProofBytes, trustedDeliveryKeys] = await Promise.all([
    loadEvidence(evidencePath),
    loadRestoreProof(restoreProofPath),
    loadTrustedKeys(trustedKeysPath),
  ]);
  const expectedActiveReleaseId = expectedReleaseForMapPreflight(evidence, mode, configuredReleaseId);
  const runtimeIdentity = runtimeIdentityFromEnvironment(environment, mode);
  const result = await preflight({
    evidence,
    deploymentRoot,
    restoreProofBytes,
    restoreRoot,
    trustedDeliveryKeys,
    expectedActiveReleaseId,
    runtimeIdentity,
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
    activationEligible: result.activationEligible,
    rollbackEligible: result.rollbackEligible,
    rollbackEligibilityReason: result.rollbackEligibilityReason,
    evidenceSha256: result.evidenceSha256,
    deliveryKeyId: result.deliveryKeyId,
    rollbackAttestationSchema: result.rollbackAttestationSchema,
    rollbackAttestationKeyId: result.rollbackAttestationKeyId,
  })}\n`);
}
