import {
  inspectLockedWorldCutoverDatabase,
  validateWorldDeploymentCutover,
} from "./world-deployment-cutover-preflight.mjs";
import {
  assertDatabaseRollbackProofMatchesLive,
  inspectLiveDatabaseRollbackSnapshot,
  validateStoredWorldCutoverReceipt,
  worldCutoverReceiptHash,
  worldFinalHistorySeal,
} from "./database-rollback-binding.mjs";
import {
  KEYCLOAK_TARGET_SCHEMA,
  loadKeycloakObjectCatalog,
  lockKeycloakCatalogTables,
} from "./keycloak-public-to-schema.mjs";

const CUTOVER_RECEIPT_SCHEMA = "zugfolge-world-cutover-receipt/v1";

function requireExactlyOne(rows, message) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(message);
  return rows[0];
}

function cutoverWorldIds(candidateWorldId, predecessorWorldId) {
  return [...new Set([candidateWorldId, predecessorWorldId].filter((value) => typeof value === "string"))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

async function acquireExclusiveWorldLocks(tx, worldIds) {
  for (const worldId of worldIds) {
    await tx.unsafe(
      "select pg_advisory_xact_lock(('x' || substr(md5($1::uuid::text), 1, 16))::bit(64)::bigint)",
      [worldId],
    );
  }
}

/**
 * Archiviert hoechstens den exakt freigegebenen V1-Vorgaenger und persistiert
 * den signierten V2-Kandidaten in einer einzigen Transaktion. Der exklusive,
 * weltbezogene Advisory-Lock wird vor jeder Inspektion gehalten und bildet mit
 * den dauerhaften Writer-Triggern die gemeinsame Cutover-Grenze.
 * Weder der Preflight noch die ausserhalb der Transaktion gelesene DB-Sicht
 * wird als Autoritaet wiederverwendet.
 */
export async function applyWorldDeploymentCutover({
  client,
  candidate,
  signed,
  signedEnvelope,
  trustedKeys,
  cutoverAuthorization,
  mapBinding,
  uiWorldId,
  databaseRollbackProof,
  inspectRollbackSnapshot = inspectLiveDatabaseRollbackSnapshot,
  sealWorldHistory = worldFinalHistorySeal,
}) {
  const keycloakCatalog = await loadKeycloakObjectCatalog(
    process.env.KEYCLOAK_SCHEMA_CATALOG_PATH,
  );
  return client.begin("isolation level read committed", async (tx) => {
    await acquireExclusiveWorldLocks(tx, cutoverWorldIds(
      candidate.deployment.worldId,
      cutoverAuthorization?.predecessorWorldId,
    ));

    const database = await inspectLockedWorldCutoverDatabase(
      tx,
      candidate.deployment.worldId,
    );
    const eligibility = validateWorldDeploymentCutover({
      candidate,
      database,
      mapBinding,
      uiWorldId,
      trustedKeys,
      cutoverAuthorization,
    });
    const createsCandidate = eligibility.mode === "authorized-v1-to-v2-cutover"
      || eligibility.mode === "new-v2-world";
    let beforeRollbackSnapshot;
    let predecessorFinalStateHash = null;
    let cutoverReceiptHash = null;
    if (createsCandidate) {
      if (databaseRollbackProof === undefined) {
        throw new Error("Der atomare Welt-Cutover besitzt keinen DB-gebundenen Rollbackbeleg.");
      }
      await tx.unsafe("set local lock_timeout = '10s'");
      await lockKeycloakCatalogTables(tx, KEYCLOAK_TARGET_SCHEMA, keycloakCatalog, { mode: "share" });
      beforeRollbackSnapshot = await inspectRollbackSnapshot(tx);
      assertDatabaseRollbackProofMatchesLive(databaseRollbackProof, beforeRollbackSnapshot, {
        releaseId: candidate.deployment.provenance.infraReleaseId,
      });
      if (eligibility.mode === "authorized-v1-to-v2-cutover") {
        predecessorFinalStateHash = await sealWorldHistory(
          tx,
          cutoverAuthorization.predecessorWorldId,
        );
      }
    } else {
      const storedReceipt = requireExactlyOne(await tx.unsafe(`
        select
          receipt.candidate_world_id::text as candidate_world_id,
          receipt.database_id::text as database_id,
          receipt.mode,
          receipt.predecessor_world_id::text as predecessor_world_id,
          receipt.predecessor_deployment_hash,
          receipt.predecessor_final_state_hash,
          receipt.candidate_deployment_hash,
          receipt.before_authoritative_head_sha256,
          receipt.after_authoritative_head_sha256,
          receipt.receipt_hash
        from world_cutover_receipts as receipt
        join zugfolge_database_identity as identity
          on identity.singleton = 1 and identity.database_id = receipt.database_id
        where receipt.candidate_world_id = $1::uuid
      `, [candidate.deployment.worldId]), "Die bestehende V2-Welt besitzt keinen DB-gebundenen Cutover-Receipt.");
      cutoverReceiptHash = validateStoredWorldCutoverReceipt(storedReceipt, {
        candidateWorldId: candidate.deployment.worldId,
        candidateDeploymentHash: candidate.deploymentHash,
      }).receiptHash;
    }

    if (eligibility.mode === "authorized-v1-to-v2-cutover") {
      const closingProfile = await tx.unsafe(`
        update alpha_world_profiles as profile
        set state = 'closing', final_state_hash = $3
        from alpha_world_deployments as deployment
        where profile.world_id = $1::uuid
          and profile.profile_kind = 'public'
          and profile.state = 'running'
          and profile.deployment_hash = $2
          and deployment.world_id = profile.world_id
          and deployment.deployment_hash = $2
        returning profile.world_id::text as world_id
      `, [
        cutoverAuthorization.predecessorWorldId,
        cutoverAuthorization.predecessorDeploymentHash,
        predecessorFinalStateHash,
      ]);
      requireExactlyOne(
        closingProfile,
        "Die freigegebene V1-Profilzeile konnte nicht exakt in den Schliesszustand wechseln.",
      );

      const archivedProfile = await tx.unsafe(`
        update alpha_world_profiles as profile
        set state = 'archived'
        from alpha_world_deployments as deployment
        where profile.world_id = $1::uuid
          and profile.profile_kind = 'public'
          and profile.state = 'closing'
          and profile.deployment_hash = $2
          and deployment.world_id = profile.world_id
          and deployment.deployment_hash = $2
        returning profile.world_id::text as world_id
      `, [
        cutoverAuthorization.predecessorWorldId,
        cutoverAuthorization.predecessorDeploymentHash,
      ]);
      requireExactlyOne(
        archivedProfile,
        "Die freigegebene V1-Profilzeile konnte aus dem Schliesszustand nicht exakt archiviert werden.",
      );

      const archivedWorld = await tx.unsafe(`
        update worlds
        set lifecycle_status = 'archived'
        where id = $1::uuid
          and lifecycle_status = 'active'
        returning id::text as world_id
      `, [cutoverAuthorization.predecessorWorldId]);
      requireExactlyOne(
        archivedWorld,
        "Die freigegebene V1-Welt konnte nicht exakt archiviert werden.",
      );
      await tx.unsafe(`
        update regional_simulation_states
        set legacy_writer_fenced = true
        where world_id = $1::uuid
          and state_schema = 'zugfolge-regional-simulation-state/v1'
          and legacy_writer_fenced = false
      `, [cutoverAuthorization.predecessorWorldId]);
      const fence = requireExactlyOne(await tx.unsafe(`
        select count(*)::int as unfenced
        from regional_simulation_states
        where world_id = $1::uuid
          and state_schema = 'zugfolge-regional-simulation-state/v1'
          and legacy_writer_fenced = false
      `, [cutoverAuthorization.predecessorWorldId]), "Der V1-Writer-Fence konnte nicht verifiziert werden.");
      if (fence.unfenced !== 0) {
        throw new Error("Der atomare Cutover laesst einen schreibbaren V1-Regionalzustand zurueck.");
      }
    }

    const definition = signed.deployment.worldDefinition;
    const authority = signed.deployment.planning.authority;
    await tx.unsafe(`
      insert into worlds (
        id,
        name,
        schedule_period_weeks,
        epoch,
        world_kind,
        ranking_status,
        lifecycle_status
      ) values ($1::uuid, $2, $3, $4::timestamptz, 'public', 'ranked', 'active')
      on conflict (id) do nothing
    `, [
      signed.deployment.worldId,
      definition.name,
      definition.schedulePeriodWeeks,
      definition.epoch,
    ]);
    await tx.unsafe(`
      insert into world_accesses (world_id, keycloak_subject)
      values ($1::uuid, $2)
      on conflict (world_id, keycloak_subject) do nothing
    `, [signed.deployment.worldId, authority.keycloakSubject]);
    await tx.unsafe(`
      insert into accounts (id, world_id, keycloak_subject, display_name)
      values ($1::uuid, $2::uuid, $3, $4)
      on conflict do nothing
    `, [
      authority.accountId,
      signed.deployment.worldId,
      authority.keycloakSubject,
      authority.displayName,
    ]);
    await tx.unsafe(`
      insert into alpha_world_deployments (
        world_id,
        deployment_hash,
        signed_deployment,
        planning_authority_account_id
      ) values ($1::uuid, $2, $3::jsonb, $4::uuid)
      on conflict (world_id) do nothing
    `, [
      signed.deployment.worldId,
      signed.deploymentHash,
      JSON.stringify(signedEnvelope),
      authority.accountId,
    ]);

    const stored = requireExactlyOne(await tx.unsafe(`
      select
        world.name = $2 as name_matches,
        world.schedule_period_weeks = $3 as schedule_matches,
        world.epoch = $4::timestamptz as epoch_matches,
        world.world_kind = 'public' as kind_matches,
        world.ranking_status = 'ranked' as ranking_matches,
        world.lifecycle_status = 'active' as lifecycle_matches,
        access.status = 'active' as access_matches,
        account.keycloak_subject = $5 as subject_matches,
        account.display_name = $6 as display_name_matches,
        account.erased_at is null as account_live,
        deployment.deployment_hash = $7 as deployment_hash_matches,
        deployment.planning_authority_account_id = $8::uuid as authority_matches,
        deployment.signed_deployment = $9::jsonb as signed_deployment_matches
      from worlds as world
      left join world_accesses as access
        on access.world_id = world.id and access.keycloak_subject = $5
      left join accounts as account
        on account.world_id = world.id and account.id = $8::uuid
      left join alpha_world_deployments as deployment
        on deployment.world_id = world.id
      where world.id = $1::uuid
    `, [
      signed.deployment.worldId,
      definition.name,
      definition.schedulePeriodWeeks,
      definition.epoch,
      authority.keycloakSubject,
      authority.displayName,
      signed.deploymentHash,
      authority.accountId,
      JSON.stringify(signedEnvelope),
    ]), "Die V2-Welt wurde nicht vollstaendig atomar persistiert.");
    if (Object.values(stored).some((value) => value !== true)) {
      throw new Error("Die persistierte V2-Welt widerspricht dem signierten Vertrag.");
    }

    if (createsCandidate) {
      const afterRollbackSnapshot = await inspectRollbackSnapshot(tx);
      const receiptPayload = {
        schema: CUTOVER_RECEIPT_SCHEMA,
        databaseIdentity: beforeRollbackSnapshot.databaseIdentity,
        mode: eligibility.mode,
        predecessorWorldId: eligibility.mode === "authorized-v1-to-v2-cutover"
          ? cutoverAuthorization.predecessorWorldId
          : null,
        predecessorDeploymentHash: eligibility.mode === "authorized-v1-to-v2-cutover"
          ? cutoverAuthorization.predecessorDeploymentHash
          : null,
        predecessorFinalStateHash,
        candidateWorldId: candidate.deployment.worldId,
        candidateDeploymentHash: candidate.deploymentHash,
        beforeAuthoritativeHeadSha256: beforeRollbackSnapshot.authoritativeHead.stateHash,
        afterAuthoritativeHeadSha256: afterRollbackSnapshot.authoritativeHead.stateHash,
      };
      cutoverReceiptHash = worldCutoverReceiptHash(receiptPayload);
      const receipts = await tx.unsafe(`
        insert into world_cutover_receipts (
          candidate_world_id,
          database_id,
          mode,
          predecessor_world_id,
          predecessor_deployment_hash,
          predecessor_final_state_hash,
          candidate_deployment_hash,
          before_authoritative_head_sha256,
          after_authoritative_head_sha256,
          receipt_hash
        ) values ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10)
        returning
          candidate_world_id::text as candidate_world_id,
          database_id::text as database_id,
          mode,
          predecessor_world_id::text as predecessor_world_id,
          predecessor_deployment_hash,
          predecessor_final_state_hash,
          candidate_deployment_hash,
          before_authoritative_head_sha256,
          after_authoritative_head_sha256,
          receipt_hash
      `, [
        receiptPayload.candidateWorldId,
        receiptPayload.databaseIdentity,
        receiptPayload.mode,
        receiptPayload.predecessorWorldId,
        receiptPayload.predecessorDeploymentHash,
        receiptPayload.predecessorFinalStateHash,
        receiptPayload.candidateDeploymentHash,
        receiptPayload.beforeAuthoritativeHeadSha256,
        receiptPayload.afterAuthoritativeHeadSha256,
        cutoverReceiptHash,
      ]);
      const persistedReceipt = requireExactlyOne(receipts, "Der atomare Cutover konnte keinen eindeutigen Receipt persistieren.");
      cutoverReceiptHash = validateStoredWorldCutoverReceipt(persistedReceipt, {
        databaseIdentity: receiptPayload.databaseIdentity,
        candidateWorldId: receiptPayload.candidateWorldId,
        candidateDeploymentHash: receiptPayload.candidateDeploymentHash,
      }).receiptHash;
    }

    const committedDatabase = await inspectLockedWorldCutoverDatabase(
      tx,
      candidate.deployment.worldId,
    );
    const committed = validateWorldDeploymentCutover({
      candidate,
      database: committedDatabase,
      mapBinding,
      uiWorldId,
      trustedKeys,
      cutoverAuthorization,
    });
    if (committed.mode !== "idempotent-v2-provisioning") {
      throw new Error("Die Cutover-Transaktion erzeugt keinen exakt idempotenten V2-Provisionierungszustand.");
    }

    return Object.freeze({
      ...eligibility,
      committedMode: committed.mode,
      cutoverReceiptHash,
    });
  });
}
