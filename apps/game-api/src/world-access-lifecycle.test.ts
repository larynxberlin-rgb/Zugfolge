import { PGlite } from "@electric-sql/pglite";
import { validateWorldBlueprint, type AlphaWorldBlueprint } from "@zugfolge/alpha";
import {
  accounts,
  alphaWorldProfiles,
  MIGRATIONS_FOLDER,
  operators,
  tutorialSessions,
  worldAccesses,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { encodeEconomyValue } from "@zugfolge/economy";
import { requestWorldAccess, type AccountRecord } from "@zugfolge/identity";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { serverWorldScope } from "./server-world-scope.js";

const publicWorldId = "11111111-1111-4111-8111-111111111111";
const incompletePublicWorldId = "11111111-1111-4111-8111-111111111112";
const privateWorldId = "22222222-2222-4222-8222-222222222222";
const tutorialWorldId = "33333333-3333-4333-8333-333333333333";
const archivedWorldId = "44444444-4444-4444-8444-444444444444";
const unknownWorldId = "99999999-9999-4999-8999-999999999999";

function publicBlueprint(
  policy: AlphaWorldBlueprint["startingCapitalPolicy"] = { kind: "finite", amountCents: "0" },
): AlphaWorldBlueprint {
  return {
    schemaVersion: "zugfolge-alpha-world-blueprint/v1",
    regionId: "mitteldeutschland-b",
    regionVariant: "B",
    seed: 2n,
    profileKind: "public",
    accelerationFactor: 1,
    periodCount: null,
    startingCapitalPolicy: policy,
    releases: { infra: "1".repeat(64), timetable: "2".repeat(64), fleet: "3".repeat(64), economy: "4".repeat(64) },
    lots: [{
      lotId: "public-lot",
      contractEndsAtPeriod: 2,
      trainRunIds: ["public-train"],
      pathReceiptIds: ["public-path"],
      vehicleIds: ["public-vehicle"],
      personnelDutyIds: ["public-duty"],
      circulationIds: ["public-circulation"],
      operatingProgramIds: ["public-program"],
    }],
    conflictCheckHash: "5".repeat(64),
    tenderCalendarHash: "6".repeat(64),
  };
}

const PUBLIC_BLUEPRINT = publicBlueprint();
const PUBLIC_CONTRACT_HASH = validateWorldBlueprint(PUBLIC_BLUEPRINT);

describe("Weltzugang und zentraler Lebenszyklus-Schreibschutz", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;
  let privateOwner: AccountRecord;
  let tutorialOwner: AccountRecord;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([
      { id: publicWorldId, name: "Oeffentliche Welt", schedulePeriodWeeks: 4, epoch: new Date(0) },
      { id: incompletePublicWorldId, name: "Unvollstaendige oeffentliche Welt", schedulePeriodWeeks: 4, epoch: new Date(0) },
      { id: privateWorldId, name: "Private Welt", schedulePeriodWeeks: 4, epoch: new Date(0), worldKind: "private", rankingStatus: "unranked" },
      { id: tutorialWorldId, name: "Tutorialwelt", schedulePeriodWeeks: 4, epoch: new Date(0), worldKind: "private", rankingStatus: "unranked" },
      { id: archivedWorldId, name: "Archiv", schedulePeriodWeeks: 4, epoch: new Date(0) },
    ]);

    const publicOwner = await requestWorldAccess(db, {
      worldId: publicWorldId,
      keycloakSubject: "tutorial-owner",
      displayName: "Tutorial Owner",
    });
    privateOwner = await requestWorldAccess(db, {
      worldId: privateWorldId,
      keycloakSubject: "private-owner",
      displayName: "Private Owner",
    });
    tutorialOwner = await requestWorldAccess(db, {
      worldId: tutorialWorldId,
      keycloakSubject: "tutorial-owner",
      displayName: "Tutorial Owner",
    });
    await requestWorldAccess(db, {
      worldId: archivedWorldId,
      keycloakSubject: "archive-member",
      displayName: "Archive Member",
    });
    const [tutorialOperator] = await db.insert(operators).values({
      worldId: tutorialWorldId,
      foundingAccountId: tutorialOwner.id,
      name: "Tutorial-EVU",
    }).returning();
    if (tutorialOperator === undefined) throw new Error("Tutorial-EVU fehlt.");
    await db.insert(alphaWorldProfiles).values({
      worldId: publicWorldId,
      profileKind: "public",
      regionId: PUBLIC_BLUEPRINT.regionId,
      regionVariant: "B",
      worldSeed: 2n,
      accelerationFactor: 1,
      infraReleaseHash: "1".repeat(64),
      timetableReleaseHash: "2".repeat(64),
      fleetReleaseHash: "3".repeat(64),
      economyReleaseHash: "4".repeat(64),
      blueprint: encodeEconomyValue(PUBLIC_BLUEPRINT),
      blueprintHash: PUBLIC_CONTRACT_HASH,
      periodCount: null,
      state: "running",
    });
    await db.insert(alphaWorldProfiles).values({
      worldId: tutorialWorldId,
      profileKind: "tutorial",
      regionId: "lhe-tutorial",
      regionVariant: "tutorial-minimal",
      worldSeed: 1n,
      accelerationFactor: 20,
      infraReleaseHash: "a".repeat(64),
      timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64),
      blueprint: { schemaVersion: "test/v1" },
      blueprintHash: "e".repeat(64),
      periodCount: 1,
      state: "running",
    });
    const now = new Date("2026-08-13T12:00:00.000Z");
    await db.insert(tutorialSessions).values({
      reference: "tut_aaaaaaaaaaaaaaaaaaaa",
      publicWorldId,
      publicAccountId: publicOwner.id,
      tutorialWorldId,
      tutorialAccountId: tutorialOwner.id,
      tutorialOperatorId: tutorialOperator.id,
      templateVersion: "test-v1",
      templateHash: "f".repeat(64),
      lifecycle: "running",
      provisioningStep: "ready",
      scenarioState: {},
      correctionAttempts: {},
      hintsUsed: {},
      startedAt: now,
      lastActivityAt: now,
      idleExpiresAt: new Date("2026-08-13T12:15:00.000Z"),
      maximumExpiresAt: new Date("2026-08-13T12:15:00.000Z"),
    });
    await db.update(worlds)
      .set({ lifecycleStatus: "archived" })
      .where(eq(worlds.id, archivedWorldId));

    app = buildApp({
      db,
      verifyToken: async (token) => ({ keycloakSubject: token, displayName: token }),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    await client.close();
  });

  async function requestAccess(worldId: string, subject: string, acceptedWorldContractHash?: string) {
    return app.inject({
      method: "POST",
      url: `/worlds/${worldId}/access`,
      headers: { authorization: `Bearer ${subject}` },
      payload: {
        displayName: subject,
        ...(acceptedWorldContractHash === undefined ? {} : { acceptedWorldContractHash }),
      },
    });
  }

  it("provisioniert oder bestaetigt ueber die oeffentliche Route niemals private Konten", async () => {
    const denied = await requestAccess(privateWorldId, "attacker");
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "private_world_access_managed" });
    expect(await db.select().from(accounts).where(and(
      eq(accounts.worldId, privateWorldId),
      eq(accounts.keycloakSubject, "attacker"),
    ))).toHaveLength(0);
    expect(await db.select().from(worldAccesses).where(and(
      eq(worldAccesses.worldId, privateWorldId),
      eq(worldAccesses.keycloakSubject, "attacker"),
    ))).toHaveLength(0);

    const existing = await requestAccess(privateWorldId, "private-owner");
    expect(existing.statusCode).toBe(403);
    expect(existing.json()).toMatchObject({ code: "private_world_access_managed" });
    expect(await db.select().from(accounts).where(eq(accounts.id, privateOwner.id))).toHaveLength(1);
  });

  it("bindet Tutorialzugang ausschliesslich an die serverseitige Sitzung", async () => {
    const owner = await requestAccess(tutorialWorldId, "tutorial-owner");
    const foreign = await requestAccess(tutorialWorldId, "attacker");
    expect(owner.statusCode).toBe(403);
    expect(owner.json()).toMatchObject({ code: "tutorial_session_required" });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: "tutorial_session_required" });
    expect(tutorialOwner.worldId).toBe(tutorialWorldId);
  });

  it("erlaubt unter der kanonischen Hauptwelt-Subdomain nur die eigene Tutorialinstanz", async () => {
    await app.close();
    app = buildApp({
      db,
      verifyToken: async (token) => ({ keycloakSubject: token, displayName: token }),
      worldScope: serverWorldScope(publicWorldId, "https://world.zugfolge.de"),
      logger: false,
    });
    const headers = { host: "world.zugfolge.de", authorization: "Bearer tutorial-owner" };
    const tutorial = await app.inject({ method: "GET", url: `/worlds/${tutorialWorldId}/operators`, headers });
    expect(tutorial.statusCode).toBe(200);
    const foreign = await app.inject({ method: "GET", url: `/worlds/${privateWorldId}/operators`, headers });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: "world_not_found" });
    const foreignHost = await app.inject({ method: "GET", url: `/worlds/${tutorialWorldId}/operators`, headers: { ...headers, host: "other.zugfolge.de", "x-forwarded-host": "world.zugfolge.de" } });
    expect(foreignHost.statusCode).toBe(421);
    const otherPublicAccount = await requestWorldAccess(db, { worldId: incompletePublicWorldId, keycloakSubject: "tutorial-owner", displayName: "Tutorial Owner" });
    await db.update(tutorialSessions).set({ publicWorldId: incompletePublicWorldId, publicAccountId: otherPublicAccount.id }).where(eq(tutorialSessions.tutorialWorldId, tutorialWorldId));
    const unbound = await app.inject({ method: "GET", url: `/worlds/${tutorialWorldId}/operators`, headers });
    expect(unbound.statusCode).toBe(404);
    expect(unbound.json()).toMatchObject({ code: "world_not_found" });
  });

  it("verlangt den exakten, gueltigen Weltvertrag vor oeffentlichem Markteintritt", async () => {
    const incomplete = await requestAccess(incompletePublicWorldId, "contract-bypass-attempt");
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json()).toMatchObject({ code: "world_contract_invalid" });
    expect(await db.select().from(accounts).where(and(
      eq(accounts.worldId, incompletePublicWorldId),
      eq(accounts.keycloakSubject, "contract-bypass-attempt"),
    ))).toHaveLength(0);

    const missing = await requestAccess(publicWorldId, "new-public-member");
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({
      code: "world_contract_confirmation_required",
      contractHash: PUBLIC_CONTRACT_HASH,
    });
    const stale = await requestAccess(publicWorldId, "new-public-member", "stale-contract");
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "world_contract_confirmation_required" });
    expect(await db.select().from(accounts).where(and(
      eq(accounts.worldId, publicWorldId),
      eq(accounts.keycloakSubject, "new-public-member"),
    ))).toHaveLength(0);

    const accepted = await requestAccess(publicWorldId, "new-public-member", PUBLIC_CONTRACT_HASH);
    expect(accepted.statusCode).toBe(201);

    await expect(db.update(alphaWorldProfiles).set({
      blueprint: encodeEconomyValue({ ...PUBLIC_BLUEPRINT, startingCapitalPolicy: { kind: "finite", amountCents: "9223372036854775808" } }),
      blueprintHash: "2".repeat(64),
    }).where(eq(alphaWorldProfiles.worldId, publicWorldId))).rejects.toThrow();

    for (const [policy, subject] of [
      [{ kind: "finite", amountCents: "100000" }, "nonzero-policy-member"],
      [{ kind: "unlimited" }, "unlimited-policy-member"],
    ] as const) {
      const changed = publicBlueprint(policy);
      const hash = validateWorldBlueprint(changed);
      await expect(db.update(alphaWorldProfiles).set({
        blueprint: encodeEconomyValue(changed),
        blueprintHash: hash,
      }).where(eq(alphaWorldProfiles.worldId, publicWorldId))).rejects.toThrow();
      expect(await db.select().from(accounts).where(and(
        eq(accounts.worldId, publicWorldId),
        eq(accounts.keycloakSubject, subject),
      ))).toHaveLength(0);
    }

    const changedContractFounding = await app.inject({
      method: "POST",
      url: `/worlds/${publicWorldId}/operators`,
      headers: { authorization: "Bearer new-public-member" },
      payload: { name: "Stale Vertragsbahn" },
    });
    expect(changedContractFounding.statusCode).toBe(201);
  });

  it("laesst in archivierten Welten weder Zugang noch Fachmutation zu, aber weiterhin Reads", async () => {
    const access = await requestAccess(archivedWorldId, "new-member");
    expect(access.statusCode).toBe(409);
    expect(access.json()).toMatchObject({ code: "world_not_active" });

    const mutation = await app.inject({
      method: "POST",
      url: `/worlds/${archivedWorldId}/operators`,
      headers: { authorization: "Bearer archive-member" },
      payload: { name: "Darf nicht entstehen" },
    });
    expect(mutation.statusCode).toBe(409);
    expect(mutation.json()).toMatchObject({ code: "world_not_active" });
    expect(await db.select().from(operators).where(eq(operators.worldId, archivedWorldId))).toHaveLength(0);

    const read = await app.inject({
      method: "GET",
      url: `/worlds/${archivedWorldId}/operators`,
      headers: { authorization: "Bearer archive-member" },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual([]);

    const unknown = await requestAccess(unknownWorldId, "archive-member");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "world_not_found" });
    const anonymousUnknown = await app.inject({
      method: "POST",
      url: `/worlds/${unknownWorldId}/access`,
      payload: { displayName: "anonymous" },
    });
    expect(anonymousUnknown.statusCode).toBe(401);
  });
});
