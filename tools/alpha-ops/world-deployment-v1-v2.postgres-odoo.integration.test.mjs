#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  inspectSignedDeploymentEnvelope,
  inspectSignedOperationalV2Candidate,
  inspectWorldCutoverDatabase,
  parseWorldDeploymentCutoverAuthorization,
  validateWorldDeploymentCutover,
  WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES,
} from "./world-deployment-cutover-preflight.mjs";
import { applyWorldDeploymentCutover } from "./world-deployment-cutover-apply.mjs";
import { inspectLiveDatabaseRollbackSnapshot } from "./database-rollback-binding.mjs";
import {
  databaseRollbackEvidenceFixtures,
  keycloakStateInspectorFixture,
} from "./database-rollback-test-fixtures.mjs";
import { createDatabaseRollbackProof } from "../tiles/map-release-build-evidence.mjs";

const contractPath = new URL(
  "../../odoo/addons/zugfolge_admin/tests/fixtures/v1_v2_postgres_odoo_contract.json",
  import.meta.url,
);
const identityPath = new URL(
  "../region-import/specifications/alpha-world-germany-2026.3.identity.json",
  import.meta.url,
);
const migrationPath = new URL(
  "../region-import/specifications/alpha-fleet-v1-migration.annual-2026.3.json",
  import.meta.url,
);
const keycloakCatalogPath = fileURLToPath(new URL(
  "../../ops/alpha/keycloak/keycloak-pg16-object-catalog.26.7.0.json",
  import.meta.url,
));
const migrationsFolder = fileURLToPath(new URL("../../packages/db/drizzle", import.meta.url));
const contract = JSON.parse(await readFile(contractPath, "utf8"));
const annualIdentity = JSON.parse(await readFile(identityPath, "utf8"));
const annualMigration = JSON.parse(await readFile(migrationPath, "utf8"));
const keycloakCatalog = JSON.parse(await readFile(keycloakCatalogPath, "utf8"));
const trustedKeys = {
  [contract.trustedKey.keyId]: contract.trustedKey.publicKeyPem,
};
const databaseUrl = process.env.TEST_DATABASE_URL?.trim() || undefined;
const legacyAuthorityAccountId = "00000000-0000-4000-8000-000000000016";

function inspectedContract() {
  const candidate = inspectSignedOperationalV2Candidate(contract.candidate, trustedKeys);
  const predecessor = inspectSignedDeploymentEnvelope(
    contract.predecessor,
    trustedKeys,
    "zugfolge-alpha-world-deployment/v1",
  );
  const authorization = parseWorldDeploymentCutoverAuthorization(contract.authorization, candidate);
  return { authorization, candidate, predecessor };
}

test("gemeinsamer Postgres/Odoo-Vertrag bindet die neue 2026.4-Welt an Revision 1", () => {
  const { authorization, candidate, predecessor } = inspectedContract();
  assert.equal(contract.schema, "zugfolge-v1-v2-postgres-odoo-contract/v1");
  assert.equal(candidate.deployment.worldId, annualIdentity.worldId);
  assert.equal(candidate.deployment.worldId, annualMigration.target.worldId);
  assert.equal(predecessor.deployment.worldId, annualMigration.legacy.worldId);
  assert.equal(candidate.deployment.blueprint.regionId, annualIdentity.regionId);
  assert.equal(candidate.deployment.deploymentRevision, 1);
  assert.equal(contract.odooProjection.worldId, candidate.deployment.worldId);
  assert.equal(contract.odooProjection.payload.deploymentHash, candidate.deploymentHash);
  assert.equal(contract.odooProjection.payload.deploymentRevision, 1);
  assert.equal(contract.odooProjection.payload.deploymentAuthorization.deploymentRevision, 1);
  assert.equal(contract.odooPredecessorProjection.worldId, predecessor.deployment.worldId);
  assert.equal(contract.odooPredecessorProjection.payload.deploymentHash, predecessor.deploymentHash);
  assert.equal(contract.odooPredecessorProjection.payload.deploymentRevision, 1);
  assert.equal(authorization.predecessorWorldId, predecessor.deployment.worldId);
  assert.notEqual(authorization.predecessorWorldId, authorization.candidateWorldId);
});

async function withTemporaryDatabase(run) {
  if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL fehlt.");
  const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const postgresModule = requireFromDb("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const { drizzle } = requireFromDb("drizzle-orm/postgres-js");
  const { migrate } = requireFromDb("drizzle-orm/postgres-js/migrator");
  const databaseName = `zf_v1_v2_contract_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  assert.match(databaseName, /^[a-z0-9_]+$/u);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl.toString(), { max: 1 });
  let target;
  try {
    await admin.unsafe(`create database "${databaseName}"`);
    target = postgres(targetUrl.toString(), { max: 1 });
    await migrate(drizzle(target), { migrationsFolder });
    await run(target, targetUrl.toString());
  } finally {
    if (target !== undefined) await target.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await admin.end({ timeout: 5 });
  }
}

async function seedSignedV1Predecessor(sql) {
  const predecessor = contract.predecessor;
  const candidateDeployment = contract.candidate.deployment;
  const releases = candidateDeployment.blueprint.releases;
  const planningAuthority = candidateDeployment.planning.authority;
  const predecessorProjection = contract.odooPredecessorProjection.payload;
  await sql.unsafe(`
    insert into worlds (
      id, name, schedule_period_weeks, epoch, world_kind, ranking_status, lifecycle_status
    ) values ($1::uuid, $2, $3, $4::timestamptz, 'public', 'ranked', 'active')
  `, [
    predecessor.deployment.worldId,
    predecessorProjection.worldName,
    candidateDeployment.worldDefinition.schedulePeriodWeeks,
    candidateDeployment.worldDefinition.epoch,
  ]);
  await sql.unsafe(`
    insert into accounts (id, world_id, keycloak_subject, display_name)
    values ($1::uuid, $2::uuid, $3, $4)
  `, [
    legacyAuthorityAccountId,
    predecessor.deployment.worldId,
    "system:planning-authority:v1-v2-postgres-odoo-contract",
    "V1-Vorgaenger-Aufgabentraeger",
  ]);
  await sql.unsafe(`
    insert into alpha_world_profiles (
      world_id, profile_kind, region_id, region_variant, world_seed,
      acceleration_factor, infra_release_hash, timetable_release_hash,
      fleet_release_hash, economy_release_hash, blueprint, blueprint_hash,
      deployment_hash, current_period, state, started_at_s
    ) values (
      $1::uuid, 'public', $2, $3, $4::bigint,
      1, $5, $6, $7, $8, $9::jsonb, $10,
      $11, 0, 'running', 0
    )
  `, [
    predecessor.deployment.worldId,
    candidateDeployment.blueprint.regionId,
    annualIdentity.regionVariant,
    annualIdentity.seed,
    releases.infra,
    releases.timetable,
    releases.fleet,
    releases.economy,
    JSON.stringify(candidateDeployment.blueprint),
    predecessorProjection.blueprintHash,
    predecessor.deploymentHash,
  ]);
  await sql.unsafe(`
    insert into alpha_world_deployments (
      world_id, deployment_hash, signed_deployment, planning_authority_account_id
    ) values ($1::uuid, $2, $3::jsonb, $4::uuid)
  `, [
    predecessor.deployment.worldId,
    predecessor.deploymentHash,
    JSON.stringify(predecessor),
    legacyAuthorityAccountId,
  ]);
  await sql.unsafe(`
    insert into regional_simulation_states (
      world_id, region_id, state_schema, state, initialization_hash,
      legacy_writer_fenced, state_hash, revision, publisher_sequence,
      created_at, updated_at
    ) values (
      $1::uuid, $2, 'zugfolge-regional-simulation-state/v1', '{}'::jsonb, null,
      false, $3, 0, 0, $4::timestamptz, $4::timestamptz
    )
  `, [
    predecessor.deployment.worldId,
    candidateDeployment.blueprint.regionId,
    "6".repeat(64),
    candidateDeployment.worldDefinition.epoch,
  ]);
  await sql.unsafe("create schema keycloak");
  for (const table of keycloakCatalog.objects.tables) {
    assert.match(table, /^[a-z_][a-z0-9_]*$/u);
    await sql.unsafe(`create table "keycloak"."${table}" (fixture_id bigint)`);
  }
}

function rollbackProof(source, releaseId) {
  return createDatabaseRollbackProof({
    releaseId,
    previousReleaseId: "infra-deutschland-2026.2",
    source,
    ...databaseRollbackEvidenceFixtures(source),
    writersQuiesced: true,
    rollbackWindow: "pre-activation-only",
  });
}

test("echtes PostgreSQL qualifiziert V1 zu neuer V2-Welt und sperrt dieselbe Kandidaten-ID fail closed", {
  skip: databaseUrl === undefined ? "TEST_DATABASE_URL fehlt" : false,
  timeout: 120_000,
}, async () => {
  const { authorization, candidate } = inspectedContract();
  await withTemporaryDatabase(async (sql, targetUrl) => {
    await sql.begin(seedSignedV1Predecessor);
    const database = await inspectWorldCutoverDatabase(targetUrl, candidate.deployment.worldId);
    const preflight = validateWorldDeploymentCutover({
      candidate,
      database,
      mapBinding: contract.mapBinding,
      uiWorldId: candidate.deployment.worldId,
      trustedKeys,
      cutoverAuthorization: authorization,
    });
    assert.deepEqual(preflight, {
      cutoverEligible: true,
      mode: "authorized-v1-to-v2-cutover",
      worldId: candidate.deployment.worldId,
      deploymentHash: candidate.deploymentHash,
      initializationHash: candidate.initializationHash,
      infrastructureReleaseId: candidate.deployment.provenance.infraReleaseId,
    });

    // Derselbe Kandidat darf auch als teilangelegte Welt-ID nicht still
    // wiederverwendet werden. Die exakte Tempzeile wird danach entfernt,
    // damit derselbe Test den autoritativen Apply ausfuehrt.
    await sql.unsafe(`
      insert into worlds (
        id, name, schedule_period_weeks, epoch, world_kind, ranking_status, lifecycle_status
      ) values ($1::uuid, $2, $3, $4::timestamptz, 'public', 'ranked', 'provisioning')
    `, [
      candidate.deployment.worldId,
      candidate.deployment.worldDefinition.name,
      candidate.deployment.worldDefinition.schedulePeriodWeeks,
      candidate.deployment.worldDefinition.epoch,
    ]);
    const reusedDatabase = await inspectWorldCutoverDatabase(targetUrl, candidate.deployment.worldId);
    assert.throws(() => validateWorldDeploymentCutover({
      candidate,
      database: reusedDatabase,
      mapBinding: contract.mapBinding,
      uiWorldId: candidate.deployment.worldId,
      trustedKeys,
      cutoverAuthorization: authorization,
    }), (error) => {
      assert.equal(error?.code, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateWorldIdReused);
      return true;
    });
    await sql.unsafe("delete from worlds where id = $1::uuid and lifecycle_status = 'provisioning'", [
      candidate.deployment.worldId,
    ]);

    // Nur die externe Keycloak-Identitaetsinspektion wird isoliert ersetzt;
    // Ledger, Constraints, Guards und autoritativer DB-Kopf stammen echt aus
    // der migrierten temporaeren PostgreSQL-Datenbank.
    const inspectKeycloakState = keycloakStateInspectorFixture();
    const inspectActualRollbackSnapshot = (transaction) => inspectLiveDatabaseRollbackSnapshot(
      transaction,
      { inspectKeycloakState },
    );
    const beforeSnapshot = await inspectActualRollbackSnapshot(sql);
    assert.match(beforeSnapshot.databaseIdentity, /^[0-9a-f-]{36}$/u);
    assert.equal(beforeSnapshot.authoritativeHead.worldCount, 1);
    assert.equal(beforeSnapshot.authoritativeHead.regionalStateCount, 1);
    const rollbackSnapshots = [];
    const inspectRollbackSnapshot = async (transaction) => {
      const snapshot = await inspectActualRollbackSnapshot(transaction);
      rollbackSnapshots.push(snapshot);
      return snapshot;
    };
    const applyInput = {
      client: sql,
      candidate,
      signed: {
        deployment: candidate.deployment,
        deploymentHash: candidate.deploymentHash,
      },
      signedEnvelope: contract.candidate,
      trustedKeys,
      cutoverAuthorization: authorization,
      mapBinding: contract.mapBinding,
      uiWorldId: candidate.deployment.worldId,
    };
    const first = await applyWorldDeploymentCutover({
      ...applyInput,
      databaseRollbackProof: rollbackProof(
        beforeSnapshot,
        candidate.deployment.provenance.infraReleaseId,
      ),
      inspectRollbackSnapshot,
    });
    assert.equal(first.mode, "authorized-v1-to-v2-cutover");
    assert.equal(first.committedMode, "idempotent-v2-provisioning");
    assert.match(first.cutoverReceiptHash, /^[a-f0-9]{64}$/u);
    assert.equal(rollbackSnapshots.length, 2);
    assert.deepEqual(rollbackSnapshots[0], beforeSnapshot);
    assert.equal(rollbackSnapshots[1].authoritativeHead.worldCount, 2);
    assert.notEqual(
      rollbackSnapshots[1].authoritativeHead.stateHash,
      beforeSnapshot.authoritativeHead.stateHash,
    );

    const second = await applyWorldDeploymentCutover(applyInput);
    assert.equal(second.mode, "idempotent-v2-provisioning");
    assert.equal(second.committedMode, "idempotent-v2-provisioning");
    assert.equal(second.cutoverReceiptHash, first.cutoverReceiptHash);
    assert.equal(rollbackSnapshots.length, 2);

    const [predecessorState] = await sql.unsafe(`
      select
        world.lifecycle_status,
        profile.state as profile_state,
        profile.final_state_hash,
        deployment.planning_authority_account_id::text as authority_account_id,
        account.world_id::text as account_world_id,
        account.keycloak_subject as authority_subject,
        regional.legacy_writer_fenced
      from worlds as world
      join alpha_world_profiles as profile on profile.world_id = world.id
      join alpha_world_deployments as deployment on deployment.world_id = world.id
      join accounts as account on account.id = deployment.planning_authority_account_id
      join regional_simulation_states as regional on regional.world_id = world.id
      where world.id = $1::uuid
    `, [contract.predecessor.deployment.worldId]);
    assert.equal(predecessorState.lifecycle_status, "archived");
    assert.equal(predecessorState.profile_state, "archived");
    assert.match(predecessorState.final_state_hash, /^[a-f0-9]{64}$/u);
    assert.equal(predecessorState.authority_account_id, legacyAuthorityAccountId);
    assert.equal(predecessorState.account_world_id, contract.predecessor.deployment.worldId);
    assert.equal(
      predecessorState.authority_subject,
      "system:planning-authority:v1-v2-postgres-odoo-contract",
    );
    assert.equal(predecessorState.legacy_writer_fenced, true);

    const [candidateState] = await sql.unsafe(`
      select
        world.lifecycle_status,
        access.status as access_status,
        account.world_id::text as account_world_id,
        account.keycloak_subject,
        deployment.deployment_hash,
        deployment.planning_authority_account_id::text as authority_account_id,
        deployment.signed_deployment
      from worlds as world
      join world_accesses as access on access.world_id = world.id
      join accounts as account on account.world_id = world.id
      join alpha_world_deployments as deployment on deployment.world_id = world.id
      where world.id = $1::uuid
        and account.id = $2::uuid
        and access.keycloak_subject = account.keycloak_subject
    `, [candidate.deployment.worldId, candidate.deployment.planning.authority.accountId]);
    assert.deepEqual(candidateState, {
      lifecycle_status: "active",
      access_status: "active",
      account_world_id: candidate.deployment.worldId,
      keycloak_subject: candidate.deployment.planning.authority.keycloakSubject,
      deployment_hash: candidate.deploymentHash,
      authority_account_id: candidate.deployment.planning.authority.accountId,
      signed_deployment: contract.candidate,
    });
    assert.notEqual(candidateState.authority_account_id, legacyAuthorityAccountId);

    const receipts = await sql.unsafe(`
      select mode, predecessor_world_id::text as predecessor_world_id,
        candidate_world_id::text as candidate_world_id,
        before_authoritative_head_sha256,
        after_authoritative_head_sha256,
        receipt_hash
      from world_cutover_receipts
      where candidate_world_id = $1::uuid
    `, [candidate.deployment.worldId]);
    assert.deepEqual(receipts, [{
      mode: "authorized-v1-to-v2-cutover",
      predecessor_world_id: contract.predecessor.deployment.worldId,
      candidate_world_id: candidate.deployment.worldId,
      before_authoritative_head_sha256: rollbackSnapshots[0].authoritativeHead.stateHash,
      after_authoritative_head_sha256: rollbackSnapshots[1].authoritativeHead.stateHash,
      receipt_hash: first.cutoverReceiptHash,
    }]);

    await assert.rejects(sql.unsafe(`
      update regional_simulation_states
      set state_hash = $2
      where world_id = $1::uuid
    `, [contract.predecessor.deployment.worldId, "7".repeat(64)]), /fenced/u);
  });
});
