import { PGlite } from "@electric-sql/pglite";
import {
  accounts,
  dailyOperationReports,
  domainEvents,
  economyOutbox,
  economyWorldStates,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  mailboxMessages,
  MIGRATIONS_FOLDER,
  operators,
  operatorStartingCapital,
  vehicleAssetHistoryEvents,
  vehicleAssets,
  vehicleMarketListings,
  worlds,
} from "@zugfolge/db";
import {
  EconomyCashWriterBindingError,
  encodeEconomyValue,
  loadEconomyCashAvailabilityForUpdate,
} from "@zugfolge/economy";
import * as schema from "@zugfolge/db/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CooperationConflictError,
  DatabaseCooperationAuthority,
  CooperationService,
  CooperationValidationError,
  type CooperationAuthority,
  type ContractOfferInput,
} from "./index.js";

const WORLD = "11111111-1111-1111-1111-111111111111";
const OTHER_WORLD = "22222222-2222-2222-2222-222222222222";
const EPOCH = new Date("2026-12-13T00:00:00.000Z");

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let migratedDatabase: Blob | File;
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

function verifiedReversalService(): CooperationService {
  const base = new DatabaseCooperationAuthority();
  const authority: CooperationAuthority = {
    verifyContract: (input) => base.verifyContract(input),
    verifyContractPayment: (input) => base.verifyContractPayment(input),
    verifyVehicleListing: (input) => base.verifyVehicleListing(input),
    verifyVehicleTransfer: (input) => base.verifyVehicleTransfer(input),
    verifyVehicleReversal: async (input) => input.reasonCode === "undisclosed-brake-damage"
      ? { permitted: true, code: "verified", explanation: "Serverautoritiver Defektbeleg bestätigt." }
      : { permitted: false, code: "reversal_evidence_missing", explanation: "Defektbeleg fehlt." },
  };
  return new CooperationService(db, authority, fleetWriter as never);
}

type TestCashAccountName = "Economy:Kasse" | "Bank";

async function ensureCashAccount(
  operatorId: string,
  name: TestCashAccountName = "Economy:Kasse",
): Promise<string> {
  const [created] = await db.insert(ledgerAccounts).values({ worldId: WORLD, operatorId, name }).onConflictDoNothing({
    target: [ledgerAccounts.worldId, ledgerAccounts.operatorId, ledgerAccounts.name],
  }).returning({ id: ledgerAccounts.id });
  if (created !== undefined) return created.id;
  const [existing] = await db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(and(
    eq(ledgerAccounts.worldId, WORLD), eq(ledgerAccounts.operatorId, operatorId), eq(ledgerAccounts.name, name),
  )).limit(1);
  return existing!.id;
}

async function cashBalance(accountId: string): Promise<bigint> {
  const entries = await db.select({ amountCents: ledgerEntries.amountCents }).from(ledgerEntries).where(and(
    eq(ledgerEntries.worldId, WORLD), eq(ledgerEntries.ledgerAccountId, accountId),
  ));
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0n);
}

async function enqueuePendingJournal(input: {
  readonly operatorId: string;
  readonly effectId: string;
  readonly revenueCents?: bigint;
  readonly costCents?: bigint;
}): Promise<void> {
  await db.insert(economyOutbox).values({
    worldId: WORLD,
    effectId: input.effectId,
    effectType: "journal",
    payload: encodeEconomyValue({
      worldId: WORLD,
      operatorId: input.operatorId,
      idempotencyKey: input.effectId,
      at: 125,
      description: `Ausstehender Testeffekt ${input.effectId}`,
      revenueCents: input.revenueCents ?? 0n,
      postings: input.costCents === undefined ? [] : [{
        amountCents: input.costCents,
        costType: "energy",
        costCentreId: "pending-test",
        reference: input.effectId,
      }],
    }),
    occurredAt: new Date(EPOCH.getTime() + 125_000),
    enqueuedAt: EPOCH,
  });
}

async function fundOperator(
  operatorId: string,
  amountCents: bigint,
  key: string,
  cashAccountName: TestCashAccountName = "Economy:Kasse",
): Promise<string> {
  const cashAccountId = await ensureCashAccount(operatorId, cashAccountName);
  const [equity] = await db.insert(ledgerAccounts).values({
    worldId: WORLD, operatorId, name: "Startkapital",
  }).returning();
  const [transaction] = await db.insert(ledgerTransactions).values({
    worldId: WORLD,
    operatorId,
    idempotencyKey: `fund:${key}`,
    description: "Autoritatives Test-Startkapital",
    postedAt: EPOCH,
  }).returning();
  await db.insert(ledgerEntries).values([
    { worldId: WORLD, transactionId: transaction!.id, ledgerAccountId: cashAccountId, amountCents },
    { worldId: WORLD, transactionId: transaction!.id, ledgerAccountId: equity!.id, amountCents: -amountCents },
  ]);
  return cashAccountId;
}

async function setEconomyPurchaseState(input: {
  readonly restricted?: boolean;
  readonly insolvent?: boolean;
  readonly revision: number;
}): Promise<void> {
  await db.update(economyWorldStates).set({
    revision: input.revision,
    state: encodeEconomyValue({
      worldId: WORLD,
      revision: input.revision,
      operatorRestrictions: input.restricted
        ? new Map([[buyerOperatorId, { purchasesBlocked: true }]])
        : new Map(),
      insolventOperators: input.insolvent ? new Set([buyerOperatorId]) : new Set(),
      tenderAutomation: new Map(),
      operatingRuntimeByLot: new Map(),
    }),
    updatedAt: EPOCH,
  }).where(eq(economyWorldStates.worldId, WORLD));
}

beforeAll(async () => {
  const templateClient = new PGlite();
  try {
    const templateDb = drizzle(templateClient, { schema });
    await migrate(templateDb, { migrationsFolder: MIGRATIONS_FOLDER });
    migratedDatabase = await templateClient.dumpDataDir();
  } finally {
    await templateClient.close();
  }
});

beforeEach(async () => {
  client = new PGlite({ loadDataDir: migratedDatabase });
  db = drizzle(client, { schema });
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
    }),
    updatedAt: EPOCH,
  });
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

async function insertDailyNonPerformanceEvidence(input: {
  readonly contractId: string;
  readonly reportOperatorId?: string;
  readonly eventOperatorId?: string;
  readonly eventContractId?: string;
  readonly eventAtS?: number;
  readonly projectedContractId?: string;
}): Promise<string> {
  const existingEvents = await db.select({ sequence: domainEvents.sequence }).from(domainEvents);
  const sequence = Math.max(0, ...existingEvents.map((event) => event.sequence)) + 1;
  const eventAtS = input.eventAtS ?? 500;
  const reportOperatorId = input.reportOperatorId ?? sellerOperatorId;
  const eventOperatorId = input.eventOperatorId ?? reportOperatorId;
  const eventContractId = input.eventContractId ?? input.contractId;
  const projectedContractId = input.projectedContractId ?? input.contractId;
  const serviceDay = new Date(EPOCH.getTime() + eventAtS * 1_000).toISOString().slice(0, 10);
  await db.insert(domainEvents).values({
    worldId: WORLD,
    sequence,
    eventType: "operations.train-outcome",
    occurredAt: new Date(EPOCH.getTime() + eventAtS * 1_000),
    payload: { operatorId: eventOperatorId, contractId: eventContractId, trainRunId: "train-100", status: "cancelled" },
  });
  await db.insert(dailyOperationReports).values({
    worldId: WORLD,
    operatorId: reportOperatorId,
    serviceDay,
    sourceFromSequence: sequence,
    sourceThroughSequence: sequence,
    projection: {
      schema: "daily-operations-report/v1",
      serviceDay,
      sourceFromSequence: sequence,
      sourceThroughSequence: sequence,
      contracts: {
        [projectedContractId]: {
          trainRuns: { total: 1, punctual: 0, cancelled: 1, trainKm: "0", missingSeats: 0, missedConnections: 0 },
          settlements: { costCents: "0", contractPenaltyCents: "0" },
        },
      },
      facts: { eventSequences: [sequence], decisions: [] },
    },
    generatedAt: new Date(EPOCH.getTime() + (eventAtS + 1) * 1_000),
  });
  return `daily-operation-report/v1:${serviceDay}`;
}

async function registerVehicle(service: CooperationService, vehicleId = "vehicle-442-001"): Promise<void> {
  await service.registerVehicle({
    worldId: WORLD,
    vehicleId,
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
    const sellerCashAccountId = await ensureCashAccount(sellerOperatorId);
    const buyerCashAccountId = await fundOperator(buyerOperatorId, 500_000n, "contract-standard");
    const created = await service.offerContract(offer());
    expect(created.status).toBe("offered");
    const [otherOfferee] = await db.insert(operators).values({
      worldId: WORLD,
      foundingAccountId: buyerAccountId,
      name: "Zweites Abnehmer-EVU",
    }).returning();
    await expect(service.offerContract(offer({ offereeOperatorId: otherOfferee!.id })))
      .rejects.toMatchObject({ code: "idempotency_conflict" } satisfies Partial<CooperationConflictError>);

    const accepted = await service.respondToContract({
      worldId: WORLD,
      contractId: created.id,
      actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId,
      atS: 150,
      response: "accept",
    });
    expect(accepted.status).toBe("accepted");
    expect(await db.select().from(ledgerTransactions)).toHaveLength(3);
    const entries = await db.select().from(ledgerEntries);
    expect(entries).toHaveLength(6);
    expect(entries.reduce((sum, row) => sum + row.amountCents, 0n)).toBe(0n);
    expect(await cashBalance(buyerCashAccountId)).toBe(375_000n);
    expect(await cashBalance(sellerCashAccountId)).toBe(125_000n);
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

  it("weist Vertragsannahmen ohne ausreichendes positives Cash atomar ab", async () => {
    const service = cooperationService();
    const buyerCashAccountId = await fundOperator(buyerOperatorId, 100_000n, "contract-insufficient");
    const sellerCashAccountId = await ensureCashAccount(sellerOperatorId);
    const created = await service.offerContract(offer({ priceCents: 125_000n, idempotencyKey: "contract-insufficient" }));
    await expect(service.respondToContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    })).rejects.toMatchObject({ code: "insufficient_funds" } satisfies Partial<CooperationConflictError>);
    expect((await service.listContracts(WORLD, buyerOperatorId)).find((contract) => contract.id === created.id)?.status).toBe("offered");
    expect(await cashBalance(buyerCashAccountId)).toBe(100_000n);
    expect(await cashBalance(sellerCashAccountId)).toBe(0n);
  });

  it("reserviert ausstehende Economy-Debits und rechnet ungebuchte Credits nicht als Vertragskaufkraft an", async () => {
    const service = cooperationService();
    const buyerCashAccountId = await fundOperator(buyerOperatorId, 700_000n, "contract-pending-journal");
    const sellerCashAccountId = await ensureCashAccount(sellerOperatorId);
    const created = await service.offerContract(offer({ priceCents: 500_000n, idempotencyKey: "contract-pending-journal" }));
    await enqueuePendingJournal({ operatorId: buyerOperatorId, effectId: "economy:pending-debit", costCents: 500_000n });
    await enqueuePendingJournal({ operatorId: buyerOperatorId, effectId: "economy:pending-credit", revenueCents: 1_000_000n });
    const before = {
      events: (await db.select().from(domainEvents)).length,
      messages: (await db.select().from(mailboxMessages)).length,
      transactions: (await db.select().from(ledgerTransactions)).length,
      entries: (await db.select().from(ledgerEntries)).length,
    };

    await expect(service.respondToContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    })).rejects.toMatchObject({ code: "insufficient_funds" } satisfies Partial<CooperationConflictError>);

    expect((await service.listContracts(WORLD, buyerOperatorId)).find((contract) => contract.id === created.id)?.status).toBe("offered");
    expect(await cashBalance(buyerCashAccountId)).toBe(700_000n);
    expect(await cashBalance(sellerCashAccountId)).toBe(0n);
    expect(await db.select().from(domainEvents)).toHaveLength(before.events);
    expect(await db.select().from(mailboxMessages)).toHaveLength(before.messages);
    expect(await db.select().from(ledgerTransactions)).toHaveLength(before.transactions);
    expect(await db.select().from(ledgerEntries)).toHaveLength(before.entries);
  });

  it("zaehlt ein bereits gebuchtes, aber noch nicht quittiertes Outbox-Journal nicht doppelt", async () => {
    const service = cooperationService();
    const buyerCashAccountId = await fundOperator(buyerOperatorId, 700_000n, "contract-dispatched-unacked");
    const sellerCashAccountId = await ensureCashAccount(sellerOperatorId);
    await enqueuePendingJournal({ operatorId: buyerOperatorId, effectId: "economy:dispatched-unacked", costCents: 500_000n });
    const [expenseAccount] = await db.insert(ledgerAccounts).values({
      worldId: WORLD, operatorId: buyerOperatorId, name: "Economy:energy",
    }).returning();
    const [dispatched] = await db.insert(ledgerTransactions).values({
      worldId: WORLD,
      operatorId: buyerOperatorId,
      idempotencyKey: "economy:dispatched-unacked",
      description: "Bereits projiziert, Outbox-Quittung ausstehend",
      postedAt: EPOCH,
    }).returning();
    await db.insert(ledgerEntries).values([
      { worldId: WORLD, transactionId: dispatched!.id, ledgerAccountId: buyerCashAccountId, amountCents: -500_000n },
      { worldId: WORLD, transactionId: dispatched!.id, ledgerAccountId: expenseAccount!.id, amountCents: 500_000n },
    ]);
    const availability = await db.transaction((tx) => loadEconomyCashAvailabilityForUpdate(tx as never, {
      worldId: WORLD,
      operatorId: buyerOperatorId,
      cashAccountId: buyerCashAccountId,
    }));
    expect(availability).toEqual({ ledgerBalanceCents: 200_000n, pendingDebitCents: 0n, availableCents: 200_000n });

    const created = await service.offerContract(offer({ priceCents: 100_000n, idempotencyKey: "contract-dispatched-unacked" }));
    await expect(service.respondToContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    })).resolves.toMatchObject({ status: "accepted" });
    expect(await cashBalance(buyerCashAccountId)).toBe(100_000n);
    expect(await cashBalance(sellerCashAccountId)).toBe(100_000n);
  });

  it("bindet pending Cash strikt an Welt, EVU und dessen Cash-Konto", async () => {
    const buyerCashAccountId = await fundOperator(buyerOperatorId, 700_000n, "cash-binding-buyer");
    const sellerCashAccountId = await fundOperator(sellerOperatorId, 900_000n, "cash-binding-seller");
    await enqueuePendingJournal({ operatorId: sellerOperatorId, effectId: "economy:foreign-operator-debit", costCents: 500_000n });

    await expect(db.transaction((tx) => loadEconomyCashAvailabilityForUpdate(tx as never, {
      worldId: WORLD,
      operatorId: buyerOperatorId,
      cashAccountId: buyerCashAccountId,
    }))).resolves.toEqual({ ledgerBalanceCents: 700_000n, pendingDebitCents: 0n, availableCents: 700_000n });
    await expect(db.transaction((tx) => loadEconomyCashAvailabilityForUpdate(tx as never, {
      worldId: WORLD,
      operatorId: buyerOperatorId,
      cashAccountId: sellerCashAccountId,
    }))).rejects.toBeInstanceOf(EconomyCashWriterBindingError);
  });

  it("weist entgeltliche Vertragsannahmen ohne autoritativen Economy-Zustand fail-closed ab", async () => {
    const service = cooperationService();
    await fundOperator(buyerOperatorId, 500_000n, "contract-without-economy");
    await ensureCashAccount(sellerOperatorId);
    const created = await service.offerContract(offer({ idempotencyKey: "contract-without-economy" }));
    await db.delete(economyWorldStates).where(eq(economyWorldStates.worldId, WORLD));

    await expect(service.respondToContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    })).rejects.toMatchObject({ code: "economy_state_missing" } satisfies Partial<CooperationConflictError>);
    expect((await service.listContracts(WORLD, buyerOperatorId)).find((contract) => contract.id === created.id)?.status).toBe("offered");
  });

  it("nimmt Nullpreis-Verträge ohne künstliches Cash-Konto oder Economy-Zustand an", async () => {
    const service = cooperationService();
    const created = await service.offerContract(offer({ priceCents: 0n, idempotencyKey: "contract-zero" }));
    await expect(service.respondToContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    })).resolves.toMatchObject({ status: "accepted" });
    expect(await db.select().from(ledgerAccounts)).toHaveLength(0);
    expect(await db.select().from(ledgerTransactions)).toHaveLength(0);
    expect(await db.select().from(ledgerEntries)).toHaveLength(0);
  });

  it("behandelt unlimited als nichtnumerischen Finanzierungsmodus bei weiterhin ausgeglichener Zahlung", async () => {
    const service = cooperationService();
    const buyerCashAccountId = await ensureCashAccount(buyerOperatorId);
    const sellerCashAccountId = await ensureCashAccount(sellerOperatorId);
    await db.insert(operatorStartingCapital).values({
      worldId: WORLD,
      accountId: buyerAccountId,
      operatorId: buyerOperatorId,
      blueprintHash: "a".repeat(64),
      policyKind: "unlimited",
      finiteAmountCents: null,
      ledgerTransactionId: null,
      appliedAt: EPOCH,
    });
    const created = await service.offerContract(offer({ priceCents: 125_000n, idempotencyKey: "contract-unlimited" }));
    await expect(service.respondToContract({
      worldId: WORLD,
      contractId: created.id,
      actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId,
      atS: 150,
      response: "accept",
    })).resolves.toMatchObject({ status: "accepted" });
    expect(await cashBalance(buyerCashAccountId)).toBe(-125_000n);
    expect(await cashBalance(sellerCashAccountId)).toBe(125_000n);
    const paymentEntries = await db.select().from(ledgerEntries);
    expect(paymentEntries.reduce((sum, entry) => sum + entry.amountCents, 0n)).toBe(0n);
  });

  it("serialisiert parallele Vertragsannahmen am Cash des zahlenden EVU", async () => {
    const service = cooperationService();
    const buyerCashAccountId = await fundOperator(buyerOperatorId, 700_000n, "parallel-contracts");
    await ensureCashAccount(sellerOperatorId);
    const contracts = await Promise.all([0, 1].map((index) => service.offerContract(offer({
      subject: { trainRunIds: [`train-${index}`], formationIds: [`formation-${index}`], personnelDutyIds: [`duty-${index}`], pathReceiptIds: [`path-${index}`] },
      priceCents: 500_000n, idempotencyKey: `parallel-contract-${index}`,
    }))));
    const results = await Promise.allSettled(contracts.map((contract) => service.respondToContract({
      worldId: WORLD, contractId: contract.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason)
      .toMatchObject({ code: "insufficient_funds" } satisfies Partial<CooperationConflictError>);
    expect(await cashBalance(buyerCashAccountId)).toBe(200_000n);
  });

  it("bucht entgeltliche Legacy- und Tutorialverträge weiter auf provisioniertes Bank-Cash", async () => {
    const service = cooperationService();
    const buyerCashAccountId = await fundOperator(buyerOperatorId, 200_000n, "legacy-contract", "Bank");
    const sellerCashAccountId = await ensureCashAccount(sellerOperatorId, "Bank");
    const created = await service.offerContract(offer({ idempotencyKey: "legacy-contract" }));
    await service.respondToContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    });
    expect(await cashBalance(buyerCashAccountId)).toBe(75_000n);
    expect(await cashBalance(sellerCashAccountId)).toBe(125_000n);
  });

  it("erzwingt Weltisolation und getrennte Parteien auch gegen direkte Fehlparameter", async () => {
    const service = cooperationService();
    await expect(service.offerContract(offer({ offereeOperatorId: sellerOperatorId }))).rejects.toBeInstanceOf(CooperationValidationError);
    await expect(service.offerContract(offer({ worldId: OTHER_WORLD }))).rejects.toThrow();
    expect(await service.listContracts(OTHER_WORLD, sellerOperatorId)).toHaveLength(0);
  });

  it("replayed Vertragsantworten und Vertragsenden genau einmal und sperrt Schluesselkollisionen", async () => {
    const service = cooperationService();
    const created = await service.offerContract(offer({ priceCents: 0n, terminationNoticeS: 0, idempotencyKey: "command-contract" }));
    const response = {
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept" as const,
      idempotencyKey: "contract-response-command",
    };
    const accepted = await service.respondToContract(response);
    const replayed = await service.respondToContract({ ...response, atS: 151 });
    expect(replayed).toMatchObject({ id: accepted.id, revision: accepted.revision, status: "accepted" });
    await expect(service.respondToContract({ ...response, response: "reject" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" } satisfies Partial<CooperationConflictError>);

    const ending = {
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 160, reason: "Ordentliche Beendigung im Test",
      idempotencyKey: "contract-end-command",
    };
    const ended = await service.terminateContract(ending);
    expect(ended).toMatchObject({
      status: "terminated",
      terminationRequestedAtS: 160,
      terminatedAtS: 160,
      terminationEffectiveAtS: 160,
      endedAtS: 160,
    });
    const endedReplay = await service.terminateContract({ ...ending, atS: 161 });
    expect(endedReplay).toMatchObject({ id: ended.id, revision: ended.revision, status: "terminated" });
    await expect(service.terminateContract({ ...ending, reason: "Andere kollidierende Begruendung" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" } satisfies Partial<CooperationConflictError>);

    const receipts = (await db.select().from(domainEvents)).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload["idempotencyKey"] === response.idempotencyKey || payload["idempotencyKey"] === ending.idempotencyKey;
    });
    expect(receipts).toHaveLength(2);
  });

  it("hält Leistung und Mietfahrzeug bis zur serverseitigen Kündigungsgrenze aktiv", async () => {
    const service = cooperationService();
    await registerVehicle(service, "vehicle-notice");
    const created = await service.offerContract(offer({
      contractType: "vehicle-rental",
      subject: { vehicleIds: ["vehicle-notice"] },
      priceCents: 0n,
      idempotencyKey: "notice-rental",
    }));
    await service.respondToContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    });
    await service.advanceContracts(WORLD, 300);

    const scheduled = await service.terminateContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 400, reason: "Ordentliche Kündigung mit Vertragsfrist",
      idempotencyKey: "notice-rental-end",
    });
    expect(scheduled).toMatchObject({
      status: "termination-pending",
      terminationRequestedAtS: 400,
      terminatedAtS: null,
      terminationEffectiveAtS: 1_000,
      endedAtS: null,
    });
    expect((await db.select().from(vehicleAssets).where(and(eq(vehicleAssets.worldId, WORLD), eq(vehicleAssets.vehicleId, "vehicle-notice"))))[0])
      .toMatchObject({ holderOperatorId: buyerOperatorId, lessorOperatorId: sellerOperatorId });
    const replay = await service.terminateContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 401, reason: "Ordentliche Kündigung mit Vertragsfrist",
      idempotencyKey: "notice-rental-end",
    });
    expect(replay).toMatchObject({ id: created.id, status: "termination-pending", revision: scheduled.revision });
    expect(await service.advanceContracts(WORLD, 999)).toEqual([]);
    expect((await db.select().from(vehicleAssets).where(and(eq(vehicleAssets.worldId, WORLD), eq(vehicleAssets.vehicleId, "vehicle-notice"))))[0])
      .toMatchObject({ holderOperatorId: buyerOperatorId, lessorOperatorId: sellerOperatorId });

    expect(await service.advanceContracts(WORLD, 1_000)).toMatchObject([{ status: "terminated", endedAtS: 1_000 }]);
    expect(await service.advanceContracts(WORLD, 1_001)).toEqual([]);
    expect((await db.select().from(vehicleAssets).where(and(eq(vehicleAssets.worldId, WORLD), eq(vehicleAssets.vehicleId, "vehicle-notice"))))[0])
      .toMatchObject({ holderOperatorId: sellerOperatorId, lessorOperatorId: null });
    expect((await db.select().from(vehicleAssetHistoryEvents).where(and(
      eq(vehicleAssetHistoryEvents.worldId, WORLD),
      eq(vehicleAssetHistoryEvents.vehicleId, "vehicle-notice"),
      eq(vehicleAssetHistoryEvents.eventType, "rental-return"),
    )))).toHaveLength(1);
  });

  it("lehnt fehlende und einer falschen Partei zugeordnete Nichterfüllungsbelege fail-closed ab", async () => {
    const service = cooperationService();
    const created = await service.offerContract(offer({ priceCents: 0n, idempotencyKey: "evidence-missing-contract" }));
    await service.respondToContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    });
    await service.advanceContracts(WORLD, 300);
    const missingReference = "daily-operation-report/v1:2026-12-13";
    await expect(service.terminateContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 600, reason: "Nicht erbrachte Zugleistung",
      evidenceReference: missingReference, idempotencyKey: "evidence-missing",
    })).rejects.toMatchObject({ code: "non_performance_evidence_missing" } satisfies Partial<CooperationConflictError>);

    const foreignReference = await insertDailyNonPerformanceEvidence({ contractId: created.id, reportOperatorId: buyerOperatorId });
    await expect(service.terminateContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 600, reason: "Nicht erbrachte Zugleistung",
      evidenceReference: foreignReference, idempotencyKey: "evidence-foreign",
    })).rejects.toMatchObject({ code: "non_performance_evidence_missing" } satisfies Partial<CooperationConflictError>);
    expect((await service.listContracts(WORLD, buyerOperatorId)).find((contract) => contract.id === created.id)?.status).toBe("active");
  });

  it("verwirft manipulierte Tagesprojektionen ohne exakt gebundenes Domain-Ereignis", async () => {
    const service = cooperationService();
    const created = await service.offerContract(offer({ priceCents: 0n, idempotencyKey: "evidence-manipulated-contract" }));
    await service.respondToContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    });
    await service.advanceContracts(WORLD, 300);
    const reference = await insertDailyNonPerformanceEvidence({ contractId: created.id, eventContractId: "fremder-vertrag" });
    await expect(service.terminateContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 600, reason: "Nicht erbrachte Zugleistung",
      evidenceReference: reference, idempotencyKey: "evidence-manipulated",
    })).rejects.toMatchObject({ code: "non_performance_evidence_unproven" } satisfies Partial<CooperationConflictError>);
    expect((await service.listContracts(WORLD, buyerOperatorId)).find((contract) => contract.id === created.id)?.status).toBe("active");
  });

  it("verwirft auch einen echten Vertragsbeleg außerhalb des Leistungszeitraums", async () => {
    const service = cooperationService();
    const created = await service.offerContract(offer({ priceCents: 0n, idempotencyKey: "evidence-outside-contract" }));
    await service.respondToContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    });
    await service.advanceContracts(WORLD, 300);
    const reference = await insertDailyNonPerformanceEvidence({ contractId: created.id, eventAtS: 250 });
    await expect(service.terminateContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 600, reason: "Ausfall außerhalb des Vertragszeitraums",
      evidenceReference: reference, idempotencyKey: "evidence-outside-contract-end",
    })).rejects.toMatchObject({ code: "non_performance_evidence_unproven" } satisfies Partial<CooperationConflictError>);
    expect((await service.listContracts(WORLD, buyerOperatorId)).find((contract) => contract.id === created.id)?.status).toBe("active");
  });

  it("beendet Nichterfüllung nur mit richtigem Beleg und replayt denselben Befehl genau einmal", async () => {
    const service = cooperationService();
    const created = await service.offerContract(offer({ priceCents: 0n, idempotencyKey: "evidence-valid-contract" }));
    await service.respondToContract({
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 150, response: "accept",
    });
    await service.advanceContracts(WORLD, 300);
    const evidenceReference = await insertDailyNonPerformanceEvidence({ contractId: created.id });
    const command = {
      worldId: WORLD, contractId: created.id, actingOperatorId: buyerOperatorId,
      actingAccountId: buyerAccountId, atS: 600, reason: "Belegter Ausfall der vereinbarten Zugleistung",
      evidenceReference, idempotencyKey: "evidence-valid",
    };
    const ended = await service.terminateContract(command);
    expect(ended).toMatchObject({
      status: "non-performance",
      terminationEvidenceReference: evidenceReference,
      terminationRuleVersion: "zugfolge-contract-non-performance-rule/v1",
      terminatedAtS: 600,
      endedAtS: 600,
    });
    const replay = await service.terminateContract({ ...command, atS: 601 });
    expect(replay).toMatchObject({ id: ended.id, revision: ended.revision, status: "non-performance" });
    expect((await db.select().from(domainEvents)).filter((event) => event.eventType === "cooperation.contract-non-performance")).toHaveLength(1);
  });

  it("begrenzt persistente Vertrags- und Marktlisten mit stabilen Cursoren und getrenntem Archiv", async () => {
    const service = cooperationService();
    const offered = [];
    for (const index of [0, 1, 2]) offered.push(await service.offerContract(offer({
      subject: { trainRunIds: [`train-${index}`], formationIds: [`formation-${index}`], personnelDutyIds: [`duty-${index}`], pathReceiptIds: [`path-${index}`] },
      terms: { summary: `Leistung ${index}` },
      priceCents: 100n + BigInt(index), validFromS: 20, validUntilS: 200,
      responseDeadlineS: 15, terminationNoticeS: 10, offeredAtS: 10 + index,
      idempotencyKey: `page-contract-${index}`,
    })));
    await service.respondToContract({ worldId: WORLD, contractId: offered[0]!.id, actingOperatorId: buyerOperatorId, actingAccountId: buyerAccountId, atS: 12, response: "reject" });

    const first = await service.pageContracts(WORLD, sellerOperatorId, { limit: 1 });
    const insertedBetweenPages = await service.offerContract(offer({
      subject: { trainRunIds: ["train-new"], formationIds: ["formation-new"], personnelDutyIds: ["duty-new"], pathReceiptIds: ["path-new"] },
      terms: { summary: "Nach Seite eins neu" }, priceCents: 999n,
      validFromS: 40, validUntilS: 500, responseDeadlineS: 30,
      terminationNoticeS: 10, offeredAtS: 20, idempotencyKey: "page-contract-newer",
    }));
    const second = await service.pageContracts(WORLD, sellerOperatorId, { limit: 1, cursor: first.nextCursor! });
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(second.items[0]?.id).not.toBe(insertedBetweenPages.id);
    expect(first.items.every((entry) => entry.status !== "rejected")).toBe(true);
    expect((await service.pageContracts(WORLD, sellerOperatorId, { view: "archive" })).items.map((entry) => entry.id)).toContain(offered[0]!.id);
    expect((await service.pageContracts(WORLD, sellerOperatorId, { view: "all", deadlineBeforeS: 205 })).items.every(
      (entry) => entry.responseDeadlineS <= 205 || entry.validUntilS <= 205,
    )).toBe(true);
    expect((await service.pageContracts(WORLD, sellerOperatorId, { view: "all", deadlineBeforeS: 16 })).items.map((entry) => entry.id)).not.toContain(insertedBetweenPages.id);
    await expect(service.pageContracts(WORLD, sellerOperatorId, { cursor: "nicht-kanonisch" })).rejects.toMatchObject({ code: "invalid_page" });
    await expect(service.pageContracts(WORLD, sellerOperatorId, { deadlineBeforeS: -1 })).rejects.toMatchObject({ code: "invalid_page" });
  });
});

describe("M12.2 Fahrzeug-Sekundärmarkt", () => {
  it("replayed Reservierung und Rueckzug genau einmal und sperrt Schluesselkollisionen", async () => {
    const service = cooperationService();
    await Promise.all([registerVehicle(service, "vehicle-command-a"), registerVehicle(service, "vehicle-command-b")]);
    const [first, second] = await Promise.all([
      service.createListing({ worldId: WORLD, vehicleId: "vehicle-command-a", offeringOperatorId: sellerOperatorId, actingAccountId: sellerAccountId, listingType: "sale", priceCents: 1n, listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "listing-command-a" }),
      service.createListing({ worldId: WORLD, vehicleId: "vehicle-command-b", offeringOperatorId: sellerOperatorId, actingAccountId: sellerAccountId, listingType: "sale", priceCents: 1n, listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "listing-command-b" }),
    ]);
    const reservation = {
      worldId: WORLD, listingId: first.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, expectedRevision: first.revision, idempotencyKey: "listing-reserve-command",
    };
    const reserved = await service.reserveListing(reservation);
    const reserveReplay = await service.reserveListing({ ...reservation, atS: 111 });
    expect(reserveReplay).toMatchObject({ id: reserved.id, revision: reserved.revision, status: "reserved" });
    await expect(service.reserveListing({ ...reservation, listingId: second.id }))
      .rejects.toMatchObject({ code: "idempotency_conflict" } satisfies Partial<CooperationConflictError>);

    const cancellation = {
      worldId: WORLD, listingId: second.id, offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, atS: 112, expectedRevision: second.revision,
      idempotencyKey: "listing-cancel-command",
    };
    const cancelled = await service.cancelListing(cancellation);
    const cancelReplay = await service.cancelListing({ ...cancellation, atS: 113 });
    expect(cancelReplay).toMatchObject({ id: cancelled.id, revision: cancelled.revision, status: "cancelled" });
    await expect(service.cancelListing({ ...cancellation, expectedRevision: cancelled.revision }))
      .rejects.toMatchObject({ code: "idempotency_conflict" } satisfies Partial<CooperationConflictError>);

    const receipts = (await db.select().from(domainEvents)).filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload["idempotencyKey"] === reservation.idempotencyKey || payload["idempotencyKey"] === cancellation.idempotencyKey;
    });
    expect(receipts).toHaveLength(2);
  });

  it("laesst gesperrte oder insolvente EVU kein Marktangebot reservieren", async () => {
    const service = cooperationService();
    await registerVehicle(service);
    const listing = await service.createListing({
      worldId: WORLD, vehicleId: "vehicle-442-001", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 1n,
      listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "listing-economy-block",
    });

    await setEconomyPurchaseState({ restricted: true, revision: 1 });
    await expect(service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, expectedRevision: listing.revision,
    })).rejects.toMatchObject({ code: "purchase_blocked" } satisfies Partial<CooperationConflictError>);

    await setEconomyPurchaseState({ insolvent: true, revision: 2 });
    await expect(service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 111, expectedRevision: listing.revision,
    })).rejects.toMatchObject({ code: "purchase_blocked" } satisfies Partial<CooperationConflictError>);
    expect((await service.listListings(WORLD)).find((entry) => entry.id === listing.id)?.status).toBe("open");
  });

  it("überträgt ein offengelegtes Fahrzeug genau einmal mit Historie, Zahlung und Eigentumswechsel", async () => {
    const service = cooperationService();
    const buyerCashAccountId = await fundOperator(buyerOperatorId, 700_000_000n, "sale");
    const buyerLegacyCashId = await ensureCashAccount(buyerOperatorId, "Bank");
    const sellerCashAccountId = await ensureCashAccount(sellerOperatorId);
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
      expectedRevision: listing.revision,
    });
    expect(reserved.reservedUntilS).toBe(710);
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
    expect(await db.select().from(ledgerTransactions)).toHaveLength(3);
    expect(await cashBalance(buyerCashAccountId)).toBe(75_000_000n);
    expect(await cashBalance(buyerLegacyCashId)).toBe(0n);
    expect(await cashBalance(sellerCashAccountId)).toBe(625_000_000n);
    const transferMessages = await db.select().from(mailboxMessages).where(and(
      eq(mailboxMessages.worldId, WORLD),
      eq(mailboxMessages.messageType, "vehicle-market.transferred"),
    ));
    expect(transferMessages).toHaveLength(2);
    expect(transferMessages.every((entry) => (
      entry.payload as Readonly<Record<string, unknown>>
    )["listingId"] === listing.id)).toBe(true);

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
    expect(await cashBalance(buyerCashAccountId)).toBe(75_000_000n);
    await expect(service.transferListing({
      worldId: WORLD,
      listingId: "99999999-9999-4999-8999-999999999999",
      buyerOperatorId,
      actingAccountId: buyerAccountId,
      atS: 120,
      expectedRevision: reserved.revision,
      idempotencyKey: "transfer-sale-1",
    })).rejects.toMatchObject({ code: "idempotency_conflict" } satisfies Partial<CooperationConflictError>);
    await expect(service.reverseTransfer({
      worldId: WORLD,
      listingId: listing.id,
      buyerOperatorId,
      actingAccountId: buyerAccountId,
      atS: 130,
      reasonCode: "undisclosed-brake-damage",
      idempotencyKey: "transfer-sale-1",
    })).rejects.toMatchObject({ code: "idempotency_conflict" } satisfies Partial<CooperationConflictError>);
  });

  it("weist den Fahrzeugkauf gegen ausstehende Economy-Debits ohne Fach- oder Ledgerwirkung ab", async () => {
    const service = cooperationService();
    const buyerCashAccountId = await fundOperator(buyerOperatorId, 700_000n, "market-pending-journal");
    const sellerCashAccountId = await ensureCashAccount(sellerOperatorId);
    await registerVehicle(service, "vehicle-pending-journal");
    const listing = await service.createListing({
      worldId: WORLD, vehicleId: "vehicle-pending-journal", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 500_000n,
      listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "listing-pending-journal",
    });
    const reserved = await service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, expectedRevision: listing.revision,
    });
    await enqueuePendingJournal({ operatorId: buyerOperatorId, effectId: "market:pending-debit", costCents: 500_000n });
    await enqueuePendingJournal({ operatorId: buyerOperatorId, effectId: "market:pending-credit", revenueCents: 1_000_000n });
    const before = {
      events: (await db.select().from(domainEvents)).length,
      messages: (await db.select().from(mailboxMessages)).length,
      transactions: (await db.select().from(ledgerTransactions)).length,
      entries: (await db.select().from(ledgerEntries)).length,
      history: (await service.listVehicleHistory(WORLD, "vehicle-pending-journal")).length,
    };

    await expect(service.transferListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 120, expectedRevision: reserved.revision, idempotencyKey: "transfer-pending-journal",
    })).rejects.toMatchObject({ code: "insufficient_funds" } satisfies Partial<CooperationConflictError>);

    expect((await db.select().from(vehicleMarketListings).where(and(
      eq(vehicleMarketListings.worldId, WORLD), eq(vehicleMarketListings.id, listing.id),
    )))[0]).toMatchObject({ status: "reserved", revision: reserved.revision });
    expect((await db.select().from(vehicleAssets).where(and(
      eq(vehicleAssets.worldId, WORLD), eq(vehicleAssets.vehicleId, "vehicle-pending-journal"),
    )))[0]).toMatchObject({ ownerOperatorId: sellerOperatorId, holderOperatorId: sellerOperatorId });
    expect(await service.listVehicleHistory(WORLD, "vehicle-pending-journal")).toHaveLength(before.history);
    expect(await cashBalance(buyerCashAccountId)).toBe(700_000n);
    expect(await cashBalance(sellerCashAccountId)).toBe(0n);
    expect(await db.select().from(domainEvents)).toHaveLength(before.events);
    expect(await db.select().from(mailboxMessages)).toHaveLength(before.messages);
    expect(await db.select().from(ledgerTransactions)).toHaveLength(before.transactions);
    expect(await db.select().from(ledgerEntries)).toHaveLength(before.entries);
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
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 1n,
      listedAtS: 101, expiresAtS: 2_000, idempotencyKey: "listing-a",
    })).rejects.toMatchObject({ code: "idempotency_conflict" } satisfies Partial<CooperationConflictError>);
    await expect(service.createListing({
      worldId: WORLD, vehicleId: "vehicle-442-001", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 2n,
      listedAtS: 101, expiresAtS: 1_000, idempotencyKey: "listing-b",
    })).rejects.toThrow();
    const reserved = await service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, expectedRevision: listing.revision,
    });
    await db.update(vehicleAssets).set({ conditionBasisPoints: 8_000 }).where(and(
      eq(vehicleAssets.worldId, WORLD), eq(vehicleAssets.vehicleId, "vehicle-442-001"),
    ));
    await expect(service.transferListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 120, expectedRevision: reserved.revision, idempotencyKey: "changed-disclosure",
    })).rejects.toMatchObject({ code: "disclosure_changed" } satisfies Partial<CooperationConflictError>);
  });

  it("begrenzt Reservierungen serverseitig auf 600 Sekunden und behandelt ihr Ende halb-offen", async () => {
    const service = cooperationService();
    await registerVehicle(service);
    const listing = await service.createListing({
      worldId: WORLD, vehicleId: "vehicle-442-001", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 1n,
      listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "listing-half-open",
    });
    const reserved = await service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 100, expectedRevision: listing.revision,
    });
    expect(reserved.reservedUntilS).toBe(700);
    await expect(service.transferListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 700, expectedRevision: reserved.revision, idempotencyKey: "transfer-at-open-end",
    })).rejects.toMatchObject({ code: "reservation_required" } satisfies Partial<CooperationConflictError>);
  });

  it("erzeugt beim Kauf niemals ein fehlendes Cash-Konto", async () => {
    const service = cooperationService();
    await ensureCashAccount(sellerOperatorId);
    await registerVehicle(service);
    const listing = await service.createListing({
      worldId: WORLD, vehicleId: "vehicle-442-001", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 1n,
      listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "listing-without-cash-account",
    });
    const reserved = await service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, expectedRevision: listing.revision,
    });
    await expect(service.transferListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 120, expectedRevision: reserved.revision, idempotencyKey: "transfer-without-cash-account",
    })).rejects.toMatchObject({ code: "cash_account_missing" } satisfies Partial<CooperationConflictError>);
    expect(await db.select().from(ledgerAccounts).where(and(
      eq(ledgerAccounts.worldId, WORLD), eq(ledgerAccounts.operatorId, buyerOperatorId),
    ))).toHaveLength(0);
  });

  it("serialisiert parallele Käufe am positiven Bankguthaben und verhindert Überziehung", async () => {
    const service = cooperationService();
    const buyerCashAccountId = await fundOperator(buyerOperatorId, 700_000_000n, "parallel-purchases");
    await ensureCashAccount(sellerOperatorId);
    await Promise.all([
      registerVehicle(service, "vehicle-parallel-a"),
      registerVehicle(service, "vehicle-parallel-b"),
    ]);
    const listings = await Promise.all(["vehicle-parallel-a", "vehicle-parallel-b"].map((vehicleId, index) => service.createListing({
      worldId: WORLD, vehicleId, offeringOperatorId: sellerOperatorId, actingAccountId: sellerAccountId,
      listingType: "sale", priceCents: 500_000_000n, listedAtS: 100, expiresAtS: 1_000,
      idempotencyKey: `parallel-listing-${index}`,
    })));
    const reservations = await Promise.all(listings.map((listing) => service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, expectedRevision: listing.revision,
    })));
    const purchases = await Promise.allSettled(reservations.map((listing, index) => service.transferListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 120, expectedRevision: listing.revision, idempotencyKey: `parallel-transfer-${index}`,
    })));
    expect(purchases.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = purchases.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "insufficient_funds" } satisfies Partial<CooperationConflictError>);
    const assets = await db.select().from(vehicleAssets).where(eq(vehicleAssets.worldId, WORLD));
    expect(assets.filter((asset) => asset.ownerOperatorId === buyerOperatorId)).toHaveLength(1);
    expect(await cashBalance(buyerCashAccountId)).toBe(200_000_000n);
  });

  it("rolls back market, ownership, ledger and events when the fleet single-writer rejects", async () => {
    const service = new CooperationService(db, undefined, {
      async apply() {
        throw new Error("asset_holding_conflict");
      },
    });
    await fundOperator(buyerOperatorId, 700_000_000n, "rollback");
    await ensureCashAccount(sellerOperatorId);
    await registerVehicle(service);
    const listing = await service.createListing({
      worldId: WORLD, vehicleId: "vehicle-442-001", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 625_000_000n,
      listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "listing-atomic",
    });
    const reserved = await service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, expectedRevision: listing.revision,
    });
    const eventCount = (await db.select().from(domainEvents)).length;
    const transactionCount = (await db.select().from(ledgerTransactions)).length;

    await expect(service.transferListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 120, expectedRevision: reserved.revision, idempotencyKey: "transfer-atomic",
    })).rejects.toThrow("asset_holding_conflict");

    expect(await db.select().from(vehicleAssets)).toMatchObject([{
      ownerOperatorId: sellerOperatorId, holderOperatorId: sellerOperatorId, revision: 1,
    }]);
    expect(await db.select().from(vehicleMarketListings)).toMatchObject([{ status: "reserved", revision: 2 }]);
    expect(await db.select().from(ledgerTransactions)).toHaveLength(transactionCount);
    expect(await db.select().from(domainEvents)).toHaveLength(eventCount);
  });

  it("vermietet mit Vertrag und wickelt einen nachgewiesenen verdeckten Mangel vollständig zurück", async () => {
    const service = verifiedReversalService();
    const buyerLegacyCashId = await fundOperator(buyerOperatorId, 10_000_000n, "rental", "Bank");
    const sellerLegacyCashId = await ensureCashAccount(sellerOperatorId, "Bank");
    await registerVehicle(service);
    const listing = await service.createListing({
      worldId: WORLD, vehicleId: "vehicle-442-001", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "rental", priceCents: 2_000_000n,
      listedAtS: 100, expiresAtS: 1_000, rentalValidUntilS: 10_000, idempotencyKey: "listing-rental",
    });
    const reserved = await service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, expectedRevision: listing.revision,
    });
    const transferred = await service.transferListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 120, expectedRevision: reserved.revision, idempotencyKey: "rental-transfer",
    });
    expect(transferred.contract).toMatchObject({ contractType: "vehicle-rental", status: "active" });
    expect(transferred.vehicle).toMatchObject({ ownerOperatorId: sellerOperatorId, holderOperatorId: buyerOperatorId, lessorOperatorId: sellerOperatorId });

    await expect(cooperationService().reverseTransfer({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 130, reasonCode: "undisclosed-player-reported", idempotencyKey: "unverified-reversal",
    })).rejects.toMatchObject({ code: "reversal_evidence_missing" } satisfies Partial<CooperationConflictError>);

    const reversed = await service.reverseTransfer({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 130, reasonCode: "undisclosed-brake-damage", idempotencyKey: "rental-reversal",
    });
    expect(reversed.listing.status).toBe("reversed");
    expect(reversed.vehicle).toMatchObject({ ownerOperatorId: sellerOperatorId, holderOperatorId: sellerOperatorId, lessorOperatorId: null });
    expect(await cashBalance(buyerLegacyCashId)).toBe(10_000_000n);
    expect(await cashBalance(sellerLegacyCashId)).toBe(0n);
    expect(await service.listVehicleHistory(WORLD, "vehicle-442-001")).toHaveLength(3);
    expect(await db.select().from(ledgerTransactions)).toHaveLength(5);
    expect(await db.select().from(vehicleMarketListings).where(eq(vehicleMarketListings.worldId, OTHER_WORLD))).toHaveLength(0);
    const reversalMessages = await db.select().from(mailboxMessages).where(and(
      eq(mailboxMessages.worldId, WORLD),
      eq(mailboxMessages.messageType, "vehicle-market.reversed"),
    ));
    expect(reversalMessages).toHaveLength(2);
    expect(reversalMessages.every((entry) => (
      entry.payload as Readonly<Record<string, unknown>>
    )["listingId"] === listing.id)).toBe(true);
  });

  it("wickelt einen belegten Mangel ohne gedeckte Verkäufererstattung vollständig nicht ab", async () => {
    const service = verifiedReversalService();
    await fundOperator(buyerOperatorId, 3_000_000n, "reversal-buyer");
    const sellerCashId = await ensureCashAccount(sellerOperatorId);
    await registerVehicle(service, "vehicle-reversal-liquidity");
    const listing = await service.createListing({
      worldId: WORLD, vehicleId: "vehicle-reversal-liquidity", offeringOperatorId: sellerOperatorId,
      actingAccountId: sellerAccountId, listingType: "sale", priceCents: 2_000_000n,
      listedAtS: 100, expiresAtS: 1_000, idempotencyKey: "listing-reversal-liquidity",
    });
    const reserved = await service.reserveListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 110, expectedRevision: listing.revision,
    });
    const transferred = await service.transferListing({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 120, expectedRevision: reserved.revision, idempotencyKey: "transfer-reversal-liquidity",
    });
    const [expenseAccount] = await db.insert(ledgerAccounts).values({
      worldId: WORLD, operatorId: sellerOperatorId, name: "Testausgabe",
    }).returning();
    const [spend] = await db.insert(ledgerTransactions).values({
      worldId: WORLD, operatorId: sellerOperatorId, idempotencyKey: "spend-sale-proceeds",
      description: "Erlös anderweitig ausgegeben", postedAt: EPOCH,
    }).returning();
    await db.insert(ledgerEntries).values([
      { worldId: WORLD, transactionId: spend!.id, ledgerAccountId: sellerCashId, amountCents: -1_500_000n },
      { worldId: WORLD, transactionId: spend!.id, ledgerAccountId: expenseAccount!.id, amountCents: 1_500_000n },
    ]);
    const before = {
      events: (await db.select().from(domainEvents)).length,
      history: (await service.listVehicleHistory(WORLD, "vehicle-reversal-liquidity")).length,
      transactions: (await db.select().from(ledgerTransactions)).length,
    };

    await expect(service.reverseTransfer({
      worldId: WORLD, listingId: listing.id, buyerOperatorId, actingAccountId: buyerAccountId,
      atS: 130, reasonCode: "undisclosed-brake-damage", idempotencyKey: "reversal-without-refund",
    })).rejects.toMatchObject({ code: "insufficient_funds" } satisfies Partial<CooperationConflictError>);

    expect((await db.select().from(vehicleMarketListings).where(and(
      eq(vehicleMarketListings.worldId, WORLD), eq(vehicleMarketListings.id, listing.id),
    )))[0]).toMatchObject({ status: "transferred", revision: transferred.listing.revision });
    expect((await db.select().from(vehicleAssets).where(and(
      eq(vehicleAssets.worldId, WORLD), eq(vehicleAssets.vehicleId, "vehicle-reversal-liquidity"),
    )))[0]).toMatchObject({ ownerOperatorId: buyerOperatorId, holderOperatorId: buyerOperatorId });
    expect(await service.listVehicleHistory(WORLD, "vehicle-reversal-liquidity")).toHaveLength(before.history);
    expect(await db.select().from(domainEvents)).toHaveLength(before.events);
    expect(await db.select().from(ledgerTransactions)).toHaveLength(before.transactions);
    expect(await cashBalance(sellerCashId)).toBe(500_000n);
  });
});
