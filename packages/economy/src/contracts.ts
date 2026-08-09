import type { PenaltyFocus } from "./release.js";

export interface MobilizationProof { readonly vehicles: boolean; readonly personnel: boolean; readonly paths: boolean }
export interface TransitionResult { readonly operatorId: string | "public"; readonly seamless: boolean; readonly penaltyCents: bigint; readonly prequalificationDamage: number }
export function performOperatingTransition(input: { readonly incumbentOperatorId: string | "public"; readonly winnerOperatorId: string; readonly proof: MobilizationProof; readonly at: number; readonly timetableBoundary: number; readonly failurePenaltyCents: bigint }): TransitionResult {
  if (input.at !== input.timetableBoundary) throw new Error("Betriebsübergang ist nur am Fahrplanstichtag zulässig.");
  if (input.winnerOperatorId === input.incumbentOperatorId) return Object.freeze({ operatorId: input.winnerOperatorId, seamless: true, penaltyCents: 0n, prequalificationDamage: 0 });
  if (!input.proof.vehicles || !input.proof.personnel || !input.proof.paths) return Object.freeze({ operatorId: "public", seamless: false, penaltyCents: input.failurePenaltyCents, prequalificationDamage: 1_500 });
  return Object.freeze({ operatorId: input.winnerOperatorId, seamless: false, penaltyCents: 0n, prequalificationDamage: 0 });
}

export interface ServiceContract { readonly id: string; readonly worldId: string; readonly lotId: string; readonly operatorId: string; readonly startsAt: number; readonly endsAt: number; readonly orderingFeeCentsPerTrainKm: bigint; readonly bonusCentsPerPeriod: bigint; readonly penaltyRates: Readonly<Record<PenaltyFocus, bigint>>; readonly evidenceRequired: readonly string[] }
export interface PerformanceEvidence { readonly trainKm: bigint; readonly punctualityBasisPoints: number; readonly cancellations: number; readonly missingSeats: number; readonly missedConnections: number; readonly evidence: readonly string[] }
export interface ContractSettlement { readonly orderingFeeCents: bigint; readonly bonusCents: bigint; readonly penaltyCents: bigint; readonly netCents: bigint; readonly explanation: readonly string[] }
export function settleContract(contract: ServiceContract, performance: PerformanceEvidence): ContractSettlement {
  for (const required of contract.evidenceRequired) if (!performance.evidence.includes(required)) throw new Error(`Vertragsnachweis fehlt: ${required}`);
  const orderingFee = performance.trainKm * contract.orderingFeeCentsPerTrainKm;
  const bonus = performance.punctualityBasisPoints >= 9_500 && performance.cancellations === 0 ? contract.bonusCentsPerPeriod : 0n;
  const penalties = BigInt(Math.max(0, 9_000 - performance.punctualityBasisPoints)) * contract.penaltyRates.punctuality + BigInt(performance.cancellations) * contract.penaltyRates.cancellation + BigInt(performance.missingSeats) * contract.penaltyRates.seats + BigInt(performance.missedConnections) * contract.penaltyRates.connections;
  return Object.freeze({ orderingFeeCents: orderingFee, bonusCents: bonus, penaltyCents: penalties, netCents: orderingFee + bonus - penalties, explanation: Object.freeze([`Bestellerentgelt ${orderingFee}`, `Bonus ${bonus}`, `Pönale ${penalties}`]) });
}

export interface PublicOperation { readonly lotId: string; readonly periodsRemaining: number; readonly minimumServiceOnly: true; readonly qualityBonusEligible: false; readonly livemapMarker: "public-operator"; readonly pathsPriority: "subordinate"; readonly vehiclePool: readonly string[] }
export function startPublicOperation(lotId: string, vehiclePool: readonly string[]): PublicOperation { return Object.freeze({ lotId, periodsRemaining: 2, minimumServiceOnly: true, qualityBonusEligible: false, livemapMarker: "public-operator", pathsPriority: "subordinate", vehiclePool }); }
export function improveFailedPackage(operation: PublicOperation, failureCount: number): { readonly orderingFeeIncreaseBasisPoints: number; readonly serviceReductionBasisPoints: number; readonly suppliedVehicles: boolean; readonly retenderAfterPeriods: 2 } {
  return Object.freeze({ orderingFeeIncreaseBasisPoints: Math.min(2_500, 500 * failureCount), serviceReductionBasisPoints: Math.min(2_000, 400 * Math.max(0, failureCount - 1)), suppliedVehicles: operation.vehiclePool.length > 0 && failureCount >= 2, retenderAfterPeriods: 2 });
}

export interface AuthorityBudget { readonly authorityId: string; readonly period: number; readonly availableCents: bigint; readonly committedCents: bigint }
export function commitAuthorityBudget(budget: AuthorityBudget, amountCents: bigint): AuthorityBudget {
  if (amountCents < 0n || budget.committedCents + amountCents > budget.availableCents) throw new Error("Aufgabenträger-Budget reicht nicht aus.");
  return Object.freeze({ ...budget, committedCents: budget.committedCents + amountCents });
}
