/** Produktionseinstieg: echte Postgres-Verbindung, echter Keycloak-Realm. */

import {
  createDatabase,
  createEconomyOutboxHealthCheck,
  createEventLogHealthCheck,
  worldEventLog,
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
import { purgeExpiredAccountData } from "@zugfolge/privacy";
import { loadOperatingRuntime, type OperatingRuntimeEvent } from "@zugfolge/runtime-native";

import { buildApp } from "./app.js";
import { projectLivemapOperationEvent } from "./livemap-operation-projection.js";
import { generateDailyOperationReports, previousBerlinServiceDay } from "./daily-reports.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Umgebungsvariable '${name}' fehlt.`);
  }
  return value;
}

const db = createDatabase(requireEnv("DATABASE_URL"));
const keycloak = loadKeycloakConfigFromEnv();
const verifyToken = createKeycloakVerifier(keycloak);
const livemap = new LivemapRegistry();
const operations = new OperationsRegistry();
const economyMonitor = new EconomySchedulerMonitor(Date.now());
const operatingRuntime = loadOperatingRuntime();

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
const app = buildApp({
  db,
  verifyToken,
  livemap,
  operations,
  livemapIngestToken: requireEnv("LIVEMAP_INGEST_TOKEN"),
  simulationIngestToken: requireEnv("SIMULATION_INGEST_TOKEN"),
  fleetIngestToken: requireEnv("FLEET_INGEST_TOKEN"),
  verifyFleetMobilizationSnapshot: operatingRuntime.verifyFleetMobilizationSnapshot,
  extraHealthChecks: [
    createKeycloakHealthCheck(keycloak),
    createEventLogHealthCheck(db),
    createEconomyOutboxHealthCheck(db),
    createEconomySchedulerHealthCheck(economyMonitor),
    createLivemapHealthCheck(livemap),
  ],
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
