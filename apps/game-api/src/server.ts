/** Produktionseinstieg: echte Postgres-Verbindung, echter Keycloak-Realm. */

import {
  createDatabase,
  createEconomyOutboxHealthCheck,
  createEventLogHealthCheck,
  regionalSimulationStates,
  worldEventLog,
  worlds,
} from "@zugfolge/db";
import { OperationsRegistry } from "@zugfolge/dispatch";
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
import { loadFleetAuthorityReleaseCatalog } from "./fleet-configuration.js";
import { projectLivemapOperationEvent } from "./livemap-operation-projection.js";
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
const keycloak = loadKeycloakConfigFromEnv();
const verifyToken = createKeycloakVerifier(keycloak);
const livemap = new LivemapRegistry();
const operations = new OperationsRegistry();
const economyMonitor = new EconomySchedulerMonitor(Date.now());
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
);
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
    createLivemapHealthCheck(livemap),
  ],
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
