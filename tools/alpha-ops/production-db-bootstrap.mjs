import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  assertProductionServerWorldEnvironment,
  inspectSignedOperationalV2Candidate,
  parseWorldDeploymentCutoverAuthorization,
} from "./world-deployment-cutover-preflight.mjs";
import { applyWorldDeploymentCutover } from "./world-deployment-cutover-apply.mjs";
import { parseCanonicalDatabaseRollbackProof } from "../tiles/map-release-build-evidence.mjs";

const uiWorldId = assertProductionServerWorldEnvironment(process.env);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL fehlt.");

const deploymentPaths = JSON.parse(process.env.ALPHA_WORLD_RELEASE_PATHS_JSON ?? "[]");
if (!Array.isArray(deploymentPaths) || deploymentPaths.length !== 1 || typeof deploymentPaths[0] !== "string") {
  throw new Error("Der Produktions-Bootstrap braucht genau ein signiertes Weltdeployment.");
}
const {
  parseTrustedReleaseKeys,
  parseTrustedReleaseKeyScopes,
} = await import("../../apps/game-api/dist/trusted-release-keys.js");
const trustedReleaseKeys = parseTrustedReleaseKeys(process.env.INFRA_RELEASE_TRUSTED_KEYS_JSON ?? "");
const trustedKeys = parseTrustedReleaseKeyScopes(
  process.env.RELEASE_TRUSTED_KEY_SCOPES_JSON ?? "",
  trustedReleaseKeys,
).alphaWorldDeployments;

const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const postgresModule = requireFromDb("postgres");
const postgres = postgresModule.default ?? postgresModule;
const { drizzle } = requireFromDb("drizzle-orm/postgres-js");
const schema = await import("../../packages/db/dist/schema/index.js");
const {
  loadSignedAlphaWorldDeployment,
} = await import("../../apps/game-api/dist/alpha-world-start.js");
const { ensureSignedPlanningAuthority } = await import("../../apps/game-api/dist/odoo-admin-handlers.js");
const { inspectPublicReadModel } = await import("../tiles/livemap-read-model.mjs");
const signedEnvelope = JSON.parse(await readFile(deploymentPaths[0], "utf8"));
const candidate = inspectSignedOperationalV2Candidate(signedEnvelope, trustedKeys);
const signed = await loadSignedAlphaWorldDeployment(deploymentPaths[0], trustedKeys);
if (candidate.deploymentHash !== signed.deploymentHash) {
  throw new Error("Preflight und Game-Parser ermitteln verschiedene Deployment-Hashes.");
}
const cutoverAuthorization = parseWorldDeploymentCutoverAuthorization(
  process.env.ALPHA_WORLD_V2_CUTOVER_AUTHORIZATION_JSON,
  candidate,
);
const definition = signed.deployment.worldDefinition;
if (definition.kind !== "public" || definition.rankingStatus !== "ranked") {
  throw new Error("Der statische Produktions-Bootstrap ist ausschliesslich fuer die signierte oeffentliche Welt erlaubt.");
}
const databaseRollbackProofPath = process.env.MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH;
if (typeof databaseRollbackProofPath !== "string" || databaseRollbackProofPath.trim() === "") {
  throw new Error("MAP_RELEASE_PREFLIGHT_DATABASE_ROLLBACK_PROOF_PATH fehlt.");
}
const databaseRollbackProof = parseCanonicalDatabaseRollbackProof(
  await readFile(databaseRollbackProofPath),
  { releaseId: signed.deployment.provenance.infraReleaseId },
).proof;

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema });
try {
  const livemapReadModelPath = process.env.LIVEMAP_READ_MODEL_PATH;
  if (typeof livemapReadModelPath !== "string" || livemapReadModelPath.trim() === "") {
    throw new Error("LIVEMAP_READ_MODEL_PATH fehlt.");
  }
  const mapBinding = await inspectPublicReadModel(livemapReadModelPath);
  const cutover = await applyWorldDeploymentCutover({
    client,
    candidate,
    signed,
    signedEnvelope,
    trustedKeys,
    cutoverAuthorization,
    mapBinding,
    uiWorldId,
    databaseRollbackProof,
  });
  // Defense in depth: derselbe bestehende Identitaetsvertrag wird nach dem
  // atomaren Cutover noch einmal ueber die regulaere Game-Grenze gelesen.
  await ensureSignedPlanningAuthority(db, signed);
  process.stdout.write(`${JSON.stringify({
    bootstrapped: true,
    worldId: signed.deployment.worldId,
    deploymentHash: signed.deploymentHash,
    cutoverMode: cutover.mode,
    committedMode: cutover.committedMode,
    cutoverReceiptHash: cutover.cutoverReceiptHash,
  })}\n`);
} finally {
  await client.end({ timeout: 5 });
}
