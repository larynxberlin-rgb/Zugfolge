import { defineConfig } from "drizzle-kit";

/**
 * Erzeugt die SQL-Migrationen aus dem Drizzle-Schema (`pnpm db:generate`).
 * Läuft offline gegen die Schemadateien — keine Verbindung zu einer
 * laufenden Datenbank nötig, `dbCredentials` bleibt deshalb leer.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
});
