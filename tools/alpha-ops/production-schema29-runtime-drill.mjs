import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, posix as posixPath, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertProductionColdBackupReceiptUnchanged,
  inspectColdDatabase,
  inspectFilestoreTree,
  readProductionColdBackupReceipt,
} from "./production-cold-backup.mjs";
import {
  assertProductionSchema29RuntimeBeforeReceiptUnchanged,
  inspectSchema29GameRuntimeHeads,
  readProductionSchema29RuntimeBeforeReceipt,
} from "./production-schema29-runtime-snapshot.mjs";
import {
  inspectSchema29OdooFilestore,
  readSchema29OdooFilestoreOpenReceipt,
  readSchema29OdooFilestoreSealReceipt,
  validateLegacyOdooSchema29WriteProbe,
} from "./schema29-odoo-filestore-access.mjs";

const RECEIPT_SCHEMA = "zugfolge-production-schema29-runtime-drill/v2";
const GAME_PROBE_SCHEMA = "zugfolge-legacy-schema29-write-probe/v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const SAFE_DATABASE = /^[a-z0-9_]+$/u;
const DEFAULT_JSON_MAX_BYTES = 4_194_304n;
const WORLD_DEPLOYMENT_JSON_MAX_BYTES = 16_777_216n;
const SCHEMA29_GAME_RUNTIME_READY_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const SCHEMA29_GAME_RUNTIME_READY_RETRY_MS = 5_000;
const LEGACY_KEYCLOAK_IMAGE_REFERENCE = "quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13";
const REQUIRED_KEYCLOAK_CLIENTS = Object.freeze(["game-api", "game-web", "livemap", "operations-center", "provisioner"]);
const REQUIRED_SERVICES = Object.freeze([
  "odoo-postgres",
  "postgres",
  "production-schema29-runtime-qualify",
  "recovery-verify-odoo-postgres",
  "recovery-verify-postgres",
  "schema29-game-runtime",
  "schema29-keycloak-runtime",
  "schema29-odoo-runtime",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
  return value;
}

function requiredNumericIdentity(environment, name) {
  const value = requiredEnvironment(environment, name);
  invariant(/^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value)), `${name} muss eine numerische Nicht-root-Identitaet sein.`);
  return Number(value);
}

function exactKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt.`);
  invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} besitzt fremde oder fehlende Felder.`);
  return value;
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

function sameValue(left, right) {
  return JSON.stringify(sortedValue(left)) === JSON.stringify(sortedValue(right));
}

function imageDigestFromReference(reference, label) {
  const digest = reference.startsWith("sha256:") ? reference : reference.split("@").at(-1);
  invariant(typeof digest === "string" && DIGEST.test(digest), `${label} ist keine unveraenderliche Image-Referenz.`);
  return digest;
}

function databaseNameFromUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} ist keine PostgreSQL-URL.`); }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  invariant((parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") && SAFE_DATABASE.test(database), `${label} besitzt keine sichere Datenbank.`);
  return database;
}

function exactHostFilestorePath(value, databaseName, label) {
  invariant(
    posixPath.isAbsolute(value)
      && posixPath.normalize(value) === value
      && posixPath.dirname(value) !== "/"
      && posixPath.basename(value) === databaseName,
    `${label} ist kein enger absoluter Hostpfad fuer die gebundene Runtime-Datenbank.`,
  );
  return value;
}

async function stableJson(path, label, maxBytes = DEFAULT_JSON_MAX_BYTES) {
  const absolute = resolve(path);
  let before;
  try { before = await lstat(absolute, { bigint: true }); } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} fehlt.`);
    throw error;
  }
  invariant(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= maxBytes, `${label} ist keine sichere JSON-Datei.`);
  const bytes = await readFile(absolute);
  const after = await lstat(absolute, { bigint: true });
  invariant(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs, `${label} aenderte sich beim Lesen.`);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} ist kein gueltiges JSON.`); }
  return Object.freeze({ absolute, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), value, identity: before, maxBytes });
}

async function assertJsonUnchanged(artifact, label) {
  const after = await stableJson(artifact.absolute, label, artifact.maxBytes);
  invariant(after.identity.dev === artifact.identity.dev && after.identity.ino === artifact.identity.ino && after.sha256 === artifact.sha256, `${label} wurde nach der Validierung ausgetauscht.`);
}

async function containedOutput(rootPath, outputPath) {
  const root = await realpath(rootPath);
  const status = await lstat(root);
  invariant(status.isDirectory() && !status.isSymbolicLink() && root !== resolve(sep), "Schema-29-Runtime-Evidence-Wurzel ist ungueltig.");
  const absolute = resolve(outputPath);
  invariant(await realpath(dirname(absolute)) === root, "Schema-29-Runtime-Beleg muss direkt in der Evidence-Wurzel liegen.");
  invariant(/^[a-z0-9][a-z0-9._-]*\.json$/u.test(basename(absolute)), "Schema-29-Runtime-Beleg besitzt keinen sicheren Dateinamen.");
  try { await lstat(absolute); } catch (error) { if (error?.code === "ENOENT") return absolute; throw error; }
  throw new Error("Schema-29-Runtime-Beleg existiert bereits; die Qualifikation ist create-new.");
}

async function publishCreateNew(path, value) {
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let linked = false;
  try {
    await handle.writeFile(`${JSON.stringify(sortedValue(value), null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await link(temporary, path);
    linked = true;
    await unlink(temporary);
  } catch (error) {
    try { await handle.close(); } catch { /* ursprünglicher Fehler bleibt maßgeblich */ }
    if (linked) { try { await unlink(path); } catch { /* nur eigene Datei */ } }
    try { await unlink(temporary); } catch { /* ursprünglicher Fehler bleibt maßgeblich */ }
    throw error;
  }
}

function validateGameProbe(value, expected) {
  exactKeys(value, ["afterUpdatedAt", "beforeUpdatedAt", "legacyImageDigest", "migrationCount", "previousWorldId", "receiptHash", "recoveryId", "rolledBack", "schema", "transientUpdatedAt"], "Legacy-Game-Schema-29-Probe");
  invariant(value.schema === GAME_PROBE_SCHEMA && value.recoveryId === expected.recoveryId && value.previousWorldId === expected.previousWorldId, "Legacy-Game-Schema-29-Probe gehoert nicht zur Recovery-Welt.");
  invariant(value.legacyImageDigest === expected.gameImageDigest && value.migrationCount === 29, "Legacy-Game-Schema-29-Probe bindet nicht den alten Digest und Schema 29.");
  invariant(value.rolledBack === true && value.beforeUpdatedAt === value.afterUpdatedAt && value.transientUpdatedAt !== value.beforeUpdatedAt, "Legacy-Game-Schema-29-Probe belegt keinen zurueckgerollten App-Adapter-Schreibzugriff.");
  const { receiptHash, ...payload } = value;
  invariant(SHA256.test(receiptHash) && receiptHash === canonicalSha256(payload), "Legacy-Game-Schema-29-Probe besitzt keinen kanonischen Hash.");
  return value;
}

function validateGameRestoreReceipt(value, expected) {
  exactKeys(value, ["database", "dumpSha256", "identical", "manifestSha256", "migrationCount", "recoveryId", "schema"], "Schema-29-Game-Runtime-Restore-Receipt");
  invariant(value.schema === "zugfolge-production-game-restore/v1" && value.recoveryId === expected.recoveryId && value.database === expected.gameDatabase, "Schema-29-Game-Runtime-Restore-Receipt bindet nicht das create-new-Runtimeziel.");
  invariant(value.identical === true && value.migrationCount === 29 && value.dumpSha256 === expected.baseline.game.dumpSha256 && value.manifestSha256 === expected.baseline.game.manifestSha256, "Schema-29-Game-Runtime-Restore-Receipt bindet nicht das kalte Baseline-Backup.");
  return value;
}

function validateOdooRestoreReceipt(value, expected) {
  exactKeys(value, ["authoritativeStateSha256", "database", "databaseSha256", "filestoreArchiveSha256", "filestoreTreeSha256", "identical", "recoveryId", "schema"], "Schema-29-Odoo-Runtime-Restore-Receipt");
  invariant(value.schema === "zugfolge-production-odoo-restore/v1" && value.recoveryId === expected.recoveryId && value.database === expected.odooDatabase, "Schema-29-Odoo-Runtime-Restore-Receipt bindet nicht das create-new-Runtimeziel.");
  invariant(value.identical === true && value.databaseSha256 === expected.baseline.odoo.databaseDumpSha256 && value.filestoreArchiveSha256 === expected.baseline.odoo.filestoreArchiveSha256, "Schema-29-Odoo-Runtime-Restore-Receipt bindet nicht die kalten Backupbytes.");
  invariant(value.authoritativeStateSha256 === expected.pristine.authoritativeStateSha256 && value.filestoreTreeSha256 === expected.baseline.odoo.filestoreTreeSha256, "Schema-29-Odoo-Runtime-Restore-Receipt bindet nicht Producerzustand und Filestore des qualifizierten pristine Restore-Receipts.");
  return value;
}

function validatePristineOdooRestoreReceipt(value, expected) {
  exactKeys(value, ["authoritativeStateSha256", "database", "databaseSha256", "filestoreArchiveSha256", "filestoreTreeSha256", "identical", "recoveryId", "schema"], "Schema-29-Odoo-Pristine-Restore-Receipt");
  invariant(
    value.schema === "zugfolge-production-odoo-restore/v1"
      && value.recoveryId === expected.recoveryId
      && value.database === databaseNameFromUrl(expected.pristineOdooUrl, "Pristiner Schema-29-Odoo-Restore"),
    "Schema-29-Odoo-Pristine-Restore-Receipt bindet nicht das qualifizierte pristine Restoreziel.",
  );
  invariant(
    value.identical === true
      && SHA256.test(value.authoritativeStateSha256)
      && value.databaseSha256 === expected.baseline.odoo.databaseDumpSha256
      && value.filestoreArchiveSha256 === expected.baseline.odoo.filestoreArchiveSha256
      && value.filestoreTreeSha256 === expected.baseline.odoo.filestoreTreeSha256,
    "Schema-29-Odoo-Pristine-Restore-Receipt bindet nicht Backupbytes, Producerzustand und Filestore der Baseline.",
  );
  return value;
}

async function dockerJson(socketPath, requestPath) {
  const bytes = await new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({ socketPath, method: "GET", path: requestPath, headers: { Host: "docker", Accept: "application/json" } }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 2 * 1_024 * 1_024) request.destroy(new Error("Docker-Runtime-Inventar ist zu gross."));
        else chunks.push(chunk);
      });
      response.on("end", () => response.statusCode === 200 ? resolvePromise(Buffer.concat(chunks)) : rejectPromise(new Error(`Docker-Runtime-Inventar endete mit HTTP ${response.statusCode ?? "unbekannt"}.`)));
    });
    request.once("error", rejectPromise);
    request.end();
  });
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Docker-Runtime-Inventar ist kein JSON."); }
}

export async function inspectSchema29RuntimeContainers(project, environment) {
  const socketPath = requiredEnvironment(environment, "PRODUCTION_RECOVERY_DOCKER_SOCKET_PATH");
  invariant(socketPath === "/var/run/docker.sock", "Schema-29-Runtime-Drill adressiert nur den festen Docker-Socket.");
  const socket = await lstat(socketPath);
  invariant(socket.isSocket() && !socket.isSymbolicLink(), "Docker-Socket ist kein direkter Unix-Socket.");
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`], status: ["running"] }));
  const containers = await dockerJson(socketPath, `/v1.43/containers/json?all=0&filters=${filters}`);
  invariant(Array.isArray(containers), "Docker-Runtime-Inventar ist keine Liste.");
  const inspected = await Promise.all(containers.map(async (container) => {
    invariant(CONTAINER_ID.test(container?.Id), "Docker-Runtime-Inventar enthaelt keine Container-ID.");
    const detail = await dockerJson(socketPath, `/v1.43/containers/${container.Id}/json`);
    return Object.freeze({
      command: detail?.Config?.Cmd,
      configuredImage: detail?.Config?.Image,
      containerId: container.Id,
      environment: detail?.Config?.Env,
      health: detail?.State?.Health?.Status ?? null,
      imageId: detail?.Image,
      mounts: detail?.Mounts,
      networks: Object.keys(detail?.NetworkSettings?.Networks ?? {}),
      portBindings: detail?.HostConfig?.PortBindings ?? null,
      service: detail?.Config?.Labels?.["com.docker.compose.service"],
      user: detail?.Config?.User ?? "",
    });
  }));
  return inspected;
}

function validateRuntimeContainers(containers, expected) {
  invariant(Array.isArray(containers), "Schema-29-Runtime-Inventar fehlt.");
  const sorted = [...containers].sort((left, right) => left.service.localeCompare(right.service, "en"));
  invariant(sameValue(sorted.map(({ service }) => service), REQUIRED_SERVICES), "Schema-29-Runtime-Drill laeuft nicht writerisoliert mit exakt vier Datenbanken, drei Legacy-Runtimes und dem Qualifier.");
  const self = sorted.find(({ service, containerId }) => service === "production-schema29-runtime-qualify" && containerId.startsWith(expected.hostname));
  invariant(self !== undefined, "Schema-29-Runtime-Qualifier ist nicht an seinen Docker-Container gebunden.");
  const game = sorted.find(({ service }) => service === "schema29-game-runtime");
  const keycloak = sorted.find(({ service }) => service === "schema29-keycloak-runtime");
  const odoo = sorted.find(({ service }) => service === "schema29-odoo-runtime");
  invariant(game !== undefined && keycloak !== undefined && odoo !== undefined, "Schema-29-Legacy-Runtimes fehlen.");
  for (const [runtime, reference, label] of [
    [game, expected.gameImageReference, "Game"],
    [keycloak, expected.keycloakImageReference, "Keycloak"],
    [odoo, expected.odooImageReference, "Odoo"],
  ]) {
    invariant(runtime.configuredImage === reference && DIGEST.test(runtime.imageId), `${label}-Runtime laeuft nicht mit der exakt gebundenen Legacy-Image-Referenz.`);
    invariant(runtime.health === "healthy", `${label}-Runtime ist im Docker-Healthcheck nicht gesund.`);
    invariant(runtime.networks.length === 1 && runtime.networks[0] === "zugfolge-schema29-recovery", `${label}-Runtime ist nicht auf das interne Schema-29-Recovery-Netz begrenzt.`);
    invariant(runtime.portBindings === null || Object.values(runtime.portBindings).every((binding) => binding === null || binding.length === 0), `${label}-Runtime besitzt eine Host-Portbindung.`);
  }
  invariant(self.networks.length === 1 && self.networks[0] === "zugfolge-schema29-recovery", "Schema-29-Runtime-Qualifier ist nicht auf das interne Drillnetz begrenzt.");
  for (const service of ["recovery-verify-odoo-postgres", "recovery-verify-postgres"]) {
    const database = sorted.find((entry) => entry.service === service);
    invariant(database?.networks.length === 1 && database.networks[0] === "zugfolge-schema29-recovery", `${service} ist nicht auf das interne Drillnetz begrenzt.`);
  }
  for (const service of ["odoo-postgres", "postgres"]) {
    const database = sorted.find((entry) => entry.service === service);
    invariant(!database?.networks.includes("zugfolge-schema29-recovery"), `${service} ist unerlaubt mit dem Schema-29-Drillnetz verbunden.`);
  }
  invariant(
    Array.isArray(game.environment)
      && game.environment.includes(`DATABASE_URL=${expected.gameUrl}`)
      && game.environment.includes(`ALPHA_PUBLIC_WORLD_ID=${expected.previousWorldId}`)
      && game.environment.includes(`ALPHA_WORLD_RELEASE_PATHS_JSON=["${expected.worldDeploymentPath}"]`),
    "Game-Runtime adressiert nicht ausschliesslich den Schema-29-Restore und das attestierte Vorgaenger-Deployment.",
  );
  invariant(
    Array.isArray(game.mounts)
      && game.mounts.some((mount) => mount?.Destination === "/evidence" && mount?.RW === false),
    "Game-Runtime besitzt keinen schreibgeschuetzten Mount fuer das attestierte Vorgaenger-Deployment.",
  );
  invariant(
    Array.isArray(keycloak.environment)
      && keycloak.environment.includes(`KC_DB_URL=jdbc:postgresql://recovery-verify-postgres:5432/${expected.gameDatabase}`)
      && keycloak.environment.includes("KC_DB_SCHEMA=public"),
    "Keycloak-Runtime adressiert nicht ausschliesslich das public-Schema im Schema-29-Runtime-Restore.",
  );
  invariant(Array.isArray(odoo.command) && odoo.command.includes(`--database=${expected.odooDatabase}`) && odoo.command.includes("--db_host=recovery-verify-odoo-postgres"), "Odoo-Runtime adressiert nicht ausschliesslich den isolierten Schema-29-Restore.");
  invariant(odoo.user === `${expected.odooOwnerUid}:${expected.odooOwnerGid}`, "Odoo-Runtime laeuft nicht als der gebundene Filestore-Owner.");
  const odooFilestoreMounts = Array.isArray(odoo.mounts)
    ? odoo.mounts.filter(({ Destination }) => Destination === "/var/lib/odoo/filestore" || Destination?.startsWith("/var/lib/odoo/filestore/"))
    : [];
  invariant(
    odooFilestoreMounts.length === 1
      && odooFilestoreMounts[0]?.Destination === `/var/lib/odoo/filestore/${expected.odooDatabase}`
      && odooFilestoreMounts[0]?.Source === expected.odooFilestoreHostPath
      && odooFilestoreMounts[0]?.RW === true,
    "Odoo-Runtime besitzt nicht ausschliesslich den exakten physischen Runtime-Filestore-Kindpfad als RW-Mount.",
  );
  return Object.freeze({ game, keycloak, odoo });
}

async function inspectHealthEndpoint(url, label, { json = false, expectedStatus } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  invariant(response.ok, `${label} endete mit HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  invariant(bytes.length > 0 && bytes.length <= 65_536, `${label} lieferte keinen begrenzten Health-Body.`);
  if (json) {
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} lieferte kein JSON.`); }
    invariant(value?.status !== "down", `${label} meldet down.`);
    if (expectedStatus !== undefined) invariant(value?.status === expectedStatus, `${label} meldet nicht '${expectedStatus}'.`);
  }
  return Object.freeze({ bodySha256: createHash("sha256").update(bytes).digest("hex"), statusCode: response.status });
}

function transientHealthEndpointError(error) {
  return error instanceof TypeError && error.message === "fetch failed"
    || error?.name === "AbortError"
    || error?.name === "TimeoutError";
}

/**
 * Der attestierte Schema-29-Server kann waehrend eines grossen exakten
 * Catch-up-Batches seinen Node-Eventloop laenger binden als ein einzelner
 * Health-Request. Der Qualifizierer wartet deshalb begrenzt auf die
 * Ueberschneidung aus echtem HTTP-Health und Docker-Health, ohne statische
 * Image-, Netzwerk- oder Mountfehler als transient zu behandeln.
 */
export async function waitForProductionSchema29RuntimeReady({
  environment,
  expected,
  inspectContainers,
  inspectHealth,
  validateContainers = validateRuntimeContainers,
  nowMs = Date.now,
  sleep = (durationMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs)),
  timeoutMs = SCHEMA29_GAME_RUNTIME_READY_TIMEOUT_MS,
  retryIntervalMs = SCHEMA29_GAME_RUNTIME_READY_RETRY_MS,
}) {
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "Schema-29-Game-Readiness-Timeout ist ungueltig.");
  invariant(Number.isSafeInteger(retryIntervalMs) && retryIntervalMs > 0, "Schema-29-Game-Readiness-Intervall ist ungueltig.");
  const startedAtMs = nowMs();
  let lastTransientError;
  for (;;) {
    const containers = await inspectContainers(expected.project, environment);
    const game = containers.find(({ service }) => service === "schema29-game-runtime");
    if (game?.health === "healthy") {
      try {
        const gameHealth = await inspectHealth(
          requiredEnvironment(environment, "PRODUCTION_SCHEMA29_GAME_HEALTH_URL"),
          "Legacy-Game-/ready",
          { json: true },
        );
        return Object.freeze({
          gameHealth,
          runtimes: validateContainers(containers, expected),
        });
      } catch (error) {
        if (!transientHealthEndpointError(error)) throw error;
        lastTransientError = error;
      }
    } else {
      lastTransientError = new Error(
        `Schema-29-Game-Runtime meldet Docker-Health '${game?.health ?? "missing"}'.`,
      );
    }
    const elapsedMs = nowMs() - startedAtMs;
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs >= timeoutMs) {
      throw new Error(
        `Schema-29-Game-Runtime wurde innerhalb von ${timeoutMs} ms nicht gleichzeitig ueber Docker und HTTP gesund.`,
        { cause: lastTransientError },
      );
    }
    await sleep(Math.min(retryIntervalMs, timeoutMs - elapsedMs));
  }
}

async function boundedFetch(url, label, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  invariant(response.status >= 200 && response.status < 400, `${label} endete mit HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  invariant(bytes.length <= 262_144, `${label} lieferte einen zu grossen Body.`);
  return Object.freeze({ response, bytes });
}

function parseJsonBytes(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} lieferte kein JSON.`); }
}

export async function inspectLegacyKeycloakDatabase(databaseUrl) {
  const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const postgresModule = requireFromDb("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 15, idle_timeout: 5 });
  try {
    const [migration, identity, rows, counts] = await Promise.all([
      client.unsafe("select count(*)::int as count from drizzle.__drizzle_migrations"),
      client.unsafe("select to_regclass('public.zugfolge_database_identity') is not null as present"),
      client.unsafe(`
        select realm.name as realm_name, realm.enabled as realm_enabled,
               client.client_id, client.enabled as client_enabled
        from public.realm as realm
        join public.client as client on client.realm_id = realm.id
        where realm.name = 'zugfolge'
        order by client.client_id
      `),
      client.unsafe(`
        select
          (select count(*)::text from public.offline_user_session) as offline_user_sessions,
          (select count(*)::text from public.offline_client_session) as offline_client_sessions
      `),
    ]);
    invariant(migration[0]?.count === 29 && identity[0]?.present === false, "Legacy-Keycloak-Datenbankbeleg adressiert nicht Schema 29.");
    invariant(rows.length >= REQUIRED_KEYCLOAK_CLIENTS.length && rows.every((row) => row.realm_name === "zugfolge" && row.realm_enabled === true), "Legacy-Keycloak-Datenbankbeleg fand keinen aktiven Zugfolge-Realm.");
    const clients = rows.map((row) => Object.freeze({ clientId: row.client_id, enabled: row.client_enabled }));
    for (const clientId of REQUIRED_KEYCLOAK_CLIENTS) {
      invariant(clients.some((client) => client.clientId === clientId && client.enabled === true), `Legacy-Keycloak-Datenbankbeleg fand den aktiven Client '${clientId}' nicht.`);
    }
    invariant(counts.length === 1 && /^(?:0|[1-9][0-9]*)$/u.test(counts[0].offline_user_sessions) && /^(?:0|[1-9][0-9]*)$/u.test(counts[0].offline_client_sessions), "Legacy-Keycloak-Datenbankbeleg konnte die Offline-/Refresh-Sitzungen nicht inventarisieren.");
    return Object.freeze({
      clientsSha256: canonicalSha256(clients),
      offlineClientSessionCount: counts[0].offline_client_sessions,
      offlineUserSessionCount: counts[0].offline_user_sessions,
      realmName: "zugfolge",
      requiredClients: REQUIRED_KEYCLOAK_CLIENTS,
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

export async function inspectLegacyKeycloakContinuity(environment, databaseUrl) {
  const health = await inspectHealthEndpoint(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_KEYCLOAK_HEALTH_URL"), "Legacy-Keycloak-/health/ready", { json: true, expectedStatus: "UP" });
  const realmUrl = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_KEYCLOAK_REALM_URL");
  const oidcUrl = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_KEYCLOAK_OIDC_URL");
  const jwksUrl = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_KEYCLOAK_JWKS_URL");
  const [realmResult, oidcResult, jwksResult, database] = await Promise.all([
    boundedFetch(realmUrl, "Legacy-Keycloak-Realm"),
    boundedFetch(oidcUrl, "Legacy-Keycloak-OIDC-Metadaten"),
    boundedFetch(jwksUrl, "Legacy-Keycloak-JWKS"),
    inspectLegacyKeycloakDatabase(databaseUrl),
  ]);
  const realm = parseJsonBytes(realmResult.bytes, "Legacy-Keycloak-Realm");
  const oidc = parseJsonBytes(oidcResult.bytes, "Legacy-Keycloak-OIDC-Metadaten");
  const jwks = parseJsonBytes(jwksResult.bytes, "Legacy-Keycloak-JWKS");
  invariant(realm?.realm === "zugfolge" && typeof realm.public_key === "string" && realm.public_key.length > 0, "Legacy-Keycloak-Realm besitzt keine persistierte Zugfolge-Signaturidentitaet.");
  invariant(oidc?.issuer === realmUrl && typeof oidc.authorization_endpoint === "string" && typeof oidc.token_endpoint === "string", "Legacy-Keycloak-OIDC-Metadaten binden Realm, Authorization und Token nicht.");
  invariant(Array.isArray(jwks?.keys) && jwks.keys.length > 0 && jwks.keys.every((key) => typeof key?.kid === "string" && key.kid !== ""), "Legacy-Keycloak-JWKS besitzt keinen aktiven Realm-Schluessel.");

  const authorizationUrl = new URL(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_KEYCLOAK_AUTH_URL"));
  authorizationUrl.searchParams.set("client_id", "game-web");
  authorizationUrl.searchParams.set("redirect_uri", requiredEnvironment(environment, "PRODUCTION_SCHEMA29_KEYCLOAK_CLIENT_REDIRECT_URI"));
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", "openid");
  authorizationUrl.searchParams.set("state", "schema29-recovery-state");
  authorizationUrl.searchParams.set("nonce", "schema29-recovery-nonce");
  authorizationUrl.searchParams.set("code_challenge", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  const authorization = await boundedFetch(authorizationUrl, "Legacy-Keycloak-game-web-Authorization", { redirect: "manual" });
  const authorizationBinding = Buffer.concat([
    Buffer.from(`${authorization.response.status}\n${authorization.response.headers.get("location") ?? ""}\n`, "utf8"),
    authorization.bytes,
  ]);
  return Object.freeze({
    authorizationSha256: createHash("sha256").update(authorizationBinding).digest("hex"),
    authorizationStatusCode: authorization.response.status,
    database,
    health,
    jwksSha256: createHash("sha256").update(jwksResult.bytes).digest("hex"),
    jwksStatusCode: jwksResult.response.status,
    oidcSha256: createHash("sha256").update(oidcResult.bytes).digest("hex"),
    oidcStatusCode: oidcResult.response.status,
    realmSha256: createHash("sha256").update(realmResult.bytes).digest("hex"),
    realmStatusCode: realmResult.response.status,
  });
}

function gameSchedulerAdvance(beforeHeads, afterHeads) {
  invariant(Array.isArray(beforeHeads) && Array.isArray(afterHeads) && beforeHeads.length === afterHeads.length && beforeHeads.length > 0, "Echter Legacy-Game-Server lieferte keine identische Regionalmenge vor und nach dem Start.");
  const advances = [];
  for (let index = 0; index < beforeHeads.length; index += 1) {
    const before = beforeHeads[index];
    const after = afterHeads[index];
    invariant(before.worldId === after.worldId && before.regionId === after.regionId, "Echter Legacy-Game-Server veraenderte die Regionalidentitaet.");
    const beforeRevision = BigInt(before.revision);
    const afterRevision = BigInt(after.revision);
    const beforePublisherSequence = BigInt(before.publisherSequence);
    const afterPublisherSequence = BigInt(after.publisherSequence);
    invariant(afterRevision >= beforeRevision && afterPublisherSequence >= beforePublisherSequence && after.revision === after.publisherSequence, "Echter Legacy-Game-Server liess Revision oder Publishersequenz zuruecklaufen.");
    if (afterRevision === beforeRevision && afterPublisherSequence === beforePublisherSequence) {
      invariant(after.stateHash === before.stateHash && after.updatedAt === before.updatedAt, "Echter Legacy-Game-Server veraenderte Zustand ohne Revision.");
      continue;
    }
    invariant(
      afterRevision > beforeRevision
        && afterPublisherSequence > beforePublisherSequence
        && after.stateHash !== before.stateHash
        && new Date(after.updatedAt).getTime() > new Date(before.updatedAt).getTime(),
      "Echter Legacy-Game-Server belegt keinen atomaren Scheduler-/Publisher-Fortschritt.",
    );
    advances.push(Object.freeze({
      afterPublisherSequence: after.publisherSequence,
      afterRevision: after.revision,
      afterStateHash: after.stateHash,
      afterUpdatedAt: after.updatedAt,
      beforePublisherSequence: before.publisherSequence,
      beforeRevision: before.revision,
      beforeStateHash: before.stateHash,
      beforeUpdatedAt: before.updatedAt,
      regionId: before.regionId,
      worldId: before.worldId,
    }));
  }
  invariant(advances.length > 0, "Der echte alte apps/game-api/dist/server.js erzeugte keinen dauerhaften Scheduler-/Publisher-Fortschritt.");
  return Object.freeze({
    advancedRegionCount: advances.length,
    advances,
    afterHeadsSha256: canonicalSha256(afterHeads),
    beforeHeadsSha256: canonicalSha256(beforeHeads),
  });
}

function runtimeEnvironment(environment) {
  const recoveryId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ID");
  invariant(SAFE_ID.test(recoveryId), "PRODUCTION_RECOVERY_ID ist nicht kanonisch.");
  const gameImageReference = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_REFERENCE");
  const odooImageReference = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_IMAGE_REFERENCE");
  const gameImageDigest = requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_RUNTIME_IMAGE_DIGEST");
  const odooImageDigest = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ODOO_IMAGE_DIGEST");
  const keycloakImageReference = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_KEYCLOAK_IMAGE_REFERENCE");
  invariant(imageDigestFromReference(gameImageReference, "Legacy-Game-Image") === gameImageDigest, "Legacy-Game-Image-Referenz bindet nicht den attestierten Digest.");
  invariant(imageDigestFromReference(odooImageReference, "Legacy-Odoo-Image") === odooImageDigest, "Legacy-Odoo-Image-Referenz bindet nicht den attestierten Digest.");
  invariant(keycloakImageReference === LEGACY_KEYCLOAK_IMAGE_REFERENCE, "Legacy-Keycloak-Image ist nicht auf den freigegebenen 26.7.0-Digest gepinnt.");
  const odooUrl = requiredEnvironment(environment, "ODOO_DATABASE_URL");
  const project = requiredEnvironment(environment, "PRODUCTION_RECOVERY_DOCKER_PROJECT");
  invariant(project === "zugfolge", "Schema-29-Runtime-Drill ist nicht an das Produktionsprojekt gebunden.");
  const hostname = requiredEnvironment(environment, "HOSTNAME");
  invariant(CONTAINER_ID.test(hostname), "Schema-29-Runtime-Qualifier besitzt keine Docker-ID als Hostname.");
  invariant(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_RUNTIME_CONTROL_SERVICE") === "production-schema29-runtime-qualify", "Schema-29-Runtime-Control-Service ist nicht fest gebunden.");
  const gameUrl = requiredEnvironment(environment, "DATABASE_URL");
  const pristineGameUrl = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_PRISTINE_GAME_RESTORED_DATABASE_URL");
  const pristineOdooUrl = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_PRISTINE_ODOO_RESTORED_DATABASE_URL");
  invariant(databaseNameFromUrl(gameUrl, "Schema-29-Game-Runtime-Restore") !== databaseNameFromUrl(pristineGameUrl, "Pristiner Schema-29-Game-Restore"), "Schema-29-Game-Runtime und pristiner Restore duerfen nicht dieselbe Datenbank verwenden.");
  invariant(databaseNameFromUrl(odooUrl, "Schema-29-Odoo-Runtime-Restore") !== databaseNameFromUrl(pristineOdooUrl, "Pristiner Schema-29-Odoo-Restore"), "Schema-29-Odoo-Runtime und pristiner Restore duerfen nicht dieselbe Datenbank verwenden.");
  const odooDatabase = databaseNameFromUrl(odooUrl, "Schema-29-Odoo-Restore");
  return Object.freeze({
    recoveryId,
    candidateReleaseId: requiredEnvironment(environment, "PRODUCTION_RECOVERY_CANDIDATE_RELEASE_ID"),
    previousReleaseId: requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_RELEASE_ID"),
    previousWorldId: requiredEnvironment(environment, "PRODUCTION_RECOVERY_PREVIOUS_WORLD_ID"),
    gameImageDigest,
    gameImageReference,
    keycloakImageDigest: imageDigestFromReference(keycloakImageReference, "Legacy-Keycloak-Image"),
    keycloakImageReference,
    odooImageDigest,
    odooImageReference,
    odooFilestoreHostPath: exactHostFilestorePath(
      requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_FILESTORE_HOST_PATH"),
      odooDatabase,
      "Schema-29-Odoo-Runtime-Filestore-Hostpfad",
    ),
    odooOwnerGid: requiredNumericIdentity(environment, "PRODUCTION_RECOVERY_ODOO_RUNTIME_GID"),
    odooOwnerUid: requiredNumericIdentity(environment, "PRODUCTION_RECOVERY_ODOO_RUNTIME_UID"),
    gameUrl,
    gameDatabase: databaseNameFromUrl(gameUrl, "Schema-29-Game-Runtime-Restore"),
    odooUrl,
    odooDatabase,
    pristineGameUrl,
    pristineOdooUrl,
    worldDeploymentPath: requiredEnvironment(environment, "MAP_RELEASE_PREFLIGHT_RUNTIME_WORLD_DEPLOYMENT_PATH"),
    project,
    hostname,
  });
}

export function validateProductionSchema29RuntimeDrillReceipt(value, expected = {}) {
  exactKeys(value, [
    "baselineReceiptHash", "baselineReceiptSha256", "candidateReleaseId", "game", "gameProbeReceiptHash",
    "gameProbeReceiptSha256", "gameRestoreReceiptSha256", "gameRestoreStateSha256", "gameSchedulerAdvance", "keycloak",
    "odoo", "odooFilestoreFinalAccessSha256", "odooFilestoreHostPath", "odooFilestoreOpenReceiptHash", "odooFilestoreOpenReceiptSha256",
    "odooFilestoreOwnerGid", "odooFilestoreOwnerUid", "odooFilestoreSealReceiptHash", "odooFilestoreSealReceiptSha256",
    "odooFilestoreTreeSha256", "odooProbeReceiptHash", "odooProbeReceiptSha256", "odooRestoreStateSha256",
    "previousReleaseId", "odooRestoreReceiptSha256", "previousWorldId", "pristineGameRestoreStateSha256",
    "pristineOdooFilestoreTreeSha256", "pristineOdooRestoreStateSha256", "qualifiedAt", "receiptHash", "recoveryId",
    "runtimeBeforeReceiptHash", "runtimeBeforeReceiptSha256", "schema", "worldDeploymentHash", "worldDeploymentSha256",
  ], "Schema-29-Runtime-Beleg");
  invariant(value.schema === RECEIPT_SCHEMA && SAFE_ID.test(value.recoveryId), "Schema-29-Runtime-Beleg besitzt keinen gueltigen Vertrag.");
  exactKeys(value.game, ["containerId", "healthBodySha256", "healthStatusCode", "imageDigest", "imageId", "imageReference"], "Schema-29-Game-Runtime-Bindung");
  exactKeys(value.keycloak, [
    "authorizationSha256", "authorizationStatusCode", "containerId", "database", "healthBodySha256", "healthStatusCode",
    "imageDigest", "imageId", "imageReference", "jwksSha256", "jwksStatusCode", "oidcSha256", "oidcStatusCode",
    "realmSha256", "realmStatusCode",
  ], "Schema-29-Keycloak-Runtime-Bindung");
  exactKeys(value.keycloak.database, ["clientsSha256", "offlineClientSessionCount", "offlineUserSessionCount", "realmName", "requiredClients"], "Schema-29-Keycloak-Datenbankbindung");
  exactKeys(value.odoo, ["containerId", "healthBodySha256", "healthStatusCode", "imageDigest", "imageId", "imageReference", "runtimeUser"], "Schema-29-Odoo-Runtime-Bindung");
  invariant(value.game.healthStatusCode === 200 && value.keycloak.healthStatusCode === 200 && value.odoo.healthStatusCode === 200, "Schema-29-Runtime-Beleg besitzt keinen erfolgreichen echten Healthcheck.");
  invariant(value.keycloak.realmStatusCode === 200 && value.keycloak.oidcStatusCode === 200 && value.keycloak.jwksStatusCode === 200 && value.keycloak.authorizationStatusCode >= 200 && value.keycloak.authorizationStatusCode < 400, "Schema-29-Keycloak-Beleg besitzt keine erfolgreiche Realm-/OIDC-/JWKS-/Client-Kontinuitaet.");
  invariant(CONTAINER_ID.test(value.game.containerId) && CONTAINER_ID.test(value.keycloak.containerId) && CONTAINER_ID.test(value.odoo.containerId), "Schema-29-Runtime-Beleg besitzt keine Containeridentitaeten.");
  for (const runtime of [value.game, value.keycloak, value.odoo]) {
    invariant(DIGEST.test(runtime.imageDigest) && DIGEST.test(runtime.imageId), "Schema-29-Runtime-Beleg besitzt keine unveraenderliche Imageidentitaet.");
    invariant(imageDigestFromReference(runtime.imageReference, "Schema-29-Runtime-Beleg") === runtime.imageDigest, "Schema-29-Runtime-Beleg bindet Referenz und Digest nicht.");
  }
  invariant(value.keycloak.imageReference === LEGACY_KEYCLOAK_IMAGE_REFERENCE, "Schema-29-Keycloak-Beleg bindet nicht den freigegebenen 26.7.0-Digest.");
  invariant(value.keycloak.database.realmName === "zugfolge" && sameValue(value.keycloak.database.requiredClients, REQUIRED_KEYCLOAK_CLIENTS), "Schema-29-Keycloak-Beleg bindet nicht Realm und alle Produktionsclients.");
  invariant(Number.isSafeInteger(value.odooFilestoreOwnerUid) && value.odooFilestoreOwnerUid > 0 && Number.isSafeInteger(value.odooFilestoreOwnerGid) && value.odooFilestoreOwnerGid > 0, "Schema-29-Odoo-Filestore-Beleg besitzt keinen gebundenen Nicht-root-Owner.");
  invariant(value.odoo.runtimeUser === `${value.odooFilestoreOwnerUid}:${value.odooFilestoreOwnerGid}`, "Schema-29-Odoo-Runtime und Filestore binden nicht dieselbe Owner-Identitaet.");
  invariant(posixPath.isAbsolute(value.odooFilestoreHostPath) && posixPath.normalize(value.odooFilestoreHostPath) === value.odooFilestoreHostPath && posixPath.dirname(value.odooFilestoreHostPath) !== "/", "Schema-29-Runtime-Beleg besitzt keinen engen absoluten Filestore-Hostpfad.");
  invariant(/^(?:0|[1-9][0-9]*)$/u.test(value.keycloak.database.offlineClientSessionCount) && /^(?:0|[1-9][0-9]*)$/u.test(value.keycloak.database.offlineUserSessionCount), "Schema-29-Keycloak-Beleg besitzt keine Offline-/Refresh-Sitzungsinventur.");
  exactKeys(value.gameSchedulerAdvance, ["advancedRegionCount", "advances", "afterHeadsSha256", "beforeHeadsSha256"], "Schema-29-Game-Schedulerfortschritt");
  invariant(Number.isSafeInteger(value.gameSchedulerAdvance.advancedRegionCount) && value.gameSchedulerAdvance.advancedRegionCount > 0 && value.gameSchedulerAdvance.advancedRegionCount === value.gameSchedulerAdvance.advances.length, "Schema-29-Game-Schedulerfortschritt besitzt keine echten Regionen.");
  for (const advance of value.gameSchedulerAdvance.advances) {
    exactKeys(advance, [
      "afterPublisherSequence", "afterRevision", "afterStateHash", "afterUpdatedAt", "beforePublisherSequence",
      "beforeRevision", "beforeStateHash", "beforeUpdatedAt", "regionId", "worldId",
    ], "Schema-29-Game-Schedulerregion");
    invariant(advance.worldId === value.previousWorldId && typeof advance.regionId === "string" && advance.regionId !== "", "Schema-29-Game-Schedulerregion bindet nicht die Vorgaengerwelt.");
    invariant(
      /^(?:0|[1-9][0-9]*)$/u.test(advance.beforeRevision)
        && /^(?:0|[1-9][0-9]*)$/u.test(advance.afterRevision)
        && BigInt(advance.afterRevision) > BigInt(advance.beforeRevision)
        && BigInt(advance.afterPublisherSequence) > BigInt(advance.beforePublisherSequence)
        && advance.afterRevision === advance.afterPublisherSequence
        && advance.beforeRevision === advance.beforePublisherSequence,
      "Schema-29-Game-Schedulerregion besitzt keinen monotonen Revision-/Publisherfortschritt.",
    );
    invariant(SHA256.test(advance.beforeStateHash) && SHA256.test(advance.afterStateHash) && advance.beforeStateHash !== advance.afterStateHash, "Schema-29-Game-Schedulerregion besitzt keinen Zustandswechsel.");
    invariant(new Date(advance.afterUpdatedAt).getTime() > new Date(advance.beforeUpdatedAt).getTime(), "Schema-29-Game-Schedulerregion besitzt keinen spaeteren Schreibzeitpunkt.");
  }
  for (const hash of [
    value.baselineReceiptHash, value.baselineReceiptSha256, value.game.healthBodySha256, value.gameProbeReceiptHash,
    value.gameProbeReceiptSha256, value.gameRestoreReceiptSha256, value.gameRestoreStateSha256,
    value.gameSchedulerAdvance.afterHeadsSha256, value.gameSchedulerAdvance.beforeHeadsSha256,
    value.keycloak.authorizationSha256, value.keycloak.database.clientsSha256, value.keycloak.healthBodySha256,
    value.keycloak.jwksSha256, value.keycloak.oidcSha256, value.keycloak.realmSha256, value.odoo.healthBodySha256,
    value.odooFilestoreFinalAccessSha256, value.odooFilestoreOpenReceiptHash, value.odooFilestoreOpenReceiptSha256,
    value.odooFilestoreSealReceiptHash, value.odooFilestoreSealReceiptSha256, value.odooFilestoreTreeSha256,
    value.odooProbeReceiptHash, value.odooProbeReceiptSha256, value.odooRestoreReceiptSha256,
    value.odooRestoreStateSha256, value.pristineGameRestoreStateSha256, value.pristineOdooFilestoreTreeSha256,
    value.pristineOdooRestoreStateSha256, value.runtimeBeforeReceiptHash, value.runtimeBeforeReceiptSha256,
    value.worldDeploymentHash, value.worldDeploymentSha256, value.receiptHash,
  ]) invariant(SHA256.test(hash), "Schema-29-Runtime-Beleg besitzt einen ungueltigen SHA-256.");
  invariant(new Date(value.qualifiedAt).toISOString() === value.qualifiedAt, "Schema-29-Runtime-Beleg besitzt keinen kanonischen UTC-Zeitpunkt.");
  for (const key of [
    "recoveryId", "candidateReleaseId", "previousReleaseId", "previousWorldId", "baselineReceiptHash",
    "baselineReceiptSha256", "gameRestoreStateSha256", "odooRestoreStateSha256", "odooFilestoreTreeSha256",
    "pristineGameRestoreStateSha256", "pristineOdooRestoreStateSha256", "pristineOdooFilestoreTreeSha256",
    "worldDeploymentHash", "worldDeploymentSha256", "odooFilestoreOwnerUid", "odooFilestoreOwnerGid",
    "odooFilestoreHostPath",
  ]) {
    if (expected[key] !== undefined) invariant(value[key] === expected[key], `Schema-29-Runtime-Beleg bindet ${key} nicht an den erwarteten Wert.`);
  }
  if (expected.gameImageDigest !== undefined) invariant(value.game.imageDigest === expected.gameImageDigest, "Schema-29-Runtime-Beleg bindet einen anderen Game-Digest.");
  if (expected.odooImageDigest !== undefined) invariant(value.odoo.imageDigest === expected.odooImageDigest, "Schema-29-Runtime-Beleg bindet einen anderen Odoo-Digest.");
  if (expected.runtimeBeforeReceiptHash !== undefined) invariant(value.runtimeBeforeReceiptHash === expected.runtimeBeforeReceiptHash, "Schema-29-Runtime-Beleg bindet einen anderen Vorher-Snapshot.");
  invariant(value.gameSchedulerAdvance.beforeHeadsSha256 === expected.beforeHeadsSha256 || expected.beforeHeadsSha256 === undefined, "Schema-29-Runtime-Beleg bindet nicht die Vorher-Koepfe.");
  const { receiptHash, ...payload } = value;
  invariant(receiptHash === canonicalSha256(payload), "Schema-29-Runtime-Beleg besitzt keinen kanonischen Receipt-Hash.");
  return value;
}

export async function readProductionSchema29RuntimeDrillReceipt(path, expected = {}) {
  const artifact = await stableJson(path, "Schema-29-Runtime-Beleg");
  const receipt = validateProductionSchema29RuntimeDrillReceipt(artifact.value, expected);
  return Object.freeze({ artifact, receipt });
}

export async function assertProductionSchema29RuntimeDrillReceiptUnchanged(artifact) {
  await assertJsonUnchanged(artifact, "Schema-29-Runtime-Beleg");
}

export async function qualifyProductionSchema29RuntimeDrill({
  environment = process.env,
  inspectDatabase = inspectColdDatabase,
  inspectFilestore = inspectFilestoreTree,
  inspectFilestoreAccess = inspectSchema29OdooFilestore,
  inspectContainers = inspectSchema29RuntimeContainers,
  inspectHealth = inspectHealthEndpoint,
  inspectHeads = inspectSchema29GameRuntimeHeads,
  inspectKeycloak = inspectLegacyKeycloakContinuity,
  waitForRuntimeReady = waitForProductionSchema29RuntimeReady,
  now = () => new Date(),
} = {}) {
  const expected = runtimeEnvironment(environment);
  const outputPath = await containedOutput(requiredEnvironment(environment, "PRODUCTION_RECOVERY_EVIDENCE_ROOT"), requiredEnvironment(environment, "PRODUCTION_SCHEMA29_RUNTIME_RECEIPT_OUTPUT_PATH"));
  const { artifact: baselineArtifact, receipt: baseline } = await readProductionColdBackupReceipt(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_COLD_RECEIPT_PATH"), {
    recoveryId: expected.recoveryId,
    candidateReleaseId: expected.candidateReleaseId,
    previousReleaseId: expected.previousReleaseId,
    migrationCount: 29,
  });
  const [gameProbeArtifact, odooProbeArtifact, gameRestoreArtifact, pristineOdooRestoreArtifact, odooRestoreArtifact, worldDeploymentArtifact] = await Promise.all([
    stableJson(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_GAME_LEGACY_PROBE_PATH"), "Legacy-Game-Schema-29-Probe"),
    stableJson(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_LEGACY_PROBE_PATH"), "Legacy-Odoo-Schema-29-Probe"),
    stableJson(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_RUNTIME_GAME_RESTORE_RECEIPT_PATH"), "Schema-29-Game-Runtime-Restore-Receipt"),
    stableJson(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_PRISTINE_ODOO_RESTORE_RECEIPT_PATH"), "Schema-29-Odoo-Pristine-Restore-Receipt"),
    stableJson(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_RUNTIME_ODOO_RESTORE_RECEIPT_PATH"), "Schema-29-Odoo-Runtime-Restore-Receipt"),
    stableJson(expected.worldDeploymentPath, "Attestiertes Vorgaenger-World-Deployment", WORLD_DEPLOYMENT_JSON_MAX_BYTES),
  ]);
  const gameProbe = validateGameProbe(gameProbeArtifact.value, expected);
  const odooProbe = validateLegacyOdooSchema29WriteProbe(odooProbeArtifact.value, {
    databaseName: expected.odooDatabase,
    legacyOdooImageDigest: expected.odooImageDigest,
    recoveryId: expected.recoveryId,
  });
  validateGameRestoreReceipt(gameRestoreArtifact.value, { ...expected, baseline });
  const pristineOdooRestoreReceipt = validatePristineOdooRestoreReceipt(pristineOdooRestoreArtifact.value, { ...expected, baseline });
  invariant(pristineOdooRestoreArtifact.sha256 === baseline.odoo.restoreReceiptSha256, "Schema-29-Odoo-Pristine-Restore-Receipt ist nicht das vom Kalt-Restore qualifizierte Artefakt.");
  validateOdooRestoreReceipt(odooRestoreArtifact.value, { ...expected, baseline, pristine: pristineOdooRestoreReceipt });
  invariant(
    worldDeploymentArtifact.value?.deployment?.worldId === expected.previousWorldId
      && SHA256.test(worldDeploymentArtifact.value?.deploymentHash)
      && worldDeploymentArtifact.value?.signature?.algorithm === "Ed25519",
    "Attestiertes Vorgaenger-World-Deployment passt nicht zur Legacy-Runtime-Welt.",
  );
  const { artifact: runtimeBeforeArtifact, receipt: runtimeBefore } = await readProductionSchema29RuntimeBeforeReceipt(
    requiredEnvironment(environment, "PRODUCTION_SCHEMA29_RUNTIME_BEFORE_RECEIPT_PATH"),
    {
      recoveryId: expected.recoveryId,
      candidateReleaseId: expected.candidateReleaseId,
      previousReleaseId: expected.previousReleaseId,
      previousWorldId: expected.previousWorldId,
      baselineReceiptHash: baseline.receiptHash,
      baselineReceiptSha256: baselineArtifact.sha256,
      gameRestoreReceiptSha256: gameRestoreArtifact.sha256,
      odooRestoreReceiptSha256: odooRestoreArtifact.sha256,
    },
  );
  const { artifact: filestoreOpenArtifact, receipt: filestoreOpen } = await readSchema29OdooFilestoreOpenReceipt(
    requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_FILESTORE_OPEN_RECEIPT_PATH"),
    {
      baselineFilestoreTreeSha256: runtimeBefore.odooFilestoreTreeSha256,
      ownerGid: expected.odooOwnerGid,
      ownerUid: expected.odooOwnerUid,
      recoveryId: expected.recoveryId,
      runtimeBeforeReceiptHash: runtimeBefore.receiptHash,
    },
  );
  const { artifact: filestoreSealArtifact, receipt: filestoreSeal } = await readSchema29OdooFilestoreSealReceipt(
    requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_FILESTORE_SEAL_RECEIPT_PATH"),
    {
      baselineFilestoreTreeSha256: runtimeBefore.odooFilestoreTreeSha256,
      odooProbeReceiptHash: odooProbe.receiptHash,
      openReceiptHash: filestoreOpen.receiptHash,
      ownerGid: expected.odooOwnerGid,
      ownerUid: expected.odooOwnerUid,
      recoveryId: expected.recoveryId,
    },
  );
  invariant(filestoreSeal.openReceiptSha256 === filestoreOpenArtifact.sha256 && filestoreSeal.odooProbeReceiptSha256 === odooProbeArtifact.sha256, "Schema-29-Odoo-Filestore-Seal-Beleg bindet nicht die exakten Open-/Probe-Bytes.");
  const { gameHealth, runtimes } = await waitForRuntimeReady({
    environment,
    expected,
    inspectContainers,
    inspectHealth,
  });
  const [
    gameRestore, odooRestore, filestore, pristineGameRestore, pristineOdooRestore,
    pristineFilestore, odooHealth, keycloakContinuity, afterHeads,
  ] = await Promise.all([
    inspectDatabase(expected.gameUrl, { game: true }),
    inspectDatabase(expected.odooUrl, { game: false }),
    inspectFilestoreAccess(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_RESTORED_FILESTORE_PATH"), {
      expectedAccess: "read-only",
      expectedGid: expected.odooOwnerGid,
      expectedUid: expected.odooOwnerUid,
      strictPaths: true,
    }),
    inspectDatabase(expected.pristineGameUrl, { game: true }),
    inspectDatabase(expected.pristineOdooUrl, { game: false }),
    inspectFilestore(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_PRISTINE_ODOO_RESTORED_FILESTORE_PATH")),
    inspectHealth(requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_HEALTH_URL"), "Legacy-Odoo-/web/health"),
    inspectKeycloak(environment, expected.gameUrl),
    inspectHeads(expected.gameUrl, expected.previousWorldId),
  ]);
  const schedulerAdvance = gameSchedulerAdvance(runtimeBefore.heads, afterHeads);
  invariant(gameRestore.state.migrationLedger.length === 29 && gameRestore.state.databaseIdentity === null, "Schema-29-Game-Runtime laeuft nicht auf dem exakten Baseline-Schema.");
  invariant(
    gameRestore.endpointSha256 === runtimeBefore.gameRestoreEndpointSha256
      && gameRestore.backendSha256 === runtimeBefore.gameRestoreBackendSha256
      && runtimeBefore.gameRestoreStateSha256 === baseline.game.stateSha256
      && gameRestore.stateSha256 !== baseline.game.stateSha256,
    "Schema-29-Game-Runtime verwendet nicht den vor Start gebundenen, anschliessend vom echten Server fortgeschriebenen Restore.",
  );
  invariant(odooRestore.endpointSha256 !== baseline.odoo.restoreEndpointSha256 && odooRestore.stateSha256 === baseline.odoo.stateSha256, "Schema-29-Odoo-Runtime verwendet keinen getrennten unveraenderten create-new-Restore.");
  invariant(
    filestore.access === "read-only"
      && filestore.ownerUid === expected.odooOwnerUid
      && filestore.ownerGid === expected.odooOwnerGid
      && filestore.treeSha256 === baseline.odoo.filestoreTreeSha256
      && filestore.treeSha256 === filestoreSeal.finalFilestoreTreeSha256
      && filestore.accessSha256 === filestoreSeal.finalAccessSha256,
    "Schema-29-Odoo-Filestore ist nach dem Runtime-Drill nicht ownergebunden, read-only und bytegleich zur Baseline versiegelt.",
  );
  invariant(
    pristineGameRestore.endpointSha256 === baseline.game.restoreEndpointSha256
      && pristineGameRestore.backendSha256 === baseline.game.restoreBackendSha256
      && pristineGameRestore.stateSha256 === baseline.game.stateSha256,
    "Pristiner Schema-29-Game-Restore wurde waehrend des Legacy-Runtime-Drills veraendert.",
  );
  invariant(
    pristineOdooRestore.endpointSha256 === baseline.odoo.restoreEndpointSha256
      && pristineOdooRestore.stateSha256 === baseline.odoo.stateSha256
      && pristineFilestore.treeSha256 === baseline.odoo.filestoreTreeSha256,
    "Pristiner Schema-29-Odoo-DB-/Filestore-Restore wurde waehrend des Legacy-Runtime-Drills veraendert.",
  );
  const payload = {
    baselineReceiptHash: baseline.receiptHash,
    baselineReceiptSha256: baselineArtifact.sha256,
    candidateReleaseId: expected.candidateReleaseId,
    game: {
      containerId: runtimes.game.containerId,
      healthBodySha256: gameHealth.bodySha256,
      healthStatusCode: gameHealth.statusCode,
      imageDigest: expected.gameImageDigest,
      imageId: runtimes.game.imageId,
      imageReference: expected.gameImageReference,
    },
    gameProbeReceiptHash: gameProbe.receiptHash,
    gameProbeReceiptSha256: gameProbeArtifact.sha256,
    gameRestoreReceiptSha256: gameRestoreArtifact.sha256,
    gameRestoreStateSha256: gameRestore.stateSha256,
    gameSchedulerAdvance: schedulerAdvance,
    keycloak: {
      authorizationSha256: keycloakContinuity.authorizationSha256,
      authorizationStatusCode: keycloakContinuity.authorizationStatusCode,
      containerId: runtimes.keycloak.containerId,
      database: keycloakContinuity.database,
      healthBodySha256: keycloakContinuity.health.bodySha256,
      healthStatusCode: keycloakContinuity.health.statusCode,
      imageDigest: expected.keycloakImageDigest,
      imageId: runtimes.keycloak.imageId,
      imageReference: expected.keycloakImageReference,
      jwksSha256: keycloakContinuity.jwksSha256,
      jwksStatusCode: keycloakContinuity.jwksStatusCode,
      oidcSha256: keycloakContinuity.oidcSha256,
      oidcStatusCode: keycloakContinuity.oidcStatusCode,
      realmSha256: keycloakContinuity.realmSha256,
      realmStatusCode: keycloakContinuity.realmStatusCode,
    },
    odoo: {
      containerId: runtimes.odoo.containerId,
      healthBodySha256: odooHealth.bodySha256,
      healthStatusCode: odooHealth.statusCode,
      imageDigest: expected.odooImageDigest,
      imageId: runtimes.odoo.imageId,
      imageReference: expected.odooImageReference,
      runtimeUser: runtimes.odoo.user,
    },
    odooFilestoreFinalAccessSha256: filestore.accessSha256,
    odooFilestoreHostPath: expected.odooFilestoreHostPath,
    odooFilestoreOpenReceiptHash: filestoreOpen.receiptHash,
    odooFilestoreOpenReceiptSha256: filestoreOpenArtifact.sha256,
    odooFilestoreOwnerGid: expected.odooOwnerGid,
    odooFilestoreOwnerUid: expected.odooOwnerUid,
    odooFilestoreSealReceiptHash: filestoreSeal.receiptHash,
    odooFilestoreSealReceiptSha256: filestoreSealArtifact.sha256,
    odooFilestoreTreeSha256: filestore.treeSha256,
    odooProbeReceiptHash: odooProbe.receiptHash,
    odooProbeReceiptSha256: odooProbeArtifact.sha256,
    odooRestoreReceiptSha256: odooRestoreArtifact.sha256,
    odooRestoreStateSha256: odooRestore.stateSha256,
    previousReleaseId: expected.previousReleaseId,
    previousWorldId: expected.previousWorldId,
    pristineGameRestoreStateSha256: pristineGameRestore.stateSha256,
    pristineOdooFilestoreTreeSha256: pristineFilestore.treeSha256,
    pristineOdooRestoreStateSha256: pristineOdooRestore.stateSha256,
    qualifiedAt: now().toISOString(),
    recoveryId: expected.recoveryId,
    runtimeBeforeReceiptHash: runtimeBefore.receiptHash,
    runtimeBeforeReceiptSha256: runtimeBeforeArtifact.sha256,
    schema: RECEIPT_SCHEMA,
    worldDeploymentHash: worldDeploymentArtifact.value.deploymentHash,
    worldDeploymentSha256: worldDeploymentArtifact.sha256,
  };
  const receipt = validateProductionSchema29RuntimeDrillReceipt({ ...payload, receiptHash: canonicalSha256(payload) }, {
    recoveryId: expected.recoveryId,
    candidateReleaseId: expected.candidateReleaseId,
    previousReleaseId: expected.previousReleaseId,
    previousWorldId: expected.previousWorldId,
    baselineReceiptHash: baseline.receiptHash,
    baselineReceiptSha256: baselineArtifact.sha256,
    beforeHeadsSha256: runtimeBefore.headsSha256,
    gameImageDigest: expected.gameImageDigest,
    odooImageDigest: expected.odooImageDigest,
    odooFilestoreOwnerGid: expected.odooOwnerGid,
    odooFilestoreOwnerUid: expected.odooOwnerUid,
    odooFilestoreHostPath: expected.odooFilestoreHostPath,
    odooRestoreStateSha256: baseline.odoo.stateSha256,
    odooFilestoreTreeSha256: baseline.odoo.filestoreTreeSha256,
    pristineGameRestoreStateSha256: baseline.game.stateSha256,
    pristineOdooRestoreStateSha256: baseline.odoo.stateSha256,
    pristineOdooFilestoreTreeSha256: baseline.odoo.filestoreTreeSha256,
    runtimeBeforeReceiptHash: runtimeBefore.receiptHash,
    worldDeploymentHash: worldDeploymentArtifact.value.deploymentHash,
    worldDeploymentSha256: worldDeploymentArtifact.sha256,
  });
  await Promise.all([
    assertProductionColdBackupReceiptUnchanged(baselineArtifact),
    assertJsonUnchanged(gameProbeArtifact, "Legacy-Game-Schema-29-Probe"),
    assertJsonUnchanged(odooProbeArtifact, "Legacy-Odoo-Schema-29-Probe"),
    assertJsonUnchanged(filestoreOpenArtifact, "Schema-29-Odoo-Filestore-Open-Beleg"),
    assertJsonUnchanged(filestoreSealArtifact, "Schema-29-Odoo-Filestore-Seal-Beleg"),
    assertJsonUnchanged(gameRestoreArtifact, "Schema-29-Game-Runtime-Restore-Receipt"),
    assertJsonUnchanged(pristineOdooRestoreArtifact, "Schema-29-Odoo-Pristine-Restore-Receipt"),
    assertJsonUnchanged(odooRestoreArtifact, "Schema-29-Odoo-Runtime-Restore-Receipt"),
    assertJsonUnchanged(worldDeploymentArtifact, "Attestiertes Vorgaenger-World-Deployment"),
    assertProductionSchema29RuntimeBeforeReceiptUnchanged(runtimeBeforeArtifact),
  ]);
  await publishCreateNew(outputPath, receipt);
  return Object.freeze({ outputPath, receiptHash: receipt.receiptHash });
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    if (process.argv[2] !== "qualify" || process.argv.length !== 3) throw new Error("Aufruf: production-schema29-runtime-drill.mjs qualify");
    process.stdout.write(`${JSON.stringify(await qualifyProductionSchema29RuntimeDrill())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  }
}

export const PRODUCTION_SCHEMA29_RUNTIME_DRILL_SCHEMA = RECEIPT_SCHEMA;
