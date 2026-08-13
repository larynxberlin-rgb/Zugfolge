import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER } from "./migrations.js";
import { alphaWorldProfiles } from "./schema/alpha.js";
import {
  globalAdminAuditEvents,
  odooCommandQueue,
  odooProjectionOutbox,
} from "./schema/commerce.js";
import { worlds } from "./schema/worlds.js";
import * as schema from "./schema/index.js";

const UNKNOWN_WORLD = "77777777-7777-4777-8777-777777777777";
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
