export type CostType = "track" | "station" | "facility" | "energy" | "personnel" | "administration" | "vehicle" | "penalty" | "interest";
export interface CostCentre { readonly id: string; readonly worldId: string; readonly operatorId: string; readonly name: string }
export interface ClassifiedPosting { readonly amountCents: bigint; readonly costType: CostType; readonly costCentreId: string; readonly reference: string }
export function classifyPosting(posting: ClassifiedPosting, centre: CostCentre, worldId: string, operatorId: string): ClassifiedPosting {
  if (centre.worldId !== worldId || centre.operatorId !== operatorId || posting.costCentreId !== centre.id || posting.amountCents < 0n) throw new Error("Kostenbuchung verletzt Welt-, EVU- oder Betragsgrenze.");
  return Object.freeze(posting);
}

export interface ProfitAndLoss { readonly revenueCents: bigint; readonly costsByType: Readonly<Record<CostType, bigint>>; readonly resultCents: bigint; readonly explanation: readonly string[] }
const TYPES: readonly CostType[] = ["track", "station", "facility", "energy", "personnel", "administration", "vehicle", "penalty", "interest"];
export function calculateProfitAndLoss(revenueCents: bigint, postings: readonly ClassifiedPosting[]): ProfitAndLoss {
  const costs = Object.fromEntries(TYPES.map((type) => [type, postings.filter((p) => p.costType === type).reduce((sum, p) => sum + p.amountCents, 0n)])) as unknown as Record<CostType, bigint>;
  const total = Object.values(costs).reduce((sum, amount) => sum + amount, 0n);
  return Object.freeze({ revenueCents, costsByType: Object.freeze(costs), resultCents: revenueCents - total, explanation: Object.freeze([`Erlöse ${revenueCents}`, ...TYPES.map((type) => `${type} ${costs[type]}`), `Ergebnis ${revenueCents - total}`]) });
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
