import { PGlite } from "@electric-sql/pglite";
import {
  accountRoles,
  accounts,
  alphaWorldProfiles,
  dailyOperationReports,
  disruptionProviderStates,
  ledgerTransactions,
  mailboxMessages,
  MIGRATIONS_FOLDER,
  commerceEntitlements,
  odooCommandQueue,
  operators,
  simulationCommands,
  worldEventLog,
  worldAccesses,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { createOdooWebhookReceiptStore, signPayload, type OdooWebhookEnvelope, type SigningKey } from "@zugfolge/commerce";
import { validateWorldBlueprint, type AlphaWorldBlueprint } from "@zugfolge/alpha";
import {
  buildEconomyRelease,
  createEconomyPlatformAdapters,
  createFleetMobilizationEnvelope,
  EconomySchedulerMonitor,
  encodeEconomyValue,
  fleetSnapshotHash,
  loadEconomyWorldState,
  listLedgerAccounts,
  openLedgerAccount,
  persistFleetMobilizationSnapshot,
  runEconomySchedulerCycle,
  type CostType,
  type EconomyDatabase,
  type FleetMobilizationSnapshot,
} from "@zugfolge/economy";
import { verifyIdentityToken, type IdentityDatabase } from "@zugfolge/identity";
import { createGtfsPlanningEnvelope, type GtfsPlanningSnapshot } from "@zugfolge/gtfs";
import { operatingProgramTemplates } from "@zugfolge/dispatch";
import { LivemapRegistry } from "@zugfolge/livemap-stream";
import {
  createPlanningAlternativeCommand,
  PLANNING_PROJECTION_SCHEMA_VERSION,
  type PlanningProjectionV1,
} from "@zugfolge/planning-projection";
import {
  REGIONAL_LIVEMAP_DELTA_SCHEMA,
  REGIONAL_SIMULATION_RESULT_SCHEMA,
  REGIONAL_SIMULATION_STATE_SCHEMA,
  type OperatingRuntime,
  type RegionalSimulationResult,
} from "@zugfolge/runtime-native";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";

const ISSUER = "https://auth.zugfolge.test/realms/lhe";
const AUDIENCE = "game-api";
const WORLD_LHE = "11111111-1111-1111-1111-111111111111";
const WORLD_MIDDLE_GERMANY = "22222222-2222-2222-2222-222222222222";
const PRIVATE_WORLD = "33333333-3333-3333-3333-333333333333";
const TUTORIAL_WORLD = "44444444-4444-4444-4444-444444444444";
function publicBlueprint(
  startingCapitalPolicy: AlphaWorldBlueprint["startingCapitalPolicy"] = { kind: "finite", amountCents: "0" },
): AlphaWorldBlueprint {
  return {
    schemaVersion: "zugfolge-alpha-world-blueprint/v1",
    regionId: "mitteldeutschland-b",
    regionVariant: "B",
    seed: 42n,
    profileKind: "public",
    accelerationFactor: 1,
    periodCount: 10,
    startingCapitalPolicy,
    releases: { infra: "a".repeat(64), timetable: "b".repeat(64), fleet: "c".repeat(64), economy: "d".repeat(64) },
    lots: [{
      lotId: "test-lot",
      contractEndsAtPeriod: 2,
      trainRunIds: ["test-train"],
      pathReceiptIds: ["test-path"],
      vehicleIds: ["test-vehicle"],
      personnelDutyIds: ["test-duty"],
      circulationIds: ["test-circulation"],
      operatingProgramIds: ["test-program"],
    }],
    conflictCheckHash: "e".repeat(64),
    tenderCalendarHash: "f".repeat(64),
  };
}

const TEST_ALPHA_BLUEPRINT = publicBlueprint();
const TEST_WORLD_CONTRACT_HASH = validateWorldBlueprint(TEST_ALPHA_BLUEPRINT);
const SIMULATION_INGEST_TOKEN = "test-only-simulation-ingest-token";
const FLEET_INGEST_TOKEN = "test-only-fleet-ingest-token";
const ODOO_KEY: SigningKey = { id: "test-2026", secret: "odoo-test-secret", activeFrom: new Date("2026-01-01T00:00:00Z") };

function planningProjection(
  worldId = WORLD_LHE,
  projectionRevision = 7,
  alternativeId: string | null = "alternative-7",
): PlanningProjectionV1 {
  const resource = { id: "block-a-b", kind: "block" as const, label: "Block A–B" };
  return {
    schemaVersion: PLANNING_PROJECTION_SCHEMA_VERSION,
    projectionRevision,
    worldId,
    corridor: { id: "corridor-a-b", name: "A–B" },
    stations: [
      { id: "station-a", name: "A", distanceMm: 0 },
      { id: "station-b", name: "B", distanceMm: 10_000_000 },
    ],
    trains: [
      {
        id: "train-a",
        number: "R 100",
        direction: "with-chainage",
        calls: [
          { stationId: "station-a", timeS: 25_800 },
          { stationId: "station-b", timeS: 26_400 },
        ],
      },
      {
        id: "train-b",
        number: "R 101",
        direction: "against-chainage",
        calls: [
          { stationId: "station-b", timeS: 25_900 },
          { stationId: "station-a", timeS: 26_500 },
        ],
      },
    ],
    occupations: [],
    conflicts: alternativeId === null ? [] : [{
      id: "conflict-7",
      kind: "opposing-move",
      resource,
      window: { startS: 26_000, endS: 26_120 },
      trainIds: ["train-a", "train-b"],
      explanation: "Beide Zugfahrten beanspruchen denselben Block in Gegenrichtung.",
      alternative: {
        alternativeId,
        trainId: "train-b",
        departureShiftS: 180,
        explanation: "Die angebotene Zeitlage ist serverseitig konfliktfrei geprüft.",
      },
    }],
  };
}

const testOperatingRuntime: OperatingRuntime = {
  verifyFleetMobilizationSnapshot(snapshot) {
    const fleetSnapshot = snapshot as FleetMobilizationSnapshot;
    return {
      schemaVersion: "zugfolge-fleet-mobilization-verification/v1",
      worldId: fleetSnapshot.worldId,
      fleetRevision: fleetSnapshot.revision,
      snapshotHash: fleetSnapshotHash(fleetSnapshot),
    };
  },
  initialize(input) {
    return { schemaVersion: "zugfolge-operating-world-initialized/v1", state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId: input.worldId, revision: 0 }, stateHash: "a".repeat(64) };
  },
  applyTransition(_state, command) {
    const success = command.mobilizationProof !== null;
    return {
      schemaVersion: "zugfolge-operating-transition-result/v1",
      state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId: command.worldId, revision: command.expectedRevision + 1 },
      stateHash: "b".repeat(64),
      outcome: { lotId: command.lotId, previousOperatorId: "public", operatorId: success ? command.winnerOperatorId : "public", kind: success ? "operator-change" : "public-operation", seamless: false, penaltyRequired: !success, trainRunIds: ["api-test-train"], livemapMarker: success ? null : "public-operator" },
      events: [
        { eventId: `${command.commandId}:0`, worldId: command.worldId, eventType: "operating-duty-ended", atS: command.atS, payload: { worldId: command.worldId, lotId: command.lotId } },
        { eventId: `${command.commandId}:1`, worldId: command.worldId, eventType: "operating-transition-completed", atS: command.atS, payload: { worldId: command.worldId, lotId: command.lotId } },
        { eventId: `${command.commandId}:2`, worldId: command.worldId, eventType: "train-operation-assigned", atS: command.atS, payload: { worldId: command.worldId, trainRunId: "api-test-train" } },
        { eventId: `${command.commandId}:3`, worldId: command.worldId, eventType: success ? "livemap-operation-cleared" : "livemap-operation-marked", atS: command.atS, payload: { worldId: command.worldId, trainRunIds: ["api-test-train"], marker: success ? null : "public-operator" } },
      ],
      idempotentReplay: false,
    };
  },
};

let client: PGlite;
let db: IdentityDatabase;
let app: FastifyInstance;
let sign: (subject: string, displayName: string) => Promise<string>;
let livemap: LivemapRegistry;
let verifyTokenForTest: Parameters<typeof buildApp>[0]["verifyToken"];

beforeEach(async () => {
  client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
  db = pgliteDb;

  await pgliteDb.insert(worlds).values([
    { id: WORLD_LHE, name: "Leipzig–Halle–Erfurt", schedulePeriodWeeks: 4, epoch: new Date("2026-01-01T00:00:00Z") },
    {
      id: WORLD_MIDDLE_GERMANY,
      name: "Mitteldeutschland",
      schedulePeriodWeeks: 4,
      epoch: new Date("2026-01-01T00:00:00Z"),
    },
  ]);
  await pgliteDb.insert(alphaWorldProfiles).values([
    {
      worldId: WORLD_LHE,
      profileKind: "public",
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      worldSeed: 42n,
      accelerationFactor: 1,
      infraReleaseHash: "a".repeat(64),
      timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64),
      blueprint: encodeEconomyValue(TEST_ALPHA_BLUEPRINT),
      blueprintHash: TEST_WORLD_CONTRACT_HASH,
      periodCount: 10,
      state: "running",
      startedAtS: 0,
    },
    {
      worldId: WORLD_MIDDLE_GERMANY,
      profileKind: "public",
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      worldSeed: 42n,
      accelerationFactor: 1,
      infraReleaseHash: "a".repeat(64),
      timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64),
      blueprint: encodeEconomyValue(TEST_ALPHA_BLUEPRINT),
      blueprintHash: TEST_WORLD_CONTRACT_HASH,
      periodCount: 10,
      state: "running",
      startedAtS: 0,
    },
  ]);

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] });
  sign = (subject, displayName) =>
    new SignJWT({ preferred_username: displayName })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

  livemap = new LivemapRegistry();
  verifyTokenForTest = (token) => verifyIdentityToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
  app = buildApp({
    db,
    verifyToken: verifyTokenForTest,
    livemap,
    simulationIngestToken: SIMULATION_INGEST_TOKEN,
    fleetIngestToken: FLEET_INGEST_TOKEN,
    cooperationSimulationSecond: async () => 100,
    odooWebhookStore: createOdooWebhookReceiptStore(db),
    odooWebhookOptions: {
      tenantId: "zugfolge-test",
      keys: [ODOO_KEY],
      authorizedActors: { "commerce-service": ["entitlement.change"] },
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await client.close();
});

describe("M13 signierter Odoo-Receiver", () => {
  it("nimmt einen signierten Kauf genau einmal entgegen und weist Replay, falsche Mandanten und abgelaufene Signaturen ab", async () => {
    const payload: OdooWebhookEnvelope = {
      schemaVersion: "zugfolge-odoo/v1",
      eventId: "odoo-api-event-0001",
      eventType: "commerce.command",
      occurredAt: "2026-08-11T12:00:00.000Z",
      correlationId: "odoo-api-correlation-0001",
      tenantId: "zugfolge-test",
      actorReference: "commerce-service",
      command: {
        kind: "entitlement.change",
        subject: "kc-anna",
        productKind: "cosmetic",
        change: "grant",
        validFrom: "2026-08-11T12:00:00.000Z",
        quantity: 1,
        sourceReference: "invoice-api-1",
      },
    };
    const signed = signPayload(payload, ODOO_KEY);
    const headers = {
      "x-zugfolge-odoo-key-id": signed.keyId,
      "x-zugfolge-odoo-timestamp": signed.timestamp,
      "x-zugfolge-odoo-signature": signed.signature,
    };
    const accepted = await app.inject({ method: "POST", url: "/integrations/odoo/webhooks", headers, payload });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: true, duplicate: false });
    const replay = await app.inject({ method: "POST", url: "/integrations/odoo/webhooks", headers, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ accepted: true, duplicate: true });
    expect(await db.select().from(odooCommandQueue)).toHaveLength(1);

    const wrongTenant = { ...payload, eventId: "odoo-api-event-0002", tenantId: "other" };
    const wrongTenantSigned = signPayload(wrongTenant, ODOO_KEY);
    expect((await app.inject({ method: "POST", url: "/integrations/odoo/webhooks", headers: { "x-zugfolge-odoo-key-id": wrongTenantSigned.keyId, "x-zugfolge-odoo-timestamp": wrongTenantSigned.timestamp, "x-zugfolge-odoo-signature": wrongTenantSigned.signature }, payload: wrongTenant })).statusCode).toBe(403);

    const expired = signPayload({ ...payload, eventId: "odoo-api-event-0003" }, ODOO_KEY, new Date("2026-01-02T00:00:00.000Z"));
    expect((await app.inject({ method: "POST", url: "/integrations/odoo/webhooks", headers: { "x-zugfolge-odoo-key-id": expired.keyId, "x-zugfolge-odoo-timestamp": expired.timestamp, "x-zugfolge-odoo-signature": expired.signature }, payload: expired.payload })).statusCode).toBe(401);
  });
});

describe("M13 Entitlement-Grenzen", () => {
  it("vergibt bei parallelem Eintritt in zwei Welten mit Limit 1 genau einen oeffentlichen Weltplatz", async () => {
    const token = await sign("kc-parallel-slot", "Parallel Slot");
    const request = (worldId: string) => app.inject({
      method: "POST",
      url: `/worlds/${worldId}/access`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Parallel Slot", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });

    const [first, second] = await Promise.all([
      request(WORLD_LHE),
      request(WORLD_MIDDLE_GERMANY),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 403]);
    const accesses = await db
      .select({ worldId: worldAccesses.worldId })
      .from(worldAccesses)
      .where(and(
        eq(worldAccesses.keycloakSubject, "kc-parallel-slot"),
        eq(worldAccesses.status, "active"),
      ));
    expect(accesses).toHaveLength(1);
    expect([WORLD_LHE, WORLD_MIDDLE_GERMANY]).toContain(accesses[0]?.worldId);
  });

  it("behandelt parallele Wiederholungen derselben Welt idempotent", async () => {
    const token = await sign("kc-parallel-replay", "Parallel Replay");
    const request = () => app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Parallel Replay", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });

    const [first, second] = await Promise.all([request(), request()]);

    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);
    const accesses = await db
      .select({ worldId: worldAccesses.worldId })
      .from(worldAccesses)
      .where(and(
        eq(worldAccesses.keycloakSubject, "kc-parallel-replay"),
        eq(worldAccesses.status, "active"),
      ));
    expect(accesses).toEqual([{ worldId: WORLD_LHE }]);
  });

  it("laesst private und Tutorialwelten nicht ueber den oeffentlichen Slotpfad betreten", async () => {
    await db.insert(worlds).values([
      {
        id: PRIVATE_WORLD,
        name: "Private Testwelt",
        schedulePeriodWeeks: 4,
        epoch: new Date("2026-01-01T00:00:00Z"),
        worldKind: "private",
        rankingStatus: "unranked",
      },
      {
        id: TUTORIAL_WORLD,
        name: "Tutorial-Testwelt",
        schedulePeriodWeeks: 4,
        epoch: new Date("2026-01-01T00:00:00Z"),
        worldKind: "private",
        rankingStatus: "unranked",
      },
    ]);
    await db.insert(alphaWorldProfiles).values({
      worldId: TUTORIAL_WORLD,
      profileKind: "tutorial",
      regionId: "tutorial-test",
      regionVariant: "T",
      worldSeed: 1n,
      accelerationFactor: 60,
      infraReleaseHash: "a".repeat(64),
      timetableReleaseHash: "b".repeat(64),
      fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64),
      blueprint: {},
      blueprintHash: "e".repeat(64),
      state: "running",
      startedAtS: 0,
    });
    const token = await sign("kc-private-oracle", "Privat Test");
    const enter = (worldId: string) => app.inject({
      method: "POST",
      url: `/worlds/${worldId}/access`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Privat Test", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });

    const privateResponse = await enter(PRIVATE_WORLD);
    const tutorialResponse = await enter(TUTORIAL_WORLD);

    expect(privateResponse.statusCode).toBe(403);
    expect(privateResponse.json()).toMatchObject({ code: "private_world_access_managed" });
    expect(tutorialResponse.statusCode).toBe(403);
    expect(tutorialResponse.json()).toMatchObject({ code: "tutorial_session_required" });
    await expect(db
      .select({ worldId: worldAccesses.worldId })
      .from(worldAccesses)
      .where(eq(worldAccesses.keycloakSubject, "kc-private-oracle")))
      .resolves.toEqual([]);
  });

  it("begrenzt öffentliche Weltplätze im Game und erzeugt private Welten nur ungewertet", async () => {
    const token = await sign("kc-entitlement", "Entitlement Test");
    expect((await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${token}` }, payload: { displayName: "Entitlement Test", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/worlds/${WORLD_MIDDLE_GERMANY}/access`, headers: { authorization: `Bearer ${token}` }, payload: { displayName: "Entitlement Test", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/private-worlds", headers: { authorization: `Bearer ${token}` }, payload: { name: "Privat", schedulePeriodWeeks: 4, epoch: "2026-01-01T00:00:00.000Z" } })).statusCode).toBe(403);

    await db.insert(commerceEntitlements).values({ externalEventId: "direct-test-plus", keycloakSubject: "kc-entitlement", productKind: "zugfolge_plus", status: "active", validFrom: new Date("2026-01-01T00:00:00.000Z"), quantity: "1", correlationId: "entitlement-test", sourceReference: "test" });
    expect((await app.inject({ method: "POST", url: `/worlds/${WORLD_MIDDLE_GERMANY}/access`, headers: { authorization: `Bearer ${token}` }, payload: { displayName: "Entitlement Test", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } })).statusCode).toBe(201);

    await db.insert(commerceEntitlements).values({ externalEventId: "direct-test-private", keycloakSubject: "kc-entitlement", productKind: "private_unranked_world", status: "active", validFrom: new Date("2026-01-01T00:00:00.000Z"), quantity: "1", correlationId: "private-test", sourceReference: "test" });
    const privateWorld = await app.inject({ method: "POST", url: "/private-worlds", headers: { authorization: `Bearer ${token}` }, payload: { name: "Privat", schedulePeriodWeeks: 4, epoch: "2026-01-01T00:00:00.000Z" } });
    expect(privateWorld.statusCode).toBe(201);
    expect(privateWorld.json()).toMatchObject({ worldKind: "private", rankingStatus: "unranked" });
  });
});

describe("M7 Betriebsprogramm und Betriebszentrale", () => {
  it("persistiert und aktiviert kanonisch, isoliert EVU, protokolliert Overrides und erzeugt Tagesberichte", async () => {
    const ownerToken = await sign("kc-m7-owner", "M7 Leitung");
    const foreignToken = await sign("kc-m7-foreign", "Fremd-EVU");
    await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${ownerToken}` }, payload: { displayName: "M7 Leitung", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } });
    await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${foreignToken}` }, payload: { displayName: "Fremd-EVU", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } });
    const founded = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/operators`, headers: { authorization: `Bearer ${ownerToken}` }, payload: { name: "M7-Bahn" } });
    const operatorId = founded.json<{ id: string }>().id;
    const base = `/worlds/${WORLD_LHE}/operators/${operatorId}`;
    const program = operatingProgramTemplates(WORLD_LHE, operatorId, 1)[0]!;

    const denied = await app.inject({ method: "POST", url: `${base}/operating-programs`, headers: { authorization: `Bearer ${foreignToken}` }, payload: { program } });
    expect(denied.statusCode).toBe(403);
    const saved = await app.inject({ method: "POST", url: `${base}/operating-programs`, headers: { authorization: `Bearer ${ownerToken}` }, payload: { program } });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ worldId: WORLD_LHE, operatorId, version: 1, status: "draft" });
    expect(saved.json<{ checksum: string }>().checksum).toMatch(/^[a-f0-9]{64}$/);

    const activated = await app.inject({ method: "POST", url: `${base}/operating-programs/1/activate`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(activated.statusCode).toBe(202);
    expect(activated.json()).toMatchObject({ active: { status: "active" }, command: { commandType: "dispatch.activate-program" } });

    const ingested = await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD_LHE}/simulation/events`,
      headers: { authorization: `Bearer ${SIMULATION_INGEST_TOKEN}` },
      payload: { events: [
        { sequence: 1, eventType: "operations.train-outcome", occurredAt: "2026-08-11T08:00:00.000Z", payload: { operatorId, trainRunId: "RE-1", status: "cancelled", delaySeconds: 900 } },
        { sequence: 2, eventType: "disruption.replacement-plan", occurredAt: "2026-08-11T08:01:00.000Z", payload: { operatorId, trainRunId: "RE-1", decisionId: "decision-1", action: "trigger_rail_replacement", cause: "Streckensperrung", causeCode: 25, causeLabel: "Anlagen Leit- und Sicherungstechnik", affectedResource: "Abzweig Gröbers", outcomeReason: "Umleitung abgelehnt; Ersatzverkehr", major: true, rejectedAlternatives: [{ action: "request_reroute", reason: "Restkapazität vergeben" }], impact: { affected_train_runs: 4, cost_cents: 1000, contract_penalty_cents: 200, personnel_effect: "Bereitschaft", vehicle_effect: "Busreserve" } } },
        { sequence: 3, eventType: "economy.settlement", occurredAt: "2026-08-11T23:59:00.000Z", payload: { operatorId, revenueCents: "5000", costCents: "250", contractPenaltyCents: "50" } },
      ] },
    });
    expect(ingested.statusCode).toBe(202);

    const operations = await app.inject({ method: "GET", url: `${base}/operations`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(operations.statusCode).toBe(200);
    expect(operations.json()).toMatchObject({ throughSequence: 3, majorEvents: [{ decisionId: "decision-1", causeCode: 25, causeLabel: "Anlagen Leit- und Sicherungstechnik" }] });

    const backdatedOverride = await app.inject({ method: "POST", url: `${base}/operations/decisions/decision-1/override`, headers: { authorization: `Bearer ${ownerToken}` }, payload: { idempotencyKey: "override-backdated", action: "request_reroute", reason: "Leitstellenentscheidung wegen verfügbarer Umleitung", at: 1 } });
    expect(backdatedOverride.statusCode).toBe(400);
    const override = await app.inject({ method: "POST", url: `${base}/operations/decisions/decision-1/override`, headers: { authorization: `Bearer ${ownerToken}` }, payload: { idempotencyKey: "override-1", action: "request_reroute", reason: "Leitstellenentscheidung wegen verfügbarer Umleitung" } });
    expect(override.statusCode).toBe(202);
    expect(override.json()).toMatchObject({ commandType: "dispatch.manual-override", payload: { decisionId: "decision-1", at: 100 } });
    const overrideRetry = await app.inject({ method: "POST", url: `${base}/operations/decisions/decision-1/override`, headers: { authorization: `Bearer ${ownerToken}` }, payload: { idempotencyKey: "override-1", action: "request_reroute", reason: "Leitstellenentscheidung wegen verfügbarer Umleitung" } });
    expect(overrideRetry.json<{ id: string }>().id).toBe(override.json<{ id: string }>().id);

    const backtest = await app.inject({ method: "POST", url: `${base}/operating-programs/backtests`, headers: { authorization: `Bearer ${ownerToken}` }, payload: { idempotencyKey: "backtest-1", programVersion: 1, sourceAfter: 0, sourceThrough: 3 } });
    expect(backtest.statusCode).toBe(202);
    expect(backtest.json()).toMatchObject({ commandType: "dispatch.backtest" });

    const report = await app.inject({ method: "POST", url: `${base}/operations/reports/2026-08-11/generate`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(report.statusCode).toBe(201);
    expect(report.json()).toMatchObject({ projection: { trainRuns: { total: 1, cancelled: 1, replacementServices: 1 }, settlements: { revenueCents: "5000", costCents: "1250", contractPenaltyCents: "250" }, facts: { eventSequences: [1, 2, 3], decisions: [{ eventSequence: 2, action: "trigger_rail_replacement" }] } } });
    const reportRetry = await app.inject({ method: "POST", url: `${base}/operations/reports/2026-08-11/generate`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(reportRetry.statusCode).toBe(201);
    expect(reportRetry.json<{ id: string }>().id).toBe(report.json<{ id: string }>().id);
    const reports = await app.inject({ method: "GET", url: `${base}/operations/reports`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(reports.json<unknown[]>()).toHaveLength(1);
  });
});

describe("M8 Störungsrichtlinie und manueller Spielleitermodus", () => {
  it("plant den Policywechsel nur am Stichtag und schreibt manuelle Eingriffe weltisoliert in die Kommandoqueue", async () => {
    const adminToken = await sign("kc-m8-admin", "M8 Spielleitung");
    const playerToken = await sign("kc-m8-player", "M8 Spieler");
    const adminAccess = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${adminToken}` }, payload: { displayName: "M8 Spielleitung", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } });
    await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${playerToken}` }, payload: { displayName: "M8 Spieler", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } });
    await db.insert(accountRoles).values({
      worldId: WORLD_LHE,
      accountId: adminAccess.json<{ id: string }>().id,
      role: "world_admin",
    });
    const boundary = 4 * 7 * 86_400;
    const blockedRealistic = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/disruptions/policies`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        requestedAtS: 100,
        effectiveAtS: boundary,
        plannedWorksMode: "REALISTIC",
        operationalIncidentMode: "REALISTIC",
        providerSetId: "public-infrastructure-restrictions/de-v1",
        simulationProfile: { id: "lhe/v1", eventsPerPeriod: 6 },
        rulesetVersion: "disruption-rules/v1",
        reason: "Provider ohne Rechtefreigabe darf nicht aktiviert werden",
      },
    });
    expect(blockedRealistic.statusCode).toBe(400);
    const policy = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/disruptions/policies`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        requestedAtS: 100,
        effectiveAtS: boundary,
        plannedWorksMode: "SIMULATED",
        operationalIncidentMode: "MANUAL",
        simulationProfile: { id: "lhe/v1", eventsPerPeriod: 6 },
        rulesetVersion: "disruption-rules/v1",
        reason: "Veröffentlichter Wechsel zur nächsten Fahrplanperiode",
      },
    });
    expect(policy.statusCode).toBe(201);
    expect(policy.json()).toMatchObject({ worldId: WORLD_LHE, version: 1, status: "scheduled", validFromS: boundary });
    await db.insert(disruptionProviderStates).values({
      worldId: WORLD_LHE,
      providerSetId: "public-infrastructure-restrictions/de-v1",
      rightsStatus: "approved",
      enabled: "enabled",
      rightsReference: "Quellenregister: Freigabe 2026-08-11",
      checkedAt: new Date("2026-08-11T15:00:00Z"),
    });
    const realistic = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/disruptions/policies`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        requestedAtS: boundary,
        effectiveAtS: boundary * 2,
        plannedWorksMode: "REALISTIC",
        operationalIncidentMode: "REALISTIC",
        providerSetId: "public-infrastructure-restrictions/de-v1",
        simulationProfile: { id: "lhe/v1", eventsPerPeriod: 6 },
        rulesetVersion: "disruption-rules/v1",
        reason: "Rechtegepruefter realistischer Datenmodus zur naechsten Periode",
      },
    });
    expect(realistic.statusCode).toBe(201);
    const tooEarly = await app.inject({ method: "GET", url: `/worlds/${WORLD_LHE}/disruptions/policy?atS=${boundary - 1}`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(tooEarly.statusCode).toBe(404);
    const active = await app.inject({ method: "GET", url: `/worlds/${WORLD_LHE}/disruptions/policy?atS=${boundary}`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(active.json()).toMatchObject({ version: 1, rulesetVersion: "disruption-rules/v1" });

    const body = {
      idempotencyKey: "manual-m8-1",
      regionId: "leipzig",
      kind: "planned",
      publishedAtS: boundary,
      startsAtS: boundary + 1_000,
      endsAtS: boundary + 2_000,
      positionMm: 1_200_000,
      causeCode: 25,
      fineCauseId: "signalling.interlocking",
      cause: "Signaltechnische Untersuchung",
      affectedResources: [{ kind: "track", id: 4 }],
      affectedResource: "track:4",
      affectedTrainRunIds: [],
      delaySeconds: 0,
      effect: { kind: "closure" },
    };
    const denied = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/disruptions/manual`, headers: { authorization: `Bearer ${playerToken}` }, payload: body });
    expect(denied.statusCode).toBe(403);
    const effectless = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/disruptions/manual`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ...body, idempotencyKey: "manual-m8-effectless", effect: { kind: "radio-unavailable" } },
    });
    expect(effectless.statusCode).toBe(400);
    const queued = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/disruptions/manual`, headers: { authorization: `Bearer ${adminToken}` }, payload: body });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ worldId: WORLD_LHE, commandType: "disruption.manual", payload: { worldId: WORLD_LHE, causeCode: 25, fineCauseId: "signalling.interlocking" } });
    const replay = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/disruptions/manual`, headers: { authorization: `Bearer ${adminToken}` }, payload: body });
    expect(replay.json<{ id: string }>().id).toBe(queued.json<{ id: string }>().id);

    const regionalApply = vi.fn(async (work: {
      readonly worldId: string;
      readonly regionId: string;
      readonly commandId: string;
    }): Promise<RegionalSimulationResult> => ({
      schemaVersion: REGIONAL_SIMULATION_RESULT_SCHEMA,
      state: {
        schemaVersion: REGIONAL_SIMULATION_STATE_SCHEMA,
        worldId: work.worldId,
        regionId: work.regionId,
        initialNowS: 0,
        nowS: boundary,
        revision: 1,
        publisherSequence: 1,
        commands: [{}],
      },
      stateHash: "d".repeat(64),
      events: [],
      delta: {
        schemaVersion: REGIONAL_LIVEMAP_DELTA_SCHEMA,
        worldId: work.worldId,
        regionId: work.regionId,
        producerSequence: 1,
        atS: boundary,
        changed: [],
        removed: [],
        changedDisruptions: [],
        removedDisruptionIds: [],
      },
      appliedCommandId: work.commandId,
      idempotentReplay: false,
    }));
    const integrated = buildApp({
      db,
      verifyToken: verifyTokenForTest,
      regionalSimulation: {
        initialize: async () => { throw new Error("in diesem Test nicht verwendet"); },
        apply: regionalApply,
      },
    });
    await integrated.ready();
    try {
      const applied = await integrated.inject({
        method: "POST",
        url: `/worlds/${WORLD_LHE}/disruptions/manual`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { ...body, idempotencyKey: "manual-m8-integrated" },
      });
      expect(applied.statusCode).toBe(200);
      expect(regionalApply).toHaveBeenCalledWith(
        expect.objectContaining({
          worldId: WORLD_LHE,
          regionId: "leipzig",
          command: expect.objectContaining({
            type: "register-disruption",
            disruption: expect.objectContaining({
              kind: "planned",
              effect: "closure",
              fineCauseId: "signalling.interlocking",
            }),
          }),
        }),
        expect.any(Date),
      );
      expect(applied.json()).toMatchObject({ command: { status: "processed" } });
    } finally {
      await integrated.close();
    }
  });
});

describe("M5-Rohsnapshot-Bypass", () => {
  it("existiert auch mit gueltigem internem Token nicht mehr", async () => {
    const rejected = await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD_LHE}/fleet/mobilization-snapshots`,
      headers: { authorization: `Bearer ${FLEET_INGEST_TOKEN}` },
      payload: { snapshot: {}, snapshotHash: "0".repeat(64) },
    });
    expect(rejected.statusCode).toBe(404);
  });
});

describe("öffentlicher, persistenter M6-Gesamtablauf", () => {
  it("führt API, DB, Scheduler, M5-Snapshot, Ledger und Postfach restart-sicher zusammen", async () => {
    const OPEN = 100;
    const CLOSE = OPEN + 3 * 86_400;
    const OPERATING = CLOSE + 10_000;
    const worldInstant = (seconds: number) =>
      new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1_000);
    const adminToken = await sign("kc-economy-admin", "Economy Admin");
    const adminAccess = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${adminToken}` }, payload: { displayName: "Economy Admin", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } });
    expect(adminAccess.statusCode).toBe(201);
    const accountId = adminAccess.json<{ id: string }>().id;
    const adminRole = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${accountId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "world_admin" },
    });
    expect(adminRole.statusCode).toBe(200);
    const operatorResponse = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/operators`, headers: { authorization: `Bearer ${adminToken}` }, payload: { name: "M6-Bahn" } });
    expect(operatorResponse.statusCode).toBe(201);
    const operatorId = operatorResponse.json<{ id: string }>().id;
    const foreignToken = await sign("kc-economy-foreign", "Fremd");
    await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${foreignToken}` }, payload: { displayName: "Fremd", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } });
    const foreignOperatorResponse = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/operators`, headers: { authorization: `Bearer ${foreignToken}` }, payload: { name: "M6-Konkurrenz" } });
    const foreignOperatorId = foreignOperatorResponse.json<{ id: string }>().id;

    const cash = (await listLedgerAccounts(db, { worldId: WORLD_LHE, operatorId }))
      .find((account) => account.name === "Economy:Kasse");
    expect(cash).toBeDefined();
    const revenue = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Economy:Bestellerentgelt" });
    const costTypes: readonly CostType[] = ["track", "station", "facility", "energy", "personnel", "administration", "vehicle", "penalty", "interest"];
    const costAccountIds = Object.fromEntries(await Promise.all(costTypes.map(async (type) => [type, (await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: `Economy:${type}` })).id]))) as Record<CostType, string>;
    const adapters = {
      ...createEconomyPlatformAdapters({ db, accountsByOperator: { [operatorId]: { cashAccountId: cash!.id, revenueAccountId: revenue.id, costAccountIds } } }),
      operatingRuntime: testOperatingRuntime,
      publishRuntimeEvents: async () => undefined,
    };
    const monitor = new EconomySchedulerMonitor(0);

    const release = buildEconomyRelease({
      version: "api-e2e-v1",
      rates: { trackPerTrainKmCents: 1n, stationPerStopCents: 1n, facilityPerHourCents: 1n, energyPerKwhCents: 1n, personnelPerHourCents: 1n, administrationPerPeriodCents: 1n, vehiclePerPeriodCents: 1n, overnightStablingPerPeriodCents: 1n, protectionEquipmentPerPeriodCents: 1n, lateInterestBasisPoints: 1 },
      rules: { qualityBaselinePunctualityBasisPoints: 8_500, pointsPerExtraSeat: 1, pointsPerPunctualityBasisPoint: 1, pointsPerAdditionalStop: 1, requirementFocusMaximumPoints: 1_000, contractBonusCentsPerPeriod: 1n, penaltyRates: { punctuality: 1n, cancellation: 1n, seats: 1n, connections: 1n }, penaltyFocusMultiplierBasisPoints: 10_000, publicOperationSurchargeBasisPoints: 0, failedPackageFeeStepBasisPoints: 0, failedPackageReductionStepBasisPoints: 0 },
      tenderProfiles: [
        { id: "a", weights: { price: 5_000, quality: 5_000 }, requirementFocus: "capacity", penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 10_000 },
        { id: "b", weights: { price: 5_000, quality: 5_000 }, requirementFocus: "bicycle", penaltyFocus: "connections", viabilitySurchargeBasisPoints: 10_000 },
      ],
    });
    const planningSnapshot: GtfsPlanningSnapshot = {
      schema: "zugfolge-gtfs-planning/v1",
      worldId: WORLD_LHE,
      revision: 1,
      producedAt: 10,
      source: {
        sourceId: "gtfs-de-rv",
        feedUrl: "https://download.gtfs.de/germany/rv_free/latest.zip",
        archiveSha256: "a".repeat(64),
        capturedAt: "2026-08-09T00:00:00.000Z",
        timeZone: "Europe/Berlin",
        sourceLicense: "CC BY 4.0",
        attribution: "Datenquelle: DELFI e.V. / GTFS.DE",
      },
      infrastructureVersion: "api-test-graph-v1",
      rulesVersion: "api-test-spnv-v1",
      serviceDates: ["20260810"],
      patterns: Array.from({ length: 8 }, (_, index) => ({
        id: `sp-s${index + 1}-test`,
        lineId: `S${index + 1}`,
        directionId: "0",
        sourceRouteIds: [`source-route-s${index + 1}`],
        stopIds: [`source-stop-${index}-a`, `source-stop-${index}-b`],
        stopNames: [`Alpha ${index}`, `Beta ${index}`],
        nodeIds: [`node-${index}-a`, `node-${index}-b`],
        edgeIds: [`edge-${index}-ab`],
        distanceMeters: 100_000,
        journeys: [{ sourceTripId: `source-trip-${index + 1}`, serviceDate: "20260810", departureServiceSeconds: 3_600, arrivalServiceSeconds: 7_200, departureEpochSeconds: 1_786_316_400, arrivalEpochSeconds: 1_786_320_000 }],
        metrics: { journeyCount: 1, totalTrainMeters: "100000", totalStops: "2", totalServiceSeconds: "3600", totalEnergyWh: "10000", medianHeadwaySeconds: null, maximumOperatingSpanSeconds: 3_600, peakVehicles: 1 },
      })),
      lots: Array.from({ length: 8 }, (_, index) => ({
        id: `lot-s${index + 1}-test`,
        lineIds: [`S${index + 1}`],
        patternIds: [`sp-s${index + 1}-test`],
        connectingNodeIds: [],
        size: 100 - index,
        attractiveness: 120 + index,
        smallLot: false,
        specificationBasis: {
          sampleServiceDays: 1,
          totalTrainMeters: "100000",
          totalStops: "2",
          totalServiceSeconds: "3600",
          totalEnergyWh: "10000",
          peakVehicles: 1,
          facilityMinutesPerDay: 30,
          overnightUnits: 1,
          protectionUnits: 1,
          requirements: { minimumSeats: 100, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 2, wheelchairPlaces: 1, requiredEquipment: ["pis"] },
        },
      })),
    };
    const planningEnvelope = createGtfsPlanningEnvelope(planningSnapshot);
    const start = await app.inject({
      method: "POST", url: `/worlds/${WORLD_LHE}/economy/start`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { at: 0, seed: "1", durationMonths: 6, release: encodeEconomyValue(release), planning: planningEnvelope, authorityBudgets: encodeEconomyValue([{ authorityId: "authority", period: 0, availableCents: 10_000_000n, committedCents: 0n }]) },
    });
    expect(start.statusCode).toBe(201);

    const fleetSnapshot: FleetMobilizationSnapshot = {
      schema: "zugfolge-fleet-mobilization/v1", worldId: WORLD_LHE, revision: 1, producedAt: 50,
      formations: [
        { id: "formation-1", operatorId, vehicleIds: ["vehicle-1"], serviceLineIds: ["S1"], availability: "available", procurement: "delivered", availableFrom: 0, availableUntil: OPERATING + 100, characteristics: { seats: 120, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 4, wheelchairPlaces: 1, equipment: ["pis"], vehicleAgeYears: 2, maximumSpeedKph: 160, operatingCostCentsPerTrainKm: 700, homologatedLineIds: ["S1"], maintenanceValidUntil: OPERATING + 100, traction: "electric", replacementPlan: true } },
        { id: "formation-foreign", operatorId: foreignOperatorId, vehicleIds: ["vehicle-foreign"], serviceLineIds: ["S1"], availability: "available", procurement: "delivered", availableFrom: 0, availableUntil: OPERATING + 100, characteristics: { seats: 120, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 4, wheelchairPlaces: 1, equipment: ["pis"], vehicleAgeYears: 2, maximumSpeedKph: 160, operatingCostCentsPerTrainKm: 700, homologatedLineIds: ["S1"], maintenanceValidUntil: OPERATING + 100, traction: "electric", replacementPlan: true } },
      ],
      personnelDuties: [
        { id: "duty-1", operatorId, formationIds: ["formation-1"], status: "ready", validFrom: 0, validUntil: OPERATING + 100 },
        { id: "duty-foreign", operatorId: foreignOperatorId, formationIds: ["formation-foreign"], status: "ready", validFrom: 0, validUntil: OPERATING + 100 },
      ],
      pathReservations: [
        { id: "path-1", operatorId, serviceLineIds: ["S1"], status: "confirmed", validFrom: 0, validUntil: OPERATING + 100 },
        { id: "path-foreign", operatorId: foreignOperatorId, serviceLineIds: ["S1"], status: "confirmed", validFrom: 0, validUntil: OPERATING + 100 },
      ],
    };
    const fleetEnvelope = createFleetMobilizationEnvelope(fleetSnapshot);
    await expect(persistFleetMobilizationSnapshot(
      db as EconomyDatabase,
      WORLD_LHE,
      fleetEnvelope,
      new Date(fleetSnapshot.producedAt * 1_000),
    )).resolves.toMatchObject({ created: true, snapshotHash: fleetEnvelope.snapshotHash });

    const planningReference = { planningRevision: 1, snapshotHash: planningEnvelope.snapshotHash, lotId: "lot-s1-test" };
    const manipulated = await app.inject({
      method: "POST", url: `/worlds/${WORLD_LHE}/economy/tenders`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { expectedRevision: 0, commandId: "api:manipulated", tenderId: "tender-manipulated", planningReference, announcedAt: 0, opensAt: OPEN, closesAt: CLOSE, operatingFrom: OPERATING, specification: { lines: ["FAKE"], trainKmPerPeriod: "1" }, authorityId: "authority", budgetPeriod: 0, vehiclePool: [], failurePenaltyCents: "1000" },
    });
    expect(manipulated.statusCode).toBe(400);
    const announced = await app.inject({
      method: "POST", url: `/worlds/${WORLD_LHE}/economy/tenders`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { expectedRevision: 0, commandId: "api:announce", tenderId: "tender-1", planningReference, announcedAt: 0, opensAt: OPEN, closesAt: CLOSE, operatingFrom: OPERATING, authorityId: "authority", budgetPeriod: 0, vehiclePool: [], failurePenaltyCents: "1000" },
    });
    expect(announced.statusCode).toBe(201);
    expect((await runEconomySchedulerCycle(db, worldInstant(OPEN), adapters, monitor)).transitions).toBe(1);

    const bidPayload = { expectedRevision: 3, commandId: "api:bid", bidId: "bid-1", orderingFeeCentsPerTrainKm: "1", vehicleReference: { fleetRevision: 1, snapshotHash: fleetEnvelope.snapshotHash, formationId: "formation-1" }, promises: { extraSeats: 0, punctualityBasisPoints: 9_000, additionalStops: 0 } };
    const backdatedBid = await app.inject({
      method: "POST", url: `/worlds/${WORLD_LHE}/economy/tenders/tender-1/operators/${operatorId}/bids`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { ...bidPayload, submittedAt: 0 },
    });
    expect(backdatedBid.statusCode).toBe(400);
    const deniedBid = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/economy/tenders/tender-1/operators/${operatorId}/bids`, headers: { authorization: `Bearer ${foreignToken}` }, payload: bidPayload });
    expect(deniedBid.statusCode).toBe(403);
    const foreignBid = await app.inject({
      method: "POST", url: `/worlds/${WORLD_LHE}/economy/tenders/tender-1/operators/${foreignOperatorId}/bids`, headers: { authorization: `Bearer ${foreignToken}` },
      payload: { expectedRevision: 2, commandId: "api:bid-foreign", bidId: "bid-foreign", orderingFeeCentsPerTrainKm: "2", vehicleReference: { fleetRevision: 1, snapshotHash: fleetEnvelope.snapshotHash, formationId: "formation-foreign" }, promises: { extraSeats: 20, punctualityBasisPoints: 9_500, additionalStops: 0 } },
    });
    expect(foreignBid.statusCode).toBe(201);
    const bid = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/economy/tenders/tender-1/operators/${operatorId}/bids`, headers: { authorization: `Bearer ${adminToken}` }, payload: bidPayload });
    expect(bid.statusCode).toBe(201);
    expect(bid.body).toContain("bid-1");
    expect(bid.body).not.toContain("bid-foreign");
    const ownerProjection = await app.inject({ method: "GET", url: `/worlds/${WORLD_LHE}/economy/state`, headers: { authorization: `Bearer ${adminToken}` } });
    const foreignProjection = await app.inject({ method: "GET", url: `/worlds/${WORLD_LHE}/economy/state`, headers: { authorization: `Bearer ${foreignToken}` } });
    expect(ownerProjection.body).toContain("bid-1");
    expect(ownerProjection.body).not.toContain("bid-foreign");
    expect(foreignProjection.body).toContain("bid-foreign");
    expect(foreignProjection.body).not.toContain("bid-1");

    expect((await runEconomySchedulerCycle(db, worldInstant(CLOSE), adapters, monitor)).transitions).toBe(1);
    const mobilization = await app.inject({
      method: "PUT", url: `/worlds/${WORLD_LHE}/economy/tenders/tender-1/operators/${operatorId}/mobilization`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { expectedRevision: 5, commandId: "api:mobilization", reference: { fleetRevision: 1, snapshotHash: fleetEnvelope.snapshotHash, formationIds: ["formation-1"], personnelDutyIds: ["duty-1"], pathReservationIds: ["path-1"] } },
    });
    expect(mobilization.statusCode).toBe(200);
    expect((await runEconomySchedulerCycle(db, worldInstant(OPERATING), adapters, monitor)).transitions).toBe(1);
    expect((await loadEconomyWorldState(db, WORLD_LHE))?.contracts.get("tender-1")?.operatorId).toBe(operatorId);

    const forgedSettlement = await app.inject({
      method: "POST", url: `/worlds/${WORLD_LHE}/economy/operators/${operatorId}/contracts/tender-1/settlements`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { expectedRevision: 7, commandId: "api:forged-settlement", period: 0, at: OPERATING + 1, performance: { trainKm: "999999999999", punctualityBasisPoints: 10_000, cancellations: 0, missingSeats: 0, missedConnections: 0, evidence: ["foreign"] }, costs: [] },
    });
    expect(forgedSettlement.statusCode).toBe(400);
    const contract = (await loadEconomyWorldState(db, WORLD_LHE))!.contracts.get("tender-1")!;
    const periodEnd = contract.startsAt + 21 * 86_400;
    const futureSettlementApp = buildApp({ db, verifyToken: verifyTokenForTest, cooperationSimulationSecond: async () => periodEnd - 1 });
    await futureSettlementApp.ready();
    const futureSettlement = await futureSettlementApp.inject({
      method: "POST", url: `/worlds/${WORLD_LHE}/economy/operators/${operatorId}/contracts/tender-1/settlements`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { expectedRevision: 7, commandId: "api:future-settlement" },
    });
    expect(futureSettlement.statusCode).toBe(409);
    await futureSettlementApp.close();
    const periodStartDay = worldInstant(contract.startsAt).toISOString().slice(0, 10);
    for (let day = 0; day <= 21; day += 1) {
      const serviceDay = worldInstant(contract.startsAt + day * 86_400).toISOString().slice(0, 10);
      await db.insert(dailyOperationReports).values({
        worldId: WORLD_LHE,
        operatorId,
        serviceDay,
        sourceFromSequence: day + 1,
        sourceThroughSequence: day + 1,
        projection: {
          schema: "daily-operations-report/v1", serviceDay, sourceFromSequence: day + 1, sourceThroughSequence: day + 1,
          trainRuns: { total: 1, punctual: 1, delayed: 0, cancelled: 0, replacementServices: 0, trainKm: "10", missingSeats: 0, missedConnections: 0 },
          settlements: { revenueCents: "0", costCents: day === 0 ? "100" : "0", contractPenaltyCents: "0" },
          contracts: { "tender-1": { trainRuns: { total: 1, punctual: 1, cancelled: 0, trainKm: "10", missingSeats: 0, missedConnections: 0 }, settlements: { costCents: day === 0 ? "100" : "0", contractPenaltyCents: "0" } } },
          decisionsByAction: {}, infrastructureEffects: [], personnelEffects: [], vehicleEffects: [], facts: { eventSequences: [day + 1], decisions: [] }, assessment: { nextLevers: [] },
        },
        generatedAt: worldInstant(periodEnd),
      });
    }
    expect(periodStartDay).toMatch(/^2026-/);
    const settlementApp = buildApp({ db, verifyToken: verifyTokenForTest, cooperationSimulationSecond: async () => periodEnd });
    await settlementApp.ready();
    const settlement = await settlementApp.inject({
      method: "POST", url: `/worlds/${WORLD_LHE}/economy/operators/${operatorId}/contracts/tender-1/settlements`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { expectedRevision: 7, commandId: "api:settlement" },
    });
    expect(settlement.statusCode).toBe(201);
    const replay = await settlementApp.inject({
      method: "POST", url: `/worlds/${WORLD_LHE}/economy/operators/${operatorId}/contracts/tender-1/settlements`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { expectedRevision: 8, commandId: "api:settlement-replay" },
    });
    expect(replay.statusCode).toBe(409);
    await settlementApp.close();
    await runEconomySchedulerCycle(db, worldInstant(periodEnd + 1), adapters, monitor);
    expect((await db.select().from(ledgerTransactions)).filter(
      (transaction) => transaction.idempotencyKey === "api:settlement:settlement",
    )).toHaveLength(1);
    expect((await db.select().from(mailboxMessages)).filter((message) => message.recipientAccountId === accountId).length).toBeGreaterThan(0);

    const restarted = buildApp({ db, verifyToken: verifyTokenForTest });
    await restarted.ready();
    const restartedState = await restarted.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/economy/state`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(restartedState.statusCode).toBe(200);
    const persisted = await loadEconomyWorldState(db, WORLD_LHE);
    expect(persisted?.revision).toBe(8);
    expect(persisted?.settledPeriods.has("tender-1:0")).toBe(true);
    await restarted.close();
  });
});

describe("GET /health", () => {
  it("antwortet ohne Authentifizierung", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("öffentliche Weltverträge", () => {
  it("projiziert No-Wipe, Release-Pins und StartingCapitalPolicy vor dem bestätigten Eintritt", async () => {
    const blueprint = publicBlueprint();
    await (db as ReturnType<typeof drizzle<typeof schema>>).update(alphaWorldProfiles).set({
      profileKind: "public", regionId: "mitteldeutschland-b", regionVariant: "B", worldSeed: 42n,
      accelerationFactor: 1, infraReleaseHash: "a".repeat(64), timetableReleaseHash: "b".repeat(64), fleetReleaseHash: "c".repeat(64), economyReleaseHash: "d".repeat(64),
      blueprint: encodeEconomyValue(blueprint), blueprintHash: TEST_WORLD_CONTRACT_HASH, periodCount: 10, state: "running", startedAtS: 0,
    }).where(eq(alphaWorldProfiles.worldId, WORLD_LHE));
    const token = await sign("world-contract-player", "Weltvertrag Spieler");
    const contracts = await app.inject({ method: "GET", url: "/public-world-contracts", headers: { authorization: `Bearer ${token}` } });
    expect(contracts.statusCode).toBe(200);
    expect(contracts.json()).toEqual(expect.arrayContaining([expect.objectContaining({
      schemaVersion: "zugfolge-public-world-contract/v1", worldId: WORLD_LHE, noWipe: true, contractHash: TEST_WORLD_CONTRACT_HASH,
      region: { id: "mitteldeutschland-b", name: "Leipzig–Halle–Erfurt", variant: "B" },
      duration: expect.objectContaining({ kind: "periods", periodCount: 10 }),
      timeBasis: expect.objectContaining({ mode: "realtime", accelerationFactor: 1 }),
      startingCapitalPolicy: expect.objectContaining({ kind: "finite", amountCents: "0" }),
      entry: expect.objectContaining({ status: "open", requiresContractConfirmation: true }),
    })]));
    const unconfirmed = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${token}` }, payload: { displayName: "Weltvertrag Spieler" } });
    expect(unconfirmed.statusCode).toBe(409);
    const confirmed = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${token}` }, payload: { displayName: "Weltvertrag Spieler", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } });
    expect(confirmed.statusCode).toBe(201);

    await (db as ReturnType<typeof drizzle<typeof schema>>).update(alphaWorldProfiles).set({
      blueprint: encodeEconomyValue({ ...blueprint, startingCapitalPolicy: { kind: "finite", amountCents: "9223372036854775808" } }),
    }).where(eq(alphaWorldProfiles.worldId, WORLD_LHE));
    const invalidContracts = await app.inject({ method: "GET", url: "/public-world-contracts", headers: { authorization: `Bearer ${token}` } });
    expect(invalidContracts.json()).toEqual(expect.arrayContaining([expect.objectContaining({
      worldId: WORLD_LHE,
      startingCapitalPolicy: null,
      entry: expect.objectContaining({ status: "configuration-incomplete" }),
    })]));
    const invalidToken = await sign("invalid-world-contract-player", "Ungültiger Weltvertrag");
    const invalidAccess = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${invalidToken}` }, payload: { displayName: "Ungültiger Weltvertrag", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } });
    expect(invalidAccess.statusCode).toBe(409);
    expect(invalidAccess.json()).toMatchObject({ code: "world_contract_invalid" });

    const finiteBlueprint = publicBlueprint({ kind: "finite", amountCents: "100000" });
    await (db as ReturnType<typeof drizzle<typeof schema>>).update(alphaWorldProfiles).set({
      blueprint: encodeEconomyValue(finiteBlueprint),
      blueprintHash: validateWorldBlueprint(finiteBlueprint),
    }).where(eq(alphaWorldProfiles.worldId, WORLD_LHE));
    const supportedContracts = await app.inject({ method: "GET", url: "/public-world-contracts", headers: { authorization: `Bearer ${token}` } });
    expect(supportedContracts.json()).toEqual(expect.arrayContaining([expect.objectContaining({
      worldId: WORLD_LHE,
      startingCapitalPolicy: expect.objectContaining({ kind: "finite", amountCents: "100000" }),
      entry: expect.objectContaining({ status: "open" }),
    })]));
  });
});

describe("Livemap (M4.6)", () => {
  async function grantWorldAccess(worldId: string, subject: string): Promise<string> {
    const token = await sign(subject, subject);
    const access = await app.inject({
      method: "POST",
      url: `/worlds/${worldId}/access`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: subject, acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });
    expect(access.statusCode).toBe(201);
    const founded = await app.inject({
      method: "POST",
      url: `/worlds/${worldId}/operators`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `EVU ${subject}` },
    });
    expect(founded.statusCode).toBe(201);
    return token;
  }

  it("liefert den Initialsnapshot nur authentifiziert und mit aktivem Zugang zur angefragten Welt", async () => {
    livemap.initializeWorld(WORLD_LHE, {
      at: 42,
      trains: [
        {
          id: "1",
          operator: "EVU",
          trainNumber: "RE 1",
          category: "regional",
          positionMm: 5,
          speedMmPerSecond: 2,
          delaySeconds: 0,
          nextOperatingPoint: "Halle",
          status: "running",
        },
      ],
    });
    const missingToken = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/snapshot`,
    });
    expect(missingToken.statusCode).toBe(401);
    const missingStreamToken = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/events`,
      headers: { "last-event-id": "0" },
    });
    expect(missingStreamToken.statusCode).toBe(401);

    const foreignToken = await grantWorldAccess(WORLD_MIDDLE_GERMANY, "kc-livemap-foreign");
    const foreignWorld = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/snapshot`,
      headers: { authorization: `Bearer ${foreignToken}` },
    });
    expect(foreignWorld.statusCode).toBe(403);
    const foreignStream = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/events`,
      headers: { authorization: `Bearer ${foreignToken}`, "last-event-id": "0" },
    });
    expect(foreignStream.statusCode).toBe(403);

    const token = await grantWorldAccess(WORLD_LHE, "kc-livemap");
    const response = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/snapshot`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ worldId: string; sequence: number; trains: unknown[] }>()).toMatchObject({
      worldId: WORLD_LHE,
      sequence: 1,
    });
    expect(response.json<{ trains: unknown[] }>().trains).toHaveLength(1);
  });

  it("legt für eine fremde oder unbekannte Welt keinen Feed an", async () => {
    const token = await grantWorldAccess(WORLD_LHE, "kc-livemap-known-world");
    const unknown = "99999999-9999-4999-8999-999999999999";
    const before = livemap.size;
    const response = await app.inject({
      method: "GET",
      url: `/worlds/${unknown}/livemap/snapshot`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(livemap.size).toBe(before);
  });

  it("liefert ohne konfigurierten Publisher keinen stillen leeren Snapshot", async () => {
    const token = await grantWorldAccess(WORLD_LHE, "kc-livemap-no-publisher");
    const withoutPublisher = buildApp({
      db,
      verifyToken: verifyTokenForTest,
      simulationIngestToken: SIMULATION_INGEST_TOKEN,
      fleetIngestToken: FLEET_INGEST_TOKEN,
    });
    await withoutPublisher.ready();
    const response = await withoutPublisher.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/snapshot`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(503);
    await withoutPublisher.close();
  });

  it("liefert vor dem autoritativen Rust-Initialsnapshot keinen stillen leeren Feed", async () => {
    const token = await grantWorldAccess(WORLD_LHE, "kc-livemap-uninitialized");
    const before = livemap.size;
    const snapshot = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/snapshot`,
      headers: { authorization: `Bearer ${token}` },
    });
    const events = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/events`,
      headers: { authorization: `Bearer ${token}`, "last-event-id": "0" },
    });
    expect(snapshot.statusCode).toBe(503);
    expect(events.statusCode).toBe(503);
    expect(snapshot.json()).toMatchObject({ error: expect.stringMatching(/Rust-Initialsnapshot/) });
    expect(livemap.size).toBe(before);
  });

  it("liefert nach atomarem TTL-Prune niemals einen neu erzeugten leeren Feed", async () => {
    const token = await grantWorldAccess(WORLD_LHE, "kc-livemap-expired");
    let now = 0;
    const expiringLivemap = new LivemapRegistry({ idleTtlMs: 100, now: () => now });
    expiringLivemap.initializeWorld(WORLD_LHE, { at: 1, trains: [] });
    const expiringApp = buildApp({
      db,
      verifyToken: verifyTokenForTest,
      livemap: expiringLivemap,
    });
    await expiringApp.ready();
    now = 101;
    const snapshot = await expiringApp.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/snapshot`,
      headers: { authorization: `Bearer ${token}` },
    });
    const events = await expiringApp.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/events`,
      headers: { authorization: `Bearer ${token}`, "last-event-id": "0" },
    });
    expect(snapshot.statusCode).toBe(503);
    expect(events.statusCode).toBe(503);
    expect(expiringLivemap.size).toBe(0);
    await expiringApp.close();
  });

  it("sendet bei gleicher Sequenz aus einer neuen Feed-Generation einen Reset", async () => {
    const token = await grantWorldAccess(WORLD_LHE, "kc-livemap-generation");
    let now = 0;
    const streamIds = ["generation-a", "generation-b"];
    const expiringLivemap = new LivemapRegistry({
      idleTtlMs: 100,
      now: () => now,
      createStreamId: () => streamIds.shift()!,
    });
    expiringLivemap.initializeWorld(WORLD_LHE, { at: 1, trains: [] });
    const oldSnapshot = expiringLivemap.initializedWorld(WORLD_LHE)!.snapshot();
    now = 101;
    expiringLivemap.initializeWorld(WORLD_LHE, { at: 2, trains: [] });
    const newSnapshot = expiringLivemap.initializedWorld(WORLD_LHE)!.snapshot();
    expect(newSnapshot.sequence).toBe(oldSnapshot.sequence);
    expect(newSnapshot.streamId).not.toBe(oldSnapshot.streamId);

    const expiringApp = buildApp({
      db,
      verifyToken: verifyTokenForTest,
      livemap: expiringLivemap,
    });
    await expiringApp.ready();
    const response = await expiringApp.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/events`,
      headers: {
        authorization: `Bearer ${token}`,
        "last-event-id": `${oldSnapshot.streamId}:${oldSnapshot.sequence}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.match(/event: reset/g)).toHaveLength(1);
    await expiringApp.close();
  });

  it("sendet bei einer Replay-Lücke genau einen Reset und hinterlässt kein Abonnement", async () => {
    const token = await grantWorldAccess(WORLD_LHE, "kc-livemap-reset");
    livemap.initializeWorld(WORLD_LHE, { at: 0, trains: [] });
    const feed = livemap.forWorld(WORLD_LHE);
    for (let sequence = 1; sequence <= 257; sequence += 1) {
      feed.publish({ at: sequence, changed: [], removed: [] });
    }

    const response = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/events`,
      headers: {
        authorization: `Bearer ${token}`,
        "last-event-id": `${feed.snapshot().streamId}:0`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.match(/event: reset/g)).toHaveLength(1);
    expect(feed.subscriberCount).toBe(0);
  });

  it("weist eine ungültige Last-Event-ID vor dem Abonnement zurück", async () => {
    const token = await grantWorldAccess(WORLD_LHE, "kc-livemap-invalid-resume");
    livemap.initializeWorld(WORLD_LHE, { at: 0, trains: [] });
    const feed = livemap.forWorld(WORLD_LHE);
    const response = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/livemap/events`,
      headers: { authorization: `Bearer ${token}`, "last-event-id": "keine-sequenz" },
    });
    expect(response.statusCode).toBe(400);
    expect(feed.subscriberCount).toBe(0);
  });

  it("liefert Replay und laufenden Fanout lückenlos und bereinigt bei Clientabbruch", async () => {
    const token = await grantWorldAccess(WORLD_LHE, "kc-livemap-resume");
    livemap.initializeWorld(WORLD_LHE, { at: 1, trains: [] });
    const feed = livemap.forWorld(WORLD_LHE);
    feed.publish({ at: 2, changed: [], removed: [] });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/worlds/${WORLD_LHE}/livemap/events`, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
        "last-event-id": `${feed.snapshot().streamId}:1`,
      },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (needle: string): Promise<void> => {
      while (!received.includes(needle)) {
        const result = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`SSE-Nachricht '${needle}' nicht empfangen.`)), 2_000);
          void reader.read().then(
            (value) => {
              clearTimeout(timeout);
              resolve(value);
            },
            (error: unknown) => {
              clearTimeout(timeout);
              reject(error);
            },
          );
        });
        if (result.done) throw new Error("Livemap-SSE endete unerwartet.");
        received += decoder.decode(result.value, { stream: true });
      }
    };

    await readUntil('"sequence":2');
    expect(feed.subscriberCount).toBe(1);
    feed.publish({ at: 3, changed: [], removed: [] });
    await readUntil('"sequence":3');

    controller.abort();
    await reader.cancel().catch(() => undefined);
    for (let attempt = 0; attempt < 20 && feed.subscriberCount !== 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(feed.subscriberCount).toBe(0);
  });

  it("stellt keinen parallelen Livemap-Ingest-Schreibweg bereit", async () => {
    const body = {
      at: 99,
      changed: [{ id: "sim-1", operator: "EVU", trainNumber: "IC 1", category: "long-distance", positionMm: 10, speedMmPerSecond: 3, delaySeconds: 4, nextOperatingPoint: "Leipzig", status: "running" }],
      removed: [],
    };
    const response = await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD_LHE}/livemap/deltas`,
      payload: body,
    });
    expect(response.statusCode).toBe(404);
    expect(livemap.isInitialized(WORLD_LHE)).toBe(false);
  });
});

describe("persistentes Simulations-Eventlog", () => {
  it("nimmt atomare Batches an, verweigert Lücken und stellt Replay bereit", async () => {
    const payload = {
      events: [
        { sequence: 1, eventType: "simulation.started", payload: { seed: 42 }, occurredAt: "2026-01-01T00:00:00.000Z" },
        { sequence: 2, eventType: "train.materialized", payload: { id: "1" }, occurredAt: "2026-01-01T00:00:01.000Z" },
      ],
    };
    const accepted = await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD_LHE}/simulation/events`,
      headers: { authorization: `Bearer ${SIMULATION_INGEST_TOKEN}` },
      payload,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ appended: 2, lastSequence: 2 });

    const gap = await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD_LHE}/simulation/events`,
      headers: { authorization: `Bearer ${SIMULATION_INGEST_TOKEN}` },
      payload: { events: [{ sequence: 4, eventType: "gap", payload: {}, occurredAt: "2026-01-01T00:00:02.000Z" }] },
    });
    expect(gap.statusCode).toBe(409);

    const token = await sign("event-reader", "Replay");
    const access = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${token}` }, payload: { displayName: "Replay", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } });
    expect(access.statusCode).toBe(201);
    const ownOperator = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/operators`, headers: { authorization: `Bearer ${token}` }, payload: { name: "Replay EVU" } });
    expect(ownOperator.statusCode).toBe(201);
    const foreignToken = await sign("event-foreign", "Konkurrenz");
    expect((await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${foreignToken}` }, payload: { displayName: "Konkurrenz", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } })).statusCode).toBe(201);
    const foreignOperator = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/operators`, headers: { authorization: `Bearer ${foreignToken}` }, payload: { name: "Konkurrenz EVU" } });
    expect(foreignOperator.statusCode).toBe(201);
    await worldEventLog(db, WORLD_LHE).appendBatch([
      { sequence: 3, eventType: "economy.settlement", payload: { operatorId: ownOperator.json<{ id: string }>().id, costCents: "1200" }, occurredAt: new Date("2026-01-01T00:00:02.000Z") },
      { sequence: 4, eventType: "economy.settlement", payload: { operatorId: foreignOperator.json<{ id: string }>().id, costCents: "987654", strategy: "foreign-secret" }, occurredAt: new Date("2026-01-01T00:00:03.000Z") },
      { sequence: 5, eventType: "planning.runtime-state", payload: { processedCommands: { private: true } }, occurredAt: new Date("2026-01-01T00:00:04.000Z") },
      { sequence: 6, eventType: "admin.action-audited", payload: { actorReference: "root", commandPayload: { private: true } }, occurredAt: new Date("2026-01-01T00:00:05.000Z") },
    ]);
    const replay = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/simulation/events?after=1&limit=10`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      schemaVersion: "zugfolge-simulation-event-projection/v1",
      after: 1,
      nextAfter: 6,
      events: [
        { sequence: 2, eventType: "train.materialized", visibility: "public", payload: { id: "1" } },
        { sequence: 3, eventType: "economy.settlement", visibility: "operator", payload: { costCents: "1200" } },
      ],
    });
    const serialized = replay.body;
    expect(serialized).not.toContain("987654");
    expect(serialized).not.toContain("foreign-secret");
    expect(serialized).not.toContain("processedCommands");
    expect(serialized).not.toContain("actorReference");

  });
});

describe("M3.10 Planner-Projektion und Alternativkommando", () => {
  async function grantPlanningAccess(subject: string, worldId = WORLD_LHE): Promise<string> {
    const token = await sign(subject, subject);
    const access = await app.inject({
      method: "POST",
      url: `/worlds/${worldId}/access`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: subject, acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });
    expect(access.statusCode).toBe(201);
    return token;
  }

  async function ingestPlanning(payload: unknown, sequence = 1): Promise<void> {
    await worldEventLog(db, WORLD_LHE).appendBatch([{
      sequence,
      eventType: "planning.diagram",
      payload,
      occurredAt: new Date(
        `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      ),
    }]);
  }

  it("liefert nur eine strikt validierte und an die URL-Welt gebundene Projektion", async () => {
    const token = await grantPlanningAccess("planning-reader");
    const projection = planningProjection();
    await ingestPlanning(projection);

    const response = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/planning/diagram`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sequence: 1,
      timeBasis: { epoch: expect.any(String), timeZone: "Europe/Berlin", operatingDayBoundaryS: 0 },
      data: projection,
    });

    const foreignToken = await grantPlanningAccess("planning-foreign", WORLD_MIDDLE_GERMANY);
    const denied = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/planning/diagram`,
      headers: { authorization: `Bearer ${foreignToken}` },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("verweigert ungueltige und in eine fremde Welt zeigende Eventlog-Projektionen", async () => {
    const token = await grantPlanningAccess("planning-invalid");
    await ingestPlanning({ ...planningProjection(), projectionRevision: 7.5 });
    const invalid = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/planning/diagram`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(invalid.statusCode).toBe(503);
    expect(invalid.json()).toMatchObject({ error: expect.stringMatching(/Format/) });

    await ingestPlanning(planningProjection(WORLD_MIDDLE_GERMANY), 2);
    const foreign = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/planning/diagram`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(foreign.statusCode).toBe(503);
    expect(foreign.json()).toMatchObject({ error: expect.stringMatching(/Welt/) });
  });

  it("weist den alten Clientvertrag, eine fremde Idempotenzkennung, stale Revisionen und unbekannte Angebote zurueck", async () => {
    const token = await grantPlanningAccess("planning-errors");
    await ingestPlanning(planningProjection());
    const url = `/worlds/${WORLD_LHE}/planning/alternatives`;
    const headers = { authorization: `Bearer ${token}` };

    const oldContract = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { idempotencyKey: "ui-1", trainId: "train-b", conflictId: "conflict-7", shiftMinutes: 3 },
    });
    expect(oldContract.statusCode).toBe(400);

    const invalidKey = await app.inject({
      method: "POST",
      url,
      headers,
      payload: {
        schemaVersion: "planning-alternative-command/v1",
        projectionRevision: 7,
        alternativeId: "alternative-7",
        idempotencyKey: "zufall-pro-retry",
      },
    });
    expect(invalidKey.statusCode).toBe(400);

    const stale = await app.inject({
      method: "POST",
      url,
      headers,
      payload: createPlanningAlternativeCommand(6, "alternative-7"),
    });
    expect(stale.statusCode).toBe(409);

    const unknown = await app.inject({
      method: "POST",
      url,
      headers,
      payload: createPlanningAlternativeCommand(7, "unknown-alternative"),
    });
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json()).toMatchObject({ error: "Planungsaktion ist nicht fuer den betroffenen Zug autorisiert." });
  });

  it("leitet das Queue-Kommando nur aus dem Serverangebot ab und behandelt Retries idempotent", async () => {
    const token = await grantPlanningAccess("planning-queue");
    const attackerToken = await grantPlanningAccess("planning-attacker");
    const [planningAccount] = await db.select().from(accounts).where(and(
      eq(accounts.worldId, WORLD_LHE),
      eq(accounts.keycloakSubject, "planning-queue"),
    )).limit(1);
    const [attackerAccount] = await db.select().from(accounts).where(and(
      eq(accounts.worldId, WORLD_LHE),
      eq(accounts.keycloakSubject, "planning-attacker"),
    )).limit(1);
    const planningOperatorId = "10000000-0000-4000-8000-000000000071";
    await db.insert(operators).values([
      { id: planningOperatorId, worldId: WORLD_LHE, foundingAccountId: planningAccount!.id, name: "Planning Queue EVU" },
      { id: "10000000-0000-4000-8000-000000000072", worldId: WORLD_LHE, foundingAccountId: planningAccount!.id, name: "Planning Queue Zweig" },
      { id: "10000000-0000-4000-8000-000000000073", worldId: WORLD_LHE, foundingAccountId: attackerAccount!.id, name: "Planning Attacker EVU" },
    ]);
    await db.insert(simulationCommands).values({
      worldId: WORLD_LHE,
      requestingAccountId: planningAccount!.id,
      idempotencyKey: "planning-path-request:train-b-owner",
      commandType: "planning.path-request",
      payload: { worldId: WORLD_LHE, requestingAccountId: planningAccount!.id, operatorId: planningOperatorId, trainId: "train-b" },
      status: "processed",
      submittedAt: new Date(0),
      processedAt: new Date(1_000),
      resultEventSequence: 1,
    });
    expect(await db.select({ id: operators.id }).from(operators).where(and(
      eq(operators.worldId, WORLD_LHE), eq(operators.foundingAccountId, planningAccount!.id),
    ))).toHaveLength(2);
    expect(await db.select({ id: simulationCommands.id }).from(simulationCommands).where(and(
      eq(simulationCommands.worldId, WORLD_LHE),
      eq(simulationCommands.requestingAccountId, planningAccount!.id),
      eq(simulationCommands.commandType, "planning.path-request"),
      eq(simulationCommands.status, "processed"),
      sql`${simulationCommands.payload}->>'trainId' = ${"train-b"}`,
    ))).toHaveLength(1);
    await ingestPlanning(planningProjection());
    const request = {
      method: "POST" as const,
      url: `/worlds/${WORLD_LHE}/planning/alternatives`,
      headers: { authorization: `Bearer ${token}` },
      payload: createPlanningAlternativeCommand(7, "alternative-7"),
    };
    const foreignTrain = await app.inject({ ...request, headers: { authorization: `Bearer ${attackerToken}` } });
    expect(foreignTrain.statusCode).toBe(403);
    expect(foreignTrain.json()).toMatchObject({ error: "Planungsaktion ist nicht fuer den betroffenen Zug autorisiert." });
    const first = await app.inject(request);
    const retry = await app.inject(request);
    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(202);
    const commandId = first.json<{ id: string }>().id;
    expect(retry.json<{ id: string }>().id).toBe(commandId);

    const queued = await app.inject({
      method: "GET",
      url: `/internal/worlds/${WORLD_LHE}/simulation/commands`,
      headers: { authorization: `Bearer ${SIMULATION_INGEST_TOKEN}` },
    });
    expect(queued.json()).toEqual([]);
    const [workerOwned] = await db
      .select()
      .from(simulationCommands)
      .where(eq(simulationCommands.id, commandId));
    expect(workerOwned).toMatchObject({
      id: commandId,
      worldId: WORLD_LHE,
      idempotencyKey: "alternative:7:alternative-7",
      commandType: "planning.apply-alternative",
      status: "pending",
      payload: {
        schemaVersion: "planning-apply-alternative/v1",
        projectionRevision: 7,
        alternativeId: "alternative-7",
        conflictId: "conflict-7",
        trainId: "train-b",
        departureShiftS: 180,
      },
    });
    expect(workerOwned!.payload).not.toHaveProperty("shiftMinutes");

    const acknowledged = await app.inject({
      method: "POST",
      url: `/internal/worlds/${WORLD_LHE}/simulation/commands/${commandId}/result`,
      headers: { authorization: `Bearer ${SIMULATION_INGEST_TOKEN}` },
      payload: { status: "processed", resultEventSequence: 2, processedAt: "2026-01-01T00:00:02.000Z" },
    });
    expect(acknowledged.statusCode).toBe(409);
    expect(acknowledged.json()).toMatchObject({ code: "reserved_planning_command_type" });

    await ingestPlanning(planningProjection(WORLD_LHE, 8, null), 2);
    const reloaded = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/planning/diagram`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json()).toMatchObject({ sequence: 2, data: { projectionRevision: 8, conflicts: [] } });
  });
});

describe("GET /health/ready", () => {
  it("meldet den aggregierten Zustand aller Health Checks ohne Authentifizierung", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      checks: [{ name: "postgres", status: "ok", code: "schema_current", durationMs: expect.any(Number) }],
    });
  });

  it("nimmt zusätzliche Health Checks künftiger Milestones in die Aggregation auf", async () => {
    const appMitErweiterung = buildApp({
      db,
      verifyToken: (token) => verifyIdentityToken(token, createLocalJWKSet({ keys: [] }), { issuer: ISSUER, audience: AUDIENCE }),
      extraHealthChecks: [{ name: "beispiel", check: async () => ({ status: "degraded", detail: "Testfall" }) }],
    });
    await appMitErweiterung.ready();
    try {
      const response = await appMitErweiterung.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "degraded",
        checks: expect.arrayContaining([{ name: "beispiel", status: "degraded", detail: "Testfall", durationMs: expect.any(Number) }]),
      });
    } finally {
      await appMitErweiterung.close();
    }
  });

  it("antwortet mit 503, sobald eine Prüfung ausfällt", async () => {
    const appMitAusfall = buildApp({
      db,
      verifyToken: (token) => verifyIdentityToken(token, createLocalJWKSet({ keys: [] }), { issuer: ISSUER, audience: AUDIENCE }),
      extraHealthChecks: [
        {
          name: "ausfall",
          check: async () => {
            throw new Error("nicht erreichbar");
          },
        },
      ],
    });
    await appMitAusfall.ready();
    try {
      const response = await appMitAusfall.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json().status).toBe("down");
      expect(response.body).not.toContain("nicht erreichbar");
    } finally {
      await appMitAusfall.close();
    }
  });
});

describe("Weltzugang und Kontoliste", () => {
  it("lehnt eine Anfrage ohne Zugriffstoken ab", async () => {
    const response = await app.inject({ method: "GET", url: `/worlds/${WORLD_LHE}/accounts` });
    expect(response.statusCode).toBe(401);
  });

  it("lässt zwei Konten derselben Welt einander sehen, ein drittes aus einer anderen Welt nicht", async () => {
    const annaToken = await sign("kc-anna", "Anna");
    const benToken = await sign("kc-ben", "Ben");
    const claraToken = await sign("kc-clara", "Clara");

    for (const [token, worldId, displayName] of [
      [annaToken, WORLD_LHE, "Anna"],
      [benToken, WORLD_LHE, "Ben"],
      [claraToken, WORLD_MIDDLE_GERMANY, "Clara"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/worlds/${worldId}/access`,
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName, acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
      });
      expect(response.statusCode).toBe(201);
    }

    const roster = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/accounts`,
      headers: { authorization: `Bearer ${annaToken}` },
    });

    expect(roster.statusCode).toBe(200);
    const names = roster.json<{ displayName: string }[]>().map((account) => account.displayName);
    expect(names.sort()).toEqual(["Anna", "Ben"]);
    expect(roster.json<Record<string, unknown>[]>().every((account) => !("keycloakSubject" in account))).toBe(true);
  });

  it("verweigert die Kontoliste einem Konto ohne Zugang zu dieser Welt", async () => {
    const outsiderToken = await sign("kc-fremd", "Fremd");

    const response = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/accounts`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("Rollenvergabe", () => {
  it("macht das erste Konto einer Welt zum Weltverwalter und lässt es weitere Rollen vergeben", async () => {
    const adminToken = await sign("kc-admin", "Admin");
    const playerToken = await sign("kc-spieler", "Spieler");

    const adminAccess = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { displayName: "Admin", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });
    const adminId = adminAccess.json<{ id: string }>().id;

    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${adminId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "world_admin" },
    });

    const playerAccessResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${playerToken}` },
      payload: { displayName: "Spieler", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });
    const playerId = playerAccessResponse.json<{ id: string }>().id;

    const grantResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${playerId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "world_admin" },
    });

    expect(grantResponse.statusCode).toBe(200);
    expect(grantResponse.json<{ roles: string[] }>().roles.sort()).toEqual(["player", "world_admin"]);
  });

  it("verweigert die Rollenvergabe einem Konto ohne Weltverwalter-Rolle", async () => {
    const playerToken = await sign("kc-spieler", "Spieler");
    const accessResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${playerToken}` },
      payload: { displayName: "Spieler", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });
    const playerId = accessResponse.json<{ id: string }>().id;

    const otherToken = await sign("kc-anders", "Anders");
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { displayName: "Anders", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });

    const response = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${playerId}/roles`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { role: "world_admin" },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("EVU (M2.3)", () => {
  it("gründet ein EVU und listet es in der Welt", async () => {
    const annaToken = await sign("kc-anna", "Anna");
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${annaToken}` },
      payload: { displayName: "Anna", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });

    const foundResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators`,
      headers: { authorization: `Bearer ${annaToken}` },
      payload: { name: "Elbtalbahn" },
    });
    expect(foundResponse.statusCode).toBe(201);

    const roster = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/operators`,
      headers: { authorization: `Bearer ${annaToken}` },
    });
    expect(roster.json<{ name: string }[]>().map((operator) => operator.name)).toEqual(["Elbtalbahn"]);
  });

  it("lehnt die Gründung ohne Weltzugang ab", async () => {
    const fremdToken = await sign("kc-fremd2", "Fremd");
    const response = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators`,
      headers: { authorization: `Bearer ${fremdToken}` },
      payload: { name: "Phantom-Bahn" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("laesst einen normalen EVU-Eigentuemer weder Rohkonten noch Geldpraegungsbuchungen erzeugen", async () => {
    const token = await sign("kc-ledger-player", "Ledger-Spieler");
    await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/access`, headers: { authorization: `Bearer ${token}` }, payload: { displayName: "Ledger-Spieler", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH } });
    const founded = await app.inject({ method: "POST", url: `/worlds/${WORLD_LHE}/operators`, headers: { authorization: `Bearer ${token}` }, payload: { name: "Spieler-Bahn" } });
    const operatorId = founded.json<{ id: string }>().id;
    const directAccount = await app.inject({
      method: "POST", url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`, headers: { authorization: `Bearer ${token}` }, payload: { name: "Fantasie-Gegenkonto" },
    });
    expect(directAccount.statusCode).toBe(403);
    const cash = (await listLedgerAccounts(db, { worldId: WORLD_LHE, operatorId }))
      .find((account) => account.name === "Economy:Kasse");
    expect(cash).toBeDefined();
    const fantasy = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Economy:Test-Gegenkonto" });
    const mint = await app.inject({
      method: "POST", url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/transactions`, headers: { authorization: `Bearer ${token}` },
      payload: { description: "Geldpraegung", entries: [{ ledgerAccountId: cash!.id, amountCents: "100000000" }, { ledgerAccountId: fantasy.id, amountCents: "-100000000" }] },
    });
    expect(mint.statusCode).toBe(403);
    const operatorTransactions = await db.select().from(ledgerTransactions).where(and(
      eq(ledgerTransactions.worldId, WORLD_LHE),
      eq(ledgerTransactions.operatorId, operatorId),
    ));
    expect(operatorTransactions).toHaveLength(1);
    expect(operatorTransactions[0]?.description).toBe(`Startkapital aus Weltvertrag ${TEST_WORLD_CONTRACT_HASH}`);
    expect(operatorTransactions.some((transaction) => transaction.description === "Geldpraegung")).toBe(false);
  });
});

describe("Ledger-Kern (M2.4)", () => {
  async function gruendeElbtalbahn(): Promise<{ token: string; operatorId: string }> {
    const token = await sign("kc-ledger", "Ledger-Anna");
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Ledger-Anna", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });
    const founded = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Ledger-Bahn" },
    });
    const [account] = await db.select().from(accounts).where(and(
      eq(accounts.worldId, WORLD_LHE),
      eq(accounts.keycloakSubject, "kc-ledger"),
    )).limit(1);
    await db.insert(accountRoles).values({ worldId: WORLD_LHE, accountId: account!.id, role: "world_admin" });
    return { token, operatorId: founded.json<{ id: string }>().id };
  }

  it("eröffnet Ledger-Konten, bucht eine ausgeglichene Transaktion und zeigt die Salden", async () => {
    const { token, operatorId } = await gruendeElbtalbahn();

    const kasse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Kasse" },
    });
    const entgelt = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Trassenentgelt" },
    });
    const kasseId = kasse.json<{ id: string }>().id;
    const entgeltId = entgelt.json<{ id: string }>().id;

    const transactionResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        description: "Trassenentgelt Januar",
        entries: [
          { ledgerAccountId: kasseId, amountCents: "-1234" },
          { ledgerAccountId: entgeltId, amountCents: "1234" },
        ],
      },
    });
    expect(transactionResponse.statusCode).toBe(201);

    const accountsWithBalance = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${token}` },
    });
    const balances = accountsWithBalance.json<{ id: string; balanceCents: string }[]>();
    expect(balances.find((account) => account.id === kasseId)?.balanceCents).toBe("-1234");
    expect(balances.find((account) => account.id === entgeltId)?.balanceCents).toBe("1234");
  });

  it("lehnt eine unausgeglichene Transaktion ab", async () => {
    const { token, operatorId } = await gruendeElbtalbahn();
    const kasse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Kasse" },
    });
    const entgelt = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Trassenentgelt" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        description: "Unausgeglichen",
        entries: [
          { ledgerAccountId: kasse.json<{ id: string }>().id, amountCents: "-100" },
          { ledgerAccountId: entgelt.json<{ id: string }>().id, amountCents: "50" },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("verweigert ein fremdes Konto den Zugriff auf die Bücher eines EVU", async () => {
    const { operatorId } = await gruendeElbtalbahn();
    const fremdToken = await sign("kc-fremd3", "Fremd");
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${fremdToken}` },
      payload: { displayName: "Fremd", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });

    const response = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators/${operatorId}/ledger/accounts`,
      headers: { authorization: `Bearer ${fremdToken}` },
      payload: { name: "Kasse" },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("Postfach (M2.5)", () => {
  it("stellt eine Nachricht zu, listet sie im Postfach und quittiert sie", async () => {
    const adminToken = await sign("kc-postadmin", "Postadmin");
    const adminAccess = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { displayName: "Postadmin", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });
    const adminId = adminAccess.json<{ id: string }>().id;
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${adminId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "world_admin" },
    });

    const spielerToken = await sign("kc-postspieler", "Postspieler");
    const spielerAccess = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${spielerToken}` },
      payload: { displayName: "Postspieler", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });
    const spielerId = spielerAccess.json<{ id: string }>().id;

    const sendResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${spielerId}/mailbox`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { messageType: "system.willkommen", payload: { text: "Willkommen" } },
    });
    expect(sendResponse.statusCode).toBe(201);

    const inbox = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/mailbox`,
      headers: { authorization: `Bearer ${spielerToken}` },
    });
    const messages = inbox.json<{ id: string; acknowledgedAt: string | null; priority: string; overdue: boolean }[]>();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.acknowledgedAt).toBeNull();
    expect(messages[0]).toMatchObject({ priority: "information", overdue: false });

    const ackResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/mailbox/${messages[0]!.id}/ack`,
      headers: { authorization: `Bearer ${spielerToken}` },
    });
    expect(ackResponse.statusCode).toBe(200);
    expect(ackResponse.json<{ acknowledgedAt: string | null; priority: string }>() ).toMatchObject({ priority: "acknowledged" });
    expect(ackResponse.json<{ acknowledgedAt: string | null }>().acknowledgedAt).not.toBeNull();
  });

  it("verweigert den Versand einer Nachricht ohne Weltverwalter-Rolle", async () => {
    const spielerToken = await sign("kc-postspieler2", "Postspieler2");
    const spielerAccess = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${spielerToken}` },
      payload: { displayName: "Postspieler2", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });
    const spielerId = spielerAccess.json<{ id: string }>().id;

    const response = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/accounts/${spielerId}/mailbox`,
      headers: { authorization: `Bearer ${spielerToken}` },
      payload: { messageType: "system.willkommen", payload: {} },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("Datenschutz (M2.6)", () => {
  it("liefert die eigene Auskunft und erlaubt die Selbstlöschung", async () => {
    const token = await sign("kc-privacy", "Privacy-Anna");
    await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Privacy-Anna", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });

    const exportResponse = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/me/export`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.json<{ account: { displayName: string } }>().account.displayName).toBe("Privacy-Anna");

    const eraseResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/me/erase`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(eraseResponse.statusCode).toBe(200);
    expect(eraseResponse.json<{ displayName: string }>().displayName).toBe("Gelöschtes Konto");

    const reaccessResponse = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/access`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Privacy-Anna", acceptedWorldContractHash: TEST_WORLD_CONTRACT_HASH },
    });
    expect(reaccessResponse.statusCode).toBe(403);

    const rosterAfterErase = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/accounts`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rosterAfterErase.statusCode).toBe(403);

    const operatorAfterErase = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD_LHE}/operators`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Darf nicht entstehen" },
    });
    expect(operatorAfterErase.statusCode).toBe(403);
  });

  it("verweigert die Auskunft ohne Konto in der Welt", async () => {
    const fremdToken = await sign("kc-privacyfremd", "Fremd");
    const response = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD_LHE}/me/export`,
      headers: { authorization: `Bearer ${fremdToken}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
