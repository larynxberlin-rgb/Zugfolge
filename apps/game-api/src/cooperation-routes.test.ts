import { PGlite } from "@electric-sql/pglite";
import { CooperationService } from "@zugfolge/cooperation";
import {
  accounts,
  dailyOperationReports,
  domainEvents,
  economyWorldStates,
  fleetWorldCheckpoints,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  mailboxMessages,
  MIGRATIONS_FOLDER,
  operators,
  regionalSimulationStates,
  vehicleAssetHistoryEvents,
  vehicleAssets,
  worldAccesses,
  worlds,
} from "@zugfolge/db";
import { encodeEconomyValue } from "@zugfolge/economy";
import type { FleetAuthorityRelease } from "@zugfolge/runtime-native";
import * as schema from "@zugfolge/db/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { GameCooperationAuthority } from "./cooperation-authority.js";

const WORLD = "11111111-1111-1111-1111-111111111111";
const EPOCH = new Date("2026-12-13T00:00:00.000Z");

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let cooperation: CooperationService;
let app: ReturnType<typeof buildApp>;
let sellerAccountId: string;
let buyerAccountId: string;
let sellerOperatorId: string;
let buyerOperatorId: string;
let nowS: number;
let authorityRelease: FleetAuthorityRelease;

beforeEach(async () => {
  nowS = 100;
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values({ id: WORLD, name: "Mitteldeutschland", schedulePeriodWeeks: 4, epoch: EPOCH });
  await db.insert(worldAccesses).values([
    { worldId: WORLD, keycloakSubject: "seller" },
    { worldId: WORLD, keycloakSubject: "buyer" },
  ]);
  [sellerAccountId, buyerAccountId] = (await db.insert(accounts).values([
    { worldId: WORLD, keycloakSubject: "seller", displayName: "Seller" },
    { worldId: WORLD, keycloakSubject: "buyer", displayName: "Buyer" },
  ]).returning()).map((row) => row.id);
  [sellerOperatorId, buyerOperatorId] = (await db.insert(operators).values([
    { worldId: WORLD, foundingAccountId: sellerAccountId, name: "Seller Rail" },
    { worldId: WORLD, foundingAccountId: buyerAccountId, name: "Buyer Rail" },
  ]).returning()).map((row) => row.id);
  await db.insert(economyWorldStates).values({
    worldId: WORLD,
    revision: 0,
    state: encodeEconomyValue({
      worldId: WORLD,
      revision: 0,
      operatorRestrictions: new Map(),
      insolventOperators: new Set(),
      tenderAutomation: new Map(),
      operatingRuntimeByLot: new Map(),
    }) as never,
    updatedAt: EPOCH,
  });
  authorityRelease = {
    schemaVersion: "zugfolge-fleet-authority-release/v1", releaseId: "fleet-md-v1", referenceYear: 2026, assets: [],
    personnelPools: [{ id: "pool-1", numericId: 1, operatorId: sellerOperatorId, capacitySeconds: 28_800, minimumRestSeconds: 39_600, classDesignations: ["442"], pathReceiptIds: ["path-1"], qualificationHash: "a".repeat(64) }],
    pathReceipts: [{ id: "path-1", numericRouteId: 1, operatorId: sellerOperatorId, serviceLineIds: ["RE 12"], decision: "confirmed", validFrom: 0, validUntil: 86_400, platformLengthsMm: [210_000], electrifications: ["overhead-ac15kv"], requiredProtection: ["pzb"], approvedClasses: ["442"], plannerStateHash: "b".repeat(64), conflictCheckHash: "c".repeat(64) }],
  };
  await db.insert(ledgerAccounts).values([
    { worldId: WORLD, operatorId: sellerOperatorId, name: "Economy:Kasse" },
    { worldId: WORLD, operatorId: buyerOperatorId, name: "Economy:Kasse" },
  ]);
  cooperation = new CooperationService(db, undefined, {
    async apply(_tx, intent) {
      expect(intent.transferReceiptHash).toMatch(/^[a-f0-9]{64}$/);
      return { resultingStateHash: "f".repeat(64), resultingRevision: 1 };
    },
  });
  await cooperation.registerVehicle({
    worldId: WORLD,
    vehicleId: "vehicle-1",
    authorityReleaseId: "fleet-md-v1",
    classDesignation: "442",
    actualConfiguration: { seats: 220, protection: ["pzb"] },
    ownerOperatorId: sellerOperatorId,
    odometerMetres: 1_000n,
    conditionBasisPoints: 9_000,
    damages: [],
    maintenanceDeadlines: [{ kind: "inspection", dueAtS: 10_000 }],
    approvals: ["line-md-1"],
    operatingLimits: ["15kv"],
    valuationSpecId: "economy-md-v1:used",
    valueCents: 100_000_000n,
    acquiredAtS: 0,
  });
  await cooperation.registerVehicle({
    worldId: WORLD,
    vehicleId: "vehicle-held",
    authorityReleaseId: "fleet-md-v1",
    classDesignation: "463",
    actualConfiguration: { seats: 430, protection: ["pzb"] },
    ownerOperatorId: buyerOperatorId,
    odometerMetres: 2_000n,
    conditionBasisPoints: 8_800,
    damages: [], maintenanceDeadlines: [], approvals: ["line-md-1"], operatingLimits: ["15kv"],
    valuationSpecId: "economy-md-v1:used", valueCents: 120_000_000n, acquiredAtS: 0,
  });
  await db.update(vehicleAssets).set({ holderOperatorId: sellerOperatorId }).where(eq(vehicleAssets.vehicleId, "vehicle-held"));
  app = buildApp({
    db,
    cooperation,
    verifyToken: async (token) => ({ keycloakSubject: token, displayName: token }),
    cooperationSimulationSecond: async (worldId) => {
      expect(worldId).toBe(WORLD);
      return nowS;
    },
    fleetAuthorityReleases: { [WORLD]: authorityRelease },
    logger: false,
  });
}, 30_000);

afterEach(async () => {
  await app.close();
  await client.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function fundBuyer(amountCents: bigint, key: string): Promise<void> {
  const [bank] = await db.select().from(ledgerAccounts).where(and(
    eq(ledgerAccounts.worldId, WORLD), eq(ledgerAccounts.operatorId, buyerOperatorId), eq(ledgerAccounts.name, "Economy:Kasse"),
  )).limit(1);
  const [equity] = await db.insert(ledgerAccounts).values({
    worldId: WORLD, operatorId: buyerOperatorId, name: `Startkapital:${key}`,
  }).returning();
  const [transaction] = await db.insert(ledgerTransactions).values({
    worldId: WORLD, operatorId: buyerOperatorId, idempotencyKey: `fund:${key}`,
    description: "Autoritatives Test-Startkapital", postedAt: EPOCH,
  }).returning();
  await db.insert(ledgerEntries).values([
    { worldId: WORLD, transactionId: transaction!.id, ledgerAccountId: bank!.id, amountCents },
    { worldId: WORLD, transactionId: transaction!.id, ledgerAccountId: equity!.id, amountCents: -amountCents },
  ]);
}

describe("M12 HTTP-Integration", () => {
  it("fordert fuer jede bestaetigte Kooperation-Aktion einen Client-Idempotenzschluessel", async () => {
    const targetId = "99999999-9999-4999-8999-999999999999";
    const responses = await Promise.all([
      app.inject({ method: "POST", url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${targetId}/respond`, headers: auth("buyer"), payload: { response: "accept" } }),
      app.inject({ method: "POST", url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${targetId}/end`, headers: auth("buyer"), payload: { reason: "Ordentliche Beendigung" } }),
      app.inject({ method: "POST", url: `/worlds/${WORLD}/vehicle-market/listings/${targetId}/reserve`, headers: auth("buyer"), payload: { buyerOperatorId, expectedRevision: 1 } }),
      app.inject({ method: "POST", url: `/worlds/${WORLD}/operators/${sellerOperatorId}/vehicle-market/listings/${targetId}/cancel`, headers: auth("seller"), payload: { expectedRevision: 1 } }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400, 400]);
  });

  it("akzeptiert Nichterfüllung nicht mehr als Client-Boolean und verlangt eine Belegreferenz", async () => {
    const targetId = "99999999-9999-4999-8999-999999999999";
    const legacyBoolean = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${targetId}/end`,
      headers: auth("buyer"),
      payload: { reason: "Behauptete Nichterfüllung", nonPerformance: true, idempotencyKey: "legacy-boolean" },
    });
    expect(legacyBoolean.statusCode).toBe(400);

    const missingEvidence = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${targetId}/non-performance`,
      headers: auth("buyer"),
      payload: { reason: "Behauptete Nichterfüllung", idempotencyKey: "missing-evidence" },
    });
    expect(missingEvidence.statusCode).toBe(400);
  });

  it("vollzieht Nichterfüllung über HTTP nur mit exakt gebundenem Tagesbericht und replayt sie", async () => {
    const offered = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${sellerOperatorId}/contracts`,
      headers: auth("seller"),
      payload: {
        offereeOperatorId: buyerOperatorId,
        contractType: "traction",
        subject: { trainRunIds: ["train-proof"], formationIds: ["formation-proof"], personnelDutyIds: ["duty-proof"], pathReceiptIds: ["path-proof"] },
        terms: { scope: "traction" }, priceCents: "0", validFromS: 300, validUntilS: 3_600,
        responseDeadlineS: 200, terminationNoticeS: 600, idempotencyKey: "http-evidence-contract",
      },
    });
    const contractId = offered.json().id as string;
    expect((await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${contractId}/respond`,
      headers: auth("buyer"), payload: { response: "accept", idempotencyKey: "http-evidence-accept" },
    })).statusCode).toBe(200);
    await cooperation.advanceContracts(WORLD, 300);
    const existingEvents = await db.select({ sequence: domainEvents.sequence }).from(domainEvents);
    const sequence = Math.max(0, ...existingEvents.map((event) => event.sequence)) + 1;
    const serviceDay = "2026-12-13";
    await db.insert(domainEvents).values({
      worldId: WORLD, sequence, eventType: "operations.train-outcome",
      occurredAt: new Date(EPOCH.getTime() + 500_000),
      payload: { operatorId: sellerOperatorId, contractId, trainRunId: "train-proof", status: "cancelled" },
    });
    await db.insert(dailyOperationReports).values({
      worldId: WORLD, operatorId: sellerOperatorId, serviceDay,
      sourceFromSequence: sequence, sourceThroughSequence: sequence,
      projection: {
        schema: "daily-operations-report/v1", serviceDay,
        sourceFromSequence: sequence, sourceThroughSequence: sequence,
        contracts: { [contractId]: { trainRuns: { total: 1, punctual: 0, cancelled: 1, trainKm: "0", missingSeats: 0, missedConnections: 0 }, settlements: { costCents: "0", contractPenaltyCents: "0" } } },
        facts: { eventSequences: [sequence], decisions: [] },
      },
      generatedAt: new Date(EPOCH.getTime() + 501_000),
    });
    nowS = 600;
    const request = () => app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${contractId}/non-performance`,
      headers: auth("buyer"),
      payload: { reason: "Belegter Ausfall der vereinbarten Zugleistung", evidenceReference: `daily-operation-report/v1:${serviceDay}`, idempotencyKey: "http-evidence-end" },
    });
    const ended = await request();
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json()).toMatchObject({
      status: "non-performance",
      terminationEvidenceReference: `daily-operation-report/v1:${serviceDay}`,
      terminationRuleVersion: "zugfolge-contract-non-performance-rule/v1",
    });
    nowS = 601;
    const replay = await request();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: contractId, revision: ended.json().revision, status: "non-performance" });
  });

  it("liefert einen welt- und EVU-gebundenen Ressourcenkatalog mit Fachlabels", async () => {
    await db.insert(worldAccesses).values({ worldId: WORLD, keycloakSubject: "third" });
    const [thirdAccount] = await db.insert(accounts).values({
      worldId: WORLD, keycloakSubject: "third", displayName: "Third",
    }).returning();
    const [thirdOperator] = await db.insert(operators).values({
      worldId: WORLD, foundingAccountId: thirdAccount!.id, name: "Third Rail",
    }).returning();
    await cooperation.registerVehicle({
      worldId: WORLD, vehicleId: "vehicle-bound", authorityReleaseId: "fleet-md-v1", classDesignation: "1442",
      actualConfiguration: { seats: 220 }, ownerOperatorId: sellerOperatorId, odometerMetres: 3_000n,
      conditionBasisPoints: 8_500, damages: [], maintenanceDeadlines: [], approvals: ["line-md-1"], operatingLimits: ["15kv"],
      valuationSpecId: "economy-md-v1:used", valueCents: 110_000_000n, acquiredAtS: 0,
    });
    await db.update(vehicleAssets).set({ bindings: { formations: [], contracts: ["existing-contract"], workshop: [], security: [] } }).where(and(
      eq(vehicleAssets.worldId, WORLD), eq(vehicleAssets.vehicleId, "vehicle-bound"),
    ));
    await db.insert(fleetWorldCheckpoints).values({
      worldId: WORLD, revision: 0, stateSchema: "zugfolge-fleet-world-state/v2",
      state: {
        formations: { "formation-1": { id: "formation-1", vehicleIds: ["vehicle-1"], pathReceiptId: "path-1" } },
        personnelDuties: { "duty-1": { id: "duty-1", personnelPoolId: "pool-1", formationIds: ["formation-1"], pathReceiptId: "path-1", validFrom: 0, validUntil: 86_400 } },
        pathReservations: {},
      },
      stateHash: "d".repeat(64), snapshotHash: "e".repeat(64), producedAt: EPOCH, ingestedAt: EPOCH,
    });
    await db.insert(regionalSimulationStates).values({
      worldId: WORLD, regionId: "md", stateSchema: "zugfolge-operational-simulation-state/v2",
      state: { trains: [
        { id: "run-seller", operator: sellerOperatorId, trainNumber: "RE 12", category: "regional", status: "planned", nextOperatingPoint: "Halle Hbf" },
        { id: "run-buyer", operator: buyerOperatorId, trainNumber: "S 5", category: "regional", status: "running", nextOperatingPoint: "Leipzig Hbf" },
        { id: "run-third", operator: thirdOperator!.id, trainNumber: "IC 9", category: "long-distance", status: "planned", nextOperatingPoint: "Erfurt Hbf" },
      ] },
      initializationHash: "e".repeat(64),
      stateHash: "f".repeat(64), revision: 0, publisherSequence: 0, createdAt: EPOCH, updatedAt: EPOCH,
    });
    await db.insert(domainEvents).values({
      worldId: WORLD, sequence: 10_000, eventType: "disruption.applied", occurredAt: EPOCH,
      payload: { disruptionId: "disruption-1", operatorIds: [sellerOperatorId], fineCauseLabel: "Weichenstörung", effect: "closure", affectedResource: "Leipzig Hbf" },
    });

    const response = await app.inject({ method: "GET", url: `/worlds/${WORLD}/operators/${sellerOperatorId}/cooperation-resources`, headers: auth("seller") });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: "zugfolge-cooperation-resource-catalog/v1", worldId: WORLD, operatorId: sellerOperatorId, fleetRevision: 0,
      trainRuns: [{ id: "run-seller", label: "RE 12 nach Halle Hbf" }],
      formations: [{ id: "formation-1", label: "Formation für RE 12" }],
      personnelDuties: [{ id: "duty-1" }], pathReceipts: [{ id: "path-1", label: "Trasse RE 12" }],
      disruptions: [{ id: "disruption-1", label: "Weichenstörung" }],
      rentableVehicles: [{ id: "vehicle-1", label: "Baureihe 442" }],
    });
    expect(response.json().trainRuns).toHaveLength(1);
    expect(response.json().connectionTrainRuns).toHaveLength(3);
    expect(response.json().rentableVehicles).toHaveLength(1);
    expect(response.json().assistanceVehicles).toHaveLength(3);
    expect(response.json().assistanceVehicles.map((entry: { id: string }) => entry.id)).toEqual(["vehicle-bound", "vehicle-1", "vehicle-held"]);
    expect(JSON.stringify(response.json())).not.toContain(buyerAccountId);

    const foreign = await app.inject({ method: "GET", url: `/worlds/${WORLD}/operators/${sellerOperatorId}/cooperation-resources`, headers: auth("buyer") });
    expect(foreign.statusCode).toBe(403);

    const authority = new GameCooperationAuthority(db, { [WORLD]: authorityRelease });
    const offer = (contractType: "traction" | "connection" | "disruption-assistance", subject: Readonly<Record<string, unknown>>) => ({
      worldId: WORLD, offerorOperatorId: sellerOperatorId, offereeOperatorId: buyerOperatorId,
      offeredByAccountId: sellerAccountId, contractType, subject, terms: {}, priceCents: 0n,
      validFromS: 300, validUntilS: 3_600, responseDeadlineS: 200, terminationNoticeS: 600,
      offeredAtS: 100, idempotencyKey: `resource-authority-${contractType}`,
    });
    await expect(authority.verifyContract(offer("traction", {
      trainRunIds: ["run-seller"], formationIds: ["formation-1"], personnelDutyIds: ["duty-1"], pathReceiptIds: ["path-1"],
    }))).resolves.toMatchObject({ permitted: true });
    await expect(authority.verifyContract(offer("traction", {
      trainRunIds: ["run-buyer"], formationIds: ["formation-1"], personnelDutyIds: ["duty-1"], pathReceiptIds: ["path-1"],
    }))).resolves.toMatchObject({ permitted: false, code: "train_run_ownership" });
    await expect(authority.verifyContract(offer("connection", {
      connections: [{ arrivalTrainRunId: "run-buyer", onwardTrainRunId: "run-seller", maxWaitSeconds: 300 }],
    }))).resolves.toMatchObject({ permitted: true });
    for (const connections of [
      [{ arrivalTrainRunId: "run-seller", onwardTrainRunId: "run-buyer", maxWaitSeconds: 300 }],
      [{ arrivalTrainRunId: "run-third", onwardTrainRunId: "run-seller", maxWaitSeconds: 300 }],
    ]) {
      await expect(authority.verifyContract(offer("connection", { connections })))
        .resolves.toMatchObject({ permitted: false, code: "train_run_ownership" });
    }
    await expect(authority.verifyContract(offer("disruption-assistance", {
      disruptionId: "disruption-1", trainRunIds: ["run-seller"], vehicleIds: ["vehicle-1"],
    }))).resolves.toMatchObject({ permitted: true });
    await expect(authority.verifyContract(offer("disruption-assistance", {
      disruptionId: "disruption-1", trainRunIds: ["run-third"], vehicleIds: ["vehicle-1"],
    }))).resolves.toMatchObject({ permitted: false, code: "train_run_ownership" });

    await db.insert(domainEvents).values({
      worldId: WORLD,
      sequence: 10_001,
      eventType: "disruption.cleared",
      occurredAt: new Date(EPOCH.getTime() + 1_000),
      payload: {
        schemaVersion: "zugfolge-operational-disruption-event/v2",
        disruptionId: "disruption-1",
        operatorIds: [sellerOperatorId],
        action: "clear_disruption",
        releaseReference: "repair-order:42",
      },
    });
    const afterClear = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD}/operators/${sellerOperatorId}/cooperation-resources`,
      headers: auth("seller"),
    });
    expect(afterClear.statusCode).toBe(200);
    expect(afterClear.json().disruptions).toEqual([]);
    await expect(authority.verifyContract(offer("disruption-assistance", {
      disruptionId: "disruption-1", trainRunIds: ["run-seller"], vehicleIds: ["vehicle-1"],
    }))).resolves.toMatchObject({ permitted: false, code: "disruption_missing" });
  });

  it("verwirft clientseitige Aktionszeiten und persistiert ausschließlich die injizierte Weltzeit", async () => {
    const manipulated = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${sellerOperatorId}/vehicles/vehicle-1/listings`,
      headers: auth("seller"),
      payload: { listingType: "sale", priceCents: "1", listedAtS: 0, expiresAtS: 1_000, idempotencyKey: "client-time" },
    });
    expect(manipulated.statusCode).toBe(400);

    const accepted = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${sellerOperatorId}/vehicles/vehicle-1/listings`,
      headers: auth("seller"),
      payload: { listingType: "sale", priceCents: "1", expiresAtS: 1_000, idempotencyKey: "server-time" },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ schemaVersion: "zugfolge-vehicle-market-listing/v1", listedAtS: 100 });
  });

  it("schließt einen Traktionsvertrag durch zwei getrennt authentifizierte EVU", async () => {
    await fundBuyer(500_000n, "api-contract");
    const offered = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${sellerOperatorId}/contracts`,
      headers: auth("seller"),
      payload: {
        offereeOperatorId: buyerOperatorId,
        contractType: "traction",
        subject: { trainRunIds: ["train-1"], formationIds: ["formation-1"], personnelDutyIds: ["duty-1"], pathReceiptIds: ["path-1"] },
        terms: { scope: "traction" },
        priceCents: "250000",
        validFromS: 300,
        validUntilS: 3_600,
        responseDeadlineS: 200,
        terminationNoticeS: 600,
        idempotencyKey: "api-contract-1",
      },
    });
    expect(offered.statusCode).toBe(201);
    expect(offered.json()).toMatchObject({ schemaVersion: "zugfolge-operator-contract/v1", status: "offered", priceCents: "250000" });

    const accepted = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${offered.json().id as string}/respond`,
      headers: auth("buyer"),
      payload: { response: "accept", idempotencyKey: "api-contract-response-1" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: "accepted", offereeOperatorId: buyerOperatorId });

    const foreign = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts`,
      headers: auth("seller"),
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("entscheidet Antworten vor, auf und nach der Frist ausschließlich mit serverseitiger Weltzeit", async () => {
    const offerForBoundary = async (suffix: string): Promise<string> => {
      nowS = 100;
      const response = await app.inject({
        method: "POST",
        url: `/worlds/${WORLD}/operators/${sellerOperatorId}/contracts`,
        headers: auth("seller"),
        payload: {
          offereeOperatorId: buyerOperatorId,
          contractType: "connection",
          subject: { connections: [{ arrivalTrainRunId: `RE-${suffix}`, onwardTrainRunId: `S-${suffix}`, maxWaitSeconds: 300 }] },
          terms: { scope: "connection" }, priceCents: "0", validFromS: 300, validUntilS: 3_600,
          responseDeadlineS: 200, terminationNoticeS: 600, idempotencyKey: `deadline-${suffix}`,
        },
      });
      expect(response.statusCode).toBe(201);
      return response.json().id as string;
    };
    const respond = (contractId: string, suffix: string) => app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${contractId}/respond`,
      headers: auth("buyer"),
      payload: { response: "accept", idempotencyKey: `deadline-response-${suffix}` },
    });

    const before = await offerForBoundary("before");
    nowS = 199;
    expect((await respond(before, "before")).statusCode).toBe(200);
    const exactly = await offerForBoundary("exactly");
    nowS = 200;
    expect((await respond(exactly, "exactly")).statusCode).toBe(200);
    const after = await offerForBoundary("after");
    nowS = 201;
    expect((await respond(after, "after")).statusCode).toBe(409);
    expect((await cooperation.listContracts(WORLD, buyerOperatorId)).find((contract) => contract.id === after)?.status).toBe("offered");
  });

  it("liefert Verträge und Marktangebote ausschließlich als begrenzte Cursor-Seiten", async () => {
    for (const index of [0, 1]) {
      const offered = await app.inject({
        method: "POST", url: `/worlds/${WORLD}/operators/${sellerOperatorId}/contracts`, headers: auth("seller"),
        payload: { offereeOperatorId: buyerOperatorId, contractType: "traction", subject: { trainRunIds: [`train-${index}`], formationIds: [`formation-${index}`], personnelDutyIds: [`duty-${index}`], pathReceiptIds: [`path-${index}`] }, terms: { scope: "traction" }, priceCents: "1", validFromS: 300, validUntilS: 3_600, responseDeadlineS: 200, terminationNoticeS: 600, idempotencyKey: `page-api-${index}` },
      });
      expect(offered.statusCode).toBe(201);
    }
    const first = await app.inject({ method: "GET", url: `/worlds/${WORLD}/operators/${sellerOperatorId}/contracts?limit=1`, headers: auth("seller") });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ schemaVersion: "zugfolge-cooperation-page/v1", items: [{ schemaVersion: "zugfolge-operator-contract/v1", status: "offered" }] });
    expect(first.json().items).toHaveLength(1);
    expect(first.json().nextCursor).toMatch(/^v1\./);
    const second = await app.inject({ method: "GET", url: `/worlds/${WORLD}/operators/${sellerOperatorId}/contracts?limit=1&cursor=${encodeURIComponent(first.json().nextCursor as string)}`, headers: auth("seller") });
    expect(second.statusCode).toBe(200);
    expect(second.json().items[0].id).not.toBe(first.json().items[0].id);
    const deadlineFiltered = await app.inject({ method: "GET", url: `/worlds/${WORLD}/operators/${sellerOperatorId}/contracts?view=all&deadlineBeforeS=199`, headers: auth("seller") });
    expect(deadlineFiltered.statusCode).toBe(200);
    expect(deadlineFiltered.json()).toMatchObject({ schemaVersion: "zugfolge-cooperation-page/v1", items: [] });
    const marketPage = await app.inject({ method: "GET", url: `/worlds/${WORLD}/vehicle-market/listings?deadlineBeforeS=1000`, headers: auth("seller") });
    expect(marketPage.statusCode).toBe(200);
    expect(marketPage.json()).toMatchObject({ schemaVersion: "zugfolge-cooperation-page/v1", items: [] });
    const invalid = await app.inject({ method: "GET", url: `/worlds/${WORLD}/vehicle-market/listings?cursor=kaputt`, headers: auth("seller") });
    expect(invalid.statusCode).toBe(400);
    const invalidDeadline = await app.inject({ method: "GET", url: `/worlds/${WORLD}/vehicle-market/listings?deadlineBeforeS=-1`, headers: auth("seller") });
    expect(invalidDeadline.statusCode).toBe(400);
  });

  it("bindet eine Vertragsantwort vor jeder Mutation an das exakt handelnde EVU", async () => {
    const [otherBuyerOperator] = await db.insert(operators).values({
      worldId: WORLD, foundingAccountId: buyerAccountId, name: "Buyer Rail Zwei",
    }).returning();
    const offered = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${sellerOperatorId}/contracts`,
      headers: auth("seller"),
      payload: {
        offereeOperatorId: buyerOperatorId,
        contractType: "connection",
        subject: { connections: [{ arrivalTrainRunId: "RE-1", onwardTrainRunId: "S-2", maxWaitSeconds: 300 }] },
        terms: { scope: "connection" }, priceCents: "0", validFromS: 300, validUntilS: 3_600,
        responseDeadlineS: 200, terminationNoticeS: 600, idempotencyKey: "exact-acting-operator",
      },
    });
    const contractId = offered.json().id as string;
    const wrongOperator = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${otherBuyerOperator!.id}/contracts/${contractId}/respond`,
      headers: auth("buyer"), payload: { response: "accept", idempotencyKey: "wrong-operator-response" },
    });
    expect(wrongOperator.statusCode).toBe(403);
    expect((await cooperation.listContracts(WORLD, buyerOperatorId)).find((contract) => contract.id === contractId)?.status).toBe("offered");

    const correctOperator = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${contractId}/respond`,
      headers: auth("buyer"), payload: { response: "accept", idempotencyKey: "correct-operator-response" },
    });
    expect(correctOperator.statusCode).toBe(200);
    expect(correctOperator.json()).toMatchObject({ status: "accepted" });
  });

  it("führt Angebot, Reservierung und Fahrzeugübertragung über Spieler-API aus", async () => {
    await fundBuyer(100_000_000n, "api-transfer");
    const inventory = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD}/operators/${sellerOperatorId}/vehicles`,
      headers: auth("seller"),
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()).toMatchObject([{ vehicleId: "vehicle-1", ownerOperatorId: sellerOperatorId }]);
    const foreignInventory = await app.inject({
      method: "GET",
      url: `/worlds/${WORLD}/operators/${sellerOperatorId}/vehicles`,
      headers: auth("buyer"),
    });
    expect(foreignInventory.statusCode).toBe(403);

    const listed = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${sellerOperatorId}/vehicles/vehicle-1/listings`,
      headers: auth("seller"),
      payload: { listingType: "sale", priceCents: "90000000", expiresAtS: 1_000, idempotencyKey: "api-listing-1" },
    });
    expect(listed.statusCode).toBe(201);
    expect(listed.json()).toMatchObject({ schemaVersion: "zugfolge-vehicle-market-listing/v1", status: "open", priceCents: "90000000" });

    const reserved = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/vehicle-market/listings/${listed.json().id as string}/reserve`,
      headers: auth("buyer"),
      payload: { buyerOperatorId, expectedRevision: 1, idempotencyKey: "api-reserve-1" },
    });
    expect(reserved.statusCode).toBe(200);
    expect(reserved.json()).toMatchObject({ status: "reserved", reservedUntilS: 700, revision: 2 });

    const transferred = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/vehicle-market/listings/${listed.json().id as string}/transfer`,
      headers: auth("buyer"),
      payload: { buyerOperatorId, expectedRevision: 2, idempotencyKey: "api-transfer-1" },
    });
    expect(transferred.statusCode, transferred.body).toBe(200);
    expect(transferred.json()).toMatchObject({
      schemaVersion: "zugfolge-vehicle-transfer-result/v1",
      vehicle: { vehicleId: "vehicle-1", ownerOperatorId: buyerOperatorId, holderOperatorId: buyerOperatorId },
    });

    const condition = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/vehicles/vehicle-1/condition`,
      headers: auth("buyer"),
      payload: {
        atS: 130, expectedRevision: 2, odometerMetres: "12500", conditionBasisPoints: 8300,
        damages: [{ code: "door-2", disclosed: true }],
        maintenanceDeadlines: [{ kind: "IS-600", dueAtS: 5000 }],
        bindings: { formations: [], contracts: [], workshop: [], security: [] },
        idempotencyKey: "api-condition-1",
      },
    });
    expect(condition.statusCode).toBe(404);

    const history = await app.inject({ method: "GET", url: `/worlds/${WORLD}/vehicles/vehicle-1/history`, headers: auth("buyer") });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject([
      { eventType: "registered", priorHistoryHash: null },
      { eventType: "sale", details: { priceCents: "90000000" } },
    ]);
  });

  it("beweist den Zwei-Spieler-Vertrag mit Ledger, Postfach und Audit in einem Lauf", async () => {
    await fundBuyer(500_000n, "two-player-contract");
    const offered = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${sellerOperatorId}/contracts`,
      headers: auth("seller"),
      payload: {
        offereeOperatorId: buyerOperatorId,
        contractType: "connection",
        subject: { connections: [{ arrivalTrainRunId: "RE-1", onwardTrainRunId: "S-2", maxWaitSeconds: 300 }] },
        terms: { quality: "binding" },
        priceCents: "125000",
        validFromS: 300,
        validUntilS: 3_600,
        responseDeadlineS: 200,
        terminationNoticeS: 600,
        idempotencyKey: "phase4-two-player-contract",
      },
    });
    expect(offered.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${offered.json().id as string}/respond`,
      headers: auth("buyer"),
      payload: { response: "accept", idempotencyKey: "phase4-contract-response" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: "accepted" });

    const [transactions, entries, messages, events] = await Promise.all([
      db.select().from(ledgerTransactions),
      db.select().from(ledgerEntries),
      db.select().from(mailboxMessages),
      db.select().from(domainEvents),
    ]);
    expect(transactions).toHaveLength(3);
    expect(entries).toHaveLength(6);
    expect(entries.reduce((sum, entry) => sum + entry.amountCents, 0n)).toBe(0n);
    expect(messages.map((message) => message.messageType)).toEqual(expect.arrayContaining([
      "cooperation.contract-offer",
      "cooperation.contract-accepted",
    ]));
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "cooperation.contract-offered",
      "cooperation.contract-accepted",
    ]));
  });

  it("erzwingt Economy-Kaufsperren und einen exakt gebundenen autoritativen Defektbeleg", async () => {
    const listing = await cooperation.createListing({
      worldId: WORLD, vehicleId: "vehicle-1", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 90_000_000n,
      listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "authority-listing",
    });
    const [vehicle] = await db.select().from(vehicleAssets).where(eq(vehicleAssets.worldId, WORLD)).limit(1);
    const authority = new GameCooperationAuthority(db, {});

    await db.delete(economyWorldStates).where(eq(economyWorldStates.worldId, WORLD));

    await expect(authority.verifyContractPayment({
      worldId: WORLD, contractId: "contract-payment", payerOperatorId: buyerOperatorId,
      priceCents: 1n, atS: 100,
    })).resolves.toMatchObject({ permitted: false, code: "economy_state_missing" });

    await expect(authority.verifyVehicleTransfer({
      worldId: WORLD, vehicle: vehicle!, listing, buyerOperatorId, atS: 100,
    })).resolves.toMatchObject({ permitted: false, code: "economy_state_missing" });

    await db.insert(economyWorldStates).values({
      worldId: WORLD, revision: 0,
      state: encodeEconomyValue({ worldId: WORLD, revision: 0, operatorRestrictions: new Map([[buyerOperatorId, { purchasesBlocked: true }]]), insolventOperators: new Set(), tenderAutomation: new Map(), operatingRuntimeByLot: new Map() }) as never,
      updatedAt: EPOCH,
    });
    await expect(authority.verifyVehicleTransfer({
      worldId: WORLD, vehicle: vehicle!, listing, buyerOperatorId, atS: 100,
    })).resolves.toMatchObject({ permitted: false, code: "purchase_blocked" });
    await expect(authority.verifyContractPayment({
      worldId: WORLD, contractId: "contract-payment", payerOperatorId: buyerOperatorId,
      priceCents: 1n, atS: 100,
    })).resolves.toMatchObject({ permitted: false, code: "contract_payment_blocked" });
    await db.update(economyWorldStates).set({
      revision: 1,
      state: encodeEconomyValue({ worldId: WORLD, revision: 1, operatorRestrictions: new Map(), insolventOperators: new Set(), tenderAutomation: new Map(), operatingRuntimeByLot: new Map() }) as never,
    }).where(eq(economyWorldStates.worldId, WORLD));
    await expect(authority.verifyContractPayment({
      worldId: WORLD, contractId: "contract-payment", payerOperatorId: buyerOperatorId,
      priceCents: 1n, atS: 100,
    })).resolves.toMatchObject({ permitted: true });
    await expect(authority.verifyVehicleTransfer({
      worldId: WORLD, vehicle: vehicle!, listing, buyerOperatorId, atS: 100,
    })).resolves.toMatchObject({ permitted: false, code: "fleet_state_missing" });
    await db.insert(fleetWorldCheckpoints).values({
      worldId: WORLD,
      revision: 0,
      stateSchema: "zugfolge-fleet-world-state/v2",
      state: { worldId: WORLD, formations: {} },
      stateHash: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      producedAt: EPOCH,
      ingestedAt: EPOCH,
    });
    await expect(authority.verifyVehicleTransfer({
      worldId: WORLD, vehicle: vehicle!, listing, buyerOperatorId, atS: 100,
    })).resolves.toMatchObject({ permitted: true });

    const reversalInput = {
      worldId: WORLD,
      vehicle: vehicle!,
      listing,
      originalTransferId: "11111111-1111-4111-8111-111111111119",
      originalTransferredAtS: 120,
      assetBeforeHash: vehicle!.historyHash,
      reasonCode: "undisclosed-brake-damage",
      atS: 150,
    } as const;
    await expect(authority.verifyVehicleReversal(reversalInput))
      .resolves.toMatchObject({ permitted: false, code: "reversal_evidence_missing" });
    await db.insert(domainEvents).values({
      worldId: WORLD, sequence: 100, eventType: "vehicle.defect-confirmed",
      payload: { vehicleId: vehicle!.vehicleId, listingId: listing.id, transferId: reversalInput.originalTransferId, disclosureHash: listing.disclosureHash, assetBeforeHash: vehicle!.historyHash, reasonCode: "undisclosed-other-damage", disclosed: false, observedAtS: 110, confirmedAtS: 140 },
      occurredAt: EPOCH,
    });
    await expect(authority.verifyVehicleReversal(reversalInput))
      .resolves.toMatchObject({ permitted: false, code: "reversal_evidence_missing" });
    await db.insert(domainEvents).values({
      worldId: WORLD, sequence: 101, eventType: "vehicle.defect-confirmed",
      payload: { vehicleId: vehicle!.vehicleId, listingId: listing.id, transferId: reversalInput.originalTransferId, disclosureHash: listing.disclosureHash, assetBeforeHash: vehicle!.historyHash, reasonCode: "undisclosed-brake-damage", disclosed: true, observedAtS: 110, confirmedAtS: 140 },
      occurredAt: EPOCH,
    });
    await expect(authority.verifyVehicleReversal(reversalInput))
      .resolves.toMatchObject({ permitted: false, code: "reversal_evidence_missing" });
    await db.insert(domainEvents).values({
      worldId: WORLD, sequence: 102, eventType: "vehicle.defect-confirmed",
      payload: { vehicleId: vehicle!.vehicleId, listingId: listing.id, transferId: reversalInput.originalTransferId, disclosureHash: listing.disclosureHash, assetBeforeHash: vehicle!.historyHash, reasonCode: "undisclosed-brake-damage", disclosed: false, observedAtS: 121, confirmedAtS: 140 },
      occurredAt: EPOCH,
    });
    await expect(authority.verifyVehicleReversal(reversalInput))
      .resolves.toMatchObject({ permitted: false, code: "reversal_evidence_missing" });
    await db.insert(domainEvents).values({
      worldId: WORLD, sequence: 103, eventType: "vehicle.defect-confirmed",
      payload: { vehicleId: vehicle!.vehicleId, listingId: listing.id, transferId: reversalInput.originalTransferId, disclosureHash: listing.disclosureHash, assetBeforeHash: vehicle!.historyHash, reasonCode: "undisclosed-brake-damage", disclosed: false, observedAtS: 110, confirmedAtS: 140 },
      occurredAt: EPOCH,
    });
    await expect(authority.verifyVehicleReversal(reversalInput)).resolves.toMatchObject({ permitted: true });
  });

  it("handelt zwanzig Fahrzeuge parallel ohne Doppelbindung oder Identitätsverlust", async () => {
    await fundBuyer(10_000_000_000n, "load-transfer");
    const vehicleIds = Array.from({ length: 20 }, (_, index) => `load-vehicle-${String(index + 1).padStart(2, "0")}`);
    await Promise.all(vehicleIds.map((vehicleId, index) => cooperation.registerVehicle({
      worldId: WORLD,
      vehicleId,
      authorityReleaseId: "fleet-md-v1",
      classDesignation: index % 2 === 0 ? "442" : "463",
      actualConfiguration: { seats: 220 },
      ownerOperatorId: sellerOperatorId,
      odometerMetres: BigInt(index * 10_000),
      conditionBasisPoints: 9_000 - index,
      damages: [], maintenanceDeadlines: [], approvals: ["line-md-1"], operatingLimits: ["15kv"],
      valuationSpecId: "economy-md-v1:used",
      valueCents: 100_000_000n,
      acquiredAtS: 0,
    })));

    const listed = await Promise.all(vehicleIds.map((vehicleId, index) => app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${sellerOperatorId}/vehicles/${vehicleId}/listings`,
      headers: auth("seller"),
      payload: { listingType: "sale", priceCents: String(90_000_000 + index), expiresAtS: 1_000, idempotencyKey: `load-listing-${index}` },
    })));
    expect(listed.every((response) => response.statusCode === 201)).toBe(true);

    const reserved = await Promise.all(listed.map((response) => app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/vehicle-market/listings/${response.json().id as string}/reserve`,
      headers: auth("buyer"),
      payload: { buyerOperatorId, expectedRevision: 1, idempotencyKey: `load-reserve-${listed.indexOf(response)}` },
    })));
    expect(reserved.every((response) => response.statusCode === 200)).toBe(true);

    const transferred = await Promise.all(reserved.map((response, index) => app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/vehicle-market/listings/${response.json().id as string}/transfer`,
      headers: auth("buyer"),
      payload: { buyerOperatorId, expectedRevision: 2, idempotencyKey: `load-transfer-${index}` },
    })));
    expect(transferred.every((response) => response.statusCode === 200), transferred.find((response) => response.statusCode !== 200)?.body).toBe(true);

    const assets = await db.select().from(vehicleAssets).where(eq(vehicleAssets.worldId, WORLD));
    const loadAssets = assets.filter((asset) => vehicleIds.includes(asset.vehicleId));
    expect(loadAssets).toHaveLength(20);
    expect(loadAssets.every((asset) => asset.ownerOperatorId === buyerOperatorId && asset.holderOperatorId === buyerOperatorId)).toBe(true);
    expect(new Set(loadAssets.map((asset) => asset.vehicleId)).size).toBe(20);

    const history = await db.select().from(vehicleAssetHistoryEvents).where(eq(vehicleAssetHistoryEvents.worldId, WORLD));
    for (const vehicleId of vehicleIds) {
      expect(history.filter((event) => event.vehicleId === vehicleId).map((event) => event.eventType)).toEqual(["registered", "sale"]);
    }

    const staleSecondReservation = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/vehicle-market/listings/${listed[0]!.json().id as string}/reserve`,
      headers: auth("buyer"),
      payload: { buyerOperatorId, expectedRevision: 1, idempotencyKey: "stale-second-reservation" },
    });
    expect(staleSecondReservation.statusCode).toBe(409);
    expect(staleSecondReservation.json()).toMatchObject({ code: "revision_conflict" });
  }, 30_000);
});
