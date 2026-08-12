import { PGlite } from "@electric-sql/pglite";
import { CooperationService } from "@zugfolge/cooperation";
import { accounts, MIGRATIONS_FOLDER, operators, worldAccesses, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
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
});
