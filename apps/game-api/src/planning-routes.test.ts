import { PGlite } from "@electric-sql/pglite";
import {
  domainEvents,
  MIGRATIONS_FOLDER,
  simulationCommands,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { requestWorldAccess, type AccountRecord } from "@zugfolge/identity";
import {
  PLANNING_COORDINATE_AUTHORITY_SCHEMA,
  PLANNING_PATH_REQUEST_SCHEMA,
} from "@zugfolge/planning-worker";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const worldA = "11111111-1111-4111-8111-111111111111";
const worldB = "22222222-2222-4222-8222-222222222222";
const unknownWorld = "99999999-9999-4999-8999-999999999999";
const internalToken = "planning-route-internal-token";

function pathRequest(requestId: string, trainId: string, trainNumber: number) {
  return {
    schemaVersion: PLANNING_PATH_REQUEST_SCHEMA,
    requestId,
    trainId,
    trainCategory: "regional" as const,
    trainNumber,
    originStationId: "leipzig",
    destinationStationId: "halle",
    desiredDepartureS: 25_800,
    operatingDays: "daily" as const,
    stops: [],
    earlierS: 300,
    laterS: 300,
    stepS: 60,
    extraRunningTimeS: 0,
    maxOperationalStops: 1,
    train: {
      numericId: trainNumber,
      name: `RE ${trainNumber}`,
      massKg: 160_000,
      lengthMm: 100_000,
      maximumSpeedKph: 160,
      accelerationMmPerS2: 700,
      decelerationMmPerS2: 800,
    },
  };
}

describe("produktive M3-Planning-Routen", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;
  let accountA: AccountRecord;
  let accountB: AccountRecord;
  let authority: AccountRecord;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([
      { id: worldA, name: "A", schedulePeriodWeeks: 4, epoch: new Date(0) },
      { id: worldB, name: "B", schedulePeriodWeeks: 4, epoch: new Date(0) },
    ]);
    accountA = await requestWorldAccess(db, {
      worldId: worldA,
      keycloakSubject: "account-a",
      displayName: "A",
    });
    accountB = await requestWorldAccess(db, {
      worldId: worldA,
      keycloakSubject: "account-b",
      displayName: "B",
    });
    await requestWorldAccess(db, {
      worldId: worldB,
      keycloakSubject: "foreign",
      displayName: "Fremd",
    });
    authority = await requestWorldAccess(db, {
      worldId: worldA,
      keycloakSubject: "authority",
      displayName: "Aufgabentraeger",
    });
    app = buildApp({
      db,
      verifyToken: async (token) => {
        if (!["account-a", "account-b", "foreign"].includes(token)) {
          throw new Error("ungueltig");
        }
        return { keycloakSubject: token, displayName: token };
      },
      simulationIngestToken: internalToken,
      planningAuthorityAccountIds: { [worldA]: authority.id },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await client.close();
  });

  async function submitPath(token: string, body: ReturnType<typeof pathRequest>) {
    return app.inject({
      method: "POST",
      url: `/worlds/${worldA}/planning/path-requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  it("bindet Welt und zwei aktive Konten serverseitig und validiert exakt", async () => {
    const bodyA = pathRequest("request-a", "train-a", 26801);
    expect((await app.inject({
      method: "POST",
      url: `/worlds/${worldA}/planning/path-requests`,
      payload: bodyA,
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: `/worlds/${unknownWorld}/planning/path-requests`,
      headers: { authorization: "Bearer account-a" },
      payload: bodyA,
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST",
      url: `/worlds/${worldA}/planning/path-requests`,
      headers: { authorization: "Bearer foreign" },
      payload: bodyA,
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: `/worlds/${worldA}/planning/path-requests`,
      headers: { authorization: "Bearer account-a" },
      payload: { ...bodyA, worldId: worldB, requestingAccountId: accountB.id },
    })).statusCode).toBe(400);

    const first = await submitPath("account-a", bodyA);
    const second = await submitPath(
      "account-b",
      pathRequest("request-b", "train-b", 26802),
    );
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    const commands = await db
      .select()
      .from(simulationCommands)
      .where(inArray(simulationCommands.id, [
        first.json<{ id: string }>().id,
        second.json<{ id: string }>().id,
      ]));
    expect(new Set(commands.map((command) => command.requestingAccountId))).toEqual(
      new Set([accountA.id, accountB.id]),
    );
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        worldId: worldA,
        commandType: "planning.path-request",
        payload: expect.objectContaining({ worldId: worldA }),
      }),
    ]));
  });

  it("behandelt fachliche Antrags-ID-Kollisionen stabil als 409", async () => {
    const body = pathRequest("same-request", "train-a", 26801);
    const first = await submitPath("account-a", body);
    const retry = await submitPath("account-a", body);
    const collision = await submitPath("account-a", { ...body, trainNumber: 26899 });

    expect(first.statusCode).toBe(202);
    expect(retry.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({ code: "planning_worker_conflict" });
  });

  it("koordiniert nur intern ueber den konfigurierten Authority-Principal", async () => {
    const first = await submitPath(
      "account-a",
      pathRequest("request-a", "train-a", 26801),
    );
    const second = await submitPath(
      "account-b",
      pathRequest("request-b", "train-b", 26802),
    );
    const body = {
      schemaVersion: PLANNING_COORDINATE_AUTHORITY_SCHEMA,
      runId: "run-1",
      expectedProjectionRevision: null,
      seedWorld: "1",
      seedPeriod: 0,
      infrastructureReleaseId: "lhe-2026",
      requestCommandIds: [
        first.json<{ id: string }>().id,
        second.json<{ id: string }>().id,
      ],
    } as const;
    const url = `/internal/worlds/${worldA}/planning/coordinate`;
    expect((await app.inject({ method: "POST", url, payload: body })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        ...body,
        authorityAccountId: accountA.id,
        stations: [],
        segments: [],
      },
    })).statusCode).toBe(400);

    const accepted = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: body,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      worldId: worldA,
      requestingAccountId: authority.id,
      commandType: "planning.coordinate",
      payload: {
        ...body,
        worldId: worldA,
      },
    });
    expect(accepted.json<{ payload: Record<string, unknown> }>().payload).not.toHaveProperty(
      "authorityAccountId",
    );
    expect(accepted.json<{ payload: Record<string, unknown> }>().payload).not.toHaveProperty(
      "stations",
    );

    const collision = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { ...body, seedWorld: "2" },
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({ code: "planning_worker_conflict" });
  });

  it("sperrt reservierte Planning-Ereignisse und Kommandos fuer generische Adapter", async () => {
    const first = await submitPath(
      "account-a",
      pathRequest("request-a", "train-a", 26801),
    );
    for (const eventType of [
      "planning.runtime-state",
      "planning.diagram",
      "livemap-operation-marked",
      "livemap-operation-cleared",
      "operating-duty-ended",
      "operating-transition-completed",
      "train-operation-assigned",
    ]) {
      const reservedEvents = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/simulation/events`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: {
          events: [
            {
              sequence: 1,
              eventType,
              payload: {},
              occurredAt: "2026-08-11T00:00:00.000Z",
            },
          ],
        },
      });
      expect(reservedEvents.statusCode).toBe(409);
    expect(reservedEvents.json()).toMatchObject({
        code: "reserved_single_writer_event_type",
      });
    }
    expect(await db.select().from(domainEvents)).toEqual([]);

    const additionalReserved = await db.insert(simulationCommands).values([
      {
        worldId: worldA,
        requestingAccountId: authority.id,
        idempotencyKey: "reserved-coordinate",
        commandType: "planning.coordinate",
        payload: {},
        submittedAt: new Date(0),
      },
      {
        worldId: worldA,
        requestingAccountId: accountA.id,
        idempotencyKey: "reserved-alternative",
        commandType: "planning.apply-alternative",
        payload: {},
        submittedAt: new Date(0),
      },
    ]).returning({ id: simulationCommands.id });
    const [generic] = await db.insert(simulationCommands).values({
      worldId: worldA,
      requestingAccountId: accountA.id,
      idempotencyKey: "generic",
      commandType: "dispatch.backtest",
      payload: {},
      submittedAt: new Date(0),
    }).returning();
    const pending = await app.inject({
      method: "GET",
      url: `/internal/worlds/${worldA}/simulation/commands`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(pending.json()).toEqual([expect.objectContaining({ id: generic!.id })]);
    expect(pending.json<readonly { id: string }[]>().some(
      (command) => command.id === first.json<{ id: string }>().id,
    )).toBe(false);

    const reservedCommandIds = [
      first.json<{ id: string }>().id,
      ...additionalReserved.map((command) => command.id),
    ];
    for (const commandId of reservedCommandIds) {
      const reservedResult = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/simulation/commands/${commandId}/result`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: {
          status: "failed",
          failureCode: "generic_failure",
          processedAt: "2026-08-11T00:00:01.000Z",
        },
      });
      expect(reservedResult.statusCode).toBe(409);
      expect(reservedResult.json()).toMatchObject({
        code: "reserved_planning_command_type",
      });
    }
    expect(
      await db
        .select({ id: simulationCommands.id, status: simulationCommands.status })
        .from(simulationCommands)
        .where(inArray(simulationCommands.id, reservedCommandIds)),
    ).toEqual(expect.arrayContaining(
      reservedCommandIds.map((id) => ({ id, status: "pending" })),
    ));

    const genericResult = await app.inject({
      method: "POST",
      url: `/internal/worlds/${worldA}/simulation/commands/${generic!.id}/result`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        status: "failed",
        failureCode: "done",
        processedAt: "2026-08-11T00:00:01.000Z",
      },
    });
    expect(genericResult.statusCode).toBe(200);
  });
});
