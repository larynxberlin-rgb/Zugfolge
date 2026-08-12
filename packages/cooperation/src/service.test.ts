import { PGlite } from "@electric-sql/pglite";
import {
  accounts,
  domainEvents,
  ledgerEntries,
  ledgerTransactions,
  mailboxMessages,
  MIGRATIONS_FOLDER,
  operators,
  vehicleAssets,
  vehicleMarketListings,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CooperationConflictError,
  CooperationService,
  CooperationValidationError,
  type ContractOfferInput,
} from "./index.js";

const WORLD = "11111111-1111-1111-1111-111111111111";
const OTHER_WORLD = "22222222-2222-2222-2222-222222222222";
const EPOCH = new Date("2026-12-13T00:00:00.000Z");

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let sellerAccountId: string;
let buyerAccountId: string;
let sellerOperatorId: string;
let buyerOperatorId: string;

const fleetWriter = {
  async apply(_tx: unknown, intent: { readonly transferReceiptHash: string }) {
    expect(intent.transferReceiptHash).toMatch(/^[a-f0-9]{64}$/);
    return { resultingStateHash: "f".repeat(64), resultingRevision: 1 };
  },
};

function cooperationService(): CooperationService {
  return new CooperationService(db, undefined, fleetWriter as never);
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values([
    { id: WORLD, name: "Mitteldeutschland", schedulePeriodWeeks: 4, epoch: EPOCH },
    { id: OTHER_WORLD, name: "Andere Welt", schedulePeriodWeeks: 4, epoch: EPOCH },
  ]);
  [sellerAccountId, buyerAccountId] = (await db.insert(accounts).values([
    { worldId: WORLD, keycloakSubject: "seller", displayName: "Seller" },
    { worldId: WORLD, keycloakSubject: "buyer", displayName: "Buyer" },
  ]).returning()).map((row) => row.id);
  [sellerOperatorId, buyerOperatorId] = (await db.insert(operators).values([
    { worldId: WORLD, foundingAccountId: sellerAccountId, name: "Anbieterbahn" },
    { worldId: WORLD, foundingAccountId: buyerAccountId, name: "Abnehmerbahn" },
  ]).returning()).map((row) => row.id);
});

afterEach(async () => client.close());

function offer(overrides: Partial<ContractOfferInput> = {}): ContractOfferInput {
  return {
    worldId: WORLD,
    offerorOperatorId: sellerOperatorId,
    offereeOperatorId: buyerOperatorId,
    offeredByAccountId: sellerAccountId,
    contractType: "traction",
    subject: {
      trainRunIds: ["train-100"],
      formationIds: ["formation-100"],
      personnelDutyIds: ["duty-100"],
      pathReceiptIds: ["path-100"],
    },
    terms: { performanceWindowSeconds: 900, nonPerformancePenaltyCents: "25000" },
    priceCents: 125_000n,
    offeredAtS: 100,
    responseDeadlineS: 200,
    validFromS: 300,
    validUntilS: 3_600,
    terminationNoticeS: 600,
    idempotencyKey: "contract-traction-1",
    ...overrides,
  };
}

async function registerVehicle(service: CooperationService): Promise<void> {
  await service.registerVehicle({
    worldId: WORLD,
    vehicleId: "vehicle-442-001",
    authorityReleaseId: "fleet-md-2027-v1",
    classDesignation: "442",
    actualConfiguration: { cars: 4, seats: 225, doorsPerSide: 6, protection: ["pzb"] },
    ownerOperatorId: sellerOperatorId,
    odometerMetres: 12_345_000n,
    conditionBasisPoints: 8_750,
    damages: [{ code: "paint-scratch", severity: "minor" }],
    maintenanceDeadlines: [{ kind: "inspection", dueAtS: 900_000 }],
    approvals: ["EBO", "DE", "line:MD-1"],
    operatingLimits: ["15kv", "pzb"],
    valuationSpecId: "economy-md-2027:used-vehicle-v1",
    valueCents: 650_000_000n,
    acquiredAtS: 10,
  });
}

describe("M12.1 EVU-zu-EVU-Verträge", () => {
  it("führt Angebot, Annahme, Ledger, Postfach und Audit atomar über den echten DB-Pfad", async () => {
    const service = cooperationService();
    const created = await service.offerContract(offer());
    expect(created.status).toBe("offered");

    const accepted = await service.respondToContract({
      worldId: WORLD,
      contractId: created.id,
      actingAccountId: buyerAccountId,
      atS: 150,
      response: "accept",
    });
    expect(accepted.status).toBe("accepted");
    expect(await db.select().from(ledgerTransactions)).toHaveLength(2);
    const entries = await db.select().from(ledgerEntries);
    expect(entries).toHaveLength(4);
    expect(entries.reduce((sum, row) => sum + row.amountCents, 0n)).toBe(0n);
    expect(await db.select().from(mailboxMessages)).toHaveLength(3);
    expect((await db.select().from(domainEvents).orderBy(domainEvents.sequence)).map((row) => row.eventType)).toEqual([
      "cooperation.contract-offered",
      "cooperation.contract-accepted",
    ]);

    expect(await service.advanceContracts(WORLD, 300)).toMatchObject([{ status: "active" }]);
    expect(await service.advanceContracts(WORLD, 3_600)).toMatchObject([{ status: "completed", endReason: "regular-end" }]);
  });

  it("validiert alle vier Leistungsgegenstände und lehnt unvollständige Verträge vor Persistenz ab", async () => {
    const service = cooperationService();
    const subjects: readonly Pick<ContractOfferInput, "contractType" | "subject">[] = [
      { contractType: "traction", subject: { trainRunIds: ["t"], formationIds: ["f"], personnelDutyIds: ["d"], pathReceiptIds: ["p"] } },
      { contractType: "vehicle-rental", subject: { vehicleIds: ["v"] } },
      { contractType: "connection", subject: { connections: [{ arrivalTrainRunId: "a", onwardTrainRunId: "b", maxWaitSeconds: 300 }] } },
      { contractType: "disruption-assistance", subject: { disruptionId: "incident-1", trainRunIds: ["r"], vehicleIds: ["v"] } },
    ];
    for (const [index, subject] of subjects.entries()) {
      await expect(service.offerContract(offer({ ...subject, idempotencyKey: `type-${index}` }))).resolves.toMatchObject({ contractType: subject.contractType });
    }
    await expect(service.offerContract(offer({
      contractType: "connection",
      subject: { connections: [{ arrivalTrainRunId: "a", onwardTrainRunId: "b", maxWaitSeconds: 8_000 }] },
      idempotencyKey: "invalid-wait",
    }))).rejects.toBeInstanceOf(CooperationValidationError);
  });

  it("erzwingt Weltisolation und getrennte Parteien auch gegen direkte Fehlparameter", async () => {
    const service = cooperationService();
    await expect(service.offerContract(offer({ offereeOperatorId: sellerOperatorId }))).rejects.toBeInstanceOf(CooperationValidationError);
    await expect(service.offerContract(offer({ worldId: OTHER_WORLD }))).rejects.toThrow();
    expect(await service.listContracts(OTHER_WORLD, sellerOperatorId)).toHaveLength(0);
  });
});

describe("M12.2 Fahrzeug-Sekundärmarkt", () => {
  it("überträgt ein offengelegtes Fahrzeug genau einmal mit Historie, Zahlung und Eigentumswechsel", async () => {
    const service = cooperationService();
    await registerVehicle(service);
    const listing = await service.createListing({
      worldId: WORLD,
      vehicleId: "vehicle-442-001",
      offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId,
      listingType: "sale",
      priceCents: 625_000_000n,
      listedAtS: 100,
      expiresAtS: 1_000,
      idempotencyKey: "listing-sale-1",
    });
    expect(listing.disclosure).toMatchObject({
      odometerMetres: "12345000",
      conditionBasisPoints: 8_750,
      valuationSpecId: "economy-md-2027:used-vehicle-v1",
    });
    const reserved = await service.reserveListing({
      worldId: WORLD,
      listingId: listing.id,
      buyerOperatorId,
      actingAccountId: buyerAccountId,
      atS: 110,
      reservedUntilS: 300,
      expectedRevision: listing.revision,
    });
    const transferred = await service.transferListing({
      worldId: WORLD,
      listingId: listing.id,
      buyerOperatorId,
      actingAccountId: buyerAccountId,
      atS: 120,
      expectedRevision: reserved.revision,
      idempotencyKey: "transfer-sale-1",
    });
    expect(transferred.vehicle).toMatchObject({
      vehicleId: "vehicle-442-001",
      ownerOperatorId: buyerOperatorId,
      holderOperatorId: buyerOperatorId,
      revision: 2,
    });
    expect(await service.listVehicleHistory(WORLD, "vehicle-442-001")).toHaveLength(2);
    expect(await db.select().from(ledgerTransactions)).toHaveLength(2);

    const repeated = await service.transferListing({
      worldId: WORLD,
      listingId: listing.id,
      buyerOperatorId,
      actingAccountId: buyerAccountId,
      atS: 120,
      expectedRevision: reserved.revision,
      idempotencyKey: "transfer-sale-1",
    });
    expect(repeated.transferId).toBe(transferred.transferId);
    expect(await service.listVehicleHistory(WORLD, "vehicle-442-001")).toHaveLength(2);
  });

  it("verhindert Doppelangebot, Doppelreservierung und Übertragung bei geänderten Mängeln", async () => {
    const service = cooperationService();
    await registerVehicle(service);
    const listing = await service.createListing({
      worldId: WORLD, vehicleId: "vehicle-442-001", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 1n,
      listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "listing-a",
    });
    await expect(service.createListing({
      worldId: WORLD, vehicleId: "vehicle-442-001", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 2n,
      listedAtS: 101, expiresAtS: 1_000, idempotencyKey: "listing-b",
    })).rejects.toThrow();
    const reserved = await service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, reservedUntilS: 300, expectedRevision: listing.revision,
    });
    await db.update(vehicleAssets).set({ conditionBasisPoints: 8_000 }).where(and(
      eq(vehicleAssets.worldId, WORLD), eq(vehicleAssets.vehicleId, "vehicle-442-001"),
    ));
    await expect(service.transferListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 120, expectedRevision: reserved.revision, idempotencyKey: "changed-disclosure",
    })).rejects.toMatchObject({ code: "disclosure_changed" } satisfies Partial<CooperationConflictError>);
  });

  it("rolls back market, ownership, ledger and events when the fleet single-writer rejects", async () => {
    const service = new CooperationService(db, undefined, {
      async apply() {
        throw new Error("asset_holding_conflict");
      },
    });
    await registerVehicle(service);
    const listing = await service.createListing({
      worldId: WORLD, vehicleId: "vehicle-442-001", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 625_000_000n,
      listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "listing-atomic",
    });
    const reserved = await service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, reservedUntilS: 300, expectedRevision: listing.revision,
    });
    const eventCount = (await db.select().from(domainEvents)).length;

    await expect(service.transferListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 120, expectedRevision: reserved.revision, idempotencyKey: "transfer-atomic",
    })).rejects.toThrow("asset_holding_conflict");

    expect(await db.select().from(vehicleAssets)).toMatchObject([{
      ownerOperatorId: sellerOperatorId, holderOperatorId: sellerOperatorId, revision: 1,
    }]);
    expect(await db.select().from(vehicleMarketListings)).toMatchObject([{ status: "reserved", revision: 2 }]);
    expect(await db.select().from(ledgerTransactions)).toHaveLength(0);
    expect(await db.select().from(domainEvents)).toHaveLength(eventCount);
  });

  it("vermietet mit Vertrag und wickelt einen nachgewiesenen verdeckten Mangel vollständig zurück", async () => {
    const service = cooperationService();
    await registerVehicle(service);
    const listing = await service.createListing({
      worldId: WORLD, vehicleId: "vehicle-442-001", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "rental", priceCents: 2_000_000n,
      listedAtS: 100, expiresAtS: 1_000, rentalValidUntilS: 10_000, idempotencyKey: "listing-rental",
    });
    const reserved = await service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, reservedUntilS: 300, expectedRevision: listing.revision,
    });
    const transferred = await service.transferListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 120, expectedRevision: reserved.revision, idempotencyKey: "rental-transfer",
    });
    expect(transferred.contract).toMatchObject({ contractType: "vehicle-rental", status: "active" });
    expect(transferred.vehicle).toMatchObject({ ownerOperatorId: sellerOperatorId, holderOperatorId: buyerOperatorId, lessorOperatorId: sellerOperatorId });

    const reversed = await service.reverseTransfer({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 130, reasonCode: "undisclosed-brake-damage", idempotencyKey: "rental-reversal",
    });
    expect(reversed.listing.status).toBe("reversed");
    expect(reversed.vehicle).toMatchObject({ ownerOperatorId: sellerOperatorId, holderOperatorId: sellerOperatorId, lessorOperatorId: null });
    expect(await service.listVehicleHistory(WORLD, "vehicle-442-001")).toHaveLength(3);
    expect(await db.select().from(ledgerTransactions)).toHaveLength(4);
    expect(await db.select().from(vehicleMarketListings).where(eq(vehicleMarketListings.worldId, OTHER_WORLD))).toHaveLength(0);
  });
});
