import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, vehicleRegistryEntries, vehicleRegistryEvents, worldAccesses, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthenticator } from "./auth.js";
import { registerVehicleRegistryRoutes } from "./vehicle-registry-routes.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const hash = "a".repeat(64);
const client = new PGlite();
const db = drizzle(client, { schema });
const app = Fastify();
const auth = { authorization: "Bearer spectator" };
const entry = (worldId: string, vehicleId: string, retiredAtS = 9000) => ({
  worldId, vehicleId, authorityReleaseId: "fleet-v1", classDesignation: "442",
  ownerOperatorId: "public", holderOperatorId: "public", introducedAtS: 0, retiredAtS,
  dataAtS: 100, fleetRevision: 3, sourceStateHash: hash,
  facts: { source: { id: vehicleId, buildYear: 2020 }, holding: { ownerOperatorId: "public", holderOperatorId: "public" }, bindings: {} },
  factsHash: hash, historyHash: hash,
});

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values([WORLD, OTHER].map((id) => ({ id, name: id, schedulePeriodWeeks: 4, epoch: new Date("2026-01-01T00:00:00Z") })));
  // Bewusst kein Konto und kein Unternehmen: Alle aktiven Weltteilnehmer können lesen.
  await db.insert(worldAccesses).values([
    { worldId: WORLD, keycloakSubject: "spectator" },
    { worldId: WORLD, keycloakSubject: "revoked", status: "revoked" },
  ]);
  await db.insert(vehicleRegistryEntries).values([entry(WORLD, "asset-a", 50), entry(WORLD, "asset-b"), entry(WORLD, "asset%"), entry(OTHER, "foreign-only")]);
  for (const revision of [1, 2, 3]) await db.insert(vehicleRegistryEvents).values({
    worldId: WORLD, vehicleId: "asset-a", fleetRevision: revision, atS: revision * 10,
    eventType: revision === 1 ? "registered" : "condition-updated", priorHistoryHash: revision === 1 ? null : hash,
    resultingHistoryHash: hash, sourceStateHash: hash, details: { ownerOperatorId: revision === 1 ? "previous-owner" : "public" },
  });
  registerVehicleRegistryRoutes(app, { db, authenticate: createAuthenticator(async (token) => ({ keycloakSubject: token })) });
}, 30_000);
afterAll(async () => { await app.close(); await client.close(); });

describe("Öffentliches weltgebundenes Fahrzeugregister", () => {
  it("zeigt ein ausgemustertes öffentliches Fahrzeug ohne Konto, EVU oder Angebot", async () => {
    const response = await app.inject({ url: `/worlds/${WORLD}/vehicle-register/asset-a`, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ schemaVersion: "zugfolge-vehicle-register/v1", vehicleId: "asset-a", ownerOperatorId: "public", retiredAtS: 50 });
    expect(JSON.stringify(response.json())).not.toMatch(/keycloak|foundingAccount|spectator/);
  });

  it("verweigert fremde Welt, entzogenen Zugang und nicht authentifizierten Zugriff", async () => {
    expect((await app.inject({ url: `/worlds/${OTHER}/vehicle-register`, headers: auth })).statusCode).toBe(403);
    expect((await app.inject({ url: `/worlds/${WORLD}/vehicle-register`, headers: { authorization: "Bearer revoked" } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/worlds/${WORLD}/vehicle-register` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/worlds/${WORLD}/vehicle-register/foreign-only`, headers: auth })).statusCode).toBe(404);
  });

  it("durchblättert Bestand ohne Duplikate und behandelt Such-Metazeichen als Text", async () => {
    const first = (await app.inject({ url: `/worlds/${WORLD}/vehicle-register?limit=2`, headers: auth })).json();
    const second = (await app.inject({ url: `/worlds/${WORLD}/vehicle-register?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, headers: auth })).json();
    expect([...first.items, ...second.items].map((item: { vehicleId: string }) => item.vehicleId).sort()).toEqual(["asset%", "asset-a", "asset-b"]);
    expect(second.nextCursor).toBeNull();
    const filtered = (await app.inject({ url: `/worlds/${WORLD}/vehicle-register?query=%25`, headers: auth })).json();
    expect(filtered.items.map((item: { vehicleId: string }) => item.vehicleId)).toEqual(["asset%"]);
  });

  it("macht den gesamten unveränderten Lebenslauf chronologisch über Folgeseiten erreichbar", async () => {
    const first = (await app.inject({ url: `/worlds/${WORLD}/vehicle-register/asset-a/history?limit=2`, headers: auth })).json();
    const second = (await app.inject({ url: `/worlds/${WORLD}/vehicle-register/asset-a/history?limit=2&cursor=${first.nextCursor}`, headers: auth })).json();
    expect([...first.items, ...second.items].map((item: { fleetRevision: number }) => item.fleetRevision)).toEqual([1, 2, 3]);
    expect(first.items[0].details.ownerOperatorId).toBe("previous-owner");
    expect(second.nextCursor).toBeNull();
    expect((await app.inject({ url: `/worlds/${WORLD}/vehicle-register/missing/history`, headers: auth })).statusCode).toBe(404);
    for (const suffix of ["?limit=101", "?cursor=not-a-revision", "?cursor=2147483648"]) {
      expect((await app.inject({ url: `/worlds/${WORLD}/vehicle-register/asset-a/history${suffix}`, headers: auth })).statusCode).toBe(400);
    }
  });
});
