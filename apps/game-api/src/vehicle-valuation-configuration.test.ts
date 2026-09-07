import { PGlite } from "@electric-sql/pglite";
import { CooperationService } from "@zugfolge/cooperation";
import { accounts, domainEvents, economyWorldStates, MIGRATIONS_FOLDER, operators, vehicleAssets, vehicleMarketListings, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import * as economy from "@zugfolge/economy";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyConfiguredVehicleValuations, parseVehicleValuationCatalog } from "./vehicle-valuation-configuration.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const checksum = "b".repeat(64);
const epoch = new Date("2026-01-01T00:00:00Z");
let databaseTemplate: Blob | File;
let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let operatorId: string;
const configuration = (releaseChecksum = checksum, baseValueCents = "100000") => parseVehicleValuationCatalog(JSON.stringify({
  schemaVersion: "zugfolge-vehicle-valuation-catalog/v1",
  entries: [{ worldId: WORLD, authorityReleaseId: "fleet-release-v1", economyReleaseChecksum: releaseChecksum,
    vehicles: [{ vehicleId: "existing-asset", atS: 0, odometerMetres: "0", conditionBasisPoints: 10000,
      basis: { baseValueCents, ageYears: 0, spec: { specId: "economy-v1:vehicle-valuation", annualDepreciationBasisPoints: 1000,
        mileageStepMetres: "100000000", mileageDepreciationBasisPoints: 100, maximumMileageSteps: 20,
        damageDeductionsBasisPoints: {}, minimumResidualBasisPoints: 1000 } } }],
  }],
}))[WORLD]!;

beforeAll(async () => {
  const template = new PGlite();
  try { await migrate(drizzle(template), { migrationsFolder: MIGRATIONS_FOLDER }); databaseTemplate = await template.dumpDataDir(); }
  finally { await template.close(); }
}, 30000);

beforeEach(async () => {
  client = new PGlite({ loadDataDir: databaseTemplate });
  db = drizzle(client, { schema });
  await db.insert(worlds).values({ id: WORLD, name: "Bewertungswelt", schedulePeriodWeeks: 4, epoch });
  const [account] = await db.insert(accounts).values({ worldId: WORLD, keycloakSubject: "owner", displayName: "Eigentümer" }).returning();
  const [operator] = await db.insert(operators).values({ worldId: WORLD, foundingAccountId: account!.id, name: "Bewertungsbahn" }).returning();
  operatorId = operator!.id;
  await db.insert(economyWorldStates).values({ worldId: WORLD, revision: 0, updatedAt: epoch,
    state: economy.encodeEconomyValue({ worldId: WORLD, revision: 0, releasePin: { worldId: WORLD, releaseVersion: "economy-v1", releaseChecksum: checksum },
      operatorRestrictions: new Map(), insolventOperators: new Set(), contracts: new Map(), tenderAutomation: new Map(), operatingRuntimeByLot: new Map() }),
  });
  await new CooperationService(db).registerVehicle({ worldId: WORLD, vehicleId: "existing-asset", authorityReleaseId: "fleet-release-v1", classDesignation: "442",
    actualConfiguration: {}, ownerOperatorId: operatorId, odometerMetres: 0n, conditionBasisPoints: 10000, damages: [], maintenanceDeadlines: [],
    approvals: ["DE"], operatingLimits: [], valuationSpecId: "historical-registration", valueCents: 100000n, acquiredAtS: 0 });
  await db.update(vehicleAssets).set({ odometerMetres: null, conditionBasisPoints: null, valueCents: null, valuationSpecId: null }).where(eq(vehicleAssets.worldId, WORLD));
  vi.spyOn(economy, "loadFleetProducerCheckpoint").mockResolvedValue({ state: { authorityRelease: { releaseId: "fleet-release-v1" } } } as never);
});

afterEach(async () => { vi.restoreAllMocks(); await client.close(); });

describe("Freigegebener Bewertungskatalog bestehender Weltassets", () => {
  it("bindet einen vorhandenen unbekannten Bestand ohne Neuerstellung an Abschreibung und Insolvenzverwertung", async () => {
    await applyConfiguredVehicleValuations(db, configuration(), 100);
    await applyConfiguredVehicleValuations(db, configuration(), 101);
    let [asset] = await db.select().from(vehicleAssets).where(eq(vehicleAssets.worldId, WORLD));
    expect(asset).toMatchObject({ vehicleId: "existing-asset", valueCents: 100000n, revision: 2, valuationSpecId: "economy-v1:vehicle-valuation" });
    expect(await db.select().from(vehicleAssets).where(eq(vehicleAssets.worldId, WORLD))).toHaveLength(1);
    const service = new CooperationService(db, undefined, { async apply() { return { resultingStateHash: "a".repeat(64), resultingRevision: 1 }; } });
    expect(await service.advanceVehicleValuations(WORLD, 31_536_000)).toBe(1);
    expect(await service.advanceVehicleValuations(WORLD, 31_535_999)).toBe(0);
    [asset] = await db.select().from(vehicleAssets).where(eq(vehicleAssets.worldId, WORLD));
    expect(asset!.valueCents).toBe(90000n);
    const [row] = await db.select().from(economyWorldStates).where(eq(economyWorldStates.worldId, WORLD));
    const state = economy.decodeEconomyValue(row!.state) as Record<string, unknown>;
    await db.update(economyWorldStates).set({ state: economy.encodeEconomyValue({ ...state, insolventOperators: new Set([operatorId]) }) }).where(eq(economyWorldStates.worldId, WORLD));
    await service.advanceInsolvencies(WORLD, 31_536_001);
    expect(await service.listListings(WORLD)).toMatchObject([{ vehicleId: "existing-asset", priceCents: 90000n, offeringOperatorId: operatorId }]);
    expect(await service.listVehicleHistory(WORLD, "existing-asset")).toHaveLength(4);
    expect((await db.select().from(domainEvents).where(eq(domainEvents.worldId, WORLD))).filter((event) => event.eventType === "vehicle.valuation-confirmed")).toHaveLength(1);
  });

  it("verweigert fremde Releases und nach der Freigabe ausgetauschte Bewertungsdateien ohne Teilwirkung", async () => {
    await expect(applyConfiguredVehicleValuations(db, configuration("c".repeat(64)), 100)).rejects.toMatchObject({ code: "valuation_release_mismatch" });
    expect((await db.select().from(vehicleAssets).where(eq(vehicleAssets.worldId, WORLD)))[0]!.valueCents).toBeNull();
    await applyConfiguredVehicleValuations(db, configuration(), 100);
    await expect(applyConfiguredVehicleValuations(db, configuration(checksum, "999999"), 101)).rejects.toMatchObject({ code: "valuation_catalog_changed" });
    expect((await db.select().from(vehicleAssets).where(eq(vehicleAssets.worldId, WORLD)))[0]!.valueCents).toBe(100000n);
  });

  it("erneuert beim ersten Bewertungsbeleg die Offenlegung und löst eine veraltete Reservierung", async () => {
    await db.insert(vehicleMarketListings).values({ worldId: WORLD, vehicleId: "existing-asset", offeringOperatorId: operatorId,
      listingType: "sale", priceCents: 95000n, disclosure: { valueCents: null }, disclosureHash: "0".repeat(64),
      listedAtS: 10, expiresAtS: 1000, status: "reserved", reservedByOperatorId: operatorId, reservedUntilS: 500,
      revision: 2, idempotencyKey: "unvalued-listing" });
    await applyConfiguredVehicleValuations(db, configuration(), 100);
    const [listing] = await db.select().from(vehicleMarketListings).where(eq(vehicleMarketListings.worldId, WORLD));
    expect(listing).toMatchObject({ status: "open", revision: 3, reservedByOperatorId: null, reservedUntilS: null,
      disclosure: { valueCents: "100000", valuationSpecId: "economy-v1:vehicle-valuation" }, priceCents: 95000n });
    expect(listing!.disclosureHash).not.toBe("0".repeat(64));
  });

  it("verwendet nach Weiterverkauf das ursprüngliche Einführungsalter und bewahrt neuere Betriebszähler", async () => {
    await db.update(vehicleAssets).set({ acquiredAtS: 31_535_000, odometerMetres: 200_000_000n,
      conditionBasisPoints: 9000, actualConfiguration: { deliveredAtS: 0 } }).where(eq(vehicleAssets.worldId, WORLD));
    await applyConfiguredVehicleValuations(db, configuration(), 31_536_000);
    const [asset] = await db.select().from(vehicleAssets).where(eq(vehicleAssets.worldId, WORLD));
    expect(asset).toMatchObject({ vehicleId: "existing-asset", acquiredAtS: 31_535_000, odometerMetres: 200_000_000n,
      conditionBasisPoints: 9000, valueCents: 79_200n, valuationBasis: { atS: 0, ageYears: 0, lastValuedAtS: 31_536_000 } });
  });

  it("lehnt unsichere Centbeträge, unbekannte Felder und doppelte Identitäten ab", () => {
    expect(() => configuration(checksum, "9223372036854775808")).toThrow(/sicheren/);
    expect(() => parseVehicleValuationCatalog('{"schemaVersion":"zugfolge-vehicle-valuation-catalog/v1","entries":[],"playerOverrides":{}}')).toThrow(/ungültiges/);
    const original = configuration();
    expect(() => parseVehicleValuationCatalog(JSON.stringify({ schemaVersion: "zugfolge-vehicle-valuation-catalog/v1",
      entries: [{ worldId: WORLD, authorityReleaseId: original.authorityReleaseId, economyReleaseChecksum: checksum, vehicles: [...original.vehicles, ...original.vehicles] }] }))).toThrow(/eindeutige/);
  });
});
