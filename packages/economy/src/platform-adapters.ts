import { sendMessage } from "@zugfolge/mailbox";
import { economyEffects, ledgerAccounts } from "@zugfolge/db";
import { and, eq } from "drizzle-orm";

import { ensureLedgerAccount, postLedgerTransaction, STARTING_CAPITAL_CASH_ACCOUNT_NAME, type EconomyDatabase } from "./ledger.js";
import { COST_TYPES, type CostType } from "./finance.js";
import type { EconomyJournalEntry, EconomyNotice } from "./workflow.js";

export interface JournalAccounts {
  readonly cashAccountId: string;
  readonly revenueAccountId: string;
  readonly costAccountIds: Readonly<Record<CostType, string>>;
}

export const ECONOMY_JOURNAL_REVENUE_ACCOUNT_NAME = "Economy:Erlöse";
export const ECONOMY_JOURNAL_COST_ACCOUNT_NAMES: Readonly<Record<CostType, string>> = Object.freeze({
  track: "Economy:Kosten:Trasse",
  station: "Economy:Kosten:Station",
  facility: "Economy:Kosten:Anlage",
  energy: "Economy:Kosten:Energie",
  personnel: "Economy:Kosten:Personal",
  administration: "Economy:Kosten:Verwaltung",
  vehicle: "Economy:Kosten:Fahrzeug",
  penalty: "Economy:Kosten:Pönale",
  interest: "Economy:Kosten:Zins",
});

/** Legt die produktive M6-Kontierung gemeinsam mit der EVU-Gründung an. */
export async function ensureOperatorJournalAccounts(
  db: EconomyDatabase,
  input: { readonly worldId: string; readonly operatorId: string },
): Promise<JournalAccounts> {
  const cash = await ensureLedgerAccount(db, { ...input, name: STARTING_CAPITAL_CASH_ACCOUNT_NAME });
  const revenue = await ensureLedgerAccount(db, { ...input, name: ECONOMY_JOURNAL_REVENUE_ACCOUNT_NAME });
  const costAccountIds = {} as Record<CostType, string>;
  for (const costType of COST_TYPES) {
    costAccountIds[costType] = (await ensureLedgerAccount(db, {
      ...input,
      name: ECONOMY_JOURNAL_COST_ACCOUNT_NAMES[costType],
    })).id;
  }
  return Object.freeze({ cashAccountId: cash.id, revenueAccountId: revenue.id, costAccountIds: Object.freeze(costAccountIds) });
}

async function loadOperatorJournalAccounts(
  db: EconomyDatabase,
  input: { readonly worldId: string; readonly operatorId: string },
): Promise<JournalAccounts> {
  const rows = await db.select({ id: ledgerAccounts.id, name: ledgerAccounts.name }).from(ledgerAccounts).where(and(
    eq(ledgerAccounts.worldId, input.worldId),
    eq(ledgerAccounts.operatorId, input.operatorId),
  ));
  const byName = new Map(rows.map((row) => [row.name, row.id] as const));
  const cashAccountId = byName.get(STARTING_CAPITAL_CASH_ACCOUNT_NAME);
  const revenueAccountId = byName.get(ECONOMY_JOURNAL_REVENUE_ACCOUNT_NAME);
  const costAccountIds = {} as Record<CostType, string>;
  for (const costType of COST_TYPES) {
    const accountId = byName.get(ECONOMY_JOURNAL_COST_ACCOUNT_NAMES[costType]);
    if (accountId === undefined) throw new Error(`Ledger-Kontierung '${costType}' für EVU '${input.operatorId}' fehlt.`);
    costAccountIds[costType] = accountId;
  }
  if (cashAccountId === undefined || revenueAccountId === undefined) {
    throw new Error(`Ledger-Kontierung für EVU '${input.operatorId}' fehlt.`);
  }
  return { cashAccountId, revenueAccountId, costAccountIds };
}

/**
 * Produktionsadapter auf die bereits vorhandenen M2-Ports. Idempotenz liegt
 * auf Datenbank-Constraints und überlebt deshalb Worker- und Prozessneustarts.
 * Der Adapter übersetzt jeden Fachjournal-Eintrag in genau eine ausgeglichene,
 * doppelt geführte Ledger-Transaktion.
 */
export function createEconomyPlatformAdapters(input: {
  readonly db: EconomyDatabase;
  readonly accountsByOperator?: Readonly<Record<string, JournalAccounts>>;
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
      const accounts = input.accountsByOperator?.[entry.operatorId]
        ?? await loadOperatorJournalAccounts(input.db, { worldId: entry.worldId, operatorId: entry.operatorId });
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
