import { PGlite } from "@electric-sql/pglite";
import {
  ALPHA_WORLD_BLUEPRINT_SCHEMA,
  PUBLIC_ENTRY_FACILITY_SCHEMA,
  validateWorldBlueprint,
  type AlphaWorldBlueprint,
} from "@zugfolge/alpha";
import { MIGRATIONS_FOLDER, accounts, alphaWorldProfiles, worldAccesses, worldParticipations, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { encodeEconomyValue } from "@zugfolge/economy";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorldParticipationHandler } from "./odoo-world-participation.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const OTHER_WORLD = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-13T06:00:00Z");
const HASH = "a".repeat(64);
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

function blueprint(capacity = 1): AlphaWorldBlueprint {
  return {
    schemaVersion: ALPHA_WORLD_BLUEPRINT_SCHEMA,
    regionId: "mitteldeutschland-b",
    regionVariant: "B",
    seed: 1n,
    profileKind: "public",
    accelerationFactor: 1,
    periodCount: 2,
    startingCapitalPolicy: { mode: "finite", amountCents: "0" },
    entryFacilityPolicy: {
      schemaVersion: PUBLIC_ENTRY_FACILITY_SCHEMA,
      mode: "award-contingent-wet-lease",
      providerOperatorId: "public",
      costBasis: "formation-operating-cost",
    },
    releases: { infra: HASH, timetable: HASH, fleet: HASH, economy: HASH },
    lots: [{
      lotId: "lot-1",
      contractEndsAtPeriod: 1,
      trainRunIds: ["train-1"],
      pathReceiptIds: ["path-1"],
      vehicleIds: ["vehicle-1"],
      personnelDutyIds: ["duty-1"],
      circulationIds: ["circulation-1"],
      operatingProgramIds: ["program-1"],
    }],
    conflictCheckHash: HASH,
    tenderCalendarHash: HASH,
    activityPolicy: null,
    admission: { capacity, status: "open" },
    publicMetadata: {
      description: "Odoo-Teilnahmetest",
      phase: "active",
      startsAt: NOW.toISOString(),
      endsAt: null,
      regionLabel: "Leipzig-Halle-Erfurt",
      ruleRelease: "test-v1",
      banner: {
        altText: "Teststrecke",
        source: "Zugfolge-Test",
        author: "Zugfolge-Test",
        license: "Eigenes Werk",
        attribution: null,
        focalPointXPermille: 500,
        focalPointYPermille: 500,
        rightsApproved: true,
      },
    },
  };
}

function context(subject: string, idempotencyKey: string, action: "provision" | "cancel" | "refund" = "provision") {
  return {
    commandId: `${subject}-${action}`, eventId: `${subject}-${action}-event`, correlationId: `${subject}-${action}-correlation`,
    receivedAt: NOW, now: NOW,
    payload: {
      kind: "world.participation.change" as const, schemaVersion: "zugfolge-world-participation/v1" as const, action,
      worldId: WORLD, keycloakSubject: subject, displayName: subject,
      odooPartnerReference: `partner-${subject}`, odooOrderReference: `order-${subject}`, paymentReference: `payment-${subject}`,
      idempotencyKey, requestedAt: NOW.toISOString(),
    },
  };
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values([
    { id: WORLD, name: "LHE", schedulePeriodWeeks: 4, epoch: NOW },
    { id: OTHER_WORLD, name: "Andere Welt", schedulePeriodWeeks: 4, epoch: NOW },
  ]);
  const worldBlueprint = blueprint();
  await db.insert(alphaWorldProfiles).values({
    worldId: WORLD, profileKind: "public", regionId: "mitteldeutschland-b", regionVariant: "B", worldSeed: 1n,
    accelerationFactor: 1, infraReleaseHash: HASH, timetableReleaseHash: HASH, fleetReleaseHash: HASH,
    economyReleaseHash: HASH,
    blueprint: encodeEconomyValue(worldBlueprint),
    blueprintHash: validateWorldBlueprint(worldBlueprint),
    periodCount: worldBlueprint.periodCount,
    state: "running",
  });
});
afterEach(async () => client.close());

describe("Game-autoritative Weltteilnahme", () => {
  it("provisioniert genau einmal und leitet keine Berechtigung aus Keycloak-Rollen ab", async () => {
    const handler = createWorldParticipationHandler(db);
    const first = await handler(context("kc-a", "payment-a:provision"));
    const replay = await handler(context("kc-a", "payment-a:provision"));
    expect(first).toMatchObject({ state: "active" });
    expect(replay).toMatchObject({ state: "active", participationId: first.participationId });
    expect(await db.select().from(worldParticipations)).toHaveLength(1);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(worldAccesses)).toHaveLength(1);
  });

  it("serialisiert die Kapazitaetspruefung und lehnt den zweiten Platz ab", async () => {
    const handler = createWorldParticipationHandler(db);
    expect(await handler(context("kc-a", "payment-a:provision"))).toMatchObject({ state: "active" });
    expect(await handler(context("kc-b", "payment-b:provision"))).toMatchObject({ state: "rejected", rejectionCode: "capacity_full" });
    expect(await db.select().from(accounts)).toHaveLength(1);
  });

  it("erstattet idempotent und entzieht nur die Weltmitgliedschaft", async () => {
    const handler = createWorldParticipationHandler(db);
    await handler(context("kc-a", "payment-a:provision"));
    expect(await handler(context("kc-a", "payment-a:refund", "refund"))).toMatchObject({ state: "refunded" });
    expect(await handler(context("kc-a", "payment-a:refund", "refund"))).toMatchObject({ state: "refunded" });
    const [access] = await db.select().from(worldAccesses).where(and(eq(worldAccesses.worldId, WORLD), eq(worldAccesses.keycloakSubject, "kc-a")));
    expect(access?.status).toBe("revoked");
  });

  it("vermischt unbekannte oder andere Welten nicht", async () => {
    const handler = createWorldParticipationHandler(db);
    const foreign = context("kc-a", "payment-a:provision");
    expect(await handler({ ...foreign, payload: { ...foreign.payload, worldId: OTHER_WORLD } })).toMatchObject({ state: "rejected", rejectionCode: "world_not_public" });
    expect(await db.select().from(worldParticipations)).toHaveLength(0);
  });
});
