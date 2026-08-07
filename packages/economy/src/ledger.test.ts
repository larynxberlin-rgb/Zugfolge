import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import { foundOperator, OperatorNotFoundError } from "@zugfolge/operators";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import fc from "fast-check";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sumEntries } from "./balance.js";
import {
  DuplicateLedgerAccountNameError,
  ForeignLedgerAccountError,
  IncompleteTransactionError,
  ledgerAccountBalance,
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
  await requestWorldAccess(identityDb, { worldId: WORLD_LHE, keycloakSubject: "kc-anna", displayName: "Anna" });
  const operator = await foundOperator(identityDb, {
    worldId: WORLD_LHE,
    foundingKeycloakSubject: "kc-anna",
    name: "Elbtalbahn",
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
