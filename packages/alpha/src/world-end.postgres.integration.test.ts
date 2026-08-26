import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import {
  MIGRATIONS_FOLDER,
  accounts,
  alphaWorldProfiles,
  domainEvents,
  gameAdminRequests,
  odooCommandQueue,
  odooProjectionOutbox,
  operators,
  worldArchives,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";

import { alphaHash } from "./hash.js";
import { WorldEndService } from "./world-end.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const EPOCH = new Date("2026-08-25T00:00:00.000Z");
const AT_S = 20;
const requireFromDb = createRequire(new URL("../../db/package.json", import.meta.url));
const postgresModule = requireFromDb("postgres");
const postgres = postgresModule.default ?? postgresModule;

async function withTemporaryDatabase(run: (client: any, targetUrl: string) => Promise<void>) {
  if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL fehlt.");
  const databaseName = `zf_world_end_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl.toString(), { max: 1 });
  let target;
  try {
    await admin.unsafe(`create database "${databaseName}"`);
    target = postgres(targetUrl.toString(), { max: 1 });
    await migrate(drizzle(target, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    await run(target, targetUrl.toString());
  } finally {
    if (target !== undefined) await target.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await admin.end({ timeout: 5 });
  }
}

async function waitForExclusiveWorldLock(observer: any, backendPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [waiting] = await observer`
      select exists (
        select 1 from pg_locks
        where pid = ${backendPid}
          and locktype = 'advisory'
          and mode = 'ExclusiveLock'
          and not granted
      ) as waiting`;
    if (waiting?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`WorldEndService-Backend ${backendPid} wartete nicht auf den offenen Welt-Writer.`);
}

describe.skipIf(databaseUrl === undefined)("WorldEndService mit echtem PostgreSQL-Writer", () => {
  it("wartet vor dem ersten Abschluss-Read und nimmt den gerade committeten Event in Replay und Schluss-Hash auf", async () => {
    await withTemporaryDatabase(async (seedClient, targetUrl) => {
      const db = drizzle(seedClient, { schema });
      const worldId = randomUUID();
      await db.insert(worlds).values({
        id: worldId,
        name: "PostgreSQL Weltabschluss-Race",
        schedulePeriodWeeks: 3,
        epoch: EPOCH,
      });
      const [account] = await db.insert(accounts).values({
        worldId,
        keycloakSubject: `world-end-${worldId}`,
        displayName: "Abschlusskonto",
      }).returning();
      if (account === undefined) throw new Error("Abschlusskonto fehlt.");
      await db.insert(operators).values({
        worldId,
        foundingAccountId: account.id,
        name: "Abschluss-EVU",
      });
      await db.insert(alphaWorldProfiles).values({
        worldId,
        profileKind: "public",
        regionId: "mitteldeutschland-b",
        regionVariant: "B",
        worldSeed: 20260825n,
        accelerationFactor: 1,
        infraReleaseHash: "a".repeat(64),
        timetableReleaseHash: "b".repeat(64),
        fleetReleaseHash: "c".repeat(64),
        economyReleaseHash: "d".repeat(64),
        blueprint: { region: "B" },
        blueprintHash: "e".repeat(64),
        periodCount: 1,
        currentPeriod: 0,
        state: "running",
        startedAtS: 0,
      });
      const [command] = await db.insert(odooCommandQueue).values({
        eventId: `world-close-${worldId}`,
        worldId,
        commandType: "admin.world_close",
        actorReference: "odoo",
        payload: {
          kind: "admin.world_close",
          actionType: "world_close",
          riskClass: "high",
          worldId,
          requestedAtS: AT_S,
        },
        correlationId: `close-${worldId}`,
        status: "processing",
        receivedAt: EPOCH,
      }).returning();
      if (command === undefined) throw new Error("Abschlusskommando fehlt.");
      const [request] = await db.insert(gameAdminRequests).values({
        worldId,
        commandId: command.id,
        actionType: "world_close",
        riskClass: "high",
        requesterReference: "requester",
        approverReference: "approver",
        reason: "PostgreSQL Writer-Race qualifizieren",
        effectPreview: {},
        state: "dispatched",
        correlationId: command.correlationId,
      }).returning();
      if (request === undefined) throw new Error("Abschlussfreigabe fehlt.");

      const observer = postgres(targetUrl, { max: 1 });
      const openWriter = postgres(targetUrl, { max: 1 });
      const closer = postgres(targetUrl, { max: 1 });
      let signalWriterReady!: () => void;
      let releaseWriter!: () => void;
      const writerReady = new Promise<void>((resolve) => { signalWriterReady = resolve; });
      const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
      try {
        const [closerBackend] = await closer`select pg_backend_pid()::int as pid`;
        if (closerBackend === undefined) throw new Error("Abschlussbackend besitzt keine PID.");
        const writerAttempt = openWriter.begin("isolation level read committed", async (tx: any) => {
          await tx`
            insert into domain_events (world_id, sequence, event_type, payload, occurred_at)
            values (${worldId}, 1, 'service.completed',
              ${tx.json({ operatorId: "writer-before-finalize", served: 17 })}, ${EPOCH})`;
          signalWriterReady();
          await writerRelease;
        });
        await writerReady;

        const closeAttempt = closer.begin("isolation level read committed", async (tx: any) => {
          const transactionDb = drizzle(tx, { schema });
          return new WorldEndService(transactionDb).close({
            db: transactionDb,
            worldId,
            atS: AT_S,
            adminRequestId: request.id,
            beforeSeal: async (closed) => {
              const [head] = await transactionDb.select({ sequence: domainEvents.sequence }).from(domainEvents)
                .where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
              const effectAuditReference = `world-close:${worldId}:${closed.finalStateHash}`;
              const [audit] = await transactionDb.insert(domainEvents).values({
                worldId,
                sequence: (head?.sequence ?? 0) + 1,
                eventType: "admin.action-audited",
                payload: {
                  adminRequestId: request.id,
                  actionType: "world_close",
                  riskClass: "high",
                  correlationId: command.correlationId,
                  outcome: "completed",
                  effectAuditReference,
                },
                occurredAt: EPOCH,
              }).returning({ id: domainEvents.id });
              if (audit === undefined) throw new Error("Abschlussaudit fehlt.");
              await transactionDb.update(gameAdminRequests).set({
                state: "completed",
                gameAuditEventId: audit.id,
                changedAt: EPOCH,
              }).where(eq(gameAdminRequests.id, request.id));
              await transactionDb.update(odooCommandQueue).set({
                status: "completed",
                processedAt: EPOCH,
              }).where(eq(odooCommandQueue.id, command.id));
              await transactionDb.insert(odooProjectionOutbox).values({
                worldId: "00000000-0000-0000-0000-000000000000",
                messageType: "admin.command.result",
                schemaVersion: "zugfolge-odoo/v1",
                correlationId: command.correlationId,
                payload: {
                  finalStateHash: closed.finalStateHash,
                  evidenceHash: closed.evidenceHash,
                  replayHash: closed.replayHash,
                  archivedAtS: AT_S,
                  eventId: command.eventId,
                  outcome: "accepted",
                  state: "completed",
                  authoritative: true,
                  projectionScope: "global-admin",
                  actionType: "world_close",
                  targetWorldId: worldId,
                  adminRequestId: request.id,
                  gameAuditEventId: audit.id,
                  effectAuditReference,
                },
                occurredAt: EPOCH,
                enqueuedAt: EPOCH,
              });
            },
          });
        });

        await waitForExclusiveWorldLock(observer, closerBackend.pid);
        releaseWriter();
        await writerAttempt;
        const closed = await closeAttempt;

        const persistedEvents = await db.select().from(domainEvents)
          .where(eq(domainEvents.worldId, worldId)).orderBy(domainEvents.sequence);
        expect(persistedEvents.map(({ sequence, eventType }) => ({ sequence, eventType }))).toEqual([
          { sequence: 1, eventType: "service.completed" },
          { sequence: 2, eventType: "alpha.world-archived" },
          { sequence: 3, eventType: "admin.action-audited" },
        ]);
        expect(closed.replayHash).toBe(alphaHash("zugfolge-authorized-replay/v1", [{
          sequence: 1,
          type: "service.completed",
          payload: { operatorId: "writer-before-finalize", served: 17 },
          occurredAt: EPOCH.toISOString(),
        }]));
        const [archive] = await db.select().from(worldArchives)
          .where(eq(worldArchives.worldId, worldId)).limit(1);
        expect(archive).toMatchObject({ eventFromSequence: 1, eventUntilSequence: 1, stateHash: closed.finalStateHash });
      } finally {
        releaseWriter();
        await Promise.all([
          observer.end({ timeout: 5 }),
          openWriter.end({ timeout: 5 }),
          closer.end({ timeout: 5 }),
        ]);
      }
    });
  }, 30_000);
});
