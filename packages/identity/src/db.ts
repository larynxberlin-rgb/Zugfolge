/** Verbindungsaufbau für den Betrieb — node-postgres gegen echtes PostgreSQL. */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { schema } from "./schema.js";
import type { IdentityDatabase } from "./accounts.js";

export function createIdentityDatabase(connectionString: string): IdentityDatabase {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}
