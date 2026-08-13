import { PGlite } from "@electric-sql/pglite";
import {
  accounts,
  alphaWorldProfiles,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  MIGRATIONS_FOLDER,
  operatingProgramVersions,
  operatorContracts,
  operators,
  operatorStartingCapital,
  worldAccesses,
  worldFinalRankings,
  worlds,
  vehicleAssets,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { encodeEconomyValue } from "@zugfolge/economy";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AlphaConflictError } from "./errors.js";
import {
  foundPublicOperatorWithStartingCapital,
  STARTING_CAPITAL_EQUITY_ACCOUNT_NAME,
} from "./starting-capital.js";
import { validateWorldBlueprint, type AlphaWorldBlueprintV1 } from "./world.js";
import { WorldEndService } from "./world-end.js";

const WORLD_A = "11111111-1111-4111-8111-111111111111";
const WORLD_B = "22222222-2222-4222-8222-222222222222";

function blueprint(
  policy: AlphaWorldBlueprintV1["startingCapitalPolicy"],
  seed = 42n,
): AlphaWorldBlueprintV1 {
  return {
    schemaVersion: "zugfolge-alpha-world-blueprint/v1",
    regionId: "mitteldeutschland-b",
    regionVariant: "B",
    seed,
    profileKind: "public",
    accelerationFactor: 1,
    periodCount: 1,
    startingCapitalPolicy: policy,
    releases: {
      infra: "a".repeat(64),
      timetable: "b".repeat(64),
      fleet: "c".repeat(64),
      economy: "d".repeat(64),
    },
    lots: [{
      lotId: "lot-1",
      contractEndsAtPeriod: 1,
      trainRunIds: ["train-1"],
      pathReceiptIds: ["path-1"],
      vehicleIds: ["vehicle-1"],
      personnelDutyIds: ["duty-1"],
      circulationIds: ["circulation-1"],
      operatingProgramIds: ["program-1"],
    }],
    conflictCheckHash: "e".repeat(64),
    tenderCalendarHash: "f".repeat(64),
  };
}

describe("oeffentliche StartingCapitalPolicy", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterEach(async () => client.close());

  async function setupWorld(
    worldId: string,
    policy: AlphaWorldBlueprintV1["startingCapitalPolicy"],
    subject: string,
    seed = 42n,
  ) {
    const contract = blueprint(policy, seed);
    const hash = validateWorldBlueprint(contract);
    await db.insert(worlds).values({
      id: worldId,
      name: `Welt ${worldId.slice(0, 4)}`,
      schedulePeriodWeeks: 4,
      epoch: new Date("2026-01-01T00:00:00.000Z"),
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
    });
    await db.insert(alphaWorldProfiles).values({
      worldId,
      profileKind: "public",
      regionId: contract.regionId,
      regionVariant: contract.regionVariant,
      worldSeed: contract.seed,
      accelerationFactor: contract.accelerationFactor,
      infraReleaseHash: contract.releases.infra,
      timetableReleaseHash: contract.releases.timetable,
      fleetReleaseHash: contract.releases.fleet,
      economyReleaseHash: contract.releases.economy,
      blueprint: encodeEconomyValue(contract),
      blueprintHash: hash,
      periodCount: contract.periodCount,
      currentPeriod: 0,
      state: "running",
      startedAtS: 0,
    });
    await db.insert(worldAccesses).values({
      worldId,
      keycloakSubject: subject,
      acceptedWorldContractHash: hash,
      acceptedStartingCapitalPolicy: policy,
      worldContractAcceptedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const [account] = await db.insert(accounts).values({ worldId, keycloakSubject: subject, displayName: subject }).returning();
    if (account === undefined) throw new Error("Testkonto fehlt.");
    return { contract, hash, account };
  }

  async function start(worldId: string, subject: string, name = `EVU ${subject}`) {
    return foundPublicOperatorWithStartingCapital(db, {
      worldId,
      foundingKeycloakSubject: subject,
      name,
    });
  }

  it("bucht einen positiven i64-Centbetrag exakt ausgeglichen", async () => {
    const amount = 12_345_678n;
    await setupWorld(WORLD_A, { kind: "finite", amountCents: amount.toString() }, "anna");
    const operator = await start(WORLD_A, "anna");

    const accountsOfOperator = await db.select().from(ledgerAccounts).where(and(
      eq(ledgerAccounts.worldId, WORLD_A),
      eq(ledgerAccounts.operatorId, operator.id),
    ));
    const byName = new Map(accountsOfOperator.map((account) => [account.name, account.id] as const));
    const transactions = await db.select().from(ledgerTransactions).where(and(
      eq(ledgerTransactions.worldId, WORLD_A),
      eq(ledgerTransactions.operatorId, operator.id),
    ));
    expect(transactions).toHaveLength(1);
    const entries = await db.select().from(ledgerEntries).where(and(
      eq(ledgerEntries.worldId, WORLD_A),
      eq(ledgerEntries.transactionId, transactions[0]!.id),
    ));
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + entry.amountCents, 0n)).toBe(0n);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ ledgerAccountId: byName.get("Economy:Kasse"), amountCents: amount }),
      expect.objectContaining({ ledgerAccountId: byName.get(STARTING_CAPITAL_EQUITY_ACCOUNT_NAME), amountCents: -amount }),
    ]));
    expect(await db.select().from(vehicleAssets).where(and(
      eq(vehicleAssets.worldId, WORLD_A),
      eq(vehicleAssets.ownerOperatorId, operator.id),
    ))).toHaveLength(0);
    expect(await db.select().from(operatorContracts).where(and(
      eq(operatorContracts.worldId, WORLD_A),
      eq(operatorContracts.offerorOperatorId, operator.id),
    ))).toHaveLength(0);
    expect(await db.select().from(operatingProgramVersions).where(and(
      eq(operatingProgramVersions.worldId, WORLD_A),
      eq(operatingProgramVersions.operatorId, operator.id),
    ))).toHaveLength(0);
  });

  it("materialisiert auch null genau einmal als nachvollziehbare 0/0-Doppelbuchung", async () => {
    await setupWorld(WORLD_A, { kind: "finite", amountCents: "0" }, "zero");
    const operator = await start(WORLD_A, "zero");
    const transactions = await db.select().from(ledgerTransactions).where(and(
      eq(ledgerTransactions.worldId, WORLD_A),
      eq(ledgerTransactions.operatorId, operator.id),
    ));
    const entries = await db.select().from(ledgerEntries).where(and(
      eq(ledgerEntries.worldId, WORLD_A),
      eq(ledgerEntries.transactionId, transactions[0]!.id),
    ));
    expect(transactions).toHaveLength(1);
    expect(entries.map((entry) => entry.amountCents)).toEqual([0n, 0n]);
  });

  it("ist bei Retry und paralleler Gruendung genau einmal wirksam", async () => {
    await setupWorld(WORLD_A, { kind: "finite", amountCents: "500000" }, "parallel");
    const [first, second] = await Promise.all([
      start(WORLD_A, "parallel"),
      start(WORLD_A, "parallel"),
    ]);
    const replay = await start(WORLD_A, "parallel");
    expect(new Set([first.id, second.id, replay.id])).toEqual(new Set([first.id]));
    expect(await db.select().from(operatorStartingCapital).where(eq(operatorStartingCapital.worldId, WORLD_A))).toHaveLength(1);
    expect(await db.select().from(operators).where(eq(operators.worldId, WORLD_A))).toHaveLength(1);
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.worldId, WORLD_A))).toHaveLength(1);
  });

  it("isoliert Claim, EVU und Buchung zwischen Welten", async () => {
    await setupWorld(WORLD_A, { kind: "finite", amountCents: "100" }, "same-subject", 42n);
    await setupWorld(WORLD_B, { kind: "finite", amountCents: "900" }, "same-subject", 43n);
    const [left, right] = await Promise.all([
      start(WORLD_A, "same-subject", "Welt-A-Bahn"),
      start(WORLD_B, "same-subject", "Welt-B-Bahn"),
    ]);
    expect(left.worldId).toBe(WORLD_A);
    expect(right.worldId).toBe(WORLD_B);
    const cash = await db.select({ worldId: ledgerEntries.worldId, amount: ledgerEntries.amountCents })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, and(
        eq(ledgerEntries.worldId, ledgerAccounts.worldId),
        eq(ledgerEntries.ledgerAccountId, ledgerAccounts.id),
        eq(ledgerAccounts.name, "Economy:Kasse"),
      ));
    expect(cash).toEqual(expect.arrayContaining([
      { worldId: WORLD_A, amount: 100n },
      { worldId: WORLD_B, amount: 900n },
    ]));
  });

  it("weist Policywechsel, Hash-Rebinding und Blueprint-Manipulation ab", async () => {
    const setup = await setupWorld(WORLD_A, { kind: "finite", amountCents: "100" }, "tamper");
    const changed = blueprint({ kind: "finite", amountCents: "200" });
    await expect(db.update(alphaWorldProfiles).set({
      blueprint: encodeEconomyValue(changed),
      blueprintHash: validateWorldBlueprint(changed),
    }).where(eq(alphaWorldProfiles.worldId, WORLD_A))).rejects.toThrow();

    await expect(db.update(alphaWorldProfiles).set({
      blueprint: encodeEconomyValue({ ...setup.contract, startingCapitalPolicy: { kind: "finite", amountCents: "300" } }),
      blueprintHash: setup.hash,
    }).where(eq(alphaWorldProfiles.worldId, WORLD_A))).rejects.toThrow();

    await db.update(worldAccesses).set({ acceptedStartingCapitalPolicy: { kind: "unlimited" } }).where(and(
      eq(worldAccesses.worldId, WORLD_A),
      eq(worldAccesses.keycloakSubject, "tamper"),
    ));
    await expect(start(WORLD_A, "tamper")).rejects.toBeInstanceOf(AlphaConflictError);
    expect(await db.select().from(operators).where(eq(operators.worldId, WORLD_A))).toHaveLength(0);
  });

  it("speichert unlimited als nichtnumerischen Modus ohne Fantasie-Startbuchung", async () => {
    await setupWorld(WORLD_A, { kind: "unlimited" }, "sandbox");
    const operator = await start(WORLD_A, "sandbox");
    const [mode] = await db.select().from(operatorStartingCapital).where(and(
      eq(operatorStartingCapital.worldId, WORLD_A),
      eq(operatorStartingCapital.operatorId, operator.id),
    ));
    expect(mode).toMatchObject({ policyKind: "unlimited", finiteAmountCents: null, ledgerTransactionId: null });
    expect(await db.select().from(ledgerTransactions).where(and(
      eq(ledgerTransactions.worldId, WORLD_A),
      eq(ledgerTransactions.operatorId, operator.id),
    ))).toHaveLength(0);
  });

  it("laesst Startkapital und unlimited-Modus aus der Wirtschaftsrangliste heraus", async () => {
    const setup = await setupWorld(WORLD_A, { kind: "finite", amountCents: "9000000000" }, "ranked");
    await start(WORLD_A, "ranked", "Kapital-Bahn");
    const [comparisonAccount] = await db.insert(accounts).values({ worldId: WORLD_A, keycloakSubject: "comparison", displayName: "comparison" }).returning();
    if (comparisonAccount === undefined) throw new Error("Vergleichskonto fehlt.");
    await db.insert(worldAccesses).values({
      worldId: WORLD_A,
      keycloakSubject: "comparison",
      acceptedWorldContractHash: setup.hash,
      acceptedStartingCapitalPolicy: setup.contract.startingCapitalPolicy,
      worldContractAcceptedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db.insert(operators).values({ worldId: WORLD_A, foundingAccountId: comparisonAccount.id, name: "Vergleichsbahn" });

    const ending = new WorldEndService(db);
    await ending.beginClosure(WORLD_A, 10);
    await ending.finalize(WORLD_A, 20);
    const economyRanks = await db.select().from(worldFinalRankings).where(and(
      eq(worldFinalRankings.worldId, WORLD_A),
      eq(worldFinalRankings.rankingType, "economy"),
    ));
    expect(economyRanks.map((row) => ({ rank: row.rank, score: row.score }))).toEqual([
      { rank: 1, score: 0n },
      { rank: 1, score: 0n },
    ]);
  });
});
