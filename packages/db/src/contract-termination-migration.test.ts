import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER } from "./migrations.js";

describe("0022 contract termination authority", () => {
  let client: PGlite;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`
      create table operators (
        world_id uuid not null,
        id uuid not null,
        primary key (world_id, id)
      );
      create table operator_contracts (
        id uuid primary key,
        world_id uuid not null,
        status text not null,
        terminated_at_s bigint,
        ended_at_s bigint,
        end_reason text,
        constraint operator_contracts_status_check check (
          status in ('offered', 'accepted', 'rejected', 'active', 'terminated', 'non-performance', 'completed', 'expired')
        )
      );
    `);
  });

  afterEach(async () => client.close());

  it("stuft unbelegte historische Nichterfüllung fail-closed herab und erzwingt neue Belegbindungen", async () => {
    const worldId = "11111111-1111-1111-1111-111111111111";
    const operatorId = "22222222-2222-2222-2222-222222222222";
    const legacyContractId = "33333333-3333-3333-3333-333333333333";
    await client.query("insert into operators (world_id, id) values ($1, $2)", [worldId, operatorId]);
    await client.query(
      "insert into operator_contracts (id, world_id, status, terminated_at_s, ended_at_s, end_reason) values ($1, $2, 'non-performance', 100, 100, 'Clientbehauptung')",
      [legacyContractId, worldId],
    );

    const migration = await readFile(join(MIGRATIONS_FOLDER, "0022_contract_termination_authority.sql"), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      await client.exec(statement);
    }

    const legacy = await client.query<{ status: string; end_reason: string }>(
      "select status, end_reason from operator_contracts where id = $1",
      [legacyContractId],
    );
    expect(legacy.rows[0]).toEqual({
      status: "terminated",
      end_reason: "[legacy-unverified-non-performance] Clientbehauptung",
    });
    await expect(client.query(
      "insert into operator_contracts (id, world_id, status, termination_requested_by_operator_id, termination_requested_at_s, terminated_at_s, termination_effective_at_s, ended_at_s, end_reason) values ($1, $2, 'non-performance', $3, 200, 200, 200, 200, 'ohne Beleg')",
      ["44444444-4444-4444-4444-444444444444", worldId, operatorId],
    )).rejects.toThrow();
  });
});
