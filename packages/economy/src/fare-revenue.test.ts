import { PGlite } from "@electric-sql/pglite";
import { economyOutbox, ledgerTransactions, MIGRATIONS_FOLDER, operators, schema, worlds } from "@zugfolge/db";
import { requestWorldAccess } from "@zugfolge/identity";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildEconomyRelease, type EconomyRelease } from "./release.js";
import { createTender, type ServiceSpecification } from "./tender.js";
import { startEconomyWorld, settleContractPeriod, type EconomyWorldState } from "./workflow.js";
import { persistEconomyTransition, dispatchEconomyOutbox, encodeEconomyValue } from "./state-store.js";
import { createEconomyPlatformAdapters, STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN } from "./platform-adapters.js";
import { ensureLedgerAccount, ledgerAccountBalance } from "./ledger.js";
import { loadConfirmedFareContractRevenues } from "./fare-revenue.js";
import { ECONOMY_COST_TYPES } from "./finance.js";

const WORLD = "11111111-1111-4111-8111-111111111116", OPERATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", DAY = 86_400;
it("liefert tatsächliche M6-Bruttoabrechnung erst mit Outbox- und Ledgerquittung, ohne Pönalen zurückzuzahlen", async () => {
  const client = new PGlite(), db = drizzle(client, { schema });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD, name: "Fiktiver Abrechnungsnachweis", schedulePeriodWeeks: 3, epoch: new Date(0) });
    const account = await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "fare-revenue-test", displayName: "Abrechnungsprüfung" });
    await db.insert(operators).values({ worldId: WORLD, id: OPERATOR, foundingAccountId: account.id, name: "Fiktiver Abrechnungsverkehr" });
    const source = JSON.parse(readFileSync(new URL("../../../crates/zugfolge-fleet/tests/fixtures/vehicle-world-seed-v3.json", import.meta.url), "utf8"),
      (_key, value: unknown) => typeof value === "string" && /^-?[0-9]+$/u.test(value) ? BigInt(value) : value).economy.release as EconomyRelease;
    const release = buildEconomyRelease({ ...source, fareInspection: { schemaVersion: "fare-inspection-economy/v1", minimumClaimCents: 6000n,
      ordinaryFareMultiplier: 2, reducedClaimCents: 700n, proofWindowDays: 7, dayLengthMs: DAY * 1000, handlingCostCents: 100n,
      proofHandlingCostCents: 250n, policeHandlingCostCents: 300n, fullPaymentBasisPoints: 10_000, partialPaymentBasisPoints: 0,
      partialPaymentShareBasisPoints: 5000, paymentDelayMs: 1000, writeOffDelayMs: 3000, validProofSubmissionBasisPoints: 10_000,
      validProofDelayMs: 2000, premiumMultiplierBasisPoints: 40_000, positiveDailyCapBasisPoints: 50, revenueAllocation: "uniform_settled_service_interval/v1" } });
    expect(buildEconomyRelease(source).checksum).toBe(source.checksum);
    const specification: ServiceSpecification = { lines: ["Fiktive Prüflinie"], trainKmPerPeriod: 100n, stopsPerPeriod: 10n,
      serviceHoursPerPeriod: 1n, facilityHoursPerPeriod: 1n, energyKwhPerPeriod: 1n, vehicleCount: 1n, overnightUnits: 1n, protectionUnits: 1n,
      requirements: { minimumSeats: 100, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 4, wheelchairPlaces: 1, requiredEquipment: [] } };
    // Bereits vergebener, explizit fiktiver M6-Startzustand. Die Abrechnung
    // selbst läuft durch den unveränderten produktiven Periodenproducer.
    const started = startEconomyWorld({ worldId: WORLD, seed: 72n, durationMonths: 6, release, authorityBudgets: [], accounts: [],
      lots: Array.from({ length: 8 }, (_, index) => ({ id: `lot-${index}`, size: 100, attractiveness: 100 })) });
    const tender = createTender({ id: "contract", worldId: WORLD, lotId: "lot-0", incumbentOperatorId: OPERATOR, specification,
      profile: release.tenderProfiles[0]!, release, announcedAt: 0, opensAt: 0, closesAt: 3 * DAY, operatingFrom: 4 * DAY,
      contractPeriods: 2, periodDurationSeconds: 21 * DAY, smallLot: false });
    const state: EconomyWorldState = { ...started.state, tenders: new Map([["contract", { phase: "awarded", tender, bids: [] }]]),
      contracts: new Map([["contract", { id: "contract", worldId: WORLD, lotId: "lot-0", operatorId: OPERATOR, startsAt: 4 * DAY, endsAt: 46 * DAY,
        orderingFeeCentsPerTrainKm: 100n, bonusCentsPerPeriod: 999n, penaltyRates: { punctuality: 0n, cancellation: 0n, seats: 0n, connections: 1700n }, evidenceRequired: ["actual-performance-fixture"] }]]) };
    await persistEconomyTransition(db, { state, effects: { notices: [], journal: [] }, expectedRevision: null, committedAt: new Date(0), enqueuedAt: new Date(0) });
    const at = 25 * DAY;
    const result = settleContractPeriod(state, { commandId: "actual-period-settlement", contractId: "contract", period: 0, at,
      performance: { trainKm: 100n, punctualityBasisPoints: 9000, cancellations: 0, missingSeats: 0, missedConnections: 1, evidence: ["actual-performance-fixture"] }, costs: [] });
    const journal = result.effects.journal[0]!;
    expect(journal.revenueCents).toBe(8300n);
    expect(journal.contractRevenueEvidence).toMatchObject({ orderingFeeCents: "10000", bonusCents: "0", penaltyCents: "1700",
      serviceStartMs: 4 * DAY * 1000, serviceEndMs: at * 1000, economyReleaseHash: release.checksum });
    await persistEconomyTransition(db, { ...result, expectedRevision: 0, committedAt: new Date(at * 1000), enqueuedAt: new Date(at * 1000) });
    expect(await loadConfirmedFareContractRevenues(db, { worldId: WORLD, operatorId: OPERATOR, nowMs: at * 1000 })).toEqual([]);
    const plan = STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN;
    const cash = await ensureLedgerAccount(db, { worldId: WORLD, operatorId: OPERATOR, name: plan.cashAccountName });
    const revenue = await ensureLedgerAccount(db, { worldId: WORLD, operatorId: OPERATOR, name: plan.revenueAccountName });
    const costAccountIds = Object.fromEntries(await Promise.all(ECONOMY_COST_TYPES.map(async (type) => [type,
      (await ensureLedgerAccount(db, { worldId: WORLD, operatorId: OPERATOR, name: plan.costAccountNames[type] })).id]))) as Record<(typeof ECONOMY_COST_TYPES)[number], string>;
    const adapters = createEconomyPlatformAdapters({ db, accountsByOperator: { [OPERATOR]: { cashAccountId: cash.id, revenueAccountId: revenue.id, costAccountIds } } });
    await dispatchEconomyOutbox(db, WORLD, adapters, new Date(at * 1000));
    const confirmed = await loadConfirmedFareContractRevenues(db, { worldId: WORLD, operatorId: OPERATOR, nowMs: at * 1000 });
    expect(confirmed).toHaveLength(1); expect(confirmed[0]!.evidence).toEqual(journal.contractRevenueEvidence);
    expect(await ledgerAccountBalance(db, { worldId: WORLD, ledgerAccountId: cash.id })).toBe(8300n);
    await dispatchEconomyOutbox(db, WORLD, adapters, new Date(at * 1000));
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.worldId, WORLD))).toHaveLength(1);
    expect(await loadConfirmedFareContractRevenues(db, { worldId: WORLD, operatorId: OPERATOR, nowMs: at * 1000 - 1 })).toEqual([]);
    expect(await loadConfirmedFareContractRevenues(db, { worldId: WORLD, operatorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", nowMs: at * 1000 })).toEqual([]);
    await db.update(economyOutbox).set({ payload: encodeEconomyValue({ ...journal, revenueCents: 999999n }) })
      .where(and(eq(economyOutbox.worldId, WORLD), eq(economyOutbox.effectId, journal.idempotencyKey)));
    await expect(loadConfirmedFareContractRevenues(db, { worldId: WORLD, operatorId: OPERATOR, nowMs: at * 1000 })).rejects.toThrow("widerspricht");
  } finally { await client.close(); }
}, 30_000);
