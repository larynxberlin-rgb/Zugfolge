#!/usr/bin/env node
import {
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { alphaHash } from "../../packages/alpha/dist/index.js";
import { decodeEconomyValue } from "../../packages/economy/dist/index.js";
import {
  parseTrustedReleaseKeys,
  parseTrustedReleaseKeyScopes,
} from "../../apps/game-api/dist/trusted-release-keys.js";

export { alphaHash };

export const WORLD_DEPLOYMENT_SCHEMA_V2 = "zugfolge-alpha-world-deployment/v2";
export const OPERATIONAL_INITIALIZATION_SCHEMA_V2 =
  "zugfolge-operational-simulation-initialize/v2";
export const OPERATIONAL_INITIALIZATION_HASH_SCHEMA_V2 =
  "zugfolge-operational-simulation-initialization/v2";
export const OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA_V2 =
  "zugfolge-operational-infrastructure-binding/v2";
export const OPERATIONAL_INFRASTRUCTURE_FILE = "operational-infrastructure-v2.json";
export const OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY =
  "zugfolge-protection-mode-selection/conservative-v1";

export const WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES = Object.freeze({
  candidateInvalid: "world_deployment_candidate_invalid",
  candidateSignatureInvalid: "world_deployment_candidate_signature_invalid",
  activeWorldRequiresV2Cutover: "active_world_requires_operational_v2_cutover",
  activeWorldConflictsCandidate: "active_world_conflicts_v2_candidate",
  candidateWorldIdReused: "v2_candidate_world_id_reused",
  initializationHashMismatch: "operational_initialization_hash_mismatch",
  uiWorldBindingMismatch: "ui_world_binding_mismatch",
  mapWorldBindingMismatch: "livemap_world_binding_mismatch",
  mapScheduleBindingMismatch: "livemap_schedule_binding_mismatch",
  regionalStateBindingMismatch: "operational_state_binding_mismatch",
  databaseContractMissing: "world_cutover_database_contract_missing",
  cutoverAuthorizationInvalid: "world_cutover_authorization_invalid",
});
export const WORLD_DEPLOYMENT_CUTOVER_AUTHORIZATION_SCHEMA =
  "zugfolge-world-deployment-v1-v2-cutover-authorization/v1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OPERATIONAL_PROTECTION_SYSTEMS = new Set([
  "etcs-level1",
  "etcs-level2",
  "lzb",
  "pzb",
]);

export class WorldDeploymentCutoverError extends Error {
  constructor(code, message, options) {
    super(`[${code}] ${message}`, options);
    this.name = "WorldDeploymentCutoverError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new WorldDeploymentCutoverError(code, message, options);
}

function invariant(condition, code, message) {
  if (!condition) fail(code, message);
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function deploymentSchema(envelope) {
  return record(record(envelope)?.deployment)?.schema;
}

export function inspectSignedDeploymentEnvelope(value, trustedKeys, expectedSchema) {
  const envelope = record(value);
  const encodedDeployment = record(envelope?.deployment);
  const signature = record(envelope?.signature);
  invariant(envelope !== undefined && encodedDeployment !== undefined && signature !== undefined, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateSignatureInvalid, "Das signierte Weltdeployment ist unvollstaendig.");
  const deployment = decodeEconomyValue(encodedDeployment);
  invariant(typeof deployment.schema === "string" && deployment.schema === expectedSchema, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateSignatureInvalid, `Das signierte Weltdeployment verwendet nicht '${expectedSchema}'.`);
  const deploymentHash = alphaHash(deployment.schema, deployment);
  invariant(envelope.deploymentHash === deploymentHash, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateSignatureInvalid, "Der Deployment-Hash stimmt nicht mit dem signierten Inhalt ueberein.");
  invariant(signature.algorithm === "Ed25519" && typeof signature.keyId === "string" && typeof signature.valueBase64 === "string", WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateSignatureInvalid, "Die Deployment-Signatur ist unvollstaendig.");
  const key = trustedKeys[signature.keyId];
  invariant(typeof key === "string", WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateSignatureInvalid, `Deployment-Schluessel '${signature.keyId}' ist nicht vertrauenswuerdig.`);
  const signatureBytes = Buffer.from(signature.valueBase64, "base64");
  let validSignature = false;
  try {
    validSignature = signatureBytes.length === 64 && verifySignature(
      null,
      Buffer.from(deploymentHash, "hex"),
      createPublicKey(key),
      signatureBytes,
    );
  } catch {
    validSignature = false;
  }
  invariant(validSignature, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateSignatureInvalid, "Die Ed25519-Signatur des Weltdeployments ist ungueltig.");
  return Object.freeze({ envelope: value, deployment, deploymentHash });
}

export function parseWorldDeploymentCutoverAuthorization(value, candidate) {
  if (value === undefined || value === null || value === "") return undefined;
  let authorization = value;
  if (typeof value === "string") {
    try {
      authorization = JSON.parse(value);
    } catch (cause) {
      fail(WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.cutoverAuthorizationInvalid, "Die V1-V2-Cutover-Freigabe ist kein gueltiges JSON.", { cause });
    }
  }
  const parsed = record(authorization);
  invariant(
    parsed !== undefined
      && Object.keys(parsed).sort().join("\u0000")
        === ["schemaVersion", "predecessorWorldId", "predecessorDeploymentHash", "candidateWorldId", "candidateDeploymentHash"].sort().join("\u0000")
      && parsed.schemaVersion === WORLD_DEPLOYMENT_CUTOVER_AUTHORIZATION_SCHEMA
      && typeof parsed.predecessorWorldId === "string"
      && UUID.test(parsed.predecessorWorldId)
      && typeof parsed.predecessorDeploymentHash === "string"
      && SHA256.test(parsed.predecessorDeploymentHash)
      && parsed.candidateWorldId === candidate.deployment.worldId
      && parsed.candidateDeploymentHash === candidate.deploymentHash
      && parsed.predecessorWorldId !== parsed.candidateWorldId,
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.cutoverAuthorizationInvalid,
    "Die V1-V2-Cutover-Freigabe bindet nicht exakt Vorgaenger und signierten Kandidaten.",
  );
  return Object.freeze({ ...parsed });
}

/**
 * Fruehe, eigenstaendige Signatur- und V2-Bindungspruefung. Der regulaere
 * Game-Parser wird danach zusaetzlich ausgefuehrt; diese Pruefung darf daher
 * vor der DB-Migration laufen und liefert trotzdem einen stabilen Fehlercode.
 */
export function inspectSignedOperationalV2Candidate(value, trustedKeys) {
  const envelope = record(value);
  const encodedDeployment = record(envelope?.deployment);
  const signature = record(envelope?.signature);
  invariant(envelope !== undefined && encodedDeployment !== undefined && signature !== undefined, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Das signierte Weltdeployment ist unvollstaendig.");

  const deployment = decodeEconomyValue(encodedDeployment);
  const worldDefinition = record(deployment.worldDefinition);
  const blueprint = record(deployment.blueprint);
  const releases = record(blueprint?.releases);
  const operational = record(deployment.regionalSimulation);
  const operationalInfra = record(operational?.infraRelease);
  const provenance = record(deployment.provenance);
  invariant(deployment.schema === WORLD_DEPLOYMENT_SCHEMA_V2, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Nur ein neues Weltdeployment im Schema v2 darf den Cutover starten.");
  invariant(typeof deployment.worldId === "string" && UUID.test(deployment.worldId), WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Das V2-Deployment besitzt keine gueltige Welt-ID.");
  invariant(deployment.deploymentRevision === 1, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Eine neue V2-Welt muss mit Deployment-Revision 1 beginnen.");
  invariant(worldDefinition?.kind === "public" && worldDefinition.rankingStatus === "ranked", WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Der Produktions-Cutover braucht eine signierte gewertete Public-Welt.");
  invariant(
    typeof worldDefinition.epoch === "string"
      && new Date(worldDefinition.epoch).toISOString() === worldDefinition.epoch
      && Number.isSafeInteger(deployment.repeatEveryS)
      && deployment.repeatEveryS > 0,
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid,
    "Der V2-Kandidat besitzt keinen kanonischen Schedule-Zeitvertrag.",
  );
  invariant(blueprint?.profileKind === "public" && typeof blueprint.regionId === "string" && blueprint.regionId !== "", WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Der V2-Weltentwurf ist nicht als Public-Welt gebunden.");
  invariant(operational?.schemaVersion === OPERATIONAL_INITIALIZATION_SCHEMA_V2, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Der Kandidat enthaelt keinen Operational-v2-Initialisierungsvertrag.");
  invariant(operational.worldId === deployment.worldId && operational.regionId === blueprint.regionId, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Operational-v2 ist nicht an Welt und Region des Kandidaten gebunden.");
  invariant(Number.isSafeInteger(operational.nowMs) && operational.nowMs >= 0, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Operational-v2 besitzt keinen gueltigen Startzeitpunkt.");
  invariant(
    operational.protectionModeSelectionPolicy === OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid,
    "Operational-v2 besitzt keine bekannte versionierte Zugsicherungs-Auswahlpolicy.",
  );
  invariant(
    ["vehicleTypes", "vehicles", "formations", "trains"].every(
      (key) => Array.isArray(operational[key]) && operational[key].length > 0,
    ),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid,
    "Operational-v2 besitzt keinen vollstaendigen Fleet- und Programmvertrag.",
  );
  const programIds = new Set();
  for (const value of operational.trains) {
    const train = record(value);
    const selectionRuns = train?.protectionModeSelectionRuns;
    invariant(
      train !== undefined
        && typeof train.id === "string"
        && train.id !== ""
        && !programIds.has(train.id)
        && typeof train.routeVersionId === "string"
        && train.routeVersionId !== ""
        && typeof train.formationVersionId === "string"
        && train.formationVersionId !== ""
        && typeof train.dispatchInterlockingRouteId === "string"
        && train.dispatchInterlockingRouteId !== ""
        && Number.isSafeInteger(train.scheduledDepartureMs)
        && train.scheduledDepartureMs >= 0
        && Array.isArray(selectionRuns)
        && selectionRuns.length > 0,
      WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid,
      "Operational-v2 besitzt eine unvollstaendige oder doppelte Programmfahrt.",
    );
    let firstRouteLegIndex = 0;
    let previousSystem;
    for (const value of selectionRuns) {
      const run = record(value);
      invariant(
        run !== undefined
          && Object.keys(run).sort().join("\u0000")
            === ["throughRouteLegIndex", "selectedProtectionSystem"].sort().join("\u0000")
          && Number.isSafeInteger(run.throughRouteLegIndex)
          && run.throughRouteLegIndex >= firstRouteLegIndex
          && OPERATIONAL_PROTECTION_SYSTEMS.has(run.selectedProtectionSystem)
          && run.selectedProtectionSystem !== previousSystem,
        WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid,
        `Operational-v2-Programmfahrt '${train.id}' besitzt keine kanonische Zugsicherungsmodus-Auswahl.`,
      );
      firstRouteLegIndex = run.throughRouteLegIndex + 1;
      previousSystem = run.selectedProtectionSystem;
    }
    programIds.add(train.id);
  }
  invariant(
    operationalInfra?.schemaVersion === OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA_V2
      && Object.keys(operationalInfra).sort().join("\u0000")
        === ["schemaVersion", "infraReleaseId", "file", "bytes", "sha256", "stateHash"].sort().join("\u0000")
      && typeof provenance?.infraReleaseId === "string"
      && provenance.infraReleaseId !== ""
      && operationalInfra.infraReleaseId === provenance.infraReleaseId
      && operationalInfra.file === OPERATIONAL_INFRASTRUCTURE_FILE
      && Number.isSafeInteger(operationalInfra.bytes)
      && operationalInfra.bytes > 0
      && typeof operationalInfra.sha256 === "string"
      && SHA256.test(operationalInfra.sha256)
      && operationalInfra.sha256 === provenance.operationalInfrastructureSha256
      && typeof operationalInfra.stateHash === "string"
      && SHA256.test(operationalInfra.stateHash)
      && operationalInfra.stateHash === provenance.operationalInfrastructureStateHash,
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid,
    "Operational-v2 ist nicht bytegenau an die externe Infrastrukturdatei gebunden.",
  );
  invariant(typeof deployment.infraReleaseHash === "string" && deployment.infraReleaseHash === releases?.infra, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Weltentwurf und Deployment besitzen verschiedene Infrastruktur-Hashes.");
  invariant(typeof provenance.operationalSimulationSourceSha256 === "string" && SHA256.test(provenance.operationalSimulationSourceSha256), WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Operational-v2 besitzt keinen gebundenen Quellhash.");

  const { deploymentHash } = inspectSignedDeploymentEnvelope(
    value,
    trustedKeys,
    WORLD_DEPLOYMENT_SCHEMA_V2,
  );

  return Object.freeze({
    envelope: value,
    deployment,
    deploymentHash,
    initializationHash: alphaHash(OPERATIONAL_INITIALIZATION_HASH_SCHEMA_V2, operational),
  });
}

async function loadSignedOperationalV2Candidate(path, trustedKeys, parseRuntimeCandidate) {
  let envelope;
  try {
    envelope = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (cause) {
    fail(WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Das Weltdeployment ist kein lesbares JSON-Artefakt.", { cause });
  }
  const inspected = inspectSignedOperationalV2Candidate(envelope, trustedKeys);
  const runtimeParser = parseRuntimeCandidate ?? (await import("../../apps/game-api/dist/alpha-world-start.js")).parseSignedAlphaWorldDeployment;
  try {
    const parsed = runtimeParser(envelope, trustedKeys);
    invariant(parsed.deploymentHash === inspected.deploymentHash, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Preflight und Game-Runtime ermitteln verschiedene Deployment-Hashes.");
  } catch (cause) {
    if (cause instanceof WorldDeploymentCutoverError) throw cause;
    fail(WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, "Der regulaere Game-Parser lehnt den V2-Kandidaten ab.", { cause });
  }
  return inspected;
}

async function relationExists(sql, qualifiedName) {
  const [row] = await sql.unsafe("select to_regclass($1) is not null as present", [qualifiedName]);
  return row?.present === true;
}

const tableExists = (sql, name) => relationExists(sql, `public.${name}`);

async function inspectExistingWorldCutoverDatabase(sql, candidateWorldId, beforeMigration = false) {
  const worlds = await sql.unsafe(`
    select
      world.id::text as world_id,
      world.lifecycle_status,
      profile.profile_kind,
      profile.state as profile_state,
      deployment.deployment_hash,
      deployment.signed_deployment
    from worlds as world
    left join alpha_world_profiles as profile on profile.world_id = world.id
    left join alpha_world_deployments as deployment on deployment.world_id = world.id
    order by world.id
  `);

  let candidateRegionalStates = [];
  let initializationHashColumnPresent = false;
  if (await tableExists(sql, "regional_simulation_states")) {
    const [column] = await sql.unsafe(`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'regional_simulation_states'
          and column_name = 'initialization_hash'
      ) as present
    `);
    initializationHashColumnPresent = column?.present === true;
    candidateRegionalStates = initializationHashColumnPresent
      ? await sql.unsafe(`
          select region_id, state_schema, initialization_hash
          from regional_simulation_states
          where world_id = $1::uuid
          order by region_id
        `, [candidateWorldId])
      : await sql.unsafe(`
          select region_id, state_schema, null::text as initialization_hash
          from regional_simulation_states
          where world_id = $1::uuid
          order by region_id
        `, [candidateWorldId]);
  }

  return Object.freeze({
    // Vor Schema 35 werden stillgelegte Lernwelten erst durch die anschliessende Migration entfernt.
    worlds: beforeMigration ? worlds.filter((row) => row.profile_kind !== "tutorial") : worlds,
    candidateRegionalStates,
    initializationHashColumnPresent,
  });
}

/**
 * Zweite Cutover-Pruefung innerhalb derselben gesperrten Schreibtransaktion,
 * die anschliessend archiviert und anlegt. Anders als der Vor-Migrations-
 * Preflight akzeptiert diese Grenze keinen leeren oder teilweisen DB-Vertrag.
 */
export async function inspectLockedWorldCutoverDatabase(sql, candidateWorldId) {
  const requiredTables = [
    "worlds",
    "alpha_world_profiles",
    "alpha_world_deployments",
    "regional_simulation_states",
  ];
  const present = await Promise.all(requiredTables.map((name) => tableExists(sql, name)));
  invariant(
    present.every(Boolean),
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.databaseContractMissing,
    "Die atomare Cutover-Transaktion besitzt nicht alle erforderlichen Welt- und Operational-Tabellen.",
  );
  return inspectExistingWorldCutoverDatabase(sql, candidateWorldId);
}

export async function inspectWorldCutoverDatabase(databaseUrl, candidateWorldId) {
  const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const postgresModule = requireFromDb("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const client = postgres(databaseUrl, { max: 1 });
  try {
    return await client.begin(async (sql) => {
      await sql.unsafe("set transaction read only");
      const requiredTables = ["worlds", "alpha_world_profiles", "alpha_world_deployments"];
      const present = await Promise.all(requiredTables.map((name) => tableExists(sql, name)));
      const migrationJournalPresent = await relationExists(sql, "drizzle.__drizzle_migrations");
      const knownGameFootprintPresent = (await Promise.all([
        "accounts",
        "domain_events",
        "regional_simulation_states",
      ].map((name) => tableExists(sql, name)))).some(Boolean);
      if (
        present.every((value) => value === false)
        && migrationJournalPresent === false
        && knownGameFootprintPresent === false
      ) {
        return Object.freeze({
          worlds: [],
          candidateRegionalStates: [],
          initializationHashColumnPresent: false,
        });
      }
      invariant(present.every(Boolean), WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.databaseContractMissing, "Die Alpha-Welt-/Deploymenttabellen fehlen im Vor-Migrationsstand.");

      return inspectExistingWorldCutoverDatabase(sql, candidateWorldId, true);
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

function requireEnvironment(environment, name) {
  const value = environment[name];
  invariant(typeof value === "string" && value.trim() !== "", WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid, `Umgebungsvariable '${name}' fehlt.`);
  return value;
}

export function validateWorldDeploymentCutover({
  candidate,
  database,
  mapBinding,
  uiWorldId,
  trustedKeys,
  cutoverAuthorization,
}) {
  const candidateWorldId = candidate.deployment.worldId;
  invariant(uiWorldId === candidateWorldId, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.uiWorldBindingMismatch, `UI-Welt '${uiWorldId}' weicht vom V2-Kandidaten '${candidateWorldId}' ab.`);
  invariant(mapBinding?.worldId === candidateWorldId, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.mapWorldBindingMismatch, `Livemap-Welt '${mapBinding?.worldId ?? "fehlend"}' weicht vom V2-Kandidaten '${candidateWorldId}' ab.`);
  invariant(mapBinding.infrastructureReleaseId === candidate.deployment.provenance.infraReleaseId, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.mapWorldBindingMismatch, "Livemap und V2-Kandidat sind an verschiedene Infrastrukturreleases gebunden.");
  const mapSchedule = record(mapBinding.scheduleTime);
  invariant(
    mapSchedule?.worldEpoch === candidate.deployment.worldDefinition.epoch
      && mapSchedule.repeatEveryS === candidate.deployment.repeatEveryS
      && mapSchedule.serviceStartOffsetS === 0,
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.mapScheduleBindingMismatch,
    "Livemap und V2-Kandidat besitzen verschiedene Schedule-Zeitachsen.",
  );

  // Archivierte V1-Huellen bleiben unveraenderte Audit-Historie. Der neue
  // Runtimepfad interpretiert oder verifiziert sie nicht; nur aktive Welten
  // duerfen den folgenden Operational-v2-Vertrag erreichen.
  const activeWorlds = database.worlds.filter((row) => row.lifecycle_status === "active");
  const activeLegacyWorlds = activeWorlds.filter(
    (row) => deploymentSchema(row.signed_deployment) !== WORLD_DEPLOYMENT_SCHEMA_V2,
  );
  if (activeLegacyWorlds.length > 0) {
    invariant(cutoverAuthorization !== undefined, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.activeWorldRequiresV2Cutover, `Aktive Welt '${activeLegacyWorlds[0].world_id}' benoetigt eine explizite bytegenaue V1-V2-Cutover-Freigabe.`);
    invariant(activeWorlds.length === 1 && activeLegacyWorlds.length === 1, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.activeWorldConflictsCandidate, "Der V1-V2-Cutover erlaubt genau eine aktive Vorgaengerwelt.");
    const active = activeLegacyWorlds[0];
    invariant(
      active.world_id === cutoverAuthorization.predecessorWorldId
        && active.deployment_hash === cutoverAuthorization.predecessorDeploymentHash
        && active.profile_kind === "public"
        && active.profile_state === "running",
      WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.activeWorldRequiresV2Cutover,
      "Die aktive V1-Welt stimmt nicht exakt mit der Cutover-Freigabe ueberein.",
    );
    const predecessor = inspectSignedDeploymentEnvelope(
      active.signed_deployment,
      trustedKeys,
      "zugfolge-alpha-world-deployment/v1",
    );
    invariant(
      predecessor.deploymentHash === cutoverAuthorization.predecessorDeploymentHash
        && predecessor.deployment.worldId === cutoverAuthorization.predecessorWorldId,
      WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.activeWorldRequiresV2Cutover,
      "Der signierte V1-Vorgaenger stimmt nicht mit der Cutover-Freigabe ueberein.",
    );
  }
  for (const active of activeWorlds) {
    const schema = deploymentSchema(active.signed_deployment);
    if (schema !== WORLD_DEPLOYMENT_SCHEMA_V2) continue;
    invariant(active.world_id === candidateWorldId, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.activeWorldConflictsCandidate, `Aktive Welt '${active.world_id}' ist nicht der freigegebene V2-Kandidat '${candidateWorldId}'.`);
    const stored = inspectSignedOperationalV2Candidate(active.signed_deployment, trustedKeys);
    invariant(active.deployment_hash === stored.deploymentHash && stored.deploymentHash === candidate.deploymentHash, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.activeWorldConflictsCandidate, "Die aktive V2-Welt entspricht nicht bytegebunden dem freigegebenen Kandidaten.");
  }

  const candidateRows = database.worlds.filter((row) => row.world_id === candidateWorldId);
  if (candidateRows.length > 0) {
    invariant(candidateRows.length === 1 && candidateRows[0].lifecycle_status === "active", WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateWorldIdReused, `Welt-ID '${candidateWorldId}' ist bereits historisch belegt und darf fuer den Cutover nicht wiederverwendet werden.`);
  } else {
    invariant(database.candidateRegionalStates.length === 0, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateWorldIdReused, `Operational-Zustand fuer die neue Welt-ID '${candidateWorldId}' existiert bereits.`);
  }

  if (database.candidateRegionalStates.length > 0) {
    invariant(database.initializationHashColumnPresent === true, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.initializationHashMismatch, "Der aktive V2-Zustand besitzt keine initialization_hash-Spalte.");
    invariant(
      database.candidateRegionalStates.length === 1
        && database.candidateRegionalStates[0].region_id === candidate.deployment.blueprint.regionId
        && database.candidateRegionalStates[0].state_schema === "zugfolge-operational-simulation-state/v2",
      WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.regionalStateBindingMismatch,
      "Der persistierte Operational-Zustand entspricht nicht exakt der signierten Welt-/Regionsmenge und dem V2-Schema.",
    );
    invariant(database.candidateRegionalStates[0].initialization_hash === candidate.initializationHash, WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.initializationHashMismatch, "Der aktive Operational-Zustand stammt nicht aus der signierten V2-Initialisierung.");
  }

  return Object.freeze({
    cutoverEligible: true,
    mode: candidateRows.length === 0
      ? activeLegacyWorlds.length === 1 ? "authorized-v1-to-v2-cutover" : "new-v2-world"
      : database.candidateRegionalStates.length === 0
        ? "idempotent-v2-provisioning"
        : "idempotent-v2-restart",
    worldId: candidateWorldId,
    deploymentHash: candidate.deploymentHash,
    initializationHash: candidate.initializationHash,
    infrastructureReleaseId: candidate.deployment.provenance.infraReleaseId,
  });
}

export async function runWorldDeploymentCutoverPreflight({
  environment = process.env,
  loadCandidate = loadSignedOperationalV2Candidate,
  inspectDatabase = inspectWorldCutoverDatabase,
  inspectMap,
  parseRuntimeCandidate,
} = {}) {
  const uiWorldId = assertProductionServerWorldEnvironment(environment);
  const databaseUrl = requireEnvironment(environment, "DATABASE_URL");
  const deploymentPath = requireEnvironment(environment, "ALPHA_WORLD_RELEASE_PATH");
  const trustedReleaseKeys = parseTrustedReleaseKeys(
    requireEnvironment(environment, "INFRA_RELEASE_TRUSTED_KEYS_JSON"),
  );
  const trustedKeys = parseTrustedReleaseKeyScopes(
    requireEnvironment(environment, "RELEASE_TRUSTED_KEY_SCOPES_JSON"),
    trustedReleaseKeys,
  ).alphaWorldDeployments;
  const readModelPath = requireEnvironment(environment, "LIVEMAP_READ_MODEL_PATH");
  const mapInspector = inspectMap ?? (await import("../tiles/livemap-read-model.mjs")).inspectPublicReadModel;

  const candidate = await loadCandidate(deploymentPath, trustedKeys, parseRuntimeCandidate);
  const cutoverAuthorization = parseWorldDeploymentCutoverAuthorization(
    environment["ALPHA_WORLD_V2_CUTOVER_AUTHORIZATION_JSON"],
    candidate,
  );
  const [database, mapBinding] = await Promise.all([
    inspectDatabase(databaseUrl, candidate.deployment.worldId),
    mapInspector(resolve(readModelPath)),
  ]);
  return validateWorldDeploymentCutover({
    candidate,
    database,
    mapBinding,
    uiWorldId,
    trustedKeys,
    cutoverAuthorization,
  });
}

/** Stoppt vor Kandidaten-/Karten-I/O und insbesondere vor einer DB-Mutation. */
export function assertProductionServerWorldEnvironment(environment) {
  const worldId = requireEnvironment(environment, "ZUGFOLGE_WORLD_ID");
  const uiWorldId = requireEnvironment(environment, "ALPHA_PUBLIC_WORLD_ID");
  invariant(UUID.test(worldId) && worldId === uiWorldId,
    WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.uiWorldBindingMismatch,
    "ZUGFOLGE_WORLD_ID und ALPHA_PUBLIC_WORLD_ID muessen dieselbe kanonische Hauptwelt-UUID binden.");
  return worldId;
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const result = await runWorldDeploymentCutoverPreflight();
    process.stdout.write(`${JSON.stringify({
      action: "world-deployment-cutover-preflight",
      ...result,
    })}\n`);
  } catch (error) {
    const code = error instanceof WorldDeploymentCutoverError
      ? error.code
      : WORLD_DEPLOYMENT_CUTOVER_ERROR_CODES.candidateInvalid;
    process.stderr.write(`${JSON.stringify({
      action: "world-deployment-cutover-preflight",
      cutoverEligible: false,
      errorCode: code,
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 65;
  }
}
