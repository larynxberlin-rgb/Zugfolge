/** Produktionseinstieg: echte Postgres-Verbindung, echter Keycloak-Realm. */

import {
  createDatabase,
  createEconomyOutboxHealthCheck,
  createEventLogHealthCheck,
  regionalSimulationStates,
  worldEventLog,
  worlds,
} from "@zugfolge/db";
import {
  createHttpOdooProjectionClient,
  createHttpOdooReconciliationClient,
  createOdooBridgeHealthCheck,
  createOdooWebhookReceiptStore,
  dispatchOdooProjectionOutbox,
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
  EconomySchedulerMonitor,
  listEconomyWorldIds,
  runEconomySchedulerCycle,
  type JournalAccounts,
} from "@zugfolge/economy";
import {
  createKeycloakHealthCheck,
  createKeycloakVerifier,
  loadKeycloakConfigFromEnv,
} from "@zugfolge/identity";
import {
  createLivemapHealthCheck,
  LivemapRegistry,
} from "@zugfolge/livemap-stream";
import { loadPlanningRuntime } from "@zugfolge/planning-runtime-native";
import { planningInfrastructureReleaseCatalog } from "@zugfolge/planning-worker";
import { purgeExpiredAccountData } from "@zugfolge/privacy";
import {
  FLEET_INITIALIZE_SCHEMA,
  loadOperatingRuntime,
  loadRegionalSimulationRuntime,
  type OperatingRuntimeEvent,
} from "@zugfolge/runtime-native";
import { asc, eq } from "drizzle-orm";

import { buildApp } from "./app.js";
import {
  createDisruptionProviderHealthCheck,
  createDisruptionProviderStore,
  DisruptionProviderMonitor,
  runDisruptionProviderCycle,
} from "./disruption-provider-scheduler.js";
import { loadFleetAuthorityReleaseCatalog } from "./fleet-configuration.js";
import { projectLivemapOperationEvent } from "./livemap-operation-projection.js";
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
const livemap = new LivemapRegistry();
const operations = new OperationsRegistry();
const economyMonitor = new EconomySchedulerMonitor(Date.now());
const disruptionProviderMonitor = new DisruptionProviderMonitor(Date.now());
const disruptionProviderClient = new PublicInfrastructureRestrictionsClient();
const disruptionProviderStore = createDisruptionProviderStore(db);
const operatingRuntime = loadOperatingRuntime();
const fleetAuthorityReleases = await loadFleetAuthorityReleaseCatalog(
  requireEnv("ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH"),
);
const regionalSimulationRuntime = loadRegionalSimulationRuntime();
const planningRuntime = loadPlanningRuntime();
const planningInfrastructureReleases = planningInfrastructureReleaseCatalog(
  parsePlanningInfrastructureReleasesJson(
    requireEnv("PLANNING_INFRASTRUCTURE_RELEASES_JSON"),
  ),
);
const planningAuthorityAccountIds = parsePlanningAuthorityAccountIdsJson(
  requireEnv("PLANNING_AUTHORITY_ACCOUNT_IDS_JSON"),
);
const regionalSimulation = new RegionalSimulationWorker(
  db,
  regionalSimulationRuntime,
  livemap,
  operations,
);
const consumeProviderSnapshot = createProviderDisruptionConsumer(db, regionalSimulation);
const worldRows = await db
  .select({ worldId: worlds.id, epoch: worlds.epoch })
  .from(worlds)
  .orderBy(asc(worlds.id));
const worldEpochs = new Map(
  worldRows.map((world) => [world.worldId, world.epoch] as const),
);
const configuredWorldIds = new Set(worldRows.map((world) => world.worldId));
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
  worldRows.map((world) => world.worldId),
  planningAuthorityAccountIds,
);

const economyAdapters = {
  ...createEconomyPlatformAdapters({
    db,
    accountsByOperator: JSON.parse(requireEnv("ECONOMY_LEDGER_ACCOUNTS_JSON")) as Readonly<Record<string, JournalAccounts>>,
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
for (const world of worldRows) {
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

const app = buildApp({
  db,
  verifyToken,
  livemap,
  operations,
  simulationIngestToken: requireEnv("SIMULATION_INGEST_TOKEN"),
  regionalSimulation,
  planningAuthorityAccountIds,
  fleetIngestToken: requireEnv("FLEET_INGEST_TOKEN"),
  fleetRuntime: operatingRuntime,
  fleetAuthorityReleases,
  extraHealthChecks: [
    createKeycloakHealthCheck(keycloak),
    createEventLogHealthCheck(db),
    createEconomyOutboxHealthCheck(db),
    createEconomySchedulerHealthCheck(economyMonitor),
    createDisruptionProviderHealthCheck(disruptionProviderMonitor),
    createLivemapHealthCheck(livemap),
    createOdooBridgeHealthCheck(db),
  ],
  odooWebhookStore,
  odooWebhookOptions,
});

// Erster expliziter 1:1-Takt noch vor dem Listener: Ein restaurierter Zustand
// wird nicht fuer einen kurzen Zeitraum mit alter Weltzeit ausgeliefert.
await advanceRegionalSimulations(regionalSimulation, worldEpochs, new Date());
let regionalAdvanceCycle: Promise<void> | undefined;
const runRegionalAdvance = () => {
  if (regionalAdvanceCycle !== undefined) return;
  regionalAdvanceCycle = advanceRegionalSimulations(
    regionalSimulation,
    worldEpochs,
    new Date(),
  )
    .then(() => undefined)
    .catch((error: unknown) => {
      app.log.error({ err: error }, "Regionaler 1:1-Simulationstakt fehlgeschlagen");
    })
    .finally(() => {
      regionalAdvanceCycle = undefined;
    });
};
const regionalAdvanceInterval = setInterval(runRegionalAdvance, 1_000);
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
    while (await processNextOdooCommand(db, new Date()) !== undefined) {
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
  worldRows.map((world) => world.worldId),
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
