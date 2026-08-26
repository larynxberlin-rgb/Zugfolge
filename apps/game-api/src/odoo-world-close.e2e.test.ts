import { PGlite } from "@electric-sql/pglite";
import { WorldEndService } from "@zugfolge/alpha";
import {
  createOdooWebhookReceiptStore,
  markOdooProjectionDelivered,
  processNextOdooCommand,
  receiveOdooWebhook,
  signPayload,
  type GameAdminCommandHandler,
  type OdooWebhookEnvelope,
  type SigningKey,
} from "@zugfolge/commerce";
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
  worldFinalRankings,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorldCloseAdminHandler } from "./odoo-admin-handlers.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const AT_S = 600;
const WORLD = "88888888-8888-4888-8888-888888888888";
const GLOBAL_ADMIN_SCOPE = "00000000-0000-0000-0000-000000000000";
const KEY: SigningKey = {
  id: "world-close-e2e",
  secret: "world-close-e2e-secret",
  activeFrom: new Date("2026-01-01T00:00:00.000Z"),
};
const RECEIVER_OPTIONS = {
  tenantId: "zugfolge-production",
  keys: [KEY],
  authorizedActors: { "odoo-admin": ["admin.world_close"] },
} as const;

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

function closeEnvelope(eventId: string): OdooWebhookEnvelope {
  return {
    schemaVersion: "zugfolge-odoo/v1",
    eventId,
    eventType: "commerce.command",
    occurredAt: NOW.toISOString(),
    correlationId: `correlation-${eventId}`,
    tenantId: "zugfolge-production",
    actorReference: "odoo-admin",
    command: {
      kind: "admin.world_close",
      worldId: WORLD,
      actionType: "world_close",
      riskClass: "high",
      requesterReference: "odoo-requester",
      approverReference: "odoo-approver",
      reason: "Vier-Augen-Abschluss der letzten Fahrplanperiode",
      effectPreview: { requestedAtS: AT_S },
      requestedAtS: AT_S,
    },
  };
}

async function setupRunningWorld(): Promise<void> {
  await db.insert(worlds).values({
    id: WORLD,
    name: "Atomic WorldEnd E2E",
    schedulePeriodWeeks: 4,
    epoch: NOW,
    worldKind: "public",
    rankingStatus: "ranked",
    lifecycleStatus: "active",
  });
  const [account] = await db.insert(accounts).values({
    worldId: WORLD,
    keycloakSubject: "world-close-e2e-account",
    displayName: "World Close E2E",
  }).returning({ id: accounts.id });
  await db.insert(operators).values({
    worldId: WORLD,
    foundingAccountId: account!.id,
    name: "World Close E2E EVU",
  });
  await db.insert(alphaWorldProfiles).values({
    worldId: WORLD,
    profileKind: "public",
    regionId: "mitteldeutschland-b",
    regionVariant: "B",
    worldSeed: 20260825n,
    accelerationFactor: 1,
    infraReleaseHash: "a".repeat(64),
    timetableReleaseHash: "b".repeat(64),
    fleetReleaseHash: "c".repeat(64),
    economyReleaseHash: "d".repeat(64),
    blueprint: { schemaVersion: "zugfolge-alpha-world-blueprint/v2" },
    blueprintHash: "e".repeat(64),
    periodCount: 1,
    currentPeriod: 0,
    state: "running",
    startedAtS: 0,
  });
}

function countedWorldCloseHandler(afterCommit: (worldId: string) => Promise<void> | void = () => undefined): {
  readonly handler: GameAdminCommandHandler;
  readonly calls: () => number;
} {
  const authoritative = createWorldCloseAdminHandler(new WorldEndService(db), afterCommit);
  let calls = 0;
  return {
    handler: async (context) => {
      calls += 1;
      return authoritative(context);
    },
    calls: () => calls,
  };
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await setupRunningWorld();
}, 30_000);

afterEach(async () => client.close());

describe("Odoo world_close atomic E2E", () => {
  it("committet Wirkung, Admin-Belege und globales Resultat vor dem finalen Lifecycle-Seal genau einmal", async () => {
    const envelope = closeEnvelope("odoo-world-close-e2e-success");
    const signed = signPayload(envelope, KEY, NOW);
    await expect(receiveOdooWebhook(
      createOdooWebhookReceiptStore(db),
      signed,
      RECEIVER_OPTIONS,
      NOW,
    )).resolves.toEqual({ accepted: true, duplicate: false });

    let afterCommitObservedArchived = false;
    const afterCommit = vi.fn(async (worldId: string) => {
      const [committed] = await db.select({ lifecycleStatus: worlds.lifecycleStatus })
        .from(worlds).where(eq(worlds.id, worldId));
      afterCommitObservedArchived = committed?.lifecycleStatus === "archived";
    });
    const counted = countedWorldCloseHandler(afterCommit);
    await expect(processNextOdooCommand(db, NOW, {
      adminHandlers: { world_close: counted.handler },
    })).resolves.toEqual(expect.objectContaining({ outcome: "accepted" }));
    expect(counted.calls()).toBe(1);
    expect(afterCommit).toHaveBeenCalledOnce();
    expect(afterCommit).toHaveBeenCalledWith(WORLD);
    expect(afterCommitObservedArchived).toBe(true);

    const [world] = await db.select().from(worlds).where(eq(worlds.id, WORLD));
    const [profile] = await db.select().from(alphaWorldProfiles)
      .where(eq(alphaWorldProfiles.worldId, WORLD));
    const [request] = await db.select().from(gameAdminRequests)
      .where(eq(gameAdminRequests.worldId, WORLD));
    const [command] = await db.select().from(odooCommandQueue)
      .where(eq(odooCommandQueue.eventId, envelope.eventId));
    const events = await db.select().from(domainEvents)
      .where(eq(domainEvents.worldId, WORLD));
    const globalResults = await db.select().from(odooProjectionOutbox).where(and(
      eq(odooProjectionOutbox.worldId, GLOBAL_ADMIN_SCOPE),
      eq(odooProjectionOutbox.correlationId, envelope.correlationId),
    ));

    expect(world?.lifecycleStatus).toBe("archived");
    expect(profile).toMatchObject({
      state: "archived",
      closingAtS: AT_S,
      archivedAtS: AT_S,
      finalStateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(command).toMatchObject({
      status: "completed",
      claimToken: null,
      claimExpiresAt: null,
    });
    expect(request).toMatchObject({
      state: "completed",
      gameAuditEventId: expect.any(String),
    });
    expect(events).toEqual([
      expect.objectContaining({
        sequence: 1,
        eventType: "alpha.world-archived",
        payload: expect.objectContaining({ adminRequestId: request!.id }),
      }),
      expect.objectContaining({
        sequence: 2,
        eventType: "admin.action-audited",
        payload: expect.objectContaining({ adminRequestId: request!.id, outcome: "completed" }),
      }),
    ]);
    expect(await db.select().from(worldFinalRankings)
      .where(eq(worldFinalRankings.worldId, WORLD))).toHaveLength(5);
    expect(await db.select().from(worldArchives)
      .where(eq(worldArchives.worldId, WORLD))).toHaveLength(3);
    expect(globalResults).toHaveLength(1);
    expect(globalResults[0]).toMatchObject({
      worldId: GLOBAL_ADMIN_SCOPE,
      messageType: "admin.command.result",
      deliveredAt: null,
      payload: expect.objectContaining({
        projectionScope: "global-admin",
        actionType: "world_close",
        targetWorldId: WORLD,
        adminRequestId: request!.id,
        gameAuditEventId: request!.gameAuditEventId,
        finalStateHash: profile!.finalStateHash,
        outcome: "accepted",
        state: "completed",
        authoritative: true,
      }),
    });
    const deliveredAt = new Date(NOW.getTime() + 500);
    await expect(markOdooProjectionDelivered(
      db,
      WORLD,
      globalResults[0]!.id,
      deliveredAt,
    )).resolves.toBe(false);
    await expect(markOdooProjectionDelivered(
      db,
      GLOBAL_ADMIN_SCOPE,
      globalResults[0]!.id,
      deliveredAt,
    )).resolves.toBe(true);
    await expect(markOdooProjectionDelivered(
      db,
      GLOBAL_ADMIN_SCOPE,
      globalResults[0]!.id,
      new Date(deliveredAt.getTime() + 1_000),
    )).resolves.toBe(false);
    await expect(db.select({ deliveredAt: odooProjectionOutbox.deliveredAt })
      .from(odooProjectionOutbox)
      .where(and(
        eq(odooProjectionOutbox.worldId, GLOBAL_ADMIN_SCOPE),
        eq(odooProjectionOutbox.id, globalResults[0]!.id),
      ))).resolves.toEqual([{ deliveredAt }]);

    // Ein verlorenes HTTP-Ack fuehrt nur zur Receiver-Duplikatquittierung;
    // das bereits completed Queue-Kommando wird nicht erneut geclaimt und der
    // Weltabschluss-Handler erhaelt keinen zweiten Aufruf.
    await expect(receiveOdooWebhook(
      createOdooWebhookReceiptStore(db),
      signed,
      RECEIVER_OPTIONS,
      new Date(NOW.getTime() + 1_000),
    )).resolves.toEqual({ accepted: true, duplicate: true });
    await expect(processNextOdooCommand(db, new Date(NOW.getTime() + 1_000), {
      adminHandlers: { world_close: counted.handler },
    })).resolves.toBeUndefined();
    expect(counted.calls()).toBe(1);
    expect(afterCommit).toHaveBeenCalledOnce();
    expect(await db.select().from(worldFinalRankings)
      .where(eq(worldFinalRankings.worldId, WORLD))).toHaveLength(5);
    expect(await db.select().from(worldArchives)
      .where(eq(worldArchives.worldId, WORLD))).toHaveLength(3);
    expect(await db.select().from(odooProjectionOutbox).where(and(
      eq(odooProjectionOutbox.worldId, GLOBAL_ADMIN_SCOPE),
      eq(odooProjectionOutbox.correlationId, envelope.correlationId),
    ))).toHaveLength(1);
  });

  it("rollt bei offenem weltgebundenem Odoo-Beleg alles zurueck und schliesst nach kontrolliertem Ack beim Retry", async () => {
    const [blockingProjection] = await db.insert(odooProjectionOutbox).values({
      worldId: WORLD,
      messageType: "world.projection",
      schemaVersion: "zugfolge-odoo/v1",
      correlationId: "world-close-drain-blocker",
      payload: { freshness: "delayed" },
      occurredAt: NOW,
      enqueuedAt: NOW,
    }).returning({ id: odooProjectionOutbox.id });
    const envelope = closeEnvelope("odoo-world-close-e2e-drain-retry");
    await receiveOdooWebhook(
      createOdooWebhookReceiptStore(db),
      signPayload(envelope, KEY, NOW),
      RECEIVER_OPTIONS,
      NOW,
    );
    const counted = countedWorldCloseHandler();

    await expect(processNextOdooCommand(db, NOW, {
      adminHandlers: { world_close: counted.handler },
    })).rejects.toMatchObject({
      cause: { message: expect.stringContaining("pending odoo projection") },
    });
    expect(counted.calls()).toBe(1);
    await expect(db.select({ lifecycleStatus: worlds.lifecycleStatus }).from(worlds)
      .where(eq(worlds.id, WORLD))).resolves.toEqual([{ lifecycleStatus: "active" }]);
    await expect(db.select({ state: alphaWorldProfiles.state }).from(alphaWorldProfiles)
      .where(eq(alphaWorldProfiles.worldId, WORLD))).resolves.toEqual([{ state: "running" }]);
    await expect(db.select().from(worldFinalRankings)
      .where(eq(worldFinalRankings.worldId, WORLD))).resolves.toEqual([]);
    await expect(db.select().from(worldArchives)
      .where(eq(worldArchives.worldId, WORLD))).resolves.toEqual([]);
    await expect(db.select().from(domainEvents)
      .where(eq(domainEvents.worldId, WORLD))).resolves.toEqual([]);
    await expect(db.select().from(odooProjectionOutbox).where(and(
      eq(odooProjectionOutbox.worldId, GLOBAL_ADMIN_SCOPE),
      eq(odooProjectionOutbox.correlationId, envelope.correlationId),
    ))).resolves.toEqual([]);
    const [retryableCommand] = await db.select().from(odooCommandQueue)
      .where(eq(odooCommandQueue.eventId, envelope.eventId));
    expect(retryableCommand).toMatchObject({
      status: "pending",
      claimToken: null,
      claimExpiresAt: null,
      failureCode: null,
    });

    await expect(markOdooProjectionDelivered(
      db,
      WORLD,
      blockingProjection!.id,
      new Date(NOW.getTime() + 1_000),
    )).resolves.toBe(true);
    await expect(processNextOdooCommand(db, new Date(NOW.getTime() + 2_000), {
      adminHandlers: { world_close: counted.handler },
    })).resolves.toEqual(expect.objectContaining({ outcome: "accepted" }));
    expect(counted.calls()).toBe(2);
    await expect(db.select({ lifecycleStatus: worlds.lifecycleStatus }).from(worlds)
      .where(eq(worlds.id, WORLD))).resolves.toEqual([{ lifecycleStatus: "archived" }]);
    await expect(db.select().from(worldFinalRankings)
      .where(eq(worldFinalRankings.worldId, WORLD))).resolves.toHaveLength(5);
    await expect(db.select().from(worldArchives)
      .where(eq(worldArchives.worldId, WORLD))).resolves.toHaveLength(3);
    await expect(db.select().from(domainEvents)
      .where(eq(domainEvents.worldId, WORLD))).resolves.toHaveLength(2);
    await expect(db.select().from(odooProjectionOutbox).where(and(
      eq(odooProjectionOutbox.worldId, GLOBAL_ADMIN_SCOPE),
      eq(odooProjectionOutbox.correlationId, envelope.correlationId),
    ))).resolves.toHaveLength(1);
  });
});
