import { addI64, assertI64, assertNonnegativeI64, subtractI64 } from "./money.js";

export type CostType = "track" | "station" | "facility" | "energy" | "personnel" | "administration" | "vehicle" | "penalty" | "interest";
export const COST_TYPES: readonly CostType[] = Object.freeze(["track", "station", "facility", "energy", "personnel", "administration", "vehicle", "penalty", "interest"]);
export interface CostCentre { readonly id: string; readonly worldId: string; readonly operatorId: string; readonly name: string }
export interface ClassifiedPosting { readonly amountCents: bigint; readonly costType: CostType; readonly costCentreId: string; readonly reference: string }
export function classifyPosting(posting: ClassifiedPosting, centre: CostCentre, worldId: string, operatorId: string): ClassifiedPosting {
  if (centre.worldId !== worldId || centre.operatorId !== operatorId || posting.costCentreId !== centre.id || posting.amountCents < 0n) throw new Error("Kostenbuchung verletzt Welt-, EVU- oder Betragsgrenze.");
  assertNonnegativeI64(posting.amountCents, "Kostenbuchung");
  return Object.freeze(posting);
}

export interface ProfitAndLoss { readonly revenueCents: bigint; readonly costsByType: Readonly<Record<CostType, bigint>>; readonly resultCents: bigint; readonly explanation: readonly string[] }
export function calculateProfitAndLoss(revenueCents: bigint, postings: readonly ClassifiedPosting[]): ProfitAndLoss {
  assertI64(revenueCents, "Erloes");
  const costs = Object.fromEntries(COST_TYPES.map((type) => [type, postings
    .filter((posting) => posting.costType === type)
    .reduce((sum, posting) => addI64(sum, assertNonnegativeI64(posting.amountCents, "Kostenbuchung"), `${type}-Kosten`), 0n)])) as unknown as Record<CostType, bigint>;
  const total = Object.values(costs).reduce((sum, amount) => addI64(sum, amount, "Gesamtkosten"), 0n);
  const result = subtractI64(revenueCents, total, "Periodenergebnis");
  return Object.freeze({ revenueCents, costsByType: Object.freeze(costs), resultCents: result, explanation: Object.freeze([`Erlöse ${revenueCents}`, ...COST_TYPES.map((type) => `${type} ${costs[type]}`), `Ergebnis ${result}`]) });
}

export interface Credit { readonly principalCents: bigint; readonly outstandingCents: bigint; readonly interestBasisPoints: number; readonly duePeriod: number }
export interface LiquidityPlan { readonly liquidCents: bigint; readonly forecastPeriodNetCents: bigint; readonly credits: readonly Credit[] }
export function takeCredit(plan: LiquidityPlan, credit: Credit, creditAllowed: boolean): LiquidityPlan {
  if (!creditAllowed || credit.principalCents <= 0n) throw new Error("Kredit nicht zulässig.");
  return Object.freeze({ liquidCents: plan.liquidCents + credit.principalCents, forecastPeriodNetCents: plan.forecastPeriodNetCents, credits: Object.freeze([...plan.credits, credit]) });
}
export function restructure(plan: LiquidityPlan, cashInjectionCents: bigint, deferredCents: bigint): LiquidityPlan {
  if (cashInjectionCents < 0n || deferredCents < 0n) throw new Error("Restrukturierung darf keine Mittel vernichten.");
  return Object.freeze({ ...plan, liquidCents: plan.liquidCents + cashInjectionCents + deferredCents });
}
export function accrueCreditInterest(credit: Credit): Credit {
  if (credit.interestBasisPoints < 0) throw new Error("Negativer Kreditzins ist nicht zulässig.");
  const interest = (credit.outstandingCents * BigInt(credit.interestBasisPoints) + 9_999n) / 10_000n;
  return Object.freeze({ ...credit, outstandingCents: credit.outstandingCents + interest });
}
export function repayCredit(plan: LiquidityPlan, creditIndex: number, amountCents: bigint): LiquidityPlan {
  const credit = plan.credits[creditIndex];
  if (credit === undefined || amountCents <= 0n || amountCents > credit.outstandingCents || amountCents > plan.liquidCents) throw new Error("Kredittilgung ist nicht gedeckt oder ungültig.");
  const credits = plan.credits.map((item, index) => index === creditIndex ? { ...item, outstandingCents: item.outstandingCents - amountCents } : item);
  return Object.freeze({ ...plan, liquidCents: plan.liquidCents - amountCents, credits: Object.freeze(credits) });
}

export type InsolvencyStage = 0 | 1 | 2 | 3 | 4 | 5;
export interface InsolvencySignals { readonly liquidCents: bigint; readonly twoPeriodNeedCents: bigint; readonly overdueCents: bigint; readonly creditScore: number; readonly contractTerminated: boolean; readonly unableToPay: boolean }
export interface EscalationMessage { readonly channel: "mailbox" | "daily-report"; readonly messageType: `insolvency-stage-${1 | 2 | 3 | 4 | 5}`; readonly stage: Exclude<InsolvencyStage, 0>; readonly actions: readonly string[] }
export interface InsolvencyDecision { readonly stage: InsolvencyStage; readonly messages: readonly EscalationMessage[]; readonly pathsBlocked: boolean; readonly creditBlocked: boolean; readonly purchasesBlocked: boolean; readonly publicOperatorTakesOver: boolean; readonly liquidated: boolean }
export function evaluateInsolvency(signals: InsolvencySignals): InsolvencyDecision {
  const stage: InsolvencyStage = signals.unableToPay ? 5 : signals.contractTerminated ? 4 : signals.creditScore < 3_000 ? 3 : signals.overdueCents > 0n ? 2 : signals.liquidCents < signals.twoPeriodNeedCents ? 1 : 0;
  const actions = stage === 1 ? ["Prognose prüfen", "Kosten senken"] : stage === 2 ? ["Verzugszins", "keine neuen Trassen"] : stage === 3 ? ["keine Kredite", "kein Fahrzeugkauf"] : stage === 4 ? ["Vertragskündigung", "Eigenbetrieb übernimmt"] : stage === 5 ? ["Assets verwerten", "Verträge kündigen", "Trassen freigeben"] : [];
  const messages = stage === 0 ? [] : (["mailbox", "daily-report"] as const).map((channel) => ({ channel, messageType: `insolvency-stage-${stage}` as EscalationMessage["messageType"], stage: stage as Exclude<InsolvencyStage, 0>, actions }));
  return Object.freeze({ stage, messages: Object.freeze(messages), pathsBlocked: stage >= 2, creditBlocked: stage >= 3, purchasesBlocked: stage >= 3, publicOperatorTakesOver: stage >= 4, liquidated: stage === 5 });
}

export interface Prequalification { readonly worldId: string; readonly accountId: string; readonly score: number; readonly creditScore: number; readonly smallLotsOnlyUntilPeriod?: number; readonly bankruptcies: number }
export function updatePrequalification(record: Prequalification, input: { readonly finalPerformanceBasisPoints?: number; readonly mobilizationFailed?: boolean; readonly insolvencyAtPeriod?: number }): Prequalification {
  let score = record.score;
  if (input.finalPerformanceBasisPoints !== undefined) score += Math.floor((input.finalPerformanceBasisPoints - 8_500) / 10);
  if (input.mobilizationFailed) score -= 1_500;
  const bankrupt = input.insolvencyAtPeriod !== undefined;
  return Object.freeze({ ...record, score: Math.max(0, Math.min(10_000, score)), creditScore: bankrupt ? Math.max(0, record.creditScore - 3_000) : record.creditScore, smallLotsOnlyUntilPeriod: bankrupt ? input.insolvencyAtPeriod! + 3 : record.smallLotsOnlyUntilPeriod, bankruptcies: record.bankruptcies + (bankrupt ? 1 : 0) });
}
export function assertPrequalified(record: Prequalification, worldId: string, period: number, smallLot: boolean, minimumScore: number): void {
  if (record.worldId !== worldId || record.score < minimumScore || (!smallLot && (record.smallLotsOnlyUntilPeriod ?? -1) > period)) throw new Error("Präqualifikation reicht für dieses Los nicht aus.");
}
