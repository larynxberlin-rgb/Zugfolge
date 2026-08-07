import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, schema, verifyIdentityToken, type IdentityDatabase } from "@zugfolge/identity";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";

const ISSUER = "https://auth.zugfolge.test/realms/lhe";
const AUDIENCE = "game-api";
const WORLD_LHE = "11111111-1111-1111-1111-111111111111";
const WORLD_MIDDLE_GERMANY = "22222222-2222-2222-2222-222222222222";

let client: PGlite;
let db: IdentityDatabase;
let app: FastifyInstance;
let sign: (subject: string, displayName: string) => Promise<string>;

beforeEach(async () => {
  client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
  db = pgliteDb;

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] });
  sign = (subject, displayName) =>
    new SignJWT({ preferred_username: displayName })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

  app = buildApp({
    db,
    verifyToken: (token) => verifyIdentityToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE }),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await client.close();
});

describe("GET /health", () => {
  it("antwortet ohne Authentifizierung", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("Weltzugang und Kontoliste", () => {
  it("lehnt eine Anfrage ohne Zugriffstoken ab", async () => {
    const response = await app.inject({ method: "GET", url: `/worlds/${WORLD_LHE}/accounts` });
    expect(response.statusCode).toBe(401);
  });

  it("lässt zwei Konten derselben Welt einander sehen, ein drittes aus einer anderen Welt nicht", async () => {
    const annaToken = await sign("kc-anna", "Anna");
    const benToken = await sign("kc-ben", "Ben");
    const claraToken = await sign("kc-clara", "Clara");

    for (const [token, worldId, displayName] of [
      [annaToken, WORLD_LHE, "Anna"],
      [benToken, WORLD_LHE, "Ben"],
      [claraToken, WORLD_MIDDLE_GERMANY, "Clara"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/worlds/${worldId}/access`,
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName },
      });
      expect(response.statusCode).toBe(201);
    }

    const roster = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/accounts`,
      headers: { authorization: `Bearer ${annaToken}` },
    });

    expect(roster.statusCode).toBe(200);
    const names = roster.json<{ displayName: string }[]>().map((account) => account.displayName);
    expect(names.sort()).toEqual(["Anna", "Ben"]);
  });

  it("verweigert die Kontoliste einem Konto ohne Zugang zu dieser Welt", async () => {
    const outsiderToken = await sign("kc-fremd", "Fremd");

    const response = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/accounts`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("Rollenvergabe", () => {
  it("macht das erste Konto einer Welt zum Weltverwalter und lässt es weitere Rollen vergeben", async () => {
    const adminToken = await sign("kc-admin", "Admin");
    const playerToken = await sign("kc-spieler", "Spieler");

    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { displayName: "Admin" },
    });
    const adminAccount = (
      await app.inject({
        method: "GET",
        url: `/worlds/${WORLD_LHE}/accounts`,
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json<{ id: string; keycloakSubject: string }[]>();
    const adminId = adminAccount.find((account) => account.keycloakSubject === "kc-admin")!.id;

    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${adminId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "world_admin" },
    });

    const playerAccessResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${playerToken}` },
      payload: { displayName: "Spieler" },
    });
    const playerId = playerAccessResponse.json<{ id: string }>().id;

    const grantResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${playerId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "world_admin" },
    });

    expect(grantResponse.statusCode).toBe(200);
    expect(grantResponse.json<{ roles: string[] }>().roles.sort()).toEqual(["player", "world_admin"]);
  });

  it("verweigert die Rollenvergabe einem Konto ohne Weltverwalter-Rolle", async () => {
    const playerToken = await sign("kc-spieler", "Spieler");
    const accessResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${playerToken}` },
      payload: { displayName: "Spieler" },
    });
    const playerId = accessResponse.json<{ id: string }>().id;

    const otherToken = await sign("kc-anders", "Anders");
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { displayName: "Anders" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${playerId}/roles`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { role: "world_admin" },
    });

    expect(response.statusCode).toBe(403);
  });
});
