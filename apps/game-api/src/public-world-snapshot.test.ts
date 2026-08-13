import { PGlite } from "@electric-sql/pglite";
import {
  MIGRATIONS_FOLDER,
  accounts,
  alphaWorldProfiles,
  domainEvents,
  operators,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { encodeEconomyValue } from "@zugfolge/economy";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPublicWorldSnapshot } from "./public-world-snapshot.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const OTHER_WORLD = "22222222-2222-4222-8222-222222222222";
const EPOCH = new Date("2026-01-01T00:00:00Z");
const HASH = "a".repeat(64);
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

function blueprint(activityPolicy: Record<string, unknown> | null) {
  return encodeEconomyValue({
    schemaVersion: "zugfolge-alpha-world-blueprint/v2",
    startingCapitalPolicy: { mode: "finite", amountCents: "0" },
    activityPolicy,
    admission: { capacity: 5, status: "open" },
    releases: { infra: HASH, timetable: HASH, fleet: HASH, economy: HASH },
    publicMetadata: {
      description: "Persistente Welt", phase: "active", startsAt: EPOCH.toISOString(),
      endsAt: "2026-01-01T01:00:00.000Z", regionLabel: "Leipzig–Halle–Erfurt", ruleRelease: "alpha-2026",
      banner: {
        altText: "Bahnstrecke", source: "Zugfolge", author: "Zugfolge", license: "Eigenes Werk",
        attribution: null, focalPointXPermille: 500, focalPointYPermille: 500, rightsApproved: true,
      },
    },
  });
}

async function profile(worldId: string, activityPolicy: Record<string, unknown> | null) {
  await db.insert(alphaWorldProfiles).values({
    worldId, profileKind: "public", regionId: "mitteldeutschland-b", regionVariant: "B", worldSeed: 1n,
    accelerationFactor: 1, infraReleaseHash: HASH, timetableReleaseHash: HASH, fleetReleaseHash: HASH,
    economyReleaseHash: HASH, blueprint: blueprint(activityPolicy), blueprintHash: HASH, periodCount: 2, state: "running",
  });
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values([
    { id: WORLD, name: "Leipzig–Halle–Erfurt", schedulePeriodWeeks: 4, epoch: EPOCH },
    { id: OTHER_WORLD, name: "Andere Welt", schedulePeriodWeeks: 4, epoch: EPOCH },
  ]);
});

afterEach(async () => client.close());

describe("oeffentlicher Game-zu-Odoo-Weltsnapshot", () => {
  it("publiziert bei nicht freigegebener ActivityPolicy ausdruecklich keine Aktivitaetszahl", async () => {
    await profile(WORLD, null);
    const snapshot = await buildPublicWorldSnapshot(db, {
      worldId: WORLD, authoritativeNowS: 1_000, generatedAt: new Date("2026-08-13T06:00:00Z"),
    });
    expect(snapshot.startingCapitalPolicy).toEqual({ mode: "finite", amountCents: "0" });
    expect(snapshot.activityPolicyStatus).toBe("unconfigured");
    expect(snapshot.stronglyActiveOperators).toBeNull();
    expect(snapshot.remainingRuntimeSeconds).toBe(2_600);
  });

  it("zaehlt deterministisch nur aktive Spieler-EVU und nur autoritative Ereignisse derselben Welt", async () => {
    await profile(WORLD, {
      schemaVersion: "zugfolge-activity-policy/v1", windowSeconds: 100, minimumScore: 3,
      weights: { "operations.train-outcome": 2, "economy.settlement": 1 },
    });
    await profile(OTHER_WORLD, null);
    const accountRows = await db.insert(accounts).values([
      { worldId: WORLD, keycloakSubject: "player-a", displayName: "A" },
      { worldId: WORLD, keycloakSubject: "player-b", displayName: "B" },
      { worldId: WORLD, keycloakSubject: "bot", displayName: "Bot" },
      { worldId: WORLD, keycloakSubject: "exited", displayName: "Ausgeschieden" },
      { worldId: OTHER_WORLD, keycloakSubject: "foreign", displayName: "Fremd" },
    ]).returning({ id: accounts.id, worldId: accounts.worldId, subject: accounts.keycloakSubject });
    const account = (worldId: string, subject: string) => accountRows.find((row) => row.worldId === worldId && row.subject === subject)!.id;
    const operatorRows = await db.insert(operators).values([
      { worldId: WORLD, foundingAccountId: account(WORLD, "player-a"), name: "EVU A" },
      { worldId: WORLD, foundingAccountId: account(WORLD, "player-b"), name: "EVU B" },
      { worldId: WORLD, foundingAccountId: account(WORLD, "bot"), name: "Bot-EVU", operatorKind: "bot" },
      { worldId: WORLD, foundingAccountId: account(WORLD, "exited"), name: "Altes EVU", lifecycle: "exited" },
      { worldId: OTHER_WORLD, foundingAccountId: account(OTHER_WORLD, "foreign"), name: "Fremdes EVU" },
    ]).returning({ id: operators.id, worldId: operators.worldId, name: operators.name });
    const operator = (worldId: string, name: string) => operatorRows.find((row) => row.worldId === worldId && row.name === name)!.id;
    const eventAt = new Date(EPOCH.getTime() + 950_000);
    await db.insert(domainEvents).values([
      { worldId: WORLD, sequence: 1, eventType: "operations.train-outcome", payload: { operatorId: operator(WORLD, "EVU A") }, occurredAt: eventAt },
      { worldId: WORLD, sequence: 2, eventType: "economy.settlement", payload: { operatorId: operator(WORLD, "EVU A") }, occurredAt: eventAt },
      { worldId: WORLD, sequence: 3, eventType: "identity.login", payload: { operatorId: operator(WORLD, "EVU B") }, occurredAt: eventAt },
      { worldId: WORLD, sequence: 4, eventType: "operations.train-outcome", payload: { operatorId: operator(WORLD, "Bot-EVU") }, occurredAt: eventAt },
      { worldId: WORLD, sequence: 5, eventType: "operations.train-outcome", payload: { operatorId: operator(WORLD, "Altes EVU") }, occurredAt: eventAt },
      { worldId: OTHER_WORLD, sequence: 1, eventType: "operations.train-outcome", payload: { operatorId: operator(OTHER_WORLD, "Fremdes EVU") }, occurredAt: eventAt },
    ]);
    const snapshot = await buildPublicWorldSnapshot(db, {
      worldId: WORLD, authoritativeNowS: 1_000, generatedAt: new Date("2026-08-13T06:00:00Z"),
    });
    expect(snapshot.totalOperators).toBe(3);
    expect(snapshot.stronglyActiveOperators).toBe(1);
    expect(snapshot.activityPolicyStatus).toBe("configured");
    expect(JSON.stringify(snapshot)).not.toMatch(/player-a|player-b|operatorId|keycloak/i);
    expect(await db.select().from(operators).where(eq(operators.worldId, OTHER_WORLD))).toHaveLength(1);
  });
});
