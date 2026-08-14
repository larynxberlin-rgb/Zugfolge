#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  createMapRollbackAttestation,
  materializeMapReleaseBuildEvidence,
  preflightMapReleaseActivation,
  prepareEmptyBuildCacheRestore,
  proveBuildCacheRestore,
  serializeMapReleaseBuildEvidence,
  signMapRollbackAttestation,
  validateMapReleaseBuildEvidence,
  verifyMapReleaseBuildEvidence,
  writeBuildCacheRestoreProof,
  writeMapReleaseBuildEvidence,
  writeMapRollbackAttestation,
} from "./map-release-build-evidence.mjs";

function usage() {
  return [
    "Aufruf:",
    "  map-release-build-evidence-cli.mjs build SPEC.json BUILD_ROOT EVIDENCE.json",
    "  map-release-build-evidence-cli.mjs verify EVIDENCE.json BUILD_ROOT",
    "  map-release-build-evidence-cli.mjs prepare-restore LEERES_RESTORE_ZIEL",
    "  map-release-build-evidence-cli.mjs prove-restore EVIDENCE.json RESTORE_ROOT PROOF.json",
    "  map-release-build-evidence-cli.mjs attest-rollback DEPLOYMENT_ROOT PREVIOUS_INSTALL_PATH PREVIOUS_RELEASE_ID PRIVATE_KEY.pem KEY_ID ATTESTATION.json",
    "  map-release-build-evidence-cli.mjs attest-runtime-rollback DEPLOYMENT_ROOT PREVIOUS_INSTALL_PATH PREVIOUS_RELEASE_ID SOURCE_COMMIT IMAGE_DIGEST WORLD_DEPLOYMENT.json PRIVATE_KEY.pem KEY_ID ATTESTATION.json",
    "  map-release-build-evidence-cli.mjs preflight EVIDENCE.json DEPLOYMENT_ROOT RESTORE_PROOF.json RESTORE_ROOT TRUSTED_DELIVERY_KEYS.json EXPECTED_ACTIVE_RELEASE_ID [SOURCE_COMMIT IMAGE_DIGEST WORLD_DEPLOYMENT.json]",
  ].join("\n");
}

async function readCanonicalEvidence(path) {
  const bytes = await readFile(resolve(path));
  const evidence = JSON.parse(bytes.toString("utf8"));
  validateMapReleaseBuildEvidence(evidence);
  if (!bytes.equals(serializeMapReleaseBuildEvidence(evidence))) throw new Error("Build-Evidence-Manifest ist nicht kanonisch serialisiert.");
  return evidence;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const [command, ...args] = process.argv.slice(2);
let result;

if (command === "build") {
  if (args.length !== 3) throw new Error(usage());
  const [specPathInput, artifactRootInput, outputPath] = args;
  const artifactRoot = resolve(artifactRootInput);
  const specPath = resolve(specPathInput);
  const specFile = relative(artifactRoot, specPath).replaceAll("\\", "/");
  const specBytes = await readFile(specPath);
  const spec = JSON.parse(specBytes.toString("utf8"));
  const evidence = await materializeMapReleaseBuildEvidence({ spec, specBytes, specFile, artifactRoot });
  const written = await writeMapReleaseBuildEvidence(evidence, outputPath);
  result = {
    action: written.status,
    evidencePath: written.path,
    releaseId: evidence.releaseId,
    previousReleaseId: evidence.previousReleaseId,
    bytes: written.bytes,
    sha256: written.sha256,
    inputs: evidence.inputs.length,
    tools: evidence.tools.length,
    outputs: evidence.outputs.length,
  };
} else if (command === "verify") {
  if (args.length !== 2) throw new Error(usage());
  const evidence = await readCanonicalEvidence(args[0]);
  result = { action: "verified", ...(await verifyMapReleaseBuildEvidence(evidence, resolve(args[1]))) };
} else if (command === "prepare-restore") {
  if (args.length !== 1) throw new Error(usage());
  const prepared = await prepareEmptyBuildCacheRestore(args[0]);
  result = {
    action: "prepared-empty-restore",
    restoreRoot: prepared.root,
    markerPath: prepared.markerPath,
    markerSha256: prepared.markerSha256,
    nonce: prepared.nonce,
  };
} else if (command === "prove-restore") {
  if (args.length !== 3) throw new Error(usage());
  const evidence = await readCanonicalEvidence(args[0]);
  const restore = await proveBuildCacheRestore(evidence, args[1]);
  const written = await writeBuildCacheRestoreProof(restore, args[2]);
  result = {
    action: written.status,
    proofPath: written.path,
    releaseId: restore.proof.releaseId,
    evidenceSha256: restore.proof.evidenceSha256,
    verifiedFiles: restore.proof.verifiedFiles,
    verifiedBytes: restore.proof.verifiedBytes,
    proofSha256: sha256(restore.proofBytes),
  };
} else if (command === "attest-rollback") {
  if (args.length !== 6) throw new Error(usage());
  const [deploymentRoot, previousInstallPath, previousReleaseId, privateKeyPath, keyId, outputPath] = args;
  const unsigned = await createMapRollbackAttestation({ deploymentRoot, previousInstallPath, previousReleaseId });
  const privateKeyPem = await readFile(resolve(privateKeyPath), "utf8");
  const signed = signMapRollbackAttestation(unsigned, privateKeyPem, keyId);
  const written = await writeMapRollbackAttestation(signed, outputPath);
  result = {
    action: written.status,
    attestationPath: written.path,
    previousReleaseId,
    attestationHash: signed.attestationHash,
    keyId,
    bytes: written.bytes,
    sha256: written.sha256,
  };
} else if (command === "attest-runtime-rollback") {
  if (args.length !== 9) throw new Error(usage());
  const [deploymentRoot, previousInstallPath, previousReleaseId, sourceCommit, imageDigest, worldDeploymentPath, privateKeyPath, keyId, outputPath] = args;
  const unsigned = await createMapRollbackAttestation({
    deploymentRoot,
    previousInstallPath,
    previousReleaseId,
    runtimeIdentity: { sourceCommit, imageDigest, worldDeploymentPath },
  });
  const privateKeyPem = await readFile(resolve(privateKeyPath), "utf8");
  const signed = signMapRollbackAttestation(unsigned, privateKeyPem, keyId);
  const written = await writeMapRollbackAttestation(signed, outputPath);
  result = {
    action: written.status,
    attestationPath: written.path,
    previousReleaseId,
    attestationHash: signed.attestationHash,
    runtimeTupleSchema: signed.runtimeTuple.schema,
    keyId,
    bytes: written.bytes,
    sha256: written.sha256,
  };
} else if (command === "preflight") {
  if (![6, 9].includes(args.length)) throw new Error(usage());
  const [evidencePath, deploymentRoot, restoreProofPath, restoreRoot, trustedDeliveryKeysPath, expectedActiveReleaseId, sourceCommit, imageDigest, worldDeploymentPath] = args;
  const evidence = await readCanonicalEvidence(evidencePath);
  const restoreProofBytes = await readFile(resolve(restoreProofPath));
  const trustedDeliveryKeys = JSON.parse(await readFile(resolve(trustedDeliveryKeysPath), "utf8"));
  result = {
    action: "activation-preflight",
    ...(await preflightMapReleaseActivation({
      evidence,
      deploymentRoot,
      restoreProofBytes,
      restoreRoot,
      trustedDeliveryKeys,
      expectedActiveReleaseId,
      ...(sourceCommit === undefined ? {} : { runtimeIdentity: { sourceCommit, imageDigest, worldDeploymentPath } }),
    })),
  };
} else {
  throw new Error(usage());
}

process.stdout.write(`${JSON.stringify(result)}\n`);
