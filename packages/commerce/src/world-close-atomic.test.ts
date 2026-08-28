import { PGlite } from "@electric-sql/pglite";
import {
  alphaWorldProfiles,
  domainEvents,
  gameAdminRequests,
  MIGRATIONS_FOLDER,
  odooCommandQueue,
  odooProjectionOutbox,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GameAdminCommandTerminalError,
  processNextOdooCommand,
  type GameAdminCommandHandler,
} from "./index.js";

const NOW = new Date("2026-08-25T16:00:00.000Z");
const WORLD = "44444444-4444-4444-8444-444444444444";
const FINAL_STATE_HASH = "a".repeat(64);
const EVIDENCE_HASH = "b".repeat(64);
const REPLAY_HASH = "c".repeat(64);
const ADMIN_REQUEST = "55555555-5555-4555-8555-555555555555";

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function enqueueWorldClose(eventId: string) {
  const [queued] = await db.insert(odooCommandQueue).values({
    eventId,
    worldId: WORLD,
    commandType: "admin.world_close",
    actorReference: "odoo-admin",
    payload: {
      kind: "admin.world_close",
      worldId: WORLD,
      actionType: "world_close",
      riskClass: "high",
      requesterReference: "requester-one",
      approverReference: "approver-two",
      reason: "Welt nach der letzten Fahrplanperiode kontrolliert abschliessen",
      effectPreview: { kind: "world-close" },
      requestedAtS: 2_419_200,
    },
    correlationId: `correlation-${eventId}`,
    status: "pending",
    receivedAt: NOW,
  }).returning();
  if (queued === undefined) throw new Error("World-close-Testkommando wurde nicht persistiert.");
  return queued;
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values({
    id: WORLD,
    name: "Atomare Abschlusswelt",
    schedulePeriodWeeks: 4,
    epoch: new Date("2026-07-27T00:00:00.000Z"),
  });
}, 30_000);

afterEach(async () => client.close());

describe("atomarer world_close-Worker", () => {
  it("rollt die Quittierung zurueck, wenn der Effekt nach dem Callback keinen Lifecycle-Seal schreibt", async () => {
    await db.insert(alphaWorldProfiles).values({
      worldId: WORLD,
      profileKind: "public",
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      worldSeed: 20260825n,
      accelerationFactor: 1,
      infraReleaseHash: "d".repeat(64),
      timetableReleaseHash: "e".repeat(64),
      fleetReleaseHash: "f".repeat(64),
      economyReleaseHash: "1".repeat(64),
      blueprint: { region: "B" },
      blueprintHash: "2".repeat(64),
      periodCount: 1,
      currentPeriod: 0,
      state: "archived",
      startedAtS: 0,
      closingAtS: 2_419_200,
      archivedAtS: 2_419_200,
      finalStateHash: FINAL_STATE_HASH,
    });
    const queued = await enqueueWorldClose("world-close-without-seal");
    const afterCommit = vi.fn();
    await db.insert(gameAdminRequests).values({
      id: ADMIN_REQUEST,
      worldId: WORLD,
      commandId: queued.id,
      actionType: "world_close",
      riskClass: "high",
      requesterReference: "requester-one",
      approverReference: "approver-two",
      reason: "Welt nach der letzten Fahrplanperiode kontrolliert abschliessen",
      effectPreview: { kind: "world-close" },
      state: "approved",
      correlationId: queued.correlationId,
      changedAt: NOW,
    });
    await db.insert(domainEvents).values({
      worldId: WORLD,
      sequence: 1,
      eventType: "alpha.world-archived",
      payload: {
        adminRequestId: ADMIN_REQUEST,
        finalStateHash: FINAL_STATE_HASH,
        evidenceHash: EVIDENCE_HASH,
        replayHash: REPLAY_HASH,
      },
      occurredAt: NOW,
    });

    const handler: GameAdminCommandHandler = ({ payload }) => ({
      atomicEffect: {
        kind: "world-close/v1",
        worldId: payload.worldId,
        afterCommit,
        execute: async (_tx, finalizeBeforeSeal) => {
          await finalizeBeforeSeal({
            state: "completed",
            gameAuditEventId: `world-close:${WORLD}:${FINAL_STATE_HASH}`,
            result: {
              finalStateHash: FINAL_STATE_HASH,
              evidenceHash: EVIDENCE_HASH,
              replayHash: REPLAY_HASH,
              archivedAtS: 2_419_200,
            },
          });
          // Absichtlich kein Update von worlds.lifecycle_status: Genau dieser
          // fehlerhafte Effekt darf niemals als erfolgreicher Seal committen.
        },
      },
    });

    await expect(processNextOdooCommand(db, NOW, {
      adminHandlers: { world_close: handler },
    })).rejects.toThrow(/nicht dauerhaft archiviert/u);

    const [world] = await db.select().from(worlds).where(eq(worlds.id, WORLD));
    const [queue] = await db.select().from(odooCommandQueue);
    const [request] = await db.select().from(gameAdminRequests);
    expect(world?.lifecycleStatus).toBe("active");
    expect(queue).toMatchObject({ status: "pending", claimToken: null, claimExpiresAt: null, failureCode: null });
    expect(request).toMatchObject({ state: "approved", gameAuditEventId: null });
    expect(await db.select().from(domainEvents)).toEqual([
      expect.objectContaining({ sequence: 1, eventType: "alpha.world-archived" }),
    ]);
    expect(await db.select().from(odooProjectionOutbox)).toHaveLength(0);
    expect(afterCommit).not.toHaveBeenCalled();
  }, 30_000);

  it("setzt einen bereits committeten Seal bei einem nachgelagerten Cleanup-Fehler niemals zurueck", async () => {
    await db.insert(alphaWorldProfiles).values({
      worldId: WORLD,
      profileKind: "public",
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      worldSeed: 20260825n,
      accelerationFactor: 1,
      infraReleaseHash: "d".repeat(64),
      timetableReleaseHash: "e".repeat(64),
      fleetReleaseHash: "f".repeat(64),
      economyReleaseHash: "1".repeat(64),
      blueprint: { region: "B" },
      blueprintHash: "2".repeat(64),
      periodCount: 1,
      currentPeriod: 0,
      state: "archived",
      startedAtS: 0,
      closingAtS: 2_419_200,
      archivedAtS: 2_419_200,
      finalStateHash: FINAL_STATE_HASH,
    });
    const queued = await enqueueWorldClose("world-close-after-commit-cleanup-failure");
    await db.insert(gameAdminRequests).values({
      id: ADMIN_REQUEST,
      worldId: WORLD,
      commandId: queued.id,
      actionType: "world_close",
      riskClass: "high",
      requesterReference: "requester-one",
      approverReference: "approver-two",
      reason: "Welt nach der letzten Fahrplanperiode kontrolliert abschliessen",
      effectPreview: { kind: "world-close" },
      state: "approved",
      correlationId: queued.correlationId,
      changedAt: NOW,
    });
    await db.insert(domainEvents).values({
      worldId: WORLD,
      sequence: 1,
      eventType: "alpha.world-archived",
      payload: {
        adminRequestId: ADMIN_REQUEST,
        finalStateHash: FINAL_STATE_HASH,
        evidenceHash: EVIDENCE_HASH,
        replayHash: REPLAY_HASH,
      },
      occurredAt: NOW,
    });
    const afterCommit = vi.fn(async () => { throw new Error("prozesslokaler Cleanup fehlgeschlagen"); });
    const handler: GameAdminCommandHandler = ({ payload }) => ({
      atomicEffect: {
        kind: "world-close/v1",
        worldId: payload.worldId,
        afterCommit,
        execute: async (tx, finalizeBeforeSeal) => {
          await finalizeBeforeSeal({
            state: "completed",
            gameAuditEventId: `world-close:${WORLD}:${FINAL_STATE_HASH}`,
            result: {
              finalStateHash: FINAL_STATE_HASH,
              evidenceHash: EVIDENCE_HASH,
              replayHash: REPLAY_HASH,
              archivedAtS: 2_419_200,
            },
          });
          await tx.update(worlds).set({ lifecycleStatus: "archived" }).where(eq(worlds.id, WORLD));
        },
      },
    });

    await expect(processNextOdooCommand(db, NOW, {
      adminHandlers: { world_close: handler },
    })).rejects.toThrow(/prozesslokaler Cleanup fehlgeschlagen/u);

    expect(afterCommit).toHaveBeenCalledOnce();
    await expect(db.select({ lifecycleStatus: worlds.lifecycleStatus }).from(worlds))
      .resolves.toEqual([{ lifecycleStatus: "archived" }]);
    await expect(db.select({ status: odooCommandQueue.status }).from(odooCommandQueue))
      .resolves.toEqual([{ status: "completed" }]);
    await expect(db.select({ state: gameAdminRequests.state }).from(gameAdminRequests))
      .resolves.toEqual([{ state: "completed" }]);
  }, 30_000);

  it("verewigt nur eine explizit typisierte fachliche Ablehnung terminal", async () => {
    await enqueueWorldClose("world-close-terminal-domain-error");
    const handler: GameAdminCommandHandler = ({ payload }) => ({
      atomicEffect: {
        kind: "world-close/v1",
        worldId: payload.worldId,
        execute: async () => {
          throw new GameAdminCommandTerminalError(
            "alpha_forbidden",
            "Die Vier-Augen-Autorisierung stimmt nicht mit dem Abschluss ueberein.",
          );
        },
      },
    });

    await expect(processNextOdooCommand(db, NOW, {
      adminHandlers: { world_close: handler },
    })).resolves.toMatchObject({ outcome: "rejected", code: "alpha_forbidden" });

    const [queue] = await db.select().from(odooCommandQueue);
    const [request] = await db.select().from(gameAdminRequests);
    const [audit] = await db.select().from(domainEvents);
    const [result] = await db.select().from(odooProjectionOutbox);
    expect(queue).toMatchObject({ status: "rejected", failureCode: "alpha_forbidden", claimToken: null });
    expect(request).toMatchObject({ state: "failed", gameAuditEventId: audit?.id });
    expect(audit).toMatchObject({ eventType: "admin.action-audited", payload: expect.objectContaining({ failureCode: "alpha_forbidden" }) });
    expect(result).toMatchObject({ worldId: WORLD, messageType: "admin.command.result" });
    expect(result?.payload).toMatchObject({ outcome: "rejected", failureCode: "alpha_forbidden", authoritative: true });
  }, 30_000);
});
