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
  validateUnsignedMapRollbackAttestation,
  validateMapReleaseBuildEvidence,
  verifyMapReleaseBuildEvidence,
  writeBuildCacheRestoreProof,
  writeMapReleaseBuildEvidence,
  writeMapRollbackAttestation,
  writeUnsignedMapRollbackAttestation,
} from "./map-release-build-evidence.mjs";
import { parseTrustedReleaseKeyScopes } from "../../apps/game-api/dist/trusted-release-keys.js";

function usage() {
  return [
    "Aufruf:",
    "  map-release-build-evidence-cli.mjs build SPEC.json BUILD_ROOT EVIDENCE.json [SEMANTIC_EXPORT_COMMIT MAP_BUILD_COMMIT]",
    "  map-release-build-evidence-cli.mjs verify EVIDENCE.json BUILD_ROOT",
    "  map-release-build-evidence-cli.mjs prepare-restore LEERES_RESTORE_ZIEL",
    "  map-release-build-evidence-cli.mjs prove-restore EVIDENCE.json RESTORE_ROOT PROOF.json",
    "  map-release-build-evidence-cli.mjs attest-rollback DEPLOYMENT_ROOT PREVIOUS_INSTALL_PATH PREVIOUS_RELEASE_ID PRIVATE_KEY.pem KEY_ID ATTESTATION.json",
    "  map-release-build-evidence-cli.mjs attest-runtime-rollback DEPLOYMENT_ROOT PREVIOUS_INSTALL_PATH PREVIOUS_RELEASE_ID SOURCE_COMMIT GAME_IMAGE_DIGEST ODOO_IMAGE_DIGEST WORLD_DEPLOYMENT.json DATABASE_ROLLBACK_PROOF.json PRIVATE_KEY.pem KEY_ID ATTESTATION.json",
    "  map-release-build-evidence-cli.mjs prepare-runtime-rollback DEPLOYMENT_ROOT PREVIOUS_INSTALL_PATH PREVIOUS_RELEASE_ID SOURCE_COMMIT GAME_IMAGE_DIGEST ODOO_IMAGE_DIGEST WORLD_DEPLOYMENT.json DATABASE_ROLLBACK_PROOF.json UNSIGNED.json",
    "  map-release-build-evidence-cli.mjs sign-runtime-rollback UNSIGNED.json PRIVATE_KEY.pem KEY_ID ATTESTATION.json",
    "  map-release-build-evidence-cli.mjs preflight EVIDENCE.json DEPLOYMENT_ROOT RESTORE_PROOF.json RESTORE_ROOT TRUSTED_RELEASE_KEYS.json TRUSTED_KEY_SCOPES.json EXPECTED_ACTIVE_RELEASE_ID SOURCE_COMMIT GAME_IMAGE_DIGEST ODOO_IMAGE_DIGEST WORLD_DEPLOYMENT.json DATABASE_ROLLBACK_PROOF.json",
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
  if (![3, 5].includes(args.length)) throw new Error(usage());
  const [specPathInput, artifactRootInput, outputPath, semanticExport, mapBuild] = args;
  const artifactRoot = resolve(artifactRootInput);
  const specPath = resolve(specPathInput);
  const specFile = relative(artifactRoot, specPath).replaceAll("\\", "/");
  const specBytes = await readFile(specPath);
  const spec = JSON.parse(specBytes.toString("utf8"));
  const evidence = await materializeMapReleaseBuildEvidence({
    spec,
    specBytes,
    specFile,
    artifactRoot,
    ...(semanticExport === undefined ? {} : { commits: { semanticExport, mapBuild } }),
  });
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
  if (args.length !== 11) throw new Error(usage());
  const [deploymentRoot, previousInstallPath, previousReleaseId, sourceCommit, imageDigest, odooImageDigest, worldDeploymentPath, databaseRollbackProofPath, privateKeyPath, keyId, outputPath] = args;
  const unsigned = await createMapRollbackAttestation({
    deploymentRoot,
    previousInstallPath,
    previousReleaseId,
    runtimeIdentity: { sourceCommit, imageDigest, odooImageDigest, worldDeploymentPath, databaseRollbackProofPath },
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
    databaseRollbackProofHash: signed.runtimeTuple.databaseRollback.proofHash,
    keyId,
    bytes: written.bytes,
    sha256: written.sha256,
  };
} else if (command === "prepare-runtime-rollback") {
  if (args.length !== 9) throw new Error(usage());
  const [deploymentRoot, previousInstallPath, previousReleaseId, sourceCommit, imageDigest, odooImageDigest, worldDeploymentPath, databaseRollbackProofPath, outputPath] = args;
  const unsigned = await createMapRollbackAttestation({
    deploymentRoot,
    previousInstallPath,
    previousReleaseId,
    runtimeIdentity: { sourceCommit, imageDigest, odooImageDigest, worldDeploymentPath, databaseRollbackProofPath },
  });
  const written = await writeUnsignedMapRollbackAttestation(unsigned, outputPath);
  result = {
    action: written.status,
    unsignedAttestationPath: written.path,
    previousReleaseId,
    runtimeTupleSchema: unsigned.runtimeTuple.schema,
    databaseRollbackProofHash: unsigned.runtimeTuple.databaseRollback.proofHash,
    bytes: written.bytes,
    sha256: written.sha256,
  };
} else if (command === "sign-runtime-rollback") {
  if (args.length !== 4) throw new Error(usage());
  const [unsignedPath, privateKeyPath, keyId, outputPath] = args;
  const unsignedBytes = await readFile(resolve(unsignedPath));
  const unsigned = JSON.parse(unsignedBytes.toString("utf8"));
  validateUnsignedMapRollbackAttestation(unsigned);
  if (!unsignedBytes.equals(serializeMapReleaseBuildEvidence(unsigned))) throw new Error("Unsignierte Rollback-Attestation ist nicht kanonisch serialisiert.");
  const privateKeyPem = await readFile(resolve(privateKeyPath), "utf8");
  const signed = signMapRollbackAttestation(unsigned, privateKeyPem, keyId);
  const written = await writeMapRollbackAttestation(signed, outputPath);
  result = {
    action: written.status,
    attestationPath: written.path,
    previousReleaseId: signed.previousReleaseId,
    attestationHash: signed.attestationHash,
    runtimeTupleSchema: signed.runtimeTuple.schema,
    databaseRollbackProofHash: signed.runtimeTuple.databaseRollback.proofHash,
    keyId,
    bytes: written.bytes,
    sha256: written.sha256,
  };
} else if (command === "preflight") {
  if (args.length !== 12) throw new Error(usage());
  const [evidencePath, deploymentRoot, restoreProofPath, restoreRoot, trustedDeliveryKeysPath, trustedKeyScopesPath, expectedActiveReleaseId, sourceCommit, imageDigest, odooImageDigest, worldDeploymentPath, databaseRollbackProofPath] = args;
  const evidence = await readCanonicalEvidence(evidencePath);
  const [restoreProofBytes, trustedDeliveryKeysBytes, trustedKeyScopesJson, databaseRollbackProofBytes] = await Promise.all([
    readFile(resolve(restoreProofPath)),
    readFile(resolve(trustedDeliveryKeysPath)),
    readFile(resolve(trustedKeyScopesPath), "utf8"),
    readFile(resolve(databaseRollbackProofPath)),
  ]);
  const trustedDeliveryKeys = JSON.parse(trustedDeliveryKeysBytes.toString("utf8"));
  const trustedReleaseKeyScopes = parseTrustedReleaseKeyScopes(trustedKeyScopesJson, trustedDeliveryKeys);
  result = {
    action: "activation-preflight",
    ...(await preflightMapReleaseActivation({
      evidence,
      deploymentRoot,
      restoreProofBytes,
      restoreRoot,
      trustedDeliveryKeys,
      trustedDeliveryKeysBytes,
      trustedAlphaWorldKeys: trustedReleaseKeyScopes.alphaWorldDeployments,
      trustedMapInfraKeys: trustedReleaseKeyScopes.mapInfraDeliveries,
      expectedActiveReleaseId,
      runtimeIdentity: { sourceCommit, imageDigest, odooImageDigest, worldDeploymentPath, databaseRollbackProofPath },
      databaseRollbackProofBytes,
    })),
  };
} else {
  throw new Error(usage());
}

process.stdout.write(`${JSON.stringify(result)}\n`);
