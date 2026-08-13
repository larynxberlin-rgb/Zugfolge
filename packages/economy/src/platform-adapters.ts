import { economyEffects, ledgerAccounts } from "@zugfolge/db";
import { sendMessage } from "@zugfolge/mailbox";
import { and, eq, inArray } from "drizzle-orm";

import { postLedgerTransaction, type EconomyDatabase } from "./ledger.js";
import { ECONOMY_COST_TYPES, type CostType } from "./finance.js";
import { lockEconomyCashWriter } from "./state-store.js";
import type { EconomyJournalEntry, EconomyNotice } from "./workflow.js";

export interface JournalAccounts {
  readonly cashAccountId: string;
  readonly revenueAccountId: string;
  readonly costAccountIds: Readonly<Record<CostType, string>>;
}

export interface EconomyLedgerAccountPlan {
  readonly schema: "economy-ledger-account-plan/v1";
  readonly version: string;
  readonly cashAccountName: string;
  readonly revenueAccountName: string;
  readonly costAccountNames: Readonly<Record<CostType, string>>;
}

/**
 * Versionierter Kontenplan fuer oeffentliche Welten. Die Economy-Adapter
 * akzeptieren nicht nur opaque Konto-IDs, sondern pruefen deren fachliche
 * Rolle unmittelbar vor jeder Buchung.
 */
export const STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN: EconomyLedgerAccountPlan = Object.freeze({
  schema: "economy-ledger-account-plan/v1",
  version: "public-economy-2026-1",
  cashAccountName: "Economy:Kasse",
  revenueAccountName: "Economy:Bestellerentgelt",
  costAccountNames: Object.freeze(Object.fromEntries(
    ECONOMY_COST_TYPES.map((type) => [type, `Economy:${type}`]),
  ) as Record<CostType, string>),
});

function validateAccountPlan(plan: EconomyLedgerAccountPlan): void {
  if (plan.schema !== "economy-ledger-account-plan/v1" || plan.version.trim() === "") {
    throw new Error("Wirtschaftskontenplan besitzt keine gueltige Version.");
  }
  const names = [
    plan.cashAccountName,
    plan.revenueAccountName,
    ...ECONOMY_COST_TYPES.map((type) => plan.costAccountNames[type]),
  ];
  if (names.some((name) => typeof name !== "string" || name.trim() === "") || new Set(names).size !== names.length) {
    throw new Error("Wirtschaftskontenplan besitzt leere oder doppelte Kontenrollen.");
  }
}

async function assertJournalAccountPlan(
  db: EconomyDatabase,
  worldId: string,
  operatorId: string,
  accounts: JournalAccounts,
  plan: EconomyLedgerAccountPlan,
): Promise<void> {
  const expected = new Map<string, string>([
    [accounts.cashAccountId, plan.cashAccountName],
    [accounts.revenueAccountId, plan.revenueAccountName],
    ...ECONOMY_COST_TYPES.map((type) => [accounts.costAccountIds[type], plan.costAccountNames[type]] as const),
  ]);
  if (expected.size !== ECONOMY_COST_TYPES.length + 2 || [...expected.keys()].some((id) => typeof id !== "string" || id === "")) {
    throw new Error("Ledger-Kontierung verletzt den versionierten Wirtschaftskontenplan.");
  }
  const rows = await db
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(and(
      eq(ledgerAccounts.worldId, worldId),
      eq(ledgerAccounts.operatorId, operatorId),
      inArray(ledgerAccounts.id, [...expected.keys()]),
    ));
  if (rows.length !== expected.size || rows.some((row) => expected.get(row.id) !== row.name)) {
    throw new Error(`Ledger-Kontierung stimmt nicht mit Kontenplan '${plan.version}' ueberein.`);
  }
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
  readonly accountPlan?: EconomyLedgerAccountPlan;
}): {
  readonly postJournal: (entry: EconomyJournalEntry) => Promise<void>;
  readonly sendNotice: (notice: EconomyNotice) => Promise<void>;
} {
  const accountPlan = input.accountPlan ?? STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN;
  validateAccountPlan(accountPlan);

  async function recordEffect(db: EconomyDatabase, worldId: string, effectId: string, effectType: "journal" | "notice", at: number) {
    await db
      .insert(economyEffects)
      .values({ worldId, effectId, effectType, processedAt: new Date(at * 1_000) })
      .onConflictDoNothing({ target: [economyEffects.worldId, economyEffects.effectType, economyEffects.effectId] });
  }

  return {
    async postJournal(entry) {
      const accounts = input.accountsByOperator[entry.operatorId];
      if (accounts === undefined) throw new Error(`Ledger-Kontierung für EVU '${entry.operatorId}' fehlt.`);
      await input.db.transaction(async (tx) => {
        await lockEconomyCashWriter(tx, { worldId: entry.worldId, operatorId: entry.operatorId });
        await assertJournalAccountPlan(tx, entry.worldId, entry.operatorId, accounts, accountPlan);
        const costTotal = entry.postings.reduce((sum, posting) => sum + posting.amountCents, 0n);
        const entries = [
          ...entry.postings.map((posting) => ({ ledgerAccountId: accounts.costAccountIds[posting.costType], amountCents: posting.amountCents, costType: posting.costType, costCentreId: posting.costCentreId })),
          ...(entry.revenueCents === 0n ? [] : [{ ledgerAccountId: accounts.revenueAccountId, amountCents: -entry.revenueCents }]),
          { ledgerAccountId: accounts.cashAccountId, amountCents: entry.revenueCents - costTotal },
        ].filter((item) => item.amountCents !== 0n);
        if (entries.length < 2) throw new Error("Wirtschaftsjournal enthält keine doppelt buchbare Bewegung.");
        await postLedgerTransaction(tx, {
          worldId: entry.worldId,
          operatorId: entry.operatorId,
          idempotencyKey: entry.idempotencyKey,
          description: entry.description,
          postedAt: new Date(entry.at * 1_000),
          entries,
        });
        await recordEffect(tx, entry.worldId, entry.idempotencyKey, "journal", entry.at);
      });
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
      await recordEffect(input.db, notice.worldId, notice.id, "notice", notice.at);
    },
  };
}
