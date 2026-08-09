import type { PenaltyFocus } from "./release.js";
import type { EconomyRules } from "./release.js";

/**
 * Referenzen auf den von M5.13 freigegebenen, revisionierten Ressourcenstand.
 * Boolesche Selbstauskünfte reichen nicht: Der Single-Writer muss konkrete
 * Formationen, Dienste und Trassenreservierungen nachweisen.
 */
export interface MobilizationProof {
  readonly source: "m5-release";
  readonly fleetRevision: number;
  readonly formationIds: readonly string[];
  readonly personnelDutyIds: readonly string[];
  readonly pathReservationIds: readonly string[];
}
export interface TransitionResult { readonly operatorId: string | "public"; readonly seamless: boolean; readonly penaltyCents: bigint; readonly prequalificationDamage: number }
export function isMobilizationProofComplete(proof: MobilizationProof): boolean {
  const validIds = (ids: readonly string[]) => ids.length > 0 && ids.every((id) => id.trim() !== "") && new Set(ids).size === ids.length;
  return proof.source === "m5-release"
    && Number.isSafeInteger(proof.fleetRevision)
    && proof.fleetRevision >= 0
    && validIds(proof.formationIds)
    && validIds(proof.personnelDutyIds)
    && validIds(proof.pathReservationIds);
}
export function performOperatingTransition(input: { readonly incumbentOperatorId: string | "public"; readonly winnerOperatorId: string; readonly proof: MobilizationProof; readonly at: number; readonly timetableBoundary: number; readonly failurePenaltyCents: bigint }): TransitionResult {
  if (input.at !== input.timetableBoundary) throw new Error("Betriebsübergang ist nur am Fahrplanstichtag zulässig.");
  if (input.winnerOperatorId === input.incumbentOperatorId) return Object.freeze({ operatorId: input.winnerOperatorId, seamless: true, penaltyCents: 0n, prequalificationDamage: 0 });
  if (!isMobilizationProofComplete(input.proof)) return Object.freeze({ operatorId: "public", seamless: false, penaltyCents: input.failurePenaltyCents, prequalificationDamage: 1_500 });
  return Object.freeze({ operatorId: input.winnerOperatorId, seamless: false, penaltyCents: 0n, prequalificationDamage: 0 });
}

export interface ServiceContract { readonly id: string; readonly worldId: string; readonly lotId: string; readonly operatorId: string; readonly startsAt: number; readonly endsAt: number; readonly orderingFeeCentsPerTrainKm: bigint; readonly bonusCentsPerPeriod: bigint; readonly penaltyRates: Readonly<Record<PenaltyFocus, bigint>>; readonly evidenceRequired: readonly string[] }
export interface PerformanceEvidence { readonly trainKm: bigint; readonly punctualityBasisPoints: number; readonly cancellations: number; readonly missingSeats: number; readonly missedConnections: number; readonly evidence: readonly string[] }
export interface ContractSettlement { readonly orderingFeeCents: bigint; readonly bonusCents: bigint; readonly penaltyCents: bigint; readonly netCents: bigint; readonly explanation: readonly string[] }
export function settleContract(contract: ServiceContract, performance: PerformanceEvidence): ContractSettlement {
  if (
    performance.trainKm < 0n
    || !Number.isSafeInteger(performance.punctualityBasisPoints)
    || performance.punctualityBasisPoints < 0
    || performance.punctualityBasisPoints > 10_000
    || !Number.isSafeInteger(performance.cancellations)
    || performance.cancellations < 0
    || !Number.isSafeInteger(performance.missingSeats)
    || performance.missingSeats < 0
    || !Number.isSafeInteger(performance.missedConnections)
    || performance.missedConnections < 0
  ) {
    throw new RangeError("Leistungsnachweis enthält ungültige oder negative Werte.");
  }
  if (
    contract.orderingFeeCentsPerTrainKm < 0n
    || contract.bonusCentsPerPeriod < 0n
    || Object.values(contract.penaltyRates).some((rate) => rate < 0n)
  ) {
    throw new RangeError("Vertrag enthält negative Entgelt-, Bonus- oder Pönalesätze.");
  }
  for (const required of contract.evidenceRequired) if (!performance.evidence.includes(required)) throw new Error(`Vertragsnachweis fehlt: ${required}`);
  const orderingFee = performance.trainKm * contract.orderingFeeCentsPerTrainKm;
  const bonus = performance.punctualityBasisPoints >= 9_500 && performance.cancellations === 0 ? contract.bonusCentsPerPeriod : 0n;
  const penalties = BigInt(Math.max(0, 9_000 - performance.punctualityBasisPoints)) * contract.penaltyRates.punctuality + BigInt(performance.cancellations) * contract.penaltyRates.cancellation + BigInt(performance.missingSeats) * contract.penaltyRates.seats + BigInt(performance.missedConnections) * contract.penaltyRates.connections;
  return Object.freeze({ orderingFeeCents: orderingFee, bonusCents: bonus, penaltyCents: penalties, netCents: orderingFee + bonus - penalties, explanation: Object.freeze([`Bestellerentgelt ${orderingFee}`, `Bonus ${bonus}`, `Pönale ${penalties}`]) });
}

export interface PublicOperation { readonly lotId: string; readonly periodsRemaining: number; readonly minimumServiceOnly: true; readonly qualityBonusEligible: false; readonly livemapMarker: "public-operator"; readonly pathsPriority: "subordinate"; readonly dispatchPolicy: "conservative-no-optimization"; readonly vehiclePool: readonly string[] }
export function startPublicOperation(lotId: string, vehiclePool: readonly string[]): PublicOperation { return Object.freeze({ lotId, periodsRemaining: 2, minimumServiceOnly: true, qualityBonusEligible: false, livemapMarker: "public-operator", pathsPriority: "subordinate", dispatchPolicy: "conservative-no-optimization", vehiclePool }); }
export function improveFailedPackage(operation: PublicOperation, failureCount: number, rules: EconomyRules): { readonly orderingFeeIncreaseBasisPoints: number; readonly serviceReductionBasisPoints: number; readonly suppliedVehicles: boolean; readonly retenderAfterPeriods: 2 } {
  return Object.freeze({ orderingFeeIncreaseBasisPoints: rules.failedPackageFeeStepBasisPoints * failureCount, serviceReductionBasisPoints: rules.failedPackageReductionStepBasisPoints * Math.max(0, failureCount - 1), suppliedVehicles: operation.vehiclePool.length > 0 && failureCount >= 2, retenderAfterPeriods: 2 });
}
export function advancePublicOperation(operation: PublicOperation, failureCount: number, rules: EconomyRules): { readonly operation?: PublicOperation; readonly retender?: ReturnType<typeof improveFailedPackage> } {
  if (operation.periodsRemaining > 1) return { operation: Object.freeze({ ...operation, periodsRemaining: operation.periodsRemaining - 1 }) };
  return { retender: improveFailedPackage(operation, failureCount, rules) };
}

export interface AuthorityBudget { readonly authorityId: string; readonly period: number; readonly availableCents: bigint; readonly committedCents: bigint }
export function commitAuthorityBudget(budget: AuthorityBudget, amountCents: bigint): AuthorityBudget {
  if (amountCents < 0n || budget.committedCents + amountCents > budget.availableCents) throw new Error("Aufgabenträger-Budget reicht nicht aus.");
  return Object.freeze({ ...budget, committedCents: budget.committedCents + amountCents });
}
