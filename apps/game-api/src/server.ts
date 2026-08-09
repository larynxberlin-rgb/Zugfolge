/** Produktionseinstieg: echte Postgres-Verbindung, echter Keycloak-Realm. */

import { createDatabase, createEconomyOutboxHealthCheck, createEventLogHealthCheck } from "@zugfolge/db";
import {
  createEconomyPlatformAdapters,
  createEconomySchedulerHealthCheck,
  EconomySchedulerMonitor,
  runEconomySchedulerCycle,
  type JournalAccounts,
} from "@zugfolge/economy";
import {
  createKeycloakHealthCheck,
  createKeycloakVerifier,
  loadKeycloakConfigFromEnv,
} from "@zugfolge/identity";
import { createLivemapHealthCheck, LivemapRegistry } from "@zugfolge/livemap-stream";
import { purgeExpiredAccountData } from "@zugfolge/privacy";

import { buildApp } from "./app.js";

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
const economyMonitor = new EconomySchedulerMonitor(Date.now());
const economyAdapters = createEconomyPlatformAdapters({
  db,
  accountsByOperator: JSON.parse(requireEnv("ECONOMY_LEDGER_ACCOUNTS_JSON")) as Readonly<Record<string, JournalAccounts>>,
});
const app = buildApp({
  db,
  verifyToken,
  livemap,
  livemapIngestToken: requireEnv("LIVEMAP_INGEST_TOKEN"),
  simulationIngestToken: requireEnv("SIMULATION_INGEST_TOKEN"),
  fleetIngestToken: requireEnv("FLEET_INGEST_TOKEN"),
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
