import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import test from "node:test";

import {
  OPERATIONAL_INITIALIZATION_HASH_SCHEMA_V2,
  WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES,
  assertProductionServerWorldEnvironment,
  alphaHash,
  inspectSignedOperationalV2Candidate,
  parseWorldDeploymentCutoverAuthorization,
  runWorldDeploymentCutoverPreflight,
  validateWorldDeploymentCutover,
} from "./world-deployment-cutover-preflight.mjs";
import { applyWorldDeploymentCutover } from "./world-deployment-cutover-apply.mjs";
import { worldCutoverReceiptHash } from "./database-rollback-binding.mjs";
import { createDatabaseRollbackProof } from "../tiles/map-release-build-evidence.mjs";
import {
  DATABASE_AUTHORITATIVE_TABLE_COUNT,
  DATABASE_AUTHORITATIVE_TABLE_SET_SHA256,
  databaseCutoverConstraintProofs,
  databaseCutoverGuardProofs,
  databaseRollbackEvidenceFixtures,
  keycloakIdentityHeadFixture,
} from "./database-rollback-test-fixtures.mjs";

const LEGACY_WORLD_ID = "00000000-0000-4000-8000-000000000014";
const V2_WORLD_ID = "00000000-0000-4000-8000-000000000315";
const KEY_ID = "world-cutover-test";
const INFRA_RELEASE_ID = "infra-deutschland-2026.4";
const DATABASE_ID = "00000000-0000-4000-8000-000000000031";

function rollbackSnapshot(stateHash = "8".repeat(64)) {
  return {
    databaseIdentity: DATABASE_ID,
    migrationLedger: Array.from({ length: 33 }, (_, index) => index + 1).map((id) => ({
      id,
      hash: id.toString(16).padStart(64, "0"),
      createdAt: 1_787_000_000_000 + id,
    })),
    constraints: databaseCutoverConstraintProofs(),
    guards: databaseCutoverGuardProofs(),
    heads: { total: 0, v2: 0, nonNullInitializationHash: 0, incompatible: 0 },
    authoritativeHead: {
      schema: "zugfolge-database-authoritative-head/v1",
      tableCount: DATABASE_AUTHORITATIVE_TABLE_COUNT,
      tableSetSha256: DATABASE_AUTHORITATIVE_TABLE_SET_SHA256,
      worldCount: 1,
      regionalStateCount: 0,
      domainEventCount: "0",
      stateHash,
    },
    keycloakIdentityHead: keycloakIdentityHeadFixture(),
  };
}

function rollbackProof() {
  const source = rollbackSnapshot();
  const evidence = databaseRollbackEvidenceFixtures(source);
  return createDatabaseRollbackProof({
    releaseId: INFRA_RELEASE_ID,
    previousReleaseId: "infra-deutschland-2026.2",
    source,
    ...evidence,
    writersQuiesced: true,
    rollbackWindow: "pre-activation-only",
  });
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const TRUSTED_KEYS = Object.freeze({ [KEY_ID]: PUBLIC_KEY_PEM });

test("Welt-Cutover verweigert ein fehlendes Scope-Mapping vor Kandidat, Karte und Datenbank", async () => {
  let externalReadStarted = false;
  await assert.rejects(
    runWorldDeploymentCutoverPreflight({
      environment: {
        DATABASE_URL: "postgres://unused.invalid/zugfolge",
        ALPHA_WORLD_RELEASE_PATH: "/unused/deployment.json",
        INFRA_RELEASE_TRUSTED_KEYS_JSON: JSON.stringify(TRUSTED_KEYS),
        ALPHA_PUBLIC_WORLD_ID: V2_WORLD_ID,
        ZUGFOLGE_WORLD_ID: V2_WORLD_ID,
        LIVEMAP_READ_MODEL_PATH: "/unused/read-model.sqlite",
      },
      loadCandidate: async () => {
        externalReadStarted = true;
        throw new Error("darf nicht erreicht werden");
      },
      inspectDatabase: async () => {
        externalReadStarted = true;
        throw new Error("darf nicht erreicht werden");
      },
      inspectMap: async () => {
        externalReadStarted = true;
        throw new Error("darf nicht erreicht werden");
      },
    }),
    /RELEASE_TRUSTED_KEY_SCOPES_JSON' fehlt/u,
  );
  assert.equal(externalReadStarted, false);
});

test("Server-/UI-Weltabweichung und fehlende Bindung stoppen vor jedem externen Vorabzugriff", async () => {
  assert.equal(assertProductionServerWorldEnvironment({ ZUGFOLGE_WORLD_ID: V2_WORLD_ID, ALPHA_PUBLIC_WORLD_ID: V2_WORLD_ID }), V2_WORLD_ID);
  for (const environment of [
    { ZUGFOLGE_WORLD_ID: LEGACY_WORLD_ID, ALPHA_PUBLIC_WORLD_ID: V2_WORLD_ID },
    { ALPHA_PUBLIC_WORLD_ID: V2_WORLD_ID },
    { ZUGFOLGE_WORLD_ID: V2_WORLD_ID },
    { ZUGFOLGE_WORLD_ID: "invalid", ALPHA_PUBLIC_WORLD_ID: "invalid" },
  ]) {
    let reads = 0;
    await assert.rejects(runWorldDeploymentCutoverPreflight({
      environment,
      loadCandidate: async () => { reads += 1; },
      inspectDatabase: async () => { reads += 1; },
      inspectMap: async () => { reads += 1; },
    }), /ZUGFOLGE_WORLD_ID|ALPHA_PUBLIC_WORLD_ID/u);
    assert.equal(reads, 0);
  }
});

function v2Deployment(worldId = V2_WORLD_ID) {
  return {
    schema: "zugfolge-alpha-world-deployment/v2",
    worldId,
    deploymentRevision: 1,
    worldDefinition: {
      name: "Deutschland 2026",
      kind: "public",
      rankingStatus: "ranked",
      schedulePeriodWeeks: 4,
      epoch: "2026-08-10T00:00:00.000Z",
    },
    repeatEveryS: 86_400,
    infraReleaseHash: "a".repeat(64),
    blueprint: {
      profileKind: "public",
      regionId: "deutschland",
      releases: { infra: "a".repeat(64) },
    },
    regionalSimulation: {
      schemaVersion: "zugfolge-operational-simulation-initialize/v2",
      worldId,
      regionId: "deutschland",
      nowMs: 0,
      protectionModeSelectionPolicy: "zugfolge-protection-mode-selection/conservative-v1",
      infraRelease: {
        schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
        infraReleaseId: INFRA_RELEASE_ID,
        file: "operational-infrastructure-v2.json",
        bytes: 1_463_733_317,
        sha256: "c".repeat(64),
        stateHash: "d".repeat(64),
      },
      vehicleTypes: [{}],
      vehicles: [{}],
      formations: [{}],
      trains: [{
        id: "program:1",
        routeVersionId: "route:1",
        formationVersionId: "formation:1",
        dispatchInterlockingRouteId: "dispatch:1",
        scheduledDepartureMs: 0,
        protectionModeSelectionRuns: [{
          throughRouteLegIndex: 0,
          selectedProtectionSystem: "pzb",
        }],
      }],
    },
    provenance: {
      infraReleaseId: INFRA_RELEASE_ID,
      operationalInfrastructureSha256: "c".repeat(64),
      operationalInfrastructureStateHash: "d".repeat(64),
      operationalSimulationSourceSha256: "b".repeat(64),
    },
    planning: {
      authority: {
        accountId: "00000000-0000-4000-8000-000000000316",
        keycloakSubject: "system:planning-authority:v2-cutover-test",
        displayName: "Planungsautoritaet",
      },
    },
  };
}

function signDeployment(deployment) {
  const deploymentHash = alphaHash(deployment.schema, deployment);
  const signature = signEd25519(null, Buffer.from(deploymentHash, "hex"), privateKey);
  return {
    deployment,
    deploymentHash,
    signature: {
      algorithm: "Ed25519",
      keyId: KEY_ID,
      valueBase64: signature.toString("base64"),
    },
  };
}

function candidate() {
  return inspectSignedOperationalV2Candidate(signDeployment(v2Deployment()), TRUSTED_KEYS);
}

function database(overrides = {}) {
  return {
    worlds: [],
    candidateRegionalStates: [],
    initializationHashColumnPresent: false,
    ...overrides,
  };
}

function validate(candidateValue, databaseValue, overrides = {}) {
  return validateWorldDeploymentCutover({
    candidate: candidateValue,
    database: databaseValue,
    mapBinding: {
      worldId: V2_WORLD_ID,
      infrastructureReleaseId: INFRA_RELEASE_ID,
      scheduleTime: {
        worldEpoch: "2026-08-10T00:00:00.000Z",
        serviceStartOffsetS: 0,
        repeatEveryS: 86_400,
      },
    },
    uiWorldId: V2_WORLD_ID,
    trustedKeys: TRUSTED_KEYS,
    ...overrides,
  });
}

function authorization(candidateValue, predecessorDeploymentHash) {
  return parseWorldDeploymentCutoverAuthorization({
    schemaVersion: "zugfolge-world-deployment-v1-v2-cutover-authorization/v1",
    predecessorWorldId: LEGACY_WORLD_ID,
    predecessorDeploymentHash,
    candidateWorldId: V2_WORLD_ID,
    candidateDeploymentHash: candidateValue.deploymentHash,
  }, candidateValue);
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error?.code, code);
    assert.match(error.message, new RegExp(`\\[${code}\\]`, "u"));
    return true;
  });
}

test("signierter Kandidat bindet Ed25519, Operational-v2 und den kanonischen initialization hash", () => {
  const deployment = v2Deployment();
  const envelope = signDeployment(deployment);
  const inspected = inspectSignedOperationalV2Candidate(envelope, TRUSTED_KEYS);

  assert.equal(inspected.deploymentHash, envelope.deploymentHash);
  assert.equal(
    inspected.initializationHash,
    alphaHash(OPERATIONAL_INITIALIZATION_HASH_SCHEMA_V2, deployment.regionalSimulation),
  );
  assert.match(inspected.initializationHash, /^[0-9a-f]{64}$/u);

  expectCode(
    () => inspectSignedOperationalV2Candidate({
      ...envelope,
      signature: { ...envelope.signature, valueBase64: Buffer.alloc(64).toString("base64") },
    }, TRUSTED_KEYS),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateSignatureInvalid,
  );
  expectCode(
    () => inspectSignedOperationalV2Candidate(
      signDeployment({ ...deployment, deploymentRevision: 2 }),
      TRUSTED_KEYS,
    ),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid,
  );
  expectCode(
    () => inspectSignedOperationalV2Candidate(signDeployment({
      ...deployment,
      regionalSimulation: {
        ...deployment.regionalSimulation,
        protectionModeSelectionPolicy: "zugfolge-protection-mode-selection/foreign-v1",
      },
    }), TRUSTED_KEYS),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid,
  );
  expectCode(
    () => inspectSignedOperationalV2Candidate(signDeployment({
      ...deployment,
      regionalSimulation: {
        ...deployment.regionalSimulation,
        trains: [{
          ...deployment.regionalSimulation.trains[0],
          protectionModeSelectionRuns: [
            { throughRouteLegIndex: 0, selectedProtectionSystem: "pzb" },
            { throughRouteLegIndex: 1, selectedProtectionSystem: "pzb" },
          ],
        }],
      },
    }), TRUSTED_KEYS),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid,
  );
});

test("realistisch signiertes aktives V1-Deployment blockiert den Cutover vor Migration", () => {
  const legacyDeployment = {
    ...v2Deployment(LEGACY_WORLD_ID),
    schema: "zugfolge-alpha-world-deployment/v1",
  };
  delete legacyDeployment.deploymentRevision;
  legacyDeployment.regionalSimulation = {
    schemaVersion: "zugfolge-operational-simulation-initialize/v1",
    worldId: LEGACY_WORLD_ID,
  };
  const signedLegacy = signDeployment(legacyDeployment);

  assert.equal(verifyEd25519(
    null,
    Buffer.from(signedLegacy.deploymentHash, "hex"),
    publicKey,
    Buffer.from(signedLegacy.signature.valueBase64, "base64"),
  ), true, "V1-Testartefakt muss wirklich Ed25519-signiert sein");

  expectCode(
    () => validate(candidate(), database({
      worlds: [{
        world_id: LEGACY_WORLD_ID,
        lifecycle_status: "active",
        profile_kind: "public",
        profile_state: "running",
        deployment_hash: signedLegacy.deploymentHash,
        signed_deployment: signedLegacy,
      }],
    })),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.activeWorldRequiresV2Cutover,
  );
});

test("exakt freigegebener signierter V1-Vorgaenger darf atomar auf die neue V2-Welt wechseln", () => {
  const inspected = candidate();
  const legacyDeployment = {
    ...v2Deployment(LEGACY_WORLD_ID),
    schema: "zugfolge-alpha-world-deployment/v1",
  };
  delete legacyDeployment.deploymentRevision;
  legacyDeployment.regionalSimulation = {
    schemaVersion: "zugfolge-operational-simulation-initialize/v1",
    worldId: LEGACY_WORLD_ID,
  };
  const signedLegacy = signDeployment(legacyDeployment);
  const databaseValue = database({
    worlds: [{
      world_id: LEGACY_WORLD_ID,
      lifecycle_status: "active",
      profile_kind: "public",
      profile_state: "running",
      deployment_hash: signedLegacy.deploymentHash,
      signed_deployment: signedLegacy,
    }],
  });
  const cutoverAuthorization = authorization(inspected, signedLegacy.deploymentHash);

  assert.equal(validate(inspected, databaseValue, { cutoverAuthorization }).mode, "authorized-v1-to-v2-cutover");
  expectCode(
    () => validate(inspected, databaseValue, {
      cutoverAuthorization: {
        ...cutoverAuthorization,
        predecessorDeploymentHash: "f".repeat(64),
      },
    }),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.activeWorldRequiresV2Cutover,
  );
});

test("archiviertes signiertes V1 plus eine wirklich neue V2-Welt besteht", () => {
  const legacy = signDeployment({
    ...v2Deployment(LEGACY_WORLD_ID),
    schema: "zugfolge-alpha-world-deployment/v1",
  });
  const result = validate(candidate(), database({
    worlds: [{
      world_id: LEGACY_WORLD_ID,
      lifecycle_status: "archived",
      profile_kind: "public",
      profile_state: "archived",
      deployment_hash: legacy.deploymentHash,
      signed_deployment: legacy,
    }],
  }));

  assert.deepEqual(result, {
    cutoverEligible: true,
    mode: "new-v2-world",
    worldId: V2_WORLD_ID,
    deploymentHash: candidate().deploymentHash,
    initializationHash: candidate().initializationHash,
    infrastructureReleaseId: INFRA_RELEASE_ID,
  });
});

test("eine archivierte Welt-ID wird nicht wiederverwendet", () => {
  expectCode(
    () => validate(candidate(), database({
      worlds: [{
        world_id: V2_WORLD_ID,
        lifecycle_status: "archived",
        profile_kind: "public",
        profile_state: "archived",
        deployment_hash: null,
        signed_deployment: null,
      }],
    })),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateWorldIdReused,
  );
});

test("UI, Livemap und bestehender Operational-Zustand muessen denselben V2-Vertrag binden", () => {
  const inspected = candidate();
  expectCode(
    () => validate(inspected, database(), { uiWorldId: LEGACY_WORLD_ID }),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.uiWorldBindingMismatch,
  );
  expectCode(
    () => validate(inspected, database(), {
      mapBinding: { worldId: LEGACY_WORLD_ID, infrastructureReleaseId: INFRA_RELEASE_ID },
    }),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.mapWorldBindingMismatch,
  );
  expectCode(
    () => validate(inspected, database(), {
      mapBinding: {
        worldId: V2_WORLD_ID,
        infrastructureReleaseId: INFRA_RELEASE_ID,
        scheduleTime: {
          worldEpoch: "2026-08-11T00:00:00.000Z",
          serviceStartOffsetS: 0,
          repeatEveryS: 86_400,
        },
      },
    }),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.mapScheduleBindingMismatch,
  );

  const signedV2 = signDeployment(v2Deployment());
  expectCode(
    () => validate(inspected, database({
      worlds: [{
        world_id: V2_WORLD_ID,
        lifecycle_status: "active",
        profile_kind: "public",
        profile_state: "running",
        deployment_hash: signedV2.deploymentHash,
        signed_deployment: signedV2,
      }],
      candidateRegionalStates: [{ region_id: "deutschland", state_schema: "zugfolge-operational-simulation-state/v2", initialization_hash: "f".repeat(64) }],
      initializationHashColumnPresent: true,
    })),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.initializationHashMismatch,
  );
});

test("nur exakt derselbe aktive V2-Vertrag darf idempotent neu starten", () => {
  const inspected = candidate();
  const signedV2 = signDeployment(v2Deployment());
  const result = validate(inspected, database({
    worlds: [{
      world_id: V2_WORLD_ID,
      lifecycle_status: "active",
      profile_kind: "public",
      profile_state: "running",
      deployment_hash: signedV2.deploymentHash,
      signed_deployment: signedV2,
    }],
    candidateRegionalStates: [{
      region_id: "deutschland",
      state_schema: "zugfolge-operational-simulation-state/v2",
      initialization_hash: inspected.initializationHash,
    }],
    initializationHashColumnPresent: true,
  }));

  assert.equal(result.mode, "idempotent-v2-restart");
  assert.equal(result.deploymentHash, inspected.deploymentHash);
});

test("V2-Restart akzeptiert nur die eine signierte Region im exakten State-Schema", () => {
  const inspected = candidate();
  const signedV2 = signDeployment(v2Deployment());
  const activeCandidate = {
    worlds: [{
      world_id: V2_WORLD_ID,
      lifecycle_status: "active",
      profile_kind: "public",
      profile_state: "running",
      deployment_hash: signedV2.deploymentHash,
      signed_deployment: signedV2,
    }],
    initializationHashColumnPresent: true,
  };
  const validState = {
    region_id: "deutschland",
    state_schema: "zugfolge-operational-simulation-state/v2",
    initialization_hash: inspected.initializationHash,
  };
  for (const candidateRegionalStates of [
    [{ ...validState, region_id: "fremd" }],
    [{ ...validState, state_schema: "zugfolge-regional-simulation-state/v1" }],
    [validState, { ...validState, region_id: "ghost" }],
  ]) {
    expectCode(
      () => validate(inspected, database({ ...activeCandidate, candidateRegionalStates })),
      WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.regionalStateBindingMismatch,
    );
  }
  const provisioning = validate(inspected, database({ ...activeCandidate, candidateRegionalStates: [] }));
  assert.equal(provisioning.mode, "idempotent-v2-provisioning");
});

function cutoverTransactionFixture({
  storedMatches = true,
  initiallyCommittedCandidate = false,
  tamperedStoredReceipt = false,
  keycloakLockBlocked = false,
} = {}) {
  const inspected = candidate();
  const legacyDeployment = {
    ...v2Deployment(LEGACY_WORLD_ID),
    schema: "zugfolge-alpha-world-deployment/v1",
  };
  delete legacyDeployment.deploymentRevision;
  legacyDeployment.regionalSimulation = {
    schemaVersion: "zugfolge-operational-simulation-initialize/v1",
    worldId: LEGACY_WORLD_ID,
  };
  const signedLegacy = signDeployment(legacyDeployment);
  const cutoverAuthorization = authorization(inspected, signedLegacy.deploymentHash);
  let committedCandidate = initiallyCommittedCandidate;
  const storedReceiptPayload = {
    schema: "zugfolge-world-cutover-receipt/v1",
    databaseIdentity: DATABASE_ID,
    mode: "authorized-v1-to-v2-cutover",
    predecessorWorldId: LEGACY_WORLD_ID,
    predecessorDeploymentHash: signedLegacy.deploymentHash,
    predecessorFinalStateHash: "7".repeat(64),
    candidateWorldId: V2_WORLD_ID,
    candidateDeploymentHash: inspected.deploymentHash,
    beforeAuthoritativeHeadSha256: "8".repeat(64),
    afterAuthoritativeHeadSha256: "9".repeat(64),
  };
  const queries = [];
  const queryCalls = [];
  const tx = {
    async unsafe(source, parameters) {
      const query = source.replace(/\s+/gu, " ").trim().toLowerCase();
      queries.push(query);
      queryCalls.push({ query, parameters: parameters ?? [] });
      if (query.startsWith("lock table") && keycloakLockBlocked) {
        throw new Error("canceling statement due to lock timeout");
      }
      if (query.includes("select to_regclass")) return [{ present: true }];
      if (query.includes("from information_schema.columns")) return [{ present: true }];
      if (query.startsWith("select count(*)::int as unfenced")) return [{ unfenced: 0 }];
      if (query.includes("from world_cutover_receipts as receipt")) {
        return [{
          candidate_world_id: storedReceiptPayload.candidateWorldId,
          database_id: storedReceiptPayload.databaseIdentity,
          mode: storedReceiptPayload.mode,
          predecessor_world_id: storedReceiptPayload.predecessorWorldId,
          predecessor_deployment_hash: storedReceiptPayload.predecessorDeploymentHash,
          predecessor_final_state_hash: storedReceiptPayload.predecessorFinalStateHash,
          candidate_deployment_hash: storedReceiptPayload.candidateDeploymentHash,
          before_authoritative_head_sha256: storedReceiptPayload.beforeAuthoritativeHeadSha256,
          after_authoritative_head_sha256: storedReceiptPayload.afterAuthoritativeHeadSha256,
          receipt_hash: tamperedStoredReceipt
            ? "f".repeat(64)
            : worldCutoverReceiptHash(storedReceiptPayload),
        }];
      }
      if (query.includes("from regional_simulation_states")) return [];
      if (query.includes("from worlds as world") && query.includes("left join alpha_world_profiles")) {
        return committedCandidate
          ? [{
              world_id: LEGACY_WORLD_ID,
              lifecycle_status: "archived",
              profile_kind: "public",
              profile_state: "archived",
              deployment_hash: signedLegacy.deploymentHash,
              signed_deployment: signedLegacy,
            }, {
              world_id: V2_WORLD_ID,
              lifecycle_status: "active",
              profile_kind: null,
              profile_state: null,
              deployment_hash: inspected.deploymentHash,
              signed_deployment: inspected.envelope,
            }]
          : [{
              world_id: LEGACY_WORLD_ID,
              lifecycle_status: "active",
              profile_kind: "public",
              profile_state: "running",
              deployment_hash: signedLegacy.deploymentHash,
              signed_deployment: signedLegacy,
            }];
      }
      if (query.startsWith("update alpha_world_profiles")) return [{ world_id: LEGACY_WORLD_ID }];
      if (query.startsWith("update worlds")) return [{ world_id: LEGACY_WORLD_ID }];
      if (query.startsWith("insert into alpha_world_deployments")) {
        committedCandidate = true;
        return [];
      }
      if (query.startsWith("insert into world_cutover_receipts")) {
        return [{
          candidate_world_id: parameters[0],
          database_id: parameters[1],
          mode: parameters[2],
          predecessor_world_id: parameters[3],
          predecessor_deployment_hash: parameters[4],
          predecessor_final_state_hash: parameters[5],
          candidate_deployment_hash: parameters[6],
          before_authoritative_head_sha256: parameters[7],
          after_authoritative_head_sha256: parameters[8],
          receipt_hash: parameters[9],
        }];
      }
      if (query.startsWith("select world.name =")) {
        return [{
          name_matches: true,
          schedule_matches: true,
          epoch_matches: true,
          kind_matches: true,
          ranking_matches: true,
          lifecycle_matches: true,
          access_matches: true,
          subject_matches: true,
          display_name_matches: true,
          account_live: true,
          deployment_hash_matches: true,
          authority_matches: true,
          signed_deployment_matches: storedMatches,
        }];
      }
      return [];
    },
  };
  let transactionOption;
  let rolledBack = false;
  const client = {
    async begin(option, callback) {
      transactionOption = option;
      try {
        return await callback(tx);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  };
  return {
    inspected,
    cutoverAuthorization,
    client,
    queries,
    queryCalls,
    inspectRollbackSnapshot: async () => {
      queryCalls.push({ query: "fixture:inspect-rollback-snapshot", parameters: [] });
      return committedCandidate ? rollbackSnapshot("9".repeat(64)) : rollbackSnapshot();
    },
    transactionState: () => ({ transactionOption, rolledBack }),
  };
}

test("atomarer Apply archiviert nur den exakten V1-Vorgaenger und endet idempotent in V2", async () => {
  const fixture = cutoverTransactionFixture();
  const result = await applyWorldDeploymentCutover({
    client: fixture.client,
    candidate: fixture.inspected,
    signed: {
      deployment: fixture.inspected.deployment,
      deploymentHash: fixture.inspected.deploymentHash,
    },
    signedEnvelope: fixture.inspected.envelope,
    trustedKeys: TRUSTED_KEYS,
    cutoverAuthorization: fixture.cutoverAuthorization,
    mapBinding: {
      worldId: V2_WORLD_ID,
      infrastructureReleaseId: INFRA_RELEASE_ID,
      scheduleTime: {
        worldEpoch: "2026-08-10T00:00:00.000Z",
        serviceStartOffsetS: 0,
        repeatEveryS: 86_400,
      },
    },
    uiWorldId: V2_WORLD_ID,
    databaseRollbackProof: rollbackProof(),
    inspectRollbackSnapshot: fixture.inspectRollbackSnapshot,
    sealWorldHistory: async () => "7".repeat(64),
  });

  assert.equal(result.mode, "authorized-v1-to-v2-cutover");
  assert.equal(result.committedMode, "idempotent-v2-provisioning");
  assert.equal(fixture.transactionState().transactionOption, "isolation level read committed");
  assert.equal(fixture.transactionState().rolledBack, false);
  const worldLocks = fixture.queryCalls.filter(({ query }) => query.includes("pg_advisory_xact_lock"));
  assert.deepEqual(worldLocks.map(({ parameters }) => parameters[0]), [LEGACY_WORLD_ID, V2_WORLD_ID]);
  assert.deepEqual(fixture.queryCalls.slice(0, 2), worldLocks);
  const keycloakLocks = fixture.queryCalls.filter(({ query }) => query.startsWith("lock table"));
  assert.equal(keycloakLocks.length, 1);
  assert.match(keycloakLocks[0].query, / in share mode$/u);
  assert.equal([...keycloakLocks[0].query.matchAll(/"keycloak"\."[a-z0-9_]+"/gu)].length, 100);
  const lockTimeoutIndex = fixture.queryCalls.findIndex(({ query }) => query === "set local lock_timeout = '10s'");
  const keycloakLockIndex = fixture.queryCalls.indexOf(keycloakLocks[0]);
  const rollbackInspectionIndex = fixture.queryCalls.findIndex(({ query }) => query === "fixture:inspect-rollback-snapshot");
  assert.equal(lockTimeoutIndex > 1, true);
  assert.equal(keycloakLockIndex > lockTimeoutIndex, true);
  assert.equal(rollbackInspectionIndex > keycloakLockIndex, true);
  assert.equal(fixture.queries.some((query) => query.startsWith("delete ") || query.startsWith("truncate ")), false);
  const profileTransitions = fixture.queries.filter((query) => query.startsWith("update alpha_world_profiles"));
  assert.equal(profileTransitions.length, 2);
  assert.match(profileTransitions[0], /set state = 'closing'.*profile\.state = 'running'/u);
  assert.match(profileTransitions[0], /final_state_hash = \$3/u);
  assert.match(profileTransitions[1], /set state = 'archived'.*profile\.state = 'closing'/u);
  const archivedWorldIndex = fixture.queries.findIndex((query) => query.startsWith("update worlds") && query.includes("lifecycle_status = 'archived'"));
  const writerFenceIndex = fixture.queries.findIndex((query) => query.startsWith("update regional_simulation_states") && query.includes("legacy_writer_fenced = true"));
  assert.equal(archivedWorldIndex >= 0, true);
  assert.equal(writerFenceIndex > archivedWorldIndex, true);
  assert.match(result.cutoverReceiptHash, /^[a-f0-9]{64}$/u);
  assert.equal(fixture.queries.some((query) => query.startsWith("insert into world_cutover_receipts")), true);
});

test("atomarer Apply bricht bei blockiertem Keycloak-Identity-Lock vor dem v3-Snapshot ab", async () => {
  const fixture = cutoverTransactionFixture({ keycloakLockBlocked: true });
  await assert.rejects(() => applyWorldDeploymentCutover({
    client: fixture.client,
    candidate: fixture.inspected,
    signed: {
      deployment: fixture.inspected.deployment,
      deploymentHash: fixture.inspected.deploymentHash,
    },
    signedEnvelope: fixture.inspected.envelope,
    trustedKeys: TRUSTED_KEYS,
    cutoverAuthorization: fixture.cutoverAuthorization,
    mapBinding: {
      worldId: V2_WORLD_ID,
      infrastructureReleaseId: INFRA_RELEASE_ID,
      scheduleTime: {
        worldEpoch: "2026-08-10T00:00:00.000Z",
        serviceStartOffsetS: 0,
        repeatEveryS: 86_400,
      },
    },
    uiWorldId: V2_WORLD_ID,
    databaseRollbackProof: rollbackProof(),
    inspectRollbackSnapshot: fixture.inspectRollbackSnapshot,
  }), /lock timeout/u);
  assert.equal(fixture.transactionState().rolledBack, true);
  assert.equal(fixture.queryCalls.some(({ query }) => query === "fixture:inspect-rollback-snapshot"), false);
});

test("atomarer Apply rollt bei abweichender persistierter Signaturhuelle vollstaendig zurueck", async () => {
  const fixture = cutoverTransactionFixture({ storedMatches: false });
  await assert.rejects(() => applyWorldDeploymentCutover({
    client: fixture.client,
    candidate: fixture.inspected,
    signed: {
      deployment: fixture.inspected.deployment,
      deploymentHash: fixture.inspected.deploymentHash,
    },
    signedEnvelope: fixture.inspected.envelope,
    trustedKeys: TRUSTED_KEYS,
    cutoverAuthorization: fixture.cutoverAuthorization,
    mapBinding: {
      worldId: V2_WORLD_ID,
      infrastructureReleaseId: INFRA_RELEASE_ID,
      scheduleTime: {
        worldEpoch: "2026-08-10T00:00:00.000Z",
        serviceStartOffsetS: 0,
        repeatEveryS: 86_400,
      },
    },
    uiWorldId: V2_WORLD_ID,
    databaseRollbackProof: rollbackProof(),
    inspectRollbackSnapshot: fixture.inspectRollbackSnapshot,
    sealWorldHistory: async () => "7".repeat(64),
  }), /widerspricht dem signierten Vertrag/u);
  assert.equal(fixture.transactionState().rolledBack, true);
});

test("idempotenter Retry verweigert einen preseeded Receipt mit nicht rekonstruierbarem Spaltenhash", async () => {
  const fixture = cutoverTransactionFixture({
    initiallyCommittedCandidate: true,
    tamperedStoredReceipt: true,
  });
  await assert.rejects(() => applyWorldDeploymentCutover({
    client: fixture.client,
    candidate: fixture.inspected,
    signed: {
      deployment: fixture.inspected.deployment,
      deploymentHash: fixture.inspected.deploymentHash,
    },
    signedEnvelope: fixture.inspected.envelope,
    trustedKeys: TRUSTED_KEYS,
    cutoverAuthorization: fixture.cutoverAuthorization,
    mapBinding: {
      worldId: V2_WORLD_ID,
      infrastructureReleaseId: INFRA_RELEASE_ID,
      scheduleTime: {
        worldEpoch: "2026-08-10T00:00:00.000Z",
        serviceStartOffsetS: 0,
        repeatEveryS: 86_400,
      },
    },
    uiWorldId: V2_WORLD_ID,
  }), /rekonstruierten kanonischen Hash/u);
  assert.equal(fixture.transactionState().rolledBack, true);
});
