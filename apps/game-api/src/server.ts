/** Produktionseinstieg: echte Postgres-Verbindung, echter Keycloak-Realm. */

import { createDatabase } from "@zugfolge/db";
import { createKeycloakVerifier, loadKeycloakConfigFromEnv } from "@zugfolge/identity";

import { buildApp } from "./app.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Umgebungsvariable '${name}' fehlt.`);
  }
  return value;
}

const db = createDatabase(requireEnv("DATABASE_URL"));
const verifyToken = createKeycloakVerifier(loadKeycloakConfigFromEnv());
const app = buildApp({ db, verifyToken });

const port = Number(process.env["PORT"] ?? "3000");
await app.listen({ host: "0.0.0.0", port });
