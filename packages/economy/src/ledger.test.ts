import { PGlite } from "@electric-sql/pglite";
import { ledgerEntries, MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import { foundOperator, OperatorNotFoundError } from "@zugfolge/operators";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import fc from "fast-check";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sumEntries } from "./balance.js";
import {
  DuplicateLedgerAccountNameError,
  ensureLedgerAccount,
  ForeignLedgerAccountError,
  IdempotentLedgerContentConflictError,
  IncompleteTransactionError,
  initializeOperatorStartingCapital,
  ledgerAccountBalance,
  listLedgerAccounts,
  listLedgerTransactions,
  openLedgerAccount,
  postLedgerTransaction,
  UnbalancedTransactionError,
  type EconomyDatabase,
} from "./ledger.js";

const WORLD_LHE = "11111111-1111-1111-1111-111111111111";
const WORLD_MIDDLE_GERMANY = "22222222-2222-2222-2222-222222222222";
const POSTED_AT = new Date("2026-01-05T08:00:00Z");

let client: PGlite;
let db: EconomyDatabase;
let identityDb: IdentityDatabase;

beforeEach(async () => {
  client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });
  db = pgliteDb;
  identityDb = pgliteDb;

  await pgliteDb.insert(worlds).values([
    { id: WORLD_LHE, name: "Leipzig–Halle–Erfurt", schedulePeriodWeeks: 4, epoch: new Date("2026-01-01T00:00:00Z") },
    {
      id: WORLD_MIDDLE_GERMANY,
      name: "Mitteldeutschland",
      schedulePeriodWeeks: 4,
      epoch: new Date("2026-01-01T00:00:00Z"),
    },
  ]);
});

afterEach(async () => {
  await client.close();
});

async function foundeElbtalbahn(): Promise<string> {
  return foundeOperator(WORLD_LHE, "kc-anna", "Anna", "Elbtalbahn");
}

async function foundeOperator(worldId: string, keycloakSubject: string, displayName: string, name: string): Promise<string> {
  await requestWorldAccess(identityDb, { worldId, keycloakSubject, displayName });
  const operator = await foundOperator(identityDb, {
    worldId,
    foundingKeycloakSubject: keycloakSubject,
    name,
  });
  return operator.id;
}

describe("openLedgerAccount", () => {
  it("eröffnet ein Ledger-Konto in den Büchern eines EVU", async () => {
    const operatorId = await foundeElbtalbahn();

    const account = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Kasse" });

    expect(account.name).toBe("Kasse");
    expect(account.operatorId).toBe(operatorId);
  });

  it("lehnt ein zweites Ledger-Konto mit demselben Namen für dasselbe EVU ab", async () => {
    const operatorId = await foundeElbtalbahn();
    await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Kasse" });

    await expect(openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Kasse" })).rejects.toBeInstanceOf(
      DuplicateLedgerAccountNameError,
    );
  });

  it("lehnt ein Ledger-Konto für ein nicht existierendes EVU ab", async () => {
    await expect(
      openLedgerAccount(db, {
        worldId: WORLD_LHE,
        operatorId: "33333333-3333-3333-3333-333333333333",
        name: "Kasse",
      }),
    ).rejects.toBeInstanceOf(OperatorNotFoundError);
  });
});

describe("ensureLedgerAccount", () => {
  it("liefert bei Wiederholung dasselbe welt- und EVU-gebundene Konto", async () => {
    const operatorId = await foundeElbtalbahn();

    const first = await ensureLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Kasse" });
    const second = await ensureLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Kasse" });

    expect(second.id).toBe(first.id);
    expect(await listLedgerAccounts(db, { worldId: WORLD_LHE, operatorId })).toHaveLength(1);
  });
});

describe("postLedgerTransaction", () => {
  it("bucht eine ausgeglichene Transaktion und aktualisiert beide Salden", async () => {
    const operatorId = await foundeElbtalbahn();
    const kasse = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Kasse" });
    const trassenentgelt = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Trassenentgelt" });

    await postLedgerTransaction(db, {
      worldId: WORLD_LHE,
      operatorId,
      description: "Trassenentgelt Januar",
      postedAt: POSTED_AT,
      entries: [
        { ledgerAccountId: kasse.id, amountCents: -12_345n },
        { ledgerAccountId: trassenentgelt.id, amountCents: 12_345n },
      ],
    });

    expect(await ledgerAccountBalance(db, { worldId: WORLD_LHE, ledgerAccountId: kasse.id })).toBe(-12_345n);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_LHE, ledgerAccountId: trassenentgelt.id })).toBe(12_345n);
  });

  it("lehnt eine Transaktion mit nur einer Buchung ab", async () => {
    const operatorId = await foundeElbtalbahn();
    const kasse = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Kasse" });

    await expect(
      postLedgerTransaction(db, {
        worldId: WORLD_LHE,
        operatorId,
        description: "Unvollständig",
        postedAt: POSTED_AT,
        entries: [{ ledgerAccountId: kasse.id, amountCents: 100n }],
      }),
    ).rejects.toBeInstanceOf(IncompleteTransactionError);
  });

  it("lehnt eine nicht ausgeglichene Transaktion ab und schreibt nichts", async () => {
    const operatorId = await foundeElbtalbahn();
    const kasse = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Kasse" });
    const trassenentgelt = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Trassenentgelt" });

    await expect(
      postLedgerTransaction(db, {
        worldId: WORLD_LHE,
        operatorId,
        description: "Unausgeglichen",
        postedAt: POSTED_AT,
        entries: [
          { ledgerAccountId: kasse.id, amountCents: -100n },
          { ledgerAccountId: trassenentgelt.id, amountCents: 50n },
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedTransactionError);

    expect(await listLedgerTransactions(db, { worldId: WORLD_LHE, operatorId })).toHaveLength(0);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_LHE, ledgerAccountId: kasse.id })).toBe(0n);
  });

  it("lehnt eine Buchung auf ein fremdes Ledger-Konto ab", async () => {
    const operatorId = await foundeElbtalbahn();
    const kasse = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Kasse" });

    await requestWorldAccess(identityDb, { worldId: WORLD_LHE, keycloakSubject: "kc-ben", displayName: "Ben" });
    const fremdesEvu = await foundOperator(identityDb, {
      worldId: WORLD_LHE,
      foundingKeycloakSubject: "kc-ben",
      name: "Saalebahn Cargo",
    });
    const fremdeKasse = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId: fremdesEvu.id, name: "Kasse" });

    await expect(
      postLedgerTransaction(db, {
        worldId: WORLD_LHE,
        operatorId,
        description: "Missbrauchsversuch",
        postedAt: POSTED_AT,
        entries: [
          { ledgerAccountId: kasse.id, amountCents: -100n },
          { ledgerAccountId: fremdeKasse.id, amountCents: 100n },
        ],
      }),
    ).rejects.toBeInstanceOf(ForeignLedgerAccountError);
  });

  it("prueft bei idempotenter Wiederholung den vollstaendigen Buchungsinhalt", async () => {
    const operatorId = await foundeElbtalbahn();
    const kasse = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Kasse" });
    const ertrag = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Ertrag" });
    const input = {
      worldId: WORLD_LHE,
      operatorId,
      description: "Idempotente Buchung",
      postedAt: POSTED_AT,
      idempotencyKey: "ledger-replay-1",
      entries: [
        { ledgerAccountId: kasse.id, amountCents: 100n },
        { ledgerAccountId: ertrag.id, amountCents: -100n },
      ],
    } as const;

    const first = await postLedgerTransaction(db, input);
    const replay = await postLedgerTransaction(db, { ...input, entries: [...input.entries].reverse() });
    expect(replay.id).toBe(first.id);

    await expect(postLedgerTransaction(db, {
      ...input,
      entries: [
        { ledgerAccountId: kasse.id, amountCents: 200n },
        { ledgerAccountId: ertrag.id, amountCents: -200n },
      ],
    })).rejects.toBeInstanceOf(IdempotentLedgerContentConflictError);
    expect(await listLedgerTransactions(db, { worldId: WORLD_LHE, operatorId })).toHaveLength(1);
  });
});

describe("initializeOperatorStartingCapital", () => {
  it("bucht endliches Startkapital ausgeglichen und exakt einmal", async () => {
    const operatorId = await foundeElbtalbahn();
    const input = {
      worldId: WORLD_LHE,
      operatorId,
      policy: { mode: "finite", amountCents: 1_000_000n } as const,
      postedAt: POSTED_AT,
    };

    const first = await initializeOperatorStartingCapital(db, input);
    const replay = await initializeOperatorStartingCapital(db, input);

    expect(replay.cashAccount.id).toBe(first.cashAccount.id);
    expect(replay.openingEquityAccount.id).toBe(first.openingEquityAccount.id);
    expect(replay.openingTransaction?.id).toBe(first.openingTransaction?.id);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_LHE, ledgerAccountId: first.cashAccount.id })).toBe(1_000_000n);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_LHE, ledgerAccountId: first.openingEquityAccount.id })).toBe(-1_000_000n);
    expect(await listLedgerAccounts(db, { worldId: WORLD_LHE, operatorId })).toHaveLength(2);
    expect(await listLedgerTransactions(db, { worldId: WORLD_LHE, operatorId })).toHaveLength(1);

    await expect(initializeOperatorStartingCapital(db, {
      ...input,
      policy: { mode: "finite", amountCents: 2_000_000n },
    })).rejects.toBeInstanceOf(IdempotentLedgerContentConflictError);
  });

  it("erzeugt fuer den Nullstart eine echte ausgeglichene Nullbuchung", async () => {
    const operatorId = await foundeOperator(WORLD_LHE, "kc-zero", "Zero", "Nullstartbahn");
    const initialized = await initializeOperatorStartingCapital(db, {
      worldId: WORLD_LHE,
      operatorId,
      policy: { mode: "finite", amountCents: 0n },
      postedAt: POSTED_AT,
    });

    expect(initialized.openingTransaction).not.toBeNull();
    const entries = await db.select().from(ledgerEntries);
    expect(entries.filter((entry) => entry.transactionId === initialized.openingTransaction?.id)).toHaveLength(2);
    expect(entries.filter((entry) => entry.transactionId === initialized.openingTransaction?.id).map((entry) => entry.amountCents)).toEqual([0n, 0n]);
  });

  it("legt fuer unbegrenztes Kapital nur Konten und keinen Zahlenersatz an", async () => {
    const operatorId = await foundeOperator(WORLD_LHE, "kc-unlimited", "Unlimited", "Testlaborbahn");
    const initialized = await initializeOperatorStartingCapital(db, {
      worldId: WORLD_LHE,
      operatorId,
      policy: { mode: "unlimited" },
      postedAt: POSTED_AT,
    });

    expect(initialized.openingTransaction).toBeNull();
    expect(await listLedgerAccounts(db, { worldId: WORLD_LHE, operatorId })).toHaveLength(2);
    expect(await listLedgerTransactions(db, { worldId: WORLD_LHE, operatorId })).toHaveLength(0);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_LHE, ledgerAccountId: initialized.cashAccount.id })).toBe(0n);
  });

  it("isoliert gleichnamige Konten und Buchungen zwischen Welten und EVU", async () => {
    const lheOperatorId = await foundeElbtalbahn();
    const middleOperatorId = await foundeOperator(
      WORLD_MIDDLE_GERMANY,
      "kc-anna",
      "Anna",
      "Elbtalbahn",
    );
    const lhe = await initializeOperatorStartingCapital(db, {
      worldId: WORLD_LHE,
      operatorId: lheOperatorId,
      policy: { mode: "finite", amountCents: 100n },
      postedAt: POSTED_AT,
    });
    const middle = await initializeOperatorStartingCapital(db, {
      worldId: WORLD_MIDDLE_GERMANY,
      operatorId: middleOperatorId,
      policy: { mode: "finite", amountCents: 200n },
      postedAt: POSTED_AT,
    });

    expect(lhe.cashAccount.id).not.toBe(middle.cashAccount.id);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_LHE, ledgerAccountId: lhe.cashAccount.id })).toBe(100n);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_MIDDLE_GERMANY, ledgerAccountId: middle.cashAccount.id })).toBe(200n);
    expect(await ledgerAccountBalance(db, { worldId: WORLD_LHE, ledgerAccountId: middle.cashAccount.id })).toBe(0n);
  });
});

describe("Property-Test: der Ledger bleibt über beliebig viele Transaktionen ausgeglichen", () => {
  it("die Salden aller Konten eines EVU summieren sich nach jeder Folge gebuchter Transaktionen zu null", async () => {
    const operatorId = await foundeElbtalbahn();
    const kasse = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Kasse" });
    const trassenentgelt = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Trassenentgelt" });
    const energie = await openLedgerAccount(db, { worldId: WORLD_LHE, operatorId, name: "Energie" });
    const konten = [kasse.id, trassenentgelt.id, energie.id];

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.bigInt({ min: -1_000_000n, max: 1_000_000n }), { minLength: 2, maxLength: 3 }),
          { minLength: 1, maxLength: 8 },
        ),
        async (transaktionen) => {
          for (const [index, betraege] of transaktionen.entries()) {
            const ausgeglichen = [...betraege, -sumEntries(betraege)];
            await postLedgerTransaction(db, {
              worldId: WORLD_LHE,
              operatorId,
              description: `Property-Buchung ${index}`,
              postedAt: POSTED_AT,
              entries: ausgeglichen.map((amountCents, position) => ({
                ledgerAccountId: konten[position % konten.length]!,
                amountCents,
              })),
            });
          }

          const salden = await Promise.all(
            konten.map((ledgerAccountId) => ledgerAccountBalance(db, { worldId: WORLD_LHE, ledgerAccountId })),
          );
          expect(sumEntries(salden)).toBe(0n);
        },
      ),
      { numRuns: 15 },
    );
  });
});
