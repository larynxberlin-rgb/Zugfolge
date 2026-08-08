import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseHealthCheck } from "./health.js";
import * as schema from "./schema/index.js";

describe("createDatabaseHealthCheck", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;

  beforeEach(() => {
    client = new PGlite();
    db = drizzle(client, { schema });
  });

  afterEach(async () => {
    if (!client.closed) {
      await client.close();
    }
  });

  it("meldet 'ok', solange die Verbindung eine Abfrage beantwortet", async () => {
    const outcome = await createDatabaseHealthCheck(db).check();
    expect(outcome).toEqual({ status: "ok" });
  });

  it("wirft, wenn die Verbindung bereits geschlossen ist — die Registry fängt das auf", async () => {
    await client.close();
    await expect(createDatabaseHealthCheck(db).check()).rejects.toThrow();
  });
});
