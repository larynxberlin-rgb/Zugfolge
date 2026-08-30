import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { prepareSchema29LegacyRuntimeWindowWithSql } from "./schema29-runtime-window.mjs";

const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { PGlite } = await import(pathToFileURL(requireFromDb.resolve("@electric-sql/pglite")).href);

function adapter(client) {
  return {
    async unsafe(source, parameters = []) {
      return (await client.query(source, parameters)).rows;
    },
  };
}

test("prepares only the isolated schema-29 runtime copy for a real legacy V1 update", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      create schema drizzle;
      create table drizzle.__drizzle_migrations (id integer primary key);
      insert into drizzle.__drizzle_migrations select generate_series(1, 29);
      create table regional_simulation_states (
        world_id uuid not null,
        region_id text not null,
        state_schema text not null,
        initialization_hash text,
        revision bigint not null
      );
      insert into regional_simulation_states
        (world_id, region_id, state_schema, initialization_hash, revision)
      values
        ('00000000-0000-4000-8000-000000000014', 'mitteldeutschland-b', 'zugfolge-regional-simulation-state/v1', null, 67406);
      alter table regional_simulation_states
        add constraint regional_simulation_states_initialization_hash_present
        check (initialization_hash is not null) not valid;
    `);
    await assert.rejects(
      database.query("update regional_simulation_states set revision = revision + 1 where region_id = 'mitteldeutschland-b'"),
      /regional_simulation_states_initialization_hash_present/iu,
    );
    const prepared = await prepareSchema29LegacyRuntimeWindowWithSql(adapter(database));
    assert.deepEqual({
      validated: prepared.afterConstraintValidated,
      legacyRows: prepared.legacyRowCount,
      invalidRows: prepared.invalidRowCount,
      migrationCount: prepared.migrationCount,
    }, { validated: true, legacyRows: "1", invalidRows: "0", migrationCount: 29 });
    await database.query("update regional_simulation_states set revision = revision + 1 where region_id = 'mitteldeutschland-b'");
    const rows = await database.query("select revision::text as revision, initialization_hash from regional_simulation_states");
    assert.deepEqual(rows.rows, [{ initialization_hash: null, revision: "67407" }]);
  } finally {
    await database.close();
  }
});
