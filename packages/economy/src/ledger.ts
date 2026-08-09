/**
 * Ledger-Kern (M2.4): Ledger-Konten und Ledger-Transaktionen eines EVU.
 *
 * Unveränderlich: Dieses Modul bietet ausschließlich Einfüge- und
 * Leseoperationen an — kein `update`, kein `delete`, in derselben Weise, wie
 * `domain_events` append-only bleibt, weil kein Code dafür einen Weg
 * anbietet (M2.2). Ausgeglichen: `postLedgerTransaction` weist jede
 * Transaktion zurück, deren Buchungen nicht exakt null Cent ergeben
 * (`balance.ts`). Doppelte Buchführung: jede Transaktion trägt mindestens
 * zwei Buchungen auf unterschiedlichen Ledger-Konten.
 */

import {
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  type LedgerAccount,
  type LedgerTransaction,
} from "@zugfolge/db";
import { getOperator } from "@zugfolge/operators";
import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { isBalanced, sumEntries } from "./balance.js";

/** Verbindungstyp, unabhängig vom Treiber — derselbe Schnitt wie in `packages/identity`. */
export type EconomyDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

/** Der Ledger-Kontoname ist in den Büchern dieses EVU bereits vergeben. */
export class DuplicateLedgerAccountNameError extends Error {
  constructor(worldId: string, operatorId: string, name: string) {
    super(`Ledger-Konto '${name}' ist in Welt '${worldId}' für EVU '${operatorId}' bereits vergeben.`);
    this.name = "DuplicateLedgerAccountNameError";
  }
}

/** Eine Transaktion mit weniger als zwei Buchungen ist keine doppelte Buchführung. */
export class IncompleteTransactionError extends Error {
  constructor() {
    super("Eine Ledger-Transaktion braucht mindestens zwei Buchungen (doppelte Buchführung).");
    this.name = "IncompleteTransactionError";
  }
}

/** Die Summe der Buchungen einer Transaktion ist nicht null — der Ledger bliebe unausgeglichen. */
export class UnbalancedTransactionError extends Error {
  constructor(netAmountCents: bigint) {
    super(`Transaktion ist nicht ausgeglichen: Summe ${netAmountCents.toString()} Cent statt 0.`);
    this.name = "UnbalancedTransactionError";
  }
}

/** Eine Buchung verweist auf ein Ledger-Konto außerhalb der Welt oder der Bücher dieses EVU. */
export class ForeignLedgerAccountError extends Error {
  constructor(ledgerAccountId: string) {
    super(`Ledger-Konto '${ledgerAccountId}' gehört nicht zu diesem EVU in dieser Welt.`);
    this.name = "ForeignLedgerAccountError";
  }
}

/**
 * Eröffnet ein Ledger-Konto in den Büchern eines EVU. Prüft, dass das EVU in
 * dieser Welt tatsächlich existiert (`getOperator` wirft sonst
 * `OperatorNotFoundError`).
 */
export async function openLedgerAccount(
  db: EconomyDatabase,
  input: { readonly worldId: string; readonly operatorId: string; readonly name: string },
): Promise<LedgerAccount> {
  await getOperator(db, { worldId: input.worldId, operatorId: input.operatorId });

  const [existing] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.worldId, input.worldId),
        eq(ledgerAccounts.operatorId, input.operatorId),
        eq(ledgerAccounts.name, input.name),
      ),
    )
    .limit(1);
  if (existing !== undefined) {
    throw new DuplicateLedgerAccountNameError(input.worldId, input.operatorId, input.name);
  }

  const [created] = await db
    .insert(ledgerAccounts)
    .values({ worldId: input.worldId, operatorId: input.operatorId, name: input.name })
    .returning();
  if (created === undefined) {
    throw new Error("Ledger-Konto konnte nicht angelegt werden.");
  }
  return created;
}

/** Alle Ledger-Konten eines EVU in einer Welt. */
export async function listLedgerAccounts(
  db: EconomyDatabase,
  input: { readonly worldId: string; readonly operatorId: string },
): Promise<readonly LedgerAccount[]> {
  return db
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.worldId, input.worldId), eq(ledgerAccounts.operatorId, input.operatorId)));
}

export interface LedgerTransactionEntryInput {
  readonly ledgerAccountId: string;
  /** Integer-Cent; positiv mehrt, negativ mindert das Ledger-Konto. */
  readonly amountCents: bigint;
  /** M6.2: Beide Felder werden gemeinsam gesetzt oder gemeinsam weggelassen. */
  readonly costType?: string;
  readonly costCentreId?: string;
}

/**
 * Bucht eine ausgeglichene Ledger-Transaktion. `postedAt` ist ein expliziter
 * Wert des Aufrufers (Invariante 2, hier auf Wirtschaftscode ausgedehnt) —
 * dieses Modul liest nie selbst die Systemuhr.
 */
export async function postLedgerTransaction(
  db: EconomyDatabase,
  input: {
    readonly worldId: string;
    readonly operatorId: string;
    readonly description: string;
    readonly postedAt: Date;
    readonly entries: readonly LedgerTransactionEntryInput[];
  },
): Promise<LedgerTransaction> {
  if (input.entries.length < 2) {
    throw new IncompleteTransactionError();
  }
  if (input.entries.some((entry) => (entry.costType === undefined) !== (entry.costCentreId === undefined))) {
    throw new Error("Kostenart und Kostenstelle müssen gemeinsam angegeben werden.");
  }

  const amounts = input.entries.map((entry) => entry.amountCents);
  if (!isBalanced(amounts)) {
    throw new UnbalancedTransactionError(sumEntries(amounts));
  }

  const accountIds = [...new Set(input.entries.map((entry) => entry.ledgerAccountId))];
  const ownedAccounts = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.worldId, input.worldId),
        eq(ledgerAccounts.operatorId, input.operatorId),
        inArray(ledgerAccounts.id, accountIds),
      ),
    );
  const ownedIds = new Set(ownedAccounts.map((account) => account.id));
  const foreignAccountId = accountIds.find((id) => !ownedIds.has(id));
  if (foreignAccountId !== undefined) {
    throw new ForeignLedgerAccountError(foreignAccountId);
  }

  return db.transaction(async (tx) => {
    const [transaction] = await tx
      .insert(ledgerTransactions)
      .values({
        worldId: input.worldId,
        operatorId: input.operatorId,
        description: input.description,
        postedAt: input.postedAt,
      })
      .returning();
    if (transaction === undefined) {
      throw new Error("Ledger-Transaktion konnte nicht angelegt werden.");
    }

    await tx.insert(ledgerEntries).values(
      input.entries.map((entry) => ({
        worldId: input.worldId,
        transactionId: transaction.id,
        ledgerAccountId: entry.ledgerAccountId,
        amountCents: entry.amountCents,
        costType: entry.costType,
        costCentreId: entry.costCentreId,
      })),
    );

    return transaction;
  });
}

/** Alle gebuchten Transaktionen eines EVU in einer Welt. */
export async function listLedgerTransactions(
  db: EconomyDatabase,
  input: { readonly worldId: string; readonly operatorId: string },
): Promise<readonly LedgerTransaction[]> {
  return db
    .select()
    .from(ledgerTransactions)
    .where(and(eq(ledgerTransactions.worldId, input.worldId), eq(ledgerTransactions.operatorId, input.operatorId)));
}

/** Saldo eines Ledger-Kontos: die Summe aller seiner Buchungen. */
export async function ledgerAccountBalance(
  db: EconomyDatabase,
  input: { readonly worldId: string; readonly ledgerAccountId: string },
): Promise<bigint> {
  const rows = await db
    .select({ amountCents: ledgerEntries.amountCents })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.worldId, input.worldId), eq(ledgerEntries.ledgerAccountId, input.ledgerAccountId)));
  return sumEntries(rows.map((row) => row.amountCents));
}
