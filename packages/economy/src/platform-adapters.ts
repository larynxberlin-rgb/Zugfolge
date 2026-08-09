import { sendMessage } from "@zugfolge/mailbox";
import { economyEffects } from "@zugfolge/db";

import { postLedgerTransaction, type EconomyDatabase } from "./ledger.js";
import type { CostType } from "./finance.js";
import type { EconomyJournalEntry, EconomyNotice } from "./workflow.js";

export interface JournalAccounts {
  readonly cashAccountId: string;
  readonly revenueAccountId: string;
  readonly costAccountIds: Readonly<Record<CostType, string>>;
}

/**
 * Produktionsadapter auf die bereits vorhandenen M2-Ports. Idempotenz liegt
 * auf Datenbank-Constraints und überlebt deshalb Worker- und Prozessneustarts.
 * Der Adapter übersetzt jeden Fachjournal-Eintrag in genau eine ausgeglichene,
 * doppelt geführte Ledger-Transaktion.
 */
export function createEconomyPlatformAdapters(input: {
  readonly db: EconomyDatabase;
  readonly accountsByOperator: Readonly<Record<string, JournalAccounts>>;
}): {
  readonly postJournal: (entry: EconomyJournalEntry) => Promise<void>;
  readonly sendNotice: (notice: EconomyNotice) => Promise<void>;
} {
  async function recordEffect(worldId: string, effectId: string, effectType: "journal" | "notice", at: number) {
    await input.db
      .insert(economyEffects)
      .values({ worldId, effectId, effectType, processedAt: new Date(at * 1_000) })
      .onConflictDoNothing({ target: [economyEffects.worldId, economyEffects.effectType, economyEffects.effectId] });
  }

  return {
    async postJournal(entry) {
      const accounts = input.accountsByOperator[entry.operatorId];
      if (accounts === undefined) throw new Error(`Ledger-Kontierung für EVU '${entry.operatorId}' fehlt.`);
      const costTotal = entry.postings.reduce((sum, posting) => sum + posting.amountCents, 0n);
      const entries = [
        ...entry.postings.map((posting) => ({ ledgerAccountId: accounts.costAccountIds[posting.costType], amountCents: posting.amountCents, costType: posting.costType, costCentreId: posting.costCentreId })),
        ...(entry.revenueCents === 0n ? [] : [{ ledgerAccountId: accounts.revenueAccountId, amountCents: -entry.revenueCents }]),
        { ledgerAccountId: accounts.cashAccountId, amountCents: entry.revenueCents - costTotal },
      ].filter((item) => item.amountCents !== 0n);
      if (entries.length < 2) throw new Error("Wirtschaftsjournal enthält keine doppelt buchbare Bewegung.");
      await postLedgerTransaction(input.db, {
        worldId: entry.worldId,
        operatorId: entry.operatorId,
        idempotencyKey: entry.idempotencyKey,
        description: entry.description,
        postedAt: new Date(entry.at * 1_000),
        entries,
      });
      await recordEffect(entry.worldId, entry.idempotencyKey, "journal", entry.at);
    },
    async sendNotice(notice) {
      await sendMessage(input.db, {
        worldId: notice.worldId,
        recipientAccountId: notice.recipientAccountId,
        messageType: notice.type,
        payload: notice.payload,
        sentAt: new Date(notice.at * 1_000),
        idempotencyKey: notice.id,
      });
      await recordEffect(notice.worldId, notice.id, "notice", notice.at);
    },
  };
}
