/** Produktionseinstieg: echte Postgres-Verbindung, echter Keycloak-Realm. */

import Fastify from "fastify";
import { purgeExpiredMailboxMessages } from "@zugfolge/mailbox";

import {
  createDatabase,
  createEconomyOutboxHealthCheck,
  createEventLogHealthCheck,
  alphaWorldProfiles,
  worldEventLog,
  worlds,
} from "@zugfolge/db";
import {
  AbuseGuard,
  AlphaFeedbackService,
  AlphaMonitoringService,
  InfraUpdateService,
  WorldEndService,
  alphaHash,
  effectiveStartingCapitalPolicy,
  type AlphaWorldBlueprint,
} from "@zugfolge/alpha";
import {
  createHttpOdooProjectionClient,
  createHttpOdooReconciliationClient,
  createOdooBridgeHealthCheck,
  createOdooWebhookReceiptStore,
  dispatchOdooProjectionOutbox,
  enqueueAlphaFeedbackProjection,
  enqueueGameAdminCapabilityProjection,
  enqueuePublicWorldSnapshot,
  enqueueWorldProjection,
  listPendingOdooProjectionWorldIds,
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
  loadDemandRuntime,
  loadConductorInteriorRuntime,
  loadConductorSessionRuntime,
  loadConductorDialogueValidator,
  loadConductorSceneRuntime,
  loadOperationalSimulationRuntime,
  type OperatingRuntimeEvent,
} from "@zugfolge/runtime-native";
import { and, asc, eq } from "drizzle-orm";

import { buildApp } from "./app.js";
import { DemandService, loadDemandDeployment } from "./demand-service.js";
import { committedInteriorTime, loadConductorInteriorDeployment } from "./conductor-interior-configuration.js";
import { ConductorInteriorService } from "./conductor-interior.js";
import { ConductorSessionService } from "./conductor-session-service.js";
import { loadConductorSessionDeployment } from "./conductor-session-configuration.js";
import { loadConductorSceneDeployment } from "./conductor-scene-configuration.js";
import { loadFareControlRuntime } from "./conductor-control-runtime.js";
import { loadConductorControlDeployment } from "./conductor-control-configuration.js";
import { createConductorControlIntegration } from "./conductor-control.js";
import { createConductorPoliceAdapter } from "./conductor-police.js";
import { advanceConductorControlWorld } from "./conductor-session-scheduler.js";
import { SpfvService } from "./spfv-service.js";
import {
  createDisruptionProviderHealthCheck,
  createDisruptionProviderStore,
  DisruptionProviderMonitor,
  runDisruptionProviderCycle,
} from "./disruption-provider-scheduler.js";
import { loadFleetAuthorityReleaseCatalog } from "./fleet-configuration.js";
import { GameInfraActivationSafety, parseInfraActivationSafetyReports } from "./infra-activation-safety.js";
import { createInfraOperationalV2NativeVerifier } from "./infra-operational-native-verifier.js";
import { InfraPackageStaging, createLocalMapPackageVerifier, type InfraUploadSigningKey } from "./infra-package-staging.js";
import {
  assertNoLegacyHotInfrastructureChanges,
  createInfraReleaseRuntimeConsistencyHealthCheck,
  reconcileActiveWorldInfrastructureRuntimes,
  type ActiveWorldInfrastructureBaseline,
} from "./infra-release-runtime-consistency.js";
import { projectLivemapOperationEvent } from "./livemap-operation-projection.js";
import {
  assertLivemapReadModelRuntimeScheduleBinding,
  loadLivemapReadModel,
} from "./livemap-read-model.js";
import { assertTrainMapProjectionBinding, loadTrainMapProjector } from "./livemap-train-map-projection.js";
import {
  MANUAL_DISRUPTION_ADMIN_CAPABILITY,
  createManualDisruptionAdminHandler,
} from "./manual-disruption-admin.js";
import { createDisruptionPolicyAdminHandler, DISRUPTION_POLICY_ADMIN_CAPABILITY } from "./disruption-policy-admin.js";
import {
  ABUSE_SANCTION_ACTIVATE_CAPABILITY,
  WORLD_ACCESS_REVOKE_CAPABILITY,
  WORLD_CLOSE_CAPABILITY,
  WORLD_DEPLOY_CAPABILITY,
  WORLD_DEPLOY_CAPABILITY_SCOPE_ID,
  createAbuseSanctionActivateAdminHandler,
  createInfraReleaseAdoptionAdminHandler,
  infraReleaseAdoptionCapability,
  ensureSignedPlanningAuthority,
  createWorldCloseAdminHandler,
  createWorldDeployAdminHandler,
  createWorldAccessRevokeAdminHandler,
  enqueueStartedWorldCapabilities,
  worldIdsForOdooProjectionDispatch,
} from "./odoo-admin-handlers.js";
import { createProviderDisruptionConsumer } from "./provider-disruption-consumer.js";
import { DailyRestrictionCommandCatalog, createDailyRestrictionPolicyLoader } from "./daily-restriction-catalog.js";
import { generateDailyOperationReports, previousBerlinServiceDay } from "./daily-reports.js";
import { alphaMonitoringApiUrl } from "./alpha-routes.js";
import {
  parsePlanningAuthorityAccountIdsJson,
  parsePlanningInfrastructureReleasesJson,
  verifyPlanningAuthorityAccounts,
} from "./planning-configuration.js";
import { createPlanningScheduler } from "./planning-scheduler.js";
import {
  RegionalSimulationCycleCoordinator,
  regionalSimulationStartupRouteAllowed,
} from "./regional-simulation-cycle.js";
import { advanceRegionalSimulations } from "./regional-simulation-scheduler.js";
import { ManualDisruptionCommandCatalog } from "./manual-disruption-catalog.js";
import {
  createRegionalSimulationSchedulerHealthCheck,
  LIVEMAP_FRESHNESS_MAXIMUM_AGE_MS,
  REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS,
  RegionalSimulationSchedulerMonitor,
} from "./regional-simulation-monitor.js";
import { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import {
  parseTrustedReleaseKeys as parseCanonicalTrustedReleaseKeys,
  parseTrustedReleaseKeyScopes,
} from "./trusted-release-keys.js";
import { compareUtf8 } from "./utf8.js";
import {
  ProductionWorldStartPort,
  assertActivePublicWorldDeploymentCoverage,
  loadActiveAlphaWorldProjectionProfiles,
  loadSignedAlphaWorldDeployment,
  persistSignedAlphaWorldDeployment,
  resolveAlphaWorldStartupDeployments,
  startSignedAlphaWorld,
} from "./alpha-world-start.js";
import { createAlphaInvitationAdminHandlers } from "./alpha-invitation-admin.js";
import { AlphaOperationsMetrics } from "./observability.js";
import { createWorldParticipationHandler } from "./odoo-world-participation.js";
import {
  PublicWorldSnapshotUnavailableError,
  buildPublicWorldSnapshot,
} from "./public-world-snapshot.js";
import { ActiveWorldDeploymentRuntime } from "./world-deployment-runtime.js";
import { assertServerWorldDatabase, assertServerWorldDeployment, serverWorldScope } from "./server-world-scope.js";

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
  return parseCanonicalTrustedReleaseKeys(value);
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

async function loadOptionalInfraPackageStaging(
  trustedReleaseKeys: Readonly<Record<string, string>>,
): Promise<{
  readonly staging?: InfraPackageStaging;
  readonly keys?: readonly InfraUploadSigningKey[];
}> {
  const enabled = optionalEnv("INFRA_PACKAGE_STAGING_ENABLED");
  const root = optionalEnv("INFRA_PACKAGE_STAGING_ROOT");
  const keysJson = optionalEnv("INFRA_UPLOAD_KEYS_JSON");
  const verifierModule = optionalEnv("INFRA_PACKAGE_VERIFIER_MODULE");
  const operationalVerifierPath = optionalEnv("INFRA_OPERATIONAL_V2_VALIDATOR_PATH");
  if (enabled === undefined || enabled === "false") return {};
  if (enabled !== "true") throw new Error("INFRA_PACKAGE_STAGING_ENABLED muss true oder false sein.");
  if (root === undefined || keysJson === undefined || verifierModule === undefined || operationalVerifierPath === undefined) {
    throw new Error("Infra-Paketstaging braucht explizit INFRA_PACKAGE_STAGING_ROOT, INFRA_UPLOAD_KEYS_JSON, INFRA_PACKAGE_VERIFIER_MODULE und INFRA_OPERATIONAL_V2_VALIDATOR_PATH gemeinsam.");
  }
  const [packageVerifier, nativeOperationalVerifier] = await Promise.all([
    createLocalMapPackageVerifier(verifierModule),
    createInfraOperationalV2NativeVerifier(operationalVerifierPath),
  ]);
  const staging = new InfraPackageStaging(root, { packageVerifier, trustedReleaseKeys, nativeOperationalVerifier });
  await staging.initialize();
  return { staging, keys: parseInfraUploadKeys(keysJson) };
}

function loadOptionalOdooWebhookOptions(): OdooWebhookReceiverOptions | undefined {
  const tenantId = optionalEnv("ODOO_WEBHOOK_TENANT_ID");
  if (tenantId === undefined) return undefined;
  const authorizedActors = JSON.parse(requireEnv("ODOO_WEBHOOK_AUTHORIZED_ACTORS_JSON")) as Readonly<Record<string, readonly string[]>>;
  return { tenantId, keys: parseSigningKeys(requireEnv("ODOO_WEBHOOK_KEYS_JSON")), authorizedActors };
}

const trustedReleaseKeys = parseTrustedReleaseKeys(requireEnv("INFRA_RELEASE_TRUSTED_KEYS_JSON"));
const trustedReleaseKeyScopes = parseTrustedReleaseKeyScopes(
  requireEnv("RELEASE_TRUSTED_KEY_SCOPES_JSON"),
  trustedReleaseKeys,
);
const alphaWorldTrustedKeys = trustedReleaseKeyScopes.alphaWorldDeployments;
const mapInfraTrustedKeys = trustedReleaseKeyScopes.mapInfraDeliveries;
const db = createDatabase(requireEnv("DATABASE_URL"));
const worldScope = serverWorldScope(requireEnv("ZUGFOLGE_WORLD_ID"), requireEnv("PUBLIC_GAME_URL"));
await assertServerWorldDatabase(db, worldScope);
const infraPackageUpload = await loadOptionalInfraPackageStaging(mapInfraTrustedKeys);
const infraReleaseAdoptionRuntimeCapability = infraReleaseAdoptionCapability(infraPackageUpload.staging !== undefined);
const assertCommerceWorldScope = (worldId: string): void => {
  if (worldId !== worldScope.worldId) throw new Error("Odoo-Befehl liegt ausserhalb der Serverhauptwelt.");
};
const configuredOdooWebhookOptions = loadOptionalOdooWebhookOptions();
const odooWebhookOptions = configuredOdooWebhookOptions === undefined ? undefined
  : { ...configuredOdooWebhookOptions, assertWorldScope: assertCommerceWorldScope };
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
}
const livemap = new LivemapRegistry({
  trainMapProjector,
  objectStateProjector: trainMapProjector,
});
const operations = new OperationsRegistry();
const economyMonitor = new EconomySchedulerMonitor(Date.now());
const regionalSimulationMonitor = new RegionalSimulationSchedulerMonitor(Date.now());
const disruptionProviderMonitor = new DisruptionProviderMonitor(Date.now());
const disruptionProviderClient = new PublicInfrastructureRestrictionsClient();
const disruptionProviderStore = createDisruptionProviderStore(db);
const operatingRuntime = loadOperatingRuntime();
const configuredFleetAuthorityConfigurations = await loadFleetAuthorityReleaseCatalog(
  requireEnv("ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH"),
);
const operationalSimulationRuntime = loadOperationalSimulationRuntime();
const planningRuntime = loadPlanningRuntime();
const configuredPlanningInfrastructureReleases = parsePlanningInfrastructureReleasesJson(
  requireEnv("PLANNING_INFRASTRUCTURE_RELEASES_JSON"),
);
const configuredPlanningAuthorityAccountIds = parsePlanningAuthorityAccountIdsJson(
  requireEnv("PLANNING_AUTHORITY_ACCOUNT_IDS_JSON"),
);
const regionalSimulation = new RegionalSimulationWorker(
  db,
  operationalSimulationRuntime,
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
  worldId: worldScope.worldId,
  operationalProgramPreflight: (initialization) =>
    operationalSimulationRuntime.initialize(initialization).validationReceipt,
  fleetAuthorityConfigurations: configuredFleetAuthorityConfigurations,
  planningAuthorityAccountIds: configuredPlanningAuthorityAccountIds,
  planningInfrastructureReleases: configuredPlanningInfrastructureReleases,
});
// Statische Authority-Kataloge koennen nach einem dauerhaften Weltabschluss
// noch dieselbe Produktionskonfiguration enthalten. Archivierte Weltanteile
// duerfen weder in die aktive Registry noch in deren spaetere Coverage-Gates
// gelangen.
for (const world of worldRows) {
  if (world.lifecycleStatus === "archived") deploymentRuntime.releaseWorld(world.worldId);
}
const configuredSignedDeployments = await Promise.all(
  (optionalEnv("ALPHA_WORLD_RELEASE_PATH") === undefined ? [] : [requireEnv("ALPHA_WORLD_RELEASE_PATH")]).map((path) => loadSignedAlphaWorldDeployment(path, alphaWorldTrustedKeys)),
);
for (const signed of configuredSignedDeployments) {
  assertServerWorldDeployment(worldScope, signed.deployment);
}
const {
  archivedWorldIds,
  persistedActiveDeployments,
  signedDeployments,
} = await resolveAlphaWorldStartupDeployments(
  db,
  alphaWorldTrustedKeys,
  configuredSignedDeployments,
);
for (const worldId of archivedWorldIds) deploymentRuntime.releaseWorld(worldId);
for (const persisted of persistedActiveDeployments) {
  assertServerWorldDeployment(worldScope, persisted.signed.deployment);
  deploymentRuntime.register(persisted.signed, persisted.epoch);
}
const activeWorldInfrastructureBaselines = (): readonly ActiveWorldInfrastructureBaseline[] =>
  deploymentRuntime.realtimeRegions().map((region) => {
    const signed = signedDeployments.get(region.worldId);
    if (
      signed === undefined
      || signed.deployment.regionalSimulation.regionId !== region.regionId
    ) {
      throw new Error(`Operational-v2-Registry fuer '${region.worldId}/${region.regionId}' besitzt kein verifiziertes signiertes Deployment.`);
    }
    return Object.freeze({
      worldId: region.worldId,
      infraReleaseHash: signed.deployment.infraReleaseHash,
      regions: Object.freeze([Object.freeze({
        regionId: region.regionId,
        initializationHash: region.initializationHash,
        infrastructure: signed.deployment.regionalSimulation.infraRelease,
      })]),
    });
  });
await assertNoLegacyHotInfrastructureChanges(db, [...signedDeployments.keys()]);
deploymentRuntime.assertVehicleCatalogDeploymentBindings(signedDeployments);
if (trainMapProjector !== undefined) {
  try {
    const config = await livemapReadModel!.getConfig(trainMapProjector.worldId);
    assertTrainMapProjectionBinding(
      trainMapProjector,
      config,
      signedDeployments.get(trainMapProjector.worldId)?.deploymentHash,
    );
  } catch (error) {
    trainMapProjector.close();
    livemapReadModel!.close();
    throw error;
  }
}
const {
  fleetAuthorityConfigurations,
  fleetAuthorityReleases,
  planningAuthorityAccountIds,
  planningInfrastructureReleases,
  worldEpochs,
} = deploymentRuntime;
const worldAccessRevokeAdminHandler = createWorldAccessRevokeAdminHandler({ db, keycloak: keycloakAdmin });
const worldParticipationHandler = createWorldParticipationHandler(db);
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
  mapInfraTrustedKeys,
  new GameInfraActivationSafety(db, parseInfraActivationSafetyReports(requireEnv("INFRA_ACTIVATION_SAFETY_REPORTS_JSON"))),
);
const abuseSanctionActivateAdminHandler = createAbuseSanctionActivateAdminHandler(abuseGuard);
const worldCloseAdminHandler = createWorldCloseAdminHandler(worldEnd, (worldId) => {
  regionalSimulation.releaseWorld(worldId);
  deploymentRuntime.releaseWorld(worldId);
  signedDeployments.delete(worldId);
});
const infraReleaseAdoptionAdminHandler = createInfraReleaseAdoptionAdminHandler(infraUpdate, infraPackageUpload.staging);
const configuredWorldIds = new Set(activeWorldRows.map((world) => world.worldId));
const configuredWorlds = new Map(activeWorldRows.map((world) => [world.worldId, world] as const));
for (const [worldId, configuration] of Object.entries(fleetAuthorityConfigurations)) {
  if (!configuredWorldIds.has(worldId)) {
    throw new Error(`M5-Authority-Release ist an die unbekannte Welt '${worldId}' gebunden.`);
  }
  // Die TS-Konfiguration prueft Form und Grenzen; Rust prueft beim Start
  // zusaetzlich die fachliche Authority-Konsistenz. Das Ergebnis wird bewusst
  // verworfen: produktiver Zustand entsteht ausschliesslich atomar per Route.
  operatingRuntime.initializeFleet({
    schemaVersion: FLEET_INITIALIZE_SCHEMA,
    worldId,
    producedAt: configuration.producedAt,
    authorityRelease: configuration.authorityRelease,
  });
}
const configuredEconomyAdapters = createEconomyPlatformAdapters({
  db,
  accountsByOperator: JSON.parse(optionalEnv("ECONOMY_LEDGER_ACCOUNTS_JSON") ?? "{}") as Readonly<Record<string, JournalAccounts>>,
});
const economyAdapters = {
  ...configuredEconomyAdapters,
  operatingRuntime,
  async publishRuntimeEvents(events: readonly OperatingRuntimeEvent[]) {
    events.forEach((event) => projectLivemapOperationEvent(livemap, event));
  },
};

// The database event log remains authoritative across process restarts. Replay
// all durable marker changes before snapshots or live scheduler work are served.
for (const worldId of deploymentRuntime.realtimeWorldIds()) {
  for (const event of await worldEventLog(db, worldId).listOfTypes([
    "alpha.public-operation-visible",
    "livemap-operation-marked",
    "livemap-operation-cleared",
  ])) {
    const atS = event.eventType === "alpha.public-operation-visible"
      ? 0
      : event.occurredAt.getTime() / 1_000;
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

for (const signedDeployment of [...signedDeployments.values()].sort((left, right) => compareUtf8(left.deployment.worldId, right.deployment.worldId))) {
  assertLivemapReadModelRuntimeScheduleBinding(livemapReadModel, {
    worldId: signedDeployment.deployment.worldId,
    worldEpoch: signedDeployment.deployment.worldDefinition.epoch,
    repeatEveryS: signedDeployment.deployment.repeatEveryS,
  });
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
  await ensureSignedPlanningAuthority(db, signedDeployment);
  const operationalProgramLease = deploymentRuntime.prepareOperationalProgram(signedDeployment);
  try {
    const worldStartPort = new ProductionWorldStartPort(
      db,
      signedDeployment,
      operatingRuntime,
      regionalSimulation,
      livemap,
      operations,
      deploymentRuntime,
    );
    await startSignedAlphaWorld(db, signedDeployment, worldStartPort);
    deploymentRuntime.register(signedDeployment, configuredWorld.epoch);
    await persistSignedAlphaWorldDeployment(db, signedDeployment);
  } catch (error) {
    operationalProgramLease.rollback();
    throw error;
  }
}
// Erst startSignedAlphaWorld erzeugt beim Erststart Profil und Regionalstate
// beziehungsweise restauriert beim Restart den bereits persistierten Kopf.
// Die danach folgende Revalidierung bleibt vor App, Listener und Scheduler und
// kann deshalb keinen unvollstaendigen Deployment-Kopf fuer Traffic freigeben.
await reconcileActiveWorldInfrastructureRuntimes(
  db,
  deploymentRuntime,
  activeWorldInfrastructureBaselines(),
);
await assertActivePublicWorldDeploymentCoverage(db, alphaWorldTrustedKeys);
await verifyPlanningAuthorityAccounts(
  db,
  deploymentRuntime.worldIds(),
  planningAuthorityAccountIds,
);
const worldDeployAdminHandler = createWorldDeployAdminHandler({
  db,
  trustedKeys: alphaWorldTrustedKeys,
  fleetRuntime: operatingRuntime,
  regionalSimulation,
  livemap,
  operations,
  operationalPrograms: deploymentRuntime,
  prepareWorldProgram: (signed) => deploymentRuntime.prepareOperationalProgram(signed),
  async validateSignedDeployment(signed) {
    assertServerWorldDeployment(worldScope, signed.deployment);
    assertLivemapReadModelRuntimeScheduleBinding(livemapReadModel, {
      worldId: signed.deployment.worldId,
      worldEpoch: signed.deployment.worldDefinition.epoch,
      repeatEveryS: signed.deployment.repeatEveryS,
    });
    if (trainMapProjector !== undefined && signed.deployment.worldId === trainMapProjector.worldId) {
      assertTrainMapProjectionBinding(
        trainMapProjector,
        await livemapReadModel!.getConfig(signed.deployment.worldId),
        signed.deploymentHash,
      );
    }
  },
  async registerStartedWorld(started) {
    deploymentRuntime.register(started.signed, started.epoch);
    signedDeployments.set(started.signed.deployment.worldId, started.signed);
    if (odooProjectionClient !== undefined) {
      await enqueueStartedWorldCapabilities(db, {
        worldId: started.signed.deployment.worldId,
        deploymentHash: started.signed.deploymentHash,
        occurredAt: started.occurredAt,
        capabilities: [
          MANUAL_DISRUPTION_ADMIN_CAPABILITY,
          WORLD_ACCESS_REVOKE_CAPABILITY,
          ABUSE_SANCTION_ACTIVATE_CAPABILITY,
          WORLD_CLOSE_CAPABILITY,
          infraReleaseAdoptionRuntimeCapability,
        ],
      });
    }
  },
});

const metricsApp = Fastify({ logger: false });
// Der signierte Deploymentwert ist unveraenderlich; 250-ms-Zyklen sollen
// den Deutschland-Fahrplan nicht wiederholt scannen und sortieren.
const dailyRestrictionSources = new WeakMap<object, import("./daily-restriction-catalog.js").DailyRestrictionWorldSource>();
const dailyRestrictionCatalog = new DailyRestrictionCommandCatalog({
  base: deploymentRuntime,
  loadPolicies: createDailyRestrictionPolicyLoader(db),
  generate(input) {
    if (operationalSimulationRuntime.dailyRestrictions === undefined) {
      throw new Error("Die native Operational-Runtime besitzt keinen La-Generatorvertrag.");
    }
    return operationalSimulationRuntime.dailyRestrictions(input);
  },
});
const disruptionPolicyAdminHandler = createDisruptionPolicyAdminHandler({
  db,
  validatePolicy: (worldId, policy) => dailyRestrictionCatalog.validatePolicy(worldId, policy),
});
const manualDisruptionCatalog = new ManualDisruptionCommandCatalog({
  db,
  base: dailyRestrictionCatalog,
  runtime: operationalSimulationRuntime,
  regions: () => {
    const ready = new Map(regionalSimulation.readyRegions().map((region) => [`${region.worldId}\u0000${region.regionId}`, region.nowMs]));
    return deploymentRuntime.realtimeRegions().map((region) => ({ ...region, nowMs: ready.get(`${region.worldId}\u0000${region.regionId}`) ?? 0 }));
  },
});
const manualDisruptionAdminHandler = createManualDisruptionAdminHandler({
  schedule: (input) => manualDisruptionCatalog.schedule(input),
});
const demandDeploymentPath = optionalEnv("ZUGFOLGE_DEMAND_DEPLOYMENT_PATH");
const demandConfiguration = demandDeploymentPath === undefined ? undefined : await loadDemandDeployment(
  demandDeploymentPath, requireEnv("ZUGFOLGE_DEMAND_DEPLOYMENT_SHA256"), worldScope.worldId,
);
const demandInfrastructure = demandConfiguration === undefined ? undefined : planningInfrastructureReleases.get(
  worldScope.worldId, demandConfiguration.deployment.infrastructureReleaseId,
);
if (demandConfiguration !== undefined && demandInfrastructure === undefined) throw new Error("Nachfrage benötigt die exakt freigegebene Planungsinfrastruktur.");
const demandRuntime = demandConfiguration === undefined ? undefined : loadDemandRuntime();
const demand = demandConfiguration === undefined ? undefined : new DemandService({
  db, runtime: demandRuntime!, deployment: demandConfiguration.deployment, deploymentHash: demandConfiguration.hash,
  readModel: livemapReadModel, livemap, infrastructure: demandInfrastructure === undefined ? [] : [demandInfrastructure],
  operationalRegions: () => deploymentRuntime.realtimeRegions().filter((region) => region.worldId === worldScope.worldId),
});
const spfv = demand === undefined ? undefined : new SpfvService({
  db, fleetRuntime: operatingRuntime,
  infrastructureReleaseForWorld: (worldId) => demandInfrastructure?.worldId === worldId ? demandInfrastructure : undefined,
  async timeForWorld(worldId) {
    const epoch = worldEpochs.get(worldId);
    if (epoch === undefined) throw new Error("Fahrplanwelt besitzt keine Weltepoche.");
    return Math.max(0, Math.trunc((Date.now() - epoch.getTime()) / 1000));
  },
  estimate: (input, tx) => demand.estimateSpfv(input, tx),
});
const interiorDeploymentPath = optionalEnv("ZUGFOLGE_CONDUCTOR_INTERIOR_DEPLOYMENT_PATH");
const interiorDeploymentHash = optionalEnv("ZUGFOLGE_CONDUCTOR_INTERIOR_DEPLOYMENT_SHA256");
const interiorTrustedKeysPath = optionalEnv("ZUGFOLGE_CONDUCTOR_ART_TRUSTED_KEYS_PATH");
const interiorConfigured = [interiorDeploymentPath, interiorDeploymentHash, interiorTrustedKeysPath].some((value) => value !== undefined);
if (interiorConfigured && [interiorDeploymentPath, interiorDeploymentHash, interiorTrustedKeysPath].some((value) => value === undefined))
  throw new Error("Innenraumdeployment benötigt gemeinsam Pfad, SHA-256-Pin und unabhängigen öffentlichen Schlüsselring.");
const interiorRuntime = !interiorConfigured ? undefined : loadConductorInteriorRuntime();
const interiorDeployment = !interiorConfigured ? undefined : await loadConductorInteriorDeployment({
  path: interiorDeploymentPath!, expectedSha256: interiorDeploymentHash!, trustedKeysPath: interiorTrustedKeysPath!, worldId: worldScope.worldId });
const conductorInterior = interiorDeployment === undefined ? undefined : new ConductorInteriorService({
  db, fleetRuntime: operatingRuntime, interiorRuntime: interiorRuntime!, deployment: interiorDeployment,
  committedTimeForWorld: (worldId) => committedInteriorTime(worldId, deploymentRuntime.realtimeRegions(), regionalSimulation.readyRegions()),
});
const conductorConfigurationKeys = ["ZUGFOLGE_CONDUCTOR_SESSION_DEPLOYMENT_PATH", "ZUGFOLGE_CONDUCTOR_SESSION_DEPLOYMENT_SHA256",
  "ZUGFOLGE_CONDUCTOR_DIALOGUE_TRUSTED_KEYS_PATH", "ZUGFOLGE_CONDUCTOR_SCENE_DEPLOYMENT_PATH", "ZUGFOLGE_CONDUCTOR_SCENE_DEPLOYMENT_SHA256",
  "ZUGFOLGE_CONDUCTOR_CONTROL_DEPLOYMENT_PATH", "ZUGFOLGE_CONDUCTOR_CONTROL_DEPLOYMENT_SHA256"] as const;
const conductorConfigured = conductorConfigurationKeys.some((key) => optionalEnv(key) !== undefined);
if (conductorConfigured && (conductorConfigurationKeys.some((key) => optionalEnv(key) === undefined)
  || interiorDeployment === undefined || demandRuntime === undefined))
  throw new Error("Schaffnersitzungen benötigen gemeinsam M10, freigegebenen Innenraum, Sitzungs-, Szenen- und Kontrollpins sowie den unabhängigen Dialogschlüsselring.");
const conductorRegionBindings = (worldId: string) => deploymentRuntime.realtimeRegions().filter((row) => row.worldId === worldId);
const conductorRuntime = !conductorConfigured ? undefined : loadConductorSessionRuntime();
const conductorControlRuntime = !conductorConfigured ? undefined : loadFareControlRuntime();
const conductorControl = conductorControlRuntime === undefined ? undefined : createConductorControlIntegration({
  runtime: conductorControlRuntime,
  releases: await loadConductorControlDeployment({ path: requireEnv("ZUGFOLGE_CONDUCTOR_CONTROL_DEPLOYMENT_PATH"),
    expectedSha256: requireEnv("ZUGFOLGE_CONDUCTOR_CONTROL_DEPLOYMENT_SHA256"), worldId: worldScope.worldId, runtime: conductorControlRuntime }),
  police: createConductorPoliceAdapter({ runtime: operationalSimulationRuntime, regionBindings: conductorRegionBindings, controlRuntime: conductorControlRuntime }),
});
const conductorSceneRuntime = !conductorConfigured ? undefined : loadConductorSceneRuntime();
const conductorSessions = conductorRuntime === undefined ? undefined : new ConductorSessionService({
  db, fleetRuntime: operatingRuntime, demandRuntime: demandRuntime!, operationalRuntime: operationalSimulationRuntime,
  interiorRuntime: interiorRuntime!, interiorDeployment: interiorDeployment!, regionBindings: conductorRegionBindings,
  sessionRuntime: conductorRuntime, control: conductorControl!,
  sessionReleases: await loadConductorSessionDeployment({ path: requireEnv("ZUGFOLGE_CONDUCTOR_SESSION_DEPLOYMENT_PATH"),
    expectedSha256: requireEnv("ZUGFOLGE_CONDUCTOR_SESSION_DEPLOYMENT_SHA256"), trustedKeysPath: requireEnv("ZUGFOLGE_CONDUCTOR_DIALOGUE_TRUSTED_KEYS_PATH"),
    worldId: worldScope.worldId, runtime: conductorRuntime, validator: loadConductorDialogueValidator() }),
  scenes: { runtime: conductorSceneRuntime!, deployment: await loadConductorSceneDeployment({
    path: requireEnv("ZUGFOLGE_CONDUCTOR_SCENE_DEPLOYMENT_PATH"), expectedSha256: requireEnv("ZUGFOLGE_CONDUCTOR_SCENE_DEPLOYMENT_SHA256"),
    worldId: worldScope.worldId, runtime: conductorSceneRuntime! }) },
});
const app = buildApp({
  worldScope,
  metricsApp,
  db,
  verifyToken,
  livemap,
  livemapReadModel,
  demand,
  conductorInterior,
  conductorSessions,
  spfv,
  operations,
  simulationIngestToken: requireEnv("SIMULATION_INGEST_TOKEN"),
  regionalSimulation,
  dailyRestrictionDiagnostics: (worldId) => dailyRestrictionCatalog.diagnostics(worldId),
  validateDailyRestrictionPolicy: (worldId, policy) => dailyRestrictionCatalog.validatePolicy(worldId, policy),
  planningAuthorityAccountIds,
  fleetIngestToken: requireEnv("FLEET_INGEST_TOKEN"),
  fleetRuntime: operatingRuntime,
  fleetAuthorityReleases,
  fleetAuthorityConfigurations,
  adminControl: "odoo",
  alpha: {
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
    createRegionalSimulationSchedulerHealthCheck(
      regionalSimulationMonitor,
      REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS,
      Date.now,
      () => deploymentRuntime.realtimeRegions(),
      () => regionalSimulation.readyRegions(),
    ),
    createInfraReleaseRuntimeConsistencyHealthCheck(
      db,
      deploymentRuntime,
      activeWorldInfrastructureBaselines,
    ),
    createDisruptionProviderHealthCheck(disruptionProviderMonitor),
    createLivemapHealthCheck(
      livemap,
      LIVEMAP_FRESHNESS_MAXIMUM_AGE_MS,
      Date.now,
      (worldId, nowMs) => deploymentRuntime.expectsLivemapFreshness(worldId, nowMs),
      (nowMs) => deploymentRuntime.realtimeWorldIds().filter(
        (worldId) => deploymentRuntime.expectsLivemapFreshness(worldId, nowMs),
      ),
    ),
    createOdooBridgeHealthCheck(db),
  ],
  extraMetricSources: [alphaOperationsMetrics, regionalSimulationMonitor],
  odooWebhookStore,
  odooWebhookOptions,
  infraPackageStaging: infraPackageUpload.staging,
  infraUploadKeys: infraPackageUpload.keys,
});
let regionalSimulationStartupReady = false;
app.addHook("onRequest", async (request, reply) => {
  if (
    regionalSimulationStartupReady
    || regionalSimulationStartupRouteAllowed(request.url)
  ) return;
  return reply.code(503).send({
    status: "down",
    code: "regional_simulation_catching_up",
  });
});
app.addHook("onClose", async () => {
  trainMapProjector?.close();
  livemapReadModel?.close();
});

if (odooProjectionClient !== undefined) {
  await enqueueGameAdminCapabilityProjection(db, {
    worldId: WORLD_DEPLOY_CAPABILITY_SCOPE_ID,
    correlationId: `startup:${worldScope.worldId}:${WORLD_DEPLOY_CAPABILITY.actionType}`,
    capability: { ...WORLD_DEPLOY_CAPABILITY, targetWorldId: worldScope.worldId },
  });
  for (const world of activeWorldRows) {
    if (world.worldId !== worldScope.worldId) continue;
    for (const capability of [
      MANUAL_DISRUPTION_ADMIN_CAPABILITY,
      { ...DISRUPTION_POLICY_ADMIN_CAPABILITY, availability: operationalSimulationRuntime.dailyRestrictions === undefined ? "unavailable" as const : "available" as const },
      WORLD_ACCESS_REVOKE_CAPABILITY,
      ABUSE_SANCTION_ACTIVATE_CAPABILITY,
      WORLD_CLOSE_CAPABILITY,
      infraReleaseAdoptionRuntimeCapability,
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
  if (alphaProjectionCycle !== undefined) return;
  const observedAt = new Date();
  alphaProjectionCycle = (async () => {
    // guards:allow world-id — Der Betriebszyklus enumeriert Welt-IDs; jede Folgeverarbeitung ist wieder weltgebunden.
    const profiles = (await loadActiveAlphaWorldProjectionProfiles(db))
      .filter((profile) => profile.worldId === worldScope.worldId);
    for (const profile of profiles) {
      const snapshot = await alphaMonitoring.snapshot(profile.worldId, observedAt);
      alphaOperationsMetrics.observe(snapshot);
      if (odooProjectionClient === undefined) continue;
      const epoch = worldEpochs.get(profile.worldId);
      if (epoch === undefined) throw new Error(`Weltepoche fuer Alpha-Projektion '${profile.worldId}' fehlt.`);
      const regionAge = snapshot.freshness.regionAgeSeconds;
      const runtimeStatus = !snapshot.world.authoritativeTimeAvailable || regionAge === null
        ? "down: kein lesbarer autoritativer Regionsstand"
        : regionAge * 1_000 > LIVEMAP_FRESHNESS_MAXIMUM_AGE_MS
          ? `down: Regionscommit ${regionAge}s alt`
          : "healthy: autoritativer Regionscommit aktuell";
      const failedProjections = snapshot.bridges.odooProjection.failed;
      const workerStatus = failedProjections > 0 ? `degraded: ${failedProjections} fehlgeschlagene Odoo-Projektionen`
        : "healthy: keine fehlgeschlagene Odoo-Projektion";
      const projectionRevision = alphaHash("zugfolge-odoo-world-projection/v1", snapshot);
      const blueprint = decodeEconomyValue(profile.blueprint) as AlphaWorldBlueprint;
      const startingCapitalPolicy = serializeStartingCapitalPolicy(effectiveStartingCapitalPolicy(blueprint));
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
          authoritativeEventUrl: alphaMonitoringApiUrl(worldScope.publicOrigin, profile.worldId),
        },
      });
      try {
        if (!snapshot.world.authoritativeTimeAvailable) continue;
        const publicSnapshot = await buildPublicWorldSnapshot(db, {
          worldId: profile.worldId,
          authoritativeNowS: snapshot.world.simulationTimeS,
          generatedAt: observedAt,
        });
        await enqueuePublicWorldSnapshot(db, {
          snapshot: publicSnapshot,
          correlationId: `public-world:${profile.worldId}:${publicSnapshot.authoritativeAsOf}`,
          occurredAt: observedAt,
        });
      } catch (error) {
        if (!(error instanceof PublicWorldSnapshotUnavailableError
          && (error.code === "legacy_blueprint" || error.code === "not_public"))) throw error;
      }
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

// Der Listener wird vor dem ersten potenziell langen Cold-Catch-up geoeffnet,
// damit /health, /health/ready und /metrics den Prozess sowie echten Fortschritt
// sichtbar halten. Die Startup-Fence oben sperrt alle Fachrouten, bis der
// erste exakte v2-Millisekundentakt vollstaendig abgeschlossen ist.
const regionalAdvanceCoordinator = new RegionalSimulationCycleCoordinator({
  monitor: regionalSimulationMonitor,
  logger: app.log,
  run: async ({ at, reportProgress }) => manualDisruptionCatalog.exclusive(async () => {
    const regions = deploymentRuntime.realtimeRegions();
    await dailyRestrictionCatalog.refresh(regions.map((region) => {
      const signed = signedDeployments.get(region.worldId);
      if (signed === undefined || signed.deployment.regionalSimulation.regionId !== region.regionId) {
        throw new Error("La-Katalog besitzt keine eindeutige signierte Welt-/Regionsbindung.");
      }
      let source = dailyRestrictionSources.get(signed);
      if (source !== undefined) return source;
      source = {
        worldId: region.worldId,
        regionId: region.regionId,
        seed: signed.deployment.blueprint.seed.toString(),
        infraRelease: signed.deployment.regionalSimulation.infraRelease,
        routeVersionIds: [...new Set(signed.deployment.regionalSimulation.trains.map((train) => train.routeVersionId))].sort(compareUtf8),
      };
      dailyRestrictionSources.set(signed, source);
      return source;
    }));
    await manualDisruptionCatalog.refresh();
    await demand?.prepareOperationalCycle(at);
    const advanced = await advanceRegionalSimulations(regionalSimulation, regions, worldEpochs, at, manualDisruptionCatalog, reportProgress);
    await demand?.prepareOperationalCycle(at);
    if (conductorControl !== undefined) {
      await advanceConductorControlWorld({ db, worldId: worldScope.worldId, regions: conductorRegionBindings(worldScope.worldId),
        runtime: operationalSimulationRuntime, control: conductorControl });
      await demand?.prepareOperationalCycle(at);
      await conductorSessions!.sweepWorld(worldScope.worldId);
    }
    return advanced;
  }),
});
const runRegionalAdvance = () => {
  void regionalAdvanceCoordinator.run(new Date()).then((result) => {
    if (result.status === "completed") {
      regionalSimulationStartupReady = true;
    }
  }).catch(() => undefined);
};
// Der Plattformtakt uebergibt die exakte Weltzeit in Millisekunden. Der
// Rust-v2-Kern verarbeitet betriebliche Ereignisgrenzen und publiziert einen
// autorisierten analytischen Bewegungsabschnitt; der Client wertet ihn nur bis
// validUntilMs aus. Fachkommandos tragen ebenfalls ihre explizite Weltzeit.
let regionalAdvanceInterval: ReturnType<typeof setInterval> | undefined;
app.addHook("onClose", async () => {
  if (regionalAdvanceInterval !== undefined) clearInterval(regionalAdvanceInterval);
  await regionalAdvanceCoordinator.close();
});

// Commerce laeuft ausserhalb jedes Simulations-, Planner- und Loginpfads.
// Auch ein langer Odoo-Ausfall laesst nur die Outbox wachsen; der Prozess
// bleibt erreichbar und bestehende Entitlements bleiben lokal gueltig.
let commerceCycle: Promise<void> | undefined;
const runCommerce = () => {
  if (commerceCycle !== undefined) return;
  commerceCycle = (async () => {
    while (await processNextOdooCommand(db, new Date(), {
      assertWorldScope: assertCommerceWorldScope,
      ...(demand === undefined ? {} : { demandDataHandler: (context: import("@zugfolge/commerce").DemandDataCommandContext) =>
        demand.updateData(context.payload, context.db, context.now) }),
      participationHandler: worldParticipationHandler,
      adminHandlers: {
        manual_disruption_create: manualDisruptionAdminHandler,
        disruption_policy_schedule: disruptionPolicyAdminHandler,
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
    if (odooProjectionClient !== undefined) {
      const pendingOutboxWorldIds = await listPendingOdooProjectionWorldIds(db);
      for (const worldId of worldIdsForOdooProjectionDispatch(
        deploymentRuntime.worldIds(),
        pendingOutboxWorldIds,
      ).filter((id) => id === worldScope.worldId || id === WORLD_DEPLOY_CAPABILITY_SCOPE_ID)) {
        await dispatchOdooProjectionOutbox(db, worldId, odooProjectionClient, new Date());
      }
    }
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
  const snapshotStartedAt = new Date();
  reconciliationCycle = odooReconciliationClient.snapshot(worldScope.worldId)
    .then((snapshot) => reconcileOdooProjectionSnapshot(db, snapshot, snapshotStartedAt, worldScope.worldId))
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

let purgeCycle: Promise<void> | undefined;
const purge = () => {
  if (purgeCycle !== undefined) return;
  purgeCycle = (async () => {
    const asOf = new Date();
    const accountsResult = await purgeExpiredAccountData(db, asOf);
    for (const failure of accountsResult.failures ?? []) app.log.error({ err: failure.error, worldId: failure.worldId, accountId: failure.accountId }, "Konto-Raeumlauf fehlgeschlagen");
    // guards:allow world-id — Der taegliche Sweeper enumeriert Welten und raeumt je Welt in begrenzten Batches.
    const retainedWorlds = await db.select({ id: worlds.id }).from(worlds);
    let purgedMessages = 0;
    let backlogWorlds = 0;
    for (const world of retainedWorlds) {
      try {
      const result = await purgeExpiredMailboxMessages(db, { worldId: world.id, asOf });
      purgedMessages += result.purgedMessageIds.length;
      if (result.hasMore) backlogWorlds += 1;
      } catch (error) {
        backlogWorlds += 1;
        app.log.error({ err: error, worldId: world.id }, "Postfach-Raeumlauf der Welt fehlgeschlagen");
      }
    }
    app.log.info({ purgedAccounts: accountsResult.purgedAccountIds.length, purgedMessages, backlogWorlds }, "Datenschutz-Raeumlauf abgeschlossen");
    if (backlogWorlds > 0) app.log.warn({ backlogWorlds }, "Postfach-Raeumlauf hat Rueckstand");
  })().catch((error: unknown) => {
    app.log.error({ err: error }, "Datenschutz-Räumlauf fehlgeschlagen");
  }).finally(() => { purgeCycle = undefined; });
};
purge();
const purgeInterval = setInterval(purge, 24 * 60 * 60 * 1_000);
purgeInterval.unref();
app.addHook("onClose", async () => { clearInterval(purgeInterval); await purgeCycle; await metricsApp.close(); });

const port = Number(process.env["PORT"] ?? "3000");
await app.listen({ host: "0.0.0.0", port });
await metricsApp.listen({ host: "0.0.0.0", port: 9464 });
runRegionalAdvance();
regionalAdvanceInterval = setInterval(
  runRegionalAdvance,
  REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS,
);
regionalAdvanceInterval.unref();
