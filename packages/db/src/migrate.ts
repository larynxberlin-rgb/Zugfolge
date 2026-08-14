import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { MIGRATIONS_FOLDER } from "./migrations.js";

const connectionString = process.env["DATABASE_URL"];
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("DATABASE_URL muss fuer die Game-Migration gesetzt sein.");
}

const client = postgres(connectionString, { max: 1 });
try {
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  process.stdout.write(`${JSON.stringify({ migrated: true, migrationsFolder: MIGRATIONS_FOLDER })}\n`);
} finally {
  await client.end();
}
