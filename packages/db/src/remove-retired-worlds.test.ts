import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./migrations.js";

const regular = "11111111-1111-4111-8111-111111111111";
const retired = "22222222-2222-4222-8222-222222222222";
const cleanup = readFileSync(join(MIGRATIONS_FOLDER, "0035_remove_tutorial_worlds.sql"), "utf8");

async function previousDatabase(): Promise<PGlite> {
  const client = new PGlite();
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    if (tag === "0035_remove_tutorial_worlds") break;
    await client.exec(readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8"));
  }
  return client;
}

describe("Bereinigung aufgegebener Spielwelten", () => {
  it("entfernt alte Welten samt geschützter Belege und erhält öffentliche Daten und deren Schutz", async () => {
    const client = await previousDatabase();
    try {
      await client.query(`INSERT INTO worlds(id,name,schedule_period_weeks,epoch,world_kind,ranking_status)
        VALUES ($1,'Regulär',4,'2026-01-01','public','ranked'), ($2,'Aufgegeben',4,'2026-01-01','private','unranked')`, [regular, retired]);
      await client.query(`INSERT INTO alpha_world_profiles(world_id,profile_kind,region_id,region_variant,world_seed,
        infra_release_hash,timetable_release_hash,fleet_release_hash,economy_release_hash,blueprint,blueprint_hash)
        VALUES ($1,'tutorial','retired','retired',1,repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),'{}',repeat('e',64))`, [retired]);
      for (const id of [regular, retired]) {
        await client.query(`INSERT INTO accounts(world_id,keycloak_subject,display_name) VALUES ($1::uuid,($1::uuid)::text,'Spieler')`, [id]);
        await client.query(`INSERT INTO domain_events(world_id,sequence,event_type,payload,occurred_at)
          VALUES ($1,1,'test.evidence','{}','2026-01-01')`, [id]);
      }
      await client.query("UPDATE worlds SET lifecycle_status = 'archived' WHERE id = $1", [retired]);
      const original = await client.query("SELECT * FROM domain_events WHERE world_id = $1", [regular]);
      await client.exec(`BEGIN; ${cleanup} COMMIT;`);
      expect((await client.query("SELECT id FROM worlds ORDER BY id")).rows).toEqual([{ id: regular }]);
      expect((await client.query("SELECT * FROM domain_events WHERE world_id = $1", [regular])).rows).toEqual(original.rows);
      expect((await client.query("SELECT world_id FROM accounts")).rows).toEqual([{ world_id: regular }]);
      expect((await client.query("SELECT to_regclass('tutorial_sessions') AS sessions, to_regclass('tutorial_progress') AS progress, to_regclass('tutorial_telemetry_events') AS telemetry")).rows).toEqual([{ sessions: null, progress: null, telemetry: null }]);
      await expect(client.query("DELETE FROM domain_events WHERE world_id = $1", [regular])).rejects.toThrow();
      await expect(client.query("INSERT INTO accounts(world_id,keycloak_subject,display_name) VALUES ($1,'orphan','Orphan')", [retired])).rejects.toThrow();
    } finally { await client.close(); }
  }, 30_000);

  it("bereinigt auch eine Neuinstallation ohne alte Welten", async () => {
    const client = await previousDatabase();
    try {
      await client.exec(`BEGIN; ${cleanup} COMMIT;`);
      expect((await client.query("SELECT count(*)::int AS count FROM worlds")).rows).toEqual([{ count: 0 }]);
    } finally { await client.close(); }
  }, 30_000);

  it("bricht bei einer widersprüchlich markierten regulären Welt ohne Datenverlust ab", async () => {
    const client = await previousDatabase();
    try {
      await client.query("INSERT INTO worlds(id,name,schedule_period_weeks,epoch) VALUES ($1,'Regulär',4,'2026-01-01')", [regular]);
      await client.query(`INSERT INTO alpha_world_profiles(world_id,profile_kind,region_id,region_variant,world_seed,
        infra_release_hash,timetable_release_hash,fleet_release_hash,economy_release_hash,blueprint,blueprint_hash)
        VALUES ($1,'tutorial','invalid','invalid',1,repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),'{}',repeat('e',64))`, [regular]);
      await expect(client.exec(`BEGIN; ${cleanup} COMMIT;`)).rejects.toThrow("regular world");
      await client.exec("ROLLBACK");
      expect((await client.query("SELECT id FROM worlds")).rows).toEqual([{ id: regular }]);
      expect((await client.query("SELECT to_regclass('tutorial_sessions')::text AS table_name")).rows).toEqual([{ table_name: "tutorial_sessions" }]);
    } finally { await client.close(); }
  }, 30_000);
});
