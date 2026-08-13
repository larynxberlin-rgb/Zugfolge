/** Produktionseinstieg: echte Postgres-Verbindung, echter Keycloak-Realm. */

import {
  createDatabase,
  createEconomyOutboxHealthCheck,
  createEventLogHealthCheck,
  alphaWorldProfiles,
  regionalSimulationStates,
  worldEventLog,
  worlds,
} from "@zugfolge/db";
import { AbuseGuard, AlphaFeedbackService, AlphaMonitoringService, InfraUpdateService, OnboardingService, TutorialService, WorldEndService, alphaHash, type AlphaWorldBlueprint } from "@zugfolge/alpha";
import {
  createHttpOdooProjectionClient,
  createHttpOdooReconciliationClient,
  createOdooBridgeHealthCheck,
  createOdooWebhookReceiptStore,
  dispatchOdooProjectionOutbox,
  enqueueAlphaFeedbackProjection,
  enqueueGameAdminCapabilityProjection,
  enqueueWorldProjection,
  processNextOdooCommand,
  reconcileOdooProjectionSnapshot,
  type OdooWebhookReceiverOptions,
  type SigningKey,
} from "@zugfolge/commerce";
import { OperationsRegistry } from "@zugfolge/dispatch";
import {
  PROVIDER_REFRESH_INTERVAL_MS,
  PublicInfrastructureRestrictionsClient,
} from "@zugfolge/disruption-provider";
import {
  createEconomyPlatformAdapters,
  createEconomySchedulerHealthCheck,
  decodeEconomyValue,
  EconomySchedulerMonitor,
  listEconomyWorldIds,
  parseStartingCapitalPolicy,
  runEconomySchedulerCycle,
  serializeStartingCapitalPolicy,
  type JournalAccounts,
} from "@zugfolge/economy";
import {
  AuthorizationError,
  createKeycloakHealthCheck,
  createKeycloakAdminClient,
  createKeycloakVerifier,
  getAccount,
  loadKeycloakConfigFromEnv,
  loadKeycloakAdminConfigFromEnv,
} from "@zugfolge/identity";
import {
  createLivemapHealthCheck,
  LivemapRegistry,
} from "@zugfolge/livemap-stream";
import { loadPlanningRuntime } from "@zugfolge/planning-runtime-native";
import { purgeExpiredAccountData } from "@zugfolge/privacy";
import {
  FLEET_INITIALIZE_SCHEMA,
  loadOperatingRuntime,
  loadRegionalSimulationRuntime,
  type OperatingRuntimeEvent,
} from "@zugfolge/runtime-native";
import { and, asc, eq } from "drizzle-orm";

import { buildApp } from "./app.js";
import {
  createDisruptionProviderHealthCheck,
  createDisruptionProviderStore,
  DisruptionProviderMonitor,
  runDisruptionProviderCycle,
} from "./disruption-provider-scheduler.js";
import { loadFleetAuthorityReleaseCatalog } from "./fleet-configuration.js";
import { GameInfraActivationSafety, parseInfraActivationSafetyReports } from "./infra-activation-safety.js";
import { InfraPackageStaging, createLocalMapPackageVerifier, type InfraUploadSigningKey } from "./infra-package-staging.js";
import { projectLivemapOperationEvent } from "./livemap-operation-projection.js";
import { loadLivemapReadModel } from "./livemap-read-model.js";
import { assertTrainMapProjectionBinding, loadTrainMapProjector } from "./livemap-train-map-projection.js";
import {
  MANUAL_DISRUPTION_ADMIN_CAPABILITY,
  createManualDisruptionAdminHandler,
} from "./manual-disruption-admin.js";
import {
  ABUSE_SANCTION_ACTIVATE_CAPABILITY,
  INFRA_RELEASE_ADOPTION_CAPABILITY,
  WORLD_ACCESS_REVOKE_CAPABILITY,
  WORLD_CLOSE_CAPABILITY,
  WORLD_DEPLOY_CAPABILITY,
  WORLD_DEPLOY_CAPABILITY_SCOPE_ID,
  createAbuseSanctionActivateAdminHandler,
  createInfraReleaseAdoptionAdminHandler,
  ensureSignedPlanningAuthority,
  createWorldCloseAdminHandler,
  createWorldDeployAdminHandler,
  createWorldAccessRevokeAdminHandler,
} from "./odoo-admin-handlers.js";
import { createProviderDisruptionConsumer } from "./provider-disruption-consumer.js";
import { generateDailyOperationReports, previousBerlinServiceDay } from "./daily-reports.js";
import {
  parsePlanningAuthorityAccountIdsJson,
  parsePlanningInfrastructureReleasesJson,
  verifyPlanningAuthorityAccounts,
} from "./planning-configuration.js";
import { createPlanningScheduler } from "./planning-scheduler.js";
import { advanceRegionalSimulations } from "./regional-simulation-scheduler.js";
import { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import { compareUtf8 } from "./utf8.js";
import {
  ProductionWorldStartPort,
  loadPersistedActiveAlphaWorldDeployments,
  loadActiveAlphaWorldProjectionProfiles,
  loadSignedAlphaWorldDeployment,
  persistSignedAlphaWorldDeployment,
  startSignedAlphaWorld,
} from "./alpha-world-start.js";
import { createAlphaInvitationAdminHandlers } from "./alpha-invitation-admin.js";
import { AuthoritativeOnboardingPort, AuthoritativeTutorialResetPort } from "./alpha-journey-adapters.js";
import { AlphaOperationsMetrics } from "./observability.js";
import {
  GameAlphaJourneyCommandWriter,
  parseAlphaJourneyAuthorityConfiguration,
  parseStartPackageSpec,
} from "./alpha-journey-writer.js";
import { ActiveWorldDeploymentRuntime } from "./world-deployment-runtime.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Umgebungsvariable '${name}' fehlt.`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function alphaWorldReleasePaths(): readonly string[] {
  const many = optionalEnv("ALPHA_WORLD_RELEASE_PATHS_JSON");
  const legacy = optionalEnv("ALPHA_WORLD_RELEASE_PATH");
  if (many === undefined) return legacy === undefined ? [] : [legacy];
  const parsed: unknown = JSON.parse(many);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((path) => typeof path !== "string" || path.trim() === "")) {
    throw new Error("ALPHA_WORLD_RELEASE_PATHS_JSON muss eine nichtleere Liste von Deploymentpfaden sein.");
  }
  if (legacy !== undefined) throw new Error("Einzel- und Mehrfachkonfiguration fuer Alpha-Deployments duerfen nicht kombiniert werden.");
  if (new Set(parsed).size !== parsed.length) throw new Error("Alpha-Deploymentpfade muessen eindeutig sein.");
  return parsed as readonly string[];
}

function parseSigningKeys(value: string): readonly SigningKey[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("ODOO_WEBHOOK_KEYS_JSON muss eine Schluesselliste sein.");
  return parsed.map((entry): SigningKey => {
    if (typeof entry !== "object" || entry === null) throw new Error("Odoo-Schluessel ist kein Objekt.");
    const record = entry as Record<string, unknown>;
    if (typeof record["id"] !== "string" || typeof record["secret"] !== "string" || typeof record["activeFrom"] !== "string") {
      throw new Error("Odoo-Schluessel ist unvollstaendig.");
    }
    const activeFrom = new Date(record["activeFrom"]);
    const activeUntil = typeof record["activeUntil"] === "string" ? new Date(record["activeUntil"]) : undefined;
    if (Number.isNaN(activeFrom.getTime()) || (activeUntil !== undefined && Number.isNaN(activeUntil.getTime()))) throw new Error("Odoo-Schluessel hat ungueltige Zeitgrenzen.");
    return { id: record["id"], secret: record["secret"], activeFrom, activeUntil };
  });
}

function parseTrustedReleaseKeys(value: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("INFRA_RELEASE_TRUSTED_KEYS_JSON muss ein Objekt sein.");
  if (Object.keys(parsed).length === 0) throw new Error("InfraRelease-Trust-Store darf nicht leer sein.");
  for (const [keyId, pem] of Object.entries(parsed)) {
    if (keyId.trim() === "" || typeof pem !== "string" || !pem.includes("PUBLIC KEY")) throw new Error("InfraRelease-Trust-Store enthaelt einen ungueltigen Schluessel.");
  }
  return parsed as Readonly<Record<string, string>>;
}

function parseInfraUploadKeys(value: string): readonly InfraUploadSigningKey[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("INFRA_UPLOAD_KEYS_JSON muss eine nichtleere Schlüsselliste sein.");
  const keys = parsed.map((entry): InfraUploadSigningKey => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Infra-Upload-Schlüssel ist kein Objekt.");
    const record = entry as Record<string, unknown>;
    if (typeof record["id"] !== "string" || record["id"].trim() === "" || typeof record["secret"] !== "string" || record["secret"].length < 32 || /replace|example|change.?me/i.test(record["secret"])) {
      throw new Error("Infra-Upload-Schlüssel ist unvollständig oder zu kurz.");
    }
    return { id: record["id"], secret: record["secret"] };
  });
  if (new Set(keys.map(({ id }) => id)).size !== keys.length) throw new Error("Infra-Upload-Schlüssel-IDs sind nicht eindeutig.");
  return keys;
}

async function loadOptionalInfraPackageStaging(): Promise<{
  readonly staging?: InfraPackageStaging;
  readonly keys?: readonly InfraUploadSigningKey[];
}> {
  const enabled = optionalEnv("INFRA_PACKAGE_STAGING_ENABLED");
  const root = optionalEnv("INFRA_PACKAGE_STAGING_ROOT");
  const keysJson = optionalEnv("INFRA_UPLOAD_KEYS_JSON");
  const verifierModule = optionalEnv("INFRA_PACKAGE_VERIFIER_MODULE");
  if (enabled === undefined || enabled === "false") return {};
  if (enabled !== "true") throw new Error("INFRA_PACKAGE_STAGING_ENABLED muss true oder false sein.");
  if (root === undefined || keysJson === undefined || verifierModule === undefined) {
    throw new Error("Infra-Paketstaging braucht explizit INFRA_PACKAGE_STAGING_ROOT, INFRA_UPLOAD_KEYS_JSON und INFRA_PACKAGE_VERIFIER_MODULE gemeinsam.");
  }
  const packageVerifier = await createLocalMapPackageVerifier(verifierModule);
  const staging = new InfraPackageStaging(root, { packageVerifier });
  await staging.initialize();
  return { staging, keys: parseInfraUploadKeys(keysJson) };
}

function loadOptionalOdooWebhookOptions(): OdooWebhookReceiverOptions | undefined {
  const tenantId = optionalEnv("ODOO_WEBHOOK_TENANT_ID");
  if (tenantId === undefined) return undefined;
  const authorizedActors = JSON.parse(requireEnv("ODOO_WEBHOOK_AUTHORIZED_ACTORS_JSON")) as Readonly<Record<string, readonly string[]>>;
  return { tenantId, keys: parseSigningKeys(requireEnv("ODOO_WEBHOOK_KEYS_JSON")), authorizedActors };
}

function persistedRegionalNowS(state: unknown): number {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error("Persistierter regionaler Simulationszustand ist kein Objekt.");
  }
  const nowS = (state as Readonly<Record<string, unknown>>)["nowS"];
  if (!Number.isSafeInteger(nowS) || (nowS as number) < 0) {
    throw new Error("Persistierter regionaler Simulationszustand hat keine sichere Weltsekunde.");
  }
  return nowS as number;
}

const db = createDatabase(requireEnv("DATABASE_URL"));
const infraPackageUpload = await loadOptionalInfraPackageStaging();
const odooWebhookOptions = loadOptionalOdooWebhookOptions();
const odooWebhookStore = odooWebhookOptions === undefined ? undefined : createOdooWebhookReceiptStore(db);
const odooProjectionUrl = optionalEnv("ODOO_PROJECTION_URL");
const odooProjectionKey = odooProjectionUrl === undefined
  ? undefined
  : {
    id: requireEnv("ODOO_PROJECTION_KEY_ID"),
    secret: requireEnv("ODOO_PROJECTION_SECRET"),
    activeFrom: new Date("1970-01-01T00:00:00.000Z"),
  };
const odooProjectionClient = odooProjectionUrl === undefined
  ? undefined
  : createHttpOdooProjectionClient(odooProjectionUrl, odooProjectionKey!);
const odooReconciliationUrl = optionalEnv("ODOO_RECONCILIATION_URL");
const odooReconciliationClient = odooReconciliationUrl === undefined || odooProjectionKey === undefined
  ? undefined
  : createHttpOdooReconciliationClient(odooReconciliationUrl, odooProjectionKey);
const keycloak = loadKeycloakConfigFromEnv();
const verifyToken = createKeycloakVerifier(keycloak);
const keycloakAdmin = createKeycloakAdminClient(loadKeycloakAdminConfigFromEnv());
const alphaInvitationAdminHandlers = createAlphaInvitationAdminHandlers({
  db,
  keycloak: keycloakAdmin,
  redirectUri: requireEnv("KEYCLOAK_INVITATION_REDIRECT_URI"),
  tutorialWorldId: requireEnv("ALPHA_TUTORIAL_WORLD_ID"),
});
const livemapReadModelPath = optionalEnv("LIVEMAP_READ_MODEL_PATH");
const livemapReadModel = livemapReadModelPath === undefined
  ? undefined
  : await loadLivemapReadModel(livemapReadModelPath);
const trainMapProjectionPath = optionalEnv("LIVEMAP_TRAIN_PROJECTION_PATH");
const trainMapProjector = trainMapProjectionPath === undefined
  ? undefined
  : loadTrainMapProjector(trainMapProjectionPath);
if (trainMapProjector !== undefined) {
  if (livemapReadModel === undefined) {
    trainMapProjector.close();
    throw new Error("Zugkartenprojektion erfordert den releasegebundenen Livemap-Detailkatalog.");
  }
  const config = await livemapReadModel.getConfig(trainMapProjector.worldId);
  try {
    assertTrainMapProjectionBinding(trainMapProjector, config);
  } catch (error) {
    trainMapProjector.close();
    livemapReadModel.close();
    throw error;
  }
}
const livemap = new LivemapRegistry({
  trainMapProjector,
  objectStateProjector: trainMapProjector,
});
const operations = new OperationsRegistry();
const economyMonitor = new EconomySchedulerMonitor(Date.now());
const disruptionProviderMonitor = new DisruptionProviderMonitor(Date.now());
const disruptionProviderClient = new PublicInfrastructureRestrictionsClient();
const disruptionProviderStore = createDisruptionProviderStore(db);
const operatingRuntime = loadOperatingRuntime();
const alphaJourneyWriter = new GameAlphaJourneyCommandWriter(
  db,
  operatingRuntime,
  parseAlphaJourneyAuthorityConfiguration(requireEnv("ALPHA_JOURNEY_AUTHORITY_JSON")),
  async (events) => { events.forEach((event) => projectLivemapOperationEvent(livemap, event)); },
);
const tutorial = new TutorialService(db, new AuthoritativeTutorialResetPort(alphaJourneyWriter));
const onboarding = new OnboardingService(db, new AuthoritativeOnboardingPort(alphaJourneyWriter));
const startPackageSpec = parseStartPackageSpec(requireEnv("ALPHA_START_PACKAGE_SPEC_JSON"));
const configuredFleetAuthorityReleases = await loadFleetAuthorityReleaseCatalog(
  requireEnv("ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH"),
);
const regionalSimulationRuntime = loadRegionalSimulationRuntime();
const planningRuntime = loadPlanningRuntime();
const configuredPlanningInfrastructureReleases = parsePlanningInfrastructureReleasesJson(
  requireEnv("PLANNING_INFRASTRUCTURE_RELEASES_JSON"),
);
const configuredPlanningAuthorityAccountIds = parsePlanningAuthorityAccountIdsJson(
  requireEnv("PLANNING_AUTHORITY_ACCOUNT_IDS_JSON"),
);
const trustedReleaseKeys = parseTrustedReleaseKeys(requireEnv("INFRA_RELEASE_TRUSTED_KEYS_JSON"));
const regionalSimulation = new RegionalSimulationWorker(
  db,
  regionalSimulationRuntime,
  livemap,
  operations,
);
const consumeProviderSnapshot = createProviderDisruptionConsumer(db, regionalSimulation);
const worldRows = await db
  .select({
    worldId: worlds.id,
    name: worlds.name,
    schedulePeriodWeeks: worlds.schedulePeriodWeeks,
    epoch: worlds.epoch,
    worldKind: worlds.worldKind,
    rankingStatus: worlds.rankingStatus,
    lifecycleStatus: worlds.lifecycleStatus,
  })
  .from(worlds)
  .orderBy(asc(worlds.id));
const activeWorldRows = worldRows.filter((world) => world.lifecycleStatus === "active");
const deploymentRuntime = new ActiveWorldDeploymentRuntime({
  activeWorlds: activeWorldRows,
  fleetAuthorityReleases: configuredFleetAuthorityReleases,
  planningAuthorityAccountIds: configuredPlanningAuthorityAccountIds,
  planningInfrastructureReleases: configuredPlanningInfrastructureReleases,
});
const persistedActiveDeployments = await loadPersistedActiveAlphaWorldDeployments(db, trustedReleaseKeys);
for (const persisted of persistedActiveDeployments) deploymentRuntime.register(persisted.signed, persisted.epoch);
const {
  boundaryTransitions,
  fleetAuthorityReleases,
  planningAuthorityAccountIds,
  planningInfrastructureReleases,
  worldEpochs,
} = deploymentRuntime;
const manualDisruptionAdminHandler = createManualDisruptionAdminHandler({
  worker: regionalSimulation,
  worldEpoch(worldId) {
    const epoch = worldEpochs.get(worldId);
    if (epoch === undefined) throw new Error(`Weltepoche fuer '${worldId}' fehlt.`);
    return epoch;
  },
});
const worldAccessRevokeAdminHandler = createWorldAccessRevokeAdminHandler({ db, keycloak: keycloakAdmin });
const alphaMonitoring = new AlphaMonitoringService(db);
const alphaOperationsMetrics = new AlphaOperationsMetrics();
const alphaPseudonymSecret = requireEnv("ALPHA_PSEUDONYM_SECRET");
const alphaFeedback = new AlphaFeedbackService(db, alphaPseudonymSecret, {
  async enqueue(tx, feedback) {
    await enqueueAlphaFeedbackProjection(tx, {
      worldId: feedback.worldId,
      correlationId: `alpha-feedback:${feedback.id}`,
      occurredAt: feedback.submittedAt,
      payload: {
        feedbackReference: feedback.id,
        participantPseudonym: feedback.participantPseudonym,
        releaseHash: feedback.releaseHash,
        fromS: feedback.fromS,
        untilS: feedback.untilS,
        eventReference: feedback.eventReference,
        reportReference: feedback.reportReference,
        category: feedback.category,
        message: feedback.message,
        contactAllowed: feedback.contactAllowed,
        submittedAt: feedback.submittedAt.toISOString(),
      },
    });
  },
});
const abuseGuard = new AbuseGuard(db);
const worldEnd = new WorldEndService(db);
const infraUpdate = new InfraUpdateService(
  db,
  trustedReleaseKeys,
  new GameInfraActivationSafety(db, parseInfraActivationSafetyReports(requireEnv("INFRA_ACTIVATION_SAFETY_REPORTS_JSON"))),
);
const abuseSanctionActivateAdminHandler = createAbuseSanctionActivateAdminHandler(abuseGuard);
const worldCloseAdminHandler = createWorldCloseAdminHandler(worldEnd);
const infraReleaseAdoptionAdminHandler = createInfraReleaseAdoptionAdminHandler(infraUpdate);
const configuredWorldIds = new Set(activeWorldRows.map((world) => world.worldId));
const configuredWorlds = new Map(activeWorldRows.map((world) => [world.worldId, world] as const));
for (const [worldId, authorityRelease] of Object.entries(fleetAuthorityReleases)) {
  if (!configuredWorldIds.has(worldId)) {
    throw new Error(`M5-Authority-Release ist an die unbekannte Welt '${worldId}' gebunden.`);
  }
  // Die TS-Konfiguration prueft Form und Grenzen; Rust prueft beim Start
  // zusaetzlich die fachliche Authority-Konsistenz. Das Ergebnis wird bewusst
  // verworfen: produktiver Zustand entsteht ausschliesslich atomar per Route.
  operatingRuntime.initializeFleet({
    schemaVersion: FLEET_INITIALIZE_SCHEMA,
    worldId,
    producedAt: 0,
    authorityRelease,
  });
}
await verifyPlanningAuthorityAccounts(
  db,
  deploymentRuntime.worldIds(),
  planningAuthorityAccountIds,
);

const economyAdapters = {
  ...createEconomyPlatformAdapters({
    db,
    accountsByOperator: JSON.parse(optionalEnv("ECONOMY_LEDGER_ACCOUNTS_JSON") ?? "{}") as Readonly<Record<string, JournalAccounts>>,
  }),
  operatingRuntime,
  async publishRuntimeEvents(events: readonly OperatingRuntimeEvent[]) {
    events.forEach((event) => projectLivemapOperationEvent(livemap, event));
  },
};

// The database event log remains authoritative across process restarts. Replay
// all durable marker changes before snapshots or live scheduler work are served.
for (const worldId of await listEconomyWorldIds(db)) {
  for (const event of await worldEventLog(db, worldId).listOfTypes([
    "livemap-operation-marked",
    "livemap-operation-cleared",
  ])) {
    const atS = event.occurredAt.getTime() / 1_000;
    if (!Number.isSafeInteger(atS)) throw new Error("Persistiertes Livemap-Betriebsereignis liegt nicht auf einer Weltsekunde.");
    if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
      throw new Error("Persistiertes Livemap-Betriebsereignis besitzt keine Nutzdaten.");
    }
    projectLivemapOperationEvent(livemap, {
      worldId,
      eventType: event.eventType,
      atS,
      payload: event.payload as Readonly<Record<string, unknown>>,
    });
  }
}

// Alle persistierten regionalen Rust-Zustaende werden vor dem ersten
// Listener restauriert. Welten ohne Zustand bleiben bewusst uninitialisiert
// und ihre Livemap-Routen damit auf 503.
for (const world of activeWorldRows) {
  const persistedRegions = await db
    .select({
      regionId: regionalSimulationStates.regionId,
      state: regionalSimulationStates.state,
    })
    .from(regionalSimulationStates)
    .where(eq(regionalSimulationStates.worldId, world.worldId));
  persistedRegions.sort(
    (left, right) => {
      const leftNowS = persistedRegionalNowS(left.state);
      const rightNowS = persistedRegionalNowS(right.state);
      return leftNowS === rightNowS
        ? compareUtf8(left.regionId, right.regionId)
        : leftNowS < rightNowS
          ? -1
          : 1;
    },
  );
  for (const region of persistedRegions) {
    await regionalSimulation.restore(world.worldId, region.regionId);
  }
}

const signedDeployments = new Map(
  persistedActiveDeployments.map((persisted) => [persisted.signed.deployment.worldId, persisted.signed] as const),
);
for (const alphaWorldReleasePath of alphaWorldReleasePaths()) {
  const signedDeployment = await loadSignedAlphaWorldDeployment(alphaWorldReleasePath, trustedReleaseKeys);
  const persisted = signedDeployments.get(signedDeployment.deployment.worldId);
  if (persisted !== undefined && persisted.deploymentHash !== signedDeployment.deploymentHash) {
    throw new Error(`Deploymentpfad fuer '${signedDeployment.deployment.worldId}' widerspricht dem autoritativ persistierten Deployment.`);
  }
  signedDeployments.set(signedDeployment.deployment.worldId, signedDeployment);
}
for (const signedDeployment of [...signedDeployments.values()].sort((left, right) => compareUtf8(left.deployment.worldId, right.deployment.worldId))) {
  const configuredWorld = configuredWorlds.get(signedDeployment.deployment.worldId);
  if (configuredWorld === undefined) {
    throw new Error(`Signiertes Alpha-Deployment ist an die unbekannte Welt '${signedDeployment.deployment.worldId}' gebunden.`);
  }
  const definition = signedDeployment.deployment.worldDefinition;
  if (
    configuredWorld.name !== definition.name
    || configuredWorld.schedulePeriodWeeks !== definition.schedulePeriodWeeks
    || configuredWorld.epoch.getTime() !== new Date(definition.epoch).getTime()
    || configuredWorld.worldKind !== (definition.kind === "public" ? "public" : "private")
    || configuredWorld.rankingStatus !== definition.rankingStatus
    || configuredWorld.lifecycleStatus !== "active"
  ) throw new Error(`Signiertes Alpha-Deployment weicht von der konfigurierten Welt '${configuredWorld.worldId}' ab.`);
  const worldStartPort = new ProductionWorldStartPort(
    db,
    signedDeployment,
    operatingRuntime,
    regionalSimulation,
    livemap,
    operations,
  );
  await ensureSignedPlanningAuthority(db, signedDeployment);
  await startSignedAlphaWorld(db, signedDeployment, worldStartPort);
  deploymentRuntime.register(signedDeployment, configuredWorld.epoch);
  await persistSignedAlphaWorldDeployment(db, signedDeployment);
}
const worldDeployAdminHandler = createWorldDeployAdminHandler({
  db,
  trustedKeys: trustedReleaseKeys,
  fleetRuntime: operatingRuntime,
  regionalSimulation,
  livemap,
  operations,
  async registerStartedWorld(started) {
    deploymentRuntime.register(started.signed, started.epoch);
    if (odooProjectionClient !== undefined) {
      for (const capability of [
        MANUAL_DISRUPTION_ADMIN_CAPABILITY,
        WORLD_ACCESS_REVOKE_CAPABILITY,
        ABUSE_SANCTION_ACTIVATE_CAPABILITY,
        WORLD_CLOSE_CAPABILITY,
        INFRA_RELEASE_ADOPTION_CAPABILITY,
      ]) {
        await enqueueGameAdminCapabilityProjection(db, {
          worldId: started.signed.deployment.worldId,
          correlationId: `world-deploy:${started.signed.deploymentHash}:${capability.actionType}`,
          capability,
        });
      }
    }
  },
});

const app = buildApp({
  db,
  verifyToken,
  livemap,
  livemapReadModel,
  operations,
  simulationIngestToken: requireEnv("SIMULATION_INGEST_TOKEN"),
  regionalSimulation,
  planningAuthorityAccountIds,
  fleetIngestToken: requireEnv("FLEET_INGEST_TOKEN"),
  fleetRuntime: operatingRuntime,
  fleetAuthorityReleases,
  adminControl: "odoo",
  alpha: {
    tutorial,
    onboarding,
    startPackageSpec,
    feedback: alphaFeedback,
    monitoring: alphaMonitoring,
    worldEnd,
    abuse: abuseGuard,
    pseudonymSecret: alphaPseudonymSecret,
    async authorizeMonitoring(worldId, keycloakSubject) {
      const account = await getAccount(db, { worldId, keycloakSubject });
      if (account === undefined || !account.roles.includes("world_admin")) {
        throw new AuthorizationError(`Konto ist kein Weltverwalter von '${worldId}'.`);
      }
    },
  },
  alphaAbuse: {
    abuse: abuseGuard,
    pseudonymSecret: alphaPseudonymSecret,
  },
  extraHealthChecks: [
    createKeycloakHealthCheck(keycloak),
    createEventLogHealthCheck(db),
    createEconomyOutboxHealthCheck(db),
    createEconomySchedulerHealthCheck(economyMonitor),
    createDisruptionProviderHealthCheck(disruptionProviderMonitor),
    createLivemapHealthCheck(livemap),
    createOdooBridgeHealthCheck(db),
  ],
  extraMetricSources: [alphaOperationsMetrics],
  odooWebhookStore,
  odooWebhookOptions,
  infraPackageStaging: infraPackageUpload.staging,
  infraUploadKeys: infraPackageUpload.keys,
});
app.addHook("onClose", async () => {
  trainMapProjector?.close();
  livemapReadModel?.close();
});

if (odooProjectionClient !== undefined) {
  await enqueueGameAdminCapabilityProjection(db, {
    worldId: WORLD_DEPLOY_CAPABILITY_SCOPE_ID,
    correlationId: `startup:global:${WORLD_DEPLOY_CAPABILITY.actionType}`,
    capability: WORLD_DEPLOY_CAPABILITY,
  });
  for (const world of activeWorldRows) {
    for (const capability of [
      MANUAL_DISRUPTION_ADMIN_CAPABILITY,
      WORLD_ACCESS_REVOKE_CAPABILITY,
      ABUSE_SANCTION_ACTIVATE_CAPABILITY,
      WORLD_CLOSE_CAPABILITY,
      INFRA_RELEASE_ADOPTION_CAPABILITY,
    ]) {
      await enqueueGameAdminCapabilityProjection(db, {
        worldId: world.worldId,
        correlationId: `startup:${world.worldId}:${capability.actionType}`,
        capability,
      });
    }
  }
}

let alphaProjectionCycle: Promise<void> | undefined;
const runAlphaProjection = () => {
  if (alphaProjectionCycle !== undefined || odooProjectionClient === undefined) return;
  const observedAt = new Date();
  alphaProjectionCycle = (async () => {
    const profiles = await loadActiveAlphaWorldProjectionProfiles(db);
    for (const profile of profiles) {
      const snapshot = await alphaMonitoring.snapshot(profile.worldId, observedAt);
      alphaOperationsMetrics.observe(snapshot);
      const epoch = worldEpochs.get(profile.worldId);
      if (epoch === undefined) throw new Error(`Weltepoche fuer Alpha-Projektion '${profile.worldId}' fehlt.`);
      const eventAge = snapshot.freshness.eventAgeSeconds;
      const runtimeStatus = eventAge === null || eventAge > 300 ? "down: kein aktueller autoritativer Eventstand"
        : eventAge > 60 ? `degraded: Eventstand ${eventAge}s alt` : "healthy: autoritativer Eventstand aktuell";
      const failedProjections = snapshot.bridges.odooProjection.failed;
      const workerStatus = failedProjections > 0 ? `degraded: ${failedProjections} fehlgeschlagene Odoo-Projektionen`
        : "healthy: keine fehlgeschlagene Odoo-Projektion";
      const projectionRevision = alphaHash("zugfolge-odoo-world-projection/v1", snapshot);
      const blueprint = decodeEconomyValue(profile.blueprint) as AlphaWorldBlueprint;
      const startingCapitalPolicy = serializeStartingCapitalPolicy(parseStartingCapitalPolicy(blueprint.startingCapitalPolicy));
      await enqueueWorldProjection(db, {
        worldId: profile.worldId,
        correlationId: `alpha-monitoring:${profile.worldId}:${observedAt.toISOString()}`,
        occurredAt: observedAt,
        payload: {
          worldName: snapshot.world.name,
          projectionRevision,
          profileKind: profile.profileKind,
          blueprintHash: profile.blueprintHash,
          ...(profile.deploymentHash === null ? {} : { deploymentHash: profile.deploymentHash }),
          startingCapitalPolicy,
          freshness: "delayed",
          simulationTime: new Date(epoch.getTime() + snapshot.world.simulationTimeS * 1_000).toISOString(),
          worldStatus: `${snapshot.world.status} / ${snapshot.world.lifecycleStatus}`,
          schedulePeriod: `${snapshot.world.currentPeriod + 1}/${snapshot.world.periodCount ?? "unbefristet"}`,
          infraReleaseHash: snapshot.world.releases.infra,
          economyReleaseHash: snapshot.world.releases.economy,
          runtimeStatus,
          workerStatus,
          telemetry: snapshot,
          authoritativeEventUrl: `${optionalEnv("PUBLIC_GAME_URL") ?? ""}/worlds/${profile.worldId}/alpha-monitoring`,
        },
      });
    }
  })().catch((error: unknown) => {
    app.log.error({ err: error }, "Odoo-Alpha-Monitoringprojektion fehlgeschlagen");
  }).finally(() => { alphaProjectionCycle = undefined; });
};
runAlphaProjection();
const alphaProjectionInterval = setInterval(runAlphaProjection, 30_000);
alphaProjectionInterval.unref();
app.addHook("onClose", async () => {
  clearInterval(alphaProjectionInterval);
  await alphaProjectionCycle;
});

let alphaPeriodCycle: Promise<void> | undefined;
const runAlphaPeriods = () => {
  if (alphaPeriodCycle !== undefined) return;
  const now = new Date();
  alphaPeriodCycle = (async () => {
    const profiles = await db.select({
      worldId: alphaWorldProfiles.worldId,
      state: alphaWorldProfiles.state,
      currentPeriod: alphaWorldProfiles.currentPeriod,
      accelerationFactor: alphaWorldProfiles.accelerationFactor,
      epoch: worlds.epoch,
      schedulePeriodWeeks: worlds.schedulePeriodWeeks,
    }).from(alphaWorldProfiles).innerJoin(worlds, eq(worlds.id, alphaWorldProfiles.worldId)).where(eq(alphaWorldProfiles.state, "running")).orderBy(asc(alphaWorldProfiles.worldId));
    for (const profile of profiles) {
      const periodSeconds = profile.schedulePeriodWeeks * 7 * 86_400;
      const simNowS = Math.max(0, Math.floor((now.getTime() - profile.epoch.getTime()) / 1_000) * profile.accelerationFactor);
      const targetPeriod = Math.floor(simNowS / periodSeconds);
      for (let period = profile.currentPeriod + 1; period <= targetPeriod; period += 1) {
        const boundaryS = period * periodSeconds;
        const activated = await infraUpdate.activateAtPeriodBoundary(profile.worldId, period, boundaryS);
        if (activated === undefined) {
          await db.update(alphaWorldProfiles).set({ currentPeriod: period }).where(and(
            eq(alphaWorldProfiles.worldId, profile.worldId), eq(alphaWorldProfiles.currentPeriod, period - 1), eq(alphaWorldProfiles.state, "running"),
          ));
        }
      }
    }
  })().catch((error: unknown) => {
    app.log.error({ err: error }, "Alpha-Periodenwechsel oder InfraRelease-Aktivierung fehlgeschlagen");
  }).finally(() => { alphaPeriodCycle = undefined; });
};
runAlphaPeriods();
const alphaPeriodInterval = setInterval(runAlphaPeriods, 10_000);
alphaPeriodInterval.unref();
app.addHook("onClose", async () => {
  clearInterval(alphaPeriodInterval);
  await alphaPeriodCycle;
});

// Erster expliziter 1:1-Takt noch vor dem Listener: Ein restaurierter Zustand
// wird nicht fuer einen kurzen Zeitraum mit alter Weltzeit ausgeliefert.
await advanceRegionalSimulations(regionalSimulation, worldEpochs, new Date(), boundaryTransitions);
let regionalAdvanceCycle: Promise<void> | undefined;
const runRegionalAdvance = () => {
  if (regionalAdvanceCycle !== undefined) return;
  regionalAdvanceCycle = advanceRegionalSimulations(
    regionalSimulation,
    worldEpochs,
    new Date(),
    boundaryTransitions,
  )
    .then(() => undefined)
    .catch((error: unknown) => {
      app.log.error({ err: error }, "Regionaler 1:1-Simulationstakt fehlgeschlagen");
    })
    .finally(() => {
      regionalAdvanceCycle = undefined;
    });
};
// Variante B liefert bis zu 1.634 Tageslaeufe. Autoritative 60-Sekunden-
// Samples halten das replaybare Kommandolog betriebsfaehig; der Livemap-
// Client interpoliert ausschliesslich zwischen diesen echten Samples.
// Fachkommandos (Grenze, Stoerung, Disposition) bleiben davon unberuehrt und
// tragen weiterhin ihre exakte Simulationssekunde.
const regionalAdvanceInterval = setInterval(runRegionalAdvance, 60_000);
regionalAdvanceInterval.unref();
app.addHook("onClose", async () => {
  clearInterval(regionalAdvanceInterval);
  await regionalAdvanceCycle;
});

// Commerce laeuft ausserhalb jedes Simulations-, Planner- und Loginpfads.
// Auch ein langer Odoo-Ausfall laesst nur die Outbox wachsen; der Prozess
// bleibt erreichbar und bestehende Entitlements bleiben lokal gueltig.
let commerceCycle: Promise<void> | undefined;
const runCommerce = () => {
  if (commerceCycle !== undefined) return;
  commerceCycle = (async () => {
    while (await processNextOdooCommand(db, new Date(), {
      adminHandlers: {
        manual_disruption_create: manualDisruptionAdminHandler,
        world_access_revoke: worldAccessRevokeAdminHandler,
        abuse_sanction_activate: abuseSanctionActivateAdminHandler,
        world_close: worldCloseAdminHandler,
        infra_release_adoption: infraReleaseAdoptionAdminHandler,
        world_deploy: worldDeployAdminHandler,
        ...alphaInvitationAdminHandlers,
      },
    }) !== undefined) {
      // Alle bereits vorliegenden Befehle abarbeiten, ohne auf Odoo zu warten.
    }
    if (odooProjectionClient !== undefined) await dispatchOdooProjectionOutbox(db, odooProjectionClient, new Date());
  })().catch((error: unknown) => {
    app.log.error({ err: error }, "Odoo-Bridge-Lauf fehlgeschlagen");
  }).finally(() => { commerceCycle = undefined; });
};
runCommerce();
const commerceInterval = setInterval(runCommerce, 5_000);
commerceInterval.unref();
app.addHook("onClose", async () => {
  clearInterval(commerceInterval);
  await commerceCycle;
});

let reconciliationCycle: Promise<void> | undefined;
const runOdooReconciliation = () => {
  if (reconciliationCycle !== undefined || odooReconciliationClient === undefined) return;
  reconciliationCycle = odooReconciliationClient.snapshot()
    .then((snapshot) => reconcileOdooProjectionSnapshot(db, snapshot, new Date()))
    .then(() => undefined)
    .catch((error: unknown) => {
      app.log.error({ err: error }, "Odoo-Nachtabgleich fehlgeschlagen");
    })
    .finally(() => { reconciliationCycle = undefined; });
};
runOdooReconciliation();
const reconciliationInterval = setInterval(runOdooReconciliation, 24 * 60 * 60 * 1_000);
reconciliationInterval.unref();
app.addHook("onClose", async () => {
  clearInterval(reconciliationInterval);
  await reconciliationCycle;
});

const planningScheduler = createPlanningScheduler(
  db,
  planningRuntime,
  planningInfrastructureReleases,
  () => deploymentRuntime.worldIds(),
  {
    onError: (error) => {
      app.log.error({ err: error }, "Planning-Consumer-Lauf fehlgeschlagen");
    },
  },
);
planningScheduler.start();
app.addHook("onClose", async () => {
  await planningScheduler.close();
});

let economyCycle: Promise<void> | undefined;
const runEconomy = () => {
  if (economyCycle !== undefined) return;
  economyCycle = runEconomySchedulerCycle(db, new Date(), economyAdapters, economyMonitor)
    .then(() => undefined)
    .catch((error: unknown) => {
      app.log.error({ err: error }, "Economy-Frist- oder Outbox-Lauf fehlgeschlagen");
    })
    .finally(() => {
      economyCycle = undefined;
    });
};
runEconomy();
const economyInterval = setInterval(runEconomy, 10_000);
economyInterval.unref();
app.addHook("onClose", async () => {
  clearInterval(economyInterval);
  await economyCycle;
});

let disruptionProviderCycle: Promise<void> | undefined;
const runDisruptionProvider = () => {
  if (disruptionProviderCycle !== undefined) return;
  disruptionProviderCycle = runDisruptionProviderCycle(
    disruptionProviderClient,
    disruptionProviderStore,
    disruptionProviderMonitor,
    new Date(),
    consumeProviderSnapshot,
  )
    .then(() => undefined)
    .catch((error: unknown) => app.log.error({ err: error }, "Abruf realistischer Infrastruktur-Einschraenkungen fehlgeschlagen"))
    .finally(() => { disruptionProviderCycle = undefined; });
};
runDisruptionProvider();
const disruptionProviderInterval = setInterval(runDisruptionProvider, PROVIDER_REFRESH_INTERVAL_MS);
disruptionProviderInterval.unref();
app.addHook("onClose", async () => {
  clearInterval(disruptionProviderInterval);
  await disruptionProviderCycle;
});

let dailyReportCycle: Promise<void> | undefined;
const runDailyReports = () => {
  if (dailyReportCycle !== undefined) return;
  const now = new Date();
  dailyReportCycle = generateDailyOperationReports(db, previousBerlinServiceDay(now), now)
    .then(() => undefined)
    .catch((error: unknown) => app.log.error({ err: error }, "M7-Tagesberichtslauf fehlgeschlagen"))
    .finally(() => { dailyReportCycle = undefined; });
};
runDailyReports();
const dailyReportInterval = setInterval(runDailyReports, 60 * 60 * 1_000);
dailyReportInterval.unref();
app.addHook("onClose", async () => {
  clearInterval(dailyReportInterval);
  await dailyReportCycle;
});

const purge = () => {
  void purgeExpiredAccountData(db, new Date()).catch((error: unknown) => {
    app.log.error({ err: error }, "Datenschutz-Räumlauf fehlgeschlagen");
  });
};
purge();
const purgeInterval = setInterval(purge, 24 * 60 * 60 * 1_000);
purgeInterval.unref();
app.addHook("onClose", async () => clearInterval(purgeInterval));

const port = Number(process.env["PORT"] ?? "3000");
await app.listen({ host: "0.0.0.0", port });
