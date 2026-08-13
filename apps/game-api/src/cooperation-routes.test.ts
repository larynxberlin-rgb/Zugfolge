import { PGlite } from "@electric-sql/pglite";
import { CooperationService } from "@zugfolge/cooperation";
import {
  accounts,
  domainEvents,
  ledgerEntries,
  ledgerTransactions,
  mailboxMessages,
  MIGRATIONS_FOLDER,
  operators,
  vehicleAssetHistoryEvents,
  vehicleAssets,
  worldAccesses,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

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

beforeEach(async () => {
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
  app = buildApp({
    db,
    cooperation,
    verifyToken: async (token) => ({ keycloakSubject: token, displayName: token }),
    logger: false,
  });
});

afterEach(async () => {
  await app.close();
  await client.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("M12 HTTP-Integration", () => {
  it("schließt einen Traktionsvertrag durch zwei getrennt authentifizierte EVU", async () => {
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
        offeredAtS: 100,
        idempotencyKey: "api-contract-1",
      },
    });
    expect(offered.statusCode).toBe(201);
    expect(offered.json()).toMatchObject({ status: "offered", priceCents: "250000" });

    const accepted = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${offered.json().id as string}/respond`,
      headers: auth("buyer"),
      payload: { response: "accept", atS: 150 },
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

  it("führt Angebot, Reservierung und Fahrzeugübertragung über Spieler-API aus", async () => {
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
      payload: { listingType: "sale", priceCents: "90000000", listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "api-listing-1" },
    });
    expect(listed.statusCode).toBe(201);
    expect(listed.json()).toMatchObject({ status: "open", priceCents: "90000000" });

    const reserved = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/vehicle-market/listings/${listed.json().id as string}/reserve`,
      headers: auth("buyer"),
      payload: { buyerOperatorId, atS: 110, reservedUntilS: 200, expectedRevision: 1 },
    });
    expect(reserved.statusCode).toBe(200);
    expect(reserved.json()).toMatchObject({ status: "reserved", revision: 2 });

    const transferred = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/vehicle-market/listings/${listed.json().id as string}/transfer`,
      headers: auth("buyer"),
      payload: { buyerOperatorId, atS: 120, expectedRevision: 2, idempotencyKey: "api-transfer-1" },
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json()).toMatchObject({
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
    expect(condition.statusCode).toBe(200);
    expect(condition.json()).toMatchObject({ revision: 3, odometerMetres: "12500", conditionBasisPoints: 8300 });

    const history = await app.inject({ method: "GET", url: `/worlds/${WORLD}/vehicles/vehicle-1/history`, headers: auth("buyer") });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject([
      { eventType: "registered", priorHistoryHash: null },
      { eventType: "sale", details: { priceCents: "90000000" } },
      { eventType: "condition-updated", details: { odometerMetres: "12500", conditionBasisPoints: 8300 } },
    ]);
  });

  it("beweist den Zwei-Spieler-Vertrag mit Ledger, Postfach und Audit in einem Lauf", async () => {
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
        offeredAtS: 100,
        idempotencyKey: "phase4-two-player-contract",
      },
    });
    expect(offered.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/operators/${buyerOperatorId}/contracts/${offered.json().id as string}/respond`,
      headers: auth("buyer"),
      payload: { response: "accept", atS: 150 },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: "accepted" });

    const [transactions, entries, messages, events] = await Promise.all([
      db.select().from(ledgerTransactions),
      db.select().from(ledgerEntries),
      db.select().from(mailboxMessages),
      db.select().from(domainEvents),
    ]);
    expect(transactions).toHaveLength(2);
    expect(entries).toHaveLength(4);
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

  it("handelt zwanzig Fahrzeuge parallel ohne Doppelbindung oder Identitätsverlust", async () => {
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
      payload: { listingType: "sale", priceCents: String(90_000_000 + index), listedAtS: 100, expiresAtS: 1_000, idempotencyKey: `load-listing-${index}` },
    })));
    expect(listed.every((response) => response.statusCode === 201)).toBe(true);

    const reserved = await Promise.all(listed.map((response) => app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/vehicle-market/listings/${response.json().id as string}/reserve`,
      headers: auth("buyer"),
      payload: { buyerOperatorId, atS: 110, reservedUntilS: 200, expectedRevision: 1 },
    })));
    expect(reserved.every((response) => response.statusCode === 200)).toBe(true);

    const transferred = await Promise.all(reserved.map((response, index) => app.inject({
      method: "POST",
      url: `/worlds/${WORLD}/vehicle-market/listings/${response.json().id as string}/transfer`,
      headers: auth("buyer"),
      payload: { buyerOperatorId, atS: 120, expectedRevision: 2, idempotencyKey: `load-transfer-${index}` },
    })));
    expect(transferred.every((response) => response.statusCode === 200)).toBe(true);

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
      payload: { buyerOperatorId, atS: 130, reservedUntilS: 180, expectedRevision: 1 },
    });
    expect(staleSecondReservation.statusCode).toBe(409);
    expect(staleSecondReservation.json()).toMatchObject({ code: "revision_conflict" });
  }, 30_000);
});
