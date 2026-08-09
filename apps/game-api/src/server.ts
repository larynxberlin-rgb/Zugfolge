/** Produktionseinstieg: echte Postgres-Verbindung, echter Keycloak-Realm. */

import { createDatabase, createEconomyOutboxHealthCheck, createEventLogHealthCheck } from "@zugfolge/db";
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
const app = buildApp({
  db,
  verifyToken,
  livemap,
  livemapIngestToken: requireEnv("LIVEMAP_INGEST_TOKEN"),
  simulationIngestToken: requireEnv("SIMULATION_INGEST_TOKEN"),
  extraHealthChecks: [
    createKeycloakHealthCheck(keycloak),
    createEventLogHealthCheck(db),
    createEconomyOutboxHealthCheck(db),
    createLivemapHealthCheck(livemap),
  ],
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
