import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createOdooWebhookReceiptStore, processNextOdooCommand, signPayload, type AdminCommandPayload, type GameAdminCommandContext, type OdooWebhookEnvelope } from "@zugfolge/commerce";
import { accounts, accountRoles, disruptionPolicies, domainEvents, MIGRATIONS_FOLDER, odooProjectionOutbox, worldAccesses, worlds, type Database } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { loadOperationalSimulationRuntime, OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV, type OperationalDailyRestrictionsGenerated, type OperationalDailyRestrictionsRequest } from "@zugfolge/runtime-native";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createDailyRestrictionPolicyLoader, DailyRestrictionCommandCatalog, type DailyRestrictionWorldSource } from "./daily-restriction-catalog.js";
import { createDisruptionPolicyAdminHandler } from "./disruption-policy-admin.js";
import { TEST_INFRASTRUCTURE_BINDING } from "./operational-infrastructure.fixture.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EPOCH = new Date("2026-08-03T00:00:00.000Z");
const NOW = new Date("2026-08-11T12:00:00.000Z");
const BOUNDARY = 28 * 86_400_000;
const KEY = { id: "policy-test", secret: "policy-test-secret", activeFrom: new Date(0) };
const source: DailyRestrictionWorldSource = {
  worldId: WORLD, regionId: "region-a", seed: "77", infraRelease: TEST_INFRASTRUCTURE_BINDING,
  routeVersionIds: ["test-route"],
};
const profile = {
  id: "explicit-policy-integration/v1", eventsPerPeriod: 6, minimumSeverityBasisPoints: 1_000, maximumSeverityBasisPoints: 8_000,
  minimumDurationSeconds: 1_800, maximumDurationSeconds: 21 * 86_400, minimumNoticeSeconds: 7 * 86_400,
  maximumNoticeSeconds: 21 * 86_400, dailyRestrictionsPerDay: 400, infrastructureIncidentsPer100Days: 1,
  vehicleIncidentsPer10000TrainRuns: 1, dwellIncidentsPer10000Stops: 1,
};
function command(): AdminCommandPayload {
  return {
    kind: "admin.disruption_policy_schedule", worldId: WORLD, actionType: "disruption_policy_schedule", riskClass: "high",
    requesterReference: "odoo-user-1", approverReference: "odoo-user-2", reason: "Explizite La-Policy zur naechsten Fahrplanperiode", effectPreview: {},
    disruptionPolicy: { schemaVersion: "zugfolge-disruption-policy-schedule/v1", requesterSubject: "kc-admin",
      effectiveAt: new Date(EPOCH.getTime() + BOUNDARY).toISOString(), plannedWorksMode: "SIMULATED", operationalIncidentMode: "SIMULATED",
      simulationProfile: profile, rulesetVersion: "disruption-rules/v1" },
  };
}
const context = (payload = command()): GameAdminCommandContext => ({
  adminRequestId: "request-1", effectIdempotencyKey: "policy-effect-1", commandId: "command-1", eventId: "event-1",
  correlationId: "correlation-1", receivedAt: NOW, now: NOW, payload,
});
function generated(input: OperationalDailyRestrictionsRequest): OperationalDailyRestrictionsGenerated {
  return { schemaVersion: "zugfolge-operational-daily-restrictions-generated/v1", worldId: input.worldId,
    regionId: input.regionId, dayStartMs: input.dayStartMs, policyVersion: input.policy.version,
    restrictions: [{ disruptionId: "la-1", startsAtMs: input.dayStartMs, endsAtMs: input.dayStartMs + 1_000,
      effect: { "speed-restriction": { edgeId: "test-edge-west", maximumSpeedMmps: 5_555 } }, provenance: {} }],
    unsupportedRestrictions: [{ reason: "operational-scope-not-supported", scope: { traffic: "passenger" } }],
  };
}
let client: PGlite;
let db: Database;
beforeEach(async () => {
  client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
  db = database as unknown as Database;
  await db.insert(worlds).values({ id: WORLD, name: "Policywelt", epoch: EPOCH, schedulePeriodWeeks: 4 });
  await db.insert(accounts).values({ id: ACCOUNT, worldId: WORLD, keycloakSubject: "kc-admin", displayName: "Administration" });
  await db.insert(accountRoles).values({ worldId: WORLD, accountId: ACCOUNT, role: "world_admin" });
  await db.insert(worldAccesses).values({ worldId: WORLD, keycloakSubject: "kc-admin", status: "active" });
});
afterEach(async () => { vi.unstubAllEnvs(); await client.close(); });

async function completeFlow(native: boolean) {
  if (native) vi.stubEnv(OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV, JSON.stringify({
    [source.infraRelease.infraReleaseId]: fileURLToPath(new URL("../test-infrastructure/operations-v1/", import.meta.url)),
  }));
  const generate = vi.fn(native ? loadOperationalSimulationRuntime().dailyRestrictions! : generated);
  const catalog = new DailyRestrictionCommandCatalog({ base: { at: () => [], *dueBoundaries() {} }, generate, loadPolicies: createDailyRestrictionPolicyLoader(db) });
  await catalog.refresh([source]);
  expect(catalog.at(WORLD, "region-a", 0)).toEqual([]);
  const handler = createDisruptionPolicyAdminHandler({ db, validatePolicy: (world, policy) => catalog.validatePolicy(world, policy) });
  const app = buildApp({ db, verifyToken: async () => ({ keycloakSubject: "kc-admin", displayName: "Administration" }),
    odooWebhookStore: createOdooWebhookReceiptStore(db),
    odooWebhookOptions: { tenantId: "test", keys: [KEY], authorizedActors: { "admin-service": ["admin.disruption_policy_schedule"] } },
    validateDailyRestrictionPolicy: (world, policy) => catalog.validatePolicy(world, policy),
  });
  try {
    vi.stubEnv("NODE_ENV", "production");
    const direct = await app.inject({ method: "POST", url: `/worlds/${WORLD}/disruptions/policies`, headers: { authorization: "Bearer valid" },
      payload: { requestedAtS: 100, effectiveAtS: BOUNDARY / 1_000, plannedWorksMode: "SIMULATED", operationalIncidentMode: "SIMULATED",
        simulationProfile: profile, rulesetVersion: "disruption-rules/v1", reason: "Ausdrueckliche Produktionspolicy" } });
    expect(direct.statusCode).toBe(403);
    expect(await db.select().from(disruptionPolicies)).toEqual([]);
    const envelope: OdooWebhookEnvelope = { schemaVersion: "zugfolge-odoo/v1", eventId: "policy-event-0001", eventType: "commerce.command",
      occurredAt: NOW.toISOString(), correlationId: "policy-correlation-0001", tenantId: "test", actorReference: "admin-service", command: command() };
    const signed = signPayload(envelope, KEY);
    const request = { method: "POST" as const, url: "/integrations/odoo/webhooks", payload: envelope,
      headers: { "x-zugfolge-odoo-key-id": signed.keyId, "x-zugfolge-odoo-timestamp": signed.timestamp, "x-zugfolge-odoo-signature": signed.signature } };
    expect((await app.inject({ ...request, headers: { ...request.headers, "x-zugfolge-odoo-signature": "0".repeat(64) } })).statusCode).toBe(401);
    expect((await app.inject(request)).statusCode).toBe(202);
    expect((await app.inject(request)).statusCode).toBe(200);
    // Ein Abbruch nach dem Fachcommit muss denselben Beleg wiederverwenden.
    let interrupted = false;
    await expect(processNextOdooCommand(db, NOW, { claimClock: () => NOW, adminHandlers: { disruption_policy_schedule: async (ctx) => {
      const result = await handler(ctx); if (!interrupted) { interrupted = true; throw new Error("lost-after-effect"); } return result;
    } } })).rejects.toThrow("lost-after-effect");
    expect(await db.select().from(disruptionPolicies)).toHaveLength(1);
    expect(await processNextOdooCommand(db, NOW, { claimClock: () => NOW, adminHandlers: { disruption_policy_schedule: handler } })).toMatchObject({ outcome: "accepted" });
    const policies = await db.select().from(disruptionPolicies);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ worldId: WORLD, version: 1, status: "scheduled", requestedByAccountId: ACCOUNT, validFromS: BOUNDARY / 1_000 });
    expect(generate).toHaveBeenCalledTimes(1);
    const [outbox] = await db.select().from(odooProjectionOutbox);
    expect(outbox?.payload).toMatchObject({ state: "completed", policyVersion: 1, policyStatus: "scheduled",
      dailyRestrictions: [{ status: "partially-supported", supportedCount: expect.any(Number), unsupportedCount: expect.any(Number) }] });
    await catalog.refresh([source]);
    expect(catalog.at(WORLD, "region-a", BOUNDARY - 1)).toEqual([]);
    const activates = catalog.at(WORLD, "region-a", BOUNDARY);
    expect(activates.length).toBeGreaterThan(0);
    expect(activates.every((entry) => entry.command.type === "activate-disruption")).toBe(true);
    expect(catalog.diagnostics(WORLD)[0]).toMatchObject({ policyVersion: 1, status: "partially-supported" });
    expect(catalog.at("foreign-world", "region-a", BOUNDARY)).toEqual([]);
  } finally { await app.close(); }
}

it("verbindet Produktion, HMAC, Vier-Augen-Antrag, atomaren Retry, Version1 und Scheduler", () => completeFlow(false), 30_000);
it.skipIf(process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] === undefined)("prueft denselben produktiven Odoo-Policyweg mit echtem nativen La-Generator", () => completeFlow(true), 30_000);

it("erlaubt die erste ausdrueckliche Policy zum zukuenftigen Weltstart, aber nie rueckwirkend oder als zweite Version bei null", async () => {
  const futureEpoch = new Date("2026-08-24T00:00:00.000Z");
  await db.update(worlds).set({ epoch: futureEpoch }).where(eq(worlds.id, WORLD));
  const catalog = new DailyRestrictionCommandCatalog({ base: { at: () => [], *dueBoundaries() {} }, generate: generated, loadPolicies: createDailyRestrictionPolicyLoader(db) });
  await catalog.refresh([source]);
  const handler = createDisruptionPolicyAdminHandler({ db, validatePolicy: (world, policy) => catalog.validatePolicy(world, policy) });
  const payload = command();
  const initial = context({ ...payload, disruptionPolicy: { ...payload.disruptionPolicy!, effectiveAt: futureEpoch.toISOString() } });
  await expect(handler({ ...initial, now: futureEpoch })).rejects.toThrow(/kuenftigen/u);
  expect(await db.select().from(disruptionPolicies)).toEqual([]);
  const result = await handler(initial);
  expect(result.result).toMatchObject({ policyVersion: 1, effectiveAt: futureEpoch.toISOString() });
  expect(await handler({ ...initial, now: new Date(futureEpoch.getTime() + 1_000) })).toEqual(result);
  await expect(handler({ ...initial, effectIdempotencyKey: "different-effect" })).rejects.toThrow(/kuenftigen/u);
  await catalog.refresh([source]);
  expect(catalog.at(WORLD, "region-a", 0)[0]?.command.type).toBe("activate-disruption");
  expect(await db.select().from(disruptionPolicies)).toHaveLength(1);
});

it("speichert bei Selbstfreigabe, fremdem Konto, vergangenem Termin oder ungueltigem nativem Profil keine Policy", async () => {
  const validate = vi.fn((): readonly OperationalDailyRestrictionsGenerated[] => { throw new Error("native-invalid-profile"); });
  const handler = createDisruptionPolicyAdminHandler({ db, validatePolicy: validate });
  const payload = command();
  await expect(handler(context({ ...payload, approverReference: payload.requesterReference }))).rejects.toThrow(/dieselbe/u);
  await expect(handler(context({ ...payload, disruptionPolicy: { ...payload.disruptionPolicy!, requesterSubject: "foreign-admin" } }))).rejects.toThrow(/Administratorzugang/u);
  await expect(handler({ ...context(), now: new Date(EPOCH.getTime() + BOUNDARY) })).rejects.toThrow(/kuenftigen/u);
  await expect(handler(context({ ...payload, disruptionPolicy: { ...payload.disruptionPolicy!, plannedWorksMode: "REALISTIC", providerSetId: "unapproved" } }))).rejects.toThrow(/rechtegeprueft/u);
  expect(validate).not.toHaveBeenCalled();
  await expect(handler(context())).rejects.toThrow("native-invalid-profile");
  expect(await db.select().from(disruptionPolicies)).toEqual([]);
  expect(await db.select().from(domainEvents).where(eq(domainEvents.worldId, WORLD))).toEqual([]);
});
