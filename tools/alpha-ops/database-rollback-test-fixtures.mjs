import { createHash } from "node:crypto";

import { serializeMapReleaseBuildEvidence } from "../tiles/map-release-build-evidence.mjs";
import {
  DATABASE_AUTHORITATIVE_TABLES,
  DATABASE_AUTHORITATIVE_TABLE_SET_SHA256,
  DATABASE_CUTOVER_CONSTRAINTS,
  DATABASE_CUTOVER_GUARDS,
} from "./database-cutover-schema-contract.mjs";

export const DATABASE_AUTHORITATIVE_TABLE_COUNT = DATABASE_AUTHORITATIVE_TABLES.length;
export { DATABASE_AUTHORITATIVE_TABLE_SET_SHA256 };

export function databaseCutoverConstraintProofs() {
  return DATABASE_CUTOVER_CONSTRAINTS.map(({ name, definitionSha256 }) => ({
    name,
    definitionSha256,
    validated: true,
  }));
}

export function databaseCutoverGuardProofs() {
  return DATABASE_CUTOVER_GUARDS.map(({ name, definitionSha256 }) => ({
    name,
    definitionSha256,
    enabled: true,
  }));
}

function artifactSha256(value) {
  return createHash("sha256").update(serializeMapReleaseBuildEvidence(value)).digest("hex");
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

export function keycloakIdentityHeadFixture(overrides = {}) {
  const payload = Object.freeze({
    schema: "keycloak-identity-head/v1",
    objectCatalogSha256: "a".repeat(64),
    tableCount: 100,
    totalRowCount: "8",
    realmCount: "1",
    userCount: "1",
    clientCount: "2",
    credentialCount: "1",
    userSessionCount: "1",
    authenticationSessionCount: "1",
    tableStatesSha256: "b".repeat(64),
    ...overrides,
  });
  return Object.freeze({ ...payload, stateHash: canonicalSha256(payload) });
}

export function keycloakStateInspectorFixture(identityHead = keycloakIdentityHeadFixture()) {
  return async () => Object.freeze({ state: "migrated", identityHead });
}

export function databaseRollbackEvidenceFixtures(source, {
  restored = structuredClone(source),
  restoreSeparation = {
    schema: "zugfolge-database-restore-separation/v1",
    sourceEndpointSha256: "1".repeat(64),
    restoredEndpointSha256: "2".repeat(64),
    sourceBackendSha256: "3".repeat(64),
    restoredBackendSha256: "4".repeat(64),
  },
  backupManifestOverrides = {},
  restoreProofOverrides = {},
} = {}) {
  const backupManifest = {
    schema: "zugfolge-database-backup-manifest/v1",
    backupId: "backup-2026.3-001",
    databaseIdentity: source.databaseIdentity,
    sourceAuthoritativeHeadSha256: source.authoritativeHead.stateHash,
    sourceEndpointSha256: restoreSeparation.sourceEndpointSha256,
    sourceBackendSha256: restoreSeparation.sourceBackendSha256,
    backupStartedWalLsn: "0/16B6C50",
    backupCompletedWalLsn: "0/16B6D20",
    writersQuiesced: true,
    completedAt: "2026-08-25T10:00:00.000Z",
    ...backupManifestOverrides,
  };
  const backupManifestSha256 = artifactSha256(backupManifest);
  const restoreProof = {
    schema: "zugfolge-database-restore-proof/v1",
    backupManifestSha256,
    databaseIdentity: source.databaseIdentity,
    sourceAuthoritativeHeadSha256: source.authoritativeHead.stateHash,
    restoredAuthoritativeHeadSha256: restored.authoritativeHead.stateHash,
    sourceEndpointSha256: restoreSeparation.sourceEndpointSha256,
    restoredEndpointSha256: restoreSeparation.restoredEndpointSha256,
    sourceBackendSha256: restoreSeparation.sourceBackendSha256,
    restoredBackendSha256: restoreSeparation.restoredBackendSha256,
    verification: "full-database-row-fingerprint",
    verified: true,
    verifiedAt: "2026-08-25T10:10:00.000Z",
    ...restoreProofOverrides,
  };
  return Object.freeze({
    restored,
    restoreSeparation,
    backupManifest,
    backupManifestSha256,
    restoreProof,
    restoreProofSha256: artifactSha256(restoreProof),
  });
}
