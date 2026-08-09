import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import { verifyIdentityToken, type IdentityDatabase } from "@zugfolge/identity";
import { LivemapRegistry } from "@zugfolge/livemap-stream";
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
const LIVEMAP_INGEST_TOKEN = "test-only-livemap-ingest-token";
const SIMULATION_INGEST_TOKEN = "test-only-simulation-ingest-token";

let client: PGlite;
let db: IdentityDatabase;
let app: FastifyInstance;
let sign: (subject: string, displayName: string) => Promise<string>;
let livemap: LivemapRegistry;

beforeEach(async () => {
  client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
  db = pgliteDb;

  await pgliteDb.insert(worlds).values([
    { id: WORLD_LHE, name: "Leipzig–Halle–Erfurt", schedulePeriodWeeks: 4, epoch: new Date("2026-01-01T00:00:00Z") },
    {
      id: WORLD_MIDDLE_GERMANY,
      name: "Mitteldeutschland",
      schedulePeriodWeeks: 4,
      epoch: new Date("2026-01-01T00:00:00Z"),
    },
  ]);

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

  livemap = new LivemapRegistry();
  app = buildApp({
    db,
    verifyToken: (token) => verifyIdentityToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE }),
    livemap,
    livemapIngestToken: LIVEMAP_INGEST_TOKEN,
    simulationIngestToken: SIMULATION_INGEST_TOKEN,
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

describe("Livemap (M4.6)", () => {
  it("liefert den öffentlichen, weltisolierten Initialsnapshot", async () => {
    livemap.forWorld(WORLD_LHE).publish({
      at: 42,
      changed: [
        {
          id: "1",
          operator: "EVU",
          trainNumber: "RE 1",
          category: "regional",
          positionMm: 5,
          speedMmPerSecond: 2,
          delaySeconds: 0,
          nextOperatingPoint: "Halle",
          status: "running",
        },
      ],
      removed: [],
    });
    const response = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/snapshot`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ worldId: string; sequence: number; trains: unknown[] }>()).toMatchObject({
      worldId: WORLD_LHE,
      sequence: 1,
    });
    expect(response.json<{ trains: unknown[] }>().trains).toHaveLength(1);
    const other = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_MIDDLE_GERMANY}/livemap/snapshot`,
    });
    expect(other.json<{ trains: unknown[] }>().trains).toEqual([]);
  });

  it("legt für eine unbekannte UUID keinen Feed an", async () => {
    const unknown = "99999999-9999-4999-8999-999999999999";
    const before = livemap.size;
    const response = await app.inject({
      method: "GET",
      url: `/worlds/${unknown}/livemap/snapshot`,
    });
    expect(response.statusCode).toBe(404);
    expect(livemap.size).toBe(before);
  });

  it("übernimmt Simulationsdeltas ausschließlich über den geschützten internen Adapter", async () => {
    const body = {
      at: 99,
      changed: [{ id: "sim-1", operator: "EVU", trainNumber: "IC 1", category: "long-distance", positionMm: 10, speedMmPerSecond: 3, delaySeconds: 4, nextOperatingPoint: "Leipzig", status: "running" }],
      removed: [],
    };
    const denied = await app.inject({ method: "POST", url: `/internal/worlds/${WORLD_LHE}/livemap/deltas`, payload: body });
    expect(denied.statusCode).toBe(401);
    const accepted = await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD_LHE}/livemap/deltas`,
      headers: { authorization: `Bearer ${LIVEMAP_INGEST_TOKEN}` },
      payload: body,
    });
    expect(accepted.statusCode).toBe(202);
    expect(livemap.forWorld(WORLD_LHE).snapshot()).toMatchObject({ at: 99, sequence: 1, trains: [{ id: "sim-1" }] });
  });
});

describe("persistentes Simulations-Eventlog", () => {
  it("nimmt atomare Batches an, verweigert Lücken und stellt Replay bereit", async () => {
    const payload = {
      events: [
        { sequence: 1, eventType: "simulation.started", payload: { seed: 42 }, occurredAt: "2026-01-01T00:00:00.000Z" },
        { sequence: 2, eventType: "train.materialized", payload: { id: "1" }, occurredAt: "2026-01-01T00:00:01.000Z" },
      ],
    };
    const accepted = await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD_LHE}/simulation/events`,
      headers: { authorization: `Bearer ${SIMULATION_INGEST_TOKEN}` },
      payload,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ appended: 2, lastSequence: 2 });

    const gap = await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD_LHE}/simulation/events`,
      headers: { authorization: `Bearer ${SIMULATION_INGEST_TOKEN}` },
      payload: { events: [{ sequence: 4, eventType: "gap", payload: {}, occurredAt: "2026-01-01T00:00:02.000Z" }] },
    });
    expect(gap.statusCode).toBe(409);

    const token = await sign("event-reader", "Replay");
    const access = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${token}` }, payload: { displayName: "Replay" } });
    expect(access.statusCode).toBe(201);
    const replay = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/simulation/events?after=1&limit=10`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual([expect.objectContaining({ sequence: 2, eventType: "train.materialized" })]);

    await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD_LHE}/simulation/events`,
      headers: { authorization: `Bearer ${SIMULATION_INGEST_TOKEN}` },
      payload: { events: [{ sequence: 3, eventType: "planning.diagram", payload: { corridor: "LHE", stations: [], trains: [], occupations: [], conflicts: [] }, occurredAt: "2026-01-01T00:00:03.000Z" }] },
    });
    const diagram = await app.inject({ method: "GET", url: `/worlds/${WORLD_LHE}/planning/diagram`, headers: { authorization: `Bearer ${token}` } });
    expect(diagram.json()).toMatchObject({ sequence: 3, data: { corridor: "LHE" } });

    const queued = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/planning/alternatives`,
      headers: { authorization: `Bearer ${token}` },
      payload: { idempotencyKey: "ui-1", trainId: "t1", conflictId: "c1", shiftMinutes: 3 },
    });
    expect(queued.statusCode).toBe(202);
    const commandId = queued.json<{ id: string }>().id;
    const commands = await app.inject({ method: "GET", url: `/internal/worlds/${WORLD_LHE}/simulation/commands`, headers: { authorization: `Bearer ${SIMULATION_INGEST_TOKEN}` } });
    expect(commands.json()).toEqual([expect.objectContaining({ id: commandId, commandType: "planning.apply-alternative", status: "pending" })]);
    const acknowledged = await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD_LHE}/simulation/commands/${commandId}/result`,
      headers: { authorization: `Bearer ${SIMULATION_INGEST_TOKEN}` },
      payload: { status: "processed", resultEventSequence: 3, processedAt: "2026-01-01T00:00:04.000Z" },
    });
    expect(acknowledged.json()).toMatchObject({ status: "processed", resultEventSequence: 3 });
  });
});

describe("GET /health/ready", () => {
  it("meldet den aggregierten Zustand aller Health Checks ohne Authentifizierung", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      checks: [{ name: "postgres", status: "ok", code: "schema_current", durationMs: expect.any(Number) }],
    });
  });

  it("nimmt zusätzliche Health Checks künftiger Milestones in die Aggregation auf", async () => {
    const appMitErweiterung = buildApp({
      db,
      verifyToken: (token) => verifyIdentityToken(token, createLocalJWKSet({ keys: [] }), { issuer: ISSUER, audience: AUDIENCE }),
      extraHealthChecks: [{ name: "beispiel", check: async () => ({ status: "degraded", detail: "Testfall" }) }],
    });
    await appMitErweiterung.ready();
    try {
      const response = await appMitErweiterung.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "degraded",
        checks: expect.arrayContaining([{ name: "beispiel", status: "degraded", detail: "Testfall", durationMs: expect.any(Number) }]),
      });
    } finally {
      await appMitErweiterung.close();
    }
  });

  it("antwortet mit 503, sobald eine Prüfung ausfällt", async () => {
    const appMitAusfall = buildApp({
      db,
      verifyToken: (token) => verifyIdentityToken(token, createLocalJWKSet({ keys: [] }), { issuer: ISSUER, audience: AUDIENCE }),
      extraHealthChecks: [
        {
          name: "ausfall",
          check: async () => {
            throw new Error("nicht erreichbar");
          },
        },
      ],
    });
    await appMitAusfall.ready();
    try {
      const response = await appMitAusfall.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json().status).toBe("down");
      expect(response.body).not.toContain("nicht erreichbar");
    } finally {
      await appMitAusfall.close();
    }
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
    expect(roster.json<Record<string, unknown>[]>().every((account) => !("keycloakSubject" in account))).toBe(true);
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

    const adminAccess = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { displayName: "Admin" },
    });
    const adminId = adminAccess.json<{ id: string }>().id;

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

describe("EVU (M2.3)", () => {
  it("gründet ein EVU und listet es in der Welt", async () => {
    const annaToken = await sign("kc-anna", "Anna");
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${annaToken}` },
      payload: { displayName: "Anna" },
    });

    const foundResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators`,
      headers: { authorization: `Bearer ${annaToken}` },
      payload: { name: "Elbtalbahn" },
    });
    expect(foundResponse.statusCode).toBe(201);

    const roster = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/operators`,
      headers: { authorization: `Bearer ${annaToken}` },
    });
    expect(roster.json<{ name: string }[]>().map((operator) => operator.name)).toEqual(["Elbtalbahn"]);
  });

  it("lehnt die Gründung ohne Weltzugang ab", async () => {
    const fremdToken = await sign("kc-fremd2", "Fremd");
    const response = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators`,
      headers: { authorization: `Bearer ${fremdToken}` },
      payload: { name: "Phantom-Bahn" },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("Ledger-Kern (M2.4)", () => {
  async function gruendeElbtalbahn(): Promise<{ token: string; operatorId: string }> {
    const token = await sign("kc-ledger", "Ledger-Anna");
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Ledger-Anna" },
    });
    const founded = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Ledger-Bahn" },
    });
    return { token, operatorId: founded.json<{ id: string }>().id };
  }

  it("eröffnet Ledger-Konten, bucht eine ausgeglichene Transaktion und zeigt die Salden", async () => {
    const { token, operatorId } = await gruendeElbtalbahn();

    const kasse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Kasse" },
    });
    const entgelt = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Trassenentgelt" },
    });
    const kasseId = kasse.json<{ id: string }>().id;
    const entgeltId = entgelt.json<{ id: string }>().id;

    const transactionResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        description: "Trassenentgelt Januar",
        entries: [
          { ledgerAccountId: kasseId, amountCents: "-1234" },
          { ledgerAccountId: entgeltId, amountCents: "1234" },
        ],
      },
    });
    expect(transactionResponse.statusCode).toBe(201);

    const accountsWithBalance = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${token}` },
    });
    const balances = accountsWithBalance.json<{ id: string; balanceCents: string }[]>();
    expect(balances.find((account) => account.id === kasseId)?.balanceCents).toBe("-1234");
    expect(balances.find((account) => account.id === entgeltId)?.balanceCents).toBe("1234");
  });

  it("lehnt eine unausgeglichene Transaktion ab", async () => {
    const { token, operatorId } = await gruendeElbtalbahn();
    const kasse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Kasse" },
    });
    const entgelt = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Trassenentgelt" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        description: "Unausgeglichen",
        entries: [
          { ledgerAccountId: kasse.json<{ id: string }>().id, amountCents: "-100" },
          { ledgerAccountId: entgelt.json<{ id: string }>().id, amountCents: "50" },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("verweigert ein fremdes Konto den Zugriff auf die Bücher eines EVU", async () => {
    const { operatorId } = await gruendeElbtalbahn();
    const fremdToken = await sign("kc-fremd3", "Fremd");
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${fremdToken}` },
      payload: { displayName: "Fremd" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${fremdToken}` },
      payload: { name: "Kasse" },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("Postfach (M2.5)", () => {
  it("stellt eine Nachricht zu, listet sie im Postfach und quittiert sie", async () => {
    const adminToken = await sign("kc-postadmin", "Postadmin");
    const adminAccess = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { displayName: "Postadmin" },
    });
    const adminId = adminAccess.json<{ id: string }>().id;
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${adminId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "world_admin" },
    });

    const spielerToken = await sign("kc-postspieler", "Postspieler");
    const spielerAccess = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${spielerToken}` },
      payload: { displayName: "Postspieler" },
    });
    const spielerId = spielerAccess.json<{ id: string }>().id;

    const sendResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${spielerId}/mailbox`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { messageType: "system.willkommen", payload: { text: "Willkommen" } },
    });
    expect(sendResponse.statusCode).toBe(201);

    const inbox = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/mailbox`,
      headers: { authorization: `Bearer ${spielerToken}` },
    });
    const messages = inbox.json<{ id: string; acknowledgedAt: string | null }[]>();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.acknowledgedAt).toBeNull();

    const ackResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/mailbox/${messages[0]!.id}/ack`,
      headers: { authorization: `Bearer ${spielerToken}` },
    });
    expect(ackResponse.statusCode).toBe(200);
    expect(ackResponse.json<{ acknowledgedAt: string | null }>().acknowledgedAt).not.toBeNull();
  });

  it("verweigert den Versand einer Nachricht ohne Weltverwalter-Rolle", async () => {
    const spielerToken = await sign("kc-postspieler2", "Postspieler2");
    const spielerAccess = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${spielerToken}` },
      payload: { displayName: "Postspieler2" },
    });
    const spielerId = spielerAccess.json<{ id: string }>().id;

    const response = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${spielerId}/mailbox`,
      headers: { authorization: `Bearer ${spielerToken}` },
      payload: { messageType: "system.willkommen", payload: {} },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("Datenschutz (M2.6)", () => {
  it("liefert die eigene Auskunft und erlaubt die Selbstlöschung", async () => {
    const token = await sign("kc-privacy", "Privacy-Anna");
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Privacy-Anna" },
    });

    const exportResponse = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/me/export`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.json<{ account: { displayName: string } }>().account.displayName).toBe("Privacy-Anna");

    const eraseResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/me/erase`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(eraseResponse.statusCode).toBe(200);
    expect(eraseResponse.json<{ displayName: string }>().displayName).toBe("Gelöschtes Konto");

    const reaccessResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Privacy-Anna" },
    });
    expect(reaccessResponse.statusCode).toBe(403);

    const rosterAfterErase = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/accounts`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rosterAfterErase.statusCode).toBe(403);

    const operatorAfterErase = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Darf nicht entstehen" },
    });
    expect(operatorAfterErase.statusCode).toBe(403);
  });

  it("verweigert die Auskunft ohne Konto in der Welt", async () => {
    const fremdToken = await sign("kc-privacyfremd", "Fremd");
    const response = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/me/export`,
      headers: { authorization: `Bearer ${fremdToken}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
