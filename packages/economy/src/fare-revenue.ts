import { createHash } from "node:crypto";
import { economyOutbox, ledgerTransactions } from "@zugfolge/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { EconomyDatabase } from "./ledger.js";
import { decodeEconomyValue } from "./state-store.js";

/** Tatsächlicher M6-Abrechnungsbeleg vor Pönalen; keine Prognose und keine Tagesverteilung in TypeScript. */
export interface FareContractRevenueEvidenceV1 {
  readonly schemaVersion: "fare-contract-revenue-evidence/v1";
  readonly worldId: string; readonly operatorId: string; readonly contractId: string; readonly journalEffectId: string;
  readonly economyReleaseHash: string; readonly serviceStartMs: number; readonly serviceEndMs: number; readonly settledAtMs: number;
  readonly orderingFeeCents: string; readonly bonusCents: string; readonly penaltyCents: string; readonly contentHash: string;
}
export interface ConfirmedFareContractRevenueV1 {
  readonly evidence: FareContractRevenueEvidenceV1; readonly ledgerTransactionId: string;
}
/** Feldreihenfolge entspricht exakt dem versionierten Rust-DTO; alle Centwerte sind Dezimalstrings. */
export function fareContractRevenueEvidenceHash(value: FareContractRevenueEvidenceV1): string {
  const body: FareContractRevenueEvidenceV1 = { schemaVersion: value.schemaVersion, worldId: value.worldId,
    operatorId: value.operatorId, contractId: value.contractId, journalEffectId: value.journalEffectId,
    economyReleaseHash: value.economyReleaseHash, serviceStartMs: value.serviceStartMs, serviceEndMs: value.serviceEndMs,
    settledAtMs: value.settledAtMs, orderingFeeCents: value.orderingFeeCents, bonusCents: value.bonusCents,
    penaltyCents: value.penaltyCents, contentHash: "" };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
export function buildFareContractRevenueEvidence(input: Omit<FareContractRevenueEvidenceV1, "schemaVersion" | "contentHash">): FareContractRevenueEvidenceV1 {
  if (![input.serviceStartMs, input.serviceEndMs, input.settledAtMs].every(Number.isSafeInteger)
    || input.serviceStartMs < 0 || input.serviceEndMs <= input.serviceStartMs || input.settledAtMs < input.serviceEndMs) {
    throw new Error("M6-Leistungsintervall ist für den Kontrollbeleg ungültig.");
  }
  const body: FareContractRevenueEvidenceV1 = { schemaVersion: "fare-contract-revenue-evidence/v1", ...input, contentHash: "" };
  return Object.freeze({ ...body, contentHash: fareContractRevenueEvidenceHash(body) });
}

/** Nur gemeinsam mit dem bestehenden Welt-/EVU-Writer verwenden. */
export async function loadConfirmedFareContractRevenues(db: EconomyDatabase, input: {
  readonly worldId: string; readonly operatorId: string; readonly nowMs: number;
}): Promise<readonly ConfirmedFareContractRevenueV1[]> {
  const rows = await db.select({ payload: economyOutbox.payload, effectId: economyOutbox.effectId, ledgerId: ledgerTransactions.id })
    .from(economyOutbox).innerJoin(ledgerTransactions, and(eq(ledgerTransactions.worldId, economyOutbox.worldId),
      eq(ledgerTransactions.operatorId, input.operatorId), eq(ledgerTransactions.idempotencyKey, economyOutbox.effectId)))
    .where(and(eq(economyOutbox.worldId, input.worldId), eq(economyOutbox.effectType, "journal"), isNotNull(economyOutbox.processedAt),
      sql`${economyOutbox.payload}->'contractRevenueEvidence' IS NOT NULL`));
  const result: ConfirmedFareContractRevenueV1[] = [];
  for (const row of rows) {
    const journal = decodeEconomyValue(row.payload) as Record<string, unknown>;
    const evidence = journal["contractRevenueEvidence"] as FareContractRevenueEvidenceV1;
    if (typeof evidence !== "object" || evidence === null || evidence.schemaVersion !== "fare-contract-revenue-evidence/v1"
      || evidence.worldId !== input.worldId || evidence.operatorId !== input.operatorId || evidence.journalEffectId !== row.effectId
      || journal["worldId"] !== input.worldId || journal["operatorId"] !== input.operatorId || journal["idempotencyKey"] !== row.effectId
      || typeof journal["at"] !== "number" || journal["at"] * 1000 !== evidence.settledAtMs
      || evidence.contentHash !== fareContractRevenueEvidenceHash(evidence)) {
      throw new Error("Der committed M6-Abrechnungsbeleg verletzt seine Bindung.");
    }
    try {
      if (BigInt(evidence.orderingFeeCents) + BigInt(evidence.bonusCents) - BigInt(evidence.penaltyCents) !== journal["revenueCents"]) throw new Error();
    } catch { throw new Error("Der M6-Bruttobeleg widerspricht dem tatsächlich gebuchten Journal."); }
    if (evidence.settledAtMs <= input.nowMs) result.push({ evidence, ledgerTransactionId: row.ledgerId });
  }
  return result.sort((a, b) => a.evidence.journalEffectId.localeCompare(b.evidence.journalEffectId));
}
