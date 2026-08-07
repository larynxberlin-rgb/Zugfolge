import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/** Baut die Drizzle-Verbindung eines Game-Service aus einer Postgres-Verbindungszeichenfolge. */
export function createDatabase(connectionString: string): Database {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}
