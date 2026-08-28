import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER } from "./migrations.js";
import { alphaWorldProfiles } from "./schema/alpha.js";
import {
  gameAdminRequests,
  globalAdminAuditEvents,
  odooCommandQueue,
  odooProjectionOutbox,
} from "./schema/commerce.js";
import { domainEvents } from "./schema/domain-events.js";
import { worlds } from "./schema/worlds.js";
import * as schema from "./schema/index.js";

const UNKNOWN_WORLD = "77777777-7777-4777-8777-777777777777";
const CLOSE_WORLD = "66666666-6666-4666-8666-666666666666";
const GLOBAL_SCOPE = "00000000-0000-0000-0000-000000000000";
const NOW = new Date("2026-08-12T10:00:00.000Z");

function queue(commandType: string, worldId: string | null = UNKNOWN_WORLD) {
  return {
    eventId: `event-${commandType}-${worldId ?? "global"}`,
    worldId,
    commandType,
    actorReference: "odoo-admin",
    payload: {},
    correlationId: `correlation-${commandType}-${worldId ?? "global"}`,
    status: "pending" as const,
    receivedAt: NOW,
  };
}

function outbox(worldId: string, messageType: string, correlationId: string, payload: Record<string, unknown>) {
  return {
    worldId,
    messageType,
    schemaVersion: "zugfolge-odoo/v1",
    correlationId,
    payload,
    occurredAt: NOW,
    enqueuedAt: NOW,
  };
}

describe("Migration 0023 pre-world Odoo-DB-Grenzen", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterEach(async () => client.close());

  it("erlaubt eine unbekannte Zielwelt nur fuer world_deploy in der Queue", async () => {
    await expect(db.insert(odooCommandQueue).values(queue("admin.world_close"))).rejects.toThrow();
    await expect(db.insert(odooCommandQueue).values(queue("entitlement.change"))).rejects.toThrow();
    await expect(db.insert(odooCommandQueue).values(queue("entitlement.change", null))).resolves.toBeDefined();
    await expect(db.insert(odooCommandQueue).values(queue("admin.world_deploy"))).resolves.toBeDefined();
  });

  it("erlaubt ausserhalb bestehender Welten nur globale Capability oder atomar auditiertes Deploy-Ergebnis", async () => {
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      UNKNOWN_WORLD,
      "world.projection",
      "orphan-world",
      {},
    ))).rejects.toThrow();
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      GLOBAL_SCOPE,
      "admin.capability.projection",
      "global-capability",
      { actionType: "world_deploy", availability: "available" },
    ))).resolves.toBeDefined();
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      UNKNOWN_WORLD,
      "admin.command.result",
      "deploy-rejected",
      { outcome: "rejected", authoritative: true },
    ))).rejects.toThrow();

    const [command] = await db.insert(odooCommandQueue).values({
      ...queue("admin.world_deploy"),
      eventId: "deploy-rejected-event",
      correlationId: "deploy-rejected",
    }).returning({ id: odooCommandQueue.id });
    await expect(db.insert(globalAdminAuditEvents).values({
      targetWorldId: "88888888-8888-4888-8888-888888888888",
      commandId: command!.id,
      correlationId: "deploy-rejected",
      actionType: "world_deploy",
      outcome: "rejected",
      failureCode: "Error",
      occurredAt: NOW,
    })).rejects.toThrow();
    const [audit] = await db.insert(globalAdminAuditEvents).values({
      targetWorldId: UNKNOWN_WORLD,
      commandId: command!.id,
      correlationId: "deploy-rejected",
      actionType: "world_deploy",
      outcome: "rejected",
      failureCode: "Error",
      occurredAt: NOW,
    }).returning({ id: globalAdminAuditEvents.id });
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      UNKNOWN_WORLD,
      "admin.command.result",
      "deploy-rejected",
      {
        outcome: "rejected",
        authoritative: true,
        auditScope: "global",
        gameAuditEventId: `global-admin-audit:${audit!.id}`,
      },
    ))).resolves.toBeDefined();
  });

  it("erlaubt global-admin world_close nur mit exakt abgeschlossener Zielwelt- und Auditbindung", async () => {
    await db.insert(worlds).values([
      {
        id: CLOSE_WORLD,
        name: "Abgeschlossene Zielwelt",
        schedulePeriodWeeks: 4,
        epoch: NOW,
        worldKind: "public",
        rankingStatus: "ranked",
        lifecycleStatus: "active",
      },
      {
        // Der reservierte Projektionsscope darf selbst dann keine generische
        // Welt-Ausnahme erhalten, wenn ein Altzustand diese UUID als Welt
        // enthaelt.
        id: GLOBAL_SCOPE,
        name: "Unzulaessige Sentinel-Welt",
        schedulePeriodWeeks: 4,
        epoch: NOW,
        worldKind: "private",
        rankingStatus: "unranked",
        lifecycleStatus: "active",
      },
    ]);
    await db.insert(alphaWorldProfiles).values({
      worldId: CLOSE_WORLD,
      profileKind: "public",
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      worldSeed: 1n,
      accelerationFactor: 1,
      infraReleaseHash: "a".repeat(64),
      timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64),
      blueprint: { region: "B" },
      blueprintHash: "e".repeat(64),
      periodCount: 1,
      currentPeriod: 0,
      state: "archived",
      startedAtS: 0,
      closingAtS: 10,
      archivedAtS: 10,
      finalStateHash: "f".repeat(64),
    });
    const correlationId = "world-close-global-result";
    const [command] = await db.insert(odooCommandQueue).values({
      eventId: "world-close-global-result-event",
      worldId: CLOSE_WORLD,
      commandType: "admin.world_close",
      actorReference: "odoo-admin",
      payload: {
        kind: "admin.world_close",
        actionType: "world_close",
        riskClass: "high",
        worldId: CLOSE_WORLD,
        requestedAtS: 10,
      },
      correlationId,
      status: "completed",
      receivedAt: NOW,
      processedAt: NOW,
    }).returning({ id: odooCommandQueue.id });
    const [adminRequest] = await db.insert(gameAdminRequests).values({
      worldId: CLOSE_WORLD,
      commandId: command!.id,
      actionType: "world_close",
      riskClass: "high",
      requesterReference: "requester",
      approverReference: "approver",
      reason: "Vier-Augen-Weltabschluss",
      effectPreview: {},
      state: "completed",
      correlationId,
      changedAt: NOW,
    }).returning({ id: gameAdminRequests.id });
    await db.insert(domainEvents).values({
      worldId: CLOSE_WORLD,
      sequence: 1,
      eventType: "alpha.world-archived",
      payload: {
        adminRequestId: adminRequest!.id,
        finalStateHash: "f".repeat(64),
        evidenceHash: "a".repeat(64),
        replayHash: "b".repeat(64),
      },
      occurredAt: NOW,
    });
    const [audit] = await db.insert(domainEvents).values({
      worldId: CLOSE_WORLD,
      sequence: 2,
      eventType: "admin.action-audited",
      payload: {
        adminRequestId: adminRequest!.id,
        actionType: "world_close",
        correlationId,
        outcome: "completed",
      },
      occurredAt: NOW,
    }).returning({ id: domainEvents.id });
    await db.update(gameAdminRequests).set({ gameAuditEventId: audit!.id })
      .where(eq(gameAdminRequests.id, adminRequest!.id));

    const exactPayload = {
      finalStateHash: "f".repeat(64),
      evidenceHash: "a".repeat(64),
      replayHash: "b".repeat(64),
      archivedAtS: 10,
      outcome: "accepted",
      state: "completed",
      authoritative: true,
      projectionScope: "global-admin",
      actionType: "world_close",
      targetWorldId: CLOSE_WORLD,
      adminRequestId: adminRequest!.id,
      gameAuditEventId: audit!.id,
    };
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      GLOBAL_SCOPE,
      "admin.command.result",
      correlationId,
      { ...exactPayload, finalStateHash: "0".repeat(64) },
    ))).rejects.toThrow();
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      GLOBAL_SCOPE,
      "admin.command.result",
      correlationId,
      { ...exactPayload, evidenceHash: "0".repeat(64) },
    ))).rejects.toThrow();
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      GLOBAL_SCOPE,
      "admin.command.result",
      correlationId,
      { ...exactPayload, evidenceHash: "g".repeat(64) },
    ))).rejects.toThrow();
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      GLOBAL_SCOPE,
      "admin.command.result",
      correlationId,
      { ...exactPayload, replayHash: "0".repeat(64) },
    ))).rejects.toThrow();
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      GLOBAL_SCOPE,
      "admin.command.result",
      correlationId,
      { ...exactPayload, replayHash: "B".repeat(64) },
    ))).rejects.toThrow();
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      GLOBAL_SCOPE,
      "admin.command.result",
      correlationId,
      { ...exactPayload, archivedAtS: -1 },
    ))).rejects.toThrow();
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      GLOBAL_SCOPE,
      "admin.command.result",
      correlationId,
      { ...exactPayload, archivedAtS: "10" },
    ))).rejects.toThrow();
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      GLOBAL_SCOPE,
      "admin.command.result",
      correlationId,
      { ...exactPayload, adminRequestId: "55555555-5555-4555-8555-555555555555" },
    ))).rejects.toThrow();
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      GLOBAL_SCOPE,
      "admin.command.result",
      correlationId,
      { ...exactPayload, projectionScope: "world" },
    ))).rejects.toThrow();
    await expect(db.insert(odooProjectionOutbox).values(outbox(
      GLOBAL_SCOPE,
      "admin.command.result",
      correlationId,
      exactPayload,
    ))).resolves.toBeDefined();
  });

  it("haelt den signierten Weltentwurf nach dem Start unveraenderlich", async () => {
    await db.insert(worlds).values({
      id: UNKNOWN_WORLD,
      name: "Unveraenderliche Alpha-Welt",
      schedulePeriodWeeks: 4,
      epoch: NOW,
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
    });
    const originalBlueprint = {
      schemaVersion: "zugfolge-alpha-world-blueprint/v2",
      startingCapitalPolicy: { mode: "finite", amountCents: "0" },
    };
    await db.insert(alphaWorldProfiles).values({
      worldId: UNKNOWN_WORLD,
      profileKind: "public",
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      worldSeed: 1n,
      accelerationFactor: 1,
      infraReleaseHash: "a".repeat(64),
      timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64),
      blueprint: originalBlueprint,
      blueprintHash: "e".repeat(64),
      deploymentHash: null,
      periodCount: 6,
      state: "running",
      startedAtS: 0,
    });

    await expect(db.update(alphaWorldProfiles).set({ currentPeriod: 1 }))
      .resolves.toBeDefined();
    await expect(db.update(alphaWorldProfiles).set({ deploymentHash: "1".repeat(64) }))
      .resolves.toBeDefined();
    await expect(db.update(alphaWorldProfiles).set({
      blueprint: {
        ...originalBlueprint,
        startingCapitalPolicy: { mode: "unlimited" },
      },
      blueprintHash: "f".repeat(64),
    })).rejects.toThrow();
    await expect(db.update(alphaWorldProfiles).set({ deploymentHash: "2".repeat(64) }))
      .rejects.toThrow();
    await expect(db.update(alphaWorldProfiles).set({ state: "draft" }))
      .rejects.toThrow();
    await expect(db.delete(alphaWorldProfiles))
      .rejects.toThrow();
    await expect(db.select({
      blueprint: alphaWorldProfiles.blueprint,
      blueprintHash: alphaWorldProfiles.blueprintHash,
      deploymentHash: alphaWorldProfiles.deploymentHash,
      state: alphaWorldProfiles.state,
    }).from(alphaWorldProfiles)).resolves.toEqual([{
      blueprint: originalBlueprint,
      blueprintHash: "e".repeat(64),
      deploymentHash: "1".repeat(64),
      state: "running",
    }]);
  });
});
