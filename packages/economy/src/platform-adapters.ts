import { sendMessage } from "@zugfolge/mailbox";

import { postLedgerTransaction, type EconomyDatabase } from "./ledger.js";
import type { CostType } from "./finance.js";
import type { EconomyJournalEntry, EconomyNotice } from "./workflow.js";

export interface JournalAccounts {
  readonly cashAccountId: string;
  readonly revenueAccountId: string;
  readonly costAccountIds: Readonly<Record<CostType, string>>;
}

/**
 * Produktionsadapter auf die bereits vorhandenen M2-Ports. Eine Instanz lebt
 * je Worker/Outbox-Lauf; Idempotenz wird zusätzlich schon am M6-Kommando
 * erzwungen. Der Adapter übersetzt jeden Fachjournal-Eintrag in genau eine
 * ausgeglichene, doppelt geführte Ledger-Transaktion.
 */
export function createEconomyPlatformAdapters(input: {
  readonly db: EconomyDatabase;
  readonly accountsByOperator: Readonly<Record<string, JournalAccounts>>;
}): {
  readonly postJournal: (entry: EconomyJournalEntry) => Promise<void>;
  readonly sendNotice: (notice: EconomyNotice) => Promise<void>;
} {
  const dispatched = new Set<string>();
  return {
    async postJournal(entry) {
      if (dispatched.has(entry.idempotencyKey)) return;
      const accounts = input.accountsByOperator[entry.operatorId];
      if (accounts === undefined) throw new Error(`Ledger-Kontierung für EVU '${entry.operatorId}' fehlt.`);
      const costTotal = entry.postings.reduce((sum, posting) => sum + posting.amountCents, 0n);
      const entries = [
        ...entry.postings.map((posting) => ({ ledgerAccountId: accounts.costAccountIds[posting.costType], amountCents: posting.amountCents, costType: posting.costType, costCentreId: posting.costCentreId })),
        ...(entry.revenueCents === 0n ? [] : [{ ledgerAccountId: accounts.revenueAccountId, amountCents: -entry.revenueCents }]),
        { ledgerAccountId: accounts.cashAccountId, amountCents: entry.revenueCents - costTotal },
      ].filter((item) => item.amountCents !== 0n);
      if (entries.length < 2) throw new Error("Wirtschaftsjournal enthält keine doppelt buchbare Bewegung.");
      await postLedgerTransaction(input.db, { worldId: entry.worldId, operatorId: entry.operatorId, description: `${entry.idempotencyKey}: ${entry.description}`, postedAt: new Date(entry.at * 1_000), entries });
      dispatched.add(entry.idempotencyKey);
    },
    async sendNotice(notice) {
      const idempotencyKey = `notice:${notice.worldId}:${notice.recipientAccountId}:${notice.type}:${notice.at}`;
      if (dispatched.has(idempotencyKey)) return;
      await sendMessage(input.db, { worldId: notice.worldId, recipientAccountId: notice.recipientAccountId, messageType: notice.type, payload: notice.payload });
      dispatched.add(idempotencyKey);
    },
  };
}
